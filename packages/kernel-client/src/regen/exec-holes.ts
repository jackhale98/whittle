/**
 * Hole wizard holes and cosmetic threads (M3).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  EntityRef,
  FeatureInputs,
  Frame,
  HoleFeature,
  KernelError,
  ResolvedRef,
  ThreadFeature,
  UnresolvedRef,
  Vec3,
} from '@wren-cad/contracts';
import { holeRow, resolveHoleSize } from '@wren-cad/document';
import type { EngineCore } from './core';
import { heightAbove, snapFrame } from './datums';
import { runOnBody } from './exec-modify';
import { normalize, planeFrame, scale, sub } from './geometry';
import { hashKey } from './hash';
import { definition, kerr, meshOnlyError } from './helpers';
import { partDiag, refKeyOf, resolvePlane, resolvePoint, resolveSub } from './refs';
import type { BodyState, Planned, WalkContext } from './state';

/**
 * Hole wizard: one hole per point on a flat face of a body. `frames["hole:i"]` has its origin on
 * the face (the point projected along the face normal; points off the face plane are an error),
 * z into the material (−outward normal) and x from `planeFrame`. The diameters and depths come
 * from the standards table (`resolveHoleSize`) with explicit values overriding it, written to
 * `values` at the feature's own pointers (`/diameter`, `/counterbore/diameter`, …, angles rad).
 */
export async function planHole(
  core: EngineCore,
  ctx: WalkContext,
  f: HoleFeature,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const fail = (e: KernelError, taint: string[] = []): Planned => ({
    unresolved,
    taint,
    error: e,
  });
  if (f.points.length === 0) {
    return fail(
      kerr('INVALID_INPUT', 'Place at least one hole point', {
        hint: 'Sketch points on the face, then pick them.',
      }),
    );
  }
  const ft = await resolveSub(core, ctx, f.face, '/face', unresolved);
  const points: (Vec3 | null)[] = [];
  for (let i = 0; i < f.points.length; i++) {
    const p = await resolvePoint(core, ctx, f.points[i] as EntityRef, `/points/${i}`, unresolved);
    if (p && 'code' in p) return fail(p);
    points.push(p?.point ?? null);
  }
  let body: BodyState | undefined;
  if (ft) {
    body = ft.kind === 'face' ? ctx.state.bodies.get(ft.owner) : undefined;
    if (!body) {
      return fail(
        kerr('INVALID_INPUT', 'Holes are drilled into a flat face of a body', {
          entityRefs: [f.face.name],
        }),
      );
    }
    if (body.meshOnly) return fail(meshOnlyError('drilled', body.id), [body.id]);
  }
  const refs: Record<string, ResolvedRef> = {};
  const refKeys: Record<string, unknown> = {};
  const frames: Record<string, Frame> = {};
  if (f.end.kind === 'upTo') {
    const p = await resolvePlane(core, ctx, f.end.target, '/end/target', unresolved);
    if (p && 'code' in p) return fail(p, body ? [body.id] : []);
    if (p?.target) {
      refs['/end/target'] = { shape: p.target.shape, kind: p.target.kind, index: p.target.index };
      refKeys['/end/target'] = refKeyOf(ctx, p.target);
    } else if (p) {
      frames.upTo = p.frame;
      refKeys['/end/target'] = p.shapeKey;
    }
  }
  if (unresolved.length > 0 || !ft || !body) return { unresolved, taint: body ? [body.id] : [] };
  const taint = [body.id];
  const fp = await core.fingerprints(ft.shape);
  const face = fp?.faces[ft.index];
  if (!face?.normal) {
    return fail(
      kerr('INVALID_INPUT', 'Holes are drilled into flat faces', {
        hint: 'Pick a planar face.',
        entityRefs: [f.face.name],
      }),
      taint,
    );
  }
  const n = normalize(face.normal);
  const facePlane: Frame = { origin: face.centroid, z: n, x: planeFrame(face.centroid, n).x };
  const tol = Math.max(1e-6, 1e-6 * (await partDiag(core, ctx)));
  const into = scale(n, -1);
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vec3;
    const h = heightAbove(facePlane, p);
    if (Math.abs(h) > tol) {
      return fail(
        kerr('INVALID_INPUT', `Hole point ${i + 1} is not on the hole’s face`, {
          hint: 'Put the hole points in a sketch on that face.',
          entityRefs: [(f.points[i] as EntityRef).name, f.face.name],
          detail: `${h} mm off the face plane`,
        }),
        taint,
      );
    }
    const origin = sub(p, scale(n, h));
    frames[`hole:${i}`] = snapFrame({ origin, z: into, x: planeFrame(origin, into).x });
  }
  const size = resolveHoleSize({
    standard: f.standard,
    kind: f.kind,
    size: f.size,
    fit: f.fit,
    ...(values['/diameter'] === undefined ? {} : { diameter: values['/diameter'] }),
    counterbore: {
      ...(values['/counterbore/diameter'] === undefined
        ? {}
        : { diameter: values['/counterbore/diameter'] }),
      ...(values['/counterbore/depth'] === undefined
        ? {}
        : { depth: values['/counterbore/depth'] }),
    },
    countersink: {
      ...(values['/countersink/diameter'] === undefined
        ? {}
        : { diameter: values['/countersink/diameter'] }),
      ...(values['/countersink/angle'] === undefined
        ? {}
        : { angle: values['/countersink/angle'] }),
    },
  });
  if (!size.ok) {
    return fail(
      kerr('INVALID_INPUT', size.message, { hint: size.hint, detail: size.field }),
      taint,
    );
  }
  if (f.end.kind === 'blind' && !((values['/end/depth'] ?? 0) > 0)) {
    return fail(kerr('INVALID_INPUT', 'The hole depth must be greater than zero'), taint);
  }
  const kv: Record<string, number> = { ...values, '/diameter': size.value.diameter };
  if (size.value.counterbore) {
    kv['/counterbore/diameter'] = size.value.counterbore.diameter;
    kv['/counterbore/depth'] = size.value.counterbore.depth;
  }
  if (size.value.countersink) {
    kv['/countersink/diameter'] = size.value.countersink.diameter;
    kv['/countersink/angle'] = size.value.countersink.angle;
  }
  const key = hashKey({
    t: 'hole',
    def: definition(f),
    values: kv,
    frames,
    refs: refKeys,
    body: [body.id, body.key],
  });
  const target = body;
  const toolInputs: FeatureInputs = { values: kv, frames, refs };
  return {
    unresolved,
    taint,
    plan: {
      key,
      involved: [target.id],
      run: () => runOnBody(core, f, target, toolInputs, key),
      tool: {
        featureId: f.id,
        key: hashKey({ t: 'tool', def: definition(f), values: kv, frames, refs: refKeys }),
        op: 1,
        // Without `target` the kernel returns the drill solids alone (proposed in ADR-036).
        build: () => core.exec(f, toolInputs),
      },
    },
  };
}

/** A cosmetic thread: checks the face and the size; no geometry change (M5 carries it to PMI). */
export async function planThread(
  core: EngineCore,
  ctx: WalkContext,
  f: ThreadFeature,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const t = await resolveSub(core, ctx, f.face, '/face', unresolved);
  if (!t) return { unresolved, taint: [] };
  const fp = await core.fingerprints(t.shape);
  const surface = t.kind === 'face' ? fp?.faces[t.index]?.surface : undefined;
  if (surface !== 'cylinder') {
    return {
      unresolved,
      taint: [],
      error: kerr('INVALID_INPUT', 'A cosmetic thread goes on a cylindrical face', {
        entityRefs: [f.face.name],
      }),
    };
  }
  const row = holeRow(f.standard, f.size);
  if (!row) {
    return {
      unresolved,
      taint: [],
      error: kerr('INVALID_INPUT', `${f.standard} ${f.size} is not in the thread table`, {
        hint: 'Pick a thread size from the table.',
      }),
    };
  }
  const warnings: KernelError[] = [];
  const m = await core.kernel.measureShapes({ shape: t.shape, kind: 'face', index: t.index });
  const d = m.ok && m.value.radius !== undefined ? 2 * m.value.radius : undefined;
  if (d !== undefined) {
    const near = (x: number) => Math.abs(d - x) <= 0.05 * x;
    if (!near(row.nominal) && !near(row.tap.drill)) {
      warnings.push(
        kerr(
          'INVALID_INPUT',
          `The face is ${Math.round(d * 1000) / 1000} mm across, which is neither the ${f.size} major diameter (${row.nominal} mm) nor its tap drill (${Math.round(row.tap.drill * 1000) / 1000} mm)`,
        ),
      );
    }
  }
  const owner = ctx.state.bodies.has(t.owner) ? [t.owner] : [];
  const key = hashKey({ t: 'thread', def: definition(f), values, face: refKeyOf(ctx, t) });
  return {
    unresolved,
    taint: [],
    plan: {
      key,
      involved: owner,
      run: async () => ({
        result: { ok: true, set: [], remove: [], touched: [], warnings },
        owned: [],
      }),
    },
  };
}
