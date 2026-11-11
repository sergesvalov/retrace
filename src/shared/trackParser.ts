import FitParser from 'fit-file-parser';
import { haversineDistanceM } from './georef.js';
import type { ParticipantTrack, TrackPoint } from './types.js';

export interface RawTrackSample {
  timeMs: number;
  lat: number;
  lon: number;
  ele?: number;
  hr?: number;
  cad?: number;
}

const PALETTE = [
  '#ef4444', // red
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#a855f7', // purple
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#84cc16', // lime
];

export function pickTrackColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

/** Parse GPX XML text into raw samples */
export function parseGpxText(xml: string): {
  name?: string;
  samples: RawTrackSample[];
} {
  const nameMatch =
    xml.match(/<trk>\s*<name>([^<]+)<\/name>/i) ||
    xml.match(/<name>([^<]+)<\/name>/i);
  const name = nameMatch ? nameMatch[1].trim() : undefined;

  // `(?<!\/)>` skips self-closing <trkpt .../> (no <time>), which would otherwise swallow the next point's body
  const ptRegex =
    /<trkpt\b[^>]*?\blat=["']([^"']+)["'][^>]*?\blon=["']([^"']+)["'][^>]*(?<!\/)>([\s\S]*?)<\/trkpt>|<trkpt\b[^>]*?\blon=["']([^"']+)["'][^>]*?\blat=["']([^"']+)["'][^>]*(?<!\/)>([\s\S]*?)<\/trkpt>/gi;

  const samples: RawTrackSample[] = [];
  let match: RegExpExecArray | null;
  while ((match = ptRegex.exec(xml)) !== null) {
    const lat = parseFloat(match[1] ?? match[5]);
    const lon = parseFloat(match[2] ?? match[4]);
    const body = match[3] ?? match[6] ?? '';
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const timeMatch = body.match(/<time>([^<]+)<\/time>/i);
    const timeMs = timeMatch ? Date.parse(timeMatch[1].trim()) : NaN;
    if (!Number.isFinite(timeMs)) continue;

    const eleMatch = body.match(/<ele>([^<]+)<\/ele>/i);
    const hrMatch = body.match(
      /<(?:gpxtpx:hr|ns3:hr|hr)>([^<]+)<\/(?:gpxtpx:hr|ns3:hr|hr)>/i
    );
    const cadMatch = body.match(
      /<(?:gpxtpx:cad|ns3:cad|cad)>([^<]+)<\/(?:gpxtpx:cad|ns3:cad|cad)>/i
    );

    samples.push({
      timeMs,
      lat,
      lon,
      ele: eleMatch ? parseFloat(eleMatch[1]) : undefined,
      hr: hrMatch ? parseInt(hrMatch[1], 10) : undefined,
      cad: cadMatch ? parseInt(cadMatch[1], 10) : undefined,
    });
  }

  return { name, samples };
}

/** Parse Garmin TCX XML text into raw samples */
export function parseTcxText(xml: string): {
  name?: string;
  samples: RawTrackSample[];
} {
  const idMatch = xml.match(/<Id>([^<]+)<\/Id>/i);
  const name = idMatch ? idMatch[1].trim() : undefined;

  const tpRegex = /<Trackpoint>([\s\S]*?)<\/Trackpoint>/gi;
  const samples: RawTrackSample[] = [];
  let match: RegExpExecArray | null;
  while ((match = tpRegex.exec(xml)) !== null) {
    const body = match[1];
    const latMatch = body.match(/<LatitudeDegrees>([^<]+)<\/LatitudeDegrees>/i);
    const lonMatch = body.match(
      /<LongitudeDegrees>([^<]+)<\/LongitudeDegrees>/i
    );
    const timeMatch = body.match(/<Time>([^<]+)<\/Time>/i);
    if (!latMatch || !lonMatch || !timeMatch) continue;

    const lat = parseFloat(latMatch[1]);
    const lon = parseFloat(lonMatch[1]);
    const timeMs = Date.parse(timeMatch[1].trim());
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(timeMs)
    )
      continue;

    const eleMatch = body.match(/<AltitudeMeters>([^<]+)<\/AltitudeMeters>/i);
    const hrMatch = body.match(
      /<HeartRateBpm>\s*<Value>([^<]+)<\/Value>\s*<\/HeartRateBpm>/i
    );
    const cadMatch = body.match(/<Cadence>([^<]+)<\/Cadence>/i);

    samples.push({
      timeMs,
      lat,
      lon,
      ele: eleMatch ? parseFloat(eleMatch[1]) : undefined,
      hr: hrMatch ? parseInt(hrMatch[1], 10) : undefined,
      cad: cadMatch ? parseInt(cadMatch[1], 10) : undefined,
    });
  }
  return { name, samples };
}

/** Parse binary Garmin FIT buffer into raw samples */
export function parseFitBuffer(buffer: ArrayBuffer | Buffer): Promise<{
  name?: string;
  samples: RawTrackSample[];
}> {
  return new Promise((resolve, reject) => {
    const parser = new FitParser({
      force: true,
      speedUnit: 'm/s',
      lengthUnit: 'm',
      elapsedRecordField: true,
      mode: 'list',
    });

    parser.parse(buffer as Buffer, (error: string | null, data: any) => {
      if (error) {
        reject(new Error(String(error)));
        return;
      }
      const records: any[] = data?.records ?? [];
      const samples: RawTrackSample[] = [];
      for (const rec of records) {
        const lat = rec.position_lat;
        const lon = rec.position_long;
        const ts = rec.timestamp ? new Date(rec.timestamp).getTime() : NaN;
        if (
          typeof lat === 'number' &&
          typeof lon === 'number' &&
          Number.isFinite(lat) &&
          Number.isFinite(lon) &&
          Number.isFinite(ts)
        ) {
          samples.push({
            timeMs: ts,
            lat,
            lon,
            ele: typeof rec.altitude === 'number' ? rec.altitude : undefined,
            hr: typeof rec.heart_rate === 'number' ? rec.heart_rate : undefined,
            cad: typeof rec.cadence === 'number' ? rec.cadence : undefined,
          });
        }
      }
      resolve({ samples });
    });
  });
}

const SPIKE_SPEED_MS = 12;

function speedBetween(a: RawTrackSample, b: RawTrackSample): number {
  const dt = Math.abs(b.timeMs - a.timeMs) / 1000;
  const d = haversineDistanceM(a.lon, a.lat, b.lon, b.lat);
  return dt > 0 ? d / dt : d > 0 ? Infinity : 0;
}

/**
 * Cold start: the first fixes after switching the watch on are often tens of metres off
 * before the receiver settles. Drop leading points that jump implausibly fast to the
 * settled part of the track (judged against the next few points, not just one).
 */
function dropColdStartFixes(samples: RawTrackSample[]): RawTrackSample[] {
  let start = 0;
  while (start + 3 < samples.length && start < 30) {
    const s = samples[start];
    const next = samples.slice(start + 1, start + 4);
    // The settled points agree with each other, but the leading one is far from all of them
    const toNext = next.map((n) => speedBetween(s, n));
    const among = speedBetween(next[0], next[1]);
    if (toNext.every((v) => v > SPIKE_SPEED_MS) && among <= SPIKE_SPEED_MS) {
      start++;
    } else {
      break;
    }
  }
  return start > 0 ? samples.slice(start) : samples;
}

/**
 * Single-point GPS spikes (multipath in forest/between buildings) look like an out-and-back:
 * too fast in, too fast out, while the neighbours are close to each other. A real fast
 * straight segment (cycling, downhill) is not touched because the detour test fails.
 */
function removeOutAndBackSpikes(samples: RawTrackSample[]): RawTrackSample[] {
  if (samples.length < 3) return samples;
  const out: RawTrackSample[] = [samples[0]];
  for (let i = 1; i < samples.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = samples[i];
    const next = samples[i + 1];
    const dIn = haversineDistanceM(prev.lon, prev.lat, cur.lon, cur.lat);
    const dOut = haversineDistanceM(cur.lon, cur.lat, next.lon, next.lat);
    const dBypass = haversineDistanceM(prev.lon, prev.lat, next.lon, next.lat);
    const isSpike =
      speedBetween(prev, cur) > SPIKE_SPEED_MS &&
      speedBetween(cur, next) > SPIKE_SPEED_MS &&
      dBypass < 0.5 * (dIn + dOut);
    if (!isSpike) out.push(cur);
  }
  out.push(samples[samples.length - 1]);
  return out;
}

/**
 * Clean, filter outliers, and normalize raw GPS samples into a ParticipantTrack.
 */
export function normalizeSamplesToTrack(opts: {
  id: string;
  name: string;
  color: string;
  sourceFormat: 'gpx' | 'fit' | 'tcx';
  samples: RawTrackSample[];
}): ParticipantTrack {
  const { id, name, color, sourceFormat } = opts;
  const sorted = [...opts.samples]
    .filter(
      (s) =>
        Number.isFinite(s.timeMs) &&
        Number.isFinite(s.lat) &&
        Number.isFinite(s.lon) &&
        Math.abs(s.lat) <= 90 &&
        Math.abs(s.lon) <= 180
    )
    .sort((a, b) => a.timeMs - b.timeMs);

  // Deduplicate identical timestamps & discard GPS spikes (> 20 m/s ~ 72 km/h)
  const filtered: RawTrackSample[] = [];
  for (const s of removeOutAndBackSpikes(dropColdStartFixes(sorted))) {
    if (filtered.length === 0) {
      filtered.push(s);
      continue;
    }
    const prev = filtered[filtered.length - 1];
    const dtSec = (s.timeMs - prev.timeMs) / 1000;
    if (dtSec <= 0.1) continue;
    const dist = haversineDistanceM(prev.lon, prev.lat, s.lon, s.lat);
    const speed = dist / dtSec;
    if (speed > 20 && dtSec < 15) {
      // Likely GPS glitch in forest
      continue;
    }
    filtered.push(s);
  }

  if (filtered.length < 2) {
    throw new Error('Трек содержит слишком мало валидных GPS-точек (< 2)');
  }

  const startMs = filtered[0].timeMs;
  let cumDist = 0;

  // Compute instantaneous distances & raw points
  const rawPoints: TrackPoint[] = filtered.map((s, idx) => {
    if (idx > 0) {
      const prev = filtered[idx - 1];
      cumDist += haversineDistanceM(prev.lon, prev.lat, s.lon, s.lat);
    }
    return {
      t: Math.round(((s.timeMs - startMs) / 1000) * 10) / 10,
      absTimeMs: s.timeMs,
      lat: s.lat,
      lon: s.lon,
      ele: s.ele,
      hr: s.hr,
      cad: s.cad,
      distM: Math.round(cumDist * 10) / 10,
      speedMs: 0,
    };
  });

  // Compute smoothed speed over a ~6 second rolling window
  let maxSpeedMs = 0;
  for (let i = 0; i < rawPoints.length; i++) {
    let j = i;
    while (j > 0 && rawPoints[i].t - rawPoints[j].t < 3) j--;
    let k = i;
    while (k < rawPoints.length - 1 && rawPoints[k].t - rawPoints[i].t < 3) k++;
    const dt = rawPoints[k].t - rawPoints[j].t;
    const dd = rawPoints[k].distM - rawPoints[j].distM;
    const spd = dt > 0.2 ? dd / dt : 0;
    rawPoints[i].speedMs = Math.round(spd * 100) / 100;
    if (rawPoints[i].speedMs > maxSpeedMs) maxSpeedMs = rawPoints[i].speedMs;
  }

  const durationSec = rawPoints[rawPoints.length - 1].t;
  const totalDistanceM = Math.round(cumDist);
  const avgSpeedMs =
    durationSec > 0 ? Math.round((cumDist / durationSec) * 100) / 100 : 0;

  const autoTrimStartSec = detectDepartureFromStartSpot(rawPoints);

  return {
    id,
    name,
    color,
    visible: true,
    sourceFormat,
    startedAtIso: new Date(startMs).toISOString(),
    offsetSec: 0,
    trimStartSec: autoTrimStartSec,
    trimEndSec: durationSec,
    totalDistanceM,
    durationSec,
    avgSpeedMs,
    maxSpeedMs,
    points: rawPoints,
  };
}

/**
 * Since all runners start from the same spot (or turn on their Garmin watch while standing
 * at the start), detect the exact second `t` when the runner leaves the 15m start zone
 * and begins moving (> 1.6 m/s).
 */
export function detectDepartureFromStartSpot(
  points: TrackPoint[],
  anchorLon?: number,
  anchorLat?: number,
  radiusM = 18
): number {
  if (points.length < 3) return 0;
  const lon0 = anchorLon ?? points[0].lon;
  const lat0 = anchorLat ?? points[0].lat;

  // Find the last point within the initial gathering period where the runner is still inside the start circle
  // before clearly moving away
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const distFromAnchor = haversineDistanceM(lon0, lat0, pt.lon, pt.lat);
    if (distFromAnchor > radiusM && pt.speedMs >= 1.4) {
      // Step back slightly to the moment they started accelerating inside the circle
      let startIdx = i;
      while (
        startIdx > 0 &&
        points[startIdx - 1].speedMs >= 1.3 &&
        haversineDistanceM(
          lon0,
          lat0,
          points[startIdx - 1].lon,
          points[startIdx - 1].lat
        ) <= radiusM
      ) {
        startIdx--;
      }
      return Math.max(0, Math.floor(points[startIdx].t));
    }
  }
  return 0;
}

/**
 * Compute the common start location (median of first points of all participants)
 * and synchronize everyone's `trimStartSec` and `offsetSec = 0` so all runners depart
 * from the shared start spot simultaneously at 00:00.
 */
export function syncAllParticipantsToCommonStartSpot(
  participants: ParticipantTrack[]
): { commonLon: number; commonLat: number } | null {
  const valid = participants.filter((p) => p.points.length >= 2);
  if (valid.length === 0) return null;

  // Compute common start coordinate (average of initial points)
  let sumLon = 0;
  let sumLat = 0;
  for (const p of valid) {
    sumLon += p.points[0].lon;
    sumLat += p.points[0].lat;
  }
  const commonLon = sumLon / valid.length;
  const commonLat = sumLat / valid.length;

  for (const p of valid) {
    p.trimStartSec = detectDepartureFromStartSpot(
      p.points,
      commonLon,
      commonLat,
      20
    );
    p.offsetSec = 0;
  }

  return { commonLon, commonLat };
}

/**
 * Compute bounding box of all GPS tracks in an event (for auto-centering map & Google screenshot).
 */
export function computeTracksBoundingBox(participants: ParticipantTrack[]): {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  startLon: number;
  startLat: number;
} | null {
  let minLon = Infinity,
    maxLon = -Infinity,
    minLat = Infinity,
    maxLat = -Infinity;
  let count = 0;
  let startLon = 0;
  let startLat = 0;

  for (const p of participants) {
    if (p.points.length > 0 && count === 0) {
      startLon = p.points[0].lon;
      startLat = p.points[0].lat;
    }
    for (const pt of p.points) {
      if (pt.lon < minLon) minLon = pt.lon;
      if (pt.lon > maxLon) maxLon = pt.lon;
      if (pt.lat < minLat) minLat = pt.lat;
      if (pt.lat > maxLat) maxLat = pt.lat;
      count++;
    }
  }

  if (count === 0) return null;
  return { minLon, maxLon, minLat, maxLat, startLon, startLat };
}

export type SpeedNormMode = 'real' | 'fitness_handicap' | 'equal_speed';

export interface LegParticipantStats {
  participantId: string;
  name: string;
  color: string;
  tStartSec: number;
  tEndSec: number;
  legTimeSec: number;
  normalizedLegTimeSec: number;
  straightDistM: number;
  routeDistM: number;
  detourPct: number;
  avgSpeedMs: number;
  overallSpeedMs: number;
  paceIndexPct: number;
  eleGainM: number;
  eleLossM: number;
}

/**
 * Find the point along `points` (at or after `afterTimeSec`) that passes closest to `[targetLon, targetLat]`.
 */
export function findClosestPassagePoint(
  points: TrackPoint[],
  targetLon: number,
  targetLat: number,
  afterTimeSec = 0
): { pt: TrackPoint; idx: number; distFromTargetM: number } | null {
  if (points.length === 0) return null;
  let bestIdx = -1;
  let bestDist = Infinity;

  for (let i = 0; i < points.length; i++) {
    if (points[i].t < afterTimeSec) continue;
    const d = haversineDistanceM(
      targetLon,
      targetLat,
      points[i].lon,
      points[i].lat
    );
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) {
    bestIdx = points.length - 1;
    bestDist = haversineDistanceM(
      targetLon,
      targetLat,
      points[bestIdx].lon,
      points[bestIdx].lat
    );
  }

  return {
    pt: points[bestIdx],
    idx: bestIdx,
    distFromTargetM: Math.round(bestDist),
  };
}

/**
 * Synchronize all participants to depart simultaneously at 00:00 from an arbitrary clicked spot on the map
 * (e.g., any Control Point КП or road fork).
 */
export function syncAllParticipantsToSpot(
  participants: ParticipantTrack[],
  spotLon: number,
  spotLat: number
): void {
  for (const p of participants) {
    const closest = findClosestPassagePoint(p.points, spotLon, spotLat, 0);
    if (closest) {
      p.trimStartSec = Math.max(0, Math.floor(closest.pt.t));
      p.trimEndSec = p.durationSec;
      p.offsetSec = 0;
    }
  }
}

/**
 * Analyze a leg between two arbitrary map points `startLonLat` (КП A) and `endLonLat` (КП B)
 * for route-choice comparison (straight vs road vs contour, elevation gain/loss, and speed normalisation).
 */
export function analyzeLegBetweenSpots(
  participants: ParticipantTrack[],
  startLonLat: [number, number],
  endLonLat: [number, number],
  /**
   * Known punch indices per participant (from the course splits). Without them the
   * closest passage is used, which can pick the wrong visit when a course loops back.
   */
  knownPassages?: Record<string, { startIdx: number; endIdx: number }>
): {
  straightDistM: number;
  groupMeanSpeedMs: number;
  stats: LegParticipantStats[];
} {
  const straightDistM = Math.max(
    1,
    Math.round(
      haversineDistanceM(
        startLonLat[0],
        startLonLat[1],
        endLonLat[0],
        endLonLat[1]
      )
    )
  );

  const visible = participants.filter((p) => p.visible && p.points.length >= 2);
  const overallSpeeds = visible.map((p) =>
    p.durationSec > 0 ? p.totalDistanceM / p.durationSec : 2.5
  );
  const groupMeanSpeedMs =
    overallSpeeds.length > 0
      ? overallSpeeds.reduce((a, b) => a + b, 0) / overallSpeeds.length
      : 2.5;

  const stats: LegParticipantStats[] = [];

  for (const p of visible) {
    const known = knownPassages?.[p.id];
    if (knownPassages && !known) continue; // no valid punches for this leg
    const startHit = known
      ? { pt: p.points[known.startIdx], idx: known.startIdx }
      : findClosestPassagePoint(p.points, startLonLat[0], startLonLat[1], 0);
    if (!startHit?.pt) continue;
    const endHit = known
      ? { pt: p.points[known.endIdx], idx: known.endIdx }
      : findClosestPassagePoint(
          p.points,
          endLonLat[0],
          endLonLat[1],
          startHit.pt.t + 3
        );
    if (!endHit?.pt || endHit.idx <= startHit.idx) continue;

    const tStartSec = Math.round(startHit.pt.t);
    const tEndSec = Math.round(endHit.pt.t);
    const legTimeSec = Math.max(1, tEndSec - tStartSec);
    const routeDistM = Math.max(
      1,
      Math.round(endHit.pt.distM - startHit.pt.distM)
    );
    const detourPct = Math.round((routeDistM / straightDistM - 1) * 100);
    const avgSpeedMs = routeDistM / legTimeSec;
    const overallSpeedMs =
      p.durationSec > 0 ? p.totalDistanceM / p.durationSec : avgSpeedMs;
    const paceIndexPct =
      overallSpeedMs > 0
        ? Math.round((avgSpeedMs / overallSpeedMs - 1) * 100)
        : 0;

    // Handicap-normalised leg time: removes the physical fitness difference between runners
    const normalizedLegTimeSec = Math.round(
      legTimeSec * (overallSpeedMs / Math.max(0.5, groupMeanSpeedMs))
    );

    let eleGainM = 0;
    let eleLossM = 0;
    for (let i = startHit.idx + 1; i <= endHit.idx; i++) {
      const e0 = p.points[i - 1].ele;
      const e1 = p.points[i].ele;
      if (e0 !== undefined && e1 !== undefined) {
        const diff = e1 - e0;
        if (diff > 0.2) eleGainM += diff;
        else if (diff < -0.2) eleLossM += -diff;
      }
    }

    stats.push({
      participantId: p.id,
      name: p.name,
      color: p.color,
      tStartSec,
      tEndSec,
      legTimeSec,
      normalizedLegTimeSec,
      straightDistM,
      routeDistM,
      detourPct,
      avgSpeedMs,
      overallSpeedMs,
      paceIndexPct,
      eleGainM: Math.round(eleGainM),
      eleLossM: Math.round(eleLossM),
    });
  }

  stats.sort((a, b) => a.legTimeSec - b.legTimeSec);
  return { straightDistM, groupMeanSpeedMs, stats };
}

export interface InterpolatedState {
  lat: number;
  lon: number;
  speedMs: number;
  distM: number;
  hr?: number;
  ele?: number;
  finished: boolean;
  notStarted: boolean;
  /** Track-local time `t` (seconds from the track's first point) of the runner's head position */
  localT: number;
}

function overallSpeedOf(track: ParticipantTrack, fallbackMs: number): number {
  return track.durationSec > 0
    ? track.totalDistanceM / track.durationSec
    : fallbackMs;
}

/**
 * Track seconds that elapse per race-clock second in 'from_start' mode.
 * Fitness handicap: every runner is replayed at the group reference speed on average,
 * so a faster-than-average runner is slowed down (rate < 1) and a slower one sped up.
 */
function trackRateFactor(
  track: ParticipantTrack,
  speedNormMode: SpeedNormMode,
  referenceSpeedMs: number
): number {
  if (speedNormMode !== 'fitness_handicap' || referenceSpeedMs <= 0.3) return 1;
  const overall = overallSpeedOf(track, referenceSpeedMs);
  return overall > 0.3 ? referenceSpeedMs / overall : 1;
}

/**
 * Race-clock second at which the runner passes track point `pt` (inverse of `interpolateTrackAt`).
 * Used for the timeline length and the speed chart, so they match what the map shows.
 */
export function raceTimeOfTrackPoint(
  track: ParticipantTrack,
  pt: TrackPoint,
  timeMode: 'from_start' | 'real',
  eventEpochZeroMs: number,
  speedNormMode: SpeedNormMode = 'real',
  referenceSpeedMs = 2.8
): number {
  if (timeMode === 'real') {
    return (pt.absTimeMs - eventEpochZeroMs) / 1000 + track.offsetSec;
  }
  if (speedNormMode === 'equal_speed') {
    const pStart = findPointAtT(track.points, track.trimStartSec);
    return (
      (pt.distM - pStart.distM) / Math.max(0.5, referenceSpeedMs) +
      track.offsetSec
    );
  }
  const rate = trackRateFactor(track, speedNormMode, referenceSpeedMs);
  return (pt.t - track.trimStartSec) / rate + track.offsetSec;
}

/**
 * Interpolate participant position & metrics at race clock `raceTimeSec`.
 * Supports speed normalisation (`fitness_handicap` and `equal_speed`).
 */
export function interpolateTrackAt(
  track: ParticipantTrack,
  raceTimeSec: number,
  timeMode: 'from_start' | 'real',
  eventEpochZeroMs: number,
  speedNormMode: SpeedNormMode = 'real',
  referenceSpeedMs = 2.8
): InterpolatedState | null {
  const pts = track.points;
  if (pts.length === 0) return null;

  const minT = track.trimStartSec;
  const maxT = Math.min(track.trimEndSec, track.durationSec);
  const pStart = findPointAtT(pts, minT);

  // Mode 3: Constant equal speed along each runner's chosen trajectory (shows pure geometry/detour cost)
  if (speedNormMode === 'equal_speed' && timeMode === 'from_start') {
    const pEnd = findPointAtT(pts, maxT);
    const runSec = raceTimeSec - track.offsetSec;
    const targetDistM =
      pStart.distM + Math.max(0, runSec) * Math.max(0.5, referenceSpeedMs);
    if (runSec <= 0) {
      return {
        lat: pStart.lat,
        lon: pStart.lon,
        speedMs: 0,
        distM: 0,
        hr: pStart.hr,
        ele: pStart.ele,
        finished: false,
        notStarted: true,
        localT: pStart.t,
      };
    }
    if (targetDistM >= pEnd.distM) {
      return {
        lat: pEnd.lat,
        lon: pEnd.lon,
        speedMs: 0,
        distM: Math.max(0, pEnd.distM - pStart.distM),
        hr: pEnd.hr,
        ele: pEnd.ele,
        finished: true,
        notStarted: false,
        localT: pEnd.t,
      };
    }
    let lo = 0;
    let hi = pts.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].distM <= targetDistM) lo = mid;
      else hi = mid;
    }
    const p0 = pts[lo];
    const p1 = pts[hi];
    const dSpan = p1.distM - p0.distM;
    const alpha = dSpan > 1e-6 ? (targetDistM - p0.distM) / dSpan : 0;
    return {
      lat: p0.lat + (p1.lat - p0.lat) * alpha,
      lon: p0.lon + (p1.lon - p0.lon) * alpha,
      speedMs: Math.max(0.5, referenceSpeedMs),
      distM: Math.max(0, targetDistM - pStart.distM),
      hr: p0.hr ?? p1.hr,
      ele: p0.ele ?? p1.ele,
      finished: false,
      notStarted: false,
      localT: p0.t + (p1.t - p0.t) * alpha,
    };
  }

  let localT: number;
  let rateFactor = 1;
  if (timeMode === 'from_start') {
    rateFactor = trackRateFactor(track, speedNormMode, referenceSpeedMs);
    localT =
      (raceTimeSec - track.offsetSec) * rateFactor + track.trimStartSec;
  } else {
    const targetAbsMs =
      eventEpochZeroMs + (raceTimeSec - track.offsetSec) * 1000;
    localT = (targetAbsMs - pts[0].absTimeMs) / 1000;
  }

  if (localT <= minT) {
    const p = findPointAtT(pts, minT);
    return {
      lat: p.lat,
      lon: p.lon,
      speedMs: 0,
      distM: 0,
      hr: p.hr,
      ele: p.ele,
      finished: false,
      notStarted: true,
      localT: minT,
    };
  }
  if (localT >= maxT) {
    const p = findPointAtT(pts, maxT);
    return {
      lat: p.lat,
      lon: p.lon,
      speedMs: 0,
      distM: Math.max(0, p.distM - pStart.distM),
      hr: p.hr,
      ele: p.ele,
      finished: true,
      notStarted: false,
      localT: maxT,
    };
  }

  // Binary search for segment [i, i+1] containing localT
  let lo = 0;
  let hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= localT) lo = mid;
    else hi = mid;
  }

  const p0 = pts[lo];
  const p1 = pts[hi];
  const span = p1.t - p0.t;
  const alpha = span > 1e-6 ? (localT - p0.t) / span : 0;

  return {
    lat: p0.lat + (p1.lat - p0.lat) * alpha,
    lon: p0.lon + (p1.lon - p0.lon) * alpha,
    // Replayed speed: the fitness handicap slows down / speeds up the whole track by `rateFactor`
    speedMs: (p0.speedMs + (p1.speedMs - p0.speedMs) * alpha) * rateFactor,
    distM: Math.max(
      0,
      p0.distM + (p1.distM - p0.distM) * alpha - pStart.distM
    ),
    hr:
      p0.hr !== undefined && p1.hr !== undefined
        ? Math.round(p0.hr + (p1.hr - p0.hr) * alpha)
        : p0.hr ?? p1.hr,
    ele:
      p0.ele !== undefined && p1.ele !== undefined
        ? Math.round((p0.ele + (p1.ele - p0.ele) * alpha) * 10) / 10
        : p0.ele ?? p1.ele,
    finished: false,
    notStarted: false,
    localT,
  };
}

function findPointAtT(pts: TrackPoint[], t: number): TrackPoint {
  // The bisection below never lands on the last index, so the finish point needs its own check
  const last = pts[pts.length - 1];
  if (t >= last.t) return last;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return pts[lo];
}

/** Format speed (m/s) as running pace "M:SS /км" */
export function formatPaceMinKm(speedMs: number): string {
  if (!Number.isFinite(speedMs) || speedMs < 0.35) return '— /км';
  const secPerKm = 1000 / speedMs;
  if (secPerKm > 1800) return '>30:00';
  const totalSec = Math.round(secPerKm);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs} /км`;
}

/** Format seconds into HH:MM:SS or MM:SS */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }
  return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

