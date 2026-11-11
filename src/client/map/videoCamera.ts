import type { ParticipantTrack } from '../../shared/types.js';

/**
 * Camera framing for replay videos: the run fills the frame. A leg is turned so that A is on
 * the left and B on the right; the whole course gets the turn that shows it largest.
 */

type LonLat = [number, number];

export interface FramePadding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface VideoCamera {
  center: LonLat;
  zoom: number;
  /** Map rotation, degrees clockwise from north (MapLibre `bearing`) */
  bearing: number;
}

interface FrameOptions {
  rotate: boolean;
  maxZoom: number;
}

/** MapLibre world size at zoom 0, px (512-px tiles) */
const WORLD_PX = 512;
/** Turning the whole course must make it at least this much larger to be worth it */
const MIN_TURN_GAIN = 1.15;

/** What a replay shows: each visible runner's track between their trims (the leg / course) */
export function replayPoints(participants: ParticipantTrack[]): LonLat[] {
  const out: LonLat[] = [];
  for (const p of participants) {
    if (!p.visible) continue;
    const end = Math.min(p.trimEndSec, p.durationSec);
    for (const pt of p.points) {
      if (pt.t >= p.trimStartSec && pt.t <= end) out.push([pt.lon, pt.lat]);
    }
  }
  return out;
}

/** Web Mercator in world units 0…1, y pointing south (as MapLibre's MercatorCoordinate) */
function toMerc([lon, lat]: LonLat): [number, number] {
  const phi = (lat * Math.PI) / 180;
  return [(lon + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2];
}

function fromMerc(x: number, y: number): LonLat {
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
}

function normBearing(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** Largest view of `merc` points with the map turned to `bearing`, inside the padded view */
function frameAt(
  merc: [number, number][],
  bearing: number,
  view: { width: number; height: number },
  pad: FramePadding,
  maxZoom: number
): VideoCamera {
  // Screen axes in world units (y south): "right" is the compass direction bearing + 90°,
  // "down" is 90° clockwise from it
  const az = ((bearing + 90) * Math.PI) / 180;
  const right: [number, number] = [Math.sin(az), -Math.cos(az)];
  const down: [number, number] = [-right[1], right[0]];

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const [x, y] of merc) {
    const sx = x * right[0] + y * right[1];
    const sy = x * down[0] + y * down[1];
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }

  const availW = Math.max(40, view.width - pad.left - pad.right);
  const availH = Math.max(40, view.height - pad.top - pad.bottom);
  const pxPerUnit = Math.min(
    availW / Math.max(maxX - minX, 1e-9),
    availH / Math.max(maxY - minY, 1e-9)
  );
  const zoom = Math.min(maxZoom, Math.log2(pxPerUnit / WORLD_PX));
  const scale = WORLD_PX * 2 ** zoom;

  // The padded box is centred on the content; the view centre shifts by the uneven padding
  const cx = (minX + maxX) / 2 + (pad.right - pad.left) / 2 / scale;
  const cy = (minY + maxY) / 2 + (pad.bottom - pad.top) / 2 / scale;
  return {
    center: fromMerc(cx * right[0] + cy * down[0], cx * right[1] + cy * down[1]),
    zoom,
    bearing: normBearing(bearing),
  };
}

/**
 * A leg: the map turned so that A → B runs left to right, zoomed in as far as A, B and all
 * `points` fit inside the view minus `pad` (CSS px). North-up when `rotate` is off or A = B.
 */
export function legCamera(
  a: LonLat,
  b: LonLat,
  points: LonLat[],
  view: { width: number; height: number },
  pad: FramePadding,
  opts: FrameOptions
): VideoCamera {
  const ma = toMerc(a);
  const mb = toMerc(b);
  const dx = mb[0] - ma[0];
  const dy = mb[1] - ma[1];
  const turn = opts.rotate && Math.hypot(dx, dy) > 1e-12;
  // Compass direction of A → B; "up" is 90° to the left of it
  const azimuth = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const merc = [ma, mb, ...points.map(toMerc)];
  return frameAt(merc, turn ? azimuth - 90 : 0, view, pad, opts.maxZoom);
}

/**
 * The whole course (or any run without A/B): the turn, north never pointing down, that shows
 * `points` largest. Stays north-up unless turning makes it at least 15% larger.
 */
export function courseCamera(
  points: LonLat[],
  view: { width: number; height: number },
  pad: FramePadding,
  opts: FrameOptions
): VideoCamera | null {
  if (points.length < 2) return null;
  const merc = points.map(toMerc);
  // Compare without the zoom cap: a small course would hit it at every turn
  const northUp = frameAt(merc, 0, view, pad, Infinity);
  let best = northUp;
  if (opts.rotate) {
    for (let bearing = -90; bearing <= 90; bearing += 3) {
      const cam = frameAt(merc, bearing, view, pad, Infinity);
      if (cam.zoom > best.zoom) best = cam;
    }
    if (best.zoom - northUp.zoom < Math.log2(MIN_TURN_GAIN)) best = northUp;
  }
  return frameAt(merc, best.bearing, view, pad, opts.maxZoom);
}
