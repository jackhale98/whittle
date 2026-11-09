// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/sync/workspace.ts (`#token`, `#refresh`) and services.ts (`refreshTokens`).
/**
 * Access tokens for a connection, read from the `CredentialVault` and refreshed shortly before
 * they expire (or when a provider got a 401 and asks with `force`). Parallel requests share one
 * refresh. A refreshed sign-in goes straight back into the vault; tokens are never cached
 * anywhere else.
 */

import type { CredentialVault, Id, StorageResult } from '@wren-cad/contracts';
import {
  defaultFetch,
  type Fetcher,
  fail,
  forward,
  ok,
  type TokenGetter,
} from '../providers/common';
import { refreshDropboxToken } from '../providers/dropbox';
import { refreshMicrosoftToken } from '../providers/onedrive';
import { refreshGoogleToken } from './google';
import type { OAuthConfig, OAuthCredential, OAuthService } from './types';

export type Refresher = (refreshToken: string) => Promise<StorageResult<OAuthCredential>>;

export interface TokenSourceOptions {
  connectionId: Id;
  vault: CredentialVault;
  refresh: Refresher;
  /** Service name for messages ("Dropbox"). */
  service: string;
  now?: () => number;
  /** Refresh this long before expiry (default 60 s). */
  marginMs?: number;
}

/** A `TokenGetter` for providers: the vault's access token, refreshed when due. */
export function oauthTokenSource(options: TokenSourceOptions): TokenGetter {
  const now = options.now ?? Date.now;
  const margin = options.marginMs ?? 60_000;
  let refreshing: Promise<StorageResult<OAuthCredential>> | null = null;

  const signedOut = (): StorageResult<never> =>
    fail('AUTH', `${options.service} signed you out. Sign in again.`);

  const refresh = (current: OAuthCredential & { refreshToken: string }) => {
    refreshing ??= (async () => {
      const next = await options.refresh(current.refreshToken);
      if (!next.ok) return next;
      const saved: OAuthCredential = {
        ...next.value,
        refreshToken: next.value.refreshToken ?? current.refreshToken,
      };
      await options.vault.set(options.connectionId, saved);
      return ok(saved);
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  return async (force = false) => {
    const cred = await options.vault.get(options.connectionId);
    if (cred?.kind !== 'oauth') return signedOut();
    const due = cred.expiresAt !== null && cred.expiresAt - margin < now();
    if (!force && !due) return ok(cred.accessToken);
    if (!cred.refreshToken) {
      // Can't renew: use what we have until the service refuses it.
      return force || (cred.expiresAt !== null && cred.expiresAt < now())
        ? signedOut()
        : ok(cred.accessToken);
    }
    const next = await refresh({ ...cred, refreshToken: cred.refreshToken });
    if (next.ok) return ok(next.value.accessToken);
    // Offline isn't signed out; a refused refresh token is.
    if (next.error.code === 'AUTH') return signedOut();
    return forward(next);
  };
}

/** The refresh call for a service, from the build's public app identifiers. */
export function refresherFor(
  service: OAuthService,
  config: OAuthConfig,
  fetcher: Fetcher = defaultFetch,
): Refresher {
  if (service === 'dropbox') {
    return (rt) => refreshDropboxToken(config.dropboxAppKey ?? '', rt, fetcher);
  }
  if (service === 'gdrive') {
    const exchange = config.tokenExchange;
    return async (rt) =>
      exchange
        ? refreshGoogleToken(exchange, rt)
        : fail('AUTH', 'Google Drive isn’t set up for this site.');
  }
  return (rt) => refreshMicrosoftToken(config.onedriveClientId ?? '', rt, fetcher);
}

/** A static token (WebDAV app passwords use Basic auth instead; this is for tokens). */
export function staticToken(token: string): TokenGetter {
  return async (force = false) =>
    force ? fail('AUTH', 'The token was refused. Enter a new one.') : ok(token);
}
