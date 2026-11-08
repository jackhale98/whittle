// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @whittle/sync — connections and background sync (PLAN §8A, ADR-020). Provider adapters, auth
 * flows and conflict handling are ported from Mycelium (same author, GPL-3.0-or-later).
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
