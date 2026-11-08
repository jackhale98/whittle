// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/auth/oauth.ts (`post`, `toTokenSet`: the Worker token exchange).
/**
 * Google sign-in for Drive (`drive.file` scope only: files Whittle created or the user opened
 * with it). Google's web-application clients need a client secret to trade a code, so the code
 * (with the PKCE verifier) goes through the Worker's `/oauth/google/token`, which adds the secret
 * and keeps nothing. Google Identity Services isn't loaded: it would break self-hosting and COEP.
 */

import type { StorageResult } from '@whittle/contracts';
import { defaultFetch, type Fetcher, fail, forward, ok, request } from '../providers/common';
import type { OAuthCredential, TokenEndpointBody, TokenExchange } from './types';

export const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/drive.file';

export function googleAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const url = new URL(GOOGLE_AUTHORIZE);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', GOOGLE_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // A refresh token comes back only for offline access, and only with consent shown.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

/**
 * The Worker's token routes. Answers may be JSON or form-encoded (GitHub-style), and error bodies
 * are passed through so the provider's message reaches the user.
 */
export function workerTokenExchange(
  workerUrl: string,
  fetcher: Fetcher = defaultFetch,
): TokenExchange {
  const base = workerUrl.replace(/\/+$/, '');
  return async (provider, action, payload) => {
    const r = await request(fetcher, 'The sign-in service', `${base}/oauth/${provider}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return forward(r);
    const text = await r.value.text();
    let parsed: TokenEndpointBody;
    try {
      parsed = JSON.parse(text) as TokenEndpointBody;
    } catch {
      const form = Object.fromEntries(new URLSearchParams(text)) as Record<string, string>;
      parsed = { ...form, ...(form.expires_in ? { expires_in: Number(form.expires_in) } : {}) };
    }
    if (!r.value.ok && !parsed.error) parsed.error = `HTTP ${r.value.status}`;
    return ok(parsed);
  };
}

function tokens(
  body: TokenEndpointBody,
  now: number,
  keepRefresh: string | null = null,
): StorageResult<OAuthCredential> {
  if (!body.access_token) {
    const why = body.error_description || body.error || 'Google sign-in failed';
    return fail(body.error === 'invalid_grant' ? 'AUTH' : 'REMOTE', `Google: ${why}`);
  }
  return ok({
    kind: 'oauth',
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? keepRefresh,
    expiresAt: body.expires_in ? now + body.expires_in * 1000 : null,
  });
}

export async function exchangeGoogleCode(
  exchange: TokenExchange,
  input: { code: string; verifier: string; redirectUri: string },
  now = Date.now(),
): Promise<StorageResult<OAuthCredential>> {
  const r = await exchange('google', 'token', {
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
  });
  return r.ok ? tokens(r.value, now) : forward(r);
}

/** Google keeps the refresh token across refreshes (none comes back): keep ours. */
export async function refreshGoogleToken(
  exchange: TokenExchange,
  refreshToken: string,
  now = Date.now(),
): Promise<StorageResult<OAuthCredential>> {
  const r = await exchange('google', 'refresh', { refresh_token: refreshToken });
  return r.ok ? tokens(r.value, now, refreshToken) : forward(r);
}
