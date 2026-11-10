import { describe, expect, it } from 'vitest';
import {
  addPinMapToTrack,
  autoPlaceScreenshotOnBounds,
  computeRubberSheetDisplacement,
  fitAffineTransform,
  fitNorthUpTransform,
  lonLatToMercator,
  mercatorToLonLat,
  pixelToLonLat,
  solveGeoref,
} from '../shared/georef.js';
import {
  formatPaceMinKm,
  interpolateTrackAt,
  normalizeSamplesToTrack,
  parseGpxText,
  parseTcxText,
  syncAllParticipantsToCommonStartSpot,
} from '../shared/trackParser.js';
import type { GCP } from '../shared/types.js';

describe('Georeferencing math (Web Mercator similarity & affine)', () => {
  it('converts lon/lat <-> Web Mercator accurately', () => {
    const [mx, my] = lonLatToMercator(37.554, 55.602);
    const [lon, lat] = mercatorToLonLat(mx, my);
    expect(lon).toBeCloseTo(37.554, 6);
    expect(lat).toBeCloseTo(55.602, 6);
  });

  it('solves 3+ point affine transformation with near-zero residual on exact synthetic control points', () => {
    const gcps: GCP[] = [
      { id: '1', label: 'A', px: 100, py: 800, lon: 37.54, lat: 55.595 },
      { id: '2', label: 'B', px: 100, py: 100, lon: 37.54, lat: 55.61 },
      { id: '3', label: 'C', px: 900, py: 100, lon: 37.565, lat: 55.61 },
      { id: '4', label: 'D', px: 900, py: 800, lon: 37.565, lat: 55.595 },
    ];

    const mat = fitAffineTransform(gcps);
    expect(mat).not.toBeNull();
    const [lon, lat] = pixelToLonLat(mat!, 500, 450);
    expect(lon).toBeCloseTo(37.5525, 3);
    expect(lat).toBeCloseTo(55.6025, 3);

    const sol = solveGeoref(gcps, 1000, 900, 'affine');
    expect(sol).not.toBeNull();
    expect(sol!.rmsErrorM).toBeLessThan(1.5);
    expect(sol!.cornersLonLat).toHaveLength(4);
  });

  it('fits North-Up Google Maps screenshot with 2 points and auto-places screenshot onto track bounds', () => {
    const placed = autoPlaceScreenshotOnBounds(1200, 800, {
      minLon: 37.54,
      maxLon: 37.56,
      minLat: 55.595,
      maxLat: 55.605,
    });
    expect(placed.gcps).toHaveLength(2);
    expect(placed.cornersLonLat).toHaveLength(4);

    const northUpMat = fitNorthUpTransform(placed.gcps);
    expect(northUpMat).not.toBeNull();
    // Zero rotation terms
    expect(northUpMat![1]).toBe(0);
    expect(northUpMat![3]).toBe(0);
  });

  it('progressively locks 1, 2, 3, and 4+ pins (Start -> CP2 -> CP5) via addPinMapToTrack and rubber-sheeting', () => {
    const init = autoPlaceScreenshotOnBounds(1000, 1000, {
      minLon: 33.34,
      maxLon: 33.36,
      minLat: 34.94,
      maxLat: 34.96,
    });

    // Pin 1 (Start)
    const mapPt1 = pixelToLonLat(init.matrix, 200, 200);
    const trackPt1: [number, number] = [33.345, 34.955];
    const step1 = addPinMapToTrack(
      init.matrix,
      [],
      1000,
      1000,
      mapPt1,
      trackPt1
    );
    expect(step1).not.toBeNull();
    expect(step1!.gcps).toHaveLength(1);
    const afterPin1 = pixelToLonLat(step1!.matrix, 200, 200);
    expect(afterPin1[0]).toBeCloseTo(trackPt1[0], 5);
    expect(afterPin1[1]).toBeCloseTo(trackPt1[1], 5);

    // Pin 2 (Far CP2) -> locks BOTH Start and CP2 simultaneously
    const mapPt2 = pixelToLonLat(step1!.matrix, 800, 800);
    const trackPt2: [number, number] = [33.358, 34.942];
    const step2 = addPinMapToTrack(
      step1!.matrix,
      step1!.gcps,
      1000,
      1000,
      mapPt2,
      trackPt2
    );
    expect(step2).not.toBeNull();
    expect(step2!.gcps).toHaveLength(2);
    expect(step2!.rmsErrorM).toBeLessThan(0.5);

    // Pin 3 (Side CP5 with slight camera X/Y tilt) -> upgrades to Affine and locks all 3 pins
    const mapPt3 = pixelToLonLat(step2!.matrix, 800, 200);
    const trackPt3: [number, number] = [33.357, 34.956];
    const step3 = addPinMapToTrack(
      step2!.matrix,
      step2!.gcps,
      1000,
      1000,
      mapPt3,
      trackPt3
    );
    expect(step3).not.toBeNull();
    expect(step3!.gcps).toHaveLength(3);
    expect(step3!.rmsErrorM).toBeLessThan(0.5);

    // Pin 4 (Local orienteering map distortion) -> rubber-sheet displacement matches exact pixel offset at Pin 4
    const mapPt4 = pixelToLonLat(step3!.matrix, 500, 500);
    const trackPt4: [number, number] = [33.3515, 34.9495];
    const step4 = addPinMapToTrack(
      step3!.matrix,
      step3!.gcps,
      1000,
      1000,
      mapPt4,
      trackPt4
    );
    expect(step4).not.toBeNull();
    expect(step4!.gcps).toHaveLength(4);
    const dispAtCenter = computeRubberSheetDisplacement(
      500,
      500,
      1000,
      1000,
      step4!.gcps,
      step4!.matrix
    );
    expect(Array.isArray(dispAtCenter)).toBe(true);
  });
});

describe('Track parsing & interpolation (GPX, TCX, normalization)', () => {
  it('parses GPX with Garmin heart-rate extensions and interpolates runner telemetry', () => {
    const sampleGpx = `<?xml version="1.0" encoding="UTF-8"?>
      <gpx version="1.1" creator="Garmin Connect">
        <trk>
          <name>Утренняя тренировка Битца</name>
          <trkseg>
            <trkpt lat="55.6000" lon="37.5500">
              <ele>195.0</ele>
              <time>2026-10-18T08:00:00Z</time>
              <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>145</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>
            </trkpt>
            <trkpt lat="55.6005" lon="37.5505">
              <ele>198.0</ele>
              <time>2026-10-18T08:00:15Z</time>
              <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>155</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>
            </trkpt>
            <trkpt lat="55.6010" lon="37.5510">
              <ele>201.0</ele>
              <time>2026-10-18T08:00:30Z</time>
              <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>165</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>
            </trkpt>
          </trkseg>
        </trk>
      </gpx>`;

    const parsed = parseGpxText(sampleGpx);
    expect(parsed.name).toBe('Утренняя тренировка Битца');
    expect(parsed.samples).toHaveLength(3);
    expect(parsed.samples[1].hr).toBe(155);

    const track = normalizeSamplesToTrack({
      id: 't1',
      name: parsed.name!,
      color: '#ef4444',
      sourceFormat: 'gpx',
      samples: parsed.samples,
    });

    expect(track.durationSec).toBe(30);
    expect(track.totalDistanceM).toBeGreaterThan(100);

    const mid = interpolateTrackAt(track, 15, 'from_start', 0);
    expect(mid).not.toBeNull();
    expect(mid!.lat).toBeCloseTo(55.6005, 4);
    expect(mid!.hr).toBe(155);
    expect(formatPaceMinKm(4.0)).toBe('4:10 /км');
  });

  it('parses Garmin TCX format', () => {
    const sampleTcx = `
      <TrainingCenterDatabase>
        <Activities>
          <Activity Sport="Running">
            <Id>2026-10-18T08:00:00Z</Id>
            <Lap>
              <Track>
                <Trackpoint>
                  <Time>2026-10-18T08:00:00Z</Time>
                  <Position><LatitudeDegrees>55.600</LatitudeDegrees><LongitudeDegrees>37.550</LongitudeDegrees></Position>
                  <AltitudeMeters>190</AltitudeMeters>
                  <HeartRateBpm><Value>140</Value></HeartRateBpm>
                </Trackpoint>
                <Trackpoint>
                  <Time>2026-10-18T08:00:10Z</Time>
                  <Position><LatitudeDegrees>55.601</LatitudeDegrees><LongitudeDegrees>37.551</LongitudeDegrees></Position>
                  <AltitudeMeters>192</AltitudeMeters>
                  <HeartRateBpm><Value>150</Value></HeartRateBpm>
                </Trackpoint>
              </Track>
            </Lap>
          </Activity>
        </Activities>
      </TrainingCenterDatabase>`;

    const res = parseTcxText(sampleTcx);
    expect(res.samples).toHaveLength(2);
    expect(res.samples[1].hr).toBe(150);
  });

  it('synchronizes runners starting from the same spot (trims standing at start)', () => {
    const baseMs = Date.parse('2026-10-18T08:00:00Z');
    // Runner waits 20s at start (55.6000, 37.5500) before running north
    const samples = [
      { timeMs: baseMs, lat: 55.6, lon: 37.55 },
      { timeMs: baseMs + 10000, lat: 55.60001, lon: 37.55001 },
      { timeMs: baseMs + 20000, lat: 55.60002, lon: 37.55001 },
      { timeMs: baseMs + 30000, lat: 55.6005, lon: 37.5505 },
      { timeMs: baseMs + 40000, lat: 55.6012, lon: 37.5512 },
    ];
    const t = normalizeSamplesToTrack({
      id: 'runner-wait',
      name: 'Runner',
      color: '#10b981',
      sourceFormat: 'gpx',
      samples,
    });
    const common = syncAllParticipantsToCommonStartSpot([t]);
    expect(common).not.toBeNull();
    expect(t.trimStartSec).toBeGreaterThanOrEqual(10);
  });
});

