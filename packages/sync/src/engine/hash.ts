// SPDX-License-Identifier: GPL-3.0-or-later
/** SHA-256 of file bytes (base keys) and byte comparison. */

const cache = new WeakMap<Uint8Array, string>();

/** SHA-256 hex. Cached per array (the engine hashes the whole working copy each round). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hit = cache.get(bytes);
  if (hit) return hit;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
  );
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  cache.set(bytes, hex);
  return hex;
}

/** Same bytes (`null`/`undefined`: absent; two absents are equal). */
export function bytesEqual(
  a: Uint8Array | null | undefined,
  b: Uint8Array | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
