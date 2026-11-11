import maplibregl from 'maplibre-gl';
import {
  formatPaceMinKm,
  interpolateTrackAt,
  type SpeedNormMode,
} from '../../shared/trackParser.js';
import type { ParticipantTrack, TimeMode } from '../../shared/types.js';
import { buildActiveTailsGeoJson } from './mapLayers.js';

export interface RunnersFrame {
  participants: ParticipantTrack[];
  raceTimeSec: number;
  tailLengthSec: number;
  timeMode: TimeMode;
  eventEpochZeroMs: number;
  speedHeatmap: boolean;
  speedNormMode: SpeedNormMode;
  referenceSpeedMs: number;
}

/**
 * Draw one replay frame straight onto the map: runner markers (name + live pace) and their
 * tails. Called every animation frame, so it touches only MapLibre/DOM, never React state.
 * `markers` keeps the marker per participant id between frames.
 */
export function drawRunnersFrame(
  map: maplibregl.Map,
  markers: Map<string, maplibregl.Marker>,
  f: RunnersFrame
) {
  const tailSrc = map.getSource('active-tails') as maplibregl.GeoJSONSource | undefined;
  tailSrc?.setData(
    buildActiveTailsGeoJson(
      f.participants,
      f.raceTimeSec,
      f.tailLengthSec,
      f.timeMode,
      f.eventEpochZeroMs,
      f.speedHeatmap,
      f.speedNormMode,
      f.referenceSpeedMs
    )
  );

  const runnerStates = f.participants.map((p) => ({
    participant: p,
    state: interpolateTrackAt(
      p,
      f.raceTimeSec,
      f.timeMode,
      f.eventEpochZeroMs,
      f.speedNormMode,
      f.referenceSpeedMs
    ),
  }));

  const activeIds = new Set<string>();
  for (const { participant: p, state } of runnerStates) {
    if (!p.visible || !state) continue;
    activeIds.add(p.id);

    let marker = markers.get(p.id);
    if (!marker) {
      // Built with DOM APIs, not innerHTML: name/color come from shared event data
      const el = document.createElement('div');
      el.className = 'flex items-center gap-1.5 pointer-events-none';
      const dot = document.createElement('div');
      dot.className =
        'runner-dot w-4 h-4 rounded-full border-2 border-white shadow-lg';
      const box = document.createElement('div');
      box.className =
        'px-1.5 py-0.5 rounded bg-slate-900/90 border border-slate-700 text-[11px] font-semibold text-white whitespace-nowrap shadow';
      const label = document.createElement('span');
      label.className = 'runner-label';
      box.appendChild(label);
      el.append(dot, box);
      marker = new maplibregl.Marker({ element: el, anchor: 'left' })
        .setLngLat([state.lon, state.lat])
        .addTo(map);
      markers.set(p.id, marker);
    } else {
      marker.setLngLat([state.lon, state.lat]);
    }

    const markerEl = marker.getElement();
    const dotEl = markerEl.querySelector('.runner-dot') as HTMLElement | null;
    if (dotEl) dotEl.style.background = p.color;
    const labelSpan = markerEl.querySelector(
      '.runner-label'
    ) as HTMLElement | null;
    if (labelSpan) {
      const paceStr = formatPaceMinKm(state.speedMs);
      labelSpan.textContent = `${p.name} • ${paceStr}`;
    }
  }

  for (const [id, marker] of markers.entries()) {
    if (!activeIds.has(id)) {
      marker.remove();
      markers.delete(id);
    }
  }
}
