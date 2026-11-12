/**
 * Construction geometry on a view (M4.1, ADR-095): the origin's point and axes, each sketch's
 * origin, axes and standalone points, plane/axis/point features and the pitch circles of circular
 * patterns. None of it is a model edge, so the drawing kernel never draws it: its geometry comes
 * from one `annotationAnchors` call (`constructionQueries`) and is projected here.
 *
 * Two uses, one projection:
 *  - while a picking tool is active the route shows every candidate as a transient pick target
 *    (`constructionShapes`), and a pick stores the exact name drawn under the pointer;
 *  - a placement that uses a construction ref draws it as a thin chain line from its resolution's
 *    anchor (`usedConstructionItems`); an unresolved ref draws nothing.
 *
 * Coincident candidates (the origin's Y axis and a sketch's y axis on the origin, seen in one
 * view) are kept once, by a fixed priority: the origin first, then history order. That is a
 * display rule over exact names, never a guess at which entity a ref means.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  AnchorAnswer,
  Annotation,
  AnnotationAnchor,
  AnnotationPlacement,
  AnnotationResolution,
  EntityKind,
  EntityRef,
  Id,
  Part,
  SketchEntity,
  Vec2,
  Vec3,
} from '@wren-cad/contracts';
import { SKETCH_ORIGIN, SKETCH_X_AXIS, SKETCH_Y_AXIS } from '@wren-cad/contracts';
import type { DisplayItem, ItemSource } from '../annotation/display';
import { cross2, dot3, norm2, norm3, TAU } from '../annotation/geom';
import { projectToView } from '../view/frame';
import { type SolvedView, viewToSheet } from '../view/solve';

/** One construction ref to ask `annotationAnchors` for, in priority order. */
export interface ConstructionQuery {
  name: string;
  ref: EntityRef;
}

/** A construction ref with its resolved geometry (part coordinates). */
export interface ConstructionCandidate {
  name: string;
  anchor: AnnotationAnchor;
}

/**
 * A construction ref as one view shows it, in the view plane (part mm, like `ProjectedCurve`):
 * a line spanned across the view, a circle, or a point.
 */
export type ConstructionShape =
  | { kind: 'line'; name: string; a: Vec2; b: Vec2 }
  | { kind: 'circle'; name: string; center: Vec2; radius: number }
  | { kind: 'point'; name: string; at: Vec2 };

const ORIGIN = /^origin:[OXYZ]$/;
const SKETCH_POINT = /^S[^:()]+:p\((.+)\)$/;
const NAME =
  /^(?:origin:[OXYZ]|S[^:()]+:p\(.+\)|S[^:()]+:e\(@[xy]\)|F[^:()]+:(?:plane|axis|point|pitch))$/;

/** Whether a ref name is construction geometry (ADR-095), not a model face, edge or vertex. */
export function isConstructionName(name: string): boolean {
  return NAME.test(name);
}

/**
 * The default for drawing used construction refs: every construction name except a sketch point
 * that is not the sketch's origin (a profile corner is a model vertex too; standalone points are
 * named by `constructionNames`).
 */
export function defaultIsConstruction(name: string): boolean {
  if (!isConstructionName(name)) return false;
  const m = SKETCH_POINT.exec(name);
  return !m || m[1] === SKETCH_ORIGIN;
}

/**
 * The entity kind a construction ref is stored with: points (`origin:O`, sketch points, point
 * features) are vertices, plane features faces, everything else (axes, pitch circles) edges.
 */
export function constructionKind(name: string): EntityKind {
  if (name === 'origin:O' || SKETCH_POINT.test(name) || /:point$/.test(name)) return 'vertex';
  if (/:plane$/.test(name)) return 'face';
  return 'edge';
}

/** The point ids a sketch's curves use (ends, centres, poles, through points). */
function usedPoints(entities: readonly SketchEntity[]): Set<string> {
  const used = new Set<string>();
  for (const e of entities) {
    switch (e.kind) {
      case 'line':
        used.add(e.start).add(e.end);
        break;
      case 'circle':
      case 'ellipse':
        used.add(e.center);
        break;
      case 'arc':
      case 'ellipticArc':
        used.add(e.center).add(e.start).add(e.end);
        break;
      case 'bspline':
        for (const p of e.poles) used.add(p);
        for (const p of e.through ?? []) used.add(p);
        break;
      default:
        break;
    }
  }
  return used;
}

/**
 * Every construction ref of a part a view can offer, in priority order (the origin, then history
 * order): origin O/X/Y/Z; each sketch's `@origin`, `@x`, `@y` and its standalone points
 * (construction points, or points no curve uses); plane, axis and point features; and the pitch
 * circle of each circular pattern. Suppressed features are left out. Pure.
 */
export function constructionQueries(part: Part): ConstructionQuery[] {
  const out: ConstructionQuery[] = [];
  const add = (name: string) => out.push({ name, ref: { name, kind: constructionKind(name) } });
  for (const n of ['origin:O', 'origin:X', 'origin:Y', 'origin:Z']) add(n);
  for (const f of part.features) {
    if (f.suppressed) continue;
    switch (f.type) {
      case 'sketch': {
        add(`S${f.id}:p(${SKETCH_ORIGIN})`);
        add(`S${f.id}:e(${SKETCH_X_AXIS})`);
        add(`S${f.id}:e(${SKETCH_Y_AXIS})`);
        const used = usedPoints(f.entities);
        for (const e of f.entities)
          if (e.kind === 'point' && (e.construction || !used.has(e.id))) add(`S${f.id}:p(${e.id})`);
        break;
      }
      case 'plane':
        add(`F${f.id}:plane`);
        break;
      case 'axis':
        add(`F${f.id}:axis`);
        break;
      case 'point':
        add(`F${f.id}:point`);
        break;
      case 'circularPattern':
        add(`F${f.id}:pitch`);
        break;
      default:
        break;
    }
  }
  return out;
}

/** The names `constructionQueries` offers: what a used ref is drawn for (with `isConstructionName`). */
export function constructionNames(part: Part): Set<string> {
  return new Set(constructionQueries(part).map((q) => q.name));
}

/** Candidates from one `annotationAnchors` answer list (same order); unresolved ones are dropped. */
export function constructionCandidates(
  queries: readonly ConstructionQuery[],
  answers: readonly (AnchorAnswer | undefined)[],
): ConstructionCandidate[] {
  const out: ConstructionCandidate[] = [];
  queries.forEach((q, i) => {
    const a = answers[i]?.anchor;
    if (a) out.push({ name: q.name, anchor: a });
  });
  return out;
}

/** The infinite line `p + t·d` (d unit) clipped to a box, or null when it misses it. */
function clipLine(p: Vec2, d: Vec2, min: Vec2, max: Vec2): [Vec2, Vec2] | null {
  let t0 = Number.NEGATIVE_INFINITY;
  let t1 = Number.POSITIVE_INFINITY;
  for (let k = 0; k < 2; k++) {
    const pk = p[k] as number;
    const dk = d[k] as number;
    const lo = min[k] as number;
    const hi = max[k] as number;
    if (Math.abs(dk) < 1e-12) {
      if (pk < lo || pk > hi) return null;
      continue;
    }
    const a = (lo - pk) / dk;
    const b = (hi - pk) / dk;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  if (!(t1 > t0)) return null;
  return [
    [p[0] + d[0] * t0, p[1] + d[1] * t0],
    [p[0] + d[0] * t1, p[1] + d[1] * t1],
  ];
}

/** How far construction lines run past the part on the sheet (ISO 128: a few mm), sheet mm. */
export const CONSTRUCTION_OVERRUN = 3;

/**
 * One construction anchor as a view shows it, or null when the view cannot show it: a line or an
 * axis seen end-on, a plane not seen edge-on, an oblique circle. Lines are spanned across the
 * view's part bounds plus `CONSTRUCTION_OVERRUN` sheet mm; a line that misses them is not shown.
 */
export function projectConstruction(
  v: SolvedView,
  name: string,
  anchor: AnnotationAnchor,
): ConstructionShape | null {
  const f = v.frame;
  const m = CONSTRUCTION_OVERRUN / v.scale;
  const min: Vec2 = [v.bounds.min[0] - m, v.bounds.min[1] - m];
  const max: Vec2 = [v.bounds.max[0] + m, v.bounds.max[1] + m];
  const flat = (d: Vec3): Vec2 | null => {
    const q: Vec2 = [dot3(d, f.x), dot3(d, f.y)];
    const l = Math.hypot(q[0], q[1]);
    const L = Math.hypot(d[0], d[1], d[2]);
    return l < 1e-6 * Math.max(1, L) ? null : [q[0] / l, q[1] / l];
  };
  const spanned = (p3: Vec3, d: Vec2 | null): ConstructionShape | null => {
    if (!d) return null;
    const seg = clipLine(projectToView(f, p3), d, min, max);
    return seg ? { kind: 'line', name, a: seg[0], b: seg[1] } : null;
  };
  switch (anchor.kind) {
    case 'point':
      return { kind: 'point', name, at: projectToView(f, anchor.at) };
    case 'line':
      return spanned(
        anchor.a,
        flat([anchor.b[0] - anchor.a[0], anchor.b[1] - anchor.a[1], anchor.b[2] - anchor.a[2]]),
      );
    case 'axis':
      return spanned(anchor.origin, flat(anchor.direction));
    case 'plane': {
      const n = norm3(anchor.normal);
      if (Math.abs(dot3(n, f.n)) > 1e-6) return null;
      const n2 = flat(n);
      return spanned(anchor.origin, n2 ? [-n2[1], n2[0]] : null);
    }
    case 'circle': {
      const n = norm3(anchor.normal);
      const c = Math.abs(dot3(n, f.n));
      const center = projectToView(f, anchor.center);
      if (Math.abs(c - 1) < 1e-6) return { kind: 'circle', name, center, radius: anchor.radius };
      if (c > 1e-6) return null;
      // Seen side-on: the circle is a line across its diameter, running past it like a centre line.
      const along = flat(n);
      if (!along) return null;
      const across: Vec2 = [-along[1], along[0]];
      const r = anchor.radius + m;
      return {
        kind: 'line',
        name,
        a: [center[0] - across[0] * r, center[1] - across[1] * r],
        b: [center[0] + across[0] * r, center[1] + across[1] * r],
      };
    }
    default:
      return null;
  }
}

const TOL = 1e-5;

function coincident(p: ConstructionShape, q: ConstructionShape): boolean {
  if (p.kind !== q.kind) return false;
  if (p.kind === 'point' && q.kind === 'point')
    return Math.hypot(p.at[0] - q.at[0], p.at[1] - q.at[1]) < TOL;
  if (p.kind === 'circle' && q.kind === 'circle')
    return (
      Math.hypot(p.center[0] - q.center[0], p.center[1] - q.center[1]) < TOL &&
      Math.abs(p.radius - q.radius) < TOL
    );
  if (p.kind === 'line' && q.kind === 'line') {
    const dp = norm2([p.b[0] - p.a[0], p.b[1] - p.a[1]]);
    const dq = norm2([q.b[0] - q.a[0], q.b[1] - q.a[1]]);
    if (Math.abs(cross2(dp, dq)) > 1e-9) return false;
    // q's point off p's infinite line.
    const w: Vec2 = [q.a[0] - p.a[0], q.a[1] - p.a[1]];
    return Math.abs(cross2(dp, w)) < TOL;
  }
  return false;
}

/** Origin refs first (in the given order), then the rest in the given (history) order. */
function byPriority<T extends { name: string }>(list: readonly T[]): T[] {
  return [...list.filter((c) => ORIGIN.test(c.name)), ...list.filter((c) => !ORIGIN.test(c.name))];
}

/**
 * The candidates a view shows, projected and deduplicated: one shape per distinct geometry, the
 * first by priority (the origin, then history order). Names are never merged: the shape kept is
 * the one whose exact name a pick stores.
 */
export function constructionShapes(
  v: SolvedView,
  candidates: readonly ConstructionCandidate[],
): ConstructionShape[] {
  const kept: ConstructionShape[] = [];
  const seen = new Set<string>();
  for (const c of byPriority(candidates)) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    const s = projectConstruction(v, c.name, c.anchor);
    if (!s || kept.some((k) => coincident(k, s))) continue;
    kept.push(s);
  }
  return kept;
}

/** Half the arm of a construction point's cross, sheet mm. */
export const CONSTRUCTION_POINT_ARM = 2.5;

/** Display items of shapes on a view: thin chain lines (role `center`), sourced by their name. */
export function constructionItems(
  v: SolvedView,
  shapes: readonly ConstructionShape[],
): DisplayItem[] {
  const out: DisplayItem[] = [];
  for (const s of shapes) {
    const source: ItemSource = { kind: 'view', viewId: v.view.id, construction: s.name };
    if (s.kind === 'line')
      out.push({
        kind: 'line',
        a: viewToSheet(v, s.a),
        b: viewToSheet(v, s.b),
        role: 'center',
        source,
      });
    else if (s.kind === 'circle')
      out.push({
        kind: 'arc',
        center: viewToSheet(v, s.center),
        radius: s.radius * v.scale,
        start: 0,
        end: TAU,
        role: 'center',
        source,
      });
    else {
      const c = viewToSheet(v, s.at);
      const e = CONSTRUCTION_POINT_ARM;
      out.push(
        { kind: 'line', a: [c[0] - e, c[1]], b: [c[0] + e, c[1]], role: 'center', source },
        { kind: 'line', a: [c[0], c[1] - e], b: [c[0], c[1] + e], role: 'center', source },
      );
    }
  }
  return out;
}

/**
 * The construction refs the placements on one view use, with the anchors their resolutions give
 * (ADR-095): what `compose` draws as thin chain lines. A ref that did not resolve has no anchor and
 * draws nothing; a suppressed annotation draws nothing. In placement order, one per name.
 */
export function usedConstruction(
  placements: readonly AnnotationPlacement[],
  annotations: ReadonlyMap<Id, Annotation>,
  resolutions: ReadonlyMap<Id, AnnotationResolution>,
  isConstruction: (name: string) => boolean = defaultIsConstruction,
): ConstructionCandidate[] {
  const out: ConstructionCandidate[] = [];
  const seen = new Set<string>();
  for (const p of placements) {
    const a = annotations.get(p.annotationId);
    const res = resolutions.get(p.annotationId);
    if (!a || a.suppressed || !res || res.state === 'suppressed') continue;
    a.refs.forEach((ref, i) => {
      const anchor = res.anchors?.[i];
      if (!anchor || seen.has(ref.name) || !isConstruction(ref.name)) return;
      seen.add(ref.name);
      out.push({ name: ref.name, anchor });
    });
  }
  return out;
}
