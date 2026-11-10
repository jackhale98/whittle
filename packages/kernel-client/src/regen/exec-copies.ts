/**
 * Mirror, linear and circular patterns (M3): copies of bodies or of the tool solids of
 * earlier features.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  CircularPatternFeature,
  Feature,
  FeatureInputs,
  Frame,
  KernelError,
  LinearPatternFeature,
  MirrorFeature,
  NamingMap,
  ResolvedRef,
  Result,
  ShapeHandle,
  UnresolvedRef,
  Vec3,
} from '@wren-cad/contracts';
import { FIELD_LABELS } from './attribution';
import type { EngineCore } from './core';
import { lineFrame } from './datums';
import { boxDiagonal, dot, emptyBox, extendBox, norm, normalize, scale, sub } from './geometry';
import { hashKey } from './hash';
import { definition, kerr, meshOnlyError } from './helpers';
import { resolveAxis, resolveBody, resolvePlane } from './refs';
import type { BodyState, EntryResult, Planned, ToolSpec, WalkContext } from './state';

/** Feature types whose tool solid can be copied by mirror / patterns. */
const TOOL_TYPES: ReadonlySet<Feature['type']> = new Set([
  'extrude',
  'revolve',
  'primitive',
  'sweep',
  'loft',
  'hole',
]);

/** The cached tool solid of a source feature, built on first use (see `ToolSpec`). */
async function toolOf(
  core: EngineCore,
  ctx: WalkContext,
  spec: ToolSpec,
  depth?: number,
): Promise<Result<{ shape: ShapeHandle; naming: NamingMap }>> {
  const key = depth === undefined ? spec.key : hashKey({ tool: spec.key, depth });
  let e = ctx.pc.entries.get(key);
  if (!e?.result.ok || !e.result.tool) {
    const r = await spec.build(depth);
    if (!r.ok) return r;
    for (const extra of r.value.bodies ?? []) {
      if (extra.shape !== r.value.shape) await core.releaseHandle(extra.shape);
    }
    const tool = { shape: r.value.shape, naming: r.value.naming };
    e = {
      key,
      owned: [tool.shape],
      result: { ok: true, set: [], remove: [], touched: [], tool, warnings: [] },
      lastUsed: ctx.pc.tick,
    };
    core.ownedHandles.add(tool.shape);
    ctx.pc.entries.set(key, e);
  }
  e.lastUsed = ctx.pc.tick;
  ctx.used.add(key);
  const tool = (e.result as { tool: { shape: ShapeHandle; naming: NamingMap } }).tool;
  return { ok: true, value: tool };
}

export async function planCopy(
  core: EngineCore,
  ctx: WalkContext,
  f: MirrorFeature | LinearPatternFeature | CircularPatternFeature,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const frames: Record<string, Frame> = {};
  const involved = new Set<string>();
  const warnings: KernelError[] = [];
  const fail = (e: KernelError, taint: string[] = []): Planned => ({
    unresolved,
    taint,
    error: e,
  });
  const noteOwner = (owner: string | undefined) => {
    if (owner && ctx.state.bodies.has(owner)) involved.add(owner);
  };

  // 1. Where the copies go.
  if (f.type === 'mirror') {
    const p = await resolvePlane(core, ctx, f.plane, '/plane', unresolved);
    if (p && 'code' in p) return fail(p);
    if (p) {
      frames.plane = p.frame;
      noteOwner(p.target?.owner);
    }
  } else if (f.type === 'linearPattern') {
    const a = await resolveAxis(core, ctx, f.direction, '/direction', unresolved, true);
    if (a && 'code' in a) return fail(a);
    if (a) {
      frames.axis = lineFrame(a.line);
      noteOwner(a.owner);
    }
    if (f.second) {
      const b = await resolveAxis(
        core,
        ctx,
        f.second.direction,
        '/second/direction',
        unresolved,
        true,
      );
      if (b && 'code' in b) return fail(b);
      if (b) {
        frames.second = lineFrame(b.line);
        noteOwner(b.owner);
      }
    }
  } else {
    const a = await resolveAxis(core, ctx, f.axis, '/axis', unresolved, false);
    if (a && 'code' in a) return fail(a);
    if (a) {
      frames.axis = lineFrame(a.line);
      noteOwner(a.owner);
    }
  }

  // 2. Counts (whole numbers) and skips.
  let total = f.type === 'mirror' ? 2 : 1;
  for (const p of ['/count', '/second/count']) {
    const v = values[p];
    if (v === undefined) continue;
    const n = Math.round(v);
    if (Math.abs(v - n) > 1e-9 || n < 1) {
      return fail(
        kerr('INVALID_INPUT', `${FIELD_LABELS[p]} must be a whole number of at least 1`, {
          hint: 'Enter the number of instances, the original included.',
          detail: `${p} = ${v}`,
        }),
      );
    }
    values[p] = n;
    total *= n;
  }
  if (f.type !== 'mirror') {
    if (total === 1) {
      warnings.push(kerr('INVALID_INPUT', 'The pattern has one instance, so it makes no copies'));
    }
    const bad = (f.skip ?? []).filter((k) => !Number.isInteger(k) || k < 1 || k >= total);
    if (bad.length > 0) {
      warnings.push(
        kerr(
          'INVALID_INPUT',
          `Skipped instance${bad.length === 1 ? '' : 's'} ${bad.join(', ')} ${
            bad.length === 1 ? 'is' : 'are'
          } not a copy in this pattern and ${bad.length === 1 ? 'is' : 'are'} ignored`,
          { hint: 'Instance 0 is the original; copies are numbered 1 and up.' },
        ),
      );
    }
  }

  // 3. What is copied.
  const specs: ToolSpec[] = [];
  const refs: Record<string, ResolvedRef> = {};
  const refKeys: Record<string, unknown> = {};
  const sources: BodyState[] = [];
  let target: BodyState | undefined;
  const src = f.source;
  if (src.kind === 'features') {
    if (src.features.length === 0)
      return fail(kerr('INVALID_INPUT', 'Select the features to copy'));
    const targets = new Set<string>();
    for (const [i, id] of src.features.entries()) {
      const feature = ctx.part.features.find((x) => x.id === id);
      if (!feature) {
        unresolved.push({
          path: `/source/features/${i}`,
          ref: { name: `F${id}`, kind: 'body' },
          reason: 'missing',
        });
        continue;
      }
      const spec = ctx.state.tools.get(id);
      if (!spec) {
        const why = !TOOL_TYPES.has(feature.type)
          ? `‘${feature.name}’ cannot be copied: only extrude, revolve, sweep, loft, hole and primitive features can`
          : feature.suppressed
            ? `‘${feature.name}’ is suppressed, so there is nothing to copy`
            : `‘${feature.name}’ must come before this feature`;
        return fail(
          kerr('INVALID_INPUT', why, {
            hint: 'Copy bodies instead, or reorder the features.',
            entityRefs: [`F${id}`],
          }),
        );
      }
      specs.push(spec);
      values[`/ops/${id}`] = spec.op;
      for (const b of spec.bodies) targets.add(b);
    }
    if (unresolved.length > 0) return { unresolved, taint: [] };
    const live = [...targets].filter((b) => ctx.state.bodies.has(b));
    if (live.length === 0) {
      return fail(
        kerr('INVALID_INPUT', 'The copied features no longer change any body', {
          hint: 'Copy bodies instead.',
        }),
      );
    }
    if (live.length > 1) {
      return fail(
        kerr('INVALID_INPUT', 'The copied features change more than one body', {
          hint: 'Copy the features of one body at a time, or copy bodies instead.',
          entityRefs: live,
        }),
        live,
      );
    }
    target = ctx.state.bodies.get(live[0] as string) as BodyState;
    if (target.meshOnly) return fail(meshOnlyError('changed', target.id), [target.id]);
    involved.add(target.id);
  } else {
    if (src.bodies.length === 0) return fail(kerr('INVALID_INPUT', 'Select the bodies to copy'));
    for (const [i, ref] of src.bodies.entries()) {
      const b = resolveBody(ctx, ref, `/source/bodies/${i}`, unresolved);
      if (!b) continue;
      if (b.meshOnly) return fail(meshOnlyError('copied', b.id), [b.id]);
      refs[`/source/bodies/${i}`] = { shape: b.shape, kind: 'body', index: 0 };
      refKeys[`/source/bodies/${i}`] = [b.id, b.key];
      involved.add(b.id);
      sources.push(b);
    }
  }
  const taint = target ? [target.id] : src.kind === 'bodies' && src.merge ? [...involved] : [];
  if (unresolved.length > 0) return { unresolved, taint };
  const key = hashKey({
    t: f.type,
    def: definition(f),
    values,
    frames,
    tools: specs.map((s) => [s.featureId, s.key, s.op]),
    target: target ? [target.id, target.key] : null,
    refs: refKeys,
  });
  const inputs: FeatureInputs = { values, frames, refs };
  const out: Planned = {
    unresolved,
    taint,
    plan: {
      key,
      involved: [...involved],
      run: () => runCopy(core, ctx, f, inputs, specs, target, sources, key),
    },
  };
  if (warnings.length > 0) out.warnings = warnings;
  return out;
}

/**
 * Depth of the blind tool that stands in for a copied through-all extrude (`ToolSpec.build`).
 * Every copy must still cut through the whole target body, so the depth is at least twice the
 * farthest a target point can be from a copied profile plane: the diagonal of the target and
 * profile boxes together (the kernel's own through-all bound) plus the farthest a profile point
 * moves (linear: the pattern's full span; circular: twice its distance from the axis; mirror:
 * twice its distance from the plane). Rounded up to a power of two, so edits that resize the
 * body a little keep the cached tool.
 */
async function throughAllDepth(
  core: EngineCore,
  f: MirrorFeature | LinearPatternFeature | CircularPatternFeature,
  inputs: FeatureInputs,
  target: BodyState,
  profiles: ShapeHandle[],
): Promise<number> {
  const box = emptyBox();
  const profile = emptyBox();
  const tb = await core.massOf(target.shape);
  if (tb) {
    extendBox(box, tb.bbox.min);
    extendBox(box, tb.bbox.max);
  }
  for (const s of profiles) {
    const pb = await core.massOf(s);
    if (!pb) continue;
    for (const p of [pb.bbox.min, pb.bbox.max]) {
      extendBox(box, p);
      extendBox(profile, p);
    }
  }
  const corners: Vec3[] = [];
  if (profile.max[0] >= profile.min[0]) {
    for (let i = 0; i < 8; i++) {
      corners.push([
        (i & 1 ? profile.max : profile.min)[0],
        (i & 2 ? profile.max : profile.min)[1],
        (i & 4 ? profile.max : profile.min)[2],
      ]);
    }
  }
  const values = inputs.values;
  let reach = 0;
  if (f.type === 'linearPattern') {
    for (const p of ['', '/second']) {
      const n = values[`${p}/count`] ?? 1;
      reach += Math.max(0, n - 1) * Math.abs(values[`${p}/spacing`] ?? 0);
    }
  } else {
    const frame = f.type === 'mirror' ? inputs.frames?.plane : inputs.frames?.axis;
    for (const c of corners) {
      if (!frame) break;
      const z = normalize(frame.z);
      const d = sub(c, frame.origin);
      const off = f.type === 'mirror' ? Math.abs(dot(d, z)) : norm(sub(d, scale(z, dot(d, z))));
      reach = Math.max(reach, 2 * off);
    }
  }
  const needed = 2 * (boxDiagonal(box) + reach) + 1;
  return 2 ** Math.ceil(Math.log2(Math.max(needed, 1)));
}

/**
 * Runs a mirror / pattern. Feature copies change the source features' body in place (it keeps
 * its id). Body copies with `merge` fuse into the first source body (the others are consumed);
 * without `merge` each copy is a new body: `B<featureId>` for one, else `B<featureId>:<key>`
 * with the kernel's per-copy key (FeatureResult.bodies).
 */
async function runCopy(
  core: EngineCore,
  ctx: WalkContext,
  f: MirrorFeature | LinearPatternFeature | CircularPatternFeature,
  inputs: FeatureInputs,
  specs: ToolSpec[],
  target: BodyState | undefined,
  sources: BodyState[],
  key: string,
): Promise<{ result: EntryResult; owned: ShapeHandle[] }> {
  const fail = (error: KernelError) => ({ result: { ok: false as const, error }, owned: [] });
  const shapes: Record<string, ShapeHandle> = {};
  for (const spec of specs) {
    const depth =
      spec.throughAll && target
        ? await throughAllDepth(core, f, inputs, target, spec.throughAll)
        : undefined;
    const t = await toolOf(core, ctx, spec, depth);
    if (!t.ok) return fail(t.error);
    shapes[`tool:${spec.featureId}`] = t.value.shape;
  }
  const all: FeatureInputs = { ...inputs, shapes };
  if (target) all.target = target.shape;
  const r = await core.exec(f, all);
  if (!r.ok) return fail(r.error);
  const v = r.value;
  const extras = (v.bodies ?? []).filter((b) => b.shape !== v.shape);
  if (target || (f.source.kind === 'bodies' && f.source.merge)) {
    for (const b of extras) await core.releaseHandle(b.shape);
    const keep = (target ?? sources[0]) as BodyState;
    const consumed = target ? [] : sources.slice(1).map((b) => b.id);
    return {
      result: {
        ok: true,
        set: [{ id: keep.id, shape: v.shape, naming: v.naming, key: `${key}/${keep.id}` }],
        remove: consumed,
        touched: target ? [target.id] : sources.map((b) => b.id),
        warnings: v.warnings,
      },
      owned: [v.shape],
    };
  }
  const copies =
    v.bodies && v.bodies.length > 0 ? v.bodies : [{ key: '', shape: v.shape, naming: v.naming }];
  if (v.bodies && v.bodies.length > 0 && !v.bodies.some((b) => b.shape === v.shape)) {
    await core.releaseHandle(v.shape);
  }
  const set: BodyState[] = copies.map((c) => {
    const id = copies.length === 1 ? `B${f.id}` : `B${f.id}:${c.key}`;
    return { id, shape: c.shape, naming: c.naming, key: `${key}/${id}` };
  });
  return {
    result: { ok: true, set, remove: [], touched: [], warnings: v.warnings },
    owned: [...new Set(copies.map((c) => c.shape))],
  };
}
