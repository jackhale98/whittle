/**
 * packages/sketch's `reprojectLinked` behind the regen engine's `ReprojectLinked` seam (ADR-036
 * item 7, ADR-034 item 2). Convert Entities links each entity group to one model edge, so a source
 * with one finite curve goes to `@wren-cad/sketch/edit`: it keys on `ref.name` only, keeps ids,
 * keeps a line's orientation that moves its ends least, changes an exact entity's kind in place
 * when its edge changed kind, and re-fits approximate (polyline) chains by length fraction.
 *
 * Sources the sketch package doesn't model keep the engine's built-in fallback: reference geometry
 * seen as an infinite line (axes, plane traces), sources that project to several curves (a
 * face outline stored as one reference), and the M3.5 exact ellipses, elliptic arcs and splines.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type ProjectedEdge, reprojectLinked } from '@wren-cad/sketch/edit';
import {
  type LinkedSource,
  type ReprojectLinked,
  type ReprojectResult,
  reprojectLinkedFallback,
} from './linked';

const LOST = 'The model geometry it follows no longer projects onto this sketch';

/** One source the sketch package can re-project, as its `ProjectedEdge`; null otherwise. */
function asProjectedEdge(s: LinkedSource): ProjectedEdge | null {
  const c = s.curves[0];
  if (s.curves.length !== 1 || !c) return null;
  if (c.kind === 'point') return { ref: s.ref, curve: { kind: 'line', a: c.p, b: c.p } };
  if (c.kind === 'line' && 'infinite' in c) return null;
  // M3.5 exact ellipses / elliptic arcs / splines: re-projected by the engine's fallback until
  // packages/sketch's `ProjectedCurve` has them (ADR-046).
  if (c.kind === 'ellipse' || c.kind === 'ellipticArc' || c.kind === 'bspline') return null;
  return { ref: s.ref, curve: c };
}

export const reprojectLinkedSketch: ReprojectLinked = (entities, sources) => {
  const edges: ProjectedEdge[] = [];
  const rest: LinkedSource[] = [];
  for (const s of sources) {
    const e = asProjectedEdge(s);
    if (e) edges.push(e);
    else rest.push(s);
  }
  if (edges.length === 0) return reprojectLinkedFallback(entities, sources);
  const restNames = new Set(rest.map((s) => s.ref.name));
  const r = reprojectLinked({ entities: [...entities], constraints: [] }, edges);
  const lost: ReprojectResult['lost'] = r.lost
    .filter((l) => !restNames.has(l.ref.name))
    .flatMap((l) => l.entities.map((entity) => ({ entity, reason: LOST })));
  if (rest.length === 0) return { entities: r.sketch.entities, lost };
  const fb = reprojectLinkedFallback(r.sketch.entities, rest);
  return { entities: fb.entities, lost: [...lost, ...fb.lost] };
};
