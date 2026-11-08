// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Document validation and schema migrations.
 *
 * Every `schemaVersion` bump adds one `Migration` (`from: n, to: n+1`) plus a test with a
 * fixture of the old shape. `migrateDoc` applies them in sequence to a *copy* of the input and
 * then validates the result, so `DocumentStore.load` never accepts a malformed document.
 */

import { SCHEMA_VERSION, type WhittleDoc } from '@whittle/contracts';
import { exprFields, FEATURE_TYPES } from './features';
import { getAt } from './patch';

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
];

export interface MigrateOptions {
  migrations?: readonly Migration[];
  target?: number;
  /** Validate the migrated result against the current document shape. Default true. */
  validate?: boolean;
}

export type MigrateResult =
  | { ok: true; doc: WhittleDoc; applied: number[] }
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
      error: `This file uses document version ${version}, but this copy of Whittle understands up to version ${target}. Update Whittle to open it.`,
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
  if (options.validate !== false) {
    const errors = validateDoc(doc);
    if (errors.length > 0) {
      const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : '';
      return { ok: false, error: `Invalid document: ${errors.slice(0, 3).join('; ')}${more}` };
    }
  }
  return { ok: true, doc: doc as unknown as WhittleDoc, applied };
}

// ---------------------------------------------------------------------------------------------
// Validation (structural; the JSON Schema in ../schema is the exhaustive description)
// ---------------------------------------------------------------------------------------------

const LENGTH_UNITS = ['mm', 'cm', 'm', 'in', 'ft'];
const ANGLE_UNITS = ['deg', 'rad'];

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
}
