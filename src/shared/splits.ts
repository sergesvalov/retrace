import { haversineDistanceM } from './georef.js';
import type { ControlPoint, ParticipantTrack } from './types.js';

export interface SplitTime {
  controlId: string;
  controlCode: string;
  /** Elapsed time from start of runner's active track (seconds) */
  cumulativeSec: number | null;
  /** Time spent on the leg from the previous control (seconds) */
  legSec: number | null;
  /** Distance covered on the leg (meters) */
  legDistM: number | null;
  /** Average speed on the leg (m/s) */
  legSpeedMs: number | null;
  /** Rank on this specific leg among all visible participants (1 = fastest) */
  legRank?: number;
  /** Time loss behind the fastest runner on this leg (seconds) */
  legBehindSec?: number;
}

export interface ParticipantSplits {
  participantId: string;
  participantName: string;
  color: string;
  totalTimeSec: number | null;
  splits: SplitTime[];
}

/**
 * Automatically detects when each participant passes through the ordered sequence
 * of ControlPoints (within `cp.radiusM` + GPS tolerance) and computes leg splits & rankings.
 */
export function computeSplitsForEvent(
  participants: ParticipantTrack[],
  controlPoints: ControlPoint[]
): ParticipantSplits[] {
  if (controlPoints.length < 2) return [];

  const results: ParticipantSplits[] = participants
    .filter((p) => p.visible)
    .map((p) => {
      const pts = p.points.filter(
        (pt) => pt.t >= p.trimStartSec && pt.t <= p.trimEndSec
      );
      if (pts.length < 2) {
        return {
          participantId: p.id,
          participantName: p.name,
          color: p.color,
          totalTimeSec: null,
          splits: [],
        };
      }

      const startT = pts[0].t;
      const startDist = pts[0].distM;
      let searchIdx = 0;

      const matchedControls: Array<{
        cp: ControlPoint;
        pointIdx: number;
        tRel: number;
        distRel: number;
      } | null> = [];

      for (let cIdx = 0; cIdx < controlPoints.length; cIdx++) {
        const cp = controlPoints[cIdx];
        // Allow generous forest GPS capture radius (at least 45m)
        const captureRadiusM = Math.max(cp.radiusM, 45);

        let bestIdx = -1;
        let bestDist = Infinity;

        for (let i = searchIdx; i < pts.length; i++) {
          const d = haversineDistanceM(pts[i].lon, pts[i].lat, cp.lon, cp.lat);
          if (d <= captureRadiusM) {
            if (d < bestDist) {
              bestDist = d;
              bestIdx = i;
            }
          } else if (bestIdx !== -1 && d > captureRadiusM * 1.4) {
            // Runner has entered and now left the control circle -> lock in minimum
            break;
          }
        }

        if (bestIdx !== -1) {
          const pt = pts[bestIdx];
          matchedControls.push({
            cp,
            pointIdx: bestIdx,
            tRel: Math.max(0, Math.round(pt.t - startT)),
            distRel: Math.max(0, Math.round(pt.distM - startDist)),
          });
          searchIdx = bestIdx + 1;
        } else {
          matchedControls.push(null);
        }
      }

      // Build leg-by-leg splits from control i-1 -> control i
      const splits: SplitTime[] = [];
      for (let cIdx = 1; cIdx < controlPoints.length; cIdx++) {
        const prevMatch = matchedControls[cIdx - 1];
        const currMatch = matchedControls[cIdx];
        const cp = controlPoints[cIdx];

        if (prevMatch && currMatch) {
          const legSec = Math.max(1, currMatch.tRel - prevMatch.tRel);
          const legDistM = Math.max(1, currMatch.distRel - prevMatch.distRel);
          splits.push({
            controlId: cp.id,
            controlCode: `${controlPoints[cIdx - 1].code} → ${cp.code}`,
            cumulativeSec: currMatch.tRel,
            legSec,
            legDistM,
            legSpeedMs: Math.round((legDistM / legSec) * 100) / 100,
          });
        } else {
          splits.push({
            controlId: cp.id,
            controlCode: `${controlPoints[cIdx - 1].code} → ${cp.code}`,
            cumulativeSec: null,
            legSec: null,
            legDistM: null,
            legSpeedMs: null,
          });
        }
      }

      const lastMatch = matchedControls[matchedControls.length - 1];
      return {
        participantId: p.id,
        participantName: p.name,
        color: p.color,
        totalTimeSec: lastMatch ? lastMatch.tRel : null,
        splits,
      };
    });

  // Compute leg rankings & time losses
  const legCount = controlPoints.length - 1;
  for (let legIdx = 0; legIdx < legCount; legIdx++) {
    const validLegTimes = results
      .map((r) => r.splits[legIdx]?.legSec)
      .filter((v): v is number => typeof v === 'number' && v > 0)
      .sort((a, b) => a - b);

    if (validLegTimes.length === 0) continue;
    const bestLegSec = validLegTimes[0];

    for (const r of results) {
      const sp = r.splits[legIdx];
      if (sp && sp.legSec !== null) {
        sp.legBehindSec = sp.legSec - bestLegSec;
        sp.legRank = validLegTimes.indexOf(sp.legSec) + 1;
      }
    }
  }

  return results;
}

