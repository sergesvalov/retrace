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

/** Ground scale correction factor cos(lat) so Mercator distances become true ground meters */
export function mercatorGroundFactor(lat: number): number {
  return Math.cos((lat * Math.PI) / 180.0);
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
 * Fit North-Up Scale+Translate transform (3 DOF: isotropic scale s, tx, ty, zero rotation)
 * Ideal for screenshots from Google Maps / OpenStreetMap / Yandex Maps where North is strictly up:
 *   X =  s * px + tx
 *   Y = -s * py + ty
 * Requires only 2 control points (e.g. start point + 1 landmark, or 2 corners).
 */
export function fitNorthUpTransform(
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
  let numS = 0;
  for (const p of pts) {
    const u = p.px - meanPx;
    const v = -(p.py - meanPy);
    const dx = p.mx - meanMx;
    const dy = p.my - meanMy;
    denom += u * u + v * v;
    numS += u * dx + v * dy;
  }
  if (denom < 1e-9) return null;
  const s = Math.max(1e-6, numS / denom);
  const tx = meanMx - s * meanPx;
  const ty = meanMy + s * meanPy;
  return [s, 0, tx, 0, -s, ty];
}

/**
 * Compute initial auto-fit North-Up matrix & corners from the bounding box of GPS tracks
 * so a newly uploaded Google Maps screenshot immediately lands right on top of the runners' tracks.
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
  gcps: GCP[];
} {
  const [minX, minY] = lonLatToMercator(bounds.minLon, bounds.minLat);
  const [maxX, maxY] = lonLatToMercator(bounds.maxLon, bounds.maxLat);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const spanX = Math.max(300, (maxX - minX) * 1.35);
  const spanY = Math.max(300, (maxY - minY) * 1.35);

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

  // Create 2 convenient control points (20% top-left & 80% bottom-right)
  const p1x = Math.round(width * 0.2);
  const p1y = Math.round(height * 0.2);
  const p2x = Math.round(width * 0.8);
  const p2y = Math.round(height * 0.8);
  const [lon1, lat1] = pixelToLonLat(matrix, p1x, p1y);
  const [lon2, lat2] = pixelToLonLat(matrix, p2x, p2y);

  return {
    matrix,
    cornersLonLat,
    gcps: [
      {
        id: 'gcp-auto-1',
        label: 'Точка 1 (СЗ)',
        px: p1x,
        py: p1y,
        lon: Number(lon1.toFixed(6)),
        lat: Number(lat1.toFixed(6)),
        residualM: 0,
      },
      {
        id: 'gcp-auto-2',
        label: 'Точка 2 (ЮВ)',
        px: p2x,
        py: p2y,
        lon: Number(lon2.toFixed(6)),
        lat: Number(lat2.toFixed(6)),
        residualM: 0,
      },
    ],
  };
}

/**
 * Fit 2D Similarity transform (4 DOF: scale, rotation, tx, ty) in Web Mercator:
 *   X = a * px - b * py + tx
 *   Y = b * px + a * py + ty
 * Returned as 2x3 affine matrix [a, -b, tx, b, a, ty].
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

  // Image Y axis points down, Mercator Y points up -> flip py sign in similarity model
  // X - meanMx = a * u - b * v
  // Y - meanMy = b * u + a * v   where u = px - meanPx, v = -(py - meanPy)
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
  // Since u = px - meanPx and v = -py + meanPy:
  // X = a*(px - meanPx) - b*(-py + meanPy) + meanMx = a*px + b*py + (meanMx - a*meanPx - b*meanPy)
  // Y = b*(px - meanPx) + a*(-py + meanPy) + meanMy = b*px - a*py + (meanMy - b*meanPx + a*meanPy)
  const m00 = a;
  const m01 = b;
  const tx = meanMx - a * meanPx - b * meanPy;
  const m10 = b;
  const m11 = -a;
  const ty = meanMy - b * meanPx + a * meanPy;
  return [m00, m01, tx, m10, m11, ty];
}

/**
 * Fit 2D Affine transform (6 DOF) via Ordinary Least Squares in Web Mercator:
 *   X = a * px + b * py + tx
 *   Y = c * px + d * py + ty
 * Includes collinearity safeguard: if the 3+ points lie nearly on a straight line
 * (causing extreme anisotropy > 1.4x or reflection), smoothly regularizes toward Similarity.
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

  // Check singular values of 2x2 linear part [[a, b], [c, d]] to guard against collinear points
  const det = a * d - b * c;
  const frobSq = a * a + b * b + c * c + d * d;
  const disc = Math.max(0, frobSq * frobSq - 4 * det * det);
  const sMax = Math.sqrt(Math.max(0, (frobSq + Math.sqrt(disc)) / 2));
  const sMin = Math.sqrt(Math.max(0, (frobSq - Math.sqrt(disc)) / 2));

  // Image Y is down, Mercator Y is up -> valid orientation has det < 0 and reasonable aspect ratio
  if (det >= 0 || sMin < 1e-7 || sMax / sMin > 1.45) {
    const sim = fitSimilarityTransform(gcps);
    if (!sim) return [a, b, tx, c, d, ty];
    if (det >= 0 || sMin < 1e-7 || sMax / sMin > 2.2) {
      return sim;
    }
    // Blend 65% affine + 35% similarity around centroid so it stays stable
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
 * Apply rigid/scale nudge in Web Mercator (dEastM, dNorthM, scaleFactor, dAngleDeg around image center)
 * directly to an existing 2x3 matrix [a, b, tx, c, d, ty] and return updated matrix & 4 corners.
 */
export function nudgeMapMatrix(
  matrix: [number, number, number, number, number, number],
  width: number,
  height: number,
  nudge: {
    dEastM?: number;
    dNorthM?: number;
    scaleFactor?: number;
    dAngleDeg?: number;
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
  let [a, b, tx, c, d, ty] = matrix;
  const cx = width / 2;
  const cy = height / 2;
  const centerMx = a * cx + b * cy + tx;
  const centerMy = c * cx + d * cy + ty;

  const k = nudge.scaleFactor ?? 1;
  const rad = ((nudge.dAngleDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad) * k;
  const sin = Math.sin(rad) * k;

  // Rotate & scale linear part around image center
  const na = cos * a - sin * c;
  const nb = cos * b - sin * d;
  const nc = sin * a + cos * c;
  const nd = sin * b + cos * d;

  const ntx = centerMx - (na * cx + nb * cy) + (nudge.dEastM ?? 0);
  const nty = centerMy - (nc * cx + nd * cy) + (nudge.dNorthM ?? 0);

  const nextMatrix: [number, number, number, number, number, number] = [
    na,
    nb,
    ntx,
    nc,
    nd,
    nty,
  ];

  const cornersLonLat: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ] = [
    pixelToLonLat(nextMatrix, 0, 0),
    pixelToLonLat(nextMatrix, width, 0),
    pixelToLonLat(nextMatrix, width, height),
    pixelToLonLat(nextMatrix, 0, height),
  ];

  return { matrix: nextMatrix, cornersLonLat };
}

/**
 * Given an existing map matrix [a, b, tx, c, d, ty] and 2 pairs of clicks on the map canvas:
 *   Pair 1: user clicked `mapPt1` (a landmark on the map overlay) and `trackPt1` (where that landmark is on the GPS track)
 *   Pair 2: user clicked `mapPt2` (a second landmark on the map overlay) and `trackPt2` (where it is on the GPS track)
 * Converts `mapPt1`, `mapPt2` back into image pixel coordinates `(px, py)` using the current matrix,
 * then solves the exact 2-point Similarity transform (shift + scale + rotation) so both landmarks
 * snap directly onto the GPS track!
 */
export function snapMapToTrackByTwoPairs(
  currentMatrix: [number, number, number, number, number, number],
  width: number,
  height: number,
  pair1: { mapLonLat: [number, number]; trackLonLat: [number, number] },
  pair2: { mapLonLat: [number, number]; trackLonLat: [number, number] }
): {
  matrix: [number, number, number, number, number, number];
  cornersLonLat: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  rotationDeg: number;
} | null {
  const pxPy1 = lonLatToPixel(
    currentMatrix,
    pair1.mapLonLat[0],
    pair1.mapLonLat[1]
  );
  const pxPy2 = lonLatToPixel(
    currentMatrix,
    pair2.mapLonLat[0],
    pair2.mapLonLat[1]
  );
  if (!pxPy1 || !pxPy2) return null;

  const syntheticGcps: GCP[] = [
    {
      id: 'snap-1',
      label: 'Привязка #1',
      px: pxPy1[0],
      py: pxPy1[1],
      lon: pair1.trackLonLat[0],
      lat: pair1.trackLonLat[1],
    },
    {
      id: 'snap-2',
      label: 'Привязка #2',
      px: pxPy2[0],
      py: pxPy2[1],
      lon: pair2.trackLonLat[0],
      lat: pair2.trackLonLat[1],
    },
  ];

  const nextMatrix = fitSimilarityTransform(syntheticGcps);
  if (!nextMatrix) return null;

  const cornersLonLat: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ] = [
    pixelToLonLat(nextMatrix, 0, 0),
    pixelToLonLat(nextMatrix, width, 0),
    pixelToLonLat(nextMatrix, width, height),
    pixelToLonLat(nextMatrix, 0, height),
  ];

  const rotationDeg =
    Math.round(
      ((Math.atan2(nextMatrix[3], nextMatrix[0]) * 180) / Math.PI) * 10
    ) / 10;

  return { matrix: nextMatrix, cornersLonLat, rotationDeg };
}

/**
 * Compute smooth Inverse-Distance-Weighted (Shepard Rubber-Sheeting) pixel displacement (dx, dy)
 * at quad coordinate (u, v) for 4+ control points so local orienteering map distortions
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
  const clean = gcps.filter((g) => !g.id.startsWith('gcp-auto-'));
  if (clean.length < 3) return [0, 0];

  const anchors: Array<{ u: number; v: number; dx: number; dy: number }> = [];
  let maxResidualPx = 0;

  for (const g of clean) {
    const uv = lonLatToPixel(matrix, g.lon, g.lat);
    if (!uv) continue;
    const dx = g.px - uv[0];
    const dy = g.py - uv[1];
    maxResidualPx = Math.max(maxResidualPx, Math.hypot(dx, dy));
    anchors.push({ u: uv[0], v: uv[1], dx, dy });
  }

  if (maxResidualPx < 0.75 || anchors.length === 0) return [0, 0];

  // Add soft zero-displacement anchors at outer corners (with lower weight) so map edges stay smooth
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
 * - 1 pin: shifts the map so Pin #1 locks onto the track.
 * - 2 pins: solves Similarity (shift + scale + magnetic north rotation) so both pins lock onto the track.
 * - 3+ pins: solves Affine (independent X/Y scale + camera tilt shear + rotation) + Rubber-Sheeting so ALL pins lock onto the track!
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

  const cleanExisting = existingGcps.filter(
    (g) => !g.id.startsWith('gcp-auto-')
  );
  const [dx, dy] = computeRubberSheetDisplacement(
    uv[0],
    uv[1],
    width,
    height,
    cleanExisting,
    currentMatrix
  );
  const px = Math.round((uv[0] + dx) * 10) / 10;
  const py = Math.round((uv[1] + dy) * 10) / 10;

  const newPin: GCP = {
    id: customId ?? `pin-${Date.now()}`,
    label: `Булавка #${cleanExisting.length + 1}`,
    px,
    py,
    lon: Number(trackLonLat[0].toFixed(6)),
    lat: Number(trackLonLat[1].toFixed(6)),
    residualM: 0,
  };

  const nextGcps = [...cleanExisting, newPin];

  if (nextGcps.length === 1) {
    // 1 pin: translate current matrix so (px, py) lands exactly on trackLonLat
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

  // 2 pins -> similarity; 3+ pins -> affine
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
 * Automatically upgrades from Similarity (4 DOF) to Affine (6 DOF: X/Y scale + camera tilt shear) when 3+ points are given.
 */
export function solveGeoref(
  gcps: GCP[],
  width: number,
  height: number,
  preferredMode: TransformType = 'similarity'
): GeorefSolution | null {
  if (gcps.length < 2) return null;

  let matrix: [number, number, number, number, number, number] | null = null;
  if (preferredMode === 'north_up') {
    matrix = fitNorthUpTransform(gcps);
  } else if (gcps.length >= 3) {
    // With 3+ points on an orienteering map, always use regularized Affine so X/Y scale difference & photo tilt are corrected!
    matrix = fitAffineTransform(gcps) ?? fitSimilarityTransform(gcps);
  } else {
    matrix = fitSimilarityTransform(gcps);
  }

  if (!matrix) return null;

  // MapLibre image source expects [topLeft, topRight, bottomRight, bottomLeft]
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
  // Angle of image X-axis relative to East (counter-clockwise deg)
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

