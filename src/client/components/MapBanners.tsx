import React from 'react';
import { Check } from 'lucide-react';
import type { CourseControl } from '../../shared/types.js';

export type SnapStage =
  | 'idle'
  | 'spot_start'
  | 'leg_start'
  | 'leg_end'
  | 'scalebar_start'
  | 'scalebar_end'
  | 'pin_map'
  | 'pin_base';

interface Props {
  courseEdit: boolean;
  courseControls: CourseControl[];
  hasTracks: boolean;
  /** The course is drawn on a scan, so the scan can be fitted by it */
  canFitScan: boolean;
  nextIsStart: boolean;
  nextIsFinish: boolean;
  onNextIsStart: (v: boolean | ((prev: boolean) => boolean)) => void;
  onNextIsFinish: (v: boolean | ((prev: boolean) => boolean)) => void;
  onSaveCourse: (controls: CourseControl[]) => void;
  onAutoFitCourse: () => void;
  onCourseEditDone: () => void;
  snapStage: SnapStage;
  onCancelSnap: () => void;
}

/** Prompts above the map for click modes: placing the course, picking points */
export const MapBanners: React.FC<Props> = ({
  courseEdit,
  courseControls,
  hasTracks,
  canFitScan,
  nextIsStart,
  nextIsFinish,
  onNextIsStart,
  onNextIsFinish,
  onSaveCourse,
  onAutoFitCourse,
  onCourseEditDone,
  snapStage,
  onCancelSnap,
}) => {
  // What the next click places (the workspace's addControlAt follows the same rules)
  const placing: CourseControl['kind'] =
    courseControls.length === 0 || nextIsStart ? 'start' : nextIsFinish ? 'finish' : 'control';
  const controlCount = courseControls.filter((c) => c.kind === 'control').length;
  return (
  <>
    {/* Course editing: click the map to place start → controls → finish */}
    {courseEdit && (
      <div className="relative z-10 px-3 py-1.5 bg-fuchsia-950/80 border-b border-fuchsia-500/40 text-xs text-fuchsia-100 flex flex-wrap items-center justify-between gap-2 shrink-0">
        <span>
          {placing === 'start'
            ? courseControls.some((c) => c.kind === 'start')
              ? '▲ Кликните новое место СТАРТА — старый переедет'
              : '▲ Кликните СТАРТ (треугольник) на карте'
            : placing === 'finish'
              ? courseControls.some((c) => c.kind === 'finish')
                ? '◎ Кликните новое место ФИНИША — старый переедет'
                : '◎ Кликните ФИНИШ на карте'
              : `Кликните КП ${controlCount + 1} — КП встают по порядку, сколько угодно. Маркеры можно перетаскивать, правый клик — удалить`}
        </span>
        <div className="flex items-center gap-1.5">
          {/* What the next click places: start is always first, finish last, controls between */}
          <div className="flex items-center gap-0.5 p-0.5 rounded bg-slate-950 border border-slate-700">
            {(
              [
                ['start', '▲ Старт', 'Старт (треугольник) — всегда первый; один на трассу'],
                ['control', '○ КП', 'КП по порядку: 1, 2, 3… — сколько угодно, встают перед финишем'],
                ['finish', '◎ Финиш', 'Финиш (двойной круг) — всегда последний; один на трассу'],
              ] as const
            ).map(([kind, label, title]) => (
              <button
                key={kind}
                title={title}
                disabled={kind !== 'start' && courseControls.length === 0}
                onClick={() => {
                  onNextIsStart(kind === 'start');
                  onNextIsFinish(kind === 'finish');
                }}
                className={`px-2 py-0.5 rounded transition disabled:opacity-40 ${
                  placing === kind
                    ? 'bg-fuchsia-500 text-white font-semibold'
                    : 'text-fuchsia-200 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => onSaveCourse(courseControls.slice(0, -1))}
            disabled={courseControls.length === 0}
            className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-200 hover:text-white disabled:opacity-40"
          >
            ↶ Убрать последний
          </button>
          <button
            onClick={() => {
              if (window.confirm('Удалить все КП дистанции?')) onSaveCourse([]);
            }}
            disabled={courseControls.length === 0}
            className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-400 hover:text-rose-300 disabled:opacity-40"
          >
            Очистить
          </button>
          {canFitScan && courseControls.length >= 3 && hasTracks && (
            <button
              onClick={onAutoFitCourse}
              className="px-2 py-0.5 rounded bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-semibold"
              title="Подогнать карту так, чтобы КП совпали с отметками участников"
            >
              🎯 Подогнать карту по КП
            </button>
          )}
          <button
            onClick={() => onCourseEditDone()}
            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
          >
            <Check className="w-3.5 h-3.5" />
            Готово
          </button>
        </div>
      </div>
    )}

    {/* Active Map Click Prompt Banner (for Spot Start, Leg Selection or Scale Bar) */}
    {snapStage !== 'idle' && (
      <div className="relative z-10 px-3 py-1.5 bg-fuchsia-600/25 border-b border-fuchsia-400/50 text-fuchsia-200 text-xs font-medium flex items-center justify-between animate-pulse shrink-0">
        <span>
          {snapStage === 'pin_map' &&
            '📍 Шаг 1/2: кликните приметное место НА СКАНЕ (перекрёсток, угол здания или забора, мост)'}
          {snapStage === 'pin_base' &&
            '📍 Шаг 2/2: скан скрыт — кликните то же место на подложке'}
          {snapStage === 'scalebar_start' &&
            '📏 Шаг 1/2: кликните ЛЕВЫЙ конец масштабной линейки на карте'}
          {snapStage === 'scalebar_end' &&
            '📏 Шаг 2/2: кликните ПРАВЫЙ конец линейки, затем введите её длину в метрах'}
          {snapStage === 'spot_start' &&
            '🏁 Кликните любую точку на карте (КП / развилку), чтобы запустить все треки одновременно из этого места!'}
          {snapStage === 'leg_start' &&
            '🧭 Шаг 1/2: Кликните НАЧАЛО перегона (КП А) на карте'}
          {snapStage === 'leg_end' &&
            '🧭 Шаг 2/2: Теперь кликните КОНЕЦ перегона (КП Б) на карте'}
        </span>
        <button
          onClick={onCancelSnap}
          className="px-2 py-0.5 rounded bg-slate-900/80 text-slate-200 hover:text-white"
        >
          Отмена
        </button>
      </div>
    )}

  </>
  );
};
