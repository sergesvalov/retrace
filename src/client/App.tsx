import React, { useEffect, useRef, useState } from 'react';
import { Check, Compass, FolderPlus, LogIn, LogOut, Pencil, Share2, Trash2, Users } from 'lucide-react';
import {
  eventKindOf,
  type EventAccess,
  type EventKind,
  type EventScope,
  type RaceEvent,
} from '../shared/types.js';
import { ReplayWorkspace } from './components/ReplayWorkspace.js';
import { fromWireEvent, mergeLiteEvent } from '../shared/pointsCodec.js';
import {
  EVENT_KIND_INFO,
  EVENT_SCOPE_INFO,
  EventDialog,
  type EventDialogValue,
} from './components/EventDialog.js';
import { LoginScreen } from './components/LoginScreen.js';
import { GroupsDialog } from './components/GroupsDialog.js';
import { api, appUrl, fetchMe, type Me } from './session.js';

interface EventSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  kind?: EventKind;
  scope: EventScope | null;
  groupId?: string;
  groupName?: string;
  ownerName?: string;
  participantCount: number;
  hasMap: boolean;
  canEdit: boolean;
}

const READ_ONLY: EventAccess = { canView: true, canUpload: false, canEdit: false };

/** Sections of the event list: stages, then each club, then personal events */
function sectionOf(e: EventSummary): string {
  if (e.scope === 'championship') return '🏆 Чемпионат';
  if (e.scope === 'club') return `👥 ${e.groupName ?? 'Клуб'}`;
  if (e.scope === 'personal') return '🔒 Личные';
  return '⚠ Без типа (видно только админам)';
}

function urlParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function setUrlParam(name: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  window.history.replaceState({}, '', url.toString());
}

export const App: React.FC = () => {
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [inviteNote, setInviteNote] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [eventsList, setEventsList] = useState<EventSummary[]>([]);
  const [currentEvent, setCurrentEvent] = useState<RaceEvent | null>(null);
  const [access, setAccess] = useState<EventAccess>(READ_ONLY);
  const [audience, setAudience] = useState<{ groupName?: string; ownerName?: string }>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fitMapMode, setFitMapMode] = useState<boolean>(false);
  const [copiedSlug, setCopiedSlug] = useState(false);
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [dialog, setDialog] = useState<'create' | 'edit' | 'groups' | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const [newEventKind, setNewEventKind] = useState<EventKind>('orienteering');

  const signedIn = Boolean(me?.user);
  // Opened by a share link without an account: that one event, read-only
  const shareToken = urlParam('share');

  // StrictMode runs effects twice in dev
  const initStartedRef = useRef(false);
  useEffect(() => {
    if (initStartedRef.current) return;
    initStartedRef.current = true;
    void initApp();
  }, []);

  async function refreshMe(): Promise<Me | null> {
    try {
      const next = await fetchMe();
      setMe(next);
      setMeError(null);
      return next;
    } catch (err) {
      setMeError((err as Error).message);
      return null;
    }
  }

  async function initApp() {
    const current = await refreshMe();
    if (!current) return;
    const invite = urlParam('invite');
    if (!current.user) {
      if (invite) {
        const info = await api<{ groupName: string; kind: string }>('GET', `api/invites/${invite}`).catch(
          () => null
        );
        setInviteNote(
          info
            ? `Вас пригласили в ${info.kind === 'club' ? 'клуб' : 'семью'} «${info.groupName}».`
            : 'Приглашение устарело — попросите новую ссылку.'
        );
      }
      // A shared event opens without signing in
      const eventParam = urlParam('event');
      if (eventParam && shareToken) await loadEvent(eventParam);
      return;
    }
    await afterSignIn(current);
  }

  async function afterSignIn(current: Me) {
    const invite = urlParam('invite');
    if (invite && current.user) {
      try {
        await api('POST', `api/invites/${invite}/accept`);
        const next = await refreshMe();
        const joined = next?.groups.find((g) => !current.groups.some((c) => c.id === g.id));
        setNotice(joined ? `Вы вступили в «${joined.name}»` : 'Приглашение принято');
      } catch (err) {
        setNotice((err as Error).message);
      }
      setUrlParam('invite', null);
    }
    const summaries = await refreshEventsList();
    setListLoaded(true);
    const eventParam = urlParam('event');
    const targetId =
      eventParam && (shareToken || summaries.some((s) => s.id === eventParam || s.slug === eventParam))
        ? eventParam
        : summaries[0]?.id;
    if (targetId) await loadEvent(targetId);
  }

  async function loadEvent(idOrSlug: string) {
    const share = urlParam('share');
    const res = await fetch(
      `api/events/${idOrSlug}${share ? `?share=${encodeURIComponent(share)}` : ''}`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setLoadError(data.error ?? 'Событие не найдено');
      return;
    }
    setLoadError(null);
    // the full event: track points come packed
    setCurrentEvent(fromWireEvent(data.event));
    setAccess(data.access ?? READ_ONLY);
    setAudience({ groupName: data.groupName, ownerName: data.ownerName });
    setUrlParam('event', data.event.slug);
  }

  async function refreshEventsList(): Promise<EventSummary[]> {
    const res = await fetch('api/events');
    if (!res.ok) return [];
    const list: EventSummary[] = (await res.json()).events ?? [];
    setEventsList(list);
    return list;
  }

  async function handleCreateNewEvent(value: EventDialogValue) {
    setCreatingEvent(true);
    try {
      const data = await api<{ event: RaceEvent; access: EventAccess }>('POST', 'api/events', value);
      const evt: RaceEvent = mergeLiteEvent(null, data.event as never);
      setCurrentEvent(evt);
      setAccess(data.access);
      setUrlParam('event', evt.slug);
      setUrlParam('share', null);
      setFitMapMode(false);
      setDialog(null);
      await refreshEventsList();
    } catch (err) {
      window.alert((err as Error).message);
    } finally {
      setCreatingEvent(false);
    }
  }

  async function patchCurrentEvent(body: object) {
    if (!currentEvent) return;
    const data = await api<{
      event: never;
      access: EventAccess;
      groupName?: string;
      ownerName?: string;
    }>('PATCH', `api/events/${currentEvent.id}`, body);
    setCurrentEvent((prev) => mergeLiteEvent(prev, data.event));
    setAccess(data.access);
    setAudience({ groupName: data.groupName, ownerName: data.ownerName });
    await refreshEventsList();
  }

  async function handleEditCurrentEvent(value: EventDialogValue) {
    try {
      await patchCurrentEvent(value);
      if (value.kind === 'run') setFitMapMode(false);
      setDialog(null);
    } catch (err) {
      window.alert((err as Error).message);
    }
  }

  async function handleDeleteCurrentEvent() {
    if (!currentEvent) return;
    const ok = window.confirm(
      `Удалить мероприятие «${currentEvent.title}» со всеми его картами и треками?`
    );
    if (!ok) return;
    const res = await fetch(`api/events/${currentEvent.id}`, { method: 'DELETE' });
    if (res.ok) {
      setUrlParam('event', null);
      setFitMapMode(false);
      const remaining = await refreshEventsList();
      if (remaining.length > 0) await loadEvent(remaining[0].id);
      else setCurrentEvent(null);
    }
  }

  function handleShareLink() {
    if (!currentEvent) return;
    // A personal event shared by link: the link with its token; otherwise the plain address
    // (it opens for those who may see the event)
    const token = currentEvent.shareToken ?? shareToken;
    const shareUrl = appUrl(`?event=${currentEvent.slug}${token ? `&share=${token}` : ''}`);
    void navigator.clipboard.writeText(shareUrl);
    setCopiedSlug(true);
    setTimeout(() => setCopiedSlug(false), 2000);
  }

  async function handleLogout() {
    await api('POST', 'api/auth/logout').catch(() => {});
    setCurrentEvent(null);
    setEventsList([]);
    setUrlParam('event', null);
    await refreshMe();
  }

  if (!me) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950 text-sm text-slate-400">
        {meError ? `Сервер недоступен: ${meError}` : 'Загрузка…'}
      </div>
    );
  }
  if (!me.user && !(shareToken && currentEvent)) {
    return (
      <LoginScreen
        login={me.login}
        inviteNote={inviteNote}
        onSignedIn={() => {
          void refreshMe().then((next) => next?.user && afterSignIn(next));
        }}
      />
    );
  }

  // Event list in sections; the open event stays listed even when opened by a share link
  const sections = new Map<string, EventSummary[]>();
  for (const ev of eventsList) {
    const key = sectionOf(ev);
    sections.set(key, [...(sections.get(key) ?? []), ev]);
  }
  const listed = eventsList.some((e) => e.id === currentEvent?.id);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
      {/* Top Application Header */}
      <header className="h-12 px-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-4 shrink-0 z-20">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
              <Compass className="w-5 h-5" />
            </div>
            <span className="font-bold tracking-tight text-white text-base hidden sm:inline">
              Retrace
            </span>
          </div>

          <div className="h-5 w-px bg-slate-800 mx-1" />

          {signedIn ? (
            <select
              value={currentEvent?.id ?? ''}
              onChange={(e) => {
                setUrlParam('share', null);
                void loadEvent(e.target.value);
              }}
              className="bg-slate-800 border border-slate-700 text-slate-100 text-xs rounded-lg px-2.5 py-1.5 max-w-[280px] truncate focus:outline-none focus:border-emerald-500"
            >
              {!listed && currentEvent && <option value={currentEvent.id}>{currentEvent.title}</option>}
              {[...sections.entries()].map(([section, list]) => (
                <optgroup key={section} label={section}>
                  {list.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {EVENT_KIND_INFO[ev.kind ?? 'orienteering'].icon} {ev.title} ({ev.participantCount} уч.)
                      {ev.scope === 'personal' && ev.ownerName ? ` — ${ev.ownerName}` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          ) : (
            <span className="text-sm font-semibold text-slate-200 truncate">{currentEvent?.title}</span>
          )}

          {currentEvent && (
            <span
              className="hidden lg:inline text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 whitespace-nowrap"
              title={currentEvent.scope ? EVENT_SCOPE_INFO[currentEvent.scope].hint : undefined}
            >
              {currentEvent.scope
                ? `${EVENT_SCOPE_INFO[currentEvent.scope].icon} ${
                    currentEvent.scope === 'personal'
                      ? audience.ownerName ?? 'личное'
                      : audience.groupName ?? EVENT_SCOPE_INFO[currentEvent.scope].label
                  }`
                : '⚠ без типа'}
              {!access.canEdit && ' · просмотр'}
            </span>
          )}

          {access.canEdit && currentEvent && (
            <>
              <button
                onClick={() => setDialog('edit')}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white transition"
                title="Название, вид и для кого событие"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleDeleteCurrentEvent}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/60 border border-slate-700 hover:border-rose-500/50 text-slate-400 hover:text-rose-300 transition"
                title="Удалить текущее мероприятие"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}

          {signedIn && (
            <button
              onClick={() => {
                setNewEventKind('orienteering');
                setDialog('create');
              }}
              disabled={creatingEvent}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-200 transition"
              title="Создать новое мероприятие"
            >
              <FolderPlus className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden md:inline">Новое событие</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {currentEvent && (
            <button
              onClick={handleShareLink}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-200 transition"
              title={
                currentEvent.shareToken
                  ? 'Ссылка для просмотра без входа'
                  : 'Ссылка на событие: откроется у тех, кому оно видно'
              }
            >
              {copiedSlug ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400">Скопировано!</span>
                </>
              ) : (
                <>
                  <Share2 className="w-3.5 h-3.5 text-slate-400" />
                  <span className="hidden md:inline">Поделиться</span>
                </>
              )}
            </button>
          )}
          {me.user ? (
            <>
              <button
                onClick={() => setDialog('groups')}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-200"
                title="Профиль, клубы и семья"
              >
                <Users className="w-3.5 h-3.5 text-sky-400" />
                <span className="max-w-[120px] truncate">{me.user.name}</span>
              </button>
              <button
                onClick={() => void handleLogout()}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-white"
                title="Выйти"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                setUrlParam('share', null);
                setCurrentEvent(null);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs text-white font-medium"
            >
              <LogIn className="w-3.5 h-3.5" />
              Войти
            </button>
          )}
        </div>
      </header>

      {notice && (
        <div className="px-3 py-1.5 bg-emerald-950/80 border-b border-emerald-500/40 text-xs text-emerald-100 flex items-center justify-between">
          {notice}
          <button onClick={() => setNotice(null)} className="text-emerald-300 hover:text-white">
            ✕
          </button>
        </div>
      )}

      {/* Main Workspace Body */}
      <main className="flex-1 min-h-0">
        {!currentEvent ? (
          loadError ? (
            <div className="flex items-center justify-center h-full text-sm text-slate-400">{loadError}</div>
          ) : listLoaded && eventsList.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 p-6 text-center">
              <div className="text-lg font-semibold text-white">Создайте первое событие</div>
              <div className="text-sm text-slate-400 max-w-md">
                Этапы чемпионата и тренировки клуба появятся здесь сами, когда их создадут судьи и
                тренеры. Свои пробежки можно добавить как личные события.
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl w-full">
                {(Object.keys(EVENT_KIND_INFO) as EventKind[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => {
                      setNewEventKind(k);
                      setDialog('create');
                    }}
                    className="text-left p-4 rounded-2xl bg-slate-900 border border-slate-700 hover:border-emerald-500 transition"
                  >
                    <div className="text-base font-semibold text-white">
                      {EVENT_KIND_INFO[k].icon} {EVENT_KIND_INFO[k].label}
                    </div>
                    <div className="mt-1 text-xs text-slate-400">{EVENT_KIND_INFO[k].hint}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-slate-400">
              Загрузка события...
            </div>
          )
        ) : (
          <ReplayWorkspace
            event={currentEvent}
            access={access}
            userId={me.user?.id ?? null}
            fitMapMode={fitMapMode}
            onToggleFitMap={setFitMapMode}
            onEventUpdated={(evt) => {
              setCurrentEvent(evt);
              if (signedIn) void refreshEventsList();
            }}
          />
        )}
      </main>

      {dialog === 'create' && (
        <EventDialog
          mode="create"
          me={me}
          initialKind={newEventKind}
          busy={creatingEvent}
          onSubmit={(v) => void handleCreateNewEvent(v)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === 'edit' && currentEvent && (
        <EventDialog
          mode="edit"
          me={me}
          initialTitle={currentEvent.title}
          initialKind={eventKindOf(currentEvent)}
          initialScope={currentEvent.scope}
          initialGroupId={currentEvent.groupId ?? null}
          shareToken={currentEvent.shareToken ?? null}
          eventSlug={currentEvent.slug}
          onShareLink={(open) => void patchCurrentEvent({ shareLink: open }).catch((e) => window.alert(e.message))}
          onSubmit={(v) => void handleEditCurrentEvent(v)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === 'groups' && me.user && (
        <GroupsDialog me={me} onChanged={() => void refreshMe()} onClose={() => setDialog(null)} />
      )}
    </div>
  );
};

export default App;
