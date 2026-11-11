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
  nextIsStart,
  nextIsFinish,
  onNextIsStart,
  onNextIsFinish,
  onSaveCourse,
  onAutoFitCourse,
  onCourseEditDone,
  snapStage,
  onCancelSnap,
}) => (
  <>
    {/* Course editing: click the map to place start → controls → finish */}
    {courseEdit && (
      <div className="relative z-10 px-3 py-1.5 bg-fuchsia-950/80 border-b border-fuchsia-500/40 text-xs text-fuchsia-100 flex flex-wrap items-center justify-between gap-2 shrink-0">
        <span>
          {courseControls.length === 0 || nextIsStart
            ? '▲ Кликните СТАРТ (треугольник) на карте'
            : nextIsFinish
              ? '◎ Кликните ФИНИШ на карте'
              : `Кликните КП ${
                  courseControls.filter((c) => c.kind === 'control').length + 1
                } по порядку. Маркеры можно перетаскивать, правый клик — удалить`}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              onNextIsStart((v) => !v);
              onNextIsFinish(false);
            }}
            className={`px-2 py-0.5 rounded border transition ${
              nextIsStart
                ? 'bg-fuchsia-500 border-fuchsia-300 text-white'
                : 'bg-slate-900 border-slate-700 text-fuchsia-200 hover:text-white'
            }`}
            title="Поставить или передвинуть старт (треугольник): он всегда первый"
          >
            {courseControls.some((c) => c.kind === 'start') ? '▲ Переставить старт' : '▲ Следующий клик — старт'}
          </button>
          <button
            onClick={() => {
              onNextIsFinish((v) => !v);
              onNextIsStart(false);
            }}
            disabled={courseControls.length === 0}
            className={`px-2 py-0.5 rounded border transition disabled:opacity-40 ${
              nextIsFinish
                ? 'bg-fuchsia-500 border-fuchsia-300 text-white'
                : 'bg-slate-900 border-slate-700 text-fuchsia-200 hover:text-white'
            }`}
          >
            ◎ Следующий клик — финиш
          </button>
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
          {courseControls.length >= 3 && hasTracks && (
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
