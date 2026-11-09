// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Canonical project serialisation and `.wrencad` packaging (implements `ProjectCodec`).
 *
 * Determinism rules (docs/FILE_FORMAT.md): object keys sorted by UTF-16 code unit, 2-space
 * indent, LF, trailing newline, arrays keep their order, no `undefined`, finite numbers only.
 * Zip entries are sorted by path, use a fixed timestamp and fixed compression settings.
 */

import type { ProjectCodec, ProjectFiles, WrenDoc } from '@wren-cad/contracts';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { ManifestEntry, ParamsFile, ProjectManifest } from './files';
import { migrateDoc } from './migrations';

export const MANIFEST_FILE = 'wren.project.json';
export const PARAMS_FILE = 'params.json';
export const CACHE_DIR = '.wren/';

// ---------------------------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------------------------

function canon(value: unknown, indent: string, out: string[], path: string): void {
  if (value === null) return void out.push('null');
  switch (typeof value) {
    case 'string':
      return void out.push(JSON.stringify(value));
    case 'boolean':
      return void out.push(value ? 'true' : 'false');
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path || '/'}`);
      return void out.push(Object.is(value, -0) ? '0' : JSON.stringify(value));
    case 'object': {
      const inner = `${indent}  `;
      if (Array.isArray(value)) {
        if (value.length === 0) return void out.push('[]');
        out.push('[\n');
        value.forEach((v, i) => {
          if (v === undefined) throw new TypeError(`undefined array element at ${path}/${i}`);
          out.push(inner);
          canon(v, inner, out, `${path}/${i}`);
          out.push(i < value.length - 1 ? ',\n' : '\n');
        });
        return void out.push(`${indent}]`);
      }
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
      if (keys.length === 0) return void out.push('{}');
      out.push('{\n');
      keys.forEach((k, i) => {
        out.push(inner, JSON.stringify(k), ': ');
        canon(o[k], inner, out, `${path}/${k}`);
        out.push(i < keys.length - 1 ? ',\n' : '\n');
      });
      return void out.push(`${indent}}`);
    }
    default:
      throw new TypeError(`Cannot serialise ${typeof value} at ${path || '/'}`);
  }
}

/** Canonical JSON text: sorted keys, 2-space indent, LF, trailing newline. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  canon(value, '', out, '');
  out.push('\n');
  return out.join('');
}

export function canonicalBytes(value: unknown): Uint8Array {
  return strToU8(canonicalJson(value));
}

// ---------------------------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------------------------

/** `Bracket – Left (v2)` → `bracket-left-v2`. ASCII, lowercase, never empty. */
export function slugify(name: string, fallback: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return s === '' ? fallback : s;
}

/**
 * Unique slugs keyed by id. Ties are resolved by ascending id (ULIDs sort by creation time), so
 * a slug never depends on array order and adding a same-named object never renames the old one.
 */
export function assignSlugs(
  items: { id: string; name: string }[],
  fallback: string,
): Map<string, string> {
  const result = new Map<string, string>();
  const taken = new Set<string>();
  const sorted = items.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const it of sorted) {
    const base = slugify(it.name, fallback);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    result.set(it.id, slug);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Folder <-> document
// ---------------------------------------------------------------------------------------------

function entries(
  items: { id: string; name: string }[],
  dir: string,
  ext: string,
  fallback: string,
): ManifestEntry[] {
  const slugs = assignSlugs(items, fallback);
  return items.map((it) => ({
    id: it.id,
    name: it.name,
    file: `${dir}/${slugs.get(it.id)}.${ext}.json`,
  }));
}

export function toFiles(doc: WrenDoc): ProjectFiles {
  const files: ProjectFiles = new Map();
  const parts = entries(doc.parts, 'parts', 'part', 'part');
  const drawings = entries(doc.drawings, 'drawings', 'drawing', 'drawing');
  const assemblies = entries(doc.assemblies, 'assemblies', 'assembly', 'assembly');
  const manifest: ProjectManifest = {
    format: 'wren-project',
    schemaVersion: doc.schemaVersion,
    units: doc.units,
    meta: doc.meta,
    parts,
    drawings,
    assemblies,
  };
  files.set(MANIFEST_FILE, canonicalBytes(manifest));
  const params: ParamsFile = { params: doc.params };
  files.set(PARAMS_FILE, canonicalBytes(params));
  const put = (list: ManifestEntry[], items: unknown[]): void => {
    items.forEach((item, i) => {
      files.set((list[i] as ManifestEntry).file, canonicalBytes(item));
    });
  };
  put(parts, doc.parts);
  put(drawings, doc.drawings);
  put(assemblies, doc.assemblies);
  return files;
}

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
  const manifest = readJson(files, MANIFEST_FILE);
  if (!isObj(manifest) || manifest.format !== 'wren-project') {
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
  if (!names.includes(MANIFEST_FILE)) {
    const roots = new Set(names.map((n) => n.split('/')[0]));
    const only = roots.size === 1 ? [...roots][0] : undefined;
    if (only && names.includes(`${only}/${MANIFEST_FILE}`)) {
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
