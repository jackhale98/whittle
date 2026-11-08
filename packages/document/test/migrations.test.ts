// SPDX-License-Identifier: GPL-3.0-or-later
import { SCHEMA_VERSION } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import {
  createDocumentStore,
  MIGRATIONS,
  type Migration,
  migrateDoc,
  newDoc,
  validateDoc,
} from '../src';
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

  it('migrates an unversioned pre-release document to v1', () => {
    const raw = {
      units: { length: 'mm', angle: 'deg' },
      parts: [],
      meta: { name: 'Old', created: 'x', modified: 'y', app: 'whittle/0.0.1' },
    };
    const r = migrateDoc(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied).toEqual([1]);
      expect(r.doc).toMatchObject({ schemaVersion: 1, params: [], assemblies: [], drawings: [] });
    }
    expect((raw as Record<string, unknown>).schemaVersion).toBeUndefined(); // input untouched
  });

  it('chains synthetic migrations in order (what a future v2/v3 bump looks like)', () => {
    const v1to2: Migration = {
      from: 1,
      to: 2,
      description: 'rename meta.name → meta.title',
      migrate(d) {
        const meta = d.meta as Record<string, unknown>;
        meta.title = meta.name;
        meta.name = undefined;
        return d;
      },
    };
    const v2to3: Migration = {
      from: 2,
      to: 3,
      description: 'upper-case the title',
      migrate(d) {
        const meta = d.meta as Record<string, unknown>;
        meta.title = String(meta.title).toUpperCase();
        return d;
      },
    };
    const migrations = [...MIGRATIONS, v1to2, v2to3];
    const r = migrateDoc(newDoc({ name: 'hello' }), { migrations, target: 3, validate: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied).toEqual([2, 3]);
      expect(r.doc.schemaVersion).toBe(3);
      expect((r.doc.meta as unknown as Record<string, unknown>).title).toBe('HELLO');
    }
  });

  it('reports missing steps, failing steps and newer versions', () => {
    const noStep = migrateDoc(newDoc(), { migrations: MIGRATIONS, target: 2, validate: false });
    expect(noStep).toEqual({ ok: false, error: 'No migration from document version 1' });
    const boom: Migration = {
      from: 1,
      to: 2,
      description: 'fails',
      migrate() {
        throw new Error('kaboom');
      },
    };
    const failing = migrateDoc(newDoc(), { migrations: [...MIGRATIONS, boom], target: 2 });
    expect(failing).toEqual({ ok: false, error: 'Migration 1→2 failed: kaboom' });
    const newer = migrateDoc({ ...newDoc(), schemaVersion: 7 });
    expect(newer.ok).toBe(false);
    expect(!newer.ok && newer.error).toMatch(/version 7.*up to version 1/);
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
    expect(errs.join('\n')).toMatch(/rollbackIndex must be an integer between 0 and 14/);
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
