// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential, StorageResult } from '@wren-cad/contracts';

/** An OAuth sign-in as kept in the `CredentialVault`. */
export type OAuthCredential = Extract<Credential, { kind: 'oauth' }>;

/**
 * Services that sign in with OAuth 2 + PKCE through a full-page redirect. Dropbox and Microsoft
 * trade the code in the browser (no secret); Google's web clients need a secret, so Google's code
 * goes through the Worker (`TokenExchange`).
 */
export type OAuthService = 'dropbox' | 'onedrive' | 'gdrive';

/** A token endpoint's JSON answer (RFC 6749 §5). */
export interface TokenEndpointBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Trades a code or a refresh token through the stateless Worker, which adds the client secret:
 * `POST <worker>/oauth/<provider>/token { code, code_verifier, redirect_uri }` and
 * `POST <worker>/oauth/<provider>/refresh { refresh_token }`. See `workerTokenExchange`.
 */
export type TokenExchange = (
  provider: 'google',
  action: 'token' | 'refresh',
  body: Record<string, string>,
) => Promise<StorageResult<TokenEndpointBody>>;

/**
 * Public app identifiers and URLs, injected by the app from build-time config (ADR-020 §9;
 * apps/web `sync-config.ts`). Not secrets. A missing key hides that provider instead of failing.
 */
export interface OAuthConfig {
  /** Dropbox app key. */
  dropboxAppKey?: string | undefined;
  /** Microsoft Entra application (client) ID, registered as a single-page application. */
  onedriveClientId?: string | undefined;
  /** Google OAuth client ID (web application). Needs `tokenExchange` too. */
  gdriveClientId?: string | undefined;
  /** Google's code and refresh exchange through the Worker. */
  tokenExchange?: TokenExchange | undefined;
  /** The callback page (apps/web `oauthRedirectUri()`). Must be registered with each provider. */
  redirectUri: string;
}
