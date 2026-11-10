import React, { useEffect, useState } from 'react';
import {
  Check,
  Compass,
  FolderPlus,
  MapPin,
  PlayCircle,
  Share2,
} from 'lucide-react';
import type { RaceEvent } from '../shared/types.js';
import { GeorefWorkspace } from './components/GeorefWorkspace.js';
import { ReplayWorkspace } from './components/ReplayWorkspace.js';

type ActiveTab = 'replay' | 'georef';

interface EventSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  participantCount: number;
  hasMap: boolean;
  mapRmsErrorM?: number;
}

export const App: React.FC = () => {
  const [eventsList, setEventsList] = useState<EventSummary[]>([]);
  const [currentEvent, setCurrentEvent] = useState<RaceEvent | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('replay');
  const [copiedSlug, setCopiedSlug] = useState(false);
  const [creatingEvent, setCreatingEvent] = useState(false);

  useEffect(() => {
    void initApp();
  }, []);

  async function initApp() {
    const params = new URLSearchParams(window.location.search);
    const eventParam = params.get('event');

    const listRes = await fetch('/api/events');
    const listData = await listRes.json();
    let summaries: EventSummary[] = listData.events ?? [];

    if (summaries.length === 0) {
      // Auto-create a clean empty event if none exist yet
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
      eventParam && summaries.some((s) => s.id === eventParam || s.slug === eventParam)
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
      const url = new URL(window.location.href);
      url.searchParams.set('event', data.event.slug);
      window.history.replaceState({}, '', url.toString());
    }
  }

  async function handleCreateNewEvent() {
    const title = window.prompt(
      'Название нового события / тренировки:',
      'Тренировка ориентирования'
    );
    if (!title) return;
    setCreatingEvent(true);
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (res.ok) {
        const data = await res.json();
        const evt: RaceEvent = data.event;
        setCurrentEvent(evt);
        setActiveTab('georef'); // Immediately open map georeferencing for a fresh event
        const listRes = await fetch('/api/events');
        const listData = await listRes.json();
        setEventsList(listData.events ?? []);
      }
    } finally {
      setCreatingEvent(false);
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
      <header className="h-14 px-4 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
              <Compass className="w-5 h-5" />
            </div>
            <div>
              <span className="font-bold tracking-tight text-white text-base">
                Retrace
              </span>
              <span className="hidden sm:inline-block ml-2 text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">
                GPS Replay & Map Georef
              </span>
            </div>
          </div>

          <div className="h-5 w-px bg-slate-800 mx-1" />

          {/* Event selector */}
          <select
            value={currentEvent?.id ?? ''}
            onChange={(e) => loadEvent(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-100 text-xs rounded-lg px-2.5 py-1.5 max-w-[260px] truncate focus:outline-none focus:border-emerald-500"
          >
            {eventsList.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.title} ({ev.participantCount} уч.)
              </option>
            ))}
          </select>

          <button
            onClick={handleCreateNewEvent}
            disabled={creatingEvent}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-200 transition"
            title="Создать новое событие без регистрации"
          >
            <FolderPlus className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden md:inline">Новое событие</span>
          </button>
        </div>

        {/* Center Navigation Tabs: Replay vs Map Georeferencing */}
        <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => setActiveTab('replay')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition ${
              activeTab === 'replay'
                ? 'bg-emerald-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <PlayCircle className="w-4 h-4" />
            Реплей и треки ({currentEvent?.participants.length ?? 0})
          </button>

          <button
            onClick={() => setActiveTab('georef')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition ${
              activeTab === 'georef'
                ? 'bg-emerald-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <MapPin className="w-4 h-4" />
            Привязка карты (GCP)
            {currentEvent?.map?.rmsErrorM !== undefined && (
              <span className="px-1.5 py-0.2 rounded bg-slate-900/60 text-[10px] text-emerald-300">
                ±{currentEvent.map.rmsErrorM}м
              </span>
            )}
          </button>
        </div>

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
        ) : activeTab === 'replay' ? (
          <ReplayWorkspace
            event={currentEvent}
            onEventUpdated={(evt) => setCurrentEvent(evt)}
          />
        ) : (
          <GeorefWorkspace
            event={currentEvent}
            onEventUpdated={(evt) => setCurrentEvent(evt)}
          />
        )}
      </main>
    </div>
  );
};

export default App;

