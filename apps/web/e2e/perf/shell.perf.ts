import { expect, test } from '@playwright/test';
import { BUDGETS, FAST_4G, PERF_FACTOR } from './budgets';

/**
 * Shell time-to-interactive (PLAN §10: <= 1.5 s cold on fast 4G, mid-range laptop). Enforced in CI
 * by `pnpm perf` (job `perf` in ci.yml) with the SwiftShader factor from budgets.ts.
 *
 * "Cold" = a fresh browser context (no HTTP cache, no service worker), throttled to fast 4G.
 * Measured from navigation start to the shell being visible with a first button present in the
 * first document. The one-time service-worker install + isolation reload (ADR-005) that follows is
 * reported as `isolatedAfterReloadMs` but not budgeted: the shell is already usable.
 */
test('cold shell time-to-interactive on fast 4G', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', FAST_4G);

  const start = Date.now();
  await page.goto('./');
  await page.getByTestId('app-shell').waitFor();
  await page.getByRole('button').first().waitFor();
  const ttiMs = Date.now() - start;
  // Informational: when the one-time isolation reload has finished (SW installed + precached on
  // the throttled link), i.e. when the threaded kernel can start. Not budgeted.
  await page.waitForFunction(() => window.crossOriginIsolated === true);
  const isolatedMs = Date.now() - start;

  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return { domInteractive: nav.domInteractive, load: nav.loadEventEnd };
  });
  const line = `shellTtiMs=${ttiMs} budget=${BUDGETS.shellTtiMs} (x${PERF_FACTOR}) isolatedAfterReloadMs=${isolatedMs} domInteractive=${Math.round(timing.domInteractive)}`;
  console.log(`[perf] cold shell TTI fast-4G: ${line}`);
  test.info().annotations.push({ type: 'perf', description: line });

  expect(ttiMs).toBeLessThan(BUDGETS.shellTtiMs);
});

test('warm shell is visible quickly (SW-cached second visit)', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => window.crossOriginIsolated === true);
  await page.getByTestId('app-shell').waitFor();
  const start = Date.now();
  await page.reload();
  await page.getByTestId('app-shell').waitFor();
  const warmMs = Date.now() - start;
  console.log(`[perf] warm shell visible: ${warmMs} ms`);
  test.info().annotations.push({ type: 'perf', description: `warmShellMs=${warmMs}` });
  expect(warmMs).toBeLessThan(BUDGETS.shellTtiMs);
});
