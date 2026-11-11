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
  opts: { rMin: number; rMax: number }
): DetectedCircle[] {
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
        if (coverage < 0.6) continue;
        if (ringShare(x, y, r * 0.5) > 0.35) continue; // filled / text inside
        if (ringShare(x, y, r * 1.6) > 0.5) continue; // purple all around (hatching)
        candidates.push({ x, y, r, votes: v, coverage });
      }
    }
  }

  // Non-maximum suppression: one circle per place (also merges the finish double circle).
  // Course circles do not overlap (controls are ≥ one circle diameter apart by the rules),
  // so anything overlapping a stronger circle is an arc of it plus a number or a leg.
  candidates.sort((a, b) => b.coverage * b.votes - a.coverage * a.votes);
  const kept: Candidate[] = [];
  for (const c of candidates) {
    if (kept.some((k) => Math.hypot(k.x - c.x, k.y - c.y) < 0.95 * (k.r + c.r))) continue;
    kept.push(c);
  }
  // All control circles of a course are printed the same size
  if (kept.length >= 3) {
    const radii = kept.map((k) => k.r).sort((a, b) => a - b);
    const med = radii[radii.length >> 1];
    return kept
      .filter((k) => Math.abs(k.r - med) <= Math.max(1.5, 0.2 * med))
      .map((c) => ({ px: c.x, py: c.y, r: c.r, coverage: c.coverage }));
  }
  return kept.map((c) => ({ px: c.x, py: c.y, r: c.r, coverage: c.coverage }));
}

/**
 * Load the scan, downscale it so a control circle is ~10 px in radius (fast and robust),
 * detect circles and return them in full-resolution image pixels.
 * Without a DPI the circle size is unknown, so a wide radius range is searched.
 */
export async function detectCirclesOnScan(
  url: string,
  fullWidth: number,
  scanDpi?: number | null
): Promise<DetectedCircle[]> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Не удалось загрузить скан карты'));
    el.src = url;
  });
  const natW = img.naturalWidth || fullWidth;
  const natH = img.naturalHeight;

  // Expected ring radius in full-res pixels: 5–6 mm circles printed, scanned at `dpi`
  const dpi = scanDpi && scanDpi >= 30 ? scanDpi : 300;
  const rMidFull = (5.5 / 2 / 25.4) * dpi;
  const factor = Math.min(1, 10 / rMidFull);
  const w = Math.max(1, Math.round(natW * factor));
  const h = Math.max(1, Math.round(natH * factor));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas недоступен');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);

  // Known DPI: ±25 % around 5–6 mm; unknown: scans from ~100 to ~750 dpi
  const range = scanDpi ? { rMin: 10 * (5 / 5.5) * 0.8, rMax: 10 * (6 / 5.5) * 1.25 } : { rMin: 4, rMax: 25 };
  const found = detectOverprintCircles(
    { width: w, height: h, data: data.data },
    range
  );
  // Back to the full-resolution pixel grid the map placement uses
  const toFull = fullWidth / w;
  return found.map((c) => ({
    px: c.px * toFull,
    py: c.py * toFull,
    r: c.r * toFull,
    coverage: c.coverage,
  }));
}
