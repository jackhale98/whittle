/**
 * Pointer interaction on the sheet: what a press means in each tool. Every edit is a document
 * command; drags share a coalescing key and close on release, so one drag is one undo step.
 */

import type {
  AnnotationPlacement,
  Curve2,
  DrawingView,
  Id,
  PlacementLayout,
  Vec2,
} from '@wren-cad/contracts';
import {
  alignedDirection,
  cuttingPlaneItems,
  detailCircleItems,
  detailWithCircle,
  labelItems,
  partToSheet,
  SIDE_VECTORS,
  type SolvedView,
  sheetToView,
  type ViewSide,
  viewItems,
  viewOutline,
  viewToPart,
  viewToSheet,
} from '@wren-cad/drawing';
import { type SvgNode, svgItems } from '@wren-cad/drawing/svg';
import {
  type HitRegion,
  type HitResult,
  hitTest,
  type SheetDrag,
  type SheetPointer,
  type SheetTransient,
  type SheetTransientFrame,
  type SheetTransientSpec,
} from '@wren-cad/ui/drawing';
import type { DrawingController } from './controller';
import { moveVertex } from './cutline';
import { arcDrag, detailRadius, textDrag } from './drag-math';
import { leaderHandleDrag } from './interact-leader';
import { dominantAxis, sideForDirection } from './model';
import {
  addChamfer,
  addFinish,
  addNote,
  createDimension,
  createOrdinate,
  pickEdge,
  reattachPick,
  updatePlacement,
} from './ops-annot';
import {
  addDatumOnSize,
  addDatumOnSurface,
  addFrameOnSize,
  addFrameOnSurface,
  dimensionAt,
} from './ops-gdt';
import { updateTable } from './ops-tables';
import { addDetail, addProjectedView, addSection, updateView } from './ops-views';
import {
  cutLineNodes,
  detailGripNodes,
  selectionRect,
  textBoxOutline,
  textSideHint,
} from './overlay-nodes';
import type { Built } from './pipeline';
import type { EdgePick } from './state';

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);

export interface Handle {
  /** The side of the view it is on, as the direction it points on the sheet. */
  dir: Vec2;
  at: Vec2;
}

/** The four arrows around a selected view that drag out projected views. */
export function handlesOf(v: SolvedView, mm: number): Handle[] {
  const o = viewOutline(v);
  const cx = (o.min[0] + o.max[0]) / 2;
  const cy = (o.min[1] + o.max[1]) / 2;
  const off = 14 * mm;
  return [
    { dir: [1, 0], at: [o.max[0] + off, cy] },
    { dir: [-1, 0], at: [o.min[0] - off, cy] },
    { dir: [0, 1], at: [cx, o.max[1] + off] },
    { dir: [0, -1], at: [cx, o.min[1] - off] },
  ];
}

export function currentSheet(c: DrawingController) {
  const b = c.built();
  const id = c.sheet()?.id;
  return b && id ? b.build.sheets.find((s) => s.sheetId === id) : undefined;
}

/** Regions for picking: view outlines and title block cells. */
export function regionsOf(c: DrawingController): HitRegion[] {
  const b = c.built();
  const sheet = c.sheet();
  const composed = currentSheet(c);
  if (!b || !sheet || !composed) return [];
  const out: HitRegion[] = [];
  for (const v of b.drawing.views) {
    if (v.sheetId !== sheet.id) continue;
    const s = b.build.views.get(v.id);
    if (!s?.ok) continue;
    const o = viewOutline(s);
    out.push({ source: { kind: 'view', viewId: v.id }, min: o.min, max: o.max, rank: 2 });
  }
  for (const cell of composed.template.titleBlock.cells)
    out.push({
      source: { kind: 'titleBlock', slot: cell.slot },
      min: cell.box.min,
      max: cell.box.max,
      rank: 4,
    });
  return out;
}

/** A grip's reach in screen px: a 44 px target (22 px radius) for a finger or pen, else 13. */
export const gripReach = (p: Pick<SheetPointer, 'pointerType' | 'mm'>) =>
  (p.pointerType === 'mouse' ? 13 : 22) * p.mm;

export function pickAt(c: DrawingController, p: SheetPointer): HitResult | null {
  const composed = currentSheet(c);
  if (!composed) return null;
  // A dimension's text is a 44 px target on touch (ADR-094): it drags apart from its line.
  const textTol = p.pointerType === 'mouse' ? p.tol : 22 * p.mm;
  return hitTest(composed.list, p.at, p.tol, regionsOf(c), textTol);
}

function solvedView(c: DrawingController, id: Id): SolvedView | undefined {
  const s = c.built()?.build.views.get(id);
  return s?.ok ? s : undefined;
}

/** Selects the thing a hit refers to. */
export function selectHit(c: DrawingController, hit: HitResult | null): void {
  const s = hit?.source;
  if (!s) c.select(null);
  else if (s.kind === 'placement') c.select({ kind: 'placement', id: s.placementId });
  else if (s.kind === 'view') c.select({ kind: 'view', id: s.viewId });
  else if (s.kind === 'note') c.select({ kind: 'note', id: s.noteId });
  else if (s.kind === 'table') c.select({ kind: 'table', id: s.tableId });
  else if (s.kind === 'titleBlock' && s.slot) c.select({ kind: 'cell', slot: s.slot });
  else c.select(null);
}

// ---------------------------------------------------------------------------------------------
// Moving views and annotations (ADR-094: a drag is a preview; one commit on release)
// ---------------------------------------------------------------------------------------------

/** What a drag frame is: the preview to show, and the one edit to make if it is released here. */
export interface DragFrame {
  frame: SheetTransientFrame;
  /** The edit to commit on release; `null` when it would change nothing. */
  commit: (() => void) | null;
}

/**
 * A drag that stores nothing until it is released. The preview (`spec`: groups moved or hidden,
 * `frame`: translation and extra nodes) is drawn straight onto the sheet, once per animation
 * frame; the build is held; release makes the one edit, which is one undo step. Escape or a cancel
 * leaves nothing behind: the document was never touched.
 */
export function previewDrag(
  c: DrawingController,
  spec: SheetTransientSpec,
  at: (p: SheetPointer) => DragFrame | null,
): SheetDrag {
  let tr: SheetTransient | null = null;
  c.hold();
  const show = (p: SheetPointer): DragFrame | null => {
    const f = at(p);
    if (!f) return null;
    tr ??= c.transient(spec);
    tr.update(f.frame);
    return f;
  };
  return {
    move(p) {
      show(p);
    },
    up(p, moved) {
      const f = moved ? show(p) : null;
      if (f?.commit) {
        f.commit();
        c.commit();
        tr?.end('hold');
      } else tr?.end('cancel');
      c.resume();
    },
    cancel() {
      tr?.end('cancel');
      c.resume();
    },
  };
}

/** The views that move with `id` when it moves: its aligned descendants, transitively. */
export function dependentsOf(b: Built, id: Id): Id[] {
  const out: Id[] = [];
  const seen = new Set<Id>([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const v of b.drawing.views) {
      if (seen.has(v.id) || v.layout.kind !== 'aligned' || !('parentId' in v)) continue;
      if (!seen.has(v.parentId)) continue;
      seen.add(v.id);
      out.push(v.id);
      grew = true;
    }
  }
  return out;
}

/** The vertices of the selected section's cut line, on the parent view (sheet mm). */
export function cutHandlesOf(b: Built, viewId: Id): { index: number; at: Vec2 }[] {
  const view = b.drawing.views.find((v) => v.id === viewId);
  if (view?.kind !== 'section') return [];
  const parent = b.build.views.get(view.parentId);
  if (!parent?.ok) return [];
  return view.cut.flatMap((p, index) =>
    p.kind === 'free' ? [{ index, at: viewToSheet(parent, p.at) }] : [],
  );
}

export interface DetailGrip {
  kind: 'radius' | 'center';
  at: Vec2;
}

/**
 * The grips of a selected detail view's circle, on its parent (sheet mm): the radius handle on the
 * circle's east side, and a centre handle when the centre is a free point (one that follows a model
 * entity is edited by re-attaching, not by dragging).
 */
export function detailGripsOf(b: Built, viewId: Id): DetailGrip[] {
  const view = b.drawing.views.find((v) => v.id === viewId);
  if (view?.kind !== 'detail') return [];
  const parent = b.build.views.get(view.parentId);
  const d = b.build.views.get(viewId);
  if (!parent?.ok || !d?.ok || !d.clip) return [];
  const c = viewToSheet(parent, d.clip.center);
  const r = d.clip.radius * parent.scale;
  const out: DetailGrip[] = [{ kind: 'radius', at: [c[0] + r, c[1]] }];
  if (view.center.kind === 'free') out.push({ kind: 'center', at: c });
  return out;
}

const PREVIEW_NODE = (children: SvgNode[]): SvgNode => ({
  tag: 'g',
  attrs: { 'data-selected': 'true' },
  children,
});

/** Dragging one vertex of a section's cut line: the line follows live; the section re-cuts on release. */
function dragCutVertex(c: DrawingController, viewId: Id, index: number, start: Vec2): SheetDrag {
  const b = c.built();
  const view = c.view(viewId);
  if (!b || view?.kind !== 'section') return {};
  const parent = b.build.views.get(view.parentId);
  const from = view.cut[index];
  const sv = solvedView(c, viewId);
  if (!parent?.ok || from?.kind !== 'free' || !sv?.section) return {};
  const key = `drag:cut:${viewId}:${index}`;
  const origin = from.at;
  const section = sv.section;
  return previewDrag(
    c,
    { hide: [{ source: `view:${viewId}`, host: view.parentId }, `overlay:cut:${viewId}`] },
    (p) => {
      const d = sub(p.at, start);
      const to: Vec2 = [origin[0] + d[0] / parent.scale, origin[1] + d[1] / parent.scale];
      const cut = moveVertex(view.cut, index, to);
      // The cutting plane as it would be drawn with the vertex there (the look stays as stored).
      const cut3 = cut.flatMap((q) => (q.kind === 'free' ? [viewToPart(parent.frame, q.at)] : []));
      const items =
        cut3.length === cut.length
          ? cuttingPlaneItems({ ...sv, section: { ...section, cut: cut3 } }, parent, b.drawing)
          : [];
      const pts = cut.flatMap((q) => (q.kind === 'free' ? [viewToSheet(parent, q.at)] : []));
      return {
        frame: {
          nodes: [PREVIEW_NODE(svgItems(items, b.drawing.style))],
          overlay: cutLineNodes(pts, p.mm, 5),
        },
        commit: () => {
          const cur = c.view(viewId);
          if (cur?.kind === 'section')
            updateView(c, { ...cur, cut: moveVertex(cur.cut, index, to) }, 'Edit cut line', key);
        },
      };
    },
  );
}

function moveTable(c: DrawingController, id: Id, start: Vec2): SheetDrag {
  const table = c.drawing()?.tables.find((t) => t.id === id);
  if (!table) return {};
  const key = `drag:table:${id}`;
  const origin = table.position;
  return previewDrag(c, { move: { sources: [`table:${id}`] } }, (p) => {
    const d = sub(p.at, start);
    return {
      frame: { dx: d[0], dy: d[1] },
      commit: () => {
        const cur = c.drawing()?.tables.find((t) => t.id === id);
        if (cur)
          updateTable(
            c,
            { ...cur, position: [origin[0] + d[0], origin[1] + d[1]] },
            'Move table',
            key,
          );
      },
    };
  });
}

function moveView(c: DrawingController, id: Id, start: Vec2): SheetDrag {
  const view = c.view(id);
  const sv = solvedView(c, id);
  const b = c.built();
  if (!view || !sv || !b) return {};
  const key = `drag:view:${id}`;
  const origin = view.layout.kind === 'free' ? view.layout.position : null;
  const dist0 = view.layout.kind === 'aligned' ? view.layout.distance : 0;
  const parent = 'parentId' in view ? solvedView(c, view.parentId) : undefined;
  // Everything drawn in the moved views' space goes with them: their lines, centre marks,
  // dimensions, the cutting planes and detail circles drawn on them, and the selection handles.
  const hosts = [id, ...dependentsOf(b, id)];
  return previewDrag(c, { move: { hosts } }, (p) => {
    const d = sub(p.at, start);
    if (view.layout.kind === 'aligned' && 'from' in view && parent) {
      const dir = alignedDirection(SIDE_VECTORS[view.from], b.drawing.projection);
      const distance = Math.max(5, dist0 + dot(d, dir));
      const k = distance - dist0;
      return {
        frame: { dx: dir[0] * k, dy: dir[1] * k },
        commit: () => {
          const cur = c.view(id);
          if (cur?.layout.kind === 'aligned')
            updateView(
              c,
              { ...cur, layout: { kind: 'aligned', distance } } as DrawingView,
              'Move view',
              key,
            );
        },
      };
    }
    if (!origin || view.layout.kind !== 'free') return null;
    return {
      frame: { dx: d[0], dy: d[1] },
      commit: () => {
        const cur = c.view(id);
        if (cur?.layout.kind === 'free')
          updateView(
            c,
            { ...cur, layout: { kind: 'free', position: [origin[0] + d[0], origin[1] + d[1]] } },
            'Move view',
            key,
          );
      },
    };
  });
}

/** Whether a projected curve can be inside a circle (a cheap box test: kept if unsure). */
function nearCircle(k: Curve2, centre: Vec2, r: number): boolean {
  const pts: Vec2[] = [];
  switch (k.kind) {
    case 'line':
      pts.push(k.a, k.b);
      break;
    case 'arc':
      pts.push(
        [k.center[0] - k.radius, k.center[1] - k.radius],
        [k.center[0] + k.radius, k.center[1] + k.radius],
      );
      break;
    case 'ellipse': {
      const m = Math.hypot(k.major[0], k.major[1]);
      pts.push([k.center[0] - m, k.center[1] - m], [k.center[0] + m, k.center[1] + m]);
      break;
    }
    case 'bspline':
      pts.push(...k.poles);
      break;
    case 'polyline':
      pts.push(...k.points);
      break;
  }
  if (pts.length === 0) return true;
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  return !(
    Math.max(...xs) < centre[0] - r ||
    Math.min(...xs) > centre[0] + r ||
    Math.max(...ys) < centre[1] - r ||
    Math.min(...ys) > centre[1] + r
  );
}

/** Detail circle: radius handle or centre handle. The detail view redraws live from its parent's lines. */
function dragDetail(
  c: DrawingController,
  id: Id,
  kind: DetailGrip['kind'],
  start: SheetPointer,
): SheetDrag {
  const b = c.built();
  const view = c.view(id);
  const detail = solvedView(c, id);
  if (!b || view?.kind !== 'detail' || !detail?.clip) return {};
  const parent = solvedView(c, view.parentId);
  const parentProj = b.projections.get(view.parentId);
  if (!parent || !parentProj) return {};
  const key = `drag:detail:${id}`;
  const centre0 = detail.clip.center;
  const radius0 = detail.clip.radius;
  const sheetCentre0 = viewToSheet(parent, centre0);
  const grab = sub(start.at, sheetCentre0);
  const gripR = start.pointerType === 'mouse' ? 9 : 22;
  const clipId = `wren-detail-clip-${id}`;
  return previewDrag(
    c,
    { hide: [`view:${id}`, `overlay:detail:${id}`, `overlay:view:${id}`] },
    (p) => {
      let centre = centre0;
      let radius = radius0;
      if (kind === 'radius') radius = detailRadius(sheetCentre0, parent.scale, p.at);
      else centre = sheetToView(parent, sub(p.at, grab));
      centre = [Math.round(centre[0] * 1000) / 1000, Math.round(centre[1] * 1000) / 1000];
      const next = detailWithCircle(detail, centre, radius);
      // The parent's lines near the circle, redrawn at the detail's scale and clipped to it.
      const near = parentProj.curves.filter((k) => nearCircle(k.curve, centre, radius));
      const lines = viewItems(next, { ...parentProj, curves: near }, b.drawing);
      const o = viewOutline(next);
      const sheetCentre = viewToSheet(parent, centre);
      const nodes: SvgNode[] = [
        PREVIEW_NODE([
          {
            tag: 'clipPath',
            attrs: { id: clipId },
            children: [
              {
                tag: 'circle',
                attrs: {
                  cx: String(next.position[0]),
                  cy: String(next.position[1]),
                  r: String(radius * next.scale),
                },
              },
            ],
          },
          {
            tag: 'g',
            attrs: { 'clip-path': `url(#${clipId})` },
            children: svgItems(lines, b.drawing.style),
          },
          ...svgItems(
            [...labelItems(next, b.drawing), ...detailCircleItems(next, parent, b.drawing)],
            b.drawing.style,
          ),
        ]),
      ];
      return {
        frame: {
          nodes,
          overlay: [
            selectionRect(o.min, o.max, p.mm),
            ...detailGripNodes(
              sheetCentre,
              radius * parent.scale,
              p.mm,
              gripR,
              view.center.kind === 'free',
            ),
          ],
        },
        commit: () => {
          const cur = c.view(id);
          if (cur?.kind !== 'detail') return;
          if (kind === 'radius') updateView(c, { ...cur, radius }, 'Change detail size', key);
          else
            updateView(
              c,
              { ...cur, center: { kind: 'free', at: centre } },
              'Move detail circle',
              key,
            );
        },
      };
    },
  );
}

/** The layout a dragged placement takes when the pointer is at `p`. Exported for tests. */
export function dragLayout(
  start: PlacementLayout,
  startPointer: Vec2,
  p: Vec2,
  ctx: {
    outline: { min: Vec2; max: Vec2 };
    firstLane: number;
    laneSpacing: number;
    /** The dimension line (arrow tip to arrow tip), for offsets. */
    line?: [Vec2, Vec2];
    /** The circle's sheet centre and radius, for radial layouts. */
    circle?: { centre: Vec2; r: number };
  },
): PlacementLayout {
  switch (start.kind) {
    case 'lane': {
      const horizontal = start.side === 'top' || start.side === 'bottom';
      const o = ctx.outline;
      // The side may flip to the opposite one on the same axis, never to the other axis.
      const side: typeof start.side = horizontal
        ? p[1] < (o.min[1] + o.max[1]) / 2
          ? 'bottom'
          : 'top'
        : p[0] < (o.min[0] + o.max[0]) / 2
          ? 'left'
          : 'right';
      const d =
        side === 'bottom'
          ? o.min[1] - p[1]
          : side === 'top'
            ? p[1] - o.max[1]
            : side === 'left'
              ? o.min[0] - p[0]
              : p[0] - o.max[0];
      const lane = Math.max(0, Math.round((d - ctx.firstLane) / ctx.laneSpacing));
      return { kind: 'lane', side, lane };
    }
    case 'offset': {
      if (!ctx.line) return start;
      let d = sub(ctx.line[1], ctx.line[0]);
      const l = len(d) || 1;
      d = [d[0] / l, d[1] / l];
      if (d[0] < -1e-9 || (Math.abs(d[0]) <= 1e-9 && d[1] < 0)) d = [-d[0], -d[1]];
      const n: Vec2 = [-d[1], d[0]];
      return { kind: 'offset', distance: start.distance + dot(sub(p, startPointer), n) };
    }
    case 'radial': {
      if (!ctx.circle) return start;
      const v = sub(p, ctx.circle.centre);
      return {
        kind: 'radial',
        angle: (Math.atan2(v[1], v[0]) * 180) / Math.PI,
        distance: len(v) - ctx.circle.r,
      };
    }
    case 'leader': {
      const d = sub(p, startPointer);
      return { ...start, text: [start.text[0] + d[0], start.text[1] + d[1]] };
    }
    default:
      return start;
  }
}

function movePlacement(
  c: DrawingController,
  placementId: Id,
  start: SheetPointer,
  onText: boolean,
): SheetDrag {
  const b = c.built();
  const pl = b?.drawing.placements.find((x) => x.id === placementId);
  if (!b || !pl) return {};
  const sv = solvedView(c, pl.viewId);
  if (!sv) return {};
  const placed = b.build.placed.find((x) => x.placementId === placementId);
  const ann = (b.part.annotations ?? []).find((a) => a.id === pl.annotationId);
  const res = b.main.resolutions.get(pl.annotationId);
  const anchor = res?.anchors?.[0];
  const circle =
    anchor?.kind === 'circle'
      ? { centre: partToSheet(sv, anchor.center), r: anchor.radius * sv.scale }
      : undefined;
  const key = `drag:placement:${placementId}`;
  const startLayout = pl.layout;
  const h = b.drawing.style.text.dimension;
  const box = placed?.textBox ?? [];
  const boxCentre: Vec2 | null =
    box.length > 0
      ? [
          box.reduce((s, v) => s + v[0], 0) / box.length,
          box.reduce((s, v) => s + v[1], 0) / box.length,
        ]
      : null;
  // The text of a linear dimension drags along and across its line; anything else (the line, a
  // radial or leader dimension, an angle) drags as a whole, text and line together.
  const linearText =
    onText &&
    boxCentre !== null &&
    placed?.line !== undefined &&
    (startLayout.kind === 'lane' || startLayout.kind === 'offset') &&
    ann?.kind !== 'ordinate';
  const arc = startLayout.kind === 'arc' ? placed?.items.find((i) => i.kind === 'arc') : undefined;
  const text0 = pl.text;

  const preview = (next: AnnotationPlacement, hint: SvgNode[]): DragFrame | null => {
    const r = b.build.relayout(next);
    if (!r) return null;
    const same = JSON.stringify(next) === JSON.stringify(pl);
    return {
      frame: {
        nodes: [PREVIEW_NODE(svgItems(r.items, b.drawing.style))],
        overlay: [textBoxOutline(r.textBox, start.mm), ...hint],
      },
      commit: same
        ? null
        : () => {
            const cur = c.drawing()?.placements.find((x) => x.id === placementId);
            if (!cur) return;
            const stored = { ...cur, layout: next.layout } as AnnotationPlacement;
            if (next.text) stored.text = next.text;
            else delete stored.text;
            updatePlacement(c, stored, linearText ? 'Move dimension text' : 'Move annotation', key);
          },
    };
  };

  return previewDrag(c, { hide: [`placement:${placementId}`] }, (p) => {
    if (linearText && placed?.line && boxCentre) {
      const t = textDrag(
        { line: placed.line, shift: text0?.shift ?? 0, centre: boxCentre, h },
        start.at,
        p.at,
      );
      const text: NonNullable<AnnotationPlacement['text']> = {
        ...(t.shift !== undefined ? { shift: t.shift } : {}),
        side: t.side,
      };
      return preview({ ...pl, text }, textSideHint(placed.line, h, t.side, p.at, start.mm));
    }
    if (startLayout.kind === 'arc' && arc?.kind === 'arc' && boxCentre) {
      const a = arcDrag(
        { vertex: arc.center, radius: arc.radius, shift: text0?.shift ?? 0, centre: boxCentre },
        p.at,
        onText ? 'text' : 'arc',
      );
      const text = { ...(text0 ?? {}) };
      if (onText) {
        if (a.shift !== undefined) text.shift = a.shift;
        else delete text.shift;
      }
      const next: AnnotationPlacement = {
        ...pl,
        layout: { ...startLayout, radius: a.radius },
      };
      if (Object.keys(text).length > 0) next.text = text;
      else delete next.text;
      return preview(next, []);
    }
    const layout = dragLayout(startLayout, start.at, p.at, {
      outline: viewOutline(sv),
      firstLane: b.drawing.style.dimension.firstLane,
      laneSpacing: b.drawing.style.dimension.laneSpacing,
      ...(placed?.line ? { line: placed.line } : {}),
      ...(circle ? { circle } : {}),
    });
    return preview({ ...pl, layout } as AnnotationPlacement, []);
  });
}

/**
 * Moves the selected dimension's text one step with an arrow key (ADR-094): along its line (shift),
 * or across it (above, inline, below); a radial, leader or angle dimension's text moves as a whole.
 * Presses within a few seconds are one undo step. Reads the stored placement, so presses made
 * before the sheet has rebuilt still add up.
 */
export function nudgeText(
  c: DrawingController,
  placementId: Id,
  arrow: Vec2,
  big: boolean,
): boolean {
  const b = c.built();
  const pl = c.drawing()?.placements.find((x) => x.id === placementId);
  const placed = b?.build.placed.find((x) => x.placementId === placementId);
  const sv = pl ? solvedView(c, pl.viewId) : undefined;
  if (!b || !pl || !placed || !sv) return false;
  const key = `nudge:placement:${placementId}`;
  const step = big ? 5 : 1;
  const box = placed.textBox;
  if (box.length === 0) return false;
  const centre: Vec2 = [
    box.reduce((s, v) => s + v[0], 0) / box.length,
    box.reduce((s, v) => s + v[1], 0) / box.length,
  ];
  const ann = (b.part.annotations ?? []).find((a) => a.id === pl.annotationId);
  const shifted = (shift: number): NonNullable<AnnotationPlacement['text']> => {
    const text = { ...(pl.text ?? {}) };
    if (Math.abs(shift) < 1e-9) delete text.shift;
    else text.shift = Math.round(shift * 100) / 100;
    return text;
  };
  const put = (next: AnnotationPlacement, label: string) => updatePlacement(c, next, label, key);
  if (
    (pl.layout.kind === 'lane' || pl.layout.kind === 'offset') &&
    placed.line &&
    ann?.kind !== 'ordinate'
  ) {
    const l = sub(placed.line[1], placed.line[0]);
    const ll = len(l) || 1;
    const u: Vec2 = [l[0] / ll, l[1] / ll];
    const n: Vec2 = [-u[1], u[0]];
    const along = dot(arrow, u);
    const across = dot(arrow, n);
    if (Math.abs(along) >= Math.abs(across))
      return put(
        { ...pl, text: shifted((pl.text?.shift ?? 0) + Math.sign(along) * step) },
        'Move dimension text',
      );
    const order = ['below', 'inline', 'above'] as const;
    const cur = pl.text?.side ?? b.drawing.style.dimension.textPosition;
    const i = order.indexOf(cur === 'above' || cur === 'below' ? cur : 'inline');
    const side = order[Math.max(0, Math.min(2, i + Math.sign(across)))] as
      | 'above'
      | 'below'
      | 'inline';
    return put({ ...pl, text: { ...(pl.text ?? {}), side } }, 'Move dimension text');
  }
  if (pl.layout.kind === 'arc') {
    const arc = placed.items.find((i) => i.kind === 'arc');
    if (arc?.kind !== 'arc') return false;
    const t = sub(centre, arc.center);
    const tl = len(t) || 1;
    const tangent: Vec2 = [-t[1] / tl, t[0] / tl];
    const radial: Vec2 = [t[0] / tl, t[1] / tl];
    if (Math.abs(dot(arrow, tangent)) >= Math.abs(dot(arrow, radial)))
      return put(
        { ...pl, text: shifted((pl.text?.shift ?? 0) + Math.sign(dot(arrow, tangent)) * step) },
        'Move dimension text',
      );
    const radius = Math.max(2, pl.layout.radius + Math.sign(dot(arrow, radial)) * step);
    return put({ ...pl, layout: { ...pl.layout, radius } }, 'Move annotation');
  }
  const layout = dragLayout(
    pl.layout,
    centre,
    [centre[0] + arrow[0] * step, centre[1] + arrow[1] * step],
    {
      outline: viewOutline(sv),
      firstLane: b.drawing.style.dimension.firstLane,
      laneSpacing: b.drawing.style.dimension.laneSpacing,
      ...(placed.line ? { line: placed.line } : {}),
    },
  );
  if (JSON.stringify(layout) === JSON.stringify(pl.layout)) return false;
  return put({ ...pl, layout } as AnnotationPlacement, 'Move annotation');
}

// ---------------------------------------------------------------------------------------------
// Dragging a projected view out of its parent
// ---------------------------------------------------------------------------------------------

function dragOut(c: DrawingController, parent: SolvedView, handle: Handle): SheetDrag {
  const b = c.built();
  if (!b) return {};
  return {
    move(p) {
      const d = sub(p.at, parent.position);
      const along = Math.max(0, dot(d, handle.dir));
      const o = viewOutline(parent);
      const w = o.max[0] - o.min[0];
      const h = o.max[1] - o.min[1];
      c.patch({
        ghost: {
          kind: 'rect',
          min: [
            parent.position[0] + handle.dir[0] * along - w / 2,
            parent.position[1] + handle.dir[1] * along - h / 2,
          ],
          max: [
            parent.position[0] + handle.dir[0] * along + w / 2,
            parent.position[1] + handle.dir[1] * along + h / 2,
          ],
        },
      });
    },
    up(p) {
      c.patch({ ghost: null });
      const d = sub(p.at, parent.position);
      const along = dot(d, handle.dir);
      const side: ViewSide = sideForDirection(handle.dir, b.drawing.projection);
      const exists = b.drawing.views.some(
        (v) => v.kind === 'projected' && v.parentId === parent.view.id && v.from === side,
      );
      if (exists) {
        c.toast(`There is already a ${side} view of this one.`, 'error');
        return;
      }
      addProjectedView(c, parent.view.id, side, along > 0 ? along : null);
    },
    cancel() {
      c.patch({ ghost: null });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

function viewOf(hit: HitResult | null): Id | null {
  return hit?.source.kind === 'view' ? hit.source.viewId : null;
}

/** The view under a point even when it is only inside its outline. */
function viewUnder(c: DrawingController, p: SheetPointer): SolvedView | undefined {
  const hit = pickAt(c, p);
  const id = viewOf(hit);
  return id ? solvedView(c, id) : undefined;
}

function sectionTool(c: DrawingController, p: SheetPointer): SheetDrag | null {
  const parent = viewUnder(c, p);
  if (!parent || parent.view.kind === 'detail') return null;
  const a = p.at;
  return {
    move(q) {
      c.patch({ ghost: { kind: 'line', a, b: q.at } });
    },
    up(q) {
      c.patch({ ghost: null });
      if (len(sub(q.at, a)) < 6) {
        c.patch({ hint: { text: 'Drag across the view to draw the cut line', picks: [] } });
        return;
      }
      const cut: Vec2[] = [sheetToView(parent, a), sheetToView(parent, q.at)];
      c.setTool('select');
      addSection(c, parent.view.id, cut, 'left');
    },
    cancel() {
      c.patch({ ghost: null });
    },
  };
}

function detailTool(c: DrawingController, p: SheetPointer): SheetDrag | null {
  const parent = viewUnder(c, p);
  if (!parent || parent.view.kind === 'detail') return null;
  const centre = p.at;
  return {
    move(q) {
      c.patch({ ghost: { kind: 'circle', at: centre, r: len(sub(q.at, centre)) } });
    },
    up(q) {
      c.patch({ ghost: null });
      const r = len(sub(q.at, centre));
      if (r < 2) {
        c.patch({ hint: { text: 'Drag out a circle around the detail', picks: [] } });
        return;
      }
      c.setTool('select');
      addDetail(c, parent.view.id, sheetToView(parent, centre), r / parent.scale);
    },
    cancel() {
      c.patch({ ghost: null });
    },
  };
}

/**
 * What a picking tool (Dimension, Angle, Chamfer, datums, frames...) picks at `p`: model geometry
 * only. Those tools pick edges and outlines, never an annotation, so a dimension drawn over an edge
 * (an extension line along a fillet, say) does not hide that edge from them.
 */
export function viewHit(c: DrawingController, p: Pick<SheetPointer, 'at' | 'tol'>) {
  const composed = currentSheet(c);
  if (!composed) return null;
  const items = composed.list.items.filter((i) => i.source?.kind === 'view');
  return hitTest({ ...composed.list, items }, p.at, p.tol);
}

function edgeAt(c: DrawingController, p: SheetPointer): EdgePick | null {
  const hit = viewHit(c, p);
  if (hit?.source.kind !== 'view') return null;
  if (hit.source.edge) return pickEdge(c, hit.source.viewId, hit.source.edge, p.at);
  // An outline has no edge name: with its face (`ProjectedCurve.face`) it picks that face.
  if (hit.source.face) return pickEdge(c, hit.source.viewId, hit.source.face, p.at, 'face');
  return null;
}

function pickTool(c: DrawingController, _p: SheetPointer): SheetDrag {
  const tool = c.ui.get().tool;
  return {
    up(q, moved) {
      if (moved) return;
      // Datums and frames: a size dimension under the pointer means its feature of size.
      if (tool === 'datum' || tool === 'gdt') {
        const size = dimensionAt(c, q);
        if (size) {
          if (tool === 'datum') void addDatumOnSize(c, size);
          else addFrameOnSize(c, size);
          return;
        }
      }
      const pick = edgeAt(c, q);
      if (!pick) {
        c.patch({
          hint: {
            text:
              pick === null && tool === 'dimension'
                ? 'Pick an edge on a view'
                : 'Pick an edge on a view',
            picks: [],
          },
        });
        return;
      }
      void onPick(c, tool, pick, q.alt || q.shift);
    },
  };
}

async function onPick(
  c: DrawingController,
  tool: ReturnType<DrawingController['ui']['get']>['tool'],
  pick: EdgePick,
  alt: boolean,
): Promise<void> {
  switch (tool) {
    case 'dimension': {
      const prev = c.ui.get().hint?.picks ?? [];
      if (prev.length === 0) {
        if (pick.shape === 'circle') {
          await createDimension(c, [pick], alt);
          return;
        }
        if (pick.shape === 'other') {
          c.toast('That edge is curved: pick a straight edge or a circle.', 'error');
          return;
        }
        c.patch({
          hint: {
            text: 'Pick a second edge, or the same edge again for its length',
            picks: [pick],
          },
        });
        return;
      }
      const first = prev[0] as EdgePick;
      // Two picks of one face's outline are its two sides (a diameter), not one edge's length.
      const same =
        first.name === pick.name &&
        first.viewId === pick.viewId &&
        first.ref !== 'face' &&
        pick.ref !== 'face';
      c.patch({ hint: null });
      await createDimension(c, same ? [first] : [first, pick]);
      return;
    }
    case 'angle': {
      const prev = c.ui.get().hint?.picks ?? [];
      const first = prev[0];
      if (!first) {
        if (pick.shape !== 'line') {
          c.toast('An angle is between two straight edges: pick a straight edge.', 'error');
          return;
        }
        c.patch({ hint: { text: 'Pick the second edge', picks: [pick] } });
        return;
      }
      if (pick.shape !== 'line') {
        c.toast('An angle is between two straight edges: pick a straight edge.', 'error');
        return;
      }
      c.patch({ hint: null });
      await createDimension(c, [first, pick]);
      return;
    }
    case 'ordinate': {
      const origin = c.ui.get().hint?.picks[0];
      if (!origin) {
        if (pick.shape === 'other') {
          c.toast('Pick a straight edge or a circle for the origin.', 'error');
          return;
        }
        c.patch({
          hint: { text: 'Pick a feature to read from this origin; Esc finishes', picks: [pick] },
        });
        return;
      }
      if (pick.viewId !== origin.viewId) {
        c.toast('The features must be on the same view as the origin.', 'error');
        return;
      }
      if (pick.name === origin.name) {
        c.toast('That is the origin: pick a feature to measure from it.', 'error');
        return;
      }
      if (pick.shape === 'other') {
        c.toast('Pick a straight edge or a circle.', 'error');
        return;
      }
      // The origin stays picked: each further pick adds another coordinate to the group.
      await createOrdinate(c, [origin, pick]);
      c.patch({
        hint: { text: 'Pick the next feature, or Esc to finish', picks: [origin] },
      });
      return;
    }
    case 'chamfer':
      await addChamfer(c, pick);
      return;
    case 'datum':
      await addDatumOnSurface(c, pick);
      return;
    case 'gdt':
      await addFrameOnSurface(c, pick);
      return;
    case 'finish':
      await addFinish(c, pick);
      return;
    case 'note':
      await addNote(c, pick);
      return;
    case 'reattach':
      await reattachPick(c, pick);
      return;
    default:
      return;
  }
}

/** What a press on the sheet starts, by tool. `null` lets the viewer pan. */
export function beginInteraction(c: DrawingController, p: SheetPointer): SheetDrag | null {
  const tool = c.ui.get().tool;
  if (c.ui.get().editingCell) c.patch({ editingCell: null });
  switch (tool) {
    case 'section':
      return sectionTool(c, p);
    case 'detail':
      return detailTool(c, p);
    case 'dimension':
    case 'angle':
    case 'ordinate':
    case 'chamfer':
    case 'datum':
    case 'gdt':
    case 'finish':
    case 'note':
    case 'reattach':
      return pickTool(c, p);
    default:
      break;
  }

  // Select: the handles of the selected view or leader first, then what is under the pointer.
  const sel = c.ui.get().selected;
  if (sel?.kind === 'placement') {
    const lh = leaderHandleDrag(c, sel.id, p);
    if (lh) return lh;
  }
  if (sel?.kind === 'view') {
    const bb = c.built();
    const cutHandle = bb
      ? cutHandlesOf(bb, sel.id).find((x) => len(sub(p.at, x.at)) < gripReach(p))
      : undefined;
    if (cutHandle) return dragCutVertex(c, sel.id, cutHandle.index, p.at);
    const grip = bb
      ? detailGripsOf(bb, sel.id)
          .map((g) => ({ g, d: len(sub(p.at, g.at)) }))
          .filter((x) => x.d < gripReach(p))
          .sort((x, y) => x.d - y.d)[0]
      : undefined;
    if (grip) return dragDetail(c, sel.id, grip.g.kind, p);
    const sv = solvedView(c, sel.id);
    if (sv && sv.view.kind !== 'iso' && sv.view.kind !== 'detail') {
      const h = handlesOf(sv, p.mm).find((x) => len(sub(p.at, x.at)) < gripReach(p));
      if (h) return dragOut(c, sv, h);
    }
  }
  const hit = pickAt(c, p);
  if (!hit) return null;
  selectHit(c, hit);
  const s = hit.source;
  if (s.kind === 'placement') return movePlacement(c, s.placementId, p, hit.itemKind === 'text');
  if (s.kind === 'view') return moveView(c, s.viewId, p.at);
  if (s.kind === 'table') return moveTable(c, s.tableId, p.at);
  if (s.kind === 'titleBlock' && s.slot) {
    const slot = s.slot;
    return {
      up(_q, moved) {
        if (!moved) c.patch({ editingCell: slot });
      },
    };
  }
  return {};
}

export { dominantAxis };
