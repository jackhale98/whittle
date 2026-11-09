// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Git LFS pointers (ADR-029 item 5). Wren runs no clean/smudge filters, so an LFS-tracked
 * file is a small pointer blob in git while the user's checkout holds the real content (smudged
 * by git-lfs). Wren leaves the pointer alone: a working file whose SHA-256 is the pointer's
 * `oid` counts as unchanged, and a commit keeps the pointer blob as it is.
 */

import { sha256Hex } from '../hash';

export interface LfsPointer {
  /** SHA-256 hex of the real content. */
  oid: string;
  size: number;
}

const HEADER = 'version https://git-lfs.github.com/spec/v1';

/** The pointer `bytes` hold (git-lfs spec v1), or `null` when they're ordinary content. */
export function lfsPointer(bytes: Uint8Array | undefined): LfsPointer | null {
  // Pointers are under 200 bytes; the spec caps them at 1024.
  if (!bytes || bytes.length > 1024 || bytes.length < HEADER.length) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!text.startsWith(`${HEADER}\n`)) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  if (!oid || size === undefined) return null;
  return { oid, size: Number(size) };
}

/** The pointer itself, or the content it stands for. */
export async function matchesLfs(pointer: Uint8Array, bytes: Uint8Array): Promise<boolean> {
  const p = lfsPointer(pointer);
  if (!p) return false;
  if (bytes.length === pointer.length && bytes.every((b, i) => b === pointer[i])) return true;
  return bytes.length === p.size && (await sha256Hex(bytes)) === p.oid;
}
