// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Content hashes for history (docs/FILE_FORMAT.md §9): SHA-256 hex over the canonical project
 * files, independent of compression, so identical content gives an identical hash in both
 * backends and across fflate versions.
 */

import type { ProjectFiles } from '@wren-cad/contracts';
import { sha256Hex } from '../engine/hash';

/** Never part of a version: the regenerable cache and the snapshot history itself. */
export const CACHE_PREFIX = '.wren/';
export const HISTORY_PREFIX = '.wren-history/';

export function isVersionedPath(path: string): boolean {
  return !path.startsWith(CACHE_PREFIX) && !path.startsWith(HISTORY_PREFIX);
}

/** The files a version records (cache and history removed), sorted by path. */
export function versionedFiles(files: ProjectFiles): ProjectFiles {
  const out: ProjectFiles = new Map();
  for (const path of [...files.keys()].sort()) {
    if (isVersionedPath(path)) out.set(path, files.get(path) as Uint8Array);
  }
  return out;
}

export { sha256Hex };

/**
 * SHA-256 over, for each versioned path in ascending UTF-16 order:
 * `utf8(path) 0x00 utf8(decimal byte length) 0x00 bytes`.
 */
export async function hashProjectFiles(files: ProjectFiles): Promise<string> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const [path, bytes] of versionedFiles(files)) {
    const head = enc.encode(`${path}\0${bytes.length}\0`);
    chunks.push(head, bytes);
    total += head.length + bytes.length;
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return sha256Hex(all);
}

export function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
