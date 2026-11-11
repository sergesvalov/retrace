import React, { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  Activity,
  Check,
  Clock,
  Eye,
  EyeOff,
  Flag,
  Flame,
  Gauge,
  Heart,
  ImagePlus,
  Layers,
  LocateFixed,
  Move,
  Navigation,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Zap,
} from 'lucide-react';
import {
  buildScaledOrientedMatrix,
  groundMetersPerPixelFromPrint,
  groundMetersPerPixelFromScaleBar,
  lonLatToMercator,
  lonLatToPixel,
  matrixBounds,
  translateMatrixCenterTo,
  type LonLatBounds,
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
  type CourseControl,
  type EventKind,
  type MapImageKind,
  type MapOverlayMeta,
  type ParticipantTrack,
  type RaceEvent,
  type TimeMode,
} from '../../shared/types.js';
import { magneticDeclinationDeg } from '../../shared/declination.js';
import {
  fromWireParticipant,
  mergeLiteEvent,
  type LiteEvent,
} from '../../shared/pointsCodec.js';
import {
  computeSplits,
  controlLabels,
  fitMapToCourse,
  controlsLonLat,
  correctTrackToControls,
} from '../../shared/course.js';
import { readImageDpi } from '../imageDpi.js';
import { useCourseOverlay } from './useCourseOverlay.js';
import { SplitsPanel } from './SplitsPanel.js';
// Map fitting UI is only needed for orienteering maps: loaded on first use
const FitPanel = React.lazy(() =>
  import('./FitPanel.js').then((m) => ({ default: m.FitPanel }))
);

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
  // `raceTimeSec` drives the panels and is refreshed a few times a second while playing;
  // the exact clock lives in `raceTimeRef` and moves the map every animation frame
  const [raceTimeSec, setRaceTimeSec] = useState<number>(0);
  const raceTimeRef = useRef<number>(0);
  /** Jump the clock (seek, reset, leg start): exact clock and panels together */
  const seekTo = (t: number) => {
    raceTimeRef.current = t;
    setRaceTimeSec(t);
  };
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
  const [dropActive, setDropActive] = useState<boolean>(false);
  const [autoFitInfo, setAutoFitInfo] = useState<{ ok: boolean; text: string } | null>(null);
  // Fully automatic georeferencing (circles on the scan ↔ tracks)
  const [autoGeorefState, setAutoGeorefState] = useState<{
    busy: boolean;
    ok: boolean | null;
    text: string;
  } | null>(null);
  const autoGeorefRunningRef = useRef(false);

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
    | 'pin_map'
    | 'pin_base'
  >('idle');
  // Landmark pin being placed: the scan pixel clicked first, then the same place on the base map
  const [pinDraftPx, setPinDraftPx] = useState<[number, number] | null>(null);
  const [pickedFeatureLonLat, setPickedFeatureLonLat] = useState<
    [number, number] | null
  >(null);

  const [customStartSpot, setCustomStartSpot] = useState<
    [number, number] | null
  >(null);
  const [selectedLeg, setSelectedLeg] = useState<{
    startLonLat: [number, number];
    endLonLat: [number, number];
    /** Punch indices from the splits, when the leg was picked from the course */
    knownPassages?: Record<string, { startIdx: number; endIdx: number }>;
    /** Leg index in the course (0 = start → 1st control) */
    courseLegIdx?: number;
  } | null>(null);

  // Course editing: clicks on the map place controls (start → 1, 2, … → finish)
  const [courseEdit, setCourseEdit] = useState<boolean>(false);
  const [nextIsFinish, setNextIsFinish] = useState<boolean>(false);
  // Start/finish are placed by hand (tracks are switched on late / off late)
  const [nextIsStart, setNextIsStart] = useState<boolean>(false);
  // Adjustment of the tracks onto the punched controls
  const [trackCorrection, setTrackCorrection] = useState<boolean>(true);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapReadyRef = useRef<boolean>(false);
  // Bumped on every MapLibre 'load': lets overlays declared before the map effect redraw
  const [mapLoadCount, setMapLoadCount] = useState<number>(0);
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

  /**
   * Change responses carry the event without track points (they never change after upload):
   * merge them into the event we hold, so nothing re-downloads megabytes per click.
   */
  function applyServerEvent(lite: LiteEvent): RaceEvent {
    const merged = mergeLiteEvent(eventRef.current, lite);
    eventRef.current = merged;
    onEventUpdated(merged);
    return merged;
  }
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
    seekTo(0);
    setSnapStage('idle');
    setPickedFeatureLonLat(null);
    setUploadError(null);
    setCourseEdit(false);
    setNextIsFinish(false);
    setAutoFitInfo(null);
    setAutoGeorefState(null);
  }, [event.id]);

  // Each event kind starts on its own default base map (also when the kind is switched)
  useEffect(() => {
    setBaseLayer(defaultBaseLayerFor(kind));
    if (kind === 'run') {
      setSpeedNormMode('real');
      onToggleFitMap?.(false);
      setCourseEdit(false);
    }
  }, [event.id, kind]);

  // Dragging the map and placing controls both use the left mouse button: one at a time
  useEffect(() => {
    if (fitMapMode) setCourseEdit(false);
  }, [fitMapMode]);
  useEffect(() => {
    if (courseEdit) {
      onToggleFitMap?.(false);
      setSnapStage('idle');
    } else {
      setNextIsFinish(false);
      setNextIsStart(false);
    }
  }, [courseEdit]);
  useEffect(() => {
    if (!event.map) setCourseEdit(false);
  }, [Boolean(event.map)]);

  // Group mean speed (m/s) for the speed normalisation modes
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

  // ---- Course: controls on the map → punches → splits → tracks pulled onto the controls ----
  const courseControls = useMemo<CourseControl[]>(
    () => (isOrienteering ? event.map?.controls ?? [] : []),
    [isOrienteering, event.map?.controls]
  );
  const courseLL = useMemo<[number, number][]>(
    () =>
      event.map?.matrix && courseControls.length > 0
        ? controlsLonLat(courseControls, event.map.matrix)
        : [],
    [courseControls, event.map?.matrix]
  );
  const splits = useMemo(
    () =>
      event.map?.matrix && courseControls.length >= 2
        ? computeSplits(event.participants, courseControls, event.map.matrix)
        : [],
    [event.participants, courseControls, event.map?.matrix]
  );
  // Tracks as drawn and replayed: with the adjustment to the controls when it is on
  const displayParticipants = useMemo<ParticipantTrack[]>(() => {
    if (!trackCorrection || splits.length === 0) return event.participants;
    const byId = new Map(splits.map((s) => [s.participantId, s]));
    return event.participants.map((p) => {
      const s = byId.get(p.id);
      return s
        ? { ...p, points: correctTrackToControls(p.points, s.passages, courseLL) }
        : p;
    });
  }, [event.participants, splits, courseLL, trackCorrection]);
  const displayParticipantsRef = useRef(displayParticipants);
  displayParticipantsRef.current = displayParticipants;
  const courseLabels = useMemo(() => controlLabels(courseControls), [courseControls]);

  const { syncToMatrix: syncCourseToMatrix } = useCourseOverlay({
    mapRef,
    mapReadyRef,
    mapLoadCount,
    controls: courseControls,
    matrix: event.map?.matrix,
    visible: isOrienteering && Boolean(event.map),
    editable: courseEdit,
    onMove: (id, px, py) =>
      void saveCourse(
        courseControlsRef.current.map((c) => (c.id === id ? { ...c, px, py } : c))
      ),
    onRemove: (id) =>
      void saveCourse(courseControlsRef.current.filter((c) => c.id !== id)),
  });
  const courseControlsRef = useRef(courseControls);
  courseControlsRef.current = courseControls;

  async function saveCourse(controls: CourseControl[]) {
    const eventId = eventRef.current.id;
    const res = await fetch(`/api/events/${eventId}/course`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ controls }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setUploadError(data.error || 'Не удалось сохранить КП');
      return;
    }
    if (eventRef.current.id === eventId) applyServerEvent(data.event);
  }

  /** Map click while editing the course: start first, then controls in order, finish last */
  function addControlAt(lngLat: [number, number]) {
    const m = liveMatrixRef.current ?? eventRef.current.map?.matrix;
    if (!m) return;
    const px = lonLatToPixel(m, lngLat[0], lngLat[1]);
    if (!px) return;
    const current = courseControlsRef.current;
    const newControl = (k: CourseControl['kind']): CourseControl => ({
      id: `${k}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: k,
      px: px[0],
      py: px[1],
    });
    let next: CourseControl[];
    if (nextIsStart) {
      // one start, always first
      next = [newControl('start'), ...current.filter((c) => c.kind !== 'start')];
      setNextIsStart(false);
    } else if (current.length === 0) {
      next = [newControl('start')];
    } else if (nextIsFinish) {
      next = [...current.filter((c) => c.kind !== 'finish'), newControl('finish')];
      setNextIsFinish(false);
      setNextIsStart(false);
    } else {
      const finish = current.find((c) => c.kind === 'finish');
      const rest = current.filter((c) => c.kind !== 'finish');
      next = [...rest, newControl('control'), ...(finish ? [finish] : [])];
    }
    void saveCourse(next);
  }

  /** Give everyone the punches of one leg (or the whole course) as their start/finish */
  async function applyCourseTrims(fromIdx: number, toIdx: number) {
    const trims = splits
      .filter((s) => s.passages[fromIdx]?.detected && s.passages[toIdx]?.detected)
      .map((s) => ({
        participantId: s.participantId,
        trimStartSec: Math.floor(s.passages[fromIdx].t),
        trimEndSec: Math.ceil(s.passages[toIdx].t),
      }));
    if (trims.length === 0) return;
    const res = await fetch(`/api/events/${event.id}/trims`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trims }),
    });
    if (res.ok) {
      const data = await res.json();
      applyServerEvent(data.event);
      seekTo(0);
      setIsPlaying(false);
    }
  }

  function selectCourseLeg(k: number) {
    if (courseLL.length < k + 2) return;
    const knownPassages: Record<string, { startIdx: number; endIdx: number }> = {};
    for (const s of splits) {
      if (s.legTimes[k] !== null) {
        knownPassages[s.participantId] = {
          startIdx: s.passages[k].idx,
          endIdx: s.passages[k + 1].idx,
        };
      }
    }
    setCustomStartSpot(null);
    setSelectedLeg({
      startLonLat: courseLL[k],
      endLonLat: courseLL[k + 1],
      knownPassages,
      courseLegIdx: k,
    });
    void applyCourseTrims(k, k + 1);
  }

  /**
   * Whole course for everyone: from the first to the last control that every runner of this
   * course punched — someone may have started the watch after control 1 or stopped it before
   * the finish. Runners of another course (they punch few of these controls) are left as is.
   */
  function selectWholeCourse() {
    setSelectedLeg(null);
    setCustomStartSpot(null);
    const n = courseControls.length;
    const onCourse = splits.filter(
      (s) => s.passages.filter((p) => p.detected).length >= n / 2
    );
    let from = 0;
    while (from < n - 1 && onCourse.some((s) => !s.passages[from].detected)) from++;
    let to = n - 1;
    while (to > from && onCourse.some((s) => !s.passages[to].detected)) to--;
    void applyCourseTrims(from, to);
  }

  // Compute detailed route-choice analytics when a leg (A -> B) is selected
  const legAnalysis = useMemo(() => {
    if (!selectedLeg) return null;
    return analyzeLegBetweenSpots(
      displayParticipants,
      selectedLeg.startLonLat,
      selectedLeg.endLonLat,
      selectedLeg.knownPassages
    );
  }, [displayParticipants, selectedLeg]);

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
    seekTo(Math.min(raceTimeRef.current, totalDurationSec));
  }, [totalDurationSec]);

  // Animation loop via requestAnimationFrame
  useEffect(() => {
    if (!isPlaying) {
      lastFrameMsRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    let lastUiMs = 0;
    const tick = (nowMs: number) => {
      if (lastFrameMsRef.current !== null) {
        const dtSec = ((nowMs - lastFrameMsRef.current) / 1000) * playbackRate;
        const next = Math.min(totalDurationSec, raceTimeRef.current + dtSec);
        raceTimeRef.current = next;
        drawFrameRef.current(next);
        if (next >= totalDurationSec) {
          setRaceTimeSec(next);
          setIsPlaying(false);
          return;
        }
        // Panels (clock, slider, leaderboard, chart) don't need 60 fps
        if (nowMs - lastUiMs > 200) {
          lastUiMs = nowMs;
          setRaceTimeSec(next);
        }
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
        data: buildGhostTracksGeoJson(displayParticipantsRef.current),
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
        data: buildCommonStartGeoJson(displayParticipantsRef.current),
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
      setMapLoadCount((c) => c + 1);
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
        // A run/hike keeps any old map hidden: the base map is the map there.
        // While picking a pin's base-map point the scan is hidden so the base map is visible.
        isOrienteering && snapStage !== 'pin_base' ? mapOpacity : 0
      );
    }
  }, [osmOpacity, mapOpacity, baseLayer, isOrienteering, snapStage]);

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
      // Controls are drawn on the map, so they travel with it
      syncCourseToMatrix(nextMatrix);
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
    syncCourseToMatrix(res.matrix);

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
        applyServerEvent(data.event);
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
    syncCourseToMatrix(next);
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

  /**
   * Semi-automatic georeferencing: move/scale/rotate the scan so the course controls drawn on
   * it coincide with where the runners punched them (see fitMapToCourse).
   */
  function autoFitMapToCourse() {
    const map = mapRef.current;
    const meta = eventRef.current.map;
    const current = liveMatrixRef.current ?? meta?.matrix;
    if (!map || !meta || !current) return;
    // Landmark pins (if any) take part in the fit as fixed pairs
    const fit = fitMapToCourse(
      eventRef.current.participants,
      courseControlsRef.current,
      current,
      meta.gcps ?? []
    );
    if (!fit) {
      setAutoFitInfo({
        ok: false,
        text: 'Не получилось: ни один трек не прошёл рядом с КП. Подвиньте карту ближе (старт на ⚓) и повторите.',
      });
      return;
    }
    liveMatrixRef.current = fit.matrix;
    (map.getSource('custom-map') as maplibregl.ImageSource | undefined)?.setCoordinates(
      matrixToCorners(fit.matrix, meta.width, meta.height)
    );
    syncCourseToMatrix(fit.matrix);
    resetRelativeSliders();
    void saveMatrixToServer(fit.matrix);

    const missed = fit.residualsM.filter((r) => r === null).length;
    const acc = Math.round(fit.rmsM * 10) / 10;
    const good = fit.rmsM <= 15 && fit.mode === 'similarity';
    setAutoFitInfo({
      ok: good,
      text:
        (fit.mode === 'shift'
          ? `Сдвинула по ${fit.usedControls} КП (для масштаба и поворота нужно 3+ отмеченных КП). `
          : `Подогнала по ${fit.usedControls} КП: точность ±${acc} м. `) +
        (missed ? `${missed} КП никто не прошёл рядом — не учтены. ` : '') +
        (fit.rmsM > 15
          ? 'Точность низкая: проверьте, что КП отмечены по порядку и в центрах кружков.'
          : ''),
    });
  }

  /**
   * Fully automatic georeferencing: find the course circles on the scan and the placement
   * where the runners pass through them. `quiet` = triggered by an upload: only a confident
   * result is applied and a failure is reported without fuss.
   */
  async function runAutoGeoref(quiet = false) {
    const evt = eventRef.current;
    const meta = evt.map;
    if (!meta || autoGeorefRunningRef.current) return;
    if (evt.participants.length === 0) {
      if (!quiet) {
        setAutoGeorefState({ busy: false, ok: false, text: 'Сначала загрузите треки участников.' });
      }
      return;
    }
    autoGeorefRunningRef.current = true;
    setAutoGeorefState({ busy: true, ok: null, text: 'Ищу кружки КП на скане…' });
    // let the status paint before the CPU-heavy part
    await new Promise((r) => setTimeout(r, 30));
    try {
      // Loaded on first use (keeps the main bundle small)
      const [{ detectCirclesOnScan }, { autoGeoref }] = await Promise.all([
        import('../detectCircles.js'),
        import('../../shared/autoGeoref.js'),
      ]);
      const scan = await detectCirclesOnScan(meta.imageUrl, meta.width, meta.scanDpi);
      const circles = scan.circles;
      if (circles.length < 3) {
        setAutoGeorefState({
          busy: false,
          ok: false,
          text: `На скане не нашлось кружков дистанции (найдено: ${circles.length}). Нужна карта с фиолетовой надпечаткой КП — иначе подгоните по приметным местам.`,
        });
        return;
      }
      setAutoGeorefState({
        busy: true,
        ok: null,
        text: `Найдено кружков: ${circles.length}. Сопоставляю с треками…`,
      });
      await new Promise((r) => setTimeout(r, 30));

      const hint =
        meta.printScale && meta.scanDpi
          ? groundMetersPerPixelFromPrint(meta.printScale, meta.scanDpi)
          : null;
      const res = autoGeoref({
        circles,
        participants: eventRef.current.participants,
        declinationDeg: meta.declinationDeg ?? autoDeclinationDeg,
        groundMPerPxHint: hint,
      });
      const matched = res?.matchedCircles.length ?? 0;
      const confident =
        res !== null &&
        matched >= (quiet ? 4 : 3) &&
        res.rmsM <= 15 &&
        (!quiet || matched >= Math.min(circles.length, 0.5 * circles.length + 1));
      if (!res || !confident) {
        setAutoGeorefState({
          busy: false,
          ok: false,
          text: `Не получилось уверенно сопоставить ${circles.length} кружков с треками${
            res ? ` (совпало ${matched})` : ''
          }. Подвиньте карту примерно на место и используйте «🎯 по КП» или точки привязки.`,
        });
        return;
      }
      if (eventRef.current.id !== evt.id) return;

      // Apply: placement first, then (if empty) the course built from the circles
      const map = mapRef.current;
      liveMatrixRef.current = res.matrix;
      (map?.getSource('custom-map') as maplibregl.ImageSource | undefined)?.setCoordinates(
        matrixToCorners(res.matrix, meta.width, meta.height)
      );
      syncCourseToMatrix(res.matrix);
      resetRelativeSliders();
      setAnchorLonLat(null);
      await saveMatrixToServer(res.matrix, {
        imageKind: 'orienteering',
        declinationDeg: meta.declinationDeg ?? autoDeclinationDeg,
        ...(res.impliedPrintScale ? { printScale: res.impliedPrintScale } : {}),
      });
      const courseCreated = courseControlsRef.current.length === 0;
      if (courseCreated) await saveCourse(res.controls);

      setAutoGeorefState({
        busy: false,
        ok: true,
        text:
          `🪄 Готово: совпало ${matched} из ${circles.length} кружков, точность ±${
            Math.round(res.rmsM * 10) / 10
          } м${res.impliedPrintScale ? `, масштаб ≈1:${res.impliedPrintScale}` : ''}.` +
          (courseCreated
            ? ' КП отмечены автоматически (порядок — по трекам). Старт и финиш поставьте вручную: ◎ КП → ▲ старт / ◎ финиш.'
            : ''),
      });
    } catch (err) {
      setAutoGeorefState({
        busy: false,
        ok: false,
        text: err instanceof Error ? err.message : 'Автоподгонка не удалась',
      });
    } finally {
      autoGeorefRunningRef.current = false;
    }
  }

  /** Add / remove landmark pins; the server re-solves the placement from all pins */
  async function sendPinChange(body: {
    addPin?: { px: number; py: number; lon: number; lat: number };
    removePinId?: string;
    clearPins?: boolean;
  }) {
    const eventId = eventRef.current.id;
    const res = await fetch(`/api/events/${eventId}/map-nudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setUploadError(data.error || 'Не удалось сохранить точку привязки');
      return;
    }
    if (eventRef.current.id !== eventId) return;
    resetRelativeSliders();
    setAnchorLonLat(null);
    applyServerEvent(data.event);
  }

  /** What the user is looking at: where a map without tracks should appear */
  function currentViewBounds(): LonLatBounds | null {
    const b = mapRef.current?.getBounds();
    if (!b) return null;
    return {
      minLon: b.getWest(),
      maxLon: b.getEast(),
      minLat: Math.max(-85, b.getSouth()),
      maxLat: Math.min(85, b.getNorth()),
    };
  }

  /** Fly to the uploaded map wherever it is */
  function showUploadedMap() {
    const map = mapRef.current;
    const m = eventRef.current.map;
    if (!map || !m?.matrix) return;
    const b = matrixBounds(liveMatrixRef.current ?? m.matrix, m.width, m.height);
    map.fitBounds(
      [
        [b.minLon, b.minLat],
        [b.maxLon, b.maxLat],
      ],
      { padding: 40, duration: 600 }
    );
  }

  /** Bring a map that ended up elsewhere into the middle of the screen (scale/rotation kept) */
  function moveMapToViewCenter() {
    const map = mapRef.current;
    const meta = eventRef.current.map;
    const current = liveMatrixRef.current ?? meta?.matrix;
    if (!map || !meta || !current) return;
    const c = map.getCenter();
    const next = translateMatrixCenterTo(current, meta.width, meta.height, c.lng, c.lat);
    liveMatrixRef.current = next;
    (map.getSource('custom-map') as maplibregl.ImageSource | undefined)?.setCoordinates(
      matrixToCorners(next, meta.width, meta.height)
    );
    syncCourseToMatrix(next);
    setAnchorLonLat(null);
    void saveMatrixToServer(next);
  }

  async function handleResetMapAutoFit() {
    const res = await fetch(`/api/events/${event.id}/map-nudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetAutoFit: true, view: currentViewBounds() }),
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
      applyServerEvent(data.event);
    }
  }

  // Landmark pins: where on the ground each pinned scan point belongs (shown while fitting)
  const pinMarkersRef = useRef<maplibregl.Marker[]>([]);
  useEffect(() => {
    const map = mapRef.current;
    for (const mk of pinMarkersRef.current) mk.remove();
    pinMarkersRef.current = [];
    if (!map || !mapReadyRef.current || !fitMapMode || !isOrienteering) return;
    (event.map?.gcps ?? []).forEach((g, i) => {
      const el = document.createElement('div');
      el.className =
        'w-5 h-5 rounded-full bg-orange-500 border-2 border-white text-[10px] font-bold text-white flex items-center justify-center shadow pointer-events-none';
      el.textContent = String(i + 1);
      pinMarkersRef.current.push(
        new maplibregl.Marker({ element: el }).setLngLat([g.lon, g.lat]).addTo(map)
      );
    });
    return () => {
      for (const mk of pinMarkersRef.current) mk.remove();
      pinMarkersRef.current = [];
    };
  }, [event.map?.gcps, fitMapMode, isOrienteering, mapLoadCount]);

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
      src.setData(buildGhostTracksGeoJson(displayParticipants));
    }
    const startSrc = map.getSource('common-start') as
      | maplibregl.GeoJSONSource
      | undefined;
    if (startSrc) {
      startSrc.setData(buildCommonStartGeoJson(displayParticipants));
    }
  }, [displayParticipants]);

  // Compute live interpolated states for each participant at `raceTimeSec`
  const runnerStates = useMemo(() => {
    return displayParticipants.map((p) => ({
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
    displayParticipants,
    raceTimeSec,
    event.timeMode,
    eventEpochZeroMs,
    speedNormMode,
    groupReferenceSpeedMs,
  ]);

  // Runner markers + tails for clock time `t`. Called by the animation loop every frame
  // (through a ref, so it always sees the latest data) and when inputs change while paused.
  const drawFrameRef = useRef<(t: number) => void>(() => {});
  drawFrameRef.current = (t: number) => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    const states = displayParticipants.map((p) => ({
      participant: p,
      state: interpolateTrackAt(
        p,
        t,
        event.timeMode,
        eventEpochZeroMs,
        speedNormMode,
        groupReferenceSpeedMs
      ),
    }));
    drawDynamicElements(map, t, states);
  };

  function drawDynamicElements(
    map: maplibregl.Map,
    raceTimeSec: number,
    runnerStates: { participant: ParticipantTrack; state: ReturnType<typeof interpolateTrackAt> }[]
  ) {
    {
      const tailSrc = map.getSource('active-tails') as
        | maplibregl.GeoJSONSource
        | undefined;
      if (tailSrc) {
        tailSrc.setData(
          buildActiveTailsGeoJson(
            displayParticipants,
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
    }
  }

  // Redraw when something other than the running clock changes (or after a seek / map load)
  useEffect(() => {
    drawFrameRef.current(raceTimeRef.current);
  }, [
    raceTimeSec,
    tailLengthSec,
    speedHeatmap,
    speedNormMode,
    groupReferenceSpeedMs,
    displayParticipants,
    event.timeMode,
    eventEpochZeroMs,
    mapLoadCount,
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
      applyServerEvent(data.event);
      onToggleFitMap?.(false);
    }
  }

  async function handleTrackUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    await uploadTrackFiles(files);
  }

  async function uploadTrackFiles(files: File[]) {
    if (files.length === 0) return;
    setUploadingTrack(true);
    setUploadError(null);

    try {
      let latestEvent = event;
      for (const file of files) {
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
          // the response carries no track points except the new participant's (packed)
          latestEvent = mergeLiteEvent(latestEvent, data.event, [
            fromWireParticipant(data.participant),
          ]);
        }
      }
      eventRef.current = latestEvent;
      onEventUpdated(latestEvent);
      if (mapRef.current) {
        fitMapToTracksOrMap(mapRef.current, latestEvent);
      }
      // A scan nobody placed by hand yet: try to put it on the tracks automatically
      if (
        eventKindOf(latestEvent) === 'orienteering' &&
        latestEvent.map &&
        !latestEvent.map.manuallyPlaced &&
        latestEvent.participants.length > 0
      ) {
        eventRef.current = latestEvent;
        void runAutoGeoref(true);
      }
    } catch {
      setUploadError('Не удалось загрузить трек (нет связи с сервером)');
    } finally {
      setUploadingTrack(false);
    }
  }

  async function handleQuickScreenshotUpload(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await uploadMapFile(file);
  }

  /** Files dropped anywhere on the workspace: tracks by extension, an image as the map */
  async function handleDroppedFiles(files: File[]) {
    const tracks = files.filter((f) => /\.(gpx|fit|tcx)$/i.test(f.name));
    const image = files.find((f) => f.type.startsWith('image/'));
    const ignored = files.length - tracks.length - (image ? 1 : 0);
    if (tracks.length > 0) await uploadTrackFiles(tracks);
    if (image) {
      if (isOrienteering) await uploadMapFile(image);
      else setUploadError('Карту можно добавить только в событие «Ориентирование»');
    }
    if (ignored > 0 && tracks.length === 0 && !image) {
      setUploadError('Поддерживаются треки .fit / .gpx / .tcx и картинки карты');
    }
  }

  async function uploadMapFile(file: File) {
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

      // Scanners store their resolution in the file: then only the print scale is left to type
      const dpi = await readImageDpi(file);

      const form = new FormData();
      form.append('width', String(dims.width));
      form.append('height', String(dims.height));
      if (dpi) form.append('dpi', String(dpi));
      // Without tracks the map is placed in the middle of the current screen
      const view = currentViewBounds();
      if (view) form.append('view', JSON.stringify(view));
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
        const merged = applyServerEvent(data.event);
        onToggleFitMap?.(true);
        if (merged.participants.length > 0) void runAutoGeoref(true);
      } else {
        const data = await res.json().catch(() => ({}));
        setUploadError(data.error || 'Не удалось загрузить карту');
      }
    } catch {
      setUploadError('Не удалось загрузить карту (нет связи с сервером)');
    } finally {
      setUploadingScreenshot(false);
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
      applyServerEvent(data.event);
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
      applyServerEvent(data.event);
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
      applyServerEvent(data.event);
      seekTo(0);
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

      if (courseEdit && snapStage === 'idle') {
        addControlAt([e.lngLat.lng, e.lngLat.lat]);
        return;
      }

      if (snapStage === 'pin_map') {
        const m = liveMatrixRef.current ?? eventRef.current.map?.matrix;
        const px = m ? lonLatToPixel(m, e.lngLat.lng, e.lngLat.lat) : null;
        if (!px) return;
        setPinDraftPx(px);
        setSnapStage('pin_base');
        return;
      }
      if (snapStage === 'pin_base' && pinDraftPx) {
        const [px, py] = pinDraftPx;
        setPinDraftPx(null);
        setSnapStage('idle');
        void sendPinChange({ addPin: { px, py, lon: e.lngLat.lng, lat: e.lngLat.lat } });
        return;
      }

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
    courseEdit,
    nextIsFinish,
    nextIsStart,
    pinDraftPx,
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
      applyServerEvent(data.event);
      seekTo(0);
    }
  }

  async function resetToFullRaceStart() {
    setSpeedNormMode('real');
    // With a course, "whole race" means start triangle → finish punches
    if (splits.length > 0 && courseControls.length >= 2) {
      selectWholeCourse();
      return;
    }
    setCustomStartSpot(null);
    setSelectedLeg(null);
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
    <div
      className="flex flex-col h-full bg-slate-950 text-slate-100 relative"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropActive(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        void handleDroppedFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {dropActive && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-emerald-950/70 border-4 border-dashed border-emerald-400 pointer-events-none">
          <div className="text-lg font-semibold text-emerald-100 text-center">
            Отпустите файлы
            <div className="text-sm font-normal text-emerald-200/80">
              треки .fit / .gpx / .tcx{isOrienteering ? ' и скан карты (картинка)' : ''}
            </div>
          </div>
        </div>
      )}
      {/* Main workspace: [Map] + [fixed-width right column] */}
      <div className="flex flex-1 min-h-0">
        {/* MAIN MAP PANE */}
        <div className="flex-1 min-w-0 flex flex-col relative overflow-hidden">
          {/* Docked Top Map Toolbar */}
          <div className="relative z-10 px-2 py-1.5 bg-slate-900 border-b border-slate-800 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs shrink-0">
            <div className="flex flex-wrap items-center gap-1.5">
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
                    {fitMapMode ? 'Подгонка…' : 'Подогнать'}
                  </button>

                  <button
                    onClick={showUploadedMap}
                    className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white transition"
                    title="Показать карту: перелететь к ней"
                  >
                    <LocateFixed className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={handleDeleteCurrentMap}
                    className="p-1 rounded-lg bg-slate-800 hover:bg-rose-900/60 border border-slate-700 hover:border-rose-500/50 text-slate-400 hover:text-rose-300 transition"
                    title="Удалить загруженную карту из этого мероприятия"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={() => setCourseEdit((v) => !v)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-medium border transition ${
                      courseEdit
                        ? 'bg-fuchsia-600 border-fuchsia-400 text-white shadow'
                        : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-fuchsia-300'
                    }`}
                    title="Отметить старт, КП и финиш на карте — получатся сплиты по перегонам"
                  >
                    ◎ КП
                    {courseControls.length > 0 && (
                      <span className="text-[10px] opacity-80">
                        ({courseControls.filter((c) => c.kind === 'control').length})
                      </span>
                    )}
                  </button>

                  <div className="flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-slate-300 hidden xl:inline">Карта</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={mapOpacity}
                      onChange={(e) => setMapOpacity(parseFloat(e.target.value))}
                      className="w-14 accent-emerald-500"
                      title="Прозрачность карты"
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
                <span className="text-slate-300 hidden xl:inline">Подложка</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={osmOpacity}
                  onChange={(e) => setOsmOpacity(parseFloat(e.target.value))}
                  className="w-14 accent-sky-500"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-slate-400" title="Длина следа за бегуном">
                Хвост
                <select
                  value={tailLengthSec}
                  onChange={(e) => setTailLengthSec(Number(e.target.value))}
                  className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-slate-200"
                >
                  {TAIL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

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

          {/* Course editing: click the map to place start → controls → finish */}
          {courseEdit && isOrienteering && event.map && (
            <div className="relative z-10 px-3 py-1.5 bg-fuchsia-950/80 border-b border-fuchsia-500/40 text-xs text-fuchsia-100 flex flex-wrap items-center justify-between gap-2 shrink-0">
              <span>
                {courseControls.length === 0 || nextIsStart
                  ? '▲ Кликните СТАРТ (треугольник) на карте'
                  : nextIsFinish
                    ? '◎ Кликните ФИНИШ на карте'
                    : `Кликните КП ${
                        courseControls.filter((c) => c.kind === 'control').length + 1
                      } по порядку. Маркеры можно перетаскивать, правый клик — удалить`}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => {
                    setNextIsStart((v) => !v);
                    setNextIsFinish(false);
                  }}
                  className={`px-2 py-0.5 rounded border transition ${
                    nextIsStart
                      ? 'bg-fuchsia-500 border-fuchsia-300 text-white'
                      : 'bg-slate-900 border-slate-700 text-fuchsia-200 hover:text-white'
                  }`}
                  title="Поставить или передвинуть старт (треугольник): он всегда первый"
                >
                  {courseControls.some((c) => c.kind === 'start') ? '▲ Переставить старт' : '▲ Следующий клик — старт'}
                </button>
                <button
                  onClick={() => {
                    setNextIsFinish((v) => !v);
                    setNextIsStart(false);
                  }}
                  disabled={courseControls.length === 0}
                  className={`px-2 py-0.5 rounded border transition disabled:opacity-40 ${
                    nextIsFinish
                      ? 'bg-fuchsia-500 border-fuchsia-300 text-white'
                      : 'bg-slate-900 border-slate-700 text-fuchsia-200 hover:text-white'
                  }`}
                >
                  ◎ Следующий клик — финиш
                </button>
                <button
                  onClick={() => void saveCourse(courseControls.slice(0, -1))}
                  disabled={courseControls.length === 0}
                  className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-200 hover:text-white disabled:opacity-40"
                >
                  ↶ Убрать последний
                </button>
                <button
                  onClick={() => {
                    if (window.confirm('Удалить все КП дистанции?')) void saveCourse([]);
                  }}
                  disabled={courseControls.length === 0}
                  className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-400 hover:text-rose-300 disabled:opacity-40"
                >
                  Очистить
                </button>
                {courseControls.length >= 3 && event.participants.length > 0 && (
                  <button
                    onClick={() => {
                      autoFitMapToCourse();
                      setCourseEdit(false);
                      onToggleFitMap?.(true);
                    }}
                    className="px-2 py-0.5 rounded bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-semibold"
                    title="Подогнать карту так, чтобы КП совпали с отметками участников"
                  >
                    🎯 Подогнать карту по КП
                  </button>
                )}
                <button
                  onClick={() => setCourseEdit(false)}
                  className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                >
                  <Check className="w-3.5 h-3.5" />
                  Готово
                </button>
              </div>
            </div>
          )}

          {/* Active Map Click Prompt Banner (for Spot Start, Leg Selection or Scale Bar) */}
          {snapStage !== 'idle' && (
            <div className="relative z-10 px-3 py-1.5 bg-fuchsia-600/25 border-b border-fuchsia-400/50 text-fuchsia-200 text-xs font-medium flex items-center justify-between animate-pulse shrink-0">
              <span>
                {snapStage === 'pin_map' &&
                  '📍 Шаг 1/2: кликните приметное место НА СКАНЕ (перекрёсток, угол здания или забора, мост)'}
                {snapStage === 'pin_base' &&
                  '📍 Шаг 2/2: скан скрыт — кликните то же место на подложке'}
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
                  setPinDraftPx(null);
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
              snapStage !== 'idle' || courseEdit
                ? 'cursor-crosshair'
                : fitMapMode && dragMovesMap && event.map
                  ? 'cursor-move'
                  : ''
            }`}
          />
        </div>

        {/* Right column (fixed width so its controls never get clipped):
            map fitting while fitting, otherwise participants, splits and analysis */}
        <div className="w-[340px] xl:w-[380px] shrink-0 flex flex-col border-l border-slate-800 bg-slate-900/80 overflow-hidden">
          {fitMapMode && isOrienteering && event.map ? (
            <>
              {uploadError && (
                <div className="m-3 mb-0 p-2 rounded bg-rose-500/20 border border-rose-500/40 text-xs text-rose-300">
                  {uploadError}
                </div>
              )}
              <React.Suspense
                fallback={<div className="p-3 text-xs text-slate-400">Загрузка…</div>}
              >
              <FitPanel
                hasTracks={event.participants.length > 0}
                onTrackFiles={handleTrackUpload}
                uploadingTrack={uploadingTrack}
                onDone={() => onToggleFitMap?.(false)}
                onShowMap={showUploadedMap}
                onMoveMapHere={moveMapToViewCenter}
                onResetPlacement={() => void handleResetMapAutoFit()}
                courseControlCount={courseControls.length}
                onEditCourse={() => setCourseEdit(true)}
                onAutoFitCourse={autoFitMapToCourse}
                autoFitInfo={autoFitInfo}
                autoGeorefState={autoGeorefState}
                onAutoGeoref={() => void runAutoGeoref(false)}
                pins={event.map?.gcps ?? []}
                pinStage={
                  snapStage === 'pin_map' || snapStage === 'pin_base' ? snapStage : null
                }
                onAddPin={() => {
                  setPickedFeatureLonLat(null);
                  setPinDraftPx(null);
                  setSnapStage('pin_map');
                }}
                onRemovePin={(id) => void sendPinChange({ removePinId: id })}
                onClearPins={() => void sendPinChange({ clearPins: true })}
                dragMovesMap={dragMovesMap}
                onToggleDragMovesMap={() => setDragMovesMap((v) => !v)}
                mapImageKind={mapImageKind}
                onMapImageKind={setMapImageKind}
                printScale={printScale}
                onPrintScale={setPrintScale}
                scanDpi={scanDpi}
                onScanDpi={setScanDpi}
                declinationDeg={declinationDeg}
                onDeclinationDeg={setDeclinationDeg}
                autoDeclinationDeg={autoDeclinationDeg}
                onApplyScaleAndNorth={() => applyScaleAndNorth(null)}
                onStartScaleBar={() => {
                  setPickedFeatureLonLat(null);
                  setSnapStage('scalebar_start');
                }}
                readout={placementReadout}
                scalePct={scalePct}
                angleDeg={angleDeg}
                stretchPct={stretchPct}
                onScale={handleScaleSliderChange}
                onAngle={handleAngleSliderChange}
                onStretch={handleStretchSliderChange}
                onCommitSlider={() => {
                  if (liveMatrixRef.current) void saveMatrixToServer(liveMatrixRef.current);
                }}
                onNudge={(dEastM, dNorthM) => {
                  // Web Mercator metres are stretched by 1/cos(lat): convert ground metres
                  const lat = anchorLonLatRef.current?.[1] ?? 0;
                  const k = 1 / Math.cos((lat * Math.PI) / 180);
                  applyLiveNudge({
                    dEastM: dEastM * k,
                    dNorthM: dNorthM * k,
                    commitToServer: true,
                  });
                }}
              />
              </React.Suspense>
            </>
          ) : (
          <>
          <div className="p-3 border-b border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Участники ({event.participants.length})
              </span>
              <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium cursor-pointer transition">
                <Plus className="w-3.5 h-3.5" />
                {uploadingTrack ? 'Загрузка…' : 'Треки'}
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
                title="Выбрать 2 точки на карте (КП А → КП Б) для анализа вариантов пути и выравнивания скорости"
              >
                <Navigation className="w-3.5 h-3.5 shrink-0" />
                Перегон A → B
              </button>
            </div>

            {/* Speed normalisation switch (orienteering route-choice tool) */}
            {isOrienteering && (
            <div className="bg-slate-950 p-1.5 rounded-lg border border-slate-800 space-y-1">
              <div className="flex items-center justify-between text-[10px] text-slate-400 px-1">
                <span className="flex items-center gap-1">
                  <Zap className="w-3 h-3 text-amber-400" />
                  Выравнивание скорости:
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
                  onClick={() => setSpeedNormMode('fitness_handicap')}
                  className={`py-1 rounded text-center transition ${
                    speedNormMode === 'fitness_handicap'
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Выравнивает базовую физподготовку участников по их среднему темпу за гонку, чтобы понять какой вариант на перегоне (по прямой, по оврагу или вокруг по дороге) выгоднее!"
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

          {/* Course splits: who ran each leg how fast */}
          {isOrienteering && courseControls.length >= 2 && (
            <SplitsPanel
              splits={splits}
              labels={courseLabels}
              selectedLegIdx={selectedLeg?.courseLegIdx ?? null}
              onSelectLeg={selectCourseLeg}
              onWholeCourse={selectWholeCourse}
              trackCorrection={trackCorrection}
              onToggleTrackCorrection={setTrackCorrection}
            />
          )}

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
                          title="Время с поправкой на физподготовку (как если бы все бежали в одном темпе)"
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
            {event.participants.length === 0 && (
              <label className="flex flex-col items-center justify-center gap-2 h-full min-h-[160px] p-4 rounded-xl border-2 border-dashed border-slate-700 hover:border-emerald-500 text-center text-slate-400 cursor-pointer transition">
                <Plus className="w-6 h-6 text-emerald-400" />
                <span className="text-sm text-slate-200 font-medium">
                  Добавьте треки участников
                </span>
                <span className="text-xs">
                  Перетащите сюда файлы .fit / .gpx / .tcx с часов
                  {isOrienteering ? ' (и скан карты)' : ''} или нажмите, чтобы выбрать
                </span>
                <input
                  type="file"
                  multiple
                  accept=".gpx,.fit,.tcx"
                  className="hidden"
                  onChange={handleTrackUpload}
                />
              </label>
            )}
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

          {event.participants.length > 0 && (
          <div className="h-32 border-t border-slate-800 bg-slate-950 p-3 flex flex-col">
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
              onSeek={(sec) => seekTo(sec)}
            />
          </div>
          )}
          </>
          )}
        </div>
      </div>

      {/* Bottom Playback Transport Bar */}
      <div className="px-3 py-2 bg-slate-900 border-t border-slate-800 flex flex-wrap items-center gap-3 shrink-0 z-10">
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
              seekTo(0);
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
            onChange={(e) => seekTo(parseFloat(e.target.value))}
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

/** Index of the first point with t ≥ `t` (points sorted by t) */
function firstIndexAtOrAfter(points: { t: number }[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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

  // The lines depend on the tracks and modes, not on the clock: only the cursor moves
  const lines = useMemo(
    () =>
      participants
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
          return { id: p.id, color: p.color, points: pts.join(' ') };
        }),
    [participants, totalDurationSec, timeMode, eventEpochZeroMs, speedNormMode, referenceSpeedMs]
  );

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

      {lines.map((l) => (
        <polyline
          key={l.id}
          fill="none"
          stroke={l.color}
          strokeWidth={1.6}
          strokeOpacity={0.85}
          points={l.points}
        />
      ))}

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
