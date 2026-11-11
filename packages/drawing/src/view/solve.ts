/**
 * Resolves every view of a drawing: frame, scale, sheet position and the projection request.
 * Scales and rotations are `Expr`s evaluated by an injected evaluator (packages/document owns the
 * expression engine). Anchored points (section cut lines, detail centres) that follow model
 * entities are resolved by an injected resolver; an unresolved one makes the view need attention,
 * it is never moved to a guess. A missing parent or a parent cycle is reported, never rendered.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  AnchoredPoint,
  Drawing,
  DrawingView,
  EntityRef,
  Expr,
  Id,
  RefPoint,
  Vec2,
  Vec3,
  ViewDisplay,
  ViewProjectionRequest,
} from '@wren-cad/contracts';
import { add2, cross3, len2, norm3, perp2, scale2, scale3, sub2 } from '../annotation/geom';
import {
  alignedDirection,
  isoFrame,
  orientationFrame,
  projectBounds,
  projectToView,
  rotateFrame,
  SIDE_VECTORS,
  sideFrame,
  type ViewFrame,
  viewToPart,
} from './frame';

/** Evaluates a drawing `Expr`: `ratio` = unitless scale (`1/2`), `angle` = radians. */
export type ExprEvaluator = (expr: Expr, kind: 'ratio' | 'angle') => number | undefined;

/** Resolves a model entity to a part-space point (`AnnotationAnchor`-style), or undefined. */
export type RefResolver = (ref: EntityRef, point: RefPoint | undefined) => Vec3 | undefined;

export type ViewProblem =
  | { kind: 'sheetMissing'; sheetId: Id }
  | { kind: 'parentMissing'; parentId: Id }
  | { kind: 'parentCycle' }
  | { kind: 'parentUnresolved'; parentId: Id }
  | { kind: 'scaleInvalid'; expr: Expr }
  | { kind: 'rotationInvalid'; expr: Expr }
  | { kind: 'cutInvalid'; message: string }
  | { kind: 'pointUnresolved'; path: string; ref: EntityRef };

export interface SolvedView {
  view: DrawingView;
  ok: true;
  frame: ViewFrame;
  /** Unitless view scale (sheet mm per part mm). */
  scale: number;
  /** View centre on the sheet (the layout position), sheet mm. */
  position: Vec2;
  /** View-plane point (part mm) shown at `position`: the projected 3D box centre. */
  center: Vec2;
  /** Projected 3D bounds, view plane, part mm. */
  bounds: { min: Vec2; max: Vec2 };
  display: ViewDisplay;
  /** Section views: the request's section; detail views: the clip circle. */
  section?: NonNullable<ViewProjectionRequest['section']>;
  clip?: NonNullable<ViewProjectionRequest['clip']>;
  /** The side of the parent this view is seen from (projected and section views). */
  side?: Vec2;
}

export interface FailedView {
  view: DrawingView;
  ok: false;
  problems: ViewProblem[];
}

export type ViewSolution = SolvedView | FailedView;

export interface SolveViewsInput {
  drawing: Drawing;
  /** Part 3D bounding box (`ShapeForDrawing.bounds`, ADR-084). */
  bounds: { min: Vec3; max: Vec3 };
  evaluate: ExprEvaluator;
  resolveRef?: RefResolver;
}

const DEFAULT_DISPLAY: ViewDisplay = {
  lines: 'visible',
  tangentEdges: 'off',
  centerMarks: true,
  centerLines: true,
  threads: true,
};

/** Sheet ← view-plane point. */
export function viewToSheet(v: SolvedView, p: Vec2): Vec2 {
  return add2(v.position, scale2(sub2(p, v.center), v.scale));
}

/** Sheet ← part point. */
export function partToSheet(v: SolvedView, p: Vec3): Vec2 {
  return viewToSheet(v, projectToView(v.frame, p));
}

/** View plane ← sheet point. */
export function sheetToView(v: SolvedView, p: Vec2): Vec2 {
  return add2(v.center, scale2(sub2(p, v.position), 1 / v.scale));
}

/** The view's outline on the sheet (its projected 3D box, sheet mm), the reference for lanes. */
export function viewOutline(v: SolvedView): { min: Vec2; max: Vec2 } {
  return { min: viewToSheet(v, v.bounds.min), max: viewToSheet(v, v.bounds.max) };
}

function resolvePoint(
  p: AnchoredPoint,
  parent: ViewFrame,
  resolve: RefResolver | undefined,
  path: string,
): { ok: true; at: Vec2 } | { ok: false; problem: ViewProblem } {
  if (p.kind === 'free') return { ok: true, at: p.at };
  const at3 = resolve?.(p.ref, p.point);
  if (!at3) return { ok: false, problem: { kind: 'pointUnresolved', path, ref: p.ref } };
  return { ok: true, at: add2(projectToView(parent, at3), p.offset ?? [0, 0]) };
}

/** Resolves every view in dependency order; views are returned keyed by id. */
export function solveViews(input: SolveViewsInput): Map<Id, ViewSolution> {
  const { drawing, evaluate } = input;
  const byId = new Map(drawing.views.map((v) => [v.id, v]));
  const sheets = new Map(drawing.sheets.map((s) => [s.id, s]));
  const out = new Map<Id, ViewSolution>();
  const visiting = new Set<Id>();

  const fail = (view: DrawingView, problems: ViewProblem[]): FailedView => {
    const f: FailedView = { view, ok: false, problems };
    out.set(view.id, f);
    return f;
  };

  const solve = (view: DrawingView): ViewSolution => {
    const done = out.get(view.id);
    if (done) return done;
    if (visiting.has(view.id)) return fail(view, [{ kind: 'parentCycle' }]);
    visiting.add(view.id);
    try {
      return solveOne(view);
    } finally {
      visiting.delete(view.id);
    }
  };

  const solveOne = (view: DrawingView): ViewSolution => {
    const problems: ViewProblem[] = [];
    const sheet = sheets.get(view.sheetId);
    if (!sheet) problems.push({ kind: 'sheetMissing', sheetId: view.sheetId });

    let parent: SolvedView | undefined;
    if (view.kind !== 'base') {
      const pv = byId.get(view.parentId);
      if (!pv) return fail(view, [...problems, { kind: 'parentMissing', parentId: view.parentId }]);
      const ps = solve(pv);
      if (out.get(view.id)) return out.get(view.id) as ViewSolution; // cycle reported meanwhile
      if (!ps.ok) {
        const cyc = ps.problems.some((p) => p.kind === 'parentCycle');
        return fail(view, [
          ...problems,
          cyc ? { kind: 'parentCycle' } : { kind: 'parentUnresolved', parentId: view.parentId },
        ]);
      }
      parent = ps;
    }

    // Scale: base and iso use the sheet's; projected and section their parent's; detail its own.
    let scale: number | undefined;
    const scaleExpr =
      view.scale ?? (view.kind === 'base' || view.kind === 'iso' ? sheet?.scale : undefined);
    if (scaleExpr !== undefined) {
      scale = evaluate(scaleExpr, 'ratio');
      if (!(scale !== undefined && scale > 0 && Number.isFinite(scale))) {
        problems.push({ kind: 'scaleInvalid', expr: scaleExpr });
        scale = undefined;
      }
    } else scale = parent?.scale;

    // Frame.
    let frame: ViewFrame | undefined;
    let side: Vec2 | undefined;
    let section: SolvedView['section'];
    let clip: SolvedView['clip'];
    let centerOverride: Vec2 | undefined;
    switch (view.kind) {
      case 'base': {
        frame = orientationFrame(view.orientation);
        if (view.rotation !== undefined) {
          const r = evaluate(view.rotation, 'angle');
          if (r === undefined || !Number.isFinite(r))
            problems.push({ kind: 'rotationInvalid', expr: view.rotation });
          else frame = rotateFrame(frame, r);
        }
        break;
      }
      case 'projected':
        side = SIDE_VECTORS[view.from];
        frame = sideFrame((parent as SolvedView).frame, side);
        break;
      case 'iso':
        frame = isoFrame((parent as SolvedView).frame, view.corner);
        break;
      case 'section': {
        const pf = (parent as SolvedView).frame;
        if (view.cut.length < 2) {
          problems.push({ kind: 'cutInvalid', message: 'A cut line needs at least two points' });
          break;
        }
        const pts: Vec2[] = [];
        view.cut.forEach((p, i) => {
          const r = resolvePoint(p, pf, input.resolveRef, `/cut/${i}`);
          if (r.ok) pts.push(r.at);
          else problems.push(r.problem);
        });
        if (pts.length !== view.cut.length) break;
        const d = sub2(pts[1] as Vec2, pts[0] as Vec2);
        if (len2(d) < 1e-9) {
          problems.push({ kind: 'cutInvalid', message: 'The first cut segment has no length' });
          break;
        }
        const t = scale2(d, 1 / len2(d));
        // The viewer looks towards the left or right of the line's direction (first → last).
        const look2 = view.look === 'left' ? perp2(t) : scale2(perp2(t), -1);
        side = scale2(look2, -1);
        frame = sideFrame(pf, side);
        const look3 = norm3(viewToPart(pf, look2));
        section = {
          cut: pts.map((p) => viewToPart(pf, p)),
          along: scale3(pf.n, -1),
          look: look3,
          depth: view.depth ?? 'full',
        };
        break;
      }
      case 'detail': {
        const pf = (parent as SolvedView).frame;
        frame = pf;
        const r = resolvePoint(view.center, pf, input.resolveRef, '/center');
        if (!r.ok) problems.push(r.problem);
        else {
          clip = { center: r.at, radius: view.radius };
          centerOverride = r.at;
        }
        if (!(view.radius > 0))
          problems.push({ kind: 'cutInvalid', message: 'The detail radius must be positive' });
        break;
      }
    }
    if (problems.length > 0 || !frame || scale === undefined) {
      if (!frame && problems.length === 0)
        problems.push({ kind: 'cutInvalid', message: 'No frame' });
      if (scale === undefined && !problems.some((p) => p.kind === 'scaleInvalid'))
        problems.push({ kind: 'scaleInvalid', expr: view.scale ?? '' });
      return fail(view, problems);
    }

    const pb = projectBounds(frame, input.bounds);
    const bounds =
      clip !== undefined
        ? {
            min: sub2(clip.center, [clip.radius, clip.radius]),
            max: add2(clip.center, [clip.radius, clip.radius]),
          }
        : { min: pb.min, max: pb.max };
    const center = centerOverride ?? pb.center;

    // Position: free, or aligned with the parent along the projection axis.
    let position: Vec2;
    if (view.layout.kind === 'free') position = view.layout.position;
    else {
      const dir = alignedDirection(side ?? [1, 0], drawing.projection);
      position = add2((parent as SolvedView).position, scale2(dir, view.layout.distance));
    }

    const inherited = parent?.display ?? { ...DEFAULT_DISPLAY, ...drawing.style.view };
    const display: ViewDisplay = { ...inherited, ...(view.display ?? {}) };
    const solved: SolvedView = {
      view,
      ok: true,
      frame,
      scale,
      position,
      center,
      bounds,
      display,
      ...(section ? { section } : {}),
      ...(clip ? { clip } : {}),
      ...(side ? { side } : {}),
    };
    out.set(view.id, solved);
    return solved;
  };

  for (const v of [...drawing.views].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
    solve(v);
  return out;
}

/** The drawing worker request for a solved view. */
export function projectionRequest(
  v: SolvedView,
  shapeKey: string,
  quality: 'draft' | 'exact',
): ViewProjectionRequest {
  return {
    shapeKey,
    frame: { x: v.frame.x, y: v.frame.y },
    quality,
    hidden: v.display.lines === 'visibleAndHidden',
    smooth: v.display.tangentEdges !== 'off',
    ...(v.section ? { section: v.section } : {}),
    ...(v.clip ? { clip: v.clip } : {}),
  };
}

/** True when the frame's normal is parallel to `dir` (a direction seen end-on in the view). */
export function seenEndOn(frame: ViewFrame, dir: Vec3, tol = 1e-6): boolean {
  return Math.hypot(...cross3(norm3(dir), frame.n)) < tol;
}
