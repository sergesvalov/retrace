export type TransformType = 'similarity' | 'affine';
export type TimeMode = 'from_start' | 'real';

export interface GCP {
  id: string;
  label: string;
  px: number; // pixel X on image (0..width)
  py: number; // pixel Y on image (0..height)
  lon: number;
  lat: number;
  residualM?: number;
}

export interface MapOverlay {
  id: string;
  name: string;
  imageUrl: string;
  width: number;
  height: number;
  gcps: GCP[];
  transformType: TransformType;
  /** 2x3 affine matrix [a, b, tx, c, d, ty] mapping (px, py) -> WebMercator (x, y) */
  matrix?: [number, number, number, number, number, number];
  /** 4 corners in [lon, lat]: top-left, top-right, bottom-right, bottom-left (MapLibre image source order) */
  cornersLonLat?: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  rmsErrorM?: number;
  rotationDeg?: number;
  /** True once the user has placed the map by hand (drag, sliders, pins, GCPs); auto-fit must not overwrite it */
  manuallyPlaced?: boolean;
}

export interface TrackPoint {
  /** Seconds from track start (0..duration) */
  t: number;
  /** Absolute epoch ms */
  absTimeMs: number;
  lat: number;
  lon: number;
  ele?: number;
  hr?: number;
  cad?: number;
  /** Cumulative distance in meters */
  distM: number;
  /** Smoothed speed in m/s */
  speedMs: number;
}

export interface ParticipantTrack {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  sourceFormat: 'gpx' | 'fit' | 'tcx';
  startedAtIso: string;
  /** Manual offset in seconds applied during replay */
  offsetSec: number;
  /** Trim start in seconds */
  trimStartSec: number;
  /** Trim end in seconds */
  trimEndSec: number;
  totalDistanceM: number;
  durationSec: number;
  avgSpeedMs: number;
  maxSpeedMs: number;
  points: TrackPoint[];
}

export interface RaceEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  createdAt: string;
  timeMode: TimeMode;
  map?: MapOverlay;
  participants: ParticipantTrack[];
}
