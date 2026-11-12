import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import {
  autoPlaceScreenshotOnBounds,
  haversineDistanceM,
  solvePins,
  boundsForViewShare,
  boundsOverlap,
  matrixBounds,
  translateMatrixCenterTo,
  type LonLatBounds,
  lonLatToMercator,
  matrixToCorners,
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
import {
  toLiteEvent,
  toWireEvent,
  toWireParticipant,
  unpackPoints,
} from '../shared/pointsCodec.js';
import { canEditParticipant, checkEventScope, eventAccess } from '../shared/access.js';
import { applySyncStart, applyTrims } from '../shared/replayOps.js';
import {
  adminListFromEnv,
  cleanupExpired,
  groupKinds,
  groupNames,
  userNames,
} from './accounts.js';
import { registerAuth } from './authRoutes.js';
import { trustProxyFromEnv } from './proxy.js';
import {
  hasFreeSpace,
  imageExtOf,
  JSON_BODY_LIMIT,
  MAX_MAP_FILE,
  MAX_OWN_EVENTS,
  MAX_PARTICIPANTS,
  MAX_TRACK_FILE,
  MAX_UPLOADS_PER_WINDOW,
  PAGE_CSP,
  UPLOAD_WINDOW_MS,
} from './limits.js';
import { migrate, openDb } from './db.js';
import { createMailer, type Mailer } from './mail.js';
import {
  deleteEvent,
  deleteTrack,
  eventCount,
  importEvents,
  loadEvents,
  saveEvent,
  saveTrack,
} from './store.js';
import { startTelegramBot, type TelegramBot } from './telegram.js';
import {
  CONTROL_KINDS,
  EVENT_KINDS,
  EVENT_SCOPES,
  type EventAccess,
  type EventScope,
  MAP_IMAGE_KINDS,
  type CourseControl,
  eventKindOf,
  type EventKind,
  type GCP,
  type GroundControl,
  type GroundCourseDef,
  type MapOverlay,
  type MapOverlayMeta,
  type ParticipantTrack,
  type RaceEvent,
  type TimeMode,
  type TrackPoint,
  type TransformType,
} from '../shared/types.js';

const gzipAsync = promisify(zlib.gzip);
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const EVENTS_DIR = path.join(DATA_DIR, 'events');
/** data/tracks/<eventId>/<participantId>.json — packed points, written once per upload */
const TRACKS_DIR = path.join(DATA_DIR, 'tracks');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const diskHasRoom = () => hasFreeSpace(UPLOADS_DIR);

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
  await fs.mkdir(TRACKS_DIR, { recursive: true });
}

async function loadAllEvents(): Promise<Map<string, RaceEvent>> {
  const map = new Map<string, RaceEvent>();

  let files: string[] = [];
  try {
    files = await fs.readdir(EVENTS_DIR);
  } catch {
    return map;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    // One broken file must not hide every event that comes after it
    try {
      const raw = await fs.readFile(path.join(EVENTS_DIR, f), 'utf8');
      const evt = JSON.parse(raw) as RaceEvent;
      if (evt.id === 'demo-bitza-2026') continue;

      // Old format kept the points inside the event file: move them to track files once
      const legacy = evt.participants.some((p) => Array.isArray(p.points));
      for (const p of evt.participants) {
        if (Array.isArray(p.points)) {
          await saveTrackToDisk(evt.id, p);
        } else {
          p.points = await loadTrackFromDisk(evt.id, p.id);
        }
      }
      if (legacy) await saveEventToDisk(evt);

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
    } catch (err) {
      console.error(`Skipping unreadable event file ${f}:`, err);
    }
  }
  return map;
}

/** Write to a temp file and rename, so a crash mid-write never leaves a truncated JSON */
async function writeFileAtomic(target: string, content: string) {
  const tmp = `${target}.${makeId(6)}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, target);
}

/**
 * Event settings only (~1 KB): written on every change. Track points live in their own
 * files, written once on upload — a slider release no longer rewrites megabytes.
 */
async function saveEventToDisk(evt: RaceEvent) {
  await writeFileAtomic(
    path.join(EVENTS_DIR, `${evt.id}.json`),
    JSON.stringify(toLiteEvent(evt), null, 1)
  );
}

function trackFile(eventId: string, participantId: string) {
  return path.join(TRACKS_DIR, path.basename(eventId), `${path.basename(participantId)}.json`);
}

async function saveTrackToDisk(eventId: string, p: ParticipantTrack) {
  await fs.mkdir(path.join(TRACKS_DIR, path.basename(eventId)), { recursive: true });
  await writeFileAtomic(trackFile(eventId, p.id), JSON.stringify(toWireParticipant(p).packed));
}

async function loadTrackFromDisk(eventId: string, participantId: string): Promise<TrackPoint[]> {
  try {
    const packed = JSON.parse(await fs.readFile(trackFile(eventId, participantId), 'utf8'));
    return unpackPoints(packed);
  } catch (err) {
    console.error(`Track ${eventId}/${participantId} unreadable:`, err);
    return [];
  }
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Finite and invertible (a zero scale would collapse the map into a point) */
function isUsableMatrix(m: number[] | undefined): boolean {
  if (!Array.isArray(m) || m.length !== 6 || !m.every(Number.isFinite)) {
    return false;
  }
  const [a, b, , c, d] = m;
  return Math.abs(a * d - b * c) > 1e-6;
}

/** Screen bounds sent by the client (JSON string in multipart, object in JSON bodies) */
function parseViewBounds(raw: unknown): LonLatBounds | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object') return null;
  const b = v as Partial<LonLatBounds>;
  const ok =
    [b.minLon, b.maxLon, b.minLat, b.maxLat].every(
      (n) => typeof n === 'number' && Number.isFinite(n)
    ) &&
    b.minLon! < b.maxLon! &&
    b.minLat! < b.maxLat! &&
    Math.abs(b.minLat!) <= 85 &&
    Math.abs(b.maxLat!) <= 85;
  return ok ? (b as LonLatBounds) : null;
}

/**
 * Where an auto-placed map goes: over the tracks if there are any, otherwise in the middle
 * of the user's screen. Only an old client sending neither lands on the fallback spot.
 */
function placementBounds(evt: RaceEvent, view: LonLatBounds | null): LonLatBounds {
  return (
    computeTracksBoundingBox(evt.participants) ??
    (view ? boundsForViewShare(view) : null) ?? {
      minLon: 32.415,
      maxLon: 32.435,
      minLat: 34.765,
      maxLat: 34.78,
    }
  );
}

/** Validate and copy client-editable map metadata; returns an error message or null */
function applyMapMeta(map: MapOverlay, meta: MapOverlayMeta | undefined): string | null {
  if (!meta) return null;
  const inRange = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  if (meta.imageKind !== undefined && !MAP_IMAGE_KINDS.includes(meta.imageKind)) {
    return 'Неизвестный тип изображения карты';
  }
  if (meta.printScale !== undefined && !inRange(meta.printScale, 500, 200000)) {
    return 'Масштаб карты должен быть от 1:500 до 1:200 000';
  }
  if (meta.scanDpi !== undefined && !inRange(meta.scanDpi, 30, 2400)) {
    return 'DPI скана должен быть от 30 до 2400';
  }
  if (meta.declinationDeg !== undefined && !inRange(meta.declinationDeg, -60, 60)) {
    return 'Склонение должно быть от -60° до 60°';
  }
  if (meta.imageKind !== undefined) map.imageKind = meta.imageKind;
  if (meta.printScale !== undefined) map.printScale = meta.printScale;
  if (meta.scanDpi !== undefined) map.scanDpi = meta.scanDpi;
  if (meta.declinationDeg !== undefined) map.declinationDeg = meta.declinationDeg;
  return null;
}

function refreshPinResiduals(pins: GCP[], m: [number, number, number, number, number, number]): GCP[] {
  return pins.map((g) => {
    const [lon, lat] = pixelToLonLat(m, g.px, g.py);
    return { ...g, residualM: Math.round(haversineDistanceM(g.lon, g.lat, lon, lat) * 10) / 10 };
  });
}

function pinsRms(pins: GCP[]): number | undefined {
  if (pins.length < 2) return undefined;
  const sq = pins.reduce((s, g) => s + (g.residualM ?? 0) ** 2, 0);
  return Math.round(Math.sqrt(sq / pins.length) * 10) / 10;
}

async function removeUploadedMapFile(imageUrl: string | undefined) {
  if (!imageUrl?.startsWith('/uploads/')) return;
  try {
    await fs.unlink(path.join(UPLOADS_DIR, path.basename(imageUrl)));
  } catch {
    // already gone
  }
}

async function startServer() {
  await ensureDirs();
  const db = await openDb();
  await migrate(db);
  // Events kept as files before the database: copied in once, into an empty database
  if ((await eventCount(db)) === 0) {
    const legacy = await loadAllEvents();
    if (legacy.size > 0) {
      const n = await importEvents(db, legacy.values());
      console.log(`Imported ${n} events from ${EVENTS_DIR} into the database`);
      await fs.rename(EVENTS_DIR, `${EVENTS_DIR}.imported-${Date.now()}`).catch(() => {});
    }
  }
  const eventsStore = await loadEvents(db);
  const persist = (evt: RaceEvent) => saveEvent(db, evt);

  const admins = adminListFromEnv();
  // Sign-in is by e-mail and password. Sign-in by an e-mail code (SMTP_URL) and through a
  // Telegram bot (TELEGRAM_BOT_TOKEN) is kept but switched off: uncomment to bring it back.
  // const mailer = await createMailer();
  // const telegram = process.env.TELEGRAM_BOT_TOKEN
  //   ? await startTelegramBot(db, process.env.TELEGRAM_BOT_TOKEN, admins, process.env.PUBLIC_URL).catch(
  //       (err) => {
  //         console.error('Telegram login is off:', err);
  //         return null;
  //       }
  //     )
  //   : null;
  const mailer: Mailer = {
    enabled: false,
    sendLoginCode: async () => {
      throw new Error('E-mail codes are switched off');
    },
  };
  const telegram: TelegramBot | null = null;
  void createMailer;
  void startTelegramBot;
  setInterval(() => void cleanupExpired(db).catch((err) => console.error(err)), 6 * 3600_000).unref();

  const app = Fastify({
    logger: true,
    // JSON bodies (settings, course, pins) are a few KB. The body is read before any sign-in
    // check, so a large limit let anyone make the server parse 50 MB per request.
    // Files go through multipart with their own limits below.
    bodyLimit: JSON_BODY_LIMIT,
    // Behind haproxy: the client's real address for rate limits (see proxy.ts)
    trustProxy: trustProxyFromEnv(process.env.TRUST_PROXY),
  });

  // Before any route: Fastify binds hooks and the error handler to a route when it is added

  // Errors: a clear message for the limits; the text of an unexpected error stays in the log
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: 'Файл слишком большой' });
    }
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: 'Слишком большой запрос' });
    }
    if (status >= 500) {
      req.log.error(err);
      return reply.code(status).send({ error: 'Ошибка сервера' });
    }
    return reply.code(status).send({ error: err.message });
  });

  // Security headers on every response
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('Content-Security-Policy', PAGE_CSP);
    }
    return payload;
  });

  await registerAuth(app, {
    db,
    mailer,
    telegram,
    admins,
    secureCookie: process.env.COOKIE_SECURE === '1',
  });

  /**
   * The event of the route, if the signed-in user may view it / add a track / edit it;
   * otherwise answers 404 / 401 / 403 itself and returns null.
   */
  function requireEvent(
    req: FastifyRequest,
    reply: FastifyReply,
    need: 'view' | 'upload' | 'edit'
  ): RaceEvent | null {
    const evt = eventsStore.get((req.params as { id: string }).id);
    const access = evt ? eventAccess(req.viewer, evt) : null;
    if (!evt || !access?.canView) {
      // Not even visible: do not tell whether it exists
      void reply.code(req.user || !evt ? 404 : 401).send({
        error: req.user || !evt ? 'Событие не найдено' : 'Войдите',
      });
      return null;
    }
    if ((need === 'upload' && !access.canUpload) || (need === 'edit' && !access.canEdit)) {
      void reply.code(403).send({ error: 'Нет прав на это действие' });
      return null;
    }
    return evt;
  }

  // gzip text responses (JSON with track points shrinks ~4×, JS/CSS bundles ~3.5×)
  app.addHook('onSend', async (req, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    const compressible = /json|javascript|css|html|svg|text\//.test(type);
    const accepts = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (!compressible || !accepts || reply.getHeader('content-encoding')) return payload;
    const body =
      typeof payload === 'string' ? Buffer.from(payload) : Buffer.isBuffer(payload) ? payload : null;
    if (!body || body.length < 1024) return payload;
    reply.header('Content-Encoding', 'gzip');
    reply.header('Vary', 'Accept-Encoding');
    reply.removeHeader('content-length');
    return gzipAsync(body);
  });

  await app.register(multipart, {
    limits: {
      fileSize: MAX_MAP_FILE,
      // One file and a few small fields (width, height, dpi, view) per request
      files: 1,
      fields: 10,
      fieldSize: 64 * 1024,
      parts: 12,
    },
  });

  /** Uploads per signed-in user: maps and tracks */
  const uploadLimit = (() => {
    const hits = new Map<string, number[]>();
    return (userId: string) => {
      const now = Date.now();
      const recent = (hits.get(userId) ?? []).filter((t) => now - t < UPLOAD_WINDOW_MS);
      recent.push(now);
      hits.set(userId, recent);
      if (hits.size > 10_000) hits.clear();
      return recent.length <= MAX_UPLOADS_PER_WINDOW;
    };
  })();
  /** Refuses (and answers 429) when this user uploads too often */
  function uploadAllowed(req: FastifyRequest, reply: FastifyReply): boolean {
    if (req.viewer.isAdmin || uploadLimit(req.user?.id ?? req.ip)) return true;
    void reply.code(429).send({ error: 'Слишком много загрузок подряд, подождите несколько минут' });
    return false;
  }

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
        // Every upload gets a new random name (a replaced map is a new file): cache forever
        reply.header('Cache-Control', IMMUTABLE_CACHE);
        // Someone's file: never active content, even opened directly
        reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
        return reply.send(buf);
      } catch {
        return reply.code(404).send({ error: 'File not found' });
      }
    }
  );

  app.get('/api/health', async () => ({ status: 'ok', service: 'retrace' }));

  /** Who the event is for, as the list and the settings show it */
  async function audienceInfo(evt: RaceEvent) {
    const [groups, owners] = await Promise.all([
      evt.groupId ? groupNames(db) : Promise.resolve({} as Record<string, string>),
      evt.ownerId ? userNames(db, [evt.ownerId]) : Promise.resolve({} as Record<string, string>),
    ]);
    return {
      groupName: evt.groupId ? groups[evt.groupId] : undefined,
      ownerName: evt.ownerId ? owners[evt.ownerId] : undefined,
    };
  }

  /** The event as this user may see it: the share token only for its editors */
  function forViewer(evt: RaceEvent, access: EventAccess) {
    return access.canEdit ? evt : { ...evt, shareToken: undefined };
  }

  // Events this user may see (summary)
  app.get('/api/events', async (req) => {
    const [groups, owners] = await Promise.all([
      groupNames(db),
      userNames(
        db,
        [...new Set([...eventsStore.values()].map((e) => e.ownerId).filter(Boolean))] as string[]
      ),
    ]);
    const list = Array.from(eventsStore.values())
      .map((e) => ({ e, access: eventAccess(req.viewer, e) }))
      .filter(({ access }) => access.canView)
      .sort((a, b) => b.e.createdAt.localeCompare(a.e.createdAt))
      .map(({ e, access }) => ({
        id: e.id,
        slug: e.slug,
        title: e.title,
        description: e.description,
        createdAt: e.createdAt,
        kind: eventKindOf(e),
        scope: e.scope ?? null,
        groupId: e.groupId,
        groupName: e.groupId ? groups[e.groupId] : undefined,
        ownerName: e.ownerId ? owners[e.ownerId] : undefined,
        participantCount: e.participants.length,
        hasMap: Boolean(e.map),
        canEdit: access.canEdit,
      }));
    return { events: list };
  });

  // Single event by id or slug (`?share=<token>` opens a personal event shared by link)
  app.get<{ Params: { idOrSlug: string }; Querystring: { share?: string } }>(
    '/api/events/:idOrSlug',
    async (req, reply) => {
      const { idOrSlug } = req.params;
      const found =
        eventsStore.get(idOrSlug) ??
        Array.from(eventsStore.values()).find((e) => e.slug === idOrSlug);
      const access = found ? eventAccess(req.viewer, found, req.query.share) : null;
      if (!found || !access?.canView) {
        return req.user || !found
          ? reply.code(404).send({ error: 'Событие не найдено' })
          : reply.code(401).send({ error: 'Войдите, чтобы открыть это событие' });
      }
      // The only response with track points (packed); changes answer without them
      return {
        event: toWireEvent(forViewer(found, access)),
        access,
        ...(await audienceInfo(found)),
      };
    }
  );

  /** Validated audience fields from a create/update body, or an error message */
  async function audienceFrom(
    req: FastifyRequest,
    body: { scope?: EventScope; groupId?: string | null }
  ): Promise<{ scope: EventScope; groupId?: string } | string> {
    const scope = body.scope ?? 'personal';
    if (!EVENT_SCOPES.includes(scope)) return 'Неизвестный тип события';
    const groupId = body.groupId || undefined;
    const kinds = await groupKinds(db);
    if (groupId && !kinds[groupId]) return 'Нет такого клуба или семьи';
    return checkEventScope(req.viewer, scope, groupId, kinds) ?? { scope, groupId };
  }

  // Create new event
  app.post<{
    Body: {
      title?: string;
      description?: string;
      kind?: EventKind;
      scope?: EventScope;
      groupId?: string | null;
    };
  }>(
    '/api/events',
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'Войдите' });
      if (!req.user.isAdmin) {
        const own = [...eventsStore.values()].filter((e) => e.ownerId === req.user!.id).length;
        if (own >= MAX_OWN_EVENTS) {
          return reply
            .code(403)
            .send({ error: `У вас уже ${MAX_OWN_EVENTS} событий — удалите ненужные` });
        }
      }
      const kind = req.body?.kind ?? 'orienteering';
      if (!EVENT_KINDS.includes(kind)) {
        return reply.code(400).send({ error: 'Неизвестный вид события' });
      }
      const audience = await audienceFrom(req, req.body ?? {});
      if (typeof audience === 'string') return reply.code(403).send({ error: audience });
      const id = makeId(10);
      const evt: RaceEvent = {
        id,
        slug: id,
        title: req.body?.title?.trim().slice(0, 120) || 'Новый разбор забега',
        description: req.body?.description?.trim() || '',
        createdAt: new Date().toISOString(),
        kind,
        scope: audience.scope,
        groupId: audience.groupId,
        ownerId: req.user.id,
        timeMode: 'from_start',
        participants: [],
      };
      eventsStore.set(evt.id, evt);
      await persist(evt);
      return { event: toLiteEvent(evt), access: eventAccess(req.viewer, evt) };
    }
  );

  // Update event settings: title, kind, time mode, audience, share link
  app.patch<{
    Params: { id: string };
    Body: {
      title?: string;
      description?: string;
      timeMode?: TimeMode;
      kind?: EventKind;
      scope?: EventScope;
      groupId?: string | null;
      /** true: open by link (a new token), false: close the link */
      shareLink?: boolean;
    };
  }>('/api/events/:id', async (req, reply) => {
    const evt = requireEvent(req, reply, 'edit');
    if (!evt) return reply;
    const { title, description, timeMode, kind, scope, groupId, shareLink } = req.body ?? {};
    if (timeMode !== undefined && timeMode !== 'from_start' && timeMode !== 'real') {
      return reply.code(400).send({ error: 'Неизвестный режим времени' });
    }
    if (kind !== undefined && !EVENT_KINDS.includes(kind)) {
      return reply.code(400).send({ error: 'Неизвестный вид события' });
    }
    if (scope !== undefined || groupId !== undefined) {
      const audience = await audienceFrom(req, {
        scope: scope ?? evt.scope,
        groupId: groupId === undefined ? evt.groupId : groupId,
      });
      if (typeof audience === 'string') return reply.code(403).send({ error: audience });
      evt.scope = audience.scope;
      evt.groupId = audience.groupId;
      // An event from before accounts gets an owner when an admin decides who it is for
      if (!evt.ownerId && req.user) evt.ownerId = req.user.id;
    }
    if (shareLink === true) evt.shareToken = crypto.randomBytes(18).toString('base64url');
    if (shareLink === false) evt.shareToken = undefined;
    // A run/hike keeps its uploaded map (if any) so switching back loses nothing
    if (kind !== undefined) evt.kind = kind;
    if (typeof title === 'string' && title.trim()) evt.title = title.trim().slice(0, 120);
    if (typeof description === 'string') evt.description = description;
    if (timeMode !== undefined) evt.timeMode = timeMode;
    await persist(evt);
    return {
      event: toLiteEvent(evt),
      access: eventAccess(req.viewer, evt),
      ...(await audienceInfo(evt)),
    };
  });

  // Upload or set raster map metadata
  app.post<{ Params: { id: string } }>(
    '/api/events/:id/map',
    async (req, reply) => {
      const evt = requireEvent(req, reply, 'edit');
      if (!evt) return reply;
      if (!uploadAllowed(req, reply)) return reply;
      if (!(await diskHasRoom())) {
        return reply.code(507).send({ error: 'На сервере кончается место — загрузка карт временно закрыта' });
      }

      const data = await req.file();
      if (!data) {
        return reply.code(400).send({ error: 'Файл карты не передан' });
      }

      // Only images, judged by the content, not the name: anything else (e.g. HTML named
      // .png) would be served back as active content. The extension follows the content.
      const buffer = await data.toBuffer();
      const ext = imageExtOf(buffer);
      if (!ext) {
        return reply
          .code(400)
          .send({ error: 'Карта должна быть изображением (PNG, JPG, WEBP, GIF)' });
      }
      const fileId = `${evt.id}-map-${makeId(6)}${ext}`;
      const filePath = path.join(UPLOADS_DIR, fileId);
      await fs.writeFile(filePath, buffer);

      const widthField = (data.fields?.width as { value?: string } | undefined)
        ?.value;
      const heightField = (data.fields?.height as { value?: string } | undefined)
        ?.value;
      const width = Number(widthField) || 1200;
      const height = Number(heightField) || 900;
      // Resolution stored by the scanner in the image header (read by the browser), if any
      const dpiField = Number(
        (data.fields?.dpi as { value?: string } | undefined)?.value
      );
      const scanDpi =
        Number.isFinite(dpiField) && dpiField >= 30 && dpiField <= 2400
          ? Math.round(dpiField)
          : undefined;

      // No tracks yet: put the map in the middle of what the user is looking at
      const viewBounds = parseViewBounds(
        (data.fields?.view as { value?: string } | undefined)?.value
      );
      const autoPlaced = autoPlaceScreenshotOnBounds(
        width,
        height,
        placementBounds(evt, viewBounds)
      );

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
        ...(scanDpi ? { scanDpi } : {}),
      };

      const previousImageUrl = evt.map?.imageUrl;
      evt.map = mapOverlay;
      await persist(evt);
      // The replaced scan is no longer referenced by anything
      await removeUploadedMapFile(previousImageUrl);
      return { event: toLiteEvent(evt) };
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
    const evt = requireEvent(req, reply, 'edit');
    if (!evt) return reply;
    if (!evt.map) {
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
    if (gcps.length > 0) evt.map.manuallyPlaced = true;

    await persist(evt);
    return { event: toLiteEvent(evt) };
  });

  // Nudge map overlay directly (shift in meters, rotate in deg, scale, or set matrix directly)
  app.post<{
    Params: { id: string };
    Body: {
      matrix?: [number, number, number, number, number, number];
      resetAutoFit?: boolean;
      dEastM?: number;
      dNorthM?: number;
      scaleFactor?: number;
      stretchXFactor?: number;
      dAngleDeg?: number;
      anchorLonLat?: [number, number];
      /** Landmark pin: scan pixel ↔ the same place clicked on the base map */
      addPin?: { px: number; py: number; lon: number; lat: number };
      removePinId?: string;
      undoLastPin?: boolean;
      clearPins?: boolean;
      meta?: MapOverlayMeta;
      /** Current screen bounds: where "reset" puts the map when there are no tracks */
      view?: LonLatBounds;
    };
  }>('/api/events/:id/map-nudge', async (req, reply) => {
    const evt = requireEvent(req, reply, 'edit');
    if (!evt) return reply;
    if (!evt.map) {
      return reply.code(404).send({ error: 'Сначала загрузите карту' });
    }

    const previousMap = structuredClone(evt.map);

    if (!evt.map.matrix || req.body.resetAutoFit) {
      const init = autoPlaceScreenshotOnBounds(
        evt.map.width,
        evt.map.height,
        placementBounds(evt, parseViewBounds(req.body.view))
      );
      evt.map.matrix = init.matrix;
      evt.map.cornersLonLat = init.cornersLonLat;
      evt.map.gcps = [];
      evt.map.rmsErrorM = undefined;
      evt.map.rotationDeg = 0;
      evt.map.manuallyPlaced = false;
      if (req.body.resetAutoFit) {
        await persist(evt);
        return { event: toLiteEvent(evt) };
      }
    }

    if (
      Array.isArray(req.body.matrix) &&
      req.body.matrix.length === 6 &&
      req.body.matrix.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      const m = req.body.matrix;
      evt.map.matrix = m;
      evt.map.cornersLonLat = matrixToCorners(m, evt.map.width, evt.map.height);
      // Landmark pins stay: they are ground truth (pixel ↔ place), not a placement
      evt.map.gcps = refreshPinResiduals(evt.map.gcps, m);
      evt.map.rmsErrorM = pinsRms(evt.map.gcps);
      evt.map.rotationDeg =
        Math.round(((Math.atan2(m[3], m[0]) * 180) / Math.PI) * 10) / 10;
    } else if (req.body.clearPins) {
      evt.map.gcps = [];
      evt.map.rmsErrorM = undefined;
    } else if (req.body.undoLastPin || req.body.removePinId || req.body.addPin) {
      let pins = evt.map.gcps.filter((g) => !g.id.startsWith('gcp-auto-'));
      if (req.body.undoLastPin) pins = pins.slice(0, -1);
      if (req.body.removePinId) pins = pins.filter((g) => g.id !== req.body.removePinId);
      if (req.body.addPin) {
        const { px, py, lon, lat } = req.body.addPin;
        if (![px, py, lon, lat].every(Number.isFinite) || Math.abs(lat) > 85) {
          return reply.code(400).send({ error: 'Некорректная точка привязки' });
        }
        pins.push({
          id: `pin-${makeId(6)}`,
          label: `Точка ${pins.length + 1}`,
          px: Math.round(px * 10) / 10,
          py: Math.round(py * 10) / 10,
          lon: Number(lon.toFixed(7)),
          lat: Number(lat.toFixed(7)),
        });
      }
      const sol = solvePins(pins, evt.map.matrix);
      if (sol) {
        evt.map.gcps = sol.pins;
        evt.map.matrix = sol.matrix;
        evt.map.cornersLonLat = matrixToCorners(sol.matrix, evt.map.width, evt.map.height);
        evt.map.rmsErrorM = sol.pins.length >= 2 ? sol.rmsErrorM : undefined;
        evt.map.rotationDeg =
          Math.round(((Math.atan2(sol.matrix[3], sol.matrix[0]) * 180) / Math.PI) * 10) / 10;
        evt.map.transformType = sol.mode === 'affine' ? 'affine' : 'similarity';
      } else {
        evt.map.gcps = pins;
        evt.map.rmsErrorM = undefined;
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

    // Bad input (NaN anchor, zero scale...) must never be persisted as a broken map placement
    if (!isUsableMatrix(evt.map.matrix)) {
      evt.map = previousMap;
      return reply.code(400).send({ error: 'Некорректные параметры подгонки карты' });
    }
    // Pins stay valid whatever moved the map; show how far each one is off now
    if (evt.map.gcps.length > 0 && evt.map.matrix) {
      evt.map.gcps = refreshPinResiduals(evt.map.gcps, evt.map.matrix);
      evt.map.rmsErrorM = pinsRms(evt.map.gcps);
    }

    const metaError = applyMapMeta(evt.map, req.body.meta);
    if (metaError) {
      evt.map = previousMap;
      return reply.code(400).send({ error: metaError });
    }

    evt.map.manuallyPlaced = true;
    await persist(evt);
    return { event: toLiteEvent(evt) };
  });

  // Upload GPS track file (GPX, FIT, TCX)
  app.post<{ Params: { id: string } }>(
    '/api/events/:id/tracks',
    async (req, reply) => {
      const evt = requireEvent(req, reply, 'upload');
      if (!evt) return reply;
      if (evt.participants.length >= MAX_PARTICIPANTS) {
        return reply.code(400).send({ error: `В событии уже ${MAX_PARTICIPANTS} треков` });
      }
      if (!uploadAllowed(req, reply)) return reply;

      const data = await req.file({ limits: { fileSize: MAX_TRACK_FILE } });
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
        if (req.user) participant.uploadedBy = req.user.id;

        evt.participants.push(participant);
        await saveTrack(db, evt.id, participant);
        syncAllParticipantsToCommonStartSpot(evt.participants);

        // Auto-fit only a map the user has not placed by hand yet
        if (
          evt.map &&
          (!evt.map.matrix ||
            (!evt.map.manuallyPlaced &&
              evt.map.gcps.every((g) => g.id.startsWith('gcp-auto-'))))
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
        } else if (evt.map?.matrix) {
          // A hand-placed map nowhere near the tracks (e.g. placed before any track was
          // loaded) is moved onto them; its scale and rotation are kept
          const trackBounds = computeTracksBoundingBox(evt.participants);
          const mapB = matrixBounds(evt.map.matrix, evt.map.width, evt.map.height);
          if (trackBounds && !boundsOverlap(trackBounds, mapB)) {
            const m = translateMatrixCenterTo(
              evt.map.matrix,
              evt.map.width,
              evt.map.height,
              (trackBounds.minLon + trackBounds.maxLon) / 2,
              (trackBounds.minLat + trackBounds.maxLat) / 2
            );
            evt.map.matrix = m;
            evt.map.cornersLonLat = matrixToCorners(m, evt.map.width, evt.map.height);
          }
        }

        await persist(evt);
        return { event: toLiteEvent(evt), participant: toWireParticipant(participant) };
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
        | 'courseId'
      >
    >;
  }>('/api/events/:id/participants/:participantId', async (req, reply) => {
    // Event editors, and the one who uploaded the track
    const evt = requireEvent(req, reply, 'view');
    if (!evt) return reply;

    const p = evt.participants.find(
      (item) => item.id === req.params.participantId
    );
    if (!p) return reply.code(404).send({ error: 'Участник не найден' });
    if (!canEditParticipant(req.viewer, eventAccess(req.viewer, evt), p)) {
      return reply.code(403).send({ error: 'Это чужой трек' });
    }

    const body = req.body ?? {};
    const isNum = (v: unknown): v is number =>
      typeof v === 'number' && Number.isFinite(v);
    if (body.color !== undefined && !HEX_COLOR_RE.test(String(body.color))) {
      return reply.code(400).send({ error: 'Цвет должен быть в формате #rrggbb' });
    }
    for (const key of ['offsetSec', 'trimStartSec', 'trimEndSec'] as const) {
      if (body[key] !== undefined && !isNum(body[key])) {
        return reply.code(400).send({ error: `Некорректное значение ${key}` });
      }
    }

    // Signed by hand in the runner's card: shown on the map, in splits and videos
    if (typeof body.name === 'string' && body.name.trim()) p.name = body.name.trim().slice(0, 40);
    if (body.color !== undefined) p.color = body.color;
    if (typeof body.visible === 'boolean') p.visible = body.visible;
    if (body.offsetSec !== undefined) p.offsetSec = body.offsetSec;
    if (body.trimStartSec !== undefined)
      p.trimStartSec = Math.max(0, Math.min(p.durationSec, body.trimStartSec));
    if (body.trimEndSec !== undefined)
      p.trimEndSec = Math.max(0, Math.min(p.durationSec, body.trimEndSec));
    // Course set by hand ('' = detect it again from the punches)
    if (body.courseId !== undefined) {
      if (body.courseId === '') delete p.courseId;
      else if (evt.courses?.some((c) => c.id === body.courseId)) p.courseId = body.courseId;
      else return reply.code(400).send({ error: 'Нет такой трассы' });
    }

    await persist(evt);
    return { event: toLiteEvent(evt) };
  });

  // Delete participant
  app.delete<{ Params: { id: string; participantId: string } }>(
    '/api/events/:id/participants/:participantId',
    async (req, reply) => {
      const evt = requireEvent(req, reply, 'view');
      if (!evt) return reply;
      const p = evt.participants.find((item) => item.id === req.params.participantId);
      if (!p) return reply.code(404).send({ error: 'Участник не найден' });
      if (!canEditParticipant(req.viewer, eventAccess(req.viewer, evt), p)) {
        return reply.code(403).send({ error: 'Это чужой трек' });
      }
      await deleteTrack(db, evt.id, req.params.participantId);
      evt.participants = evt.participants.filter(
        (p) => p.id !== req.params.participantId
      );
      await persist(evt);
      return { event: toLiteEvent(evt) };
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
    const evt = requireEvent(req, reply, 'edit');
    if (!evt) return reply;

    const b = req.body ?? {};
    const spot: [number, number] | undefined =
      b.spotLon !== undefined && b.spotLat !== undefined ? [b.spotLon, b.spotLat] : undefined;
    const endSpot: [number, number] | undefined =
      b.endLon !== undefined && b.endLat !== undefined ? [b.endLon, b.endLat] : undefined;
    applySyncStart(evt.participants, spot, endSpot);

    evt.timeMode = 'from_start';
    await persist(evt);
    return { event: toLiteEvent(evt) };
  });

  // Replace the course, in course order: controls drawn on the map image (pixels), or —
  // with `ground: true`, or when there is no scan — controls marked on the base map (lon/lat),
  // optionally with `courses` (A, B, C… on that area, sharing its start and finish)
  app.put<{
    Params: { id: string };
    Body: {
      ground?: boolean;
      controls?: (CourseControl | GroundControl)[];
      courses?: GroundCourseDef[];
    };
  }>(
    '/api/events/:id/course',
    async (req, reply) => {
      const evt = requireEvent(req, reply, 'edit');
      if (!evt) return reply;
      const controls = req.body?.controls;
      if (!Array.isArray(controls) || controls.length > 199) {
        return reply.code(400).send({ error: 'Некорректный список КП' });
      }
      const validId = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 40;

      if (req.body?.ground || !evt.map) {
        const ground: GroundControl[] = [];
        for (const c of controls as GroundControl[]) {
          const ok =
            c &&
            validId(c.id) &&
            CONTROL_KINDS.includes(c.kind) &&
            Number.isFinite(c.lon) &&
            Number.isFinite(c.lat) &&
            Math.abs(c.lon) <= 180 &&
            Math.abs(c.lat) <= 85;
          if (!ok) return reply.code(400).send({ error: 'Некорректный КП' });
          // ~1 cm
          ground.push({
            id: c.id,
            kind: c.kind,
            lon: Math.round(c.lon * 1e7) / 1e7,
            lat: Math.round(c.lat * 1e7) / 1e7,
            ...(c.kind === 'control' && c.common === true ? { common: true } : {}),
          });
        }

        // Courses on the area: each lists area controls; one shared start and finish
        const rawCourses = req.body?.courses;
        let courses: GroundCourseDef[] | undefined;
        if (rawCourses !== undefined) {
          if (!Array.isArray(rawCourses) || rawCourses.length > 20) {
            return reply.code(400).send({ error: 'Некорректный список трасс' });
          }
          const controlIds = new Set(ground.filter((c) => c.kind === 'control').map((c) => c.id));
          courses = [];
          for (const c of rawCourses) {
            const ok =
              c &&
              validId(c.id) &&
              typeof c.name === 'string' &&
              c.name.trim().length > 0 &&
              c.name.length <= 20 &&
              Array.isArray(c.controlIds) &&
              c.controlIds.length <= 99 &&
              c.controlIds.every((id) => controlIds.has(id));
            if (!ok) return reply.code(400).send({ error: 'Некорректная трасса' });
            courses.push({ id: c.id, name: c.name.trim(), controlIds: [...c.controlIds] });
          }
          if (
            courses.length > 0 &&
            (ground.filter((c) => c.kind === 'start').length > 1 ||
              ground.filter((c) => c.kind === 'finish').length > 1)
          ) {
            return reply.code(400).send({ error: 'Старт и финиш у трасс общие — по одному' });
          }
        }

        evt.course = ground;
        if (courses !== undefined) {
          if (courses.length > 0) evt.courses = courses;
          else delete evt.courses;
          // A runner's hand-set course must still exist
          const ids = new Set(courses.map((c) => c.id));
          for (const p of evt.participants) if (p.courseId && !ids.has(p.courseId)) delete p.courseId;
        }
        await persist(evt);
        return { event: toLiteEvent(evt) };
      }
      const { width, height } = evt.map;
      const clean: CourseControl[] = [];
      for (const c of controls as CourseControl[]) {
        const ok =
          c &&
          validId(c.id) &&
          CONTROL_KINDS.includes(c.kind) &&
          Number.isFinite(c.px) &&
          Number.isFinite(c.py) &&
          Math.abs(c.px) <= width * 3 &&
          Math.abs(c.py) <= height * 3;
        if (!ok) return reply.code(400).send({ error: 'Некорректный КП' });
        clean.push({
          id: c.id,
          kind: c.kind,
          px: Math.round(c.px * 10) / 10,
          py: Math.round(c.py * 10) / 10,
        });
      }
      evt.map.controls = clean;
      await persist(evt);
      return { event: toLiteEvent(evt) };
    }
  );

  // Set start/finish of several participants at once (e.g. punches at S and F from the splits)
  app.put<{
    Params: { id: string };
    Body: { trims?: { participantId: string; trimStartSec: number; trimEndSec: number }[] };
  }>('/api/events/:id/trims', async (req, reply) => {
    const evt = requireEvent(req, reply, 'edit');
    if (!evt) return reply;
    const trims = req.body?.trims;
    if (!Array.isArray(trims)) {
      return reply.code(400).send({ error: 'Нет данных о старте/финише' });
    }
    const error = applyTrims(evt.participants, trims);
    if (error) return reply.code(400).send({ error });
    evt.timeMode = 'from_start';
    await persist(evt);
    return { event: toLiteEvent(evt) };
  });

  // Delete map from an event
  app.delete<{ Params: { id: string } }>(
    '/api/events/:id/map',
    async (req, reply) => {
      const evt = requireEvent(req, reply, 'edit');
      if (!evt) return reply;
      await removeUploadedMapFile(evt.map?.imageUrl);
      evt.map = undefined;
      await persist(evt);
      return { event: toLiteEvent(evt) };
    }
  );

  // Delete entire event
  app.delete<{ Params: { id: string } }>(
    '/api/events/:id',
    async (req, reply) => {
      const { id } = req.params;
      const evt = requireEvent(req, reply, 'edit');
      if (!evt) return reply;
      await deleteEvent(db, id);
      eventsStore.delete(id);
      await removeUploadedMapFile(evt.map?.imageUrl);
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
    // With the separator: `../client-other/…` must not pass as inside `client`
    if (!resolved.startsWith(clientDistDir + path.sep)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile()) {
        const ext = path.extname(resolved).toLowerCase();
        if (ext === '.html') {
          reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
        reply.header(
          'Content-Type',
          MIME_BY_EXT[ext] ?? 'application/octet-stream'
        );
        // Vite build assets carry a content hash in their name
        if (relPath.startsWith('assets/')) reply.header('Cache-Control', IMMUTABLE_CACHE);
        return reply.send(await fs.readFile(resolved));
      }
    } catch {
      // Fall back to index.html for SPA routes
    }
    try {
      const indexHtml = await fs.readFile(
        path.join(clientDistDir, 'index.html')
      );
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
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
