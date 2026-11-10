import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  CheckCircle2,
  Crosshair,
  ImagePlus,
  Layers,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react';
import { solveGeoref } from '../../shared/georef.js';
import type { GCP, RaceEvent, TransformType } from '../../shared/types.js';

interface Props {
  event: RaceEvent;
  onEventUpdated: (evt: RaceEvent) => void;
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

export const GeorefWorkspace: React.FC<Props> = ({ event, onEventUpdated }) => {
  const mapObj = event.map;
  const [gcps, setGcps] = useState<GCP[]>(mapObj?.gcps ?? []);
  const [transformType, setTransformType] = useState<TransformType>(
    mapObj?.transformType ?? 'similarity'
  );
  const [pendingPixel, setPendingPixel] = useState<{
    px: number;
    py: number;
  } | null>(null);
  const [overlayOpacity, setOverlayOpacity] = useState<number>(0.72);
  const [useSatelliteBase, setUseSatelliteBase] = useState<boolean>(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  useEffect(() => {
    setGcps(event.map?.gcps ?? []);
    setTransformType(event.map?.transformType ?? 'similarity');
    setPendingPixel(null);
  }, [event.id, event.map?.id]);

  // Compute live solution on the client
  const liveSolution =
    mapObj && gcps.length >= 2
      ? solveGeoref(gcps, mapObj.width, mapObj.height, transformType)
      : null;

  // Initialize MapLibre right-hand map with Satellite + Hybrid OSM road overlay
  useEffect(() => {
    if (!mapContainerRef.current) return;
    const firstRunnerPt = event.participants[0]?.points[0];
    const initialCenter: [number, number] =
      gcps.length > 0
        ? [gcps[0].lon, gcps[0].lat]
        : firstRunnerPt
          ? [firstRunnerPt.lon, firstRunnerPt.lat]
          : [32.4245, 34.772];

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: OSM_STYLE,
      center: initialCenter,
      zoom: 13.5,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapInstanceRef.current = map;

    map.on('load', () => {
      if (event.participants.length > 0) {
        fitMapToTracksOrGcps(map, event);
      }
    });

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Handle click on OSM map when a pending pixel is waiting for its world coordinate
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const handleMapClick = (e: maplibregl.MapMouseEvent) => {
      if (!pendingPixel) return;
      const newGcp: GCP = {
        id: `gcp-${Date.now()}`,
        label: `Точка #${gcps.length + 1}`,
        px: Math.round(pendingPixel.px),
        py: Math.round(pendingPixel.py),
        lon: Number(e.lngLat.lng.toFixed(6)),
        lat: Number(e.lngLat.lat.toFixed(6)),
      };
      const updated = [...gcps, newGcp];
      setGcps(updated);
      setPendingPixel(null);
      void persistGeoref(updated, transformType);
    };

    map.on('click', handleMapClick);
    return () => {
      map.off('click', handleMapClick);
    };
  }, [pendingPixel, gcps, transformType]);

  // Sync GCP markers and live raster overlay onto MapLibre
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const syncLayers = () => {
      // Remove previous markers
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];

      // Add draggable markers for each GCP
      gcps.forEach((g, idx) => {
        const el = document.createElement('div');
        el.className =
          'w-6 h-6 rounded-full bg-emerald-500 border-2 border-white text-slate-950 font-bold text-xs flex items-center justify-center shadow-lg cursor-grab';
        el.textContent = String(idx + 1);

        const marker = new maplibregl.Marker({ element: el, draggable: true })
          .setLngLat([g.lon, g.lat])
          .addTo(map);

        marker.on('dragend', () => {
          const pos = marker.getLngLat();
          const next = gcps.map((item) =>
            item.id === g.id
              ? {
                  ...item,
                  lon: Number(pos.lng.toFixed(6)),
                  lat: Number(pos.lat.toFixed(6)),
                }
              : item
          );
          setGcps(next);
          void persistGeoref(next, transformType);
        });

        markersRef.current.push(marker);
      });

      // Update or add warped raster image overlay
      const sourceId = 'georef-preview';
      const layerId = 'georef-preview-layer';
      if (mapObj && liveSolution?.cornersLonLat) {
        const existingSource = map.getSource(
          sourceId
        ) as maplibregl.ImageSource | undefined;
        if (existingSource) {
          existingSource.updateImage({
            url: mapObj.imageUrl,
            coordinates: liveSolution.cornersLonLat,
          });
          if (map.getLayer(layerId)) {
            map.setPaintProperty(layerId, 'raster-opacity', overlayOpacity);
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
              'raster-opacity': overlayOpacity,
              'raster-fade-duration': 0,
            },
          });
        }
      } else {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      }
          // Render GPS tracks on the OSM map so user can align Google screenshot directly onto tracks & common start
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
    };

    if (map.isStyleLoaded()) {
      syncLayers();
    } else {
      map.once('load', syncLayers);
    }
  }, [gcps, liveSolution, mapObj, overlayOpacity, transformType, event.participants]);

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
      // Measure natural image dimensions before uploading
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
      setUploading(false);
    }
  }

  function handleImageClick(e: React.MouseEvent<HTMLImageElement>) {
    if (!imgRef.current || !mapObj) return;
    const rect = imgRef.current.getBoundingClientRect();
    const actualWidth = imgRef.current.naturalWidth || mapObj.width;
    const actualHeight = imgRef.current.naturalHeight || mapObj.height;
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    const px = relX * actualWidth;
    const py = relY * actualHeight;
    setPendingPixel({ px, py });
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

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100">
      {/* Top toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-slate-900 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium cursor-pointer transition">
            <Upload className="w-3.5 h-3.5" />
            {uploading
              ? 'Загрузка...'
              : 'Загрузить карту (PNG / JPG / скрин)'}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileUpload}
            />
          </label>

          <div className="flex items-center gap-1 bg-slate-800 p-0.5 rounded-lg text-xs">
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
              title="Север сверху (без поворота): идеально для скринов Google Maps / OSM — достаточно 2 точек!"
            >
              Скрин Google/OSM (2 т., без поворота)
            </button>
            <button
              onClick={() => {
                setTransformType('similarity');
                void persistGeoref(gcps, 'similarity');
              }}
              className={`px-2.5 py-1 rounded-md transition ${
                transformType === 'similarity'
                  ? 'bg-slate-700 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="2+ точки: масштаб + поворот + сдвиг"
            >
              С поворотом (2+ т.)
            </button>
            <button
              onClick={() => {
                setTransformType('affine');
                void persistGeoref(gcps, 'affine');
              }}
              className={`px-2.5 py-1 rounded-md transition ${
                transformType === 'affine'
                  ? 'bg-slate-700 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="3+ точки: полное аффинное преобразование по МНК"
            >
              Affine (3+ т.)
            </button>
          </div>
        </div>

        {/* Status banner */}
        <div className="flex items-center gap-4 text-xs">
          {pendingPixel ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300 animate-pulse">
              <Crosshair className="w-3.5 h-3.5" />
              Шаг 2: кликни на эту же точку на карте OSM справа
            </span>
          ) : (
            <span className="text-slate-400">
              Шаг 1: кликни ориентир на картинке слева → затем на карте OSM
              справа
            </span>
          )}

          {liveSolution && (
            <div className="flex items-center gap-3 px-3 py-1 rounded-lg bg-slate-800 border border-slate-700">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>
                Сomputed RMS:{' '}
                <strong
                  className={
                    liveSolution.rmsErrorM < 15
                      ? 'text-emerald-400'
                      : 'text-amber-400'
                  }
                >
                  {liveSolution.rmsErrorM} м
                </strong>
              </span>
              <span className="text-slate-400">
                Поворот: {liveSolution.rotationDeg}°
              </span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Layers className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-slate-400">Прозрачность:</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={overlayOpacity}
              onChange={(e) => setOverlayOpacity(parseFloat(e.target.value))}
              className="w-24 accent-emerald-500"
            />
          </div>
        </div>
      </div>

      {/* Split view: Left = Raster Image, Right = OSM MapLibre with live warped overlay */}
      <div className="grid grid-cols-1 lg:grid-cols-12 flex-1 min-h-0">
        {/* Left pane: Raw uploaded image */}
        <div className="lg:col-span-5 flex flex-col border-r border-slate-800 bg-slate-950 overflow-hidden">
          <div className="px-3 py-1.5 bg-slate-900/60 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
            <span>
              1. Исходная растровая карта ({mapObj?.width}×{mapObj?.height} px)
            </span>
            {pendingPixel && (
              <button
                onClick={() => setPendingPixel(null)}
                className="text-amber-400 hover:underline flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" /> Отменить точку
              </button>
            )}
          </div>

          <div className="relative flex-1 overflow-auto flex items-center justify-center p-3 bg-slate-950">
            {mapObj ? (
              <div className="relative inline-block shadow-2xl border border-slate-800">
                <img
                  ref={imgRef}
                  src={mapObj.imageUrl}
                  alt={mapObj.name}
                  onLoad={handleImageLoad}
                  onClick={handleImageClick}
                  className="max-h-[58vh] w-auto object-contain cursor-crosshair select-none"
                />
                {/* Render existing GCP pins on the image */}
                {gcps.map((g, idx) => (
                  <div
                    key={g.id}
                    style={{
                      left: `${(g.px / mapObj.width) * 100}%`,
                      top: `${(g.py / mapObj.height) * 100}%`,
                    }}
                    className="absolute -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-emerald-500 border-2 border-white text-slate-950 font-bold text-xs flex items-center justify-center shadow-md pointer-events-none"
                  >
                    {idx + 1}
                  </div>
                ))}
                {/* Pending pixel marker */}
                {pendingPixel && (
                  <div
                    style={{
                      left: `${(pendingPixel.px / mapObj.width) * 100}%`,
                      top: `${(pendingPixel.py / mapObj.height) * 100}%`,
                    }}
                    className="absolute -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-amber-400 border-2 border-white text-slate-950 font-bold text-xs flex items-center justify-center animate-bounce pointer-events-none"
                  >
                    ?
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center text-slate-500 space-y-2">
                <ImagePlus className="w-10 h-10 mx-auto text-slate-600" />
                <p className="text-sm">Загрузите скрин карты или карту ориентирования</p>
              </div>
            )}
          </div>

          {/* GCP table with residuals */}
          <div className="h-44 border-t border-slate-800 bg-slate-900/70 overflow-y-auto p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Контрольные точки привязки ({gcps.length})
              </span>
              {saving && (
                <span className="text-[11px] text-emerald-400">
                  Сохранение...
                </span>
              )}
            </div>
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="text-slate-400 border-b border-slate-800">
                  <th className="py-1">#</th>
                  <th className="py-1">Пиксели (X, Y)</th>
                  <th className="py-1">Координаты (Lat, Lon)</th>
                  <th className="py-1">Невязка</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {(liveSolution?.gcpsWithResiduals ?? gcps).map((g, idx) => (
                  <tr
                    key={g.id}
                    className="border-b border-slate-800/60 hover:bg-slate-800/40"
                  >
                    <td className="py-1.5 font-bold text-emerald-400">
                      #{idx + 1}
                    </td>
                    <td className="py-1.5 font-mono text-slate-300">
                      {Math.round(g.px)}, {Math.round(g.py)}
                    </td>
                    <td className="py-1.5 font-mono text-slate-300">
                      {g.lat.toFixed(5)}, {g.lon.toFixed(5)}
                    </td>
                    <td className="py-1.5 font-mono">
                      {g.residualM !== undefined ? (
                        <span
                          className={
                            g.residualM < 15
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                          }
                        >
                          {g.residualM} м
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        onClick={() => removeGcp(g.id)}
                        className="text-slate-500 hover:text-rose-400 p-1"
                        title="Удалить точку"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right pane: Interactive OSM map + warped overlay */}
        <div className="lg:col-span-7 flex flex-col relative">
          <div className="px-3 py-1.5 bg-slate-900/60 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
            <span>
              2. Подложка + предпросмотр наложенной карты и GPS-треков (маркеры
              можно перетаскивать)
            </span>
            <div className="flex items-center gap-1.5">
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
                {useSatelliteBase ? 'Спутник (вкл)' : 'Подложка: Спутник / OSM'}
              </button>
              {event.participants.length > 0 && (
                <button
                  onClick={() => {
                    if (mapInstanceRef.current) {
                      fitMapToTracksOrGcps(mapInstanceRef.current, event);
                    }
                  }}
                  className="px-2 py-0.5 rounded bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/30"
                >
                  Показать мои треки
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

  for (const p of event.participants) {
    for (const pt of p.points) {
      if (pt.lon < minLon) minLon = pt.lon;
      if (pt.lon > maxLon) maxLon = pt.lon;
      if (pt.lat < minLat) minLat = pt.lat;
      if (pt.lat > maxLat) maxLat = pt.lat;
      count++;
    }
  }
  if (count === 0 && event.map?.gcps) {
    for (const g of event.map.gcps) {
      if (g.lon < minLon) minLon = g.lon;
      if (g.lon > maxLon) maxLon = g.lon;
      if (g.lat < minLat) minLat = g.lat;
      if (g.lat > maxLat) maxLat = g.lat;
      count++;
    }
  }
  if (count >= 2) {
    map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      { padding: 50, maxZoom: 16.5, duration: 600 }
    );
  }
}

