/**
 * Builds one display list per sheet from the drawing, the solved views, the drawing worker's
 * projections and the laid-out placements: template and title block, view geometry (hatching,
 * hidden, tangent and visible lines), automatic centre marks, cutting-plane lines, detail
 * circles, view labels, annotations, sheet notes and tables. SVG, PDF and DXF all render this one
 * list. Nothing here is stored.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  AnnotationAnchor,
  CenterMark,
  Curve2,
  Drawing,
  DrawingTable,
  Id,
  ProjectedCurve,
  SheetNote,
  TitleBlockFields,
  Vec2,
  ViewProjection,
} from '@wren-cad/contracts';
import { arrowhead } from '../annotation/dimension-layout';
import type {
  DisplayItem,
  DisplayList,
  ItemSource,
  Primitive,
  StrokeRole,
} from '../annotation/display';
import { flattenPrimitive } from '../annotation/flatten';
import { add2, dist2, norm2, scale2, sub2, TAU } from '../annotation/geom';
import { formatScale } from '../annotation/numbers';
import { normalizeText, textWidth } from '../annotation/text';
import { projectCircle } from '../placement/anchors';
import type { PlacedAnnotation } from '../placement/layout';
import { generateTemplate, titleBlockGrid } from '../template';
import {
  type ResolvedSlot,
  resolveTitleBlock,
  type TitleBlockData,
  type TitleBlockResolution,
  titleBlockItems,
} from '../template/title-block';
import type { TemplateLayout } from '../template/types';
import { projectToView } from '../view/frame';
import { type SolvedView, type ViewSolution, viewOutline, viewToSheet } from '../view/solve';
import { hatchLines } from './hatch';

export interface TableData {
  header: string[];
  rows: string[][];
}

export interface SheetInput {
  drawing: Drawing;
  sheetId: Id;
  views: ReadonlyMap<Id, ViewSolution>;
  projections: ReadonlyMap<Id, ViewProjection>;
  placed: readonly PlacedAnnotation[];
  /** Title block data for this sheet (its configuration, revision, sheet n/m). */
  titleBlock: TitleBlockData;
  /** Project `drawingDefaults.fields` (the last step of the text cascade). */
  projectFields?: TitleBlockFields;
  /** Rows of tables (part properties, hole tables), resolved by the caller. */
  tables?: (table: DrawingTable) => TableData | undefined;
  /** Geometry of manual centre marks' refs, in the view's configuration. */
  centerMarkAnchors?: (mark: CenterMark) => (AnnotationAnchor | null)[];
}

export interface ComposedSheet {
  sheetId: Id;
  list: DisplayList;
  template: TemplateLayout;
  titleBlock: TitleBlockResolution;
  /** Title block slots whose text had to shrink beyond 60 % (shown as a warning). */
  overflow: string[];
  /** Problems with the sheet itself (template version newer than the app). */
  problems: string[];
}

/** Line role of a projected curve, or null when the view hides it. */
export function curveRole(c: ProjectedCurve, v: SolvedView): StrokeRole | null {
  if (c.role === 'hidden') return v.display.lines === 'visibleAndHidden' ? 'hidden' : null;
  if (c.edge === 'smooth') {
    if (v.display.tangentEdges === 'off') return null;
    return v.display.tangentEdges === 'thin' ? 'tangent' : 'visible';
  }
  return 'visible';
}

/** A projected 2D curve (view plane, part mm) on the sheet. */
export function curveToSheet(c: Curve2, v: SolvedView): Primitive {
  const pt = (p: Vec2) => viewToSheet(v, p);
  switch (c.kind) {
    case 'line':
      return { kind: 'line', a: pt(c.a), b: pt(c.b) };
    case 'arc':
      return {
        kind: 'arc',
        center: pt(c.center),
        radius: c.radius * v.scale,
        start: c.start,
        end: c.end,
      };
    case 'ellipse':
      return {
        kind: 'ellipse',
        center: pt(c.center),
        major: scale2(c.major, v.scale),
        ratio: c.ratio,
        start: c.start,
        end: c.end,
      };
    case 'bspline':
      return {
        kind: 'spline',
        degree: c.degree,
        poles: c.poles.map(pt),
        knots: c.knots,
        ...(c.weights ? { weights: c.weights } : {}),
      };
    case 'polyline':
      return { kind: 'polyline', points: c.points.map(pt) };
  }
}

function centerCross(center: Vec2, r: number, source: ItemSource): DisplayItem[] {
  const e = r + 2.5;
  return [
    {
      kind: 'line',
      a: [center[0] - e, center[1]],
      b: [center[0] + e, center[1]],
      role: 'center',
      source,
    },
    {
      kind: 'line',
      a: [center[0], center[1] - e],
      b: [center[0], center[1] + e],
      role: 'center',
      source,
    },
  ];
}

/**
 * Joins a loop's flattened pieces head to tail. The kernel lists a wire's curves in wire order, but
 * an arc or an ellipse keeps its counter-clockwise form even where the wire runs the other way, so
 * a piece may need reversing to meet the one before it.
 */
export function chainLoop(pieces: readonly Vec2[][]): Vec2[] {
  const pts = pieces.filter((p) => p.length > 0).map((p) => [...p]);
  if (pts.length === 0) return [];
  const d = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const ends = (p: Vec2[]) => [p[0] as Vec2, p[p.length - 1] as Vec2] as const;
  if (pts.length > 1) {
    // The first piece is the one with no piece before it: its start meets the last piece (the loop
    // closes) and its end meets the second. Keep the listed direction unless the other is clearly
    // better (the pieces of a half disc share both end points, so ties go to the listed one).
    const first = pts[0] as Vec2[];
    const [a0, a1] = ends(first);
    const nearest = (p: Vec2, q: Vec2[]) => Math.min(d(p, ends(q)[0]), d(p, ends(q)[1]));
    const second = pts[1] as Vec2[];
    const last = pts[pts.length - 1] as Vec2[];
    const forward = nearest(a1, second) + nearest(a0, last);
    const backward = nearest(a0, second) + nearest(a1, last);
    if (backward < forward - 1e-6) first.reverse();
  }
  const out: Vec2[] = [...(pts[0] as Vec2[])];
  for (const p of pts.slice(1)) {
    const last = out[out.length - 1] as Vec2;
    if (d(last, p[0] as Vec2) > d(last, p[p.length - 1] as Vec2)) p.reverse();
    out.push(...p.slice(1));
  }
  return out;
}

/** A view's geometry (hatching, edges, centre marks) on the sheet, from a projection. */
export function viewItems(
  v: SolvedView,
  proj: ViewProjection | undefined,
  drawing: Drawing,
): DisplayItem[] {
  const items: DisplayItem[] = [];
  if (!proj) return items;
  const vid = v.view.id;
  // Hatching first (under the edges). `sectionFaces[].face` is a synthetic id of the kernel
  // (`section:<segment>#<k>`), not a persistent name: it is never an item's `edge`, so nothing
  // can pick or dimension a hatch.
  if (v.view.kind === 'section' && proj.sectionFaces) {
    const style = { ...drawing.style.hatch, ...(v.view.hatch ?? {}) };
    for (const f of proj.sectionFaces) {
      const loops = f.loops.map((loop) =>
        chainLoop(loop.map((c) => flattenPrimitive(curveToSheet(c, v), 0.05)[0] ?? [])),
      );
      if (style.pattern === 'solid') {
        items.push({
          kind: 'fill',
          loops,
          role: 'hatch',
          source: { kind: 'view', viewId: vid },
        });
        continue;
      }
      for (const [a, b] of hatchLines(loops, style))
        items.push({
          kind: 'line',
          a,
          b,
          role: 'hatch',
          source: { kind: 'view', viewId: vid },
        });
    }
  }
  const byRole: Record<string, DisplayItem[]> = { hidden: [], tangent: [], visible: [] };
  for (const c of proj.curves) {
    const role = curveRole(c, v);
    if (!role) continue;
    const source: ItemSource = {
      kind: 'view',
      viewId: vid,
      ...(c.name ? { edge: c.name } : {}),
      ...(c.face ? { face: c.face } : {}),
    };
    byRole[role] ??= [];
    byRole[role].push({ ...curveToSheet(c.curve, v), role, source });
  }
  items.push(...(byRole.hidden ?? []), ...(byRole.tangent ?? []), ...(byRole.visible ?? []));
  // Automatic centre marks on full circles seen face-on.
  if (v.display.centerMarks) {
    for (const c of proj.curves) {
      if (c.role !== 'visible' || c.curve.kind !== 'arc') continue;
      if (Math.abs(c.curve.end - c.curve.start - TAU) > 1e-6) continue;
      const r = c.curve.radius * v.scale;
      if (r < 1.5) continue;
      items.push(
        ...centerCross(viewToSheet(v, c.curve.center), r, { kind: 'centerMark', viewId: vid }),
      );
    }
  }
  return items;
}

function viewLabel(v: SolvedView, drawing: Drawing): string | null {
  const view = v.view;
  if (view.showLabel === false) return null;
  if (view.label !== undefined) return view.label;
  const asme = drawing.standard.family === 'asme';
  if (view.kind === 'section')
    return asme ? `SECTION ${view.letter}-${view.letter}` : `${view.letter}–${view.letter}`;
  if (view.kind === 'detail') {
    const s = formatScale(v.scale);
    return asme ? `DETAIL ${view.letter} SCALE ${s}` : `${view.letter} (${s})`;
  }
  return view.showLabel ? '' : null;
}

/** The view's label (section `A–A`, detail `B (2:1)`, or the stored one), as drawn on the sheet. */
export function labelItems(v: SolvedView, drawing: Drawing): DisplayItem[] {
  const text = viewLabel(v, drawing);
  if (!text) return [];
  const o = viewOutline(v);
  const h = drawing.style.text.viewLabel;
  const asme = drawing.standard.family === 'asme';
  const at: Vec2 = [(o.min[0] + o.max[0]) / 2, asme ? o.min[1] - 2.5 * h : o.max[1] + 1.5 * h];
  return [
    {
      kind: 'text',
      at,
      text: normalizeText(text),
      height: h,
      angle: 0,
      align: 'center',
      baseline: 'baseline',
      role: 'text',
      source: { kind: 'view', viewId: v.view.id },
    },
  ];
}

/** Cutting-plane line, arrows and letters on the parent view of a section. */
export function cuttingPlaneItems(
  section: SolvedView,
  parent: SolvedView,
  drawing: Drawing,
): DisplayItem[] {
  const view = section.view;
  if (view.kind !== 'section' || !section.section) return [];
  const source: ItemSource = { kind: 'view', viewId: view.id, on: parent.view.id };
  const pts = section.section.cut.map((p) => viewToSheet(parent, projectToView(parent.frame, p)));
  if (pts.length < 2) return [];
  const items: DisplayItem[] = [{ kind: 'polyline', points: pts, role: 'cuttingPlane', source }];
  const thick = 5;
  const seg = (a: Vec2, b: Vec2): DisplayItem => {
    const d = norm2(sub2(b, a));
    return {
      kind: 'line',
      a,
      b: add2(a, scale2(d, Math.min(thick, dist2(a, b)))),
      role: 'cuttingPlaneEnd',
      source,
    };
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Vec2;
    if (i > 0) items.push(seg(p, pts[i - 1] as Vec2));
    if (i < pts.length - 1) items.push(seg(p, pts[i + 1] as Vec2));
  }
  const look3 = section.section.look;
  const look = norm2(projectToView(parent.frame, look3));
  const h = drawing.style.text.viewLabel;
  const arrowLen = 2.5 * h;
  for (const end of [pts[0] as Vec2, pts[pts.length - 1] as Vec2]) {
    const tip = add2(end, scale2(look, arrowLen));
    items.push({ kind: 'line', a: end, b: tip, role: 'dimension', source });
    for (const p of arrowhead(tip, look, {
      ...drawing.style.dimension.arrow,
      length: Math.max(3, h * 0.8),
    }))
      items.push({ ...p, role: 'dimension', source });
    items.push({
      kind: 'text',
      at: add2(tip, scale2(look, 0.9 * h)),
      text: view.letter,
      height: h,
      angle: 0,
      align: 'center',
      baseline: 'middle',
      role: 'text',
      source,
    });
  }
  return items;
}

/** A detail view's circle and letter on its parent view. */
export function detailCircleItems(
  detail: SolvedView,
  parent: SolvedView,
  drawing: Drawing,
): DisplayItem[] {
  const view = detail.view;
  if (view.kind !== 'detail' || !detail.clip) return [];
  const source: ItemSource = { kind: 'view', viewId: view.id, on: parent.view.id };
  const c = viewToSheet(parent, detail.clip.center);
  const r = detail.clip.radius * parent.scale;
  const h = drawing.style.text.viewLabel;
  const d = Math.SQRT1_2;
  return [
    { kind: 'arc', center: c, radius: r, start: 0, end: TAU, role: 'dimension', source },
    {
      kind: 'text',
      at: [c[0] + (r + h) * d, c[1] + (r + h) * d],
      text: view.letter,
      height: h,
      angle: 0,
      align: 'left',
      baseline: 'baseline',
      role: 'text',
      source,
    },
  ];
}

function manualCenterMarks(
  v: SolvedView,
  marks: CenterMark[],
  anchorsOf: SheetInput['centerMarkAnchors'],
): DisplayItem[] {
  if (!anchorsOf) return [];
  const items: DisplayItem[] = [];
  for (const m of marks) {
    const anchors = anchorsOf(m);
    const source: ItemSource = { kind: 'centerMark', viewId: v.view.id, markId: m.id };
    const circles = anchors
      .map((a) => (a?.kind === 'circle' ? projectCircle(v, a) : null))
      .filter(
        (c): c is Extract<ReturnType<typeof projectCircle>, { kind: 'faceOn' }> =>
          c?.kind === 'faceOn',
      );
    if (m.kind === 'centerMark')
      for (const c of circles) items.push(...centerCross(c.center, c.radius, source));
    if (m.kind === 'boltCircle' && circles.length >= 2) {
      const n = circles.length;
      const cx = circles.reduce((s, c) => s + c.center[0], 0) / n;
      const cy = circles.reduce((s, c) => s + c.center[1], 0) / n;
      const R = circles.reduce((s, c) => s + dist2(c.center, [cx, cy]), 0) / n;
      items.push({
        kind: 'arc',
        center: [cx, cy],
        radius: R,
        start: 0,
        end: TAU,
        role: 'center',
        source,
      });
      for (const c of circles) {
        const u = norm2(sub2(c.center, [cx, cy]));
        const e = c.radius + 2.5;
        items.push({
          kind: 'line',
          a: sub2(c.center, scale2(u, e)),
          b: add2(c.center, scale2(u, e)),
          role: 'center',
          source,
        });
      }
    }
    if (m.kind === 'centerLine') {
      const segs = anchors.flatMap((a) => (a?.kind === 'line' ? [[a.a, a.b] as const] : []));
      if (segs.length === 2) {
        const [s0, s1] = segs as [readonly [never, never], readonly [never, never]];
        const p = (x: readonly [number, number, number]) =>
          viewToSheet(v, projectToView(v.frame, [x[0], x[1], x[2]]));
        const a = scale2(add2(p(s0[0]), p(s1[0])), 0.5);
        const b = scale2(add2(p(s0[1]), p(s1[1])), 0.5);
        const u = norm2(sub2(b, a));
        items.push({
          kind: 'line',
          a: sub2(a, scale2(u, 2.5)),
          b: add2(b, scale2(u, 2.5)),
          role: 'center',
          source,
        });
      }
    }
  }
  return items;
}

/** Replaces `{slot}` tokens with the title block's resolved text (unknown tokens stay as typed). */
export function resolveTokens(text: string, slots: ReadonlyMap<string, ResolvedSlot>): string {
  return text.replace(/\{([A-Za-z]+)\}/g, (m, k: string) => {
    const s = slots.get(k as never);
    return s ? s.text : m;
  });
}

/** Greedy word wrap to `width` at height `h`. */
export function wrapText(text: string, h: number, width?: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!width) {
      out.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, h) > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

function noteItems(
  note: SheetNote,
  drawing: Drawing,
  slots: ReadonlyMap<string, ResolvedSlot>,
): DisplayItem[] {
  const h = note.height ?? drawing.style.text.note;
  const lines = wrapText(normalizeText(resolveTokens(note.text, slots)), h, note.width);
  return lines.map((t, i) => ({
    kind: 'text',
    at: [note.position[0], note.position[1] - h - i * 1.6 * h],
    text: t,
    height: h,
    angle: 0,
    align: 'left',
    baseline: 'baseline',
    role: 'text',
    source: { kind: 'note', noteId: note.id },
  }));
}

/** A table's grid and text at its anchored position. */
export function tableItems(t: DrawingTable, data: TableData, drawing: Drawing): DisplayItem[] {
  const h = drawing.style.text.note * 0.8;
  const rowH = 2 * h;
  const pad = 1.5;
  const rows = [data.header, ...data.rows];
  const ncol = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: ncol }, (_, c) =>
    Math.max(10, ...rows.map((r) => textWidth(normalizeText(r[c] ?? ''), h) + 2 * pad)),
  );
  const W = widths.reduce((s, w) => s + w, 0);
  const H = rows.length * rowH;
  const [px, py] = t.position;
  const x0 = t.anchor === 'topRight' || t.anchor === 'bottomRight' ? px - W : px;
  const y0 = t.anchor === 'topLeft' || t.anchor === 'topRight' ? py - H : py;
  const source: ItemSource = { kind: 'table', tableId: t.id };
  const items: DisplayItem[] = [
    {
      kind: 'polyline',
      closed: true,
      points: [
        [x0, y0],
        [x0 + W, y0],
        [x0 + W, y0 + H],
        [x0, y0 + H],
      ],
      role: 'thin',
      source,
    },
  ];
  for (let r = 1; r < rows.length; r++)
    items.push({
      kind: 'line',
      a: [x0, y0 + H - r * rowH],
      b: [x0 + W, y0 + H - r * rowH],
      role: 'thin',
      source,
    });
  let x = x0;
  widths.forEach((w, c) => {
    if (c > 0) items.push({ kind: 'line', a: [x, y0], b: [x, y0 + H], role: 'thin', source });
    rows.forEach((row, r) => {
      const s = normalizeText(row[c] ?? '');
      if (!s) return;
      items.push({
        kind: 'text',
        at: [x + pad, y0 + H - (r + 1) * rowH + (rowH - h) / 2],
        text: s,
        height: h,
        angle: 0,
        align: 'left',
        baseline: 'baseline',
        role: 'text',
        source,
      });
    });
    x += w;
  });
  return items;
}

/** Composes one sheet. */
export function composeSheet(input: SheetInput): ComposedSheet {
  const { drawing } = input;
  const sheet = drawing.sheets.find((s) => s.id === input.sheetId);
  if (!sheet) throw new Error(`No sheet ${input.sheetId}`);
  const problems: string[] = [];
  let tr = generateTemplate(sheet.format, drawing.template);
  if (!tr.ok) {
    problems.push(tr.message);
    tr = generateTemplate(sheet.format, { id: drawing.template.id, version: 1 });
    if (!tr.ok) throw new Error(tr.message);
  }
  const template = tr.layout;
  const titleBlock = resolveTitleBlock(template, input.titleBlock, {
    ...(sheet.fields ? { sheet: sheet.fields } : {}),
    ...(drawing.template.fields ? { drawing: drawing.template.fields } : {}),
    ...(input.projectFields ? { project: input.projectFields } : {}),
  });
  const tb = titleBlockItems(template, titleBlock);
  const items: DisplayItem[] = [
    ...template.items,
    ...titleBlockGrid(template.titleBlock),
    ...tb.items,
  ];
  // Sheet scale next to the reference graduation.
  if (template.graduation && input.titleBlock.scale !== undefined) {
    const g = template.graduation;
    items.push({
      kind: 'text',
      at: [g.end[0] - 2.5, g.end[1] + 3],
      text: formatScale(input.titleBlock.scale),
      height: 2.5,
      angle: 90,
      align: 'left',
      baseline: 'middle',
      role: 'text',
      source: { kind: 'scaleBar' },
    });
  }

  const onSheet = drawing.views.filter((v) => v.sheetId === sheet.id);
  const solved = onSheet
    .map((v) => input.views.get(v.id))
    .filter((s): s is SolvedView => !!s && s.ok);
  for (const v of solved) items.push(...viewItems(v, input.projections.get(v.view.id), drawing));
  for (const v of solved) {
    items.push(
      ...manualCenterMarks(
        v,
        drawing.centerMarks.filter((m) => m.viewId === v.view.id),
        input.centerMarkAnchors,
      ),
    );
    items.push(...labelItems(v, drawing));
  }
  // Cutting planes and detail circles on parents placed on this sheet.
  for (const child of drawing.views) {
    if (child.kind !== 'section' && child.kind !== 'detail') continue;
    const cs = input.views.get(child.id);
    const ps = input.views.get(child.parentId);
    if (!cs?.ok || !ps?.ok || ps.view.sheetId !== sheet.id) continue;
    items.push(
      ...(child.kind === 'section'
        ? cuttingPlaneItems(cs, ps, drawing)
        : detailCircleItems(cs, ps, drawing)),
    );
  }
  const viewIds = new Set(onSheet.map((v) => v.id));
  for (const p of input.placed) if (viewIds.has(p.viewId)) items.push(...p.items);
  const slots = titleBlock.slots as ReadonlyMap<string, ResolvedSlot>;
  for (const n of drawing.notes)
    if (n.sheetId === sheet.id) items.push(...noteItems(n, drawing, slots));
  for (const t of drawing.tables) {
    if (t.sheetId !== sheet.id) continue;
    const data = input.tables?.(t);
    if (data) items.push(...tableItems(t, data, drawing));
  }
  return {
    sheetId: sheet.id,
    list: { width: template.width, height: template.height, items },
    template,
    titleBlock,
    overflow: tb.overflow,
    problems,
  };
}
