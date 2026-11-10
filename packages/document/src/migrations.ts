// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Document validation and schema migrations.
 *
 * Every `schemaVersion` bump adds one `Migration` (`from: n, to: n+1`) plus a test with a
 * fixture of the old shape. `migrateDoc` applies them in sequence to a *copy* of the input and
 * then validates the result, so `DocumentStore.load` never accepts a malformed document.
 */

import { type Part, SCHEMA_VERSION, type WrenDoc } from '@wren-cad/contracts';
import { exprFields, FEATURE_TYPES } from './features';
import { folderProblems, normalizeFolders } from './folders';
import { getAt, parsePointer } from './patch';

type Obj = Record<string, unknown>;

export interface Migration {
  from: number;
  to: number;
  description: string;
  /** Receives a private copy; may mutate and return it. */
  migrate(doc: Obj): Obj;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    from: 0,
    to: 1,
    description: 'Baseline: documents without a version (pre-release) gain empty collections.',
    migrate(doc) {
      for (const k of ['params', 'parts', 'assemblies', 'drawings']) {
        if (doc[k] === undefined) doc[k] = [];
      }
      return doc;
    },
  },
  {
    from: 1,
    to: 2,
    description:
      'Additive (M3.6): optional Part.folders and SketchFeature.visibility. Also marks files that may hold the M3.5 sketch curves (ellipticArc, bspline) written under v1. No data changes.',
    migrate(doc) {
      return doc;
    },
  },
  {
    from: 2,
    to: 3,
    description:
      'Additive (M3.7): optional Part.configurations, Part.activeConfigurationId and Part.properties. No data changes.',
    migrate(doc) {
      return doc;
    },
  },
];

export interface MigrateOptions {
  migrations?: readonly Migration[];
  target?: number;
  /** Validate the migrated result against the current document shape. Default true. */
  validate?: boolean;
}

export type MigrateResult =
  | { ok: true; doc: WrenDoc; applied: number[] }
  | { ok: false; error: string };

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function migrateDoc(raw: unknown, options: MigrateOptions = {}): MigrateResult {
  const migrations = options.migrations ?? MIGRATIONS;
  const target = options.target ?? SCHEMA_VERSION;
  if (!isObj(raw)) return { ok: false, error: 'The document is not a JSON object' };
  const declared = raw.schemaVersion === undefined ? 0 : raw.schemaVersion;
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 0) {
    return { ok: false, error: `Invalid schemaVersion ‘${String(declared)}’` };
  }
  let version: number = declared;
  if (version > target) {
    return {
      ok: false,
      error: `This file uses document version ${version}, but this copy of Wren understands up to version ${target}. Update Wren to open it.`,
    };
  }
  let doc: Obj = structuredClone(raw);
  const applied: number[] = [];
  while (version < target) {
    const m = migrations.find((x) => x.from === version);
    if (!m) return { ok: false, error: `No migration from document version ${version}` };
    try {
      doc = m.migrate(doc);
    } catch (e) {
      return { ok: false, error: `Migration ${m.from}→${m.to} failed: ${(e as Error).message}` };
    }
    version = m.to;
    doc.schemaVersion = version;
    applied.push(version);
  }
  doc.schemaVersion = version;
  repairFolders(doc);
  if (options.validate !== false) {
    const errors = validateDoc(doc);
    if (errors.length > 0) {
      const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : '';
      return { ok: false, error: `Invalid document: ${errors.slice(0, 3).join('; ')}${more}` };
    }
  }
  return { ok: true, doc: doc as unknown as WrenDoc, applied };
}

const wellFormedFolders = (p: Obj): boolean =>
  Array.isArray(p.features) &&
  p.features.every((f) => isObj(f) && typeof f.id === 'string') &&
  Array.isArray(p.folders) &&
  p.folders.every(
    (f) =>
      isObj(f) &&
      typeof f.id === 'string' &&
      typeof f.name === 'string' &&
      Array.isArray(f.features) &&
      f.features.every((m) => typeof m === 'string'),
  );

/**
 * Loading repairs semantic folder problems (missing members, broken runs, overlaps) with
 * `normalizeFolders` instead of rejecting the file: a merge written by a plain text tool (git)
 * can produce them, and ADR-066 defines the deterministic fix. Malformed folders (wrong types)
 * are left for `validateDoc` to report.
 */
function repairFolders(doc: Obj): void {
  if (!Array.isArray(doc.parts)) return;
  doc.parts = doc.parts.map((p: unknown) => {
    if (!isObj(p) || !wellFormedFolders(p)) return p;
    return normalizeFolders(p as unknown as Part).part;
  });
}

// ---------------------------------------------------------------------------------------------
// Validation (structural; the JSON Schema in ../schema is the exhaustive description)
// ---------------------------------------------------------------------------------------------

const LENGTH_UNITS = ['mm', 'cm', 'm', 'in', 'ft'];
const ANGLE_UNITS = ['deg', 'rad'];
const SKETCH_VISIBILITY = ['auto', 'shown', 'hidden'];

/** Human-readable problems; empty when the document is structurally sound. */
export function validateDoc(doc: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(doc)) return ['the document is not an object'];
  const str = (v: unknown, path: string): v is string => {
    if (typeof v === 'string') return true;
    errs.push(`${path} must be a string`);
    return false;
  };
  const arr = (v: unknown, path: string): v is unknown[] => {
    if (Array.isArray(v)) return true;
    errs.push(`${path} must be an array`);
    return false;
  };
  const seen = new Map<string, string>();
  const id = (v: unknown, path: string): void => {
    if (!str(v, path)) return;
    if (v === '') errs.push(`${path} must not be empty`);
    const prev = seen.get(v);
    if (prev !== undefined) errs.push(`duplicate id ‘${v}’ at ${path} (also ${prev})`);
    else seen.set(v, path);
  };

  if (typeof doc.schemaVersion !== 'number' || !Number.isInteger(doc.schemaVersion)) {
    errs.push('schemaVersion must be an integer');
  }
  if (!isObj(doc.units)) errs.push('units must be an object');
  else {
    if (!LENGTH_UNITS.includes(doc.units.length as string)) {
      errs.push(`units.length must be one of ${LENGTH_UNITS.join(', ')}`);
    }
    if (!ANGLE_UNITS.includes(doc.units.angle as string)) {
      errs.push(`units.angle must be one of ${ANGLE_UNITS.join(', ')}`);
    }
  }

  if (!isObj(doc.meta)) errs.push('meta must be an object');
  else for (const k of ['name', 'created', 'modified', 'app']) str(doc.meta[k], `meta.${k}`);

  const names = new Set<string>();
  if (arr(doc.params, 'params')) {
    doc.params.forEach((p, i) => {
      const at = `params[${i}]`;
      if (!isObj(p)) {
        errs.push(`${at} must be an object`);
        return;
      }
      id(p.id, `${at}.id`);
      if (str(p.name, `${at}.name`)) {
        if (names.has(p.name)) errs.push(`duplicate parameter name ‘${p.name}’ at ${at}`);
        names.add(p.name);
      }
      str(p.expr, `${at}.expr`);
    });
  }

  if (arr(doc.parts, 'parts')) {
    doc.parts.forEach((part, i) => {
      validatePart(part, `parts[${i}]`, errs, str, arr, id);
    });
  }
  for (const key of ['assemblies', 'drawings'] as const) {
    if (arr(doc[key], key)) {
      doc[key].forEach((x, i) => {
        if (!isObj(x)) {
          errs.push(`${key}[${i}] must be an object`);
          return;
        }
        id(x.id, `${key}[${i}].id`);
        str(x.name, `${key}[${i}].name`);
      });
    }
  }
  return errs;
}

function validatePart(
  part: unknown,
  at: string,
  errs: string[],
  str: (v: unknown, p: string) => v is string,
  arr: (v: unknown, p: string) => v is unknown[],
  id: (v: unknown, p: string) => void,
): void {
  if (!isObj(part)) {
    errs.push(`${at} must be an object`);
    return;
  }
  id(part.id, `${at}.id`);
  str(part.name, `${at}.name`);
  if (part.color !== undefined) str(part.color, `${at}.color`);
  if (part.material !== undefined) {
    if (!isObj(part.material)) errs.push(`${at}.material must be an object`);
    else {
      str(part.material.name, `${at}.material.name`);
      str(part.material.density, `${at}.material.density`);
    }
  }
  validateConfigurations(part, at, errs, str, arr, id);
  if (!arr(part.features, `${at}.features`)) return;
  const n = part.features.length;
  if (
    typeof part.rollbackIndex !== 'number' ||
    !Number.isInteger(part.rollbackIndex) ||
    part.rollbackIndex < 0 ||
    part.rollbackIndex > n
  ) {
    errs.push(`${at}.rollbackIndex must be an integer between 0 and ${n}`);
  }
  part.features.forEach((f, j) => {
    const fa = `${at}.features[${j}]`;
    if (!isObj(f)) {
      errs.push(`${fa} must be an object`);
      return;
    }
    id(f.id, `${fa}.id`);
    str(f.name, `${fa}.name`);
    if (f.visibility !== undefined) {
      if (f.type !== 'sketch') errs.push(`${fa}.visibility is only valid on sketches`);
      else if (!SKETCH_VISIBILITY.includes(f.visibility as string)) {
        errs.push(`${fa}.visibility must be one of ${SKETCH_VISIBILITY.join(', ')}`);
      }
    }
    if (typeof f.suppressed !== 'boolean') errs.push(`${fa}.suppressed must be a boolean`);
    if (!(FEATURE_TYPES as readonly unknown[]).includes(f.type)) {
      errs.push(`${fa}.type ‘${String(f.type)}’ is not a known feature type`);
      return;
    }
    try {
      for (const field of exprFields(f as never)) {
        if (typeof getAt(f, field.pointer) !== 'string') {
          errs.push(`${fa}${field.pointer} must be an expression string`);
        }
      }
    } catch {
      errs.push(`${fa} is malformed`);
    }
  });
  if (part.folders === undefined) return;
  if (!arr(part.folders, `${at}.folders`)) return;
  let structural = true;
  part.folders.forEach((f, k) => {
    const fa = `${at}.folders[${k}]`;
    if (!isObj(f)) {
      errs.push(`${fa} must be an object`);
      structural = false;
      return;
    }
    id(f.id, `${fa}.id`);
    if (!str(f.name, `${fa}.name`)) structural = false;
    if (!Array.isArray(f.features) || !f.features.every((m) => typeof m === 'string')) {
      errs.push(`${fa}.features must be an array of feature ids`);
      structural = false;
    }
  });
  // Semantic membership checks. `validateDoc` is strict about them; loading repairs them first
  // (`repairFolders`), so they only fail for documents that skipped normalisation.
  if (structural && part.features.every((f) => isObj(f) && typeof f.id === 'string')) {
    for (const p of folderProblems(part as unknown as Part)) errs.push(`${at}.${p}`);
  }
}

const isPlainObj = (v: unknown): v is Obj =>
  isObj(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * M3.7 structure checks: types, unique ids, the active configuration exists, override keys are
 * well-formed. Stale overrides (a deleted feature or parameter) are *not* errors: resolution
 * reports them as "needs attention" (ADR-074).
 */
function validateConfigurations(
  part: Obj,
  at: string,
  errs: string[],
  str: (v: unknown, p: string) => v is string,
  arr: (v: unknown, p: string) => v is unknown[],
  id: (v: unknown, p: string) => void,
): void {
  const props = (v: unknown, path: string): void => {
    if (!isPlainObj(v)) {
      errs.push(`${path} must be an object`);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (k !== 'partNumber' && k !== 'description')
        errs.push(`${path}.${k} is not a part property`);
      else str(x, `${path}.${k}`);
    }
  };
  if (part.properties !== undefined) props(part.properties, `${at}.properties`);
  const ids = new Set<string>();
  if (part.configurations !== undefined && arr(part.configurations, `${at}.configurations`)) {
    part.configurations.forEach((c, k) => {
      const ca = `${at}.configurations[${k}]`;
      if (!isObj(c)) {
        errs.push(`${ca} must be an object`);
        return;
      }
      id(c.id, `${ca}.id`);
      if (typeof c.id === 'string') ids.add(c.id);
      str(c.name, `${ca}.name`);
      if (c.params !== undefined) {
        if (!isPlainObj(c.params)) errs.push(`${ca}.params must be an object`);
        else {
          for (const [key, v] of Object.entries(c.params)) {
            if (key === '') errs.push(`${ca}.params has an empty parameter id`);
            str(v, `${ca}.params.${key}`);
          }
        }
      }
      if (c.features !== undefined) {
        if (!isPlainObj(c.features)) errs.push(`${ca}.features must be an object`);
        else {
          for (const [fid, ov] of Object.entries(c.features)) {
            const oa = `${ca}.features.${fid}`;
            if (fid === '') errs.push(`${ca}.features has an empty feature id`);
            if (!isPlainObj(ov)) {
              errs.push(`${oa} must be an object`);
              continue;
            }
            for (const k2 of Object.keys(ov)) {
              if (k2 !== 'suppressed' && k2 !== 'fields')
                errs.push(`${oa}.${k2} is not an override`);
            }
            if (ov.suppressed !== undefined && typeof ov.suppressed !== 'boolean') {
              errs.push(`${oa}.suppressed must be a boolean`);
            }
            if (ov.fields !== undefined) {
              if (!isPlainObj(ov.fields)) errs.push(`${oa}.fields must be an object`);
              else {
                for (const [path, v] of Object.entries(ov.fields)) {
                  const bad = pointerProblem(path);
                  if (bad) errs.push(`${oa}.fields key ‘${path}’ ${bad}`);
                  const okType =
                    typeof v === 'string' ||
                    typeof v === 'boolean' ||
                    (typeof v === 'number' && Number.isFinite(v));
                  if (!okType)
                    errs.push(`${oa}.fields[‘${path}’] must be a string, number or boolean`);
                }
              }
            }
          }
        }
      }
      if (c.material !== undefined && c.material !== null) {
        if (!isObj(c.material)) errs.push(`${ca}.material must be an object or null`);
        else {
          str(c.material.name, `${ca}.material.name`);
          str(c.material.density, `${ca}.material.density`);
        }
      }
      if (c.color !== undefined) str(c.color, `${ca}.color`);
      if (c.properties !== undefined) props(c.properties, `${ca}.properties`);
    });
  }
  if (part.activeConfigurationId !== undefined) {
    if (str(part.activeConfigurationId, `${at}.activeConfigurationId`)) {
      if (!ids.has(part.activeConfigurationId)) {
        errs.push(
          `${at}.activeConfigurationId ‘${part.activeConfigurationId}’ is not one of the part’s configurations`,
        );
      }
    }
  }
}

function pointerProblem(path: string): string | undefined {
  if (!path.startsWith('/') || path.length < 2) return 'must be a JSON pointer starting with ‘/’';
  try {
    parsePointer(path);
  } catch {
    return 'is not a valid JSON pointer';
  }
  return undefined;
}
