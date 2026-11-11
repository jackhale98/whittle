/**
 * What occupies a sheet besides annotations, as simple shapes: view outlines and labels, cutting
 * planes and detail circles on their parents, the title block, tables and the drawing frame. The
 * import planner keeps lane bands clear of them, and tests check laid-out annotations against
 * them. Shapes come from the same display items the sheet draws (`compose.ts`), so they cannot
 * drift from what is rendered.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Drawing, DrawingTable, Id, Vec2 } from '@wren-cad/contracts';
import type { Primitive } from '../annotation/display';
import { type Box2, boxOf, rotate2 } from '../annotation/geom';
import { textWidth } from '../annotation/text';
import { generateTemplate } from '../template';
import { type SolvedView, type ViewSolution, viewOutline } from '../view/solve';
import {
  cuttingPlaneItems,
  detailCircleItems,
  labelItems,
  type TableData,
  tableItems,
} from './compose';

/** A box, or a segment (cut lines: a diagonal line's box would block far more than the line). */
export type Shape = { kind: 'box'; box: Box2 } | { kind: 'segment'; a: Vec2; b: Vec2 };

export type ObstacleKind =
  | 'view'
  | 'viewLabel'
  | 'cutLine'
  | 'detailCircle'
  | 'titleBlock'
  | 'table';

export interface SheetObstacle {
  kind: ObstacleKind;
  shape: Shape;
  /** The view the obstacle moves with (its outline, label, or a cut line drawn on it). */
  viewId?: Id;
}

export interface SheetObstacles {
  /** The drawing frame: everything must stay inside it. */
  frame: Box2;
  titleBlock: Box2;
  obstacles: SheetObstacle[];
}

/** Bounding box of a text item (cap height plus a descender allowance). */
export function textBox(p: Extract<Primitive, { kind: 'text' }>): Box2 {
  const w = textWidth(p.text, p.height);
  const h = p.height;
  const x0 = p.align === 'left' ? 0 : p.align === 'center' ? -w / 2 : -w;
  const y0 = p.baseline === 'baseline' ? -0.25 * h : p.baseline === 'middle' ? -0.5 * h : -h;
  const y1 = p.baseline === 'baseline' ? h : p.baseline === 'middle' ? 0.5 * h : 0;
  const a = (p.angle * Math.PI) / 180;
  const corners: Vec2[] = [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y1],
    [x0, y1],
  ].map((c) => {
    const r = rotate2(c as Vec2, a);
    return [p.at[0] + r[0], p.at[1] + r[1]] as Vec2;
  });
  return boxOf(corners) as Box2;
}

/** Bounding box of one primitive (arcs: their whole circle, conservatively). */
export function primitiveBox(p: Primitive): Box2 | null {
  switch (p.kind) {
    case 'line':
      return boxOf([p.a, p.b]);
    case 'polyline':
      return boxOf(p.points);
    case 'arc':
      return {
        min: [p.center[0] - p.radius, p.center[1] - p.radius],
        max: [p.center[0] + p.radius, p.center[1] + p.radius],
      };
    case 'ellipse': {
      const r = Math.hypot(p.major[0], p.major[1]);
      return { min: [p.center[0] - r, p.center[1] - r], max: [p.center[0] + r, p.center[1] + r] };
    }
    case 'spline':
      return boxOf(p.poles);
    case 'fill':
      return boxOf(p.loops.flat());
    case 'text':
      return textBox(p);
  }
}

/** Shapes of one primitive: segments for lines and polylines, a box for everything else. */
export function primitiveShapes(p: Primitive): Shape[] {
  if (p.kind === 'line') return [{ kind: 'segment', a: p.a, b: p.b }];
  if (p.kind === 'polyline') {
    const out: Shape[] = [];
    const n = p.points.length;
    for (let i = 0; i + 1 < n; i++)
      out.push({ kind: 'segment', a: p.points[i] as Vec2, b: p.points[i + 1] as Vec2 });
    if (p.closed && n > 2)
      out.push({ kind: 'segment', a: p.points[n - 1] as Vec2, b: p.points[0] as Vec2 });
    return out;
  }
  const b = primitiveBox(p);
  return b ? [{ kind: 'box', box: b }] : [];
}

/** True when the boxes overlap by more than `eps` (touching does not count). */
export function boxesOverlap(a: Box2, b: Box2, eps = 1e-6): boolean {
  return (
    a.min[0] < b.max[0] - eps &&
    b.min[0] < a.max[0] - eps &&
    a.min[1] < b.max[1] - eps &&
    b.min[1] < a.max[1] - eps
  );
}

/** True when segment ab passes through the inside of `box` (Liang–Barsky clip). */
export function segmentHitsBox(a: Vec2, b: Vec2, box: Box2, eps = 1e-6): boolean {
  const lo: Vec2 = [box.min[0] + eps, box.min[1] + eps];
  const hi: Vec2 = [box.max[0] - eps, box.max[1] - eps];
  if (lo[0] > hi[0] || lo[1] > hi[1]) return false;
  let t0 = 0;
  let t1 = 1;
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  for (let k = 0; k < 2; k++) {
    const dk = d[k] as number;
    const ak = a[k] as number;
    if (Math.abs(dk) < 1e-15) {
      if (ak <= (lo[k] as number) || ak >= (hi[k] as number)) return false;
      continue;
    }
    let ta = ((lo[k] as number) - ak) / dk;
    let tb = ((hi[k] as number) - ak) / dk;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 >= t1) return false;
  }
  return true;
}

export function shapeHitsBox(s: Shape, box: Box2, eps = 1e-6): boolean {
  return s.kind === 'box' ? boxesOverlap(s.box, box, eps) : segmentHitsBox(s.a, s.b, box, eps);
}

/** A solved view with its outline grown by `growth` (0.1 = 10 %) about its centre. */
export function grownView(v: SolvedView, growth: number): SolvedView {
  if (!growth) return v;
  const k = 1 + growth;
  const c = v.center;
  const g = (p: Vec2): Vec2 => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k];
  return { ...v, bounds: { min: g(v.bounds.min), max: g(v.bounds.max) } };
}

export interface SheetObstaclesInput {
  drawing: Drawing;
  sheetId: Id;
  views: ReadonlyMap<Id, ViewSolution>;
  /** Table rows (as `SheetInput.tables`); a table without data is left out. */
  tables?: (table: DrawingTable) => TableData | undefined;
  /** Grow every view's outline (and so its label) by this fraction; default 0. */
  growth?: number;
}

/** Everything on a sheet that annotations must keep clear of. */
export function sheetObstacles(input: SheetObstaclesInput): SheetObstacles {
  const { drawing, sheetId } = input;
  const sheet = drawing.sheets.find((s) => s.id === sheetId);
  let tr = sheet ? generateTemplate(sheet.format, drawing.template) : null;
  if (sheet && tr && !tr.ok)
    tr = generateTemplate(sheet.format, { id: drawing.template.id, version: 1 });
  const layout = tr?.ok ? tr.layout : null;
  const frame: Box2 = layout?.frame ?? {
    min: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
    max: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  };
  const titleBlock: Box2 = layout?.titleBlock.box ?? { min: [0, 0], max: [0, 0] };
  const obstacles: SheetObstacle[] = [];
  if (layout) obstacles.push({ kind: 'titleBlock', shape: { kind: 'box', box: titleBlock } });
  const growth = input.growth ?? 0;
  const solved = new Map<Id, SolvedView>();
  for (const [id, s] of input.views) if (s.ok) solved.set(id, grownView(s, growth));
  for (const v of drawing.views) {
    const s = solved.get(v.id);
    if (!s || v.sheetId !== sheetId) continue;
    obstacles.push({ kind: 'view', viewId: v.id, shape: { kind: 'box', box: viewOutline(s) } });
    for (const it of labelItems(s, drawing))
      for (const shape of primitiveShapes(it))
        obstacles.push({ kind: 'viewLabel', viewId: v.id, shape });
  }
  for (const child of drawing.views) {
    if (child.kind !== 'section' && child.kind !== 'detail') continue;
    const cs = solved.get(child.id);
    const ps = solved.get(child.parentId);
    if (!cs || !ps || ps.view.sheetId !== sheetId) continue;
    const items =
      child.kind === 'section'
        ? cuttingPlaneItems(cs, ps, drawing)
        : detailCircleItems(cs, ps, drawing);
    const kind: ObstacleKind = child.kind === 'section' ? 'cutLine' : 'detailCircle';
    for (const it of items)
      for (const shape of primitiveShapes(it)) obstacles.push({ kind, viewId: ps.view.id, shape });
  }
  for (const t of drawing.tables) {
    if (t.sheetId !== sheetId) continue;
    const data = input.tables?.(t);
    if (!data) continue;
    const box = boxOf(tableItems(t, data, drawing).flatMap((it) => primitiveBoxPoints(it)));
    if (box) obstacles.push({ kind: 'table', shape: { kind: 'box', box } });
  }
  return { frame, titleBlock, obstacles };
}

function primitiveBoxPoints(p: Primitive): Vec2[] {
  const b = primitiveBox(p);
  return b ? [b.min, b.max] : [];
}
