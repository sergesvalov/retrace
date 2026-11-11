import { describe, expect, it } from 'vitest';
import {
  buildScaledOrientedMatrix,
  haversineDistanceM,
  lonLatToPixel,
  matrixGroundMetersPerPixel,
  matrixUpBearingDeg,
  nudgeMapMatrix,
  pixelToLonLat,
  solvePins,
} from './georef.js';
import type { GCP } from './types.js';

const START: [number, number] = [33.42, 34.95]; // Mosfiloti
// "True" placement of a 3504×2544 scan: 0.42 m/px, magnetic north +5.3°
const TRUTH = buildScaledOrientedMatrix(
  [1, 0, 3_720_000, 0, -1, 4_156_000],
  START,
  0.42,
  5.3
)!;

/** A landmark: a scan pixel and where it really is (under the true placement) */
function landmark(px: number, py: number, noiseEastM = 0): GCP {
  const [lon, lat] = pixelToLonLat(TRUTH, px, py);
  return {
    id: `p${px}-${py}`,
    label: '',
    px,
    py,
    lon: lon + noiseEastM / (111_320 * Math.cos((lat * Math.PI) / 180)),
    lat,
  };
}

const ROUGH = nudgeMapMatrix(TRUTH, 3504, 2544, {
  dEastM: 120,
  dNorthM: -80,
  dAngleDeg: 3,
  scaleFactor: 0.93,
}).matrix;

describe('landmark pins', () => {
  it('one pin only shifts: scale and north from the print scale are kept', () => {
    const pin = landmark(800, 600);
    const sol = solvePins([pin], ROUGH)!;
    expect(sol.mode).toBe('shift');
    const [lon, lat] = pixelToLonLat(sol.matrix, pin.px, pin.py);
    expect(haversineDistanceM(lon, lat, pin.lon, pin.lat)).toBeLessThan(0.01);
    expect(matrixGroundMetersPerPixel(sol.matrix, lat)).toBeCloseTo(
      matrixGroundMetersPerPixel(ROUGH, lat),
      6
    );
    expect(matrixUpBearingDeg(sol.matrix)).toBeCloseTo(matrixUpBearingDeg(ROUGH), 6);
  });

  it('two pins recover shift, scale and rotation exactly', () => {
    const sol = solvePins([landmark(400, 500), landmark(3000, 2100)], ROUGH)!;
    expect(sol.mode).toBe('similarity');
    expect(sol.rmsErrorM).toBeLessThan(0.1);
    const far = lonLatToPixel(sol.matrix, ...pixelToLonLat(TRUTH, 3400, 100))!;
    expect(Math.hypot(far[0] - 3400, far[1] - 100)).toBeLessThan(0.5);
    expect(matrixUpBearingDeg(sol.matrix)).toBeCloseTo(5.3, 3);
  });

  it('reports the residual of a badly clicked pin', () => {
    const sol = solvePins(
      [landmark(400, 500), landmark(3000, 2100), landmark(1700, 300, 25)],
      ROUGH
    )!;
    const bad = sol.pins[2].residualM!;
    expect(bad).toBeGreaterThan(8);
    expect(sol.pins[0].residualM!).toBeLessThan(bad);
  });

  it('four pins use an affine fit (absorbs paper stretch)', () => {
    const sol = solvePins(
      [landmark(300, 300), landmark(3200, 400), landmark(3100, 2300), landmark(400, 2200)],
      ROUGH
    )!;
    expect(sol.mode).toBe('affine');
    expect(sol.rmsErrorM).toBeLessThan(0.5);
  });
});
