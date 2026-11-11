/**
 * Stress part, no kernel: the fixture is well formed, deterministic, round-trips through the
 * `.wrencad` codec, and the committed `apps/web/e2e/fixtures/stress-enclosure.wrencad` is exactly
 * what the builder produces. Regenerate that file after changing the part:
 *
 *   UPDATE_STRESS_FIXTURE=1 pnpm --filter @wren-cad/test-fixtures test -- stress-part.fixture
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, projectCodec } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import {
  ENCLOSURE_DIMS,
  enclosureDoc,
  enclosureFeatureIds,
  enclosureStepIds,
} from '../stress-part';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = resolve(
  here,
  '../../../apps/web/e2e/fixtures/stress-enclosure.wrencad',
);

describe('stress part fixture', () => {
  const doc = enclosureDoc();
  const features = doc.parts[0]?.features ?? [];

  it('has 100+ features of the expected kinds', () => {
    expect(features.length).toBeGreaterThanOrEqual(100);
    const kinds = new Set(features.map((f) => f.type));
    for (const k of [
      'sketch',
      'extrude',
      'draft',
      'shell',
      'fillet',
      'chamfer',
      'hole',
      'linearPattern',
      'mirror',
    ]) {
      expect(kinds.has(k as never), k).toBe(true);
    }
    const count = (t: string) => features.filter((f) => f.type === t).length;
    expect(count('fillet') + count('chamfer')).toBeGreaterThanOrEqual(10);
    expect(count('hole')).toBeGreaterThanOrEqual(8);
    expect(count('linearPattern') + count('mirror')).toBeGreaterThanOrEqual(10);
  });

  it('is driven by named parameters that all parse', () => {
    expect(Object.keys(ENCLOSURE_DIMS).length).toBeGreaterThanOrEqual(12);
    expect(doc.params.map((p) => p.name)).toEqual(Object.keys(ENCLOSURE_DIMS));
    // Every parameter is used by some feature or sketch dimension.
    const text = JSON.stringify(features);
    for (const p of doc.params) expect(text, `unused parameter ${p.name}`).toContain(p.name);
  });

  it('has unique, stable ids and no dangling step references', () => {
    const ids = features.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(enclosureStepIds()).toHaveLength(ids.length);
    const known = new Set(Object.values(enclosureFeatureIds()));
    const text = JSON.stringify(features);
    for (const m of text.matchAll(/01JRP90\d{3}0{16}/g)) expect(known.has(m[0]), m[0]).toBe(true);
    expect(text).not.toMatch(/[FSB]\{[a-z]/);
  });

  it('is deterministic and round-trips through the codec', () => {
    expect(canonicalJson(enclosureDoc())).toBe(canonicalJson(doc));
    const bytes = projectCodec.toWren(doc);
    const back = projectCodec.fromWren(bytes).doc;
    expect(canonicalJson(back.parts)).toBe(canonicalJson(doc.parts));
    expect(canonicalJson(back.params)).toBe(canonicalJson(doc.params));
  });

  it('matches the committed .wrencad (UPDATE_STRESS_FIXTURE=1 rewrites it)', () => {
    const bytes = projectCodec.toWren(doc);
    if (process.env.UPDATE_STRESS_FIXTURE === '1') {
      mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
      writeFileSync(FIXTURE_PATH, bytes);
    }
    expect(existsSync(FIXTURE_PATH), 'run with UPDATE_STRESS_FIXTURE=1 to create it').toBe(true);
    const onDisk = projectCodec.fromWren(new Uint8Array(readFileSync(FIXTURE_PATH))).doc;
    expect(canonicalJson(onDisk.parts)).toBe(canonicalJson(doc.parts));
    expect(canonicalJson(onDisk.params)).toBe(canonicalJson(doc.params));
  });
});
