/**
 * Placement layout (ADR-090 §3.6): turns placements (intent, sheet mm, relative to the measured
 * geometry) plus the regen's annotation resolutions into display items. Lanes sit at
 * `firstLane + n · laneSpacing` outside the view outline; offsets are signed distances from the
 * measured geometry; radial, arc and leader layouts as stored. After a model change every
 * placement keeps its lane or offset, and every style size stays in sheet mm (trap T8).
 *
 * Trust rules: a value is drawn only when the resolution is `ok` (trap T1); otherwise the
 * geometry that did resolve is drawn in the needs-attention role with `?`, and nothing is
 * re-attached to a guessed entity. A layout that does not fit the annotation, or geometry seen
 * end-on in the view, is flagged, never laid out differently behind the user's back.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Annotation,
  AnnotationAnchor,
  AnnotationPlacement,
  AnnotationResolution,
  DatumRef,
  DimensionAnnotation,
  DrawingStyle,
  Expr,
  GpsStandard,
  HoleCalloutAnnotation,
  Id,
  Vec2,
} from '@wren-cad/contracts';
import {
  chamferText,
  type HoleCalloutData,
  holeCalloutLines,
  layoutDatumBox,
  layoutSurfaceFinish,
  noteLines,
} from '../annotation/callouts';
import {
  angularLayout,
  type DimensionGeometry,
  leaderLayout,
  linearLayout,
  radialLayout,
} from '../annotation/dimension-layout';
import type { DisplayItem, Primitive } from '../annotation/display';
import { layoutFrame } from '../annotation/gdt';
import {
  add2,
  angle2,
  type Box2,
  dist2,
  dot2,
  dot3,
  lerp2,
  norm2,
  perp2,
  scale2,
  sub2,
} from '../annotation/geom';
import { layoutDimensionLabel, layoutLines, type TextBlock } from '../annotation/label-layout';
import { placeSymbol } from '../annotation/symbols';
import {
  dimensionLabel,
  evaluateTolerance,
  type FitDeviationLookup,
  type SizeSymbol,
  type TextRun,
} from '../annotation/tolerance';
import { type SolvedView, viewOutline } from '../view/solve';
import {
  anchorDirection,
  attachPoint,
  isSurfaceFaceOn,
  projectCircle,
  projectedSegment,
  sheetPoints,
  spanNormal,
  viewDirection,
} from './anchors';

/** Placement-level problems (the drawing's needs-attention panel lists them). */
export type PlacementIssue =
  | { kind: 'notMeasurableInView'; viewId: Id }
  | {
      kind: 'layoutDoesNotFit';
      layout: AnnotationPlacement['layout']['kind'];
      annotation: Annotation['kind'];
    }
  | { kind: 'anchorsMissing' }
  | { kind: 'attachTargetMissing'; placementId: Id }
  | { kind: 'directionMissing' };

export interface PlacedAnnotation {
  placementId: Id;
  annotationId: Id;
  viewId: Id;
  items: DisplayItem[];
  /** Label outline on the sheet (overlap checks, picking, the panel's grid zone). */
  textBox: Vec2[];
  /** Dimension line between the arrow tips (attach `dimensionLine`). */
  line?: [Vec2, Vec2];
  /** Needs attention: drawn in the attention role, no value. */
  attention: boolean;
  /** Not in this configuration: nothing drawn (listed quietly). */
  suppressed: boolean;
  issues: PlacementIssue[];
}

/** Model data for callouts whose numbers come from a feature (hole, thread, chamfer). */
export interface FeatureCalloutData {
  hole?: (a: HoleCalloutAnnotation) => HoleCalloutData | undefined;
  chamfer?: (
    a: Extract<Annotation, { kind: 'chamfer' }>,
  ) => { distance?: number; angle?: number; distance2?: number } | undefined;
}

export interface PlacementContext {
  view: SolvedView;
  style: DrawingStyle;
  /** The displaying drawing's GPS standard (frame presentation). */
  standard: GpsStandard;
  /** Evaluates annotation `Expr`s: lengths in mm, angles in rad. */
  evaluate: (expr: Expr, kind: 'length' | 'angle') => number | undefined;
  fitDeviations?: FitDeviationLookup;
  /** Every annotation of the part by id (datum letters, `appliesTo`). */
  annotations: ReadonlyMap<Id, Annotation>;
  resolutions: ReadonlyMap<Id, AnnotationResolution>;
  features?: FeatureCalloutData;
  /** Placements already laid out (leader attach to another placement). */
  placed: ReadonlyMap<Id, PlacedAnnotation>;
}

const DIMENSION_KINDS = new Set<Annotation['kind']>([
  'linear',
  'aligned',
  'ordinate',
  'radius',
  'diameter',
  'angle',
  'chamfer',
]);

function isDimension(a: Annotation): a is DimensionAnnotation {
  return DIMENSION_KINDS.has(a.kind);
}

/** Layout kinds each annotation kind accepts (anything else is flagged). */
export function layoutFits(a: Annotation, layout: AnnotationPlacement['layout']['kind']): boolean {
  switch (a.kind) {
    case 'linear':
    case 'aligned':
    case 'ordinate':
      return layout === 'lane' || layout === 'offset';
    case 'radius':
      return layout === 'radial';
    case 'diameter':
      return layout === 'radial' || layout === 'offset' || layout === 'lane';
    case 'angle':
      return layout === 'arc';
    case 'chamfer':
      return layout === 'leader' || layout === 'offset';
    default:
      return layout === 'leader';
  }
}

interface Builder {
  items: DisplayItem[];
  issues: PlacementIssue[];
  attention: boolean;
}

function datumLabelFor(annotations: ReadonlyMap<Id, Annotation>) {
  return (r: DatumRef): string | undefined => {
    if ('label' in r) return r.label;
    const d = annotations.get(r.datum);
    return d?.kind === 'datumFeature' ? d.label : undefined;
  };
}

/** Lays out one placement. */
export function layoutPlacement(
  placement: AnnotationPlacement,
  annotation: Annotation,
  ctx: PlacementContext,
): PlacedAnnotation {
  const res = ctx.resolutions.get(annotation.id);
  const base: PlacedAnnotation = {
    placementId: placement.id,
    annotationId: annotation.id,
    viewId: placement.viewId,
    items: [],
    textBox: [],
    attention: false,
    suppressed: false,
    issues: [],
  };
  if (res?.state === 'suppressed' || annotation.suppressed) return { ...base, suppressed: true };
  const b: Builder = { items: [], issues: [], attention: res?.state !== 'ok' };
  if (!layoutFits(annotation, placement.layout.kind)) {
    b.issues.push({
      kind: 'layoutDoesNotFit',
      layout: placement.layout.kind,
      annotation: annotation.kind,
    });
    b.attention = true;
  }
  const out =
    isDimension(annotation) && placement.layout.kind !== 'leader'
      ? dimensionGeometry(placement, annotation, res, ctx, b)
      : leaderGeometry(placement, annotation, res, ctx, b);
  const meta = {
    role: 'dimension' as const,
    source: { kind: 'placement' as const, placementId: placement.id, annotationId: annotation.id },
    ...(b.attention ? { attention: true } : {}),
  };
  const items = (out?.prims ?? []).map(
    (p): DisplayItem => ({ ...p, ...meta, role: p.kind === 'text' ? 'text' : 'dimension' }),
  );
  if (!out) items.push(...attentionMarker(placement, ctx, meta.source));
  return {
    ...base,
    items,
    textBox: out?.textBox ?? [],
    ...(out?.line ? { line: out.line } : {}),
    attention: b.attention,
    issues: b.issues,
  };
}

/** A `?` in a circle where the annotation would be: drawn when no geometry can be drawn. */
function attentionMarker(
  placement: AnnotationPlacement,
  ctx: PlacementContext,
  source: DisplayItem['source'],
): DisplayItem[] {
  const o = viewOutline(ctx.view);
  const h = ctx.style.text.dimension;
  const l = placement.layout;
  const d = ctx.style.dimension;
  let at: Vec2 = [(o.min[0] + o.max[0]) / 2, (o.min[1] + o.max[1]) / 2];
  if (l.kind === 'lane') {
    const off = d.firstLane + l.lane * d.laneSpacing;
    at =
      l.side === 'top'
        ? [at[0], o.max[1] + off]
        : l.side === 'bottom'
          ? [at[0], o.min[1] - off]
          : l.side === 'left'
            ? [o.min[0] - off, at[1]]
            : [o.max[0] + off, at[1]];
  }
  const meta = { role: 'dimension' as const, attention: true, ...(source ? { source } : {}) };
  return [
    { kind: 'arc', center: at, radius: h, start: 0, end: 2 * Math.PI, ...meta },
    {
      kind: 'text',
      at,
      text: '?',
      height: h,
      angle: 0,
      align: 'center',
      baseline: 'middle',
      ...meta,
      role: 'text',
    },
  ];
}

function anchorsOf(res: AnnotationResolution | undefined): (AnnotationAnchor | null)[] {
  return res?.anchors ?? [];
}

/** The label of a dimension (value only when the resolution is ok). */
function labelFor(
  a: DimensionAnnotation | HoleCalloutAnnotation,
  res: AnnotationResolution | undefined,
  ctx: PlacementContext,
  size?: SizeSymbol,
): TextBlock {
  const quantity = a.kind === 'angle' ? 'angle' : 'length';
  const tol = a.tolerance
    ? evaluateTolerance(a.tolerance, (e) => ctx.evaluate(e, quantity))
    : undefined;
  const value = res?.state === 'ok' ? res.value : undefined;
  const label = dimensionLabel({
    ...(value !== undefined ? { value } : {}),
    quantity,
    ...(size ? { size } : {}),
    ...(tol ? { tolerance: tol } : {}),
    ...(a.text ? { text: a.text } : {}),
    numbers: ctx.style.numbers,
    ...(ctx.fitDeviations ? { fitDeviations: ctx.fitDeviations } : {}),
  });
  return layoutDimensionLabel(label, ctx.style.text.dimension);
}

/** Readable measuring direction: +x first, then +y. */
function canonical(u: Vec2): Vec2 {
  return u[0] > 1e-9 || (Math.abs(u[0]) <= 1e-9 && u[1] > 0) ? u : [-u[0], -u[1]];
}

/** Where a linear dimension's line goes: lane outside the outline or offset from the geometry. */
function dimensionLineAcross(
  placement: AnnotationPlacement,
  u: Vec2,
  pts: Vec2[],
  ctx: PlacementContext,
  b: Builder,
): number | undefined {
  const n = perp2(u);
  const l = placement.layout;
  const d = ctx.style.dimension;
  if (l.kind === 'offset') {
    const ts = pts.map((p) => dot2(p, n));
    return (l.distance >= 0 ? Math.max(...ts) : Math.min(...ts)) + l.distance;
  }
  if (l.kind === 'lane') {
    const o = viewOutline(ctx.view);
    const off = d.firstLane + l.lane * d.laneSpacing;
    const horizontal = Math.abs(u[1]) < 1e-6;
    const vertical = Math.abs(u[0]) < 1e-6;
    if ((l.side === 'top' || l.side === 'bottom') && horizontal)
      return l.side === 'top' ? o.max[1] + off : o.min[1] - off;
    // u = (0, 1): n = (−1, 0), so "across" is −x.
    if ((l.side === 'left' || l.side === 'right') && vertical)
      return l.side === 'left' ? -(o.min[0] - off) : -(o.max[0] + off);
    b.issues.push({ kind: 'layoutDoesNotFit', layout: 'lane', annotation: 'linear' });
    b.attention = true;
    return undefined;
  }
  return undefined;
}

/** For each ref: its sheet points (by `at`) and the point the extension starts from. */
function measuredPoints(
  anchors: (AnnotationAnchor | null)[],
  a: Annotation,
  ctx: PlacementContext,
): Vec2[][] | null {
  const out: Vec2[][] = [];
  for (let i = 0; i < 2; i++) {
    const an = anchors[i];
    if (!an) return null;
    out.push(sheetPoints(ctx.view, an, a.at?.[i]));
  }
  return out;
}

function dimensionGeometry(
  placement: AnnotationPlacement,
  a: DimensionAnnotation,
  res: AnnotationResolution | undefined,
  ctx: PlacementContext,
  b: Builder,
): DimensionGeometry | null {
  const anchors = anchorsOf(res);
  const v = ctx.view;
  const style = ctx.style.dimension;
  const h = ctx.style.text.dimension;
  const common = {
    style,
    h,
    ...(placement.text?.shift !== undefined ? { shift: placement.text.shift } : {}),
    ...(placement.witness ? { witness: placement.witness } : {}),
    ...(placement.arrows ? { arrows: placement.arrows } : {}),
  };
  const notMeasurable = () => {
    b.issues.push({ kind: 'notMeasurableInView', viewId: v.view.id });
    b.attention = true;
    return null;
  };

  if (a.kind === 'linear' || a.kind === 'aligned' || a.kind === 'ordinate') {
    const pts = measuredPoints(anchors, a, ctx);
    if (!pts) {
      b.issues.push({ kind: 'anchorsMissing' });
      return null;
    }
    let u: Vec2 | null;
    if (a.kind === 'aligned') {
      const c0 = centroid(pts[0] as Vec2[]);
      const c1 = centroid(pts[1] as Vec2[]);
      u = dist2(c0, c1) < 1e-9 ? null : norm2(sub2(c1, c0));
    } else if (a.direction) {
      u = viewDirection(v, a.direction);
    } else {
      // Natural separation: the normal of a plane (or the perpendicular between lines).
      const an = anchors[0] as AnnotationAnchor;
      const n3 = an.kind === 'plane' ? an.normal : null;
      if (n3) u = viewDirection(v, n3);
      else {
        const seg0 = projectedSegment(v, an);
        const seg1 = anchors[1] ? projectedSegment(v, anchors[1]) : null;
        if (seg0 && seg1) u = perp2(norm2(sub2(seg0[1], seg0[0])));
        else {
          b.issues.push({ kind: 'directionMissing' });
          b.attention = true;
          return null;
        }
      }
    }
    if (!u) return notMeasurable();
    u = canonical(u);
    const all = [...(pts[0] as Vec2[]), ...(pts[1] as Vec2[])];
    const across = dimensionLineAcross(placement, u, all, ctx, b);
    if (across === undefined) return null;
    const n = perp2(u);
    // Each side: measured coordinate (mean along u), extension from the point nearest the line.
    const pick = (ps: Vec2[]): Vec2 => {
      const s = ps.reduce((acc, p) => acc + dot2(p, u as Vec2), 0) / ps.length;
      let best = ps[0] as Vec2;
      for (const p of ps)
        if (Math.abs(dot2(p, n) - across) < Math.abs(dot2(best, n) - across)) best = p;
      return add2(scale2(u as Vec2, s), scale2(n, dot2(best, n)));
    };
    const p1 = pick(pts[0] as Vec2[]);
    const p2 = pick(pts[1] as Vec2[]);
    if (Math.abs(dot2(sub2(p2, p1), u)) < 1e-9 && a.kind !== 'ordinate') return notMeasurable();
    if (a.kind === 'ordinate') return ordinateGeometry(p2, u, across, labelFor(a, res, ctx), ctx);
    return linearLayout({ p1, p2, dir: u, across, label: labelFor(a, res, ctx), ...common });
  }

  if (a.kind === 'radius' || a.kind === 'diameter') {
    const an = anchors[0];
    if (!an) {
      b.issues.push({ kind: 'anchorsMissing' });
      return null;
    }
    if (an.kind !== 'circle') return notMeasurable();
    const pc = projectCircle(v, an);
    const size: SizeSymbol = a.kind === 'radius' ? 'radius' : 'diameter';
    if (placement.layout.kind === 'radial') {
      if (pc.kind !== 'faceOn') return notMeasurable();
      return radialLayout({
        center: pc.center,
        radius: pc.radius,
        angle: placement.layout.angle,
        distance: placement.layout.distance,
        kind: a.kind,
        label: labelFor(a, res, ctx, size),
        style,
        h,
      });
    }
    // A diameter seen side-on is dimensioned across its silhouettes.
    if (pc.kind !== 'sideOn' || a.kind !== 'diameter') return notMeasurable();
    const u = canonical(pc.across);
    const p1 = add2(pc.center, scale2(u, -pc.radius));
    const p2 = add2(pc.center, scale2(u, pc.radius));
    const across = dimensionLineAcross(placement, u, [p1, p2], ctx, b);
    if (across === undefined) return null;
    return linearLayout({ p1, p2, dir: u, across, label: labelFor(a, res, ctx, size), ...common });
  }

  if (a.kind === 'angle') {
    if (placement.layout.kind !== 'arc') return null;
    const s0 = anchors[0] ? projectedSegment(v, anchors[0]) : null;
    const s1 = anchors[1] ? projectedSegment(v, anchors[1]) : null;
    if (!anchors[0] || !anchors[1]) {
      b.issues.push({ kind: 'anchorsMissing' });
      return null;
    }
    if (!s0 || !s1) return notMeasurable();
    // The angle must lie in the view plane to be seen true.
    const d0 = anchorDirection(anchors[0]);
    const d1 = anchorDirection(anchors[1]);
    if (d0 && d1) {
      const sn = spanNormal(d0, d1);
      if (sn && Math.abs(Math.abs(dot3(sn, v.frame.n)) - 1) > 1e-6) return notMeasurable();
    }
    const vertex = intersect(s0, s1);
    if (!vertex) return notMeasurable();
    const ray = (s: [Vec2, Vec2]) => {
      const far = dist2(s[0], vertex) > dist2(s[1], vertex) ? s[0] : s[1];
      return { dir: norm2(sub2(far, vertex)), ext: dist2(far, vertex) };
    };
    let r0 = ray(s0);
    let r1 = ray(s1);
    if (a.measure === 'supplement') r1 = { dir: scale2(r1.dir, -1), ext: 0 };
    if (placement.layout.opposite) {
      r0 = { dir: scale2(r0.dir, -1), ext: 0 };
      r1 = { dir: scale2(r1.dir, -1), ext: 0 };
    }
    return angularLayout({
      vertex,
      a: r0.dir,
      b: r1.dir,
      extentA: r0.ext,
      extentB: r1.ext,
      radius: placement.layout.radius,
      label: labelFor(a, res, ctx),
      style,
      h,
      ...(placement.text?.shift !== undefined ? { shift: placement.text.shift } : {}),
    });
  }

  // Chamfer in its linear form (offset): along the chamfer face's projected segment.
  if (a.kind === 'chamfer') {
    const an = anchors[0];
    const seg = an ? projectedSegment(v, an) : null;
    if (!seg) return an ? notMeasurable() : null;
    const u = canonical(norm2(sub2(seg[1], seg[0])));
    const across = dimensionLineAcross(placement, u, seg, ctx, b);
    if (across === undefined) return null;
    const label = layoutLines([[{ kind: 'text', text: chamferCallout(a, res, ctx) }]], [0, 0], h);
    return linearLayout({ p1: seg[0], p2: seg[1], dir: u, across, label, ...common });
  }
  return null;
}

function centroid(ps: Vec2[]): Vec2 {
  const s = ps.reduce((acc, p) => add2(acc, p), [0, 0] as Vec2);
  return scale2(s, 1 / Math.max(1, ps.length));
}

function intersect(a: [Vec2, Vec2], b: [Vec2, Vec2]): Vec2 | null {
  const d1 = sub2(a[1], a[0]);
  const d2 = sub2(b[1], b[0]);
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-12 * Math.max(1, Math.hypot(...d1) * Math.hypot(...d2))) return null;
  const w = sub2(b[0], a[0]);
  const t = (w[0] * d2[1] - w[1] * d2[0]) / den;
  return add2(a[0], scale2(d1, t));
}

/** Ordinate: an extension line from the feature to the lane, the value at its end (no arrows). */
function ordinateGeometry(
  target: Vec2,
  u: Vec2,
  across: number,
  label: TextBlock,
  ctx: PlacementContext,
): DimensionGeometry {
  const n = perp2(u);
  const d = ctx.style.dimension;
  const h = ctx.style.text.dimension;
  const t = dot2(target, n);
  const sgn = Math.sign(across - t) || 1;
  const s = dot2(target, u);
  const at = (tt: number): Vec2 => add2(scale2(u, s), scale2(n, tt));
  const end = at(across);
  const prims: Primitive[] = [{ kind: 'line', a: at(t + sgn * d.extensionGap), b: end }];
  // The value reads along the extension line, beyond its end.
  const dir = scale2(n, sgn);
  const ang = (angle2(dir) * 180) / Math.PI;
  const readable = ang > 90 + 1e-9 || ang <= -90 + 1e-9 ? ang - 180 * Math.sign(ang) : ang;
  const flip = Math.abs(readable - ang) > 1e-9;
  const a = (readable * Math.PI) / 180;
  const startAlong = flip ? -(0.5 * h + label.width) : 0.5 * h;
  const origin = add2(end, scale2(dir, flip ? -startAlong - label.width : startAlong));
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const y0 = -(label.box.min[1] + label.box.max[1]) / 2;
  const pt = (p: Vec2): Vec2 => [
    origin[0] + p[0] * c - (p[1] + y0) * sn,
    origin[1] + p[0] * sn + (p[1] + y0) * c,
  ];
  for (const p of label.prims) prims.push(movePrimLocal(p, pt, readable));
  const { min, max } = label.box;
  return {
    prims,
    textBox: [pt(min), pt([max[0], min[1]]), pt(max), pt([min[0], max[1]])],
    line: [target, end],
    arrowsOutside: false,
  };
}

function movePrimLocal(p: Primitive, pt: (q: Vec2) => Vec2, angleDeg: number): Primitive {
  switch (p.kind) {
    case 'text':
      return { ...p, at: pt(p.at), angle: p.angle + angleDeg };
    case 'line':
      return { ...p, a: pt(p.a), b: pt(p.b) };
    case 'polyline':
      return { ...p, points: p.points.map(pt) };
    case 'fill':
      return { ...p, loops: p.loops.map((l) => l.map(pt)) };
    case 'arc':
      return {
        ...p,
        center: pt(p.center),
        start: p.start + (angleDeg * Math.PI) / 180,
        end: p.end + (angleDeg * Math.PI) / 180,
      };
    default:
      return p;
  }
}

function chamferCallout(
  a: Extract<Annotation, { kind: 'chamfer' }>,
  res: AnnotationResolution | undefined,
  ctx: PlacementContext,
): string {
  if (res?.state !== 'ok') return '?';
  const data = ctx.features?.chamfer?.(a) ?? { distance: res.value };
  return `${a.text?.prefix ?? ''}${chamferText(a.form, data, ctx.style.numbers)}`;
}

/** Leader-based annotations: notes, frames, datums, surface finish, hole and chamfer callouts. */
function leaderGeometry(
  placement: AnnotationPlacement,
  a: Annotation,
  res: AnnotationResolution | undefined,
  ctx: PlacementContext,
  b: Builder,
): DimensionGeometry | null {
  const l = placement.layout;
  if (l.kind !== 'leader') return null;
  const v = ctx.view;
  const h = a.kind === 'note' ? ctx.style.text.note : ctx.style.text.dimension;
  const style = ctx.style.dimension;

  // Attach point.
  let attach: Vec2 | undefined;
  let anchor: AnnotationAnchor | null | undefined;
  let below = false;
  if (l.attach.kind === 'ref') {
    let anchors = anchorsOf(res);
    if (a.kind === 'geometricTolerance' && a.refs.length === 0 && a.appliesTo)
      anchors = anchorsOf(ctx.resolutions.get(a.appliesTo));
    anchor = anchors[l.attach.index];
    if (anchor) attach = attachPoint(v, anchor, l.attach.t);
  } else {
    const other = ctx.placed.get(l.attach.placementId);
    if (!other || other.textBox.length === 0) {
      b.issues.push({ kind: 'attachTargetMissing', placementId: l.attach.placementId });
      b.attention = true;
    } else if (l.attach.kind === 'placement') {
      const xs = other.textBox.map((p) => p[0]);
      const ys = other.textBox.map((p) => p[1]);
      attach = [Math.min(...xs), Math.min(...ys)];
      below = true;
    } else if (other.line) attach = lerp2(other.line[0], other.line[1], l.attach.t);
  }
  if (!attach) {
    if (l.attach.kind === 'ref') b.issues.push({ kind: 'anchorsMissing' });
    return null;
  }

  // Content block in a local frame.
  const content = leaderContent(a, res, ctx, h, b);
  const textAt = add2(attach, l.text);
  const prims: Primitive[] = [];
  let placeAt: Vec2;
  let side: 'left' | 'right' = 'right';

  if (below) {
    // A frame (or note) directly under another placement's text: no leader.
    placeAt = add2(attach, [l.text[0], l.text[1] - 0.5 * h - content.box.max[1]]);
    prims.push(...shift(content.prims, placeAt));
    return finish(prims, content.box, placeAt);
  }

  if (a.kind === 'datumFeature') {
    // Triangle on the surface, a leader to the letter box (no landing).
    const pts = [attach, ...(l.bends ?? []).map((p) => add2(attach as Vec2, p)), textAt];
    const first = pts[1] ?? textAt;
    const dir = norm2(sub2(first, attach));
    const ang = angle2(dir) - Math.PI / 2;
    prims.push(...placeSymbol('datumTriangle', attach, 2 * h * 0.5 * 1.15, ang));
    prims.push({ kind: 'polyline', points: pts });
    const prev = pts[pts.length - 2] ?? attach;
    const d = sub2(textAt, prev);
    const box = content.box;
    if (Math.abs(d[1]) >= Math.abs(d[0])) {
      placeAt = d[1] >= 0 ? textAt : add2(textAt, [0, -(box.max[1] - box.min[1])]);
    } else {
      const w = box.max[0] - box.min[0];
      placeAt = add2(textAt, [d[0] >= 0 ? w / 2 : -w / 2, -(box.max[1] - box.min[1]) / 2]);
    }
    prims.push(...shift(content.prims, placeAt));
    return finish(prims, content.box, placeAt);
  }

  if (a.kind === 'surfaceFinish') {
    // Symbol apex on the surface, or at the end of a leader with an arrow.
    if (dist2(textAt, attach) < 1e-9) placeAt = attach;
    else {
      const pts = [attach, ...(l.bends ?? []).map((p) => add2(attach as Vec2, p)), textAt];
      prims.push({ kind: 'polyline', points: pts });
      const lg = leaderLayout({
        attach,
        bends: [],
        text: pts[1] as Vec2,
        contentWidth: 0,
        terminator: 'arrow',
        style,
        h,
      });
      prims.push(...lg.prims.filter((p) => p.kind === 'fill'));
      placeAt = textAt;
    }
    prims.push(...shift(content.prims, placeAt));
    return finish(prims, content.box, placeAt);
  }

  const terminator = anchor && isSurfaceFaceOn(v, anchor) ? 'dot' : 'arrow';
  const lg = leaderLayout({
    attach,
    bends: (l.bends ?? []).map((p) => add2(attach as Vec2, p)),
    text: textAt,
    ...(l.landing ? { landing: l.landing } : {}),
    contentWidth: content.width,
    terminator,
    style,
    h,
    ...(a.kind === 'geometricTolerance' && a.allAround ? { allAround: true } : {}),
  });
  prims.push(...lg.prims);
  side = lg.side;
  const mid = (content.box.min[1] + content.box.max[1]) / 2;
  const gap = a.kind === 'geometricTolerance' ? 0 : 0.4 * h;
  placeAt =
    side === 'right'
      ? add2(lg.contentAt, [gap - content.box.min[0], -mid])
      : add2(lg.contentAt, [-gap - content.box.max[0], -mid]);
  // Text lines sit on the landing (their first baseline just above it), frames centre on it.
  if (a.kind !== 'geometricTolerance')
    placeAt = add2(placeAt, [0, mid - content.firstBaseline + 0.4 * h]);
  prims.push(...shift(content.prims, placeAt));
  return finish(prims, content.box, placeAt);
}

function finish(prims: Primitive[], box: Box2, at: Vec2): DimensionGeometry {
  const min = add2(box.min, at);
  const max = add2(box.max, at);
  return {
    prims,
    textBox: [min, [max[0], min[1]], max, [min[0], max[1]]],
    line: [at, at],
    arrowsOutside: false,
  };
}

function shift(prims: Primitive[], at: Vec2): Primitive[] {
  return prims.map((p) => movePrimLocal(p, (q) => add2(q, at), 0));
}

interface Content extends TextBlock {
  /** Baseline of the first text line, local y. */
  firstBaseline: number;
}

function linesBlock(lines: TextRun[][], h: number): Content {
  const blk = layoutLines(lines, [0, 0], h);
  return { ...blk, firstBaseline: 0 };
}

function leaderContent(
  a: Annotation,
  res: AnnotationResolution | undefined,
  ctx: PlacementContext,
  h: number,
  b: Builder,
): Content {
  const numbers = ctx.style.numbers;
  const ev = (e: Expr) => ctx.evaluate(e, 'length');
  switch (a.kind) {
    case 'geometricTolerance': {
      const z = a.zone;
      const pu = z.perUnit
        ? (() => {
            const value = ev(z.perUnit.value);
            const length = ev(z.perUnit.length);
            const width = z.perUnit.width !== undefined ? ev(z.perUnit.width) : undefined;
            return value !== undefined && length !== undefined
              ? { value, length, ...(width !== undefined ? { width } : {}) }
              : undefined;
          })()
        : undefined;
      const value = ev(z.value);
      const projected = z.projected !== undefined ? ev(z.projected) : undefined;
      const unequal = z.unequal !== undefined ? ev(z.unequal) : undefined;
      const f = layoutFrame({
        annotation: a,
        zone: {
          ...(value !== undefined ? { value } : {}),
          ...(projected !== undefined ? { projected } : {}),
          ...(unequal !== undefined ? { unequal } : {}),
          ...(pu ? { perUnit: pu } : {}),
        },
        datumLabel: datumLabelFor(ctx.annotations),
        standard: ctx.standard,
        numbers,
        h,
      });
      if (f.incomplete) b.attention = true;
      return { ...f, firstBaseline: (f.height - h) / 2 };
    }
    case 'datumFeature': {
      const d = layoutDatumBox(a.label, h);
      if (d.attention) b.attention = true;
      // Origin at the box's bottom-middle; shift so the local box starts at x = 0.
      return { ...d, firstBaseline: h / 2 };
    }
    case 'surfaceFinish': {
      const values = {
        requirements: a.requirements.map((r) => ev(r.value)),
        ...(a.allowance !== undefined
          ? (() => {
              const x = ev(a.allowance);
              return x !== undefined ? { allowance: x } : {};
            })()
          : {}),
      };
      const s = layoutSurfaceFinish(a, values, numbers, h);
      if (s.attention) b.attention = true;
      return { ...s, firstBaseline: 0 };
    }
    case 'note':
      return linesBlock(noteLines(a.text), h);
    case 'holeCallout': {
      const data = res?.state === 'ok' ? ctx.features?.hole?.(a) : undefined;
      if (!data) {
        b.attention = true;
        return linesBlock([[{ kind: 'text', text: '?' }]], h);
      }
      const withCount = { ...data, count: res?.instances?.length ?? data.count };
      const tol = a.tolerance ? evaluateTolerance(a.tolerance, ev) : undefined;
      const lines = holeCalloutLines(
        { ...withCount, ...(tol ? { tolerance: tol } : {}) },
        numbers,
        a.show ?? {},
      );
      return linesBlock(lines, h);
    }
    case 'chamfer':
      return linesBlock([[{ kind: 'text', text: chamferCallout(a, res, ctx) }]], h);
    default: {
      // A dimension placed with a leader (flagged by layoutFits): show its label.
      if (isDimension(a)) {
        const lab = labelFor(a, res, ctx);
        return { ...lab, firstBaseline: 0 };
      }
      return linesBlock([[{ kind: 'text', text: '?' }]], h);
    }
  }
}

/**
 * Lays out every placement of one view, targets before the placements that attach to them.
 * Placement order otherwise follows ids (deterministic output).
 */
export function layoutView(
  placements: readonly AnnotationPlacement[],
  ctx: Omit<PlacementContext, 'placed'>,
): PlacedAnnotation[] {
  const placed = new Map<Id, PlacedAnnotation>();
  const byId = new Map(placements.map((p) => [p.id, p]));
  const order: AnnotationPlacement[] = [];
  const state = new Map<Id, 'visiting' | 'done'>();
  const visit = (p: AnnotationPlacement) => {
    const s = state.get(p.id);
    if (s === 'done' || s === 'visiting') return;
    state.set(p.id, 'visiting');
    if (p.layout.kind === 'leader' && p.layout.attach.kind !== 'ref') {
      const t = byId.get(p.layout.attach.placementId);
      if (t) visit(t);
    }
    state.set(p.id, 'done');
    order.push(p);
  };
  for (const p of [...placements].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)))
    visit(p);
  const out: PlacedAnnotation[] = [];
  for (const p of order) {
    const a = ctx.annotations.get(p.annotationId);
    if (!a) continue;
    const r = layoutPlacement(p, a, { ...ctx, placed });
    placed.set(p.id, r);
    out.push(r);
  }
  return out;
}
