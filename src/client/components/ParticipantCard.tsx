import React, { useRef, useState } from 'react';
import { Activity, Clock, Eye, EyeOff, Gauge, Heart, Pencil, Trash2 } from 'lucide-react';
import {
  formatDuration,
  formatPaceMinKm,
  type InterpolatedState,
} from '../../shared/trackParser.js';
import type { ParticipantTrack } from '../../shared/types.js';

interface Props {
  participant: ParticipantTrack;
  state: InterpolatedState | null;
  rank: number;
  gapMeters: number;
  /** Courses A, B, C… on the area (several courses only) */
  courses?: { id: string; name: string }[];
  /** The runner's course: set by hand or detected from the punches (null = none fits) */
  courseId?: string | null;
  onUpdate: (patch: Partial<ParticipantTrack>) => void;
  onDelete: () => void;
}

/** Longest runner name (the server cuts it to the same length) */
const MAX_NAME_LENGTH = 40;

/**
 * Runner name in the card. It comes from the track file ("Sia Running", "Morning Run"…):
 * click it to sign the runner; Enter or clicking away saves, Esc cancels.
 */
const RunnerName: React.FC<{ name: string; onRename: (name: string) => void }> = ({
  name,
  onRename,
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  // Esc closes the field: the blur that follows must not save
  const cancelledRef = useRef(false);
  if (draft === null) {
    return (
      <button
        onClick={() => {
          cancelledRef.current = false;
          setDraft(name);
        }}
        className="group flex items-center gap-1 min-w-0 text-left"
        title="Подписать бегуна: имя на карте, в сплитах и в видео"
      >
        <span className="text-sm font-semibold text-slate-100 truncate">{name}</span>
        <Pencil className="w-3 h-3 shrink-0 text-slate-500 opacity-0 group-hover:opacity-100 transition" />
      </button>
    );
  }
  const commit = () => {
    if (cancelledRef.current) return;
    const next = draft.trim().slice(0, MAX_NAME_LENGTH);
    setDraft(null);
    if (next && next !== name) onRename(next);
  };
  return (
    <input
      autoFocus
      value={draft}
      maxLength={MAX_NAME_LENGTH}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelledRef.current = true;
          setDraft(null);
        }
      }}
      placeholder="Имя бегуна"
      className="min-w-0 flex-1 bg-slate-950 border border-sky-500/60 rounded px-1.5 py-0.5 text-sm font-semibold text-slate-100 outline-none"
    />
  );
};

/** One runner in the live list: name, colour, visibility, pace / distance / HR now, start shift */
export const ParticipantCard: React.FC<Props> = ({
  participant: p,
  state,
  rank,
  gapMeters,
  courses,
  courseId,
  onUpdate,
  onDelete,
}) => (
    <div
            className={`p-3 rounded-xl border transition ${
        p.visible
          ? 'bg-slate-900 border-slate-800'
          : 'bg-slate-950/50 border-slate-900 opacity-50'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-xs font-bold text-slate-500">
            #{rank}
          </span>
          <input
            type="color"
            value={p.color}
            onChange={(e) =>
              onUpdate({ color: e.target.value })
            }
            className="w-4 h-4 shrink-0 rounded cursor-pointer bg-transparent border-0"
            title="Изменить цвет трека"
          />
          <RunnerName name={p.name} onRename={(name) => onUpdate({ name })} />
          {courses && courses.length > 0 && (
            // Course: detected from the punches ("авто") or set by hand
            <select
              value={p.courseId ?? ''}
              onChange={(e) => onUpdate({ courseId: e.target.value })}
              className="shrink-0 bg-slate-950 border border-fuchsia-500/40 rounded px-1 py-0.5 text-[11px] text-fuchsia-200"
              title="Трасса бегуна: «авто» — по отмеченным КП, или выберите сами"
            >
              <option value="">
                {p.courseId
                  ? 'авто'
                  : `авто: ${courses.find((c) => c.id === courseId)?.name ?? '—'}`}
              </option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  Трасса {c.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() =>
              onUpdate({ visible: !p.visible })
            }
            className="p-1 text-slate-400 hover:text-white"
            title={p.visible ? 'Скрыть трек' : 'Показать трек'}
          >
            {p.visible ? (
              <Eye className="w-3.5 h-3.5" />
            ) : (
              <EyeOff className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={onDelete}
            className="p-1 text-slate-500 hover:text-rose-400"
            title="Удалить участника"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {state && (
        <div className="grid grid-cols-3 gap-2 text-xs bg-slate-950/70 p-2 rounded-lg border border-slate-800/80">
          <div>
            <div className="text-[10px] text-slate-400 flex items-center gap-1">
              <Gauge className="w-3 h-3 text-emerald-400" />
              Темп / Скор.
            </div>
            <div className="font-mono font-semibold text-slate-100">
              {formatPaceMinKm(state.speedMs)}
            </div>
            <div className="text-[10px] font-mono text-slate-400">
              {(state.speedMs * 3.6).toFixed(1)} км/ч
            </div>
          </div>

          <div>
            <div className="text-[10px] text-slate-400 flex items-center gap-1">
              <Activity className="w-3 h-3 text-sky-400" />
              Дистанция
            </div>
            <div className="font-mono font-semibold text-slate-100">
              {(state.distM / 1000).toFixed(2)} км
            </div>
            <div className="text-[10px] font-mono text-amber-400">
              {rank === 1 ? 'Лидер' : `-${gapMeters} м`}
            </div>
          </div>

          <div>
            <div className="text-[10px] text-slate-400 flex items-center gap-1">
              <Heart className="w-3 h-3 text-rose-400" />
              Пульс / Выс.
            </div>
            <div className="font-mono font-semibold text-slate-100">
              {state.hr ? `${state.hr} уд/м` : '—'}
            </div>
            <div className="text-[10px] font-mono text-slate-400">
              {state.ele ? `${Math.round(state.ele)} м` : '—'}
            </div>
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          Сдвиг: {p.offsetSec > 0 ? `+${p.offsetSec}` : p.offsetSec}с (старт: {formatDuration(p.trimStartSec)})
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() =>
              onUpdate({
                offsetSec: p.offsetSec - 5,
              })
            }
            className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            -5с
          </button>
          <button
            onClick={() =>
              onUpdate({ offsetSec: 0 })
            }
            className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400"
          >
            0
          </button>
          <button
            onClick={() =>
              onUpdate({
                offsetSec: p.offsetSec + 5,
              })
            }
            className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            +5с
          </button>
        </div>
      </div>
    </div>
);
