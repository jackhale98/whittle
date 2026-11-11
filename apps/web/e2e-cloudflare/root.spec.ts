import { expect, test } from '@playwright/test';
import type { RuntimeDiagnostics, WrenTestHooks } from '@wren-cad/contracts';

type W = { __wren: WrenTestHooks };

test('root-base build: isolated on the very first load, threaded kernel boots', async ({
  page,
}) => {
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  expect(response?.headers()['cache-control']).toBe('no-cache');

  // Isolated by the server's headers: no service-worker reload is needed.
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  await page.waitForFunction(() => !!(window as unknown as Partial<W>).__wren);
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('status-line')).toContainText('threaded kernel available');
  // The kernel loads and meshes the default document.
  await page.evaluate(() => (window as unknown as W).__wren.firstBodyRendered());

  const d: RuntimeDiagnostics = await page.evaluate(() =>
    (window as unknown as W).__wren.diagnostics(),
  );
  expect(d.crossOriginIsolated).toBe(true);
  expect(d.serviceWorker).toBe('active');
  await page.waitForTimeout(1000);
  expect(navigations).toBe(1);

  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(`${new URL(page.url()).origin}/`);
});

test('hashed kernel assets are immutable wasm; unknown paths fall back to the shell with 200', async ({
  page,
  request,
}) => {
  // The kernel is fetched by its worker: watch the whole context, not just the page.
  const wasmUrl = new Promise<string>((resolve) =>
    page.context().on('response', (r) => {
      if (r.url().endsWith('.wasm') && r.url().includes('whittle-kernel')) resolve(r.url());
    }),
  );
  await page.goto('/');
  const wasm = await wasmUrl;
  expect(wasm).toMatch(/\/assets\/whittle-kernel.*\.wasm$/);
  const res = await request.head(wasm);
  expect(res.headers()['content-type']).toBe('application/wasm');
  expect(res.headers()['cache-control']).toBe('public, max-age=31536000, immutable');

  const deep = await request.get('/some/deep/link?x=1');
  expect(deep.status()).toBe(200);
  expect(await deep.text()).toContain('<div id="root"');
  expect(deep.headers()['cross-origin-embedder-policy']).toBe('require-corp');
});

test('manifest is rooted at /', async ({ request }) => {
  const m = await (await request.get('/manifest.webmanifest')).json();
  expect([m.start_url, m.scope, m.id]).toEqual(['/', '/', '/']);
});
