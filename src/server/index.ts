import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { nanoid } from 'nanoid';
import {
  autoPlaceScreenshotOnBounds,
  nudgeMapMatrix,
  snapMapToTrackByTwoPairs,
  solveGeoref,
} from '../shared/georef.js';
import {
  computeTracksBoundingBox,
  normalizeSamplesToTrack,
  parseFitBuffer,
  parseGpxText,
  parseTcxText,
  pickTrackColor,
  syncAllParticipantsToCommonStartSpot,
} from '../shared/trackParser.js';
import type {
  ControlPoint,
  GCP,
  MapOverlay,
  ParticipantTrack,
  RaceEvent,
  TimeMode,
  TransformType,
} from '../shared/types.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const EVENTS_DIR = path.join(DATA_DIR, 'events');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

async function ensureDirs() {
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

async function loadAllEvents(): Promise<Map<string, RaceEvent>> {
  const map = new Map<string, RaceEvent>();

  try {
    const files = await fs.readdir(EVENTS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const raw = await fs.readFile(path.join(EVENTS_DIR, f), 'utf8');
      const evt = JSON.parse(raw) as RaceEvent;
      if (evt.id === 'demo-bitza-2026') continue;
      map.set(evt.id, evt);
    }
  } catch {
    // ignore
  }
  return map;
}

async function saveEventToDisk(evt: RaceEvent) {
  await fs.writeFile(
    path.join(EVENTS_DIR, `${evt.id}.json`),
    JSON.stringify(evt, null, 2),
    'utf8'
  );
}

async function startServer() {
  await ensureDirs();
  const eventsStore = await loadAllEvents();

  const app = Fastify({
    logger: true,
    bodyLimit: 50 * 1024 * 1024, // 50 MB
  });

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: {
      fileSize: 40 * 1024 * 1024,
    },
  });

  await app.register(fastifyStatic, {
    root: UPLOADS_DIR,
    prefix: '/uploads/',
    decorateReply: false,
  });

  // Serve built SPA frontend in production if dist/client exists
  const clientDistDir = path.resolve(process.cwd(), 'dist', 'client');
  try {
    const stat = await fs.stat(clientDistDir);
    if (stat.isDirectory()) {
      await app.register(fastifyStatic, {
        root: clientDistDir,
        prefix: '/',
        decorateReply: false,
      });
    }
  } catch {
    // dist/client not built yet (dev mode)
  }

  app.get('/api/health', async () => ({ status: 'ok', service: 'retrace' }));

  // List events (summary)
  app.get('/api/events', async () => {
    const list = Array.from(eventsStore.values()).map((e) => ({
      id: e.id,
      slug: e.slug,
      title: e.title,
      description: e.description,
      createdAt: e.createdAt,
      participantCount: e.participants.length,
      hasMap: Boolean(e.map),
      mapRmsErrorM: e.map?.rmsErrorM,
    }));
    return { events: list };
  });

  // Get single event by id or slug
  app.get<{ Params: { idOrSlug: string } }>(
    '/api/events/:idOrSlug',
    async (req, reply) => {
      const { idOrSlug } = req.params;
      const found =
        eventsStore.get(idOrSlug) ??
        Array.from(eventsStore.values()).find((e) => e.slug === idOrSlug);
      if (!found) {
        return reply.code(404).send({ error: 'Событие не найдено' });
      }
      return { event: found };
    }
  );

  // Create new event (no registration required — instant shareable slug)
  app.post<{ Body: { title?: string; description?: string } }>(
    '/api/events',
    async (req) => {
      const id = nanoid(10);
      const evt: RaceEvent = {
        id,
        slug: id,
        title: req.body?.title?.trim() || 'Новый разбор забега',
        description: req.body?.description?.trim() || '',
        createdAt: new Date().toISOString(),
        timeMode: 'from_start',
        participants: [],
        controlPoints: [],
      };
      eventsStore.set(evt.id, evt);
      await saveEventToDisk(evt);
      return { event: evt };
    }
  );

  // Update event settings (title, timeMode)
  app.patch<{
    Params: { id: string };
    Body: { title?: string; description?: string; timeMode?: TimeMode };
  }>('/api/events/:id', async (req, reply) => {
    const evt = eventsStore.get(req.params.id);
    if (!evt) return reply.code(404).send({ error: 'Событие не найдено' });
    if (req.body.title !== undefined) evt.title = req.body.title;
    if (req.body.description !== undefined)
      evt.description = req.body.description;
    if (req.body.timeMode !== undefined) evt.timeMode = req.body.timeMode;
    await saveEventToDisk(evt);
    return { event: evt };
  });

  // Upload or set raster map metadata
  app.post<{ Params: { id: string } }>(
    '/api/events/:id/map',
    async (req, reply) => {
      const evt = eventsStore.get(req.params.id);
      if (!evt) return reply.code(404).send({ error: 'Событие не найдено' });

      const data = await req.file();
      if (!data) {
        return reply.code(400).send({ error: 'Файл карты не передан' });
      }

      const ext = path.extname(data.filename || '.png').toLowerCase() || '.png';
      const fileId = `${evt.id}-map-${nanoid(6)}${ext}`;
      const filePath = path.join(UPLOADS_DIR, fileId);
      const buffer = await data.toBuffer();
      await fs.writeFile(filePath, buffer);

      const widthField = (data.fields?.width as any)?.value;
      const heightField = (data.fields?.height as any)?.value;
      const width = Number(widthField) || 1200;
      const height = Number(heightField) || 900;

      // Auto-place screenshot onto the bounding box of existing GPS tracks (or default Paphos bounds if no tracks yet)
      const trackBounds = computeTracksBoundingBox(evt.participants) ?? {
        minLon: 32.415,
        maxLon: 32.435,
        minLat: 34.765,
        maxLat: 34.78,
        startLon: 32.4245,
        startLat: 34.772,
      };
      const autoPlaced = autoPlaceScreenshotOnBounds(width, height, trackBounds);

      const mapOverlay: MapOverlay = {
        id: nanoid(8),
        name: data.filename || 'Скрин карты',
        imageUrl: `/uploads/${fileId}`,
        width,
        height,
        gcps: autoPlaced.gcps,
        transformType: 'similarity',
        matrix: autoPlaced.matrix,
        cornersLonLat: autoPlaced.cornersLonLat,
        rmsErrorM: 0,
        rotationDeg: 0,
      };

      evt.map = mapOverlay;
      await saveEventToDisk(evt);
      return { event: evt };
    }
  );

  // Save GCPs and compute georeferencing transform (similarity / affine)
  app.put<{
    Params: { id: string };
    Body: {
      gcps: GCP[];
      transformType?: TransformType;
      width?: number;
      height?: number;
    };
  }>('/api/events/:id/georef', async (req, reply) => {
    const evt = eventsStore.get(req.params.id);
    if (!evt || !evt.map) {
      return reply
        .code(404)
        .send({ error: 'Событие или карта ещё не загружены' });
    }

    const gcps = req.body.gcps ?? [];
    const transformType: TransformType = req.body.transformType ?? 'affine';
    if (req.body.width) evt.map.width = req.body.width;
    if (req.body.height) evt.map.height = req.body.height;
    evt.map.transformType = transformType;

    const solution = solveGeoref(
      gcps,
      evt.map.width,
      evt.map.height,
      transformType
    );

    if (solution) {
      evt.map.gcps = solution.gcpsWithResiduals;
      evt.map.matrix = solution.matrix;
      evt.map.cornersLonLat = solution.cornersLonLat;
      evt.map.rmsErrorM = solution.rmsErrorM;
      evt.map.rotationDeg = solution.rotationDeg;
    } else {
      evt.map.gcps = gcps;
      evt.map.matrix = undefined;
      evt.map.cornersLonLat = undefined;
      evt.map.rmsErrorM = undefined;
    }

    await saveEventToDisk(evt);
    return { event: evt };
  });

  // Nudge map overlay directly (shift in meters, rotate in deg, scale) or snap by 2 pairs of points (map -> track)
  app.post<{
    Params: { id: string };
    Body: {
      dEastM?: number;
      dNorthM?: number;
      scaleFactor?: number;
      dAngleDeg?: number;
      twoPointSnap?: {
        pair1: { mapLonLat: [number, number]; trackLonLat: [number, number] };
        pair2: { mapLonLat: [number, number]; trackLonLat: [number, number] };
      };
    };
  }>('/api/events/:id/map-nudge', async (req, reply) => {
    const evt = eventsStore.get(req.params.id);
    if (!evt || !evt.map) {
      return reply
        .code(404)
        .send({ error: 'Сначала загрузите карту' });
    }

    // If map has no matrix yet, initialize it onto the GPS track bounds first
    if (!evt.map.matrix) {
      const bounds = computeTracksBoundingBox(evt.participants) ?? {
        minLon: 32.415,
        maxLon: 32.435,
        minLat: 34.765,
        maxLat: 34.78,
        startLon: 32.4245,
        startLat: 34.772,
      };
      const init = autoPlaceScreenshotOnBounds(
        evt.map.width,
        evt.map.height,
        bounds
      );
      evt.map.matrix = init.matrix;
      evt.map.cornersLonLat = init.cornersLonLat;
    }

    if (req.body.twoPointSnap) {
      const snapped = snapMapToTrackByTwoPairs(
        evt.map.matrix,
        evt.map.width,
        evt.map.height,
        req.body.twoPointSnap.pair1,
        req.body.twoPointSnap.pair2
      );
      if (snapped) {
        evt.map.matrix = snapped.matrix;
        evt.map.cornersLonLat = snapped.cornersLonLat;
        evt.map.rotationDeg = snapped.rotationDeg;
      }
    } else {
      const res = nudgeMapMatrix(
        evt.map.matrix,
        evt.map.width,
        evt.map.height,
        req.body
      );
      evt.map.matrix = res.matrix;
      evt.map.cornersLonLat = res.cornersLonLat;
      evt.map.rotationDeg =
        Math.round(
          ((Math.atan2(res.matrix[3], res.matrix[0]) * 180) / Math.PI) * 10
        ) / 10;
    }

    await saveEventToDisk(evt);
    return { event: evt };
  });

  // Upload GPS track file (GPX, FIT, TCX)
  app.post<{ Params: { id: string } }>(
    '/api/events/:id/tracks',
    async (req, reply) => {
      const evt = eventsStore.get(req.params.id);
      if (!evt) return reply.code(404).send({ error: 'Событие не найдено' });

      const data = await req.file();
      if (!data) {
        return reply.code(400).send({ error: 'Файл трека не найден' });
      }

      const filename = data.filename || 'track.gpx';
      const ext = path.extname(filename).toLowerCase();
      const buffer = await data.toBuffer();

      let parsedName: string | undefined;
      let samples: Awaited<ReturnType<typeof parseFitBuffer>>['samples'] = [];
      let sourceFormat: 'gpx' | 'fit' | 'tcx' = 'gpx';

      try {
        if (ext === '.fit') {
          sourceFormat = 'fit';
          const res = await parseFitBuffer(buffer);
          parsedName = res.name;
          samples = res.samples;
        } else if (ext === '.tcx') {
          sourceFormat = 'tcx';
          const res = parseTcxText(buffer.toString('utf8'));
          parsedName = res.name;
          samples = res.samples;
        } else {
          sourceFormat = 'gpx';
          const res = parseGpxText(buffer.toString('utf8'));
          parsedName = res.name;
          samples = res.samples;
        }

        const baseName = path.basename(filename, ext);
        const participant: ParticipantTrack = normalizeSamplesToTrack({
          id: nanoid(8),
          name: parsedName || baseName,
          color: pickTrackColor(evt.participants.length),
          sourceFormat,
          samples,
        });

        evt.participants.push(participant);
        syncAllParticipantsToCommonStartSpot(evt.participants);

        // If map was uploaded before any tracks existed (still on auto-placed default bounds), move it onto the tracks!
        if (
          evt.map &&
          (!evt.map.matrix ||
            evt.map.gcps.length === 0 ||
            evt.map.gcps.every((g) => g.id.startsWith('gcp-auto-')))
        ) {
          const trackBounds = computeTracksBoundingBox(evt.participants);
          if (trackBounds) {
            const autoPlaced = autoPlaceScreenshotOnBounds(
              evt.map.width,
              evt.map.height,
              trackBounds
            );
            evt.map.gcps = autoPlaced.gcps;
            evt.map.matrix = autoPlaced.matrix;
            evt.map.cornersLonLat = autoPlaced.cornersLonLat;
          }
        }

        await saveEventToDisk(evt);
        return { event: evt, participant };
      } catch (err: any) {
        return reply.code(400).send({
          error: err?.message || 'Ошибка разбора файла трека (GPX/FIT/TCX)',
        });
      }
    }
  );

  // Update participant metadata (name, color, time offset, trim, visibility)
  app.patch<{
    Params: { id: string; participantId: string };
    Body: Partial<
      Pick<
        ParticipantTrack,
        | 'name'
        | 'color'
        | 'visible'
        | 'offsetSec'
        | 'trimStartSec'
        | 'trimEndSec'
      >
    >;
  }>('/api/events/:id/participants/:participantId', async (req, reply) => {
    const evt = eventsStore.get(req.params.id);
    if (!evt) return reply.code(404).send({ error: 'Событие не найдено' });

    const p = evt.participants.find(
      (item) => item.id === req.params.participantId
    );
    if (!p) return reply.code(404).send({ error: 'Участник не найден' });

    if (req.body.name !== undefined) p.name = req.body.name;
    if (req.body.color !== undefined) p.color = req.body.color;
    if (req.body.visible !== undefined) p.visible = req.body.visible;
    if (req.body.offsetSec !== undefined) p.offsetSec = req.body.offsetSec;
    if (req.body.trimStartSec !== undefined)
      p.trimStartSec = req.body.trimStartSec;
    if (req.body.trimEndSec !== undefined) p.trimEndSec = req.body.trimEndSec;

    await saveEventToDisk(evt);
    return { event: evt };
  });

  // Delete participant
  app.delete<{ Params: { id: string; participantId: string } }>(
    '/api/events/:id/participants/:participantId',
    async (req, reply) => {
      const evt = eventsStore.get(req.params.id);
      if (!evt) return reply.code(404).send({ error: 'Событие не найдено' });
      evt.participants = evt.participants.filter(
        (p) => p.id !== req.params.participantId
      );
      await saveEventToDisk(evt);
      return { event: evt };
    }
  );

  // Synchronize all participants to depart simultaneously from the common start spot
  app.post<{ Params: { id: string } }>(
    '/api/events/:id/sync-start',
    async (req, reply) => {
      const evt = eventsStore.get(req.params.id);
      if (!evt) return reply.code(404).send({ error: 'Событие не найдено' });
      syncAllParticipantsToCommonStartSpot(evt.participants);
      evt.timeMode = 'from_start';
      await saveEventToDisk(evt);
      return { event: evt };
    }
  );

  // Delete entire event
  app.delete<{ Params: { id: string } }>(
    '/api/events/:id',
    async (req, reply) => {
      const { id } = req.params;
      if (!eventsStore.has(id)) {
        return reply.code(404).send({ error: 'Событие не найдено' });
      }
      eventsStore.delete(id);
      try {
        await fs.unlink(path.join(EVENTS_DIR, `${id}.json`));
      } catch {
        // ignore
      }
      return { ok: true };
    }
  );

  // Update ordered Control Points (КП) for split calculation
  app.put<{
    Params: { id: string };
    Body: { controlPoints: ControlPoint[] };
  }>('/api/events/:id/controls', async (req, reply) => {
    const evt = eventsStore.get(req.params.id);
    if (!evt) return reply.code(404).send({ error: 'Событие не найдено' });
    evt.controlPoints = req.body.controlPoints ?? [];
    await saveEventToDisk(evt);
    return { event: evt };
  });

  const port = Number(process.env.PORT) || 3001;
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`Retrace API server listening on http://localhost:${port}`);
}

startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});

