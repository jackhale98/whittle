/**
 * Memory guard (PLAN H1): the LRU feature-result cache at a large model size. A 200-feature part
 * regenerated with many distinct results, a partial failure (last-good entries kept for ghosts),
 * more version slots than the bound and a runtime budget change must keep the cache within its
 * configured limits, account for every live kernel handle, and give everything back on `closePart`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature } from '@wren-cad/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { KernelMemoryStats } from '../../src/modeling-api';
import {
  type Api,
  built,
  describeFailures,
  extrude,
  fid,
  loadApi,
  makeDoc,
  region,
  Sk,
  skipNote,
  states,
  withParams,
} from './helpers';

const PART = fid('MEMPART');
const PAIRS = 100;
const FEATURES = 2 * PAIRS;
const MAX_SPARE = 16;
const MAX_SLOTS = 2;

/**
 * 100 × (sketch of a 4 × 4 square, extruded as a new body) = 200 features, 100 bodies (ids end in
 * `Z`: `fid` pads with zeros, so `ME1` and `ME10` would collide). Extrudes
 * use the depth `h`, every tenth one `g` instead (so a bad `g` fails 10 features, not all).
 */
function twoHundredFeatures(): Feature[] {
  const features: Feature[] = [];
  for (let i = 0; i < PAIRS; i++) {
    const s = new Sk();
    const x = (i % 10) * 10;
    const y = Math.floor(i / 10) * 10;
    const r = s.rect('p', 'L', x, y, x + 4, y + 4, '4', '4');
    s.geo({ kind: 'fix', entity: r.a });
    const sid = fid(`MS${i}Z`);
    features.push(s.feature(sid));
    features.push(extrude(fid(`ME${i}Z`), [region(sid, 'L1,L2,L3,L4')], i % 10 === 9 ? 'g' : 'h'));
  }
  return features;
}

/** The rows of `PART` in the regen stats. */
const rows = (m: KernelMemoryStats) => m.regen.slots.filter((s) => s.partId === PART);

/** Invariants of every snapshot taken between engine calls. */
function checkAccounting(m: KernelMemoryStats, baseline: number): void {
  const importHandles = m.regen.slots.reduce((n, s) => n + s.importHandles, 0);
  expect(m.regen.ownedHandles).toBe(m.regen.handles + importHandles);
  // Between calls every live handle beyond the baseline belongs to the engine's caches.
  expect(m.liveHandles - baseline).toBe(m.regen.ownedHandles);
  expect(rows(m).length).toBeLessThanOrEqual(1 + MAX_SLOTS);
  for (const r of rows(m)) {
    // Kept: the latest regen's entries and the last all-ok regen's (≤ 2 × FEATURES), plus spares.
    expect(r.entries).toBeLessThanOrEqual(2 * FEATURES + MAX_SPARE);
    // Each entry owns at most two shapes.
    expect(r.handles).toBeLessThanOrEqual(2 * r.entries);
  }
}

const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;

describe.skipIf(!built)(`memory guard: LRU result cache at 200 features${skipNote}`, () => {
  let api: Api;
  let baseline = 0;
  const doc = makeDoc({ h: '5 mm', g: '5 mm' }, twoHundredFeatures(), PART);

  beforeAll(async () => {
    api = await loadApi({ maxSpareResults: MAX_SPARE, maxVersionSlots: MAX_SLOTS });
    baseline = api.liveHandleCount();
  }, 60_000);
  afterAll(async () => {
    await api?.closePart(PART);
  });

  it('reports the configured limits, the Wasm heap and an empty cache before any regen', async () => {
    const m = await api.memoryStats();
    expect(m.regen.limits).toEqual({
      maxSpareResults: MAX_SPARE,
      maxVersionSlots: MAX_SLOTS,
      importSpare: 8,
    });
    expect(m.liveHandles).toBe(baseline);
    expect(m.wasmHeapBytes).toBeGreaterThan(0);
    expect(m.wasmHeapBytes % 65_536).toBe(0); // whole Wasm pages
    expect(rows(m)).toEqual([]);
    expect(m.regen.ownedHandles).toBe(0);
  });

  it('stays bounded over many regens with distinct results, a partial failure and version slots', async () => {
    const regen = async (changes: Record<string, string>, slot?: `version:${string}`) => {
      const r = await api.regenerate({
        doc: withParams(doc, changes),
        partId: PART,
        quality: 'coarse',
        ...(slot === undefined ? {} : { slot }),
      });
      const m = await api.memoryStats();
      checkAccounting(m, baseline);
      return { r, m };
    };

    // Cold: every feature is a miss; one entry (one shape) per feature.
    const cold = await regen({});
    expect(states(cold.r), describeFailures(cold.r)).toEqual(Array(FEATURES).fill('ok'));
    expect(cold.r.bodies).toHaveLength(PAIRS);
    expect(rows(cold.m)).toEqual([
      expect.objectContaining({ slot: 'main', entries: FEATURES, handles: FEATURES }),
    ]);

    // Distinct depths: each regen misses all 100 extrudes (the sketches hit), so each pushes 100
    // results out of use. Only MAX_SPARE of them survive, least recently used first out.
    const entries: number[] = [];
    for (let i = 1; i <= 12; i++) {
      const { r, m } = await regen({ h: `${5 + i} mm`, g: `${5 + i} mm` });
      expect(r.cache).toEqual({ hits: PAIRS, misses: PAIRS });
      const main = rows(m)[0];
      entries.push(main?.entries ?? -1);
      expect(main?.entries).toBe(FEATURES + MAX_SPARE);
      expect(main?.handles).toBe(FEATURES + MAX_SPARE);
    }

    // A partial failure keeps the last all-ok regen's entries too (ghosts): bounded by both.
    const bad = await regen({ h: '30 mm', g: 'nope' });
    expect(bad.r.features.filter((f) => f.state === 'error')).toHaveLength(PAIRS / 10);
    expect(bad.r.ghosts?.length).toBeGreaterThan(0);
    const badMain = rows(bad.m)[0];
    const latestAndLastGood = FEATURES + (FEATURES - PAIRS / 10 - PAIRS); // + lastGood's own extrudes
    expect(badMain?.entries).toBe(latestAndLastGood + MAX_SPARE);
    // Recovery: the failed regen's leftovers age out like any other spare.
    const good = await regen({ h: '31 mm', g: '31 mm' });
    expect(rows(good.m)[0]?.entries).toBe(FEATURES + MAX_SPARE);

    // Version slots: three slots for a bound of two; the least recently used one is released.
    const depths = { a: '41 mm', b: '42 mm', c: '43 mm' };
    for (const [v, h] of Object.entries(depths)) await regen({ h }, `version:${v}`);
    const versions = await api.memoryStats();
    expect(rows(versions).map((s) => s.slot)).toEqual(['main', 'version:c', 'version:b']);
    for (const r of rows(versions)) expect(r.entries).toBeLessThanOrEqual(FEATURES + MAX_SPARE);

    // A lower spare budget at runtime applies at the next regen of the slot.
    await api.configureRegen({ maxSpareResults: 4 });
    const lowered = await api.regenerate({
      doc: withParams(doc, { h: '50 mm', g: '50 mm' }),
      partId: PART,
      quality: 'coarse',
    });
    expect(lowered.cache.misses).toBe(PAIRS);
    const after = await api.memoryStats();
    expect(after.regen.limits.maxSpareResults).toBe(4);
    expect(rows(after)[0]?.entries).toBe(FEATURES + 4);
    expect(after.liveHandles - baseline).toBe(after.regen.ownedHandles);
    await api.configureRegen({ maxSpareResults: MAX_SPARE });

    console.log(
      `[memory guard] ${FEATURES} features, maxSpareResults ${MAX_SPARE}, maxVersionSlots ${MAX_SLOTS}: ` +
        `main entries after regen 1..12 = ${entries.join('/')}, after a partial failure ${badMain?.entries}; ` +
        `with 3 slots: ${rows(versions)
          .map((s) => `${s.slot} ${s.entries}/${s.handles}`)
          .join(', ')}; ` +
        `owned handles ${versions.regen.ownedHandles}, cached meshes ${versions.regen.shapeCaches.meshes} ` +
        `(${mb(versions.regen.shapeCaches.meshBytes)}), Wasm heap ${mb(versions.wasmHeapBytes)}`,
    );
  }, 240_000);

  it('closePart gives every entry, handle and per-handle cache back', async () => {
    const before = await api.memoryStats();
    expect(rows(before).length).toBeGreaterThan(0);
    await api.closePart(PART);
    const m = await api.memoryStats();
    expect(rows(m)).toEqual([]);
    expect(m.regen.entries).toBe(0);
    expect(m.regen.handles).toBe(0);
    expect(m.regen.ownedHandles).toBe(0);
    expect(m.liveHandles).toBe(baseline);
    expect(m.regen.shapeCaches).toEqual({
      fingerprints: 0,
      massProperties: 0,
      meshes: 0,
      meshBytes: 0,
      geometry: 0,
    });
    // Linear memory never shrinks; the freed space is reused by the next part.
    expect(m.wasmHeapBytes).toBeGreaterThanOrEqual(before.wasmHeapBytes);
  });
});
