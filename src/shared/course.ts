import {
  fitSimilarityTransform,
  haversineDistanceM,
  lonLatToMercator,
  pixelToLonLat,
} from './georef.js';
import { detectDepartureFromStartSpot } from './trackParser.js';
import type { CourseControl, GCP, ParticipantTrack, TrackPoint } from './types.js';

type Matrix = [number, number, number, number, number, number];

/** Overprint labels: S (start triangle), 1, 2, …, F (finish) */
export function controlLabels(controls: CourseControl[]): string[] {
  let n = 0;
  return controls.map((c) =>
    c.kind === 'start' ? 'S' : c.kind === 'finish' ? 'F' : String(++n)
  );
}

/** Controls live in map-image pixels (they move with the map); this gives their ground position */
export function controlsLonLat(
  controls: CourseControl[],
  matrix: Matrix
): [number, number][] {
  return controls.map((c) => pixelToLonLat(matrix, c.px, c.py));
}

export interface ControlPassage {
  /** Index of the track point where the runner punched (closest approach) */
  idx: number;
  /** Track-local time of that point, seconds */
  t: number;
  /** Distance from the control at that point, metres (GPS error + map error) */
  distM: number;
  /** False when the track never came within the search radius: no split for this control */
  detected: boolean;
}

/**
 * Find when a runner punched each control, in course order.
 *
 * A course often passes near the same spot twice, so instead of the global closest point
 * each control is searched only after the previous punch, and the punch is the closest
 * point of the FIRST approach that comes within `radiusM` (forest GPS is often 20–50 m off).
 * The start is the moment the runner leaves the start triangle, not the closest point
 * (runners stand at the start before the clock runs).
 */
export function detectControlPassages(
  points: TrackPoint[],
  controlsLL: [number, number][],
  kinds: CourseControl['kind'][],
  radiusM = 60,
  /**
   * true (splits): the start punch is the moment of leaving the triangle.
   * false (map fitting): the closest point, i.e. where runners stood at the start.
   */
  startAsDeparture = true
): ControlPassage[] {
  const out: ControlPassage[] = [];
  let fromIdx = 0;

  for (let k = 0; k < controlsLL.length; k++) {
    const [lon, lat] = controlsLL[k];

    if (startAsDeparture && kinds[k] === 'start' && k === 0) {
      const t = detectDepartureFromStartSpot(points, lon, lat, 25);
      let idx = points.findIndex((p) => p.t >= t);
      if (idx < 0) idx = 0;
      const distM = haversineDistanceM(lon, lat, points[idx].lon, points[idx].lat);
      const detected = distM <= radiusM;
      out.push({ idx, t: points[idx].t, distM, detected });
      if (detected) fromIdx = idx;
      continue;
    }

    let bestIdx = -1;
    let bestDist = Infinity;
    let inside = false;
    for (let i = fromIdx; i < points.length; i++) {
      const d = haversineDistanceM(lon, lat, points[i].lon, points[i].lat);
      if (d <= radiusM) {
        inside = true;
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      } else if (inside) {
        break; // first approach is over
      }
    }

    if (bestIdx >= 0) {
      out.push({ idx: bestIdx, t: points[bestIdx].t, distM: bestDist, detected: true });
      fromIdx = bestIdx;
    } else {
      // Missed (or far GPS error): report the closest point, but keep searching later
      // controls from the previous punch so one miss does not break the rest
      let idx = fromIdx;
      let dist = Infinity;
      for (let i = fromIdx; i < points.length; i++) {
        const d = haversineDistanceM(lon, lat, points[i].lon, points[i].lat);
        if (d < dist) {
          dist = d;
          idx = i;
        }
      }
      out.push({ idx, t: points[idx]?.t ?? 0, distM: dist, detected: false });
    }
  }
  return out;
}

/**
 * Livelox-style route adjustment: shift the track so it passes exactly through every
 * punched control. The shift measured at each punch is blended linearly in time between
 * punches, which removes the slowly drifting GPS offset typical for forest running.
 * Punches farther than `maxShiftM` are treated as unreliable and ignored.
 *
 * Limitation: a punch is the closest approach, so drift ALONG the running direction at a
 * control is invisible (the drifted line still passes through the circle) and stays.
 * Drift across the running direction — the usual "track runs beside the path" — is removed.
 */
export function correctTrackToControls(
  points: TrackPoint[],
  passages: ControlPassage[],
  controlsLL: [number, number][],
  maxShiftM = 80
): TrackPoint[] {
  const anchors = passages
    .map((p, k) => ({ p, ll: controlsLL[k] }))
    .filter(({ p }) => p.detected && p.distM <= maxShiftM)
    .map(({ p, ll }) => ({
      t: points[p.idx].t,
      dLon: ll[0] - points[p.idx].lon,
      dLat: ll[1] - points[p.idx].lat,
    }))
    .sort((a, b) => a.t - b.t);

  if (anchors.length === 0) return points;

  let j = 0;
  return points.map((pt) => {
    while (j + 1 < anchors.length && anchors[j + 1].t <= pt.t) j++;
    const a = anchors[j];
    const b = anchors[j + 1];
    let dLon: number;
    let dLat: number;
    if (pt.t <= anchors[0].t) {
      ({ dLon, dLat } = anchors[0]);
    } else if (!b) {
      ({ dLon, dLat } = a);
    } else {
      const w = b.t > a.t ? (pt.t - a.t) / (b.t - a.t) : 0;
      dLon = a.dLon + (b.dLon - a.dLon) * w;
      dLat = a.dLat + (b.dLat - a.dLat) * w;
    }
    return { ...pt, lon: pt.lon + dLon, lat: pt.lat + dLat };
  });
}

export interface CourseFitResult {
  matrix: Matrix;
  /** RMS distance between the fitted controls and the runners' punches, metres */
  rmsM: number;
  /** Controls that took part in the fit (punched by at least one runner) */
  usedControls: number;
  /** Per control: distance to the runners' (median) punch after the fit, null = not punched */
  residualsM: (number | null)[];
  /** 'similarity' = shift + scale + rotation; 'shift' = only 2 controls usable */
  mode: 'similarity' | 'shift';
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Semi-automatic georeferencing from the course: the controls drawn on the scan must lie
 * where the runners punched them. Iterative closest point:
 *   1. find each runner's punch of every control under the current placement,
 *   2. take the median punch over all runners (one bad GPS track does not pull the map),
 *   3. fit a similarity transform (shift + scale + rotation) control pixel → punch,
 * and repeat with a shrinking search radius until the placement stops moving.
 * Works from a rough placement (the start roughly on the tracks, scale within ~20%).
 */
export function fitMapToCourse(
  participants: ParticipantTrack[],
  controls: CourseControl[],
  matrix: Matrix,
  /** Landmark pins (scan pixel ↔ base-map point): fixed pairs added to every iteration */
  pins: GCP[] = []
): CourseFitResult | null {
  const tracks = participants.filter((p) => p.visible && p.points.length >= 2);
  if (tracks.length === 0 || controls.length < 2) return null;
  const kinds = controls.map((c) => c.kind);

  const punchesUnder = (m: Matrix, radiusM: number) => {
    const ll = controlsLonLat(controls, m);
    const perControl: { lon: number[]; lat: number[] }[] = controls.map(() => ({
      lon: [],
      lat: [],
    }));
    for (const p of tracks) {
      detectControlPassages(p.points, ll, kinds, radiusM, false).forEach((pass, k) => {
        if (!pass.detected) return;
        perControl[k].lon.push(p.points[pass.idx].lon);
        perControl[k].lat.push(p.points[pass.idx].lat);
      });
    }
    return { ll, perControl };
  };

  let m = matrix;
  // Generous radius first (rough placement), then tighter so neighbouring paths don't attract.
  // Closest-point matching converges gradually near corners, so keep iterating at the final
  // radius until the placement settles.
  const radii = [250, 150, 100, 70, 60, 50];
  let mode: CourseFitResult['mode'] = 'similarity';

  for (let iter = 0; iter < 80; iter++) {
    const r = radii[Math.min(iter, radii.length - 1)];
    const { ll, perControl } = punchesUnder(m, r);
    const gcps: GCP[] = [];
    perControl.forEach((pc, k) => {
      if (pc.lon.length === 0) return;
      gcps.push({
        id: controls[k].id,
        label: '',
        px: controls[k].px,
        py: controls[k].py,
        lon: median(pc.lon),
        lat: median(pc.lat),
      });
    });
    if (gcps.length === 0) return null;
    gcps.push(...pins);

    let next: Matrix | null;
    if (gcps.length >= 3) {
      mode = 'similarity';
      next = fitSimilarityTransform(gcps);
    } else {
      // Two points (often start + finish next to each other) cannot fix scale/rotation
      mode = 'shift';
      let dx = 0;
      let dy = 0;
      for (const g of gcps) {
        const [cx, cy] = lonLatToMercator(...pixelToLonLat(m, g.px, g.py));
        const [tx, ty] = lonLatToMercator(g.lon, g.lat);
        dx += tx - cx;
        dy += ty - cy;
      }
      next = [m[0], m[1], m[2] + dx / gcps.length, m[3], m[4], m[5] + dy / gcps.length];
    }
    if (!next) return null;

    const moved = Math.max(
      ...controls.map((c, k) => {
        const [lon, lat] = pixelToLonLat(next!, c.px, c.py);
        return haversineDistanceM(lon, lat, ll[k][0], ll[k][1]);
      })
    );
    m = next;
    if (moved < 0.02 && iter >= radii.length - 1) break;
  }

  const { ll, perControl } = punchesUnder(m, 50);
  const residualsM = perControl.map((pc, k) =>
    pc.lon.length
      ? haversineDistanceM(ll[k][0], ll[k][1], median(pc.lon), median(pc.lat))
      : null
  );
  const used = residualsM.filter((r): r is number => r !== null);
  if (used.length === 0) return null;
  const rmsM = Math.sqrt(used.reduce((s, r) => s + r * r, 0) / used.length);
  return { matrix: m, rmsM, usedControls: used.length, residualsM, mode };
}

export interface ParticipantSplits {
  participantId: string;
  name: string;
  color: string;
  passages: ControlPassage[];
  /** legTimes[k] = time from control k to control k+1 (null if either punch is missing) */
  legTimes: (number | null)[];
  /** Rank on each leg among runners with a valid time (1 = fastest) */
  legRanks: (number | null)[];
  /** Start → last control, null when any punch is missing */
  totalSec: number | null;
  totalRank: number | null;
}

/** Splits table: who ran each leg how fast — the core view of an orienteering analysis */
export function computeSplits(
  participants: ParticipantTrack[],
  controls: CourseControl[],
  matrix: Matrix
): ParticipantSplits[] {
  if (controls.length < 2) return [];
  const ll = controlsLonLat(controls, matrix);
  const kinds = controls.map((c) => c.kind);

  const rows: ParticipantSplits[] = participants
    .filter((p) => p.points.length >= 2)
    .map((p) => {
      const passages = detectControlPassages(p.points, ll, kinds);
      const legTimes = passages.slice(1).map((pass, k) => {
        const prev = passages[k];
        return prev.detected && pass.detected && pass.t >= prev.t
          ? Math.round(pass.t - prev.t)
          : null;
      });
      const totalSec = legTimes.every((t) => t !== null)
        ? Math.round(passages[passages.length - 1].t - passages[0].t)
        : null;
      return {
        participantId: p.id,
        name: p.name,
        color: p.color,
        passages,
        legTimes,
        legRanks: legTimes.map(() => null),
        totalSec,
        totalRank: null,
      };
    });

  const rank = (values: (number | null)[]) => {
    const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
    return values.map((v) => (v === null ? null : sorted.indexOf(v) + 1));
  };
  for (let k = 0; k < controls.length - 1; k++) {
    const ranks = rank(rows.map((r) => r.legTimes[k]));
    rows.forEach((r, i) => (r.legRanks[k] = ranks[i]));
  }
  const totalRanks = rank(rows.map((r) => r.totalSec));
  rows.forEach((r, i) => (r.totalRank = totalRanks[i]));
  return rows;
}
