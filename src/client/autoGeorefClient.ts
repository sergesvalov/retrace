import type { AutoGeorefResult, DetectedCircle } from '../shared/autoGeoref.js';
import type { AutoGeorefMessage, AutoGeorefRequest } from './autoGeoref.worker.js';

export interface AutoGeorefOutcome {
  circles: DetectedCircle[];
  result: AutoGeorefResult | null;
}

/**
 * Run circle detection + automatic map fit in a Web Worker (the UI keeps running);
 * falls back to the main thread where workers or OffscreenCanvas are unavailable.
 */
export async function runAutoGeorefTask(
  req: AutoGeorefRequest,
  onCircles?: (count: number) => void
): Promise<AutoGeorefOutcome> {
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
    try {
      return await inWorker(req, onCircles);
    } catch {
      // e.g. a browser without 2d OffscreenCanvas: do it here instead
    }
  }
  return onMainThread(req, onCircles);
}

function inWorker(
  req: AutoGeorefRequest,
  onCircles?: (count: number) => void
): Promise<AutoGeorefOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./autoGeoref.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => worker.terminate();
    worker.onmessage = (e: MessageEvent<AutoGeorefMessage>) => {
      const msg = e.data;
      if (msg.type === 'circles') onCircles?.(msg.count);
      else if (msg.type === 'done') {
        finish();
        resolve({ circles: msg.circles, result: msg.result });
      } else {
        finish();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message || 'Ошибка фонового потока'));
    };
    worker.postMessage(req);
  });
}

async function onMainThread(
  req: AutoGeorefRequest,
  onCircles?: (count: number) => void
): Promise<AutoGeorefOutcome> {
  const [{ detectCirclesOnScan }, { autoGeoref }] = await Promise.all([
    import('./detectCircles.js'),
    import('../shared/autoGeoref.js'),
  ]);
  const { circles } = await detectCirclesOnScan(req.url, req.fullWidth, req.scanDpi);
  onCircles?.(circles.length);
  // let the progress message paint before the matching blocks the thread
  await new Promise((r) => setTimeout(r, 30));
  const result =
    circles.length >= 3
      ? autoGeoref({
          circles,
          participants: req.participants,
          declinationDeg: req.declinationDeg,
          groundMPerPxHint: req.groundMPerPxHint,
        })
      : null;
  return { circles, result };
}
