import { describe, expect, it } from 'vitest';
import {
  formatPaceMinKm,
  interpolateTrackAt,
  MAX_TRACK_POINTS,
  normalizeSamplesToTrack,
  parseGpxText,
  parseTcxText,
  raceTimeOfTrackPoint,
  xmlElements,
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
  it('fitness handicap brings fast and slow runners to the reference speed', () => {
    const fast = makeRunner('fast', 4);
    const slow = makeRunner('slow', 2);
    const ref = 3;
    const at = 100;
    const f = interpolateTrackAt(fast, at, 'from_start', 0, 'fitness_handicap', ref)!;
    const s = interpolateTrackAt(slow, at, 'from_start', 0, 'fitness_handicap', ref)!;
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
    for (const mode of ['real', 'fitness_handicap', 'equal_speed'] as const) {
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

describe('track files from the internet', () => {
  const pt = (i: number, attrs = `lat="55.${i}" lon="37.${i}"`) =>
    `<trkpt ${attrs}><time>2026-10-18T08:00:${String(i).padStart(2, '0')}Z</time></trkpt>`;

  it('reads points with lat/lon in either order, skips self-closing ones', () => {
    const xml = `<gpx><trk><trkseg>${pt(1)}<trkpt lat="1" lon="2"/>${pt(2, "lon='37.2' lat='55.2'")}</trkseg></trk></gpx>`;
    const { samples } = parseGpxText(xml);
    expect(samples.map((s) => [s.lat, s.lon])).toEqual([
      [55.1, 37.1],
      [55.2, 37.2],
    ]);
  });

  it('elements: bodies in order, a missing closing tag ends the scan', () => {
    const items = [...xmlElements('<a x="1">one</a><A>two</A ><a/><a>three', 'a')];
    expect(items.map((e) => e.body)).toEqual(['one', 'two']);
    expect(items[0].attrs.trim()).toBe('x="1"');
  });

  // Unclosed tags made the old regex rescan the rest of the file from each of them:
  // 200 KB took seconds, 40 MB — hours, with the whole server frozen
  it('unclosed tags take linear time, not quadratic', () => {
    const size = 4 * 1024 * 1024;
    const gpx = '<gpx><trk><trkseg>' + '<trkpt lat="1" lon="1">'.repeat(size / 23);
    const tcx = '<TrainingCenterDatabase>' + '<Trackpoint>'.repeat(size / 12);
    const noGt = '<gpx>' + '<trkpt lat="1"'.repeat(size / 14);
    const t = Date.now();
    expect(parseGpxText(gpx).samples).toEqual([]);
    expect(parseTcxText(tcx).samples).toEqual([]);
    expect(parseGpxText(noGt).samples).toEqual([]);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('a track longer than the limit is refused', () => {
    const one = pt(1);
    const xml = '<gpx>' + one.repeat(MAX_TRACK_POINTS + 1) + '</gpx>';
    expect(() => parseGpxText(xml)).toThrow(/точек/);
  });
});
