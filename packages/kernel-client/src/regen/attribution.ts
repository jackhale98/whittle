/**
 * Cause attribution (`AttentionCause`, cause.ts): the walk record of each feature and the
 * causes attached to failed features and unresolved references, plus the field labels
 * used in messages.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { AttentionCause, Feature, Id } from '@wren-cad/contracts';
import { entityRefs } from '@wren-cad/document';
import {
  type CauseEnv,
  changeCause,
  nameTags,
  refIdentity,
  stillHolds,
  structuralCause,
  upstreamCause,
  valueAt,
  type WalkContainer,
  type WalkEntry,
} from './cause';
import { stableStringify } from './hash';
import { definition } from './helpers';
import type { EntryResult, WalkContext } from './state';
import type { RegenFeatureStatus } from './types';

export const FIELD_LABELS: Record<string, string> = {
  '/dx': 'Length X',
  '/dy': 'Length Y',
  '/dz': 'Length Z',
  '/radius': 'Radius',
  '/height': 'Height',
  '/end/depth': 'Depth',
  '/draft': 'Draft angle',
  '/angle': 'Angle',
  '/mode/distance': 'Distance',
  '/mode/angle': 'Angle',
  '/distance': 'Distance',
  '/definition/distance': 'Offset',
  '/definition/angle': 'Angle',
  '/definition/at/t': 'Position along the curve',
  '/definition/t': 'Position along the edge',
  '/definition/x': 'X',
  '/definition/y': 'Y',
  '/definition/z': 'Z',
  '/thickness': 'Thickness',
  '/count': 'Count',
  '/spacing': 'Spacing',
  '/second/count': 'Second direction count',
  '/second/spacing': 'Second direction spacing',
  '/diameter': 'Diameter',
  '/tipAngle': 'Drill point angle',
  '/counterbore/diameter': 'Counterbore diameter',
  '/counterbore/depth': 'Counterbore depth',
  '/countersink/diameter': 'Countersink diameter',
  '/countersink/angle': 'Countersink angle',
  '/thread/depth': 'Thread depth',
  '/length': 'Thread length',
};

const DIMENSION_LABELS: Record<string, string> = {
  distance: 'Distance',
  hDistance: 'Horizontal distance',
  vDistance: 'Vertical distance',
  length: 'Length',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
};

/** The walk record of a feature about to run: its own definition, values and reference tags. */
export function walkEntry(
  ctx: WalkContext,
  f: Feature,
  values: Record<string, number>,
  exprErrors: [string, unknown][],
  copied: Id[],
): WalkEntry {
  const own: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) if (!k.startsWith('/annotations/')) own[k] = v;
  const deps: Id[] = [];
  const dep = (id: Id) => {
    if (id !== f.id && ctx.walk.byId.has(id) && !deps.includes(id)) deps.push(id);
  };
  for (const r of entityRefs(f)) for (const id of nameTags(r.name, r.kind).all) dep(id);
  for (const id of copied) dep(id);
  const rec: WalkEntry = {
    id: f.id,
    state: 'ok',
    def: stableStringify(definition(f)),
    values: own,
    planned: false,
    deps,
  };
  if (exprErrors.length > 0) rec.valueErrors = exprErrors.map(([p]) => p);
  return rec;
}

function causeEnv(ctx: WalkContext): CauseEnv {
  return {
    part: ctx.part,
    index: ctx.index,
    walk: ctx.walk,
    prev: ctx.pc.walk,
    label: causeLabel,
  };
}

/**
 * `AttentionCause` for a finished feature's unresolved refs and its status (cause.ts rules):
 * structural from the name, else this regen's change if the same stored ref resolved last
 * regen, else the cause it already had. Blocked causes are set by `runFeature`.
 */
export function attachCauses(
  ctx: WalkContext,
  f: Feature,
  status: RegenFeatureStatus,
  rec: WalkEntry,
): void {
  if (status.state === 'ok' || status.state === 'blocked') return;
  const env = causeEnv(ctx);
  const prev = ctx.pc.walk?.byId.get(f.id);
  // Entities sharing a linked source share one name: compute its change once.
  const changed = new Map<string, AttentionCause | null>();
  for (const u of status.unresolved ?? []) {
    const stored = refIdentity(valueAt(f, u.path));
    const same =
      prev !== undefined &&
      stored !== undefined &&
      refIdentity(valueAt(prev.def, u.path)) === stored;
    let cause = structuralCause(env, f.id, u.ref.name, u.ref.kind);
    if (!cause && same && prev?.planned) {
      const k = `${u.ref.kind}|${u.ref.name}`;
      if (!changed.has(k)) changed.set(k, changeCause(env, f.id, u.ref.name, u.ref.kind));
      cause = changed.get(k) ?? null;
    } else if (!cause && same) {
      const was = prev?.unresolved?.find((x) => x.path === u.path)?.cause;
      if (was && stillHolds(env, f.id, was)) cause = was;
    }
    if (cause) u.cause = cause;
  }
  if (status.state === 'needsAttention') {
    const first = status.unresolved?.find((u) => u.cause)?.cause;
    if (first) status.cause = first;
    return;
  }
  if (status.state !== 'error' || status.cause || !prev) return;
  const ownSame =
    prev.def === rec.def && stableStringify(prev.values) === stableStringify(rec.values);
  if (prev.state === 'ok') {
    const c = upstreamCause(env, rec);
    if (c) status.cause = c;
  } else if (prev.state === 'error' && prev.cause && ownSame && stillHolds(env, f.id, prev.cause)) {
    status.cause = prev.cause;
  }
}

/** The containers an ok result sets (cause.ts touchers) and the bodies it removes. */
export function walkDelta(r: Extract<EntryResult, { ok: true }>): NonNullable<WalkEntry['delta']> {
  const set: WalkContainer[] = r.set.map((b) => ({ id: b.id, naming: b.naming }));
  if (r.sketch) set.push({ id: `sketch:${r.sketch.id}`, naming: r.sketch.naming });
  if (r.plane) set.push({ id: `plane:${r.plane.id}`, naming: r.plane.naming });
  if (r.datum) {
    const d = r.datum;
    set.push({
      id: `datum:${d.id}`,
      naming: [
        { name: `F${d.id}:${d.kind}`, kind: d.kind === 'axis' ? 'edge' : 'vertex', index: 0 },
      ],
    });
  }
  return { set, remove: [...r.remove] };
}

export function fieldLabel(f: Feature, pointer: string): string {
  const m = /^\/constraints\/(\d+)\/value$/.exec(pointer);
  if (m && f.type === 'sketch') {
    const c = f.constraints[Number(m[1])];
    return c ? `Sketch dimension ${c.id} (${c.kind})` : 'Sketch dimension';
  }
  return FIELD_LABELS[pointer] ?? pointer;
}

/** `AttentionCause.detail` labels: sketch dimensions by kind, never by constraint id. */
function causeLabel(f: Feature, pointer: string): string {
  const m = /^\/constraints\/(\d+)\/value$/.exec(pointer);
  if (m && f.type === 'sketch') {
    const c = f.constraints[Number(m[1])];
    return (c && DIMENSION_LABELS[c.kind]) ?? 'Dimension';
  }
  return fieldLabel(f, pointer);
}
