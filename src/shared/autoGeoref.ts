import {
  fitAffineTransform,
  fitSimilarityTransform,
  lonLatToMercator,
  mercatorToLonLat,
} from './georef.js';
import type { CourseControl, GCP, ParticipantTrack } from './types.js';

type Matrix = [number, number, number, number, number, number];

/** A control circle found on the scan, in full-resolution image pixels */
export interface DetectedCircle {
  px: number;
  py: number;
  r: number;
  /** Share of the ring that is actually drawn (0..1) */
  coverage: number;
  /** Double circle (ISOM finish: 5 and 7 mm) */
  finish?: boolean;
}

export interface AutoGeorefResult {
  matrix: Matrix;
  /** Circles that the runners passed through after the fit */
  matchedCircles: DetectedCircle[];
  rmsM: number;
  /** Print scale implied by the fit and the circle size (ISOM ≈ 6 mm, sprint ≈ 5 mm) */
  impliedPrintScale: number | null;
  /** Course built from the matched circles in the order the runners visited them */
  controls: CourseControl[];
}

const PRINT_SCALES = [4000, 5000, 7500, 10000, 15000];
/** Control circle diameters on paper: ISSprOM ≈ 5 mm, ISOM 6 mm */
const CIRCLE_DIAMETERS_MM = [5, 6];

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * One track in Web Mercator metres, bucketed for fast "is the track near here".
 * `nearest` projects onto the track's segments, not just its sample points: snapping to
 * samples would make the iterative fit stop on the sample grid, metres off.
 */
class TrackIndex {
  private cells = new Map<string, number[]>();
  constructor(
    readonly pts: [number, number][],
    private cell: number
  ) {
    pts.forEach((p, i) => {
      const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
      let arr = this.cells.get(k);
      if (!arr) this.cells.set(k, (arr = []));
      arr.push(i);
    });
  }
  /** Closest point on the track within `maxDist` (≤ cell size), or null */
  nearest(x: number, y: number, maxDist: number): [number, number] | null {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let bestIdx = -1;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = this.cells.get(`${cx + dx},${cy + dy}`);
        if (!arr) continue;
        for (const i of arr) {
          const p = this.pts[i];
          const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
          if (d < bestD) {
            bestD = d;
            bestIdx = i;
          }
        }
      }
    }
    if (bestIdx < 0) return null;
    // Refine on the two segments around the closest sample
    let best = this.pts[bestIdx];
    for (const j of [bestIdx - 1, bestIdx + 1]) {
      if (j < 0 || j >= this.pts.length) continue;
      const a = this.pts[Math.min(j, bestIdx)];
      const b = this.pts[Math.max(j, bestIdx)];
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const len2 = vx * vx + vy * vy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / len2));
      const q: [number, number] = [a[0] + vx * t, a[1] + vy * t];
      const d = (q[0] - x) ** 2 + (q[1] - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    return bestD <= maxDist * maxDist ? best : null;
  }
}

/** Track resampled every `stepM` ground metres (keeps the index small and even) */
function resampleMerc(track: ParticipantTrack, stepM: number): [number, number][] {
  const out: [number, number][] = [];
  let lastDist = -Infinity;
  for (const p of track.points) {
    if (p.distM - lastDist >= stepM) {
      out.push(lonLatToMercator(p.lon, p.lat));
      lastDist = p.distM;
    }
  }
  return out;
}

function linearPart(groundMPerPx: number, upBearingDeg: number, mercK: number) {
  const s = groundMPerPx * mercK;
  const t = (-upBearingDeg * Math.PI) / 180;
  return { a: s * Math.cos(t), b: s * Math.sin(t), c: s * Math.sin(t), d: -s * Math.cos(t) };
}

/**
 * Fully automatic georeferencing of an orienteering map scan.
 *
 * Every runner visits every control, so under the right placement the course circles on
 * the scan lie on ALL tracks. Scale comes from the circle size (and typical print scales),
 * rotation from the magnetic declination (± a few degrees); for each such hypothesis the
 * shift is found by voting: each (circle, track point) pair votes for the shift that would
 * put that circle on that point, and the shift where the most circles agree wins — scored
 * by how many runners pass each circle. The winner is then refined by iterative closest
 * point with a similarity transform.
 */
export function autoGeoref(opts: {
  circles: DetectedCircle[];
  participants: ParticipantTrack[];
  declinationDeg: number;
  /** Extra scale hypothesis, e.g. from the print scale + DPI the user entered */
  groundMPerPxHint?: number | null;
}): AutoGeorefResult | null {
  const { declinationDeg } = opts;
  // The finish double circle is left out: runners mill around start/finish and watches are
  // stopped late, so it is a poor tie point (and not part of the auto course either)
  const circles = opts.circles.filter((c) => !c.finish);
  const tracks = opts.participants.filter((p) => p.points.length >= 2);
  if (circles.length < 3 || tracks.length === 0) return null;

  const lat0 = median(tracks.flatMap((t) => t.points.map((p) => p.lat)));
  const mercK = 1 / Math.cos((lat0 * Math.PI) / 180);
  const tolM = 25 * mercK; // how close a track must pass a circle centre (GPS + scan error)
  const indexes = tracks.map((t) => new TrackIndex(resampleMerc(t, 3), tolM));
  const samples = tracks.flatMap((t) => resampleMerc(t, 12));

  // --- scale hypotheses ---
  const rFull = median(circles.map((c) => c.r));
  const mppHyps: number[] = [];
  const addHyp = (v: number) => {
    if (!(v > 0.02 && v < 20)) return;
    if (mppHyps.some((h) => Math.abs(h / v - 1) < 0.03)) return;
    mppHyps.push(v);
  };
  if (opts.groundMPerPxHint) addHyp(opts.groundMPerPxHint);
  for (const s of PRINT_SCALES) {
    for (const dmm of CIRCLE_DIAMETERS_MM) addHyp((s * dmm) / 1000 / (2 * rFull));
  }

  const scoreShift = (L: ReturnType<typeof linearPart>, tx: number, ty: number) => {
    let score = 0;
    for (const c of circles) {
      const x = L.a * c.px + L.b * c.py + tx;
      const y = L.c * c.px + L.d * c.py + ty;
      let visited = 0;
      for (const idx of indexes) if (idx.nearest(x, y, tolM)) visited++;
      score += visited / indexes.length;
    }
    return score;
  };

  let best: { score: number; mpp: number; up: number; tx: number; ty: number } | null = null;
  for (const mpp of mppHyps) {
    for (const dUp of [-3, -1.5, 0, 1.5, 3]) {
      const up = declinationDeg + dUp;
      const L = linearPart(mpp, up, mercK);
      // Vote: shift bins → set of circles agreeing
      const bin = tolM;
      const votes = new Map<string, { circles: Set<number>; sx: number; sy: number; n: number }>();
      circles.forEach((c, i) => {
        const cx = L.a * c.px + L.b * c.py;
        const cy = L.c * c.px + L.d * c.py;
        for (const q of samples) {
          const tx = q[0] - cx;
          const ty = q[1] - cy;
          const k = `${Math.round(tx / bin)},${Math.round(ty / bin)}`;
          let v = votes.get(k);
          if (!v) votes.set(k, (v = { circles: new Set(), sx: 0, sy: 0, n: 0 }));
          v.circles.add(i);
          v.sx += tx;
          v.sy += ty;
          v.n++;
        }
      });
      const top = [...votes.values()]
        .sort((p, q) => q.circles.size - p.circles.size)
        .slice(0, 6);
      for (const v of top) {
        const tx = v.sx / v.n;
        const ty = v.sy / v.n;
        const score = scoreShift(L, tx, ty);
        if (!best || score > best.score) best = { score, mpp, up, tx, ty };
      }
    }
  }
  if (!best || best.score < 3) return null;

  // --- refine: iterative closest point (circles ↔ median nearest track point) ---
  const L0 = linearPart(best.mpp, best.up, mercK);
  let m: Matrix = [L0.a, L0.b, best.tx, L0.c, L0.d, best.ty];
  const matchUnder = (mat: Matrix, radiusM: number) => {
    const pairs: { circle: DetectedCircle; x: number; y: number; distM: number }[] = [];
    for (const c of circles) {
      const x = mat[0] * c.px + mat[1] * c.py + mat[2];
      const y = mat[3] * c.px + mat[4] * c.py + mat[5];
      const hits = indexes
        .map((idx) => idx.nearest(x, y, radiusM * mercK))
        .filter((h): h is [number, number] => h !== null);
      // A control is visited by (nearly) everyone: ignore circles only some runners pass
      if (hits.length === 0 || hits.length < Math.ceil(indexes.length / 2)) continue;
      const mx = median(hits.map((h) => h[0]));
      const my = median(hits.map((h) => h[1]));
      pairs.push({ circle: c, x: mx, y: my, distM: Math.hypot(mx - x, my - y) / mercK });
    }
    return pairs;
  };
  // Closest-point matching converges gradually: iterate until the circles stop moving
  const radii = [25, 20, 15];
  for (let iter = 0; iter < 60; iter++) {
    const r = radii[Math.min(iter, radii.length - 1)];
    const pairs = matchUnder(m, r);
    if (pairs.length < 3) break;
    const gcps: GCP[] = pairs.map((p, i) => {
      const [lon, lat] = mercatorToLonLat(p.x, p.y);
      return { id: String(i), label: '', px: p.circle.px, py: p.circle.py, lon, lat };
    });
    const next = fitSimilarityTransform(gcps);
    if (!next) break;
    const movedM =
      Math.max(
        ...pairs.map(({ circle: c }) =>
          Math.hypot(
            next[0] * c.px + next[1] * c.py + next[2] - (m[0] * c.px + m[1] * c.py + m[2]),
            next[3] * c.px + next[4] * c.py + next[5] - (m[3] * c.px + m[4] * c.py + m[5])
          )
        )
      ) / mercK;
    m = next;
    if (movedM < 0.05 && iter >= radii.length - 1) break;
  }

  const pairs = matchUnder(m, 20);
  if (pairs.length < 3) return null;
  let rmsM = Math.sqrt(pairs.reduce((s, p) => s + p.distM ** 2, 0) / pairs.length);

  // A folded, slightly skewed scan is not exactly a scaled + rotated copy of the ground:
  // with enough circles try an affine fit and keep it if it is clearly better
  if (pairs.length >= 6) {
    const gcps: GCP[] = pairs.map((p, i) => {
      const [lon, lat] = mercatorToLonLat(p.x, p.y);
      return { id: String(i), label: '', px: p.circle.px, py: p.circle.py, lon, lat };
    });
    const aff = fitAffineTransform(gcps);
    if (aff) {
      const affPairs = matchUnder(aff, 20);
      if (affPairs.length >= pairs.length) {
        const affRms = Math.sqrt(
          affPairs.reduce((s, p) => s + p.distM ** 2, 0) / affPairs.length
        );
        if (affRms < rmsM * 0.85) {
          m = aff;
          rmsM = affRms;
        }
      }
    }
  }
  const finalPairs = matchUnder(m, 20);

  const mpp = Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3])) / mercK;
  const rMed = median(finalPairs.map((p) => p.circle.r));
  // diameter on paper (mm) = 2 r px · mpp / scale · 1000 → pick the scale closest to 5–6 mm
  const impliedPrintScale =
    PRINT_SCALES.map((s) => ({
      s,
      err: Math.min(
        ...CIRCLE_DIAMETERS_MM.map((d) => Math.abs((2 * rMed * mpp * 1000) / s - d))
      ),
    })).sort((p, q) => p.err - q.err)[0]?.s ?? null;

  return {
    matrix: m,
    matchedCircles: finalPairs.map((p) => p.circle),
    rmsM,
    impliedPrintScale,
    // The course may include circles the GPS passed a bit wider (fold of the paper, forest GPS)
    controls: buildCourseFromCircles(circles, tracks, m),
  };
}

/**
 * Numbered controls from the circles the runners passed (within `nearM`), ordered by when
 * they punched them (closest approach, median over runners).
 *
 * Start and finish are NOT created: watches are switched on late and off after walking back
 * to the start table, so tracks say little about them — the user places them by hand.
 * The finish double circle (if detected) is therefore left out as well.
 */
export function buildCourseFromCircles(
  circles: DetectedCircle[],
  tracks: ParticipantTrack[],
  matrix: Matrix,
  nearM = 35
): CourseControl[] {
  const lat0 = tracks[0]?.points[0]?.lat ?? 0;
  const mercK = 1 / Math.cos((lat0 * Math.PI) / 180);
  const near = nearM * mercK;
  const merc = tracks.map((t) =>
    t.points.map((p) => ({
      xy: lonLatToMercator(p.lon, p.lat),
      rel: p.t / Math.max(1, t.durationSec),
    }))
  );

  const ordered = circles
    .filter((c) => !c.finish)
    .map((c) => {
      const x = matrix[0] * c.px + matrix[1] * c.py + matrix[2];
      const y = matrix[3] * c.px + matrix[4] * c.py + matrix[5];
      const closest: number[] = [];
      for (const pts of merc) {
        let bestD = near * near;
        let bestRel: number | null = null;
        for (const p of pts) {
          const d = (p.xy[0] - x) ** 2 + (p.xy[1] - y) ** 2;
          if (d < bestD) {
            bestD = d;
            bestRel = p.rel;
          }
        }
        if (bestRel !== null) closest.push(bestRel);
      }
      return closest.length ? { c, order: median(closest) } : null;
    })
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .sort((a, b) => a.order - b.order);

  return ordered.map((o, i) => ({
    id: `control-auto-${i + 1}-${Math.round(Math.random() * 1e6).toString(36)}`,
    kind: 'control' as const,
    px: o.c.px,
    py: o.c.py,
  }));
}
