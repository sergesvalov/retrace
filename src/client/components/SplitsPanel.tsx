import React from 'react';
import type { ParticipantSplits } from '../../shared/course.js';
import { formatDuration } from '../../shared/trackParser.js';
import { COURSE_COLOR } from './useCourseOverlay.js';

interface Props {
  splits: ParticipantSplits[];
  labels: string[];
  selectedLegIdx: number | null;
  onSelectLeg: (legIdx: number) => void;
  onWholeCourse: () => void;
  trackCorrection: boolean;
  onToggleTrackCorrection: (on: boolean) => void;
}

/**
 * Who ran each leg how fast. Legs are rows and runners columns, so a handful of friends
 * fits the narrow sidebar. Clicking a leg replays everyone from its start control.
 */
export const SplitsPanel: React.FC<Props> = ({
  splits,
  labels,
  selectedLegIdx,
  onSelectLeg,
  onWholeCourse,
  trackCorrection,
  onToggleTrackCorrection,
}) => {
  const legCount = labels.length - 1;
  const cell = (
    time: number | null,
    rank: number | null,
    title: string,
    key: string
  ) => (
    <td
      key={key}
      title={title}
      className={`px-1.5 py-1 text-right font-mono whitespace-nowrap ${
        rank === 1 ? 'text-emerald-300 font-semibold' : 'text-slate-200'
      }`}
    >
      {time === null ? (
        <span className="text-slate-500">—</span>
      ) : (
        <>
          {formatDuration(time)}
          <sup className="ml-0.5 text-[9px] text-slate-400">{rank}</sup>
        </>
      )}
    </td>
  );

  return (
    <div className="p-3 border-b border-slate-800 space-y-2 text-xs shrink-0">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold" style={{ color: COURSE_COLOR }}>
          Сплиты по КП
        </span>
        <div className="flex items-center gap-2">
          <label
            className="inline-flex items-center gap-1 text-[11px] text-slate-300 cursor-pointer"
            title="Сдвинуть треки так, чтобы они проходили точно через отметки на КП (снос GPS поперёк хода)"
          >
            <input
              type="checkbox"
              checked={trackCorrection}
              onChange={(e) => onToggleTrackCorrection(e.target.checked)}
              className="accent-fuchsia-500"
            />
            Доводка до КП
          </label>
          <button
            onClick={onWholeCourse}
            className="text-[11px] text-emerald-400 hover:underline"
            title="Всем старт с треугольника и финиш на финише, время от 00:00"
          >
            ⏱ Вся дистанция
          </button>
        </div>
      </div>

      {splits.length === 0 ? (
        <div className="text-slate-400">Загрузите треки участников</div>
      ) : (
        <div className="max-h-64 overflow-auto rounded-lg border border-slate-800">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-slate-900">
              <tr>
                <th className="px-1.5 py-1 text-left text-slate-400 font-normal">
                  Перегон
                </th>
                {splits.map((s) => (
                  <th
                    key={s.participantId}
                    className="px-1.5 py-1 text-right font-semibold max-w-[90px] truncate"
                    title={s.name}
                  >
                    <span
                      className="inline-block w-2 h-2 rounded-full mr-1 align-middle"
                      style={{ background: s.color }}
                    />
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: legCount }, (_, k) => (
                <tr
                  key={k}
                  onClick={() => onSelectLeg(k)}
                  className={`cursor-pointer border-t border-slate-800/70 ${
                    selectedLegIdx === k
                      ? 'bg-fuchsia-900/40'
                      : 'hover:bg-slate-800/60'
                  }`}
                  title="Показать этот перегон: все стартуют с его начала"
                >
                  <td className="px-1.5 py-1 text-slate-300 whitespace-nowrap">
                    {labels[k]}→{labels[k + 1]}
                  </td>
                  {splits.map((s) =>
                    cell(
                      s.legTimes[k],
                      s.legRanks[k],
                      s.legTimes[k] === null
                        ? `${s.name}: КП ${labels[s.passages[k].detected ? k + 1 : k]} не найден на треке (ближе ${Math.round(
                            (s.passages[k].detected ? s.passages[k + 1] : s.passages[k]).distM
                          )} м не подходил)`
                        : `${s.name}: отметка в ${Math.round(s.passages[k + 1].distM)} м от центра КП`,
                      s.participantId
                    )
                  )}
                </tr>
              ))}
              <tr className="border-t border-slate-700 bg-slate-900/80">
                <td className="px-1.5 py-1 text-slate-300 font-semibold">Итого</td>
                {splits.map((s) =>
                  cell(s.totalSec, s.totalRank, `${s.name}: вся дистанция`, s.participantId)
                )}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
