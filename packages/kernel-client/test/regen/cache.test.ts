/**
 * Regen goldens 7 and 9: the incremental cache (PLAN §4) on a 50-feature part against the PLAN §10
 * budget (≤ 300 ms after editing the last feature), and handle accounting across many regens.
 * Timings are printed for the report.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature } from '@wren-cad/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bracketDoc } from './bracket';
import {
  type Api,
  built,
  describeFailures,
  extrude,
  fid,
  loadApi,
  makeDoc,
  PERF_FACTOR,
  region,
  relClose,
  Sk,
  skipNote,
  states,
  totalVolume,
  withParams,
} from './helpers';

const PART = fid('PART');
const PI = Math.PI;

/** Plate 240 × 100 × 10 + 24 hole (sketch, cut) pairs = 50 features; the last cut is blind. */
function fiftyFeatures(): Feature[] {
  const s = new Sk();
  const r = s.rect('p', 'L', 0, 0, 240, 100, '240', '100');
  s.geo({ kind: 'fix', entity: r.a });
  const features: Feature[] = [
    s.feature(fid('Q0')),
    extrude(fid('QE'), [region(fid('Q0'), 'L1,L2,L3,L4')], '10'),
  ];
  for (let i = 0; i < 24; i++) {
    const hs = new Sk();
    const x = 10 + (i % 12) * 20;
    const y = i < 12 ? 30 : 70;
    hs.circle('C', x, y, 4);
    hs.geo({ kind: 'fix', entity: 'Cc' });
    hs.dim({ kind: 'radius', curve: 'C' }, '4');
    const sid = fid(`QS${i}`);
    features.push(hs.feature(sid));
    features.push(
      i === 23
        ? extrude(fid(`QC${i}`), [region(sid, 'C')], 'last_depth', 'cut')
        : extrude(fid(`QC${i}`), [region(sid, 'C')], 'throughAll', 'cut'),
    );
  }
  return features;
}

/** Plate (thickness `t`) + 49 through holes: an edit of `t` misses all 50 solid features. */
function hundredFeatures(): Feature[] {
  const s = new Sk();
  const r = s.rect('p', 'L', 0, 0, 280, 140, '280', '140');
  s.geo({ kind: 'fix', entity: r.a });
  const features: Feature[] = [
    s.feature(fid('HQ0')),
    extrude(fid('HQE'), [region(fid('HQ0'), 'L1,L2,L3,L4')], 't'),
  ];
  for (let i = 0; i < 49; i++) {
    const hs = new Sk();
    hs.circle('C', 10 + (i % 7) * 40, 10 + Math.floor(i / 7) * 20, 3);
    hs.geo({ kind: 'fix', entity: 'Cc' });
    hs.dim({ kind: 'radius', curve: 'C' }, '3');
    const sid = fid(`HQS${i}`);
    features.push(hs.feature(sid));
    features.push(extrude(fid(`HQC${i}`), [region(sid, 'C')], 'throughAll', 'cut'));
  }
  return features;
}

const fiftyVolume = (lastDepth: number) =>
  240 * 100 * 10 - 23 * PI * 16 * 10 - PI * 16 * Math.min(10, lastDepth);

const ms = (x: number) => `${x.toFixed(1)} ms`;

describe.skipIf(!built)(`regen golden: cache and handles${skipNote}`, () => {
  let api: Api;
  beforeAll(async () => {
    api = await loadApi();
  }, 60_000);
  afterAll(async () => {
    await api?.closePart(PART);
  });

  it('50 features: editing the last recomputes only it, within the 300 ms budget', async () => {
    const doc = makeDoc({ last_depth: '4 mm' }, fiftyFeatures());
    expect(doc.parts[0]?.features).toHaveLength(50);
    const cold = await api.regenerate({
      doc,
      partId: PART,
      quality: 'coarse',
      massProperties: true,
    });
    expect(states(cold), describeFailures(cold)).toEqual(Array(50).fill('ok'));
    expect(cold.cache).toEqual({ hits: 0, misses: 50 });
    relClose(totalVolume(cold.bodies), fiftyVolume(4), 1e-9);

    const warm = await api.regenerate({
      doc,
      partId: PART,
      quality: 'coarse',
      massProperties: true,
    });
    expect(warm.cache).toEqual({ hits: 50, misses: 0 });

    const edits: number[] = [];
    let last = warm;
    for (const depth of ['5 mm', '6 mm', '7 mm', '3 mm', '8 mm']) {
      last = await api.regenerate({
        doc: withParams(doc, { last_depth: depth }),
        partId: PART,
        quality: 'coarse',
        massProperties: true,
      });
      edits.push(last.totalMs);
      expect(last.features.map((f) => f.cached)).toEqual([...Array(49).fill(true), false]);
      expect(last.cache).toEqual({ hits: 49, misses: 1 });
    }
    relClose(totalVolume(last.bodies), fiftyVolume(8), 1e-9);
    const fine = await api.regenerate({
      doc: withParams(doc, { last_depth: '9 mm' }),
      partId: PART,
      quality: 'fine',
      massProperties: true,
    });
    const median = [...edits].sort((a, b) => a - b)[2] as number;
    console.log(
      `[regen timing] 50 features: cold ${ms(cold.totalMs)}, all cached ${ms(warm.totalMs)}, ` +
        `edit last (coarse) median ${ms(median)} [${edits.map(ms).join(', ')}], ` +
        `edit last (fine) ${ms(fine.totalMs)}; last-feature kernel time ${ms(last.features[49]?.ms ?? 0)}`,
    );
    expect(median).toBeLessThan(300 * PERF_FACTOR);
  }, 60_000); // cold 50-feature regen is ~2 s alone, ~4 s on a loaded 2-vCPU CI runner

  it('bracket timings (cold full regen, warm, one-dimension edit)', async () => {
    await api.closePart(PART);
    const doc = bracketDoc();
    const cold = await api.regenerate({ doc, partId: PART, quality: 'fine', massProperties: true });
    expect(states(cold), describeFailures(cold)).toEqual(Array(9).fill('ok'));
    const warm = await api.regenerate({ doc, partId: PART, quality: 'fine', massProperties: true });
    const edit = await api.regenerate({
      doc: withParams(doc, { chamfer_d: '3 mm' }),
      partId: PART,
      quality: 'fine',
      massProperties: true,
    });
    const width = await api.regenerate({
      doc: withParams(doc, { width: '90 mm' }),
      partId: PART,
      quality: 'fine',
      massProperties: true,
    });
    console.log(
      `[regen timing] bracket (9 features, fine): cold (empty cache) ${ms(cold.totalMs)}, ` +
        `all cached ${ms(warm.totalMs)}, chamfer edit ${ms(edit.totalMs)} ` +
        `(hits ${edit.cache.hits}/${edit.features.length}), width edit (full) ${ms(width.totalMs)}`,
    );
    expect(warm.cache.hits).toBe(9);
    expect(edit.cache).toEqual({ hits: 8, misses: 1 });
  });

  it('no handle leaks across 100 regens; closePart releases everything', async () => {
    const small = await loadApi({ maxSpareResults: 8 });
    const baseline = small.liveHandleCount();
    const doc = bracketDoc();
    const counts: number[] = [];
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      // Mix of new values (cache misses), repeats (hits) and an occasional failure.
      const width = i % 10 === 9 ? '-5 mm' : `${80 + (i % 7)} mm`;
      const r = await small.regenerate({
        doc: withParams(doc, { width, hole_spacing: `${30 + (i % 3) * 5} mm` }),
        partId: PART,
        quality: 'coarse',
      });
      expect(r.revision).toBe(i + 1);
      counts.push(small.liveHandleCount() - baseline);
    }
    const peak = Math.max(...counts);
    const settled = counts.slice(50);
    console.log(
      `[regen handles] 100 regens, maxSpareResults 8: live handles after regen 10/50/100 = ` +
        `${counts[9]}/${counts[49]}/${counts[99]}, peak ${peak}; engine ${JSON.stringify(small.engine.stats(PART))}; ` +
        `${ms((performance.now() - t0) / 100)} per regen`,
    );
    // Bounded: the latest regen's results + 8 spare entries (each ≤ 2 shapes) + ghosts.
    expect(peak).toBeLessThanOrEqual(9 * 2 + 8 * 2 + 9);
    expect(Math.max(...settled)).toBeLessThanOrEqual(Math.max(...counts.slice(10, 50)));
    expect(small.engine.stats(PART)?.handles).toBe(counts[99]);
    await small.closePart(PART);
    expect(small.liveHandleCount()).toBe(baseline);
    expect(small.engine.stats(PART)).toBeNull();
  }, 120_000);

  it('memoryStats reports the live handles and the Wasm heap (diagnostics)', async () => {
    // Start from a closed part: an earlier test may leave this bracket cached, and a cache hit
    // would add no handles (seen in a serial run: 19 vs 19).
    await api.closePart(PART);
    const m0 = await api.memoryStats();
    expect(m0.liveHandles).toBe(api.liveHandleCount());
    expect(m0.wasmHeapBytes).toBeGreaterThan(0);
    await api.regenerate({ doc: bracketDoc(), partId: PART, quality: 'coarse' });
    const m1 = await api.memoryStats();
    expect(m1.liveHandles).toBeGreaterThan(m0.liveHandles);
    await api.closePart(PART);
    expect((await api.memoryStats()).liveHandles).toBe(m0.liveHandles);
  });

  it('the default spare budget keeps three earlier states of a large part (ADR-084)', async () => {
    const doc = makeDoc({ t: '10 mm' }, hundredFeatures());
    const undoAfterThreeEdits = async (a: Api) => {
      const r0 = await a.regenerate({ doc, partId: PART, quality: 'coarse' });
      expect(states(r0), describeFailures(r0)).toEqual(Array(100).fill('ok'));
      for (const t of ['11 mm', '12 mm', '13 mm']) {
        const r = await a.regenerate({
          doc: withParams(doc, { t }),
          partId: PART,
          quality: 'coarse',
        });
        expect(r.cache.misses).toBe(50);
      }
      // 150 spare entries now: back to the first state is a hit only if all of them were kept.
      const back = await a.regenerate({ doc, partId: PART, quality: 'coarse' });
      const limit = (await a.memoryStats()).regen.limits.maxSpareResults;
      await a.closePart(PART);
      return { ...back.cache, limit };
    };
    await api.closePart(PART);
    // The reported limit is the effective one: three states of the 100 entries.
    expect(await undoAfterThreeEdits(api)).toEqual({ hits: 100, misses: 0, limit: 300 });
    expect((await api.memoryStats()).regen.limits.maxSpareResults).toBe(128); // no part: the floor
    // A configured bound stays a hard bound: 128 keeps 128 of the 150.
    const bounded = await loadApi({ maxSpareResults: 128 });
    const cache = await undoAfterThreeEdits(bounded);
    expect(cache.misses).toBeGreaterThan(0);
    expect(cache.limit).toBe(128);
    expect(cache.hits + cache.misses).toBe(100);
  }, 120_000);

  it('configureRegen lowers the spare budget at runtime (device tiers)', async () => {
    const doc = bracketDoc();
    const regen = (width: string) =>
      api.regenerate({ doc: withParams(doc, { width }), partId: PART, quality: 'coarse' });
    for (const w of ['81 mm', '82 mm', '83 mm', '84 mm']) await regen(w);
    const before = api.engine.stats(PART)?.entries ?? 0;
    await api.configureRegen({ maxSpareResults: 0 });
    await regen('85 mm');
    const after = api.engine.stats(PART)?.entries ?? 0;
    // Only the latest regen's and the last all-ok regen's entries survive (here the same: 9).
    expect(after).toBe(9);
    expect(before).toBeGreaterThan(after);
    await api.configureRegen({ maxSpareResults: -1 }); // invalid: ignored
    await api.configureRegen({ maxSpareResults: 128 });
    await api.closePart(PART);
  });
});
