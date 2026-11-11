import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

/**
 * Memory readings shared by the report-only stress spec (same three sources as memory.perf.ts:
 * `measureUserAgentSpecificMemory` incl. the kernel worker's Wasm, the browser process tree's PSS,
 * and the main-thread JS heap).
 */
export async function peakMemory(
  page: Page,
): Promise<{ ua: number | null; tree: number | null; heap: number | null; note: string }> {
  const inPage = await page.evaluate(async () => {
    const p = performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
      memory?: { usedJSHeapSize: number };
    };
    let ua: number | null = null;
    let note = 'ok';
    if (window.crossOriginIsolated && typeof p.measureUserAgentSpecificMemory === 'function') {
      try {
        ua = (await p.measureUserAgentSpecificMemory()).bytes;
      } catch (e) {
        note = String(e);
      }
    } else {
      note = `uaMemory unavailable (isolated=${window.crossOriginIsolated})`;
    }
    return { ua, heap: p.memory?.usedJSHeapSize ?? null, note };
  });
  return { ...inPage, tree: await processTreeBytes(page) };
}

/** Sum of PSS (fallback RSS) over every browser process, in bytes; null off Linux. */
export async function processTreeBytes(page: Page): Promise<number | null> {
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
        const kb = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${id}/smaps_rollup`, 'utf8'))?.[1];
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
