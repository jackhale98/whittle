// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv, type ErrorObject } from 'ajv';
import { strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { toFiles } from '../src';
import { req, sampleDoc } from './fixtures';

const schemaDir = join(import.meta.dirname, '..', 'schema');
const load = (name: string): object => JSON.parse(readFileSync(join(schemaDir, name), 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validators = {
  project: ajv.compile(load('wren-project.schema.json')),
  params: ajv.compile(load('wren-params.schema.json')),
  part: ajv.compile(load('wren-part.schema.json')),
  drawing: ajv.compile(load('wren-drawing.schema.json')),
  assembly: ajv.compile(load('wren-assembly.schema.json')),
  document: ajv.compile(load('wren-document.schema.json')),
};

const fmt = (errs: ErrorObject[] | null | undefined) =>
  (errs ?? []).map((e) => `${e.instancePath} ${e.message}`).join('\n');

function kindOf(path: string): keyof typeof validators | undefined {
  if (path === 'wren.project.json') return 'project';
  if (path === 'params.json') return 'params';
  if (path.endsWith('.part.json')) return 'part';
  if (path.endsWith('.drawing.json')) return 'drawing';
  if (path.endsWith('.assembly.json')) return 'assembly';
  return undefined;
}

describe('JSON Schema', () => {
  const doc = sampleDoc();

  it('every file of a full project validates against its schema', () => {
    const files = toFiles(doc);
    expect(files.size).toBe(6);
    for (const [path, bytes] of files) {
      const kind = kindOf(path);
      expect(kind, path).toBeDefined();
      const v = validators[kind as keyof typeof validators];
      const ok = v(JSON.parse(strFromU8(bytes)));
      expect(ok, `${path}\n${fmt(v.errors)}`).toBe(true);
    }
  });

  it('the in-memory document validates too', () => {
    const ok = validators.document(doc);
    expect(ok, fmt(validators.document.errors)).toBe(true);
  });

  it('covers all ten feature types and sketch geometry in the fixture', () => {
    const part = JSON.parse(strFromU8(toFiles(doc).get('parts/bracket.part.json') as Uint8Array));
    expect(new Set(part.features.map((f: { type: string }) => f.type))).toEqual(
      new Set([
        'primitive',
        'sketch',
        'extrude',
        'revolve',
        'fillet',
        'chamfer',
        'boolean',
        'pushPull',
        'plane',
        'import',
      ]),
    );
  });

  it('rejects malformed parts', () => {
    const part = structuredClone(doc.parts[0]);
    const bad = (mutate: (p: Record<string, unknown>) => void): boolean => {
      const p = structuredClone(part) as unknown as Record<string, unknown>;
      mutate(p);
      return validators.part(p) as boolean;
    };
    expect(bad(() => {})).toBe(true);
    expect(bad((p) => delete p.rollbackIndex)).toBe(false);
    expect(bad((p) => (p.rollbackIndex = 'x'))).toBe(false);
    expect(bad((p) => (p.surprise = 1))).toBe(false);
    expect(bad((p) => (req((p.features as { type: string }[])[0]).type = 'teleport'))).toBe(false);
    expect(bad((p) => (req((p.features as { suppressed: unknown }[])[2]).suppressed = 'no'))).toBe(
      false,
    );
    expect(bad((p) => (req((p.features as { dx: unknown }[])[2]).dx = 40))).toBe(false);
    expect(bad((p) => ((p.material as { density: unknown }).density = 2.7))).toBe(false);
  });

  it('rejects bad manifests and params', () => {
    const files = toFiles(doc);
    const manifest = JSON.parse(strFromU8(files.get('wren.project.json') as Uint8Array));
    expect(validators.project({ ...manifest, format: 'other' })).toBe(false);
    expect(validators.project({ ...manifest, units: { length: 'furlong', angle: 'deg' } })).toBe(
      false,
    );
    expect(validators.project({ ...manifest, parts: [{ id: 'x' }] })).toBe(false);
    expect(validators.params({ params: [{ id: 'x', name: 'w' }] })).toBe(false);
    expect(validators.params({ params: [] })).toBe(true);
  });

  it('committed schema files are up to date with the TypeScript types', async () => {
    const script = join(import.meta.dirname, '..', 'scripts', 'generate-schema.mjs');
    const mod = (await import(/* @vite-ignore */ script)) as { generate(): Record<string, string> };
    const fresh = mod.generate();
    expect(Object.keys(fresh).length).toBe(6);
    for (const [file, text] of Object.entries(fresh)) {
      expect(
        readFileSync(join(schemaDir, file), 'utf8'),
        `${file} is stale — run pnpm --filter @wren-cad/document schema`,
      ).toBe(text);
    }
  }, 120_000);
});
