import { describe, expect, it } from 'vitest';
import {
  computeSplits,
  controlLabels,
  controlsLonLat,
  correctTrackToControls,
  detectControlPassages,
  fitMapToCourse,
  courseOnGround,
  courseToGround,
  groundToCourse,
  GROUND_MATRIX,
} from './course.js';
import { haversineDistanceM, lonLatToPixel, nudgeMapMatrix } from './georef.js';
import { normalizeSamplesToTrack } from './trackParser.js';
import type { CourseControl, RaceEvent } from './types.js';

const BASE_MS = Date.parse('2026-11-08T08:00:00Z');
const M_PER_DEG_LAT = 111_320;
const LAT0 = 34.77;
const LON0 = 32.42;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);

/** lon/lat of a point `east`/`north` metres from the origin */
function at(east: number, north: number): [number, number] {
  return [LON0 + east / M_PER_DEG_LON, LAT0 + north / M_PER_DEG_LAT];
}

// North-up map, 1 px = 1 m (mercator scale ≈ 1/cos(lat)), origin pixel (500, 500) = (LON0, LAT0)
const S = 1 / Math.cos((LAT0 * Math.PI) / 180);
const ORIGIN_MERC_X = (LON0 * Math.PI * 6378137) / 180;
const ORIGIN_MERC_Y =
  Math.log(Math.tan(((90 + LAT0) * Math.PI) / 360)) * 6378137;
const MATRIX: [number, number, number, number, number, number] = [
  S,
  0,
  ORIGIN_MERC_X - S * 500,
  0,
  -S,
  ORIGIN_MERC_Y + S * 500,
];

function control(kind: CourseControl['kind'], east: number, north: number): CourseControl {
  const [lon, lat] = at(east, north);
  const [px, py] = lonLatToPixel(MATRIX, lon, lat)!;
  return { id: `${kind}-${east}-${north}`, kind, px, py };
}

/**
 * Runner: waits 20 s at the start, then runs S(0,0) → 1(300,0) → 2(300,300) → back past
 * the start → F(0,20), at `speed` m/s, with a constant GPS offset of `driftEast` metres.
 */
function runner(id: string, speed: number, drift: [number, number] = [0, 0]) {
  const [driftEast, driftNorth] = drift;
  const route: [number, number][] = [
    [0, 0],
    [300, 0],
    [300, 300],
    [0, 300],
    [0, 20],
  ];
  const samples = [];
  let t = 0;
  for (let i = 0; i < 20; i++, t++) {
    const [lon, lat] = at(driftEast, driftNorth);
    samples.push({ timeMs: BASE_MS + t * 1000, lon, lat });
  }
  for (let seg = 0; seg < route.length - 1; seg++) {
    const [x0, y0] = route[seg];
    const [x1, y1] = route[seg + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.round(len / speed);
    for (let s = 1; s <= steps; s++, t++) {
      const f = s / steps;
      const [lon, lat] = at(
        x0 + (x1 - x0) * f + driftEast,
        y0 + (y1 - y0) * f + driftNorth
      );
      samples.push({ timeMs: BASE_MS + t * 1000, lon, lat });
    }
  }
  return normalizeSamplesToTrack({
    id,
    name: id,
    color: '#ef4444',
    sourceFormat: 'gpx',
    samples,
  });
}

const COURSE: CourseControl[] = [
  control('start', 0, 0),
  control('control', 300, 0),
  control('control', 300, 300),
  control('finish', 0, 20),
];

describe('course controls & splits', () => {
  it('labels controls like an overprint', () => {
    expect(controlLabels(COURSE)).toEqual(['S', '1', '2', 'F']);
  });

  it('detects punches in course order, even when the finish is next to the start', () => {
    const r = runner('a', 4);
    const ll = controlsLonLat(COURSE, MATRIX);
    const passages = detectControlPassages(r.points, ll, COURSE.map((c) => c.kind));
    expect(passages.every((p) => p.detected)).toBe(true);
    // Start = leaving the triangle after waiting, not the first point
    expect(passages[0].t).toBeGreaterThanOrEqual(15);
    // Leg 1 is 300 m at 4 m/s
    expect(passages[1].t - passages[0].t).toBeGreaterThan(65);
    expect(passages[1].t - passages[0].t).toBeLessThan(85);
    // The finish (20 m from the start) is punched at the end, not at the start
    expect(passages[3].t).toBeGreaterThan(passages[2].t);
  });

  it('ranks legs: the faster runner wins every leg', () => {
    const rows = computeSplits([runner('fast', 5), runner('slow', 3)], COURSE, MATRIX);
    const fast = rows.find((r) => r.participantId === 'fast')!;
    const slow = rows.find((r) => r.participantId === 'slow')!;
    expect(fast.legRanks.every((r) => r === 1)).toBe(true);
    expect(slow.legRanks.every((r) => r === 2)).toBe(true);
    expect(fast.totalRank).toBe(1);
    expect(fast.totalSec!).toBeLessThan(slow.totalSec!);
  });

  it('pulls a sideways-drifted GPS track onto the controls', () => {
    // Controls in the middle of the east/west legs; GPS 30 m north, i.e. across the
    // direction of running there (drift ALONG the running direction is invisible to
    // closest-approach punching — that ambiguity needs a manual adjustment)
    const course: CourseControl[] = [
      control('start', 0, 0),
      control('control', 150, 0),
      control('control', 150, 300),
      control('finish', 0, 20),
    ];
    const drift: [number, number] = [0, 30];
    const raw = runner('drift', 4, drift);
    const ll = controlsLonLat(course, MATRIX);
    const passages = detectControlPassages(raw.points, ll, course.map((c) => c.kind));
    expect(passages.every((p) => p.detected)).toBe(true);
    const fixed = correctTrackToControls(raw.points, passages, ll);

    const p1 = fixed[passages[1].idx];
    expect(haversineDistanceM(p1.lon, p1.lat, ll[1][0], ll[1][1])).toBeLessThan(1);
    // Every point between the punches is back on the true route
    for (let i = passages[1].idx; i <= passages[2].idx; i++) {
      const trueLat = raw.points[i].lat - drift[1] / M_PER_DEG_LAT;
      expect(Math.abs(fixed[i].lat - trueLat) * M_PER_DEG_LAT).toBeLessThan(1);
    }
  });
});

describe('GPS noise cleanup', () => {
  it('drops a cold-start fix and an out-and-back spike', () => {
    const samples = [];
    // Cold start: first fix 400 m away
    const [flon, flat] = at(400, 400);
    samples.push({ timeMs: BASE_MS, lon: flon, lat: flat });
    for (let i = 1; i <= 30; i++) {
      const [lon, lat] = at(i * 3, 0);
      samples.push({ timeMs: BASE_MS + i * 1000, lon, lat });
    }
    // Spike at t=15: 150 m to the side and back
    const [slon, slat] = at(45, 150);
    samples[15] = { timeMs: BASE_MS + 15_000, lon: slon, lat: slat };

    const t = normalizeSamplesToTrack({
      id: 'n',
      name: 'n',
      color: '#ef4444',
      sourceFormat: 'gpx',
      samples,
    });
    expect(t.points).toHaveLength(29); // 31 − cold start − spike
    // ~29 × 3 m, not hundreds of metres of fake distance
    expect(t.totalDistanceM).toBeLessThan(100);
  });
});

describe('semi-automatic map fit from the course', () => {
  it('recovers the true placement from a rough one using the controls and tracks', () => {
    // Course with controls at the corners of the runners' route
    const course: CourseControl[] = [
      control('start', 0, 0),
      control('control', 300, 0),
      control('control', 300, 300),
      control('control', 0, 300),
      control('finish', 0, 20),
    ];
    const runners = [runner('a', 4), runner('b', 3.2), runner('c', 4.6)];

    // Rough placement: ~90 m off, turned 5°, 8% too big
    const rough = nudgeMapMatrix(MATRIX, 1000, 1000, {
      dEastM: 70,
      dNorthM: -60,
      dAngleDeg: 5,
      scaleFactor: 1.08,
    }).matrix;
    const roughLL = controlsLonLat(course, rough);
    const trueLL = controlsLonLat(course, MATRIX);
    const worstRough = Math.max(
      ...roughLL.map((ll, k) => haversineDistanceM(...ll, ...trueLL[k]))
    );
    expect(worstRough).toBeGreaterThan(80);

    const fit = fitMapToCourse(runners, course, rough)!;
    expect(fit.mode).toBe('similarity');
    expect(fit.usedControls).toBe(5);
    // From >80 m off to a few metres. Not exactly 0: every runner here takes the same
    // straight legs, and a corner control can slide slightly along a leg while the
    // closest track point stays close (the along-track ambiguity). Real runners take
    // different routes, and GPS itself is ±5 m, so this is the accuracy that matters.
    expect(fit.rmsM).toBeLessThan(3);
    const fittedLL = controlsLonLat(course, fit.matrix);
    fittedLL.forEach((ll, k) => {
      expect(haversineDistanceM(...ll, ...trueLL[k])).toBeLessThan(5);
    });
  });

  it('returns null without tracks or with fewer than two controls', () => {
    expect(fitMapToCourse([], [control('start', 0, 0), control('finish', 0, 20)], MATRIX)).toBeNull();
    expect(fitMapToCourse([runner('a', 4)], [control('start', 0, 0)], MATRIX)).toBeNull();
  });
});

describe('course marked on the ground (no scan)', () => {
  const ground = COURSE.map((c) => {
    const [lon, lat] = controlsLonLat([c], MATRIX)[0];
    return { id: c.id, kind: c.kind, lon, lat };
  });

  it('round-trips coordinates through the ground frame', () => {
    const back = courseToGround(groundToCourse(ground));
    back.forEach((c, i) => {
      expect(c.kind).toBe(ground[i].kind);
      expect(c.lon).toBeCloseTo(ground[i].lon, 9);
      expect(c.lat).toBeCloseTo(ground[i].lat, 9);
    });
  });

  it('gives the same splits as the same course drawn on a scan', () => {
    const runners = [runner('a', 4), runner('b', 3, [8, -5])];
    const onScan = computeSplits(runners, COURSE, MATRIX);
    const onGround = computeSplits(runners, groundToCourse(ground), GROUND_MATRIX);
    expect(onGround.map((s) => s.legTimes)).toEqual(onScan.map((s) => s.legTimes));
    expect(onGround[0].legTimes.every((t) => t !== null)).toBe(true);
  });

  it('is the course when there is no scan, or when one was marked anyway', () => {
    const map = { controls: COURSE } as unknown as RaceEvent['map'];
    expect(courseOnGround({})).toBe(true);
    expect(courseOnGround({ map })).toBe(false);
    expect(courseOnGround({ map, course: [] })).toBe(false);
    expect(courseOnGround({ map, course: ground })).toBe(true);
  });
});
