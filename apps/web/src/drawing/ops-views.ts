/**
 * View operations of the drawing route: each is one document command (one undo step) built from
 * the current build's solved views. Placement follows the sheet's free space and the drawing's
 * projection; nothing here guesses a reference.
 */

import type {
  BaseView,
  DetailView,
  DrawingView,
  Id,
  IsoCorner,
  IsoView,
  ProjectedView,
  SectionView,
  Sheet,
  Vec2,
} from '@wren-cad/contracts';
import {
  alignedDirection,
  isoFrame,
  orientationFrame,
  projectBounds,
  SIDE_VECTORS,
  type SolvedView,
  sideFrame,
  type ViewSide,
  viewOutline,
} from '@wren-cad/drawing';
import type { DrawingController } from './controller';
import { host } from './host';
import {
  alignedDistance,
  detailScale,
  freeSpot,
  nextLetter,
  type Rect,
  ratioExpr,
  sideForDirection,
  usableArea,
} from './model';
import type { Built } from './pipeline';

type NamedBase = Extract<BaseView['orientation'], { kind: 'named' }>['name'];

function solved(c: DrawingController, id: Id): SolvedView | undefined {
  const s = c.built()?.build.views.get(id);
  return s?.ok ? s : undefined;
}

/** Outlines of the views on the sheet (sheet mm), for free-spot search. */
function takenRects(c: DrawingController, sheetId: Id): Rect[] {
  const b = c.built();
  if (!b) return [];
  const out: Rect[] = [];
  for (const v of b.drawing.views) {
    if (v.sheetId !== sheetId) continue;
    const s = b.build.views.get(v.id);
    if (s?.ok) out.push(viewOutline(s));
  }
  return out;
}

function areaOf(c: DrawingController, sheet: Sheet): Rect {
  const b = c.built() as Built;
  return usableArea(sheet.format, b.drawing.template);
}

/** Size (sheet mm) of a view of the part seen along `frame` at `scale`. */
function sizeOf(b: Built, frame: SolvedView['frame'], scale: number): { w: number; h: number } {
  const p = projectBounds(frame, b.main.shape.bounds);
  return { w: (p.max[0] - p.min[0]) * scale, h: (p.max[1] - p.min[1]) * scale };
}

export function sheetScale(c: DrawingController, sheet: Sheet): number {
  const b = c.built();
  const v = b?.evalLength(sheet.scale);
  return v !== undefined && v > 0 ? v : 1;
}

/** Adds a base view of one of the six standard orientations on the current sheet. */
export function addBaseView(c: DrawingController, name: NamedBase): Id | null {
  const b = c.built();
  const sheet = c.sheet();
  if (!b || !sheet) return null;
  const frame = orientationFrame({ kind: 'named', name });
  const scale = sheetScale(c, sheet);
  const { w, h } = sizeOf(b, frame, scale);
  const area = areaOf(c, sheet);
  const centre: Vec2 = [(area.min[0] + area.max[0]) / 2, (area.min[1] + area.max[1]) / 2];
  const at = freeSpot(takenRects(c, sheet.id), w, h, area, [centre]);
  const id = host.ulid();
  const view: BaseView = {
    id,
    sheetId: sheet.id,
    kind: 'base',
    orientation: { kind: 'named', name },
    layout: { kind: 'free', position: at },
  };
  if (!c.apply({ kind: 'addView', drawingId: b.drawing.id, view }, `Add ${name} view`)) return null;
  c.select({ kind: 'view', id });
  return id;
}

/** Adds a view of `parent` seen from `from`, aligned on the projection axis. */
export function addProjectedView(
  c: DrawingController,
  parentId: Id,
  from: ViewSide,
  dragged: number | null = null,
): Id | null {
  const b = c.built();
  const parent = solved(c, parentId);
  if (!b || !parent) return null;
  const distance = alignedDistance(
    parent,
    from,
    b.main.shape.bounds,
    b.drawing.projection,
    dragged,
  );
  const id = host.ulid();
  const view: ProjectedView = {
    id,
    sheetId: parent.view.sheetId,
    kind: 'projected',
    parentId,
    from,
    layout: { kind: 'aligned', distance },
  };
  if (!c.apply({ kind: 'addView', drawingId: b.drawing.id, view }, `Add ${from} view`)) return null;
  c.select({ kind: 'view', id });
  return id;
}

/** The standard top and side views of a base view, aligned to it. */
export function addStandardViews(c: DrawingController, parentId: Id): void {
  const b = c.built();
  const parent = solved(c, parentId);
  if (!b || !parent) return;
  const existing = new Set(
    b.drawing.views.flatMap((v) =>
      v.kind === 'projected' && v.parentId === parentId ? [v.from] : [],
    ),
  );
  const key = `views:std:${host.ulid()}`;
  // The top view goes where the projection puts it (below in first angle, above in third); the
  // side view is the one that lands to the right of the base.
  const side = sideForDirection([1, 0], b.drawing.projection);
  const list = (['top', side] as ViewSide[]).filter((s) => !existing.has(s));
  for (const from of list) {
    const distance = alignedDistance(parent, from, b.main.shape.bounds, b.drawing.projection, null);
    const view: ProjectedView = {
      id: host.ulid(),
      sheetId: parent.view.sheetId,
      kind: 'projected',
      parentId,
      from,
      layout: { kind: 'aligned', distance },
    };
    c.apply({ kind: 'addView', drawingId: b.drawing.id, view }, 'Add standard views', key);
  }
  c.commit();
}

/** An isometric view of the sheet's first base view (or `parentId`), in free space. */
export function addIsoView(
  c: DrawingController,
  parentId?: Id,
  corner: IsoCorner = 'topRight',
): Id | null {
  const b = c.built();
  const sheet = c.sheet();
  if (!b || !sheet) return null;
  const parent =
    (parentId && solved(c, parentId)) ||
    b.drawing.views
      .filter((v) => v.sheetId === sheet.id && v.kind === 'base')
      .map((v) => solved(c, v.id))
      .find(Boolean);
  if (!parent) {
    c.toast('Add a base view first: an isometric view is derived from one.', 'error');
    return null;
  }
  const id = host.ulid();
  const view: IsoView = {
    id,
    sheetId: sheet.id,
    kind: 'iso',
    parentId: parent.view.id,
    corner,
    layout: { kind: 'free', position: [0, 0] },
  };
  // Size it from the same frames the solver will use: probe with a trial placement.
  const area = areaOf(c, sheet);
  const scale = sheetScale(c, sheet);
  const trial = sizeFor(b, parent, corner, scale);
  const at = freeSpot(takenRects(c, sheet.id), trial.w, trial.h, area, [
    [area.max[0] - trial.w / 2 - 5, area.max[1] - trial.h / 2 - 5],
  ]);
  view.layout = { kind: 'free', position: at };
  if (!c.apply({ kind: 'addView', drawingId: b.drawing.id, view }, 'Add isometric view'))
    return null;
  c.select({ kind: 'view', id });
  return id;
}

function sizeFor(b: Built, parent: SolvedView, corner: IsoCorner, scale: number) {
  return sizeOf(b, isoFrame(parent.frame, corner), scale);
}

/**
 * A section of `parentId` along a cut line in the parent's view plane (part mm). The viewer
 * looks to the `look` side of the line's direction; the new view is placed beyond the part on
 * the side it looks from, in free space.
 */
export function addSection(
  c: DrawingController,
  parentId: Id,
  cut: Vec2[],
  look: 'left' | 'right' = 'left',
): Id | null {
  const b = c.built();
  const parent = solved(c, parentId);
  if (!b || !parent || cut.length < 2) return null;
  const used = b.drawing.views.flatMap((v) =>
    v.kind === 'section' || v.kind === 'detail' ? [v.letter] : [],
  );
  const id = host.ulid();
  const view: SectionView = {
    id,
    sheetId: parent.view.sheetId,
    kind: 'section',
    parentId,
    letter: nextLetter(used),
    cut: cut.map((at) => ({ kind: 'free' as const, at })),
    look,
    layout: { kind: 'free', position: [0, 0] },
  };
  const [p0, p1] = cut as [Vec2, Vec2];
  const t: Vec2 = [p1[0] - p0[0], p1[1] - p0[1]];
  const tl = Math.hypot(t[0], t[1]) || 1;
  const look2: Vec2 = look === 'left' ? [-t[1] / tl, t[0] / tl] : [t[1] / tl, -t[0] / tl];
  const side: Vec2 = [-look2[0], -look2[1]];
  const dir = alignedDirection(side, b.drawing.projection);
  const sheet = b.drawing.sheets.find((s) => s.id === parent.view.sheetId) as Sheet;
  const area = areaOf(c, sheet);
  const o = viewOutline(parent);
  const w = o.max[0] - o.min[0];
  const h = o.max[1] - o.min[1];
  const prefer: Vec2[] = [
    [parent.position[0] + dir[0] * (w + 30), parent.position[1] + dir[1] * (h + 30)],
    [parent.position[0] - dir[0] * (w + 30), parent.position[1] - dir[1] * (h + 30)],
  ];
  const at = freeSpot(takenRects(c, parent.view.sheetId), w, h, area, prefer);
  view.layout = { kind: 'free', position: at };
  if (!c.apply({ kind: 'addView', drawingId: b.drawing.id, view }, 'Add section view')) return null;
  c.select({ kind: 'view', id });
  return id;
}

/** A detail of a circle (view-plane centre and radius, part mm) of `parentId`. */
export function addDetail(
  c: DrawingController,
  parentId: Id,
  centre: Vec2,
  radius: number,
): Id | null {
  const b = c.built();
  const parent = solved(c, parentId);
  if (!b || !parent || !(radius > 0)) return null;
  const used = b.drawing.views.flatMap((v) =>
    v.kind === 'section' || v.kind === 'detail' ? [v.letter] : [],
  );
  const scale = detailScale(radius, parent.scale);
  const d = 2 * radius * scale;
  const sheet = b.drawing.sheets.find((s) => s.id === parent.view.sheetId) as Sheet;
  const area = areaOf(c, sheet);
  const o = viewOutline(parent);
  const at = freeSpot(takenRects(c, parent.view.sheetId), d, d, area, [
    [o.max[0] + d / 2 + 20, parent.position[1]],
    [parent.position[0], o.min[1] - d / 2 - 20],
  ]);
  const id = host.ulid();
  const view: DetailView = {
    id,
    sheetId: parent.view.sheetId,
    kind: 'detail',
    parentId,
    letter: nextLetter(used),
    center: { kind: 'free', at: centre },
    radius,
    scale: ratioExpr(scale),
    layout: { kind: 'free', position: at },
  };
  if (!c.apply({ kind: 'addView', drawingId: b.drawing.id, view }, 'Add detail view')) return null;
  c.select({ kind: 'view', id });
  return id;
}

/** Replaces a view (move, scale, display …); drags share `key` and are committed on release. */
export function updateView(
  c: DrawingController,
  view: DrawingView,
  label: string,
  key?: string,
): boolean {
  const b = c.built();
  if (!b) return false;
  return c.apply({ kind: 'updateView', drawingId: b.drawing.id, view }, label, key);
}

/** Deletes a view; views derived from it go too, unless `detach` keeps them as base views. */
export function removeView(
  c: DrawingController,
  id: Id,
  dependents: 'remove' | 'detach' = 'remove',
): boolean {
  const b = c.built();
  if (!b) return false;
  const ok = c.apply(
    { kind: 'removeViews', drawingId: b.drawing.id, viewIds: [id], dependents },
    'Delete view',
  );
  if (ok) c.select(null);
  return ok;
}

/** The views directly derived from `id`. */
export function childrenOf(b: Built, id: Id): DrawingView[] {
  return b.drawing.views.filter((v) => 'parentId' in v && v.parentId === id);
}

export { SIDE_VECTORS, sideFrame };
