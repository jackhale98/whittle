// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Three-way structural merge of Whittle documents, keyed by stable id (PLAN §8A.3, ADR-020 item
 * 5). This replaces Mycelium's line-based text merge: Whittle merges the parsed document.
 *
 * Rules:
 *  - Arrays of identified items (`tree.ts` COLLECTIONS) merge as id-keyed maps plus an order.
 *    Every other array is a leaf.
 *  - A value only one side changed takes that side. Both sides changing the same leaf
 *    differently is `bothModified`; a change against a delete is `modifiedDeleted`; the same id
 *    added differently is `bothAdded`. The merged document holds "ours" at every conflict.
 *  - Order: the relative order of items present in all three versions is taken from the side
 *    that reordered them; two different reorders are an `order` conflict. Items only some
 *    versions have are woven in after the nearest preceding common item of the version that has
 *    them; two runs inserted at the same place are ordered by their first id (ULIDs: oldest
 *    first), so the result doesn't depend on which side is "ours".
 *  - Objects whose union variant (`type`, `kind`, `shape`, a material's `libraryId`) differs
 *    between versions, and entity references, merge whole, so the result stays schema-valid.
 *  - `meta.modified` takes the later time and `meta.created` the earlier; `meta.app` follows the
 *    later edit. They never conflict.
 *  - `Part.rollbackIndex` merges as "the bar sits before feature X" (an id), not as a number, so
 *    features added on both sides stay rolled forward.
 *  - Two parameters can't share a name: a name only "theirs" introduced that clashes with one in
 *    the merge is a conflict on theirs' parameter.
 */

import type {
  DocMerger,
  MergeConflict,
  MergeConflictKind,
  MergeResolution,
  MergeResult,
  Param,
  WhittleDoc,
} from '@whittle/contracts';
import { validateDoc } from '@whittle/document';
import { subjectAt } from './labels';
import {
  barIdOf,
  barIndex,
  byId,
  equal,
  fromPointer,
  type Identified,
  idsOf,
  isAtomicObject,
  isCollectionPath,
  isObj,
  type Obj,
  type Segs,
  toPointer,
} from './tree';

type Choice = { take: 'ours' | 'theirs' | 'base' } | { value: unknown };

interface Sides {
  base: WhittleDoc;
  ours: WhittleDoc;
  theirs: WhittleDoc;
}

/** The inputs of each result, so `resolve` can re-run the merge with the user's choices. */
const CONTEXT = new WeakMap<MergeResult, Sides>();

export class MergeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeResolutionError';
  }
}

export function conflictId(kind: MergeConflictKind, segs: Segs): string {
  return `${kind}:${toPointer(segs)}`;
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

class MergeRun {
  readonly conflicts: MergeConflict[] = [];
  autoMerged = 0;

  constructor(
    private readonly sides: Sides,
    private readonly choices: ReadonlyMap<string, Choice>,
  ) {}

  run(): WhittleDoc {
    const { base, ours, theirs } = this.sides;
    // A copy: the walk returns the inputs' own objects where nothing changed.
    const doc = clone(this.node([], base, ours, theirs)) as WhittleDoc;
    this.paramNames(doc);
    return doc;
  }

  /** Records a conflict and returns the user's choice for it, if `resolve` is re-running. */
  private choose(
    kind: MergeConflictKind,
    segs: Segs,
    values: { base?: unknown; ours?: unknown; theirs?: unknown },
  ): Choice | undefined {
    const id = conflictId(kind, segs);
    const { base, ours, theirs } = this.sides;
    const c: MergeConflict = {
      id,
      kind,
      path: toPointer(segs),
      subject: subjectAt(segs, [ours, theirs, base]),
    };
    if (values.base !== undefined) c.base = clone(values.base);
    if (values.ours !== undefined) c.ours = clone(values.ours);
    if (values.theirs !== undefined) c.theirs = clone(values.theirs);
    this.conflicts.push(c);
    return this.choices.get(id);
  }

  private pick(choice: Choice | undefined, b: unknown, o: unknown, t: unknown): unknown {
    if (choice === undefined) return o;
    if ('value' in choice) return clone(choice.value);
    return choice.take === 'theirs' ? t : choice.take === 'base' ? b : o;
  }

  private node(segs: Segs, b: unknown, o: unknown, t: unknown): unknown {
    if (equal(o, t)) return o;
    if (equal(b, o)) {
      this.autoMerged++;
      return t;
    }
    if (equal(b, t)) return o;
    // Both sides changed this value, differently.
    if (segs.length === 2 && segs[0] === 'meta') {
      const special = this.meta(segs[1] as string, o, t);
      if (special !== undefined) return special;
    }
    const listy = (v: unknown) => v === undefined || Array.isArray(v);
    if (isCollectionPath(segs) && listy(b) && listy(o) && listy(t)) {
      const list = this.collection(
        segs,
        (b ?? []) as unknown[],
        (o ?? []) as unknown[],
        (t ?? []) as unknown[],
      );
      if (list.length > 0) return list;
      const [pb, po, pt] = [b !== undefined, o !== undefined, t !== undefined];
      const present = po === pt ? po : pb === po ? pt : po;
      return present ? [] : undefined;
    }
    if (isObj(b) && isObj(o) && isObj(t) && !isAtomicObject(segs, b, o, t)) {
      return this.object(segs, b, o, t);
    }
    const kind: MergeConflictKind =
      b === undefined
        ? 'bothAdded'
        : o === undefined || t === undefined
          ? 'modifiedDeleted'
          : 'bothModified';
    return this.pick(this.choose(kind, segs, { base: b, ours: o, theirs: t }), b, o, t);
  }

  /** Bookkeeping fields that never conflict. */
  private meta(key: string, o: unknown, t: unknown): unknown {
    if (typeof o !== 'string' || typeof t !== 'string') return undefined;
    if (key === 'modified' || key === 'created') {
      const later = t > o;
      const takeTheirs = key === 'modified' ? later : !later;
      if (takeTheirs) this.autoMerged++;
      return takeTheirs ? t : o;
    }
    if (key === 'app') {
      const om = this.sides.ours.meta.modified;
      const tm = this.sides.theirs.meta.modified;
      const takeTheirs = tm > om || (tm === om && t > o);
      return takeTheirs ? t : o;
    }
    return undefined;
  }

  private object(segs: Segs, b: Obj, o: Obj, t: Obj): Obj {
    const isPart = segs.length === 2 && segs[0] === 'parts';
    const keys = new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)]);
    const out: Obj = {};
    for (const k of [...keys].sort()) {
      if (isPart && k === 'rollbackIndex') continue;
      const v = this.node([...segs, k], b[k], o[k], t[k]);
      if (v !== undefined) out[k] = v;
    }
    if (isPart)
      out.rollbackIndex = this.rollback(segs, b, o, t, (out.features ?? []) as Identified[]);
    return out;
  }

  /** The rollback bar as "before feature X", mapped back to an index in the merged features. */
  private rollback(segs: Segs, b: Obj, o: Obj, t: Obj, features: Identified[]): number {
    const [bb, ob, tb] = [barIdOf(b), barIdOf(o), barIdOf(t)];
    const order = (side: Obj) => idsOf(side.features);
    const at = (bar: string | null, first: Obj) =>
      barIndex(features, bar, [order(first), order(b), order(o), order(t)]);
    if (ob === tb) return at(ob, o);
    if (bb === ob) {
      this.autoMerged++;
      return at(tb, t);
    }
    if (bb === tb) return at(ob, o);
    const choice = this.choose('bothModified', [...segs, 'rollbackIndex'], {
      base: b.rollbackIndex,
      ours: o.rollbackIndex,
      theirs: t.rollbackIndex,
    });
    if (choice !== undefined && 'value' in choice) {
      const n = Number(choice.value);
      return Number.isInteger(n) ? Math.max(0, Math.min(features.length, n)) : at(ob, o);
    }
    const take = choice?.take ?? 'ours';
    return take === 'theirs' ? at(tb, t) : take === 'base' ? at(bb, b) : at(ob, o);
  }

  private collection(segs: Segs, bl: unknown[], ol: unknown[], tl: unknown[]): unknown[] {
    const [bm, om, tm] = [byId(bl), byId(ol), byId(tl)];
    const [bIds, oIds, tIds] = [idsOf(bl), idsOf(ol), idsOf(tl)];
    const merged = new Map<string, unknown>();
    for (const id of new Set([...oIds, ...tIds, ...bIds])) {
      const v = this.node([...segs, id], bm.get(id), om.get(id), tm.get(id));
      if (v !== undefined) merged.set(id, v);
    }
    const common = (ids: string[]) => ids.filter((id) => bm.has(id) && om.has(id) && tm.has(id));
    const [bo, oo, to] = [common(bIds), common(oIds), common(tIds)];
    const values = { base: bIds, ours: oIds, theirs: tIds };
    let skeleton: string[];
    let choice: Choice | undefined;
    let conflicted = false;
    if (sameOrder(oo, to)) skeleton = oo;
    else if (sameOrder(bo, oo)) {
      this.autoMerged++;
      skeleton = to;
    } else if (sameOrder(bo, to)) skeleton = oo;
    else {
      choice = this.choose('order', segs, values);
      conflicted = true;
      skeleton = normaliseOrder(this.pick(choice, bo, oo, to), oo);
    }
    // Items both sides added (same id) are placed by ours first, then by theirs first: if that
    // differs, the two sides put the same new item in different places, which is an order
    // conflict too (one conflict per list).
    const present = [...merged.keys()];
    const byOurs = weave(skeleton, present, [oIds, tIds, bIds]);
    const byTheirs = weave(skeleton, present, [tIds, oIds, bIds]);
    let order = byOurs;
    if (!sameOrder(byOurs, byTheirs)) {
      if (!conflicted) choice = this.choose('order', segs, values);
      if (choice !== undefined && 'value' in choice) {
        const typed = Array.isArray(choice.value) ? (choice.value as string[]) : [];
        order = weave(skeleton, present, [typed, oIds, tIds, bIds]);
      } else if (choice?.take === 'theirs') order = byTheirs;
    }
    return order.map((id) => merged.get(id));
  }

  /** Parameter names are unique: theirs' new or renamed name that clashes is a conflict. */
  private paramNames(doc: WhittleDoc): void {
    const { base, ours, theirs } = this.sides;
    const [bm, om, tm] = [byId(base.params), byId(ours.params), byId(theirs.params)];
    const count = new Map<string, number>();
    for (const p of doc.params) count.set(p.name, (count.get(p.name) ?? 0) + 1);
    const drop = new Set<string>();
    for (const p of doc.params) {
      if ((count.get(p.name) ?? 0) < 2) continue;
      const o = om.get(p.id) as Param | undefined;
      const t = tm.get(p.id) as Param | undefined;
      if (t?.name !== p.name || o?.name === p.name) continue; // not theirs' name
      const b = bm.get(p.id) as Param | undefined;
      if (o !== undefined) {
        const choice = this.choose('bothModified', ['params', p.id, 'name'], {
          base: b?.name,
          ours: o.name,
          theirs: t.name,
        });
        const name = this.pick(choice, b?.name ?? o.name, o.name, t.name);
        if (typeof name === 'string' && name !== p.name) {
          count.set(p.name, (count.get(p.name) ?? 1) - 1);
          p.name = name;
        }
      } else {
        const choice = this.choose('bothAdded', ['params', p.id], { base: b, theirs: t });
        const keep = this.pick(choice, b, undefined, t);
        if (keep === undefined) {
          count.set(p.name, (count.get(p.name) ?? 1) - 1);
          drop.add(p.id);
        } else if (isObj(keep)) Object.assign(p, keep);
      }
    }
    if (drop.size > 0) doc.params = doc.params.filter((p) => !drop.has(p.id));
  }
}

/** An order the user picked, restricted to `known` ids, with any missing ones appended. */
function normaliseOrder(picked: unknown, known: readonly string[]): string[] {
  const set = new Set(known);
  const ids = Array.isArray(picked) ? picked.filter((x): x is string => set.has(x as string)) : [];
  const seen = new Set(ids);
  return [...new Set(ids), ...known.filter((id) => !seen.has(id))];
}

/**
 * The final order: `skeleton`, with every other id of `present` inserted after the nearest
 * preceding skeleton id in the first of `sources` that has it. Runs from different sources at the
 * same place are ordered by their first id, so the result is symmetric in the sources.
 */
export function weave(
  skeleton: readonly string[],
  present: readonly string[],
  sources: readonly (readonly string[])[],
): string[] {
  const skel = new Set(skeleton);
  const extras = present.filter((id) => !skel.has(id));
  const sourceOf = new Map<string, number>();
  for (const id of extras) {
    const s = sources.findIndex((order) => order.includes(id));
    sourceOf.set(id, s);
  }
  const runs = new Map<string, string[][]>();
  sources.forEach((order, s) => {
    let anchor = '';
    let run: string[] | null = null;
    for (const id of order) {
      if (skel.has(id)) {
        anchor = id;
        run = null;
      } else if (sourceOf.get(id) === s) {
        if (run === null) {
          run = [];
          const group = runs.get(anchor) ?? [];
          group.push(run);
          runs.set(anchor, group);
        }
        run.push(id);
      }
    }
  });
  const placed = new Set<string>();
  const out: string[] = [];
  const emit = (anchor: string) => {
    const group = (runs.get(anchor) ?? []).slice().sort((a, b) => {
      const x = a[0] as string;
      const y = b[0] as string;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    for (const run of group) {
      for (const id of run) {
        if (placed.has(id)) continue;
        placed.add(id);
        out.push(id);
      }
    }
  };
  emit('');
  for (const id of skeleton) {
    out.push(id);
    placed.add(id);
    emit(id);
  }
  // Ids no source orders (a hand-entered item): keep them, at the end.
  for (const id of extras) if (!placed.has(id)) out.push(id);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Resolving without the merge inputs (a result that crossed a worker boundary)
// ---------------------------------------------------------------------------------------------

function sideValue(c: MergeConflict, choice: Choice): unknown {
  if ('value' in choice) return clone(choice.value);
  return clone(choice.take === 'theirs' ? c.theirs : choice.take === 'base' ? c.base : c.ours);
}

function setAt(doc: Obj, segs: Segs, value: unknown): void {
  let node: unknown = doc;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i] as string;
    node = Array.isArray(node)
      ? node.find((x) => (x as Identified).id === seg)
      : isObj(node)
        ? node[seg]
        : undefined;
    if (node === undefined) return; // the parent is gone: nothing to set
  }
  const last = segs[segs.length - 1] as string;
  if (Array.isArray(node)) {
    const i = node.findIndex((x) => (x as Identified).id === last);
    if (value === undefined) {
      if (i >= 0) node.splice(i, 1);
    } else if (i >= 0) node[i] = value;
    else node.push(value);
  } else if (isObj(node)) {
    if (value === undefined) delete node[last];
    else node[last] = value;
  }
}

function resolveByPath(result: MergeResult, choices: ReadonlyMap<string, Choice>): WhittleDoc {
  const doc = clone(result.doc) as unknown as Obj;
  const counts = new Map<Obj, number>();
  for (const part of (doc.parts ?? []) as Obj[]) {
    counts.set(part, ((part.features ?? []) as unknown[]).length);
  }
  for (const c of result.conflicts) {
    const choice = choices.get(c.id);
    if (choice === undefined) continue;
    const segs = fromPointer(c.path);
    const value = sideValue(c, choice);
    if (c.kind === 'order') {
      const list = segs.reduce<unknown>(
        (n, s) =>
          Array.isArray(n)
            ? n.find((x) => (x as Identified).id === s)
            : isObj(n)
              ? n[s]
              : undefined,
        doc,
      );
      if (!Array.isArray(list)) continue;
      const ids = idsOf(list);
      const items = byId(list);
      const order = weave(normaliseOrder(value, ids), ids, [ids]);
      list.splice(0, list.length, ...order.map((id) => items.get(id)));
    } else setAt(doc, segs, value);
  }
  // Keep every part's rollback bar meaningful after items came and went.
  for (const part of (doc.parts ?? []) as Obj[]) {
    const n = ((part.features ?? []) as unknown[]).length;
    const before = counts.get(part);
    let r = typeof part.rollbackIndex === 'number' ? part.rollbackIndex : n;
    if (before !== undefined && r === before) r = n; // was fully rolled forward: stays so
    part.rollbackIndex = Math.max(0, Math.min(n, r));
  }
  return doc as unknown as WhittleDoc;
}

// ---------------------------------------------------------------------------------------------
// DocMerger
// ---------------------------------------------------------------------------------------------

export class StructuralMerger implements DocMerger {
  merge(base: WhittleDoc, ours: WhittleDoc, theirs: WhittleDoc): MergeResult {
    const sides = { base: clone(base), ours: clone(ours), theirs: clone(theirs) };
    const run = new MergeRun(sides, new Map());
    const doc = run.run();
    const result: MergeResult = { doc, conflicts: run.conflicts, autoMerged: run.autoMerged };
    CONTEXT.set(result, sides);
    return result;
  }

  /**
   * Applies resolutions; conflicts not mentioned keep "ours". With the result `merge` returned,
   * the merge re-runs with the choices (items come back in their own place). A result that lost
   * its inputs (structured-cloned) is patched by path instead. Throws `MergeResolutionError` for
   * an unknown conflict id or when the choices would make an invalid document (e.g. two
   * parameters with one name).
   */
  resolve(result: MergeResult, resolutions: readonly MergeResolution[]): WhittleDoc {
    const known = new Set(result.conflicts.map((c) => c.id));
    const choices = new Map<string, Choice>();
    for (const r of resolutions) {
      if (!known.has(r.conflictId)) {
        throw new MergeResolutionError(`There is no conflict ‘${r.conflictId}’ in this merge`);
      }
      choices.set(r.conflictId, 'take' in r ? { take: r.take } : { value: r.value });
    }
    const sides = CONTEXT.get(result);
    const doc =
      choices.size === 0
        ? clone(result.doc)
        : sides
          ? new MergeRun(sides, choices).run()
          : resolveByPath(result, choices);
    const errors = validateDoc(doc);
    if (errors.length > 0) {
      throw new MergeResolutionError(
        `These choices would make an invalid document: ${errors.slice(0, 3).join('; ')}`,
      );
    }
    return doc;
  }
}

export const docMerger: DocMerger = new StructuralMerger();
