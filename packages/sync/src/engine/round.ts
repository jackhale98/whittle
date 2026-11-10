// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/sync/engine.ts (`syncFolder`), with a structural document merge.
/**
 * One two-way sync round between a project's local working copy and its folder in a file
 * service.
 *
 * Each file remembers the service's revision and the bytes it last agreed on (its base). A round
 * first takes what changed remotely since the last cursor:
 * - files not edited here are replaced;
 * - if any document file (manifest, params, parts, drawings, assemblies) changed on both sides,
 *   the whole base, local and remote documents are rebuilt with `fromFiles` and merged with the
 *   injected `DocMerger`. A clean merge is written back with `toFiles`; conflicts leave the local
 *   document untouched, hold every document file back from upload and keep the cursor, so each
 *   round offers them again until `resolve()`;
 * - any other file edited on both sides is a whole-file conflict.
 *
 * Then local edits are uploaded against the base's revision, so a write that races another
 * device fails with `CONFLICT` instead of overwriting; the base is marked stale and the next
 * round re-reads and merges it. Local edits are found by hashing the working copy against the
 * bases, so nothing is lost even if the pending list is. Local writes are compare-and-swap
 * (`SyncLocalStore.writeFiles`): if the user saved meanwhile, the round is abandoned (nothing
 * committed) and run again.
 */

import type {
  DocMerger,
  MergeConflict,
  MergeResult,
  ProjectFiles,
  RemoteEntry,
  StorageProvider,
  StorageResult,
  SyncBase,
  SyncOutcome,
  SyncState,
  WrenDoc,
} from '@wren-cad/contracts';
import { fromFiles, MANIFEST_FILE, newDoc, toFiles } from '@wren-cad/document';
import { mergeNotes, type StructuralMergeResult } from '../merge/merge';
import { documentPaths, pushRank, syncable, toAbsolute, toRelative } from '../paths';
import { fail, forward, ok, pool } from '../providers/common';
import { bytesEqual, sha256Hex } from './hash';
import type { SyncLocalStore } from './store';

/** A base whose remote copy has moved on (a push conflicted): re-read it before pushing. */
export const STALE_REV = '\u0000stale';
/** Base hash meaning "no base bytes" (a create that conflicted). */
export const NO_BASE = '';

export type SyncPhase = 'listing' | 'pulling' | 'merging' | 'pushing';

export interface RemoteFile {
  bytes: Uint8Array;
  rev: string;
}

/** A document merge waiting for the user's choices. */
export interface DocConflictContext {
  /** From the `DocMerger` (document conflicts only). */
  result: MergeResult;
  /** Local document files at merge time: `resolve` refuses if they changed since. */
  ours: Map<string, Uint8Array | null>;
  /** The remote document files read this round (bases to adopt once resolved). */
  theirs: Map<string, RemoteFile | null>;
  paths: Set<string>;
}

/** A non-document file changed on both sides. */
export interface FileConflictContext {
  id: string;
  path: string;
  base: Uint8Array | null;
  ours: Uint8Array | null;
  theirs: RemoteFile | null;
}

export interface ConflictContext {
  doc: DocConflictContext | null;
  files: FileConflictContext[];
  /** What the status and outcome show: document and file conflicts together. */
  merge: MergeResult;
}

export interface RoundDeps {
  provider: StorageProvider;
  store: SyncLocalStore;
  merger: DocMerger;
  now: () => number;
  onProgress?: (phase: SyncPhase, ratio: number | null) => void;
  /** Called with the working copy before sync replaces or deletes any local file (local history). */
  onBeforeOverwrite?: (files: ProjectFiles) => Promise<void> | void;
}

export type RoundResult =
  | {
      kind: 'done';
      outcome: SyncOutcome;
      state: SyncState;
      conflict: ConflictContext | null;
      /** A push conflicted: run another round now to merge it. */
      again: boolean;
    }
  /** The working copy changed during the round; nothing was committed. Run again. */
  | { kind: 'retry' };

const FILE_CONFLICT_PREFIX = 'file:';

/** The project-relative path of a whole-file conflict, or `null` for document conflicts. */
export function fileConflictPath(c: MergeConflict): string | null {
  if (c.file !== undefined) return c.file;
  return c.id.startsWith(FILE_CONFLICT_PREFIX) ? c.id.slice(FILE_CONFLICT_PREFIX.length) : null;
}

function syncableFiles(files: ProjectFiles): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [p, b] of files) if (syncable(p)) out.set(p, b);
  return out;
}

/** A base document for merging when none can be built: the same document with nothing in it. */
function emptyLike(doc: WrenDoc): WrenDoc {
  return { ...doc, params: [], parts: [], assemblies: [], drawings: [] };
}

function tryFromFiles(files: ProjectFiles): { doc: WrenDoc } | { error: string } {
  try {
    return { doc: fromFiles(files) };
  } catch (e) {
    return { error: (e as Error)?.message ?? String(e) };
  }
}

export function fileConflict(fc: FileConflictContext): MergeConflict {
  return {
    id: fc.id,
    kind: 'bothModified',
    path: fc.path,
    file: fc.path,
    subject: { kind: 'doc', label: fc.path },
    ...(fc.base ? { base: fc.base } : {}),
    ...(fc.ours ? { ours: fc.ours } : {}),
    ...(fc.theirs ? { theirs: fc.theirs.bytes } : {}),
  };
}

/** The current document for showing file-only conflicts. */
function docForDisplay(files: ProjectFiles): WrenDoc {
  const r = tryFromFiles(files);
  return 'doc' in r ? r.doc : newDoc();
}

export function combineConflicts(
  doc: DocConflictContext | null,
  files: FileConflictContext[],
  local: ProjectFiles,
): MergeResult {
  const result: StructuralMergeResult = {
    doc: doc ? doc.result.doc : docForDisplay(local),
    conflicts: [...(doc?.result.conflicts ?? []), ...files.map(fileConflict)],
    autoMerged: doc?.result.autoMerged ?? 0,
  };
  const notes = doc ? mergeNotes(doc.result) : [];
  if (notes.length > 0) result.notes = notes;
  return result;
}

export async function syncRound(
  deps: RoundDeps,
  state0: SyncState,
): Promise<StorageResult<RoundResult>> {
  const { provider, store, merger } = deps;
  const cs = provider.caseSensitive;
  const norm = cs ? (p: string) => p : (p: string) => p.toLowerCase();
  const root = state0.link.path;
  const abs = (p: string) => toAbsolute(root, p);
  const progress = deps.onProgress ?? (() => undefined);
  const bases = new Map<string, SyncBase>(Object.entries(state0.bases));
  const newBlobs = new Map<string, Uint8Array>();

  // ------------------------------------------------------------ list
  progress('listing', null);
  const local0 = syncableFiles(await store.readFiles());
  let full = state0.cursor === null;
  let expired = false;
  let listed = await provider.list(
    state0.cursor === null ? { path: root } : { cursor: state0.cursor },
  );
  if (!listed.ok && listed.error.code === 'CURSOR_EXPIRED') {
    // An expired cursor: start over from a full listing.
    expired = true;
    full = true;
    listed = await provider.list({ path: root });
  }
  if (!listed.ok) return forward(listed);
  const listing = listed.value;
  if (listing.complete) full = true;

  // Case-insensitive services: keep the spelling this project already uses.
  const known = new Map<string, string>();
  for (const p of [...bases.keys(), ...local0.keys(), ...state0.pending]) known.set(norm(p), p);
  const relative = (path: string): string | null => {
    const r = toRelative(root, path, cs);
    return r === null ? null : (known.get(norm(r)) ?? r);
  };

  const changed = new Map<string, RemoteEntry>();
  const deleted = new Set<string>();
  const seen = new Set<string>();
  for (const e of listing.entries) {
    const p = relative(e.path);
    if (!p) continue;
    if (e.kind === 'deleted') {
      // A deleted folder takes everything under it.
      const prefix = `${norm(p)}/`;
      for (const b of bases.keys()) {
        if (norm(b) === norm(p) || norm(b).startsWith(prefix)) {
          deleted.add(b);
          changed.delete(b);
        }
      }
      continue;
    }
    if (e.kind !== 'file' || !syncable(p)) continue;
    seen.add(norm(p));
    deleted.delete(p);
    // Our own upload coming back, or nothing new.
    if (bases.get(p)?.rev === e.rev) changed.delete(p);
    else changed.set(p, e);
  }
  // A full listing shows what exists: anything we had that's gone was deleted.
  if (full) for (const b of bases.keys()) if (!seen.has(norm(b))) deleted.add(b);
  // Stale bases are re-read even if the listing didn't mention them.
  for (const [p, b] of bases) {
    if (b.rev === STALE_REV && !changed.has(p) && !deleted.has(p)) {
      changed.set(p, { kind: 'file', path: abs(p) });
    }
  }

  // ------------------------------------------------------------ pull
  const theirs = new Map<string, RemoteFile | null>();
  const toRead = [...changed];
  let done = 0;
  progress('pulling', toRead.length ? 0 : null);
  const pulled = await pool(toRead, 6, async ([p, e]) => {
    const r = await provider.read(e.path);
    done += 1;
    progress('pulling', done / toRead.length);
    if (r.ok) {
      theirs.set(p, { bytes: r.value.bytes, rev: r.value.rev || e.rev || '' });
      return r;
    }
    if (r.error.code === 'NOT_FOUND') {
      theirs.set(p, null);
      return ok(undefined);
    }
    return r;
  });
  if (!pulled.ok) return forward(pulled);
  for (const p of deleted) theirs.set(p, null);

  // Hashes and bases for everything involved.
  const hashes = new Map<Uint8Array, string>();
  const hashOf = async (b: Uint8Array) => {
    let h = hashes.get(b);
    if (h === undefined) {
      h = await sha256Hex(b);
      hashes.set(b, h);
    }
    return h;
  };
  const localHash = new Map<string, string>();
  for (const [p, b] of local0) localHash.set(p, await hashOf(b));
  for (const t of theirs.values()) if (t) await hashOf(t.bytes);
  const baseCache = new Map<string, Uint8Array | null>();
  const loadBase = async (p: string): Promise<Uint8Array | null> => {
    if (baseCache.has(p)) return baseCache.get(p) ?? null;
    const b = bases.get(p);
    const bytes = b && b.hash !== NO_BASE ? await store.getBase(b.hash) : null;
    baseCache.set(p, bytes);
    return bytes;
  };

  /** Edited here since the base (added, changed or deleted). */
  const edited = (p: string, base: SyncBase | undefined): boolean => {
    const h = localHash.get(p);
    if (h === undefined) return !!base && base.hash !== NO_BASE;
    return !base || base.hash !== h;
  };

  const writes = new Map<string, Uint8Array | null>();
  const adopt = (p: string, t: RemoteFile | null) => {
    if (!t) bases.delete(p);
    else {
      const h = hashes.get(t.bytes) as string;
      bases.set(p, { rev: t.rev, hash: h });
      newBlobs.set(h, t.bytes);
    }
  };

  // Which files belong to the document: from the base, local and remote manifests.
  const origBases = new Map(bases);
  const manifestBase = await loadBase(MANIFEST_FILE);
  const manifestTheirs = theirs.has(MANIFEST_FILE)
    ? (theirs.get(MANIFEST_FILE)?.bytes ?? null)
    : manifestBase;
  const docPaths = documentPaths(manifestBase, local0.get(MANIFEST_FILE), manifestTheirs);

  interface Classified {
    p: string;
    base: SyncBase | undefined;
    baseBytes: Uint8Array | null;
    ours: Uint8Array | null;
    t: RemoteFile | null;
    both: boolean;
    remoteChanged: boolean;
  }
  const classified: Classified[] = [];
  for (const [p, t] of theirs) {
    const base = origBases.get(p);
    const baseBytes = await loadBase(p);
    const ours = local0.get(p) ?? null;
    const remoteChanged = !bytesEqual(t?.bytes ?? null, baseBytes);
    const both = edited(p, base) && remoteChanged && !bytesEqual(ours, t?.bytes ?? null);
    classified.push({ p, base, baseBytes, ours, t, both, remoteChanged });
  }
  const docMerge = classified.some((c) => c.both && docPaths.has(c.p));

  const merged: string[] = [];
  let docConflict: DocConflictContext | null = null;
  const fileConflicts: FileConflictContext[] = [];
  const held = new Set<string>();
  let holdCursor = false;

  progress('merging', null);
  for (const c of classified) {
    if (docMerge && docPaths.has(c.p)) continue; // handled below, as one document
    if (bytesEqual(c.ours, c.t?.bytes ?? null)) {
      adopt(c.p, c.t);
    } else if (!c.remoteChanged) {
      // Same bytes as the base under a new revision: keep the local edit, against the new rev.
      if (c.t && c.base) bases.set(c.p, { rev: c.t.rev, hash: c.base.hash });
      else adopt(c.p, c.t);
    } else if (!c.both) {
      // Not edited here: take theirs.
      writes.set(c.p, c.t?.bytes ?? null);
      adopt(c.p, c.t);
    } else if (c.t === null) {
      // Edited here, deleted there: keep the edit (it uploads as a new file).
      bases.delete(c.p);
    } else if (c.ours === null) {
      // Deleted here, edited there: keep their version (nothing is lost).
      writes.set(c.p, c.t.bytes);
      adopt(c.p, c.t);
    } else {
      fileConflicts.push({
        id: `${FILE_CONFLICT_PREFIX}${c.p}`,
        path: c.p,
        base: c.baseBytes,
        ours: c.ours,
        theirs: c.t,
      });
      held.add(c.p);
      holdCursor = true;
    }
  }

  if (docMerge) {
    const baseFiles: ProjectFiles = new Map();
    const oursFiles: ProjectFiles = new Map();
    const theirsFiles: ProjectFiles = new Map();
    for (const p of docPaths) {
      const bb = await loadBase(p);
      if (bb) baseFiles.set(p, bb);
      const lb = local0.get(p);
      if (lb) oursFiles.set(p, lb);
      const tb = theirs.has(p) ? (theirs.get(p)?.bytes ?? null) : bb;
      if (tb) theirsFiles.set(p, tb);
    }
    const t = tryFromFiles(theirsFiles);
    if ('error' in t) {
      // Usually another device is midway through uploading; nothing is committed.
      return fail(
        'REMOTE',
        `The copy in the service isn’t a complete project yet (${t.error}). Sync will try again.`,
      );
    }
    const o = tryFromFiles(oursFiles);
    if ('error' in o) {
      return fail('REMOTE', `This device’s copy of the project can’t be read: ${o.error}`);
    }
    const b = tryFromFiles(baseFiles);
    const baseDoc = 'doc' in b ? b.doc : emptyLike(o.doc);
    const result = merger.merge(baseDoc, o.doc, t.doc);
    if (result.conflicts.length === 0) {
      const out = toFiles(result.doc);
      for (const p of new Set([...docPaths, ...out.keys()])) {
        const nb = out.get(p) ?? null;
        if (!bytesEqual(local0.get(p) ?? null, nb)) writes.set(p, nb);
        if (theirs.has(p)) adopt(p, theirs.get(p) ?? null);
      }
      for (const c of classified) if (c.both && docPaths.has(c.p)) merged.push(c.p);
    } else {
      const ours = new Map<string, Uint8Array | null>();
      const docTheirs = new Map<string, RemoteFile | null>();
      for (const p of docPaths) {
        ours.set(p, local0.get(p) ?? null);
        if (theirs.has(p)) docTheirs.set(p, theirs.get(p) ?? null);
        held.add(p);
      }
      docConflict = { result, ours, theirs: docTheirs, paths: new Set(docPaths) };
      holdCursor = true;
    }
  }

  // ------------------------------------------------------------ apply locally
  if (writes.size) {
    const expected = new Map<string, Uint8Array | null>();
    for (const p of writes.keys()) expected.set(p, local0.get(p) ?? null);
    if (docMerge) for (const p of docPaths) expected.set(p, local0.get(p) ?? null);
    if ([...writes.keys()].some((p) => local0.has(p))) {
      await deps.onBeforeOverwrite?.(new Map(local0));
    }
    if (!(await store.writeFiles(writes, expected))) return ok({ kind: 'retry' });
  }
  for (const [h, b] of newBlobs) await store.putBase(h, b);
  newBlobs.clear();
  const cursor = holdCursor ? (expired ? null : state0.cursor) : listing.cursor;
  const snapshot = (pending: string[]): SyncState => ({
    link: state0.link,
    cursor,
    bases: Object.fromEntries([...bases].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    pending,
    lastSyncAt: new Date(deps.now()).toISOString(),
  });

  // ------------------------------------------------------------ push
  const local1 = syncableFiles(await store.readFiles());
  for (const [p, b] of local1) localHash.set(p, await hashOf(b));
  for (const p of [...localHash.keys()]) if (!local1.has(p)) localHash.delete(p);
  const dirty = (p: string) => {
    const base = bases.get(p);
    const h = localHash.get(p);
    if (h === undefined) return !!base && base.hash !== NO_BASE;
    return !base || base.hash !== h;
  };
  const pendingNow = () =>
    [...new Set([...local1.keys(), ...bases.keys()])].filter((p) => syncable(p) && dirty(p)).sort();
  await store.saveState(snapshot(pendingNow()));

  interface Upload {
    p: string;
    bytes: Uint8Array | null;
  }
  const uploads: Upload[] = [];
  for (const p of pendingNow()) {
    if (held.has(p)) continue;
    if (bases.get(p)?.rev === STALE_REV) continue; // re-read and merge first (next round)
    uploads.push({ p, bytes: local1.get(p) ?? null });
  }
  let pushed = 0;
  let again = false;
  let docBlocked = false;
  let failure: StorageResult<RoundResult> | null = null;
  const ranks = [0, 1, 2, 3];
  progress('pushing', uploads.length ? 0 : null);
  let sent = 0;
  for (const rank of ranks) {
    const batch = uploads.filter((u) => pushRank(u.p, u.bytes === null) === rank);
    const r = await pool(batch, 4, async (u) => {
      if (docBlocked && docPaths.has(u.p)) return ok(undefined);
      const base = bases.get(u.p);
      let res: StorageResult<unknown>;
      let h = '';
      if (u.bytes === null) {
        res = await provider.remove(abs(u.p), base?.rev ?? null);
      } else {
        h = await hashOf(u.bytes);
        res = await provider.write(abs(u.p), u.bytes, base?.rev ?? null);
      }
      sent += 1;
      progress('pushing', sent / uploads.length);
      if (res.ok) {
        if (u.bytes === null) bases.delete(u.p);
        else {
          const rev = (res.value as { rev: string }).rev;
          bases.set(u.p, { rev, hash: h });
          newBlobs.set(h, u.bytes);
        }
        pushed += 1;
        return ok(undefined);
      }
      if (res.error.code === 'CONFLICT' || (res.error.code === 'NOT_FOUND' && u.bytes !== null)) {
        // Changed elsewhere since our base: never overwrite. Re-read and merge next round.
        bases.set(u.p, base ? { ...base, rev: STALE_REV } : { rev: STALE_REV, hash: NO_BASE });
        again = true;
        if (docPaths.has(u.p)) docBlocked = true;
        return ok(undefined);
      }
      return forward(res);
    });
    if (!r.ok) {
      failure = forward(r);
      break;
    }
  }
  for (const [h, b] of newBlobs) await store.putBase(h, b);
  const state = snapshot(pendingNow());
  await store.saveState(state);
  if (store.pruneBases) {
    const keep = new Set<string>();
    for (const b of bases.values()) if (b.hash !== NO_BASE) keep.add(b.hash);
    for (const b of Object.values(state0.bases)) if (holdCursor) keep.add(b.hash);
    await store.pruneBases(keep);
  }
  if (failure) return failure;

  const conflict: ConflictContext | null =
    docConflict || fileConflicts.length
      ? {
          doc: docConflict,
          files: fileConflicts,
          merge: combineConflicts(docConflict, fileConflicts, local1),
        }
      : null;
  const outcome: SyncOutcome = {
    pulled: writes.size,
    pushed,
    merged,
    ...(writes.size ? { files: new Map(local1) } : {}),
    ...(conflict ? { merge: conflict.merge } : {}),
  };
  return ok({ kind: 'done', outcome, state, conflict, again });
}
