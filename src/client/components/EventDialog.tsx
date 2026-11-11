import React, { useEffect, useRef, useState } from 'react';
import type { EventKind } from '../../shared/types.js';

export const EVENT_KIND_INFO: Record<
  EventKind,
  { icon: string; label: string; hint: string; defaultTitle: string }
> = {
  orienteering: {
    icon: '🧭',
    label: 'Ориентирование',
    hint: 'Скан карты ориентирования или скриншот Google Maps поверх подложки, подгонка карты под треки, перегоны и выравнивание скорости участников',
    defaultTitle: 'Тренировка ориентирования',
  },
  run: {
    icon: '🏃',
    label: 'Забег / хайк',
    hint: 'Треки на топографической подложке (OpenTopoMap / OSM / спутник) без своей карты: темп, пульс, высота, сравнение участников',
    defaultTitle: 'Пробежка',
  },
};

interface Props {
  mode: 'create' | 'edit';
  initialTitle?: string;
  initialKind?: EventKind;
  busy?: boolean;
  onSubmit: (value: { title: string; kind: EventKind }) => void;
  onCancel: () => void;
}

/** Create / edit an event: title + kind (orienteering with a map vs plain run/hike) */
export const EventDialog: React.FC<Props> = ({
  mode,
  initialTitle,
  initialKind = 'orienteering',
  busy = false,
  onSubmit,
  onCancel,
}) => {
  const [kind, setKind] = useState<EventKind>(initialKind);
  const [title, setTitle] = useState<string>(
    initialTitle ?? EVENT_KIND_INFO[initialKind].defaultTitle
  );
  // While creating, the suggested title follows the kind until the user types their own
  const titleTouchedRef = useRef(mode === 'edit');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function pickKind(next: EventKind) {
    setKind(next);
    if (!titleTouchedRef.current) setTitle(EVENT_KIND_INFO[next].defaultTitle);
  }

  const trimmed = title.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-5 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && !busy) onSubmit({ title: trimmed, kind });
        }}
      >
        <h2 className="text-base font-semibold text-white">
          {mode === 'create' ? 'Новое событие' : 'Настройки события'}
        </h2>

        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(EVENT_KIND_INFO) as EventKind[]).map((k) => {
            const info = EVENT_KIND_INFO[k];
            const active = kind === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => pickKind(k)}
                className={`text-left p-3 rounded-xl border transition ${
                  active
                    ? 'bg-emerald-600/20 border-emerald-500 text-white'
                    : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:border-slate-500'
                }`}
              >
                <div className="text-sm font-semibold">
                  {info.icon} {info.label}
                </div>
                <div className="mt-1 text-[11px] leading-snug text-slate-400">
                  {info.hint}
                </div>
              </button>
            );
          })}
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-slate-400">Название</span>
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => {
              titleTouchedRef.current = true;
              setTitle(e.target.value);
            }}
            maxLength={120}
            className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
          />
        </label>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-300"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={!trimmed || busy}
            className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-semibold text-white"
          >
            {mode === 'create' ? 'Создать' : 'Сохранить'}
          </button>
        </div>
      </form>
    </div>
  );
};
