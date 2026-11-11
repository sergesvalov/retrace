import { describe, expect, it } from 'vitest';
import type { ParticipantTrack } from '../../shared/types.js';
import { courseCamera, legCamera, legRunnerIds, type VideoCamera } from './videoCamera.js';

type LonLat = [number, number];
const view = { width: 1000, height: 700 };
const pad = { top: 76, bottom: 35, left: 70, right: 110 };
const opts = { rotate: true, maxZoom: 22 };

/** Screen position (CSS px) of a point under `cam`, the way MapLibre draws it */
function project(ll: LonLat, cam: VideoCamera): [number, number] {
  const merc = ([lon, lat]: LonLat) => {
    const phi = (lat * Math.PI) / 180;
    return [(lon + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2];
  };
  const [x, y] = merc(ll);
  const [cx, cy] = merc(cam.center);
  const scale = 512 * 2 ** cam.zoom;
  const dx = (x - cx) * scale;
  const dy = (y - cy) * scale;
  const b = (cam.bearing * Math.PI) / 180;
  // screen right = compass bearing + 90°, screen down = bearing + 180°
  const right = [Math.cos(b), Math.sin(b)];
  const down = [-Math.sin(b), Math.cos(b)];
  return [
    view.width / 2 + dx * right[0] + dy * right[1],
    view.height / 2 + dx * down[0] + dy * down[1],
  ];
}

const metres = (e: number, n: number): LonLat => [
  37.5 + e / (111320 * Math.cos((55.7 * Math.PI) / 180)),
  55.7 + n / 111320,
];

function expectInside(points: LonLat[], cam: VideoCamera) {
  for (const p of points) {
    const [sx, sy] = project(p, cam);
    expect(sx).toBeGreaterThanOrEqual(pad.left - 0.5);
    expect(sx).toBeLessThanOrEqual(view.width - pad.right + 0.5);
    expect(sy).toBeGreaterThanOrEqual(pad.top - 0.5);
    expect(sy).toBeLessThanOrEqual(view.height - pad.bottom + 0.5);
  }
}

describe('legCamera', () => {
  it('turns the map so that A is at the left edge and B at the right one', () => {
    // A → B heads south-east; runners bulge sideways a little
    const a = metres(0, 0);
    const b = metres(300, -400);
    const path = [metres(50, -50), metres(200, -150), metres(250, -350), metres(120, -260)];
    const cam = legCamera(a, b, path, view, pad, opts);

    const [ax, ay] = project(a, cam);
    const [bx, by] = project(b, cam);
    expect(ax).toBeCloseTo(pad.left, 0);
    expect(bx).toBeCloseTo(view.width - pad.right, 0);
    expect(ay).toBeCloseTo(by, 3);
    expectInside([a, b, ...path], cam);
  });

  it('keeps a wide route choice in view by zooming out, not cutting it', () => {
    const a = metres(0, 0);
    const b = metres(400, 0);
    // a detour far to the north: the height limits the zoom now
    const path = [metres(100, 500), metres(300, 500)];
    const cam = legCamera(a, b, path, view, pad, opts);
    expect(cam.bearing).toBeCloseTo(0, 6);
    expectInside([a, b, ...path], cam);
    const [, topY] = project(path[0], cam);
    expect(topY).toBeCloseTo(pad.top, 0);
  });

  it('A north of B: east is up, so A → B still runs left to right', () => {
    const cam = legCamera(metres(0, 300), metres(0, 0), [], view, pad, opts);
    expect(cam.bearing).toBeCloseTo(90, 6);
  });

  it('stays north-up when turning is off', () => {
    const cam = legCamera(metres(0, 0), metres(300, -400), [], view, pad, {
      ...opts,
      rotate: false,
    });
    expect(cam.bearing).toBe(0);
    expectInside([metres(0, 0), metres(300, -400)], cam);
  });
});

describe('legRunnerIds', () => {
  /** A track along `pts` (one point every 10 s), trimmed to [trimStart, trimEnd] */
  function track(id: string, pts: LonLat[], trimStart: number, trimEnd: number) {
    return {
      id,
      visible: true,
      trimStartSec: trimStart,
      trimEndSec: trimEnd,
      durationSec: (pts.length - 1) * 10,
      points: pts.map(([lon, lat], i) => ({ lon, lat, t: i * 10 })),
    } as unknown as ParticipantTrack;
  }
  const a = metres(0, 0);
  const b = metres(200, 0);

  it('keeps runners whose replayed part goes from A to B, drops the ones who were elsewhere', () => {
    const ran = track('ran', [metres(-100, 0), metres(5, 3), metres(100, 40), metres(195, -4)], 10, 30);
    // Trimmed "from the point closest to A to the one closest to B" — 400 m away from both
    const elsewhere = track('elsewhere', [metres(0, -400), metres(300, -900), metres(200, -400)], 0, 20);
    const ids = legRunnerIds([ran, elsewhere], a, b);
    expect([...ids]).toEqual(['ran']);
  });

  it('drops a runner who reached A but stopped short of B', () => {
    const short = track('short', [metres(0, 5), metres(60, 10), metres(90, 10)], 0, 20);
    expect(legRunnerIds([short], a, b).size).toBe(0);
  });
});

describe('courseCamera', () => {
  it('turns a long north–south course sideways, north never pointing down', () => {
    const course = [metres(0, 0), metres(60, 900), metres(-40, 1800), metres(20, 2400)];
    const cam = courseCamera(course, view, pad, opts)!;
    // A thin course is largest along the frame's diagonal (atan(820/589) ≈ 54°)
    expect(Math.abs(cam.bearing)).toBeGreaterThan(45);
    expect(Math.abs(cam.bearing)).toBeLessThanOrEqual(90);
    expectInside(course, cam);
    const northUp = courseCamera(course, view, pad, { ...opts, rotate: false })!;
    expect(cam.zoom).toBeGreaterThan(northUp.zoom + 0.5);
  });

  it('leaves a course that already fits north-up as it is', () => {
    const course = [metres(0, 0), metres(900, 100), metres(1200, 600), metres(100, 550)];
    const cam = courseCamera(course, view, pad, opts)!;
    expect(cam.bearing).toBe(0);
    expectInside(course, cam);
  });
});
