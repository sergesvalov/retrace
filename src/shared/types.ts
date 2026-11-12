export type TransformType = 'similarity' | 'affine';
export type TimeMode = 'from_start' | 'real';
/** orienteering: map scan + controls + route-choice tools; run: plain run/hike on a base map */
export type EventKind = 'orienteering' | 'run';
export type BaseLayer = 'topo' | 'osm' | 'satellite';
/**
 * orienteering: printed/scanned O-map — drawn to magnetic north, known print scale;
 * screenshot: Google Maps / web map screenshot — true north, Web Mercator, scale from its scale bar
 */
export type MapImageKind = 'orienteering' | 'screenshot';

export const EVENT_KINDS: readonly EventKind[] = ['orienteering', 'run'];
export const MAP_IMAGE_KINDS: readonly MapImageKind[] = [
  'orienteering',
  'screenshot',
];

/** Events saved before event kinds existed were all orienteering analyses */
export function eventKindOf(evt: { kind?: EventKind }): EventKind {
  return evt.kind ?? 'orienteering';
}

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
  /** What the image is; decides whether magnetic declination applies (default: orienteering) */
  imageKind?: MapImageKind;
  /** Print scale denominator of an O-map, e.g. 10000 for 1:10 000 */
  printScale?: number;
  /** Scan resolution, dots per inch */
  scanDpi?: number;
  /** Magnetic declination used for the map's north, degrees (east positive) */
  declinationDeg?: number;
  /** Course controls in map-image pixels, in course order (start → … → finish) */
  controls?: CourseControl[];
}

export type ControlKind = 'start' | 'control' | 'finish';
export const CONTROL_KINDS: readonly ControlKind[] = ['start', 'control', 'finish'];

/** A control drawn on the map image: it moves together with the map placement */
export interface CourseControl {
  id: string;
  kind: ControlKind;
  px: number;
  py: number;
}

/**
 * A control placed straight on the base map (an event without a map scan, or a course marked
 * on the ground): plain coordinates, it never moves with a scan
 */
export interface GroundControl {
  id: string;
  kind: ControlKind;
  lon: number;
  lat: number;
}

/** Map metadata the client may change together with a placement */
export type MapOverlayMeta = Partial<
  Pick<MapOverlay, 'imageKind' | 'printScale' | 'scanDpi' | 'declinationDeg'>
>;

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
  /** Missing on events created before kinds existed — read it via `eventKindOf` */
  kind?: EventKind;
  timeMode: TimeMode;
  map?: MapOverlay;
  /**
   * Course marked on the base map (start → controls → finish). When it is not empty it is
   * the course, scan or not; otherwise the controls drawn on the scan (`map.controls`) are.
   */
  course?: GroundControl[];
  participants: ParticipantTrack[];
}
