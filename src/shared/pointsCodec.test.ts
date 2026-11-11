import { describe, expect, it } from 'vitest';
import {
  fromWireEvent,
  mergeLiteEvent,
  packPoints,
  toLiteEvent,
  toWireEvent,
  unpackPoints,
} from './pointsCodec.js';
import { normalizeSamplesToTrack } from './trackParser.js';
import type { RaceEvent } from './types.js';

const BASE = Date.parse('2026-11-08T08:00:00Z');

function track(id: string, n = 300) {
  return normalizeSamplesToTrack({
    id,
    name: id,
    color: '#ef4444',
    sourceFormat: 'fit',
    samples: Array.from({ length: n }, (_, i) => ({
      timeMs: BASE + i * 1000,
      lat: 34.95 + i * 0.00003 + Math.sin(i) * 0.000004,
      lon: 33.42 + i * 0.00002,
      ele: i % 7 === 0 ? undefined : 250 + i * 0.13,
      hr: 120 + (i % 40),
    })),
  });
}

function event(): RaceEvent {
  return {
    id: 'e1',
    slug: 'e1',
    title: 'Мосфилоти',
    description: '',
    createdAt: new Date(BASE).toISOString(),
    timeMode: 'from_start',
    participants: [track('a'), track('b', 120)],
  };
}

describe('compact track points', () => {
  it('round-trips points within GPS-irrelevant rounding', () => {
    const t = track('a');
    const back = unpackPoints(packPoints(t.points, t.points[0].absTimeMs));
    expect(back).toHaveLength(t.points.length);
    back.forEach((p, i) => {
      const o = t.points[i];
      expect(p.absTimeMs).toBe(o.absTimeMs);
      expect(Math.abs(p.lat - o.lat)).toBeLessThan(1e-7);
      expect(Math.abs(p.lon - o.lon)).toBeLessThan(1e-7);
      expect(p.hr).toBe(o.hr);
      expect(p.ele === undefined).toBe(o.ele === undefined);
      if (o.ele !== undefined) expect(Math.abs(p.ele! - o.ele)).toBeLessThanOrEqual(0.0501);
    });
  });

  it('is several times smaller than the object array', () => {
    const evt = event();
    const plain = JSON.stringify(evt).length;
    const wire = JSON.stringify(toWireEvent(evt)).length;
    expect(wire).toBeLessThan(plain / 2.5);
  });

  it('change responses carry no points; merging keeps the cached ones', () => {
    const evt = event();
    const lite = toLiteEvent({ ...evt, title: 'Новое имя' });
    expect(JSON.stringify(lite).length).toBeLessThan(2000);
    const merged = mergeLiteEvent(fromWireEvent(toWireEvent(evt)), lite);
    expect(merged.title).toBe('Новое имя');
    expect(merged.participants.map((p) => p.points.length)).toEqual([300, 120]);
  });

  it('new participants get their points from the upload response', () => {
    const evt = event();
    const c = track('c', 50);
    const lite = toLiteEvent({ ...evt, participants: [...evt.participants, c] });
    const merged = mergeLiteEvent(evt, lite, [c]);
    expect(merged.participants.find((p) => p.id === 'c')!.points).toHaveLength(50);
  });
});
