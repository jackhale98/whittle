/**
 * Connections, sync and version control (PLAN §8A, M2.5). Lead-owned contract, implemented by
 * packages/sync (providers, sync engine, history, merge, diff) and packages/kernel-client
 * (geometric diff, see `ModelingApi.compare`).
 *
 * The app always edits a local working copy and syncs in the background. A project is the
 * canonical folder of `ProjectFiles` (docs/FILE_FORMAT.md); sync and history move those files,
 * never the in-memory document. Merges happen on the parsed document, keyed by stable ids.
 *
 * Ported from Mycelium (same author, GPL-3.0-or-later, ADR-003): `RemoteFiles` → `StorageProvider`,
 * `syncFolder` → `SyncEngine`, `GitRepo` → `GitHistory`. Whittle replaces Mycelium's line-based
 * text merge with a structural merge of the document (`DocMerger`).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { FeatureType, Id, Vec3, WhittleDoc } from './document';
import type { ProjectFiles } from './io';
import type { KernelError, MassProperties, MeshBuffers } from './kernel';
import type { JsonPointer } from './store';

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export type StorageErrorCode =
  /** A write or delete found the file changed since the revision it was based on. */
  | 'CONFLICT'
  | 'NOT_FOUND'
  /** The change cursor is too old: list everything again. */
  | 'CURSOR_EXPIRED'
  /** Signed out, or the token or password was refused. The UI offers "Sign in again". */
  | 'AUTH'
  /** No network. Changes stay queued. */
  | 'OFFLINE'
  /** The server refused a cross-origin request (WebDAV without CORS, git host without proxy). */
  | 'CORS'
  | 'RATE_LIMITED'
  | 'QUOTA'
  /** The user denied access (folder permission, OAuth consent). */
  | 'PERMISSION'
  /** This provider or operation isn't available in this build (e.g. a provider without app keys). */
  | 'UNSUPPORTED'
  /** Anything else, with the HTTP status when there is one. */
  | 'REMOTE';

export interface StorageError {
  code: StorageErrorCode;
  /** Human, actionable: "Dropbox: the folder ‘Bracket’ was deleted". Never contains a token. */
  message: string;
  path?: string;
  status?: number;
  retryAfterMs?: number;
}

/** Results cross worker boundaries, so errors are values, not thrown classes. */
export type StorageResult<T> = { ok: true; value: T } | { ok: false; error: StorageError };

// ---------------------------------------------------------------------------------------------
// Connections and credentials
// ---------------------------------------------------------------------------------------------

/** File services: implement `StorageProvider` and use `SnapshotHistory`. */
export type FileProviderKind = 'folder' | 'dropbox' | 'onedrive' | 'gdrive' | 'webdav';
/** Git hosts: use `GitHistory` (isomorphic-git) through the CORS proxy. */
export type GitProviderKind = 'github' | 'gitlab' | 'bitbucket' | 'forgejo';
export type ProviderKind = FileProviderKind | GitProviderKind;

/** A configured place projects can live. Holds no secrets (see `CredentialVault`). */
export type Connection =
  | {
      id: Id;
      kind: 'folder';
      label: string;
      /** The FileSystemDirectoryHandle is kept in IndexedDB under this key (handles can't be JSON). */
      handleKey: string;
    }
  | { id: Id; kind: 'dropbox' | 'gdrive'; label: string; account?: string }
  | {
      id: Id;
      kind: 'onedrive';
      label: string;
      account?: string;
      driveId: string;
      /** "OneDrive" or "SharePoint · Team site". */
      driveName?: string;
    }
  | {
      id: Id;
      kind: 'webdav';
      label: string;
      /** Server URL, e.g. `https://cloud.example.org/remote.php/dav/files/ann`. */
      url: string;
      username: string;
      /** Route requests through the WebDAV relay (servers without CORS). */
      relay: boolean;
    }
  | {
      id: Id;
      kind: GitProviderKind;
      label: string;
      /** API/git host, e.g. `github.com` or a self-hosted Forgejo host. */
      host: string;
      account?: string;
    };

export type Credential =
  | { kind: 'oauth'; accessToken: string; refreshToken: string | null; expiresAt: number | null }
  | { kind: 'token'; token: string; username?: string }
  | { kind: 'password'; username: string; password: string };

/**
 * Secrets at rest (PLAN §8A.2 security): encrypted with a non-extractable AES-GCM WebCrypto key
 * kept in IndexedDB, so no token is ever readable in plain text from storage. Never synced, never
 * logged, never sent anywhere but the provider (or the stateless token-exchange Worker).
 */
export interface CredentialVault {
  get(connectionId: Id): Promise<Credential | null>;
  set(connectionId: Id, credential: Credential): Promise<void>;
  remove(connectionId: Id): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// File providers
// ---------------------------------------------------------------------------------------------

export interface RemoteEntry {
  kind: 'file' | 'folder' | 'deleted';
  /** Absolute in the service, original case, `/`-separated: `/CAD/bracket/params.json`. */
  path: string;
  /** Files only: the service's version (Dropbox rev, Graph eTag, WebDAV ETag, mtime+size). */
  rev?: string;
  size?: number;
}

export interface RemoteListing {
  entries: RemoteEntry[];
  cursor: string;
  /** `entries` is everything under the folder now (not a delta), so anything missing is deleted. */
  complete: boolean;
}

export interface RemoteFolder {
  name: string;
  path: string;
  /** The folder holds a `whittle.project.json` (shown as a project in the picker). */
  isProject: boolean;
}

/**
 * One service's files. Optimistic concurrency everywhere: a write or delete with `ifRev` succeeds
 * only if the service still has that revision, else `CONFLICT`; `ifRev: null` means "only if it
 * doesn't exist yet". Providers never overwrite blindly.
 */
export interface StorageProvider {
  readonly kind: FileProviderKind;
  /** Paths differing only in case are different files (WebDAV usually; Dropbox, OneDrive no). */
  readonly caseSensitive: boolean;
  /** Poll interval while the app is open and focused, ms (deltas: 60 s; WebDAV listing: 300 s). */
  readonly pollMs: number;
  /** Everything under `path`, or what changed since `cursor`. */
  list(start: { path: string } | { cursor: string }): Promise<StorageResult<RemoteListing>>;
  read(path: string): Promise<StorageResult<{ bytes: Uint8Array; rev: string }>>;
  write(
    path: string,
    bytes: Uint8Array,
    ifRev: string | null,
  ): Promise<StorageResult<{ rev: string }>>;
  /** Missing files are fine. */
  remove(path: string, ifRev: string | null): Promise<StorageResult<void>>;
  /** Subfolders of `path` (`''`: the top) for the folder picker. */
  browse(path: string): Promise<StorageResult<RemoteFolder[]>>;
}

// ---------------------------------------------------------------------------------------------
// Background sync (file providers)
// ---------------------------------------------------------------------------------------------

/** A local project linked to a folder in a connection. Stored with the library entry. */
export interface ProjectLink {
  connectionId: Id;
  /** The project folder in the service, e.g. `/CAD/bracket`. */
  path: string;
}

/** What the last agreed sync saw for one file: its revision and bytes (the merge base). */
export interface SyncBase {
  rev: string;
  /** SHA-256 hex of the bytes. */
  hash: string;
}

/** Persistent per-project sync state (IndexedDB). Base bytes live beside it, keyed by hash. */
export interface SyncState {
  link: ProjectLink;
  cursor: string | null;
  /** By project-relative path (`parts/bracket.part.json`). */
  bases: Record<string, SyncBase>;
  /** Project-relative paths edited locally and not yet uploaded (the offline queue). */
  pending: string[];
  lastSyncAt?: string;
}

export type SyncStatus =
  | { state: 'local' }
  | { state: 'idle'; lastSyncAt?: string; pending: number }
  | { state: 'syncing'; phase: 'listing' | 'pulling' | 'merging' | 'pushing'; ratio: number | null }
  | { state: 'offline'; pending: number }
  | { state: 'conflicts'; merge: MergeResult }
  | { state: 'error'; error: StorageError };

export interface SyncOutcome {
  pulled: number;
  pushed: number;
  /** Paths whose remote and local edits merged without conflict. */
  merged: string[];
  /** The merged project, when anything remote changed (the app loads it as one undo step). */
  files?: ProjectFiles;
  /** Unresolved conflicts: nothing conflicting is uploaded until they are resolved. */
  merge?: MergeResult;
}

/**
 * Two-way sync of one project (Mycelium `syncFolder`, structural merge). Pull first: files not
 * edited here are replaced; files edited on both sides merge three-way against the base with
 * `DocMerger`; only real overlaps become conflicts. Then push local edits against the base's
 * revision, so a write racing another device fails with `CONFLICT` and the next round merges it.
 * The `.whittle/` cache is never synced. `.whittle-history/` files are append-only and merge by
 * union (see `SnapshotHistory`).
 */
export interface SyncEngine {
  status(): SyncStatus;
  subscribe(listener: (status: SyncStatus) => void): () => void;
  /** Local save happened; push after edits settle (debounce, default 3 s). */
  notifyLocalChange(paths: readonly string[]): void;
  /** Sync now (window focus, reconnect, poll tick, the user's "Sync" button). */
  syncNow(): Promise<StorageResult<SyncOutcome>>;
  /** Applies the user's conflict choices, then pushes. */
  resolve(resolutions: readonly MergeResolution[]): Promise<StorageResult<SyncOutcome>>;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Structural merge and feature diff
// ---------------------------------------------------------------------------------------------

/** What a conflict or change is about, for display ("Fillet 3", "Parameter width"). */
export interface DiffSubject {
  kind:
    | 'doc'
    | 'param'
    | 'part'
    | 'material'
    | 'feature'
    | 'sketchEntity'
    | 'sketchConstraint'
    | 'drawing'
    | 'assembly';
  id?: Id;
  partId?: Id;
  /** For sketch entities and constraints: the sketch feature. */
  featureId?: Id;
  /** For features: its type, so the UI can show the feature's icon. */
  featureType?: FeatureType;
  /** Display name at the time of the change: "Fillet 3", "width", "Line 2 in Sketch 1". */
  label: string;
}

export type MergeConflictKind =
  /** Both sides changed the same leaf (a parameter's expression, a feature's radius). */
  | 'bothModified'
  /** One side changed what the other deleted. */
  | 'modifiedDeleted'
  /** Both sides added the same id with different content (rare: ULIDs). */
  | 'bothAdded'
  /** Both sides reordered the same list differently (feature order). */
  | 'order';

export interface MergeConflict {
  /** Stable within one `MergeResult`. */
  id: string;
  kind: MergeConflictKind;
  /** JSON pointer in the document; ids, not indices, select array items (`/parts/<id>/features/<id>/radius`). */
  path: JsonPointer;
  /**
   * Whole-file conflict (a non-JSON project file, e.g. `imports/bracket.step`, edited on both
   * sides): its project-relative path. `base`/`ours`/`theirs` then hold the file bytes.
   */
  file?: string;
  subject: DiffSubject;
  /** Absent: that side doesn't have it (deleted, or not yet added). */
  base?: unknown;
  ours?: unknown;
  theirs?: unknown;
}

export type MergeResolution =
  | { conflictId: string; take: 'ours' | 'theirs' | 'base' }
  /** A hand-entered value (e.g. a new expression for a parameter both sides changed). */
  | { conflictId: string; value: unknown };

export interface MergeResult {
  /** The merged document with "ours" in every conflicting place until resolved. */
  doc: WhittleDoc;
  conflicts: MergeConflict[];
  /** Number of non-conflicting changes taken from "theirs". */
  autoMerged: number;
}

/**
 * Three-way merge of the document tree keyed by stable id (PLAN §8A.3). Arrays of identified
 * items (features, params, entities, constraints, parts) merge as id-keyed maps plus an order;
 * non-overlapping edits merge automatically; both sides editing the same leaf conflicts; an
 * unchanged side's order is taken, two different reorders conflict (`order`). `meta.modified`
 * takes the later of the two and never conflicts. The result is always schema-valid; references
 * broken by the merge surface as "needs attention" on regen, never as a silent re-pick.
 */
export interface DocMerger {
  merge(base: WhittleDoc, ours: WhittleDoc, theirs: WhittleDoc): MergeResult;
  /** Applies resolutions; conflicts not mentioned keep "ours". */
  resolve(result: MergeResult, resolutions: readonly MergeResolution[]): WhittleDoc;
}

export interface FieldChange {
  /** Pointer relative to the subject, e.g. `/radius` or `/definition/distance`. */
  path: JsonPointer;
  /** "radius", "distance". */
  label: string;
  before?: unknown;
  after?: unknown;
}

export interface DiffChange {
  kind: 'added' | 'removed' | 'modified' | 'moved' | 'renamed';
  subject: DiffSubject;
  fields?: FieldChange[];
  /** One line for the compare panel: "Fillet 3: radius 2 mm → 3 mm". */
  summary: string;
}

/** Feature-level diff between two documents (compare panel, merge preview). */
export interface DocDiffer {
  diff(before: WhittleDoc, after: WhittleDoc): DiffChange[];
}

// ---------------------------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------------------------

export interface Author {
  name: string;
  email?: string;
}

export interface Version {
  /** Git commit oid, or the snapshot's id (ULID). */
  id: string;
  parents: string[];
  message: string;
  author: Author;
  /** ISO-8601. */
  at: string;
  /** SHA-256 hex over the canonical project files (identical content → identical hash). */
  hash: string;
  /** Automatic local snapshot (pruned over time; hidden by default in the versions panel). */
  auto?: boolean;
  /** Release names pointing at this version ("Rev A"). */
  releases?: string[];
}

export interface Branch {
  name: string;
  head: string;
  current: boolean;
  /** Git: the remote-tracking state. */
  ahead?: number;
  behind?: number;
}

export interface Release {
  /** "Rev A". Unique per project. */
  name: string;
  versionId: string;
  at: string;
  author: Author;
  /** Frozen exports under `releases/<slug>/` (STEP, PDF). Read-only once released. */
  files: string[];
}

export interface PrunePolicy {
  /** Keep every automatic snapshot this recent (default 1 day). */
  keepAllForMs: number;
  /** Then one per hour for (default 7 days), then one per day. */
  hourlyForMs: number;
}

/**
 * One history interface, two backends (PLAN §8A.3). Named versions are never pruned; releases
 * are read-only. Switching branches returns the files to load (regen comes from the cache).
 */
export interface HistoryStore {
  readonly backend: 'git' | 'snapshot';
  log(options?: { branch?: string; limit?: number; includeAuto?: boolean }): Promise<Version[]>;
  /** Records the current files. Returns the existing head when nothing changed (same hash). */
  saveVersion(
    files: ProjectFiles,
    message: string,
    options: { author: Author; auto?: boolean },
  ): Promise<StorageResult<Version>>;
  read(versionId: string): Promise<StorageResult<ProjectFiles>>;
  branches(): Promise<Branch[]>;
  /** "Try an idea": a branch from `from` (default: the current head). Doesn't switch. */
  createBranch(name: string, from?: string): Promise<StorageResult<Branch>>;
  switchBranch(name: string): Promise<StorageResult<ProjectFiles>>;
  /** Nearest common ancestor, for three-way merge. */
  mergeBase(a: string, b: string): Promise<string | null>;
  /** Records a merge version with both parents (after `DocMerger` and the user's resolutions). */
  commitMerge(
    files: ProjectFiles,
    message: string,
    parents: [string, string],
    author: Author,
  ): Promise<StorageResult<Version>>;
  release(
    versionId: string,
    name: string,
    exports: ProjectFiles,
    author: Author,
  ): Promise<StorageResult<Release>>;
  releases(): Promise<Release[]>;
  /** Removes old automatic snapshots per policy; returns how many were removed. */
  prune(policy?: Partial<PrunePolicy>): Promise<number>;
}

/**
 * Cloud drives and local-only projects: snapshots in `.whittle-history/` (docs/FILE_FORMAT.md),
 * synced with the project. Every file there is immutable and content-addressed or append-only
 * (`versions/<id>.json`, `snapshots/<hash>.zip`, `refs/…/<name>/<versionId>`), so two devices
 * adding versions offline merge by union with no conflicts. A branch with two heads after a sync
 * shows as diverged and offers a merge.
 */
export interface SnapshotHistory extends HistoryStore {
  readonly backend: 'snapshot';
}

export interface GitProgress {
  phase: string;
  loaded: number;
  total?: number;
}

export type GitPullResult =
  | { kind: 'upToDate' }
  | { kind: 'fastForward'; files: ProjectFiles }
  | { kind: 'merged'; files: ProjectFiles; version: Version }
  /** Nothing is committed until the user resolves them. */
  | { kind: 'conflicts'; merge: MergeResult; theirs: string };

export type GitPushResult =
  | { kind: 'pushed' }
  | { kind: 'rejected'; reason: 'behind' | 'protected' };

/** Git connections (isomorphic-git; Mycelium `GitRepo`). Branches are git branches; releases are tags. */
export interface GitHistory extends HistoryStore {
  readonly backend: 'git';
  clone(onProgress?: (p: GitProgress) => void): Promise<StorageResult<ProjectFiles>>;
  fetch(
    onProgress?: (p: GitProgress) => void,
  ): Promise<StorageResult<{ ahead: number; behind: number }>>;
  pull(onProgress?: (p: GitProgress) => void): Promise<StorageResult<GitPullResult>>;
  push(onProgress?: (p: GitProgress) => void): Promise<StorageResult<GitPushResult>>;
}

// ---------------------------------------------------------------------------------------------
// Geometric compare (kernel; see ModelingApi.compare)
// ---------------------------------------------------------------------------------------------

/**
 * Regen slots let the kernel worker hold a second regeneration of a part (another version)
 * beside the live one, with its own cache. `'main'` is the live model.
 */
export type RegenSlot = 'main' | `version:${string}`;

/** Added and removed material between two regenerations of a part (A = before, B = after). */
export interface GeometricDiff {
  /**
   * B − A: material that B adds (shown green). Each side's solids are unioned first; one mesh per
   * non-empty difference (several disjoint regions may share one mesh).
   */
  added: MeshBuffers[];
  /** A − B: material that B removes (shown red). */
  removed: MeshBuffers[];
  /** mm³. */
  addedVolume: number;
  removedVolume: number;
  /** Mass properties and bounding box of each side (deltas shown in the compare panel). */
  a: { mass: MassProperties; bbox: { min: Vec3; max: Vec3 } };
  b: { mass: MassProperties; bbox: { min: Vec3; max: Vec3 } };
  /** Non-fatal notes, e.g. mesh-only (imported STL) bodies left out of the booleans. */
  warnings?: KernelError[];
}
