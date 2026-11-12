import { computeSplits } from './course.js';
import type {
  CourseControl,
  GroundControl,
  GroundCourseDef,
  ParticipantTrack,
} from './types.js';

/**
 * Several courses on one area (A, B, C…): the area has one start, one finish and a set of
 * controls; each course runs start → its controls in order → finish. A control may belong to
 * several courses. Without course definitions the area is a single course, in order.
 */

type Matrix = [number, number, number, number, number, number];

/** Id of the only course when no courses are defined */
export const SINGLE_COURSE_ID = 'single';

export interface ResolvedCourse {
  id: string;
  /** '' for the only course */
  name: string;
  /** start → controls → finish, in course order */
  controls: GroundControl[];
}

/** Each course as an ordered list of its points (shared start and finish included) */
export function resolveCourses(
  points: GroundControl[],
  courses: GroundCourseDef[] | undefined
): ResolvedCourse[] {
  if (!courses?.length) return [{ id: SINGLE_COURSE_ID, name: '', controls: points }];
  const start = points.find((c) => c.kind === 'start');
  const finish = points.find((c) => c.kind === 'finish');
  const byId = new Map(points.map((c) => [c.id, c]));
  return courses.map((def) => ({
    id: def.id,
    name: def.name,
    controls: [
      ...(start ? [start] : []),
      ...def.controlIds
        .map((id) => byId.get(id))
        .filter((c): c is GroundControl => c?.kind === 'control'),
      ...(finish ? [finish] : []),
    ],
  }));
}

/**
 * Apply an edit of one course (its points before → after, in order) to the area.
 * A removed control stays on the area while another course still uses it; start and finish
 * are shared, so there is only ever one of each.
 */
export function applyCourseEdit(
  points: GroundControl[],
  courses: GroundCourseDef[] | undefined,
  courseId: string,
  before: GroundControl[],
  after: GroundControl[]
): { points: GroundControl[]; courses: GroundCourseDef[] | undefined } {
  if (!courses?.length) return { points: after, courses };
  const kept = new Set(after.map((c) => c.id));
  const usedElsewhere = new Set(
    courses.filter((c) => c.id !== courseId).flatMap((c) => c.controlIds)
  );
  const byId = new Map(points.map((c) => [c.id, c]));
  for (const c of before) {
    if (kept.has(c.id)) continue;
    if (c.kind !== 'control' || !usedElsewhere.has(c.id)) byId.delete(c.id);
    else if (byId.get(c.id)?.common) {
      // Taken off one course: no longer common to all
      byId.set(c.id, { ...byId.get(c.id)!, common: undefined });
    }
  }
  for (const c of after) {
    if (c.kind !== 'control') {
      for (const [id, p] of byId) if (p.kind === c.kind && id !== c.id) byId.delete(id);
    }
    byId.set(c.id, c);
  }
  const ownIds = after.filter((c) => c.kind === 'control').map((c) => c.id);
  // A control made common joins every other course too (at its end, before the finish)
  const commonIds = ownIds.filter((id) => byId.get(id)?.common);
  return {
    points: [...byId.values()],
    courses: courses.map((def) =>
      def.id === courseId
        ? { ...def, controlIds: ownIds }
        : {
            ...def,
            controlIds: [
              ...def.controlIds,
              ...commonIds.filter((id) => !def.controlIds.includes(id)),
            ],
          }
    ),
  };
}

/** Next free course name: A, B, C, … */
export function nextCourseName(courses: { name: string }[]): string {
  const used = new Set(courses.map((c) => c.name));
  for (let i = 0; i < 26; i++) {
    const name = String.fromCharCode(65 + i);
    if (!used.has(name)) return name;
  }
  return String(courses.length + 1);
}

/**
 * Add a course. The first one turns the single course into course "A" (its controls kept)
 * plus a new empty course "B".
 */
export function addCourse(
  points: GroundControl[],
  courses: GroundCourseDef[] | undefined,
  makeId: () => string
): GroundCourseDef[] {
  const list: GroundCourseDef[] = courses?.length
    ? [...courses]
    : [
        {
          id: makeId(),
          name: 'A',
          controlIds: points.filter((c) => c.kind === 'control').map((c) => c.id),
        },
      ];
  // Controls common to all courses: in the order the first course has them
  const commonIds = new Set(points.filter((c) => c.common).map((c) => c.id));
  const ordered = [
    ...list[0].controlIds.filter((id) => commonIds.has(id)),
    ...[...commonIds].filter((id) => !list[0].controlIds.includes(id)),
  ];
  list.push({ id: makeId(), name: nextCourseName(list), controlIds: ordered });
  return list;
}

/** Remove a course; its controls that no other course uses leave the area */
export function removeCourse(
  points: GroundControl[],
  courses: GroundCourseDef[],
  courseId: string
): { points: GroundControl[]; courses: GroundCourseDef[] } {
  const rest = courses.filter((c) => c.id !== courseId);
  const used = new Set(rest.flatMap((c) => c.controlIds));
  return {
    points: points.filter((p) => p.kind !== 'control' || used.has(p.id)),
    courses: rest,
  };
}

/**
 * Which course each runner ran: the one whose controls they punched the largest share of
 * (at least half); on a tie the longer course (a runner of a long course also punches every
 * control of a shorter one inside it). A course set by hand wins. null = no course fits.
 */
export function assignRunnersToCourses(
  participants: ParticipantTrack[],
  courses: { id: string; controls: CourseControl[] }[],
  matrix: Matrix
): Map<string, string | null> {
  const known = new Set(courses.map((c) => c.id));
  const best = new Map<string, { id: string; share: number; punched: number } | null>();
  for (const p of participants) best.set(p.id, null);
  for (const course of courses) {
    const total = course.controls.filter((c) => c.kind === 'control').length;
    if (total === 0) continue;
    for (const s of computeSplits(participants, course.controls, matrix)) {
      const punched = s.passages.filter(
        (pass, i) => pass.detected && course.controls[i].kind === 'control'
      ).length;
      const share = punched / total;
      if (share < 0.5) continue;
      const cur = best.get(s.participantId);
      if (!cur || share > cur.share || (share === cur.share && punched > cur.punched)) {
        best.set(s.participantId, { id: course.id, share, punched });
      }
    }
  }
  const out = new Map<string, string | null>();
  for (const p of participants) {
    out.set(
      p.id,
      p.courseId && known.has(p.courseId) ? p.courseId : best.get(p.id)?.id ?? null
    );
  }
  return out;
}
