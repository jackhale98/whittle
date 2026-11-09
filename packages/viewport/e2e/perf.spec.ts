import { expect, test } from '@playwright/test';
import { open } from './helpers';

/**
 * First-frame cost of the first body: `setBody` -> presented, on a fresh viewport that has had
 * 2 s of idle time (so the idle warm-up could run). Compares with warm-up disabled.
 */
async function firstBodyMs(
  page: import('@playwright/test').Page,
  warm: boolean,
): Promise<{ ms: number; warmMs: number }> {
  await open(page, `?backend=webgl2&reducedMotion=1&empty=1&warm=${warm ? 1 : 0}`);
  await page.waitForTimeout(2500); // idle time for the warm-up
  return page.evaluate(async () => {
    const w = window.__viewport!;
    const t0 = performance.now();
    w.loadBox();
    await w.viewport.nextFrame();
    return {
      ms: performance.now() - t0,
      warmMs: w.viewport.getTouchStats().warmMs,
    };
  });
}

test('perf probe: first-frame shader compile with and without idle warm-up', async ({
  browser,
}) => {
  test.skip(!process.env.WREN_PERF, 'perf probe: set WREN_PERF=1');
  test.setTimeout(240_000);
  const runs = 3;
  const cold: number[] = [];
  const warm: number[] = [];
  let warmMs = 0;
  for (let i = 0; i < runs; i++) {
    for (const mode of [false, true]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const r = await firstBodyMs(page, mode);
      (mode ? warm : cold).push(r.ms);
      if (mode) warmMs = Math.max(warmMs, r.warmMs);
      await ctx.close();
    }
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] as number;
  console.log(
    `[perf] first body setBody->presented: no warm-up ${cold.map((v) => v.toFixed(0)).join('/')} ms ` +
      `(median ${med(cold).toFixed(0)}), idle warm-up ${warm.map((v) => v.toFixed(0)).join('/')} ms ` +
      `(median ${med(warm).toFixed(0)}); warm-up itself ${warmMs.toFixed(0)} ms off the critical path`,
  );
  // The warm-up must never make the first frame slower.
  expect(med(warm)).toBeLessThanOrEqual(med(cold) * 1.1);
});
