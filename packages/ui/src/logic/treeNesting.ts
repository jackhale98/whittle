/**
 * Feature-tree nesting (ADR-015): a view of the flat feature list, never a change to the document.
 *
 * A sketch that exactly one feature consumes is shown under that feature. A sketch several
 * features use, or none, stays top-level (the shared ones get a "used by N" badge). All of it is
 * derived from the features' persistent references, so nothing is stored.
 *
 * What counts as consuming a sketch `S`: any other non-sketch feature holding an entity reference
 * (profile regions, a revolve axis, an extrude's up-to target, edges, tools, body scopes, PMI
 * annotations ...) whose persistent name starts with `S<id>:` (naming.ts). A suppressed consumer
 * still consumes: suppressing must not pop the sketch out of the tree. A sketch placed on another
 * sketch (`on`) does not count: sketch features are never consumers, so nesting is one level deep.
 * Imports and primitives hold no sketch references. A consumer listed before its sketch (an
 * invalid document) never nests it.
 */

import type { Id } from '@wren-cad/contracts';

/** What the helper needs of a feature; a full `Feature` fits. */
export interface NestingFeature {
  id: Id;
  type: string;
}

export interface TreeNesting {
  /** Nested sketch id -> the feature it sits under. */
  parentOf: ReadonlyMap<Id, Id>;
  /** Feature id -> its nested sketch ids, in document order. */
  childrenOf: ReadonlyMap<Id, readonly Id[]>;
  /** Sketch id -> the features that consume it (document order). Unused sketches are absent. */
  consumers: ReadonlyMap<Id, readonly Id[]>;
}

const ENTITY_KINDS = new Set(['face', 'edge', 'vertex', 'region', 'body']);

/** Every persistent name held anywhere in a feature (duck-typed: an object with `name` and an entity `kind`). */
export function referencedNames(feature: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.name === 'string' && typeof o.kind === 'string' && ENTITY_KINDS.has(o.kind)) {
      out.push(o.name);
    }
    for (const x of Object.values(o)) walk(x);
  };
  walk(feature);
  return out;
}

const EMPTY: TreeNesting = { parentOf: new Map(), childrenOf: new Map(), consumers: new Map() };

/** Which sketch each feature consumes, and the resulting nesting. */
export function computeNesting(features: readonly NestingFeature[]): TreeNesting {
  const sketches = features.filter((f) => f.type === 'sketch');
  if (sketches.length === 0) return EMPTY;
  const consumers = new Map<Id, Id[]>();
  for (const f of features) {
    if (f.type === 'sketch') continue;
    const names = referencedNames(f);
    if (names.length === 0) continue;
    for (const s of sketches) {
      const tag = `S${s.id}:`;
      if (names.some((n) => n.startsWith(tag))) {
        const list = consumers.get(s.id);
        if (list) list.push(f.id);
        else consumers.set(s.id, [f.id]);
      }
    }
  }
  const index = new Map(features.map((f, i) => [f.id, i]));
  const parentOf = new Map<Id, Id>();
  const childrenOf = new Map<Id, Id[]>();
  for (const s of sketches) {
    const c = consumers.get(s.id);
    if (c?.length !== 1) continue;
    const parent = c[0] as Id;
    if ((index.get(parent) ?? -1) < (index.get(s.id) ?? 0)) continue;
    parentOf.set(s.id, parent);
    const kids = childrenOf.get(parent);
    if (kids) kids.push(s.id);
    else childrenOf.set(parent, [s.id]);
  }
  return { parentOf, childrenOf, consumers };
}

/** How many features use a sketch that stays top-level because several do (>= 2), else 0. */
export function sharedCount(nesting: TreeNesting, sketchId: Id): number {
  const n = nesting.consumers.get(sketchId)?.length ?? 0;
  return n >= 2 ? n : 0;
}

/** Top-level feature ids in display order (the nested sketches are folded into their feature). */
export function topLevel(features: readonly NestingFeature[], nesting: TreeNesting): Id[] {
  return features.filter((f) => !nesting.parentOf.has(f.id)).map((f) => f.id);
}

/**
 * Rollback positions (`rollbackIndex` values 0..n) the bar may stop at. It cannot stop between a
 * feature and a sketch nested under it: for a nested sketch at index s under a feature at index c,
 * the positions s < r <= c are not allowed. Rolling back above the feature rolls back both.
 */
export function allowedRollbacks(
  features: readonly NestingFeature[],
  nesting: TreeNesting,
): number[] {
  const n = features.length;
  const index = new Map(features.map((f, i) => [f.id, i]));
  const blocked = new Set<number>();
  for (const [sketch, parent] of nesting.parentOf) {
    const s = index.get(sketch);
    const c = index.get(parent);
    if (s === undefined || c === undefined) continue;
    for (let r = s + 1; r <= c; r++) blocked.add(r);
  }
  const out: number[] = [];
  for (let r = 0; r <= n; r++) if (!blocked.has(r)) out.push(r);
  return out;
}

/** The nearest allowed stop to `r`: `dir` 1 = at or after, -1 = at or before, 0 = closest. */
export function snapRollback(r: number, allowed: readonly number[], dir: -1 | 0 | 1 = 0): number {
  if (allowed.length === 0) return r;
  if (allowed.includes(r)) return r;
  const after = allowed.find((a) => a >= r);
  const before = [...allowed].reverse().find((a) => a <= r);
  if (dir === 1) return after ?? (before as number);
  if (dir === -1) return before ?? (after as number);
  if (after === undefined) return before as number;
  if (before === undefined) return after;
  return r - before <= after - r ? before : after;
}

/** One `moveFeature` of a reorder: the feature, its index before, and where it goes. */
export interface MoveStep {
  id: Id;
  from: number;
  toIndex: number;
}

/**
 * Moves the top-level feature `unitId` together with its nested sketches so that it becomes the
 * `to`th top-level item (0-based, in the list without it). Returns the `moveFeature` steps in an
 * order that keeps every intermediate document valid: sketches first when moving up, the feature
 * first when moving down; the block ends sketches-then-feature. Steps that would not move anything
 * are dropped; an empty result means nothing to do.
 *
 * The block lands right after the feature of the top-level item before it (or at the start), so
 * the item order the tree shows is exactly what the document order gives.
 */
export function planUnitMove(
  features: readonly NestingFeature[],
  nesting: TreeNesting,
  unitId: Id,
  to: number,
): MoveStep[] {
  const ids = features.map((f) => f.id);
  const units = topLevel(features, nesting);
  const members = [...(nesting.childrenOf.get(unitId) ?? []), unitId];
  const memberSet = new Set(members);
  const others = ids.filter((id) => !memberSet.has(id));
  const otherUnits = units.filter((u) => u !== unitId);
  const q = Math.max(0, Math.min(otherUnits.length, to));
  let ref: Id | undefined;
  if (q === 0) ref = others[0];
  else {
    const prev = otherUnits[q - 1] as Id;
    ref = others[others.indexOf(prev) + 1];
  }

  const cur = ids.slice();
  const steps: MoveStep[] = [];
  const parentBeforeRef = ref === undefined || cur.indexOf(unitId) < cur.indexOf(ref);
  const order = parentBeforeRef ? members.slice().reverse() : members;
  let anchor = ref;
  for (const m of order) {
    const from = cur.indexOf(m);
    cur.splice(from, 1);
    const at = anchor === undefined ? cur.length : cur.indexOf(anchor);
    cur.splice(at, 0, m);
    if (at !== from) steps.push({ id: m, from, toIndex: at });
    if (parentBeforeRef) anchor = m;
  }
  return steps;
}
