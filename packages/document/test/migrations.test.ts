// SPDX-License-Identifier: GPL-3.0-or-later
import { SCHEMA_VERSION, type WrenDoc } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  createDocumentStore,
  MIGRATIONS,
  type Migration,
  migrateDoc,
  newDoc,
  validateDoc,
} from '../src';
import { KNOWN_FEATURE_TYPES } from '../src/features';
import { id, req, sampleDoc } from './fixtures';

describe('migration framework', () => {
  it('the registry covers every version up to SCHEMA_VERSION with no gaps', () => {
    let v = 0;
    for (const m of MIGRATIONS) {
      expect(m.from).toBe(v);
      expect(m.to).toBe(v + 1);
      v = m.to;
    }
    expect(v).toBe(SCHEMA_VERSION);
  });

  it('a current document passes through unchanged (no-op) and is copied', () => {
    const doc = sampleDoc();
    const r = migrateDoc(doc);
    expect(r.ok && r.applied).toEqual([]);
    expect(r.ok && r.doc).toEqual(doc);
    expect(r.ok && r.doc).not.toBe(doc);
  });

  it('migrates an unversioned pre-release document to the current version', () => {
    const raw = {
      units: { length: 'mm', angle: 'deg' },
      parts: [],
      meta: { name: 'Old', created: 'x', modified: 'y', app: 'wren/0.0.1' },
    };
    const r = migrateDoc(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied).toEqual([1, 2, 3]);
      expect(r.doc).toMatchObject({ schemaVersion: 3, params: [], assemblies: [], drawings: [] });
    }
    expect((raw as Record<string, unknown>).schemaVersion).toBeUndefined(); // input untouched
  });

  it('migrates a v1 document (M3.5 shape) to v2 unchanged apart from the version', () => {
    const v1 = { ...newDoc({ name: 'v1' }), schemaVersion: 1 };
    const r = migrateDoc(v1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied).toEqual([2, 3]);
      expect(r.doc).toEqual({ ...v1, schemaVersion: 3 });
    }
  });

  it('chains synthetic migrations in order (what a future v2/v3 bump looks like)', () => {
    const v3to4: Migration = {
      from: 3,
      to: 4,
      description: 'rename meta.name → meta.title',
      migrate(d) {
        const meta = d.meta as Record<string, unknown>;
        meta.title = meta.name;
        meta.name = undefined;
        return d;
      },
    };
    const v4to5: Migration = {
      from: 4,
      to: 5,
      description: 'upper-case the title',
      migrate(d) {
        const meta = d.meta as Record<string, unknown>;
        meta.title = String(meta.title).toUpperCase();
        return d;
      },
    };
    const migrations = [...MIGRATIONS, v3to4, v4to5];
    const r = migrateDoc(newDoc({ name: 'hello' }), { migrations, target: 5, validate: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied).toEqual([4, 5]);
      expect(r.doc.schemaVersion).toBe(5);
      expect((r.doc.meta as unknown as Record<string, unknown>).title).toBe('HELLO');
    }
  });

  it('reports missing steps, failing steps and newer versions', () => {
    const noStep = migrateDoc(newDoc(), { migrations: MIGRATIONS, target: 4, validate: false });
    expect(noStep).toEqual({ ok: false, error: 'No migration from document version 3' });
    const boom: Migration = {
      from: 3,
      to: 4,
      description: 'fails',
      migrate() {
        throw new Error('kaboom');
      },
    };
    const failing = migrateDoc(newDoc(), { migrations: [...MIGRATIONS, boom], target: 4 });
    expect(failing).toEqual({ ok: false, error: 'Migration 3→4 failed: kaboom' });
    const newer = migrateDoc({ ...newDoc(), schemaVersion: 7 });
    expect(newer.ok).toBe(false);
    expect(!newer.ok && newer.error).toMatch(/version 7.*up to version 3/);
    expect(migrateDoc({ schemaVersion: -1 }).ok).toBe(false);
    expect(migrateDoc({ schemaVersion: 1.5 }).ok).toBe(false);
    expect(migrateDoc([]).ok).toBe(false);
    expect(migrateDoc(null).ok).toBe(false);
  });

  it('the store runs custom migrations on load', () => {
    const bump: Migration = {
      from: 1,
      to: 2,
      description: 'noop',
      migrate: (d) => d,
    };
    const store = createDocumentStore(newDoc(), { migrations: [...MIGRATIONS, bump] });
    // Target stays SCHEMA_VERSION (1) so a v1 doc loads without applying `bump`.
    expect(store.load(sampleDoc()).ok).toBe(true);
  });
});

describe('validateDoc', () => {
  it('accepts a full valid document', () => {
    expect(validateDoc(sampleDoc())).toEqual([]);
    expect(validateDoc(newDoc())).toEqual([]);
  });

  it('pinpoints problems', () => {
    const d = sampleDoc() as unknown as Record<string, unknown>;
    const bad = structuredClone(d) as {
      units: { length: string };
      params: { name: string; id: string }[];
      parts: { rollbackIndex: number; features: Record<string, unknown>[] }[];
    };
    bad.units.length = 'furlong';
    bad.params.push({ id: id(1), name: 'width' });
    const part0 = req(bad.parts[0]);
    part0.rollbackIndex = 99;
    req(part0.features[0]).type = 'teleport';
    req(part0.features[2]).dx = 7;
    const errs = validateDoc(bad);
    expect(errs.join('\n')).toMatch(/units.length must be one of/);
    expect(errs.join('\n')).toMatch(/duplicate id/);
    expect(errs.join('\n')).toMatch(/duplicate parameter name ‘width’/);
    expect(errs.join('\n')).toMatch(/rollbackIndex must be an integer between 0 and 15/);
    expect(errs.join('\n')).toMatch(/features\[0\].type ‘teleport’/);
    expect(errs.join('\n')).toMatch(/features\[2\]\/dx must be an expression string/);
  });

  it('flags structurally broken input without throwing', () => {
    expect(validateDoc(null)).toEqual(['the document is not an object']);
    expect(validateDoc({}).length).toBeGreaterThan(3);
    const weird = {
      ...newDoc(),
      parts: [
        {
          id: 'p',
          name: 'n',
          rollbackIndex: 0,
          features: [{ id: 'f', type: 'extrude', name: 'x', suppressed: false }],
        },
      ],
    };
    expect(validateDoc(weird).join('\n')).toMatch(/malformed|must be/);
  });
});

describe('validateDoc knows every feature type', () => {
  it('accepts the M3 types (a saved hole, thread, shell or pattern must reload)', () => {
    const doc = newDoc();
    const features = KNOWN_FEATURE_TYPES.map((type, i) => ({
      id: `01J0000000000000000000F${String(i).padStart(3, '0')}`,
      type,
      name: type,
      suppressed: false,
    }));
    const withAll = {
      ...doc,
      parts: [{ id: '01J0000000000000000000P001', name: 'P', features, rollbackIndex: 0 }],
    } as unknown as WrenDoc;
    const unknown = validateDoc(withAll).filter((e) => e.includes('not a known feature type'));
    expect(unknown).toEqual([]);
    for (const t of ['hole', 'thread', 'shell', 'linearPattern', 'mirror', 'point'] as const) {
      expect(KNOWN_FEATURE_TYPES).toContain(t);
    }
  });
});
