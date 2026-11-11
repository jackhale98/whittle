/**
 * Sheet sizes (trimmed), mm. ISO 216 A0–A4 (ISO 5457) and ANSI A–E (ASME Y14.1, inch sizes
 * converted exactly: 1 in = 25.4 mm).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { AnsiSheetSize, IsoSheetSize, SheetFormat } from '@wren-cad/contracts';

/** Short side × long side, mm. */
export const SHEET_SIZES: Readonly<
  Record<IsoSheetSize | AnsiSheetSize, readonly [number, number]>
> = {
  A0: [841, 1189],
  A1: [594, 841],
  A2: [420, 594],
  A3: [297, 420],
  A4: [210, 297],
  'ANSI-A': [215.9, 279.4],
  'ANSI-B': [279.4, 431.8],
  'ANSI-C': [431.8, 558.8],
  'ANSI-D': [558.8, 863.6],
  'ANSI-E': [863.6, 1117.6],
};

export function isIsoSize(size: SheetFormat['size']): size is IsoSheetSize {
  return typeof size === 'string' && size.startsWith('A') && !size.startsWith('ANSI');
}

export function isAnsiSize(size: SheetFormat['size']): size is AnsiSheetSize {
  return typeof size === 'string' && size.startsWith('ANSI');
}

/** Width × height of the trimmed sheet as oriented, mm. */
export function sheetDimensions(format: SheetFormat): { width: number; height: number } {
  if (typeof format.size === 'object') {
    const { width, height } = format.size;
    // A custom size is taken as given; orientation swaps only when it disagrees.
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    return format.orientation === 'landscape'
      ? { width: long, height: short }
      : { width: short, height: long };
  }
  const [short, long] = SHEET_SIZES[format.size];
  return format.orientation === 'landscape'
    ? { width: long, height: short }
    : { width: short, height: long };
}
