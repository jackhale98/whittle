/**
 * Annotation operations of the drawing route. A dimension drawn on a view is a part annotation
 * (origin: this drawing) plus a placement, added as one undo step. References are model edges by
 * persistent name; nothing is attached to a guessed entity, and a dimension whose references do
 * not resolve shows as needs attention at once.
 */

import type {
  Annotation,
  AnnotationPlacement,
  EntityRef,
  GeometricToleranceAnnotation,
  Id,
  LinearDimension,
  PlacementLayout,
  ProjectedCurve,
  RefPoint,
  SurfaceFinishAnnotation,
  Vec2,
  Vec3,
} from '@wren-cad/contracts';
import {
  anchorLookup,
  importAnchorQueries,
  importCommands,
  planImport,
  type SolvedView,
  sheetToView,
  viewOutline,
  viewToSheet,
} from '@wren-cad/drawing';
import type { DrawingController } from './controller';
import { host } from './host';
import type { Built } from './pipeline';
import type { EdgePick } from './state';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------
// Picks
// ---------------------------------------------------------------------------------------------

/** Distance from `p` to a projected curve (view plane, part mm); lines and arcs, else Infinity. */
function curveDistance(curve: ProjectedCurve['curve'], p: Vec2): number {
  if (curve.kind === 'line') {
    const d = sub(curve.b, curve.a);
    const l2 = d[0] * d[0] + d[1] * d[1] || 1;
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - curve.a[0]) * d[0] + (p[1] - curve.a[1]) * d[1]) / l2),
    );
    return len(sub(p, [curve.a[0] + t * d[0], curve.a[1] + t * d[1]]));
  }
  if (curve.kind === 'arc') return Math.abs(len(sub(p, curve.center)) - curve.radius);
  return Number.POSITIVE_INFINITY;
}

/**
 * What an edge on a view is, from the kernel's projected curves (the run of that name nearest the
 * pointer). With
 * `by: 'face'`, `name` is a face and the pick is the outline of it nearest the pointer: a cylinder
 * seen side-on has two (two outlines, or an outline and the seam on its silhouette).
 */
export function pickEdge(
  c: DrawingController,
  viewId: Id,
  name: string,
  at: Vec2,
  by: 'edge' | 'face' = 'edge',
): EdgePick | null {
  const proj = c.built()?.projections.get(viewId);
  // The run under the pointer: an edge can be drawn in several pieces (a curved blend piece and
  // an arc of one name), and a face has two sides seen side-on.
  const runs = (proj?.curves ?? []).filter(
    (x) => (by === 'face' ? x.face : x.name) === name && x.role === 'visible',
  );
  const sv = c.built()?.build.views.get(viewId);
  let k: ProjectedCurve | undefined = runs[0];
  if (runs.length > 1 && sv?.ok) {
    const q = sheetToView(sv, at);
    k = runs.map((x) => ({ x, d: curveDistance(x.curve, q) })).sort((a, b) => a.d - b.d)[0]?.x;
  }
  const curve = k?.curve;
  if (!k || !curve) return null;
  const base = {
    viewId,
    name,
    at,
    ...(by === 'face' ? { ref: 'face' as const } : {}),
    ...(k.face ? { face: k.face } : {}),
  };
  if (curve.kind === 'arc')
    return {
      ...base,
      shape: 'circle',
      sweep: curve.end - curve.start,
      geom: {
        centre: curve.center,
        radius: curve.radius,
        full: Math.abs(curve.end - curve.start - TAU) < 1e-6,
      },
    };
  if (curve.kind === 'line') return { ...base, shape: 'line', geom: { a: curve.a, b: curve.b } };
  return { ...base, shape: 'other' };
}

async function refOf(
  c: DrawingController,
  name: string,
  kind: 'edge' | 'face' = 'edge',
): Promise<EntityRef> {
  const plain: EntityRef = { name, kind };
  const wb = c.wb;
  const r = wb.regen.get()?.result;
  const part = wb.part;
  if (!r || !part || !wb.modeling) return plain;
  for (const b of r.bodies) {
    const i = (kind === 'face' ? b.mesh.faceNames : b.mesh.edgeNames).indexOf(name);
    if (i < 0) continue;
    const ref = await wb.modeling.refFor(part.id, { bodyId: b.id, kind, index: i });
    // Only the fingerprint is taken: the name stays exactly what the view showed.
    return ref && ref.name === name && ref.fingerprint
      ? { ...plain, fingerprint: ref.fingerprint }
      : plain;
  }
  return plain;
}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const dir = (a: Vec2, b: Vec2): Vec2 => {
  const d = sub(b, a);
  const l = len(d) || 1;
  return [d[0] / l, d[1] / l];
};
const to3 = (v: SolvedView['frame'], p: Vec2): Vec3 => [
  v.x[0] * p[0] + v.y[0] * p[1],
  v.x[1] * p[0] + v.y[1] * p[1],
  v.x[2] * p[0] + v.y[2] * p[1],
];

const centre = (p: EdgePick): Vec2 | null => (p.geom && 'centre' in p.geom ? p.geom.centre : null);
const ends = (p: EdgePick): [Vec2, Vec2] | null =>
  p.geom && 'a' in p.geom ? [p.geom.a, p.geom.b] : null;

export type DimensionPlan =
  | {
      ok: true;
      annotation: Omit<Annotation, 'id'>;
      layout: PlacementLayout;
      viewId: Id;
      /** The plan measures this face (two sides of it were picked): its one ref. */
      faceRef?: string;
    }
  | { ok: false; message: string };

function laneFor(b: Built, viewId: Id, side: 'top' | 'bottom' | 'left' | 'right'): number {
  const used = b.drawing.placements.filter(
    (p) => p.viewId === viewId && p.layout.kind === 'lane' && p.layout.side === side,
  );
  return used.length === 0
    ? 0
    : Math.max(...used.map((p) => (p.layout.kind === 'lane' ? p.layout.lane : 0))) + 1;
}

const cross2 = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];

/** The angle between two straight edges of one view: an arc around where they meet. */
export function planAngle(c: DrawingController, picks: EdgePick[]): DimensionPlan {
  const b = c.built();
  const first = picks[0];
  const second = picks[1];
  if (!b || !first || !second) return { ok: false, message: 'Pick two straight edges.' };
  if (second.viewId !== first.viewId)
    return { ok: false, message: 'Both edges must be on the same view.' };
  const sv = b.build.views.get(first.viewId);
  if (!sv?.ok) return { ok: false, message: 'That view is not available.' };
  const ea = ends(first);
  const eb = ends(second);
  if (!ea || !eb) return { ok: false, message: 'An angle is between two straight edges.' };
  if (first.name === second.name) return { ok: false, message: 'Pick two different edges.' };
  const ta = dir(ea[0], ea[1]);
  const tb = dir(eb[0], eb[1]);
  const x = cross2(ta, tb);
  // Within a degree of parallel there is no vertex worth drawing.
  if (Math.abs(x) < 0.0175)
    return {
      ok: false,
      message:
        'Those edges are parallel, so there is no angle between them. Pick two edges that meet.',
    };
  const s = cross2(sub(eb[0], ea[0]), tb) / x;
  const vertex: Vec2 = [ea[0][0] + ta[0] * s, ea[0][1] + ta[1] * s];
  const vs = viewToSheet(sv, vertex);
  const radius = Math.min(
    30,
    Math.max(8, 0.5 * Math.min(len(sub(first.at, vs)), len(sub(second.at, vs)))),
  );
  return {
    ok: true,
    viewId: first.viewId,
    annotation: {
      kind: 'angle',
      origin: { kind: 'drawing' as const, drawingId: b.drawing.id },
      refs: [],
      at: ['self', 'self'],
    } as Omit<Annotation, 'id'>,
    layout: { kind: 'arc', radius: Math.round(radius * 10) / 10 },
  };
}

/** Which dimension the picks mean, and where it goes. Pure: refs are attached by the caller. */
/** A lane on the side of the view nearest the picks, for a dimension along a view axis. */
function laneBeside(
  b: Built,
  sv: SolvedView,
  picks: EdgePick[],
  measuredAxis: 'x' | 'y' | null,
): PlacementLayout {
  const outline = viewOutline(sv);
  const n = Math.max(1, picks.length);
  const mid: Vec2 = [
    picks.reduce((s, p) => s + p.at[0], 0) / n,
    picks.reduce((s, p) => s + p.at[1], 0) / n,
  ];
  const cx = (outline.min[0] + outline.max[0]) / 2;
  const cy = (outline.min[1] + outline.max[1]) / 2;
  if (measuredAxis === 'x') {
    const side = mid[1] < cy ? 'bottom' : 'top';
    return { kind: 'lane', side, lane: laneFor(b, sv.view.id, side) };
  }
  if (measuredAxis === 'y') {
    const side = mid[0] < cx ? 'left' : 'right';
    return { kind: 'lane', side, lane: laneFor(b, sv.view.id, side) };
  }
  return { kind: 'offset', distance: 10 };
}

export function planDimension(
  c: DrawingController,
  picks: EdgePick[],
  radius = false,
): DimensionPlan {
  const b = c.built();
  const first = picks[0];
  if (!b || !first) return { ok: false, message: 'Pick an edge.' };
  const sv = b.build.views.get(first.viewId);
  if (!sv?.ok) return { ok: false, message: 'That view is not available.' };
  const frame = sv.frame;
  const origin = { kind: 'drawing' as const, drawingId: b.drawing.id };

  // Two sides of one curved face seen side-on (its outlines, or an outline and the seam on its
  // silhouette, `ProjectedCurve.face`), or one face-named outline circle (a sphere): the
  // diameter of that face, measured by the kernel from the face (ADR-090 amendment).
  const second0 = picks[1];
  const outlined =
    first.face &&
    (picks.length === 1
      ? first.ref === 'face' && first.shape === 'circle'
      : picks.length === 2 && second0?.face === first.face && second0.viewId === first.viewId);
  if (outlined) {
    // Seen side-on (straight sides): across the silhouettes, in a lane beside the view. Seen as a
    // circle (a sphere's outline): radial. A diameter unless a radius is asked for.
    const side = picks.length === 2 ? ends(first) : null;
    let layout: PlacementLayout = { kind: 'radial', angle: 45, distance: 6 };
    let kind: 'radius' | 'diameter' = radius ? 'radius' : 'diameter';
    if (side) {
      const t = dir(side[0], side[1]);
      const n: Vec2 = [-t[1], t[0]];
      const axis = Math.abs(n[0]) > 0.98 ? 'x' : Math.abs(n[1]) > 0.98 ? 'y' : null;
      layout = laneBeside(b, sv, picks, axis);
      kind = 'diameter';
    }
    return {
      ok: true,
      viewId: first.viewId,
      annotation: { kind, origin, refs: [] } as Omit<Annotation, 'id'>,
      layout,
      faceRef: first.face as string,
    };
  }
  // One circle: a diameter (a radius for an arc, or on request).
  if (picks.length === 1 && first.shape === 'circle') {
    const full = first.geom && 'full' in first.geom ? first.geom.full : true;
    const kind = radius || !full ? 'radius' : 'diameter';
    return {
      ok: true,
      viewId: first.viewId,
      annotation: { kind, origin, refs: [], at: [] } as Omit<Annotation, 'id'>,
      layout: { kind: 'radial', angle: 45, distance: 6 },
    };
  }
  // One straight edge (picked twice): its length.
  if (picks.length === 1 && first.shape === 'line') {
    return {
      ok: true,
      viewId: first.viewId,
      annotation: { kind: 'aligned', origin, refs: [], at: ['start', 'end'] },
      layout: { kind: 'offset', distance: 10 },
    };
  }
  const second = picks[1];
  if (!second)
    return { ok: false, message: 'Pick a second edge, or the same edge again for its length.' };
  if (second.viewId !== first.viewId)
    return { ok: false, message: 'Both edges must be on the same view.' };
  if (first.shape === 'other' || second.shape === 'other')
    return {
      ok: false,
      message:
        'Dimensions between curved edges are not supported yet: pick a straight edge or a circle.',
    };

  const ca = centre(first);
  const cb = centre(second);
  const ea = ends(first);
  const eb = ends(second);
  let direction: Vec3 | undefined;
  let measuredAxis: 'x' | 'y' | null = null;
  const at: RefPoint[] = [];

  if (ca && cb) {
    at.push('center', 'center');
    const d = sub(cb, ca);
    measuredAxis = Math.abs(d[0]) >= Math.abs(d[1]) ? 'x' : 'y';
    direction = measuredAxis === 'x' ? frame.x : frame.y;
  } else if ((ca && eb) || (cb && ea)) {
    const line = (ea ?? eb) as [Vec2, Vec2];
    const t = dir(line[0], line[1]);
    const n: Vec2 = [-t[1], t[0]];
    direction = to3(frame, n);
    measuredAxis = Math.abs(n[0]) > 0.98 ? 'x' : Math.abs(n[1]) > 0.98 ? 'y' : null;
    at.push(ca ? 'center' : 'self', cb ? 'center' : 'self');
  } else if (ea && eb) {
    const ta = dir(ea[0], ea[1]);
    const tb = dir(eb[0], eb[1]);
    // Not parallel: the angle between them (the same plan the Angle tool makes).
    if (Math.abs(ta[0] * tb[0] + ta[1] * tb[1]) < 0.985) return planAngle(c, picks);
    const n: Vec2 = [-ta[1], ta[0]];
    measuredAxis = Math.abs(n[0]) > 0.98 ? 'x' : Math.abs(n[1]) > 0.98 ? 'y' : null;
    direction = measuredAxis === 'x' ? frame.x : measuredAxis === 'y' ? frame.y : undefined;
    at.push('self', 'self');
  } else return { ok: false, message: 'Pick two edges.' };

  const layout = laneBeside(b, sv, picks, measuredAxis);

  return {
    ok: true,
    viewId: first.viewId,
    annotation: {
      kind: 'linear',
      origin,
      refs: [],
      at,
      ...(direction ? { direction } : {}),
    } as Omit<Annotation, 'id'>,
    layout,
  };
}

/** Creates the dimension for `picks` (one undo step: the annotation and its placement). */
export async function createDimension(
  c: DrawingController,
  picks: EdgePick[],
  radius = false,
): Promise<boolean> {
  const b = c.built();
  const plan = planDimension(c, picks, radius);
  if (!b || !plan.ok) {
    c.toast(plan.ok ? 'There is nothing to dimension.' : plan.message, 'error');
    return false;
  }
  const names =
    picks.length === 1 && picks[0]?.shape === 'line'
      ? [picks[0].name, picks[0].name]
      : picks.map((p) => p.name);
  const refs = plan.faceRef
    ? [await refOf(c, plan.faceRef, 'face')]
    : await Promise.all(names.map((n, i) => refOf(c, n, picks[i]?.ref ?? 'edge')));
  const id = host.ulid();
  const annotation = { ...plan.annotation, id, refs } as Annotation;
  const placement: AnnotationPlacement = {
    id: host.ulid(),
    viewId: plan.viewId,
    annotationId: id,
    layout: plan.layout,
  };
  const ok = c.apply(
    {
      kind: 'addAnnotation',
      partId: b.part.id,
      annotation,
      place: { drawingId: b.drawing.id, placement },
    },
    `Add ${annotation.kind} dimension`,
  );
  if (ok) {
    c.select({ kind: 'placement', id: placement.id });
    c.patch({ hint: null });
  }
  return ok;
}

/**
 * An ordinate dimension: the coordinate of `picks[1]` from the origin `picks[0]`, along the view
 * axis the two differ most on. Ordinates with the same origin and direction share a lane, so they
 * read as one group (one `0`, the rest as coordinates).
 */
export async function createOrdinate(c: DrawingController, picks: EdgePick[]): Promise<boolean> {
  const b = c.built();
  const origin = picks[0];
  const feature = picks[1];
  if (!b || !origin || !feature) return false;
  const plan = planDimension(c, [origin, feature]);
  const lin =
    plan.ok && plan.annotation.kind === 'linear'
      ? (plan.annotation as Omit<LinearDimension, 'id'>)
      : undefined;
  const dir = lin?.direction;
  if (!plan.ok || !lin || !dir) {
    c.toast(
      plan.ok
        ? 'An ordinate runs along the view’s horizontal or vertical: pick features that differ along one of them.'
        : plan.message,
      'error',
    );
    return false;
  }
  const refs = await Promise.all([origin, feature].map((p) => refOf(c, p.name)));
  const id = host.ulid();
  const annotation = {
    ...plan.annotation,
    kind: 'ordinate',
    id,
    refs,
    direction: dir,
  } as Annotation;
  // The group's lane: the one the first ordinate from this origin along this axis took.
  let layout = plan.layout;
  if (layout.kind === 'lane') {
    const sibling = (b.part.annotations ?? []).find(
      (a) =>
        a.kind === 'ordinate' &&
        a.refs[0]?.name === origin.name &&
        Math.abs(
          Math.abs(a.direction[0] * dir[0] + a.direction[1] * dir[1] + a.direction[2] * dir[2]) - 1,
        ) < 1e-6,
    );
    const placed = sibling
      ? b.drawing.placements.find(
          (p) =>
            p.annotationId === sibling.id && p.viewId === plan.viewId && p.layout.kind === 'lane',
        )
      : undefined;
    if (placed?.layout.kind === 'lane') layout = placed.layout;
  }
  const placement: AnnotationPlacement = {
    id: host.ulid(),
    viewId: plan.viewId,
    annotationId: id,
    layout,
  };
  const ok = c.apply(
    {
      kind: 'addAnnotation',
      partId: b.part.id,
      annotation,
      place: { drawingId: b.drawing.id, placement },
    },
    'Add ordinate dimension',
  );
  if (ok) c.select({ kind: 'placement', id: placement.id });
  return ok;
}

/** The chamfer face's name inside an edge name (`F…:chamfer(…)`, balanced), if the edge has one. */
export function chamferFaceName(name: string): { featureId: Id; face: string } | null {
  const m = /F([0-9A-Za-z]+):chamfer\(/.exec(name);
  if (!m) return null;
  const start = m.index;
  let depth = 0;
  for (let i = start + m[0].length - 1; i < name.length; i++) {
    if (name[i] === '(') depth++;
    else if (name[i] === ')' && --depth === 0)
      return { featureId: m[1] as Id, face: name.slice(start, i + 1) };
  }
  return null;
}

/**
 * A chamfer callout for the chamfer feature that made the picked edge. The numbers come from the
 * feature; an edge no chamfer feature made is refused, never guessed at.
 */
export async function addChamfer(c: DrawingController, pick: EdgePick): Promise<boolean> {
  const b = c.built();
  if (!b) return false;
  const found = chamferFaceName(pick.name);
  const feature = found
    ? b.part.features.find((f) => f.id === found.featureId && f.type === 'chamfer')
    : undefined;
  if (!found || !feature) {
    c.toast(
      'That edge is not on a chamfer made by a Chamfer feature. Pick an edge of the chamfer’s face.',
      'error',
    );
    return false;
  }
  const taken = (b.part.annotations ?? []).find(
    (a) =>
      a.kind === 'chamfer' && a.source?.kind === 'feature' && a.source.featureId === feature.id,
  );
  if (taken) {
    const placed = b.drawing.placements.find((p) => p.annotationId === taken.id);
    if (placed) c.select({ kind: 'placement', id: placed.id });
    c.toast('This chamfer already has a callout.');
    return false;
  }
  const mode = feature.type === 'chamfer' ? feature.mode.kind : 'distance';
  const annotation: Annotation = {
    id: host.ulid(),
    kind: 'chamfer',
    origin: { kind: 'drawing', drawingId: b.drawing.id },
    form: mode === 'distanceAngle' || mode === 'distance' ? 'distanceAngle' : 'twoDistances',
    refs: [{ name: found.face, kind: 'face' }],
    source: { kind: 'feature', featureId: feature.id },
  };
  const placement: AnnotationPlacement = {
    id: host.ulid(),
    viewId: pick.viewId,
    annotationId: annotation.id,
    layout: LEADER,
  };
  const ok = c.apply(
    {
      kind: 'addAnnotation',
      partId: b.part.id,
      annotation,
      place: { drawingId: b.drawing.id, placement },
    },
    'Add chamfer callout',
  );
  if (ok) c.select({ kind: 'placement', id: placement.id });
  return ok;
}

/** The next free datum letter (never I, O or Q). */
export function nextDatumLabel(existing: readonly string[]): string {
  for (const l of 'ABCDEFGHJKLMNPRSTUVWXYZ') if (!existing.includes(l)) return l;
  return 'AA';
}

const LEADER: PlacementLayout = {
  kind: 'leader',
  attach: { kind: 'ref', index: 0 },
  text: [10, 8],
};

async function addCallout(
  c: DrawingController,
  pick: EdgePick,
  make: (b: Built, ref: EntityRef) => Annotation,
  label: string,
): Promise<boolean> {
  const b = c.built();
  if (!b) return false;
  const ref = await refOf(c, pick.name);
  const annotation = make(b, ref);
  const placement: AnnotationPlacement = {
    id: host.ulid(),
    viewId: pick.viewId,
    annotationId: annotation.id,
    layout: LEADER,
  };
  const ok = c.apply(
    {
      kind: 'addAnnotation',
      partId: b.part.id,
      annotation,
      place: { drawingId: b.drawing.id, placement },
    },
    label,
  );
  if (ok) c.select({ kind: 'placement', id: placement.id });
  return ok;
}

export const addDatum = (c: DrawingController, pick: EdgePick) =>
  addCallout(
    c,
    pick,
    (b, ref) => {
      const used = (b.part.annotations ?? []).flatMap((a) =>
        a.kind === 'datumFeature' ? [a.label] : [],
      );
      return {
        id: host.ulid(),
        kind: 'datumFeature',
        origin: { kind: 'drawing', drawingId: b.drawing.id },
        refs: [ref],
        label: nextDatumLabel(used),
        standard: b.drawing.standard.gps,
      };
    },
    'Add datum',
  );

export const addFrame = (c: DrawingController, pick: EdgePick) =>
  addCallout(
    c,
    pick,
    (b, ref) => {
      const round = pick.shape === 'circle';
      const datum = (b.part.annotations ?? []).find((a) => a.kind === 'datumFeature');
      const frame: GeometricToleranceAnnotation = {
        id: host.ulid(),
        kind: 'geometricTolerance',
        origin: { kind: 'drawing', drawingId: b.drawing.id },
        refs: [ref],
        standard: b.drawing.standard.gps,
        characteristic: round ? 'position' : 'flatness',
        zone: { value: '0.1 mm', ...(round ? { shape: 'diameter' as const } : {}) },
        ...(round && datum ? { datums: [{ datums: [{ datum: datum.id }] }] } : {}),
      };
      return frame;
    },
    'Add tolerance frame',
  );

export const addFinish = (c: DrawingController, pick: EdgePick) =>
  addCallout(
    c,
    pick,
    (b, ref) => {
      const f: SurfaceFinishAnnotation = {
        id: host.ulid(),
        kind: 'surfaceFinish',
        origin: { kind: 'drawing', drawingId: b.drawing.id },
        refs: [ref],
        standard: b.drawing.standard.surfaceFinish,
        process: 'any',
        requirements: [{ parameter: 'Ra', value: '1.6 um' }],
      };
      return f;
    },
    'Add surface finish',
  );

export const addNote = (c: DrawingController, pick: EdgePick, text = 'NOTE') =>
  addCallout(
    c,
    pick,
    (b, ref) => ({
      id: host.ulid(),
      kind: 'note',
      origin: { kind: 'drawing', drawingId: b.drawing.id },
      refs: [ref],
      text,
    }),
    'Add note',
  );

// ---------------------------------------------------------------------------------------------
// Edit, remove, reattach
// ---------------------------------------------------------------------------------------------

export function updateAnnotation(
  c: DrawingController,
  annotation: Annotation,
  label: string,
  key?: string,
): boolean {
  const b = c.built();
  if (!b) return false;
  return c.apply(
    { kind: 'updateAnnotation', partId: b.part.id, annotationId: annotation.id, annotation },
    label,
    key,
  );
}

/** Takes the annotation off this view only; the part annotation stays. */
export function removePlacement(c: DrawingController, placementId: Id): boolean {
  const b = c.built();
  if (!b) return false;
  const ok = c.apply(
    { kind: 'removePlacements', drawingId: b.drawing.id, placementIds: [placementId] },
    'Remove from view',
  );
  if (ok) c.select(null);
  return ok;
}

/** Deletes the annotation from the part: every placement of it, in every drawing, goes too. */
export function deleteAnnotation(c: DrawingController, annotationId: Id): boolean {
  const b = c.built();
  if (!b) return false;
  const ok = c.apply(
    { kind: 'removeAnnotation', partId: b.part.id, annotationIds: [annotationId] },
    'Delete annotation',
  );
  if (ok) c.select(null);
  return ok;
}

export function updatePlacement(
  c: DrawingController,
  placement: AnnotationPlacement,
  label: string,
  key?: string,
): boolean {
  const b = c.built();
  if (!b) return false;
  return c.apply(
    { kind: 'updatePlacements', drawingId: b.drawing.id, placements: [placement] },
    label,
    key,
  );
}

/** Starts picking replacement references for an annotation that needs attention. */
export function startReattach(c: DrawingController, annotationId: Id): void {
  const b = c.built();
  const a = b?.part.annotations?.find((x) => x.id === annotationId);
  if (!a) return;
  const needed = Math.max(a.refs.length, 1);
  c.ui.set((s) => ({
    ...s,
    tool: 'reattach',
    reattach: { annotationId, picked: [], needed },
    hint: {
      text:
        needed === 1
          ? 'Pick the edge this should attach to'
          : `Pick the new edge for reference 1 of ${needed}`,
      picks: [],
    },
  }));
}

/** One more edge for the reattach in progress; at the last one, one `reattachAnnotation` step. */
export async function reattachPick(c: DrawingController, pick: EdgePick): Promise<void> {
  const st = c.ui.get().reattach;
  const b = c.built();
  if (!st || !b) return;
  const picked = [...st.picked, pick];
  if (picked.length < st.needed) {
    c.ui.set((s) => ({
      ...s,
      reattach: { ...st, picked },
      hint: {
        text: `Pick the new edge for reference ${picked.length + 1} of ${st.needed}`,
        picks: picked,
      },
    }));
    return;
  }
  const refs = await Promise.all(picked.map((p) => refOf(c, p.name)));
  const old = b.part.annotations?.find((x) => x.id === st.annotationId);
  const at = old?.at;
  const ok = c.apply(
    {
      kind: 'reattachAnnotation',
      partId: b.part.id,
      annotationId: st.annotationId,
      refs,
      ...(at ? { at } : {}),
    },
    'Reattach annotation',
  );
  c.ui.set((s) => ({ ...s, tool: 'select', reattach: null, hint: null }));
  if (ok) c.toast('Reattached. The value is measured from the new geometry.');
}

// ---------------------------------------------------------------------------------------------
// Import model annotations
// ---------------------------------------------------------------------------------------------

/**
 * Plans "Import model annotations" for the drawing and opens the panel. Async: the anchors of
 * the promoted refs (fillets, chamfers, revolves) come from one query to the modelling worker, in
 * the drawing configuration's slot.
 */
export async function openImport(c: DrawingController): Promise<void> {
  const b = c.built();
  if (!b) return;
  const frames = new Map(b.main.result.sketches.map((s) => [s.featureId, s.frame] as const));
  const part = b.main.doc.parts.find((p) => p.id === b.part.id) ?? b.part;
  const queries = importAnchorQueries(part, frames);
  const modeling = c.wb.modeling;
  // The drawing's configuration lives in `main` when it is the active one, else in its own slot.
  const cfg = b.drawing.configurationId ?? null;
  const slot = cfg === host.activeIdOf(part) ? 'main' : host.slotOf(cfg);
  let anchors: ReturnType<typeof anchorLookup> | undefined;
  if (queries.length > 0 && modeling?.port.annotationAnchors) {
    try {
      const r = await modeling.port.annotationAnchors(part.id, queries, slot);
      if (r.ok) anchors = anchorLookup(queries, r.value);
    } catch {
      // Without anchors those promotions are reported as not placeable, never guessed.
    }
  }
  // The model may have changed while the worker answered: plan from what is shown now.
  const now = c.built() ?? b;
  const plan = planImport({
    drawing: now.drawing,
    part,
    views: now.build.views,
    resolutions: now.main.resolutions,
    projections: now.projections,
    sketchFrames: frames,
    ...(anchors ? { anchors } : {}),
    moveViews: true,
    tables: now.tableData,
    evaluate: now.evaluateAnnotation,
    newId: () => host.ulid(),
  });
  c.ui.set((s) => ({
    ...s,
    importPlan: plan,
    importChecked: new Set(
      plan.candidates.filter((x) => x.checked && x.placement).map((x) => x.key),
    ),
    panel: 'import',
  }));
}

/** Places the checked candidates (and the view moves they need): one undo step. */
export function commitImport(c: DrawingController): number {
  const { importPlan, importChecked } = c.ui.get();
  const b = c.built();
  if (!importPlan || !b) return 0;
  const cmds = importCommands(importPlan, b.drawing.id, importChecked);
  const place = cmds.find((x) => x.kind === 'placeAnnotations');
  const items = place && place.kind === 'placeAnnotations' ? place.items : [];
  if (items.length === 0) return 0;
  const key = `import:${host.ulid()}`;
  for (const cmd of cmds) {
    if (!c.apply(cmd, 'Import model annotations', key)) {
      c.commit();
      return 0;
    }
  }
  c.commit();
  c.ui.set((s) => ({
    ...s,
    importPlan: null,
    panel: 'inspector',
    fresh: items.map((i) => i.placement.id),
  }));
  c.toast(`Placed ${items.length} annotation${items.length === 1 ? '' : 's'}.`);
  return items.length;
}
