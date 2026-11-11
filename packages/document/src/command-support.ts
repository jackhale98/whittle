// SPDX-License-Identifier: GPL-3.0-or-later
/** Shared pieces of the annotation and drawing command compilers. */

import type { Drawing, Id, JsonPatchOp, Part, WrenDoc } from '@wren-cad/contracts';
import { Checker } from './check';
import { diff } from './patch';

export type Compiled =
  | { ok: true; ops: JsonPatchOp[]; label: string }
  | { ok: false; error: string };

export const err = (error: string): Compiled => ({ ok: false, error });

/** Every id in the document-wide id space (params, parts, features, drawings and their content…). */
export function usedIds(doc: WrenDoc): Set<string> {
  const ids = new Set<string>();
  for (const p of doc.params) ids.add(p.id);
  for (const p of doc.parts) {
    ids.add(p.id);
    for (const f of p.features) ids.add(f.id);
    for (const f of p.folders ?? []) ids.add(f.id);
    for (const c of p.configurations ?? []) ids.add(c.id);
    for (const a of p.annotations ?? []) ids.add(a.id);
  }
  for (const a of doc.assemblies) ids.add(a.id);
  for (const d of doc.drawings) {
    ids.add(d.id);
    for (const s of d.sheets) ids.add(s.id);
    for (const l of [d.views, d.placements, d.centerMarks, d.tables, d.notes, d.markup ?? []]) {
      for (const x of l) ids.add(x.id);
    }
  }
  return ids;
}

/**
 * A checker that treats ids as *new*: each must be a non-empty string that is not in `used` and
 * not repeated; accepted ids are added to `used` (pass a copy).
 */
export function newIdChecker(used: Set<string>): Checker {
  const c: Checker = new Checker((v, path) => {
    if (typeof v !== 'string' || v === '') {
      c.err(`${path} must be a non-empty string`);
      return;
    }
    if (used.has(v)) c.err(`The id ‘${v}’ is already in use`);
    used.add(v);
  });
  return c;
}

/** A checker for objects that already exist (ids are only checked for being non-empty). */
export const plainChecker = (): Checker => new Checker();

/** The first problem as a command error. */
export function firstProblem(c: Checker, what: string): Compiled | undefined {
  const first = c.errs[0];
  return first === undefined ? undefined : err(`${what}: ${first}`);
}

export const partIndex = (doc: WrenDoc, partId: Id): number =>
  doc.parts.findIndex((p) => p.id === partId);

export const drawingIndex = (doc: WrenDoc, drawingId: Id): number =>
  doc.drawings.findIndex((d) => d.id === drawingId);

export const subjectPart = (doc: WrenDoc, d: Drawing): Part | undefined =>
  doc.parts.find((p) => p.id === d.subject.partId);

/**
 * An id-keyed collection kept sorted by id (code units). Emits the patch ops that add, replace and
 * remove members while tracking the working index of each member, so one command can touch many.
 * `optional` collections (`Part.annotations`, `Drawing.markup`) are absent when empty.
 */
export class SortedSet<T extends { id: string }> {
  private readonly ids: string[];
  private readonly by = new Map<string, T>();
  private exists: boolean;

  constructor(
    readonly path: string,
    items: readonly T[] | undefined,
    readonly ops: JsonPatchOp[],
    private readonly optional: boolean,
  ) {
    this.exists = items !== undefined;
    this.ids = (items ?? []).map((i) => i.id);
    for (const i of items ?? []) this.by.set(i.id, i);
  }

  has(id: string): boolean {
    return this.by.has(id);
  }

  get(id: string): T | undefined {
    return this.by.get(id);
  }

  add(item: T): void {
    let k = 0;
    while (k < this.ids.length && (this.ids[k] as string) < item.id) k++;
    if (!this.exists) {
      this.ops.push({ op: 'add', path: this.path, value: [item] });
      this.exists = true;
    } else {
      this.ops.push({ op: 'add', path: `${this.path}/${k}`, value: item });
    }
    this.ids.splice(k, 0, item.id);
    this.by.set(item.id, item);
  }

  replace(item: T): void {
    const old = this.by.get(item.id) as T;
    const k = this.ids.indexOf(item.id);
    this.ops.push(...diff(old, item, `${this.path}/${k}`));
    this.by.set(item.id, item);
  }

  remove(id: string): void {
    const k = this.ids.indexOf(id);
    if (k < 0) return;
    if (this.optional && this.ids.length === 1) {
      this.ops.push({ op: 'remove', path: this.path });
      this.exists = false;
    } else {
      this.ops.push({ op: 'remove', path: `${this.path}/${k}` });
    }
    this.ids.splice(k, 1);
    this.by.delete(id);
  }
}

export const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;
