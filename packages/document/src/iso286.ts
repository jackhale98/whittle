// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ISO 286 fit classes (M4, ADR-090): parsing and deviations.
 *
 * Deviations are computed from the closed formulas of ISO 286-1 (standard tolerance unit
 * `i = 0.45 ∛D + 0.001 D`, fundamental deviation formulas per letter) and not copied from the
 * ISO 286-2 tables. **Provisional (secondary sources):** the owner decided (ADR-090, D9) to build
 * from public sources first and re-verify once the standards are bought. The printed tables round
 * some cells by rules that are not published as formulas, so a result can differ from the table by
 * one rounding step (a few micrometres at most). Every result carries `provisional: true`. Letters
 * whose fundamental deviation is tabulated without a closed formula (`j`, `p`, `r`, `s` up to
 * 50 mm) are reported as unsupported; callers then show the symbol without deviations. Nothing is
 * ever guessed.
 *
 * Units: input diameter in mm; deviations are returned in mm (signed, relative to the nominal).
 */

/** Hole class: one or two capital letters then the IT grade (`01` or 1–18). */
export const HOLE_FIT_RE = /^([A-Z]{1,2})(01|[1-9]|1[0-8])$/;
/** Shaft class: the lower-case form. */
export const SHAFT_FIT_RE = /^([a-z]{1,2})(01|[1-9]|1[0-8])$/;

export const isHoleFitClass = (s: unknown): s is string =>
  typeof s === 'string' && HOLE_FIT_RE.test(s);
export const isShaftFitClass = (s: unknown): s is string =>
  typeof s === 'string' && SHAFT_FIT_RE.test(s);

export interface FitClass {
  /** `hole` for capitals, `shaft` for lower case. */
  side: 'hole' | 'shaft';
  /** Fundamental deviation letter(s) in lower case: `h`, `js`, `cd`. */
  letter: string;
  /** IT grade: `0` stands for IT01 (use `grade === 0`), otherwise 1–18. */
  grade: number;
}

/** Parses `H7`, `g6`, `JS9`, `cd8`. Returns undefined when the text is not an ISO 286 class. */
export function parseFitClass(text: string): FitClass | undefined {
  const hole = HOLE_FIT_RE.exec(text);
  const shaft = hole ? null : SHAFT_FIT_RE.exec(text);
  const m = hole ?? shaft;
  if (!m) return undefined;
  const letter = (m[1] as string).toLowerCase();
  if (!LETTERS.includes(letter)) return undefined;
  const g = m[2] as string;
  return { side: hole ? 'hole' : 'shaft', letter, grade: g === '01' ? 0 : Number(g) };
}

/** Fundamental deviation letters ISO 286-1 defines (`j` and `js`: only `js` is symmetric). */
const LETTERS = [
  'a',
  'b',
  'c',
  'cd',
  'd',
  'e',
  'ef',
  'f',
  'fg',
  'g',
  'h',
  'j',
  'js',
  'k',
  'm',
  'n',
  'p',
  'r',
  's',
  't',
  'u',
  'v',
  'x',
  'y',
  'z',
  'za',
  'zb',
  'zc',
];

/** Nominal size ranges of ISO 286-1 up to 500 mm (upper limits; the first starts above 0). */
const RANGE_UPPER = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500];
export const ISO286_MAX_SIZE = 500;

/** Geometric mean of the size range containing `d` (mm), or undefined outside 0 < d ≤ 500. */
export function rangeMean(d: number): number | undefined {
  if (!Number.isFinite(d) || d <= 0 || d > ISO286_MAX_SIZE) return undefined;
  const k = RANGE_UPPER.findIndex((u) => d <= u);
  const hi = RANGE_UPPER[k] as number;
  const lo = k === 0 ? 1 : (RANGE_UPPER[k - 1] as number);
  return Math.sqrt(lo * hi);
}

/** Rounds a value in µm the way the printed tables mostly do: 1 µm below 100, 10 µm above. */
function roundUm(x: number): number {
  const a = Math.abs(x);
  const step = a < 100 ? 1 : a < 1000 ? 10 : 100;
  return Math.round(x / step) * step;
}

const KMULT: Record<number, number> = {
  5: 7,
  6: 10,
  7: 16,
  8: 25,
  9: 40,
  10: 64,
  11: 100,
  12: 160,
  13: 250,
  14: 400,
  15: 640,
  16: 1000,
  17: 1600,
  18: 2500,
};

/** Standard tolerance IT grade in µm for a size-range mean `D` (`grade` 0 = IT01). */
export function itMicrometres(grade: number, D: number): number {
  const i = 0.45 * Math.cbrt(D) + 0.001 * D;
  if (grade === 0) return Math.round((0.3 + 0.008 * D) * 10) / 10;
  if (grade === 1) return Math.round((0.8 + 0.02 * D) * 10) / 10;
  if (grade >= 2 && grade <= 4) {
    // Geometric progression between IT1 and IT5.
    const it1 = 0.8 + 0.02 * D;
    const it5 = 7 * i;
    return Math.round(it1 * (it5 / it1) ** ((grade - 1) / 4) * 10) / 10;
  }
  return roundUm((KMULT[grade] as number) * i);
}

/** Letters whose shaft fundamental deviation is the upper one (es). */
const ES_LETTERS = new Set(['a', 'b', 'c', 'cd', 'd', 'e', 'ef', 'f', 'fg', 'g', 'h']);

type Formula = (D: number, grade: number) => number | undefined;

const itOf = (g: number, D: number): number => itMicrometres(g, D);

/**
 * Shaft fundamental deviation in µm (upper deviation `es` for a–h, lower deviation `ei` for k–zc),
 * or undefined when ISO 286-1 gives no closed formula.
 */
const SHAFT_FD: Record<string, Formula> = {
  a: (D) => -(D <= 120 ? 265 + 1.3 * D : 3.5 * D),
  b: (D) => -(D <= 160 ? 140 + 0.85 * D : 1.8 * D),
  c: (D) => -(D <= 40 ? 52 * D ** 0.2 : 95 + 0.8 * D),
  d: (D) => -16 * D ** 0.44,
  e: (D) => -11 * D ** 0.41,
  f: (D) => -5.5 * D ** 0.41,
  g: (D) => -2.5 * D ** 0.34,
  h: () => 0,
  k: (D, g) => (g >= 4 && g <= 7 ? 0.6 * Math.cbrt(D) : 0),
  m: (D) => itOf(7, D) - itOf(6, D),
  n: (D) => 5 * D ** 0.34,
  s: (D) => (D > 50 ? itOf(7, D) + 0.4 * D : undefined),
  t: (D) => itOf(7, D) + 0.63 * D,
  u: (D) => itOf(7, D) + D,
  v: (D) => itOf(7, D) + 1.25 * D,
  x: (D) => itOf(7, D) + 1.6 * D,
  y: (D) => itOf(7, D) + 2 * D,
  z: (D) => itOf(7, D) + 2.5 * D,
  za: (D) => itOf(8, D) + 3.15 * D,
  zb: (D) => itOf(9, D) + 4 * D,
  zc: (D) => itOf(10, D) + 5 * D,
};

/** Letters built as the geometric mean of two neighbours. */
const MEAN_OF: Record<string, [string, string]> = {
  cd: ['c', 'd'],
  ef: ['e', 'f'],
  fg: ['f', 'g'],
};

function shaftFd(letter: string, D: number, grade: number): number | undefined {
  const pair = MEAN_OF[letter];
  if (pair) {
    const a = shaftFd(pair[0], D, grade);
    const b = shaftFd(pair[1], D, grade);
    return a === undefined || b === undefined ? undefined : -roundUm(Math.sqrt(a * b));
  }
  const f = SHAFT_FD[letter];
  const v = f?.(D, grade);
  return v === undefined ? undefined : letter === 'h' ? 0 : roundUm(v);
}

export type FitDeviationResult =
  | {
      ok: true;
      /** Upper and lower deviation in mm (signed), relative to the nominal size. */
      upper: number;
      lower: number;
      provisional: true;
    }
  | { ok: false; reason: string };

/**
 * Upper and lower deviations of a fit class for a nominal size, from the ISO 286-1 formulas.
 * `size` in mm, 0 < size ≤ 500.
 */
export function fitDeviations(fitClass: string, size: number): FitDeviationResult {
  const c = parseFitClass(fitClass);
  if (!c) return { ok: false, reason: `‘${fitClass}’ is not an ISO 286 class` };
  const D = rangeMean(size);
  if (D === undefined) {
    return {
      ok: false,
      reason: `ISO 286 deviations are computed for sizes up to ${ISO286_MAX_SIZE} mm`,
    };
  }
  const it = itMicrometres(c.grade, D);
  const mm = (um: number): number => Math.round(um * 1000) / 1e6;
  const tabulated = (): FitDeviationResult => ({
    ok: false,
    reason: `ISO 286-1 tabulates the ‘${c.letter}’ deviation without a closed formula`,
  });
  if (c.letter === 'js') {
    return { ok: true, upper: mm(it / 2), lower: mm(-it / 2), provisional: true };
  }
  if (c.letter === 'j' || c.letter === 'p' || c.letter === 'r') return tabulated();
  if (c.side === 'shaft') {
    const fd = shaftFd(c.letter, D, c.grade);
    if (fd === undefined) return tabulated();
    return ES_LETTERS.has(c.letter)
      ? { ok: true, upper: mm(fd), lower: mm(fd - it), provisional: true }
      : { ok: true, upper: mm(fd + it), lower: mm(fd), provisional: true };
  }
  // Holes A–H mirror the shaft's upper deviation (EI = −es).
  if (ES_LETTERS.has(c.letter)) {
    const es = shaftFd(c.letter, D, c.grade);
    if (es === undefined) return tabulated();
    return { ok: true, upper: mm(-es + it), lower: mm(-es), provisional: true };
  }
  // K–ZC: general rule ES = −ei, with Δ = IT_n − IT_(n−1) added for K, M, N up to IT8 and
  // P–ZC up to IT7. K up to IT8 uses the shaft ‘k’ value of the 4–7 range.
  const special = 'kmn'.includes(c.letter) ? c.grade <= 8 : c.grade <= 7;
  const ei = shaftFd(c.letter, D, c.letter === 'k' && c.grade >= 4 && c.grade <= 8 ? 7 : c.grade);
  if (ei === undefined) return tabulated();
  const delta =
    special && c.grade > 1 ? itMicrometres(c.grade, D) - itMicrometres(c.grade - 1, D) : 0;
  const es = -ei + delta;
  return { ok: true, upper: mm(es), lower: mm(es - it), provisional: true };
}
