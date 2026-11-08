// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/auth/oauth.ts (PKCE helpers).
/** OAuth 2 PKCE (RFC 7636) helpers on WebCrypto. */

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `bytes` random bytes as base64url (32 → 43 characters, a valid PKCE verifier). */
export function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE S256 challenge for a verifier. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
