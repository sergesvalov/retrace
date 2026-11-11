import type { DetectedCircle } from '../shared/autoGeoref.js';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Course overprint colour (ISOM purple, CMYK ≈ M100+, on scans anything from violet to
 * magenta-pink). Separated by hue from brown contours, green vegetation, blue water and
 * black, which are the other colours of an orienteering map.
 */
export function isOverprintPurple(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (max < 60 || chroma < 35 || chroma / max < 0.2) return false;
  let hue: number;
  if (max === r) hue = (60 * ((g - b) / chroma) + 360) % 360;
  else if (max === g) hue = 60 * ((b - r) / chroma) + 120;
  else hue = 60 * ((r - g) / chroma) + 240;
  return hue >= 275 && hue <= 352;
}

interface Candidate {
  x: number;
  y: number;
  r: number;
  votes: number;
  coverage: number;
  /** Radius of a concentric second ring (finish double circle), if one was found */
  r2?: number;
}

/** Integer offsets of a circle outline of radius r (each counted once) */
function circleOffsets(r: number): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  const n = Math.max(16, Math.ceil(2 * Math.PI * r * 1.5));
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const dx = Math.round(r * Math.cos(a));
    const dy = Math.round(r * Math.sin(a));
    const k = `${dx},${dy}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push([dx, dy]);
    }
  }
  return out;
}

/**
 * Find course control circles (thin purple rings) in an image.
 * Hough transform per radius over the purple mask, then each peak is checked:
 * the ring must be mostly drawn (legs and numbers may cut it) while inside and around it
 * there is little purple (rejects filled symbols, text and purple out-of-bounds hatching).
 */
export function detectOverprintCircles(
  img: RgbaImage,
  opts: { rMin: number; rMax: number; minCoverage?: number }
): DetectedCircle[] {
  const minCoverage = opts.minCoverage ?? 0.6;
  const { width: w, height: h, data } = img;
  const mask = new Uint8Array(w * h);
  const purple: number[] = [];
  for (let i = 0, p = 0; p < w * h; p++, i += 4) {
    if (data[i + 3] > 128 && isOverprintPurple(data[i], data[i + 1], data[i + 2])) {
      mask[p] = 1;
      purple.push(p);
    }
  }
  if (purple.length < 20) return [];

  // Mask grown by 1 px: tolerant ring checks on slightly blurry / anti-aliased scans
  const near = new Uint8Array(w * h);
  for (const p of purple) {
    const x = p % w;
    const y = (p / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) near[ny * w + nx] = 1;
      }
    }
  }
  const ringShare = (cx: number, cy: number, r: number) => {
    const n = Math.max(24, Math.round(2 * Math.PI * r));
    let hit = 0;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const x = Math.round(cx + r * Math.cos(a));
      const y = Math.round(cy + r * Math.sin(a));
      if (x >= 0 && y >= 0 && x < w && y < h && near[y * w + x]) hit++;
    }
    return hit / n;
  };

  const acc = new Uint16Array(w * h);
  const candidates: Candidate[] = [];
  const rMin = Math.max(3, Math.floor(opts.rMin));
  const rMax = Math.max(rMin, Math.ceil(opts.rMax));

  for (let r = rMin; r <= rMax; r++) {
    acc.fill(0);
    const offs = circleOffsets(r);
    for (const p of purple) {
      const x = p % w;
      const y = (p / w) | 0;
      for (const [dx, dy] of offs) {
        const cx = x + dx;
        const cy = y + dy;
        if (cx >= 0 && cy >= 0 && cx < w && cy < h) acc[cy * w + cx]++;
      }
    }
    const thr = Math.max(8, 0.35 * offs.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const v = acc[y * w + x];
        if (v < thr) continue;
        // local maximum in 3×3
        let isMax = true;
        for (let dy = -1; dy <= 1 && isMax; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if ((dx || dy) && acc[(y + dy) * w + x + dx] > v) {
              isMax = false;
              break;
            }
          }
        }
        if (!isMax) continue;
        const coverage = ringShare(x, y, r);
        if (coverage < minCoverage) continue;
        if (ringShare(x, y, r * 0.5) > 0.35) continue; // filled / text inside
        // purple all around (hatching): high at several radii — not just one second ring,
        // which is what a finish double circle (ratio ≈1.4–1.6) has
        if (ringShare(x, y, r * 1.8) > 0.5 && ringShare(x, y, r * 2.1) > 0.5) continue;
        candidates.push({ x, y, r, votes: v, coverage });
      }
    }
  }

  // Non-maximum suppression: one circle per place (also merges the finish double circle).
  // Course circles do not overlap (controls are ≥ one circle diameter apart by the rules),
  // so anything overlapping a stronger circle is an arc of it plus a number or a leg.
  // Best-closed ring first: a clean ring beats a blend of strokes that merely collects many
  // votes (e.g. a start triangle drawn over the finish circle)
  candidates.sort((a, b) => b.coverage - a.coverage || b.votes - a.votes);
  const kept: Candidate[] = [];
  for (const c of candidates) {
    const over = kept.find((k) => Math.hypot(k.x - c.x, k.y - c.y) < 0.95 * (k.r + c.r));
    if (over) {
      // Concentric rings 5 and 7 mm (ratio 1.4, allow 1.2–1.7) = the finish double circle
      const ratio = Math.max(over.r, c.r) / Math.min(over.r, c.r);
      const concentric = Math.hypot(over.x - c.x, over.y - c.y) <= 0.25 * Math.min(over.r, c.r);
      if (concentric && ratio >= 1.2 && ratio <= 1.7 && over.r2 === undefined) over.r2 = c.r;
      continue;
    }
    kept.push(c);
  }
  // All control circles of a course are printed the same size
  let sameSize = kept;
  if (kept.length >= 3) {
    const radii = kept.map((k) => k.r).sort((a, b) => a - b);
    const med = radii[radii.length >> 1];
    const fits = (r: number) => Math.abs(r - med) <= Math.max(1.5, 0.2 * med);
    sameSize = kept
      .filter((k) => fits(k.r) || (k.r2 !== undefined && fits(k.r2)))
      // report a finish by its control-sized ring
      .map((k) => (fits(k.r) || k.r2 === undefined ? k : { ...k, r: k.r2, r2: k.r }));
  }
  // Finish = double circle (ISOM: 5 mm inside 7 mm, radius ratio 1.4). Print and scan
  // tolerances (and which of the two rings was detected) move the ratio: try 1.25–1.65.
  // A second ring must be a separate ring: clearly away from the first, with a gap between.
  const secondRing = (c: Candidate) => {
    if (c.r2 !== undefined) return 1;
    let best = 0;
    for (let k = 1.25; k <= 1.651; k += 0.05) {
      for (const r2 of [c.r * k, c.r / k]) {
        if (Math.abs(r2 - c.r) < 3) continue;
        // no gap → the same thick ring (strokes of a start triangle drawn on top may cross it)
        if (ringShare(c.x, c.y, (c.r + r2) / 2) > 0.5) continue;
        best = Math.max(best, ringShare(c.x, c.y, r2));
      }
    }
    return best;
  };
  return sameSize.map((c) => ({
    px: c.x,
    py: c.y,
    r: c.r,
    coverage: c.coverage,
    finish: secondRing(c) >= 0.6,
  }));
}

/**
 * Load the scan, downscale it so a control circle is ~10 px in radius (fast and robust),
 * detect circles and return them in full-resolution image pixels.
 * Without a DPI the circle size is unknown, so a wide radius range is searched.
 */
export interface ScanAnalysis {
  /** Control circles in full-resolution pixels (finish flagged) */
  circles: DetectedCircle[];
}

export async function detectCirclesOnScan(
  url: string,
  fullWidth: number,
  scanDpi?: number | null
): Promise<ScanAnalysis> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Не удалось загрузить скан карты'));
    el.src = url;
  });
  const natW = img.naturalWidth || fullWidth;
  const natH = img.naturalHeight;

  const knownDpi = scanDpi && scanDpi >= 30 ? scanDpi : null;
  let factor: number;
  let range: { rMin: number; rMax: number };
  if (knownDpi) {
    // 5–6 mm circles at a known DPI: downscale so the radius is ~10 px, search ±25 %
    const rMidFull = (5.5 / 2 / 25.4) * knownDpi;
    factor = Math.min(1, 10 / rMidFull);
    range = { rMin: 10 * (5 / 5.5) * 0.8, rMax: 10 * (6 / 5.5) * 1.25 };
  } else {
    // Unknown DPI (screenshots, re-saved copies): keep up to 1600 px so thin rings survive.
    // A whole A4…A3 sheet across 1600 px puts a 5–6 mm circle at r ≈ 9…16 px; allow crops.
    factor = Math.min(1, 1600 / Math.max(natW, natH || 1));
    range = { rMin: 6, rMax: 32 };
  }
  const w = Math.max(1, Math.round(natW * factor));
  const h = Math.max(1, Math.round(natH * factor));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas недоступен');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);

  const small: RgbaImage = { width: w, height: h, data: data.data };
  const found = detectOverprintCircles(small, range);
  // Back to the full-resolution pixel grid the map placement uses
  const toFull = fullWidth / w;
  const circles = found.map((c) => ({
    ...c,
    px: c.px * toFull,
    py: c.py * toFull,
    r: c.r * toFull,
  }));
  return { circles };
}

