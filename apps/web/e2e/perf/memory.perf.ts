import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { app, boot } from '../helpers';
import { configPartDoc, P_LENGTH, P_THICK } from '../support/config-part';
import { BUDGETS } from './budgets';

/**
 * Memory (PLAN §10: <= 1 GB peak, iPad tier, typical part). Opens the demo bracket, edits a
 * parameter a few times, and reports the peak of three readings:
 *  - `performance.measureUserAgentSpecificMemory()` (cross-origin isolated only; includes the
 *    kernel worker's Wasm memory). The preferred figure. Headless Chromium often withholds it
 *    ("not available"), in which case it is reported as n/a;
 *  - the whole browser process tree's proportional set size (Linux `/proc`, via CDP
 *    `SystemInfo.getProcessInfo`): includes the Wasm heap, GPU (SwiftShader) and renderer. An upper
 *    bound that is stricter than what an iPad tab is charged;
 *  - the main-thread JS heap (`performance.memory`).
 * The budget is asserted against the largest available figure. Real-device numbers come from
 * Safari Web Inspector on an iPad (docs/DECISIONS.md ADR-010).
 */

interface PageMemory {
  uaBytes: number | null;
  heapBytes: number | null;
  /** Why the UA-specific figure is missing (diagnostic). */
  note: string;
}

async function readPage(page: Page): Promise<PageMemory> {
  return page.evaluate(async () => {
    const p = performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
      memory?: { usedJSHeapSize: number };
    };
    let uaBytes: number | null = null;
    let note = '';
    if (window.crossOriginIsolated && typeof p.measureUserAgentSpecificMemory === 'function') {
      try {
        uaBytes = (await p.measureUserAgentSpecificMemory()).bytes;
      } catch (e) {
        note = String(e);
      }
    } else {
      note = `unavailable (isolated=${window.crossOriginIsolated})`;
    }
    return { uaBytes, heapBytes: p.memory?.usedJSHeapSize ?? null, note };
  });
}

/** Sum of PSS (fallback RSS) over every browser process, in bytes; null off Linux. */
async function processTreeBytes(page: Page): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    const cdp = await page.context().browser()?.newBrowserCDPSession();
    if (!cdp) return null;
    const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as {
      processInfo: { id: number }[];
    };
    await cdp.detach();
    let total = 0;
    for (const { id } of processInfo) {
      try {
        const rollup = readFileSync(`/proc/${id}/smaps_rollup`, 'utf8');
        const kb = /^Pss:\s+(\d+) kB/m.exec(rollup)?.[1];
        if (kb) {
          total += Number(kb) * 1024;
          continue;
        }
      } catch {
        // fall through to RSS
      }
      try {
        const rss = /^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${id}/status`, 'utf8'))?.[1];
        if (rss) total += Number(rss) * 1024;
      } catch {
        // process went away
      }
    }
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

test('demo bracket + edits stay within 1 GB', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const a = app(page);
  await page.getByTestId('welcome').getByTestId('open-demo').click();
  await expect(page.getByTestId('feature-tree')).toContainText('Top chamfer');
  await a.idle();

  const pages: PageMemory[] = [];
  const trees: (number | null)[] = [];
  const sample = async () => {
    pages.push(await readPage(page));
    trees.push(await processTreeBytes(page));
  };
  await sample();
  await page.getByRole('tab', { name: 'Params' }).click();
  const width = page.getByRole('textbox', { name: 'Expression for width' });
  for (const w of ['100 mm', '90 mm', '110 mm', '80 mm']) {
    await width.fill(w);
    await width.press('Enter');
    await a.idle();
    await sample();
  }

  const peak = (v: (number | null)[]): number | null => {
    const n = v.filter((x): x is number => x !== null);
    return n.length ? Math.max(...n) : null;
  };
  const peakUa = peak(pages.map((m) => m.uaBytes));
  const peakHeap = peak(pages.map((m) => m.heapBytes));
  const peakTree = peak(trees);
  const mb = (b: number | null) => (b === null ? 'n/a' : `${(b / 1048576).toFixed(1)} MB`);
  const line =
    `peak userAgentMemory=${mb(peakUa)} processTreePSS=${mb(peakTree)} jsHeap=${mb(peakHeap)} ` +
    `budget=${mb(BUDGETS.peakMemoryBytes)} (uaMemory: ${pages[0]?.note || 'ok'})`;
  console.log(`[perf] memory after demo bracket + 4 edits: ${line}`);
  test.info().annotations.push({ type: 'perf', description: line });

  const figure = Math.max(peakUa ?? 0, peakTree ?? 0, peakHeap ?? 0);
  expect(figure, 'no memory reading available').toBeGreaterThan(0);
  expect(figure).toBeLessThanOrEqual(BUDGETS.peakMemoryBytes);
});

test('a part with four configurations stays within 1 GB and keeps no configuration slot', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await boot(page);
  const a = app(page);
  const doc = configPartDoc();
  doc.parts[0]?.configurations?.push(
    { id: '01JCEXTRA1000000000000000A', name: 'Wide', params: { [P_LENGTH]: '80 mm' } },
    { id: '01JCEXTRA2000000000000000B', name: 'Slim', params: { [P_THICK]: '5 mm' } },
  );
  await a.load(doc);
  await a.idle();
  expect(await a.configurationsBuilt()).toBe(true);
  // Each build releases its shapes once its summary is cached (iPad budget, PLAN §10).
  await expect.poll(async () => (await a.kernelSlots()).filter((s) => s !== 'main')).toEqual([]);
  const tree = await processTreeBytes(page);
  const ua = (await readPage(page)).uaBytes;
  const figure = Math.max(tree ?? 0, ua ?? 0);
  console.log(`[perf] 4 configurations: processTreePSS=${((tree ?? 0) / 1048576).toFixed(1)} MB`);
  expect(figure, 'no memory reading available').toBeGreaterThan(0);
  expect(figure).toBeLessThanOrEqual(BUDGETS.peakMemoryBytes);
});
