import {
  findClosestPassagePoint,
  syncAllParticipantsToCommonStartSpot,
  syncAllParticipantsToSpot,
} from './trackParser.js';
import type { ParticipantTrack } from './types.js';

/**
 * Replay set-ups that change the runners' start/finish (trims): a leg, the whole course, a
 * start from a clicked spot. The server stores them for event editors; for everyone else
 * the client applies the same thing to its own copy only — viewers must not change what
 * others see.
 */

export interface TrimChange {
  participantId: string;
  trimStartSec: number;
  trimEndSec: number;
}

/** Start/finish of several runners at once (punches of a leg or of the whole course) */
export function applyTrims(participants: ParticipantTrack[], trims: TrimChange[]): string | null {
  for (const tr of trims) {
    const p = participants.find((x) => x.id === tr?.participantId);
    if (!p) continue;
    if (!Number.isFinite(tr.trimStartSec) || !Number.isFinite(tr.trimEndSec)) {
      return 'Некорректное время старта/финиша';
    }
    const start = Math.max(0, Math.min(p.durationSec, tr.trimStartSec));
    const end = Math.max(start, Math.min(p.durationSec, tr.trimEndSec));
    p.trimStartSec = start;
    p.trimEndSec = end;
    p.offsetSec = 0;
  }
  return null;
}

/**
 * Everyone starts at once: from `spot` (and finishes at `endSpot`, a leg A → B), or — with
 * no spot — from the common start of the tracks to their ends
 */
export function applySyncStart(
  participants: ParticipantTrack[],
  spot?: [number, number],
  endSpot?: [number, number]
): void {
  if (spot) {
    syncAllParticipantsToSpot(participants, spot[0], spot[1]);
    if (endSpot) {
      for (const p of participants) {
        const endHit = findClosestPassagePoint(p.points, endSpot[0], endSpot[1], p.trimStartSec + 3);
        if (endHit && endHit.pt.t > p.trimStartSec) {
          p.trimEndSec = Math.min(p.durationSec, Math.ceil(endHit.pt.t));
        }
      }
    }
    return;
  }
  for (const p of participants) p.trimEndSec = p.durationSec;
  syncAllParticipantsToCommonStartSpot(participants);
}
