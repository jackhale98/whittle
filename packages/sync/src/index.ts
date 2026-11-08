// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @whittle/sync — connections, sync and version control (PLAN §8A, ADR-020).
 *
 *  - Structural merge and feature diff: `docMerger`, `docDiffer`, `mergeProjectFiles`
 *  - Snapshot history (`.whittle-history/`): `createSnapshotHistory`, `MemoryHistoryFiles`
 *  - Git history (isomorphic-git): `createGitHistory`
 */

export { type HistoryFiles, MemoryHistoryFiles } from './history/files';
export { type BasicAuth, basicAuth, type GitHost, retryAuth } from './history/git/auth';
export { browserGitFs } from './history/git/browser-fs';
export {
  corsProxyFor,
  createGitHistory,
  DEFAULT_CORS_PROXY,
  type GitHistoryOptions,
  gitError,
  ownedPath,
} from './history/git/git';
export {
  CACHE_PREFIX,
  HISTORY_PREFIX,
  hashProjectFiles,
  isVersionedPath,
  sha256Hex,
  versionedFiles,
} from './history/hash';
export { decodeName, encodeName, gitRefName, nameProblem } from './history/names';
export {
  DAY_MS,
  DEFAULT_PRUNE_POLICY,
  HOUR_MS,
  type PruneCandidate,
  selectPrunable,
} from './history/prune';
export {
  createSnapshotHistory,
  type SnapshotHistoryOptions,
  type SnapshotLocalState,
} from './history/snapshot';
export { docDiffer, FeatureDiffer, movedIds } from './merge/diff';
export {
  FILES_POINTER,
  fileConflictId,
  isModelPath,
  mergeProjectFiles,
  type ProjectMerge,
  resolveProjectFiles,
} from './merge/files';
export { formatValue, prettyExpr } from './merge/format';
export { subjectAt } from './merge/labels';
export {
  conflictId,
  docMerger,
  MergeResolutionError,
  StructuralMerger,
  weave,
} from './merge/merge';
export { COLLECTIONS, fromPointer, getAtSegs, isCollectionPath, toPointer } from './merge/tree';
