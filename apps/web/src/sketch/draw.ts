/**
 * Sketch drawing state machine (PLAN §2.1, §9.2): click-click drawing with a rubber-band preview,
 * live constraint inference and snapping. Pure functions over plain data so the whole flow is
 * unit-testable without a viewport or solver. The host feeds cursor positions in sketch space
 * (`screenToPlane`) and applies the returned edits to the document, then solves.
 */

import type {
  GeometricConstraintDraft,
  Id,
  InferenceCandidate,
  SketchConstraint,
  SketchEntity,
  SketchEntityKind,
  SketchSolveInput,
  Vec2,
} from '@wren-cad/contracts';
import { INFERENCE_CURSOR, INFERENCE_DRAWING } from '@wren-cad/contracts';
import {
  AlignmentClasses,
  arc3PointTool,
  arcCenterTool,
  arcTangentTool,
  bindCandidate,
  circle3PointTool,
  circleCenterTool,
  ellipseTool,
  ellipticArcTool,
  infer,
  isSketchReference,
  newId,
  polygonTool,
  rectangle3PointTool,
  rectangleCenterTool,
  rectangleCornerTool,
  reusePoints,
  SKETCH_ORIGIN,
  type SketchFragment,
  slotTool,
  splineControlTool,
  splineThroughTool,
} from '@wren-cad/sketch';

export type DrawToolId =
  | 'line'
  | 'rectangle'
  | 'circle'
  | 'arc'
  | 'slot'
  | 'polygon'
  | 'point'
  | 'ellipse'
  | 'ellipticArc'
  | 'splineControl'
  | 'splineThrough';

/** Spline tools take any number of taps: Enter, a double-tap or closing on the first point ends them. */
export const isSplineTool = (tool: DrawToolId): boolean =>
  tool === 'splineControl' || tool === 'splineThrough';

export interface SketchData {
  entities: readonly SketchEntity[];
  constraints: readonly SketchConstraint[];
}

/** A placed click: where it landed and, when it snapped onto an existing point, that point. */
export interface Anchor {
  at: Vec2;
  /** Existing sketch point this click merged into (coincident snap). */
  pointId?: Id;
  /**
   * Point-type inference at this click (pointOn / midpoint, or coincident with the origin, which
   * is never merged into: it is not an entity), applied on commit.
   */
  snap?: GeometricConstraintDraft;
  /** Directional inference for the segment ending here (horizontal, parallel, …). */
  dir?: GeometricConstraintDraft;
  /** What the click becomes (see {@link ClickRole}); absent = `point`. */
  role?: ClickRole;
}

/**
 * What a click becomes in the shape (PLAN M3.8, "what is shown is what is committed"):
 * - `point`: a point of the shape (a corner, a centre, an end, a pole). Every point snap is kept:
 *   onto an existing point it *is* that point (reused, no duplicate), onto a curve or a midpoint
 *   it gets `pointOn` / `midpoint`, onto an axis `pointOn` the axis.
 * - `curve`: a position the new curve passes through without a point of its own (a circle's rim,
 *   a 3-point circle's points, a 3-point arc's middle, an ellipse's axis end). Only a snap onto an
 *   existing point is kept, as `pointOn` (the curve passes through it).
 * - `free`: a size or direction only (a slot's width, a 3-point rectangle's depth, the ellipse's
 *   minor radius, an elliptic arc's projected ends). No snap, so no glyph and no constraint.
 */
export type ClickRole = 'point' | 'curve' | 'free';

/** A dashed alignment guide (display only: guides snap, they are never committed). */
export interface Guide {
  from: Vec2;
  to: Vec2;
}

export interface DrawState {
  tool: DrawToolId;
  variant: string;
  construction: boolean;
  anchors: Anchor[];
  /** Polyline chain: the previous segment's end point (shared with the next segment). */
  chainFrom: Anchor | null;
  /** Snapped cursor and the inference behind it (glyphs). */
  cursor: Vec2 | null;
  hover: Anchor | null;
  candidates: InferenceCandidate[];
  /** Glyphs to show next to the cursor (best one or two). */
  glyphs: InferenceCandidate['constraint']['kind'][];
  /** Snap tolerance (mm) at the last cursor move: how near the first point closes a spline. */
  tolerance?: number;
  /** Alignment guides behind the snapped cursor (drawn dashed; they add no constraint). */
  guides?: Guide[];
}

/** Clicks each tool variant needs (the line tool chains instead). */
export function clicksFor(tool: DrawToolId, variant: string): number {
  switch (tool) {
    case 'line':
      return 2;
    case 'rectangle':
      return variant === 'threePoint' ? 3 : 2;
    case 'circle':
      return variant === 'threePoint' ? 3 : 2;
    case 'arc':
      return variant === 'tangent' ? 2 : 3;
    case 'slot':
      return 3;
    case 'polygon':
      return 2;
    case 'point':
      return 1;
    case 'ellipse':
      return 3;
    case 'ellipticArc':
      return 5;
    case 'splineControl':
    case 'splineThrough':
      return 2; // at least; the shape ends when the user says so
  }
}

export const defaultVariant: Record<DrawToolId, string> = {
  line: 'line',
  rectangle: 'corner',
  circle: 'center',
  arc: 'threePoint',
  slot: 'slot',
  polygon: 'polygon',
  point: 'point',
  ellipse: 'ellipse',
  ellipticArc: 'ellipticArc',
  splineControl: 'splineControl',
  splineThrough: 'splineThrough',
};

/** The role of the next click of the shape in progress. */
export function nextRole(state: DrawState): ClickRole {
  const i = state.anchors.length;
  const v = state.variant;
  switch (state.tool) {
    case 'line':
    case 'point':
    case 'polygon':
    case 'splineControl':
    case 'splineThrough':
      return 'point';
    case 'rectangle':
      return v === 'threePoint' && i >= 2 ? 'free' : 'point';
    case 'circle':
      return v === 'threePoint' || i >= 1 ? 'curve' : 'point';
    case 'arc':
      if (v === 'tangent') return 'point';
      if (v === 'center') return i >= 2 ? 'free' : 'point';
      return i >= 2 ? 'curve' : 'point';
    case 'slot':
      return i >= 2 ? 'free' : 'point';
    case 'ellipse':
      return i === 0 ? 'point' : i === 1 ? 'curve' : 'free';
    case 'ellipticArc':
      return i === 0 ? 'point' : 'free';
  }
}

/** A shape (or line chain) is in progress: a right click or Finish ends it instead of the menu. */
export function inProgress(state: DrawState | null | undefined): boolean {
  return !!state && (state.anchors.length > 0 || state.chainFrom !== null);
}

/** A chain or spline is in progress: the touch toolbar shows Finish. */
export function finishable(state: DrawState | null | undefined): boolean {
  return !!state && inProgress(state) && (state.tool === 'line' || isSplineTool(state.tool));
}

export function startDraw(tool: DrawToolId, variant?: string, construction = false): DrawState {
  return {
    tool,
    variant: variant ?? defaultVariant[tool],
    construction,
    anchors: [],
    chainFrom: null,
    cursor: null,
    hover: null,
    candidates: [],
    glyphs: [],
  };
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const POINT_KINDS = new Set(['coincident', 'pointOn', 'midpoint']);
const DIRECTION_KINDS = new Set(['horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent']);
const GUIDE_KINDS = new Set(['horizontalPoints', 'verticalPoints']);

/** The entity kind being drawn and its anchor, for directional inference. */
function drawing(state: DrawState): { kind: SketchEntityKind; from?: Vec2 } | null {
  const last = state.chainFrom ?? state.anchors[state.anchors.length - 1];
  if (!last) return null;
  if (state.tool === 'line') return { kind: 'line', from: last.at };
  if (state.tool === 'circle' && state.variant === 'center' && state.anchors.length === 1)
    return { kind: 'circle', from: last.at };
  return null;
}

function solveInput(sketch: SketchData): SketchSolveInput {
  return { entities: [...sketch.entities], constraints: [...sketch.constraints], values: {} };
}

/**
 * Cursor moved to `raw` (sketch mm). Infers constraints within `tolerance` (mm) and snaps: a
 * point snap (coincident/midpoint/on-curve) wins outright; otherwise the best directional snap
 * (horizontal, vertical, parallel, …) and then an alignment guide on the free axis. What a snap
 * may become depends on the click's {@link ClickRole}; `glyphs` lists exactly the constraints the
 * click will commit (a reused point shows `coincident`). Alignment guides only snap: they are
 * drawn as dashed lines (`guides`), never as glyphs.
 */
export function move(
  state: DrawState,
  sketch: SketchData,
  raw: Vec2,
  tolerance: number,
): DrawState {
  const role = nextRole(state);
  const d = drawing(state);
  const candidates = infer(solveInput(sketch), raw, d, tolerance);
  const done = (hover: Anchor, glyphs: DrawState['glyphs'], guides: Guide[] = []): DrawState => ({
    ...state,
    cursor: hover.at,
    hover: role === 'point' ? hover : { ...hover, role },
    candidates,
    glyphs,
    guides,
    tolerance,
  });
  if (role === 'free') return done({ at: raw }, []);
  if (role === 'curve') {
    // Only an existing point (or the origin) can be passed through without a point of our own.
    const p = candidates.find((c) => c.constraint.kind === 'coincident');
    if (!p) return done({ at: raw }, []);
    return done(anchorFor(p.snapped, p.constraint), ['pointOn']);
  }
  let at: Vec2 = raw;
  let hover: Anchor = { at: raw };
  const glyphs: DrawState['glyphs'] = [];
  const guides: Guide[] = [];
  const point = candidates.find((c) => POINT_KINDS.has(c.constraint.kind));
  if (point) {
    at = point.snapped;
    const c = point.constraint;
    hover = anchorFor(at, c);
    glyphs.push(c.kind);
    // A line ending on a point/curve can still be horizontal/vertical (closing a rectangle),
    // unless its ends are already aligned that way (it would be redundant).
    const dir = candidates.find(
      (k) => DIRECTION_KINDS.has(k.constraint.kind) && dist(k.snapped, point.snapped) < tolerance,
    );
    if (dir && dirKept(state, sketch, hover, dir.constraint)) {
      glyphs.push(dir.constraint.kind);
      hover.dir = dir.constraint;
    }
  } else {
    const dir = candidates.find((c) => DIRECTION_KINDS.has(c.constraint.kind));
    if (dir) {
      at = dir.snapped;
      glyphs.push(dir.constraint.kind);
    }
    // Guides snap only the coordinate the direction left free.
    const from: Vec2[] = [];
    for (const g of candidates) {
      if (!GUIDE_KINDS.has(g.constraint.kind)) continue;
      const horizontalGuide = g.constraint.kind === 'horizontalPoints';
      if (dir?.constraint.kind === 'horizontal' && horizontalGuide) continue;
      if (dir?.constraint.kind === 'vertical' && !horizontalGuide) continue;
      if (dir && dir.constraint.kind !== 'horizontal' && dir.constraint.kind !== 'vertical') break;
      at = horizontalGuide ? [at[0], g.snapped[1]] : [g.snapped[0], at[1]];
      const other = 'b' in g.constraint ? pointAt(sketch, g.constraint.b) : null;
      if (other) from.push(other);
      if (from.length >= 2) break;
    }
    // Every guide ends at the final (fully snapped) cursor.
    for (const f of from) guides.push({ from: f, to: at });
    hover = dir ? { at, dir: dir.constraint } : { at };
  }
  return done(hover, glyphs.slice(0, 2), guides);
}

/** Position of a sketch point (or the origin) by id. */
function pointAt(sketch: SketchData, id: Id): Vec2 | null {
  if (id === SKETCH_ORIGIN) return [0, 0];
  const e = sketch.entities.find((x) => x.id === id);
  return e?.kind === 'point' ? [e.x, e.y] : null;
}

/** Placeholder for a chain start whose point is not in the sketch yet. */
const FROM_POINT = '@from';

/**
 * Whether a line's directional snap is committed: not when its two ends are already aligned
 * that way (both on one axis, an existing horizontal pair, …): the solver would call it
 * redundant. Judged on the sketch plus the start point's own snap when that point is new in this
 * segment.
 */
function dirKept(
  state: DrawState,
  sketch: SketchData,
  to: Anchor,
  dir: GeometricConstraintDraft,
): boolean {
  if (dir.kind !== 'horizontal' && dir.kind !== 'vertical') return true;
  const from = state.chainFrom ?? state.anchors[0];
  if (state.tool !== 'line' || !from) return true;
  const classes = new AlignmentClasses(sketch.entities, sketch.constraints);
  const fromId = from.pointId ?? FROM_POINT;
  if (!state.chainFrom && !from.pointId && from.snap)
    classes.add(bindCandidate(from.snap, { cursorPoint: FROM_POINT }));
  const toId = to.pointId ?? INFERENCE_CURSOR;
  if (!to.pointId && to.snap) classes.add(to.snap);
  classes.line(INFERENCE_DRAWING, fromId, toId);
  return !classes.redundant(dir);
}

/**
 * End-point inference for a point placed at `at` without a cursor (Pencil strokes): an existing
 * point within `tolerance` is reused, else a curve or midpoint it lies on (pointOn / midpoint).
 * `at` stays where it is, so `bindAnchors` finds the fragment point there.
 */
export function pointAnchor(sketch: SketchData, at: Vec2, tolerance: number): Anchor {
  const point = infer(solveInput(sketch), at, null, tolerance).find((c) =>
    POINT_KINDS.has(c.constraint.kind),
  );
  if (!point) return { at };
  return anchorFor(at, point.constraint);
}

/** A coincident snap reuses the existing point; the origin gets a new point + constraint. */
function anchorFor(at: Vec2, c: GeometricConstraintDraft): Anchor {
  if (c.kind === 'coincident' && !isSketchReference(c.b)) return { at, pointId: c.b };
  return { at, snap: c };
}

export interface SketchEdit {
  entities: SketchEntity[];
  constraints: SketchConstraint[];
  /** Entity ids created (for selection / dimensioning). */
  created: Id[];
  /** Existing points the clicks landed on and the new geometry now uses (no duplicates made). */
  reused?: Id[];
}

function bind(c: GeometricConstraintDraft, ids: { cursorPoint?: Id; drawingEntity?: Id }) {
  return { ...bindCandidate(c, ids), id: newId() } as SketchConstraint;
}

/** True when `e` is built on point `id` (an end, a centre or a pole). */
function usesPoint(e: SketchEntity, id: Id): boolean {
  switch (e.kind) {
    case 'point':
      return false;
    case 'line':
      return e.start === id || e.end === id;
    case 'circle':
    case 'ellipse':
      return e.center === id;
    case 'arc':
    case 'ellipticArc':
      return e.center === id || e.start === id || e.end === id;
    case 'bspline':
      return e.poles.includes(id);
  }
}

/** The curve a `curve`-role click passes through: the fragment's one circle, arc or ellipse. */
function fragmentCurve(frag: SketchFragment): Id | null {
  const c = frag.entities.find(
    (e) => !e.construction && e.kind !== 'point' && e.kind !== 'line' && e.kind !== 'bspline',
  );
  return c?.id ?? null;
}

/**
 * The fragment with its snapped anchors applied (PLAN M3.8): a `point` anchor on an existing
 * point reuses it (the fragment's own point at that spot is dropped, so there is no duplicate and
 * no `coincident`), other point snaps are bound to the fragment point at the anchor; a `curve`
 * anchor on an existing point adds `pointOn` (the curve passes through it); `free` anchors add
 * nothing. Fragment points are matched by position (visible points first, then construction
 * ones such as a polygon's centre or a spline's inner poles), each at most once.
 */
export function bindAnchors(
  frag: SketchFragment,
  anchors: readonly Anchor[],
): { entities: SketchEntity[]; constraints: SketchConstraint[]; reused: Id[] } {
  const reuse = new Map<Id, Id>();
  const reused = new Set<Id>();
  const taken = new Set<Id>();
  const extra: SketchConstraint[] = [];
  const curve = fragmentCurve(frag);
  const throughs = new Set<Id>();
  const pointsAt = (at: Vec2) =>
    frag.entities
      .filter((e) => e.kind === 'point' && !taken.has(e.id) && dist([e.x, e.y], at) < 1e-6)
      .sort((a, b) => Number(a.construction) - Number(b.construction));
  for (const a of anchors) {
    const role = a.role ?? 'point';
    if (role === 'free') continue;
    if (role === 'curve') {
      const through =
        a.pointId ??
        (a.snap?.kind === 'coincident' && isSketchReference(a.snap.b) ? a.snap.b : null);
      if (!through || !curve || throughs.has(through)) continue;
      throughs.add(through);
      extra.push({ id: newId(), kind: 'pointOn', point: through, on: curve });
      continue;
    }
    const p = pointsAt(a.at)[0];
    if (!p) {
      // The tool already built on the existing point (a tangent arc's start).
      if (a.pointId && frag.entities.some((e) => usesPoint(e, a.pointId as Id)))
        reused.add(a.pointId);
      continue;
    }
    taken.add(p.id);
    if (a.pointId && !reused.has(a.pointId)) {
      reuse.set(p.id, a.pointId);
      reused.add(a.pointId);
    } else if (a.pointId) extra.push({ id: newId(), kind: 'coincident', a: p.id, b: a.pointId });
    else if (a.snap) extra.push(bind(a.snap, { cursorPoint: p.id }));
  }
  const out = reusePoints(frag, reuse);
  return {
    entities: out.entities,
    constraints: [...out.constraints, ...extra],
    reused: [...reused],
  };
}

/** The sketch edit for a finished tool fragment and the clicks that placed it. */
function fragmentEdit(frag: SketchFragment, anchors: readonly Anchor[]): SketchEdit {
  const bound = bindAnchors(frag, anchors);
  return {
    ...bound,
    reused: bound.reused,
    created: bound.entities.filter((e) => e.kind !== 'point').map((e) => e.id),
  };
}

function shapeFragment(
  state: DrawState,
  sketch: SketchData,
  pts: readonly Vec2[],
  anchors: readonly Anchor[],
): SketchFragment | null {
  const o = { construction: state.construction };
  const [a, b, c, d, e] = pts;
  if (!a || !b) return null;
  switch (state.tool) {
    case 'ellipse':
      return c ? ellipseTool(a, b, c, o) : null;
    case 'ellipticArc':
      return c && d && e ? ellipticArcTool(a, b, c, d, e, o) : null;
    case 'splineControl':
    case 'splineThrough': {
      // A preview whose cursor sits on the first point shows the closed curve.
      const last = pts[pts.length - 1] as Vec2;
      if (pts.length === state.anchors.length + 1 && closesSpline(state, last))
        return splineFragment(state, pts.slice(0, -1), true);
      return splineFragment(state, pts, false);
    }
    case 'rectangle':
      if (state.variant === 'center') return rectangleCenterTool(a, b, o);
      if (state.variant === 'threePoint') return c ? rectangle3PointTool(a, b, c, o) : null;
      if (dist(a, b) < 1e-9 || a[0] === b[0] || a[1] === b[1]) return null;
      return rectangleCornerTool(a, b, o);
    case 'circle':
      if (state.variant === 'threePoint') return c ? circle3PointTool(a, b, c, o) : null;
      return dist(a, b) > 1e-9 ? circleCenterTool(a, b, o) : null;
    case 'arc':
      if (state.variant === 'center') return c ? arcCenterTool(a, b, c, o) : null;
      if (state.variant === 'tangent') {
        const start = anchors[0]?.pointId;
        return start ? arcTangentTool(sketch.entities, start, b, o) : null;
      }
      return c ? arc3PointTool(a, b, c, o) : null;
    case 'slot': {
      if (!c) return null;
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const l = Math.hypot(ux, uy);
      if (l < 1e-9) return null;
      const r = Math.abs(((c[0] - a[0]) * uy - (c[1] - a[1]) * ux) / l);
      return slotTool(a, b, r, o);
    }
    case 'polygon':
      return polygonTool(a, b, 6, o);
    case 'point':
    case 'line':
      return null;
  }
}

/** Closing: the point lands on the first of at least three placed points. */
function closesSpline(state: DrawState, at: Vec2): boolean {
  const first = state.anchors[0];
  return (
    !!first &&
    state.anchors.length >= 3 &&
    dist(first.at, at) <= Math.max((state.tolerance ?? 0) * 1.5, 1e-6)
  );
}

/** A spline through (or controlled by) the placed points; `closed` makes it periodic. */
function splineFragment(
  state: DrawState,
  pts: readonly Vec2[],
  closed: boolean,
): SketchFragment | null {
  const o = { construction: state.construction, closed };
  return state.tool === 'splineControl' ? splineControlTool(pts, o) : splineThroughTool(pts, o);
}

/**
 * A line segment from `from` to `to`, reusing existing points; with the inferred constraints
 * the glyphs showed (the directional one was already dropped by `move` when redundant).
 */
function lineSegment(state: DrawState, from: Anchor, to: Anchor): SketchEdit {
  const entities: SketchEntity[] = [];
  const constraints: SketchConstraint[] = [];
  const o = state.construction;
  const startId = from.pointId ?? newId();
  if (!from.pointId) {
    entities.push({ id: startId, kind: 'point', construction: o, x: from.at[0], y: from.at[1] });
    if (from.snap) constraints.push(bind(from.snap, { cursorPoint: startId }));
  }
  const endId = to.pointId ?? newId();
  if (!to.pointId) {
    entities.push({ id: endId, kind: 'point', construction: o, x: to.at[0], y: to.at[1] });
    if (to.snap) constraints.push(bind(to.snap, { cursorPoint: endId }));
  }
  const lineId = newId();
  entities.push({ id: lineId, kind: 'line', construction: o, start: startId, end: endId });
  // The strongest directional inference at the end (horizontal, vertical, parallel, …).
  if (to.dir) constraints.push(bind(to.dir, { drawingEntity: lineId, cursorPoint: endId }));
  // The chain's own previous end is shared, not reused; the first click's and this one's are.
  const reused = [state.chainFrom ? undefined : from.pointId, to.pointId].filter(
    (id): id is Id => id !== undefined,
  );
  return { entities, constraints, created: [lineId], reused };
}

export interface ClickResult {
  state: DrawState;
  edit: SketchEdit | null;
  /** An existing point the click landed on without creating anything (the Point tool): select it. */
  select?: Id;
}

/** A tap for a spline tool: another point, or (on the first point) the end of a closed curve. */
function splineClick(state: DrawState, hover: Anchor): ClickResult {
  const last = state.anchors[state.anchors.length - 1];
  if (last && dist(last.at, hover.at) < 1e-9) return { state, edit: null }; // a double-tap's second
  if (closesSpline(state, hover.at)) return finishSpline(state, true);
  return { state: { ...state, anchors: [...state.anchors, hover] }, edit: null };
}

function finishSpline(state: DrawState, closed: boolean): ClickResult {
  const reset = { ...state, anchors: [], candidates: [], glyphs: [] };
  const frag = splineFragment(
    state,
    state.anchors.map((a) => a.at),
    closed,
  );
  if (!frag) return { state: reset, edit: null }; // too few points: nothing to make
  return { state: reset, edit: fragmentEdit(frag, state.anchors) };
}

/**
 * Enter or a double-tap: ends the open spline being drawn (null when the tool has nothing to end).
 * Closing is by tapping the first point; this leaves the curve open.
 */
export function finishShape(state: DrawState): ClickResult | null {
  if (!isSplineTool(state.tool) || state.anchors.length === 0) return null;
  return finishSpline(state, false);
}

/**
 * A right click, the touch Finish button or Enter (PLAN M3.8): ends what is in progress without
 * leaving the tool. A spline is committed open with the points placed so far (two are enough); a
 * line chain ends where it is (its segments are already committed). Any other shape that is only
 * partly placed cannot be finished, so it is dropped, as Esc does. Null when nothing is in
 * progress (a right click then opens the radial menu).
 */
export function finishTool(state: DrawState): ClickResult | null {
  if (!inProgress(state)) return null;
  const spline = finishShape(state);
  if (spline) return spline;
  const next = cancel(state);
  return next ? { state: next, edit: null } : null;
}

/** A click at the current (snapped) cursor. */
export function click(state: DrawState, sketch: SketchData): ClickResult {
  const hover = state.hover ?? (state.cursor ? { at: state.cursor } : null);
  if (!hover) return { state, edit: null };

  if (state.tool === 'line') {
    const from = state.chainFrom ?? state.anchors[0];
    if (!from) return { state: { ...state, anchors: [hover] }, edit: null };
    if (dist(from.at, hover.at) < 1e-9) return { state, edit: null };
    const edit = lineSegment(state, from, hover);
    const line = edit.entities.find((e) => e.kind === 'line');
    const endId = line && line.kind === 'line' ? line.end : undefined;
    // Closing onto an existing point ends the chain (e.g. back at the start of a rectangle).
    const closed = !!hover.pointId;
    return {
      state: {
        ...state,
        anchors: [],
        // The snap rides along (it is already applied) so the next segment knows the axis.
        chainFrom:
          closed || !endId
            ? null
            : { at: hover.at, pointId: endId, ...(hover.snap ? { snap: hover.snap } : {}) },
        candidates: [],
        glyphs: [],
      },
      edit,
    };
  }

  if (state.tool === 'point') {
    // A point (hole centres, references): snaps like any click. Onto an existing point it *is*
    // that point: nothing new (no duplicate), the point is selected instead.
    if (hover.pointId) return { state, edit: null, select: hover.pointId };
    const id = newId();
    const constraints = hover.snap ? [bind(hover.snap, { cursorPoint: id })] : [];
    return {
      state: { ...state, anchors: [], candidates: [], glyphs: [] },
      edit: {
        entities: [
          { id, kind: 'point', construction: state.construction, x: hover.at[0], y: hover.at[1] },
        ],
        constraints,
        created: [id],
      },
    };
  }

  if (isSplineTool(state.tool)) return splineClick(state, hover);

  const anchors = [...state.anchors, hover];
  const need = clicksFor(state.tool, state.variant);
  if (state.tool === 'arc' && state.variant === 'tangent' && anchors.length === 1 && !hover.pointId)
    return { state, edit: null }; // tangent arcs start on an existing end point
  if (anchors.length < need) return { state: { ...state, anchors }, edit: null };
  const frag = shapeFragment(
    state,
    sketch,
    anchors.map((a) => a.at),
    anchors,
  );
  if (!frag) return { state: { ...state, anchors: anchors.slice(0, -1) }, edit: null };
  return {
    state: { ...state, anchors: [], candidates: [], glyphs: [] },
    edit: fragmentEdit(frag, anchors),
  };
}

/**
 * Rubber-band geometry for the shape in progress plus the dashed alignment guides behind the
 * cursor (display only; preview ids).
 */
export function preview(state: DrawState, sketch: SketchData): SketchFragment | null {
  const shape = shapePreview(state, sketch);
  const guides = state.cursor ? (state.guides ?? []) : [];
  if (guides.length === 0) return shape;
  const entities = [...(shape?.entities ?? [])];
  guides.forEach((g, i) => {
    const [a, b, l] = ['a', 'b', 'l'].map((k) => newPreviewId(`guide:${i}:${k}`)) as [Id, Id, Id];
    entities.push(
      { id: a, kind: 'point', construction: true, x: g.from[0], y: g.from[1] },
      { id: b, kind: 'point', construction: true, x: g.to[0], y: g.to[1] },
      { id: l, kind: 'line', construction: true, start: a, end: b },
    );
  });
  return { entities, constraints: shape?.constraints ?? [] };
}

function shapePreview(state: DrawState, sketch: SketchData): SketchFragment | null {
  const cursor = state.cursor;
  if (!cursor) return null;
  if (state.tool === 'line') {
    const from = state.chainFrom ?? state.anchors[0];
    if (!from) return null;
    const a = newPreviewId('a');
    const b = newPreviewId('b');
    const l = newPreviewId('l');
    const pts: SketchEntity[] = [
      { id: a, kind: 'point', construction: state.construction, x: from.at[0], y: from.at[1] },
      { id: b, kind: 'point', construction: state.construction, x: cursor[0], y: cursor[1] },
    ];
    return {
      entities: [
        ...pts,
        { id: l, kind: 'line', construction: state.construction, start: a, end: b },
      ],
      constraints: [],
    };
  }
  if (state.anchors.length === 0) return null;
  const pts = [...state.anchors.map((a) => a.at), cursor];
  const need = clicksFor(state.tool, state.variant);
  // With fewer points than needed, preview the two-point form (e.g. a circle through 2 points).
  let frag: SketchFragment | null = null;
  if (state.tool === 'ellipticArc' && (pts.length === 3 || pts.length === 4)) {
    // The ellipse first (dashed), then the arc along it once its start is placed.
    frag = ellipseTool(pts[0] as Vec2, pts[1] as Vec2, pts[2] as Vec2, { construction: true });
  } else if (pts.length >= need) frag = shapeFragment(state, sketch, pts, [...state.anchors]);
  else if (pts.length === 2) {
    const a = pts[0] as Vec2;
    const b = pts[1] as Vec2;
    if (state.tool === 'slot')
      frag = slotTool(a, b, Math.max(dist(a, b) * 0.15, 0.5), { construction: state.construction });
    else if (
      state.tool === 'rectangle' ||
      state.tool === 'arc' ||
      state.tool === 'circle' ||
      state.tool === 'ellipse' ||
      state.tool === 'ellipticArc'
    ) {
      const ids = ['a', 'b', 'l'].map(newPreviewId) as [Id, Id, Id];
      frag = {
        entities: [
          { id: ids[0], kind: 'point', construction: true, x: a[0], y: a[1] },
          { id: ids[1], kind: 'point', construction: true, x: b[0], y: b[1] },
          { id: ids[2], kind: 'line', construction: true, start: ids[0], end: ids[1] },
        ],
        constraints: [],
      };
    }
  }
  if (!frag) return null;
  // Preview ids must never collide with real ones.
  const map = new Map(frag.entities.map((e) => [e.id, newPreviewId(e.id)]));
  const re = (id: Id) => map.get(id) ?? id;
  return {
    entities: frag.entities.map((e) => {
      switch (e.kind) {
        case 'point':
          return { ...e, id: re(e.id) };
        case 'line':
          return { ...e, id: re(e.id), start: re(e.start), end: re(e.end) };
        case 'circle':
          return { ...e, id: re(e.id), center: re(e.center) };
        case 'arc':
          return { ...e, id: re(e.id), center: re(e.center), start: re(e.start), end: re(e.end) };
        case 'ellipticArc':
          return { ...e, id: re(e.id), center: re(e.center), start: re(e.start), end: re(e.end) };
        case 'bspline':
          return {
            ...e,
            id: re(e.id),
            poles: e.poles.map(re),
            ...(e.through ? { through: e.through.map(re) } : {}),
          };
        default:
          return { ...e, id: re(e.id), center: re(e.center) };
      }
    }),
    constraints: [],
  };
}

export const PREVIEW_PREFIX = 'preview:';
const newPreviewId = (seed: string): Id => `${PREVIEW_PREFIX}${seed}`;

/** Esc: drop the shape in progress; returns null when there was nothing to drop (leave tool). */
export function cancel(state: DrawState): DrawState | null {
  if (state.anchors.length === 0 && !state.chainFrom) return null;
  return { ...state, anchors: [], chainFrom: null, candidates: [], glyphs: [], guides: [] };
}

/** The cursor placeholder ids, re-exported for hosts that render candidate glyphs. */
export const PLACEHOLDERS = { cursor: INFERENCE_CURSOR, drawing: INFERENCE_DRAWING } as const;

/**
 * The sketch as drawing sees it: the document's sketch plus edits that were clicked but whose
 * solve hasn't landed yet. Drawing must infer against this, or a fast click (or a busy solver)
 * misses points it just placed: closing a rectangle on its start point would add a free point.
 * Entities already in the document win (they carry solved positions).
 */
export function withPending(sketch: SketchData, pending: readonly SketchData[]): SketchData {
  if (pending.length === 0) return sketch;
  const have = new Set<Id>(sketch.entities.map((e) => e.id));
  const haveC = new Set<Id>(sketch.constraints.map((c) => c.id));
  const entities = [...sketch.entities];
  const constraints = [...sketch.constraints];
  for (const p of pending) {
    for (const e of p.entities) if (!have.has(e.id)) entities.push(e);
    for (const c of p.constraints) if (!haveC.has(c.id)) constraints.push(c);
  }
  return { entities, constraints };
}
