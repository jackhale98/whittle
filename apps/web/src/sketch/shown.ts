/**
 * What an open sketch draws when the active configuration (or a parameter change) moves its
 * geometry (ADR-080). The document keeps the Default geometry; the solved geometry for the values
 * in force is display state only, valid for exactly the entities it was solved from.
 */
import type { SketchConstraint, SketchEntity, SketchFeature } from '@wren-cad/contracts';

export interface ShownSketch {
  /** The stored entities this was solved from: any other array means it is stale and ignored. */
  for: readonly SketchEntity[];
  entities: readonly SketchEntity[];
  constraints: readonly SketchConstraint[];
}

export function displayFeature(
  f: SketchFeature,
  shown: ShownSketch | null | undefined,
): SketchFeature {
  if (!shown || shown.for !== f.entities) return f;
  return { ...f, entities: [...shown.entities], constraints: [...shown.constraints] };
}
