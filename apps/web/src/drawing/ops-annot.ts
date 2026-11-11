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
  PlacementLayout,
  RefPoint,
  SurfaceFinishAnnotation,
  Vec2,
  Vec3,
} from '@wren-cad/contracts';
import { importCommand, planImport, type SolvedView, viewOutline } from '@wren-cad/drawing';
import type { DrawingController } from './controller';
import { host } from './host';
import type { Built } from './pipeline';
import type { EdgePick } from './state';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------
// Picks
// ---------------------------------------------------------------------------------------------

/** What an edge on a view is, from the kernel's projected curves (the first run of that name). */
export function pickEdge(
  c: DrawingController,
  viewId: Id,
  name: string,
  at: Vec2,
): EdgePick | null {
  const proj = c.built()?.projections.get(viewId);
  const curve = proj?.curves.find((k) => k.name === name && k.role === 'visible')?.curve;
  if (!curve) return null;
  if (curve.kind === 'arc')
    return {
      viewId,
      name,
      at,
      shape: 'circle',
      geom: {
        centre: curve.center,
        radius: curve.radius,
        full: Math.abs(curve.end - curve.start - TAU) < 1e-6,
      },
    };
  if (curve.kind === 'line')
    return { viewId, name, at, shape: 'line', geom: { a: curve.a, b: curve.b } };
  return { viewId, name, at, shape: 'other' };
}

async function refOf(c: DrawingController, name: string): Promise<EntityRef> {
  const plain: EntityRef = { name, kind: 'edge' };
  const wb = c.wb;
  const r = wb.regen.get()?.result;
  const part = wb.part;
  if (!r || !part || !wb.modeling) return plain;
  for (const b of r.bodies) {
    const i = b.mesh.edgeNames.indexOf(name);
    if (i < 0) continue;
    const ref = await wb.modeling.refFor(part.id, { bodyId: b.id, kind: 'edge', index: i });
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
  | { ok: true; annotation: Omit<Annotation, 'id'>; layout: PlacementLayout; viewId: Id }
  | { ok: false; message: string };

function laneFor(b: Built, viewId: Id, side: 'top' | 'bottom' | 'left' | 'right'): number {
  const used = b.drawing.placements.filter(
    (p) => p.viewId === viewId && p.layout.kind === 'lane' && p.layout.side === side,
  );
  return used.length === 0
    ? 0
    : Math.max(...used.map((p) => (p.layout.kind === 'lane' ? p.layout.lane : 0))) + 1;
}

/** Which dimension the picks mean, and where it goes. Pure: refs are attached by the caller. */
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
    if (Math.abs(ta[0] * tb[0] + ta[1] * tb[1]) < 0.985)
      return {
        ok: false,
        message: 'Those edges are not parallel. Pick two parallel edges, or an edge and a circle.',
      };
    const n: Vec2 = [-ta[1], ta[0]];
    measuredAxis = Math.abs(n[0]) > 0.98 ? 'x' : Math.abs(n[1]) > 0.98 ? 'y' : null;
    direction = measuredAxis === 'x' ? frame.x : measuredAxis === 'y' ? frame.y : undefined;
    at.push('self', 'self');
  } else return { ok: false, message: 'Pick two edges.' };

  const outline = viewOutline(sv);
  const mid: Vec2 = [(first.at[0] + second.at[0]) / 2, (first.at[1] + second.at[1]) / 2];
  const cx = (outline.min[0] + outline.max[0]) / 2;
  const cy = (outline.min[1] + outline.max[1]) / 2;
  let layout: PlacementLayout;
  if (measuredAxis === 'x') {
    const side = mid[1] < cy ? 'bottom' : 'top';
    layout = { kind: 'lane', side, lane: laneFor(b, first.viewId, side) };
  } else if (measuredAxis === 'y') {
    const side = mid[0] < cx ? 'left' : 'right';
    layout = { kind: 'lane', side, lane: laneFor(b, first.viewId, side) };
  } else layout = { kind: 'offset', distance: 10 };

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
  const refs = await Promise.all(names.map((n) => refOf(c, n)));
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

/** Plans "Import model annotations" for the drawing and opens the panel. */
export function openImport(c: DrawingController): void {
  const b = c.built();
  if (!b) return;
  const frames = new Map(b.main.result.sketches.map((s) => [s.featureId, s.frame] as const));
  const part = b.main.doc.parts.find((p) => p.id === b.part.id) ?? b.part;
  const plan = planImport({
    drawing: b.drawing,
    part,
    views: b.build.views,
    resolutions: b.main.resolutions,
    projections: b.projections,
    sketchFrames: frames,
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

/** Places the checked candidates: one `placeAnnotations` step. */
export function commitImport(c: DrawingController): number {
  const { importPlan, importChecked } = c.ui.get();
  const b = c.built();
  if (!importPlan || !b) return 0;
  const cmd = importCommand(importPlan, b.drawing.id, importChecked);
  if (cmd.items.length === 0) return 0;
  const ok = c.apply(cmd, 'Import model annotations');
  if (!ok) return 0;
  c.ui.set((s) => ({
    ...s,
    importPlan: null,
    panel: 'inspector',
    fresh: cmd.items.map((i) => i.placement.id),
  }));
  c.toast(`Placed ${cmd.items.length} annotation${cmd.items.length === 1 ? '' : 's'}.`);
  return cmd.items.length;
}
