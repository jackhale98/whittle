import { expect, test } from '@playwright/test';

/**
 * Perf stub (PLAN §10). Today it only probes the placeholder shell; the lead adds viewport and
 * kernel probes (`window.__whittle.firstBodyRendered()`) as those subsystems land. Runs serially
 * in the `perf` Playwright project: `pnpm perf`.
 */
test('shell becomes visible quickly on a warm static server', async ({ page }) => {
  const start = Date.now();
  await page.goto('./');
  await page.getByTestId('app-shell').waitFor();
  const shellMs = Date.now() - start;

  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return { domInteractive: nav.domInteractive, load: nav.loadEventEnd };
  });
  test.info().annotations.push({
    type: 'perf',
    description: `shellVisibleMs=${shellMs} domInteractive=${Math.round(timing.domInteractive)}`,
  });

  // Budget (PLAN §10): time to interactive shell <= 1.5 s (cold, throttled). Unthrottled local
  // runs must be far below it; this guards against gross regressions only.
  expect(shellMs).toBeLessThan(1500);
});
