import React, { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Clock,
  Crosshair,
  Eye,
  EyeOff,
  Flag,
  Flame,
  Gauge,
  Heart,
  ImagePlus,
  Layers,
  Move,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { lonLatToMercator } from '../../shared/georef.js';
import {
  formatDuration,
  formatPaceMinKm,
  interpolateTrackAt,
} from '../../shared/trackParser.js';
import type {
  ParticipantTrack,
  RaceEvent,
  TimeMode,
} from '../../shared/types.js';
import { buildRubberSheetedMapUrl } from '../utils/rubberSheet.js';

interface Props {
  event: RaceEvent;
  onEventUpdated: (evt: RaceEvent) => void;
  onSwitchToGeoref?: () => void;
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
  onSwitchToGeoref,
}) => {
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(10);
  const [raceTimeSec, setRaceTimeSec] = useState<number>(0); // Start right at 00:00 at the common start spot
  const [tailLengthSec, setTailLengthSec] = useState<number>(120);
  const [mapOpacity, setMapOpacity] = useState<number>(0.88);
  const [osmOpacity, setOsmOpacity] = useState<number>(0.75);
  const [speedHeatmap, setSpeedHeatmap] = useState<boolean>(false);
  const [uploadingTrack, setUploadingTrack] = useState<boolean>(false);
  const [uploadingScreenshot, setUploadingScreenshot] =
    useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showMapCalibrator, setShowMapCalibrator] = useState<boolean>(true);
  const [snapStage, setSnapStage] = useState<
    | 'idle'
    | 'pin_map'
    | 'pin_track'
    | 'shift_map'
    | 'shift_track'
    | 'two_pt_map1'
    | 'two_pt_track1'
    | 'two_pt_map2'
    | 'two_pt_track2'
  >('idle');
  const [pickedFeatureLonLat, setPickedFeatureLonLat] = useState<
    [number, number] | null
  >(null);
  const [pair1Data, setPair1Data] = useState<{
    mapLonLat: [number, number];
    trackLonLat: [number, number];
  } | null>(null);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapReadyRef = useRef<boolean>(false);
  const runnerMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const pinMarkersRef = useRef<maplibregl.Marker[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastFrameMsRef = useRef<number | null>(null);

  // Compute earliest start epoch across participants for 'real' time mode
  const eventEpochZeroMs = useMemo(() => {
    if (event.participants.length === 0) return Date.now();
    return Math.min(
      ...event.participants.map(
        (p) => p.points[0]?.absTimeMs ?? Date.parse(p.startedAtIso)
      )
    );
  }, [event.participants]);

  // Compute total replay duration
  const totalDurationSec = useMemo(() => {
    if (event.participants.length === 0) return 600;
    if (event.timeMode === 'from_start') {
      return Math.max(
        60,
        ...event.participants.map(
          (p) =>
            Math.min(p.trimEndSec, p.durationSec) -
            p.trimStartSec +
            Math.max(0, p.offsetSec)
        )
      );
    } else {
      const maxAbsMs = Math.max(
        ...event.participants.map(
          (p) =>
            (p.points[p.points.length - 1]?.absTimeMs ?? eventEpochZeroMs) +
            p.offsetSec * 1000
        )
      );
      return Math.max(60, Math.ceil((maxAbsMs - eventEpochZeroMs) / 1000));
    }
  }, [event.participants, event.timeMode, eventEpochZeroMs]);

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

    const initialCenter: [number, number] = event.map?.cornersLonLat
      ? [
          (event.map.cornersLonLat[0][0] + event.map.cornersLonLat[2][0]) / 2,
          (event.map.cornersLonLat[0][1] + event.map.cornersLonLat[2][1]) / 2,
        ]
      : event.participants[0]?.points[0]
        ? [
            event.participants[0].points[0].lon,
            event.participants[0].points[0].lat,
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
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [
          {
            id: 'osm-base',
            type: 'raster',
            source: 'osm',
            paint: {
              'raster-opacity': osmOpacity,
            },
          },
        ],
      },
      center: initialCenter,
      zoom: 14.3,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapRef.current = map;
    mapReadyRef.current = false;

    map.on('load', () => {
      mapReadyRef.current = true;
      // 1. Georeferenced custom map overlay
      if (event.map?.cornersLonLat) {
        map.addSource('custom-map', {
          type: 'image',
          url: event.map.imageUrl,
          coordinates: event.map.cornersLonLat,
        });
        map.addLayer({
          id: 'custom-map-layer',
          type: 'raster',
          source: 'custom-map',
          paint: {
            'raster-opacity': mapOpacity,
            'raster-fade-duration': 0,
          },
        });
      }

      // 2. Full ghost tracks (faint background lines)
      map.addSource('ghost-tracks', {
        type: 'geojson',
        data: buildGhostTracksGeoJson(event.participants),
      });
      map.addLayer({
        id: 'ghost-tracks-layer',
        type: 'line',
        source: 'ghost-tracks',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
          'line-opacity': 0.22,
          'line-dasharray': [2, 2],
        },
      });

      // 3. Active animated tails (colored by runner or speed heatmap)
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
          'line-width': 4.5,
          'line-opacity': 0.92,
        },
      });

      // 4. Common Start Spot Marker (all runners start from this single point)
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

      // Fit camera to georeferenced map or tracks so both maps are visible immediately
      let minLon = Infinity,
        maxLon = -Infinity,
        minLat = Infinity,
        maxLat = -Infinity;
      let count = 0;
      if (event.map?.cornersLonLat) {
        for (const [lon, lat] of event.map.cornersLonLat) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          count++;
        }
      }
      for (const p of event.participants) {
        for (const pt of p.points) {
          if (pt.lon < minLon) minLon = pt.lon;
          if (pt.lon > maxLon) maxLon = pt.lon;
          if (pt.lat < minLat) minLat = pt.lat;
          if (pt.lat > maxLat) maxLat = pt.lat;
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
    });

    return () => {
      mapReadyRef.current = false;
      for (const m of runnerMarkersRef.current.values()) m.remove();
      runnerMarkersRef.current.clear();
      map.remove();
      mapRef.current = null;
    };
  }, [event.id]);

  // Update raster opacities when sliders change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    if (map.getLayer('osm-base')) {
      map.setPaintProperty('osm-base', 'raster-opacity', osmOpacity);
    }
    if (map.getLayer('custom-map-layer')) {
      map.setPaintProperty('custom-map-layer', 'raster-opacity', mapOpacity);
    }
  }, [osmOpacity, mapOpacity]);

  // Update custom map if georef or uploaded screenshot changed (including multi-pin Rubber-Sheeting)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !event.map?.cornersLonLat) return;
    const mapObj = event.map;
    const corners = mapObj.cornersLonLat!;
    let cancelled = false;

    void buildRubberSheetedMapUrl(
      mapObj.imageUrl,
      mapObj.width,
      mapObj.height,
      mapObj.gcps,
      mapObj.matrix
    ).then((warpedUrl) => {
      if (cancelled || !mapReadyRef.current) return;
      const src = map.getSource('custom-map') as
        | maplibregl.ImageSource
        | undefined;
      if (src) {
        src.updateImage({
          url: warpedUrl,
          coordinates: corners,
        });
      } else {
        map.addSource('custom-map', {
          type: 'image',
          url: warpedUrl,
          coordinates: corners,
        });
        map.addLayer(
          {
            id: 'custom-map-layer',
            type: 'raster',
            source: 'custom-map',
            paint: { 'raster-opacity': mapOpacity, 'raster-fade-duration': 0 },
          },
          'ghost-tracks-layer'
        );
      }
    });

    // Render pinned control points on the Replay map when calibrator is open
    for (const pm of pinMarkersRef.current) pm.remove();
    pinMarkersRef.current = [];
    if (showMapCalibrator && mapObj.gcps) {
      const cleanPins = mapObj.gcps.filter((g) => !g.id.startsWith('gcp-auto-'));
      cleanPins.forEach((g, idx) => {
        const el = document.createElement('div');
        el.className =
          'px-1.5 py-0.5 rounded-full bg-emerald-500 border-2 border-white text-slate-950 font-bold text-[10px] shadow-lg pointer-events-none flex items-center gap-0.5';
        el.textContent = `📌${idx + 1}`;
        const m = new maplibregl.Marker({ element: el })
          .setLngLat([g.lon, g.lat])
          .addTo(map);
        pinMarkersRef.current.push(m);
      });
    }

    // If the georeferenced map is outside the current camera view, fly to it automatically
    const mapCenterLon = (corners[0][0] + corners[2][0]) / 2;
    const mapCenterLat = (corners[0][1] + corners[2][1]) / 2;
    const viewCenter = map.getCenter();
    if (
      Math.abs(viewCenter.lng - mapCenterLon) > 0.03 ||
      Math.abs(viewCenter.lat - mapCenterLat) > 0.03
    ) {
      let minLon = Infinity,
        maxLon = -Infinity,
        minLat = Infinity,
        maxLat = -Infinity;
      for (const [lon, lat] of corners) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      map.fitBounds(
        [
          [minLon, minLat],
          [maxLon, maxLat],
        ],
        { padding: 50, maxZoom: 16, duration: 500 }
      );
    }

    return () => {
      cancelled = true;
    };
  }, [event.map, showMapCalibrator]);

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
        eventEpochZeroMs
      ),
    }));
  }, [event.participants, raceTimeSec, event.timeMode, eventEpochZeroMs]);

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
            speedHeatmap
          )
        );
      }

      // Sync runner head markers
      const activeIds = new Set<string>();
      for (const { participant: p, state } of runnerStates) {
        if (!p.visible || !state) continue;
        activeIds.add(p.id);

        let marker = runnerMarkersRef.current.get(p.id);
        if (!marker) {
          const el = document.createElement('div');
          el.className = 'flex items-center gap-1.5 pointer-events-none';
          el.innerHTML = `
            <div class="w-4 h-4 rounded-full border-2 border-white shadow-lg" style="background:${p.color}"></div>
            <div class="px-1.5 py-0.5 rounded bg-slate-900/90 border border-slate-700 text-[11px] font-semibold text-white whitespace-nowrap shadow">
              <span class="runner-label"></span>
            </div>
          `;
          marker = new maplibregl.Marker({ element: el, anchor: 'left' })
            .setLngLat([state.lon, state.lat])
            .addTo(map);
          runnerMarkersRef.current.set(p.id, marker);
        } else {
          marker.setLngLat([state.lon, state.lat]);
        }

        const labelEl = marker
          .getElement()
          .querySelector('.runner-label') as HTMLElement | null;
        if (labelEl) {
          const shortName = p.name.split(' ')[0];
          const paceStr = formatPaceMinKm(state.speedMs);
          labelEl.textContent = `${shortName} • ${paceStr}`;
        }
      }

      // Remove markers for hidden/deleted participants
      for (const [id, marker] of runnerMarkersRef.current.entries()) {
        if (!activeIds.has(id)) {
          marker.remove();
          runnerMarkersRef.current.delete(id);
        }
      }
    };

    if (map.isStyleLoaded()) {
      updateDynamicElements();
    } else {
      map.once('load', updateDynamicElements);
    }
  }, [
    runnerStates,
    raceTimeSec,
    tailLengthSec,
    event.timeMode,
    eventEpochZeroMs,
    speedHeatmap,
  ]);

  // Sort leaderboard by distance covered at current timestamp
  const leaderboard = useMemo(() => {
    const list = [...runnerStates].sort(
      (a, b) => (b.state?.distM ?? 0) - (a.state?.distM ?? 0)
    );
    const leaderDist = list[0]?.state?.distM ?? 0;
    return list.map((item, idx) => ({
      ...item,
      rank: idx + 1,
      gapMeters: Math.round(leaderDist - (item.state?.distM ?? 0)),
    }));
  }, [runnerStates]);

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
          throw new Error(data.error || 'Ошибка загрузки трека');
        }
        latestEvent = data.event;
      }
      onEventUpdated(latestEvent);
      setRaceTimeSec(0);
      // Fly map to the common start point of the newly uploaded tracks
      const firstPt =
        latestEvent.participants[latestEvent.participants.length - 1]
          ?.points[0];
      if (firstPt && mapRef.current) {
        mapRef.current.flyTo({
          center: [firstPt.lon, firstPt.lat],
          zoom: 14.5,
        });
      }
    } catch (err: any) {
      setUploadError(err.message);
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
        onEventUpdated(data.event);
      }
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

  // Handle direct click-on-map -> click-on-track alignment (both 1-point shift & 2-point full auto-align)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onMapClick = (e: maplibregl.MapMouseEvent) => {
      const clicked: [number, number] = [e.lngLat.lng, e.lngLat.lat];

      if (snapStage === 'pin_map') {
        setPickedFeatureLonLat(clicked);
        setSnapStage('pin_track');
      } else if (snapStage === 'pin_track' && pickedFeatureLonLat) {
        const mapPt = pickedFeatureLonLat;
        setSnapStage('idle');
        setPickedFeatureLonLat(null);
        void nudgeMap({
          addPin: {
            mapLonLat: mapPt,
            trackLonLat: clicked,
          },
        });
      } else if (snapStage === 'shift_map') {
        setPickedFeatureLonLat(clicked);
        setSnapStage('shift_track');
      } else if (snapStage === 'shift_track' && pickedFeatureLonLat) {
        const [m0x, m0y] = lonLatToMercator(
          pickedFeatureLonLat[0],
          pickedFeatureLonLat[1]
        );
        const [m1x, m1y] = lonLatToMercator(clicked[0], clicked[1]);
        setSnapStage('idle');
        setPickedFeatureLonLat(null);
        void nudgeMap({ dEastM: m1x - m0x, dNorthM: m1y - m0y });
      } else if (snapStage === 'two_pt_map1') {
        setPickedFeatureLonLat(clicked);
        setSnapStage('two_pt_track1');
      } else if (snapStage === 'two_pt_track1' && pickedFeatureLonLat) {
        setPair1Data({
          mapLonLat: pickedFeatureLonLat,
          trackLonLat: clicked,
        });
        setPickedFeatureLonLat(null);
        setSnapStage('two_pt_map2');
      } else if (snapStage === 'two_pt_map2') {
        setPickedFeatureLonLat(clicked);
        setSnapStage('two_pt_track2');
      } else if (
        snapStage === 'two_pt_track2' &&
        pickedFeatureLonLat &&
        pair1Data
      ) {
        const pair2 = {
          mapLonLat: pickedFeatureLonLat,
          trackLonLat: clicked,
        };
        setSnapStage('idle');
        setPickedFeatureLonLat(null);
        setPair1Data(null);
        void nudgeMap({
          twoPointSnap: {
            pair1: pair1Data,
            pair2,
          },
        });
      }
    };

    map.on('click', onMapClick);
    return () => {
      map.off('click', onMapClick);
    };
  }, [snapStage, pickedFeatureLonLat, pair1Data, event.id]);

  async function nudgeMap(params: {
    dEastM?: number;
    dNorthM?: number;
    scaleFactor?: number;
    dAngleDeg?: number;
    addPin?: {
      mapLonLat: [number, number];
      trackLonLat: [number, number];
    };
    undoLastPin?: boolean;
    clearPins?: boolean;
    twoPointSnap?: {
      pair1: { mapLonLat: [number, number]; trackLonLat: [number, number] };
      pair2: { mapLonLat: [number, number]; trackLonLat: [number, number] };
    };
  }) {
    const res = await fetch(`/api/events/${event.id}/map-nudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (res.ok) {
      const data = await res.json();
      onEventUpdated(data.event);
    }
  }

  async function syncCommonStartSpot() {
    const res = await fetch(`/api/events/${event.id}/sync-start`, {
      method: 'POST',
    });
    if (res.ok) {
      const data = await res.json();
      onEventUpdated(data.event);
      setRaceTimeSec(0);
    }
  }

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100">
      {/* Main workspace: Map + Right Analytics Sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-12 flex-1 min-h-0">
        {/* Map area */}
        <div className="lg:col-span-8 xl:col-span-9 relative flex flex-col min-h-[420px]">
          {/* Floating map layer controls */}
          <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-3 px-3.5 py-2 rounded-xl bg-slate-900/90 backdrop-blur border border-slate-800 shadow-xl text-xs">
            <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer transition">
              <ImagePlus className="w-3.5 h-3.5" />
              {uploadingScreenshot
                ? 'Загрузка...'
                : event.map
                  ? 'Заменить карту'
                  : 'Загрузить карту / скрин'}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleQuickScreenshotUpload}
              />
            </label>

            <div className="flex items-center gap-2 border-l border-slate-800 pl-3">
              <Layers className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-slate-300">Карта:</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={mapOpacity}
                onChange={(e) => setMapOpacity(parseFloat(e.target.value))}
                className="w-20 accent-emerald-500"
              />
            </div>

            <div className="flex items-center gap-2 border-l border-slate-800 pl-3">
              <span className="text-slate-300">OSM:</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={osmOpacity}
                onChange={(e) => setOsmOpacity(parseFloat(e.target.value))}
                className="w-20 accent-sky-500"
              />
            </div>

            <div className="flex items-center gap-1.5 border-l border-slate-800 pl-3">
              <span className="text-slate-400">Хвост:</span>
              {TAIL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTailLengthSec(opt.value)}
                  className={`px-2 py-0.5 rounded transition ${
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
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border transition ${
                speedHeatmap
                  ? 'bg-amber-500/20 border-amber-400/50 text-amber-300 font-medium'
                  : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
              }`}
              title="Окрашивать трек в зависимости от мгновенного темпа (быстро = зелёный, медленно = красный)"
            >
              <Flame className="w-3.5 h-3.5" />
              Темп-хитмап
            </button>

            {onSwitchToGeoref && (
              <button
                onClick={onSwitchToGeoref}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-sky-600/25 hover:bg-sky-600/35 border border-sky-400/50 text-sky-200 font-medium transition"
                title="Открыть двухпанельный режим: слева скан карты, справа OpenStreetMap"
              >
                <Crosshair className="w-3.5 h-3.5" />
                Привязка к OSM (2 карты)
              </button>
            )}

            {event.map && (
              <button
                onClick={() => setShowMapCalibrator((v) => !v)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border transition ${
                  showMapCalibrator || snapStage !== 'idle'
                    ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-300 font-medium'
                    : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'
                }`}
                title="Подогнать сдвиг, поворот или масштаб карты прямо под GPS-трек"
              >
                <Move className="w-3.5 h-3.5" />
                Подогнать карту под трек
              </button>
            )}
          </div>

          {/* Direct Map-to-Track Calibration Floating Widget */}
          {event.map && showMapCalibrator && (
            <div className="absolute top-16 left-3 z-20 p-3 rounded-xl bg-slate-900/95 backdrop-blur border border-emerald-500/40 shadow-2xl text-xs space-y-2.5 w-80">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-emerald-300">
                  Подгонка карты прямо под трек
                </span>
                <button
                  onClick={() => {
                    setShowMapCalibrator(false);
                    setSnapStage('idle');
                  }}
                  className="text-slate-400 hover:text-white"
                >
                  ✕
                </button>
              </div>

              {/* Multi-Pin Anchor ("Приколоть булавку КАРТА -> ТРЕК"): locks Start, КП2, КП5... simultaneously */}
              <div className="bg-slate-950/90 p-2.5 rounded-lg border border-emerald-500/30 space-y-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-emerald-300 font-semibold">
                    📌 Булавки по КП и дорогам ({
                      (event.map.gcps ?? []).filter(
                        (g) => !g.id.startsWith('gcp-auto-')
                      ).length
                    })
                  </span>
                  <span className="text-slate-400 text-[10px]">
                    {(event.map.gcps ?? []).filter(
                      (g) => !g.id.startsWith('gcp-auto-')
                    ).length === 0 && 'Старт → КП2 → дальний КП'}
                    {(event.map.gcps ?? []).filter(
                      (g) => !g.id.startsWith('gcp-auto-')
                    ).length === 1 && '1 т.: сдвиг'}
                    {(event.map.gcps ?? []).filter(
                      (g) => !g.id.startsWith('gcp-auto-')
                    ).length === 2 && '2 т.: поворот + масштаб'}
                    {(event.map.gcps ?? []).filter(
                      (g) => !g.id.startsWith('gcp-auto-')
                    ).length === 3 && '3 т.: наклон фото X/Y'}
                    {(event.map.gcps ?? []).filter(
                      (g) => !g.id.startsWith('gcp-auto-')
                    ).length >= 4 && '4+ т.: эластичная сетка'}
                  </span>
                </div>

                <button
                  onClick={() => {
                    if (snapStage.startsWith('pin_')) {
                      setSnapStage('idle');
                      setPickedFeatureLonLat(null);
                    } else {
                      setPickedFeatureLonLat(null);
                      setSnapStage('pin_map');
                    }
                  }}
                  className={`w-full py-2 px-3 rounded-lg font-medium flex items-center justify-center gap-1.5 border transition ${
                    snapStage.startsWith('pin_')
                      ? 'bg-amber-500/25 border-amber-400 text-amber-200 animate-pulse'
                      : 'bg-emerald-600 hover:bg-emerald-500 border-emerald-500 text-white shadow'
                  }`}
                >
                  <Crosshair className="w-4 h-4 shrink-0" />
                  {!snapStage.startsWith('pin_') &&
                    '📌 + Приколоть точку: КАРТА → ТРЕК'}
                  {snapStage === 'pin_map' &&
                    '1/2: Кликни КП / поворот дороги на КАРТЕ'}
                  {snapStage === 'pin_track' &&
                    '2/2: Кликни это же место на GPS-ТРЕКЕ'}
                </button>

                {(event.map.gcps ?? []).filter(
                  (g) => !g.id.startsWith('gcp-auto-')
                ).length > 0 && (
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <button
                      onClick={() => void nudgeMap({ undoLastPin: true })}
                      className="flex-1 py-1 px-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] flex items-center justify-center gap-1"
                      title="Удалить последнюю поставленную булавку"
                    >
                      <RotateCcw className="w-3 h-3" /> Отменить булавку
                    </button>
                    <button
                      onClick={() => void nudgeMap({ clearPins: true })}
                      className="py-1 px-2 rounded bg-slate-800 hover:bg-rose-900/50 text-slate-400 hover:text-rose-200 text-[11px]"
                      title="Сбросить все булавки"
                    >
                      Сброс
                    </button>
                  </div>
                )}
              </div>

              {/* 1-point simple shift without adding a pin */}
              <button
                onClick={() => {
                  if (snapStage.startsWith('shift')) {
                    setSnapStage('idle');
                    setPickedFeatureLonLat(null);
                  } else {
                    setPickedFeatureLonLat(null);
                    setSnapStage('shift_map');
                  }
                }}
                className={`w-full py-1.5 px-3 rounded-lg font-medium flex items-center justify-center gap-1.5 border transition ${
                  snapStage.startsWith('shift')
                    ? 'bg-amber-500/25 border-amber-400 text-amber-200 animate-pulse'
                    : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
                }`}
              >
                <Move className="w-3.5 h-3.5 shrink-0" />
                {!snapStage.startsWith('shift') &&
                  'Просто сдвинуть всю карту (1 точка)'}
                {snapStage === 'shift_map' &&
                  '1/2: Кликни место на КАРТЕ'}
                {snapStage === 'shift_track' &&
                  '2/2: Кликни куда сдвинуть на ТРЕКЕ'}
              </button>

              {/* Shift buttons */}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800 space-y-1">
                  <div className="text-[10px] text-slate-400 text-center">
                    Сдвиг карты (15 м)
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <button
                      onClick={() => nudgeMap({ dNorthM: 15 })}
                      className="p-1 rounded bg-slate-800 hover:bg-slate-700"
                      title="На север (+15м)"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => nudgeMap({ dEastM: -15 })}
                        className="p-1 rounded bg-slate-800 hover:bg-slate-700"
                        title="На запад (-15м)"
                      >
                        <ArrowLeft className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => nudgeMap({ dEastM: 15 })}
                        className="p-1 rounded bg-slate-800 hover:bg-slate-700"
                        title="На восток (+15м)"
                      >
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <button
                      onClick={() => nudgeMap({ dNorthM: -15 })}
                      className="p-1 rounded bg-slate-800 hover:bg-slate-700"
                      title="На юг (-15м)"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Rotation & Scale */}
                <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800 flex flex-col justify-between">
                  <div>
                    <div className="text-[10px] text-slate-400 text-center mb-1">
                      Поворот ({event.map.rotationDeg ?? 0}°)
                    </div>
                    <div className="flex items-center justify-center gap-1.5">
                      <button
                        onClick={() => nudgeMap({ dAngleDeg: 1 })}
                        className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 flex items-center gap-1"
                        title="Повернуть против часовой (+1°)"
                      >
                        <RotateCcw className="w-3 h-3" /> 1°
                      </button>
                      <button
                        onClick={() => nudgeMap({ dAngleDeg: -1 })}
                        className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 flex items-center gap-1"
                        title="Повернуть по часовой (-1°)"
                      >
                        <RotateCw className="w-3 h-3" /> 1°
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="text-[10px] text-slate-400 text-center mb-1">
                      Масштаб карты
                    </div>
                    <div className="flex items-center justify-center gap-1.5">
                      <button
                        onClick={() => nudgeMap({ scaleFactor: 0.98 })}
                        className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 flex items-center gap-1"
                        title="Уменьшить карту (-2%)"
                      >
                        <ZoomOut className="w-3 h-3" /> -2%
                      </button>
                      <button
                        onClick={() => nudgeMap({ scaleFactor: 1.02 })}
                        className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 flex items-center gap-1"
                        title="Увеличить карту (+2%)"
                      >
                        <ZoomIn className="w-3 h-3" /> +2%
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Speed heatmap legend */}
          {speedHeatmap && (
            <div className="absolute bottom-4 left-3 z-10 px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[11px] flex items-center gap-2 shadow-lg">
              <span className="text-slate-400">Темп:</span>
              <span className="inline-block w-3 h-3 rounded-sm bg-rose-500" />
              <span>&gt;6:30/км</span>
              <span className="inline-block w-3 h-3 rounded-sm bg-amber-400 ml-1" />
              <span>4:45/км</span>
              <span className="inline-block w-3 h-3 rounded-sm bg-emerald-400 ml-1" />
              <span>&lt;3:45/км</span>
            </div>
          )}

          <div ref={mapContainerRef} className="flex-1 w-full" />
        </div>

        {/* Right sidebar: Participants, live telemetry & time sync */}
        <div className="lg:col-span-4 xl:col-span-3 flex flex-col border-l border-slate-800 bg-slate-900/80 overflow-hidden">
          {/* Sidebar header: Upload Garmin tracks & Time synchronization mode */}
          <div className="p-3 border-b border-slate-800 space-y-2.5">
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
                title="Все участники стартуют одновременно в 00:00 с одного места"
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
                title="По реальным часам GPS (абсолютные timestamps)"
              >
                Реальное время GPS
              </button>
            </div>

            <button
              onClick={syncCommonStartSpot}
              className="w-full py-1.5 px-2.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-[11px] text-emerald-300 font-medium transition flex items-center justify-center gap-1.5"
              title="Автоматически обрезать ожидание на старте у всех участников и выровнять выход из общей точки старта в 00:00"
            >
              <Flag className="w-3.5 h-3.5" />
              Синхронизировать общий старт с 1 места
            </button>
          </div>

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

                  {/* Live telemetry metrics at current timestamp */}
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

                  {/* Manual time offset adjustment */}
                  <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Сдвиг: {p.offsetSec > 0 ? `+${p.offsetSec}` : p.offsetSec}с (обрезка старта: {p.trimStartSec}с)
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

          {/* Synchronized Speed Comparison Sparkline Chart */}
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
              onSeek={(sec) => setRaceTimeSec(sec)}
            />
          </div>
        </div>
      </div>

      {/* Bottom Playback Transport Bar */}
      <div className="px-4 py-3 bg-slate-900 border-t border-slate-800 flex flex-wrap items-center gap-4">
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
            title="В начало (00:00 — общий старт)"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>

        {/* Time readout */}
        <div className="font-mono text-sm min-w-[115px]">
          <span className="text-emerald-400 font-bold">
            {formatDuration(raceTimeSec)}
          </span>
          <span className="text-slate-500">
            {' '}
            / {formatDuration(totalDurationSec)}
          </span>
        </div>

        {/* Scrubber timeline */}
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

        {/* Playback multiplier buttons */}
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
    sumLon += p.points[0].lon;
    sumLat += p.points[0].lat;
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
  speedHeatmap: boolean
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  for (const p of participants) {
    if (!p.visible || p.points.length < 2) continue;

    let headLocalT: number;
    if (timeMode === 'from_start') {
      headLocalT = raceTimeSec - p.offsetSec + p.trimStartSec;
    } else {
      const targetAbsMs =
        eventEpochZeroMs + (raceTimeSec - p.offsetSec) * 1000;
      headLocalT = (targetAbsMs - p.points[0].absTimeMs) / 1000;
    }

    const tailStartT = Math.max(p.trimStartSec, headLocalT - tailLengthSec);
    const tailEndT = Math.min(p.trimEndSec, p.durationSec, headLocalT);
    if (tailEndT <= tailStartT) continue;

    const windowPts = p.points.filter(
      (pt) => pt.t >= tailStartT && pt.t <= tailEndT
    );

    const headState = interpolateTrackAt(
      p,
      raceTimeSec,
      timeMode,
      eventEpochZeroMs
    );

    const coords: Array<[number, number, number]> = windowPts.map((pt) => [
      pt.lon,
      pt.lat,
      pt.speedMs,
    ]);
    if (headState && !headState.notStarted) {
      coords.push([headState.lon, headState.lat, headState.speedMs]);
    }

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
  onSeek: (sec: number) => void;
}> = ({ participants, currentTimeSec, totalDurationSec, onSeek }) => {
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
      className="w-full flex-1 bg-slate-900/60 rounded border border-slate-800/80 cursor-pointer"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        onSeek(Math.max(0, Math.min(totalDurationSec, ratio * totalDurationSec)));
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
        .filter((p) => p.visible && p.points.length > 2)
        .map((p) => {
          const step = Math.max(1, Math.floor(p.points.length / 80));
          const pathParts: string[] = [];
          for (let i = 0; i < p.points.length; i += step) {
            const pt = p.points[i];
            const tRel = pt.t - p.trimStartSec + p.offsetSec;
            const x = (tRel / totalDurationSec) * width;
            const kmh = Math.min(maxKmh, pt.speedMs * 3.6);
            const y = height - (kmh / maxKmh) * (height - 10) - 4;
            pathParts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
          }
          return (
            <path
              key={p.id}
              d={pathParts.join(' ')}
              fill="none"
              stroke={p.color}
              strokeWidth={1.6}
              strokeOpacity={0.85}
            />
          );
        })}
      <line
        x1={cursorX}
        y1={0}
        x2={cursorX}
        y2={height}
        stroke="#10b981"
        strokeWidth={1.8}
      />
    </svg>
  );
};
