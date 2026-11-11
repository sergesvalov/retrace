import { describe, expect, it } from 'vitest';
import { autoGeoref, type DetectedCircle } from './autoGeoref.js';
import {
  buildScaledOrientedMatrix,
  haversineDistanceM,
  pixelToLonLat,
  translateMatrixCenterTo,
} from './georef.js';
import { normalizeSamplesToTrack } from './trackParser.js';

const W = 3504;
const H = 2544;
const MOSFILOTI: [number, number] = [33.42, 34.95];
const MPP = (10000 * 0.0254) / 300; // 1:10 000 scanned at 300 dpi
const DECL = 5.3;

// The scan's true placement (unknown to the algorithm)
const TRUTH = translateMatrixCenterTo(
  buildScaledOrientedMatrix([1, 0, 3_720_000, 0, -1, 4_156_000], MOSFILOTI, MPP, DECL)!,
  W,
  H,
  ...MOSFILOTI
);

// Course: control circles on the scan (6 mm at 1:10 000 = 60 m → r ≈ 35 px)
const CONTROL_PX: [number, number][] = [
  [600, 500],
  [1500, 400],
  [2600, 700],
  [3000, 1600],
  [2200, 2100],
  [1200, 2000],
  [700, 1500],
  [900, 900],
];
const R_PX = 30 / MPP;
const START_PX: [number, number] = [400, 800];

const truthLL = (p: [number, number]) => pixelToLonLat(TRUTH, p[0], p[1]);

/** Runner through all controls; `detourM` pushes each leg sideways (different route choice) */
function runner(id: string, speed: number, detourM: number) {
  const wps: [number, number][] = [truthLL(START_PX)];
  let prev = truthLL(START_PX);
  for (const c of CONTROL_PX) {
    const next = truthLL(c);
    if (detourM) {
      // midpoint shifted perpendicular to the leg
      const mx = (prev[0] + next[0]) / 2;
      const my = (prev[1] + next[1]) / 2;
      const dx = next[0] - prev[0];
      const dy = next[1] - prev[1];
      const len = Math.hypot(dx, dy);
      const k = detourM / 111_320;
      wps.push([mx - (dy / len) * k, my + (dx / len) * k]);
    }
    wps.push(next);
    prev = next;
  }
  const samples = [];
  let t = 0;
  for (let i = 0; i < 15; i++, t++) samples.push({ timeMs: t * 1000, lon: wps[0][0], lat: wps[0][1] });
  for (let s = 0; s < wps.length - 1; s++) {
    const [lon0, lat0] = wps[s];
    const [lon1, lat1] = wps[s + 1];
    const steps = Math.max(1, Math.round(haversineDistanceM(lon0, lat0, lon1, lat1) / speed));
    for (let k = 1; k <= steps; k++, t++) {
      samples.push({
        timeMs: t * 1000,
        lon: lon0 + ((lon1 - lon0) * k) / steps,
        lat: lat0 + ((lat1 - lat0) * k) / steps,
      });
    }
  }
  return normalizeSamplesToTrack({ id, name: id, color: '#f00', sourceFormat: 'gpx', samples });
}

describe('fully automatic georeferencing', () => {
  it('places the scan from detected circles + tracks without any manual input', () => {
    const circles: DetectedCircle[] = [
      ...CONTROL_PX.map(([px, py], i) => ({
        px: px + ((i % 3) - 1) * 0.8, // detection noise
        py: py - ((i % 2) - 0.5),
        r: R_PX + (i % 2 ? 1 : -1),
        coverage: 0.9,
      })),
      // false detections nobody ran through
      { px: 1800, py: 1250, r: R_PX, coverage: 0.7 },
      { px: 300, py: 2300, r: R_PX, coverage: 0.65 },
    ];
    const runners = [runner('a', 3.6, 0), runner('b', 3.1, 70)];

    const res = autoGeoref({ circles, participants: runners, declinationDeg: DECL })!;
    expect(res).not.toBeNull();
    expect(res.matchedCircles).toHaveLength(CONTROL_PX.length);
    expect(res.rmsM).toBeLessThan(2);
    expect(res.impliedPrintScale).toBe(10000);

    // Every control lands where it really is
    for (const p of CONTROL_PX) {
      const [lon, lat] = pixelToLonLat(res.matrix, p[0], p[1]);
      expect(haversineDistanceM(lon, lat, ...truthLL(p))).toBeLessThan(2);
    }

    // Course built in the order the runners went: start, 1…7, finish
    expect(res.controls.map((c) => c.kind)).toEqual([
      'start',
      ...Array(CONTROL_PX.length - 1).fill('control'),
      'finish',
    ]);
    res.controls.slice(1).forEach((c, i) => {
      expect(Math.hypot(c.px - CONTROL_PX[i][0], c.py - CONTROL_PX[i][1])).toBeLessThan(3);
    });
  });

  it('gives up instead of guessing when the circles do not fit the tracks', () => {
    const circles: DetectedCircle[] = [
      { px: 100, py: 100, r: R_PX, coverage: 0.8 },
      { px: 3300, py: 200, r: R_PX, coverage: 0.8 },
      { px: 1700, py: 2400, r: R_PX, coverage: 0.8 },
    ];
    // a short track far smaller than the circle pattern
    const res = autoGeoref({
      circles,
      participants: [runner('a', 3.6, 0)].map((r) => ({ ...r, points: r.points.slice(0, 40) })),
      declinationDeg: DECL,
    });
    expect(res === null || res.matchedCircles.length < 3).toBe(true);
  });
});
