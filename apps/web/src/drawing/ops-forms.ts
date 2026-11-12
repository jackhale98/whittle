/**
 * M4.1 (ADR-095) annotation forms and the one-pick radius on a face:
 *  - a diameter and the same circle's size in linear form (refs [c, c] at ['min', 'max'] along
 *    the view's x or y), switched in the inspector: the annotation and its placement in one undo
 *    step;
 *  - an angle measured from its second face's normal (a draft angle, at ['self', 'axis']);
 *  - a radius on a face whose outline is not an arc (a fillet at a shaft step is a torus, its
 *    outline a B-spline): stored only when the face is round, refused with the reason otherwise.
 */

import type {
  Annotation,
  AnnotationAnchor,
  AnnotationPlacement,
  Id,
  PlacementLayout,
  Vec3,
} from '@wren-cad/contracts';
import { partToSheet, projectCircle, type SolvedView } from '@wren-cad/drawing';
import type { DrawingController } from './controller';
import { host } from './host';
import { laneBeside, refOf, updateAnnotation, updatePlacement } from './ops-annot';
import { faceAnchors } from './ops-gdt';
import type { Built } from './pipeline';
import type { EdgePick } from './state';

export type DiameterForm = 'diameter' | 'x' | 'y';

const parallel = (a: Vec3, b: Vec3) => {
  const la = Math.hypot(...a) || 1;
  const lb = Math.hypot(...b) || 1;
  return Math.abs(Math.abs((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb)) - 1) < 1e-6;
};

function viewOf(b: Built, placement: AnnotationPlacement): SolvedView | undefined {
  const sv = b.build.views.get(placement.viewId);
  return sv?.ok ? sv : undefined;
}

/**
 * The form of a diameter-like annotation on this placement's view: a diameter (`diameter`), or a
 * linear across one circle (refs [c, c] at ['min', 'max']) along the view's `x` or `y`. Undefined
 * for anything else (no form to offer).
 */
export function diameterFormOf(
  b: Built,
  a: Annotation,
  placement: AnnotationPlacement,
): DiameterForm | undefined {
  if (a.kind === 'diameter') return a.refs.length === 1 ? 'diameter' : undefined;
  if (a.kind !== 'linear' || a.refs.length !== 2 || !a.direction) return undefined;
  if (a.refs[0]?.name !== a.refs[1]?.name || a.at?.[0] !== 'min' || a.at?.[1] !== 'max')
    return undefined;
  const sv = viewOf(b, placement);
  if (!sv) return undefined;
  if (parallel(a.direction, sv.frame.x)) return 'x';
  if (parallel(a.direction, sv.frame.y)) return 'y';
  return undefined;
}

/**
 * Rewrites a diameter to the chosen form (or back): the same annotation id, its tolerance, stated
 * value and text kept, and its placement's layout (radial for a circle seen face-on, a lane beside
 * the view for linear). One coalescing key: one undo step.
 */
export function setDiameterForm(
  c: DrawingController,
  placementId: Id,
  form: DiameterForm,
): boolean {
  const b = c.built();
  const pl = b?.drawing.placements.find((p) => p.id === placementId);
  const a = pl ? (b?.part.annotations ?? []).find((x) => x.id === pl.annotationId) : undefined;
  if (!b || !pl || !a) return false;
  const sv = viewOf(b, pl);
  const now = diameterFormOf(b, a, pl);
  if (!sv || now === undefined || now === form) return false;
  const ref = a.refs[0];
  if (!ref) return false;
  const anchor = b.main.resolutions.get(a.id)?.anchors?.[0] ?? null;
  const centre = anchorSheetCentre(sv, anchor) ?? sv.position;
  let next: Annotation;
  let layout: PlacementLayout;
  if (form === 'diameter') {
    const {
      kind: _k,
      refs: _r,
      at: _a,
      direction: _d,
      ...rest
    } = a as Extract<Annotation, { kind: 'linear' }>;
    next = { ...rest, kind: 'diameter', refs: [ref] } as Annotation;
    const faceOn = anchor?.kind === 'circle' && projectCircle(sv, anchor).kind === 'faceOn';
    // Seen face-on a diameter is radial; otherwise it stays across, in the lane it had.
    layout = faceOn ? { kind: 'radial', angle: 45, distance: 6 } : pl.layout;
  } else {
    const { kind: _k, refs: _r, at: _a, ...rest } = a as Extract<Annotation, { kind: 'diameter' }>;
    next = {
      ...rest,
      kind: 'linear',
      refs: [ref, ref],
      at: ['min', 'max'],
      direction: form === 'x' ? sv.frame.x : sv.frame.y,
    } as Annotation;
    layout =
      pl.layout.kind === 'lane' && sideAxis(pl) === form
        ? pl.layout
        : laneBeside(b, sv, [{ at: centre }], form);
  }
  const key = `form:${a.id}:${host.ulid()}`;
  const label = form === 'diameter' ? 'Show as a diameter' : 'Show as linear across';
  const ok =
    updateAnnotation(c, next, label, key) &&
    updatePlacement(c, { ...pl, layout } as AnnotationPlacement, label, key);
  c.commit();
  return ok;
}

/** The view axis a lane placement measures along (top/bottom: x; left/right: y). */
function sideAxis(pl: AnnotationPlacement): 'x' | 'y' | null {
  if (pl.layout.kind !== 'lane') return null;
  return pl.layout.side === 'top' || pl.layout.side === 'bottom' ? 'x' : 'y';
}

function anchorSheetCentre(sv: SolvedView, a: AnnotationAnchor | null) {
  if (!a) return undefined;
  if (a.kind === 'circle' || a.kind === 'torus') return partToSheet(sv, a.center);
  if (a.kind === 'point') return partToSheet(sv, a.at);
  return undefined;
}

/** Whether the inspector offers "from the normal of the second face" for this annotation. */
export function fromNormalOf(a: Annotation): boolean | undefined {
  if (a.kind !== 'angle' || a.refs.length !== 2 || a.refs[1]?.kind !== 'face') return undefined;
  return a.at?.[1] === 'axis';
}

/** Measures an angle from its second face's normal (a draft angle), or between the faces. */
export function setAngleFromNormal(c: DrawingController, annotationId: Id, on: boolean): boolean {
  const a = (c.built()?.part.annotations ?? []).find((x) => x.id === annotationId);
  if (!a || fromNormalOf(a) === undefined || fromNormalOf(a) === on) return false;
  return updateAnnotation(
    c,
    { ...a, at: [a.at?.[0] ?? 'self', on ? 'axis' : 'self'] } as Annotation,
    on ? 'Measure from the face normal' : 'Measure between the faces',
  );
}

const SHAPE_WORDS: Partial<Record<AnnotationAnchor['kind'], string>> = {
  plane: 'flat',
  axis: 'a cylinder or a cone seen along its side',
  line: 'straight',
  curve: 'a free-form curve',
};

/**
 * A radius (or, asked for, a diameter) on the face a curved outline outlines (M4.1): the outline
 * picked twice, as a circle is. The face's radius anchor from the modelling worker decides: a torus
 * (a fillet at a shaft step; always a radius), a circle or a sphere gets the dimension on that
 * face; anything else is refused with the reason, never guessed.
 */
export async function addRadiusOnFace(
  c: DrawingController,
  pick: EdgePick,
  opts: { diameter?: boolean } = {},
): Promise<boolean> {
  const b = c.built();
  const face = pick.ref === 'face' ? pick.name : pick.face;
  if (!b || !face) {
    c.toast('That edge is curved: pick a straight edge or a circle.', 'error');
    return false;
  }
  const ref = await refOf(c, face, 'face');
  const anchors = await faceAnchors(c, [{ ref, annotationKind: 'radius' }]);
  if (!anchors) {
    c.toast('The model is still loading. Try again in a moment.', 'error');
    return false;
  }
  const anchor = anchors[0] ?? null;
  if (!anchor) {
    c.toast(
      'That outline’s face did not resolve in the model, so it has no radius to show.',
      'error',
    );
    return false;
  }
  if (anchor.kind !== 'torus' && anchor.kind !== 'circle' && anchor.kind !== 'point') {
    const what = SHAPE_WORDS[anchor.kind] ?? 'not round';
    c.toast(
      `That outline’s face is ${what}, so it has no radius. Pick an arc or a circle.`,
      'error',
    );
    return false;
  }
  const now = c.built() ?? b;
  const sv = now.build.views.get(pick.viewId);
  // A torus: the meridian on the side that was picked (the leader angle points there).
  let angle = 45;
  if (anchor.kind === 'torus' && sv?.ok) {
    const cs = partToSheet(sv, anchor.center);
    angle = Math.round((Math.atan2(pick.at[1] - cs[1], pick.at[0] - cs[0]) * 180) / Math.PI);
  }
  const id = host.ulid();
  const annotation: Annotation = {
    id,
    // A torus is sized by its radius (a fillet); a round face's diameter when asked for.
    kind: opts.diameter && anchor.kind !== 'torus' ? 'diameter' : 'radius',
    origin: { kind: 'drawing', drawingId: now.drawing.id },
    refs: [ref],
  };
  const placement: AnnotationPlacement = {
    id: host.ulid(),
    viewId: pick.viewId,
    annotationId: id,
    layout: { kind: 'radial', angle, distance: 6 },
  };
  const ok = c.apply(
    {
      kind: 'addAnnotation',
      partId: now.part.id,
      annotation,
      place: { drawingId: now.drawing.id, placement },
    },
    annotation.kind === 'diameter' ? 'Add diameter dimension' : 'Add radius dimension',
  );
  if (ok) {
    c.select({ kind: 'placement', id: placement.id });
    c.patch({ hint: null });
  }
  return ok;
}
