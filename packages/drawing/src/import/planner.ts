/**
 * "Import model annotations" (PLAN §12 M4, ADR-090 §6, ADR-091): a deterministic, previewed plan
 * that
 *
 *  1. lists candidates: the part's annotations not yet placed in this drawing (checked by
 *     default) and the driving sketch and feature dimensions that can be promoted (unchecked:
 *     they carry no tolerance);
 *  2. never places a dimension twice: not an annotation already placed, not a promotion of a
 *     source that already has an annotation (that annotation is listed instead), and not a second
 *     dimension of the same measurement (same direction, same measured geometry; `dedupe.ts`),
 *     keeping the driving (sourced) one;
 *  3. picks for each the view where it is seen true length (linear: direction in the view
 *     plane; diameters and callouts: the circle face-on; angles: the angle's plane); a promotion's
 *     sketch frame or feature direction decides, its anchors give the length; then visible refs,
 *     longer projected length, base before projected, id;
 *  4. assigns lanes clear of every other view, cut line, table and the title block (`lanes.ts`):
 *     the free side, else an aligned view pushed out (`moveViews`), else `layoutDoesNotFit`,
 *     never an overlap;
 *  5. commits as one undo step: `importCommand` (one `placeAnnotations`) or, with pushed views,
 *     `importCommands` (their `updateView`s and the `placeAnnotations`, applied with one
 *     coalescing key).
 *
 * Geometry comes from the regen's resolutions for existing annotations, and for promoted ones
 * from one `annotationAnchors` call (`anchors`, see `anchors.ts`) or the sketch's own geometry. A
 * candidate with no geometry is listed with the reason; nothing is placed on a guessed view or
 * attached to a guessed entity.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  AnchorAnswer,
  Annotation,
  AnnotationAnchor,
  AnnotationPlacement,
  AnnotationResolution,
  Command,
  Drawing,
  DrawingTable,
  DrawingView,
  EntityRef,
  Expr,
  Id,
  Part,
  RefPoint,
  SketchFeature,
  Vec2,
  Vec3,
  ViewProjection,
} from '@wren-cad/contracts';
import { dist2, dot2, dot3, len3, norm2, norm3, sub2 } from '../annotation/geom';
import { layoutDimensionLabel, type TextBlock } from '../annotation/label-layout';
import { formatLength } from '../annotation/numbers';
import { textWidth } from '../annotation/text';
import { dimensionLabel, evaluateTolerance } from '../annotation/tolerance';
import {
  anchorDirection,
  anchorPoints,
  attachPoint,
  projectCircle,
  projectedSegment,
  spanNormal,
} from '../placement/anchors';
import type { TableData } from '../sheet/compose';
import { partToSheet, type SolvedView, type ViewSolution, viewOutline } from '../view/solve';
import { anchorQueryKey, sketchAnchor } from './anchors';
import { measureKey } from './dedupe';
import { type LaneRequest, type LaneSide, type LeaderRequest, planLanes } from './lanes';
import {
  type AnnotationDraft,
  collectPromotions,
  type NotPromotable,
  type PromotionHint,
  type SketchFrame,
  sourceKey,
} from './promote';

export type { AnnotationDraft, NotPromotable, SketchFrame };

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
  /**
   * Answers to `importAnchorQueries(part, sketchFrames)` from one
   * `ModelingApi.annotationAnchors` call, as `anchorLookup(queries, answers)`. Places fillet,
   * chamfer and revolve promotions, and picks extrude-depth refs that resolve.
   */
  anchors?: ReadonlyMap<string, AnchorAnswer>;
  /** Older single-ref form of `anchors` (used only when `anchors` is absent). */
  resolveAnchor?: (ref: EntityRef, at?: RefPoint) => AnnotationAnchor | undefined;
  /** Annotation expressions (tolerances), for label sizes; absent: a typical width is assumed. */
  evaluate?: (expr: Expr, kind: 'length' | 'angle') => number | undefined;
  /** Table rows (as the sheet's), so lanes keep clear of tables. */
  tables?: (table: DrawingTable) => TableData | undefined;
  /** Outline growth lanes keep free for later model edits (default 0.1 = 10 %). */
  headroom?: number;
  /**
   * Allow pushing an aligned view's distance out when a dimension fits on neither side
   * (`plan.viewMoves`, committed by `importCommands`). Default false: such a dimension is
   * reported as `layoutDoesNotFit`.
   */
  moveViews?: boolean;
  /** Mints ids (ULIDs) for promoted annotations and new placements, in call order. */
  newId: () => Id;
}

export type CandidateReason =
  | 'needsAttention'
  | 'suppressed'
  | 'noSuitableView'
  | 'noGeometry'
  /** Measures what another candidate (or a placed annotation) measures: see `duplicateOf`. */
  | 'duplicate'
  /** No lane clear of the neighbouring views, cut lines, tables and the title block. */
  | 'layoutDoesNotFit';

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
  /** `reason: 'duplicate'`: the key of the candidate kept, or `annotation:<id>` already placed. */
  duplicateOf?: string;
}

/** An aligned view pushed out to make room, and the candidates laid out with that room. */
export interface ViewMove {
  view: DrawingView;
  /** Candidate keys that need the move; it is committed when one of them is checked. */
  for: string[];
}

export interface ImportPlan {
  candidates: ImportCandidate[];
  /** Annotations already placed in this drawing (never placed again). */
  alreadyPlaced: Id[];
  /** Driving values import cannot promote in M4; the panel offers the dimension tool instead. */
  notPromotable: NotPromotable[];
  /** Views to push out (only with `moveViews`; otherwise empty). */
  viewMoves: ViewMove[];
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

function hintSuit(h: PromotionHint, v: SolvedView): number | null {
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

function laneSideAndSpan(
  a: Annotation,
  anchors: (AnnotationAnchor | null)[] | undefined,
  hint: PromotionHint | undefined,
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

/** The leader angle of a radial layout: an arc's middle, else 45°. */
function radialAngle(anchor: AnnotationAnchor | null | undefined, v: SolvedView): number {
  if (anchor?.kind !== 'circle' || !anchor.start || !anchor.end) return 45;
  const c = partToSheet(v, anchor.center);
  const s = norm2(sub2(partToSheet(v, anchor.start), c));
  const e = norm2(sub2(partToSheet(v, anchor.end), c));
  const m: Vec2 = [s[0] + e[0], s[1] + e[1]];
  if (Math.hypot(m[0], m[1]) < 1e-6) return 45;
  return Math.round((Math.atan2(m[1], m[0]) * 180) / Math.PI);
}

function defaultLayout(
  a: Annotation,
  style: Drawing['style'],
  anchors: (AnnotationAnchor | null)[] | undefined,
  v: SolvedView,
): AnnotationPlacement['layout'] {
  const h = style.text.dimension;
  switch (a.kind) {
    case 'radius':
    case 'diameter':
      return { kind: 'radial', angle: radialAngle(anchors?.[0], v), distance: 2 * h };
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

/** The label a lane dimension will show, for its size (the layout makes the real one). */
function laneLabel(
  a: Extract<Annotation, { kind: 'linear' | 'aligned' | 'ordinate' }>,
  value: number,
  input: ImportInput,
): TextBlock {
  const style = input.drawing.style;
  const tol = a.tolerance
    ? evaluateTolerance(a.tolerance, (e) => input.evaluate?.(e, 'length') ?? 0.05)
    : null;
  const label = dimensionLabel({
    value,
    quantity: 'length',
    ...(tol ? { tolerance: tol } : {}),
    ...(a.text ? { text: a.text } : {}),
    numbers: style.numbers,
    fitDeviations: () => ({ upper: 0.05, lower: -0.05 }),
  });
  return layoutDimensionLabel(label, style.text.dimension);
}

interface Pending {
  key: string;
  kind: 'existing' | 'promote';
  annotation: Annotation;
  checked: boolean;
  /** The kernel's anchors (resolution, or the anchor lookup), parallel to refs. */
  anchors?: (AnnotationAnchor | null)[];
  /** Anchors for layout and duplicates: `anchors`, else the sketch's own geometry. */
  layout?: (AnnotationAnchor | null)[];
  hint?: PromotionHint;
  reason?: CandidateReason;
  duplicateOf?: string;
}

/** The first ref choice whose refs all resolve (unmerged first), and its anchors. */
function chooseRefs(
  choices: EntityRef[][],
  draft: AnnotationDraft,
  input: ImportInput,
): { refs: EntityRef[]; anchors?: AnnotationAnchor[] } {
  const answer = (ref: EntityRef, i: number) => {
    const at = draft.at?.[i];
    return input.anchors?.get(
      anchorQueryKey({ ref, ...(at && at !== 'self' ? { at } : {}), annotationKind: draft.kind }),
    );
  };
  if (input.anchors) {
    for (const strict of [true, false])
      for (const refs of choices) {
        const got = refs.map(answer);
        if (got.length && got.every((g) => g?.anchor && (!strict || !g.merged)))
          return { refs, anchors: got.map((g) => g?.anchor as AnnotationAnchor) };
      }
    return { refs: choices[0] as EntityRef[] };
  }
  if (input.resolveAnchor)
    for (const refs of choices) {
      const got = refs.map((r, i) => input.resolveAnchor?.(r, draft.at?.[i]));
      if (got.length && got.every(Boolean)) return { refs, anchors: got as AnnotationAnchor[] };
    }
  return { refs: choices[0] as EntityRef[] };
}

/** Marks every candidate that measures what another (or a placed annotation) measures. */
function markDuplicates(pending: Pending[], annotations: Annotation[], input: ImportInput): void {
  const placedIds = new Set(input.drawing.placements.map((p) => p.annotationId));
  const placedKey = new Map<string, Id>();
  for (const a of annotations) {
    if (!placedIds.has(a.id)) continue;
    const r = input.resolutions.get(a.id);
    const k = r?.state === 'ok' ? measureKey(a, r.anchors) : null;
    if (k && !placedKey.has(k)) placedKey.set(k, a.id);
  }
  const groups = new Map<string, Pending[]>();
  for (const p of pending) {
    if (p.reason) continue;
    const k = measureKey(p.annotation, p.layout);
    if (!k) continue;
    const g = groups.get(k) ?? [];
    g.push(p);
    groups.set(k, g);
  }
  // Kept: a placed annotation; else the driving (sourced) one, an existing annotation before a
  // promotion, then the key order. The kept one is checked when a dropped one was.
  const rank = (p: Pending) =>
    ('source' in p.annotation && p.annotation.source ? 0 : 2) + (p.kind === 'existing' ? 0 : 1);
  for (const [k, g] of groups) {
    const placed = placedKey.get(k);
    const sorted = [...g].sort(
      (x, y) => rank(x) - rank(y) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
    );
    const keep = placed ? null : (sorted[0] as Pending);
    for (const p of sorted) {
      if (p === keep) continue;
      if (keep && p.checked) keep.checked = true;
      p.reason = 'duplicate';
      p.duplicateOf = keep ? keep.key : `annotation:${placed}`;
      p.checked = false;
    }
  }
}

/** Width of a radius or diameter label, or of a callout's text, for the clearance check. */
function leaderWidth(a: Annotation, value: number | undefined, style: Drawing['style']): number {
  const h = style.text.dimension;
  const num = value !== undefined ? formatLength(value, style.numbers) : '00';
  switch (a.kind) {
    case 'radius':
      return textWidth(`R${num}`, h);
    case 'diameter':
      return textWidth(`Ø${num}`, h);
    case 'chamfer':
      return textWidth('00 × 45°', h);
    case 'note':
      return Math.max(...a.text.split('\n').map((l) => textWidth(l, style.text.note)));
    default:
      return 10 * h;
  }
}

/**
 * The clearance request of a default leader or radial layout: its options in order (the default
 * first), and how an option becomes the layout.
 */
function leaderRequest(
  key: string,
  a: Annotation,
  layout: AnnotationPlacement['layout'],
  anchors: (AnnotationAnchor | null)[] | undefined,
  v: SolvedView,
  input: ImportInput,
): { request: LeaderRequest; apply: (option: number) => AnnotationPlacement['layout'] } | null {
  const style = input.drawing.style;
  const h = style.text.dimension;
  const an = anchors?.[0];
  if (!an) return null;
  if (layout.kind === 'radial') {
    if (an.kind !== 'circle') return null;
    const pc = projectCircle(v, an);
    if (pc.kind !== 'faceOn') return null;
    const base = layout.angle;
    const options = [0, 45, -45, 90, -90, 135, -135, 180].map((d) => base + d);
    const value = a.kind === 'diameter' ? (2 * pc.radius) / v.scale : pc.radius / v.scale;
    return {
      request: {
        key,
        viewId: v.view.id,
        from: pc.center,
        options,
        radius: pc.radius,
        distance: layout.distance,
        width: leaderWidth(a, value, style),
        height: 1.6 * h,
      },
      apply: (i) => ({ ...layout, angle: options[i] as number }),
    };
  }
  if (layout.kind === 'leader' && layout.attach.kind === 'ref') {
    if (a.kind === 'surfaceFinish') return null;
    const [dx, dy] = layout.text;
    const options: Vec2[] =
      dx === 0
        ? [
            [0, dy],
            [0, -dy],
            [dy, 0],
            [-dy, 0],
          ]
        : [
            [dx, dy],
            [-dx, dy],
            [dx, -dy],
            [-dx, -dy],
            [2 * dx, 2 * dy],
            [-2 * dx, 2 * dy],
            [2 * dx, -2 * dy],
            [-2 * dx, -2 * dy],
          ];
    const lines = a.kind === 'holeCallout' ? 3 : 1;
    return {
      request: {
        key,
        viewId: v.view.id,
        from: attachPoint(v, an),
        options,
        width: leaderWidth(a, undefined, style),
        height: (lines === 1 ? 2 : 1.6 * lines) * h,
      },
      apply: (i) => ({ ...layout, text: options[i] as Vec2 }),
    };
  }
  return null;
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

  const pending: Pending[] = [];
  for (const a of annotations) {
    if (placedIds.has(a.id)) continue;
    const r = input.resolutions.get(a.id);
    const base = { key: `annotation:${a.id}`, kind: 'existing' as const, annotation: a };
    if (a.suppressed || r?.state === 'suppressed')
      pending.push({ ...base, checked: false, reason: 'suppressed' });
    else if (r?.state !== 'ok') pending.push({ ...base, checked: false, reason: 'needsAttention' });
    else {
      const anchors = r.anchors ?? [];
      pending.push({ ...base, checked: true, anchors, layout: anchors });
    }
  }

  const frames = input.sketchFrames ?? new Map<Id, SketchFrame>();
  const sketches = new Map<Id, SketchFeature>();
  for (const f of part.features) if (f.type === 'sketch') sketches.set(f.id, f);
  const { promotions, notPromotable } = collectPromotions(part, frames, input.evaluate);
  for (const p of promotions) {
    if (sourced.has(p.key)) continue; // already an annotation: listed above as existing
    const chosen = chooseRefs(p.choices ?? [p.draft.refs], p.draft, input);
    const annotation = { ...p.draft, refs: chosen.refs, id: input.newId() } as Annotation;
    const anchors = chosen.anchors;
    let layout: (AnnotationAnchor | null)[] | undefined = anchors;
    if (!layout) {
      const own = annotation.refs.map((r) => sketchAnchor(r, sketches, frames) ?? null);
      if (own.length && own.every(Boolean)) layout = own;
    }
    pending.push({
      key: p.key,
      kind: 'promote',
      annotation,
      checked: false,
      ...(anchors ? { anchors } : {}),
      ...(layout ? { layout } : {}),
      hint: p.hint,
      ...(p.hint.kind === 'anchors' && !anchors ? { reason: 'noGeometry' as const } : {}),
    });
  }
  markDuplicates(pending, annotations, input);

  // View choice.
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
      if (p.duplicateOf) c.duplicateOf = p.duplicateOf;
      c.checked = false;
      continue;
    }
    // A promotion's sketch frame or feature direction decides; its anchors give the length.
    const suit = (v: SolvedView): number | null => {
      if (p.hint && p.hint.kind !== 'anchors') {
        if (hintSuit(p.hint, v) === null) return null;
        return (p.anchors ? anchorsSuit(p.annotation, p.anchors, v) : null) ?? 1;
      }
      return p.anchors ? anchorsSuit(p.annotation, p.anchors, v) : null;
    };
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
  const candidates: ImportCandidate[] = byIndex.filter(Boolean);

  // Layout: lanes for linear kinds, defaults otherwise; frames go under their size dimension.
  const style = drawing.style;
  const requests: LaneRequest[] = [];
  const leaders: LeaderRequest[] = [];
  const leaderApply = new Map<string, (option: number) => void>();
  const lanePlacement = new Map<string, AnnotationPlacement>();
  for (const { c, view, p } of chosen) {
    const a = c.annotation;
    const placementId = input.newId();
    const lanes = a.kind === 'linear' || a.kind === 'aligned' || a.kind === 'ordinate';
    const ls = lanes ? laneSideAndSpan(a, p.layout, p.hint, view) : null;
    if (lanes && ls) {
      const placement: AnnotationPlacement = {
        id: placementId,
        viewId: view.view.id,
        annotationId: a.id,
        layout: { kind: 'lane', side: ls.side, lane: 0 },
      };
      c.placement = placement;
      lanePlacement.set(c.key, placement);
      const r = c.kind === 'existing' ? input.resolutions.get(a.id) : undefined;
      const value = r?.value ?? (ls.span[1] - ls.span[0]) / view.scale;
      requests.push({
        key: c.key,
        viewId: view.view.id,
        side: ls.side,
        span: ls.span,
        label: laneLabel(a, value, input),
      });
    } else {
      const layout = lanes
        ? { kind: 'offset' as const, distance: style.dimension.firstLane }
        : defaultLayout(a, style, p.layout, view);
      const placement: AnnotationPlacement = {
        id: placementId,
        viewId: view.view.id,
        annotationId: a.id,
        layout,
      };
      c.placement = placement;
      const lr = leaderRequest(c.key, a, layout, p.layout, view, input);
      if (lr) {
        leaders.push(lr.request);
        leaderApply.set(c.key, (i) => {
          placement.layout = lr.apply(i);
        });
      }
    }
  }
  const lanePlan = planLanes({
    drawing,
    views: input.views,
    requests,
    ...(input.tables ? { tables: input.tables } : {}),
    ...(input.headroom !== undefined ? { headroom: input.headroom } : {}),
    ...(input.moveViews ? { moveViews: true } : {}),
    leaders,
  });
  for (const c of candidates) {
    const option = lanePlan.leaders.get(c.key);
    if (option !== undefined) {
      if (option === null) {
        delete c.placement;
        delete c.viewId;
        c.reason = 'layoutDoesNotFit';
        c.checked = false;
      } else leaderApply.get(c.key)?.(option);
      continue;
    }
    const placement = lanePlacement.get(c.key);
    const r = lanePlan.results.get(c.key);
    if (!placement || !r) continue;
    if ('fail' in r) {
      delete c.placement;
      delete c.viewId;
      c.reason = 'layoutDoesNotFit';
      c.checked = false;
      continue;
    }
    placement.layout = { kind: 'lane', side: r.side, lane: r.lane };
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
  const viewMoves: ViewMove[] = [...lanePlan.moved]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([id, view]) => ({ view, for: [...(lanePlan.movedFor.get(id) ?? [])].sort() }));
  return { candidates, alreadyPlaced, notPromotable, viewMoves };
}

function defaultChecked(plan: ImportPlan): Set<string> {
  return new Set(plan.candidates.filter((c) => c.checked).map((c) => c.key));
}

/** The one command that commits the checked candidates (`placeAnnotations`). */
export function importCommand(
  plan: ImportPlan,
  drawingId: Id,
  checked: ReadonlySet<string> = defaultChecked(plan),
): Extract<Command, { kind: 'placeAnnotations' }> {
  const items = plan.candidates
    .filter((c) => checked.has(c.key) && c.placement)
    .map((c) => ({
      placement: c.placement as AnnotationPlacement,
      ...(c.kind === 'promote' ? { annotation: c.annotation } : {}),
    }));
  return { kind: 'placeAnnotations', drawingId, items };
}

/**
 * Every command of the import, in order: an `updateView` for each pushed view a checked
 * candidate needs, then the `placeAnnotations`. Apply them with one coalescing key, so the import
 * stays one undo step; without pushed views this is `[importCommand(…)]`.
 */
export function importCommands(
  plan: ImportPlan,
  drawingId: Id,
  checked: ReadonlySet<string> = defaultChecked(plan),
): Command[] {
  const place = importCommand(plan, drawingId, checked);
  if (place.items.length === 0) return [place];
  const moves: Command[] = plan.viewMoves
    .filter((m) => m.for.some((k) => checked.has(k)))
    .map((m) => ({ kind: 'updateView', drawingId, view: m.view }));
  return [...moves, place];
}
