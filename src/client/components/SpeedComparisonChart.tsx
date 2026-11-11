import React, { useMemo } from 'react';
import {
  raceTimeOfTrackPoint,
  type SpeedNormMode,
} from '../../shared/trackParser.js';
import type { ParticipantTrack, TimeMode } from '../../shared/types.js';

/** Speed (km/h) of every runner over the race clock; click to seek */
export const SpeedComparisonChart: React.FC<{
  participants: ParticipantTrack[];
  currentTimeSec: number;
  totalDurationSec: number;
  timeMode: TimeMode;
  eventEpochZeroMs: number;
  speedNormMode: SpeedNormMode;
  referenceSpeedMs: number;
  onSeek: (sec: number) => void;
}> = ({
  participants,
  currentTimeSec,
  totalDurationSec,
  timeMode,
  eventEpochZeroMs,
  speedNormMode,
  referenceSpeedMs,
  onSeek,
}) => {
  const width = 320;
  const height = 84;
  const maxKmh = 22;

  const cursorX =
    totalDurationSec > 0
      ? Math.min(width, Math.max(0, (currentTimeSec / totalDurationSec) * width))
      : 0;

  // The lines depend on the tracks and modes, not on the clock: only the cursor moves
  const lines = useMemo(
    () =>
      participants
        .filter((p) => p.visible && p.points.length >= 2)
        .map((p) => {
          const step = Math.max(1, Math.floor(p.points.length / 80));
          const pts: string[] = [];
          for (let i = 0; i < p.points.length; i += step) {
            const pt = p.points[i];
            if (pt.t < p.trimStartSec || pt.t > p.trimEndSec) continue;
            // Same race clock as the map replay, in every time/speed mode
            const activeT = raceTimeOfTrackPoint(
              p,
              pt,
              timeMode,
              eventEpochZeroMs,
              speedNormMode,
              referenceSpeedMs
            );
            if (activeT < 0 || activeT > totalDurationSec) continue;
            const x = (activeT / totalDurationSec) * width;
            const kmh = Math.min(maxKmh, pt.speedMs * 3.6);
            const y = height - (kmh / maxKmh) * (height - 8) - 4;
            pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
          }
          return { id: p.id, color: p.color, points: pts.join(' ') };
        }),
    [participants, totalDurationSec, timeMode, eventEpochZeroMs, speedNormMode, referenceSpeedMs]
  );

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full flex-1 bg-slate-900/60 rounded-lg border border-slate-800/80 cursor-pointer overflow-visible"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const rel = Math.max(
          0,
          Math.min(1, (e.clientX - rect.left) / rect.width)
        );
        onSeek(rel * totalDurationSec);
      }}
    >
      <line
        x1={0}
        y1={height / 2}
        x2={width}
        y2={height / 2}
        stroke="#1e293b"
        strokeDasharray="3 3"
      />

      {lines.map((l) => (
        <polyline
          key={l.id}
          fill="none"
          stroke={l.color}
          strokeWidth={1.6}
          strokeOpacity={0.85}
          points={l.points}
        />
      ))}

      <line
        x1={cursorX}
        y1={0}
        x2={cursorX}
        y2={height}
        stroke="#10b981"
        strokeWidth={1.5}
      />
    </svg>
  );
};
