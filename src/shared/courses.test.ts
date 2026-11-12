import { describe, expect, it } from 'vitest';
import { GROUND_MATRIX, groundToCourse } from './course.js';
import {
  addCourse,
  applyCourseEdit,
  assignRunnersToCourses,
  nextCourseName,
  removeCourse,
  resolveCourses,
  SINGLE_COURSE_ID,
} from './courses.js';
import { normalizeSamplesToTrack } from './trackParser.js';
import type { GroundControl, GroundCourseDef } from './types.js';

const LAT0 = 55.7;
const LON0 = 37.5;
const at = (e: number, n: number): [number, number] => [
  LON0 + e / (111_320 * Math.cos((LAT0 * Math.PI) / 180)),
  LAT0 + n / 111_320,
];
const pt = (id: string, kind: GroundControl['kind'], e: number, n: number): GroundControl => {
  const [lon, lat] = at(e, n);
  return { id, kind, lon, lat };
};

// Area: shared start and finish, four controls
const S = pt('s', 'start', 0, 0);
const C1 = pt('c1', 'control', 300, 0);
const C2 = pt('c2', 'control', 300, 300);
const C3 = pt('c3', 'control', 0, 300);
const C4 = pt('c4', 'control', -200, 150);
const F = pt('f', 'finish', 0, 30);
const POINTS = [S, C1, C2, C3, C4, F];
// A: S-1-2-3-F (long), B: S-1-F (short, inside A), C: S-4-F
const COURSES: GroundCourseDef[] = [
  { id: 'A', name: 'A', controlIds: ['c1', 'c2', 'c3'] },
  { id: 'B', name: 'B', controlIds: ['c1'] },
  { id: 'C', name: 'C', controlIds: ['c4'] },
];

const ids = (list: { id: string }[]) => list.map((c) => c.id);

describe('resolveCourses', () => {
  it('builds every course as shared start → its controls → shared finish', () => {
    const courses = resolveCourses(POINTS, COURSES);
    expect(courses.map((c) => [c.name, ids(c.controls)])).toEqual([
      ['A', ['s', 'c1', 'c2', 'c3', 'f']],
      ['B', ['s', 'c1', 'f']],
      ['C', ['s', 'c4', 'f']],
    ]);
  });

  it('is one course in the stored order without course definitions', () => {
    const [only] = resolveCourses([S, C2, C1, F], undefined);
    expect(only.id).toBe(SINGLE_COURSE_ID);
    expect(ids(only.controls)).toEqual(['s', 'c2', 'c1', 'f']);
  });
});

describe('applyCourseEdit', () => {
  const courseB = resolveCourses(POINTS, COURSES)[1].controls;

  it('a control removed from one course stays while another course uses it', () => {
    const after = courseB.filter((c) => c.id !== 'c1');
    const res = applyCourseEdit(POINTS, COURSES, 'B', courseB, after);
    expect(ids(res.points)).toContain('c1');
    expect(res.courses!.find((c) => c.id === 'B')!.controlIds).toEqual([]);
    expect(res.courses!.find((c) => c.id === 'A')!.controlIds).toEqual(['c1', 'c2', 'c3']);
  });

  it('a control used by no other course leaves the area', () => {
    const courseC = resolveCourses(POINTS, COURSES)[2].controls;
    const res = applyCourseEdit(POINTS, COURSES, 'C', courseC, [S, F]);
    expect(ids(res.points)).not.toContain('c4');
  });

  it('a new or shared control joins the course; start and finish stay one each', () => {
    const newStart = pt('s2', 'start', 10, 10);
    const newCtl = pt('c5', 'control', 100, 100);
    const after = [newStart, C1, C3, newCtl, F];
    const res = applyCourseEdit(POINTS, COURSES, 'B', courseB, after);
    expect(res.points.filter((c) => c.kind === 'start').map((c) => c.id)).toEqual(['s2']);
    expect(res.courses!.find((c) => c.id === 'B')!.controlIds).toEqual(['c1', 'c3', 'c5']);
    // moving the start moved it for every course
    expect(ids(resolveCourses(res.points, res.courses)[0].controls)[0]).toBe('s2');
  });
});

describe('controls common to all courses', () => {
  it('a common control added to one course joins every course, before the finish', () => {
    const courseC = resolveCourses(POINTS, COURSES)[2].controls;
    const go = { ...pt('go', 'control', 50, 60), common: true };
    const after = [...courseC.slice(0, -1), go, F];
    const res = applyCourseEdit(POINTS, COURSES, 'C', courseC, after);
    const resolved = resolveCourses(res.points, res.courses);
    for (const c of resolved) expect(ids(c.controls).slice(-2)).toEqual(['go', 'f']);
  });

  it('a course added later gets the common controls', () => {
    const points = [...POINTS, { ...pt('go', 'control', 50, 60), common: true }];
    const courses = COURSES.map((c) => ({ ...c, controlIds: [...c.controlIds, 'go'] }));
    const list = addCourse(points, courses, () => 'D');
    expect(list[list.length - 1].controlIds).toEqual(['go']);
  });

  it('taken off one course it stays on the others, but is no longer common', () => {
    const points = [...POINTS, { ...pt('go', 'control', 50, 60), common: true }];
    const courses = COURSES.map((c) => ({ ...c, controlIds: [...c.controlIds, 'go'] }));
    const courseB = resolveCourses(points, courses)[1].controls;
    const res = applyCourseEdit(points, courses, 'B', courseB, courseB.filter((c) => c.id !== 'go'));
    expect(res.points.find((c) => c.id === 'go')?.common).toBeFalsy();
    expect(res.courses!.find((c) => c.id === 'A')!.controlIds).toContain('go');
    expect(res.courses!.find((c) => c.id === 'B')!.controlIds).not.toContain('go');
  });
});

describe('adding and removing courses', () => {
  it('the first extra course turns the single course into A and adds an empty B', () => {
    let n = 0;
    const list = addCourse([S, C1, C2, F], undefined, () => `id${++n}`);
    expect(list.map((c) => [c.name, c.controlIds])).toEqual([
      ['A', ['c1', 'c2']],
      ['B', []],
    ]);
    expect(nextCourseName(list)).toBe('C');
  });

  it('removing a course drops the controls only it used', () => {
    const res = removeCourse(POINTS, COURSES, 'C');
    expect(ids(res.points)).not.toContain('c4');
    expect(ids(res.points)).toContain('c1');
    expect(res.courses.map((c) => c.id)).toEqual(['A', 'B']);
  });
});

describe('assignRunnersToCourses', () => {
  /** A runner going through `route` (metres east/north) at 4 m/s */
  function runner(id: string, route: [number, number][], courseId?: string) {
    const samples = [];
    let t = 0;
    for (let i = 0; i < route.length - 1; i++) {
      const [x0, y0] = route[i];
      const [x1, y1] = route[i + 1];
      const steps = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 4));
      for (let s = 0; s < steps; s++, t++) {
        const [lon, lat] = at(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
        samples.push({ timeMs: Date.parse('2026-11-01T10:00:00Z') + t * 1000, lon, lat });
      }
    }
    const track = normalizeSamplesToTrack({
      id,
      name: id,
      color: '#ef4444',
      sourceFormat: 'gpx',
      samples,
    });
    return courseId ? { ...track, courseId } : track;
  }
  const courses = resolveCourses(POINTS, COURSES).map((c) => ({
    id: c.id,
    controls: groundToCourse(c.controls),
  }));

  it('gives each runner the course whose controls they punched; the longer one on a tie', () => {
    const onA = runner('a', [[0, 0], [300, 0], [300, 300], [0, 300], [0, 30]]);
    const onB = runner('b', [[0, 0], [300, 0], [0, 30]]);
    const onC = runner('c', [[0, 0], [-200, 150], [0, 30]]);
    const lost = runner('x', [[0, 0], [100, -400], [0, 30]]);
    const got = assignRunnersToCourses([onA, onB, onC, lost], courses, GROUND_MATRIX);
    expect(Object.fromEntries(got)).toEqual({ a: 'A', b: 'B', c: 'C', x: null });
  });

  it('a course set by hand wins', () => {
    const onB = runner('b', [[0, 0], [300, 0], [0, 30]], 'C');
    expect(assignRunnersToCourses([onB], courses, GROUND_MATRIX).get('b')).toBe('C');
  });
});
