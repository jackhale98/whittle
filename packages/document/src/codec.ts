// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Canonical project serialisation (the eager half; `.wrencad` packaging and reading live in `archive.ts`
 * so the zip library and the migrations stay out of the initial route).
 *
 * Determinism rules (docs/FILE_FORMAT.md): object keys sorted by UTF-16 code unit, 2-space
 * indent, LF, trailing newline, arrays keep their order, no `undefined`, finite numbers only.
 * Zip entries are sorted by path, use a fixed timestamp and fixed compression settings.
 */

import type { ProjectFiles, WrenDoc } from '@wren-cad/contracts';
import type { ManifestEntry, ParamsFile, ProjectManifest } from './files';

export const MANIFEST_FILE = 'wren.project.json';
export const PARAMS_FILE = 'params.json';
export const CACHE_DIR = '.wren/';

/** Names used before the project was renamed to Wren (ADR-032); still read, never written. */
export const LEGACY_MANIFEST_FILE = 'whittle.project.json';
export const LEGACY_CACHE_DIR = '.whittle/';

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
  return new TextEncoder().encode(canonicalJson(value));
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
    ...(doc.drawingDefaults ? { drawingDefaults: doc.drawingDefaults } : {}),
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
