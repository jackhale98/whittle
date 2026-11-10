/**
 * Features that change existing bodies in place: fillet / chamfer, boolean, push/pull, shell
 * and draft.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  ChamferFeature,
  DraftFeature,
  EntityRef,
  Feature,
  FeatureInputs,
  FeatureResult,
  FilletFeature,
  KernelError,
  PushPullFeature,
  ResolvedRef,
  Result,
  ShapeHandle,
  ShellFeature,
  UnresolvedRef,
} from '@wren-cad/contracts';
import type { EngineCore } from './core';
import { groupByNormal } from './geometry';
import { hashKey } from './hash';
import { definition, kerr, meshOnlyError } from './helpers';
import { refKeyOf, resolveBody, resolvePlane, resolveSub } from './refs';
import type { ResolvedTarget } from './resolve';
import type { BodyState, EntryResult, Planned, WalkContext } from './state';

export async function planEdgeOp(
  core: EngineCore,
  ctx: WalkContext,
  f: FilletFeature | ChamferFeature,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const groups = new Map<string, { body: BodyState; refs: Record<string, ResolvedRef> }>();
  const refKeys: Record<string, unknown> = {};
  const add = (path: string, t: ResolvedTarget): KernelError | null => {
    const body = ctx.state.bodies.get(t.owner);
    if (body?.meshOnly) {
      return meshOnlyError(f.type === 'fillet' ? 'filleted' : 'chamfered', body.id);
    }
    if (!body)
      return kerr(
        'INVALID_INPUT',
        `Only edges of a body can be ${f.type === 'fillet' ? 'filleted' : 'chamfered'}`,
        { entityRefs: [t.name] },
      );
    let g = groups.get(body.id);
    if (!g) {
      g = { body, refs: {} };
      groups.set(body.id, g);
    }
    g.refs[path] = { shape: t.shape, kind: t.kind, index: t.index };
    refKeys[path] = refKeyOf(ctx, t);
    return null;
  };
  for (let i = 0; i < f.edges.length; i++) {
    const t = await resolveSub(core, ctx, f.edges[i] as EntityRef, `/edges/${i}`, unresolved);
    if (t) {
      const e = add(`/edges/${i}`, t);
      if (e) return { unresolved, taint: [t.owner], error: e };
    }
  }
  if (f.type === 'chamfer' && f.mode.kind === 'distanceAngle' && f.mode.face) {
    const t = await resolveSub(core, ctx, f.mode.face, '/mode/face', unresolved);
    if (t) {
      const e = add('/mode/face', t);
      if (e) return { unresolved, taint: [t.owner], error: e };
    }
  }
  const owners = [...groups.keys()];
  const taint = owners.length > 0 ? owners : [...ctx.state.bodies.keys()];
  const key = hashKey({
    t: f.type,
    // `propagate` absent means true (ADR-019 item 2): both spellings share one cache entry.
    def: { ...(definition(f) as object), propagate: f.propagate !== false },
    values,
    refs: refKeys,
    bodies: [...groups.values()].map((g) => [g.body.id, g.body.key]),
  });
  return {
    unresolved,
    taint,
    plan: {
      key,
      involved: owners,
      run: async () => {
        const set: BodyState[] = [];
        const owned: ShapeHandle[] = [];
        const warnings: KernelError[] = [];
        for (const g of groups.values()) {
          const r = await core.exec(f, {
            values,
            target: g.body.shape,
            refs: g.refs,
          });
          if (!r.ok) {
            for (const h of owned) await core.releaseHandle(h);
            return { result: { ok: false, error: r.error }, owned: [] };
          }
          set.push({
            id: g.body.id,
            shape: r.value.shape,
            naming: r.value.naming,
            key: `${key}/${g.body.id}`,
          });
          owned.push(r.value.shape);
          warnings.push(...r.value.warnings);
        }
        return { result: { ok: true, set, remove: [], touched: owners, warnings }, owned };
      },
    },
  };
}

export async function planBoolean(
  core: EngineCore,
  ctx: WalkContext,
  f: Extract<Feature, { type: 'boolean' }>,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const target = resolveBody(ctx, f.target, '/target', unresolved);
  const tools: BodyState[] = [];
  f.tools.forEach((ref, i) => {
    const b = resolveBody(ctx, ref, `/tools/${i}`, unresolved);
    if (b) tools.push(b);
  });
  const involved = [...(target ? [target.id] : []), ...tools.map((t) => t.id)];
  const taint = involved.length > 0 ? involved : [...ctx.state.bodies.keys()];
  const mesh = [...(target ? [target] : []), ...tools].find((b) => b.meshOnly);
  if (mesh) return { unresolved, taint, error: meshOnlyError('combined', mesh.id) };
  if (target && tools.some((t) => t.id === target.id)) {
    return {
      unresolved,
      taint,
      error: kerr('INVALID_INPUT', 'A body cannot be combined with itself', {
        entityRefs: [target.id],
      }),
    };
  }
  const key = hashKey({
    t: 'boolean',
    def: definition(f),
    bodies: involved.map((id) => [id, ctx.state.bodies.get(id)?.key]),
  });
  const refs: Record<string, ResolvedRef> = {};
  if (target) refs['/target'] = { shape: target.shape, kind: 'body', index: 0 };
  tools.forEach((t, i) => {
    refs[`/tools/${i}`] = { shape: t.shape, kind: 'body', index: 0 };
  });
  return {
    unresolved,
    taint,
    plan: {
      key,
      involved,
      run: async () => {
        if (!target)
          return {
            result: { ok: false, error: kerr('UNRESOLVED_REFERENCE', 'Select the target body') },
            owned: [],
          };
        const r = await core.exec(f, { values, refs });
        if (!r.ok) return { result: { ok: false, error: r.error }, owned: [] };
        for (const extra of r.value.bodies ?? []) await core.releaseHandle(extra.shape);
        return {
          result: {
            ok: true,
            set: [
              {
                id: target.id,
                shape: r.value.shape,
                naming: r.value.naming,
                key: `${key}/${target.id}`,
              },
            ],
            remove: f.keepTools ? [] : tools.map((t) => t.id),
            touched: involved,
            warnings: r.value.warnings,
          },
          owned: [r.value.shape],
        };
      },
    },
  };
}

/**
 * Push/pull (M2): faces of one body moved along their outward normals by `distance`. The
 * kernel names the result per naming.ts "M2 additions" (moved faces keep their names, new walls
 * are `F…:side(<edge>)`), so the body keeps its id and downstream refs keep resolving.
 */
export async function planPushPull(
  core: EngineCore,
  ctx: WalkContext,
  f: PushPullFeature,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const refs: Record<string, ResolvedRef> = {};
  const refKeys: Record<string, unknown> = {};
  const owners = new Set<string>();
  const picked: string[] = [];
  for (let i = 0; i < f.faces.length; i++) {
    const ref = f.faces[i] as EntityRef;
    if (ref.kind !== 'face') {
      return {
        unresolved,
        taint: [],
        error: kerr('INVALID_INPUT', 'Only faces can be pushed or pulled', {
          hint: 'Pick flat faces of a body.',
          entityRefs: [ref.name],
        }),
      };
    }
    const t = await resolveSub(core, ctx, ref, `/faces/${i}`, unresolved);
    if (t) {
      refs[`/faces/${i}`] = { shape: t.shape, kind: t.kind, index: t.index };
      refKeys[`/faces/${i}`] = refKeyOf(ctx, t);
      owners.add(t.owner);
      picked.push(t.name);
    }
  }
  const bodyIds = [...owners].filter((o) => ctx.state.bodies.has(o));
  const taint = bodyIds.length > 0 ? bodyIds : [...ctx.state.bodies.keys()];
  if (f.faces.length === 0) {
    return {
      unresolved,
      taint,
      error: kerr('UNRESOLVED_REFERENCE', 'Select at least one face to push or pull', {
        hint: 'Pick a flat face of a body.',
      }),
    };
  }
  const mesh = bodyIds.find((id) => ctx.state.bodies.get(id)?.meshOnly);
  if (mesh) return { unresolved, taint, error: meshOnlyError('pushed or pulled', mesh) };
  if (owners.size > 1 || (owners.size === 1 && bodyIds.length === 0)) {
    return {
      unresolved,
      taint,
      error: kerr(
        'INVALID_INPUT',
        bodyIds.length === 0
          ? 'Push/pull moves faces of a body'
          : 'Push/pull faces must all be on one body',
        { hint: 'Pick faces of one solid body.', entityRefs: picked },
      ),
    };
  }
  const bodyId = bodyIds[0];
  const key = hashKey({ t: 'pushPull', def: definition(f), values, refs: refKeys });
  return {
    unresolved,
    taint,
    plan: {
      key,
      involved: bodyIds,
      run: async () => {
        const body = bodyId === undefined ? undefined : ctx.state.bodies.get(bodyId);
        if (!body) {
          return {
            result: {
              ok: false,
              error: kerr('UNRESOLVED_REFERENCE', 'Select the faces to push or pull'),
            },
            owned: [],
          };
        }
        const r = await pushPullSteps(core, f, body, values, refs, picked);
        if (!r.ok) return { result: { ok: false, error: r.error }, owned: [] };
        return {
          result: {
            ok: true,
            set: [
              {
                id: body.id,
                shape: r.value.shape,
                naming: r.value.naming,
                key: `${key}/${body.id}`,
              },
            ],
            remove: [],
            touched: [body.id],
            warnings: r.value.warnings,
          },
          owned: [r.value.shape],
        };
      },
    },
  };
}

/**
 * Runs a push/pull as one kernel step per normal group (ADR-013 addendum). Faces facing the same
 * way move together in one prism + boolean, as before. Faces facing different ways move group
 * by group, groups sorted by normal; after each step the remaining groups' faces are found on
 * the new body by their persistent names (moved and untouched faces keep them, naming.ts M2).
 * Moving the top and then the side means the side is already taller when it moves, so its prism
 * fills the corner: the result is the uniform offset at convex corners. A face that no longer
 * exists by name after an earlier step fails the feature; it is never guessed.
 */
async function pushPullSteps(
  core: EngineCore,
  f: PushPullFeature,
  body: BodyState,
  values: Record<string, number>,
  refs: Record<string, ResolvedRef>,
  picked: readonly string[],
): Promise<Result<FeatureResult>> {
  const fp = await core.fingerprints(body.shape);
  const members = Object.keys(refs)
    .map((path) => Number(path.slice('/faces/'.length)))
    .sort((a, b) => a - b)
    .map((i) => {
      const ref = refs[`/faces/${i}`] as ResolvedRef;
      const name = body.naming.find((n) => n.kind === 'face' && n.index === ref.index)?.name;
      return { i, ref, name, normal: fp?.faces[ref.index]?.normal };
    });
  const groups = fp ? groupByNormal(members) : null;
  // One normal (or a curved face, which the kernel reports): a single step, as in M2.
  if (!groups || groups.length < 2) return core.exec(f, { target: body.shape, values, refs });

  let shape = body.shape;
  let naming = body.naming;
  const warnings: KernelError[] = [];
  const seen = new Set<string>();
  const release = async (h: ShapeHandle): Promise<void> => {
    if (h !== body.shape) await core.kernel.release(h);
  };
  for (const [g, group] of groups.entries()) {
    const stepRefs: Record<string, ResolvedRef> = {};
    const faces: EntityRef[] = [];
    for (const m of group.items) {
      const original = f.faces[m.i] as EntityRef;
      let index = m.ref.index;
      if (g > 0) {
        const hit =
          m.name === undefined
            ? undefined
            : naming.find((n) => n.kind === 'face' && n.name === m.name);
        if (!hit) {
          await release(shape);
          return {
            ok: false,
            error: kerr(
              'UNRESOLVED_REFERENCE',
              `Selected face ${m.i + 1} is gone once the faces facing another way have moved`,
              {
                hint: 'Push/pull these faces in separate steps, or pick fewer faces.',
                detail: `push/pull step ${g + 1} of ${groups.length}: no face named ${
                  m.name ?? '(unnamed)'
                }`,
                entityRefs: [m.name ?? original.name],
              },
            ),
          };
        }
        index = hit.index;
      }
      stepRefs[`/faces/${faces.length}`] = { shape, kind: 'face', index };
      faces.push(original);
    }
    const r = await core.exec({ ...f, faces }, { target: shape, values, refs: stepRefs });
    await release(shape);
    if (!r.ok) {
      // The error speaks for the whole selection, not just this step's share of it.
      const names = [...new Set([...(r.error.entityRefs ?? []), ...picked])];
      return { ok: false, error: { ...r.error, entityRefs: names } };
    }
    for (const w of r.value.warnings) {
      const k = `${w.code}|${w.message}`;
      if (seen.has(k)) continue;
      seen.add(k);
      warnings.push(w);
    }
    shape = r.value.shape;
    naming = r.value.naming;
  }
  return { ok: true, value: { shape, naming, warnings } };
}

/** Resolves face refs that must all lie on one (B-rep) body. */
async function facesOfOneBody(
  core: EngineCore,
  ctx: WalkContext,
  refsIn: readonly EntityRef[],
  base: string,
  unresolved: UnresolvedRef[],
  verb: string,
): Promise<{
  body?: BodyState;
  refs: Record<string, ResolvedRef>;
  refKeys: Record<string, unknown>;
  error?: KernelError;
  taint: string[];
}> {
  const refs: Record<string, ResolvedRef> = {};
  const refKeys: Record<string, unknown> = {};
  const owners = new Set<string>();
  const picked: string[] = [];
  for (let i = 0; i < refsIn.length; i++) {
    const ref = refsIn[i] as EntityRef;
    const path = `${base}/${i}`;
    const t = await resolveSub(core, ctx, ref, path, unresolved);
    if (!t) continue;
    if (t.kind !== 'face') {
      return {
        refs,
        refKeys,
        taint: [],
        error: kerr('INVALID_INPUT', `Only faces can be ${verb}`, { entityRefs: [ref.name] }),
      };
    }
    refs[path] = { shape: t.shape, kind: t.kind, index: t.index };
    refKeys[path] = refKeyOf(ctx, t);
    owners.add(t.owner);
    picked.push(t.name);
  }
  const ids = [...owners];
  const bodies = ids.filter((o) => ctx.state.bodies.has(o));
  if (ids.length > 1 || (ids.length === 1 && bodies.length === 0)) {
    return {
      refs,
      refKeys,
      taint: bodies,
      error: kerr(
        'INVALID_INPUT',
        bodies.length === 0
          ? `Only faces of a body can be ${verb}`
          : `The faces must all be on one body`,
        { hint: 'Pick faces of one solid body.', entityRefs: picked },
      ),
    };
  }
  const body = bodies[0] === undefined ? undefined : ctx.state.bodies.get(bodies[0]);
  if (body?.meshOnly) {
    return { refs, refKeys, taint: [body.id], error: meshOnlyError(verb, body.id) };
  }
  return body ? { body, refs, refKeys, taint: [body.id] } : { refs, refKeys, taint: [] };
}

/** Runs a feature that changes one body in place (shell, draft, hole). */
export async function runOnBody(
  core: EngineCore,
  f: Feature,
  body: BodyState,
  inputs: FeatureInputs,
  key: string,
): Promise<{ result: EntryResult; owned: ShapeHandle[] }> {
  const r = await core.exec(f, { ...inputs, target: body.shape });
  if (!r.ok) return { result: { ok: false, error: r.error }, owned: [] };
  for (const extra of r.value.bodies ?? []) {
    if (extra.shape !== r.value.shape) await core.releaseHandle(extra.shape);
  }
  return {
    result: {
      ok: true,
      set: [
        { id: body.id, shape: r.value.shape, naming: r.value.naming, key: `${key}/${body.id}` },
      ],
      remove: [],
      touched: [body.id],
      warnings: r.value.warnings,
    },
    owned: [r.value.shape],
  };
}

export async function planShell(
  core: EngineCore,
  ctx: WalkContext,
  f: ShellFeature,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const g = await facesOfOneBody(core, ctx, f.openFaces, '/openFaces', unresolved, 'shelled');
  if (g.error) return { unresolved, taint: g.taint, error: g.error };
  let body = g.body;
  if (f.openFaces.length === 0) {
    if (!f.body) {
      return {
        unresolved,
        taint: [],
        error: kerr('INVALID_INPUT', 'Pick the faces to remove, or the body to hollow'),
      };
    }
    body = resolveBody(ctx, f.body, '/body', unresolved) ?? undefined;
    if (body?.meshOnly) {
      return { unresolved, taint: [body.id], error: meshOnlyError('shelled', body.id) };
    }
  } else if (f.body && body && f.body.name !== body.id) {
    return {
      unresolved,
      taint: [body.id],
      error: kerr('INVALID_INPUT', 'The faces to remove are not on the selected body', {
        entityRefs: [f.body.name],
      }),
    };
  }
  if (unresolved.length > 0 || !body) return { unresolved, taint: body ? [body.id] : [] };
  if (!((values['/thickness'] ?? 0) > 0)) {
    return {
      unresolved,
      taint: [body.id],
      error: kerr('INVALID_INPUT', 'The shell thickness must be greater than zero', {
        hint: 'Enter a positive thickness; use the direction to shell outward.',
      }),
    };
  }
  const target = body;
  const key = hashKey({
    t: 'shell',
    def: definition(f),
    values,
    refs: g.refKeys,
    body: [target.id, target.key],
  });
  return {
    unresolved,
    taint: [target.id],
    plan: {
      key,
      involved: [target.id],
      run: () => runOnBody(core, f, target, { values, refs: g.refs }, key),
    },
  };
}

export async function planDraft(
  core: EngineCore,
  ctx: WalkContext,
  f: DraftFeature,
  values: Record<string, number>,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const g = await facesOfOneBody(core, ctx, f.faces, '/faces', unresolved, 'drafted');
  if (g.error) return { unresolved, taint: g.taint, error: g.error };
  const p = await resolvePlane(core, ctx, f.neutral, '/neutral', unresolved);
  if (p && 'code' in p) return { unresolved, taint: g.taint, error: p };
  if (unresolved.length > 0 || !p || !g.body) return { unresolved, taint: g.taint };
  if (f.faces.length === 0) {
    return {
      unresolved,
      taint: [],
      error: kerr('INVALID_INPUT', 'Pick the faces to draft'),
    };
  }
  const body = g.body;
  const refs = { ...g.refs };
  const refKeys: Record<string, unknown> = { ...g.refKeys, '/neutral': p.shapeKey };
  // `frames.neutral` always carries the plane; `refs['/neutral']` too when it is a face or a
  // plane feature's face (origin planes have no shape).
  if (p.target) {
    refs['/neutral'] = { shape: p.target.shape, kind: p.target.kind, index: p.target.index };
    refKeys['/neutral'] = [p.shapeKey, ...refKeyOf(ctx, p.target).slice(1)];
  }
  const frames = { neutral: p.frame };
  const key = hashKey({
    t: 'draft',
    def: definition(f),
    values,
    refs: refKeys,
    frames,
    body: [body.id, body.key],
  });
  return {
    unresolved,
    taint: [body.id],
    plan: {
      key,
      involved: [body.id],
      run: () => runOnBody(core, f, body, { values, refs, frames }, key),
    },
  };
}
