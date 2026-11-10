import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import {
  addPinMapToTrack,
  autoPlaceScreenshotOnBounds,
  lonLatToMercator,
  nudgeMapMatrix,
  pixelToLonLat,
  solveGeoref,
} from '../shared/georef.js';
import {
  computeTracksBoundingBox,
  findClosestPassagePoint,
  normalizeSamplesToTrack,
  parseFitBuffer,
  parseGpxText,
  parseTcxText,
  pickTrackColor,
  syncAllParticipantsToCommonStartSpot,
  syncAllParticipantsToSpot,
} from '../shared/trackParser.js';
import type {
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

function makeId(len = 8): string {
  return crypto
    .randomBytes(Math.ceil(len / 2))
    .toString('hex')
    .slice(0, len);
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

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

      if (evt.map?.gcps?.some((g) => g.id.startsWith('gcp-auto-'))) {
        const manualGcps = evt.map.gcps.filter(
          (g) => !g.id.startsWith('gcp-auto-')
        );
        evt.map.gcps = manualGcps;
        if (manualGcps.length >= 2) {
          const sol = solveGeoref(
            manualGcps,
            evt.map.width,
            evt.map.height,
            evt.map.transformType ?? 'similarity'
          );
          if (sol) {
            evt.map.gcps = sol.gcpsWithResiduals;
            evt.map.matrix = sol.matrix;
            evt.map.cornersLonLat = sol.cornersLonLat;
            evt.map.rmsErrorM = sol.rmsErrorM;
            evt.map.rotationDeg = sol.rotationDeg;
          }
        }
        await saveEventToDisk(evt);
      }

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

  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header(
      'Access-Control-Allow-Methods',
      'GET,POST,PUT,PATCH,DELETE,OPTIONS'
    );
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

  await app.register(multipart, {
    limits: {
      fileSize: 40 * 1024 * 1024,
    },
  });

  // Serve uploaded map images from /uploads/:file
  app.get<{ Params: { file: string } }>(
    '/uploads/:file',
    async (req, reply) => {
      const safeName = path.basename(req.params.file);
      const filePath = path.join(UPLOADS_DIR, safeName);
      try {
        const buf = await fs.readFile(filePath);
        const ext = path.extname(safeName).toLowerCase();
        reply.header(
          'Content-Type',
          MIME_BY_EXT[ext] ?? 'application/octet-stream'
        );
        return reply.send(buf);
      } catch {
        return reply.code(404).send({ error: 'File not found' });
      }
    }
  );

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

  // Create new event
  app.post<{ Body: { title?: string; description?: string } }>(
    '/api/events',
    async (req) => {
      const id = makeId(10);
      const evt: RaceEvent = {
        id,
        slug: id,
        title: req.body?.title?.trim() || 'Новый разбор забега',
        description: req.body?.description?.trim() || '',
        createdAt: new Date().toISOString(),
        timeMode: 'from_start',
        participants: [],
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
      const fileId = `${evt.id}-map-${makeId(6)}${ext}`;
      const filePath = path.join(UPLOADS_DIR, fileId);
      const buffer = await data.toBuffer();
      await fs.writeFile(filePath, buffer);

      const widthField = (data.fields?.width as { value?: string } | undefined)
        ?.value;
      const heightField = (data.fields?.height as { value?: string } | undefined)
        ?.value;
      const width = Number(widthField) || 1200;
      const height = Number(heightField) || 900;

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
        id: makeId(8),
        name: data.filename || 'Скан карты',
        imageUrl: `/uploads/${fileId}`,
        width,
        height,
        gcps: [],
        transformType: 'similarity',
        matrix: autoPlaced.matrix,
        cornersLonLat: autoPlaced.cornersLonLat,
        rmsErrorM: undefined,
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

    const gcps = (req.body.gcps ?? []).filter(
      (g) => !g.id.startsWith('gcp-auto-')
    );
    const transformType: TransformType =
      req.body.transformType ?? 'similarity';
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
    } else if (gcps.length === 1 && evt.map.matrix) {
      const g = gcps[0];
      const [nowLon, nowLat] = pixelToLonLat(evt.map.matrix, g.px, g.py);
      const [m0x, m0y] = lonLatToMercator(nowLon, nowLat);
      const [m1x, m1y] = lonLatToMercator(g.lon, g.lat);
      const nudged = nudgeMapMatrix(
        evt.map.matrix,
        evt.map.width,
        evt.map.height,
        {
          dEastM: m1x - m0x,
          dNorthM: m1y - m0y,
        }
      );
      evt.map.gcps = [{ ...g, residualM: 0 }];
      evt.map.matrix = nudged.matrix;
      evt.map.cornersLonLat = nudged.cornersLonLat;
      evt.map.rmsErrorM = 0;
    } else {
      evt.map.gcps = gcps;
      evt.map.rmsErrorM = undefined;
    }

    await saveEventToDisk(evt);
    return { event: evt };
  });

  // Nudge map overlay directly (shift in meters, rotate in deg, scale) or manage pins
  app.post<{
    Params: { id: string };
    Body: {
      dEastM?: number;
      dNorthM?: number;
      scaleFactor?: number;
      dAngleDeg?: number;
      addPin?: {
        mapLonLat: [number, number];
        trackLonLat: [number, number];
      };
      undoLastPin?: boolean;
      clearPins?: boolean;
    };
  }>('/api/events/:id/map-nudge', async (req, reply) => {
    const evt = eventsStore.get(req.params.id);
    if (!evt || !evt.map) {
      return reply.code(404).send({ error: 'Сначала загрузите карту' });
    }

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

    if (req.body.clearPins) {
      evt.map.gcps = [];
      evt.map.rmsErrorM = undefined;
    } else if (req.body.undoLastPin) {
      const clean = evt.map.gcps.filter((g) => !g.id.startsWith('gcp-auto-'));
      clean.pop();
      evt.map.gcps = clean;
      if (clean.length >= 2) {
        const sol = solveGeoref(
          clean,
          evt.map.width,
          evt.map.height,
          clean.length >= 3 ? 'affine' : 'similarity'
        );
        if (sol) {
          evt.map.gcps = sol.gcpsWithResiduals;
          evt.map.matrix = sol.matrix;
          evt.map.cornersLonLat = sol.cornersLonLat;
          evt.map.rmsErrorM = sol.rmsErrorM;
          evt.map.rotationDeg = sol.rotationDeg;
        }
      }
    } else if (req.body.addPin) {
      const pinned = addPinMapToTrack(
        evt.map.matrix,
        evt.map.gcps,
        evt.map.width,
        evt.map.height,
        req.body.addPin.mapLonLat,
        req.body.addPin.trackLonLat,
        `pin-${makeId(6)}`
      );
      if (pinned) {
        evt.map.gcps = pinned.gcps;
        evt.map.matrix = pinned.matrix;
        evt.map.cornersLonLat = pinned.cornersLonLat;
        evt.map.rmsErrorM = pinned.rmsErrorM;
        evt.map.rotationDeg = pinned.rotationDeg;
        evt.map.transformType =
          pinned.gcps.length >= 3 ? 'affine' : 'similarity';
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
          id: makeId(8),
          name: parsedName || baseName,
          color: pickTrackColor(evt.participants.length),
          sourceFormat,
          samples,
        });

        evt.participants.push(participant);
        syncAllParticipantsToCommonStartSpot(evt.participants);

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
            evt.map.matrix = autoPlaced.matrix;
            evt.map.cornersLonLat = autoPlaced.cornersLonLat;
          }
        }

        await saveEventToDisk(evt);
        return { event: evt, participant };
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : 'Ошибка разбора файла трека (GPX/FIT/TCX)';
        return reply.code(400).send({ error: message });
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

  // Synchronize all participants to depart simultaneously from the common start spot OR any clicked spot on the map
  app.post<{
    Params: { id: string };
    Body?: {
      spotLon?: number;
      spotLat?: number;
      endLon?: number;
      endLat?: number;
    };
  }>('/api/events/:id/sync-start', async (req, reply) => {
    const evt = eventsStore.get(req.params.id);
    if (!evt) return reply.code(404).send({ error: 'Событие не найдено' });

    if (
      req.body?.spotLon !== undefined &&
      req.body?.spotLat !== undefined
    ) {
      syncAllParticipantsToSpot(
        evt.participants,
        req.body.spotLon,
        req.body.spotLat
      );
      if (
        req.body?.endLon !== undefined &&
        req.body?.endLat !== undefined
      ) {
        for (const p of evt.participants) {
          const endHit = findClosestPassagePoint(
            p.points,
            req.body.endLon,
            req.body.endLat,
            p.trimStartSec + 3
          );
          if (endHit && endHit.pt.t > p.trimStartSec) {
            p.trimEndSec = Math.min(p.durationSec, Math.ceil(endHit.pt.t));
          }
        }
      }
    } else {
      for (const p of evt.participants) {
        p.trimEndSec = p.durationSec;
      }
      syncAllParticipantsToCommonStartSpot(evt.participants);
    }

    evt.timeMode = 'from_start';
    await saveEventToDisk(evt);
    return { event: evt };
  });

  // Delete map from an event
  app.delete<{ Params: { id: string } }>(
    '/api/events/:id/map',
    async (req, reply) => {
      const evt = eventsStore.get(req.params.id);
      if (!evt) return reply.code(404).send({ error: 'Событие не найдено' });
      if (evt.map?.imageUrl?.startsWith('/uploads/')) {
        const fileName = path.basename(evt.map.imageUrl);
        try {
          await fs.unlink(path.join(UPLOADS_DIR, fileName));
        } catch {
          // ignore
        }
      }
      evt.map = undefined;
      await saveEventToDisk(evt);
      return { event: evt };
    }
  );

  // Delete entire event
  app.delete<{ Params: { id: string } }>(
    '/api/events/:id',
    async (req, reply) => {
      const { id } = req.params;
      const evt = eventsStore.get(id);
      if (!evt) {
        return reply.code(404).send({ error: 'Событие не найдено' });
      }
      if (evt.map?.imageUrl?.startsWith('/uploads/')) {
        const fileName = path.basename(evt.map.imageUrl);
        try {
          await fs.unlink(path.join(UPLOADS_DIR, fileName));
        } catch {
          // ignore
        }
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

  // Serve built SPA frontend in production if dist/client exists
  const clientDistDir = path.resolve(process.cwd(), 'dist', 'client');
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'API route not found' });
    }
    const cleanUrl = req.url.split('?')[0] || '/';
    const relPath = cleanUrl === '/' ? 'index.html' : cleanUrl.replace(/^\/+/, '');
    const resolved = path.resolve(clientDistDir, relPath);
    if (!resolved.startsWith(clientDistDir)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile()) {
        const ext = path.extname(resolved).toLowerCase();
        reply.header(
          'Content-Type',
          MIME_BY_EXT[ext] ?? 'application/octet-stream'
        );
        return reply.send(await fs.readFile(resolved));
      }
    } catch {
      // Fall back to index.html for SPA routes
    }
    try {
      const indexHtml = await fs.readFile(
        path.join(clientDistDir, 'index.html')
      );
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(indexHtml);
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });

  const port = Number(process.env.PORT) || 3001;
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`Retrace API server listening on http://localhost:${port}`);
}

startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
