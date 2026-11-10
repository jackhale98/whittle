/**
 * Solid features: extrude, revolve, primitive, sweep and loft, with their body op and scope
 * semantics, and the tool solids mirror / patterns copy (`ToolSpec`).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  EntityRef,
  ExtrudeFeature,
  Feature,
  FeatureInputs,
  FeatureResult,
  Frame,
  KernelError,
  LoftFeature,
  NamingMap,
  PrimitiveFeature,
  ResolvedRef,
  RevolveFeature,
  ShapeHandle,
  SweepFeature,
  UnresolvedRef,
  Vec3,
} from '@wren-cad/contracts';
import { chainOrder } from './chain';
import type { EngineCore } from './core';
import { boxDiagonal, boxesOverlap, ORIGIN_AXES } from './geometry';
import { hashKey } from './hash';
import { definition, kerr } from './helpers';
import { AXIS_NAME, partDiag, refKeyOf, resolvePlane, resolveSub, scopeBodies } from './refs';
import type { ResolvedTarget } from './resolve';
import type { BodyState, EntryResult, Planned, ToolSpec, WalkContext } from './state';

export async function planSolid(
  core: EngineCore,
  ctx: WalkContext,
  f: ExtrudeFeature | RevolveFeature | PrimitiveFeature,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const refs: Record<string, ResolvedRef> = {};
  const refKeys: Record<string, unknown> = {};
  const frames: Record<string, Frame> = {};
  const involved = new Set<string>();
  const note = (path: string, t: ResolvedTarget) => {
    refs[path] = { shape: t.shape, kind: t.kind, index: t.index };
    refKeys[path] = refKeyOf(ctx, t);
    if (ctx.state.bodies.has(t.owner)) involved.add(t.owner);
  };
  if (f.type !== 'primitive') {
    for (let i = 0; i < f.profile.length; i++) {
      const t = await resolveSub(core, ctx, f.profile[i] as EntityRef, `/profile/${i}`, unresolved);
      if (t) note(`/profile/${i}`, t);
    }
  }
  if (f.type === 'extrude' && f.end.kind === 'upTo') {
    const p = await resolvePlane(core, ctx, f.end.target, '/end/target', unresolved);
    if (p && !('code' in p)) {
      if (p.target) note('/end/target', p.target);
      else {
        frames.upTo = p.frame;
        refKeys['/end/target'] = p.shapeKey;
      }
    } else if (p && 'code' in p) {
      return { unresolved, taint: [], error: p };
    }
  }
  if (f.type === 'revolve') {
    const axis = ORIGIN_AXES[f.axis.name];
    const datum = AXIS_NAME.exec(f.axis.name);
    if (axis) frames.axis = axis;
    else if (datum) {
      // M3: an axis feature (`F…:axis`) revolves about its frame.
      const d = ctx.state.datums.get(datum[1] as string);
      if (d?.kind === 'axis') frames.axis = d.frame;
      else unresolved.push({ path: '/axis', ref: f.axis, reason: 'missing' });
    } else {
      const t = await resolveSub(core, ctx, f.axis, '/axis', unresolved);
      if (t) note('/axis', t);
    }
  }
  const scoped =
    f.op === 'new'
      ? { bodies: [] as BodyState[], mode: 'bodies' as const }
      : scopeBodies(ctx, f.scope, unresolved);
  if ('error' in scoped && scoped.error) {
    return { unresolved, taint: scoped.bodies.map((b) => b.id), error: scoped.error };
  }
  // A failed `new` feature taints its would-be body id: implicit scopes can't know whether
  // that body would have been touched, so they are blocked rather than evaluated without it.
  const taint = f.op === 'new' ? [`B${f.id}`] : scoped.bodies.map((b) => b.id);
  if (scoped.mode === 'bodies') for (const b of scoped.bodies) involved.add(b.id);
  else if (f.op !== 'new') {
    for (const t of ctx.tainted.keys()) if (!ctx.state.bodies.has(t)) involved.add(t);
  }
  const key = hashKey({
    t: f.type,
    def: definition(f),
    values,
    refs: refKeys,
    frames,
    scope: scoped.mode,
    bodies: scoped.bodies.map((b) => [b.id, b.key]),
  });
  const inputs: FeatureInputs = { values, refs, frames };
  return {
    unresolved,
    taint,
    plan: {
      key,
      involved: [...involved],
      reads: scoped.bodies.map((b) => b.id),
      run: () => runSolid(core, f, inputs, scoped, key),
      tool: solidTool(core, f, inputs, refKeys),
    },
  };
}

/** The tool solid of a solid feature: the feature alone (op `new`), keyed without its bodies. */
function solidTool(
  core: EngineCore,
  f: ExtrudeFeature | RevolveFeature | PrimitiveFeature | SweepFeature | LoftFeature,
  inputs: FeatureInputs,
  refKeys: Record<string, unknown>,
): Omit<ToolSpec, 'bodies'> {
  const tool = { ...f, op: 'new', scope: undefined } as Feature;
  const toolInputs: FeatureInputs = { values: inputs.values };
  if (inputs.refs) toolInputs.refs = inputs.refs;
  if (inputs.frames) toolInputs.frames = inputs.frames;
  return {
    featureId: f.id,
    key: hashKey({
      t: 'tool',
      def: definition(tool),
      values: inputs.values,
      refs: refKeys,
      frames: inputs.frames ?? {},
    }),
    op: opCode(f.op),
    build: (depth?: number) => {
      if (depth === undefined || f.type !== 'extrude' || f.end.kind !== 'throughAll') {
        return core.exec(tool, toolInputs);
      }
      const blind = { ...tool, end: { kind: 'blind', depth: `${depth} mm` } } as Feature;
      return core.exec(blind, {
        ...toolInputs,
        values: { ...inputs.values, '/end/depth': depth },
      });
    },
    ...(f.type === 'extrude' && f.end.kind === 'throughAll'
      ? {
          throughAll: [
            ...new Set(
              Object.entries(inputs.refs ?? {})
                .filter(([p]) => p.startsWith('/profile/'))
                .map(([, r]) => r.shape),
            ),
          ],
        }
      : {}),
  };
}

/** Executes a solid feature with its body op and scope semantics. */
async function runSolid(
  core: EngineCore,
  f: ExtrudeFeature | RevolveFeature | PrimitiveFeature | SweepFeature | LoftFeature,
  inputs: FeatureInputs,
  scoped: { bodies: BodyState[]; mode: 'default' | 'all' | 'bodies' },
  key: string,
): Promise<{ result: EntryResult; owned: ShapeHandle[] }> {
  const fail = (error: KernelError) => ({ result: { ok: false as const, error }, owned: [] });
  const newBody = (r: FeatureResult, warnings: KernelError[]) => ({
    result: {
      ok: true as const,
      set: [{ id: `B${f.id}`, shape: r.shape, naming: r.naming, key: `${key}/B${f.id}` }],
      remove: [],
      touched: [],
      warnings,
    },
    owned: [r.shape],
  });
  if (f.op === 'new') {
    const r = await core.exec(f, inputs);
    return r.ok ? newBody(r.value, r.value.warnings) : fail(r.error);
  }

  let candidates = scoped.bodies;
  let tool: FeatureResult | null = null;
  const throughAll = f.type === 'extrude' && f.end.kind === 'throughAll';
  if (scoped.mode === 'default' && !throughAll) {
    // Prefilter "every body the tool touches" by bounding boxes of the tool alone.
    const t = await core.exec({ ...f, op: 'new', scope: undefined } as Feature, inputs);
    if (!t.ok) return fail(t.error);
    tool = t.value;
    const tb = await core.massOf(tool.shape);
    if (tb && candidates.length > 0) {
      const tol = 1e-6 * Math.max(1, boxDiagonal(tb.bbox));
      const kept: BodyState[] = [];
      for (const b of candidates) {
        const bb = await core.massOf(b.shape);
        if (!bb || boxesOverlap(bb.bbox, tb.bbox, tol)) kept.push(b);
      }
      candidates = kept;
    }
  }
  const dropTool = async () => {
    if (tool) await core.releaseHandle(tool.shape);
    tool = null;
  };

  if (candidates.length === 0) {
    if (f.op === 'add' && scoped.mode === 'default') {
      // Nothing to merge with: the material becomes a new body.
      const warning = kerr(
        'OPERATION_FAILED',
        scoped.bodies.length === 0
          ? 'There is no body to add to; created a new body'
          : 'The new material touches no body; created a new body',
      );
      if (tool) {
        const t = tool;
        tool = null;
        return newBody(t, [warning, ...t.warnings]);
      }
      const r = await core.exec({ ...f, op: 'new', scope: undefined } as Feature, inputs);
      return r.ok ? newBody(r.value, [warning, ...r.value.warnings]) : fail(r.error);
    }
    await dropTool();
    if (f.op === 'cut' && scoped.mode === 'default' && scoped.bodies.length > 0) {
      return {
        result: {
          ok: true,
          set: [],
          remove: [],
          touched: [],
          warnings: [
            kerr('OPERATION_FAILED', 'The cut does not touch any body', {
              hint: 'Move the sketch, or extend the cut depth.',
            }),
          ],
        },
        owned: [],
      };
    }
    return fail(
      kerr('INVALID_INPUT', `There is no body to ${f.op === 'add' ? 'add to' : f.op}`, {
        hint: 'Create a body first, or set the operation to New.',
      }),
    );
  }
  await dropTool();

  const exec = (bodies: BodyState[]) => {
    const shapes: Record<string, ShapeHandle> = {};
    bodies.slice(1).forEach((b, i) => {
      shapes[`scope:${String(i + 1).padStart(4, '0')}`] = b.shape;
    });
    return core.exec(f, {
      ...inputs,
      target: (bodies[0] as BodyState).shape,
      shapes: { ...inputs.shapes, ...shapes },
    });
  };
  const resultsOf = (r: FeatureResult, bodies: BodyState[]) => {
    const out = new Map<string, { shape: ShapeHandle; naming: NamingMap }>();
    out.set((bodies[0] as BodyState).id, { shape: r.shape, naming: r.naming });
    for (const extra of r.bodies ?? []) {
      const i = Number(extra.key.slice('scope:'.length));
      const b = bodies[i];
      if (b) out.set(b.id, { shape: extra.shape, naming: extra.naming });
    }
    return out;
  };

  if (f.op === 'add') {
    const r = await exec(candidates);
    if (!r.ok) return fail(r.error);
    const first = candidates[0] as BodyState;
    // Merged bodies: the oldest keeps its id; extra handles (none expected for fuse) released.
    for (const extra of r.value.bodies ?? []) await core.releaseHandle(extra.shape);
    return {
      result: {
        ok: true,
        set: [
          {
            id: first.id,
            shape: r.value.shape,
            naming: r.value.naming,
            key: `${key}/${first.id}`,
          },
        ],
        remove: candidates.slice(1).map((b) => b.id),
        touched: candidates.map((b) => b.id),
        warnings: r.value.warnings,
      },
      owned: [r.value.shape],
    };
  }

  // cut / intersect: one result per body; untouched bodies keep their shape.
  let produced: Map<string, { shape: ShapeHandle; naming: NamingMap }>;
  let warnings: KernelError[];
  const r = await exec(candidates);
  if (r.ok) {
    produced = resultsOf(r.value, candidates);
    warnings = r.value.warnings;
  } else if (f.op === 'intersect' && scoped.mode !== 'bodies' && candidates.length > 1) {
    // Some bbox candidate does not overlap: intersect body by body, skipping empty ones.
    produced = new Map();
    warnings = [];
    for (const b of candidates) {
      const one = await exec([b]);
      if (one.ok) {
        produced.set(b.id, { shape: one.value.shape, naming: one.value.naming });
        warnings.push(...one.value.warnings);
      }
    }
    if (produced.size === 0) return fail(r.error);
  } else {
    return fail(r.error);
  }

  const set: BodyState[] = [];
  const owned: ShapeHandle[] = [];
  const touched: string[] = [];
  for (const b of candidates) {
    const p = produced.get(b.id);
    if (!p) continue;
    if (f.op === 'cut' && scoped.mode !== 'bodies' && (await sameSolid(core, b.shape, p.shape))) {
      await core.releaseHandle(p.shape);
      continue;
    }
    set.push({ id: b.id, shape: p.shape, naming: p.naming, key: `${key}/${b.id}` });
    owned.push(p.shape);
    touched.push(b.id);
  }
  if (f.op === 'cut' && scoped.mode !== 'bodies') {
    // Per-body "does not touch" warnings are expected with an implicit scope.
    warnings = warnings.filter((w) => w.message !== 'The cut does not touch the body');
    if (touched.length === 0) {
      warnings.push(
        kerr('OPERATION_FAILED', 'The cut does not touch any body', {
          hint: 'Move the sketch, or extend the cut depth.',
        }),
      );
    }
  }
  return { result: { ok: true, set, remove: [], touched, warnings }, owned };
}

/** Same volume and topology counts: the boolean left the body unchanged. */
export async function sameSolid(
  core: EngineCore,
  a: ShapeHandle,
  b: ShapeHandle,
): Promise<boolean> {
  const ma = await core.massOf(a);
  const mb = await core.massOf(b);
  if (!ma || !mb) return false;
  return (
    Math.abs(ma.volume - mb.volume) <= 1e-9 * Math.max(1, Math.abs(ma.volume)) &&
    ma.faceCount === mb.faceCount &&
    ma.edgeCount === mb.edgeCount
  );
}

export async function planSweepLoft(
  core: EngineCore,
  ctx: WalkContext,
  f: SweepFeature | LoftFeature,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const refs: Record<string, ResolvedRef> = {};
  const refKeys: Record<string, unknown> = {};
  const involved = new Set<string>();
  const note = (path: string, t: ResolvedTarget) => {
    refs[path] = { shape: t.shape, kind: t.kind, index: t.index };
    refKeys[path] = refKeyOf(ctx, t);
    if (ctx.state.bodies.has(t.owner)) involved.add(t.owner);
  };
  const taintNew = f.op === 'new' ? [`B${f.id}`] : [];
  const fail = (message: string, names: string[] = []): Planned => ({
    unresolved,
    taint: taintNew,
    error: kerr('INVALID_INPUT', message, { entityRefs: names }),
  });
  let feature: SweepFeature | LoftFeature = f;
  if (f.type === 'sweep') {
    for (let i = 0; i < f.profile.length; i++) {
      const t = await resolveSub(core, ctx, f.profile[i] as EntityRef, `/profile/${i}`, unresolved);
      if (t) note(`/profile/${i}`, t);
    }
    if (f.profile.length === 0) return fail('Select the profile to sweep');
    const path: (ResolvedTarget | null)[] = [];
    for (let i = 0; i < f.path.length; i++) {
      path.push(await resolveSub(core, ctx, f.path[i] as EntityRef, `/path/${i}`, unresolved));
    }
    if (unresolved.length === 0) {
      const tol = Math.max(1e-6, 1e-6 * (await partDiag(core, ctx)));
      const ends: Vec3[][] = [];
      for (const t of path as ResolvedTarget[]) {
        if (t.kind !== 'edge')
          return fail('The sweep path must be edges or sketch curves', [t.name]);
        ends.push(await core.endpointsOf(t, tol / 10));
      }
      const chain = chainOrder(ends, tol);
      if (!chain.ok)
        return fail(
          chain.message,
          f.path.map((r) => r.name),
        );
      feature = { ...f, path: chain.order.map((i) => f.path[i] as EntityRef) };
      chain.order.forEach((src, j) => {
        note(`/path/${j}`, path[src] as ResolvedTarget);
      });
    }
  } else {
    if (f.sections.length < 2) return fail('A loft needs at least two sections');
    for (let i = 0; i < f.sections.length; i++) {
      const ref = f.sections[i] as EntityRef;
      const t = await resolveSub(core, ctx, ref, `/sections/${i}`, unresolved);
      if (!t) continue;
      if (t.kind === 'vertex' && i > 0 && i < f.sections.length - 1) {
        return fail('Only the first and the last loft section can be a point', [ref.name]);
      }
      if (t.kind === 'edge') return fail('Loft sections are regions, faces or points', [ref.name]);
      note(`/sections/${i}`, t);
    }
    for (let i = 0; i < (f.guides ?? []).length; i++) {
      const t = await resolveSub(
        core,
        ctx,
        (f.guides as EntityRef[])[i] as EntityRef,
        `/guides/${i}`,
        unresolved,
      );
      if (t) note(`/guides/${i}`, t);
    }
  }
  const scoped =
    f.op === 'new'
      ? { bodies: [] as BodyState[], mode: 'bodies' as const }
      : scopeBodies(ctx, f.scope, unresolved);
  if ('error' in scoped && scoped.error) {
    return { unresolved, taint: scoped.bodies.map((b) => b.id), error: scoped.error };
  }
  const taint = f.op === 'new' ? taintNew : scoped.bodies.map((b) => b.id);
  if (scoped.mode === 'bodies') for (const b of scoped.bodies) involved.add(b.id);
  else if (f.op !== 'new') {
    for (const t of ctx.tainted.keys()) if (!ctx.state.bodies.has(t)) involved.add(t);
  }
  const key = hashKey({
    t: f.type,
    def: definition(f),
    values,
    refs: refKeys,
    scope: scoped.mode,
    bodies: scoped.bodies.map((b) => [b.id, b.key]),
  });
  const inputs: FeatureInputs = { values, refs };
  return {
    unresolved,
    taint,
    plan: {
      key,
      involved: [...involved],
      reads: scoped.bodies.map((b) => b.id),
      run: () => runSolid(core, feature, inputs, scoped, key),
      tool: solidTool(core, feature, inputs, refKeys),
    },
  };
}

/** values["/ops/<id>"] of a copied feature: 0 add, 1 cut, 2 intersect (a `new` copy is added). */
function opCode(op: ExtrudeFeature['op']): 0 | 1 | 2 {
  return op === 'cut' ? 1 : op === 'intersect' ? 2 : 0;
}
