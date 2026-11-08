/**
 * Sketch reference geometry (ADR-017 item 1): every sketch implicitly has a fixed origin point
 * (`@origin`, sketch-local (0, 0)) and its two axes (`@x` along +u, `@y` along +v). Constraints and
 * dimensions reference these ids like entities; they are never stored in `entities`, never form
 * profiles and carry no degrees of freedom.
 *
 * `referenceEntities()` describes them as ordinary contract entities so that geometry code (the
 * solver model, dimension measuring, label placement in the app) can treat them uniformly: the
 * origin is a point at (0, 0), and each axis is a line from the origin to a unit point on it
 * (`@x:end` at (1, 0), `@y:end` at (0, 1)). Only the line's direction matters: every relation the
 * solver offers on an axis (point on, distance, angle, parallel, tangent, symmetry) treats a line as
 * infinite. The end points are internal: they are not referenceable ids.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  type Id,
  SKETCH_ORIGIN,
  SKETCH_REFERENCES,
  SKETCH_X_AXIS,
  SKETCH_Y_AXIS,
  type SketchConstraint,
  type SketchEntity,
  type SketchReferenceId,
} from '@whittle/contracts';

export { SKETCH_ORIGIN, SKETCH_REFERENCES, SKETCH_X_AXIS, SKETCH_Y_AXIS };

/** Internal end points of the axis lines (direction only). */
export const X_AXIS_END = '@x:end';
export const Y_AXIS_END = '@y:end';

const REFERENCE_SET: ReadonlySet<string> = new Set(SKETCH_REFERENCES);
const RESERVED: ReadonlySet<string> = new Set([...SKETCH_REFERENCES, X_AXIS_END, Y_AXIS_END]);

/** True for `@origin`, `@x` and `@y`. */
export function isSketchReference(id: Id): id is SketchReferenceId {
  return REFERENCE_SET.has(id);
}

/** True for ids user entities may not use (the references and their internal end points). */
export function isReservedSketchId(id: Id): boolean {
  return RESERVED.has(id);
}

const NAMES: Record<SketchReferenceId, string> = {
  [SKETCH_ORIGIN]: 'the origin',
  [SKETCH_X_AXIS]: 'the horizontal axis',
  [SKETCH_Y_AXIS]: 'the vertical axis',
};

/** Plain-language name, lower case for use inside a sentence ("the origin"). */
export function referenceName(id: SketchReferenceId): string {
  return NAMES[id];
}

/**
 * The reference geometry as contract entities: the origin point, the axes' internal end points
 * and the two axis lines (always in this order; all `construction`).
 */
export function referenceEntities(): SketchEntity[] {
  return [
    { id: SKETCH_ORIGIN, kind: 'point', construction: true, x: 0, y: 0 },
    { id: X_AXIS_END, kind: 'point', construction: true, x: 1, y: 0 },
    { id: Y_AXIS_END, kind: 'point', construction: true, x: 0, y: 1 },
    { id: SKETCH_X_AXIS, kind: 'line', construction: true, start: SKETCH_ORIGIN, end: X_AXIS_END },
    { id: SKETCH_Y_AXIS, kind: 'line', construction: true, start: SKETCH_ORIGIN, end: Y_AXIS_END },
  ];
}

/** Every entity id a constraint refers to (all string fields except its own id and kind). */
export function constraintRefs(c: SketchConstraint): Id[] {
  const out: Id[] = [];
  for (const [k, v] of Object.entries(c)) {
    if (k === 'id' || k === 'kind' || k === 'value' || k === 'driving' || k === 'label') continue;
    if (typeof v === 'string') out.push(v);
  }
  return out;
}

/** True when any constraint refers to the origin or an axis. */
export function usesReferences(constraints: readonly SketchConstraint[]): boolean {
  for (const c of constraints)
    for (const id of constraintRefs(c)) if (isSketchReference(id)) return true;
  return false;
}
