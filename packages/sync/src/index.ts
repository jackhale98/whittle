// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @whittle/sync — connections, sync and version control (PLAN §8A, ADR-020). Provider adapters,
 * auth flows, conflict handling and the git wrapper are ported from Mycelium (same author,
 * GPL-3.0-or-later).
 *
 *  - Providers, credential vault, OAuth PKCE and the sync engine
 *  - Structural merge and feature diff: `docMerger`, `docDiffer`, `mergeProjectFiles`
 *  - Snapshot history (`.whittle-history/`): `createSnapshotHistory`, `MemoryHistoryFiles`
 *  - Git history (isomorphic-git): `createGitHistory`
 */

// Auth
export {
  exchangeGoogleCode,
  GOOGLE_SCOPES,
  googleAuthorizeUrl,
  refreshGoogleToken,
  workerTokenExchange,
} from './auth/google';
export {
  availableServices,
  type BeginSignInOptions,
  beginSignIn,
  type CompleteSignInDeps,
  completeSignIn,
  hasPendingSignIn,
  type SignInEnv,
  type SignInResult,
  type SignInStorage,
  stripCallbackQuery,
  takeSignInResult,
} from './auth/oauth';
export { base64url, challengeFor, randomString } from './auth/pkce';
export {
  oauthTokenSource,
  type Refresher,
  refresherFor,
  staticToken,
  type TokenSourceOptions,
} from './auth/tokens';
export type {
  OAuthConfig,
  OAuthCredential,
  OAuthService,
  TokenEndpointBody,
  TokenExchange,
} from './auth/types';
// Engine
export {
  browserEnvironment,
  createSyncEngine,
  type ProjectSyncEngine,
  type SyncEngineOptions,
  type SyncEnvironment,
} from './engine/engine';
export { bytesEqual, sha256Hex } from './engine/hash';
export { closeSyncDatabases, createIdbSyncStore } from './engine/idb-store';
export {
  combineConflicts,
  fileConflictPath,
  NO_BASE,
  STALE_REV,
  type SyncPhase,
} from './engine/round';
export {
  type CheckPace,
  MAX_WAIT,
  nextCheckDelay,
  SAVE_DATA_MAX_WAIT,
  SAVE_DATA_WAIT,
} from './engine/schedule';
export { type FileChanges, MemorySyncStore, type SyncLocalStore } from './engine/store';
// Merge, diff and history
export { type HistoryFiles, MemoryHistoryFiles } from './history/files';
export { type BasicAuth, basicAuth, type GitHost, retryAuth } from './history/git/auth';
export { browserGitFs } from './history/git/browser-fs';
export { FsaPromises, FsaStats, FsError, type FsErrorCode, fsaGitFs } from './history/git/fsa-fs';
export {
  corsProxyFor,
  createGitHistory,
  DEFAULT_CORS_PROXY,
  type GitHistoryOptions,
  gitError,
  gitRemoteHeads,
  ownedPath,
} from './history/git/git';
export { browserGitHttp } from './history/git/http';
export { type LfsPointer, lfsPointer, matchesLfs } from './history/git/lfs';
export {
  type LocalGitRepo,
  type LocalGitRepoOptions,
  type LocalRepoProblem,
  type LocalRepoState,
  openLocalGitRepo,
  sharedGitPath,
  worktreeGitFs,
} from './history/git/local';
export { normalizeProjectPath, ProjectScope } from './history/git/scope';
export { projectStatus, type StatusCounters, type WorkingChange } from './history/git/status';
export {
  CACHE_PREFIX,
  HISTORY_PREFIX,
  hashProjectFiles,
  isVersionedPath,
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
// Project file rules
export { documentPaths, HISTORY_DIR, syncable, toAbsolute, toRelative } from './paths';
// Providers
export {
  type Fetcher,
  fail,
  ok,
  type TokenGetter,
} from './providers/common';
export { createProvider, type ProviderDeps, SERVICE_NAMES, serviceLabel } from './providers/create';
export {
  apiArg,
  DROPBOX_SCOPES,
  DropboxProvider,
  dropboxAuthorizeUrl,
  exchangeDropboxCode,
  refreshDropboxToken,
} from './providers/dropbox';
export {
  type FolderFileHandle,
  type FolderHandle,
  FolderProvider,
  folderPermission,
} from './providers/folder';
export { loadFolderHandle, removeFolderHandle, saveFolderHandle } from './providers/folder-handles';
export { GDRIVE_AVAILABLE, GDRIVE_SCOPES, GoogleDriveProvider } from './providers/gdrive';
export { MemoryProvider, type MemoryProviderOptions } from './providers/memory';
export {
  type DriveChoice,
  exchangeMicrosoftCode,
  GraphAccount,
  graphPath,
  microsoftAuthorizeUrl,
  ONEDRIVE_SCOPES,
  OneDriveProvider,
  parentPath,
  refreshMicrosoftToken,
  SHAREPOINT_SCOPES,
} from './providers/onedrive';
export {
  type DavEntry,
  nextcloudUrl,
  parseMultistatus,
  type WebDavConfig,
  WebDavProvider,
} from './providers/webdav';
// Credentials
export {
  type CredentialVaultOptions,
  createCredentialVault,
  IdbCredentialVault,
  MemoryCredentialVault,
} from './vault/vault';
