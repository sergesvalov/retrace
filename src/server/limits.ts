import fs from 'node:fs/promises';

/**
 * Limits and checks for a site open to the internet: anyone may sign up, so nothing one
 * account sends may take the server down or fill its disk.
 */

/** JSON request bodies: settings, course, pins — a few KB in practice */
export const JSON_BODY_LIMIT = 1024 * 1024;
/** A map scan */
export const MAX_MAP_FILE = 40 * 1024 * 1024;
/** A GPX/TCX/FIT track: a long day at one point per second is ~5 MB of GPX */
export const MAX_TRACK_FILE = 20 * 1024 * 1024;
/** Tracks in one event */
export const MAX_PARTICIPANTS = 300;
/** Events one user owns (site admins: no limit) */
export const MAX_OWN_EVENTS = 200;
/** Uploads (maps and tracks) per user in a window (site admins: no limit) */
export const MAX_UPLOADS_PER_WINDOW = 60;
export const UPLOAD_WINDOW_MS = 10 * 60_000;
/** Map uploads stop while the data disk has less free space than this */
export const MIN_FREE_DISK = 5 * 1024 ** 3;

/**
 * Content-Security-Policy of the site: scripts only from the site itself (an injected
 * `<script>` or a script from elsewhere does not run), map tiles from the three tile servers
 * of mapStyle.ts, MapLibre's worker from a blob, no framing by other sites.
 */
const TILE_HOSTS =
  'https://tile.openstreetmap.org https://*.tile.opentopomap.org https://server.arcgisonline.com';
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${TILE_HOSTS}`,
  `connect-src 'self' ${TILE_HOSTS}`,
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * The image type by the file's first bytes: `.png`, `.jpg`, `.gif`, `.webp`, or null for
 * anything else (whatever its name says).
 */
export function imageExtOf(buf: Uint8Array): '.png' | '.jpg' | '.gif' | '.webp' | null {
  const starts = (bytes: number[], at = 0) => bytes.every((b, i) => buf[at + i] === b);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return '.png';
  if (starts([0xff, 0xd8, 0xff])) return '.jpg';
  if (starts(ascii('GIF87a')) || starts(ascii('GIF89a'))) return '.gif';
  if (starts(ascii('RIFF')) && starts(ascii('WEBP'), 8)) return '.webp';
  return null;
}

/** Enough free space on the disk holding `dir` for one more upload (unknown: yes) */
export async function hasFreeSpace(dir: string, minFree = MIN_FREE_DISK): Promise<boolean> {
  try {
    const s = await fs.statfs(dir);
    return s.bavail * s.bsize >= minFree;
  } catch {
    return true;
  }
}
