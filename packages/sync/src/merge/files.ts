// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Three-way merge of whole projects (`ProjectFiles`), for git pulls and file sync (ADR-020 item
 * 4): the model files (manifest, params, parts, drawings, assemblies) are parsed and merged with
 * `DocMerger`; every other file (attachments, previews, release exports) merges as whole bytes,
 * and both sides changing one differently is a conflict on that file.
 *
 * File conflicts sit in the same `MergeResult.conflicts` list, at `/files/<path>` (outside the
 * document), with `{ sha256, size }` for each side that has the file. `DocMerger.resolve` ignores
 * them; `resolveProjectFiles` applies both kinds.
 */

import type {
  DocMerger,
  MergeConflict,
  MergeConflictKind,
  MergeResolution,
  MergeResult,
  ProjectFiles,
  WrenDoc,
} from '@wren-cad/contracts';
import { fromFiles, MANIFEST_FILE, toFiles } from '@wren-cad/document';
import { isVersionedPath, sameBytes, sha256Hex } from '../history/hash';
import { docMerger } from './merge';
import { escapeSeg } from './tree';

/** Pointer prefix of whole-file conflicts (not part of the document). */
export const FILES_POINTER = '/files';

const MODEL_PATH = /^(wren\.project\.json|params\.json|(parts|drawings|assemblies)\/)/;

export function isModelPath(path: string): boolean {
  return MODEL_PATH.test(path);
}

export function fileConflictId(kind: MergeConflictKind, path: string): string {
  return `${kind}:${FILES_POINTER}/${escapeSeg(path)}`;
}

export interface ProjectMerge {
  /** Document merge plus whole-file conflicts (at `/files/<path>`). */
  merge: MergeResult;
  /** Merged files: the merged document's canonical files plus the other files ("ours" where they conflict). */
  files: ProjectFiles;
}

interface Sides {
  base: ProjectFiles;
  ours: ProjectFiles;
  theirs: ProjectFiles;
}

function emptyLike(doc: WrenDoc): WrenDoc {
  return { ...structuredClone(doc), params: [], parts: [], drawings: [], assemblies: [] };
}

async function describe(bytes: Uint8Array | undefined) {
  return bytes === undefined ? undefined : { sha256: await sha256Hex(bytes), size: bytes.length };
}

/**
 * Merges three versions of a project. Throws `ProjectFormatError` when a side's model files can't
 * be read. A base without a project (unrelated histories) counts as empty: everything is added.
 */
export async function mergeProjectFiles(
  base: ProjectFiles,
  ours: ProjectFiles,
  theirs: ProjectFiles,
  merger: DocMerger = docMerger,
): Promise<ProjectMerge> {
  const o = fromFiles(ours);
  const t = fromFiles(theirs);
  const b = base.has(MANIFEST_FILE) ? fromFiles(base) : emptyLike(o);
  const merge = merger.merge(b, o, t);
  const conflicts: MergeConflict[] = [];
  const files: ProjectFiles = toFiles(merge.doc);
  let autoMerged = merge.autoMerged;
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of [...paths].sort()) {
    if (isModelPath(path) || !isVersionedPath(path)) continue;
    const [bb, ob, tb] = [base.get(path), ours.get(path), theirs.get(path)];
    let take: Uint8Array | undefined;
    if (sameBytes(ob, tb)) take = ob;
    else if (sameBytes(bb, ob)) {
      take = tb;
      autoMerged++;
    } else if (sameBytes(bb, tb)) take = ob;
    else {
      const kind: MergeConflictKind =
        bb === undefined
          ? 'bothAdded'
          : ob === undefined || tb === undefined
            ? 'modifiedDeleted'
            : 'bothModified';
      const c: MergeConflict = {
        id: fileConflictId(kind, path),
        kind,
        path: `${FILES_POINTER}/${escapeSeg(path)}`,
        file: path,
        subject: { kind: 'doc', label: path },
      };
      const [db, dout, dt] = await Promise.all([describe(bb), describe(ob), describe(tb)]);
      if (db) c.base = db;
      if (dout) c.ours = dout;
      if (dt) c.theirs = dt;
      conflicts.push(c);
      take = ob;
    }
    if (take !== undefined) files.set(path, take);
  }
  const result: MergeResult = {
    doc: merge.doc,
    conflicts: [...merge.conflicts, ...conflicts],
    autoMerged,
  };
  CONTEXT.set(result, { sides: { base, ours, theirs }, files, docResult: merge });
  return { merge: result, files };
}

/** What `resolveProjectFiles` needs besides the result: the inputs and the merged other files. */
const CONTEXT = new WeakMap<
  MergeResult,
  { sides: Sides; files: ProjectFiles; docResult: MergeResult }
>();

/**
 * Applies the user's choices to a `mergeProjectFiles` result and returns the project to save.
 * Document conflicts go through `merger.resolve`; a file conflict takes that side's bytes (or a
 * hand-picked `Uint8Array`; `null` deletes the file). Needs the result `mergeProjectFiles`
 * returned (not a structured clone of it): merge again otherwise.
 */
export function resolveProjectFiles(
  merge: MergeResult,
  resolutions: readonly MergeResolution[],
  merger: DocMerger = docMerger,
): ProjectFiles {
  const ctx = CONTEXT.get(merge);
  if (!ctx) throw new Error('This merge no longer has its files: merge again to resolve it');
  const isFile = (id: string) => id.includes(`:${FILES_POINTER}/`);
  const doc = merger.resolve(
    ctx.docResult,
    resolutions.filter((r) => !isFile(r.conflictId)),
  );
  const out: ProjectFiles = toFiles(doc);
  for (const [path, bytes] of ctx.files) if (!isModelPath(path)) out.set(path, bytes);
  const byId = new Map(merge.conflicts.map((c) => [c.id, c]));
  for (const r of resolutions) {
    if (!isFile(r.conflictId)) continue;
    const c = byId.get(r.conflictId);
    if (!c) throw new Error(`There is no conflict ‘${r.conflictId}’ in this merge`);
    const path = c.file ?? c.subject.label;
    const bytes =
      'value' in r
        ? r.value instanceof Uint8Array
          ? r.value
          : null
        : (ctx.sides[r.take].get(path) ?? null);
    if (bytes === null) out.delete(path);
    else out.set(path, bytes);
  }
  return out;
}
