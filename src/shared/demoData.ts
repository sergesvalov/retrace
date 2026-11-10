import { solveGeoref } from './georef.js';
import {
  normalizeSamplesToTrack,
  pickTrackColor,
  type RawTrackSample,
} from './trackParser.js';
import type { ControlPoint, GCP, MapOverlay, RaceEvent } from './types.js';

/**
 * Generates an SVG Orienteering Map data URL and 3 realistic multi-runner GPS tracks
 * around Bitsevsky Forest (Moscow) so the user can immediately test georeferencing & animated replay.
 */
export function createDemoOrienteeringEvent(): RaceEvent {
  const width = 1200;
  const height = 900;

  // Map covers roughly lon [37.5400, 37.5680], lat [55.5950, 55.6110]
  const gcps: GCP[] = [
    {
      id: 'gcp-1',
      label: 'КП Старт (перекрёсток просек)',
      px: 180,
      py: 720,
      lon: 37.5442,
      lat: 55.5974,
    },
    {
      id: 'gcp-2',
      label: 'Мост через овраг (СЗ)',
      px: 220,
      py: 190,
      lon: 37.5453,
      lat: 55.6081,
    },
    {
      id: 'gcp-3',
      label: 'Поляна Лысая гора (СВ)',
      px: 980,
      py: 210,
      lon: 37.5635,
      lat: 55.6077,
    },
    {
      id: 'gcp-4',
      label: 'Родник у ручья (ЮВ)',
      px: 940,
      py: 735,
      lon: 37.5625,
      lat: 55.5971,
    },
  ];

  const solved = solveGeoref(gcps, width, height, 'affine')!;

  const svgMap = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <defs>
      <pattern id="magNorth" width="120" height="900" patternUnits="userSpaceOnUse" patternTransform="rotate(-6)">
        <line x1="60" y1="0" x2="60" y2="900" stroke="#2563eb" stroke-width="1.2" stroke-opacity="0.45"/>
        <polygon points="60,18 55,34 65,34" fill="#2563eb" fill-opacity="0.55"/>
      </pattern>
      <pattern id="marsh" width="24" height="10" patternUnits="userSpaceOnUse">
        <line x1="2" y1="5" x2="22" y2="5" stroke="#0284c7" stroke-width="1.5" stroke-opacity="0.55"/>
      </pattern>
    </defs>
    <!-- Orienteering map base (open forest white + semi-open yellow + dense green) -->
    <rect width="1200" height="900" fill="#fbf8ee"/>
    <!-- Semi-open clearings (yellow ISOM 401/403) -->
    <ellipse cx="960" cy="230" rx="145" ry="95" fill="#fde047" fill-opacity="0.65"/>
    <ellipse cx="520" cy="540" rx="110" ry="70" fill="#fde047" fill-opacity="0.5"/>
    <!-- Slow/thick forest (green ISOM 406/408) -->
    <path d="M 310 260 Q 470 210 560 320 Q 610 430 430 450 Q 290 410 310 260 Z" fill="#86efac" fill-opacity="0.65"/>
    <path d="M 640 430 Q 790 390 850 520 Q 820 650 670 630 Q 590 560 640 430 Z" fill="#4ade80" fill-opacity="0.55"/>
    <path d="M 230 520 Q 350 490 390 610 Q 330 700 220 640 Z" fill="#bbf7d0" fill-opacity="0.7"/>
    <!-- Marsh area -->
    <ellipse cx="620" cy="240" rx="85" ry="42" fill="url(#marsh)"/>
    <!-- Contours (brown ISOM 101) -->
    <g fill="none" stroke="#b45309" stroke-width="1.6" stroke-opacity="0.55">
      <path d="M 80 140 Q 420 90 760 160 T 1130 130"/>
      <path d="M 70 240 Q 410 190 730 270 T 1140 250"/>
      <path d="M 90 360 Q 460 310 750 380 T 1120 370"/>
      <path d="M 80 480 Q 430 450 760 510 T 1130 490"/>
      <path d="M 90 610 Q 470 570 790 640 T 1120 620"/>
      <path d="M 100 760 Q 480 710 820 770 T 1130 750"/>
      <ellipse cx="980" cy="210" rx="85" ry="52" stroke-width="2.2"/>
      <ellipse cx="980" cy="210" rx="42" ry="25"/>
    </g>
    <!-- Stream / creek (blue) -->
    <path d="M 140 120 Q 320 220 490 290 T 820 560 T 1060 820" fill="none" stroke="#0284c7" stroke-width="3.5"/>
    <!-- Forest rides & trails (black dashed) -->
    <g fill="none" stroke="#1e293b" stroke-linecap="round">
      <path d="M 120 780 L 240 120" stroke-width="2.5" stroke-dasharray="12 6"/>
      <path d="M 100 710 L 1060 745" stroke-width="2.5" stroke-dasharray="12 6"/>
      <path d="M 220 190 L 980 210" stroke-width="2.2" stroke-dasharray="10 6"/>
      <path d="M 180 720 Q 410 580 540 520 T 980 210" stroke-width="1.8" stroke-dasharray="6 5"/>
      <path d="M 220 190 Q 480 390 650 590 T 940 735" stroke-width="1.8" stroke-dasharray="6 5"/>
    </g>
    <!-- Magnetic north lines -->
    <rect width="1200" height="900" fill="url(#magNorth)"/>
    <!-- Purple Orienteering Course Overlay (ISOM 701-709) -->
    <g fill="none" stroke="#9333ea" stroke-width="3.2" stroke-opacity="0.85">
      <!-- Start triangle around (180, 720) -->
      <polygon points="180,694 158,733 202,733"/>
      <!-- Control 31 at (220, 190) -->
      <circle cx="220" cy="190" r="22"/>
      <!-- Control 32 at (610, 330) -->
      <circle cx="610" cy="330" r="22"/>
      <!-- Control 33 at (980, 210) -->
      <circle cx="980" cy="210" r="22"/>
      <!-- Control 34 at (730, 560) -->
      <circle cx="730" cy="560" r="22"/>
      <!-- Finish double circle at (940, 735) -->
      <circle cx="940" cy="735" r="18"/>
      <circle cx="940" cy="735" r="25"/>
      <!-- Course legs -->
      <line x1="184" y1="692" x2="218" y2="212"/>
      <line x1="241" y1="198" x2="589" y2="322"/>
      <line x1="631" y1="323" x2="959" y2="217"/>
      <line x1="967" y1="229" x2="743" y2="541"/>
      <line x1="748" y1="575" x2="922" y2="720"/>
    </g>
    <g fill="#7e22ce" font-family="sans-serif" font-size="20" font-weight="bold">
      <text x="155" y="762">СТАРТ</text>
      <text x="248" y="182">31 (Мост)</text>
      <text x="638" y="325">32 (Овраг)</text>
      <text x="1008" y="205">33 (Поляна)</text>
      <text x="760" y="565">34 (Бугор)</text>
      <text x="972" y="742">ФИНИШ</text>
    </g>
    <!-- Map title header box -->
    <rect x="24" y="20" width="430" height="58" rx="8" fill="#ffffff" fill-opacity="0.88" stroke="#cbd5e1"/>
    <text x="40" y="46" font-family="sans-serif" font-size="18" font-weight="bold" fill="#0f172a">СПОРТИВНОЕ ОРИЕНТИРОВАНИЕ — БИТЦА</text>
    <text x="40" y="66" font-family="sans-serif" font-size="13" fill="#475569">Масштаб 1:7 500 • Сечение рельефа 2.5 м • Демо-карта Retrace</text>
  </svg>`;

  const imageUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svgMap)}`;

  const map: MapOverlay = {
    id: 'demo-map-1',
    name: 'Карта ориентирования: Битцевский лес (1:7500)',
    imageUrl,
    width,
    height,
    gcps: solved.gcpsWithResiduals,
    transformType: 'affine',
    matrix: solved.matrix,
    cornersLonLat: solved.cornersLonLat,
    rmsErrorM: solved.rmsErrorM,
    rotationDeg: solved.rotationDeg,
  };

  // Control points in lon/lat corresponding to course circles
  const controlPoints: ControlPoint[] = [
    { id: 'cp-s', code: 'СТАРТ', lon: 37.5442, lat: 55.5974, radiusM: 25 },
    { id: 'cp-31', code: 'КП 31', lon: 37.5453, lat: 55.6081, radiusM: 25 },
    { id: 'cp-32', code: 'КП 32', lon: 37.5546, lat: 55.6053, radiusM: 25 },
    { id: 'cp-33', code: 'КП 33', lon: 37.5635, lat: 55.6077, radiusM: 25 },
    { id: 'cp-34', code: 'КП 34', lon: 37.5575, lat: 55.6006, radiusM: 25 },
    { id: 'cp-f', code: 'ФИНИШ', lon: 37.5625, lat: 55.5971, radiusM: 25 },
  ];

  const baseEpoch = Date.parse('2026-10-18T08:00:00Z');

  // Runner 1: Алексей (Garmin Forerunner 965) — fast, takes northern trail route on leg 1->2
  const runner1Waypoints: Array<[number, number, number, number]> = [
    // [lon, lat, speedMs, hr]
    [37.5442, 55.5974, 4.1, 138],
    [37.5439, 55.6012, 4.3, 156],
    [37.5445, 55.6048, 4.0, 164],
    [37.5453, 55.6081, 3.8, 168], // CP 31
    [37.5495, 55.6075, 3.6, 171], // North around marsh
    [37.5528, 55.6064, 3.5, 173],
    [37.5546, 55.6053, 3.3, 175], // CP 32
    [37.5588, 55.6068, 4.2, 172],
    [37.5635, 55.6077, 4.0, 176], // CP 33
    [37.5612, 55.6041, 3.7, 174],
    [37.5575, 55.6006, 3.9, 177], // CP 34
    [37.5602, 55.5988, 4.5, 181],
    [37.5625, 55.5971, 4.8, 185], // Finish
  ];

  // Runner 2: Мария (Garmin Fenix 7) — steady pace, straight line on leg 1->2 through slow green forest, faster on leg 3->4
  const runner2Waypoints: Array<[number, number, number, number]> = [
    [37.5442, 55.5974, 3.8, 142],
    [37.5451, 55.6015, 3.7, 158],
    [37.5456, 55.6052, 3.9, 163],
    [37.5453, 55.6081, 3.6, 166], // CP 31
    [37.5482, 55.6061, 2.6, 174], // Straight through green thicket (slower!)
    [37.5515, 55.6051, 2.8, 176],
    [37.5546, 55.6053, 3.4, 173], // CP 32
    [37.5592, 55.6062, 3.9, 171],
    [37.5635, 55.6077, 3.8, 174], // CP 33
    [37.5621, 55.6035, 4.3, 175], // Fast trail choice
    [37.5575, 55.6006, 4.1, 177], // CP 34
    [37.5598, 55.5985, 4.2, 179],
    [37.5625, 55.5971, 4.5, 182], // Finish
  ];

  // Runner 3: Дмитрий (Garmin Instinct 2) — fast start, makes an orienteering mistake near CP 32 & CP 34
  const runner3Waypoints: Array<[number, number, number, number]> = [
    [37.5442, 55.5974, 4.5, 148],
    [37.5462, 55.6008, 4.3, 166], // Eastern route choice to CP 31
    [37.5465, 55.6049, 4.1, 172],
    [37.5453, 55.6081, 3.9, 175], // CP 31
    [37.5504, 55.6068, 3.8, 176],
    [37.5558, 55.6036, 2.2, 179], // Overshot CP 32 to the south!
    [37.5546, 55.6053, 3.1, 180], // Relocated CP 32
    [37.5595, 55.6069, 4.1, 177],
    [37.5635, 55.6077, 4.0, 179], // CP 33
    [37.5591, 55.6038, 3.6, 176],
    [37.5558, 55.6012, 2.5, 178], // Small hesitation before CP 34
    [37.5575, 55.6006, 3.7, 179], // CP 34
    [37.5625, 55.5971, 4.6, 186], // Finish sprint
  ];

  const participants = [
     normalizeSamplesToTrack({
      id: 'p-1',
      name: 'Алексей Морозов (FR 965)',
      color: pickTrackColor(0),
      sourceFormat: 'demo',
      samples: synthesizeDenseSamples(runner1Waypoints, baseEpoch, 1),
    }),
    normalizeSamplesToTrack({
      id: 'p-2',
      name: 'Мария Соколова (Fenix 7)',
      color: pickTrackColor(1),
      sourceFormat: 'demo',
      samples: synthesizeDenseSamples(runner2Waypoints, baseEpoch + 120_000, 2),
    }),
    normalizeSamplesToTrack({
      id: 'p-3',
      name: 'Дмитрий Волков (Instinct 2)',
      color: pickTrackColor(2),
      sourceFormat: 'demo',
      samples: synthesizeDenseSamples(runner3Waypoints, baseEpoch + 240_000, 3),
    }),
  ];

  return {
    id: 'demo-bitza-2026',
    slug: 'demo-bitza-2026',
    title: 'Чемпионат клуба: Битцевский лес (Демо)',
    description:
      'Разбор путей 3 ориентировщиков с часов Garmin поверх привязанной растровой карты 1:7500.',
    createdAt: new Date(baseEpoch).toISOString(),
    timeMode: 'from_start',
    map,
    participants,
    controlPoints,
  };
}

function synthesizeDenseSamples(
  waypoints: Array<[number, number, number, number]>,
  startEpochMs: number,
  seed: number
): RawTrackSample[] {
  const samples: RawTrackSample[] = [];
  let currentMs = startEpochMs;
  let stepCount = 0;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const [lon0, lat0, spd0, hr0] = waypoints[i];
    const [lon1, lat1, spd1, hr1] = waypoints[i + 1];

    // Approximate segment distance in meters
    const dLatM = (lat1 - lat0) * 111_132;
    const dLonM = (lon1 - lon0) * 111_132 * Math.cos((lat0 * Math.PI) / 180);
    const segDistM = Math.hypot(dLatM, dLonM);
    const avgSpd = (spd0 + spd1) / 2;
    const segDurationSec = Math.max(8, Math.round(segDistM / avgSpd));
    const steps = Math.max(4, Math.round(segDurationSec / 2)); // 0.5 Hz sample rate

    for (let s = 0; s < steps; s++) {
      const u = s / steps;
      // Add slight natural curve/wobble so routes look like real forest GPS tracks
      const wobble =
        Math.sin(u * Math.PI) *
        0.00018 *
        Math.sin((i + seed) * 2.1 + u * 4.5);
      const lat = lat0 + (lat1 - lat0) * u + wobble * 0.6;
      const lon = lon0 + (lon1 - lon0) * u - wobble;
      const hr = Math.round(hr0 + (hr1 - hr0) * u);
      const ele =
        195 +
        Math.round(
          18 * Math.sin(lat * 450) + 12 * Math.cos(lon * 380) + stepCount * 0.05
        );

      samples.push({
        timeMs: Math.round(currentMs),
        lat,
        lon,
        ele,
        hr,
        cad: 82 + ((stepCount + seed) % 8),
      });

      currentMs += (segDurationSec / steps) * 1000;
      stepCount++;
    }
  }

  const last = waypoints[waypoints.length - 1];
  samples.push({
    timeMs: Math.round(currentMs),
    lat: last[1],
    lon: last[0],
    ele: 204,
    hr: last[3],
    cad: 88,
  });

  return samples;
}

