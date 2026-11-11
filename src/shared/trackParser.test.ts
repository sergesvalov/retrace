import { describe, expect, it } from 'vitest';
import {
  formatPaceMinKm,
  interpolateTrackAt,
  normalizeSamplesToTrack,
  parseGpxText,
  raceTimeOfTrackPoint,
} from './trackParser.js';

const BASE_MS = Date.parse('2026-10-18T08:00:00Z');

/** Straight run north at a constant speed (one point every 10 s). */
function makeRunner(id: string, speedMs: number, points = 31) {
  const degPerM = 1 / 111_320;
  const samples = Array.from({ length: points }, (_, i) => ({
    timeMs: BASE_MS + i * 10_000,
    lat: 55.6 + i * 10 * speedMs * degPerM,
    lon: 37.55,
  }));
  const t = normalizeSamplesToTrack({
    id,
    name: id,
    color: '#ef4444',
    sourceFormat: 'gpx',
    samples,
  });
  t.trimStartSec = 0;
  return t;
}

describe('replay timing', () => {
  it('Livelox handicap brings fast and slow runners to the reference speed', () => {
    const fast = makeRunner('fast', 4);
    const slow = makeRunner('slow', 2);
    const ref = 3;
    const at = 100;
    const f = interpolateTrackAt(fast, at, 'from_start', 0, 'livelox_handicap', ref)!;
    const s = interpolateTrackAt(slow, at, 'from_start', 0, 'livelox_handicap', ref)!;
    // Both cover ~ref * t metres, instead of the fast runner pulling further ahead
    expect(f.distM).toBeGreaterThan(ref * at * 0.95);
    expect(f.distM).toBeLessThan(ref * at * 1.05);
    expect(s.distM).toBeGreaterThan(ref * at * 0.95);
    expect(s.distM).toBeLessThan(ref * at * 1.05);
  });

  it('finished runner stands on the last track point', () => {
    const r = makeRunner('r', 3);
    const st = interpolateTrackAt(r, 10_000, 'from_start', 0)!;
    const last = r.points[r.points.length - 1];
    expect(st.finished).toBe(true);
    expect(st.lat).toBe(last.lat);
    expect(st.localT).toBe(last.t);
  });

  it('raceTimeOfTrackPoint is the inverse of interpolateTrackAt in every mode', () => {
    const r = makeRunner('r', 4);
    r.offsetSec = 7;
    const pt = r.points[12];
    for (const mode of ['real', 'livelox_handicap', 'equal_speed'] as const) {
      const raceT = raceTimeOfTrackPoint(r, pt, 'from_start', 0, mode, 3);
      const st = interpolateTrackAt(r, raceT, 'from_start', 0, mode, 3)!;
      expect(st.localT).toBeCloseTo(pt.t, 3);
    }
    const realT = raceTimeOfTrackPoint(r, pt, 'real', BASE_MS);
    const st = interpolateTrackAt(r, realT, 'real', BASE_MS)!;
    expect(st.localT).toBeCloseTo(pt.t, 3);
  });

  it('formats pace without a ":60" overflow', () => {
    expect(formatPaceMinKm(1000 / 299.6)).toBe('5:00 /км');
    expect(formatPaceMinKm(4.0)).toBe('4:10 /км');
  });
});

describe('GPX parsing', () => {
  it('ignores self-closing trkpt without swallowing the next point', () => {
    const gpx = `<gpx><trk><trkseg>
      <trkpt lat="55.1" lon="37.1"/>
      <trkpt lat="55.2" lon="37.2"><time>2026-10-18T08:00:00Z</time></trkpt>
      <trkpt lat="55.3" lon="37.3"><time>2026-10-18T08:00:10Z</time></trkpt>
    </trkseg></trk></gpx>`;
    const res = parseGpxText(gpx);
    expect(res.samples.map((s) => s.lat)).toEqual([55.2, 55.3]);
  });
});
