import type maplibregl from 'maplibre-gl';
import { formatDuration } from '../../shared/trackParser.js';
import type { CourseControl } from '../../shared/types.js';

/**
 * Video of a replay: every map frame is copied onto a 2D canvas together with what the map
 * shows as DOM markers (course, runners, leg ends) and a caption with the race clock; the
 * canvas stream is recorded by MediaRecorder in real time.
 */

/** A runner as drawn in one frame */
export interface RunnerOnMap {
  lon: number;
  lat: number;
  color: string;
  name: string;
  pace: string;
}

/** What stays the same for the whole video */
export interface VideoScene {
  title: string;
  subtitle: string;
  course: { lonLat: [number, number]; kind: CourseControl['kind']; label: string }[];
  /** A → B markers of a leg picked by two clicks (course legs are shown by the course itself) */
  legEnds: { a: [number, number]; b: [number, number] } | null;
  startSpot: [number, number] | null;
  attribution: string;
}

/** What changes every frame */
export interface VideoFrame {
  raceTimeSec: number;
  totalSec: number;
  playbackRate: number;
  runners: RunnerOnMap[];
}

const COURSE_COLOR = '#c026d3';
const LEG_COLOR = '#c026d3';
// Videos are meant for messengers: ~720p keeps files small and is what chats show anyway
const MAX_SIDE_PX = 1280;
const FPS = 30;

/** First container/codec the browser can record: MP4 (H.264) plays everywhere, WebM otherwise */
export function pickVideoFormat(): { mimeType: string; ext: 'mp4' | 'webm' } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates: [string, 'mp4' | 'webm'][] = [
    ['video/mp4;codecs=avc1.640028', 'mp4'],
    ['video/mp4;codecs=avc1', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9', 'webm'],
    ['video/webm;codecs=vp8', 'webm'],
    ['video/webm', 'webm'],
  ];
  for (const [mimeType, ext] of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType, ext };
  }
  return null;
}

export function canRecordVideo(): boolean {
  return (
    pickVideoFormat() !== null &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  );
}

/** Safe file name: keeps letters (any script) and digits */
export function videoFileName(parts: string[], ext: string): string {
  const base = parts
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' - ')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, '_')
    .slice(0, 120);
  return `${base || 'replay'}.${ext}`;
}

/** Resolves once the map has drawn everything it is loading (tiles), or after `timeoutMs` */
export function waitForMapIdle(map: maplibregl.Map, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      map.off('idle', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    map.on('idle', done);
    map.triggerRepaint();
  });
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export class ReplayVideoRecorder {
  readonly ext: 'mp4' | 'webm';
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly recorder: MediaRecorder;
  private readonly stream: MediaStream;
  private readonly chunks: Blob[] = [];
  private readonly onRender = () => this.compose();
  private repaintRaf: number | null = null;
  private stopped = false;

  constructor(
    private readonly map: maplibregl.Map,
    private readonly scene: VideoScene,
    private readonly getFrame: () => VideoFrame
  ) {
    const format = pickVideoFormat();
    if (!format) throw new Error('Браузер не умеет записывать видео');
    this.ext = format.ext;

    const src = map.getCanvas();
    const k = Math.min(1, MAX_SIDE_PX / Math.max(src.width, src.height));
    // H.264 needs even frame sizes
    const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
    this.canvas = document.createElement('canvas');
    this.canvas.width = even(src.width * k);
    this.canvas.height = even(src.height * k);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Нет 2D-контекста для видео');
    this.ctx = ctx;

    this.stream = this.canvas.captureStream(FPS);
    // ~0.13 bit per pixel per frame: readable map text, ~3.5 Mbit/s at 720p (≈ 26 MB a minute)
    const bitrate = Math.round(
      Math.min(5e6, Math.max(2e6, this.canvas.width * this.canvas.height * FPS * 0.13))
    );
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: format.mimeType,
      videoBitsPerSecond: bitrate,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
  }

  start() {
    // Copy the map in its own 'render' event: the WebGL buffer is still intact there
    this.map.on('render', this.onRender);
    // The map redraws only on changes: keep it drawing so pauses and the clock are recorded too
    const keepDrawing = () => {
      this.map.triggerRepaint();
      this.repaintRaf = requestAnimationFrame(keepDrawing);
    };
    keepDrawing();
    this.recorder.start(1000);
  }

  /** Finish and return the video file */
  stop(): Promise<Blob> {
    const done = new Promise<Blob>((resolve) => {
      this.recorder.onstop = () =>
        resolve(new Blob(this.chunks, { type: this.recorder.mimeType }));
    });
    this.release();
    return done;
  }

  /** Stop without a file (the workspace went away) */
  cancel() {
    this.recorder.onstop = null;
    this.release();
  }

  private release() {
    if (this.stopped) return;
    this.stopped = true;
    this.map.off('render', this.onRender);
    if (this.repaintRaf !== null) cancelAnimationFrame(this.repaintRaf);
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    for (const t of this.stream.getTracks()) t.stop();
  }

  private compose() {
    const { ctx, canvas, map } = this;
    const src = map.getCanvas();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);

    // Overlays are laid out in CSS pixels (map.project), like the markers on screen
    const cssW = src.clientWidth || canvas.width;
    const cssH = src.clientHeight || canvas.height;
    const s = canvas.width / cssW;
    ctx.setTransform(s, 0, 0, s, 0, 0);

    const frame = this.getFrame();
    const at = (ll: [number, number]) => map.project(ll);

    for (const c of this.scene.course) drawControl(ctx, at(c.lonLat), c.kind, c.label);
    if (this.scene.legEnds) {
      drawLegEnd(ctx, at(this.scene.legEnds.a), 'A');
      drawLegEnd(ctx, at(this.scene.legEnds.b), 'B');
    }
    if (this.scene.startSpot) drawStartSpot(ctx, at(this.scene.startSpot));
    for (const r of frame.runners) drawRunner(ctx, at([r.lon, r.lat]), r);

    drawCaption(ctx, cssW, cssH, this.scene, frame);
  }
}

type Pt = { x: number; y: number };

function haloText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fill: string,
  halo = '#ffffff'
) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = halo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Same shapes as the course markers on the map (28 px box centred on the control) */
function drawControl(
  ctx: CanvasRenderingContext2D,
  p: Pt,
  kind: CourseControl['kind'],
  label: string
) {
  ctx.save();
  ctx.strokeStyle = COURSE_COLOR;
  ctx.lineWidth = 2.5;
  if (kind === 'start') {
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 12);
    ctx.lineTo(p.x + 12, p.y + 10);
    ctx.lineTo(p.x - 12, p.y + 10);
    ctx.closePath();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 11.5, 0, Math.PI * 2);
    ctx.stroke();
    if (kind === 'finish') {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (kind === 'control') {
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    haloText(ctx, label, p.x + 13, p.y - 24, COURSE_COLOR);
  }
  ctx.restore();
}

function drawLegEnd(ctx: CanvasRenderingContext2D, p: Pt, letter: string) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
  ctx.fillStyle = LEG_COLOR;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.font = '700 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(letter, p.x, p.y + 0.5);
  ctx.restore();
}

function drawStartSpot(ctx: CanvasRenderingContext2D, p: Pt) {
  ctx.save();
  ctx.font = '700 11px system-ui, sans-serif';
  const text = 'СТАРТ';
  const w = ctx.measureText(text).width + 16;
  roundRect(ctx, p.x - w / 2, p.y - 10, w, 20, 10);
  ctx.fillStyle = '#10b981';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#020617';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, p.x, p.y + 0.5);
  ctx.restore();
}

/** Dot + "name • pace" label, anchored at the dot's left edge like the live marker */
function drawRunner(ctx: CanvasRenderingContext2D, p: Pt, r: RunnerOnMap) {
  ctx.save();
  const cx = p.x + 8;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.arc(cx, p.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = r.color;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  ctx.font = '600 11px system-ui, sans-serif';
  const text = `${r.name} • ${r.pace}`;
  const w = ctx.measureText(text).width + 12;
  const x = p.x + 22;
  roundRect(ctx, x, p.y - 9, w, 18, 4);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#334155';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 6, p.y + 0.5);
  ctx.restore();
}

/** Title and leg top-left, race clock top-right, progress line and map credits at the bottom */
function drawCaption(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  scene: VideoScene,
  f: VideoFrame
) {
  ctx.save();
  const pad = 12;

  // Title + leg
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = '700 17px system-ui, sans-serif';
  const title = scene.title;
  const titleW = ctx.measureText(title).width;
  ctx.font = '600 13px system-ui, sans-serif';
  const subW = ctx.measureText(scene.subtitle).width;
  const boxW = Math.min(w * 0.6, Math.max(titleW, subW) + 24);
  roundRect(ctx, pad, pad, boxW, scene.subtitle ? 52 : 34, 8);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad, pad, boxW - 10, 60);
  ctx.clip();
  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 17px system-ui, sans-serif';
  ctx.fillText(title, pad + 12, pad + 8);
  if (scene.subtitle) {
    ctx.fillStyle = '#e879f9';
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.fillText(scene.subtitle, pad + 12, pad + 31);
  }
  ctx.restore();

  // Race clock
  const clock = formatDuration(f.raceTimeSec);
  const sub = `из ${formatDuration(f.totalSec)} · ×${f.playbackRate}`;
  ctx.font = '700 26px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const clockW = ctx.measureText(clock).width;
  ctx.font = '500 11px system-ui, sans-serif';
  const subClockW = ctx.measureText(sub).width;
  const cw = Math.max(clockW, subClockW) + 24;
  // Leave room for the zoom buttons that sit in the map's top-right corner on screen
  const cx = w - pad - cw;
  roundRect(ctx, cx, pad, cw, 52, 8);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
  ctx.fill();
  ctx.textAlign = 'right';
  ctx.fillStyle = '#34d399';
  ctx.font = '700 26px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillText(clock, w - pad - 12, pad + 5);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 11px system-ui, sans-serif';
  ctx.fillText(sub, w - pad - 12, pad + 35);

  // Progress
  const progress = f.totalSec > 0 ? Math.min(1, f.raceTimeSec / f.totalSec) : 0;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
  ctx.fillRect(0, h - 4, w, 4);
  ctx.fillStyle = '#10b981';
  ctx.fillRect(0, h - 4, w * progress, 4);

  // Map credits (required by the tile providers)
  if (scene.attribution) {
    ctx.font = '400 10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    haloText(ctx, scene.attribution, w - 6, h - 8, '#1e293b', 'rgba(255,255,255,0.85)');
  }
  ctx.restore();
}
