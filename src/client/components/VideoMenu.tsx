import React, { useEffect, useState } from 'react';
import { Square, Video } from 'lucide-react';
import { formatDuration } from '../../shared/trackParser.js';

export type RecordPhase = 'idle' | 'preparing' | 'intro' | 'recording' | 'saving';

/** What to record: the run set up in the player, one course leg, or the whole course */
export type VideoTarget =
  | { kind: 'current' }
  | { kind: 'leg'; legIdx: number }
  | { kind: 'whole' };

interface Props {
  /** null: the browser cannot record video */
  format: { ext: 'mp4' | 'webm' } | null;
  phase: RecordPhase;
  error: string | null;
  /** "S → 1", "1 → 2", … (empty without a course) */
  legNames: string[];
  /** Slowest runner's time per leg, for the length estimate */
  legMaxSec: (number | null)[];
  selectedLegIdx: number | null;
  /** What the player is set to now: "Перегон 1 → 2", "Вся дистанция", … */
  currentLabel: string;
  currentDurationSec: number;
  playbackRate: number;
  fitView: boolean;
  onFitView: (on: boolean) => void;
  /** Turn the map to fit the frame (a leg: A on the left, B on the right) */
  rotateMap: boolean;
  onRotateMap: (on: boolean) => void;
  onRecord: (target: VideoTarget) => void;
  onStop: () => void;
}

/** Red "record" dot (the ⏺ emoji renders as a blue box on Windows) */
const RecDot = () => (
  <span className="inline-block w-2 h-2 mr-1.5 mb-px rounded-full bg-rose-500" />
);

/** "Видео" button of the transport bar: pick what to record; while recording — the stop button */
export const VideoMenu: React.FC<Props> = ({
  format,
  phase,
  error,
  legNames,
  legMaxSec,
  selectedLegIdx,
  currentLabel,
  currentDurationSec,
  playbackRate,
  fitView,
  onFitView,
  rotateMap,
  onRotateMap,
  onRecord,
  onStop,
}) => {
  const [open, setOpen] = useState(false);
  const [legIdx, setLegIdx] = useState(0);
  const [startedMs, setStartedMs] = useState(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (open) setLegIdx(selectedLegIdx ?? 0);
  }, [open]);

  // Elapsed recording time on the stop button
  useEffect(() => {
    if (phase !== 'intro' && phase !== 'recording') return;
    if (phase === 'intro') setStartedMs(Date.now());
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [phase]);

  const estimate = (raceSec: number | null | undefined) =>
    raceSec ? `≈ ${formatDuration(raceSec / playbackRate)} видео при ×${playbackRate}` : '';

  if (phase !== 'idle') {
    const text =
      phase === 'preparing'
        ? 'Готовлю…'
        : phase === 'saving'
          ? 'Сохраняю…'
          : `Стоп ${formatDuration((Date.now() - startedMs) / 1000)}`;
    return (
      <button
        onClick={onStop}
        disabled={phase === 'preparing' || phase === 'saving'}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-70 text-white text-xs font-semibold shadow-lg transition"
        title="Остановить запись и сохранить видео"
      >
        <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
        {phase === 'intro' || phase === 'recording' ? (
          <Square className="w-3 h-3 fill-current" />
        ) : null}
        <span className="font-mono">{text}</span>
      </button>
    );
  }

  const item =
    'w-full text-left px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 transition disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-medium transition ${
          open
            ? 'bg-rose-600 border-rose-500 text-white'
            : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-rose-300'
        }`}
        title="Записать прогон в видеофайл — например, чтобы отправить в чат"
      >
        <Video className="w-4 h-4" />
        Видео
      </button>
      {error && !open && (
        <div className="absolute bottom-full right-0 mb-2 w-64 p-2 rounded-lg bg-rose-950/95 border border-rose-500/50 text-[11px] text-rose-200 shadow-xl">
          {error}
        </div>
      )}
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 mb-2 z-40 w-80 p-3 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl space-y-2.5 text-xs">
            <div className="font-semibold text-slate-100">Запись видео</div>
            {!format ? (
              <div className="text-rose-300">
                Этот браузер не умеет записывать видео. Откройте страницу в Chrome, Edge или
                Safari.
              </div>
            ) : (
              <>
                <button
                  className={item}
                  onClick={() => {
                    setOpen(false);
                    onRecord({ kind: 'current' });
                  }}
                >
                  <div className="text-slate-100 font-medium"><RecDot />Как сейчас в плеере</div>
                  <div className="text-[11px] text-fuchsia-300">{currentLabel}</div>
                  <div className="text-[10px] text-slate-500">
                    {estimate(currentDurationSec)}
                  </div>
                </button>

                {legNames.length > 0 && (
                  <div className="p-2 rounded-lg bg-slate-950 border border-slate-800 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-300">Перегон</span>
                      <select
                        value={legIdx}
                        onChange={(e) => setLegIdx(Number(e.target.value))}
                        className="flex-1 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-100"
                      >
                        {legNames.map((name, k) => (
                          <option key={k} value={k}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      className={item}
                      onClick={() => {
                        setOpen(false);
                        onRecord({ kind: 'leg', legIdx });
                      }}
                    >
                      <div className="text-slate-100 font-medium">
                        <RecDot />Записать перегон {legNames[legIdx]}
                      </div>
                      <div className="text-[10px] text-slate-500">
                        {estimate(legMaxSec[legIdx])}
                      </div>
                    </button>
                  </div>
                )}

                <button
                  className={item}
                  onClick={() => {
                    setOpen(false);
                    onRecord({ kind: 'whole' });
                  }}
                >
                  <div className="text-slate-100 font-medium"><RecDot />Вся дистанция целиком</div>
                  <div className="text-[10px] text-slate-500">
                    от старта до финиша, все участники
                  </div>
                </button>

                <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fitView}
                    onChange={(e) => onFitView(e.target.checked)}
                    className="accent-rose-500"
                  />
                  Вписать прогон в кадр
                </label>
                <label
                  className={`flex items-start gap-2 cursor-pointer ${
                    fitView ? 'text-slate-300' : 'text-slate-600'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={rotateMap}
                    disabled={!fitView}
                    onChange={(e) => onRotateMap(e.target.checked)}
                    className="accent-rose-500 mt-0.5"
                  />
                  <span>
                    Повернуть карту под кадр
                    <span className="block text-[10px] text-slate-500">
                      перегон: A слева, B справа; вся трасса — как крупнее. В видео будет
                      стрелка на север
                    </span>
                  </span>
                </label>

                <div className="text-[10px] text-slate-500 leading-snug">
                  Запись идёт в реальном времени с выбранной скоростью плеера (×1…×60) — её
                  можно поменять до записи. В кадр попадает карта с бегунами, название и
                  часы. Во время записи не сворачивайте вкладку.{' '}
                  {format.ext === 'mp4' ? (
                    <>Файл MP4 (~720p) можно сразу отправить в чат.</>
                  ) : (
                    <span className="text-amber-300">
                      Этот браузер пишет только WebM: не все мессенджеры его покажут. Для
                      MP4 запишите в Chrome, Edge или Safari.
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};
