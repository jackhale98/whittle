// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Hole and thread standards tables for the M3 hole wizard (types: contracts `standards.ts`), and
 * `resolveHoleSize`, which turns a hole's standard, size, fit and kind into the diameters and
 * depths the kernel drills. All lengths are millimetres; angles in the tables are degrees.
 *
 * Sources (values transcribed from the published tables; spot-checked in hole-tables.test.ts):
 *  - ISO 273:1979, clearance holes for bolts and screws: fine / medium / coarse series, mapped to
 *    `close` / `normal` / `loose`.
 *  - ISO 261 / ISO 262, ISO general-purpose metric screw threads, coarse pitch.
 *  - Tap drills: DIN 336-1 / ISO 2306 core-drill recommendations for coarse threads (6H).
 *  - Counterbores for ISO 4762 socket-head cap screws: diameter from DIN 974-2 (row for ISO 4762
 *    without washer); depth = the ISO 4762 head height k max (= d), so the head sits flush.
 *  - Countersinks for ISO 10642 countersunk socket-head screws at 90°: diameter = the theoretical
 *    (sharp-edge) head diameter dk max, so the head sits flush. ISO 10642 covers M3–M20 only
 *    (no M18); other ISO rows have no countersink (`NaN`, see `available`).
 *  - ANSI (inch, Unified): clearance `close` / `normal` = the close-fit / free-fit drills of the
 *    standard tap-and-clearance drill chart (Machinery's Handbook; reproduced in Wikipedia's
 *    "List of drill and tap sizes"). `loose` follows ASME B18.2.8 where listed; for #0, #1, #3
 *    and #12, which it does not list, loose ≈ free fit + 1/64 in at a standard drill size.
 *    Tap drills: the same chart (75 % thread, UNC; #0 is 0-80 UNF, which has no UNC).
 *    Counterbores for ASME B18.3 socket-head cap screws (#0–#10, 1/4–1; none for #12), depth =
 *    head height (= d). Countersinks: ASME B18.6.3 82° flat head, theoretical head diameter
 *    (#0–3/4; none for 7/8 and 1).
 *  The inch values are converted to millimetres exactly (× 25.4).
 *
 * The ANSI loose column and the derived rows are flagged in docs/DECISIONS.md for a check against
 * the printed standard.
 */

import type { HoleSizeRow, HoleStandard, HoleTable } from '@wren-cad/contracts';

const NONE = Number.NaN;

/** Is this table value defined (a size outside a standard's range has `NaN`)? */
export function available(value: number): boolean {
  return Number.isFinite(value);
}

// ---------------------------------------------------------------------------------------------
// ISO (metric)
// ---------------------------------------------------------------------------------------------

/**
 * size, d, ISO 273 fine / medium / coarse, pitch, tap drill, DIN 974-2 counterbore Ø,
 * ISO 10642 dk (NaN = not in ISO 10642).
 */
const ISO_ROWS: readonly [
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
][] = [
  ['M1.6', 1.6, 1.7, 1.8, 2.0, 0.35, 1.25, 3.5, NONE],
  ['M2', 2, 2.2, 2.4, 2.6, 0.4, 1.6, 4.4, NONE],
  ['M2.5', 2.5, 2.7, 2.9, 3.1, 0.45, 2.05, 5.5, NONE],
  ['M3', 3, 3.2, 3.4, 3.6, 0.5, 2.5, 6.5, 6.72],
  ['M4', 4, 4.3, 4.5, 4.8, 0.7, 3.3, 8, 8.96],
  ['M5', 5, 5.3, 5.5, 5.8, 0.8, 4.2, 10, 11.2],
  ['M6', 6, 6.4, 6.6, 7, 1, 5, 11, 13.44],
  ['M8', 8, 8.4, 9, 10, 1.25, 6.8, 15, 17.92],
  ['M10', 10, 10.5, 11, 12, 1.5, 8.5, 18, 22.4],
  ['M12', 12, 13, 13.5, 14.5, 1.75, 10.2, 20, 26.88],
  ['M14', 14, 15, 15.5, 16.5, 2, 12, 24, 30.8],
  ['M16', 16, 17, 17.5, 18.5, 2, 14, 26, 33.6],
  ['M18', 18, 19, 20, 21, 2.5, 15.5, 30, NONE],
  ['M20', 20, 21, 22, 24, 2.5, 17.5, 33, 40.32],
  ['M22', 22, 23, 24, 26, 2.5, 19.5, 36, NONE],
  ['M24', 24, 25, 26, 28, 3, 21, 40, NONE],
  ['M27', 27, 28, 30, 32, 3, 24, 46, NONE],
  ['M30', 30, 31, 33, 35, 3.5, 26.5, 50, NONE],
  ['M33', 33, 34, 36, 38, 3.5, 29.5, 54, NONE],
  ['M36', 36, 37, 39, 42, 4, 32, 58, NONE],
];

export const ISO_HOLES: HoleTable = {
  standard: 'ISO',
  rows: ISO_ROWS.map(
    ([size, d, close, normal, loose, pitch, drill, cbore, csink]): HoleSizeRow => ({
      size,
      nominal: d,
      clearance: { close, normal, loose },
      // ISO 4762: head height k max = d.
      counterbore: { diameter: cbore, depth: d },
      countersink: { diameter: csink, angle: 90 },
      tap: { drill, pitch },
    }),
  ),
};

// ---------------------------------------------------------------------------------------------
// ANSI (inch, Unified)
// ---------------------------------------------------------------------------------------------

const IN = 25.4;
const mm = (inches: number): number => Math.round(inches * IN * 1e9) / 1e9;

/**
 * size, d (in), close, free (normal), loose, threads per inch, tap drill, B18.3 counterbore Ø,
 * B18.6.3 82° head Ø — all inches.
 */
const ANSI_ROWS: readonly [
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
][] = [
  ['#0', 0.06, 0.0635, 0.07, 0.086, 80, 3 / 64, 0.125, 0.119],
  ['#1', 0.073, 0.076, 0.081, 0.096, 64, 0.0595, 0.156, 0.146],
  ['#2', 0.086, 0.089, 0.096, 0.116, 56, 0.07, 0.188, 0.172],
  ['#3', 0.099, 0.104, 0.11, 0.125, 48, 0.0785, 0.219, 0.199],
  ['#4', 0.112, 0.116, 0.1285, 0.156, 40, 0.089, 0.219, 0.225],
  ['#5', 0.125, 0.1285, 0.136, 0.172, 40, 0.1015, 0.25, 0.252],
  ['#6', 0.138, 0.144, 0.1495, 0.188, 32, 0.1065, 0.281, 0.279],
  ['#8', 0.164, 0.1695, 0.177, 0.219, 32, 0.136, 0.312, 0.332],
  ['#10', 0.19, 0.196, 0.201, 0.234, 24, 0.1495, 0.375, 0.385],
  ['#12', 0.216, 0.221, 0.228, 0.25, 24, 0.177, NONE, 0.438],
  ['1/4', 0.25, 0.257, 0.266, 0.297, 20, 0.201, 0.438, 0.507],
  ['5/16', 0.3125, 0.323, 0.332, 0.359, 18, 0.257, 0.531, 0.635],
  ['3/8', 0.375, 0.386, 0.397, 0.422, 16, 0.3125, 0.625, 0.762],
  ['7/16', 0.4375, 29 / 64, 15 / 32, 0.484, 14, 0.368, 0.719, 0.812],
  ['1/2', 0.5, 33 / 64, 17 / 32, 0.547, 13, 27 / 64, 0.812, 0.875],
  ['5/8', 0.625, 41 / 64, 21 / 32, 0.719, 11, 17 / 32, 1, 1.125],
  ['3/4', 0.75, 49 / 64, 25 / 32, 0.844, 10, 21 / 32, 1.188, 1.375],
  ['7/8', 0.875, 57 / 64, 29 / 32, 0.969, 9, 49 / 64, 1.375, NONE],
  ['1', 1, 65 / 64, 33 / 32, 1.094, 8, 7 / 8, 1.625, NONE],
];

export const ANSI_HOLES: HoleTable = {
  standard: 'ANSI',
  rows: ANSI_ROWS.map(
    ([size, d, close, normal, loose, tpi, drill, cbore, csink]): HoleSizeRow => ({
      size,
      nominal: mm(d),
      clearance: { close: mm(close), normal: mm(normal), loose: mm(loose) },
      // ASME B18.3: head height = d.
      counterbore: { diameter: available(cbore) ? mm(cbore) : NONE, depth: mm(d) },
      countersink: { diameter: available(csink) ? mm(csink) : NONE, angle: 82 },
      tap: { drill: mm(drill), pitch: mm(1 / tpi) },
    }),
  ),
};

export const HOLE_TABLES: Record<HoleStandard, HoleTable> = { ISO: ISO_HOLES, ANSI: ANSI_HOLES };

/** The table row for a size key (`"M6"`, `"#10"`, `"1/4"`), or undefined. Case and spaces ignored. */
export function holeRow(standard: HoleStandard, size: string): HoleSizeRow | undefined {
  const key = size.replace(/\s+/g, '').toUpperCase();
  return HOLE_TABLES[standard]?.rows.find((r) => r.size.toUpperCase() === key);
}
