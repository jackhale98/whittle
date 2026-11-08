import { expect, type Page, test } from '@playwright/test';
import type { RuntimeDiagnostics, WhittleTestHooks } from '@whittle/contracts';

/**
 * Platform E2E (PWA + cross-origin isolation). Runs against the production build served like
 * GitHub Pages: base `/whittle/`, no COOP/COEP from the server. See playwright.config.ts.
 */

const KERNEL_CACHE = 'whittle-kernel-v1';
const FIXTURE_WASM = '/whittle/__e2e__/test.wasm';

function diagnostics(page: Page): Promise<RuntimeDiagnostics> {
  return page.evaluate(() =>
    (window as unknown as { __whittle: WhittleTestHooks }).__whittle.diagnostics(),
  );
}

/** Counts main-frame navigations (initial load + reloads). */
function countNavigations(page: Page): () => number {
  let count = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) count++;
  });
  return () => count;
}

/** First visit: wait for the SW to install, the one-time reload, and isolation. */
async function visitUntilIsolated(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => window.crossOriginIsolated === true);
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('status-line')).toContainText('threaded kernel available');
}

test.describe('cross-origin isolation via the service worker', () => {
  test('first visit installs the SW, reloads exactly once, and becomes isolated', async ({
    page,
  }) => {
    const navigations = countNavigations(page);
    await visitUntilIsolated(page);

    expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function');
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    expect(navigations()).toBe(2); // load + exactly one reload

    // No reload loop: still two navigations a moment later.
    await page.waitForTimeout(1000);
    expect(navigations()).toBe(2);

    const d = await diagnostics(page);
    expect(d.crossOriginIsolated).toBe(true);
    expect(d.serviceWorker).toBe('active');
    expect(d.appVersion).toMatch(/^\d+\.\d+\.\d+.*\+\w+/);
  });

  test('service worker stamps COOP/COEP/CORP on navigation and asset responses', async ({
    page,
  }) => {
    await visitUntilIsolated(page);
    const headers = await page.evaluate(async () => {
      const read = async (url: string) => {
        const response = await fetch(url);
        return {
          status: response.status,
          coop: response.headers.get('cross-origin-opener-policy'),
          coep: response.headers.get('cross-origin-embedder-policy'),
          corp: response.headers.get('cross-origin-resource-policy'),
        };
      };
      const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
      return { page: await read(location.href), script: await read(script?.src ?? '') };
    });
    for (const result of [headers.page, headers.script]) {
      expect(result.status).toBe(200);
      expect(result.coop).toBe('same-origin');
      expect(result.coep).toBe('require-corp');
      expect(result.corp).toBe('same-origin');
    }
  });

  test('an isolated page can share memory with a worker', async ({ page }) => {
    await visitUntilIsolated(page);
    const value = await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const source = `onmessage = (e) => { Atomics.store(new Int32Array(e.data), 0, 42); postMessage('done'); }`;
          const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
          const worker = new Worker(url);
          const shared = new SharedArrayBuffer(4);
          worker.onmessage = () => resolve(Atomics.load(new Int32Array(shared), 0));
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage(shared);
        }),
    );
    expect(value).toBe(42);
  });

  test('deep links on the Pages 404 fallback still boot the app', async ({ page }) => {
    const response = await page.goto('some/deep/link');
    expect(response?.status()).toBe(404); // what GitHub Pages answers; the body is the app shell
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.waitForFunction(() => window.crossOriginIsolated === true);
    await expect(page.getByTestId('app-shell')).toBeVisible();
  });
});

test.describe('offline', () => {
  test('app shell and a fetched wasm are served from cache with no network', async ({
    page,
    context,
  }) => {
    await visitUntilIsolated(page);

    // Fetch the fixture wasm once while online: the SW caches it at runtime (CacheFirst).
    const online = await page.evaluate(async (url) => {
      const response = await fetch(url);
      return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    }, FIXTURE_WASM);
    expect(online).toEqual({ status: 200, bytes: 8 });
    await expect
      .poll(() =>
        page.evaluate(
          async (name) => (await (await caches.open(name)).keys()).length,
          KERNEL_CACHE,
        ),
      )
      .toBe(1);
    expect(await page.evaluate(() => caches.keys())).toContain('whittle-precache-v1');

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible();
    expect((await diagnostics(page)).crossOriginIsolated).toBe(true);

    const offline = await page.evaluate(async (url) => {
      const response = await fetch(url);
      const buffer = await response.arrayBuffer();
      await WebAssembly.compile(buffer);
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        coep: response.headers.get('cross-origin-embedder-policy'),
        bytes: buffer.byteLength,
      };
    }, FIXTURE_WASM);
    expect(offline).toEqual({
      status: 200,
      type: 'application/wasm',
      coep: 'require-corp',
      bytes: 8,
    });

    // And a wasm that was never fetched online is (correctly) unavailable.
    const missing = await page.evaluate(() =>
      fetch('/whittle/__e2e__/never-fetched.wasm').then(
        () => 'resolved',
        () => 'rejected',
      ),
    );
    expect(missing).toBe('rejected');
  });
});

test.describe('fallback path', () => {
  test('with service workers blocked the app boots in single-threaded fallback mode', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ serviceWorkers: 'block', baseURL });
    const page = await context.newPage();
    const navigations = countNavigations(page);
    await page.goto('./');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByTestId('status-line')).toContainText(
      'fallback (single-threaded kernel)',
    );

    const d = await diagnostics(page);
    expect(d.crossOriginIsolated).toBe(false);
    expect(d.serviceWorker).toBe('none');
    expect(await page.evaluate(() => typeof SharedArrayBuffer === 'undefined')).toBe(true);

    await page.waitForTimeout(1000);
    expect(navigations()).toBe(1); // never reloads when there is nothing to wait for
    await context.close();
  });

  test('reload guard: a second non-isolated load does not reload again', async ({ page }) => {
    // Simulate "worker controls the page but isolation still fails" by pre-setting the guard.
    await page.addInitScript(() => sessionStorage.setItem('whittle:coi-reload', '1'));
    const navigations = countNavigations(page);
    await page.goto('./');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await expect(page.getByTestId('status-line')).toContainText(
      'fallback (single-threaded kernel)',
    );
    expect(navigations()).toBe(1);
    expect((await diagnostics(page)).crossOriginIsolated).toBe(false);
  });
});

test.describe('PWA manifest and installability', () => {
  test('manifest is linked and valid', async ({ page, request, baseURL }) => {
    await page.goto('./');
    const href = await page.locator('link[rel="manifest"]').first().getAttribute('href');
    expect(href).toBe('/whittle/manifest.webmanifest');
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);

    const response = await request.get(new URL(href ?? '', baseURL).toString());
    expect(response.status()).toBe(200);
    const manifest = await response.json();

    expect(manifest.name).toBe('Whittle');
    expect(manifest.short_name).toBe('Whittle');
    expect(manifest.display).toBe('standalone');
    expect(manifest.display_override).toContain('standalone');
    expect(manifest.start_url).toBe('/whittle/');
    expect(manifest.scope).toBe('/whittle/');
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.launch_handler.client_mode).toBeTruthy();

    const icons = manifest.icons as Array<{ src: string; sizes: string; purpose?: string }>;
    expect(icons.some((i) => i.sizes === '192x192' && i.purpose === 'any')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true);
    for (const icon of icons) {
      const res = await request.get(new URL(icon.src, `${baseURL}`).toString());
      expect(res.status(), icon.src).toBe(200);
    }

    const accepted = (
      manifest.file_handlers as Array<{ accept: Record<string, string[]> }>
    ).flatMap((handler) => Object.values(handler.accept).flat());
    expect(accepted).toEqual(expect.arrayContaining(['.whittle', '.step', '.stp']));
  });

  test('chromium reports no installability errors once the SW controls the page', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Installability CDP API is Chromium-only');
    await visitUntilIsolated(page);
    const cdp = await page.context().newCDPSession(page);
    const result = (await cdp.send('Page.getInstallabilityErrors')) as {
      installabilityErrors: Array<{ errorId: string }>;
    };
    expect(result.installabilityErrors).toEqual([]);
  });
});
