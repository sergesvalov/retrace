import React from 'react';
import {
  Anchor,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Crosshair,
  Globe,
  LocateFixed,
  Move,
  Plus,
} from 'lucide-react';
import type { GCP, MapImageKind } from '../../shared/types.js';

const PRINT_SCALES = [4000, 5000, 7500, 10000, 15000];

export function formatSignedDeg(deg: number): string {
  const r = Math.round(deg * 10) / 10;
  return `${r > 0 ? '+' : ''}${r}°`;
}

interface Props {
  hasTracks: boolean;
  onTrackFiles: (e: React.ChangeEvent<HTMLInputElement>) => void;
  uploadingTrack: boolean;
  onDone: () => void;
  onShowMap: () => void;
  onMoveMapHere: () => void;
  onResetPlacement: () => void;

  /** Semi-automatic fit: course controls on the scan ↔ runners' punches */
  courseControlCount: number;
  onEditCourse: () => void;
  onAutoFitCourse: () => void;
  autoFitInfo: { ok: boolean; text: string } | null;

  /** Fully automatic: course circles found on the scan ↔ tracks */
  autoGeorefState: { busy: boolean; ok: boolean | null; text: string } | null;
  onAutoGeoref: () => void;

  /** Landmark pins: scan point ↔ the same place on the base map */
  pins: GCP[];
  pinStage: 'pin_map' | 'pin_base' | null;
  onAddPin: () => void;
  onRemovePin: (id: string) => void;
  onClearPins: () => void;

  dragMovesMap: boolean;
  onToggleDragMovesMap: () => void;

  mapImageKind: MapImageKind;
  onMapImageKind: (k: MapImageKind) => void;
  printScale: number;
  onPrintScale: (v: number) => void;
  scanDpi: number;
  onScanDpi: (v: number) => void;
  declinationDeg: number;
  onDeclinationDeg: (v: number) => void;
  autoDeclinationDeg: number;
  onApplyScaleAndNorth: () => void;
  onStartScaleBar: () => void;
  readout: {
    metersPerPixel: number;
    impliedScale: number | null;
    upBearingDeg: number;
  } | null;

  /** Fine tuning relative to the last absolute placement */
  scalePct: number;
  angleDeg: number;
  stretchPct: number;
  onScale: (v: number, commit: boolean) => void;
  onAngle: (v: number, commit: boolean) => void;
  onStretch: (v: number, commit: boolean) => void;
  onCommitSlider: () => void;
  onNudge: (dEastM: number, dNorthM: number) => void;
}

const sectionCls = 'p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2';
const inputCls =
  'w-full px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-100';

/**
 * Map fitting controls. Lives in the right column while fitting (the participants list is
 * not needed then), so the map keeps the whole height of the screen.
 */
export const FitPanel: React.FC<Props> = (p) => {
  const isOMap = p.mapImageKind === 'orienteering';

  const slider = (
    label: string,
    value: string,
    input: React.ReactNode,
    accent: string
  ) => (
    <div className="space-y-0.5">
      <div className="flex justify-between text-slate-300">
        <span>{label}</span>
        <strong className={accent}>{value}</strong>
      </div>
      {input}
    </div>
  );

  const rangeProps = {
    onMouseUp: p.onCommitSlider,
    onTouchEnd: p.onCommitSlider,
    onKeyUp: p.onCommitSlider,
  };

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-2.5 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-amber-300 flex items-center gap-1.5 text-sm">
          <Anchor className="w-4 h-4" />
          Подгонка карты
        </span>
        <button
          onClick={p.onDone}
          className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
        >
          <Check className="w-3.5 h-3.5" />
          Готово
        </button>
      </div>

      {/* What to do now depends on whether the tracks are there */}
      {p.hasTracks ? (
        <ol className="list-decimal pl-4 space-y-0.5 text-slate-300">
          <li>Задайте масштаб и север (ниже).</li>
          <li>
            Перетащите карту мышкой: треугольник старта — на зелёную метку{' '}
            <b className="text-emerald-400">⚓ СТАРТ</b> (начало треков).
          </li>
          <li>Если нужно, подстройте масштаб и поворот — вокруг ⚓ старт не сбивается.</li>
        </ol>
      ) : (
        <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/40 text-amber-100 space-y-1.5">
          <div>
            Треков ещё нет, поэтому якорь ⚓ стоит в центре карты, а совмещать старт не с чем.
            Загрузите треки — карта переедет к ним, ⚓ встанет на старт.
          </div>
          <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer">
            <Plus className="w-3.5 h-3.5" />
            {p.uploadingTrack ? 'Загрузка…' : 'Загрузить треки (FIT/GPX/TCX)'}
            <input
              type="file"
              multiple
              accept=".gpx,.fit,.tcx"
              className="hidden"
              onChange={p.onTrackFiles}
            />
          </label>
        </div>
      )}

      <div className="flex gap-1.5">
        <button
          onClick={p.onShowMap}
          className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
          title="Перелететь к загруженной карте"
        >
          <LocateFixed className="w-3.5 h-3.5" />
          Показать карту
        </button>
        <button
          onClick={p.onMoveMapHere}
          className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
          title="Перенести карту в центр экрана (масштаб и поворот сохраняются)"
        >
          <Crosshair className="w-3.5 h-3.5" />
          Перенести сюда
        </button>
      </div>

      {/* Fully automatic: circles on the scan ↔ tracks */}
      <div className="p-2.5 rounded-xl bg-emerald-950/40 border border-emerald-500/40 space-y-2">
        <div className="font-semibold text-emerald-200">🪄 Полностью автоматически</div>
        <div className="text-slate-300">
          Находит кружки КП на скане и ставит карту так, чтобы через них прошли все треки.
          Масштаб и поворот определяются сами; дистанция отмечается по порядку прохождения.
        </div>
        <button
          onClick={p.onAutoGeoref}
          disabled={p.autoGeorefState?.busy}
          className="w-full px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-semibold"
        >
          {p.autoGeorefState?.busy ? 'Подгоняю…' : '🪄 Подогнать автоматически'}
        </button>
        {p.autoGeorefState && (
          <div
            className={
              p.autoGeorefState.ok === null
                ? 'text-slate-300'
                : p.autoGeorefState.ok
                  ? 'text-emerald-300'
                  : 'text-amber-300'
            }
          >
            {p.autoGeorefState.text}
          </div>
        )}
      </div>

      {/* Fastest: fit from the course controls and the tracks */}
      <div className="p-2.5 rounded-xl bg-fuchsia-950/40 border border-fuchsia-500/40 space-y-2">
        <div className="font-semibold text-fuchsia-200">🎯 Авто: по КП и трекам</div>
        {p.courseControlCount >= 3 && p.hasTracks ? (
          <>
            <div className="text-slate-300">
              Карта сама подстроится (сдвиг, масштаб, поворот), чтобы КП на скане совпали с
              местами, где участники их отмечали. Карта должна лежать хотя бы примерно (в пределах
              ~150 м).
            </div>
            <button
              onClick={p.onAutoFitCourse}
              className="w-full px-2.5 py-1.5 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-semibold"
            >
              🎯 Подогнать карту по КП
            </button>
          </>
        ) : (
          <>
            <div className="text-slate-300">
              {p.hasTracks ? '' : 'Нужны треки и отмеченные КП. '}
              Отметьте на скане старт и хотя бы 3 КП (сейчас:{' '}
              {Math.max(0, p.courseControlCount)}) — и карту можно будет подогнать одной кнопкой.
            </div>
            <button
              onClick={p.onEditCourse}
              className="w-full px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-fuchsia-500/50 text-fuchsia-200"
            >
              ◎ Отметить КП на карте
            </button>
          </>
        )}
        {p.autoFitInfo && (
          <div className={p.autoFitInfo.ok ? 'text-emerald-300' : 'text-amber-300'}>
            {p.autoFitInfo.text}
          </div>
        )}
      </div>

      {/* Landmarks: the tracks lie on the base map, so its features are ground truth too */}
      <div className="p-2.5 rounded-xl bg-orange-950/30 border border-orange-500/40 space-y-2">
        <div className="font-semibold text-orange-200">📍 По приметным местам</div>
        <div className="text-slate-300">
          Кликните место на скане (перекрёсток, угол здания или забора), затем то же место на
          подложке. 1 точка — сдвиг, 2–3 — ещё масштаб и поворот, 4+ — и растяжение. Точки
          учитываются и при подгонке по КП.
        </div>
        <button
          onClick={p.onAddPin}
          disabled={p.pinStage !== null}
          className="w-full px-2.5 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-60 text-white font-semibold"
        >
          {p.pinStage === 'pin_map'
            ? 'Кликните место на скане…'
            : p.pinStage === 'pin_base'
              ? 'Кликните то же место на подложке…'
              : '+ Добавить точку'}
        </button>
        {p.pins.length > 0 && (
          <div className="space-y-0.5">
            {p.pins.map((g, i) => (
              <div key={g.id} className="flex items-center justify-between text-slate-300">
                <span>
                  <span className="inline-flex w-4 h-4 mr-1 rounded-full bg-orange-500 text-[9px] font-bold text-white items-center justify-center">
                    {i + 1}
                  </span>
                  {p.pins.length >= 2 && g.residualM !== undefined
                    ? `расхождение ${g.residualM} м`
                    : 'точка'}
                </span>
                <button
                  onClick={() => p.onRemovePin(g.id)}
                  className="text-slate-500 hover:text-rose-300"
                  title="Удалить точку"
                >
                  ✕
                </button>
              </div>
            ))}
            <button onClick={p.onClearPins} className="text-[11px] text-slate-400 hover:text-rose-300">
              очистить все точки
            </button>
          </div>
        )}
      </div>

      {/* 1. Absolute scale & north */}
      <div className={sectionCls}>
        <div className="font-semibold text-slate-200">1. Масштаб и север</div>
        <div className="grid grid-cols-2 gap-1 bg-slate-900 p-0.5 rounded-lg border border-slate-800">
          {(
            [
              ['orienteering', '🧭 Карта О'],
              ['screenshot', '🗺 Скриншот'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => p.onMapImageKind(k)}
              className={`px-2 py-0.5 rounded-md ${
                p.mapImageKind === k
                  ? 'bg-emerald-600 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title={
                k === 'orienteering'
                  ? 'Карта ориентирования: нарисована на магнитный север, масштаб напечатан на карте'
                  : 'Скриншот Google Maps: истинный север, масштаб — по линейке на скриншоте'
              }
            >
              {label}
            </button>
          ))}
        </div>

        {isOMap && (
          <div className="grid grid-cols-3 gap-1.5">
            <label className="space-y-0.5 text-slate-400" title="Масштаб печати — напечатан на карте">
              <span>Масштаб 1:</span>
              <input
                list="retrace-print-scales"
                type="number"
                min={500}
                max={200000}
                step={500}
                value={p.printScale}
                onChange={(e) => p.onPrintScale(Number(e.target.value))}
                className={inputCls}
              />
              <datalist id="retrace-print-scales">
                {PRINT_SCALES.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </label>
            <label
              className="space-y-0.5 text-slate-400"
              title="Разрешение скана. Для фото с телефона неизвестно — используйте линейку"
            >
              <span>DPI скана</span>
              <input
                type="number"
                min={30}
                max={2400}
                step={10}
                value={p.scanDpi}
                onChange={(e) => p.onScanDpi(Number(e.target.value))}
                className={inputCls}
              />
            </label>
            <label
              className="space-y-0.5 text-slate-400"
              title="Магнитное склонение: карта О нарисована на магнитный север"
            >
              <span>Склонение °</span>
              <input
                type="number"
                min={-60}
                max={60}
                step={0.1}
                value={p.declinationDeg}
                onChange={(e) => p.onDeclinationDeg(Number(e.target.value))}
                className={inputCls}
              />
            </label>
          </div>
        )}
        {isOMap && p.declinationDeg !== p.autoDeclinationDeg && (
          <button
            onClick={() => p.onDeclinationDeg(p.autoDeclinationDeg)}
            className="text-sky-300 hover:underline"
            title="Склонение по модели WMM2025 для старта и даты забега"
          >
            склонение авто: {formatSignedDeg(p.autoDeclinationDeg)}
          </button>
        )}

        <button
          onClick={p.onApplyScaleAndNorth}
          className="w-full px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
          title="⚓ СТАРТ при этом не сдвигается"
        >
          {isOMap ? 'Применить масштаб и север' : 'Выровнять на север'}
        </button>
        <button
          onClick={p.onStartScaleBar}
          className="w-full px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-amber-300"
          title="Кликнуть два конца масштабной линейки на карте и ввести её длину — для фото и скриншотов"
        >
          📏 Масштаб по линейке на карте
        </button>
        {p.readout && (
          <div className="text-[11px] text-slate-400 font-mono">
            сейчас {p.readout.metersPerPixel.toFixed(3)} м/пикс
            {p.readout.impliedScale ? ` ≈ 1:${p.readout.impliedScale}` : ''}, север{' '}
            {formatSignedDeg(p.readout.upBearingDeg)}
          </div>
        )}
      </div>

      {/* 2. Mouse */}
      <div className={sectionCls}>
        <div className="font-semibold text-slate-200">2. Перетаскивание</div>
        <button
          onClick={p.onToggleDragMovesMap}
          className={`w-full inline-flex items-center justify-center gap-1 px-2.5 py-1 rounded-lg border font-medium ${
            p.dragMovesMap
              ? 'bg-amber-500 text-slate-950 border-amber-400'
              : 'bg-slate-800 text-sky-300 border-slate-700'
          }`}
          title="Что двигает левая кнопка мыши. С Shift всегда двигается экран"
        >
          {p.dragMovesMap ? (
            <>
              <Move className="w-3.5 h-3.5" /> Мышь двигает КАРТУ (Shift — экран)
            </>
          ) : (
            <>
              <Globe className="w-3.5 h-3.5" /> Мышь двигает ЭКРАН
            </>
          )}
        </button>
      </div>

      {/* 3. Fine tuning around the anchor */}
      <div className={sectionCls}>
        <div className="font-semibold text-slate-200">3. Подстройка вокруг ⚓</div>
        {slider(
          'Масштаб',
          `${p.scalePct - 100 > 0 ? '+' : ''}${p.scalePct - 100}%`,
          <div className="flex items-center gap-1">
            <button
              onClick={() => p.onScale(p.scalePct - 1, true)}
              className="px-1.5 rounded bg-slate-800 hover:bg-slate-700 font-mono"
            >
              −
            </button>
            <input
              type="range"
              min={40}
              max={260}
              step={1}
              value={p.scalePct}
              onChange={(e) => p.onScale(parseFloat(e.target.value), false)}
              {...rangeProps}
              className="flex-1 accent-emerald-500"
            />
            <button
              onClick={() => p.onScale(p.scalePct + 1, true)}
              className="px-1.5 rounded bg-slate-800 hover:bg-slate-700 font-mono"
            >
              +
            </button>
          </div>,
          'text-emerald-400'
        )}
        {slider(
          'Поворот',
          formatSignedDeg(p.angleDeg),
          <div className="flex items-center gap-1">
            <button
              onClick={() => p.onAngle(Math.round((p.angleDeg - 0.5) * 10) / 10, true)}
              className="px-1.5 rounded bg-slate-800 hover:bg-slate-700 font-mono"
              title="−0.5° (по часовой)"
            >
              ↻
            </button>
            <input
              type="range"
              min={-45}
              max={45}
              step={0.5}
              value={p.angleDeg}
              onChange={(e) => p.onAngle(parseFloat(e.target.value), false)}
              {...rangeProps}
              className="flex-1 accent-amber-500"
            />
            <button
              onClick={() => p.onAngle(Math.round((p.angleDeg + 0.5) * 10) / 10, true)}
              className="px-1.5 rounded bg-slate-800 hover:bg-slate-700 font-mono"
              title="+0.5° (против часовой)"
            >
              ↺
            </button>
          </div>,
          'text-amber-400'
        )}
        {slider(
          'Ширина / высота',
          `${p.stretchPct > 0 ? '+' : ''}${p.stretchPct}%`,
          <input
            type="range"
            min={-25}
            max={25}
            step={1}
            value={p.stretchPct}
            onChange={(e) => p.onStretch(parseFloat(e.target.value), false)}
            {...rangeProps}
            className="w-full accent-sky-500"
            title="Если фото карты снято чуть под углом"
          />,
          'text-sky-400'
        )}
        <div className="flex items-center justify-between">
          <span className="text-slate-400">Сдвиг на 5 м</span>
          <div className="flex gap-0.5">
            {(
              [
                [ArrowLeft, -5, 0, 'влево'],
                [ArrowUp, 0, 5, 'вверх'],
                [ArrowDown, 0, -5, 'вниз'],
                [ArrowRight, 5, 0, 'вправо'],
              ] as const
            ).map(([Icon, e, n, t]) => (
              <button
                key={t}
                onClick={() => p.onNudge(e, n)}
                className="p-1 rounded bg-slate-800 hover:bg-slate-700"
                title={`Сдвинуть карту на 5 м ${t}`}
              >
                <Icon className="w-3 h-3" />
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={p.onResetPlacement}
          className="w-full px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-white"
          title="Вернуть карту в автоматическое положение: над треками или в центр экрана"
        >
          ↺ Сбросить положение карты
        </button>
      </div>
    </div>
  );
};
