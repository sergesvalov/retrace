import maplibregl from 'maplibre-gl';
import {
  interpolateTrackAt,
  type SpeedNormMode,
} from '../../shared/trackParser.js';
import type { ParticipantTrack, RaceEvent, TimeMode } from '../../shared/types.js';

/** GeoJSON builders and view helpers for the replay map layers */

export function fitMapToTracksOrMap(map: maplibregl.Map, event: RaceEvent) {
  let minLon = Infinity,
    maxLon = -Infinity,
    minLat = Infinity,
    maxLat = -Infinity;
  let count = 0;

  for (const p of event.participants) {
    for (const pt of p.points) {
      if (pt.lon < minLon) minLon = pt.lon;
      if (pt.lon > maxLon) maxLon = pt.lon;
      if (pt.lat < minLat) minLat = pt.lat;
      if (pt.lat > maxLat) maxLat = pt.lat;
      count++;
    }
  }
  if (count === 0 && event.map?.cornersLonLat) {
    for (const [lon, lat] of event.map.cornersLonLat) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      count++;
    }
  }
  if (count >= 2) {
    map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      { padding: 50, maxZoom: 16, duration: 400 }
    );
  }
}

/**
 * Bounds of what a replay shows: each visible runner's track between their trims (the picked
 * leg or the whole course) plus `extra` points such as the leg ends
 */
export function replayBounds(
  participants: ParticipantTrack[],
  extra: [number, number][]
): [[number, number], [number, number]] | null {
  let minLon = Infinity,
    maxLon = -Infinity,
    minLat = Infinity,
    maxLat = -Infinity;
  const add = (lon: number, lat: number) => {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };
  for (const p of participants) {
    if (!p.visible) continue;
    const end = Math.min(p.trimEndSec, p.durationSec);
    for (const pt of p.points) {
      if (pt.t >= p.trimStartSec && pt.t <= end) add(pt.lon, pt.lat);
    }
  }
  for (const [lon, lat] of extra) add(lon, lat);
  if (!(maxLon > minLon || maxLat > minLat)) return null;
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

export function buildCommonStartGeoJson(
  participants: ParticipantTrack[]
): GeoJSON.FeatureCollection {
  const valid = participants.filter((p) => p.visible && p.points.length > 0);
  if (valid.length === 0) {
    return { type: 'FeatureCollection', features: [] };
  }
  let sumLon = 0;
  let sumLat = 0;
  for (const p of valid) {
    const startPt =
      p.points.find((pt) => pt.t >= p.trimStartSec) ?? p.points[0];
    sumLon += startPt.lon;
    sumLat += startPt.lat;
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { label: 'ОБЩИЙ СТАРТ' },
        geometry: {
          type: 'Point',
          coordinates: [sumLon / valid.length, sumLat / valid.length],
        },
      },
    ],
  };
}

export function buildGhostTracksGeoJson(
  participants: ParticipantTrack[]
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: participants
      .filter((p) => p.visible && p.points.length >= 2)
      .map((p) => ({
        type: 'Feature',
        properties: { id: p.id, color: p.color },
        geometry: {
          type: 'LineString',
          coordinates: p.points.map((pt) => [pt.lon, pt.lat]),
        },
      })),
  };
}

export function speedToColorHex(speedMs: number): string {
  if (speedMs < 2.7) return '#f43f5e';
  if (speedMs < 3.6) return '#f59e0b';
  return '#10b981';
}

/** Index of the first point with t ≥ `t` (points sorted by t) */
export function firstIndexAtOrAfter(points: { t: number }[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function buildActiveTailsGeoJson(
  participants: ParticipantTrack[],
  raceTimeSec: number,
  tailLengthSec: number,
  timeMode: TimeMode,
  eventEpochZeroMs: number,
  speedHeatmap: boolean,
  speedNormMode: SpeedNormMode = 'real',
  referenceSpeedMs = 2.8
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  for (const p of participants) {
    if (!p.visible || p.points.length < 2) continue;

    const headState = interpolateTrackAt(
      p,
      raceTimeSec,
      timeMode,
      eventEpochZeroMs,
      speedNormMode,
      referenceSpeedMs
    );
    if (!headState || headState.notStarted) continue;

    // Track-local time of the head, consistent with every speed mode (incl. equal speed)
    const headLocalT = headState.localT;

    const tailStartT = Math.max(p.trimStartSec, headLocalT - tailLengthSec);
    const tailEndT = Math.min(p.trimEndSec, p.durationSec, headLocalT);
    // Points are sorted by t: binary-search the window instead of scanning the whole track
    // every frame
    const windowPts = p.points.slice(
      firstIndexAtOrAfter(p.points, tailStartT),
      firstIndexAtOrAfter(p.points, tailEndT + 1e-9)
    );

    const coords: Array<[number, number, number]> = windowPts.map((pt) => [
      pt.lon,
      pt.lat,
      pt.speedMs,
    ]);
    coords.push([headState.lon, headState.lat, headState.speedMs]);

    if (coords.length < 2) continue;

    if (!speedHeatmap) {
      features.push({
        type: 'Feature',
        properties: { color: p.color },
        geometry: {
          type: 'LineString',
          coordinates: coords.map(([lon, lat]) => [lon, lat]),
        },
      });
    } else {
      for (let i = 0; i < coords.length - 1; i++) {
        const c0 = coords[i];
        const c1 = coords[i + 1];
        features.push({
          type: 'Feature',
          properties: { color: speedToColorHex((c0[2] + c1[2]) / 2) },
          geometry: {
            type: 'LineString',
            coordinates: [
              [c0[0], c0[1]],
              [c1[0], c1[1]],
            ],
          },
        });
      }
    }
  }

  return { type: 'FeatureCollection', features };
}

