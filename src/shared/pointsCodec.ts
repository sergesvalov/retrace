import type { ParticipantTrack, RaceEvent, TrackPoint } from './types.js';

/**
 * Compact, column-oriented track points for the wire and the disk.
 * An array of {t, absTimeMs, lat, lon, …} objects repeats every key for every point
 * (~150 bytes/point); columns of rounded numbers are ~4× smaller and gzip ~3× better.
 * `absTimeMs` is not stored: it is `startMs + t·1000` (t was derived from it).
 */
export interface PackedPoints {
  v: 1;
  startMs: number;
  t: number[];
  lat: number[];
  lon: number[];
  distM: number[];
  speedMs: number[];
  /** Optional columns: null where a sample has no value; omitted entirely when none has */
  ele?: (number | null)[];
  hr?: (number | null)[];
  cad?: (number | null)[];
}

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

export function packPoints(points: TrackPoint[], startMs: number): PackedPoints {
  const optional = (key: 'ele' | 'hr' | 'cad', digits: number) => {
    if (!points.some((p) => p[key] !== undefined)) return undefined;
    return points.map((p) => (p[key] === undefined ? null : round(p[key]!, digits)));
  };
  const packed: PackedPoints = {
    v: 1,
    startMs,
    t: points.map((p) => round(p.t, 1)),
    // 7 decimals ≈ 1 cm: far below GPS accuracy
    lat: points.map((p) => round(p.lat, 7)),
    lon: points.map((p) => round(p.lon, 7)),
    distM: points.map((p) => round(p.distM, 1)),
    speedMs: points.map((p) => round(p.speedMs, 2)),
  };
  const ele = optional('ele', 1);
  const hr = optional('hr', 0);
  const cad = optional('cad', 0);
  if (ele) packed.ele = ele;
  if (hr) packed.hr = hr;
  if (cad) packed.cad = cad;
  return packed;
}

export function unpackPoints(packed: PackedPoints): TrackPoint[] {
  const out: TrackPoint[] = new Array(packed.t.length);
  for (let i = 0; i < packed.t.length; i++) {
    const p: TrackPoint = {
      t: packed.t[i],
      absTimeMs: packed.startMs + Math.round(packed.t[i] * 1000),
      lat: packed.lat[i],
      lon: packed.lon[i],
      distM: packed.distM[i],
      speedMs: packed.speedMs[i],
    };
    const ele = packed.ele?.[i];
    const hr = packed.hr?.[i];
    const cad = packed.cad?.[i];
    if (ele !== undefined && ele !== null) p.ele = ele;
    if (hr !== undefined && hr !== null) p.hr = hr;
    if (cad !== undefined && cad !== null) p.cad = cad;
    out[i] = p;
  }
  return out;
}

/** Participant as sent over the wire with its points packed */
export type WireParticipant = Omit<ParticipantTrack, 'points'> & { packed: PackedPoints };

/** Participant without points: what change responses carry (the client keeps the points) */
export type LiteParticipant = Omit<ParticipantTrack, 'points'>;

export type WireEvent = Omit<RaceEvent, 'participants'> & { participants: WireParticipant[] };
export type LiteEvent = Omit<RaceEvent, 'participants'> & { participants: LiteParticipant[] };

export function trackStartMs(p: ParticipantTrack): number {
  return p.points[0]?.absTimeMs ?? Date.parse(p.startedAtIso);
}

export function toWireParticipant(p: ParticipantTrack): WireParticipant {
  const { points, ...rest } = p;
  return { ...rest, packed: packPoints(points, trackStartMs(p)) };
}

export function fromWireParticipant(p: WireParticipant): ParticipantTrack {
  const { packed, ...rest } = p;
  return { ...rest, points: unpackPoints(packed) };
}

export function toWireEvent(evt: RaceEvent): WireEvent {
  return { ...evt, participants: evt.participants.map(toWireParticipant) };
}

export function fromWireEvent(evt: WireEvent): RaceEvent {
  return { ...evt, participants: evt.participants.map(fromWireParticipant) };
}

export function toLiteEvent(evt: RaceEvent): LiteEvent {
  return {
    ...evt,
    participants: evt.participants.map(({ points: _points, ...rest }) => rest),
  };
}

/**
 * Apply a change response (no points) to the event the client holds: participants keep the
 * points they already have; `added` supplies points for newly uploaded tracks.
 */
export function mergeLiteEvent(
  prev: RaceEvent | null,
  lite: LiteEvent,
  added: ParticipantTrack[] = []
): RaceEvent {
  const known = new Map<string, TrackPoint[]>();
  if (prev && prev.id === lite.id) {
    for (const p of prev.participants) known.set(p.id, p.points);
  }
  for (const p of added) known.set(p.id, p.points);
  return {
    ...lite,
    participants: lite.participants.map((p) => {
      // points sent along (an older server, or a full event) win over the cached ones
      const own = (p as Partial<ParticipantTrack>).points;
      return { ...p, points: Array.isArray(own) ? own : known.get(p.id) ?? [] };
    }),
  };
}
