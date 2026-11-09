// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Minimal RFC 6902 JSON Patch: immutable apply (structural sharing), inverse generation, and a
 * structural diff for compiling "replace this whole feature" edits into small patches.
 *
 * Hand-written (~250 lines) rather than a dependency because we need (a) inverse patches computed
 * *during* application, which the small MIT libraries (fast-json-patch, rfc6902) do not give us in
 * an immutable form, and (b) a tiny, worker-safe, fully tested surface. Pointers follow RFC 6901
 * (`~0` = `~`, `~1` = `/`); `-` addresses the end of an array.
 */

import type { JsonPatchOp, JsonPointer } from '@wren-cad/contracts';

export class PatchError extends Error {
  constructor(
    message: string,
    readonly op?: JsonPatchOp,
  ) {
    super(message);
    this.name = 'PatchError';
  }
}

type Json = unknown;
type Container = Record<string, Json> | Json[];

export function parsePointer(p: JsonPointer): string[] {
  if (p === '') return [];
  if (!p.startsWith('/')) throw new PatchError(`Invalid JSON pointer ‘${p}’`);
  const segs = p
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segs.includes('__proto__')) throw new PatchError(`Forbidden path segment in ‘${p}’`);
  return segs;
}

export function escapePointerSegment(s: string | number): string {
  return String(s).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function pointerOf(...segments: (string | number)[]): JsonPointer {
  return segments.map((s) => `/${escapePointerSegment(s)}`).join('');
}

function isContainer(v: Json): v is Container {
  return typeof v === 'object' && v !== null;
}

function hasOwn(o: object, k: string): boolean {
  return Object.hasOwn(o, k);
}

function arrayIndex(seg: string, len: number, allowEnd: boolean, op: JsonPatchOp): number {
  if (seg === '-' && allowEnd) return len;
  if (!/^(0|[1-9]\d*)$/.test(seg)) throw new PatchError(`Invalid array index ‘${seg}’`, op);
  const i = Number(seg);
  if (i > len || (i === len && !allowEnd)) {
    throw new PatchError(`Array index ${i} is out of range (length ${len})`, op);
  }
  return i;
}

/** Reads the value at a pointer; throws if absent. */
export function getAt(doc: Json, pointer: JsonPointer): Json {
  let cur: Json = doc;
  for (const seg of parsePointer(pointer)) {
    if (Array.isArray(cur)) {
      const i = arrayIndex(seg, cur.length, false, { op: 'test', path: pointer, value: null });
      cur = cur[i];
    } else if (isContainer(cur) && hasOwn(cur, seg)) {
      cur = (cur as Record<string, Json>)[seg];
    } else {
      throw new PatchError(`Path ‘${pointer}’ does not exist`);
    }
  }
  return cur;
}

export function existsAt(doc: Json, pointer: JsonPointer): boolean {
  try {
    getAt(doc, pointer);
    return true;
  } catch {
    return false;
  }
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/** Returns a copy of `doc` where `segs` resolves to `fn(parentCopy, lastSegment)`'s result. */
function updateParent(
  doc: Json,
  segs: string[],
  op: JsonPatchOp,
  fn: (parent: Container, last: string) => void,
): Json {
  if (segs.length === 0) throw new PatchError('Cannot operate on the document root here', op);
  const walk = (node: Json, depth: number): Json => {
    if (!isContainer(node)) throw new PatchError(`Path does not exist`, op);
    const copy: Container = Array.isArray(node) ? node.slice() : { ...node };
    const seg = segs[depth] as string;
    if (depth === segs.length - 1) {
      fn(copy, seg);
      return copy;
    }
    if (Array.isArray(copy)) {
      const i = arrayIndex(seg, copy.length, false, op);
      copy[i] = walk(copy[i], depth + 1);
    } else {
      if (!hasOwn(copy, seg)) throw new PatchError(`Path component ‘${seg}’ does not exist`, op);
      copy[seg] = walk(copy[seg], depth + 1);
    }
    return copy;
  };
  return walk(doc, 0);
}

function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  const ao = a as Record<string, Json>;
  const bo = b as Record<string, Json>;
  const ak = Object.keys(ao);
  return (
    ak.length === Object.keys(bo).length &&
    ak.every((k) => hasOwn(bo, k) && jsonEqual(ao[k], bo[k]))
  );
}

export { jsonEqual };

interface Step {
  doc: Json;
  /** Inverse operations, in the order they must be applied to undo this step. */
  inverse: JsonPatchOp[];
}

function applyAdd(doc: Json, path: JsonPointer, value: Json, op: JsonPatchOp): Step {
  const segs = parsePointer(path);
  if (segs.length === 0) {
    return { doc: clone(value), inverse: [{ op: 'replace', path: '', value: doc }] };
  }
  let inverse: JsonPatchOp | undefined;
  const next = updateParent(doc, segs, op, (parent, last) => {
    if (Array.isArray(parent)) {
      const i = arrayIndex(last, parent.length, true, op);
      parent.splice(i, 0, clone(value));
      inverse = { op: 'remove', path: pointerOf(...segs.slice(0, -1), i) };
    } else if (hasOwn(parent, last)) {
      inverse = { op: 'replace', path, value: parent[last] };
      parent[last] = clone(value);
    } else {
      inverse = { op: 'remove', path };
      parent[last] = clone(value);
    }
  });
  return { doc: next, inverse: [inverse as JsonPatchOp] };
}

function applyRemove(doc: Json, path: JsonPointer, op: JsonPatchOp): Step & { removed: Json } {
  const segs = parsePointer(path);
  let removed: Json;
  let inverse: JsonPatchOp | undefined;
  const next = updateParent(doc, segs, op, (parent, last) => {
    if (Array.isArray(parent)) {
      const i = arrayIndex(last, parent.length, false, op);
      removed = parent[i];
      parent.splice(i, 1);
      inverse = { op: 'add', path: pointerOf(...segs.slice(0, -1), i), value: removed };
    } else {
      if (!hasOwn(parent, last)) throw new PatchError(`Path ‘${path}’ does not exist`, op);
      removed = parent[last];
      delete parent[last];
      inverse = { op: 'add', path, value: removed };
    }
  });
  return { doc: next, inverse: [inverse as JsonPatchOp], removed };
}

function applyReplace(doc: Json, path: JsonPointer, value: Json, op: JsonPatchOp): Step {
  const segs = parsePointer(path);
  if (segs.length === 0) {
    return { doc: clone(value), inverse: [{ op: 'replace', path: '', value: doc }] };
  }
  let old: Json;
  const next = updateParent(doc, segs, op, (parent, last) => {
    if (Array.isArray(parent)) {
      const i = arrayIndex(last, parent.length, false, op);
      old = parent[i];
      parent[i] = clone(value);
    } else {
      if (!hasOwn(parent, last)) throw new PatchError(`Path ‘${path}’ does not exist`, op);
      old = parent[last];
      parent[last] = clone(value);
    }
  });
  return { doc: next, inverse: [{ op: 'replace', path, value: old }] };
}

export interface PatchResult<T> {
  doc: T;
  /** Applying this to `doc` restores the input. */
  inverse: JsonPatchOp[];
}

/**
 * Applies `ops` in order without mutating `doc`. Throws `PatchError` (and leaves nothing applied)
 * if any operation fails. Untouched subtrees are shared with the input (structural sharing).
 */
export function applyPatch<T>(doc: T, ops: readonly JsonPatchOp[]): PatchResult<T> {
  let cur: Json = doc;
  const inverses: JsonPatchOp[][] = [];
  for (const op of ops) {
    let step: Step;
    switch (op.op) {
      case 'add':
        step = applyAdd(cur, op.path, op.value, op);
        break;
      case 'remove':
        step = applyRemove(cur, op.path, op);
        break;
      case 'replace':
        step = applyReplace(cur, op.path, op.value, op);
        break;
      case 'copy': {
        step = applyAdd(cur, op.path, getAt(cur, op.from), op);
        break;
      }
      case 'move': {
        if (op.from === op.path) {
          step = { doc: cur, inverse: [] };
          break;
        }
        if (op.path.startsWith(`${op.from}/`)) {
          throw new PatchError('Cannot move a value into itself', op);
        }
        const rem = applyRemove(cur, op.from, op);
        const add = applyAdd(rem.doc, op.path, rem.removed, op);
        step = { doc: add.doc, inverse: [...add.inverse, ...rem.inverse] };
        break;
      }
      case 'test': {
        if (!jsonEqual(getAt(cur, op.path), op.value)) {
          throw new PatchError(`Test failed at ‘${op.path}’`, op);
        }
        step = { doc: cur, inverse: [] };
        break;
      }
    }
    cur = step.doc;
    inverses.push(step.inverse);
  }
  return { doc: cur as T, inverse: inverses.reverse().flat() };
}

/**
 * Structural diff `a → b` as patch ops. Objects are diffed per key, equal-length arrays per
 * element; arrays of different length are replaced wholesale (ids make element matching the
 * caller's job). `base` is the pointer of `a`/`b` within the document.
 */
export function diff(a: Json, b: Json, base: JsonPointer = ''): JsonPatchOp[] {
  if (jsonEqual(a, b)) return [];
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((x, i) => diff(x, b[i], `${base}/${i}`));
  }
  if (isContainer(a) && isContainer(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const ops: JsonPatchOp[] = [];
    for (const k of Object.keys(a)) {
      const p = `${base}/${escapePointerSegment(k)}`;
      if (!hasOwn(b, k)) ops.push({ op: 'remove', path: p });
      else ops.push(...diff(a[k], b[k], p));
    }
    for (const k of Object.keys(b)) {
      if (!hasOwn(a, k))
        ops.push({ op: 'add', path: `${base}/${escapePointerSegment(k)}`, value: b[k] });
    }
    return ops;
  }
  return [{ op: 'replace', path: base, value: b }];
}
