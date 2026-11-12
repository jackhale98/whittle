/**
 * Datums and tolerance frames on surfaces and on features of size (ADR-094, ISO 5459 / ISO 1101,
 * ASME Y14.5 §6.3 and §8):
 *
 * - **On a surface.** The pick is an edge line in a view; it maps to the face seen edge-on along
 *   it (the edge's name says which faces meet there, the kernel's anchors say which of them lies
 *   along the line in this view). The annotation refs that face; the triangle (or the frame's
 *   arrow) sits on its line, or on an extension of it.
 * - **On a feature of size.** The pick is a size dimension on the sheet. A datum sits in line with
 *   its dimension line (`dimensionLine`) and refs the feature (a cylinder's axis); a frame sits with
 *   its text (`placement`) and applies to it (`appliesTo`).
 *
 * Nothing is attached to a guessed entity: a pick that maps to no face, or to two, is refused
 * with the reason. Every creation is one `addAnnotation` with its placement: one undo step.
 */

import type {
  Annotation,
  AnnotationAnchor,
  AnnotationPlacement,
  DatumFeatureAnnotation,
  EntityRef,
  GeometricToleranceAnnotation,
  Id,
  PlacementLayout,
  Vec2,
} from '@wren-cad/contracts';
import {
  datumTriangleSize,
  dimensionLineEnd,
  edgeFaceNames,
  faceAlongLine,
  lineParameter,
  outwardOffset,
  type PlacedAnnotation,
  projectedSegment,
  type SolvedView,
  storableAttachT,
  viewToSheet,
} from '@wren-cad/drawing';
import { hitTest, type SheetPointer } from '@wren-cad/ui/drawing';
import type { DrawingController } from './controller';
import { host } from './host';
import { nextDatumLabel, refOf } from './ops-annot';
import type { Built } from './pipeline';
import type { EdgePick } from './state';

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (v: Vec2): Vec2 => [round3(v[0]), round3(v[1])];

// ---------------------------------------------------------------------------------------------
// Faces behind a pick
// ---------------------------------------------------------------------------------------------

/** Anchors of face refs in the drawing configuration's regen (one modelling-worker query). */
async function faceAnchors(
  c: DrawingController,
  refs: readonly { ref: EntityRef; annotationKind?: Annotation['kind'] }[],
): Promise<(AnnotationAnchor | null)[] | null> {
  const b = c.built();
  const modeling = c.wb.modeling;
  if (!b || !modeling?.port.annotationAnchors) return null;
  const part = b.main.doc.parts.find((p) => p.id === b.part.id) ?? b.part;
  const cfg = b.drawing.configurationId ?? null;
  const slot = cfg === host.activeIdOf(part) ? 'main' : host.slotOf(cfg);
  try {
    const r = await modeling.port.annotationAnchors(
      part.id,
      refs.map((q) => ({
        ref: q.ref,
        ...(q.annotationKind ? { annotationKind: q.annotationKind } : {}),
      })),
      slot,
    );
    return r.ok ? r.value.map((x) => x.anchor) : null;
  } catch {
    return null;
  }
}

export type SurfacePick =
  | { ok: true; ref: EntityRef; anchor: AnnotationAnchor; view: SolvedView; t: number }
  | { ok: false; message: string };

const NOT_A_LINE =
  'Pick the straight line a flat surface is seen as. For a hole or a cylinder, pick its diameter dimension: the datum or frame then goes on the feature of size.';

/** The face a picked edge line is the edge-on view of, in that view (never a guess). */
export async function surfaceOfPick(c: DrawingController, pick: EdgePick): Promise<SurfacePick> {
  const b = c.built();
  const sv = b?.build.views.get(pick.viewId);
  if (!b || !sv?.ok) return { ok: false, message: 'That view is not available.' };
  if (pick.ref === 'face' || pick.shape !== 'line' || !pick.geom || !('a' in pick.geom))
    return { ok: false, message: NOT_A_LINE };
  const line: [Vec2, Vec2] = [viewToSheet(sv, pick.geom.a), viewToSheet(sv, pick.geom.b)];
  const names = edgeFaceNames(pick.name);
  if (names.length === 0)
    return {
      ok: false,
      message:
        'This edge’s name does not say which faces meet there, so no surface can be found for it.',
    };
  const refs = await Promise.all(names.map((n) => refOf(c, n, 'face')));
  const anchors = await faceAnchors(
    c,
    refs.map((ref) => ({ ref })),
  );
  if (!anchors) return { ok: false, message: 'The model is still loading. Try again in a moment.' };
  // The view may have been rebuilt while the worker answered: measure in the view shown now.
  const now = c.built()?.build.views.get(pick.viewId);
  const v = now?.ok ? now : sv;
  const along = anchors
    .map((anchor, i) => ({ anchor, ref: refs[i] as EntityRef }))
    .filter((x): x is { anchor: AnnotationAnchor; ref: EntityRef } =>
      x.anchor ? faceAlongLine(v, x.anchor, line, Math.max(0.05, 0.01 * v.scale)) : false,
    );
  if (along.length === 0)
    return {
      ok: false,
      message:
        'No flat surface is seen edge-on along that line in this view. Pick the line a surface is seen as (in a view where it is seen side-on).',
    };
  if (along.length > 1)
    return {
      ok: false,
      message:
        'Two surfaces lie along that line in this view. Pick it in a view where only one of them is seen edge-on.',
    };
  const hit = along[0] as { anchor: AnnotationAnchor; ref: EntityRef };
  const seg = projectedSegment(v, hit.anchor);
  const t = seg ? lineParameter(seg, pick.at) : 0.5;
  return {
    ok: true,
    ref: hit.ref,
    anchor: hit.anchor,
    view: v,
    t: Math.round(storableAttachT(t) * 1e4) / 1e4,
  };
}

// ---------------------------------------------------------------------------------------------
// Size dimensions on the sheet
// ---------------------------------------------------------------------------------------------

export interface SizePick {
  placement: AnnotationPlacement;
  annotation: Annotation;
  placed: PlacedAnnotation;
  /** The pointer, sheet mm (which end of the dimension line it is nearer). */
  at: Vec2;
}

/** The dimension placement under the pointer, if any (the datum and frame tools pick those). */
export function dimensionAt(
  c: DrawingController,
  p: Pick<SheetPointer, 'at' | 'tol'>,
): SizePick | null {
  const b = c.built();
  const sheetId = c.sheet()?.id;
  const composed = b?.build.sheets.find((s) => s.sheetId === sheetId);
  if (!b || !composed) return null;
  const items = composed.list.items.filter((i) => i.source?.kind === 'placement');
  const hit = hitTest({ ...composed.list, items }, p.at, p.tol);
  if (hit?.source.kind !== 'placement') return null;
  const id = hit.source.placementId;
  const placement = b.drawing.placements.find((x) => x.id === id);
  const annotation = b.part.annotations?.find((a) => a.id === placement?.annotationId);
  const placed = b.build.placed.find((x) => x.placementId === id);
  if (!placement || !annotation || !placed) return null;
  const sizeKinds: Annotation['kind'][] = [
    'linear',
    'aligned',
    'ordinate',
    'radius',
    'diameter',
    'angle',
    'chamfer',
  ];
  return sizeKinds.includes(annotation.kind) ? { placement, annotation, placed, at: p.at } : null;
}

/** Why a dimension is not a feature of size (a width or a diameter), or undefined when it is. */
export function notASize(a: Annotation): string | undefined {
  if (a.kind === 'diameter') return undefined;
  if (a.kind === 'linear' && a.refs.length === 2 && (a.at ?? []).every((x) => x === 'self'))
    return undefined;
  if (a.kind === 'linear')
    return 'That dimension runs between centres: it locates features, it is not a size. Pick a diameter, or a width between two parallel faces.';
  return 'A feature of size is a diameter, or a width between two parallel faces: pick one of those dimensions.';
}

// ---------------------------------------------------------------------------------------------
// Datums
// ---------------------------------------------------------------------------------------------

function datumBase(b: Built): Omit<DatumFeatureAnnotation, 'refs' | 'at'> {
  const used = (b.part.annotations ?? []).flatMap((a) =>
    a.kind === 'datumFeature' ? [a.label] : [],
  );
  return {
    id: host.ulid(),
    kind: 'datumFeature',
    origin: { kind: 'drawing', drawingId: b.drawing.id },
    label: nextDatumLabel(used),
    standard: b.drawing.standard.gps,
  };
}

function place(
  c: DrawingController,
  annotation: Annotation,
  viewId: Id,
  layout: PlacementLayout,
  label: string,
): boolean {
  const b = c.built();
  if (!b) return false;
  const placement: AnnotationPlacement = {
    id: host.ulid(),
    viewId,
    annotationId: annotation.id,
    layout,
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
  if (ok) {
    c.select({ kind: 'placement', id: placement.id });
    c.patch({ hint: null });
  }
  return ok;
}

/** A datum on the surface a picked edge line shows: the triangle on that line. One undo step. */
export async function addDatumOnSurface(c: DrawingController, pick: EdgePick): Promise<boolean> {
  const s = await surfaceOfPick(c, pick);
  const b = c.built();
  if (!b) return false;
  if (!s.ok) {
    c.toast(s.message, 'error');
    return false;
  }
  const h = b.drawing.style.text.dimension;
  const text = outwardOffset(s.view, s.anchor, 3 * h + datumTriangleSize(h).height) ?? [0, -10];
  const annotation: DatumFeatureAnnotation = { ...datumBase(b), refs: [s.ref] };
  return place(
    c,
    annotation,
    pick.viewId,
    { kind: 'leader', attach: { kind: 'ref', index: 0, t: s.t }, text: r2(text) },
    'Add datum',
  );
}

/**
 * A datum on a feature of size (ADR-094): it names the size dimension (`appliesTo`; no refs of
 * its own), so it is that dimension's median plane (a width) or axis (a diameter), and follows
 * it. It sits in line with the dimension line, at the end nearer the pick.
 */
export async function addDatumOnSize(c: DrawingController, size: SizePick): Promise<boolean> {
  const b = c.built();
  if (!b) return false;
  const why = notASize(size.annotation);
  if (why) {
    c.toast(why, 'error');
    return false;
  }
  const taken = (b.part.annotations ?? []).find(
    (a) => a.kind === 'datumFeature' && a.appliesTo === size.annotation.id,
  );
  if (taken) {
    const placed = b.drawing.placements.find((p) => p.annotationId === taken.id);
    if (placed) c.select({ kind: 'placement', id: placed.id });
    c.toast(
      `This feature of size is already datum ${taken.kind === 'datumFeature' ? taken.label : ''}.`,
    );
    return false;
  }
  const line = size.placed.line;
  if (!line || Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]) < 1e-6) {
    c.toast('That dimension has no dimension line to attach to.', 'error');
    return false;
  }
  const t = dimensionLineEnd(lineParameter(line, size.at));
  const from = t === 0 ? line[1] : line[0];
  const to = t === 0 ? line[0] : line[1];
  const l = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const h = b.drawing.style.text.dimension;
  const reach = datumTriangleSize(h).height + 2 * h;
  const text: Vec2 = [((to[0] - from[0]) / l) * reach, ((to[1] - from[1]) / l) * reach];
  const annotation: DatumFeatureAnnotation = {
    ...datumBase(b),
    refs: [],
    appliesTo: size.annotation.id,
  };
  return place(
    c,
    annotation,
    size.placement.viewId,
    {
      kind: 'leader',
      attach: { kind: 'dimensionLine', placementId: size.placement.id, t },
      text: r2(text),
    },
    'Add datum on a feature of size',
  );
}

// ---------------------------------------------------------------------------------------------
// Tolerance frames
// ---------------------------------------------------------------------------------------------

function frameBase(
  b: Built,
): Omit<GeometricToleranceAnnotation, 'refs' | 'characteristic' | 'zone'> {
  return {
    id: host.ulid(),
    kind: 'geometricTolerance',
    origin: { kind: 'drawing', drawingId: b.drawing.id },
    standard: b.drawing.standard.gps,
  };
}

/** A frame on the surface a picked edge line shows: a leader with an arrow to that line. */
export async function addFrameOnSurface(c: DrawingController, pick: EdgePick): Promise<boolean> {
  const s = await surfaceOfPick(c, pick);
  const b = c.built();
  if (!b) return false;
  if (!s.ok) {
    c.toast(s.message, 'error');
    return false;
  }
  const h = b.drawing.style.text.dimension;
  const text = outwardOffset(s.view, s.anchor, 4 * h) ?? [10, 8];
  const frame: GeometricToleranceAnnotation = {
    ...frameBase(b),
    refs: [s.ref],
    characteristic: 'flatness',
    zone: { value: '0.1 mm' },
  };
  return place(
    c,
    frame,
    pick.viewId,
    { kind: 'leader', attach: { kind: 'ref', index: 0, t: s.t }, text: r2(text) },
    'Add tolerance frame',
  );
}

/**
 * A frame on a feature of size: under the size dimension's text, applying to it. A diameter gets
 * a Ø zone; position with the part's first datum when it has one (not one on this feature),
 * else the form of the axis or median plane (straightness, flatness), which needs no datum.
 */
export function addFrameOnSize(c: DrawingController, size: SizePick): boolean {
  const b = c.built();
  if (!b) return false;
  const why = notASize(size.annotation);
  if (why) {
    c.toast(why, 'error');
    return false;
  }
  const round = size.annotation.kind === 'diameter';
  // A datum on this feature itself is not a datum for its own frame: the dimension's faces (an
  // edge's are in its name), and any datum sitting on this dimension's line.
  const own = new Set(
    size.annotation.refs.flatMap((r) => [
      r.name,
      ...(r.kind === 'edge' ? edgeFaceNames(r.name) : []),
    ]),
  );
  const onLine = new Set(
    b.drawing.placements
      .filter(
        (p) =>
          p.layout.kind === 'leader' &&
          p.layout.attach.kind === 'dimensionLine' &&
          p.layout.attach.placementId === size.placement.id,
      )
      .map((p) => p.annotationId),
  );
  const datum = (b.part.annotations ?? []).find(
    (a) =>
      a.kind === 'datumFeature' &&
      a.appliesTo !== size.annotation.id &&
      !onLine.has(a.id) &&
      !a.refs.some((r) => own.has(r.name)),
  );
  const frame: GeometricToleranceAnnotation = {
    ...frameBase(b),
    refs: [],
    appliesTo: size.annotation.id,
    characteristic: datum ? 'position' : round ? 'straightness' : 'flatness',
    zone: { value: '0.1 mm', ...(round ? { shape: 'diameter' as const } : {}) },
    ...(datum ? { datums: [{ datums: [{ datum: datum.id }] }] } : {}),
  };
  return place(
    c,
    frame,
    size.placement.viewId,
    { kind: 'leader', attach: { kind: 'placement', placementId: size.placement.id }, text: [0, 0] },
    'Add tolerance frame on a feature of size',
  );
}
