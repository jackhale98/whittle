/**
 * "Import model annotations" (PLAN §12 M4, ADR-090 §6): a deterministic, previewed plan that
 *
 *  1. lists candidates: the part's annotations not yet placed in this drawing (checked by
 *     default) and the driving sketch and feature dimensions that can be promoted (unchecked:
 *     they carry no tolerance);
 *  2. picks for each the view where it is seen true length (linear: direction in the view
 *     plane; diameters and callouts: the circle face-on; angles: the angle's plane), breaking
 *     ties by visible refs, then longer projected length, then base before projected, then id;
 *  3. never places an annotation twice in a drawing, and never promotes a source that already
 *     has an annotation (that annotation is placed instead);
 *  4. assigns lanes per view side, shortest nearest the outline, sharing a lane when spans do
 *     not overlap (text overlaps move outward);
 *  5. commits as one `placeAnnotations` command.
 *
 * Geometry comes from the regen's resolutions for existing annotations, and from sketch frames
 * plus an injected anchor resolver for promoted ones. A candidate with no geometry is listed with
 * the reason; nothing is placed on a guessed view.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Annotation,
  AnnotationAnchor,
  AnnotationPlacement,
  AnnotationResolution,
  AnnotationSource,
  Command,
  DimensionConstraint,
  Drawing,
  EntityRef,
  Feature,
  Id,
  Part,
  RefPoint,
  SketchFeature,
  Vec2,
  Vec3,
  ViewProjection,
} from '@wren-cad/contracts';
import { dist2, dot2, dot3, len3, norm2, norm3, sub2 } from '../annotation/geom';
import {
  anchorDirection,
  anchorPoints,
  projectCircle,
  projectedSegment,
  spanNormal,
} from '../placement/anchors';
import { partToSheet, type SolvedView, type ViewSolution, viewOutline } from '../view/solve';

export interface SketchFrame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export interface ImportInput {
  drawing: Drawing;
  part: Part;
  views: ReadonlyMap<Id, ViewSolution>;
  /** Regen resolutions of the part's annotations (in the drawing's configuration). */
  resolutions: ReadonlyMap<Id, AnnotationResolution>;
  /** Projections per view, for the "visible refs" tie-break. */
  projections?: ReadonlyMap<Id, ViewProjection>;
  /** Sketch plane frames by sketch feature id (`SketchResult.frame`). */
  sketchFrames?: ReadonlyMap<Id, SketchFrame>;
  /** Geometry of a model entity for promoted dimensions (drawing worker or regen). */
  resolveAnchor?: (ref: EntityRef, at?: RefPoint) => AnnotationAnchor | undefined;
  /** Mints ids (ULIDs) for promoted annotations and new placements, in call order. */
  newId: () => Id;
}

export type CandidateReason = 'needsAttention' | 'suppressed' | 'noSuitableView' | 'noGeometry';

export interface ImportCandidate {
  /** Stable key: `annotation:<id>`, `sketch:<feature>:<constraint>`, `feature:<feature>:<path>`. */
  key: string;
  kind: 'existing' | 'promote';
  /** The existing annotation, or the promoted one to create (with its id already minted). */
  annotation: Annotation;
  checked: boolean;
  viewId?: Id;
  placement?: AnnotationPlacement;
  /** Why it cannot be placed (then `viewId` and `placement` are absent). */
  reason?: CandidateReason;
}

export interface NotPromotable {
  featureId: Id;
  path: string;
  message: string;
}

export interface ImportPlan {
  candidates: ImportCandidate[];
  /** Annotations already placed in this drawing (never placed again). */
  alreadyPlaced: Id[];
  /** Driving values import cannot promote in M4; the panel offers the dimension tool instead. */
  notPromotable: NotPromotable[];
}

// ---------------------------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------------------------

function sourceKey(s: AnnotationSource): string {
  switch (s.kind) {
    case 'sketchDimension':
      return `sketch:${s.featureId}:${s.constraintId}`;
    case 'featureField':
      return `feature:${s.featureId}:${s.path}`;
    case 'feature':
      return `feature:${s.featureId}:`;
  }
}

function sketchRef(f: SketchFeature, id: Id): EntityRef {
  const e = f.entities.find((x) => x.id === id);
  const point = e?.kind === 'point' || id === '@origin';
  return { name: `S${f.id}:${point ? 'p' : 'e'}(${id})`, kind: point ? 'vertex' : 'edge' };
}

/** An annotation without its id (distributes over the union, unlike `Omit`). */
export type AnnotationDraft = Annotation extends infer A
  ? A extends Annotation
    ? Omit<A, 'id'>
    : never
  : never;

interface Promotion {
  key: string;
  draft: AnnotationDraft;
  /** Geometry hints for the view choice. */
  hint:
    | { kind: 'inPlane'; normal: Vec3; direction?: Vec3 }
    | { kind: 'direction'; direction: Vec3 }
    | { kind: 'circleNormal'; normal: Vec3 }
    | { kind: 'anchors' };
}

function promoteSketch(
  f: SketchFeature,
  c: DimensionConstraint,
  frame: SketchFrame | undefined,
): Promotion | NotPromotable {
  const source: AnnotationSource = { kind: 'sketchDimension', featureId: f.id, constraintId: c.id };
  const key = sourceKey(source);
  const origin = { kind: 'model' as const };
  const kindOf = (id: Id) =>
    f.entities.find((e) => e.id === id)?.kind ?? (id === '@origin' ? 'point' : 'line');
  const normal = frame?.z;
  if (!normal)
    return {
      featureId: f.id,
      path: `/constraints/${c.id}`,
      message: 'The sketch plane is not known yet',
    };
  switch (c.kind) {
    case 'hDistance':
    case 'vDistance': {
      const direction = c.kind === 'hDistance' ? frame.x : frame.y;
      return {
        key,
        draft: {
          kind: 'linear',
          origin,
          refs: [sketchRef(f, c.a), sketchRef(f, c.b)],
          direction,
          source,
        },
        hint: { kind: 'inPlane', normal, direction },
      };
    }
    case 'distance': {
      const points = kindOf(c.a) === 'point' && kindOf(c.b) === 'point';
      return {
        key,
        draft: points
          ? { kind: 'aligned', origin, refs: [sketchRef(f, c.a), sketchRef(f, c.b)], source }
          : { kind: 'linear', origin, refs: [sketchRef(f, c.a), sketchRef(f, c.b)], source },
        hint: { kind: 'inPlane', normal },
      };
    }
    case 'length': {
      const line = f.entities.find((e) => e.id === c.line);
      if (line?.kind !== 'line')
        return {
          featureId: f.id,
          path: `/constraints/${c.id}`,
          message: 'Only straight lengths can be promoted',
        };
      return {
        key,
        draft: {
          kind: 'aligned',
          origin,
          refs: [sketchRef(f, line.start), sketchRef(f, line.end)],
          source,
        },
        hint: { kind: 'inPlane', normal },
      };
    }
    case 'radius':
    case 'diameter':
      return {
        key,
        draft: { kind: c.kind, origin, refs: [sketchRef(f, c.curve)], source },
        hint: { kind: 'circleNormal', normal },
      };
    case 'angle':
      return {
        key,
        draft: { kind: 'angle', origin, refs: [sketchRef(f, c.a), sketchRef(f, c.b)], source },
        hint: { kind: 'inPlane', normal },
      };
    case 'offset':
      return {
        featureId: f.id,
        path: `/constraints/${c.id}`,
        message: 'Offset dimensions are not promotable in M4: use the dimension tool',
      };
  }
}

/** The sketch id a profile or point name comes from (`S<id>:…`). */
function sketchIdOf(name: string | undefined): Id | undefined {
  const m = name ? /^S([^:]+):/.exec(name) : null;
  return m?.[1];
}

function promoteFeature(
  f: Feature,
  frames: ReadonlyMap<Id, SketchFrame>,
): (Promotion | NotPromotable)[] {
  const origin = { kind: 'model' as const };
  const out: (Promotion | NotPromotable)[] = [];
  const no = (path: string, message: string) => out.push({ featureId: f.id, path, message });
  switch (f.type) {
    case 'extrude': {
      if (f.end.kind !== 'blind') break;
      const sk = sketchIdOf(f.profile[0]?.name);
      const z = sk ? frames.get(sk)?.z : undefined;
      if (!z) {
        no('/end/depth', 'The profile sketch plane is not known yet');
        break;
      }
      const source: AnnotationSource = {
        kind: 'featureField',
        featureId: f.id,
        path: '/end/depth',
      };
      out.push({
        key: sourceKey(source),
        draft: {
          kind: 'linear',
          origin,
          refs: [
            { name: `F${f.id}:start`, kind: 'face' },
            { name: `F${f.id}:end`, kind: 'face' },
          ],
          direction: z,
          source,
        },
        hint: { kind: 'direction', direction: z },
      });
      break;
    }
    case 'fillet': {
      const edge = f.edges[0];
      if (!edge) break;
      const source: AnnotationSource = { kind: 'featureField', featureId: f.id, path: '/radius' };
      out.push({
        key: sourceKey(source),
        draft: {
          kind: 'radius',
          origin,
          refs: [{ name: `F${f.id}:fillet(${edge.name})`, kind: 'face' }],
          source,
        },
        hint: { kind: 'anchors' },
      });
      break;
    }
    case 'chamfer': {
      const edge = f.edges[0];
      if (!edge) break;
      const source: AnnotationSource = { kind: 'feature', featureId: f.id };
      out.push({
        key: sourceKey(source),
        draft: {
          kind: 'chamfer',
          origin,
          form:
            f.mode.kind === 'distanceAngle' || f.mode.kind === 'distance'
              ? 'distanceAngle'
              : 'twoDistances',
          refs: [{ name: `F${f.id}:chamfer(${edge.name})`, kind: 'face' }],
          source,
        },
        hint: { kind: 'anchors' },
      });
      break;
    }
    case 'hole': {
      const sk = sketchIdOf(f.points[0]?.name);
      const z = sk ? frames.get(sk)?.z : undefined;
      const source = { kind: 'feature' as const, featureId: f.id };
      if (!z) {
        no('', 'The hole sketch plane is not known yet');
        break;
      }
      out.push({
        key: sourceKey(source),
        draft: { kind: 'holeCallout', origin, refs: [], source },
        hint: { kind: 'circleNormal', normal: z },
      });
      break;
    }
    case 'revolve': {
      const source: AnnotationSource = { kind: 'featureField', featureId: f.id, path: '/angle' };
      out.push({
        key: sourceKey(source),
        draft: {
          kind: 'angle',
          origin,
          refs: [
            { name: `F${f.id}:start`, kind: 'face' },
            { name: `F${f.id}:end`, kind: 'face' },
          ],
          source,
        },
        hint: { kind: 'anchors' },
      });
      break;
    }
    case 'shell':
      no('/thickness', 'Shell thickness is not promotable in M4: use the dimension tool');
      break;
    case 'draft':
      no('/angle', 'Draft angles are not promotable in M4: use the dimension tool');
      break;
    case 'linearPattern':
    case 'circularPattern':
      no('', 'Pattern spacing is not promotable in M4: use the dimension tool');
      break;
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// View choice
// ---------------------------------------------------------------------------------------------

const KIND_ORDER: Record<string, number> = { base: 0, projected: 1, section: 2, detail: 3, iso: 4 };
const TOL = 1e-6;

interface ViewScore {
  view: SolvedView;
  visible: number;
  length: number;
}

function anchorsSuit(
  a: Annotation,
  anchors: (AnnotationAnchor | null)[],
  v: SolvedView,
): number | null {
  const n = v.frame.n;
  const pts = (an: AnnotationAnchor | null | undefined, at?: RefPoint) =>
    an ? anchorPoints(an, at).map((p) => partToSheet(v, p)) : [];
  switch (a.kind) {
    case 'linear':
    case 'ordinate': {
      const d = a.direction ?? (anchors[0]?.kind === 'plane' ? anchors[0].normal : undefined);
      if (!d || Math.abs(dot3(norm3(d), n)) > TOL) return null;
      const u = norm2([dot3(d, v.frame.x), dot3(d, v.frame.y)]);
      const p0 = pts(anchors[0], a.at?.[0]);
      const p1 = pts(anchors[1], a.at?.[1]);
      if (!p0.length || !p1.length) return null;
      const s = (ps: Vec2[]) => ps.reduce((acc, p) => acc + dot2(p, u), 0) / ps.length;
      return Math.abs(s(p1) - s(p0));
    }
    case 'aligned': {
      const [a0, a1] = [anchors[0], anchors[1]];
      if (!a0 || !a1) return null;
      const P = anchorPoints(a0, a.at?.[0])[0];
      const Q = anchorPoints(a1, a.at?.[1])[0];
      if (!P || !Q) return null;
      const d: Vec3 = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]];
      if (len3(d) < 1e-9 || Math.abs(dot3(d, n)) > TOL * len3(d)) return null;
      return dist2(partToSheet(v, P), partToSheet(v, Q));
    }
    case 'radius':
    case 'diameter':
    case 'holeCallout': {
      const an = anchors[0];
      if (an?.kind !== 'circle') return null;
      const pc = projectCircle(v, an);
      return pc.kind === 'faceOn' ? 2 * pc.radius : null;
    }
    case 'angle': {
      const d0 = anchors[0] ? anchorDirection(anchors[0]) : null;
      const d1 = anchors[1] ? anchorDirection(anchors[1]) : null;
      const planes = anchors.filter(
        (x): x is Extract<AnnotationAnchor, { kind: 'plane' }> => x?.kind === 'plane',
      );
      let sn: Vec3 | null = null;
      if (d0 && d1) sn = spanNormal(d0, d1);
      else if (planes[0] && planes[1]) sn = spanNormal(planes[0].normal, planes[1].normal);
      if (!sn || Math.abs(Math.abs(dot3(sn, n)) - 1) > TOL) return null;
      return 1;
    }
    case 'chamfer':
    case 'datumFeature':
    case 'surfaceFinish':
    case 'geometricTolerance': {
      const an = anchors[0];
      if (!an) return null;
      if (an.kind === 'circle') {
        const pc = projectCircle(v, an);
        return pc.kind === 'oblique' ? null : pc.radius;
      }
      const seg = projectedSegment(v, an);
      return seg ? dist2(seg[0], seg[1]) : null;
    }
    case 'note':
      return anchors[0] ? 1 : null;
  }
}

function hintSuit(h: Promotion['hint'], v: SolvedView): number | null {
  const n = v.frame.n;
  switch (h.kind) {
    case 'inPlane':
    case 'circleNormal':
      return Math.abs(Math.abs(dot3(norm3(h.normal), n)) - 1) < TOL ? 1 : null;
    case 'direction':
      return Math.abs(dot3(norm3(h.direction), n)) < TOL ? 1 : null;
    case 'anchors':
      return null;
  }
}

function visibleRefs(a: Annotation, proj: ViewProjection | undefined): number {
  if (!proj) return 0;
  const visible = new Set(
    proj.curves.filter((c) => c.role === 'visible' && c.name).map((c) => c.name),
  );
  return a.refs.filter((r) => visible.has(r.name)).length;
}

function chooseView(
  a: Annotation,
  suit: (v: SolvedView) => number | null,
  input: ImportInput,
): SolvedView | undefined {
  const scores: ViewScore[] = [];
  for (const sol of input.views.values()) {
    if (!sol.ok) continue;
    if (sol.view.kind === 'iso' && a.kind !== 'note') continue;
    const len = suit(sol);
    if (len === null) continue;
    scores.push({
      view: sol,
      visible: visibleRefs(a, input.projections?.get(sol.view.id)),
      length: len * sol.scale,
    });
  }
  scores.sort(
    (x, y) =>
      y.visible - x.visible ||
      y.length - x.length ||
      (KIND_ORDER[x.view.view.kind] ?? 9) - (KIND_ORDER[y.view.view.kind] ?? 9) ||
      (x.view.view.id < y.view.view.id ? -1 : x.view.view.id > y.view.view.id ? 1 : 0),
  );
  return scores[0]?.view;
}

// ---------------------------------------------------------------------------------------------
// Layout of the chosen placements
// ---------------------------------------------------------------------------------------------

type LaneSide = 'top' | 'bottom' | 'left' | 'right';

interface LaneItem {
  key: string;
  side: LaneSide;
  span: [number, number];
  length: number;
  set: (lane: number) => void;
}

function laneSideAndSpan(
  a: Annotation,
  anchors: (AnnotationAnchor | null)[] | undefined,
  hint: Promotion['hint'] | undefined,
  v: SolvedView,
): { side: LaneSide; span: [number, number] } | null {
  let d: Vec3 | undefined;
  if (a.kind === 'linear' || a.kind === 'ordinate') d = a.direction;
  if (!d && hint && 'direction' in hint) d = hint.direction;
  if (!d && anchors?.[0]?.kind === 'plane') d = anchors[0].normal;
  const o = viewOutline(v);
  const cx = (o.min[0] + o.max[0]) / 2;
  const cy = (o.min[1] + o.max[1]) / 2;
  let pts: Vec2[] = [];
  if (anchors)
    pts = anchors.flatMap((an, i) =>
      an ? anchorPoints(an, a.at?.[i]).map((p) => partToSheet(v, p)) : [],
    );
  const mid: Vec2 = pts.length
    ? [
        pts.reduce((s, p) => s + p[0], 0) / pts.length,
        pts.reduce((s, p) => s + p[1], 0) / pts.length,
      ]
    : [cx, cy];
  if (!d) {
    if (a.kind !== 'aligned' || pts.length < 2) return null;
    const dd = sub2(pts[pts.length - 1] as Vec2, pts[0] as Vec2);
    d = [dd[0], dd[1], 0];
    const u = norm2(dd);
    if (Math.abs(u[1]) > TOL && Math.abs(u[0]) > TOL) return null;
    return Math.abs(u[1]) <= TOL
      ? { side: mid[1] < cy ? 'bottom' : 'top', span: spanOf(pts, 0) }
      : { side: mid[0] < cx ? 'left' : 'right', span: spanOf(pts, 1) };
  }
  const u = norm2([dot3(d, v.frame.x), dot3(d, v.frame.y)]);
  if (Math.abs(u[1]) <= TOL)
    return {
      side: mid[1] < cy ? 'bottom' : 'top',
      span: pts.length ? spanOf(pts, 0) : [o.min[0], o.max[0]],
    };
  if (Math.abs(u[0]) <= TOL)
    return {
      side: mid[0] < cx ? 'left' : 'right',
      span: pts.length ? spanOf(pts, 1) : [o.min[1], o.max[1]],
    };
  return null;
}

function spanOf(pts: Vec2[], axis: 0 | 1): [number, number] {
  const xs = pts.map((p) => p[axis]);
  return [Math.min(...xs), Math.max(...xs)];
}

/** Greedy lane packing: shortest first; a lane is shared when spans (plus text room) don't overlap. */
function assignLanes(
  items: LaneItem[],
  occupied: Map<string, [number, number][][]>,
  margin: number,
): void {
  const sorted = [...items].sort((a, b) => a.length - b.length || (a.key < b.key ? -1 : 1));
  for (const it of sorted) {
    const key = it.side;
    const lanes = occupied.get(key) ?? [];
    let lane = 0;
    for (; ; lane++) {
      const used = lanes[lane] ?? [];
      const clash = used.some(([a, b]) => it.span[0] < b + margin && a < it.span[1] + margin);
      if (!clash) break;
    }
    const row = lanes[lane] ?? [];
    row.push(it.span);
    lanes[lane] = row;
    occupied.set(key, lanes);
    it.set(lane);
  }
}

function defaultLayout(a: Annotation, style: Drawing['style']): AnnotationPlacement['layout'] {
  const h = style.text.dimension;
  switch (a.kind) {
    case 'radius':
    case 'diameter':
      return { kind: 'radial', angle: 45, distance: 2 * h };
    case 'angle':
      return { kind: 'arc', radius: 6 * h };
    case 'datumFeature':
      return { kind: 'leader', attach: { kind: 'ref', index: 0 }, text: [0, -4 * h] };
    case 'surfaceFinish':
      return { kind: 'leader', attach: { kind: 'ref', index: 0 }, text: [0, 0] };
    default:
      return { kind: 'leader', attach: { kind: 'ref', index: 0 }, text: [4 * h, 4 * h] };
  }
}

/** Builds the import plan (deterministic for a given `newId` sequence). */
export function planImport(input: ImportInput): ImportPlan {
  const { drawing, part } = input;
  const annotations = [...(part.annotations ?? [])].sort((x, y) => (x.id < y.id ? -1 : 1));
  const placedIds = new Set(drawing.placements.map((p) => p.annotationId));
  const alreadyPlaced = annotations.filter((a) => placedIds.has(a.id)).map((a) => a.id);
  const sourced = new Map<string, Annotation>();
  for (const a of annotations) {
    const s = 'source' in a ? a.source : undefined;
    if (s) sourced.set(sourceKey(s), a);
  }

  interface Pending {
    key: string;
    kind: 'existing' | 'promote';
    annotation: Annotation;
    checked: boolean;
    anchors?: (AnnotationAnchor | null)[];
    hint?: Promotion['hint'];
    reason?: CandidateReason;
  }
  const pending: Pending[] = [];

  for (const a of annotations) {
    if (placedIds.has(a.id)) continue;
    const r = input.resolutions.get(a.id);
    const base = { key: `annotation:${a.id}`, kind: 'existing' as const, annotation: a };
    if (a.suppressed || r?.state === 'suppressed')
      pending.push({ ...base, checked: false, reason: 'suppressed' });
    else if (r?.state !== 'ok') pending.push({ ...base, checked: false, reason: 'needsAttention' });
    else pending.push({ ...base, checked: true, anchors: r.anchors ?? [] });
  }

  const notPromotable: NotPromotable[] = [];
  const frames = input.sketchFrames ?? new Map();
  const promotions: Promotion[] = [];
  const active = part.features.slice(0, part.rollbackIndex).filter((f) => !f.suppressed);
  for (const f of active) {
    if (f.type === 'sketch') {
      for (const c of f.constraints) {
        if (!('value' in c) || !(c as DimensionConstraint).driving) continue;
        const p = promoteSketch(f, c as DimensionConstraint, frames.get(f.id));
        if ('draft' in p) promotions.push(p);
        else notPromotable.push(p);
      }
    } else {
      for (const p of promoteFeature(f, frames)) {
        if ('draft' in p) promotions.push(p);
        else notPromotable.push(p);
      }
    }
  }
  promotions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const p of promotions) {
    if (sourced.has(p.key)) continue; // already an annotation: listed above as existing
    const annotation = { ...p.draft, id: input.newId() } as Annotation;
    let anchors: (AnnotationAnchor | null)[] | undefined;
    if (p.hint.kind === 'anchors' || input.resolveAnchor) {
      const got = annotation.refs.map(
        (r, i) => input.resolveAnchor?.(r, annotation.at?.[i]) ?? null,
      );
      if (got.length && got.every(Boolean)) anchors = got;
    }
    pending.push({
      key: p.key,
      kind: 'promote',
      annotation,
      checked: false,
      ...(anchors ? { anchors } : {}),
      hint: p.hint,
      ...(p.hint.kind === 'anchors' && !anchors ? { reason: 'noGeometry' as const } : {}),
    });
  }

  // View choice.
  const candidates: ImportCandidate[] = [];
  const chosen: { c: ImportCandidate; view: SolvedView; p: Pending }[] = [];
  // Frames bound to a size dimension go last, preferring that dimension's view.
  const bound = (p: Pending) =>
    p.annotation.kind === 'geometricTolerance' && !!p.annotation.appliesTo;
  const viewOf = new Map<Id, Id>();
  for (const pl of drawing.placements) viewOf.set(pl.annotationId, pl.viewId);
  const ordered = [...pending.filter((p) => !bound(p)), ...pending.filter(bound)];
  const slot = new Map(pending.map((p, i) => [p, i]));
  const byIndex: ImportCandidate[] = [];
  for (const p of ordered) {
    const c: ImportCandidate = {
      key: p.key,
      kind: p.kind,
      annotation: p.annotation,
      checked: p.checked,
    };
    byIndex[slot.get(p) ?? 0] = c;
    if (p.reason) {
      c.reason = p.reason;
      c.checked = false;
      continue;
    }
    const suit = (v: SolvedView) =>
      p.anchors ? anchorsSuit(p.annotation, p.anchors, v) : p.hint ? hintSuit(p.hint, v) : null;
    const a = p.annotation;
    const preferId =
      a.kind === 'geometricTolerance' && a.appliesTo ? viewOf.get(a.appliesTo) : undefined;
    const preferred = preferId ? input.views.get(preferId) : undefined;
    const view = preferred?.ok && suit(preferred) !== null ? preferred : chooseView(a, suit, input);
    if (!view) {
      c.reason = 'noSuitableView';
      c.checked = false;
      continue;
    }
    c.viewId = view.view.id;
    viewOf.set(a.id, view.view.id);
    chosen.push({ c, view, p });
  }
  candidates.push(...byIndex.filter(Boolean));

  // Layout: lanes for linear kinds, defaults otherwise; frames go under their size dimension.
  const style = drawing.style;
  const laneItems = new Map<Id, LaneItem[]>();
  for (const { c, view, p } of chosen) {
    const a = c.annotation;
    const placementId = input.newId();
    const lanes = a.kind === 'linear' || a.kind === 'aligned' || a.kind === 'ordinate';
    const ls = lanes ? laneSideAndSpan(a, p.anchors, p.hint, view) : null;
    if (lanes && ls) {
      const placement: AnnotationPlacement = {
        id: placementId,
        viewId: view.view.id,
        annotationId: a.id,
        layout: { kind: 'lane', side: ls.side, lane: 0 },
      };
      c.placement = placement;
      const list = laneItems.get(view.view.id) ?? [];
      list.push({
        key: c.key,
        side: ls.side,
        span: ls.span,
        length: ls.span[1] - ls.span[0],
        set: (lane) => {
          placement.layout = { kind: 'lane', side: ls.side, lane };
        },
      });
      laneItems.set(view.view.id, list);
    } else {
      c.placement = {
        id: placementId,
        viewId: view.view.id,
        annotationId: a.id,
        layout: lanes
          ? { kind: 'offset', distance: style.dimension.firstLane }
          : defaultLayout(a, style),
      };
    }
  }
  // Existing lane placements of the drawing occupy their lanes (the whole lane: spans unknown).
  for (const [viewId, items] of laneItems) {
    const occupied = new Map<string, [number, number][][]>();
    for (const pl of drawing.placements) {
      if (pl.viewId !== viewId || pl.layout.kind !== 'lane') continue;
      const lanes = occupied.get(pl.layout.side) ?? [];
      const row = lanes[pl.layout.lane] ?? [];
      row.push([Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]);
      lanes[pl.layout.lane] = row;
      occupied.set(pl.layout.side, lanes);
    }
    // Room for the text between neighbours sharing a lane.
    assignLanes(items, occupied, 4 * style.text.dimension);
  }
  // A frame bound to a size dimension placed in the same view sits under that dimension's text.
  const placementOf = new Map(chosen.map(({ c }) => [c.annotation.id, c.placement]));
  for (const { c } of chosen) {
    const a = c.annotation;
    if (a.kind !== 'geometricTolerance' || !a.appliesTo || !c.placement) continue;
    const target =
      placementOf.get(a.appliesTo) ??
      drawing.placements.find(
        (x) => x.annotationId === a.appliesTo && x.viewId === c.placement?.viewId,
      );
    if (target && target.viewId === c.placement.viewId)
      c.placement.layout = {
        kind: 'leader',
        attach: { kind: 'placement', placementId: target.id },
        text: [0, 0],
      };
  }
  return { candidates, alreadyPlaced, notPromotable };
}

/** The one command that commits the checked candidates (`placeAnnotations`). */
export function importCommand(
  plan: ImportPlan,
  drawingId: Id,
  checked: ReadonlySet<string> = new Set(
    plan.candidates.filter((c) => c.checked).map((c) => c.key),
  ),
): Extract<Command, { kind: 'placeAnnotations' }> {
  const items = plan.candidates
    .filter((c) => checked.has(c.key) && c.placement)
    .map((c) => ({
      placement: c.placement as AnnotationPlacement,
      ...(c.kind === 'promote' ? { annotation: c.annotation } : {}),
    }));
  return { kind: 'placeAnnotations', drawingId, items };
}
