import React, { useEffect, useRef, useState } from 'react';
import type { EventKind, EventScope } from '../../shared/types.js';
import type { Me } from '../session.js';

/** Who an event is for */
export const EVENT_SCOPE_INFO: Record<EventScope, { icon: string; label: string; hint: string }> = {
  championship: {
    icon: '🏆',
    label: 'Этап чемпионата',
    hint: 'Видят все, кто вошёл на сайт; каждый может добавить свой трек. Трассу и карту ведут судьи клуба-организатора',
  },
  club: {
    icon: '👥',
    label: 'Тренировка клуба',
    hint: 'Видят и добавляют треки только члены клуба; ведут тренеры и админы клуба',
  },
  personal: {
    icon: '🔒',
    label: 'Личное',
    hint: 'Видите вы и ваша семья; можно открыть по ссылке для просмотра',
  },
};

export interface EventDialogValue {
  title: string;
  kind: EventKind;
  scope: EventScope;
  groupId: string | null;
}

/** Clubs where the user may create stages and trainings (site admins: every club) */
function staffClubs(me: Me): { id: string; name: string }[] {
  if (me.user?.isAdmin) return me.clubs ?? [];
  return me.groups
    .filter((g) => g.kind === 'club' && (g.role === 'admin' || g.role === 'judge'))
    .map((g) => ({ id: g.id, name: g.name }));
}

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
  me: Me;
  initialTitle?: string;
  initialKind?: EventKind;
  /** undefined: an event from before accounts (site admins only until set) */
  initialScope?: EventScope;
  initialGroupId?: string | null;
  /** Edit mode, personal event: the current share link token (null = closed) */
  shareToken?: string | null;
  onShareLink?: (open: boolean) => void;
  eventSlug?: string;
  busy?: boolean;
  onSubmit: (value: EventDialogValue) => void;
  onCancel: () => void;
}

/** Create / edit an event: title + kind (orienteering with a map vs plain run/hike) */
export const EventDialog: React.FC<Props> = ({
  mode,
  me,
  initialTitle,
  initialKind = 'orienteering',
  initialScope,
  initialGroupId = null,
  shareToken = null,
  onShareLink,
  eventSlug,
  busy = false,
  onSubmit,
  onCancel,
}) => {
  const clubs = staffClubs(me);
  const families = me.groups.filter((g) => g.kind === 'family');
  const allowed: Record<EventScope, boolean> = {
    championship: Boolean(me.user?.isAdmin) || clubs.length > 0,
    club: clubs.length > 0,
    personal: true,
  };
  const [scope, setScope] = useState<EventScope>(initialScope ?? 'personal');
  const [groupId, setGroupId] = useState<string | null>(initialGroupId);
  const [copied, setCopied] = useState(false);
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
  // The group must fit the audience: a club for stages/trainings, a family for personal events
  const groupChoices =
    scope === 'personal' ? families.map((f) => ({ id: f.id, name: f.name })) : clubs;
  const groupOk =
    scope === 'club'
      ? clubs.some((c) => c.id === groupId)
      : scope === 'championship'
        ? groupId
          ? clubs.some((c) => c.id === groupId)
          : Boolean(me.user?.isAdmin)
        : !groupId || families.some((f) => f.id === groupId);
  const shareUrl =
    shareToken && eventSlug
      ? `${window.location.origin}/?event=${eventSlug}&share=${shareToken}`
      : null;

  function pickScope(next: EventScope) {
    setScope(next);
    // keep the group if it still fits, otherwise the first that does
    if (next === 'personal') setGroupId(families.some((f) => f.id === groupId) ? groupId : null);
    else setGroupId(clubs.some((c) => c.id === groupId) ? groupId : clubs[0]?.id ?? null);
  }

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
          if (trimmed && !busy && groupOk) onSubmit({ title: trimmed, kind, scope, groupId });
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

        <div className="space-y-1.5">
          <span className="text-xs text-slate-400">Для кого</span>
          {mode === 'edit' && !initialScope && (
            <div className="text-[11px] text-amber-300">
              Событие создано до появления входа: пока его видят только администраторы.
            </div>
          )}
          <div className="grid grid-cols-3 gap-1.5">
            {(Object.keys(EVENT_SCOPE_INFO) as EventScope[]).map((s) => {
              const info = EVENT_SCOPE_INFO[s];
              return (
                <button
                  key={s}
                  type="button"
                  disabled={!allowed[s]}
                  onClick={() => pickScope(s)}
                  title={allowed[s] ? info.hint : 'Создают админы и судьи / тренеры клуба'}
                  className={`p-2 rounded-xl border text-left transition disabled:opacity-40 ${
                    scope === s
                      ? 'bg-sky-600/20 border-sky-500 text-white'
                      : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  <div className="text-xs font-semibold">
                    {info.icon} {info.label}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="text-[11px] text-slate-400 leading-snug">{EVENT_SCOPE_INFO[scope].hint}</div>
          {(scope !== 'personal' || families.length > 0) && (
            <label className="flex items-center gap-2 text-xs">
              <span className="text-slate-400 shrink-0">
                {scope === 'personal' ? 'Видно' : scope === 'club' ? 'Клуб' : 'Организатор'}
              </span>
              <select
                value={groupId ?? ''}
                onChange={(e) => setGroupId(e.target.value || null)}
                className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-slate-100"
              >
                {scope === 'personal' && <option value="">только мне</option>}
                {scope === 'championship' && me.user?.isAdmin && <option value="">без клуба</option>}
                {groupChoices.map((g) => (
                  <option key={g.id} value={g.id}>
                    {scope === 'personal' ? `мне и семье «${g.name}»` : g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mode === 'edit' && scope === 'personal' && initialScope === 'personal' && onShareLink && (
            <div className="p-2 rounded-lg bg-slate-950 border border-slate-800 space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-300">Открыть по ссылке (только просмотр)</span>
                <button
                  type="button"
                  onClick={() => onShareLink(!shareUrl)}
                  className={`px-2 py-0.5 rounded border ${
                    shareUrl
                      ? 'bg-rose-900/40 border-rose-500/50 text-rose-200'
                      : 'bg-emerald-700/40 border-emerald-500/50 text-emerald-100'
                  }`}
                >
                  {shareUrl ? 'Закрыть ссылку' : 'Создать ссылку'}
                </button>
              </div>
              {shareUrl && (
                <div className="flex gap-1">
                  <input
                    readOnly
                    value={shareUrl}
                    onFocus={(e) => e.target.select()}
                    className="min-w-0 flex-1 px-2 py-1 rounded bg-slate-900 border border-slate-700 font-mono text-[11px]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(shareUrl);
                      setCopied(true);
                    }}
                    className="px-2 rounded bg-slate-800 border border-slate-700 text-slate-200"
                  >
                    {copied ? '✓' : 'Копировать'}
                  </button>
                </div>
              )}
              <div className="text-[11px] text-slate-500">
                Кто откроет ссылку, увидит событие без входа, но ничего не сможет изменить.
              </div>
            </div>
          )}
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
            disabled={!trimmed || busy || !groupOk}
            className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-semibold text-white"
          >
            {mode === 'create' ? 'Создать' : 'Сохранить'}
          </button>
        </div>
      </form>
    </div>
  );
};
