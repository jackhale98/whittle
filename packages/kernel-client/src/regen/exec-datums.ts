/**
 * Reference geometry features: construction planes, axes and points (M1 offset planes, M3
 * definitions computed in TypeScript).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  AxisFeature,
  EntityRef,
  Frame,
  KernelError,
  PlaneFeature,
  PointFeature,
  UnresolvedRef,
  Vec3,
} from '@wren-cad/contracts';
import type { EngineCore } from './core';
import {
  anglePlane,
  flipFrame,
  isGeoError,
  type Line,
  lineFrame,
  lineLineIntersection,
  linePlaneIntersection,
  midPlane,
  normalPlane,
  planesIntersection,
  planeThroughPoint,
  planeThroughPoints,
  pointFrame,
  sphereCentre,
} from './datums';
import { add, cross, dist, normalize, scale, sub } from './geometry';
import { hashKey } from './hash';
import { definition, kerr } from './helpers';
import {
  partDiag,
  resolveAxis,
  resolveLineOrPlane,
  resolvePlane,
  resolvePoint,
  resolveSub,
} from './refs';
import type { DatumState, PlaneState, Planned, WalkContext } from './state';

export async function planPlane(
  core: EngineCore,
  ctx: WalkContext,
  f: PlaneFeature,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const frames: Record<string, Frame> = {};
  let fromKey: unknown = null;
  const involved = new Set<string>();
  const noteOwner = (owner: string | undefined) => {
    if (owner && ctx.state.bodies.has(owner)) involved.add(owner);
  };
  const fail = (e: KernelError): Planned => ({ unresolved, taint: [], error: e });
  const d = f.definition;
  /** Frame computed in TypeScript (M3 definitions); the kernel then gets `{ kind: 'frame' }`. */
  let computed: Frame | null = null;
  const geoError = (message: string, refs: EntityRef[]) =>
    fail(
      kerr('INVALID_INPUT', message, {
        hint: 'Pick other references for the plane.',
        entityRefs: refs.map((r) => r.name),
      }),
    );
  if (d.kind === 'offset') {
    const p = await resolvePlane(core, ctx, d.from, '/definition/from', unresolved);
    if (p === null) return { unresolved, taint: [] };
    if ('code' in p) return fail(p);
    frames.from = p.frame;
    fromKey = p.shapeKey;
    noteOwner(p.target?.owner);
  } else if (d.kind === 'threePoints') {
    const pts: Vec3[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await resolvePoint(
        core,
        ctx,
        d.points[i] as EntityRef,
        `/definition/points/${i}`,
        unresolved,
      );
      if (p && 'code' in p) return fail(p);
      if (p) {
        pts.push(p.point);
        noteOwner(p.owner);
      }
    }
    if (unresolved.length > 0) return { unresolved, taint: [] };
    const g = planeThroughPoints(pts[0] as Vec3, pts[1] as Vec3, pts[2] as Vec3);
    if (isGeoError(g)) return geoError(g.error, d.points);
    computed = g;
  } else if (d.kind === 'angle') {
    const p = await resolvePlane(core, ctx, d.from, '/definition/from', unresolved);
    const a = await resolveAxis(core, ctx, d.axis, '/definition/axis', unresolved, false);
    if (p && 'code' in p) return fail(p);
    if (a && 'code' in a) return fail(a);
    if (!p || !a) return { unresolved, taint: [] };
    noteOwner(p.target?.owner);
    noteOwner(a.owner);
    const g = anglePlane(p.frame, a.line, values['/definition/angle'] ?? 0);
    if (isGeoError(g)) return geoError(g.error, [d.from, d.axis]);
    computed = g;
  } else if (d.kind === 'normalToCurve') {
    const r = await normalToCurve(core, ctx, d, values, unresolved);
    if (r === null) return { unresolved, taint: [] };
    if ('code' in r) return fail(r);
    noteOwner(r.owner);
    computed = r.frame;
  } else if (d.kind === 'midplane') {
    const a = await resolvePlane(core, ctx, d.a, '/definition/a', unresolved);
    const b = await resolvePlane(core, ctx, d.b, '/definition/b', unresolved);
    if (a && 'code' in a) return fail(a);
    if (b && 'code' in b) return fail(b);
    if (!a || !b) return { unresolved, taint: [] };
    noteOwner(a.target?.owner);
    noteOwner(b.target?.owner);
    const g = midPlane(a.frame, b.frame);
    if (isGeoError(g)) return geoError(g.error, [d.a, d.b]);
    computed = g;
  } else if (d.kind === 'throughPoint') {
    const p = await resolvePlane(core, ctx, d.from, '/definition/from', unresolved);
    const q = await resolvePoint(core, ctx, d.point, '/definition/point', unresolved);
    if (p && 'code' in p) return fail(p);
    if (q && 'code' in q) return fail(q);
    if (!p || !q) return { unresolved, taint: [] };
    noteOwner(p.target?.owner);
    noteOwner(q.owner);
    computed = planeThroughPoint(p.frame, q.point);
  }
  if (unresolved.length > 0) return { unresolved, taint: [] };
  // The kernel never sees `flip`: new definitions reach it as a (flipped) frame; offset planes
  // run as in M1 and the flip is applied to the resulting frame.
  if (computed && f.flip) computed = flipFrame(computed);
  if (!computed && f.flip && d.kind === 'frame') computed = flipFrame(d.frame);
  const kernelFeature: PlaneFeature = computed
    ? { ...f, definition: { kind: 'frame', frame: computed } }
    : { ...f };
  delete kernelFeature.flip;
  delete kernelFeature.visibility;
  const flipAfter = !computed && f.flip === true;
  const key = hashKey({
    t: 'plane',
    def: definition(f),
    values,
    frames,
    from: fromKey,
    computed,
  });
  return {
    unresolved,
    taint: [],
    plan: {
      key,
      involved: [...involved],
      run: async () => {
        const r = await core.exec(kernelFeature, computed ? { values: {} } : { values, frames });
        if (!r.ok) return { result: { ok: false, error: r.error }, owned: [] };
        let frame = computed ??
          r.value.frame ??
          frames.from ?? { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] };
        if (flipAfter) frame = flipFrame(frame);
        const plane: PlaneState = {
          id: f.id,
          shape: r.value.shape,
          naming: r.value.naming,
          frame,
          key: `${key}/P`,
        };
        return {
          result: {
            ok: true,
            set: [],
            remove: [],
            touched: [],
            plane,
            warnings: r.value.warnings,
          },
          owned: [r.value.shape],
        };
      },
    },
  };
}

/** `normalToCurve` planes: at a vertex on the curve or at a 0–1 position along a straight edge. */
async function normalToCurve(
  core: EngineCore,
  ctx: WalkContext,
  d: Extract<PlaneFeature['definition'], { kind: 'normalToCurve' }>,
  values: Record<string, number>,
  unresolved: UnresolvedRef[],
): Promise<{ frame: Frame; owner?: string } | KernelError | null> {
  const t = await resolveSub(core, ctx, d.curve, '/definition/curve', unresolved);
  let at: Vec3 | null = null;
  if (!('t' in d.at)) {
    const p = await resolvePoint(core, ctx, d.at, '/definition/at', unresolved);
    if (p && 'code' in p) return p;
    if (p) at = p.point;
  }
  if (!t || unresolved.length > 0) return null;
  const bad = (message: string) =>
    kerr('INVALID_INPUT', message, {
      hint: 'Pick a straight or circular edge.',
      entityRefs: [d.curve.name],
    });
  if (t.kind !== 'edge') return bad('A plane normal to a curve needs an edge');
  const owner = t.owner;
  const line = await core.lineOfEdge(t);
  if (line) {
    const dir = normalize(sub(line.b, line.a));
    const point = at ?? add(line.a, scale(sub(line.b, line.a), values['/definition/at/t'] ?? 0));
    return { frame: normalPlane(point, dir), owner };
  }
  const circle = await core.circleOfEdge(t);
  if (circle) {
    if (!at) {
      return kerr(
        'UNSUPPORTED_FEATURE',
        'A position along a curved edge is not supported yet; pick a vertex on it',
        { hint: 'Pick a vertex on the edge instead of a position.', entityRefs: [d.curve.name] },
      );
    }
    const radial = sub(at, circle.centre);
    if (Math.abs(dist(at, circle.centre) - circle.radius) > 1e-6 * (1 + circle.radius)) {
      return bad('The point is not on the curve');
    }
    return { frame: normalPlane(at, cross(circle.normal, radial)), owner };
  }
  return bad('Planes normal to this kind of curve are not supported yet');
}

function datumPlan(
  f: AxisFeature | PointFeature,
  frame: Frame,
  values: Record<string, number>,
  involved: Set<string>,
): Planned {
  const key = hashKey({ t: f.type, def: definition(f), values, frame });
  const datum: DatumState = { id: f.id, kind: f.type, frame, key: `${key}/D` };
  return {
    unresolved: [],
    taint: [],
    plan: {
      key,
      involved: [...involved],
      run: async () => ({
        result: { ok: true, set: [], remove: [], touched: [], datum, warnings: [] },
        owned: [],
      }),
    },
  };
}

export async function planAxis(
  core: EngineCore,
  ctx: WalkContext,
  f: AxisFeature,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const involved = new Set<string>();
  const note = (owner: string | undefined) => {
    if (owner && ctx.state.bodies.has(owner)) involved.add(owner);
  };
  const fail = (e: KernelError): Planned => ({ unresolved, taint: [], error: e });
  const geoError = (message: string, refs: EntityRef[]) =>
    fail(
      kerr('INVALID_INPUT', message, {
        hint: 'Pick other references for the axis.',
        entityRefs: refs.map((r) => r.name),
      }),
    );
  const d = f.definition;
  let line: Line | null = null;
  if (d.kind === 'twoPoints') {
    const a = await resolvePoint(core, ctx, d.a, '/definition/a', unresolved);
    const b = await resolvePoint(core, ctx, d.b, '/definition/b', unresolved);
    if (a && 'code' in a) return fail(a);
    if (b && 'code' in b) return fail(b);
    if (a && b) {
      note(a.owner);
      note(b.owner);
      if (dist(a.point, b.point) <= 1e-9) return geoError('The two points coincide', [d.a, d.b]);
      line = { origin: a.point, dir: normalize(sub(b.point, a.point)) };
    }
  } else if (d.kind === 'edge') {
    const t = await resolveSub(core, ctx, d.edge, '/definition/edge', unresolved);
    if (t) {
      note(t.owner);
      const l = t.kind === 'edge' ? await core.lineOfEdge(t) : null;
      if (!l) return geoError('Pick a straight edge', [d.edge]);
      line = { origin: l.a, dir: normalize(sub(l.b, l.a)) };
    }
  } else if (d.kind === 'cylinder') {
    const a = await resolveAxis(core, ctx, d.face, '/definition/face', unresolved, false);
    if (a && 'code' in a) return fail(a);
    if (a) {
      note(a.owner);
      line = a.line;
    }
  } else if (d.kind === 'twoPlanes') {
    const a = await resolvePlane(core, ctx, d.a, '/definition/a', unresolved);
    const b = await resolvePlane(core, ctx, d.b, '/definition/b', unresolved);
    if (a && 'code' in a) return fail(a);
    if (b && 'code' in b) return fail(b);
    if (a && b) {
      note(a.target?.owner);
      note(b.target?.owner);
      const g = planesIntersection(a.frame, b.frame);
      if (isGeoError(g)) return geoError(g.error, [d.a, d.b]);
      line = g;
    }
  } else if (d.kind === 'pointNormal') {
    const p = await resolvePoint(core, ctx, d.point, '/definition/point', unresolved);
    const pl = await resolvePlane(core, ctx, d.plane, '/definition/plane', unresolved);
    if (p && 'code' in p) return fail(p);
    if (pl && 'code' in pl) return fail(pl);
    if (p && pl) {
      note(p.owner);
      note(pl.target?.owner);
      line = { origin: p.point, dir: normalize(pl.frame.z) };
    }
  }
  if (unresolved.length > 0 || !line) return { unresolved, taint: [] };
  return datumPlan(f, lineFrame(line), values, involved);
}

export async function planPoint(
  core: EngineCore,
  ctx: WalkContext,
  f: PointFeature,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const involved = new Set<string>();
  const note = (owner: string | undefined) => {
    if (owner && ctx.state.bodies.has(owner)) involved.add(owner);
  };
  const fail = (e: KernelError): Planned => ({ unresolved, taint: [], error: e });
  const geoError = (
    message: string,
    refs: EntityRef[],
    code: KernelError['code'] = 'INVALID_INPUT',
  ) =>
    fail(
      kerr(code, message, {
        hint: 'Pick other references for the point.',
        entityRefs: refs.map((r) => r.name),
      }),
    );
  const d = f.definition;
  let point: Vec3 | null = null;
  if (d.kind === 'coordinates') {
    point = [
      values['/definition/x'] ?? 0,
      values['/definition/y'] ?? 0,
      values['/definition/z'] ?? 0,
    ];
  } else if (d.kind === 'vertex') {
    const p = await resolvePoint(core, ctx, d.vertex, '/definition/vertex', unresolved);
    if (p && 'code' in p) return fail(p);
    if (p) {
      note(p.owner);
      point = p.point;
    }
  } else if (d.kind === 'center') {
    const t = await resolveSub(core, ctx, d.of, '/definition/of', unresolved);
    if (t) {
      note(t.owner);
      if (t.kind === 'edge') point = (await core.circleOfEdge(t))?.centre ?? null;
      else if (t.kind === 'face') {
        point = await core.memo(t.shape, `sphere:${t.index}`, () =>
          sphereCentre(core.geo(), t.shape, t.index),
        );
      }
      if (!point) return geoError('Pick a circular edge or a spherical face', [d.of]);
    }
  } else if (d.kind === 'alongEdge') {
    const t = await resolveSub(core, ctx, d.edge, '/definition/edge', unresolved);
    if (t) {
      note(t.owner);
      const l = t.kind === 'edge' ? await core.lineOfEdge(t) : null;
      if (!l) {
        return geoError(
          'A position along a curved edge is not supported yet; pick a straight edge',
          [d.edge],
          'UNSUPPORTED_FEATURE',
        );
      }
      point = add(l.a, scale(sub(l.b, l.a), values['/definition/t'] ?? 0));
    }
  } else if (d.kind === 'intersection') {
    const a = await resolveLineOrPlane(core, ctx, d.a, '/definition/a', unresolved);
    const b = await resolveLineOrPlane(core, ctx, d.b, '/definition/b', unresolved);
    if (a && 'code' in a) return fail(a);
    if (b && 'code' in b) return fail(b);
    if (a && b) {
      const tol = Math.max(1e-6, 1e-6 * (await partDiag(core, ctx)));
      const g =
        'line' in a && 'line' in b
          ? lineLineIntersection(a.line, b.line, tol)
          : 'line' in a && 'plane' in b
            ? linePlaneIntersection(a.line, b.plane)
            : 'plane' in a && 'line' in b
              ? linePlaneIntersection(b.line, a.plane)
              : { error: 'Two planes meet in a line; pick a line and a plane' };
      if (isGeoError(g)) return geoError(g.error, [d.a, d.b]);
      point = g;
    }
  }
  if (unresolved.length > 0 || !point) return { unresolved, taint: [] };
  return datumPlan(f, pointFrame(point), values, involved);
}
