import { describe, expect, it } from 'vitest';
import {
  autoPlaceScreenshotOnBounds,
  boundsForViewShare,
  boundsOverlap,
  buildScaledOrientedMatrix,
  groundMetersPerPixelFromPrint,
  groundMetersPerPixelFromScaleBar,
  haversineDistanceM,
  lonLatToPixel,
  matrixBounds,
  matrixGroundMetersPerPixel,
  matrixUpBearingDeg,
  pixelToLonLat,
  translateMatrixCenterTo,
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

describe('map placement helpers', () => {
  it('moves the map centre to a point keeping scale and rotation', () => {
    const m0 = buildScaledOrientedMatrix(initialMatrix(), START, 0.5, 5.3)!;
    const mosfiloti: [number, number] = [33.42, 34.95];
    const m = translateMatrixCenterTo(m0, 3504, 2544, mosfiloti[0], mosfiloti[1]);
    const [lon, lat] = pixelToLonLat(m, 1752, 1272);
    expect(haversineDistanceM(lon, lat, mosfiloti[0], mosfiloti[1])).toBeLessThan(0.01);
    expect(m.slice(0, 2)).toEqual(m0.slice(0, 2));
    expect(m.slice(3, 5)).toEqual(m0.slice(3, 5));
  });

  it('places a map without tracks inside the current view', () => {
    const view = { minLon: 33.38, maxLon: 33.46, minLat: 34.93, maxLat: 34.97 };
    const { matrix } = autoPlaceScreenshotOnBounds(3504, 2544, boundsForViewShare(view));
    const b = matrixBounds(matrix, 3504, 2544);
    expect(boundsOverlap(b, view)).toBe(true);
    expect(b.minLon).toBeGreaterThanOrEqual(view.minLon);
    expect(b.maxLon).toBeLessThanOrEqual(view.maxLon);
    // Paphos (the old hard-coded default) is nowhere near
    expect(boundsOverlap(b, { minLon: 32.4, maxLon: 32.45, minLat: 34.76, maxLat: 34.79 })).toBe(false);
  });
});
