import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import type { Feature, Id, SketchFeature, WrenDoc } from '@wren-cad/contracts';
import { app, boot, palette } from './helpers';
import { PERF_FACTOR } from './perf/budgets';

/**
 * Long-session soak (PLAN H1). Not part of the per-push suites: it has its own Playwright project
 * (`soak`) and needs WREN_SOAK=1 (nightly / workflow_dispatch job "Soak" in ci.yml; locally
 * `WREN_SOAK=1 pnpm --filter @wren-cad/web exec playwright test --project=soak --trace off`).
 *
 * The session: open the demo bracket; make 100 edits (a fixed cycle of ten kinds, ten rounds:
 * parameters, feature edits, suppress / unsuppress, a sketch edit, undo, redo); then close and
 * reopen the document 10 times (one edit in each). Assertions:
 *  - kernel shape handles return to the baseline after every close (the regen cache and the
 *    viewport release everything), and stay bounded while editing;
 *  - the main-thread JS heap (after a forced GC), the kernel worker's Wasm heap and the browser
 *    process tree stay within a bound of the first cycle;
 *  - regen time does not drift: the first and last 10 edits are the same ten kinds, compared as sums.
 *
 * Hooks used: `__wrenApp` (apply, idle, doc, regen, history), `__wren`, and `__wrenKernel.memory()`
 * (apps/web/src/app/kernel-memory.ts: live handles and Wasm heap from the kernel worker).
 */

test.skip(!process.env.WREN_SOAK, 'soak: set WREN_SOAK=1 (minutes)');
test.use({ viewport: { width: 1280, height: 720 } });

const EDITS = 100;
const CYCLES = 10;
const MiB = 1024 * 1024;

type Kernel = {
  memory(): Promise<{
    handles: number;
    heapBytes: number;
    cacheEntries: number;
    cacheHandles: number;
  } | null>;
};
const kernelMemory = (page: Page) =>
  page.evaluate(() => (window as unknown as { __wrenKernel: Kernel }).__wrenKernel.memory());

/** Main-thread JS heap after a forced GC (CDP; `performance.memory` is bucketed). */
async function jsHeapBytes(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
    return usedSize;
  } finally {
    await cdp.detach();
  }
}

/** Sum of PSS (fallback RSS) over every browser process, bytes; null off Linux. Same as memory.perf.ts. */
async function processTreeBytes(page: Page): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  const cdp = await page.context().browser()?.newBrowserCDPSession();
  if (!cdp) return null;
  try {
    const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as {
      processInfo: { id: number }[];
    };
    let total = 0;
    for (const { id } of processInfo) {
      try {
        const kb = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${id}/smaps_rollup`, 'utf8'))?.[1];
        if (kb) total += Number(kb) * 1024;
      } catch {
        // process went away
      }
    }
    return total > 0 ? total : null;
  } finally {
    await cdp.detach();
  }
}

/** Waits until the worker has released everything but `baseline` handles. */
async function settleHandles(page: Page, baseline: number): Promise<number> {
  let last = -2;
  await expect
    .poll(
      async () => {
        last = (await kernelMemory(page))?.handles ?? -2;
        return last;
      },
      { timeout: 30_000, message: 'kernel handles return to baseline' },
    )
    .toBe(baseline);
  return last;
}

const featureNamed = (doc: WrenDoc, name: string): Feature => {
  const f = doc.parts[0]?.features.find((x) => x.name === name);
  if (!f) throw new Error(`no feature "${name}"`);
  return f;
};
const paramId = (doc: WrenDoc, name: string): Id => {
  const p = doc.params.find((x) => x.name === name);
  if (!p) throw new Error(`no param "${name}"`);
  return p.id;
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

test('100 edits and 10 close/reopen cycles: handles back to baseline, memory bounded, no drift', async ({
  page,
}) => {
  test.setTimeout(45 * 60_000);
  await boot(page);
  const a = app(page);
  await expect
    .poll(async () => (await kernelMemory(page))?.handles ?? -1, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(0);
  const baseline = (await kernelMemory(page))?.handles ?? -1;

  const openDemo = async () => {
    await page.getByTestId('welcome').getByTestId('open-demo').click();
    await expect(page.getByTestId('feature-tree')).toContainText('Top chamfer');
    await a.idle();
  };
  const closeDoc = async () => {
    await a.flushSave();
    await palette(page, 'New document');
    await a.idle();
  };
  /** Runs the edit, then waits for the regen to settle; returns wall ms. */
  const timed = async (run: () => Promise<unknown>): Promise<number> => {
    const t0 = Date.now();
    await run();
    await a.idle();
    return Date.now() - t0;
  };

  /** The ten edit kinds. `k` is the round (0-based), so every round differs. */
  const kinds: ((k: number) => Promise<number>)[] = [
    // 0 parameter
    async (k) => {
      const doc = await a.doc();
      return timed(() =>
        a.apply({ kind: 'updateParam', paramId: paramId(doc, 'width'), expr: `${80 + k} mm` }),
      );
    },
    // 1 parameter
    async (k) => {
      const doc = await a.doc();
      return timed(() =>
        a.apply({
          kind: 'updateParam',
          paramId: paramId(doc, 'thickness'),
          expr: `${8 + (k % 3)} mm`,
        }),
      );
    },
    // 2 feature edit: fillet radius
    async (k) => {
      const doc = await a.doc();
      const f = structuredClone(featureNamed(doc, 'Corner fillets'));
      if (f.type !== 'fillet') throw new Error('Corner fillets is not a fillet');
      f.radius = `${4 + (k % 3)} mm`;
      return timed(() =>
        a.apply({ kind: 'updateFeature', partId: doc.parts[0]?.id, featureId: f.id, feature: f }),
      );
    },
    // 3 feature edit: chamfer distance
    async (k) => {
      const doc = await a.doc();
      const f = structuredClone(featureNamed(doc, 'Top chamfer'));
      if (f.type !== 'chamfer') throw new Error('Top chamfer is not a chamfer');
      f.mode = { kind: 'distance', distance: `${1 + (k % 3)} mm` };
      return timed(() =>
        a.apply({ kind: 'updateFeature', partId: doc.parts[0]?.id, featureId: f.id, feature: f }),
      );
    },
    // 4 suppress
    async () => {
      const doc = await a.doc();
      return timed(() =>
        a.apply({
          kind: 'setSuppressed',
          partId: doc.parts[0]?.id,
          featureId: featureNamed(doc, 'Top chamfer').id,
          suppressed: true,
        }),
      );
    },
    // 5 unsuppress
    async () => {
      const doc = await a.doc();
      return timed(() =>
        a.apply({
          kind: 'setSuppressed',
          partId: doc.parts[0]?.id,
          featureId: featureNamed(doc, 'Top chamfer').id,
          suppressed: false,
        }),
      );
    },
    // 6 sketch edit: the plate sketch's width dimension, driven by `width` or overridden
    async (k) => {
      const doc = await a.doc();
      const f = structuredClone(featureNamed(doc, 'Plate sketch')) as SketchFeature;
      const dim = f.constraints.find((c) => c.kind === 'hDistance');
      if (!dim || !('value' in dim)) throw new Error('no width dimension in the plate sketch');
      dim.value = k % 2 === 0 ? `${82 + (k % 5)} mm` : 'width';
      return timed(() =>
        a.apply({ kind: 'updateFeature', partId: doc.parts[0]?.id, featureId: f.id, feature: f }),
      );
    },
    // 7 undo (the sketch edit)
    async () => timed(() => page.keyboard.press('ControlOrMeta+z')),
    // 8 redo
    async () => timed(() => page.keyboard.press('ControlOrMeta+Shift+z')),
    // 9 parameter
    async (k) => {
      const doc = await a.doc();
      return timed(() =>
        a.apply({
          kind: 'updateParam',
          paramId: paramId(doc, 'hole_d'),
          expr: `${5 + (k % 3)} mm`,
        }),
      );
    },
  ];

  await openDemo();
  const sessionStart = (await kernelMemory(page))?.handles ?? -1;
  const times: number[] = [];
  let maxHandles = sessionStart;
  for (let i = 0; i < EDITS; i++) {
    times.push(
      await (kinds[i % kinds.length] as (k: number) => Promise<number>)(Math.floor(i / 10)),
    );
    if (i % 5 === 4) maxHandles = Math.max(maxHandles, (await kernelMemory(page))?.handles ?? 0);
  }
  // Every feature still regenerates after the whole session.
  await expect
    .poll(async () => (await a.regen())?.features.map((f) => f.state).join(','))
    .toBe(Array(9).fill('ok').join(','));

  // Close and reopen, 10 times.
  const cycles: {
    handles: number;
    cache: number;
    wasm: number;
    js: number;
    tree: number | null;
  }[] = [];
  for (let c = 0; c < CYCLES; c++) {
    if (c > 0) {
      await palette(page, 'Welcome');
      await openDemo();
    }
    await kinds[c % 3]?.(c); // one edit in each cycle
    await closeDoc();
    const handles = await settleHandles(page, baseline);
    const mem = await kernelMemory(page);
    cycles.push({
      handles,
      cache: (mem?.cacheEntries ?? -1) + (mem?.cacheHandles ?? -1),
      wasm: mem?.heapBytes ?? -1,
      js: await jsHeapBytes(page),
      tree: await processTreeBytes(page),
    });
  }

  const first10 = sum(times.slice(0, 10));
  const last10 = sum(times.slice(-10));
  const mb = (n: number | null) => (n === null ? 'n/a' : `${(n / MiB).toFixed(1)}`);
  const report =
    `baseline handles=${baseline} sessionStart=${sessionStart} maxDuringSession=${maxHandles}; ` +
    `regen first10=${first10} ms last10=${last10} ms (median ${median(times.slice(0, 10))}/${median(times.slice(-10))} ms); ` +
    `after close: handles ${cycles.map((c) => c.handles).join('/')}; ` +
    `wasm MiB ${cycles.map((c) => mb(c.wasm)).join('/')}; ` +
    `js heap MiB ${cycles.map((c) => mb(c.js)).join('/')}; ` +
    `process tree PSS MiB ${cycles.map((c) => mb(c.tree)).join('/')}`;
  console.log(`[soak] ${report}`);
  test.info().annotations.push({ type: 'soak', description: report });

  // Handles: every close returns to the baseline (settleHandles already polled for it).
  for (const c of cycles) expect(c.handles).toBe(baseline);
  // ...and the regen cache holds nothing for a closed part (0 entries, 0 handles).
  for (const c of cycles) expect(c.cache).toBe(0);
  // The regen cache is an LRU with a tier budget (desktop 128 results): bounded while editing.
  expect(maxHandles).toBeLessThanOrEqual(500);

  // Memory: the last cycle stays within a bound of the first (allocator noise allowed).
  const f = cycles[0] as (typeof cycles)[number];
  const l = cycles[CYCLES - 1] as (typeof cycles)[number];
  expect(l.wasm, 'Wasm heap after the last close').toBeLessThanOrEqual(f.wasm * 1.25 + 32 * MiB);
  expect(l.js, 'JS heap after the last close').toBeLessThanOrEqual(f.js * 1.5 + 24 * MiB);
  if (f.tree !== null && l.tree !== null) {
    expect(l.tree, 'process tree after the last close').toBeLessThanOrEqual(
      f.tree * 1.5 + 128 * MiB,
    );
    expect(l.tree).toBeLessThanOrEqual(1024 * MiB);
  }

  // No drift: the last ten edits (the same ten kinds as the first ten) cost about the same.
  expect(last10, 'regen time of the last 10 edits vs the first 10').toBeLessThanOrEqual(
    first10 * 1.5 + 500 * PERF_FACTOR,
  );
});
