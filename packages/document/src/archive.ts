// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reading a project (`fromFiles`), `.wrencad` packaging and the `ProjectCodec` (split from
 * `codec.ts` so fflate and the migrations stay in a lazy chunk; ADR-089).
 */

import type { ProjectCodec, ProjectFiles, WrenDoc } from '@wren-cad/contracts';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import {
  CACHE_DIR,
  LEGACY_CACHE_DIR,
  LEGACY_MANIFEST_FILE,
  MANIFEST_FILE,
  PARAMS_FILE,
  toFiles,
} from './codec';
import { migrateDoc } from './migrations';

const PROJECT_FORMATS = new Set(['wren-project', 'whittle-project']);

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFormatError';
  }
}

function readJson(files: ProjectFiles, path: string): unknown {
  const bytes = files.get(path);
  if (!bytes) throw new ProjectFormatError(`The project is missing ‘${path}’`);
  try {
    return JSON.parse(strFromU8(bytes));
  } catch (e) {
    throw new ProjectFormatError(`‘${path}’ is not valid JSON: ${(e as Error).message}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function safePath(p: unknown): string {
  if (
    typeof p !== 'string' ||
    p === '' ||
    p.startsWith('/') ||
    p.includes('\\') ||
    p.split('/').includes('..')
  ) {
    throw new ProjectFormatError(`Invalid file path in manifest: ${JSON.stringify(p)}`);
  }
  return p;
}

function readEntries(files: ProjectFiles, list: unknown, key: string): unknown[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new ProjectFormatError(`Manifest ‘${key}’ must be an array`);
  return list.map((e) => {
    if (!isObj(e)) throw new ProjectFormatError(`Manifest ‘${key}’ has an invalid entry`);
    const file = safePath(e.file);
    const obj = readJson(files, file);
    if (isObj(obj) && typeof e.id === 'string' && obj.id !== e.id) {
      throw new ProjectFormatError(
        `‘${file}’ has id ${String(obj.id)} but the manifest says ${e.id}`,
      );
    }
    return obj;
  });
}

/** Rebuilds a document from project files, migrating and validating it. Throws `ProjectFormatError`. */
export function fromFiles(files: ProjectFiles): WrenDoc {
  const manifestFile =
    !files.has(MANIFEST_FILE) && files.has(LEGACY_MANIFEST_FILE)
      ? LEGACY_MANIFEST_FILE
      : MANIFEST_FILE;
  const manifest = readJson(files, manifestFile);
  if (!isObj(manifest) || !PROJECT_FORMATS.has(String(manifest.format))) {
    throw new ProjectFormatError(`‘${MANIFEST_FILE}’ is not a Wren project manifest`);
  }
  const params = readJson(files, PARAMS_FILE);
  if (!isObj(params) || !Array.isArray(params.params)) {
    throw new ProjectFormatError(`‘${PARAMS_FILE}’ must contain a ‘params’ array`);
  }
  const raw = {
    schemaVersion: manifest.schemaVersion,
    units: manifest.units,
    params: params.params,
    parts: readEntries(files, manifest.parts, 'parts'),
    assemblies: readEntries(files, manifest.assemblies, 'assemblies'),
    drawings: readEntries(files, manifest.drawings, 'drawings'),
    meta: manifest.meta,
    drawingDefaults: manifest.drawingDefaults,
  };
  const r = migrateDoc(raw);
  if (!r.ok) throw new ProjectFormatError(r.error);
  return r.doc;
}

// ---------------------------------------------------------------------------------------------
// .wrencad (zip)
// ---------------------------------------------------------------------------------------------

/** Zip entries carry no wall-clock time: 1980-01-01 00:00 (local fields, so the TZ cannot leak in). */
const fixedTime = (): Date => new Date(1980, 0, 1, 0, 0, 0);

/** Hardening limits when reading archives from untrusted sources. */
export const MAX_ARCHIVE_ENTRIES = 20_000;
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

/** Zips files (sorted, fixed timestamp). `cache` entries are stored under `.wren/`. */
export function packFiles(files: ProjectFiles, cache?: ProjectFiles): Uint8Array {
  const all = new Map<string, Uint8Array>(files);
  if (cache) for (const [k, v] of cache) all.set(`${CACHE_DIR}${k}`, v);
  const mtime = fixedTime();
  const tree: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {};
  for (const path of [...all.keys()].sort()) {
    tree[path] = [all.get(path) as Uint8Array, { mtime, level: 6 }];
  }
  return zipSync(tree);
}

/** Unzips a `.wrencad`: project files (everything outside `.wren/`) and the cache (keys relative to `.wren/`). */
export function unpackFiles(bytes: Uint8Array): { files: ProjectFiles; cache: ProjectFiles } {
  let total = 0;
  let count = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes, {
      filter(f) {
        count++;
        total += f.originalSize;
        if (count > MAX_ARCHIVE_ENTRIES || total > MAX_ARCHIVE_BYTES) {
          throw new ProjectFormatError('The archive is too large to open');
        }
        return !f.name.endsWith('/');
      },
    });
  } catch (e) {
    if (e instanceof ProjectFormatError) throw e;
    throw new ProjectFormatError('This is not a valid .wrencad archive');
  }
  let names = Object.keys(raw);
  for (const n of names) {
    if (n.startsWith('/') || n.includes('\\') || n.split('/').includes('..')) {
      throw new ProjectFormatError(`The archive contains an unsafe path: ${n}`);
    }
  }
  // Tolerate a single wrapping folder (a project folder zipped by an ordinary tool).
  const hasManifest = (prefix: string) =>
    names.includes(`${prefix}${MANIFEST_FILE}`) ||
    names.includes(`${prefix}${LEGACY_MANIFEST_FILE}`);
  if (!hasManifest('')) {
    const roots = new Set(names.map((n) => n.split('/')[0]));
    const only = roots.size === 1 ? [...roots][0] : undefined;
    if (only && hasManifest(`${only}/`)) {
      const stripped: Record<string, Uint8Array> = {};
      for (const n of names) stripped[n.slice(only.length + 1)] = raw[n] as Uint8Array;
      raw = stripped;
      names = Object.keys(raw);
    }
  }
  const files: ProjectFiles = new Map();
  const cache: ProjectFiles = new Map();
  for (const n of names.sort()) {
    if (n.startsWith(CACHE_DIR)) cache.set(n.slice(CACHE_DIR.length), raw[n] as Uint8Array);
    else if (n.startsWith(LEGACY_CACHE_DIR))
      cache.set(n.slice(LEGACY_CACHE_DIR.length), raw[n] as Uint8Array);
    else files.set(n, raw[n] as Uint8Array);
  }
  return { files, cache };
}

const MODEL_PATH = /^(wren\.project\.json|params\.json|(parts|drawings|assemblies)\/)/;

export const projectCodec: ProjectCodec = {
  toFiles,
  fromFiles,
  toWren: (doc, cache, extra) => {
    const files = toFiles(doc);
    // Attachments and other non-model files (imports/, previews/, releases/) ride along.
    if (extra) for (const [path, data] of extra) if (!MODEL_PATH.test(path)) files.set(path, data);
    return packFiles(files, cache);
  },
  fromWren(bytes) {
    const { files, cache } = unpackFiles(bytes);
    // Files outside the document model (previews/, releases/, …) are returned so a round trip
    // through Wren never drops them.
    const extra: ProjectFiles = new Map();
    for (const [path, data] of files) {
      if (!MODEL_PATH.test(path)) extra.set(path, data);
    }
    return { doc: fromFiles(files), cache, extra };
  },
};
