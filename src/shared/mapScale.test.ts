import { describe, expect, it } from 'vitest';
import {
  autoPlaceScreenshotOnBounds,
  buildScaledOrientedMatrix,
  groundMetersPerPixelFromPrint,
  groundMetersPerPixelFromScaleBar,
  haversineDistanceM,
  lonLatToPixel,
  matrixGroundMetersPerPixel,
  matrixUpBearingDeg,
  pixelToLonLat,
} from './georef.js';
import { magneticDeclinationDeg } from './declination.js';

const START: [number, number] = [32.4245, 34.772]; // Paphos

function initialMatrix() {
  return autoPlaceScreenshotOnBounds(3504, 2544, {
    minLon: 32.415,
    maxLon: 32.435,
    minLat: 34.765,
    maxLat: 34.78,
  }).matrix;
}

describe('map scale & north', () => {
  it('converts print scale + DPI to ground metres per pixel', () => {
    // 1:10 000 at 300 dpi: 1 px = 1/300 inch on paper = 0.0846667 cm -> 8.4667 m on the ground
    expect(groundMetersPerPixelFromPrint(10000, 300)).toBeCloseTo(0.84667, 4);
  });

  it('builds an exact-scale, magnetic-north placement without moving the Start', () => {
    const m0 = initialMatrix();
    const startPx = lonLatToPixel(m0, START[0], START[1])!;
    const m = buildScaledOrientedMatrix(m0, START, 0.5, 5.3)!;

    // Start stays on the same map pixel
    const [lon, lat] = pixelToLonLat(m, startPx[0], startPx[1]);
    expect(haversineDistanceM(lon, lat, START[0], START[1])).toBeLessThan(0.01);

    // Map "up" points to magnetic north (declination east of true north)
    expect(matrixUpBearingDeg(m)).toBeCloseTo(5.3, 6);
    expect(matrixGroundMetersPerPixel(m, START[1])).toBeCloseTo(0.5, 6);

    // 1000 px along the map's x axis is 500 m on the ground
    const p1 = pixelToLonLat(m, startPx[0], startPx[1]);
    const p2 = pixelToLonLat(m, startPx[0] + 1000, startPx[1]);
    expect(haversineDistanceM(p1[0], p1[1], p2[0], p2[1])).toBeCloseTo(500, 0);
  });

  it('measures ground scale from a scale bar clicked on the displayed map', () => {
    const m = buildScaledOrientedMatrix(initialMatrix(), START, 0.5, 0)!;
    const a = pixelToLonLat(m, 1000, 2000);
    const b = pixelToLonLat(m, 1600, 2000); // 600 px bar
    expect(groundMetersPerPixelFromScaleBar(m, a, b, 300)).toBeCloseTo(0.5, 6);
  });

  it('computes WMM declination (Paphos ≈ +5°, Moscow ≈ +12°)', () => {
    const when = new Date('2026-11-08T08:00:00Z');
    expect(magneticDeclinationDeg(32.42, 34.77, when)).toBeGreaterThan(4);
    expect(magneticDeclinationDeg(32.42, 34.77, when)).toBeLessThan(7);
    expect(magneticDeclinationDeg(37.55, 55.6, when)).toBeGreaterThan(10);
    expect(magneticDeclinationDeg(37.55, 55.6, when)).toBeLessThan(14);
  });
});
