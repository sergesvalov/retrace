import {
  computeRubberSheetDisplacement,
  lonLatToPixel,
} from '../../shared/georef.js';
import type { GCP } from '../../shared/types.js';

/**
 * Draw a single textured triangle from source image coordinates (sx0,sy0)-(sx1,sy1)-(sx2,sy2)
 * onto destination canvas coordinates (dx0,dy0)-(dx1,dy1)-(dx2,dy2).
 */
function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  sx0: number,
  sy0: number,
  sx1: number,
  sy1: number,
  sx2: number,
  sy2: number,
  dx0: number,
  dy0: number,
  dx1: number,
  dy1: number,
  dx2: number,
  dy2: number
) {
  // Solve affine mapping from source triangle S to destination triangle D
  const denom = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
  if (Math.abs(denom) < 1e-6) return;

  const m11 =
    (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / denom;
  const m12 =
    (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / denom;
  const dx =
    (dx0 * (sx1 * sy2 - sx2 * sy1) +
      dx1 * (sx2 * sy0 - sx0 * sy2) +
      dx2 * (sx0 * sy1 - sx1 * sy0)) /
    denom;

  const m21 =
    (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / denom;
  const m22 =
    (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / denom;
  const dy =
    (dy0 * (sx1 * sy2 - sx2 * sy1) +
      dy1 * (sx2 * sy0 - sx0 * sy2) +
      dy2 * (sx0 * sy1 - sx1 * sy0)) /
    denom;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(dx0, dy0);
  ctx.lineTo(dx1, dy1);
  ctx.lineTo(dx2, dy2);
  ctx.closePath();
  ctx.clip();
  ctx.transform(m11, m21, m12, m22, dx, dy);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/**
 * If 3+ control points have local non-linear distortion (e.g. 4+ pins across an orienteering map
 * with ISOM generalization or camera perspective fold), warps the image on an offscreen canvas
 * using smooth Shepard Rubber-Sheeting so every pinned control point has 0m error on the map.
 * If residuals are already near zero (< 1.5 px), returns `imageUrl` directly.
 */
export async function buildRubberSheetedMapUrl(
  imageUrl: string,
  width: number,
  height: number,
  gcps: GCP[] | undefined,
  matrix: [number, number, number, number, number, number] | undefined
): Promise<string> {
  if (!gcps || !matrix) return imageUrl;
  const clean = gcps.filter((g) => !g.id.startsWith('gcp-auto-'));
  if (clean.length < 3) return imageUrl;

  // Check if there is any non-linear residual beyond the global Affine matrix
  let maxResidualPx = 0;
  for (const g of clean) {
    const uv = lonLatToPixel(matrix, g.lon, g.lat);
    if (!uv) continue;
    maxResidualPx = Math.max(
      maxResidualPx,
      Math.hypot(g.px - uv[0], g.py - uv[1])
    );
  }
  if (maxResidualPx < 1.5) {
    return imageUrl;
  }

  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = imageUrl;
  });
  if (!img) return imageUrl;

  const natW = img.naturalWidth || width;
  const natH = img.naturalHeight || height;
  const maxDim = 1600;
  const scale = Math.min(1, maxDim / Math.max(natW, natH));
  const outW = Math.round(natW * scale);
  const outH = Math.round(natH * scale);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return imageUrl;

  const cols = 22;
  const rows = 22;

  // Precompute source coordinates for each grid vertex (r, c)
  const srcGrid: Array<Array<{ sx: number; sy: number; dx: number; dy: number }>> =
    [];
  for (let r = 0; r <= rows; r++) {
    const rowArr: Array<{ sx: number; sy: number; dx: number; dy: number }> = [];
    const v = (r / rows) * height;
    const dy = (r / rows) * outH;
    for (let c = 0; c <= cols; c++) {
      const u = (c / cols) * width;
      const dx = (c / cols) * outW;
      // Outer boundary stays anchored to quad frame
      const isEdge = r === 0 || r === rows || c === 0 || c === cols;
      const [offX, offY] = isEdge
        ? [0, 0]
        : computeRubberSheetDisplacement(u, v, width, height, clean, matrix);
      const sx = Math.max(0, Math.min(natW, ((u + offX) / width) * natW));
      const sy = Math.max(0, Math.min(natH, ((v + offY) / height) * natH));
      rowArr.push({ sx, sy, dx, dy });
    }
    srcGrid.push(rowArr);
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p00 = srcGrid[r][c];
      const p10 = srcGrid[r][c + 1];
      const p01 = srcGrid[r + 1][c];
      const p11 = srcGrid[r + 1][c + 1];

      drawTexturedTriangle(
        ctx,
        img,
        p00.sx,
        p00.sy,
        p10.sx,
        p10.sy,
        p11.sx,
        p11.sy,
        p00.dx,
        p00.dy,
        p10.dx,
        p10.dy,
        p11.dx,
        p11.dy
      );
      drawTexturedTriangle(
        ctx,
        img,
        p00.sx,
        p00.sy,
        p11.sx,
        p11.sy,
        p01.sx,
        p01.sy,
        p00.dx,
        p00.dy,
        p11.dx,
        p11.dy,
        p01.dx,
        p01.dy
      );
    }
  }

  return canvas.toDataURL('image/png');
}

