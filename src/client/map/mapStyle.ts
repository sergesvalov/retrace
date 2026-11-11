import type maplibregl from 'maplibre-gl';
import type { BaseLayer, EventKind, ParticipantTrack } from '../../shared/types.js';
import { buildCommonStartGeoJson, buildGhostTracksGeoJson } from './mapLayers.js';

/** Base maps; only the active one is visible (hidden ones download no tiles) */
export const BASE_LAYERS: readonly BaseLayer[] = ['topo', 'osm', 'satellite'];
export const BASE_LAYER_LABELS: Record<BaseLayer, string> = {
  topo: 'Топо',
  osm: 'OSM',
  satellite: 'Спутник',
};
/** Credits the tile providers require wherever their tiles are shown (videos too) */
export const BASE_LAYER_ATTRIBUTION: Record<BaseLayer, string> = {
  osm: '© OpenStreetMap contributors',
  topo: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
  satellite: '© Esri World Imagery',
};
/** Runs/hikes live on the base map, so default to the one with contours and trails */
export function defaultBaseLayerFor(kind: EventKind): BaseLayer {
  return kind === 'run' ? 'topo' : 'osm';
}

/** MapLibre style with the three base maps; `active` is shown at `opacity` */
export function baseMapStyle(active: BaseLayer, opacity: number): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: BASE_LAYER_ATTRIBUTION.osm,
      },
      topo: {
        type: 'raster',
        tiles: [
          'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        // OpenTopoMap has no tiles past z17: MapLibre over-zooms z17 instead of showing blanks
        maxzoom: 17,
        attribution: BASE_LAYER_ATTRIBUTION.topo,
      },
      satellite: {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: BASE_LAYER_ATTRIBUTION.satellite,
      },
    },
    // Hidden base layers use `visibility: none` so their tiles are not downloaded at all
    layers: BASE_LAYERS.map((layer) => ({
      id: `${layer}-base`,
      type: 'raster' as const,
      source: layer,
      layout: {
        visibility:
          layer === active
            ? ('visible' as const)
            : ('none' as const),
      },
      paint: { 'raster-opacity': opacity },
    })),
  };
}

/** Replay overlays on top of the map scan: full tracks, selected leg, tails, common start */
export function addReplayLayers(map: maplibregl.Map, participants: ParticipantTrack[]) {
  map.addSource('ghost-tracks', {
    type: 'geojson',
    data: buildGhostTracksGeoJson(participants),
  });
  map.addLayer({
    id: 'ghost-tracks-casing',
    type: 'line',
    source: 'ghost-tracks',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': 4.5,
      'line-opacity': 0.6,
    },
  });
  map.addLayer({
    id: 'ghost-tracks-layer',
    type: 'line',
    source: 'ghost-tracks',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 2.75,
      'line-opacity': 0.78,
    },
  });

  // 3. Selected Orienteering Leg Line (CP A -> CP B)
  map.addSource('selected-leg', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'selected-leg-line',
    type: 'line',
    source: 'selected-leg',
    paint: {
      'line-color': '#d946ef',
      'line-width': 3.5,
      'line-dasharray': [3, 2],
      'line-opacity': 0.9,
    },
  });

  // 4. Active animated tails (colored by runner or speed heatmap)
  map.addSource('active-tails', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'active-tails-layer',
    type: 'line',
    source: 'active-tails',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 5,
      'line-opacity': 0.95,
    },
  });

  // 5. Common Start Spot Circle
  map.addSource('common-start', {
    type: 'geojson',
    data: buildCommonStartGeoJson(participants),
  });
  map.addLayer({
    id: 'common-start-circle',
    type: 'circle',
    source: 'common-start',
    paint: {
      'circle-radius': 8,
      'circle-color': '#10b981',
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#ffffff',
    },
  });

}
