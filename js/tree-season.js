import { copenhagenLocalDateTimeToUtc } from './sun-position.js';

// Northern-European phenology estimates, calibrated to nature-light.md §2.2 and
// the 27 April CIR leaf-out observations in ortho-cir.md. Colours are sRGB.
export const DEFAULT_TREE_DATE = '2026-10-26';
export const OCTOBER_DAY = 299;
export const PHENOLOGY_SPREAD = 12;

// bud, full leaf, first colour, first fall, retained on 26 Oct, bare, autumn RGB.
const rows = {
  chestnut: [99, 125, 235, 260, 0.45, 319, [120, 80, 40]],
  lime: [104, 133, 268, 281, 0.65, 324, [200, 170, 60]],
  plane: [115, 146, 280, 289, 0.80, 345, [170, 140, 70]],
  willow: [85, 115, 284, 292, 0.88, 338, [90, 110, 50]],
  poplar: [85, 114, 269, 281, 0.63, 322, [113, 132, 49]],
  birch: [100, 130, 260, 275, 0.48, 318, [191, 163, 57]],
  elm: [118, 149, 269, 280, 0.58, 324, [164, 135, 52]],
  ash: [121, 152, 264, 273, 0.36, 315, [139, 126, 55]],
  robinia: [124, 156, 278, 289, 0.66, 330, [175, 166, 67]],
  oak: [104, 137, 282, 292, 0.83, 348, [143, 102, 46]],
  maple: [105, 137, 263, 279, 0.60, 326, [181, 111, 38]],
  cherry: [99, 133, 262, 277, 0.52, 321, [163, 86, 40]],
  hawthorn: [100, 131, 272, 282, 0.60, 329, [154, 115, 51]],
  generic: [105, 136, 272, 283, 0.63, 329, [156, 123, 53]],
  conifer: [1, 2, 365, 365, 1, 366, [28, 68, 37]]
};
export const TREE_SEASONS = Object.fromEntries(Object.entries(rows).map(([genus, r]) => [genus, {
  bud: r[0], full: r[1], turn: r[2], fall: r[3], retained: r[4], bare: r[5], autumn: r[6].map(v => v / 255), evergreen: genus === 'conifer'
}]));

/** Strict ISO calendar date; local timezone and the machine's clock do not change the scene. */
export function treeDayOfYear(value = DEFAULT_TREE_DATE) {
  // Lighting passes its already-validated instant. Keep its Copenhagen civil date,
  // including times whose UTC date is the previous day.
  if (value instanceof Date && Number.isFinite(value.valueOf())) {
    value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  }
  try { copenhagenLocalDateTimeToUtc(value, '12:00'); } catch { return OCTOBER_DAY; }
  const date = new Date(`${value}T12:00:00Z`);
  // The phenology table is a 365-day calendar: leap day must not move autumn by a day.
  const day = Math.floor((date - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  const leap = new Date(Date.UTC(date.getUTCFullYear(), 1, 29)).getUTCMonth() === 1;
  return day - (leap && date.getUTCMonth() > 1 ? 1 : 0);
}

const ramp = (a, b, x) => Math.max(0, Math.min(1, (x - a) / Math.max(1, b - a)));
const smooth = (a, b, x) => { const t = ramp(a, b, x); return t * t * (3 - 2 * t); };
const blend = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const rgb = values => values.map(v => v / 255);

/** Interpolate along botanical colour stages in sRGB, never through a red/pink tint. */
export function treeLeafColour(genus, day = OCTOBER_DAY, summer = [0.23, 0.41, 0.14]) {
  const s = TREE_SEASONS[genus] || TREE_SEASONS.generic;
  if (s.evergreen || day <= s.turn) return [...summer];
  const green = rgb([90, 110, 50]);
  const late = genus === 'willow' || genus === 'poplar';
  const stages = late ? [
    [s.turn, summer], [299, s.autumn], [309, rgb([174, 163, 60])], [s.bare, rgb([104, 88, 46])]
  ] : [
    [s.turn, summer], [287, green],
    [293, rgb(genus === 'chestnut' ? [170, 151, 51] : [151, 155, 48])],
    [299, s.autumn], [Math.min(319, s.bare), rgb([104, 83, 45])]
  ];
  for (let i = 1; i < stages.length; i++) {
    if (day <= stages[i][0]) return blend(stages[i - 1][1], stages[i][1], smooth(stages[i - 1][0], stages[i][0], day));
  }
  return [...stages.at(-1)[1]];
}

/** Stable individual advance/delay, with a 7–12 day local range on either side. */
export function treePhenologyOffset(x, z) {
  const hash = salt => {
    const value = Math.sin(x * 12.9898 + z * 78.233 + salt) * 43758.5453;
    return value - Math.floor(value);
  };
  return (hash(91) * 2 - 1) * (7 + hash(173) * 5);
}

// A shared genus mesh must include every spray that an earlier/later individual
// can retain. Per-instance alpha testing performs the remaining shedding.
export function treeGeometryDensity(genus, day) {
  let density = 0;
  for (let offset = -PHENOLOGY_SPREAD; offset <= PHENOLOGY_SPREAD; offset++) {
    density = Math.max(density, treeSeason(genus, day + offset).density);
  }
  return density;
}

/** Seasonal leaf colour, retained spray fraction and hard-ground litter coverage. */
export function treeSeason(genus, day = OCTOBER_DAY, summer = [0.23, 0.41, 0.14]) {
  const s = TREE_SEASONS[genus] || TREE_SEASONS.generic;
  if (s.evergreen) return { density: 1, colour: [...summer], autumn: 0, litter: 0 };
  const autumn = smooth(s.turn, OCTOBER_DAY, day);
  // The October window retains 30–60% of chestnut leaves and 60–80% of lime
  // leaves across individuals, then sheds the remainder before the bare date.
  const range = genus === 'chestnut' ? [0.60, 0.30] : genus === 'lime' ? [0.80, 0.60] : null;
  const fallen = range ?
    ramp(s.fall, 287, day) * (1 - range[0]) + ramp(287, 299, day) * (range[0] - s.retained) +
      ramp(299, 311, day) * (s.retained - range[1]) + ramp(311, s.bare, day) * range[1] :
    ramp(s.fall, OCTOBER_DAY, day) * (1 - s.retained) + ramp(OCTOBER_DAY, s.bare, day) * s.retained;
  return {
    density: smooth(s.bud, s.full, day) * (1 - fallen), autumn,
    colour: treeLeafColour(genus, day, summer),
    litter: fallen * (1 - ramp(335, 365, day))
  };
}
