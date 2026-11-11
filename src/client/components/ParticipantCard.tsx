import React from 'react';
import { Activity, Clock, Eye, EyeOff, Gauge, Heart, Trash2 } from 'lucide-react';
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
  onUpdate: (patch: Partial<ParticipantTrack>) => void;
  onDelete: () => void;
}

/** One runner in the live list: colour, visibility, pace / distance / HR now, start shift */
export const ParticipantCard: React.FC<Props> = ({
  participant: p,
  state,
  rank,
  gapMeters,
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
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-bold text-slate-500">
            #{rank}
          </span>
          <input
            type="color"
            value={p.color}
            onChange={(e) =>
              onUpdate({ color: e.target.value })
            }
            className="w-4 h-4 rounded cursor-pointer bg-transparent border-0"
            title="Изменить цвет трека"
          />
          <span className="text-sm font-semibold text-slate-100 truncate">
            {p.name}
          </span>
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
