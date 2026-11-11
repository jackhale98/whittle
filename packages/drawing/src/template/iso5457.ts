/**
 * ISO 5457 sheet with an ISO 7200 title block, generator version 1. Provisional (secondary
 * sources, owner D9): re-verify against ISO 5457:1999/A1:2010 and ISO 7200:2004.
 *
 *  - Frame: 20 mm filing margin on the left, 10 mm elsewhere, 0.7 mm line.
 *  - Grid reference: 50 mm fields measured from the centring marks, end fields taking the rest
 *    (A0 24×16, A1 16×12, A2 12×8, A3 8×6, A4 6×4 long × short); numbers left → right, capital
 *    letters top → bottom without I and O, in the margin on all four sides.
 *  - Centring marks: 0.7 mm, from the trimmed edge to 5 mm inside the frame, mid-side.
 *  - Trim marks: thin 10 × 5 mm corner L's.
 *  - Metric reference graduation: 100 mm in 10 mm intervals, in the filing margin, symmetric
 *    about the left centring mark.
 *  - Title block: 180 mm wide at the frame's bottom-right corner (ISO 7200 fields).
 *
 * Custom sheet sizes get the frame and title block without zones.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { TitleBlockSlot, Vec2 } from '@wren-cad/contracts';
import type { DisplayItem, StrokeRole } from '../annotation/display';
import type { Box2 } from '../annotation/geom';
import type { TemplateLayout, TitleBlockCell, ZoneAxis } from './types';

/** Zone letters without I and O (ISO 5457, ASME Y14.1). */
export const ZONE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function zoneLetter(i: number): string {
  const n = ZONE_LETTERS.length;
  return i < n
    ? (ZONE_LETTERS[i] ?? '?')
    : `${ZONE_LETTERS[Math.floor(i / n) - 1]}${ZONE_LETTERS[i % n]}`;
}

/** 50 mm fields from the centre of [lo, hi]: an even count, end fields absorb the remainder. */
export function isoFieldEdges(lo: number, hi: number, field = 50): number[] {
  const mid = (lo + hi) / 2;
  const half = Math.max(1, Math.round((hi - lo) / 2 / field));
  const edges: number[] = [lo];
  for (let k = -half + 1; k <= half - 1; k++) edges.push(mid + k * field);
  edges.push(hi);
  return edges;
}

const line = (a: Vec2, b: Vec2, role: StrokeRole): DisplayItem => ({
  kind: 'line',
  a,
  b,
  role,
  source: { kind: 'template' },
});

const text = (
  at: Vec2,
  s: string,
  height: number,
  angle = 0,
  align: 'left' | 'center' | 'right' = 'center',
): DisplayItem => ({
  kind: 'text',
  at,
  text: s,
  height,
  angle,
  align,
  baseline: 'middle',
  role: 'text',
  source: { kind: 'template' },
});

function rect(b: Box2, role: StrokeRole): DisplayItem {
  return {
    kind: 'polyline',
    closed: true,
    points: [b.min, [b.max[0], b.min[1]], b.max, [b.min[0], b.max[1]]],
    role,
    source: { kind: 'template' },
  };
}

/** Zone ticks and labels in the margin (shared by both templates). */
export function zoneItems(
  frame: Box2,
  zones: { x: ZoneAxis; y: ZoneAxis },
  sheet: { width: number; height: number },
  labelHeight: number,
): DisplayItem[] {
  const items: DisplayItem[] = [];
  const tick = 5;
  const inner = zones.x.edges.slice(1, -1);
  for (const x of inner) {
    items.push(line([x, frame.max[1]], [x, Math.min(sheet.height, frame.max[1] + tick)], 'thin'));
    items.push(line([x, frame.min[1]], [x, Math.max(0, frame.min[1] - tick)], 'thin'));
  }
  for (const y of zones.y.edges.slice(1, -1)) {
    items.push(line([frame.min[0], y], [Math.max(0, frame.min[0] - tick), y], 'thin'));
    items.push(line([frame.max[0], y], [Math.min(sheet.width, frame.max[0] + tick), y], 'thin'));
  }
  const topY = (frame.max[1] + sheet.height) / 2;
  const botY = frame.min[1] / 2;
  zones.x.labels.forEach((l, i) => {
    const cx = ((zones.x.edges[i] ?? 0) + (zones.x.edges[i + 1] ?? 0)) / 2;
    items.push(text([cx, topY], l, labelHeight), text([cx, botY], l, labelHeight));
  });
  const leftX = frame.min[0] - 5;
  const rightX = (frame.max[0] + sheet.width) / 2;
  zones.y.labels.forEach((l, i) => {
    const cy = ((zones.y.edges[i] ?? 0) + (zones.y.edges[i + 1] ?? 0)) / 2;
    items.push(text([leftX, cy], l, labelHeight), text([rightX, cy], l, labelHeight));
  });
  return items;
}

/** Title block cells relative to its bottom-left corner (x, y, w, h, slot, caption, value h). */
type CellSpec = [number, number, number, number, TitleBlockSlot, string, number];

/** ISO 7200 fields, version 1 layout: 180 × 56 mm (provisional). */
const ISO_TITLE_BLOCK_V1: { width: number; height: number; cells: CellSpec[] } = {
  width: 180,
  height: 56,
  cells: [
    [0, 0, 80, 8, 'partNumber', 'Identification number', 3.5],
    [80, 0, 20, 8, 'revision', 'Rev.', 2.5],
    [100, 0, 40, 8, 'date', 'Date of issue', 2.5],
    [140, 0, 40, 8, 'sheet', 'Sheet', 2.5],
    [0, 8, 60, 24, 'owner', 'Legal owner', 3.5],
    [60, 8, 120, 8, 'description', 'Supplementary title', 2.5],
    [60, 16, 120, 16, 'title', 'Title', 5],
    [0, 32, 45, 8, 'drawnBy', 'Created by', 2.5],
    [45, 32, 45, 8, 'checkedBy', 'Technical reference', 2.5],
    [90, 32, 45, 8, 'approvedBy', 'Approved by', 2.5],
    [135, 32, 45, 8, 'documentStatus', 'Document status', 2.5],
    [0, 40, 60, 8, 'material', 'Material', 2.5],
    [60, 40, 30, 8, 'mass', 'Mass', 2.5],
    [90, 40, 50, 8, 'configuration', 'Configuration', 2.5],
    [140, 40, 40, 8, 'documentType', 'Document type', 2.5],
    [0, 48, 20, 8, 'units', 'Units', 2.5],
    [20, 48, 20, 8, 'scale', 'Scale', 2.5],
    [40, 48, 25, 8, 'projection', 'Projection', 2.5],
    [65, 48, 40, 8, 'standard', 'Standard', 2.5],
    [105, 48, 40, 8, 'generalTolerance', 'General tolerances', 2.5],
    [145, 48, 35, 8, 'language', 'Lang.', 2.5],
  ],
};

export function titleBlockCells(
  spec: { width: number; height: number; cells: CellSpec[] },
  corner: Vec2,
): { box: Box2; cells: TitleBlockCell[] } {
  const x0 = corner[0] - spec.width;
  const y0 = corner[1];
  return {
    box: { min: [x0, y0], max: [corner[0], y0 + spec.height] },
    cells: spec.cells.map(([x, y, w, h, slot, caption, valueHeight]) => ({
      slot,
      caption,
      valueHeight,
      box: { min: [x0 + x, y0 + y], max: [x0 + x + w, y0 + y + h] },
    })),
  };
}

/** Outline (frame role) and cell borders (thin) of a title block. */
export function titleBlockGrid(tb: { box: Box2; cells: TitleBlockCell[] }): DisplayItem[] {
  const items: DisplayItem[] = tb.cells.map((c) => ({
    ...rect(c.box, 'thin'),
    source: { kind: 'titleBlock', slot: c.slot },
  }));
  items.push({ ...rect(tb.box, 'frame'), source: { kind: 'titleBlock' } });
  return items;
}

const ISO_FIELDS: Record<string, [number, number]> = {
  A0: [24, 16],
  A1: [16, 12],
  A2: [12, 8],
  A3: [8, 6],
  A4: [6, 4],
};

/** Field counts (long × short) the ISO 5457 table gives; `isoFieldEdges` reproduces them. */
export const ISO_5457_FIELD_COUNTS: Readonly<Record<string, readonly [number, number]>> =
  ISO_FIELDS;

export function iso5457v1(sheet: {
  width: number;
  height: number;
  named: boolean;
}): TemplateLayout {
  const { width: W, height: H } = sheet;
  const frame: Box2 = { min: [20, 10], max: [W - 10, H - 10] };
  const items: DisplayItem[] = [rect(frame, 'frame')];
  let zones: TemplateLayout['zones'];
  if (sheet.named) {
    const xe = isoFieldEdges(frame.min[0], frame.max[0]);
    const ye = isoFieldEdges(frame.min[1], frame.max[1]);
    const ny = ye.length - 1;
    zones = {
      x: { edges: xe, labels: xe.slice(1).map((_, i) => String(i + 1)) },
      // Letters from the top: the lowest interval gets the last letter.
      y: { edges: ye, labels: ye.slice(1).map((_, i) => zoneLetter(ny - 1 - i)) },
    };
    items.push(...zoneItems(frame, zones, sheet, 3.5));
  }
  // Centring marks.
  const cx = W / 2;
  const cy = H / 2;
  items.push(
    line([cx, 0], [cx, frame.min[1] + 5], 'frame'),
    line([cx, H], [cx, frame.max[1] - 5], 'frame'),
    line([0, cy], [frame.min[0] + 5, cy], 'frame'),
    line([W, cy], [frame.max[0] - 5, cy], 'frame'),
  );
  // Trim marks (thin corner L's, 10 × 5 mm).
  for (const [x, y, sx, sy] of [
    [0, 0, 1, 1],
    [W, 0, -1, 1],
    [W, H, -1, -1],
    [0, H, 1, -1],
  ] as const) {
    items.push({
      kind: 'polyline',
      points: [
        [x + sx * 10, y + sy * 0.5],
        [x + sx * 0.5, y + sy * 0.5],
        [x + sx * 0.5, y + sy * 10],
      ],
      role: 'thin',
      source: { kind: 'template' },
    });
  }
  // Metric reference graduation in the filing margin, centred on the left centring mark.
  const gx = 6;
  const g0: Vec2 = [gx, cy - 50];
  const g1: Vec2 = [gx, cy + 50];
  items.push({ ...line(g0, g1, 'thin'), source: { kind: 'scaleBar' } });
  for (let i = 0; i <= 10; i++) {
    const len = i % 5 === 0 ? 4 : 2.5;
    items.push({
      ...line([gx, g0[1] + 10 * i], [gx + len, g0[1] + 10 * i], 'thin'),
      source: { kind: 'scaleBar' },
    });
  }
  items.push({ ...text([gx - 2.5, cy], '100 mm', 2.5, 90), source: { kind: 'scaleBar' } });

  const titleBlock = titleBlockCells(ISO_TITLE_BLOCK_V1, [frame.max[0], frame.min[1]]);
  return {
    id: 'iso-5457',
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
