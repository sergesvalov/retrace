/**
 * Background thread for the CPU-heavy part of the automatic map fit: decode the scan,
 * find the control circles, match them to the tracks. The page stays responsive meanwhile.
 */
import { autoGeoref, type AutoGeorefResult, type DetectedCircle } from '../shared/autoGeoref.js';
import type { ParticipantTrack } from '../shared/types.js';
import { circlesOnShrunkScan, planDownscale } from './detectCircles.js';

export interface AutoGeorefRequest {
  url: string;
  fullWidth: number;
  scanDpi?: number | null;
  participants: ParticipantTrack[];
  declinationDeg: number;
  groundMPerPxHint: number | null;
}

export type AutoGeorefMessage =
  | { type: 'circles'; count: number }
  | { type: 'done'; circles: DetectedCircle[]; result: AutoGeorefResult | null }
  | { type: 'error'; message: string };

// Minimal worker-scope typing (the project compiles against the DOM lib)
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<AutoGeorefRequest>) => void) | null;
  postMessage: (msg: AutoGeorefMessage) => void;
};

scope.onmessage = async (e) => {
  const req = e.data;
  try {
    const blob = await (await fetch(req.url)).blob();
    const bitmap = await createImageBitmap(blob);
    const { factor, range } = planDownscale(bitmap.width, bitmap.height, req.scanDpi);
    const w = Math.max(1, Math.round(bitmap.width * factor));
    const h = Math.max(1, Math.round(bitmap.height * factor));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('OffscreenCanvas 2d недоступен');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const data = ctx.getImageData(0, 0, w, h);

    const circles = circlesOnShrunkScan({ width: w, height: h, data: data.data }, range, req.fullWidth);
    scope.postMessage({ type: 'circles', count: circles.length });
    const result =
      circles.length >= 3
        ? autoGeoref({
            circles,
            participants: req.participants,
            declinationDeg: req.declinationDeg,
            groundMPerPxHint: req.groundMPerPxHint,
          })
        : null;
    scope.postMessage({ type: 'done', circles, result });
  } catch (err) {
    scope.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
