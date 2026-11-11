/**
 * Annotation resolution after the walk (M4, ADR-090, proposal §2.7): every `Part.annotations`
 * entry is resolved against the part's **final** state in the regenerated slot (so in that slot's
 * configuration: the engine is handed the configuration-resolved document, as for features).
 *
 * Rules, the same as for feature refs (PLAN §7.3, ADR-078): exact name, then merge alias
 * (`merged`, never healed), then the name family with containment, then fingerprints for weak
 * (imported) names; otherwise unresolved. Never re-attached to a guessed entity. `source`,
 * `appliesTo` and datum ids are resolved too (`/source`, `/appliesTo`, `/datums/i/datums/j`).
 * M4 gate (ADR-090 amendment "second gate round, kernel-client resolution"): sketch points and
 * the sketch origin and axes come from the sketch's final state (`sketchRef`); faces measured as
 * planes resolve plane-like; a face name that no longer exists may resolve to its recorded
 * successor (`resolveSuccessor`, reported as `merged`); `count` for `text.count`.
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
  AnchorAnswer,
  AnchorQuery,
  Annotation,
  AnnotationAnchor,
  AnnotationResolution,
  AnnotationSource,
  AttentionCause,
  DimensionText,
  EntityRef,
  Feature,
  GrownRef,
  HoleFeature,
  Id,
  KernelError,
  MergedRef,
  NamedDimension,
  RefPoint,
  UnresolvedRef,
  Vec3,
} from '@wren-cad/contracts';
import { SKETCH_ORIGIN, SKETCH_X_AXIS, SKETCH_Y_AXIS } from '@wren-cad/contracts';
import {
  evaluateFeatureValues,
  expressionEngine,
  exprFields,
  holeRow,
  resolveHoleSize,
  scopeOf,
} from '@wren-cad/document';
import {
  type AxisGeo,
  anchorOf,
  measureAnnotation,
  type RefGeo,
  rimAnchor,
  subGeometry,
} from './annotation-geometry';
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
import {
  add,
  dot,
  frameY,
  normalize,
  ORIGIN_AXES,
  ORIGIN_PLANES,
  scale,
  sub,
  toWorld,
} from './geometry';
import { hashKey } from './hash';
import { kerr } from './helpers';
import {
  AXIS_NAME,
  fingerprintOf,
  PLANE_NAME,
  POINT_NAME,
  resolveSub,
  resolveSuccessor,
} from './refs';
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
  const targets: RefTarget[] = [];
  for (let i = 0; i < a.refs.length; i++) {
    const ref = a.refs[i] as EntityRef;
    const target: RefTarget = {};
    const use = { kind: a.kind, at: at(i) };
    geos.push(await refGeometry(core, ctx, ref, `/refs/${i}`, unresolved, use, target));
    targets.push(target);
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
      res.anchors.push(g ? await anchorFor(core, ctx, g, at(i), a.kind) : null);
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
    const first = instances[0];
    if (a.kind === 'holeCallout' && first && sourceFeature) {
      const g = await subGeometry(core, { ...first, kind: 'face' });
      if (sourceFeature.type === 'hole' && g?.t === 'axis' && g.radius !== undefined) {
        measured = 2 * g.radius;
      }
      // ADR-092 proposal 1: a callout without refs of its own is anchored by the first instance's
      // rim at the entry face, so its leader has a circle to point at.
      if (a.refs.length === 0 && g?.t === 'axis') {
        g.name = first.name;
        res.anchors = [await calloutAnchor(core, ctx, g)];
      }
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
  // `DimensionText.count`: only when asked, and like the value only when ok.
  if (wantsCount(a)) {
    const n = a.refs.length > 0 ? instanceCount(ctx, targets[0]) : instances?.length;
    if (n !== undefined && n > 0) res.count = n;
  }
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
      // `hDistance` / `vDistance` are signed (b − a, contracts sketch.ts); a dimension shows the
      // distance (`-length/2` from the origin to a corner is 60 mm on the drawing).
      if (out.value !== undefined && (c.kind === 'hDistance' || c.kind === 'vDistance')) {
        out.value = Math.abs(out.value);
      }
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

/** Annotation kinds that measure a face ref (`at: 'self'`) as its plane. */
const PLANE_KINDS = new Set<Annotation['kind']>(['linear', 'ordinate', 'angle']);

/** How a ref is used, for plane-like resolution: the annotation kind and the point qualifier. */
interface RefUse {
  kind?: Annotation['kind'] | undefined;
  at: RefPoint;
}

/** What `refGeometry` resolved a ref to, besides its geometry (for `count`). */
interface RefTarget {
  /** Current persistent name of the body sub-shape (absent for sketch, plane and datum refs). */
  name?: string;
  kind?: 'face' | 'edge' | 'vertex';
}

/**
 * Resolves one annotation ref to its geometry: origin planes, axes and point by name, construction
 * planes, axes and points (`F…:plane` / `:axis` / `:point`) from the walk's state, bodies by id,
 * sketch points and the sketch origin and axes from the sketch's final state (`sketchRef`), and
 * every other face, edge, vertex and sketch entity through `resolveSub` (the feature rules).
 *
 * A face measured as its plane (`PLANE_KINDS`, `at: 'self'`) resolves plane-like: pieces of a
 * split face that are all coplanar are one plane (resolve.ts), reported as `rebound`. A face name
 * that no longer exists may resolve to its recorded successor (`resolveSuccessor`: a Boolean's
 * `face(N)`, a Shell's `rim(N)`), reported as `merged`.
 */
async function refGeometry(
  core: EngineCore,
  ctx: WalkContext,
  ref: EntityRef,
  path: string,
  unresolved: RegenUnresolvedRef[],
  use: RefUse = { at: 'self' },
  target: RefTarget = {},
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
  const sketch = await sketchRef(core, ctx, ref);
  if (sketch) return sketch;
  const planeLike =
    ref.kind === 'face' && use.at === 'self' && use.kind !== undefined && PLANE_KINDS.has(use.kind);
  const missed: RegenUnresolvedRef[] = [];
  let t = await resolveSub(core, ctx, ref, path, missed, planeLike);
  if (!t && missed.length === 1 && missed[0]?.reason === 'missing') {
    t = await resolveSuccessor(core, ctx, ref, path, planeLike);
  }
  if (!t) {
    unresolved.push(...missed);
    return null;
  }
  if (ctx.state.bodies.has(t.owner)) {
    target.name = t.name;
    target.kind = t.kind;
  }
  const g = await subGeometry(core, { shape: t.shape, kind: t.kind, index: t.index });
  if (g?.t === 'axis') g.name = t.name;
  return g;
}

// ---------------------------------------------------------------------------------------------
// Sketch references: points, the origin and the axes, from the sketch's final state
// ---------------------------------------------------------------------------------------------

/** `S<sketch>:p(<id>)` / `S<sketch>:e(<id>)`. */
const SKETCH_ENTITY = /^S([0-9A-Za-z]+):([pe])\((.+)\)$/;

/**
 * Sketch geometry that is the sketch's own and needs no kernel topology, from the sketch's final
 * (solved) state in this walk: the origin `S…:p(@origin)` (the frame's origin), the axes
 * `S…:e(@x)` / `S…:e(@y)` (lines through it along the frame's x and y) and points `S…:p(<id>)`
 * (stored and construction points: the solved entity on the frame). These are exact names, not
 * guesses; a sketch point is not read from the kernel's vertices, where coincident points (a
 * construction origin and a circle centre on it) share one location and so one name family.
 *
 * Null when the sketch is not in the final state (deleted, suppressed, failed or after the
 * rollback bar: `resolveSub` then reports it missing and cause.ts says why), or for any other
 * entity (curves resolve through the kernel's names).
 *
 * An axis line spans the part along it: the projections onto the axis of the bodies' bounding
 * boxes, the sketch's points and the origin (at least ±1 mm), so a view can draw it as a centre
 * line and pick it; only its direction and position measure.
 */
async function sketchRef(
  core: EngineCore,
  ctx: WalkContext,
  ref: EntityRef,
): Promise<RefGeo | null> {
  const m = SKETCH_ENTITY.exec(ref.name);
  if (!m) return null;
  const s = ctx.state.sketches.get(m[1] as string);
  if (!s) return null;
  const id = m[3] as string;
  const frame = s.frame;
  if (m[2] === 'p') {
    if (id === SKETCH_ORIGIN) return { t: 'point', at: toWorld(frame, 0, 0) };
    const e = s.entities.find((x) => x.id === id);
    return e?.kind === 'point' ? { t: 'point', at: toWorld(frame, e.x, e.y) } : null;
  }
  if (id !== SKETCH_X_AXIS && id !== SKETCH_Y_AXIS) return null;
  const o = toWorld(frame, 0, 0);
  const dir = normalize(id === SKETCH_X_AXIS ? frame.x : frameY(frame));
  let lo = -1;
  let hi = 1;
  const reach = (p: Vec3) => {
    const t = dot(sub(p, o), dir);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  };
  for (const e of s.entities) if (e.kind === 'point') reach(toWorld(frame, e.x, e.y));
  for (const b of ctx.state.bodies.values()) {
    if (b.meshOnly) continue;
    const bb = await core.boundsOf(b.shape);
    if (!bb) continue;
    const { min, max } = bb.bbox;
    for (const x of [min[0], max[0]])
      for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) reach([x, y, z]);
  }
  return { t: 'line', a: add(o, scale(dir, lo)), b: add(o, scale(dir, hi)) };
}

// ---------------------------------------------------------------------------------------------
// Anchors by kind: rims of round faces, hole callouts
// ---------------------------------------------------------------------------------------------

/** Kinds whose ref is a size: a round face is anchored by its rim circle, not its axis. */
const SIZE_KINDS = new Set<Annotation['kind']>(['radius', 'diameter']);

/**
 * The anchor of one resolved ref for an annotation of `kind`. A cylindrical face (`self`) of a
 * radius or diameter is its rim circle, as the drawing dimensions circles: a hole wall's at its
 * entry, any other at the far end of its canonical axis. A hole callout's ref on a hole wall is
 * the callout's rim (`calloutAnchor`). Everything else is `anchorOf`.
 */
async function anchorFor(
  core: EngineCore,
  ctx: WalkContext,
  g: RefGeo,
  at: RefPoint,
  kind: Annotation['kind'] | undefined,
): Promise<AnnotationAnchor> {
  if (g.t === 'axis' && at === 'self' && g.target && kind !== undefined) {
    if (kind === 'holeCallout' && g.radius !== undefined) return calloutAnchor(core, ctx, g);
    if (SIZE_KINDS.has(kind) && g.radius !== undefined) {
      const hole = holeWallOf(ctx, g.name);
      const entry = hole ? await wallEntry(core, ctx, g, hole) : null;
      const rim = await rimAnchor(core, g, entry ?? 1, entry !== null);
      if (rim) return rim;
    }
  }
  return anchorOf(core, g, at);
}

/**
 * A hole callout's anchor: the rim of the first instance at the hole's entry face. That is the
 * counterbore's rim for a counterbored hole, the countersink's outer rim for a countersunk one,
 * else the bore's; its normal points out of the hole. A thread's callout (no entry face in the
 * model) is the rim at the far end of its face's canonical axis. Without a radius (a cone):
 * the axis.
 */
async function calloutAnchor(
  core: EngineCore,
  ctx: WalkContext,
  wall: AxisGeo,
): Promise<AnnotationAnchor> {
  const hole = holeWallOf(ctx, wall.name);
  const entry = hole ? await wallEntry(core, ctx, wall, hole) : null;
  if (hole && entry !== null && wall.target) {
    // The outermost rim at the entry: counterbore wall, else countersink cone, else the bore.
    for (const suffix of ['cbore.wall', 'csink']) {
      const s = siblingFaces(ctx, wall, hole, suffix)[0];
      if (s === undefined) continue;
      const g = await subGeometry(core, { shape: wall.target.shape, kind: 'face', index: s });
      if (g?.t !== 'axis') continue;
      const end = dot(g.dir, wall.dir) >= 0 ? entry : entry === 0 ? 1 : 0;
      const rim = await rimAnchor(core, g, end, true);
      if (rim) return rim;
    }
  }
  return (
    (await rimAnchor(core, wall, entry ?? 1, entry !== null)) ??
    (await anchorOf(core, wall, 'self'))
  );
}

/** A hole wall's hole: its feature and the wall's name without copies and split suffix. */
interface HoleWall {
  feature: HoleFeature;
  /** `F<hole>:hole(<point>)`, the prefix every face of this instance shares. */
  stem: string;
}

const WALL = /^(F([0-9A-Za-z]+):hole\(.*\)):wall(?:#\d+)?$/;

/** The hole whose wall (an instance or a pattern or mirror copy of one) `name` is. */
function holeWallOf(ctx: WalkContext, name: string | undefined): HoleWall | null {
  if (!name) return null;
  let inner = name;
  for (let m = COPY.exec(inner); m; m = COPY.exec(inner)) inner = m[1] as string;
  const w = WALL.exec(inner);
  if (!w) return null;
  const i = ctx.index.get(w[2] as string);
  const f = i === undefined ? undefined : ctx.part.features[i];
  return f?.type === 'hole' ? { feature: f, stem: w[1] as string } : null;
}

/**
 * Faces of the same hole instance as `wall` (same copy wrappers) with another suffix (`bottom`,
 * `tip`, `cbore.wall`, `cbore.floor`, `csink`), by the body's primary names; split pieces too.
 */
function siblingFaces(ctx: WalkContext, wall: AxisGeo, hole: HoleWall, suffix: string): number[] {
  const t = wall.target;
  const name = wall.name;
  if (!t || !name) return [];
  const body = [...ctx.state.bodies.values()].find((b) => b.shape === t.shape);
  if (!body) return [];
  const strip = (n: string) => n.replace(/#\d+$/, '');
  const own = strip(name);
  const at = own.lastIndexOf(`${hole.stem}:wall`);
  if (at < 0) return [];
  const want = `${own.slice(0, at)}${hole.stem}:${suffix}${own.slice(at + hole.stem.length + 5)}`;
  return primaryNaming(body.naming)
    .filter((n) => n.kind === 'face' && strip(n.name) === want)
    .map((n) => n.index);
}

/**
 * Which end of a hole wall (0 or 1 along its canonical axis) is towards the hole's entry face.
 * Evidence, in order: the instance's own faces (a blind hole's bottom or tip is at the far end; a
 * counterbore floor or a countersink is at the entry), then the hole's placement face, whose
 * outward normal points out of the entry (exact for the hole's own instances and translated
 * copies). Null when there is none: the caller then uses a fixed end and says nothing about the
 * entry.
 */
async function wallEntry(
  core: EngineCore,
  ctx: WalkContext,
  wall: AxisGeo,
  hole: HoleWall,
): Promise<0 | 1 | null> {
  const t = wall.target;
  if (!t) return null;
  const fp = await core.fingerprints(t.shape);
  const station = (index: number) => {
    const c = fp?.faces[index]?.centroid;
    return c ? dot(sub(c, wall.origin), wall.dir) : null;
  };
  const [lo, hi] = wall.extent;
  for (const [suffix, atEntry] of [
    ['bottom', false],
    ['tip', false],
    ['cbore.floor', true],
    ['csink', true],
  ] as const) {
    const s = siblingFaces(ctx, wall, hole, suffix)[0];
    const at = s === undefined ? null : station(s);
    if (at === null) continue;
    const nearHi = Math.abs(at - hi) < Math.abs(at - lo);
    return nearHi === atEntry ? 1 : 0;
  }
  // The placement face, resolved as the hole feature resolves it (its reports stay out).
  const mine = ctx.current;
  ctx.current = { featureId: hole.feature.id, rebound: [], merged: [], grown: [] };
  const face = await resolveSub(core, ctx, hole.feature.face, '/face', []);
  ctx.current = mine;
  const n = face ? (await core.fingerprints(face.shape))?.faces[face.index]?.normal : undefined;
  if (!n) return null;
  const s = dot(normalize(n), wall.dir);
  return Math.abs(s) < 1e-9 ? null : s > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Anchor queries (ADR-092 proposal 2)
// ---------------------------------------------------------------------------------------------

// `AnchorQuery` / `AnchorAnswer` are contract types (modeling.ts).

/** The consumer id of anchor queries (after every feature, like an annotation). */
const QUERY = 'A:anchors';

/**
 * Anchors of arbitrary refs against a regen's final state (`final`: that regen's walk context),
 * resolved exactly as annotation refs are: exact name, merge alias, name family, fingerprints for
 * weak names; otherwise unresolved with its structural cause (deleted, suppressed, failed). It
 * reads the slot's state and never writes it: the `lastKnown` and `grown` memories are copies.
 */
export async function queryAnchors(
  core: EngineCore,
  final: WalkContext,
  queries: readonly AnchorQuery[],
): Promise<AnchorAnswer[]> {
  const pc = { ...final.pc, lastResolved: new Map(), absorbed: new Map(final.pc.absorbed) };
  const ctx: WalkContext = { ...final, pc };
  const env: CauseEnv = {
    part: ctx.part,
    index: ctx.index,
    walk: ctx.walk,
    prev: null,
    label: causeLabel,
  };
  const out: AnchorAnswer[] = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i] as AnchorQuery;
    ctx.current = { featureId: QUERY, rebound: [], merged: [], grown: [] };
    const unresolved: RegenUnresolvedRef[] = [];
    const use = { kind: q.annotationKind, at: q.at ?? 'self' };
    const g = await refGeometry(core, ctx, q.ref, `/${i}`, unresolved, use);
    const answer: AnchorAnswer = {
      anchor: g ? await anchorFor(core, ctx, g, q.at ?? 'self', q.annotationKind) : null,
    };
    const u = unresolved[0];
    if (u) {
      const cause = structuralCause(env, QUERY, u.ref.name, u.ref.kind);
      answer.unresolved = cause ? { ...u, cause } : u;
    }
    const [merged] = ctx.current.merged;
    const [grown] = ctx.current.grown;
    const [rebound] = ctx.current.rebound;
    if (merged) answer.merged = merged;
    if (grown) answer.grown = grown;
    if (rebound) answer.rebound = rebound;
    out.push(answer);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Instance counts (`AnnotationResolution.count`)
// ---------------------------------------------------------------------------------------------

/** Does the annotation show an automatic `N×` (`DimensionText.count`)? */
function wantsCount(a: Annotation): boolean {
  const text: unknown = 'text' in a ? a.text : undefined;
  return typeof text === 'object' && text !== null && (text as DimensionText).count === true;
}

/**
 * The number of instances of the feature that made a resolved ref, pattern and mirror copies
 * included: the distinct sub-shapes of the same kind in the final bodies that are the same
 * sub-shape of an instance (`instanceKey`). Split pieces count once. A hole's instances are its
 * points (every `F<hole>:hole(<point>)` is one), times its copies. What is counted is what exists:
 * a skipped pattern instance, or a copy that a later feature removed, is not an instance. A ref to
 * a sketch, plane or datum is one instance.
 */
function instanceCount(ctx: WalkContext, target: RefTarget | undefined): number | undefined {
  if (!target) return undefined;
  const { name, kind } = target;
  if (name === undefined || kind === undefined) return 1;
  const key = instanceKey(name);
  const seen = new Set<string>();
  for (const b of ctx.state.bodies.values()) {
    if (b.meshOnly) continue;
    for (const n of primaryNaming(b.naming)) {
      if (n.kind !== kind) continue;
      const own = n.name.replace(SPLIT_SUFFIX, '');
      if (!seen.has(own) && instanceKey(n.name) === key) seen.add(own);
    }
  }
  return Math.max(1, seen.size);
}

const SPLIT_SUFFIX = /#\d+/g;
/** A copy wrapper's opening: `F<copy>:inst<k>(` or `F<copy>:mirror(`. */
const COPY_OPEN = /(?<![0-9A-Za-z])F[0-9A-Za-z]+:(?:inst\d+|mirror)\(/;
/** A hole instance's opening: `F<hole>:hole(` (its argument is the point's name). */
const HOLE_OPEN = /(?<![0-9A-Za-z])F[0-9A-Za-z]+:hole\((?!\*\))/;

/** Index of the parenthesis closing the one at `open`, or -1. */
function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * What every instance of one sub-shape has in common: its name without split suffixes, with every
 * copy wrapper (`F<c>:inst<k>(N)`, `F<c>:mirror(N)`, at any depth) replaced by `N`, every hole
 * point replaced by `*`, and the components of an `edge(…)` / `vertex(…)` name sorted.
 */
export function instanceKey(name: string): string {
  let s = name.replace(SPLIT_SUFFIX, '');
  for (let m = COPY_OPEN.exec(s); m; m = COPY_OPEN.exec(s)) {
    const open = m.index + m[0].length - 1;
    const close = closing(s, open);
    if (close < 0) break;
    s = s.slice(0, m.index) + s.slice(open + 1, close) + s.slice(close + 1);
  }
  for (let m = HOLE_OPEN.exec(s); m; m = HOLE_OPEN.exec(s)) {
    const open = m.index + m[0].length - 1;
    const close = closing(s, open);
    if (close < 0) break;
    s = `${s.slice(0, open + 1)}*${s.slice(close)}`;
  }
  const top = /^(edge|vertex)\((.*)\)$/.exec(s);
  if (!top) return s;
  const inner = top[2] as string;
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') depth++;
    else if (inner[i] === ')') depth--;
    else if (inner[i] === '|' && depth === 0) {
      parts.push(inner.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(inner.slice(from));
  return `${top[1]}(${parts.sort().join('|')})`;
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
