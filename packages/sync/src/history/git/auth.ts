// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/git/providers.ts (same author, GPL-3.0-or-later).
/**
 * How each git host takes a token over HTTP Basic auth, for isomorphic-git's `onAuth`. Tokens
 * come from `CredentialVault` at the moment of the request and are never stored here, logged or
 * put in a URL.
 */

import type { Credential, GitProviderKind } from '@whittle/contracts';

export type GitHost = GitProviderKind | 'other';

export interface BasicAuth {
  username: string;
  password: string;
}

/** The username/password pair a host expects for this credential. */
export function basicAuth(host: GitHost, c: Credential): BasicAuth {
  if (c.kind === 'password') return { username: c.username, password: c.password };
  const token = c.kind === 'oauth' ? c.accessToken : c.token;
  const named = c.kind === 'token' ? c.username?.trim() : undefined;
  switch (host) {
    case 'github':
      return { username: 'x-access-token', password: token };
    case 'gitlab':
      return { username: 'oauth2', password: token };
    case 'bitbucket':
      // Signed-in (OAuth) tokens use x-token-auth. API tokens use Atlassian's fixed username,
      // or the Bitbucket username; git rejects the account email.
      if (c.kind === 'oauth') return { username: 'x-token-auth', password: token };
      return {
        username: named && !named.includes('@') ? named : 'x-bitbucket-api-token-auth',
        password: token,
      };
    default:
      // Forgejo/Gitea accept any username with a token; other servers want theirs.
      return { username: named || 'git', password: token };
  }
}

/**
 * A second try after the host refused `failed`, when the token might be another kind (Bitbucket
 * repository, project and workspace access tokens sign in as x-token-auth), else `null`.
 */
export function retryAuth(
  host: GitHost,
  c: Credential,
  failed: { username?: string },
): BasicAuth | null {
  if (
    host === 'bitbucket' &&
    c.kind === 'token' &&
    failed.username === 'x-bitbucket-api-token-auth'
  ) {
    return { username: 'x-token-auth', password: c.token };
  }
  return null;
}

/** The secret in a credential, so error messages can be scrubbed of it. */
export function secretOf(c: Credential | null): string | null {
  if (!c) return null;
  return c.kind === 'oauth' ? c.accessToken : c.kind === 'token' ? c.token : c.password;
}
