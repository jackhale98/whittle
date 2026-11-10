// SPDX-License-Identifier: GPL-3.0-or-later

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { isUlid, newDoc, newPart, ulid, validateDoc } from '../src';

describe('ulid', () => {
  it('produces 26-char Crockford ULIDs', () => {
    for (let i = 0; i < 50; i++) expect(isUlid(ulid())).toBe(true);
    expect(isUlid('01J00000000000000000000001')).toBe(true);
    expect(isUlid('01J0000000000000000000000U')).toBe(false);
    expect(isUlid('short')).toBe(false);
    expect(isUlid(5)).toBe(false);
  });

  it('is strictly increasing, even within one millisecond', () => {
    const t = 1_900_000_000_000;
    const ids = Array.from({ length: 2000 }, () => ulid(t));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('encodes the timestamp in the prefix and never goes backwards', () => {
    const a = ulid(1_900_000_001_000);
    const b = ulid(1_900_000_002_000);
    expect(a < b).toBe(true);
    const c = ulid(1_000); // clock went backwards: still increasing
    expect(c > b).toBe(true);
  });

  it('is unique across many calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) seen.add(ulid());
    expect(seen.size).toBe(20000);
  });
});

describe('factories', () => {
  it('newDoc is valid, current-version and has sensible defaults', () => {
    const d = newDoc();
    expect(validateDoc(d)).toEqual([]);
    expect(d.schemaVersion).toBe(SCHEMA_VERSION);
    expect(d.units).toEqual({ length: 'mm', angle: 'deg' });
    expect(d.meta.name).toBe('Untitled');
    expect(d.meta.created).toBe(d.meta.modified);
    expect(d.parts).toEqual([]);
  });

  it('newDoc options', () => {
    const d = newDoc({
      name: 'X',
      units: { length: 'in', angle: 'rad' },
      firstPart: 'Body',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(d.parts).toHaveLength(1);
    expect(d.parts[0]?.name).toBe('Body');
    expect(d.meta.created).toBe('2026-01-01T00:00:00.000Z');
    expect(validateDoc(d)).toEqual([]);
  });

  it('newPart creates an empty, fully rolled-forward part with a fresh id', () => {
    const p = newPart('Bracket');
    expect(p).toMatchObject({ name: 'Bracket', features: [], rollbackIndex: 0 });
    expect(isUlid(p.id)).toBe(true);
    expect(newPart().id).not.toBe(p.id);
  });
});

describe('worker safety', () => {
  const dir = join(import.meta.dirname, '..', 'src');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('source avoids DOM, Node-only APIs, eval and Function', () => {
    expect(files.length).toBeGreaterThan(8);
    const banned: [RegExp, string][] = [
      [/\bwindow\b/, 'window'],
      [/\bdocument\.(?:get|query|create|body|cookie)/, 'document.*'],
      [/\blocalStorage\b|\bsessionStorage\b/, 'web storage'],
      [/\bnavigator\b/, 'navigator'],
      [/\beval\s*\(/, 'eval'],
      [/\bnew\s+Function\b|\bFunction\s*\(/, 'Function'],
      [/from\s+['"]node:/, 'node: import'],
      [/\brequire\s*\(/, 'require'],
      [/\bprocess\./, 'process'],
      [/\bBuffer\b/, 'Buffer'],
      [/\bsetTimeout\b|\bsetInterval\b/, 'timers'],
    ];
    for (const f of files) {
      const src = strip(readFileSync(join(dir, f), 'utf8'));
      for (const [re, what] of banned) expect(re.test(src), `${f} uses ${what}`).toBe(false);
    }
  });

  it('every source file carries the SPDX header', () => {
    for (const f of files) {
      expect(
        readFileSync(join(dir, f), 'utf8').startsWith(
          '// SPDX-License-Identifier: GPL-3.0-or-later',
        ),
      ).toBe(true);
    }
  });
});
