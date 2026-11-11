import { describe, expect, it } from 'vitest';
import { detectOverprintCircles, isOverprintPurple } from './detectCircles.js';

const W = 640;
const H = 420;
const PURPLE: [number, number, number] = [190, 60, 160];
const BROWN: [number, number, number] = [185, 115, 55];

function blank() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 250;
    data[i + 1] = 248;
    data[i + 2] = 240;
    data[i + 3] = 255;
  }
  return data;
}
function put(data: Uint8ClampedArray, x: number, y: number, c: [number, number, number]) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  data[i] = c[0];
  data[i + 1] = c[1];
  data[i + 2] = c[2];
}
function ring(data: Uint8ClampedArray, cx: number, cy: number, r: number, c = PURPLE) {
  for (let a = 0; a < 2 * Math.PI; a += 0.01) {
    for (let t = -0.8; t <= 0.8; t += 0.4) {
      put(data, cx + (r + t) * Math.cos(a), cy + (r + t) * Math.sin(a), c);
    }
  }
}
function line(data: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, c = PURPLE) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const y = y0 + ((y1 - y0) * i) / n;
    put(data, x, y, c);
    put(data, x + 1, y, c);
  }
}

describe('overprint colour', () => {
  it('accepts purple/magenta overprint, rejects other map colours', () => {
    expect(isOverprintPurple(190, 60, 160)).toBe(true); // purple
    expect(isOverprintPurple(220, 40, 120)).toBe(true); // magenta-pink
    expect(isOverprintPurple(150, 60, 190)).toBe(true); // violet
    expect(isOverprintPurple(185, 115, 55)).toBe(false); // brown contour
    expect(isOverprintPurple(140, 200, 110)).toBe(false); // green
    expect(isOverprintPurple(90, 170, 230)).toBe(false); // blue water
    expect(isOverprintPurple(30, 30, 30)).toBe(false); // black
    expect(isOverprintPurple(240, 240, 235)).toBe(false); // paper
    expect(isOverprintPurple(220, 40, 40)).toBe(false); // red
  });
});

describe('control circle detection', () => {
  it('finds the course circles and ignores legs, numbers, discs, hatching and contours', () => {
    const data = blank();
    // brown contours everywhere
    for (let y = 20; y < H; y += 23) {
      for (let x = 0; x < W; x++) put(data, x, y + 6 * Math.sin(x / 30), BROWN);
    }
    const controls: [number, number][] = [
      [90, 90],
      [300, 70],
      [520, 140],
      [430, 330],
      [160, 300],
    ];
    controls.forEach(([x, y]) => ring(data, x, y, 12));
    // legs between circles (stop at the ring edge, like a real overprint)
    for (let i = 0; i < controls.length - 1; i++) {
      const [x0, y0] = controls[i];
      const [x1, y1] = controls[i + 1];
      const d = Math.hypot(x1 - x0, y1 - y0);
      const ux = (x1 - x0) / d;
      const uy = (y1 - y0) / d;
      line(data, x0 + ux * 14, y0 + uy * 14, x1 - ux * 14, y1 - uy * 14);
    }
    // control number "7" next to a circle
    line(data, 106, 70, 116, 70);
    line(data, 116, 70, 109, 84);
    // filled purple disc (not a control circle)
    for (let y = -12; y <= 12; y++) {
      for (let x = -12; x <= 12; x++) if (x * x + y * y <= 144) put(data, 600 + x, 380 + y, PURPLE);
    }
    // purple out-of-bounds hatching
    for (let x = 230; x < 330; x += 4) line(data, x, 180, x, 260);

    const found = detectOverprintCircles({ width: W, height: H, data }, { rMin: 8, rMax: 16 });
    for (const [x, y] of controls) {
      const hit = found.find((c) => Math.hypot(c.px - x, c.py - y) <= 2);
      expect(hit, `circle at ${x},${y}`).toBeDefined();
      expect(Math.abs(hit!.r - 12)).toBeLessThanOrEqual(1);
    }
    expect(found).toHaveLength(controls.length);
  });
});
