/**
 * Annotation resolution after the walk (M4, ADR-090, proposal §2.7): every `Part.annotations`
 * entry is resolved against the part's **final** state in the regenerated slot (so in that slot's
 * configuration: the engine is handed the configuration-resolved document, as for features).
 *
 * Rules, the same as for feature refs (PLAN §7.3, ADR-078): exact name, then merge alias
 * (`merged`, never healed), then the name family with containment, then fingerprints for weak
 * (imported) names; otherwise unresolved. Never re-attached to a guessed entity. `source`,
 * `appliesTo` and datum ids are resolved too (`/source`, `/appliesTo`, `/datums/i/datums/j`).
 *
 * States:
 *  - `suppressed` (ADR-090 decision 7, "not in this configuration"): the annotation is suppressed,
 *    its source feature is, or every unresolved ref is explained by a suppressed feature
 *    (`AttentionCause.kind === 'suppressed'`, structural: known exactly, not a guess), a datum or
 *    the dimension a frame applies to is suppressed;
 *  - `needsAttention`: anything else unresolved, a failed source, a value that cannot be had;
 *  - `ok`.
 * `value` (mm / rad) is the source's, else the nominal's, else the measurement, and is **absent
 * whenever the state is not `ok`** (trap T1). `measured` is the cross-check from the geometry
 * (annotation-geometry.ts), `anchors` are parallel to `refs`, hole callouts list `instances`
 * (pattern and mirror copies included).
 *
 * Annotations never enter a feature's cache key or the walk: they are read after it. Cost: one
 * resolution per annotation only when asked (`RegenRequest.annotations`, default "the part has
 * annotations"), and a resolution is reused while the final state (body, sketch, plane and datum
 * content keys, the merge table, feature states and keys, parameters) and the annotation are
 * unchanged. Geometry probes are memoised per shape handle.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Annotation,
  AnnotationResolution,
  AnnotationSource,
  AttentionCause,
  EntityRef,
  Feature,
  Id,
  KernelError,
  NamedDimension,
  RefPoint,
  Vec3,
} from '@wren-cad/contracts';
import {
  evaluateFeatureValues,
  expressionEngine,
  exprFields,
  holeRow,
  resolveHoleSize,
  scopeOf,
} from '@wren-cad/document';
import { anchorOf, measureAnnotation, type RefGeo, subGeometry } from './annotation-geometry';
import { causeLabel } from './attribution';
import {
  type CauseEnv,
  changeCause,
  refIdentity,
  stillHolds,
  structuralCause,
  type Walk,
} from './cause';
import type { EngineCore } from './core';
import { normalize, ORIGIN_AXES, ORIGIN_PLANES } from './geometry';
import { hashKey } from './hash';
import { kerr } from './helpers';
import { AXIS_NAME, fingerprintOf, PLANE_NAME, POINT_NAME, resolveSub } from './refs';
import { baseName } from './resolve';
import { type AnnotationMemo, primaryNaming, type WalkContext } from './state';
import type { RegenUnresolvedRef } from './types';

const DIMENSION_KINDS = new Set<Annotation['kind']>([
  'linear',
  'aligned',
  'ordinate',
  'radius',
  'diameter',
  'angle',
  'chamfer',
]);

/** Kinds whose value the drawing shows (a number is required for `ok`). */
const VALUED_KINDS = new Set<Annotation['kind']>([...DIMENSION_KINDS, 'holeCallout']);

/**
 * Resolves the part's annotations against the final state of the walk in `ctx` (`prev`: the
 * previous regen's walk of this slot, for causes). One resolution per annotation, sorted by id.
 */
export async function resolveAnnotations(
  core: EngineCore,
  ctx: WalkContext,
  prev: Walk | null,
): Promise<AnnotationResolution[]> {
  const anns = [...(ctx.part.annotations ?? [])].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const memo = ctx.pc.annotations;
  // Overrides and memo entries are keyed by id: a deleted annotation's entry goes, nothing moves.
  const ids = new Set(anns.map((a) => a.id));
  for (const id of [...memo.keys()]) if (!ids.has(id)) memo.delete(id);
  if (anns.length === 0) return [];

  const byId = new Map(anns.map((a) => [a.id, a]));
  const state = stateKey(ctx);
  const env: CauseEnv = {
    part: ctx.part,
    index: ctx.index,
    walk: ctx.walk,
    prev,
    label: causeLabel,
  };
  const out = new Map<Id, AnnotationResolution>();
  // Frames bound to a dimension (`appliesTo`) read that dimension's resolution: second pass.
  const later = (a: Annotation) => a.kind === 'geometricTolerance' && a.appliesTo !== undefined;
  for (const pass of [false, true]) {
    for (const a of anns) {
      if (later(a) !== pass) continue;
      const key = hashKey({ state, a, deps: dependencies(a, byId, out) });
      const m = memo.get(a.id);
      // A needs-attention resolution carries causes computed against the previous regen: reused
      // only from the regen right before this one (where they were computed or carried).
      const reuse =
        m !== undefined &&
        m.key === key &&
        (m.resolution.state !== 'needsAttention' || m.revision === ctx.pc.revision - 1);
      if (m && reuse) {
        m.revision = ctx.pc.revision;
        out.set(a.id, m.resolution);
        continue;
      }
      const r = await resolveOne(core, ctx, env, a, byId, out, m);
      memo.set(a.id, { key, revision: ctx.pc.revision, resolution: r.resolution, refs: r.refs });
      out.set(a.id, r.resolution);
    }
  }
  return anns.map((a) => structuredClone(out.get(a.id) as AnnotationResolution));
}

/**
 * Everything a resolution reads besides the annotation itself: the final state's content keys
 * (bodies, sketches, planes, datums), the merge table, each feature's state and cache key, the
 * parameters and units (sources and nominals). Equal keys give equal resolutions.
 */
function stateKey(ctx: WalkContext): string {
  const st = ctx.state;
  return hashKey({
    b: [...st.bodies.values()].map((b) => [b.id, b.key]),
    s: [...st.sketches.values()].map((s) => [s.id, s.key]),
    p: [...st.planes.values()].map((p) => [p.id, p.key]),
    d: [...st.datums.values()].map((d) => [d.id, d.key]),
    m: [...st.merged.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)),
    w: ctx.walk.entries.map((e) => [e.id, e.state, e.key ?? null]),
    params: ctx.doc.params.map((p) => [p.name, p.expr]),
    units: ctx.doc.units,
  });
}

/** What else an annotation's resolution reads: datum annotations and the frame's dimension. */
function dependencies(
  a: Annotation,
  byId: ReadonlyMap<Id, Annotation>,
  done: ReadonlyMap<Id, AnnotationResolution>,
): unknown {
  if (a.kind !== 'geometricTolerance') return null;
  const datums = (a.datums ?? []).flatMap((c) =>
    c.datums.map((d) => ('datum' in d ? (byId.get(d.datum) ?? null) : null)),
  );
  const applies = a.appliesTo === undefined ? null : (done.get(a.appliesTo) ?? null);
  return { datums, applies };
}

interface Resolved {
  resolution: AnnotationResolution;
  refs: AnnotationMemo['refs'];
}

/** The pseudo `EntityRef` of a non-geometric binding (a source feature, an annotation id). */
const bindingRef = (name: string): EntityRef => ({ name, kind: 'body' });

async function resolveOne(
  core: EngineCore,
  ctx: WalkContext,
  env: CauseEnv,
  a: Annotation,
  byId: ReadonlyMap<Id, Annotation>,
  done: ReadonlyMap<Id, AnnotationResolution>,
  last: AnnotationMemo | undefined,
): Promise<Resolved> {
  const refsMemo: AnnotationMemo['refs'] = new Map();
  if (a.suppressed === true) {
    return { resolution: { annotationId: a.id, state: 'suppressed' }, refs: refsMemo };
  }
  const consumer = `A:${a.id}`;
  ctx.current = { featureId: consumer, rebound: [], merged: [], grown: [] };
  const unresolved: RegenUnresolvedRef[] = [];
  /** Causes that make the annotation "not in this configuration" (suppressed). */
  const suppressedBy: (AttentionCause | null)[] = [];
  /** Reasons the annotation needs attention without an unresolved ref. */
  const problems: { error: KernelError; cause?: AttentionCause }[] = [];

  // Source (dimensions and hole callouts).
  const source = 'source' in a ? a.source : undefined;
  let sourceValue: number | undefined;
  let sourceFeature: Feature | undefined;
  let sourceSuppressed = false;
  if (source) {
    const s = sourceOf(ctx, a, source);
    if (s.unresolved) unresolved.push(s.unresolved);
    if (s.suppressed) {
      suppressedBy.push(s.suppressed);
      sourceSuppressed = true;
    }
    if (s.problem) problems.push(s.problem);
    sourceValue = s.value;
    sourceFeature = s.feature;
  }

  // Refs.
  const at = (i: number): RefPoint => a.at?.[i] ?? 'self';
  const geos: (RefGeo | null)[] = [];
  for (let i = 0; i < a.refs.length; i++) {
    const ref = a.refs[i] as EntityRef;
    geos.push(await refGeometry(core, ctx, ref, `/refs/${i}`, unresolved));
  }

  // GD&T bindings: datums by id, and the dimension a frame applies to.
  if (a.kind === 'geometricTolerance') {
    (a.datums ?? []).forEach((c, i) => {
      c.datums.forEach((d, j) => {
        const path = `/datums/${i}/datums/${j}`;
        if (!('datum' in d)) {
          unresolved.push({ path, ref: bindingRef(d.label), reason: 'missing' });
          return;
        }
        const target = byId.get(d.datum);
        if (target?.kind !== 'datumFeature') {
          unresolved.push({ path, ref: bindingRef(d.datum), reason: 'missing' });
        } else if (target.suppressed === true) suppressedBy.push(null);
      });
    });
    if (a.appliesTo !== undefined) {
      const target = byId.get(a.appliesTo);
      const r = done.get(a.appliesTo);
      if (!target || !DIMENSION_KINDS.has(target.kind) || !r) {
        unresolved.push({ path: '/appliesTo', ref: bindingRef(a.appliesTo), reason: 'missing' });
      } else if (r.state === 'suppressed') {
        suppressedBy.push(r.cause ?? null);
      } else if (r.state === 'needsAttention') {
        problems.push({
          error: kerr(
            'UNRESOLVED_REFERENCE',
            'The dimension this frame applies to needs attention',
            {
              hint: 'Fix that dimension first.',
            },
          ),
          ...(r.cause ? { cause: r.cause } : {}),
        });
      }
    }
  }

  // Hole callout instances (pattern and mirror copies included).
  let instances: InstanceFace[] | undefined;
  if (a.kind === 'holeCallout' && sourceFeature) {
    if (sourceFeature.type === 'hole') {
      instances = await holeInstances(core, ctx, sourceFeature.id);
    } else if (sourceFeature.type === 'thread') {
      // The thread's own face, resolved as the thread feature resolves it (its reports stay out).
      const mine = ctx.current;
      ctx.current = { featureId: sourceFeature.id, rebound: [], merged: [], grown: [] };
      const t = await resolveSub(core, ctx, sourceFeature.face, '/face', []);
      ctx.current = mine;
      instances = t && t.kind === 'face' ? [{ shape: t.shape, index: t.index, name: t.name }] : [];
    }
    if (instances && instances.length === 0 && !problems.length && !unresolved.length) {
      problems.push({
        error: kerr('UNRESOLVED_REFERENCE', 'The hole is no longer in the model', {
          hint: 'Check the hole feature, or delete the callout.',
          entityRefs: [`F${sourceFeature.id}`],
        }),
      });
    }
  }

  // Causes of the unresolved refs (cause.ts rules, the annotation as a consumer after the walk).
  // Rule 2 compares with the previous walk, so only a resolution from the regen right before.
  const fresh = last !== undefined && last.revision === ctx.pc.revision - 1;
  for (const u of unresolved) {
    // Datum letters and annotation ids are not persistent names: no feature tags to read.
    const named = u.path.startsWith('/refs/') || u.path === '/source';
    if (!u.cause && named) {
      const c = causeFor(env, consumer, u, last, fresh);
      if (c) u.cause = c;
    }
    const identity = refIdentity(u.ref) ?? u.ref.name;
    refsMemo.set(u.path, { identity, resolved: false, ...(u.cause ? { cause: u.cause } : {}) });
  }
  a.refs.forEach((r, i) => {
    const path = `/refs/${i}`;
    if (!refsMemo.has(path))
      refsMemo.set(path, { identity: refIdentity(r) ?? r.name, resolved: true });
  });

  const res: AnnotationResolution = { annotationId: a.id, state: 'ok' };
  const open = unresolved.filter((u) => u.cause?.kind !== 'suppressed');
  const bySuppression = unresolved.filter((u) => u.cause?.kind === 'suppressed');
  if (
    sourceSuppressed ||
    (open.length === 0 &&
      problems.length === 0 &&
      (bySuppression.length > 0 || suppressedBy.length > 0))
  ) {
    res.state = 'suppressed';
    const cause = suppressedBy.find((c) => c) ?? bySuppression[0]?.cause;
    if (cause) res.cause = cause;
    return { resolution: res, refs: refsMemo };
  }

  if (unresolved.length > 0) res.unresolved = unresolved;
  if (ctx.current.merged.length > 0) res.merged = ctx.current.merged;
  if (ctx.current.grown.length > 0) res.grown = ctx.current.grown;
  if (ctx.current.rebound.length > 0) res.rebound = ctx.current.rebound;
  if (a.refs.length > 0) {
    res.anchors = [];
    for (let i = 0; i < geos.length; i++) {
      const g = geos[i];
      res.anchors.push(g ? await anchorOf(core, g, at(i)) : null);
    }
  }

  // Values.
  let measured: number | undefined;
  let unmeasurable: { reason: string; hint?: string } | undefined;
  if (geos.every((g) => g !== null)) {
    const m = await measureAnnotation(core, a, geos as RefGeo[], a.at ?? []);
    if (typeof m === 'number' && Number.isFinite(m)) measured = m;
    else if (m !== undefined && typeof m !== 'number') unmeasurable = m;
  }
  if (instances) {
    res.instances = await instanceRefs(core, instances);
    if (a.kind === 'holeCallout' && instances[0] && sourceFeature?.type === 'hole') {
      const g = await subGeometry(core, { ...instances[0], kind: 'face' });
      if (g?.t === 'axis' && g.radius !== undefined) measured = 2 * g.radius;
    }
  }
  if (measured !== undefined) res.measured = measured;
  let nominal: number | undefined;
  if ('nominal' in a && a.nominal !== undefined) {
    const expected: NamedDimension = a.kind === 'angle' ? 'angle' : 'length';
    const r = expressionEngine.evaluate(a.nominal, expected, scopeOf(ctx.doc));
    if (r.ok) nominal = r.value;
    else {
      problems.push({
        error: kerr('INVALID_INPUT', `The stated value: ${r.error.message}`, {
          hint: 'Correct the value.',
        }),
      });
    }
  }
  const value = sourceValue ?? nominal ?? measured;
  if (
    VALUED_KINDS.has(a.kind) &&
    value === undefined &&
    problems.length === 0 &&
    open.length === 0
  ) {
    problems.push({
      error: kerr('INVALID_INPUT', unmeasurable?.reason ?? 'This dimension has no value', {
        ...(unmeasurable?.hint ? { hint: unmeasurable.hint } : {}),
      }),
    });
  }

  if (unresolved.length > 0 || problems.length > 0) {
    res.state = 'needsAttention';
    const cause = unresolved.find((u) => u.cause)?.cause ?? problems.find((p) => p.cause)?.cause;
    if (cause) res.cause = cause;
    const first = unresolved[0];
    res.error =
      problems[0]?.error ??
      kerr(
        'UNRESOLVED_REFERENCE',
        first?.reason === 'ambiguous'
          ? 'A reference now matches several entities'
          : 'A reference no longer exists',
        {
          hint: 'Reattach the highlighted reference.',
          entityRefs: [...new Set(unresolved.map((u) => u.ref.name))],
        },
      );
    // Trap T1: no value whenever the state is not ok.
    return { resolution: res, refs: refsMemo };
  }
  if (value !== undefined && VALUED_KINDS.has(a.kind)) res.value = value;
  return { resolution: res, refs: refsMemo };
}

/**
 * Cause of one unresolved annotation ref (cause.ts): structural from the name, else the change in
 * this regen when the same stored ref resolved in the previous one, else the cause it had while it
 * still holds. Bindings without a feature tag (annotation ids, datum letters) have none.
 */
function causeFor(
  env: CauseEnv,
  consumer: string,
  u: RegenUnresolvedRef,
  last: AnnotationMemo | undefined,
  fresh: boolean,
): AttentionCause | null {
  const structural = structuralCause(env, consumer, u.ref.name, u.ref.kind);
  if (structural) return structural;
  const identity = refIdentity(u.ref) ?? u.ref.name;
  const was = last?.refs.get(u.path);
  if (!was || was.identity !== identity) return null;
  if (was.resolved) {
    // Only against the walk the ref resolved in (the regen right before this one).
    return fresh && env.prev ? changeCause(env, consumer, u.ref.name, u.ref.kind) : null;
  }
  return was.cause && stillHolds(env, consumer, was.cause) ? was.cause : null;
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

interface SourceOut {
  value?: number;
  feature?: Feature;
  unresolved?: RegenUnresolvedRef;
  suppressed?: AttentionCause;
  problem?: { error: KernelError; cause?: AttentionCause };
}

/** The source's feature, its state in this walk and its value (mm / rad). */
function sourceOf(ctx: WalkContext, a: Annotation, s: AnnotationSource): SourceOut {
  const i = ctx.index.get(s.featureId);
  const f = i === undefined ? undefined : ctx.part.features[i];
  if (!f) {
    return {
      unresolved: { path: '/source', ref: bindingRef(`F${s.featureId}`), reason: 'missing' },
    };
  }
  const st = ctx.walk.byId.get(f.id)?.state;
  if (st === 'suppressed')
    return { feature: f, suppressed: { featureId: f.id, kind: 'suppressed' } };
  if (st === 'rolledBack') {
    return {
      feature: f,
      problem: {
        error: kerr('INVALID_INPUT', `‘${f.name}’ is after the rollback bar`, {
          hint: 'Roll the part forward to show this value.',
        }),
      },
    };
  }
  if (st !== 'ok') {
    return {
      feature: f,
      problem: {
        error: kerr('UNRESOLVED_REFERENCE', `‘${f.name}’ failed, so its value is not known`, {
          hint: 'Fix the feature first.',
          entityRefs: [`F${f.id}`],
        }),
        cause: { featureId: f.id, kind: 'failed' },
      },
    };
  }
  const changed = (detail: string): SourceOut => ({
    feature: f,
    unresolved: {
      path: '/source',
      ref: bindingRef(`F${f.id}`),
      reason: 'missing',
      cause: { featureId: f.id, kind: 'changed', detail },
    },
  });
  const evaluated = () => evaluateFeatureValues(f, ctx.doc);
  const fromValues = (pointer: string): SourceOut => {
    const ev = evaluated();
    const v = ev.values[pointer];
    if (v !== undefined) return { feature: f, value: v };
    const e = ev.errors[pointer];
    return {
      feature: f,
      problem: {
        error: kerr(
          'INVALID_INPUT',
          e ? `The source value: ${e.message}` : 'The source has no value',
        ),
      },
    };
  };
  switch (s.kind) {
    case 'sketchDimension': {
      if (f.type !== 'sketch') return changed('not a sketch');
      const k = f.constraints.findIndex((c) => c.id === s.constraintId && 'value' in c);
      const c = f.constraints[k];
      if (!c || !('value' in c)) return changed('dimension deleted');
      let out: SourceOut;
      if (c.driving) out = fromValues(`/constraints/${k}/value`);
      else {
        const v = ctx.state.sketches.get(f.id)?.driven?.[c.id];
        out =
          v === undefined
            ? {
                feature: f,
                problem: { error: kerr('INVALID_INPUT', 'The reference dimension has no value') },
              }
            : { feature: f, value: v };
      }
      if (out.value !== undefined) out.value = asKind(a, out.value, c.kind);
      return out;
    }
    case 'featureField': {
      const field = exprFields(f).find((x) => x.pointer === s.path);
      if (!field) return changed(`${causeLabel(f, s.path).toLowerCase()} no longer applies`);
      const out = fromValues(s.path);
      if (out.value !== undefined) {
        const last = s.path.split('/').pop() ?? '';
        out.value = asKind(
          a,
          out.value,
          last === 'radius' ? 'radius' : last === 'diameter' ? 'diameter' : '',
        );
      }
      return out;
    }
    case 'feature':
      return wholeFeature(ctx, a, f);
  }
}

/** A whole feature's value: a chamfer's distance, a hole's diameter, a thread's major diameter. */
function wholeFeature(ctx: WalkContext, a: Annotation, f: Feature): SourceOut {
  if (a.kind === 'holeCallout' && f.type !== 'hole' && f.type !== 'thread') {
    return {
      feature: f,
      problem: {
        error: kerr('INVALID_INPUT', 'A hole callout is bound to a hole or a thread feature'),
      },
    };
  }
  const ev = () => evaluateFeatureValues(f, ctx.doc).values;
  switch (f.type) {
    case 'chamfer': {
      const v = ev()['/mode/distance'];
      return v === undefined ? { feature: f } : { feature: f, value: v };
    }
    case 'fillet': {
      const v = ev()['/radius'];
      return v === undefined ? { feature: f } : { feature: f, value: asKind(a, v, 'radius') };
    }
    case 'hole': {
      // As the hole executor sizes it (exec-holes.ts): the table, explicit values overriding it.
      const values = ev();
      const opt = (pointer: string, key: string) =>
        values[pointer] === undefined ? {} : { [key]: values[pointer] };
      const size = resolveHoleSize({
        standard: f.standard,
        kind: f.kind,
        size: f.size,
        fit: f.fit,
        ...opt('/diameter', 'diameter'),
        counterbore: {
          ...opt('/counterbore/diameter', 'diameter'),
          ...opt('/counterbore/depth', 'depth'),
        },
        countersink: {
          ...opt('/countersink/diameter', 'diameter'),
          ...opt('/countersink/angle', 'angle'),
        },
      });
      if (!size.ok) {
        return {
          feature: f,
          problem: { error: kerr('INVALID_INPUT', size.message, { hint: size.hint }) },
        };
      }
      const d = size.value.thread?.nominal ?? size.value.diameter;
      return { feature: f, value: asKind(a, d, 'diameter') };
    }
    case 'thread': {
      const row = holeRow(f.standard, f.size);
      return row ? { feature: f, value: asKind(a, row.nominal, 'diameter') } : { feature: f };
    }
    default:
      return { feature: f };
  }
}

/** Converts a radius ↔ diameter source to the annotation's kind. */
function asKind(a: Annotation, v: number, of: string): number {
  if (a.kind === 'radius' && of === 'diameter') return v / 2;
  if (a.kind === 'diameter' && of === 'radius') return 2 * v;
  return v;
}

// ---------------------------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------------------------

/**
 * Resolves one annotation ref to its geometry: origin planes, axes and point by name, construction
 * planes, axes and points (`F…:plane` / `:axis` / `:point`) from the walk's state, bodies by id, and
 * every face, edge, vertex and sketch entity through `resolveSub` (the feature rules).
 */
async function refGeometry(
  core: EngineCore,
  ctx: WalkContext,
  ref: EntityRef,
  path: string,
  unresolved: RegenUnresolvedRef[],
): Promise<RefGeo | null> {
  const op = ORIGIN_PLANES[ref.name];
  if (op) return { t: 'plane', origin: op.origin, normal: normalize(op.z) };
  const oa = ORIGIN_AXES[ref.name];
  if (oa) return { t: 'axis', origin: oa.origin, dir: normalize(oa.z), extent: [0, 0] };
  if (ref.name === 'origin:O') return { t: 'point', at: [0, 0, 0] };
  const pl = PLANE_NAME.exec(ref.name);
  if (pl) {
    const p = ctx.state.planes.get(pl[1] as string);
    if (p) return { t: 'plane', origin: p.frame.origin, normal: normalize(p.frame.z) };
    unresolved.push({ path, ref, reason: 'missing' });
    return null;
  }
  const ax = AXIS_NAME.exec(ref.name) ?? POINT_NAME.exec(ref.name);
  if (ax) {
    const d = ctx.state.datums.get(ax[1] as string);
    const wanted = AXIS_NAME.test(ref.name) ? 'axis' : 'point';
    if (d?.kind === wanted) {
      return wanted === 'axis'
        ? { t: 'axis', origin: d.frame.origin, dir: normalize(d.frame.z), extent: [0, 0] }
        : { t: 'point', at: d.frame.origin };
    }
    unresolved.push({ path, ref, reason: 'missing' });
    return null;
  }
  if (ref.kind === 'body') {
    const b = ctx.state.bodies.get(ref.name);
    if (!b) {
      unresolved.push({ path, ref, reason: 'missing' });
      return null;
    }
    const bb = await core.boundsOf(b.shape);
    const c: Vec3 = bb
      ? ([0, 1, 2].map(
          (k) => ((bb.bbox.min[k] as number) + (bb.bbox.max[k] as number)) / 2,
        ) as Vec3)
      : [0, 0, 0];
    return { t: 'point', at: c };
  }
  const t = await resolveSub(core, ctx, ref, path, unresolved);
  if (!t) return null;
  return subGeometry(core, { shape: t.shape, kind: t.kind, index: t.index });
}

// ---------------------------------------------------------------------------------------------
// Hole instances
// ---------------------------------------------------------------------------------------------

interface InstanceFace {
  shape: number;
  index: number;
  name: string;
}

/** `F<copy>:inst<k>(N)` / `F<copy>:mirror(N)` (optionally split) → N. */
const COPY = /^F[0-9A-Za-z]+:(?:inst\d+|mirror)\((.*)\)(?:#\d+)?$/;

/**
 * The bore faces of every instance of hole feature `holeId` in the final bodies: its own
 * `F<hole>:hole(<point>):wall` faces and their pattern and mirror copies (`inst<k>(…)`,
 * `mirror(…)`, nested). Pieces of a split wall count once: the largest piece stands for the
 * instance. Ordered: the original instances first, then copies, by name (digit runs as numbers).
 */
async function holeInstances(
  core: EngineCore,
  ctx: WalkContext,
  holeId: Id,
): Promise<InstanceFace[]> {
  const wall = new RegExp(`^F${holeId}:hole\\((.*)\\):wall(?:#\\d+)?$`);
  const tag = `F${holeId}:hole(`;
  const best = new Map<string, { f: InstanceFace; depth: number; area: number }>();
  for (const b of ctx.state.bodies.values()) {
    if (b.meshOnly) continue;
    for (const n of primaryNaming(b.naming)) {
      if (n.kind !== 'face' || !n.name.includes(tag)) continue;
      let inner = n.name;
      let depth = 0;
      for (let m = COPY.exec(inner); m; m = COPY.exec(inner)) {
        inner = m[1] as string;
        depth++;
      }
      if (!wall.test(inner)) continue;
      const fp = await core.fingerprints(b.shape);
      const area = fp?.faces[n.index]?.area ?? 0;
      const key = baseName(n.name);
      const had = best.get(key);
      if (!had || area > had.area) {
        best.set(key, { f: { shape: b.shape, index: n.index, name: n.name }, depth, area });
      }
    }
  }
  return [...best.values()]
    .sort((x, y) => x.depth - y.depth || naturalCompare(x.f.name, y.f.name))
    .map((x) => x.f);
}

/** Instance faces as refs with their current fingerprints. */
async function instanceRefs(core: EngineCore, faces: InstanceFace[]): Promise<EntityRef[]> {
  const out: EntityRef[] = [];
  for (const f of faces) {
    const fp = await core.fingerprints(f.shape);
    const ref: EntityRef = { name: f.name, kind: 'face' };
    const print = fp ? fingerprintOf(fp, 'face', f.index) : undefined;
    if (print) ref.fingerprint = print;
    out.push(ref);
  }
  return out;
}

/** Name order with digit runs compared as numbers (`inst2` before `inst10`). */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const pa = a.match(re) ?? [];
  const pb = b.match(re) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i] as string;
    const y = pb[i] as string;
    if (x === y) continue;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    }
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}
