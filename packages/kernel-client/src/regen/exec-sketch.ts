/**
 * Sketch features: the plane, the linked-entity pipeline (Convert Entities: sources resolved,
 * projected onto the sketch plane and re-projected, linked.ts) and the planegcs solve.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  EntityRef,
  Frame,
  Id,
  KernelError,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  UnresolvedRef,
  Vec2,
  Vec3,
} from '@wren-cad/contracts';
import { sketchSolveValues } from '@wren-cad/document';
import type { EngineCore } from './core';
import { frameLine, toLocal } from './datums';
import { cross, dot, normalize, ORIGIN_AXES, ORIGIN_PLANES, sub } from './geometry';
import { hashKey } from './hash';
import { kerr } from './helpers';
import {
  flattenProjection,
  type LinkedCurve,
  type LinkedSource,
  projectAxis,
  projectCircle,
  projectPlaneTrace,
  projectPoint,
  projectSketchEntity,
} from './linked';
import {
  AXIS_NAME,
  PLANE_NAME,
  POINT_NAME,
  partDiag,
  resolveAxis,
  resolvePlane,
  resolvePoint,
  resolveSub,
  SKETCH_TAG,
} from './refs';
import type { Planned, SketchState, WalkContext } from './state';

export async function planSketch(
  core: EngineCore,
  ctx: WalkContext,
  f: SketchFeature,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const plane = await resolvePlane(core, ctx, f.on, '/on', unresolved);
  if (plane === null) return { unresolved, taint: [] };
  if ('code' in plane) return { unresolved, taint: [], error: plane };
  const owner = plane.target?.owner;
  const involved = owner && ctx.state.bodies.has(owner) ? [owner] : [];
  const solveValues = sketchSolveValues(f, { values, errors: {} }).values;
  const frame = plane.frame;
  let entities = f.entities;
  let constraints = f.constraints;
  if (f.entities.some((e) => e.source)) {
    const linked = await linkedEntities(core, ctx, f, frame, unresolved, involved);
    if ('code' in linked) return { unresolved, taint: [], error: linked };
    if ('attention' in linked) return { unresolved, taint: [], attention: linked.attention };
    entities = linked.entities;
    constraints = linked.constraints;
  }
  const key = hashKey({
    t: 'sketch',
    id: f.id,
    entities,
    constraints,
    values: solveValues,
    frame,
  });
  return {
    unresolved,
    taint: [],
    plan: {
      key,
      involved,
      run: async () => {
        core.solver ??= await core.solverLoader();
        const solved = core.solver.solve({ entities, constraints, values: solveValues });
        if (solved.status !== 'solved') {
          const c = solved.conflicts[0];
          const error =
            solved.status === 'conflicting' && c
              ? kerr('INVALID_INPUT', `The sketch is over-constrained: ${c.explanation}`, {
                  ...(c.fixes[0] ? { hint: c.fixes[0].label } : {}),
                  detail: `conflicting constraints: ${c.constraints.join(', ')}`,
                })
              : kerr('OPERATION_FAILED', solved.error ?? 'The sketch could not be solved', {
                  hint: 'Check the dimensions for values that cannot all hold at once.',
                });
          return { result: { ok: false, error }, owned: [] };
        }
        const r = await core.exec(
          { ...f, entities: solved.entities },
          { values: {}, frames: { plane: frame } },
        );
        if (!r.ok) return { result: { ok: false, error: r.error }, owned: [] };
        const sketch: SketchState = {
          id: f.id,
          shape: r.value.shape,
          naming: r.value.naming,
          frame, // ours (deterministic; the kernel echoes it)
          regions: r.value.regions ?? [],
          entities: solved.entities,
          key: `${key}/S`,
        };
        if (Object.keys(solved.driven ?? {}).length > 0) sketch.driven = { ...solved.driven };
        return {
          result: {
            ok: true,
            set: [],
            remove: [],
            touched: [],
            sketch,
            warnings: r.value.warnings,
          },
          owned: [r.value.shape],
        };
      },
    },
  };
}

/**
 * Resolves and projects the sources of a sketch's linked entities and re-projects them (see
 * linked.ts). Returns the entities and constraints to solve, `attention` (entity names) when a
 * source is lost — the sketch then needs attention and nothing is re-picked — or an error.
 */
async function linkedEntities(
  core: EngineCore,
  ctx: WalkContext,
  f: SketchFeature,
  plane: Frame,
  unresolved: UnresolvedRef[],
  involved: string[],
): Promise<
  | { entities: SketchEntity[]; constraints: SketchConstraint[] }
  | { attention: string[] }
  | KernelError
> {
  const groups = new Map<string, { ref: EntityRef; ids: Id[]; paths: string[] }>();
  f.entities.forEach((e, i) => {
    if (!e.source) return;
    const k = `${e.source.ref.kind}|${e.source.ref.name}`;
    let g = groups.get(k);
    if (!g) {
      g = { ref: e.source.ref, ids: [], paths: [] };
      groups.set(k, g);
    }
    g.ids.push(e.id);
    g.paths.push(`/entities/${i}/source/ref`);
  });
  const attention: string[] = [];
  const sources: LinkedSource[] = [];
  for (const g of groups.values()) {
    const u: UnresolvedRef[] = [];
    const before = ctx.current.rebound.length;
    const p = await projectSource(core, ctx, f, g.ref, g.paths[0] as string, u, plane);
    if (p && 'code' in p) return p;
    // Every entity sharing a source shares its outcome and its healing.
    const healed = ctx.current.rebound.slice(before);
    for (const path of g.paths.slice(1)) {
      for (const r of healed) ctx.current.rebound.push({ ...r, path });
    }
    if (!p) {
      const first: UnresolvedRef = u[0] ?? { path: '', ref: g.ref, reason: 'missing' };
      for (const path of g.paths) unresolved.push({ ...first, path });
      attention.push(...g.ids.map((id) => entityName(f, id)));
      continue;
    }
    if (p.owner && ctx.state.bodies.has(p.owner) && !involved.includes(p.owner)) {
      involved.push(p.owner);
    }
    const s: LinkedSource = { ref: g.ref, entities: g.ids, curves: p.curves };
    if (p.curves.some((c) => c.kind === 'polyline')) s.approximate = true;
    sources.push(s);
  }
  if (attention.length > 0) return { attention };
  const rp = core.reproject(f.entities, sources);
  for (const l of rp.lost) {
    const i = f.entities.findIndex((e) => e.id === l.entity);
    const e = f.entities[i];
    if (!e?.source) continue;
    unresolved.push({ path: `/entities/${i}/source/ref`, ref: e.source.ref, reason: 'missing' });
    attention.push(entityName(f, l.entity));
  }
  if (attention.length > 0) return { attention };
  // Linked entities are fixed for the solver (grounding twice is harmless if it already is).
  const fixed = new Set<Id>();
  for (const e of rp.entities) {
    if (!e.source) continue;
    fixed.add(e.id);
    if (e.kind === 'line') fixed.add(e.start).add(e.end);
    if (e.kind === 'circle' || e.kind === 'ellipse') fixed.add(e.center);
    if (e.kind === 'arc' || e.kind === 'ellipticArc') fixed.add(e.center).add(e.start).add(e.end);
    if (e.kind === 'bspline') for (const id of e.poles) fixed.add(id);
  }
  const fixes = [...fixed].map(
    (id): SketchConstraint => ({ id: `@linked:${id}`, kind: 'fix', entity: id }),
  );
  return { entities: rp.entities, constraints: [...f.constraints, ...fixes] };
}

/** One linked source projected onto the sketch plane; null when it does not resolve. */
async function projectSource(
  core: EngineCore,
  ctx: WalkContext,
  f: SketchFeature,
  ref: EntityRef,
  path: string,
  unresolved: UnresolvedRef[],
  plane: Frame,
): Promise<{ curves: LinkedCurve[]; owner?: string } | KernelError | null> {
  const fail = (message: string, code: KernelError['code'] = 'INVALID_INPUT') =>
    kerr(code, message, {
      hint: 'Pick another source, or unlink the entity.',
      entityRefs: [ref.name],
    });
  const one = (c: LinkedCurve | { error: string }, owner?: string) =>
    'error' in c ? fail(c.error) : owner ? { curves: [c], owner } : { curves: [c] };
  if (ref.name === 'origin:O') return one(projectPoint(plane, [0, 0, 0]));
  const oa = ORIGIN_AXES[ref.name];
  if (oa) return one(projectAxis(plane, frameLine(oa)));
  const op = ORIGIN_PLANES[ref.name];
  if (op) return one(projectPlaneTrace(plane, op));
  if (AXIS_NAME.test(ref.name)) {
    const a = await resolveAxis(core, ctx, ref, path, unresolved, false);
    if (!a || 'code' in a) return a;
    return one(projectAxis(plane, a.line));
  }
  if (POINT_NAME.test(ref.name)) {
    const p = await resolvePoint(core, ctx, ref, path, unresolved);
    if (!p || 'code' in p) return p;
    return one(projectPoint(plane, p.point));
  }
  if (PLANE_NAME.test(ref.name)) {
    const p = await resolvePlane(core, ctx, ref, path, unresolved);
    if (!p || 'code' in p) return p;
    return one(projectPlaneTrace(plane, p.frame));
  }
  if (SKETCH_TAG.exec(ref.name)?.[1] === f.id) {
    return fail('A sketch cannot link to its own geometry');
  }
  const t = await resolveSub(core, ctx, ref, path, unresolved);
  if (!t) return null;
  if (t.owner.startsWith('sketch:')) {
    // Another sketch's curve or point: exact, from its solved entities.
    const s = ctx.state.sketches.get(t.owner.slice('sketch:'.length));
    const m = /^S[0-9A-Za-z]+:[ep]\((.+)\)$/.exec(t.name);
    const e = m && s ? s.entities.find((x) => x.id === m[1]) : undefined;
    if (s && e) {
      const pts = new Map<Id, Vec2>();
      for (const x of s.entities) if (x.kind === 'point') pts.set(x.id, [x.x, x.y]);
      const c = projectSketchEntity(plane, s.frame, e, pts);
      if (!('error' in c)) return { curves: [c] };
    }
  }
  if (t.kind === 'vertex') {
    const fp = await core.fingerprints(t.shape);
    const v = fp?.vertices[t.index];
    if (v) return one(projectPoint(plane, v.point), t.owner);
  }
  if (t.kind === 'edge') {
    if (core.kernel.projectEdges) {
      const r = await core.kernel.projectEdges(t.shape, [t.index], plane);
      if (!r.ok) return r.error;
      return { curves: r.value.flatMap((x) => x.curves), owner: t.owner };
    }
    const l = await core.lineOfEdge(t);
    if (l) {
      const c = projectAxis(plane, { origin: l.a, dir: normalize(sub(l.b, l.a)) });
      if (c.kind === 'point') return one(c, t.owner);
      return one({ kind: 'line', a: toLocal(plane, l.a), b: toLocal(plane, l.b) }, t.owner);
    }
    const circle = await core.circleOfEdge(t);
    if (circle?.full) return one(projectCircle(plane, circle), t.owner);
    if (circle) {
      const tol = Math.max(1e-7, 1e-7 * (await partDiag(core, ctx)));
      const ends = await core.endpointsOf(t, tol);
      const fp = await core.fingerprints(t.shape);
      const mid = fp?.edges[t.index]?.centroid;
      if (ends.length === 2 && mid) {
        const [s, e] = ends as [Vec3, Vec3];
        const ccw = dot(cross(sub(s, circle.centre), sub(mid, circle.centre)), circle.normal) > 0;
        return one(
          projectCircle(plane, circle, ccw ? { start: s, end: e } : { start: e, end: s }),
          t.owner,
        );
      }
    }
    return fail(
      'This edge cannot be projected yet (it needs the kernel’s projection call)',
      'UNSUPPORTED_FEATURE',
    );
  }
  if (t.kind === 'face') {
    if (core.kernel.projectFaceOutline) {
      const r = await core.kernel.projectFaceOutline(t.shape, t.index, plane);
      if (!r.ok) return r.error;
      return { curves: flattenProjection(r.value), owner: t.owner };
    }
    return fail(
      'Projecting a face outline needs a newer kernel; convert its edges instead',
      'UNSUPPORTED_FEATURE',
    );
  }
  return fail('This reference cannot be projected into a sketch');
}

/** Persistent name of a sketch entity (naming.ts): points `S…:p(id)`, curves `S…:e(id)`. */
function entityName(f: SketchFeature, id: Id): string {
  const e = f.entities.find((x) => x.id === id);
  return `S${f.id}:${e?.kind === 'point' ? 'p' : 'e'}(${id})`;
}
