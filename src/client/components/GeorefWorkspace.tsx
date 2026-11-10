import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  CheckCircle2,
  Crosshair,
  Eye,
  EyeOff,
  ImagePlus,
  Layers,
  PlayCircle,
  RotateCcw,
  Trash2,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { solveGeoref } from '../../shared/georef.js';
import type { GCP, RaceEvent, TransformType } from '../../shared/types.js';

interface Props {
  event: RaceEvent;
  onEventUpdated: (evt: RaceEvent) => void;
  onSwitchToReplay?: () => void;
}

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
    satellite: {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: '© Esri World Imagery',
    },
  },
  layers: [
    {
      id: 'osm-tiles',
      type: 'raster',
      source: 'osm',
      minzoom: 0,
      maxzoom: 19,
    },
    {
      id: 'satellite-tiles',
      type: 'raster',
      source: 'satellite',
      minzoom: 0,
      maxzoom: 19,
      paint: {
        'raster-opacity': 0,
      },
    },
  ],
};

function cleanManualGcps(raw?: GCP[]): GCP[] {
  return (raw ?? []).filter((g) => !g.id.startsWith('gcp-auto-'));
}

export const GeorefWorkspace: React.FC<Props> = ({
  event,
  onEventUpdated,
  onSwitchToReplay,
}) => {
  const mapObj = event.map;
  const [gcps, setGcps] = useState<GCP[]>(() => cleanManualGcps(mapObj?.gcps));
  const [transformType, setTransformType] = useState<TransformType>(
    mapObj?.transformType ?? 'similarity'
  );
  const [pendingPixel, setPendingPixel] = useState<{
    px: number;
    py: number;
  } | null>(null);
  const [pendingLonLat, setPendingLonLat] = useState<{
    lon: number;
    lat: number;
  } | null>(null);

  const [showOverlayOnOsm, setShowOverlayOnOsm] = useState<boolean>(true);
  const [overlayOpacity, setOverlayOpacity] = useState<number>(0.68);
  const [useSatelliteBase, setUseSatelliteBase] = useState<boolean>(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Left scanned map zoom & pan state
  const [scanZoom, setScanZoom] = useState<number>(1);
  const [scanPan, setScanPan] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const isPanningScanRef = useRef(false);
  const scanDragStartRef = useRef<{
    clientX: number;
    clientY: number;
    panX: number;
    panY: number;
    moved: boolean;
  }>({ clientX: 0, clientY: 0, panX: 0, panY: 0, moved: false });
  const draggingScanGcpIdRef = useRef<string | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const scanViewportRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<maplibregl.Map | null>(null);
  const mapReadyRef = useRef<boolean>(false);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const pendingOsmMarkerRef = useRef<maplibregl.Marker | null>(null);

  // Keep latest state in refs so MapLibre click handler never uses stale closures
  const gcpsRef = useRef<GCP[]>(gcps);
  gcpsRef.current = gcps;
  const pendingPixelRef = useRef(pendingPixel);
  pendingPixelRef.current = pendingPixel;
  const pendingLonLatRef = useRef(pendingLonLat);
  pendingLonLatRef.current = pendingLonLat;
  const transformTypeRef = useRef(transformType);
  transformTypeRef.current = transformType;

  useEffect(() => {
    setGcps(cleanManualGcps(event.map?.gcps));
    setTransformType(event.map?.transformType ?? 'similarity');
    setPendingPixel(null);
    setPendingLonLat(null);
    setScanZoom(1);
    setScanPan({ x: 0, y: 0 });
  }, [event.id, event.map?.id]);

  // Compute live solution on the client from manual GCPs
  const liveSolution =
    mapObj && gcps.length >= 2
      ? solveGeoref(gcps, mapObj.width, mapObj.height, transformType)
      : null;

  // Initialize MapLibre right-hand map
  useEffect(() => {
    if (!mapContainerRef.current) return;
    const clean = cleanManualGcps(event.map?.gcps);
    const firstRunnerPt = event.participants[0]?.points[0];
    const initialCenter: [number, number] =
      clean.length > 0
        ? [clean[0].lon, clean[0].lat]
        : firstRunnerPt
          ? [firstRunnerPt.lon, firstRunnerPt.lat]
          : event.map?.cornersLonLat
            ? [
                (event.map.cornersLonLat[0][0] +
                  event.map.cornersLonLat[2][0]) /
                  2,
                (event.map.cornersLonLat[0][1] +
                  event.map.cornersLonLat[2][1]) /
                  2,
              ]
            : [32.4245, 34.772];

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: OSM_STYLE,
      center: initialCenter,
      zoom: 14,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapInstanceRef.current = map;
    mapReadyRef.current = false;

    map.on('load', () => {
      mapReadyRef.current = true;
      if (event.participants.length > 0 || clean.length >= 2) {
        fitMapToTracksOrGcps(map, event);
      }
      syncMapLayers();
    });

    // Click on right-hand OSM map: either completes a pending scan click, or starts a pending OSM click
    map.on('click', (e: maplibregl.MapMouseEvent) => {
      const lon = Number(e.lngLat.lng.toFixed(6));
      const lat = Number(e.lngLat.lat.toFixed(6));
      const curPendingPx = pendingPixelRef.current;

      if (curPendingPx) {
        const nextIdx = gcpsRef.current.length + 1;
        const newGcp: GCP = {
          id: `gcp-${Date.now()}`,
          label: `Точка #${nextIdx}`,
          px: Math.round(curPendingPx.px),
          py: Math.round(curPendingPx.py),
          lon,
          lat,
        };
        const updated = [...gcpsRef.current, newGcp];
        setGcps(updated);
        setPendingPixel(null);
        setPendingLonLat(null);
        void persistGeoref(updated, transformTypeRef.current);
      } else {
        // User clicked OSM first — store pendingLonLat so they can click the matching spot on the scan!
        setPendingLonLat({ lon, lat });
      }
    });

    return () => {
      mapReadyRef.current = false;
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [event.id]);

  // Effective opacity: dim overlay while picking a point on OSM so roads are clearly visible
  const effectiveOsmOverlayOpacity = !showOverlayOnOsm
    ? 0
    : pendingPixel
      ? Math.min(overlayOpacity, 0.28)
      : overlayOpacity;

  function syncMapLayers() {
    const map = mapInstanceRef.current;
    if (!map || !mapReadyRef.current) return;

    // 1. Remove previous markers
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    if (pendingOsmMarkerRef.current) {
      pendingOsmMarkerRef.current.remove();
      pendingOsmMarkerRef.current = null;
    }

    // 2. Render pending OSM marker if user clicked OSM first
    if (pendingLonLat) {
      const el = document.createElement('div');
      el.className =
        'w-7 h-7 rounded-full bg-amber-400 border-2 border-white text-slate-950 font-bold text-xs flex items-center justify-center shadow-xl animate-bounce pointer-events-none';
      el.textContent = '?';
      pendingOsmMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([pendingLonLat.lon, pendingLonLat.lat])
        .addTo(map);
    }

    // 3. Add draggable markers for each paired GCP
    gcps.forEach((g, idx) => {
      const el = document.createElement('div');
      el.className =
        'w-6 h-6 rounded-full bg-emerald-500 border-2 border-white text-slate-950 font-bold text-xs flex items-center justify-center shadow-lg cursor-grab';
      el.textContent = String(idx + 1);
      el.title = `Точка #${idx + 1} (перетащите для точной подстройки на карте OSM)`;

      // Stop click propagation so clicking a marker doesn't place a new point
      el.addEventListener('click', (ev) => ev.stopPropagation());

      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([g.lon, g.lat])
        .addTo(map);

      marker.on('dragend', () => {
        const pos = marker.getLngLat();
        const next = gcpsRef.current.map((item) =>
          item.id === g.id
            ? {
                ...item,
                lon: Number(pos.lng.toFixed(6)),
                lat: Number(pos.lat.toFixed(6)),
              }
            : item
        );
        setGcps(next);
        void persistGeoref(next, transformTypeRef.current);
      });

      markersRef.current.push(marker);
    });

    // 4. Update or add warped raster image overlay on OSM
    const sourceId = 'georef-preview';
    const layerId = 'georef-preview-layer';
    if (mapObj && liveSolution?.cornersLonLat) {
      const existingSource = map.getSource(sourceId) as
        | maplibregl.ImageSource
        | undefined;
      if (existingSource) {
        existingSource.updateImage({
          url: mapObj.imageUrl,
          coordinates: liveSolution.cornersLonLat,
        });
        if (map.getLayer(layerId)) {
          map.setPaintProperty(
            layerId,
            'raster-opacity',
            effectiveOsmOverlayOpacity
          );
        }
      } else {
        map.addSource(sourceId, {
          type: 'image',
          url: mapObj.imageUrl,
          coordinates: liveSolution.cornersLonLat,
        });
        map.addLayer({
          id: layerId,
          type: 'raster',
          source: sourceId,
          paint: {
            'raster-opacity': effectiveOsmOverlayOpacity,
            'raster-fade-duration': 0,
          },
        });
      }
    } else {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }

    // 5. Render GPS tracks on the OSM map so user can also see tracks while georeferencing
    const tracksSourceId = 'georef-gps-tracks';
    const tracksLayerId = 'georef-gps-tracks-layer';
    const tracksGeoJson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: event.participants
        .filter((p) => p.points.length >= 2)
        .map((p) => ({
          type: 'Feature',
          properties: { color: p.color },
          geometry: {
            type: 'LineString',
            coordinates: p.points.map((pt) => [pt.lon, pt.lat]),
          },
        })),
    };
    const existingTrackSrc = map.getSource(tracksSourceId) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (existingTrackSrc) {
      existingTrackSrc.setData(tracksGeoJson);
    } else {
      map.addSource(tracksSourceId, {
        type: 'geojson',
        data: tracksGeoJson,
      });
      map.addLayer({
        id: tracksLayerId,
        type: 'line',
        source: tracksSourceId,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 3,
          'line-opacity': 0.85,
        },
      });
    }
  }

  // Sync GCP markers and live raster overlay onto MapLibre whenever state changes
  useEffect(() => {
    syncMapLayers();
  }, [
    gcps,
    liveSolution,
    mapObj,
    effectiveOsmOverlayOpacity,
    transformType,
    pendingLonLat,
    event.participants,
  ]);

  async function persistGeoref(
    nextGcps: GCP[],
    nextTransformType: TransformType
  ) {
    setSaving(true);
    try {
      const res = await fetch(`/api/events/${event.id}/georef`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gcps: nextGcps,
          transformType: nextTransformType,
          width: mapObj?.width,
          height: mapObj?.height,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        onEventUpdated(data.event);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
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
        setGcps([]);
        setPendingPixel(null);
        setPendingLonLat(null);
        setScanZoom(1);
        setScanPan({ x: 0, y: 0 });
        onEventUpdated(data.event);
      }
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  function clientPosToImagePixel(
    clientX: number,
    clientY: number
  ): { px: number; py: number } | null {
    if (!imgRef.current || !mapObj) return null;
    const rect = imgRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const actualWidth = imgRef.current.naturalWidth || mapObj.width;
    const actualHeight = imgRef.current.naturalHeight || mapObj.height;
    const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const relY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return {
      px: relX * actualWidth,
      py: relY * actualHeight,
    };
  }

  function handleScanMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    isPanningScanRef.current = true;
    scanDragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      panX: scanPan.x,
      panY: scanPan.y,
      moved: false,
    };
  }

  function handleScanMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    // Dragging an existing GCP pin on the left scan
    if (draggingScanGcpIdRef.current) {
      const pt = clientPosToImagePixel(e.clientX, e.clientY);
      if (!pt) return;
      const targetId = draggingScanGcpIdRef.current;
      setGcps((prev) =>
        prev.map((g) =>
          g.id === targetId
            ? { ...g, px: Math.round(pt.px), py: Math.round(pt.py) }
            : g
        )
      );
      return;
    }

    if (!isPanningScanRef.current) return;
    const dx = e.clientX - scanDragStartRef.current.clientX;
    const dy = e.clientY - scanDragStartRef.current.clientY;
    if (Math.hypot(dx, dy) > 5) {
      scanDragStartRef.current.moved = true;
      setScanPan({
        x: scanDragStartRef.current.panX + dx,
        y: scanDragStartRef.current.panY + dy,
      });
    }
  }

  function handleScanMouseUp(e: React.MouseEvent<HTMLDivElement>) {
    if (draggingScanGcpIdRef.current) {
      draggingScanGcpIdRef.current = null;
      void persistGeoref(gcpsRef.current, transformTypeRef.current);
      return;
    }

    if (!isPanningScanRef.current) return;
    isPanningScanRef.current = false;

    // If user didn't drag the canvas, treat as a click to place a point on the scan!
    if (!scanDragStartRef.current.moved) {
      const pt = clientPosToImagePixel(e.clientX, e.clientY);
      if (!pt) return;

      if (pendingLonLat) {
        // User had already clicked on OSM first -> pair them immediately!
        const nextIdx = gcps.length + 1;
        const newGcp: GCP = {
          id: `gcp-${Date.now()}`,
          label: `Точка #${nextIdx}`,
          px: Math.round(pt.px),
          py: Math.round(pt.py),
          lon: pendingLonLat.lon,
          lat: pendingLonLat.lat,
        };
        const updated = [...gcps, newGcp];
        setGcps(updated);
        setPendingLonLat(null);
        setPendingPixel(null);
        void persistGeoref(updated, transformType);
      } else {
        setPendingPixel(pt);
      }
    }
  }

  function handleScanWheel(e: React.WheelEvent<HTMLDivElement>) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    setScanZoom((prev) => Math.max(0.8, Math.min(8, Number((prev * factor).toFixed(2)))));
  }

  function handleImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    if (
      mapObj &&
      img.naturalWidth > 0 &&
      img.naturalHeight > 0 &&
      (mapObj.width !== img.naturalWidth || mapObj.height !== img.naturalHeight)
    ) {
      mapObj.width = img.naturalWidth;
      mapObj.height = img.naturalHeight;
      if (gcps.length >= 2) {
        void persistGeoref(gcps, transformType);
      }
    }
  }

  function removeGcp(id: string) {
    const next = gcps.filter((g) => g.id !== id);
    setGcps(next);
    void persistGeoref(next, transformType);
  }

  function clearAllGcps() {
    setGcps([]);
    setPendingPixel(null);
    setPendingLonLat(null);
    void persistGeoref([], transformType);
  }

  // Step prompt for user clarity
  const nextPointNum = gcps.length + 1;

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100">
      {/* Top toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-slate-900 border-b border-slate-800">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium cursor-pointer transition shadow">
            <Upload className="w-3.5 h-3.5" />
            {uploading
              ? 'Загрузка...'
              : mapObj
                ? 'Заменить скан карты'
                : '1. Загрузить скан карты (PNG / JPG)'}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileUpload}
            />
          </label>

          {/* Transform mode selector */}
          <div className="flex items-center gap-1 bg-slate-800 p-0.5 rounded-lg text-xs">
            <button
              onClick={() => {
                setTransformType('similarity');
                void persistGeoref(gcps, 'similarity');
              }}
              className={`px-2.5 py-1 rounded-md transition ${
                transformType === 'similarity'
                  ? 'bg-emerald-600 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Идеально для карт спортивного ориентирования: по 2 точкам автоматически находит сдвиг, масштаб и угол поворота магнитного меридиана!"
            >
              Спортивная карта (2 точки, с поворотом)
            </button>
            <button
              onClick={() => {
                setTransformType('north_up');
                void persistGeoref(gcps, 'north_up');
              }}
              className={`px-2.5 py-1 rounded-md transition ${
                transformType === 'north_up'
                  ? 'bg-emerald-600 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Север строго сверху (без поворота): для скриншотов Google Maps / OSM"
            >
              Скрин Google/OSM (без поворота)
            </button>
            <button
              onClick={() => {
                setTransformType('affine');
                void persistGeoref(gcps, 'affine');
              }}
              className={`px-2.5 py-1 rounded-md transition ${
                transformType === 'affine'
                  ? 'bg-emerald-600 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="3+ точки: полное аффинное растяжение (если скан криво сфотографирован)"
            >
              Affine (3+ т.)
            </button>
          </div>

          {gcps.length > 0 && (
            <button
              onClick={clearAllGcps}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/50 border border-slate-700 hover:border-rose-500/40 text-xs text-slate-300 hover:text-rose-200 transition"
              title="Удалить все поставленные точки и начать привязку заново"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Сбросить точки ({gcps.length})
            </button>
          )}
        </div>

        {/* Clear Step-by-Step Banner + Done Button */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {!mapObj ? (
            <span className="px-3 py-1 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300 font-medium">
              Сначала загрузите файл карты кнопкой слева
            </span>
          ) : pendingPixel ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/20 border border-amber-400 text-amber-200 font-medium animate-pulse">
              <Crosshair className="w-3.5 h-3.5" />
              Точка #{nextPointNum}: теперь кликни это же место на карте OpenStreetMap СПРАВА →
            </span>
          ) : pendingLonLat ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/20 border border-amber-400 text-amber-200 font-medium animate-pulse">
              <Crosshair className="w-3.5 h-3.5" />
              Точка #{nextPointNum}: теперь кликни это же место на СКАНЕ КАРТЫ СЛЕВА ←
            </span>
          ) : gcps.length < 2 ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-sky-500/15 border border-sky-500/30 text-sky-300 font-medium">
              <Crosshair className="w-3.5 h-3.5" />
              Точка #{nextPointNum} из 2: кликни перекрёсток/ориентир на СКАНЕ СЛЕВА, затем его же на OSM СПРАВА
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Карта привязана ({gcps.length} т., поворот {liveSolution?.rotationDeg ?? 0}°) — можно двигать маркеры!
            </span>
          )}

          {liveSolution && onSwitchToReplay && (
            <button
              onClick={onSwitchToReplay}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold shadow-lg transition"
            >
              <PlayCircle className="w-4 h-4" />
              Готово — открыть Реплей и треки
            </button>
          )}
        </div>
      </div>

      {/* Split view: Left = Zoomable Scanned Image, Right = OSM MapLibre with live warped overlay */}
      <div className="grid grid-cols-1 lg:grid-cols-12 flex-1 min-h-0">
        {/* Left pane: Zoomable & Pannable Scanned Map */}
        <div className="lg:col-span-6 flex flex-col border-r border-slate-800 bg-slate-950 overflow-hidden">
          <div className="px-3 py-1.5 bg-slate-900/80 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
            <span className="font-medium text-emerald-300">
              1. Скан карты (колесо — зум, зажать мышь — двигать, клик — точка)
            </span>
            <div className="flex items-center gap-1.5">
              {(pendingPixel || pendingLonLat) && (
                <button
                  onClick={() => {
                    setPendingPixel(null);
                    setPendingLonLat(null);
                  }}
                  className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" /> Отменить клик
                </button>
              )}
              <button
                onClick={() =>
                  setScanZoom((z) => Math.max(0.8, Number((z / 1.25).toFixed(2))))
                }
                className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                title="Отдалить скан"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => {
                  setScanZoom(1);
                  setScanPan({ x: 0, y: 0 });
                }}
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[11px]"
                title="Сбросить масштаб скана"
              >
                {Math.round(scanZoom * 100)}%
              </button>
              <button
                onClick={() =>
                  setScanZoom((z) => Math.min(8, Number((z * 1.25).toFixed(2))))
                }
                className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                title="Приблизить скан"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div
            ref={scanViewportRef}
            onMouseDown={handleScanMouseDown}
            onMouseMove={handleScanMouseMove}
            onMouseUp={handleScanMouseUp}
            onWheel={handleScanWheel}
            className="relative flex-1 overflow-hidden flex items-center justify-center bg-slate-950 cursor-crosshair select-none"
          >
            {mapObj ? (
              <div
                style={{
                  transform: `translate(${scanPan.x}px, ${scanPan.y}px) scale(${scanZoom})`,
                  transformOrigin: 'center center',
                }}
                className="relative inline-block shadow-2xl border border-slate-800 transition-transform duration-75"
              >
                <img
                  ref={imgRef}
                  src={mapObj.imageUrl}
                  alt={mapObj.name}
                  draggable={false}
                  onLoad={handleImageLoad}
                  className="max-h-[62vh] max-w-full w-auto object-contain select-none pointer-events-none"
                />
                {/* Existing GCP pins on the scanned image (draggable!) */}
                {gcps.map((g, idx) => (
                  <div
                    key={g.id}
                    onMouseDown={(ev) => {
                      ev.stopPropagation();
                      draggingScanGcpIdRef.current = g.id;
                    }}
                    style={{
                      left: `${(g.px / mapObj.width) * 100}%`,
                      top: `${(g.py / mapObj.height) * 100}%`,
                      transform: `translate(-50%, -50%) scale(${1 / scanZoom})`,
                    }}
                    title={`Точка #${idx + 1} (можно перетащить мышью)`}
                    className="absolute w-6 h-6 rounded-full bg-emerald-500 border-2 border-white text-slate-950 font-bold text-xs flex items-center justify-center shadow-lg cursor-grab"
                  >
                    {idx + 1}
                  </div>
                ))}
                {/* Pending pixel marker on scan */}
                {pendingPixel && (
                  <div
                    style={{
                      left: `${(pendingPixel.px / mapObj.width) * 100}%`,
                      top: `${(pendingPixel.py / mapObj.height) * 100}%`,
                      transform: `translate(-50%, -50%) scale(${1 / scanZoom})`,
                    }}
                    className="absolute w-7 h-7 rounded-full bg-amber-400 border-2 border-white text-slate-950 font-bold text-xs flex items-center justify-center animate-bounce pointer-events-none shadow-xl"
                  >
                    ?
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center text-slate-500 space-y-2 p-6">
                <ImagePlus className="w-10 h-10 mx-auto text-slate-600" />
                <p className="text-sm">
                  Загрузите скан карты спортивного ориентирования или скриншот
                </p>
              </div>
            )}
          </div>

          {/* Compact GCP list at bottom of left pane */}
          <div className="h-36 border-t border-slate-800 bg-slate-900/70 overflow-y-auto p-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Точки привязки ({gcps.length} — достаточно 2 точек)
              </span>
              {saving && (
                <span className="text-[11px] text-emerald-400">
                  Сохранение...
                </span>
              )}
            </div>
            {gcps.length === 0 ? (
              <div className="text-xs text-slate-500 py-3 text-center">
                Точек пока нет. Кликните перекрёсток/ориентир №1 на скане выше, а затем его же на карте OpenStreetMap справа.
              </div>
            ) : (
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-800">
                    <th className="py-1">Точка</th>
                    <th className="py-1">На скане (X, Y)</th>
                    <th className="py-1">На карте OSM (Lat, Lon)</th>
                    <th className="py-1">Точность</th>
                    <th className="py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {(liveSolution?.gcpsWithResiduals ?? gcps).map((g, idx) => (
                    <tr
                      key={g.id}
                      className="border-b border-slate-800/60 hover:bg-slate-800/40"
                    >
                      <td className="py-1 font-bold text-emerald-400">
                        #{idx + 1}
                      </td>
                      <td className="py-1 font-mono text-slate-300">
                        {Math.round(g.px)}, {Math.round(g.py)}
                      </td>
                      <td className="py-1 font-mono text-slate-300">
                        {g.lat.toFixed(5)}, {g.lon.toFixed(5)}
                      </td>
                      <td className="py-1 font-mono">
                        {g.residualM !== undefined ? (
                          <span
                            className={
                              g.residualM < 15
                                ? 'text-emerald-400'
                                : 'text-amber-400'
                            }
                          >
                            ±{g.residualM} м
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-1 text-right">
                        <button
                          onClick={() => removeGcp(g.id)}
                          className="text-slate-400 hover:text-rose-400 p-1"
                          title="Удалить эту точку"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right pane: Interactive OSM / Satellite map + live warped preview */}
        <div className="lg:col-span-6 flex flex-col relative">
          <div className="px-3 py-1.5 bg-slate-900/80 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
            <span className="font-medium text-sky-300">
              2. Карта OpenStreetMap / Спутник (клик — поставить точку, маркеры 1-2 можно двигать)
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {liveSolution && (
                <>
                  <button
                    onClick={() => setShowOverlayOnOsm((v) => !v)}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border transition ${
                      showOverlayOnOsm
                        ? 'bg-emerald-600/25 border-emerald-500/50 text-emerald-300'
                        : 'bg-slate-800 border-slate-700 text-slate-400'
                    }`}
                    title="Включить/выключить показ наложенного скана поверх карты OSM"
                  >
                    {showOverlayOnOsm ? (
                      <Eye className="w-3.5 h-3.5" />
                    ) : (
                      <EyeOff className="w-3.5 h-3.5" />
                    )}
                    {showOverlayOnOsm ? 'Скан поверх OSM: ВКЛ' : 'Скан скрыт'}
                  </button>
                  <div className="flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-slate-400" />
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={overlayOpacity}
                      onChange={(e) => {
                        setShowOverlayOnOsm(true);
                        setOverlayOpacity(parseFloat(e.target.value));
                      }}
                      className="w-20 accent-emerald-500"
                      title="Прозрачность наложенного скана на карте OSM"
                    />
                  </div>
                </>
              )}

              <button
                onClick={() => {
                  const next = !useSatelliteBase;
                  setUseSatelliteBase(next);
                  const m = mapInstanceRef.current;
                  if (m && m.getLayer('satellite-tiles')) {
                    m.setPaintProperty(
                      'satellite-tiles',
                      'raster-opacity',
                      next ? 1 : 0
                    );
                  }
                }}
                className={`px-2 py-0.5 rounded border transition ${
                  useSatelliteBase
                    ? 'bg-sky-600 border-sky-400 text-white font-medium'
                    : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'
                }`}
              >
                {useSatelliteBase ? 'Спутник: ВКЛ' : 'Спутник / OSM'}
              </button>

              {(event.participants.length > 0 || gcps.length >= 2) && (
                <button
                  onClick={() => {
                    if (mapInstanceRef.current) {
                      fitMapToTracksOrGcps(mapInstanceRef.current, {
                        ...event,
                        map: event.map
                          ? { ...event.map, gcps }
                          : undefined,
                      });
                    }
                  }}
                  className="px-2 py-0.5 rounded bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/30"
                >
                  Центрировать
                </button>
              )}
            </div>
          </div>

          <div ref={mapContainerRef} className="flex-1 w-full min-h-[420px]" />
        </div>
      </div>
    </div>
  );
};

function fitMapToTracksOrGcps(map: maplibregl.Map, event: RaceEvent) {
  let minLon = Infinity,
    maxLon = -Infinity,
    minLat = Infinity,
    maxLat = -Infinity;
  let count = 0;

  const manualGcps = cleanManualGcps(event.map?.gcps);
  for (const g of manualGcps) {
    if (g.lon < minLon) minLon = g.lon;
    if (g.lon > maxLon) maxLon = g.lon;
    if (g.lat < minLat) minLat = g.lat;
    if (g.lat > maxLat) maxLat = g.lat;
    count++;
  }

  if (count === 0) {
    for (const p of event.participants) {
      for (const pt of p.points) {
        if (pt.lon < minLon) minLon = pt.lon;
        if (pt.lon > maxLon) maxLon = pt.lon;
        if (pt.lat < minLat) minLat = pt.lat;
        if (pt.lat > maxLat) maxLat = pt.lat;
        count++;
      }
    }
  }

  if (count >= 2) {
    map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      { padding: 60, maxZoom: 16, duration: 500 }
    );
  }
}
