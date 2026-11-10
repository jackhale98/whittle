// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The shape of the document as the structural merge and the feature diff see it (PLAN §8A.3,
 * ADR-020 item 5): which arrays are id-keyed collections, which values are atomic leaves, and
 * how paths are written. Shared by `DocMerger` and `DocDiffer` so both walk the same tree.
 *
 * Paths are arrays of unescaped segments; array items in collections are selected by their `id`,
 * never by index (`['parts', <partId>, 'features', <featureId>, 'radius']`).
 */

import type { EntityKind, JsonPointer } from '@wren-cad/contracts';

export type Segs = readonly string[];
export type Obj = Record<string, unknown>;

/**
 * Every array in document.ts / sketch.ts whose items carry a stable `id`. `*` matches one item id.
 * Everything else that is an array (EntityRef lists, Vec3, frames, `skip`, `CopySource.features`)
 * is a leaf and merges as a whole, except a folder's member ids (`FeatureFolder.features`), which
 * merge as a set.
 */
export const COLLECTIONS: readonly Segs[] = [
  ['params'],
  ['parts'],
  ['drawings'],
  ['assemblies'],
  ['parts', '*', 'features'],
  // Feature tree folders (M3.6). The merge handles them at the part level (`merge.ts` folders()):
  // their order carries no meaning and their member lists merge as sets.
  ['parts', '*', 'folders'],
  ['parts', '*', 'features', '*', 'entities'],
  ['parts', '*', 'features', '*', 'constraints'],
  ['parts', '*', 'features', '*', 'annotations'],
];

export function isCollectionPath(segs: Segs): boolean {
  return COLLECTIONS.some(
    (pat) => pat.length === segs.length && pat.every((p, i) => p === '*' || p === segs[i]),
  );
}

export const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep JSON equality where a property holding `undefined` is the same as a missing one. */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
    return true;
  }
  const ao = a as Obj;
  const bo = b as Obj;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!equal(ao[k], bo[k])) return false;
  return true;
}

const ENTITY_KINDS: readonly EntityKind[] = ['face', 'edge', 'vertex', 'region', 'body'];
const REF_KEYS = new Set(['name', 'kind', 'fingerprint']);

/** A persistent topological reference: always merged whole (its name and fingerprint belong together). */
export function isEntityRef(v: unknown): boolean {
  return (
    isObj(v) &&
    typeof v.name === 'string' &&
    ENTITY_KINDS.includes(v.kind as EntityKind) &&
    Object.keys(v).every((k) => REF_KEYS.has(k))
  );
}

/** Keys that select a variant of a discriminated union; a variant change replaces the object whole. */
const DISCRIMINANTS = ['type', 'kind', 'shape'] as const;

function discriminantsOf(segs: Segs): readonly string[] {
  // A material switched to another library entry is a different material, not a field edit.
  if (segs.length === 3 && segs[0] === 'parts' && segs[2] === 'material') {
    return [...DISCRIMINANTS, 'libraryId'];
  }
  return DISCRIMINANTS;
}

/**
 * Whether three versions of an object at `segs` must merge as one leaf: entity references, and
 * objects whose union variant differs between any two versions (merging the fields of two
 * variants could produce an object that is neither, which the schema rejects).
 */
export function isAtomicObject(segs: Segs, ...versions: unknown[]): boolean {
  const present = versions.filter((v) => v !== undefined);
  if (present.some(isEntityRef)) return true;
  for (const k of discriminantsOf(segs)) {
    const first = (present[0] as Obj | undefined)?.[k];
    if (present.some((v) => (v as Obj)[k] !== first)) return true;
  }
  return false;
}

export function escapeSeg(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapeSeg(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function toPointer(segs: Segs): JsonPointer {
  return segs.length === 0 ? '' : `/${segs.map(escapeSeg).join('/')}`;
}

export function fromPointer(p: JsonPointer): string[] {
  if (p === '') return [];
  if (!p.startsWith('/')) throw new Error(`Invalid JSON pointer ‘${p}’`);
  return p.slice(1).split('/').map(unescapeSeg);
}

export interface Identified {
  id: string;
}

export function idsOf(list: unknown): string[] {
  return Array.isArray(list) ? list.map((x) => (x as Identified).id) : [];
}

export function byId(list: unknown): Map<string, unknown> {
  const m = new Map<string, unknown>();
  if (Array.isArray(list)) for (const x of list) m.set((x as Identified).id, x);
  return m;
}

/**
 * The value at an id path (`['parts', id, 'features', id, 'radius']`), or `undefined`.
 * Collection segments look items up by id.
 */
export function getAtSegs(root: unknown, segs: Segs): unknown {
  let node: unknown = root;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as string;
    if (Array.isArray(node)) {
      if (!isCollectionPath(segs.slice(0, i))) return undefined;
      node = node.find((x) => (x as Identified).id === seg);
    } else if (isObj(node)) {
      node = node[seg];
    } else return undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

/** The id of the first rolled-back feature of a part, or `null` when it is fully rolled forward. */
export function barIdOf(part: unknown): string | null {
  if (!isObj(part) || !Array.isArray(part.features)) return null;
  const i = typeof part.rollbackIndex === 'number' ? part.rollbackIndex : part.features.length;
  return (part.features[i] as Identified | undefined)?.id ?? null;
}

/**
 * Index of the rollback bar in `features` for a bar that sat before `barId`. If that feature is
 * gone, the bar sits before the first later survivor in `order` (the version the bar came from).
 */
export function barIndex(
  features: readonly Identified[],
  barId: string | null,
  orders: readonly (readonly string[])[],
): number {
  if (barId === null) return features.length;
  const at = new Map(features.map((f, i) => [f.id, i]));
  const direct = at.get(barId);
  if (direct !== undefined) return direct;
  for (const order of orders) {
    const k = order.indexOf(barId);
    if (k < 0) continue;
    for (let j = k + 1; j < order.length; j++) {
      const i = at.get(order[j] as string);
      if (i !== undefined) return i;
    }
    return features.length;
  }
  return features.length;
}
