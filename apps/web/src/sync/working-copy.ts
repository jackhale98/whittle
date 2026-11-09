/**
 * The local working copy of a project as sync and history see it (PLAN §8A.2): the canonical
 * document files plus the library entry's extra files (attachments, previews/, releases/,
 * `.wren-history/`). The `.wren/` cache is never part of it. Pure helpers, unit-tested.
 */

import type { JsonPatchOp, ProjectFiles, WrenDoc } from '@wren-cad/contracts';
import { diff, projectCodec } from '@wren-cad/document';

/** Model files (manifest, params, parts, drawings, assemblies); everything else is "extra". */
export const MODEL_PATH = /^(wren\.project\.json|params\.json|(parts|drawings|assemblies)\/)/;
export const HISTORY_PREFIX = '.wren-history/';

export function sameBytes(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined) {
  if (!a || !b) return !a && !b;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The project's files: canonical document files, then the extra files (never model paths). */
export function projectFiles(doc: WrenDoc, extra: ProjectFiles): ProjectFiles {
  const files = projectCodec.toFiles(doc);
  for (const [p, b] of extra) if (!MODEL_PATH.test(p) && !p.startsWith('.wren/')) files.set(p, b);
  return files;
}

/** Splits project files into the document (with the library id) and its extra files. */
export function splitProject(
  files: ProjectFiles,
  id: string,
): { doc: WrenDoc; extra: ProjectFiles } {
  const model: ProjectFiles = new Map();
  const extra: ProjectFiles = new Map();
  for (const [p, b] of files) {
    if (p.startsWith('.wren/')) continue;
    (MODEL_PATH.test(p) ? model : extra).set(p, b);
  }
  const doc = projectCodec.fromFiles(model);
  return { doc: { ...doc, meta: { ...doc.meta, id } }, extra };
}

/**
 * Applies sync's changes (`null` deletes) only if every `expected` path still has those bytes
 * (`null`: absent). Returns the new files, or `null` when the working copy moved on (the
 * `SyncLocalStore.writeFiles` compare-and-swap).
 */
export function applyChanges(
  files: ProjectFiles,
  changes: ReadonlyMap<string, Uint8Array | null>,
  expected: ReadonlyMap<string, Uint8Array | null>,
): ProjectFiles | null {
  for (const [p, want] of expected) if (!sameBytes(files.get(p) ?? null, want)) return null;
  const out = new Map(files);
  for (const [p, b] of changes) {
    if (b === null) out.delete(p);
    else out.set(p, b);
  }
  return out;
}

/** Project-relative paths whose bytes differ between two versions of the working copy. */
export function changedPaths(before: ProjectFiles, after: ProjectFiles): string[] {
  const out: string[] = [];
  for (const [p, b] of after) if (!sameBytes(before.get(p), b)) out.push(p);
  for (const p of before.keys()) if (!after.has(p)) out.push(p);
  return out.sort();
}

/**
 * The patch that turns `current` into `next` as one undo step. `keepModified`: the result keeps
 * `next`'s `meta.modified` exactly (the store would otherwise stamp "now" on it), so a document
 * that arrived from another device is byte-identical here and is not pushed back.
 */
export function patchTo(current: WrenDoc, next: WrenDoc, keepModified: boolean): JsonPatchOp[] {
  const target = { ...next, meta: { ...next.meta, id: current.meta.id ?? next.meta.id } };
  const ops = diff(current as never, target as never);
  if (keepModified && !ops.some((o) => 'path' in o && o.path === '/meta/modified')) {
    ops.push({ op: 'replace', path: '/meta/modified', value: target.meta.modified });
  }
  return ops;
}

/** Version files restored into a working copy: the version's files plus this copy's history. */
export function restoredExtra(current: ProjectFiles, version: ProjectFiles): ProjectFiles {
  const out: ProjectFiles = new Map();
  for (const [p, b] of current) if (p.startsWith(HISTORY_PREFIX)) out.set(p, b);
  for (const [p, b] of version) {
    if (!MODEL_PATH.test(p) && !p.startsWith('.wren/') && !p.startsWith(HISTORY_PREFIX))
      out.set(p, b);
  }
  return out;
}
