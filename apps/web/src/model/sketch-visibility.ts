/**
 * Which sketches the viewport shows (ADR-060, M3.6 / ADR-066). One function decides, and both the
 * viewport and the tree's eye use it, so the eye always matches what is on screen.
 *
 * - `shown` shows the sketch even when a feature consumed it.
 * - `hidden` hides it even when nothing consumed it (a profile being picked still brings it back,
 *   or the user could not pick from it).
 * - `auto` (or absent) is the ADR-060 rule: shown until consumed; a sketch comes back while its
 *   consuming feature is being edited, or while a region is being picked.
 * - The sketch being edited is always shown (the sketch session owns its overlay).
 */

import type { Feature, Id, SketchFeature } from '@wren-cad/contracts';
import { effectiveSketchShown } from '@wren-cad/ui';
import { consumedSketchRefs } from '../features/factories';

export interface VisibilityContext {
  features: readonly Feature[];
  /** Features at an index >= this are rolled back: they consume nothing. */
  rollback: number;
  /** The sketch in sketch mode. */
  activeSketch?: Id | undefined;
  /** The feature open in the inspector. */
  editing?: Feature | undefined;
  /** Regions, sketch curves or points are being picked (a profile, a sweep path, a hole centre). */
  wantRegions: boolean;
}

/** Does `f` use sketch `id`? */
export function usesSketch(f: Feature | undefined, id: Id): boolean {
  return !!f && consumedSketchRefs(f).some((r) => r.name.startsWith(`S${id}:`));
}

/** Whether a feature that is not rolled back consumes the sketch. */
export function isConsumed(ctx: VisibilityContext, id: Id): boolean {
  const n = Math.min(ctx.rollback, ctx.features.length);
  for (let i = 0; i < n; i++) if (usesSketch(ctx.features[i], id)) return true;
  return false;
}

export function sketchShown(sketch: SketchFeature, ctx: VisibilityContext): boolean {
  if (ctx.activeSketch === sketch.id) return true;
  const vis = sketch.visibility;
  if (vis === 'shown') return true;
  if (ctx.wantRegions) return true;
  if (vis === 'hidden') return false;
  const related = ctx.editing?.id === sketch.id || usesSketch(ctx.editing, sketch.id);
  return related || effectiveSketchShown(vis, isConsumed(ctx, sketch.id));
}
