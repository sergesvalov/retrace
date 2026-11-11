import React, { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  Activity,
  Anchor,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Clock,
  Eye,
  EyeOff,
  Flag,
  Flame,
  Gauge,
  Globe,
  Heart,
  ImagePlus,
  Layers,
  Move,
  Navigation,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Trash2,
  Zap,
} from 'lucide-react';
import {
  buildScaledOrientedMatrix,
  groundMetersPerPixelFromPrint,
  groundMetersPerPixelFromScaleBar,
  lonLatToMercator,
  matrixGroundMetersPerPixel,
  matrixToCorners,
  matrixUpBearingDeg,
  nudgeMapMatrix,
} from '../../shared/georef.js';
import {
  analyzeLegBetweenSpots,
  formatDuration,
  formatPaceMinKm,
  interpolateTrackAt,
  raceTimeOfTrackPoint,
  type SpeedNormMode,
} from '../../shared/trackParser.js';
import {
  eventKindOf,
  type BaseLayer,
  type EventKind,
  type MapImageKind,
  type MapOverlayMeta,
  type ParticipantTrack,
  type RaceEvent,
  type TimeMode,
} from '../../shared/types.js';
import { magneticDeclinationDeg } from '../../shared/declination.js';

const BASE_LAYERS: readonly BaseLayer[] = ['topo', 'osm', 'satellite'];
const BASE_LAYER_LABELS: Record<BaseLayer, string> = {
  topo: 'Топо',
  osm: 'OSM',
  satellite: 'Спутник',
};
/** Runs/hikes live on the base map, so default to the one with contours and trails */
function defaultBaseLayerFor(kind: EventKind): BaseLayer {
  return kind === 'run' ? 'topo' : 'osm';
}
const PRINT_SCALES = [4000, 5000, 7500, 10000, 15000];

function formatSignedDeg(deg: number): string {
  const r = Math.round(deg * 10) / 10;
  return `${r > 0 ? '+' : ''}${r}°`;
}

interface Props {
  event: RaceEvent;
  onEventUpdated: (evt: RaceEvent) => void;
  fitMapMode?: boolean;
  onToggleFitMap?: (open: boolean) => void;
}

const SPEED_OPTIONS = [1, 2, 5, 10, 20, 40, 60];
const TAIL_OPTIONS = [
  { label: '30 сек', value: 30 },
  { label: '2 мин', value: 120 },
  { label: '5 мин', value: 300 },
  { label: 'Весь путь', value: 999999 },
];

export const ReplayWorkspace: React.FC<Props> = ({
  event,
  onEventUpdated,
  fitMapMode = false,
  onToggleFitMap,
}) => {
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(10);
  const [raceTimeSec, setRaceTimeSec] = useState<number>(0);
  const [tailLengthSec, setTailLengthSec] = useState<number>(120);
  const [mapOpacity, setMapOpacity] = useState<number>(0.78);
  const [osmOpacity, setOsmOpacity] = useState<number>(0.85);
  const kind = eventKindOf(event);
  const isOrienteering = kind === 'orienteering';
  const [baseLayer, setBaseLayer] = useState<BaseLayer>(
    defaultBaseLayerFor(kind)
  );
  const baseLayerRef = useRef(baseLayer);
  baseLayerRef.current = baseLayer;
  const [speedHeatmap, setSpeedHeatmap] = useState<boolean>(false);
  const [speedNormMode, setSpeedNormMode] = useState<SpeedNormMode>('real');
  const [uploadingTrack, setUploadingTrack] = useState<boolean>(false);
  const [uploadingScreenshot, setUploadingScreenshot] =
    useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Interactive Map Fitting state (drag map directly with mouse + sliders around Start anchor)
  const [dragMovesMap, setDragMovesMap] = useState<boolean>(true);
  const [anchorLonLat, setAnchorLonLat] = useState<[number, number] | null>(
    null
  );
  const [scalePct, setScalePct] = useState<number>(100);
  const [angleDeg, setAngleDeg] = useState<number>(0);
  const [stretchPct, setStretchPct] = useState<number>(0);

  const prevScalePctRef = useRef<number>(100);
  const prevAngleDegRef = useRef<number>(0);
  const prevStretchPctRef = useRef<number>(0);
  const liveMatrixRef = useRef<
    [number, number, number, number, number, number] | null
  >(event.map?.matrix ?? null);

  // Map click interaction stages for Spot Start & Leg Route-Choice Analysis
  const [snapStage, setSnapStage] = useState<
    | 'idle'
    | 'spot_start'
    | 'leg_start'
    | 'leg_end'
    | 'scalebar_start'
    | 'scalebar_end'
  >('idle');
  const [pickedFeatureLonLat, setPickedFeatureLonLat] = useState<
    [number, number] | null
  >(null);

  const [customStartSpot, setCustomStartSpot] = useState<
    [number, number] | null
  >(null);
  const [selectedLeg, setSelectedLeg] = useState<{
    startLonLat: [number, number];
    endLonLat: [number, number];
  } | null>(null);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapReadyRef = useRef<boolean>(false);
  const runnerMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const anchorMarkerRef = useRef<maplibregl.Marker | null>(null);
  const legMarkersRef = useRef<maplibregl.Marker[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastFrameMsRef = useRef<number | null>(null);
  const customMapUrlRef = useRef<string | null>(null);
  // Only the latest placement save may update the event (older responses would roll the map back)
  const matrixSaveSeqRef = useRef<number>(0);
  const matrixSaveChainRef = useRef<Promise<void>>(Promise.resolve());

  const eventRef = useRef(event);
  eventRef.current = event;
  const anchorLonLatRef = useRef(anchorLonLat);
  anchorLonLatRef.current = anchorLonLat;

  // Compute common start coordinate of visible participants (default anchor for scaling & rotating the map!)
  const commonStartLonLat = useMemo<[number, number] | null>(() => {
    const valid = event.participants.filter(
      (p) => p.visible && p.points.length > 0
    );
    if (valid.length === 0) {
      if (event.map?.cornersLonLat) {
        const c = event.map.cornersLonLat;
        return [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2];
      }
      return null;
    }
    let sumLon = 0;
    let sumLat = 0;
    for (const p of valid) {
      const startPt =
        p.points.find((pt) => pt.t >= p.trimStartSec) ?? p.points[0];
      sumLon += startPt.lon;
      sumLat += startPt.lat;
    }
    return [sumLon / valid.length, sumLat / valid.length];
  }, [event.participants, event.map?.cornersLonLat]);

  // Keep anchor defaulted to the GPS Start point unless user dragged the anchor
  const effectiveAnchorLonLat = anchorLonLat ?? commonStartLonLat;
  anchorLonLatRef.current = effectiveAnchorLonLat;

  // ---- Scale & north of the map image (print scale / DPI / magnetic declination) ----
  const [mapImageKind, setMapImageKind] = useState<MapImageKind>(
    event.map?.imageKind ?? 'orienteering'
  );
  const [printScale, setPrintScale] = useState<number>(
    event.map?.printScale ?? 10000
  );
  const [scanDpi, setScanDpi] = useState<number>(event.map?.scanDpi ?? 300);

  // WMM declination at the start, for the day of the run (the field drifts ~0.1°/year)
  const autoDeclinationDeg = useMemo(() => {
    const at = commonStartLonLat;
    if (!at) return 0;
    const firstStart = event.participants[0]?.startedAtIso;
    return magneticDeclinationDeg(
      at[0],
      at[1],
      firstStart ? new Date(firstStart) : new Date()
    );
  }, [commonStartLonLat?.[0], commonStartLonLat?.[1], event.participants[0]?.startedAtIso]);

  const [declinationDeg, setDeclinationDeg] = useState<number>(
    event.map?.declinationDeg ?? autoDeclinationDeg
  );

  // Reload the stored settings when another map image (or event) is shown
  useEffect(() => {
    setMapImageKind(event.map?.imageKind ?? 'orienteering');
    setPrintScale(event.map?.printScale ?? 10000);
    setScanDpi(event.map?.scanDpi ?? 300);
    setDeclinationDeg(event.map?.declinationDeg ?? autoDeclinationDeg);
  }, [event.id, event.map?.id]);

  // Until the user stores a declination, follow the auto value (tracks may arrive after the map)
  useEffect(() => {
    if (event.map?.declinationDeg === undefined) {
      setDeclinationDeg(autoDeclinationDeg);
    }
  }, [autoDeclinationDeg]);

  // Live readout of the current placement: ground m/px, implied print scale, map north bearing
  const placementReadout = useMemo(() => {
    const m = event.map?.matrix;
    const at = effectiveAnchorLonLat;
    if (!m || !at) return null;
    const metersPerPixel = matrixGroundMetersPerPixel(m, at[1]);
    const impliedScale =
      mapImageKind === 'orienteering' && scanDpi > 0
        ? Math.round((metersPerPixel * scanDpi) / 0.0254 / 100) * 100
        : null;
    return {
      metersPerPixel,
      impliedScale,
      upBearingDeg: Math.round(matrixUpBearingDeg(m) * 10) / 10,
    };
  }, [event.map?.matrix, effectiveAnchorLonLat?.[0], effectiveAnchorLonLat?.[1], mapImageKind, scanDpi]);

  // Sync liveMatrixRef whenever event.map.matrix changes from server
  useEffect(() => {
    liveMatrixRef.current = event.map?.matrix ?? null;
  }, [event.map?.matrix]);

  // Reset per-event UI state when switching events
  useEffect(() => {
    setAnchorLonLat(null);
    setScalePct(100);
    setAngleDeg(0);
    setStretchPct(0);
    prevScalePctRef.current = 100;
    prevAngleDegRef.current = 0;
    prevStretchPctRef.current = 0;
    setCustomStartSpot(null);
    setSelectedLeg(null);
    setSpeedNormMode('real');
    setIsPlaying(false);
    setRaceTimeSec(0);
    setSnapStage('idle');
    setPickedFeatureLonLat(null);
    setUploadError(null);
  }, [event.id]);

  // Each event kind starts on its own default base map (also when the kind is switched)
  useEffect(() => {
    setBaseLayer(defaultBaseLayerFor(kind));
    if (kind === 'run') {
      setSpeedNormMode('real');
      onToggleFitMap?.(false);
    }
  }, [event.id, kind]);

  // Compute group mean speed (m/s) for Livelox speed normalization
  const groupReferenceSpeedMs = useMemo(() => {
    const visible = event.participants.filter(
      (p) => p.visible && p.durationSec > 0
    );
    if (visible.length === 0) return 2.8;
    const sum = visible.reduce(
      (acc, p) => acc + p.totalDistanceM / p.durationSec,
      0
    );
    return sum / visible.length;
  }, [event.participants]);

  // Compute detailed route-choice analytics when a leg (A -> B) is selected
  const legAnalysis = useMemo(() => {
    if (!selectedLeg) return null;
    return analyzeLegBetweenSpots(
      event.participants,
      selectedLeg.startLonLat,
      selectedLeg.endLonLat
    );
  }, [event.participants, selectedLeg]);

  // Compute earliest start epoch across participants for 'real' time mode
  const eventEpochZeroMs = useMemo(() => {
    if (event.participants.length === 0) return Date.now();
    return Math.min(
      ...event.participants.map(
        (p) => p.points[0]?.absTimeMs ?? Date.parse(p.startedAtIso)
      )
    );
  }, [event.participants]);

  // Total replay duration: the race-clock moment the last runner reaches their trimmed finish
  // (depends on the speed mode, since normalization stretches/compresses each runner's timeline)
  const totalDurationSec = useMemo(() => {
    const withPoints = event.participants.filter((p) => p.points.length > 0);
    if (withPoints.length === 0) return 600;
    const finishTimes = withPoints.map((p) => {
      const endT = Math.min(p.trimEndSec, p.durationSec);
      const finishPt =
        [...p.points].reverse().find((pt) => pt.t <= endT) ??
        p.points[p.points.length - 1];
      return raceTimeOfTrackPoint(
        p,
        finishPt,
        event.timeMode,
        eventEpochZeroMs,
        speedNormMode,
        groupReferenceSpeedMs
      );
    });
    return Math.max(
      event.timeMode === 'from_start' ? 15 : 60,
      Math.ceil(Math.max(...finishTimes))
    );
  }, [
    event.participants,
    event.timeMode,
    eventEpochZeroMs,
    speedNormMode,
    groupReferenceSpeedMs,
  ]);

  // Keep the playhead inside the timeline when it shrinks (speed mode, trims, deleted runner)
  useEffect(() => {
    setRaceTimeSec((t) => Math.min(t, totalDurationSec));
  }, [totalDurationSec]);

  // Animation loop via requestAnimationFrame
  useEffect(() => {
    if (!isPlaying) {
      lastFrameMsRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    const tick = (nowMs: number) => {
      if (lastFrameMsRef.current !== null) {
        const dtSec = ((nowMs - lastFrameMsRef.current) / 1000) * playbackRate;
        setRaceTimeSec((prev) => {
          const next = prev + dtSec;
          if (next >= totalDurationSec) {
            setIsPlaying(false);
            return totalDurationSec;
          }
          return next;
        });
      }
      lastFrameMsRef.current = nowMs;
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, playbackRate, totalDurationSec]);

  // Initialize MapLibre GL map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    const initialCenter: [number, number] = event.participants[0]?.points[0]
      ? [
          event.participants[0].points[0].lon,
          event.participants[0].points[0].lat,
        ]
      : event.map?.cornersLonLat
        ? [
            (event.map.cornersLonLat[0][0] + event.map.cornersLonLat[2][0]) / 2,
            (event.map.cornersLonLat[0][1] + event.map.cornersLonLat[2][1]) / 2,
          ]
        : [32.4245, 34.772];

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            maxzoom: 19,
            attribution: '© OpenStreetMap contributors',
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
            attribution:
              '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
          },
          satellite: {
            type: 'raster',
            tiles: [
              'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            ],
            tileSize: 256,
            maxzoom: 19,
            attribution: '© Esri World Imagery',
          },
        },
        // Hidden base layers use `visibility: none` so their tiles are not downloaded at all
        layers: BASE_LAYERS.map((layer) => ({
          id: `${layer}-base`,
          type: 'raster' as const,
          source: layer,
          layout: {
            visibility:
              layer === baseLayerRef.current
                ? ('visible' as const)
                : ('none' as const),
          },
          paint: { 'raster-opacity': osmOpacity },
        })),
      },
      center: initialCenter,
      zoom: 14.3,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapRef.current = map;
    mapReadyRef.current = false;

    map.on('load', () => {
      mapReadyRef.current = true;
      // The event may have been updated while the style was loading: use the latest one
      const event = eventRef.current;
      // The base layer may have been switched (e.g. per event kind) while loading
      for (const layer of BASE_LAYERS) {
        map.setLayoutProperty(
          `${layer}-base`,
          'visibility',
          layer === baseLayerRef.current ? 'visible' : 'none'
        );
      }
      // 1. Georeferenced custom map overlay
      if (event.map?.cornersLonLat) {
        map.addSource('custom-map', {
          type: 'image',
          url: event.map.imageUrl,
          coordinates: event.map.cornersLonLat,
        });
        customMapUrlRef.current = event.map.imageUrl;
        map.addLayer({
          id: 'custom-map-layer',
          type: 'raster',
          source: 'custom-map',
          paint: {
            'raster-opacity':
              eventKindOf(event) === 'orienteering' ? mapOpacity : 0,
            'raster-fade-duration': 0,
          },
        });
      }

      // 2. Full GPS tracks (white halo + clear colored line)
      map.addSource('ghost-tracks', {
        type: 'geojson',
        data: buildGhostTracksGeoJson(event.participants),
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
        data: buildCommonStartGeoJson(event.participants),
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

      fitMapToTracksOrMap(map, event);
    });

    return () => {
      mapReadyRef.current = false;
      for (const m of runnerMarkersRef.current.values()) m.remove();
      runnerMarkersRef.current.clear();
      anchorMarkerRef.current?.remove();
      anchorMarkerRef.current = null;
      for (const lm of legMarkersRef.current) lm.remove();
      legMarkersRef.current = [];
      map.remove();
      mapRef.current = null;
      customMapUrlRef.current = null;
    };
  }, [event.id]);

  // Update base layer choice and raster opacities when the controls change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    for (const layer of BASE_LAYERS) {
      const id = `${layer}-base`;
      if (!map.getLayer(id)) continue;
      map.setLayoutProperty(
        id,
        'visibility',
        layer === baseLayer ? 'visible' : 'none'
      );
      map.setPaintProperty(id, 'raster-opacity', osmOpacity);
    }
    if (map.getLayer('custom-map-layer')) {
      map.setPaintProperty(
        'custom-map-layer',
        'raster-opacity',
        // A run/hike keeps any old map hidden: the base map is the map there
        isOrienteering ? mapOpacity : 0
      );
    }
  }, [osmOpacity, mapOpacity, baseLayer, isOrienteering]);

  // Update or remove custom map when `event.map` changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;

    if (!event.map?.cornersLonLat) {
      if (map.getLayer('custom-map-layer')) {
        map.removeLayer('custom-map-layer');
      }
      if (map.getSource('custom-map')) {
        map.removeSource('custom-map');
      }
      customMapUrlRef.current = null;
      return;
    }

    const mapObj = event.map;
    const corners = mapObj.cornersLonLat!;
    const src = map.getSource('custom-map') as
      | maplibregl.ImageSource
      | undefined;

    if (src) {
      // Re-downloading the (multi-MB) scan on every placement save makes it flicker:
      // only reload when the image itself changed
      if (customMapUrlRef.current === mapObj.imageUrl) {
        src.setCoordinates(corners);
      } else {
        src.updateImage({ url: mapObj.imageUrl, coordinates: corners });
      }
      customMapUrlRef.current = mapObj.imageUrl;
    } else {
      customMapUrlRef.current = mapObj.imageUrl;
      map.addSource('custom-map', {
        type: 'image',
        url: mapObj.imageUrl,
        coordinates: corners,
      });
      map.addLayer(
        {
          id: 'custom-map-layer',
          type: 'raster',
          source: 'custom-map',
          paint: {
            'raster-opacity': isOrienteering ? mapOpacity : 0,
            'raster-fade-duration': 0,
          },
        },
        'ghost-tracks-casing'
      );
    }
  }, [event.map]);

  // Show draggable green "⚓ СТАРТ (Якорь)" marker when `fitMapMode` is active
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;

    anchorMarkerRef.current?.remove();
    anchorMarkerRef.current = null;

    if (!fitMapMode || !effectiveAnchorLonLat) return;

    const el = document.createElement('div');
    el.className =
      'px-2 py-0.5 rounded-full bg-emerald-500 border-2 border-white text-slate-950 font-bold text-[11px] shadow-xl cursor-grab flex items-center gap-1 select-none';
    el.textContent = '⚓ СТАРТ (якорь)';
    el.title =
      'Точка вращения и масштабирования карты! Совместите треугольник Старта карты с этой точкой, и при масштабировании Старт не собьётся.';
    el.addEventListener('mousedown', (ev) => ev.stopPropagation());

    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(effectiveAnchorLonLat)
      .addTo(map);

    marker.on('dragend', () => {
      const lngLat = marker.getLngLat();
      setAnchorLonLat([
        Number(lngLat.lng.toFixed(6)),
        Number(lngLat.lat.toFixed(6)),
      ]);
    });

    anchorMarkerRef.current = marker;

    return () => {
      marker.remove();
      anchorMarkerRef.current = null;
    };
    // event.id: the MapLibre instance is recreated per event, so the marker must be re-attached
  }, [fitMapMode, effectiveAnchorLonLat?.[0], effectiveAnchorLonLat?.[1], event.id]);

  // Direct 60 FPS mouse dragging of the custom map overlay when `fitMapMode && dragMovesMap` is active
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const shouldCaptureDrag =
      fitMapMode &&
      dragMovesMap &&
      Boolean(event.map) &&
      snapStage === 'idle';

    if (!shouldCaptureDrag) {
      map.dragPan.enable();
      return;
    }

    map.dragPan.disable();
    const canvas = map.getCanvasContainer();

    let isDraggingMap = false;
    let startMercator: [number, number] | null = null;
    let startMatrix: [number, number, number, number, number, number] | null =
      null;

    const onMouseDown = (e: MouseEvent) => {
      // Allow Shift+drag or Right/Middle click to pan the viewport camera
      if (e.button !== 0 || e.shiftKey) {
        map.dragPan.enable();
        return;
      }
      if (!liveMatrixRef.current || !eventRef.current.map) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const lngLat = map.unproject([
        e.clientX - rect.left,
        e.clientY - rect.top,
      ]);
      startMercator = lonLatToMercator(lngLat.lng, lngLat.lat);
      startMatrix = [...liveMatrixRef.current] as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      isDraggingMap = true;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (
        !isDraggingMap ||
        !startMercator ||
        !startMatrix ||
        !eventRef.current.map
      ) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const lngLat = map.unproject([
        e.clientX - rect.left,
        e.clientY - rect.top,
      ]);
      const [mx, my] = lonLatToMercator(lngLat.lng, lngLat.lat);
      const dEastM = mx - startMercator[0];
      const dNorthM = my - startMercator[1];

      const nextMatrix: [number, number, number, number, number, number] = [
        startMatrix[0],
        startMatrix[1],
        startMatrix[2] + dEastM,
        startMatrix[3],
        startMatrix[4],
        startMatrix[5] + dNorthM,
      ];
      liveMatrixRef.current = nextMatrix;

      const corners = matrixToCorners(
        nextMatrix,
        eventRef.current.map.width,
        eventRef.current.map.height
      );
      const src = map.getSource('custom-map') as
        | maplibregl.ImageSource
        | undefined;
      if (src) {
        src.setCoordinates(corners);
      }
    };

    const onMouseUp = () => {
      if (isDraggingMap && liveMatrixRef.current) {
        isDraggingMap = false;
        void saveMatrixToServer(liveMatrixRef.current);
      }
      map.dragPan.disable();
    };

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      map.dragPan.enable();
    };
    // event.id: listeners belong to the per-event MapLibre instance
  }, [fitMapMode, dragMovesMap, Boolean(event.map), snapStage, event.id]);

  // Apply live 60 FPS transform around `effectiveAnchorLonLat` and update MapLibre ImageSource
  function applyLiveNudge(params: {
    dEastM?: number;
    dNorthM?: number;
    scaleFactor?: number;
    stretchXFactor?: number;
    dAngleDeg?: number;
    commitToServer?: boolean;
  }) {
    const map = mapRef.current;
    const mapMeta = eventRef.current.map;
    if (!map || !mapMeta || !liveMatrixRef.current) return;

    const res = nudgeMapMatrix(
      liveMatrixRef.current,
      mapMeta.width,
      mapMeta.height,
      {
        ...params,
        anchorLonLat: anchorLonLatRef.current ?? undefined,
      }
    );
    liveMatrixRef.current = res.matrix;

    const src = map.getSource('custom-map') as
      | maplibregl.ImageSource
      | undefined;
    if (src) {
      src.setCoordinates(res.cornersLonLat);
    }

    if (params.commitToServer) {
      void saveMatrixToServer(res.matrix);
    }
  }

  async function saveMatrixToServer(
    matrix: [number, number, number, number, number, number],
    meta?: MapOverlayMeta
  ) {
    const seq = ++matrixSaveSeqRef.current;
    const eventId = eventRef.current.id;
    // Saves run one after another so the server always ends up with the last placement
    matrixSaveChainRef.current = matrixSaveChainRef.current.then(async () => {
      try {
        const res = await fetch(`/api/events/${eventId}/map-nudge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matrix, meta }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setUploadError(data.error || 'Не удалось сохранить положение карты');
          return;
        }
        const data = await res.json();
        // Skip stale responses (a newer save is queued) and responses for an event we left
        if (seq !== matrixSaveSeqRef.current || eventRef.current.id !== eventId) {
          return;
        }
        onEventUpdated(data.event);
      } catch {
        // network error: the next save carries the full matrix anyway
      }
    });
    await matrixSaveChainRef.current;
  }

  /** Relative sliders restart from zero after an absolute placement change */
  function resetRelativeSliders() {
    setScalePct(100);
    setAngleDeg(0);
    setStretchPct(0);
    prevScalePctRef.current = 100;
    prevAngleDegRef.current = 0;
    prevStretchPctRef.current = 0;
  }

  /**
   * Put the map at an exact ground scale and orientation around ⚓ СТАРТ:
   * - O-map: scale from print scale + DPI (or `groundMPerPx` from a scale bar), up = magnetic north
   * - Google screenshot: keep scale (or scale-bar value), up = true north
   */
  function applyScaleAndNorth(groundMPerPx: number | null) {
    const map = mapRef.current;
    const mapMeta = eventRef.current.map;
    const current = liveMatrixRef.current;
    const anchor = anchorLonLatRef.current;
    if (!map || !mapMeta || !current || !anchor) return;

    const isOMap = mapImageKind === 'orienteering';
    if (isOMap && !(printScale >= 500 && scanDpi >= 30) && groundMPerPx === null) {
      setUploadError('Укажите масштаб карты и DPI скана');
      return;
    }
    const metersPerPixel =
      groundMPerPx ??
      (isOMap
        ? groundMetersPerPixelFromPrint(printScale, scanDpi)
        : matrixGroundMetersPerPixel(current, anchor[1]));
    const upBearingDeg = isOMap ? declinationDeg : 0;
    const next = buildScaledOrientedMatrix(
      current,
      anchor,
      metersPerPixel,
      upBearingDeg
    );
    if (!next) return;

    liveMatrixRef.current = next;
    const src = map.getSource('custom-map') as maplibregl.ImageSource | undefined;
    src?.setCoordinates(matrixToCorners(next, mapMeta.width, mapMeta.height));
    resetRelativeSliders();
    setUploadError(null);
    void saveMatrixToServer(next, {
      imageKind: mapImageKind,
      declinationDeg: isOMap ? declinationDeg : 0,
      ...(isOMap && groundMPerPx === null ? { printScale, scanDpi } : {}),
    });
  }

  /** Scale bar measured: ask its length and apply the resulting exact scale */
  function finishScaleBar(p1: [number, number], p2: [number, number]) {
    const current = liveMatrixRef.current;
    if (!current) return;
    const input = window.prompt('Длина масштабной линейки, метров:', '100');
    if (!input) return;
    const lengthM = Number(input.replace(',', '.'));
    const mpp = groundMetersPerPixelFromScaleBar(current, p1, p2, lengthM);
    if (!mpp) {
      setUploadError('Не удалось измерить линейку: кликните два разных конца');
      return;
    }
    applyScaleAndNorth(mpp);
  }

  async function handleResetMapAutoFit() {
    const res = await fetch(`/api/events/${event.id}/map-nudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetAutoFit: true }),
    });
    if (res.ok) {
      const data = await res.json();
      setScalePct(100);
      setAngleDeg(0);
      setStretchPct(0);
      prevScalePctRef.current = 100;
      prevAngleDegRef.current = 0;
      prevStretchPctRef.current = 0;
      setAnchorLonLat(null);
      onEventUpdated(data.event);
    }
  }

  // Render custom start spot or selected leg (A -> B) markers & line on MapLibre
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;

    for (const lm of legMarkersRef.current) lm.remove();
    legMarkersRef.current = [];

    const legSrc = map.getSource('selected-leg') as
      | maplibregl.GeoJSONSource
      | undefined;

    if (selectedLeg) {
      if (legSrc) {
        legSrc.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: [selectedLeg.startLonLat, selectedLeg.endLonLat],
              },
            },
          ],
        });
      }

      const elA = document.createElement('div');
      elA.className =
        'w-7 h-7 rounded-full bg-fuchsia-600 border-2 border-white text-white font-bold text-xs flex items-center justify-center shadow-xl pointer-events-none';
      elA.textContent = 'A';
      legMarkersRef.current.push(
        new maplibregl.Marker({ element: elA })
          .setLngLat(selectedLeg.startLonLat)
          .addTo(map)
      );

      const elB = document.createElement('div');
      elB.className =
        'w-7 h-7 rounded-full bg-fuchsia-600 border-2 border-white text-white font-bold text-xs flex items-center justify-center shadow-xl pointer-events-none';
      elB.textContent = 'B';
      legMarkersRef.current.push(
        new maplibregl.Marker({ element: elB })
          .setLngLat(selectedLeg.endLonLat)
          .addTo(map)
      );
    } else {
      if (legSrc) {
        legSrc.setData({ type: 'FeatureCollection', features: [] });
      }
      if (customStartSpot) {
        const el = document.createElement('div');
        el.className =
          'px-2 py-0.5 rounded-full bg-emerald-500 border-2 border-white text-slate-950 font-bold text-[11px] shadow-xl pointer-events-none';
        el.textContent = '🏁 СТАРТ';
        legMarkersRef.current.push(
          new maplibregl.Marker({ element: el })
            .setLngLat(customStartSpot)
            .addTo(map)
        );
      }
    }
  }, [selectedLeg, customStartSpot]);

  // Update ghost tracks & common start marker when participants list changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    const src = map.getSource('ghost-tracks') as
      | maplibregl.GeoJSONSource
      | undefined;
    if (src) {
      src.setData(buildGhostTracksGeoJson(event.participants));
    }
    const startSrc = map.getSource('common-start') as
      | maplibregl.GeoJSONSource
      | undefined;
    if (startSrc) {
      startSrc.setData(buildCommonStartGeoJson(event.participants));
    }
  }, [event.participants]);

  // Compute live interpolated states for each participant at `raceTimeSec`
  const runnerStates = useMemo(() => {
    return event.participants.map((p) => ({
      participant: p,
      state: interpolateTrackAt(
        p,
        raceTimeSec,
        event.timeMode,
        eventEpochZeroMs,
        speedNormMode,
        groupReferenceSpeedMs
      ),
    }));
  }, [
    event.participants,
    raceTimeSec,
    event.timeMode,
    eventEpochZeroMs,
    speedNormMode,
    groupReferenceSpeedMs,
  ]);

  // Sync active tails GeoJSON and HTML runner markers on every frame
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const updateDynamicElements = () => {
      const tailSrc = map.getSource('active-tails') as
        | maplibregl.GeoJSONSource
        | undefined;
      if (tailSrc) {
        tailSrc.setData(
          buildActiveTailsGeoJson(
            event.participants,
            raceTimeSec,
            tailLengthSec,
            event.timeMode,
            eventEpochZeroMs,
            speedHeatmap,
            speedNormMode,
            groupReferenceSpeedMs
          )
        );
      }

      const activeIds = new Set<string>();
      for (const { participant: p, state } of runnerStates) {
        if (!p.visible || !state) continue;
        activeIds.add(p.id);

        let marker = runnerMarkersRef.current.get(p.id);
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
          runnerMarkersRef.current.set(p.id, marker);
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

      for (const [id, marker] of runnerMarkersRef.current.entries()) {
        if (!activeIds.has(id)) {
          marker.remove();
          runnerMarkersRef.current.delete(id);
        }
      }
    };

    if (mapReadyRef.current) {
      updateDynamicElements();
    } else {
      map.once('load', updateDynamicElements);
    }
  }, [
    runnerStates,
    raceTimeSec,
    tailLengthSec,
    speedHeatmap,
    speedNormMode,
    groupReferenceSpeedMs,
    event.participants,
    event.timeMode,
    eventEpochZeroMs,
  ]);

  // Sort participants by distance covered at current timestamp for live leaderboard
  const leaderboard = useMemo(() => {
    const list = [...runnerStates];
    list.sort((a, b) => (b.state?.distM ?? 0) - (a.state?.distM ?? 0));
    const leaderDist = list[0]?.state?.distM ?? 0;
    return list.map((item, idx) => ({
      ...item,
      rank: idx + 1,
      gapMeters: Math.max(0, Math.round(leaderDist - (item.state?.distM ?? 0))),
    }));
  }, [runnerStates]);

  async function handleDeleteCurrentMap() {
    if (!event.map) return;
    if (!window.confirm('Удалить загруженную карту из этого мероприятия?')) {
      return;
    }
    const res = await fetch(`/api/events/${event.id}/map`, {
      method: 'DELETE',
    });
    if (res.ok) {
      const data = await res.json();
      onEventUpdated(data.event);
      onToggleFitMap?.(false);
    }
  }

  async function handleTrackUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploadingTrack(true);
    setUploadError(null);

    try {
      let latestEvent = event;
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`/api/events/${event.id}/tracks`, {
          method: 'POST',
          body: form,
        });
        const data = await res.json();
        if (!res.ok) {
          setUploadError(data.error || 'Ошибка загрузки трека');
        } else {
          latestEvent = data.event;
        }
      }
      onEventUpdated(latestEvent);
      if (mapRef.current) {
        fitMapToTracksOrMap(mapRef.current, latestEvent);
      }
    } finally {
      setUploadingTrack(false);
      e.target.value = '';
    }
  }

  async function handleQuickScreenshotUpload(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingScreenshot(true);
    setUploadError(null);
    try {
      const dims = await new Promise<{ width: number; height: number }>(
        (resolve) => {
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            resolve({
              width: img.naturalWidth || 1200,
              height: img.naturalHeight || 900,
            });
            URL.revokeObjectURL(url);
          };
          img.onerror = () => resolve({ width: 1200, height: 900 });
          img.src = url;
        }
      );

      const form = new FormData();
      form.append('width', String(dims.width));
      form.append('height', String(dims.height));
      form.append('file', file);

      const res = await fetch(`/api/events/${event.id}/map`, {
        method: 'POST',
        body: form,
      });
      if (res.ok) {
        const data = await res.json();
        setScalePct(100);
        setAngleDeg(0);
        setStretchPct(0);
        prevScalePctRef.current = 100;
        prevAngleDegRef.current = 0;
        prevStretchPctRef.current = 0;
        onEventUpdated(data.event);
        onToggleFitMap?.(true);
      } else {
        const data = await res.json().catch(() => ({}));
        setUploadError(data.error || 'Не удалось загрузить карту');
      }
    } catch {
      setUploadError('Не удалось загрузить карту (нет связи с сервером)');
    } finally {
      setUploadingScreenshot(false);
      e.target.value = '';
    }
  }

  async function updateParticipant(
    participantId: string,
    patch: Partial<ParticipantTrack>
  ) {
    const res = await fetch(
      `/api/events/${event.id}/participants/${participantId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }
    );
    if (res.ok) {
      const data = await res.json();
      onEventUpdated(data.event);
    }
  }

  async function deleteParticipant(participantId: string) {
    const res = await fetch(
      `/api/events/${event.id}/participants/${participantId}`,
      {
        method: 'DELETE',
      }
    );
    if (res.ok) {
      const data = await res.json();
      onEventUpdated(data.event);
    }
  }

  async function toggleTimeMode(mode: TimeMode) {
    const res = await fetch(`/api/events/${event.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMode: mode }),
    });
    if (res.ok) {
      const data = await res.json();
      onEventUpdated(data.event);
      setRaceTimeSec(0);
    }
  }

  // Click on Map for `spot_start` (mass start from clicked point) or `leg_start` -> `leg_end` (leg analysis)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onMapClick = (e: maplibregl.MapMouseEvent) => {
      const clicked: [number, number] = [
        Number(e.lngLat.lng.toFixed(6)),
        Number(e.lngLat.lat.toFixed(6)),
      ];

      if (snapStage === 'scalebar_start') {
        setPickedFeatureLonLat(clicked);
        setSnapStage('scalebar_end');
        return;
      }
      if (snapStage === 'scalebar_end' && pickedFeatureLonLat) {
        const startPt = pickedFeatureLonLat;
        setSnapStage('idle');
        setPickedFeatureLonLat(null);
        // Unrounded click position: 6 decimals (~10 cm) would be fine, but keep it exact
        finishScaleBar(startPt, [e.lngLat.lng, e.lngLat.lat]);
        return;
      }

      if (snapStage === 'spot_start') {
        setSnapStage('idle');
        setSelectedLeg(null);
        setCustomStartSpot(clicked);
        void syncStartAtSpot(clicked);
        return;
      }

      if (snapStage === 'leg_start') {
        setPickedFeatureLonLat(clicked);
        setSnapStage('leg_end');
        return;
      }
      if (snapStage === 'leg_end' && pickedFeatureLonLat) {
        const startPt = pickedFeatureLonLat;
        setSnapStage('idle');
        setPickedFeatureLonLat(null);
        setCustomStartSpot(null);
        setSelectedLeg({ startLonLat: startPt, endLonLat: clicked });
        void syncStartAtSpot(startPt, clicked);
      }
    };

    map.on('click', onMapClick);
    return () => {
      map.off('click', onMapClick);
    };
    // Scale-bar completion reads the current scale/north settings: re-bind when they change
  }, [
    snapStage,
    pickedFeatureLonLat,
    event.id,
    mapImageKind,
    printScale,
    scanDpi,
    declinationDeg,
  ]);

  async function syncStartAtSpot(
    spot?: [number, number],
    endSpot?: [number, number]
  ) {
    const res = await fetch(`/api/events/${event.id}/sync-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        spot
          ? {
              spotLon: spot[0],
              spotLat: spot[1],
              endLon: endSpot?.[0],
              endLat: endSpot?.[1],
            }
          : {}
      ),
    });
    if (res.ok) {
      const data = await res.json();
      onEventUpdated(data.event);
      setRaceTimeSec(0);
    }
  }

  async function resetToFullRaceStart() {
    setCustomStartSpot(null);
    setSelectedLeg(null);
    setSpeedNormMode('real');
    await syncStartAtSpot();
  }

  function handleScaleSliderChange(nextPct: number, commit = false) {
    const clamped = Math.max(40, Math.min(260, nextPct));
    const factor = clamped / prevScalePctRef.current;
    prevScalePctRef.current = clamped;
    setScalePct(clamped);
    applyLiveNudge({ scaleFactor: factor, commitToServer: commit });
  }

  function handleAngleSliderChange(nextDeg: number, commit = false) {
    const clamped = Math.max(-60, Math.min(60, nextDeg));
    const delta = clamped - prevAngleDegRef.current;
    prevAngleDegRef.current = clamped;
    setAngleDeg(clamped);
    applyLiveNudge({ dAngleDeg: delta, commitToServer: commit });
  }

  function handleStretchSliderChange(nextPct: number, commit = false) {
    const clamped = Math.max(-25, Math.min(25, nextPct));
    const factor = (1 + clamped / 100) / (1 + prevStretchPctRef.current / 100);
    prevStretchPctRef.current = clamped;
    setStretchPct(clamped);
    applyLiveNudge({ stretchXFactor: factor, commitToServer: commit });
  }

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100">
      {/* Main workspace: [Unified Map Pane] + [Right Analytics Sidebar] */}
      <div className="grid grid-cols-1 lg:grid-cols-12 flex-1 min-h-0">
        {/* MAIN MAP PANE */}
        <div className="lg:col-span-8 xl:col-span-9 flex flex-col min-h-[420px] relative overflow-hidden">
          {/* Docked Top Map Toolbar */}
          <div className="relative z-10 px-3 py-2 bg-slate-900 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
            <div className="flex flex-wrap items-center gap-2">
              {isOrienteering && (
                <label
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer transition"
                  title="Скан карты ориентирования или скриншот Google Maps"
                >
                  <ImagePlus className="w-3.5 h-3.5" />
                  {uploadingScreenshot
                    ? 'Загрузка...'
                    : event.map
                      ? 'Заменить карту'
                      : 'Загрузить карту'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={handleQuickScreenshotUpload}
                  />
                </label>
              )}

              {isOrienteering && event.map && (
                <>
                  <button
                    onClick={() => onToggleFitMap?.(!fitMapMode)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-medium border transition ${
                      fitMapMode
                        ? 'bg-amber-500 border-amber-400 text-slate-950 font-semibold shadow'
                        : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-amber-300'
                    }`}
                  >
                    <Move className="w-3.5 h-3.5" />
                    {fitMapMode ? 'Подгонка включена' : '✋ Подогнать карту'}
                  </button>

                  <button
                    onClick={handleDeleteCurrentMap}
                    className="p-1 rounded-lg bg-slate-800 hover:bg-rose-900/60 border border-slate-700 hover:border-rose-500/50 text-slate-400 hover:text-rose-300 transition"
                    title="Удалить загруженную карту из этого мероприятия"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>

                  <div className="flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-slate-300">Карта:</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={mapOpacity}
                      onChange={(e) => setMapOpacity(parseFloat(e.target.value))}
                      className="w-16 accent-emerald-500"
                    />
                  </div>
                </>
              )}

              {/* Base map: one active layer at a time (hidden ones download no tiles) */}
              <div className="flex items-center gap-0.5 bg-slate-950 p-0.5 rounded-lg border border-slate-800">
                {BASE_LAYERS.map((layer) => (
                  <button
                    key={layer}
                    onClick={() => setBaseLayer(layer)}
                    className={`px-2 py-0.5 rounded-md transition ${
                      baseLayer === layer
                        ? 'bg-sky-600 text-white font-medium'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {BASE_LAYER_LABELS[layer]}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1.5" title="Прозрачность подложки">
                <span className="text-slate-300">Подложка:</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={osmOpacity}
                  onChange={(e) => setOsmOpacity(parseFloat(e.target.value))}
                  className="w-16 accent-sky-500"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1">
                <span className="text-slate-400">Хвост:</span>
                {TAIL_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setTailLengthSec(opt.value)}
                    className={`px-1.5 py-0.5 rounded transition ${
                      tailLengthSec === opt.value
                        ? 'bg-emerald-600 text-white font-medium'
                        : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <button
                onClick={() => setSpeedHeatmap((v) => !v)}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border transition ${
                  speedHeatmap
                    ? 'bg-amber-500/20 border-amber-400/50 text-amber-300 font-medium'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
                title="Окрашивать трек по мгновенному темпу"
              >
                <Flame className="w-3.5 h-3.5" />
                Темп
              </button>
            </div>
          </div>

          {/* SIMPLE, DIRECT MAP FITTING PANEL (shown when fitMapMode is active) */}
          {fitMapMode && isOrienteering && event.map && (
            <div className="relative z-10 px-3 py-2.5 bg-slate-900/95 border-b border-amber-500/40 space-y-2 text-xs shrink-0 shadow-xl">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-amber-300 flex items-center gap-1.5">
                    <Anchor className="w-3.5 h-3.5" />
                    Шаг 1: потяни карту мышкой, совместив Старт △ с зелёной точкой ⚓ СТАРТ. Шаг 2: подгони Масштаб и Поворот ползунками!
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  {/* Mouse drag mode switch: move map vs move screen */}
                  <button
                    onClick={() => setDragMovesMap((v) => !v)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border font-medium transition ${
                      dragMovesMap
                        ? 'bg-amber-500 text-slate-950 border-amber-400'
                        : 'bg-slate-800 text-sky-300 border-slate-700'
                    }`}
                    title="Переключить действие левой кнопки мыши: двигать саму карту под треком или двигать камеру"
                  >
                    {dragMovesMap ? (
                      <>
                        <Move className="w-3.5 h-3.5" />
                        Мышь: двигает КАРТУ
                      </>
                    ) : (
                      <>
                        <Globe className="w-3.5 h-3.5" />
                        Мышь: двигает ЭКРАН
                      </>
                    )}
                  </button>

                  <button
                    onClick={() => void handleResetMapAutoFit()}
                    className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white transition"
                    title="Сбросить карту в исходное положение над треком"
                  >
                    ↺ Сбросить
                  </button>

                  <button
                    onClick={() => onToggleFitMap?.(false)}
                    className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Готово
                  </button>
                </div>
              </div>

              {/* Sliders row: Scale + Rotation + Stretch X/Y + Fine shift arrows (all pivot around ⚓ СТАРТ!) */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5 items-center bg-slate-950/90 p-2 rounded-xl border border-slate-800">
                {/* 1. Scale Slider */}
                <div className="md:col-span-4 flex items-center gap-1.5">
                  <span className="text-slate-300 font-medium w-20 shrink-0">
                    Масштаб: <strong className="text-emerald-400">{scalePct}%</strong>
                  </span>
                  <button
                    onClick={() => handleScaleSliderChange(scalePct - 1, true)}
                    className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono"
                    title="Уменьшить на 1% вокруг ⚓ СТАРТ"
                  >
                    -
                  </button>
                  <input
                    type="range"
                    min={40}
                    max={260}
                    step={1}
                    value={scalePct}
                    onChange={(e) =>
                      handleScaleSliderChange(parseFloat(e.target.value), false)
                    }
                    onMouseUp={() =>
                      liveMatrixRef.current &&
                      void saveMatrixToServer(liveMatrixRef.current)
                    }
                    onTouchEnd={() =>
                      liveMatrixRef.current &&
                      void saveMatrixToServer(liveMatrixRef.current)
                    }
                    className="flex-1 accent-emerald-500 cursor-pointer"
                  />
                  <button
                    onClick={() => handleScaleSliderChange(scalePct + 1, true)}
                    className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono"
                    title="Увеличить на 1% вокруг ⚓ СТАРТ"
                  >
                    +
                  </button>
                </div>

                {/* 2. Rotation Slider */}
                <div className="md:col-span-4 flex items-center gap-1.5">
                  <span className="text-slate-300 font-medium w-20 shrink-0">
                    Поворот:{' '}
                    <strong className="text-amber-400">
                      {angleDeg > 0 ? `+${angleDeg}°` : `${angleDeg}°`}
                    </strong>
                  </span>
                  <button
                    onClick={() =>
                      handleAngleSliderChange(
                        Math.round((angleDeg - 0.5) * 10) / 10,
                        true
                      )
                    }
                    className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                    title="Повернуть на -0.5° вокруг ⚓ СТАРТ"
                  >
                    <RotateCw className="w-3 h-3" />
                  </button>
                  <input
                    type="range"
                    min={-45}
                    max={45}
                    step={0.5}
                    value={angleDeg}
                    onChange={(e) =>
                      handleAngleSliderChange(parseFloat(e.target.value), false)
                    }
                    onMouseUp={() =>
                      liveMatrixRef.current &&
                      void saveMatrixToServer(liveMatrixRef.current)
                    }
                    onTouchEnd={() =>
                      liveMatrixRef.current &&
                      void saveMatrixToServer(liveMatrixRef.current)
                    }
                    className="flex-1 accent-amber-500 cursor-pointer"
                  />
                  <button
                    onClick={() =>
                      handleAngleSliderChange(
                        Math.round((angleDeg + 0.5) * 10) / 10,
                        true
                      )
                    }
                    className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                    title="Повернуть на +0.5° вокруг ⚓ СТАРТ"
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>
                </div>

                {/* 3. Stretch X/Y Slider + Fine Nudge Arrows */}
                <div className="md:col-span-4 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 flex-1">
                    <span
                      className="text-slate-300 font-medium shrink-0"
                      title="Растяжение по ширине/высоте (если фото карты снято телефоном чуть под углом)"
                    >
                      Ш/В:{' '}
                      <strong className="text-sky-400">
                        {stretchPct > 0 ? `+${stretchPct}%` : `${stretchPct}%`}
                      </strong>
                    </span>
                    <input
                      type="range"
                      min={-25}
                      max={25}
                      step={1}
                      value={stretchPct}
                      onChange={(e) =>
                        handleStretchSliderChange(
                          parseFloat(e.target.value),
                          false
                        )
                      }
                      onMouseUp={() =>
                        liveMatrixRef.current &&
                        void saveMatrixToServer(liveMatrixRef.current)
                      }
                      onTouchEnd={() =>
                        liveMatrixRef.current &&
                        void saveMatrixToServer(liveMatrixRef.current)
                      }
                      className="flex-1 accent-sky-500 cursor-pointer"
                    />
                  </div>

                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={() =>
                        applyLiveNudge({ dEastM: -5, commitToServer: true })
                      }
                      className="p-1 rounded bg-slate-800 hover:bg-slate-700"
                      title="Сдвинуть карту на 5м влево"
                    >
                      <ArrowLeft className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() =>
                        applyLiveNudge({ dNorthM: 5, commitToServer: true })
                      }
                      className="p-1 rounded bg-slate-800 hover:bg-slate-700"
                      title="Сдвинуть карту на 5м вверх"
                    >
                      <ArrowUp className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() =>
                        applyLiveNudge({ dNorthM: -5, commitToServer: true })
                      }
                      className="p-1 rounded bg-slate-800 hover:bg-slate-700"
                      title="Сдвинуть карту на 5м вниз"
                    >
                      <ArrowDown className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() =>
                        applyLiveNudge({ dEastM: 5, commitToServer: true })
                      }
                      className="p-1 rounded bg-slate-800 hover:bg-slate-700"
                      title="Сдвинуть карту на 5м вправо"
                    >
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Scale & north: exact size from print scale/DPI or a scale bar, O-map turned to magnetic north */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-slate-950/90 p-2 rounded-xl border border-slate-800">
                <div className="flex items-center gap-0.5 bg-slate-900 p-0.5 rounded-lg border border-slate-800">
                  {(
                    [
                      ['orienteering', '🧭 Карта О'],
                      ['screenshot', '🗺 Скриншот Google'],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setMapImageKind(k)}
                      className={`px-2 py-0.5 rounded-md transition ${
                        mapImageKind === k
                          ? 'bg-emerald-600 text-white font-medium'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                      title={
                        k === 'orienteering'
                          ? 'Карта ориентирования: нарисована на магнитный север, масштаб печати известен'
                          : 'Скриншот Google Maps: истинный север, масштаб — по линейке на скриншоте'
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {mapImageKind === 'orienteering' && (
                  <>
                    <label className="flex items-center gap-1 text-slate-300">
                      1:
                      <input
                        list="retrace-print-scales"
                        type="number"
                        min={500}
                        max={200000}
                        step={500}
                        value={printScale}
                        onChange={(e) => setPrintScale(Number(e.target.value))}
                        className="w-20 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-100"
                        title="Масштаб печати карты (указан на карте: 1:4000, 1:10000...)"
                      />
                      <datalist id="retrace-print-scales">
                        {PRINT_SCALES.map((s) => (
                          <option key={s} value={s} />
                        ))}
                      </datalist>
                    </label>
                    <label
                      className="flex items-center gap-1 text-slate-300"
                      title="Разрешение скана. Для фото с телефона DPI неизвестен — используйте линейку"
                    >
                      DPI
                      <input
                        type="number"
                        min={30}
                        max={2400}
                        step={10}
                        value={scanDpi}
                        onChange={(e) => setScanDpi(Number(e.target.value))}
                        className="w-16 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-100"
                      />
                    </label>
                    <label
                      className="flex items-center gap-1 text-slate-300"
                      title="Магнитное склонение: карты ориентирования рисуются на магнитный север, а подложка — на истинный"
                    >
                      Склонение
                      <input
                        type="number"
                        min={-60}
                        max={60}
                        step={0.1}
                        value={declinationDeg}
                        onChange={(e) => setDeclinationDeg(Number(e.target.value))}
                        className="w-16 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-100"
                      />
                      °
                      <button
                        onClick={() => setDeclinationDeg(autoDeclinationDeg)}
                        className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-sky-300"
                        title="Склонение по модели WMM2025 для места старта и даты забега"
                      >
                        авто {formatSignedDeg(autoDeclinationDeg)}
                      </button>
                    </label>
                  </>
                )}

                <button
                  onClick={() => applyScaleAndNorth(null)}
                  className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                  title={
                    mapImageKind === 'orienteering'
                      ? 'Выставить точный размер по масштабу и DPI и повернуть на магнитный север. ⚓ СТАРТ не сдвигается'
                      : 'Повернуть скриншот строго на север (масштаб не меняется). ⚓ СТАРТ не сдвигается'
                  }
                >
                  {mapImageKind === 'orienteering'
                    ? 'Применить масштаб и север'
                    : 'Выровнять на север'}
                </button>
                <button
                  onClick={() => {
                    setPickedFeatureLonLat(null);
                    setSnapStage('scalebar_start');
                  }}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-amber-300"
                  title="Кликнуть два конца масштабной линейки на карте и ввести её длину в метрах — для фото и скриншотов"
                >
                  📏 По линейке
                </button>

                {placementReadout && (
                  <span className="text-[11px] text-slate-400 font-mono">
                    сейчас: {placementReadout.metersPerPixel.toFixed(3)} м/пикс
                    {placementReadout.impliedScale
                      ? ` (≈1:${placementReadout.impliedScale})`
                      : ''}
                    , север карты {formatSignedDeg(placementReadout.upBearingDeg)}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Active Map Click Prompt Banner (for Spot Start, Leg Selection or Scale Bar) */}
          {snapStage !== 'idle' && (
            <div className="relative z-10 px-3 py-1.5 bg-fuchsia-600/25 border-b border-fuchsia-400/50 text-fuchsia-200 text-xs font-medium flex items-center justify-between animate-pulse shrink-0">
              <span>
                {snapStage === 'scalebar_start' &&
                  '📏 Шаг 1/2: кликните ЛЕВЫЙ конец масштабной линейки на карте'}
                {snapStage === 'scalebar_end' &&
                  '📏 Шаг 2/2: кликните ПРАВЫЙ конец линейки, затем введите её длину в метрах'}
                {snapStage === 'spot_start' &&
                  '🏁 Кликните любую точку на карте (КП / развилку), чтобы запустить все треки одновременно из этого места!'}
                {snapStage === 'leg_start' &&
                  '🧭 Шаг 1/2: Кликните НАЧАЛО перегона (КП А) на карте'}
                {snapStage === 'leg_end' &&
                  '🧭 Шаг 2/2: Теперь кликните КОНЕЦ перегона (КП Б) на карте'}
              </span>
              <button
                onClick={() => {
                  setSnapStage('idle');
                  setPickedFeatureLonLat(null);
                }}
                className="px-2 py-0.5 rounded bg-slate-900/80 text-slate-200 hover:text-white"
              >
                Отмена
              </button>
            </div>
          )}

          {/* Speed heatmap legend */}
          {speedHeatmap && (
            <div className="absolute bottom-4 left-3 z-10 px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[11px] flex items-center gap-2 shadow-lg">
              <span className="text-slate-400">Темп:</span>
              <span className="inline-block w-3 h-3 rounded-sm bg-rose-500" />
              {/* Thresholds match speedToColorHex: 2.7 m/s ≈ 6:10/км, 3.6 m/s ≈ 4:38/км */}
              <span>&gt;6:10/км</span>
              <span className="inline-block w-3 h-3 rounded-sm bg-amber-400 ml-1" />
              <span>4:38–6:10/км</span>
              <span className="inline-block w-3 h-3 rounded-sm bg-emerald-400 ml-1" />
              <span>&lt;4:38/км</span>
            </div>
          )}

          {/* MapLibre Canvas Container — strictly relative + overflow-hidden so canvas never escapes */}
          <div
            ref={mapContainerRef}
            className={`relative flex-1 w-full overflow-hidden ${
              snapStage !== 'idle'
                ? 'cursor-crosshair'
                : fitMapMode && dragMovesMap && event.map
                  ? 'cursor-move'
                  : ''
            }`}
          />
        </div>

        {/* Right sidebar: Participants, Route-Choice Leg Analysis, Livelox Speed Normalization */}
        <div className="lg:col-span-4 xl:col-span-3 flex flex-col border-l border-slate-800 bg-slate-900/80 overflow-hidden">
          <div className="p-3 border-b border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Участники ({event.participants.length})
              </span>
              <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium cursor-pointer transition">
                <Plus className="w-3.5 h-3.5" />
                {uploadingTrack ? 'Парсинг...' : 'Загрузить Garmin (FIT/GPX)'}
                <input
                  type="file"
                  multiple
                  accept=".gpx,.fit,.tcx"
                  className="hidden"
                  onChange={handleTrackUpload}
                />
              </label>
            </div>

            {uploadError && (
              <div className="p-2 rounded bg-rose-500/20 border border-rose-500/40 text-xs text-rose-300">
                {uploadError}
              </div>
            )}

            {/* Synchronization mode switch */}
            <div className="flex items-center justify-between bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
              <button
                onClick={() => toggleTimeMode('from_start')}
                className={`flex-1 py-1 rounded-md text-center transition ${
                  event.timeMode === 'from_start'
                    ? 'bg-slate-800 text-emerald-400 font-medium shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                С 1 места (00:00)
              </button>
              <button
                onClick={() => toggleTimeMode('real')}
                className={`flex-1 py-1 rounded-md text-center transition ${
                  event.timeMode === 'real'
                    ? 'bg-slate-800 text-emerald-400 font-medium shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Реальное время GPS
              </button>
            </div>

            {/* Common Start / Spot Launch / Leg Route-Choice Analysis buttons */}
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={() => {
                  setSnapStage((s) =>
                    s === 'spot_start' ? 'idle' : 'spot_start'
                  );
                  setPickedFeatureLonLat(null);
                }}
                className={`py-1.5 px-2 rounded-lg border text-[11px] font-medium transition flex items-center justify-center gap-1 ${
                  snapStage === 'spot_start'
                    ? 'bg-amber-500/25 border-amber-400 text-amber-200 animate-pulse'
                    : 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/30 text-emerald-300'
                }`}
                title="Кликнуть на любой КП или развилку на карте, чтобы запустить все треки одновременно из одной точки"
              >
                <Flag className="w-3.5 h-3.5 shrink-0" />
                Пуск с точки
              </button>

              <button
                onClick={() => {
                  if (snapStage === 'leg_start' || snapStage === 'leg_end') {
                    setSnapStage('idle');
                    setPickedFeatureLonLat(null);
                  } else {
                    setPickedFeatureLonLat(null);
                    setSnapStage('leg_start');
                  }
                }}
                className={`py-1.5 px-2 rounded-lg border text-[11px] font-medium transition flex items-center justify-center gap-1 ${
                  snapStage === 'leg_start' || snapStage === 'leg_end'
                    ? 'bg-fuchsia-500/30 border-fuchsia-400 text-fuchsia-200 animate-pulse'
                    : 'bg-fuchsia-500/15 hover:bg-fuchsia-500/25 border-fuchsia-500/30 text-fuchsia-300'
                }`}
                title="Выбрать 2 точки на карте (КП А → КП Б) для анализа вариантов пути и выравнивания скорости (как в Livelox)"
              >
                <Navigation className="w-3.5 h-3.5 shrink-0" />
                Перегон A → B
              </button>
            </div>

            {/* Livelox Speed Normalization Switch (orienteering route-choice tool) */}
            {isOrienteering && (
            <div className="bg-slate-950 p-1.5 rounded-lg border border-slate-800 space-y-1">
              <div className="flex items-center justify-between text-[10px] text-slate-400 px-1">
                <span className="flex items-center gap-1">
                  <Zap className="w-3 h-3 text-amber-400" />
                  Режим скорости (Livelox):
                </span>
                {(customStartSpot || selectedLeg) && (
                  <button
                    onClick={() => void resetToFullRaceStart()}
                    className="text-emerald-400 hover:underline"
                  >
                    Вся дистанция
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1 text-[11px]">
                <button
                  onClick={() => setSpeedNormMode('real')}
                  className={`py-1 rounded text-center transition ${
                    speedNormMode === 'real'
                      ? 'bg-emerald-600 text-white font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Реальная скорость GPS каждого участника"
                >
                  Реальная
                </button>
                <button
                  onClick={() => setSpeedNormMode('livelox_handicap')}
                  className={`py-1 rounded text-center transition ${
                    speedNormMode === 'livelox_handicap'
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Как в Livelox: выравнивает базовую физподготовку участников по их среднему темпу за гонку, чтобы понять какой вариант на перегоне (по прямой, по оврагу или вокруг по дороге) выгоднее!"
                >
                  ⚡ По силам
                </button>
                <button
                  onClick={() => setSpeedNormMode('equal_speed')}
                  className={`py-1 rounded text-center transition ${
                    speedNormMode === 'equal_speed'
                      ? 'bg-sky-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Одинаковая постоянная скорость движения по треку — показывает чистый проигрыш по длине пути при оббегании"
                >
                  📏 Равная
                </button>
              </div>
            </div>
            )}
            {!isOrienteering && (customStartSpot || selectedLeg) && (
              <button
                onClick={() => void resetToFullRaceStart()}
                className="w-full py-1 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-emerald-400 hover:underline"
              >
                ↺ Вся дистанция
              </button>
            )}
          </div>

          {/* Selected Leg Route-Choice Comparison Panel */}
          {legAnalysis && (
            <div className="p-3 border-b border-fuchsia-500/30 bg-fuchsia-950/20 space-y-2 text-xs shrink-0 max-h-56 overflow-y-auto">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-fuchsia-300">
                  🧭 Перегон A → B (по прямой {legAnalysis.straightDistM} м)
                </span>
                <button
                  onClick={() => void resetToFullRaceStart()}
                  className="text-[11px] text-slate-400 hover:text-white"
                >
                  ✕ Сбросить
                </button>
              </div>

              {legAnalysis.stats.map((st, idx) => {
                const bestLegSec =
                  legAnalysis.stats[0]?.legTimeSec ?? st.legTimeSec;
                const diffSec = st.legTimeSec - bestLegSec;
                return (
                  <div
                    key={st.participantId}
                    className="p-2 rounded-lg bg-slate-900/90 border border-slate-800 space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold flex items-center gap-1.5">
                        <span
                          className="w-2.5 h-2.5 rounded-full inline-block"
                          style={{ background: st.color }}
                        />
                        {st.name}
                      </span>
                      <span className="font-mono font-bold text-white">
                        {formatDuration(st.legTimeSec)}
                        {idx > 0 && (
                          <span className="text-rose-400 ml-1">
                            +{diffSec}с
                          </span>
                        )}
                        <span
                          className="text-amber-300 ml-1.5 text-[11px]"
                          title="Выровненное время Livelox (при равной физподготовке)"
                        >
                          (⚡{formatDuration(st.normalizedLegTimeSec)})
                        </span>
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center justify-between text-[11px] text-slate-300 gap-1">
                      <span>
                        Путь: <strong>{st.routeDistM} м</strong> (
                        <span
                          className={
                            st.detourPct > 25
                              ? 'text-amber-300'
                              : 'text-emerald-300'
                          }
                        >
                          {st.detourPct >= 0
                            ? `+${st.detourPct}%`
                            : `${st.detourPct}%`}
                        </span>
                        )
                      </span>
                      <span>
                        Темп: <strong>{formatPaceMinKm(st.avgSpeedMs)}</strong>{' '}
                        (
                        <span
                          className={
                            st.paceIndexPct >= 0
                              ? 'text-emerald-400'
                              : 'text-rose-400'
                          }
                          title="Сравнение темпа на этом перегоне со своим средним темпом по всей дистанции"
                        >
                          {st.paceIndexPct >= 0
                            ? `+${st.paceIndexPct}% к сред.`
                            : `${st.paceIndexPct}% к сред.`}
                        </span>
                        )
                      </span>
                      {(st.eleGainM > 0 || st.eleLossM > 0) && (
                        <span className="text-slate-400 font-mono">
                          ↑+{st.eleGainM}м ↓-{st.eleLossM}м
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Live leaderboard cards */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
            {leaderboard.map(
              ({ participant: p, state, rank, gapMeters }) => (
                <div
                  key={p.id}
                  className={`p-3 rounded-xl border transition ${
                    p.visible
                      ? 'bg-slate-900 border-slate-800'
                      : 'bg-slate-950/50 border-slate-900 opacity-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-bold text-slate-500">
                        #{rank}
                      </span>
                      <input
                        type="color"
                        value={p.color}
                        onChange={(e) =>
                          updateParticipant(p.id, { color: e.target.value })
                        }
                        className="w-4 h-4 rounded cursor-pointer bg-transparent border-0"
                        title="Изменить цвет трека"
                      />
                      <span className="text-sm font-semibold text-slate-100 truncate">
                        {p.name}
                      </span>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        onClick={() =>
                          updateParticipant(p.id, { visible: !p.visible })
                        }
                        className="p-1 text-slate-400 hover:text-white"
                        title={p.visible ? 'Скрыть трек' : 'Показать трек'}
                      >
                        {p.visible ? (
                          <Eye className="w-3.5 h-3.5" />
                        ) : (
                          <EyeOff className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        onClick={() => deleteParticipant(p.id)}
                        className="p-1 text-slate-500 hover:text-rose-400"
                        title="Удалить участника"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {state && (
                    <div className="grid grid-cols-3 gap-2 text-xs bg-slate-950/70 p-2 rounded-lg border border-slate-800/80">
                      <div>
                        <div className="text-[10px] text-slate-400 flex items-center gap-1">
                          <Gauge className="w-3 h-3 text-emerald-400" />
                          Темп / Скор.
                        </div>
                        <div className="font-mono font-semibold text-slate-100">
                          {formatPaceMinKm(state.speedMs)}
                        </div>
                        <div className="text-[10px] font-mono text-slate-400">
                          {(state.speedMs * 3.6).toFixed(1)} км/ч
                        </div>
                      </div>

                      <div>
                        <div className="text-[10px] text-slate-400 flex items-center gap-1">
                          <Activity className="w-3 h-3 text-sky-400" />
                          Дистанция
                        </div>
                        <div className="font-mono font-semibold text-slate-100">
                          {(state.distM / 1000).toFixed(2)} км
                        </div>
                        <div className="text-[10px] font-mono text-amber-400">
                          {rank === 1 ? 'Лидер' : `-${gapMeters} м`}
                        </div>
                      </div>

                      <div>
                        <div className="text-[10px] text-slate-400 flex items-center gap-1">
                          <Heart className="w-3 h-3 text-rose-400" />
                          Пульс / Выс.
                        </div>
                        <div className="font-mono font-semibold text-slate-100">
                          {state.hr ? `${state.hr} уд/м` : '—'}
                        </div>
                        <div className="text-[10px] font-mono text-slate-400">
                          {state.ele ? `${Math.round(state.ele)} м` : '—'}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Сдвиг: {p.offsetSec > 0 ? `+${p.offsetSec}` : p.offsetSec}с (старт: {formatDuration(p.trimStartSec)})
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() =>
                          updateParticipant(p.id, {
                            offsetSec: p.offsetSec - 5,
                          })
                        }
                        className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                      >
                        -5с
                      </button>
                      <button
                        onClick={() =>
                          updateParticipant(p.id, { offsetSec: 0 })
                        }
                        className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400"
                      >
                        0
                      </button>
                      <button
                        onClick={() =>
                          updateParticipant(p.id, {
                            offsetSec: p.offsetSec + 5,
                          })
                        }
                        className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                      >
                        +5с
                      </button>
                    </div>
                  </div>
                </div>
              )
            )}
          </div>

          <div className="h-36 border-t border-slate-800 bg-slate-950 p-3 flex flex-col">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span>График скорости участников (км/ч)</span>
              <span className="font-mono text-emerald-400">
                t = {formatDuration(raceTimeSec)}
              </span>
            </div>
            <SpeedComparisonChart
              participants={event.participants}
              currentTimeSec={raceTimeSec}
              totalDurationSec={totalDurationSec}
              timeMode={event.timeMode}
              eventEpochZeroMs={eventEpochZeroMs}
              speedNormMode={speedNormMode}
              referenceSpeedMs={groupReferenceSpeedMs}
              onSeek={(sec) => setRaceTimeSec(sec)}
            />
          </div>
        </div>
      </div>

      {/* Bottom Playback Transport Bar */}
      <div className="px-4 py-3 bg-slate-900 border-t border-slate-800 flex flex-wrap items-center gap-4 shrink-0 z-10">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsPlaying((p) => !p)}
            className="w-10 h-10 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 flex items-center justify-center shadow-lg transition"
            title={isPlaying ? 'Пауза' : 'Старт анимации'}
          >
            {isPlaying ? (
              <Pause className="w-5 h-5 fill-current" />
            ) : (
              <Play className="w-5 h-5 fill-current ml-0.5" />
            )}
          </button>

          <button
            onClick={() => {
              setIsPlaying(false);
              setRaceTimeSec(0);
            }}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
            title="В начало (00:00)"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>

        <div className="font-mono text-sm min-w-[115px]">
          <span className="text-emerald-400 font-bold">
            {formatDuration(raceTimeSec)}
          </span>
          <span className="text-slate-500">
            {' '}
            / {formatDuration(totalDurationSec)}
          </span>
        </div>

        <div className="flex-1 flex items-center">
          <input
            type="range"
            min={0}
            max={totalDurationSec}
            step={0.5}
            value={raceTimeSec}
            onChange={(e) => setRaceTimeSec(parseFloat(e.target.value))}
            className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
          />
        </div>

        <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
          {SPEED_OPTIONS.map((spd) => (
            <button
              key={spd}
              onClick={() => setPlaybackRate(spd)}
              className={`px-2 py-1 rounded-lg font-mono transition ${
                playbackRate === spd
                  ? 'bg-emerald-600 text-white font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {spd}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

function fitMapToTracksOrMap(map: maplibregl.Map, event: RaceEvent) {
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

function buildCommonStartGeoJson(
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

function buildGhostTracksGeoJson(
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

function speedToColorHex(speedMs: number): string {
  if (speedMs < 2.7) return '#f43f5e';
  if (speedMs < 3.6) return '#f59e0b';
  return '#10b981';
}

function buildActiveTailsGeoJson(
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
    const windowPts = p.points.filter(
      (pt) => pt.t >= tailStartT && pt.t <= tailEndT
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

const SpeedComparisonChart: React.FC<{
  participants: ParticipantTrack[];
  currentTimeSec: number;
  totalDurationSec: number;
  timeMode: TimeMode;
  eventEpochZeroMs: number;
  speedNormMode: SpeedNormMode;
  referenceSpeedMs: number;
  onSeek: (sec: number) => void;
}> = ({
  participants,
  currentTimeSec,
  totalDurationSec,
  timeMode,
  eventEpochZeroMs,
  speedNormMode,
  referenceSpeedMs,
  onSeek,
}) => {
  const width = 320;
  const height = 84;
  const maxKmh = 22;

  const cursorX =
    totalDurationSec > 0
      ? Math.min(width, Math.max(0, (currentTimeSec / totalDurationSec) * width))
      : 0;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full flex-1 bg-slate-900/60 rounded-lg border border-slate-800/80 cursor-pointer overflow-visible"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const rel = Math.max(
          0,
          Math.min(1, (e.clientX - rect.left) / rect.width)
        );
        onSeek(rel * totalDurationSec);
      }}
    >
      <line
        x1={0}
        y1={height / 2}
        x2={width}
        y2={height / 2}
        stroke="#1e293b"
        strokeDasharray="3 3"
      />

      {participants
        .filter((p) => p.visible && p.points.length >= 2)
        .map((p) => {
          const step = Math.max(1, Math.floor(p.points.length / 80));
          const pts: string[] = [];
          for (let i = 0; i < p.points.length; i += step) {
            const pt = p.points[i];
            if (pt.t < p.trimStartSec || pt.t > p.trimEndSec) continue;
            // Same race clock as the map replay, in every time/speed mode
            const activeT = raceTimeOfTrackPoint(
              p,
              pt,
              timeMode,
              eventEpochZeroMs,
              speedNormMode,
              referenceSpeedMs
            );
            if (activeT < 0 || activeT > totalDurationSec) continue;
            const x = (activeT / totalDurationSec) * width;
            const kmh = Math.min(maxKmh, pt.speedMs * 3.6);
            const y = height - (kmh / maxKmh) * (height - 8) - 4;
            pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
          }
          return (
            <polyline
              key={p.id}
              fill="none"
              stroke={p.color}
              strokeWidth={1.6}
              strokeOpacity={0.85}
              points={pts.join(' ')}
            />
          );
        })}

      <line
        x1={cursorX}
        y1={0}
        x2={cursorX}
        y2={height}
        stroke="#10b981"
        strokeWidth={1.5}
      />
    </svg>
  );
};
