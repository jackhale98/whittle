// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/auth/oauth.ts (cloud sign-in: Dropbox and Microsoft).
/**
 * Sign in to Dropbox, OneDrive/SharePoint or Google Drive with OAuth 2 authorization code + PKCE, using
 * full-page **redirects, not popups**: Wren is cross-origin isolated (COOP `same-origin`,
 * ADR-010), which severs `window.opener`, so a popup could never report back.
 *
 * 1. `beginSignIn` keeps the PKCE verifier and state in `sessionStorage` (this tab only; the
 *    verifier is useless without the one-time code) and leaves for the provider.
 * 2. The provider returns to the callback page, which calls `completeSignIn`: it checks the
 *    state, trades the code for tokens (directly with Dropbox and Microsoft, with no secret;
 *    through the Worker for Google) and stores them **only in the `CredentialVault`**
 *    (encrypted). Only after that succeeds is the callback query (`code`, `state`) stripped
 *    from the address bar. Nothing secret is left in `sessionStorage`; the app picks up a
 *    non-secret result with `takeSignInResult`.
 */

import type { CredentialVault, Id, StorageResult } from '@wren-cad/contracts';
import { ulid } from '@wren-cad/document';
import { defaultFetch, type Fetcher, fail, forward, ok } from '../providers/common';
import { dropboxAuthorizeUrl, exchangeDropboxCode } from '../providers/dropbox';
import {
  exchangeMicrosoftCode,
  microsoftAuthorizeUrl,
  ONEDRIVE_SCOPES,
  SHAREPOINT_SCOPES,
} from '../providers/onedrive';
import { exchangeGoogleCode, googleAuthorizeUrl } from './google';
import { challengeFor, randomString } from './pkce';
import type { OAuthConfig, OAuthCredential, OAuthService } from './types';

const PENDING_KEY = 'whittle:oauth-pending';
const RESULT_KEY = 'whittle:oauth-result';
/** A sign-in left unfinished for longer than this has expired. */
const PENDING_TTL_MS = 15 * 60_000;

/** `sessionStorage`, or a stand-in in tests. */
export interface SignInStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PendingSignIn {
  service: OAuthService;
  state: string;
  verifier: string;
  redirectUri: string;
  returnTo: string;
  /** Microsoft: the scopes asked for (the token request repeats them). */
  scopes?: string;
  /** Signing in again for this connection. */
  renew?: Id;
  startedAt: number;
}

/** What a finished sign-in leaves for the app. No secrets: the tokens are in the vault. */
export interface SignInResult {
  service: OAuthService;
  /** The vault entry holding the tokens: a new id, or the renewed connection's id. */
  connectionId: Id;
  /** `true` when this signed in again for an existing connection. */
  renewed: boolean;
  /** OneDrive: SharePoint sites can be searched (the SharePoint scopes were granted). */
  sharepoint: boolean;
  returnTo: string;
}

export interface BeginSignInOptions {
  /** Where the app goes after the callback (e.g. `/#/connections`). */
  returnTo: string;
  /** Sign in again for this connection (its vault entry is replaced). */
  renew?: Id;
  /** OneDrive: also ask for SharePoint document libraries (work accounts). */
  sharepoint?: boolean;
}

export interface SignInEnv {
  storage?: SignInStorage;
  /** Leaves the page (default `location.assign`). */
  navigate?: (url: string) => void;
  now?: () => number;
}

const session = (env: SignInEnv): SignInStorage => env.storage ?? globalThis.sessionStorage;

/** Services this build can sign in to (a missing key hides the provider, ADR-020 §9). */
export function availableServices(config: OAuthConfig): OAuthService[] {
  const out: OAuthService[] = [];
  if (config.dropboxAppKey) out.push('dropbox');
  if (config.onedriveClientId) out.push('onedrive');
  if (config.gdriveClientId && config.tokenExchange) out.push('gdrive');
  return out;
}

/** Leaves for the provider's sign-in page (full-page redirect). */
export async function beginSignIn(
  service: OAuthService,
  config: OAuthConfig,
  options: BeginSignInOptions,
  env: SignInEnv = {},
): Promise<StorageResult<void>> {
  const pending: PendingSignIn = {
    service,
    state: randomString(16),
    verifier: randomString(48),
    redirectUri: config.redirectUri,
    returnTo: options.returnTo,
    startedAt: (env.now ?? Date.now)(),
    ...(options.renew ? { renew: options.renew } : {}),
  };
  const challenge = await challengeFor(pending.verifier);
  let url: string;
  if (service === 'dropbox') {
    if (!config.dropboxAppKey) return fail('REMOTE', 'Dropbox isn’t set up for this site.');
    url = dropboxAuthorizeUrl(config.dropboxAppKey, config.redirectUri, pending.state, challenge);
  } else if (service === 'gdrive') {
    if (!config.gdriveClientId || !config.tokenExchange) {
      return fail('REMOTE', 'Google Drive isn’t set up for this site.');
    }
    url = googleAuthorizeUrl(config.gdriveClientId, config.redirectUri, pending.state, challenge);
  } else {
    if (!config.onedriveClientId) return fail('REMOTE', 'OneDrive isn’t set up for this site.');
    pending.scopes = options.sharepoint ? SHAREPOINT_SCOPES : ONEDRIVE_SCOPES;
    url = microsoftAuthorizeUrl(
      config.onedriveClientId,
      config.redirectUri,
      pending.state,
      challenge,
      pending.scopes,
    );
  }
  session(env).setItem(PENDING_KEY, JSON.stringify(pending));
  (env.navigate ?? ((u: string) => globalThis.location.assign(u)))(url);
  return ok(undefined);
}

/** Is a sign-in started in this tab waiting for its callback? */
export function hasPendingSignIn(env: SignInEnv = {}): boolean {
  try {
    return session(env).getItem(PENDING_KEY) !== null;
  } catch {
    return false;
  }
}

export interface CompleteSignInDeps extends SignInEnv {
  vault: CredentialVault;
  fetch?: Fetcher;
  /** New connection ids (default: ULIDs). */
  newId?: () => Id;
  /**
   * Removes the callback query from the address bar, called only once the tokens are safely in
   * the vault (default: `history.replaceState` without `code`, `state` and error parameters).
   */
  clearCallback?: () => void;
}

const CALLBACK_PARAMS = ['code', 'state', 'scope', 'error', 'error_description', 'session_state'];

/** `history.replaceState` to the same URL without the OAuth callback parameters. */
export function stripCallbackQuery(): void {
  const loc = globalThis.location;
  const hist = globalThis.history;
  if (!loc || !hist?.replaceState) return;
  const url = new URL(loc.href);
  for (const k of CALLBACK_PARAMS) url.searchParams.delete(k);
  hist.replaceState(hist.state, '', `${url.pathname}${url.search}${url.hash}`);
}

/**
 * On the callback page: check the state, trade the code for tokens and put them in the vault.
 * Returns where to go next (and leaves the same non-secret result for `takeSignInResult`).
 */
export async function completeSignIn(
  params: URLSearchParams,
  config: OAuthConfig,
  deps: CompleteSignInDeps,
): Promise<StorageResult<SignInResult>> {
  const store = session(deps);
  const raw = store.getItem(PENDING_KEY);
  store.removeItem(PENDING_KEY);
  if (!raw) return fail('AUTH', 'This sign-in has expired. Start again from Wren.');
  let pending: PendingSignIn;
  try {
    pending = JSON.parse(raw) as PendingSignIn;
  } catch {
    return fail('AUTH', 'This sign-in has expired. Start again from Wren.');
  }
  const now = (deps.now ?? Date.now)();
  if (!(now - pending.startedAt <= PENDING_TTL_MS)) {
    return fail('AUTH', 'This sign-in has expired. Start again from Wren.');
  }
  const error = params.get('error');
  if (error) {
    const why = params.get('error_description') || error;
    return fail(error === 'access_denied' ? 'PERMISSION' : 'AUTH', `Sign-in didn’t finish: ${why}`);
  }
  if (params.get('state') !== pending.state) {
    return fail('AUTH', 'Sign-in state mismatch. Start again from Wren.');
  }
  const code = params.get('code');
  if (!code) return fail('AUTH', 'No authorization code came back.');
  const fetcher = deps.fetch ?? defaultFetch;
  let tokens: StorageResult<OAuthCredential>;
  if (pending.service === 'dropbox') {
    if (!config.dropboxAppKey) return fail('REMOTE', 'Dropbox isn’t set up for this site.');
    tokens = await exchangeDropboxCode(
      {
        appKey: config.dropboxAppKey,
        code,
        verifier: pending.verifier,
        redirectUri: pending.redirectUri,
      },
      fetcher,
      now,
    );
  } else if (pending.service === 'gdrive') {
    if (!config.tokenExchange) return fail('REMOTE', 'Google Drive isn’t set up for this site.');
    tokens = await exchangeGoogleCode(
      config.tokenExchange,
      { code, verifier: pending.verifier, redirectUri: pending.redirectUri },
      now,
    );
  } else {
    if (!config.onedriveClientId) return fail('REMOTE', 'OneDrive isn’t set up for this site.');
    tokens = await exchangeMicrosoftCode(
      {
        clientId: config.onedriveClientId,
        code,
        verifier: pending.verifier,
        redirectUri: pending.redirectUri,
        scopes: pending.scopes ?? ONEDRIVE_SCOPES,
      },
      fetcher,
      now,
    );
  }
  if (!tokens.ok) return forward(tokens);
  const connectionId = pending.renew ?? (deps.newId ?? (() => ulid()))();
  await deps.vault.set(connectionId, tokens.value);
  const result: SignInResult = {
    service: pending.service,
    connectionId,
    renewed: !!pending.renew,
    sharepoint: !!pending.scopes?.includes('Sites.Read.All'),
    returnTo: pending.returnTo,
  };
  store.setItem(RESULT_KEY, JSON.stringify(result));
  (deps.clearCallback ?? stripCallbackQuery)();
  return ok(result);
}

/** Picks up a sign-in left by the callback page (once). */
export function takeSignInResult(env: SignInEnv = {}): SignInResult | null {
  try {
    const store = session(env);
    const raw = store.getItem(RESULT_KEY);
    if (!raw) return null;
    store.removeItem(RESULT_KEY);
    return JSON.parse(raw) as SignInResult;
  } catch {
    return null;
  }
}
