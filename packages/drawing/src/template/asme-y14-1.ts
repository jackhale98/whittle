/**
 * ASME Y14.1 sheet, generator version 1 (ANSI A–E). Provisional (secondary sources, owner D9):
 * re-verify against ASME Y14.1-2020.
 *
 *  - Border margins: A and B 0.38 in left/right, 0.25 in top/bottom; C, D and E 0.5 in.
 *  - Zones: equal divisions, numbered right → left from the lower-right corner and lettered
 *    bottom → top (without I and O): A 2×2, B 4×2, C 6×4, D 8×4, E 10×6 (long × short).
 *  - Centring marks at mid-side; a 100 mm graduation in the left margin (the PDF scale check;
 *    not a Y14.1 requirement).
 *  - Title block 170 mm wide at the border's lower-right corner.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { TitleBlockSlot, Vec2 } from '@wren-cad/contracts';
import type { DisplayItem } from '../annotation/display';
import type { Box2 } from '../annotation/geom';
import { titleBlockCells, zoneItems, zoneLetter } from './iso5457';
import type { TemplateLayout } from './types';

const IN = 25.4;

/** Zone counts, long side × short side (provisional). */
export const ASME_ZONE_COUNTS: Readonly<Record<string, readonly [number, number]>> = {
  'ANSI-A': [2, 2],
  'ANSI-B': [4, 2],
  'ANSI-C': [6, 4],
  'ANSI-D': [8, 4],
  'ANSI-E': [10, 6],
};

type CellSpec = [number, number, number, number, TitleBlockSlot, string, number];

const ASME_TITLE_BLOCK_V1: { width: number; height: number; cells: CellSpec[] } = {
  width: 170,
  height: 60,
  cells: [
    [0, 0, 45, 8, 'scale', 'SCALE', 2.5],
    [45, 0, 45, 8, 'mass', 'WEIGHT', 2.5],
    [90, 0, 40, 8, 'sheet', 'SHEET', 2.5],
    [130, 0, 40, 8, 'date', 'DATE', 2.5],
    [0, 8, 25, 12, 'projection', 'PROJECTION', 2.5],
    [25, 8, 20, 12, 'units', 'UNITS', 2.5],
    [45, 8, 95, 12, 'partNumber', 'DWG NO.', 5],
    [140, 8, 30, 12, 'revision', 'REV', 3.5],
    [0, 20, 45, 16, 'owner', 'COMPANY', 3],
    [45, 20, 125, 16, 'title', 'TITLE', 5],
    [0, 36, 45, 8, 'drawnBy', 'DRAWN', 2.5],
    [45, 36, 45, 8, 'checkedBy', 'CHECKED', 2.5],
    [90, 36, 40, 8, 'approvedBy', 'APPROVED', 2.5],
    [130, 36, 40, 8, 'documentStatus', 'STATUS', 2.5],
    [0, 44, 60, 8, 'material', 'MATERIAL', 2.5],
    [60, 44, 110, 8, 'description', 'DESCRIPTION', 2.5],
    [0, 52, 60, 8, 'generalTolerance', 'UNLESS OTHERWISE SPECIFIED', 2.5],
    [60, 52, 50, 8, 'standard', 'INTERPRET PER', 2.5],
    [110, 52, 35, 8, 'configuration', 'CONFIGURATION', 2.5],
    [145, 52, 25, 8, 'documentType', 'TYPE', 2.5],
  ],
};

function equalEdges(lo: number, hi: number, n: number): number[] {
  return Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
}

export function asmeY141v1(sheet: {
  width: number;
  height: number;
  named: boolean;
  sizeKey?: string;
}): TemplateLayout {
  const { width: W, height: H } = sheet;
  const small = sheet.sizeKey === 'ANSI-A' || sheet.sizeKey === 'ANSI-B';
  const side = small ? 0.38 * IN : 0.5 * IN;
  const tb = small ? 0.25 * IN : 0.5 * IN;
  const landscape = W >= H;
  const mx = landscape ? side : tb;
  const my = landscape ? tb : side;
  const frame: Box2 = { min: [mx, my], max: [W - mx, H - my] };
  const items: DisplayItem[] = [
    {
      kind: 'polyline',
      closed: true,
      points: [frame.min, [frame.max[0], frame.min[1]], frame.max, [frame.min[0], frame.max[1]]],
      role: 'frame',
      source: { kind: 'template' },
    },
  ];
  let zones: TemplateLayout['zones'];
  const counts = sheet.sizeKey ? ASME_ZONE_COUNTS[sheet.sizeKey] : undefined;
  if (sheet.named && counts) {
    const [nl, ns] = counts;
    const nx = landscape ? nl : ns;
    const ny = landscape ? ns : nl;
    const xe = equalEdges(frame.min[0], frame.max[0], nx);
    const ye = equalEdges(frame.min[1], frame.max[1], ny);
    zones = {
      // Numbers right → left: the leftmost interval has the highest number.
      x: { edges: xe, labels: xe.slice(1).map((_, i) => String(nx - i)) },
      // Letters bottom → top.
      y: { edges: ye, labels: ye.slice(1).map((_, i) => zoneLetter(i)) },
    };
    items.push(...zoneItems(frame, zones, sheet, 3));
  }
  const cx = W / 2;
  const cy = H / 2;
  const mark = (a: Vec2, b: Vec2): DisplayItem => ({
    kind: 'line',
    a,
    b,
    role: 'frame',
    source: { kind: 'template' },
  });
  items.push(
    mark([cx, 0], [cx, frame.min[1]]),
    mark([cx, H], [cx, frame.max[1]]),
    mark([0, cy], [frame.min[0], cy]),
    mark([W, cy], [frame.max[0], cy]),
  );
  // 100 mm graduation in the left margin (inside the margin width).
  // Clear of the zone letters (centred 5 mm outside the border).
  const gx = small ? 1.2 : 2;
  const g0: Vec2 = [gx, cy - 50];
  const g1: Vec2 = [gx, cy + 50];
  items.push({ kind: 'line', a: g0, b: g1, role: 'thin', source: { kind: 'scaleBar' } });
  for (let i = 0; i <= 10; i++) {
    const len = (i % 5 === 0 ? 2 : 1.2) * (small ? 1 : 1.5);
    items.push({
      kind: 'line',
      a: [gx, g0[1] + 10 * i],
      b: [gx + len, g0[1] + 10 * i],
      role: 'thin',
      source: { kind: 'scaleBar' },
    });
  }
  const titleBlock = titleBlockCells(ASME_TITLE_BLOCK_V1, [frame.max[0], frame.min[1]]);
  return {
    id: 'asme-y14.1',
    version: 1,
    width: W,
    height: H,
    frame,
    ...(zones ? { zones } : {}),
    items,
    titleBlock,
    graduation: { start: g0, end: g1 },
  };
}
