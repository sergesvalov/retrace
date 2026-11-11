import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Compass,
  FolderPlus,
  Move,
  Pencil,
  PlayCircle,
  Share2,
  Trash2,
} from 'lucide-react';
import {
  eventKindOf,
  type EventKind,
  type RaceEvent,
} from '../shared/types.js';
import { ReplayWorkspace } from './components/ReplayWorkspace.js';
import { EVENT_KIND_INFO, EventDialog } from './components/EventDialog.js';

interface EventSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  kind?: EventKind;
  participantCount: number;
  hasMap: boolean;
  mapRmsErrorM?: number;
}

export const App: React.FC = () => {
  const [eventsList, setEventsList] = useState<EventSummary[]>([]);
  const [currentEvent, setCurrentEvent] = useState<RaceEvent | null>(null);
  const [fitMapMode, setFitMapMode] = useState<boolean>(false);
  const [copiedSlug, setCopiedSlug] = useState(false);
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [dialog, setDialog] = useState<'create' | 'edit' | null>(null);
  const isOrienteering =
    currentEvent !== null && eventKindOf(currentEvent) === 'orienteering';

  // StrictMode runs effects twice in dev: without the guard two "Тренировка" events get created
  const initStartedRef = useRef(false);
  useEffect(() => {
    if (initStartedRef.current) return;
    initStartedRef.current = true;
    void initApp();
  }, []);

  function setEventInUrl(slug: string | null) {
    const url = new URL(window.location.href);
    if (slug) url.searchParams.set('event', slug);
    else url.searchParams.delete('event');
    window.history.replaceState({}, '', url.toString());
  }

  async function initApp() {
    const params = new URLSearchParams(window.location.search);
    const eventParam = params.get('event');

    const listRes = await fetch('/api/events');
    const listData = await listRes.json();
    let summaries: EventSummary[] = listData.events ?? [];

    if (summaries.length === 0) {
      const createRes = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Тренировка' }),
      });
      if (createRes.ok) {
        const created = await createRes.json();
        const evt: RaceEvent = created.event;
        summaries = [
          {
            id: evt.id,
            slug: evt.slug,
            title: evt.title,
            description: evt.description,
            participantCount: 0,
            hasMap: false,
          },
        ];
      }
    }

    setEventsList(summaries);
    const targetId =
      eventParam &&
      summaries.some((s) => s.id === eventParam || s.slug === eventParam)
        ? eventParam
        : summaries[0]?.id;
    if (targetId) {
      await loadEvent(targetId);
    }
  }

  async function loadEvent(idOrSlug: string) {
    const res = await fetch(`/api/events/${idOrSlug}`);
    if (res.ok) {
      const data = await res.json();
      setCurrentEvent(data.event);
      setEventInUrl(data.event.slug);
    }
  }

  async function handleCreateNewEvent(value: { title: string; kind: EventKind }) {
    setCreatingEvent(true);
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (res.ok) {
        const data = await res.json();
        const evt: RaceEvent = data.event;
        setCurrentEvent(evt);
        setEventInUrl(evt.slug);
        setFitMapMode(false);
        setDialog(null);
        await refreshEventsList();
      }
    } finally {
      setCreatingEvent(false);
    }
  }

  async function refreshEventsList() {
    const listRes = await fetch('/api/events');
    if (listRes.ok) {
      const listData = await listRes.json();
      setEventsList(listData.events ?? []);
    }
  }

  async function handleEditCurrentEvent(value: { title: string; kind: EventKind }) {
    if (!currentEvent) return;
    const res = await fetch(`/api/events/${currentEvent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    if (res.ok) {
      const data = await res.json();
      setCurrentEvent(data.event);
      if (value.kind === 'run') setFitMapMode(false);
      setDialog(null);
      await refreshEventsList();
    }
  }

  async function handleDeleteCurrentEvent() {
    if (!currentEvent) return;
    const ok = window.confirm(
      `Удалить мероприятие «${currentEvent.title}» со всеми его картами и треками?`
    );
    if (!ok) return;
    const res = await fetch(`/api/events/${currentEvent.id}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setEventInUrl(null);
      setFitMapMode(false);

      const listRes = await fetch('/api/events');
      const listData = await listRes.json();
      const remaining: EventSummary[] = listData.events ?? [];
      if (remaining.length > 0) {
        setEventsList(remaining);
        await loadEvent(remaining[0].id);
      } else {
        await initApp();
      }
    }
  }

  function handleShareLink() {
    if (!currentEvent) return;
    const shareUrl = `${window.location.origin}/?event=${currentEvent.slug}`;
    void navigator.clipboard.writeText(shareUrl);
    setCopiedSlug(true);
    setTimeout(() => setCopiedSlug(false), 2000);
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
      {/* Top Application Header */}
      <header className="h-14 px-4 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-4 shrink-0 z-20">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
              <Compass className="w-5 h-5" />
            </div>
            <div>
              <span className="font-bold tracking-tight text-white text-base">
                Retrace
              </span>
              <span className="hidden xl:inline-block ml-2 text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">
                GPS Replay & Map Georef
              </span>
            </div>
          </div>

          <div className="h-5 w-px bg-slate-800 mx-1" />

          {/* Event selector + Edit + Delete + Create */}
          <select
            value={currentEvent?.id ?? ''}
            onChange={(e) => loadEvent(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-100 text-xs rounded-lg px-2.5 py-1.5 max-w-[240px] truncate focus:outline-none focus:border-emerald-500"
          >
            {eventsList.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {EVENT_KIND_INFO[ev.kind ?? 'orienteering'].icon} {ev.title} (
                {ev.participantCount} уч.)
              </option>
            ))}
          </select>

          <button
            onClick={() => setDialog('edit')}
            disabled={!currentEvent}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white transition"
            title="Название и тип события (ориентирование / забег)"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleDeleteCurrentEvent}
            disabled={!currentEvent}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/60 border border-slate-700 hover:border-rose-500/50 text-slate-400 hover:text-rose-300 transition"
            title="Удалить текущее мероприятие"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => setDialog('create')}
            disabled={creatingEvent}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-200 transition"
            title="Создать новое мероприятие"
          >
            <FolderPlus className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden md:inline">Новое событие</span>
          </button>
        </div>

        {/* Center Mode Switch: Replay vs Interactive Map Fit (orienteering maps only) */}
        {isOrienteering && (
        <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => setFitMapMode(false)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition ${
              !fitMapMode
                ? 'bg-emerald-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <PlayCircle className="w-4 h-4" />
            Реплей и анализ
          </button>

          <button
            onClick={() => setFitMapMode(true)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition ${
              fitMapMode
                ? 'bg-amber-500 text-slate-950 font-semibold shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
            title="Перетаскивай карту мышкой прямо под GPS-трек и крути ползунки масштаба/поворота вокруг Старта"
          >
            <Move className="w-4 h-4" />
            ✋ Подогнать карту мышкой
          </button>
        </div>
        )}

        {/* Share event button */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleShareLink}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-200 transition"
          >
            {copiedSlug ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-400">Ссылка скопирована!</span>
              </>
            ) : (
              <>
                <Share2 className="w-3.5 h-3.5 text-slate-400" />
                <span>Поделиться</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main Workspace Body */}
      <main className="flex-1 min-h-0">
        {!currentEvent ? (
          <div className="flex items-center justify-center h-full text-sm text-slate-400">
            Загрузка события...
          </div>
        ) : (
          <ReplayWorkspace
            event={currentEvent}
            fitMapMode={fitMapMode}
            onToggleFitMap={setFitMapMode}
            onEventUpdated={(evt) => {
              setCurrentEvent(evt);
              void refreshEventsList();
            }}
          />
        )}
      </main>

      {dialog === 'create' && (
        <EventDialog
          mode="create"
          busy={creatingEvent}
          onSubmit={(v) => void handleCreateNewEvent(v)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === 'edit' && currentEvent && (
        <EventDialog
          mode="edit"
          initialTitle={currentEvent.title}
          initialKind={eventKindOf(currentEvent)}
          onSubmit={(v) => void handleEditCurrentEvent(v)}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
};

export default App;
