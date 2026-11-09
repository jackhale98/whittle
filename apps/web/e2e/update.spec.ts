import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/** Same base as the build (ADR-032). */
const BASE_PATH = process.env.WREN_BASE ?? '/wren-cad/';

/**
 * A new deploy must reach users without them closing every tab. Serves a private copy of the build
 * (so other tests are unaffected), visits it, then "deploys" a new service worker and checks that
 * the app picks it up on focus: silently before any interaction, via the "Update available" button
 * after one.
 */

const PORT = 4183;
const BASE = `http://127.0.0.1:${PORT}${BASE_PATH}`;

let dir = '';
let server: ChildProcess | null = null;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wren-update-'));
  cpSync(join(import.meta.dirname, '..', 'dist'), dir, { recursive: true });
  server = spawn(
    process.execPath,
    [
      join(import.meta.dirname, '..', 'scripts', 'static-serve.mjs'),
      '--dir',
      dir,
      '--base',
      BASE_PATH,
      '--port',
      String(PORT),
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('static server did not start');
});

test.afterAll(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

let deploys = 0;
function deployNewServiceWorker(): void {
  deploys++;
  appendFileSync(join(dir, 'sw.js'), `\n// deploy ${deploys} ${Date.now()}\n`);
}

async function activeSwScript(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return `${reg?.active?.scriptURL ?? ''}#${String(reg?.active?.state)}`;
  });
}

test.describe.configure({ mode: 'serial' });

test('a new deploy found before any interaction is applied automatically', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.crossOriginIsolated === true);
  const before = await page.evaluate(() => performance.timeOrigin);

  deployNewServiceWorker();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction((t0) => performance.timeOrigin !== t0, before, { timeout: 15_000 });
  await page.waitForFunction(() => window.crossOriginIsolated === true);
  expect(await activeSwScript(page)).toContain('#activated');
});

test('after interaction, an update shows a non-modal "Update available" button', async ({
  page,
}) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.crossOriginIsolated === true);
  await page.mouse.click(5, 300); // user has interacted: never reload under their hands

  deployNewServiceWorker();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const button = page.getByTestId('update-available');
  await expect(button).toBeVisible({ timeout: 15_000 });

  const before = await page.evaluate(() => performance.timeOrigin);
  await button.click();
  await page.waitForFunction((t0) => performance.timeOrigin !== t0, before, { timeout: 15_000 });
  await expect(page.getByTestId('update-available')).toHaveCount(0);
});

test('⌘K → "Check for updates" reports up to date, or offers the update', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.crossOriginIsolated === true);
  await page.mouse.click(5, 300); // interacted: updates must not auto-apply

  await page.keyboard.press('Control+k');
  await page.getByText('Check for updates').click();
  await expect(page.getByTestId('update-note')).toContainText("You're up to date");

  deployNewServiceWorker();
  await page.keyboard.press('Control+k');
  await page.getByText('Check for updates').click();
  await expect(page.getByTestId('update-available')).toBeVisible({ timeout: 15_000 });
});
