import type { GCP, TransformType } from './types.js';

const EARTH_RADIUS = 6378137.0;
const MAX_LAT = 85.05112877980659;

/** Convert [lon, lat] in degrees to Web Mercator EPSG:3857 [x, y] in meters */
export function lonLatToMercator(lon: number, lat: number): [number, number] {
  const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const x = (lon * Math.PI * EARTH_RADIUS) / 180.0;
  const y =
    Math.log(Math.tan(((90.0 + clampedLat) * Math.PI) / 360.0)) * EARTH_RADIUS;
  return [x, y];
}

/** Convert Web Mercator EPSG:3857 [x, y] in meters to [lon, lat] in degrees */
export function mercatorToLonLat(x: number, y: number): [number, number] {
  const lon = (x * 180.0) / (Math.PI * EARTH_RADIUS);
  const lat =
    (360.0 * Math.atan(Math.exp(y / EARTH_RADIUS))) / Math.PI - 90.0;
  return [lon, lat];
}

/** Haversine distance in meters between two [lon, lat] points */
export function haversineDistanceM(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
): number {
  const toRad = Math.PI / 180.0;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) *
      Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Solve 3x3 linear system A * x = b using Gaussian elimination with partial pivoting.
 */
function solve3x3(A: number[][], b: number[]): [number, number, number] | null {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(M[pivot][col]) < 1e-11) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    for (let j = col; j < 4; j++) M[col][j] /= div;
    for (let row = 0; row < 3; row++) {
      if (row !== col) {
        const factor = M[row][col];
        for (let j = col; j < 4; j++) {
          M[row][j] -= factor * M[col][j];
        }
      }
    }
  }
  return [M[0][3], M[1][3], M[2][3]];
}

/**
 * Compute initial auto-fit North-Up matrix & corners from the bounding box of GPS tracks
 * so a newly uploaded map immediately lands right on top of the runners' tracks.
 */
export function autoPlaceScreenshotOnBounds(
  width: number,
  height: number,
  bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number }
): {
  matrix: [number, number, number, number, number, number];
  cornersLonLat: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
} {
  const [minX, minY] = lonLatToMercator(bounds.minLon, bounds.minLat);
  const [maxX, maxY] = lonLatToMercator(bounds.maxLon, bounds.maxLat);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const spanX = Math.max(300, (maxX - minX) * 1.75);
  const spanY = Math.max(300, (maxY - minY) * 1.75);

  const s = Math.max(spanX / width, spanY / height);
  const tx = centerX - (s * width) / 2;
  const ty = centerY + (s * height) / 2;
  const matrix: [number, number, number, number, number, number] = [
    s,
    0,
    tx,
    0,
    -s,
    ty,
  ];

  const cornersLonLat = matrixToCorners(matrix, width, height);

  return { matrix, cornersLonLat };
}

/** Compute the 4 corners [topLeft, topRight, bottomRight, bottomLeft] in [lon, lat] for MapLibre ImageSource */
export function matrixToCorners(
  matrix: [number, number, number, number, number, number],
  width: number,
  height: number
): [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
] {
  return [
    pixelToLonLat(matrix, 0, 0),
    pixelToLonLat(matrix, width, 0),
    pixelToLonLat(matrix, width, height),
    pixelToLonLat(matrix, 0, height),
  ];
}

/**
 * Fit 2D Similarity transform (4 DOF: scale, rotation, tx, ty) in Web Mercator:
 *   X = a * px - b * py + tx
 *   Y = b * px + a * py + ty
 * Returned as 2x3 affine matrix [a, b, tx, b, -a, ty].
 */
export function fitSimilarityTransform(
  gcps: GCP[]
): [number, number, number, number, number, number] | null {
  if (gcps.length < 2) return null;
  const n = gcps.length;
  const pts = gcps.map((g) => {
    const [mx, my] = lonLatToMercator(g.lon, g.lat);
    return { px: g.px, py: g.py, mx, my };
  });

  let meanPx = 0,
    meanPy = 0,
    meanMx = 0,
    meanMy = 0;
  for (const p of pts) {
    meanPx += p.px;
    meanPy += p.py;
    meanMx += p.mx;
    meanMy += p.my;
  }
  meanPx /= n;
  meanPy /= n;
  meanMx /= n;
  meanMy /= n;

  let denom = 0;
  let numA = 0;
  let numB = 0;
  for (const p of pts) {
    const u = p.px - meanPx;
    const v = -(p.py - meanPy);
    const dx = p.mx - meanMx;
    const dy = p.my - meanMy;
    denom += u * u + v * v;
    numA += u * dx + v * dy;
    numB += u * dy - v * dx;
  }
  if (denom < 1e-9) return null;
  const a = numA / denom;
  const b = numB / denom;
  const tx = meanMx - a * meanPx - b * meanPy;
  const ty = meanMy - b * meanPx + a * meanPy;
  return [a, b, tx, b, -a, ty];
}

/**
 * Fit 2D Affine transform (6 DOF) via Ordinary Least Squares in Web Mercator:
 *   X = a * px + b * py + tx
 *   Y = c * px + d * py + ty
 * Includes collinearity safeguard: if the 3+ points lie nearly on a straight line
 * (causing extreme anisotropy > 1.45x or reflection), smoothly regularizes toward Similarity.
 */
export function fitAffineTransform(
  gcps: GCP[]
): [number, number, number, number, number, number] | null {
  if (gcps.length < 3) return null;

  let sxx = 0,
    sxy = 0,
    sx1 = 0,
    syy = 0,
    sy1 = 0;
  let sxX = 0,
    syX = 0,
    s1X = 0;
  let sxY = 0,
    syY = 0,
    s1Y = 0;
  const n = gcps.length;

  for (const g of gcps) {
    const [X, Y] = lonLatToMercator(g.lon, g.lat);
    const x = g.px;
    const y = g.py;
    sxx += x * x;
    sxy += x * y;
    sx1 += x;
    syy += y * y;
    sy1 += y;

    sxX += x * X;
    syX += y * X;
    s1X += X;

    sxY += x * Y;
    syY += y * Y;
    s1Y += Y;
  }

  const A = [
    [sxx, sxy, sx1],
    [sxy, syy, sy1],
    [sx1, sy1, n],
  ];
  const rowX = solve3x3(A, [sxX, syX, s1X]);
  const rowY = solve3x3(A, [sxY, syY, s1Y]);
  if (!rowX || !rowY) return fitSimilarityTransform(gcps);

  const [a, b, tx] = rowX;
  const [c, d, ty] = rowY;

  const det = a * d - b * c;
  const frobSq = a * a + b * b + c * c + d * d;
  const disc = Math.max(0, frobSq * frobSq - 4 * det * det);
  const sMax = Math.sqrt(Math.max(0, (frobSq + Math.sqrt(disc)) / 2));
  const sMin = Math.sqrt(Math.max(0, (frobSq - Math.sqrt(disc)) / 2));

  if (det >= 0 || sMin < 1e-7 || sMax / sMin > 1.45) {
    const sim = fitSimilarityTransform(gcps);
    if (!sim) return [a, b, tx, c, d, ty];
    if (det >= 0 || sMin < 1e-7 || sMax / sMin > 2.2) {
      return sim;
    }
    const wAff = 0.65;
    const wSim = 0.35;
    return [
      wAff * a + wSim * sim[0],
      wAff * b + wSim * sim[1],
      wAff * tx + wSim * sim[2],
      wAff * c + wSim * sim[3],
      wAff * d + wSim * sim[4],
      wAff * ty + wSim * sim[5],
    ];
  }

  return [a, b, tx, c, d, ty];
}

/** Apply affine matrix [a, b, tx, c, d, ty] to image pixel (px, py) -> [lon, lat] */
export function pixelToLonLat(
  matrix: [number, number, number, number, number, number],
  px: number,
  py: number
): [number, number] {
  const [a, b, tx, c, d, ty] = matrix;
  const mx = a * px + b * py + tx;
  const my = c * px + d * py + ty;
  return mercatorToLonLat(mx, my);
}

/** Inverse transform: [lon, lat] -> image pixel [px, py] */
export function lonLatToPixel(
  matrix: [number, number, number, number, number, number],
  lon: number,
  lat: number
): [number, number] | null {
  const [a, b, tx, c, d, ty] = matrix;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  const [mx, my] = lonLatToMercator(lon, lat);
  const dx = mx - tx;
  const dy = my - ty;
  const px = (d * dx - b * dy) / det;
  const py = (-c * dx + a * dy) / det;
  return [px, py];
}

/**
 * Apply shift (dEastM, dNorthM), scale (scaleFactor), X-stretch (stretchXFactor), and rotation (dAngleDeg)
 * around a geographic anchor point `anchorLonLat` (e.g. the GPS Start point, so the Start never moves
 * while scaling or rotating!) or around the image center if no anchor is given.
 */
export function nudgeMapMatrix(
  matrix: [number, number, number, number, number, number],
  width: number,
  height: number,
  nudge: {
    dEastM?: number;
    dNorthM?: number;
    scaleFactor?: number;
    stretchXFactor?: number;
    dAngleDeg?: number;
    anchorLonLat?: [number, number];
  }
): {
  matrix: [number, number, number, number, number, number];
  cornersLonLat: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
} {
  const [a, b, tx, c, d, ty] = matrix;

  let pivotMx: number;
  let pivotMy: number;
  if (nudge.anchorLonLat) {
    [pivotMx, pivotMy] = lonLatToMercator(
      nudge.anchorLonLat[0],
      nudge.anchorLonLat[1]
    );
  } else {
    const cx = width / 2;
    const cy = height / 2;
    pivotMx = a * cx + b * cy + tx;
    pivotMy = c * cx + d * cy + ty;
  }

  const k = nudge.scaleFactor ?? 1;
  const sx = nudge.stretchXFactor ?? 1;
  const rad = ((nudge.dAngleDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad) * k;
  const sin = Math.sin(rad) * k;

  // Apply image-space X stretch first (a*sx, c*sx), then world-space scale & rotation around pivot
  const as = a * sx;
  const cs = c * sx;

  // Compute pixel under pivot before stretch so pivot remains invariant under stretch too
  const det = a * d - b * c;
  let pivotPx = width / 2;
  let pivotPy = height / 2;
  if (Math.abs(det) > 1e-12) {
    const dx = pivotMx - tx;
    const dy = pivotMy - ty;
    pivotPx = (d * dx - b * dy) / det;
    pivotPy = (-c * dx + a * dy) / det;
  }

  const na = cos * as - sin * cs;
  const nb = cos * b - sin * d;
  const nc = sin * as + cos * cs;
  const nd = sin * b + cos * d;

  const ntx =
    pivotMx - (na * pivotPx + nb * pivotPy) + (nudge.dEastM ?? 0);
  const nty =
    pivotMy - (nc * pivotPx + nd * pivotPy) + (nudge.dNorthM ?? 0);

  const nextMatrix: [number, number, number, number, number, number] = [
    na,
    nb,
    ntx,
    nc,
    nd,
    nty,
  ];

  const cornersLonLat = matrixToCorners(nextMatrix, width, height);

  return { matrix: nextMatrix, cornersLonLat };
}

export interface LonLatBounds {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

/** Shift a placement (scale and rotation unchanged) so the image centre lands on `lon`,`lat` */
export function translateMatrixCenterTo(
  matrix: [number, number, number, number, number, number],
  width: number,
  height: number,
  lon: number,
  lat: number
): [number, number, number, number, number, number] {
  const [a, b, , c, d] = matrix;
  const [mx, my] = lonLatToMercator(lon, lat);
  const cx = width / 2;
  const cy = height / 2;
  return [a, b, mx - (a * cx + b * cy), c, d, my - (c * cx + d * cy)];
}

/** Lon/lat bounding box of the four image corners under a placement */
export function matrixBounds(
  matrix: [number, number, number, number, number, number],
  width: number,
  height: number
): LonLatBounds {
  const corners = matrixToCorners(matrix, width, height);
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  return {
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons),
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
  };
}

export function boundsOverlap(a: LonLatBounds, b: LonLatBounds): boolean {
  return (
    a.minLon <= b.maxLon &&
    b.minLon <= a.maxLon &&
    a.minLat <= b.maxLat &&
    b.minLat <= a.maxLat
  );
}

/**
 * Bounds for `autoPlaceScreenshotOnBounds` that make the image cover about `share` of the
 * given view (that function pads its input by 1.75×).
 */
export function boundsForViewShare(view: LonLatBounds, share = 0.7): LonLatBounds {
  const k = share / 1.75 / 2;
  const cLon = (view.minLon + view.maxLon) / 2;
  const cLat = (view.minLat + view.maxLat) / 2;
  const hLon = (view.maxLon - view.minLon) * k;
  const hLat = (view.maxLat - view.minLat) * k;
  return {
    minLon: cLon - hLon,
    maxLon: cLon + hLon,
    minLat: cLat - hLat,
    maxLat: cLat + hLat,
  };
}

/** Ground metres per image pixel of a scan printed at 1:`printScale` and scanned at `dpi` */
export function groundMetersPerPixelFromPrint(
  printScale: number,
  dpi: number
): number {
  return (printScale * 0.0254) / dpi;
}

/**
 * Ground metres per image pixel of a placement matrix at latitude `lat`
 * (Web Mercator metres are stretched by 1/cos(lat) relative to ground metres).
 * For a non-uniform (affine) matrix this is the geometric mean of both axes.
 */
export function matrixGroundMetersPerPixel(
  matrix: [number, number, number, number, number, number],
  lat: number
): number {
  const [a, b, , c, d] = matrix;
  return Math.sqrt(Math.abs(a * d - b * c)) * Math.cos((lat * Math.PI) / 180);
}

/** Bearing (deg, clockwise from true north) that the image's "up" direction points to */
export function matrixUpBearingDeg(
  matrix: [number, number, number, number, number, number]
): number {
  const [, b, , , d] = matrix;
  // Image up = pixel (0, -1) -> mercator (-b, -d): east component -b, north component -d
  return (Math.atan2(-b, -d) * 180) / Math.PI;
}

/**
 * Rebuild a North-Up-like placement with an exact ground scale and orientation while the
 * map point under `anchorLonLat` (e.g. the Start triangle) stays exactly where it is.
 *
 * `upBearingDeg` is where the image's up direction must point: for an orienteering map
 * this is the magnetic declination (O-maps are drawn to magnetic north), for a
 * Google Maps screenshot it is 0 (true north).
 */
export function buildScaledOrientedMatrix(
  currentMatrix: [number, number, number, number, number, number],
  anchorLonLat: [number, number],
  groundMetersPerPixel: number,
  upBearingDeg: number
): [number, number, number, number, number, number] | null {
  const anchorPx = lonLatToPixel(currentMatrix, anchorLonLat[0], anchorLonLat[1]);
  if (!anchorPx || !(groundMetersPerPixel > 0)) return null;
  const s = groundMetersPerPixel / Math.cos((anchorLonLat[1] * Math.PI) / 180);
  // Image up must point to `upBearingDeg`, i.e. rotate the north-up matrix clockwise by it
  const theta = (-upBearingDeg * Math.PI) / 180;
  const a = s * Math.cos(theta);
  const b = s * Math.sin(theta);
  const c = s * Math.sin(theta);
  const d = -s * Math.cos(theta);
  const [mx, my] = lonLatToMercator(anchorLonLat[0], anchorLonLat[1]);
  const tx = mx - (a * anchorPx[0] + b * anchorPx[1]);
  const ty = my - (c * anchorPx[0] + d * anchorPx[1]);
  return [a, b, tx, c, d, ty];
}

/**
 * Ground metres per image pixel measured from a scale bar: the user clicks both ends of the
 * bar on the displayed map (`p1`, `p2` in lon/lat under the current placement) and enters its length.
 */
export function groundMetersPerPixelFromScaleBar(
  currentMatrix: [number, number, number, number, number, number],
  p1: [number, number],
  p2: [number, number],
  barLengthM: number
): number | null {
  const px1 = lonLatToPixel(currentMatrix, p1[0], p1[1]);
  const px2 = lonLatToPixel(currentMatrix, p2[0], p2[1]);
  if (!px1 || !px2 || !(barLengthM > 0)) return null;
  const pxDist = Math.hypot(px2[0] - px1[0], px2[1] - px1[1]);
  if (pxDist < 3) return null;
  return barLengthM / pxDist;
}

/**
 * Compute smooth Inverse-Distance-Weighted (Shepard Rubber-Sheeting) pixel displacement (dx, dy)
 * at quad coordinate (u, v) for 3+ control points so local orienteering map distortions
 * (ISOM generalization, ridges/valleys, camera perspective) vanish at every pinned control point.
 */
export function computeRubberSheetDisplacement(
  u: number,
  v: number,
  width: number,
  height: number,
  gcps: GCP[],
  matrix: [number, number, number, number, number, number]
): [number, number] {
  if (gcps.length < 3) return [0, 0];

  const anchors: Array<{ u: number; v: number; dx: number; dy: number }> = [];
  let maxResidualPx = 0;

  for (const g of gcps) {
    const uv = lonLatToPixel(matrix, g.lon, g.lat);
    if (!uv) continue;
    const dx = g.px - uv[0];
    const dy = g.py - uv[1];
    maxResidualPx = Math.max(maxResidualPx, Math.hypot(dx, dy));
    anchors.push({ u: uv[0], v: uv[1], dx, dy });
  }

  if (maxResidualPx < 0.75 || anchors.length === 0) return [0, 0];

  const cornerWeightFactor = 0.18;
  const corners = [
    { u: 0, v: 0 },
    { u: width, v: 0 },
    { u: width, v: height },
    { u: 0, v: height },
  ];

  let sumW = 0;
  let sumDx = 0;
  let sumDy = 0;

  for (const a of anchors) {
    const d2 = (u - a.u) * (u - a.u) + (v - a.v) * (v - a.v);
    if (d2 < 1e-3) return [a.dx, a.dy];
    const w = 1 / Math.pow(d2 + 400, 1.35);
    sumW += w;
    sumDx += w * a.dx;
    sumDy += w * a.dy;
  }

  for (const c of corners) {
    const d2 = (u - c.u) * (u - c.u) + (v - c.v) * (v - c.v);
    const w = cornerWeightFactor / Math.pow(d2 + 2500, 1.35);
    sumW += w;
  }

  if (sumW < 1e-12) return [0, 0];
  return [sumDx / sumW, sumDy / sumW];
}

/**
 * Add a persistent Pin ("Булавка КАРТА -> ТРЕК") directly from a click on the displayed map (`mapLonLat`)
 * and a click on the GPS track (`trackLonLat`).
 */
export function addPinMapToTrack(
  currentMatrix: [number, number, number, number, number, number],
  existingGcps: GCP[],
  width: number,
  height: number,
  mapLonLat: [number, number],
  trackLonLat: [number, number],
  customId?: string
): {
  gcps: GCP[];
  matrix: [number, number, number, number, number, number];
  cornersLonLat: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  rmsErrorM: number;
  rotationDeg: number;
} | null {
  const uv = lonLatToPixel(currentMatrix, mapLonLat[0], mapLonLat[1]);
  if (!uv) return null;

  const [dx, dy] = computeRubberSheetDisplacement(
    uv[0],
    uv[1],
    width,
    height,
    existingGcps,
    currentMatrix
  );
  const px = Math.round((uv[0] + dx) * 10) / 10;
  const py = Math.round((uv[1] + dy) * 10) / 10;

  const newPin: GCP = {
    id: customId ?? `pin-${Date.now()}`,
    label: `Булавка #${existingGcps.length + 1}`,
    px,
    py,
    lon: Number(trackLonLat[0].toFixed(6)),
    lat: Number(trackLonLat[1].toFixed(6)),
    residualM: 0,
  };

  const nextGcps = [...existingGcps, newPin];

  if (nextGcps.length === 1) {
    const [nowLon, nowLat] = pixelToLonLat(currentMatrix, px, py);
    const [m0x, m0y] = lonLatToMercator(nowLon, nowLat);
    const [m1x, m1y] = lonLatToMercator(trackLonLat[0], trackLonLat[1]);
    const nudged = nudgeMapMatrix(currentMatrix, width, height, {
      dEastM: m1x - m0x,
      dNorthM: m1y - m0y,
    });
    const rotationDeg =
      Math.round(
        ((Math.atan2(nudged.matrix[3], nudged.matrix[0]) * 180) / Math.PI) * 10
      ) / 10;
    return {
      gcps: nextGcps,
      matrix: nudged.matrix,
      cornersLonLat: nudged.cornersLonLat,
      rmsErrorM: 0,
      rotationDeg,
    };
  }

  const mode: TransformType = nextGcps.length >= 3 ? 'affine' : 'similarity';
  const sol = solveGeoref(nextGcps, width, height, mode);
  if (!sol) return null;

  return {
    gcps: sol.gcpsWithResiduals,
    matrix: sol.matrix,
    cornersLonLat: sol.cornersLonLat,
    rmsErrorM: sol.rmsErrorM,
    rotationDeg: sol.rotationDeg,
  };
}

/**
 * Placement from landmark pins (scan pixel ↔ ground point clicked on the base map):
 *  - 1 pin: shift only — keeps the scale and north already set (print scale / declination);
 *  - 2–3 pins: similarity (shift + scale + rotation), least squares;
 *  - 4+ pins: affine (also absorbs paper stretch / slightly skewed scans).
 */
export function solvePins(
  pins: GCP[],
  currentMatrix: [number, number, number, number, number, number]
): {
  matrix: [number, number, number, number, number, number];
  pins: GCP[];
  rmsErrorM: number;
  mode: 'shift' | 'similarity' | 'affine';
} | null {
  if (pins.length === 0) return null;
  let matrix: [number, number, number, number, number, number] | null;
  let mode: 'shift' | 'similarity' | 'affine';
  if (pins.length === 1) {
    const [p] = pins;
    const [a, b, , c, d] = currentMatrix;
    const [mx, my] = lonLatToMercator(p.lon, p.lat);
    matrix = [a, b, mx - (a * p.px + b * p.py), c, d, my - (c * p.px + d * p.py)];
    mode = 'shift';
  } else if (pins.length <= 3) {
    matrix = fitSimilarityTransform(pins);
    mode = 'similarity';
  } else {
    matrix = fitAffineTransform(pins);
    mode = 'affine';
  }
  if (!matrix) return null;
  let sumSq = 0;
  const withResiduals = pins.map((g) => {
    const [lon, lat] = pixelToLonLat(matrix!, g.px, g.py);
    const err = haversineDistanceM(g.lon, g.lat, lon, lat);
    sumSq += err * err;
    return { ...g, residualM: Math.round(err * 10) / 10 };
  });
  return {
    matrix,
    pins: withResiduals,
    rmsErrorM: Math.round(Math.sqrt(sumSq / pins.length) * 10) / 10,
    mode,
  };
}

export interface GeorefSolution {
  matrix: [number, number, number, number, number, number];
  cornersLonLat: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  rmsErrorM: number;
  rotationDeg: number;
  gcpsWithResiduals: GCP[];
}

/**
 * Compute full georeferencing solution (matrix, 4 corners for MapLibre, RMS error in meters, rotation angle).
 * Automatically upgrades from Similarity (4 DOF) to Affine (6 DOF) when 3+ points are given.
 */
export function solveGeoref(
  gcps: GCP[],
  width: number,
  height: number,
  _preferredMode: TransformType = 'similarity'
): GeorefSolution | null {
  if (gcps.length < 2) return null;

  const matrix =
    gcps.length >= 3
      ? (fitAffineTransform(gcps) ?? fitSimilarityTransform(gcps))
      : fitSimilarityTransform(gcps);

  if (!matrix) return null;

  const cornersLonLat: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ] = [
    pixelToLonLat(matrix, 0, 0),
    pixelToLonLat(matrix, width, 0),
    pixelToLonLat(matrix, width, height),
    pixelToLonLat(matrix, 0, height),
  ];

  let sumSq = 0;
  const gcpsWithResiduals: GCP[] = gcps.map((g) => {
    const [predLon, predLat] = pixelToLonLat(matrix, g.px, g.py);
    const errM = haversineDistanceM(g.lon, g.lat, predLon, predLat);
    sumSq += errM * errM;
    return { ...g, residualM: Math.round(errM * 10) / 10 };
  });

  const rmsErrorM = Math.round(Math.sqrt(sumSq / gcps.length) * 10) / 10;
  const rotationDeg =
    Math.round(((Math.atan2(matrix[3], matrix[0]) * 180) / Math.PI) * 10) / 10;

  return {
    matrix,
    cornersLonLat,
    rmsErrorM,
    rotationDeg,
    gcpsWithResiduals,
  };
}
