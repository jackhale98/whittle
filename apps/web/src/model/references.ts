/**
 * Reference geometry in the viewport (ADR-093): which planes, axes and points are drawn, and the
 * persistent names their picks resolve to. One function decides, and the tree's eye and the
 * viewport both use it, so the eye cannot disagree with what is on screen.
 *
 * - Absent or `'auto'` visibility is shown: reference geometry is not consumed away like a sketch.
 * - `'hidden'` hides it everywhere, and a hidden reference is not pickable in the view (the tree
 *   still reaches it).
 * - A plane, axis or point that the regen did not evaluate (suppressed, failed, rolled back) has
 *   no result and so is never drawn, whatever its setting.
 */

import type {
  EntityKind,
  EntityRef,
  Feature,
  Id,
  ReferenceResult,
  RegenResult,
} from '@wren-cad/contracts';
import type { ViewportReference } from '@wren-cad/viewport';
import { isReferenceFeature, referenceName } from './reference-names';

export {
  isOriginName,
  isReferenceFeature,
  isReferenceName,
  referenceName,
} from './reference-names';

export type ReferenceKind = ReferenceResult['kind'];

const ENTITY_KIND: Record<ReferenceKind, EntityKind> = {
  plane: 'face',
  axis: 'edge',
  point: 'vertex',
};

/** The `EntityRef` of a reference feature: plane = face, axis = edge, point = vertex. */
export function referenceRef(id: Id, kind: ReferenceKind): EntityRef {
  return { name: referenceName(id, kind), kind: ENTITY_KIND[kind] };
}

/** The viewport's visibility of one reference feature (what the tree's eye shows). */
export function referenceShown(f: Feature, evaluated: ReadonlySet<Id>): boolean {
  if (!isReferenceFeature(f)) return false;
  const vis = (f as { visibility?: string }).visibility;
  return evaluated.has(f.id) && vis !== 'hidden';
}

/** What the viewport is given: the evaluated references that are not hidden, with their labels. */
export function viewportReferences(
  result: Pick<RegenResult, 'references'> | undefined,
  features: readonly Feature[],
): { refs: ViewportReference[]; shown: Set<Id> } {
  const byId = new Map(features.map((f) => [f.id, f]));
  const evaluated = new Set<Id>((result?.references ?? []).map((r) => r.featureId));
  const refs: ViewportReference[] = [];
  const shown = new Set<Id>();
  for (const r of result?.references ?? []) {
    const f = byId.get(r.featureId);
    if (!f || !referenceShown(f, evaluated)) continue;
    shown.add(f.id);
    refs.push({
      name: referenceName(r.featureId, r.kind),
      kind: r.kind,
      label: f.name,
      frame: r.frame,
      extent: r.extent,
    });
  }
  return { refs, shown };
}

/** The origin planes and axes show when the per-device toggle is on or the plane chooser is open. */
export function originShown(toggle: boolean, chooserOpen: boolean): boolean {
  return toggle || chooserOpen;
}
