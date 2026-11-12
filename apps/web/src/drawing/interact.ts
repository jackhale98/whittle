/**
 * Pointer interaction on the sheet: what a press means in each tool. Every edit is a document
 * command; drags share a coalescing key and close on release, so one drag is one undo step.
 */

import type { AnnotationPlacement, Id, PlacementLayout, Vec2 } from '@wren-cad/contracts';
import {
  alignedDirection,
  partToSheet,
  SIDE_VECTORS,
  type SolvedView,
  sheetToView,
  type ViewSide,
  viewOutline,
  viewToSheet,
} from '@wren-cad/drawing';
import {
  type HitRegion,
  type HitResult,
  hitTest,
  type SheetDrag,
  type SheetPointer,
} from '@wren-cad/ui/drawing';
import type { DrawingController } from './controller';
import { moveVertex } from './cutline';
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

export function pickAt(c: DrawingController, p: SheetPointer): HitResult | null {
  const composed = currentSheet(c);
  if (!composed) return null;
  return hitTest(composed.list, p.at, p.tol, regionsOf(c));
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
// Moving views and annotations
// ---------------------------------------------------------------------------------------------

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

/** Dragging one vertex of a section's cut line: one undo step, and Esc or a cancel restores it. */
function dragCutVertex(c: DrawingController, viewId: Id, index: number, start: Vec2): SheetDrag {
  const b = c.built();
  const view = c.view(viewId);
  if (!b || view?.kind !== 'section') return {};
  const parent = b.build.views.get(view.parentId);
  const from = view.cut[index];
  if (!parent?.ok || from?.kind !== 'free') return {};
  const key = `drag:cut:${viewId}:${index}`;
  const origin = from.at;
  return {
    move(p) {
      const cur = c.view(viewId);
      if (cur?.kind !== 'section') return;
      const d = sub(p.at, start);
      const to: Vec2 = [origin[0] + d[0] / parent.scale, origin[1] + d[1] / parent.scale];
      updateView(c, { ...cur, cut: moveVertex(cur.cut, index, to) }, 'Edit cut line', key);
    },
    up() {
      c.commit();
    },
    cancel() {
      c.cancelEdit(key);
    },
  };
}

function moveTable(c: DrawingController, id: Id, start: Vec2): SheetDrag {
  const table = c.drawing()?.tables.find((t) => t.id === id);
  if (!table) return {};
  const key = `drag:table:${id}`;
  const origin = table.position;
  return {
    move(p) {
      const cur = c.drawing()?.tables.find((t) => t.id === id);
      if (!cur) return;
      const d = sub(p.at, start);
      updateTable(c, { ...cur, position: [origin[0] + d[0], origin[1] + d[1]] }, 'Move table', key);
    },
    up() {
      c.commit();
    },
    cancel() {
      c.cancelEdit(key);
    },
  };
}

function moveView(c: DrawingController, id: Id, start: Vec2): SheetDrag {
  const view = c.view(id);
  const sv = solvedView(c, id);
  if (!view || !sv) return {};
  const key = `drag:view:${id}`;
  const origin = view.layout.kind === 'free' ? view.layout.position : null;
  const dist0 = view.layout.kind === 'aligned' ? view.layout.distance : 0;
  const parent = 'parentId' in view ? solvedView(c, view.parentId) : undefined;
  const b = c.built();
  return {
    move(p) {
      const d = sub(p.at, start);
      const cur = c.view(id);
      if (!cur || !b) return;
      if (cur.layout.kind === 'aligned' && 'from' in cur && parent) {
        const dir = alignedDirection(SIDE_VECTORS[cur.from], b.drawing.projection);
        const distance = Math.max(5, dist0 + dot(d, dir));
        updateView(c, { ...cur, layout: { kind: 'aligned', distance } }, 'Move view', key);
      } else if (origin && cur.layout.kind === 'free') {
        updateView(
          c,
          { ...cur, layout: { kind: 'free', position: [origin[0] + d[0], origin[1] + d[1]] } },
          'Move view',
          key,
        );
      }
    },
    up() {
      c.commit();
    },
    cancel() {
      c.cancelEdit(key);
    },
  };
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

function movePlacement(c: DrawingController, placementId: Id, start: Vec2): SheetDrag {
  const b = c.built();
  const pl = b?.drawing.placements.find((x) => x.id === placementId);
  if (!b || !pl) return {};
  const sv = solvedView(c, pl.viewId);
  if (!sv) return {};
  const placed = b.build.placed.find((x) => x.placementId === placementId);
  const res = b.main.resolutions.get(pl.annotationId);
  const anchor = res?.anchors?.[0];
  const circle =
    anchor?.kind === 'circle'
      ? { centre: partToSheet(sv, anchor.center), r: anchor.radius * sv.scale }
      : undefined;
  const key = `drag:placement:${placementId}`;
  const startLayout = pl.layout;
  return {
    move(p) {
      const cur = c.drawing()?.placements.find((x) => x.id === placementId);
      if (!cur) return;
      const layout = dragLayout(startLayout, start, p.at, {
        outline: viewOutline(sv),
        firstLane: b.drawing.style.dimension.firstLane,
        laneSpacing: b.drawing.style.dimension.laneSpacing,
        ...(placed?.line ? { line: placed.line } : {}),
        ...(circle ? { circle } : {}),
      });
      updatePlacement(c, { ...cur, layout } as AnnotationPlacement, 'Move annotation', key);
    },
    up() {
      c.commit();
    },
    cancel() {
      c.cancelEdit(key);
    },
  };
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
      ? cutHandlesOf(bb, sel.id).find((x) => len(sub(p.at, x.at)) < 13 * p.mm)
      : undefined;
    if (cutHandle) return dragCutVertex(c, sel.id, cutHandle.index, p.at);
    const sv = solvedView(c, sel.id);
    if (sv && sv.view.kind !== 'iso' && sv.view.kind !== 'detail') {
      const h = handlesOf(sv, p.mm).find((x) => len(sub(p.at, x.at)) < 13 * p.mm);
      if (h) return dragOut(c, sv, h);
    }
  }
  const hit = pickAt(c, p);
  if (!hit) return null;
  selectHit(c, hit);
  const s = hit.source;
  if (s.kind === 'placement') return movePlacement(c, s.placementId, p.at);
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
