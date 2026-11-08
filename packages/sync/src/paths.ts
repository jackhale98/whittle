// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/sync/remote.ts (`syncable`), with Whittle's project rules.
/**
 * Which files of a project folder sync (PLAN §8A.1): every file under the project folder except
 * the `.whittle/` cache (meshes, BREP, thumbnails: regenerable, never synced). `.whittle-history/`
 * (snapshot history) does sync. Also skipped: `.git/` (git connections use GitHistory, not file
 * sync) and operating-system metadata files that desktop sync clients drop into folders.
 */

import { CACHE_DIR, MANIFEST_FILE, PARAMS_FILE } from '@whittle/document';

export const HISTORY_DIR = '.whittle-history/';

const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'Icon\r']);

/** Project-relative POSIX path → whether it syncs. */
export function syncable(path: string): boolean {
  if (!path || path.startsWith('/') || path.endsWith('/')) return false;
  if (path.startsWith(CACHE_DIR) || path === CACHE_DIR.slice(0, -1)) return false;
  const parts = path.split('/');
  if (parts.includes('..') || parts.includes('.') || parts.includes('')) return false;
  if (parts[0] === '.git') return false;
  const name = parts[parts.length - 1] as string;
  // Office/LibreOffice lock files and desktop-sync temporaries.
  if (OS_JUNK.has(name) || name.startsWith('~$') || name.startsWith('.~lock.')) return false;
  return true;
}

/** Service path of a project-relative path: `('/CAD/bracket', 'params.json')` → `/CAD/bracket/params.json`. */
export function toAbsolute(root: string, rel: string): string {
  const r = root.replace(/\/+$/, '');
  return `${r}/${rel}`;
}

/** Project-relative path of a service path, or `null` when it's outside the project folder. */
export function toRelative(root: string, abs: string, caseSensitive: boolean): string | null {
  const r = root.replace(/\/+$/, '');
  const norm = caseSensitive ? (s: string) => s : (s: string) => s.toLowerCase();
  if (r && !norm(abs).startsWith(`${norm(r)}/`)) return null;
  if (!r && !abs.startsWith('/')) return null;
  const rel = abs.slice(r.length + 1);
  return rel || null;
}

interface ManifestLike {
  parts?: { file?: unknown }[];
  drawings?: { file?: unknown }[];
  assemblies?: { file?: unknown }[];
}

/** Files a manifest's bytes reference (parts, drawings, assemblies). Lenient: bad JSON → none. */
export function manifestRefs(bytes: Uint8Array | null | undefined): string[] {
  if (!bytes) return [];
  let m: ManifestLike;
  try {
    m = JSON.parse(new TextDecoder().decode(bytes)) as ManifestLike;
  } catch {
    return [];
  }
  if (!m || typeof m !== 'object') return [];
  const out: string[] = [];
  for (const list of [m.parts, m.drawings, m.assemblies]) {
    if (!Array.isArray(list)) continue;
    for (const e of list) if (e && typeof e.file === 'string') out.push(e.file);
  }
  return out;
}

/** The document's own files: manifest, params and everything a manifest references. */
export function documentPaths(...manifests: (Uint8Array | null | undefined)[]): Set<string> {
  const out = new Set<string>([MANIFEST_FILE, PARAMS_FILE]);
  for (const m of manifests) for (const p of manifestRefs(m)) out.add(p);
  return out;
}

/**
 * Push order: referenced files first, then params, the manifest last, so a device listing midway
 * sees new parts before the manifest that points at them. Deletions go after everything else.
 */
export function pushRank(path: string, deleting: boolean): number {
  if (deleting) return 3;
  if (path === MANIFEST_FILE) return 2;
  if (path === PARAMS_FILE) return 1;
  return 0;
}
