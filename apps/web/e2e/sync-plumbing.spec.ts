import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Page, test } from '@playwright/test';

/**
 * Cross-origin plumbing for cloud/git sync (M2.5 platform): provider API calls (CORS fetch) under
 * the service worker's COOP/COEP, OAuth full-page redirects out and back, and the rule that the
 * service worker never caches provider traffic. The "provider" is a real second origin (another
 * port on 127.0.0.1) so the browser applies its real CORS and COEP checks.
 *
 * Run alone on its own port: `WREN_E2E_PORT=4181 pnpm --filter @wren-cad/web exec playwright test sync-plumbing`.
 */

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

let provider: Server;
let providerOrigin = '';
let seen: Seen[] = [];

test.beforeAll(async () => {
  provider = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const url = new URL(req.url ?? '/', 'http://provider.invalid');
    const origin = req.headers.origin;
    if (url.pathname === '/authorize') {
      // OAuth: send the browser (top-level navigation) back to the app with a code.
      res.writeHead(302, { location: url.searchParams.get('redirect_uri') ?? '/' });
      res.end();
      return;
    }
    if (url.pathname === '/no-cors') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"secret":true}');
      return;
    }
    const cors: Record<string, string> = origin
      ? {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, PROPFIND, MKCOL, OPTIONS',
          'access-control-allow-headers':
            'Authorization, Content-Type, Depth, If-Match, Dropbox-API-Arg',
          'access-control-expose-headers': 'ETag',
          vary: 'Origin',
        }
      : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    res.writeHead(200, {
      ...cors,
      'content-type': 'application/json',
      etag: '"e1"',
      'cache-control': 'max-age=3600',
    });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => provider.close(() => resolve()));
});

test.beforeEach(() => {
  seen = [];
});

function countNavigations(page: Page): () => number {
  let count = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) count++;
  });
  return () => count;
}

async function visitUntilIsolated(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => window.crossOriginIsolated === true);
  await expect(page.getByTestId('app-shell')).toBeVisible();
}

async function cachedUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  });
}

test.describe('provider API calls under COOP/COEP', () => {
  test('CORS fetches with Authorization, JSON bodies and WebDAV verbs work while isolated', async ({
    page,
  }) => {
    await visitUntilIsolated(page);
    const results = await page.evaluate(async (origin) => {
      const run = async (path: string, init: RequestInit) => {
        const response = await fetch(`${origin}${path}`, init);
        return {
          status: response.status,
          etag: response.headers.get('etag'),
          body: await response.text(),
        };
      };
      return {
        bearer: await run('/2/files/list_folder', {
          method: 'POST',
          headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
          body: '{"path":""}',
        }),
        dropboxArg: await run('/2/files/download', {
          method: 'POST',
          headers: { Authorization: 'Bearer tok', 'Dropbox-API-Arg': '{"path":"/a"}' },
        }),
        propfind: await run('/dav/host/x/', {
          method: 'PROPFIND',
          headers: { Authorization: 'Basic YTpi', Depth: '1', 'If-Match': '"e0"' },
          body: '<propfind/>',
        }),
        put: await run('/dav/host/x/a.wrencad', {
          method: 'PUT',
          headers: { Authorization: 'Basic YTpi' },
          body: new Uint8Array([1, 2, 3]),
        }),
      };
    }, providerOrigin);
    for (const r of Object.values(results)) {
      expect(r.status).toBe(200);
      expect(r.body).toBe('{"ok":true}');
      expect(r.etag).toBe('"e1"');
    }
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    // The provider received the real Authorization header (nothing stripped by the worker).
    const authed = seen.filter((s) => s.method !== 'OPTIONS');
    expect(authed.length).toBe(4);
    for (const s of authed) expect(s.headers.authorization).toBeTruthy();
  });

  test('a response without CORS headers is refused by the browser (provider must allow Wren)', async ({
    page,
  }) => {
    await visitUntilIsolated(page);
    const outcome = await page.evaluate(
      (origin) =>
        fetch(`${origin}/no-cors`).then(
          () => 'resolved',
          () => 'rejected',
        ),
      providerOrigin,
    );
    expect(outcome).toBe('rejected');
  });

  test('the service worker never caches provider responses or Authorization requests', async ({
    page,
  }) => {
    await visitUntilIsolated(page);
    await page.evaluate(async (origin) => {
      // A cacheable provider response (max-age); the browser HTTP cache may serve repeats, the
      // service worker must never store it in Cache Storage.
      await fetch(`${origin}/files/a`, { headers: { Authorization: 'Bearer tok' } });
      await fetch(`${origin}/public`);
      // Same-origin request that carries Authorization (e.g. a misconfigured same-origin Worker).
      await fetch('/wren-cad/__e2e__/test.wasm', { headers: { Authorization: 'Bearer tok' } });
    }, providerOrigin);
    expect(seen.filter((s) => s.url === '/files/a' && s.method === 'GET')).toHaveLength(1);
    const urls = await cachedUrls(page);
    expect(urls.some((u) => u.startsWith(providerOrigin))).toBe(false);
    expect(urls.some((u) => u.endsWith('/__e2e__/test.wasm'))).toBe(false);
  });
});

test.describe('OAuth full-page redirects', () => {
  test('out to the provider and back keeps the query, isolation, and does not loop', async ({
    page,
    baseURL,
  }) => {
    await visitUntilIsolated(page);
    const navigations = countNavigations(page);
    const back = `${baseURL}?code=abc123&state=s-1#/sync`;
    await page.goto(`${providerOrigin}/authorize?redirect_uri=${encodeURIComponent(back)}`);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.waitForFunction(() => window.crossOriginIsolated === true);
    expect(await page.evaluate(() => location.search)).toBe('?code=abc123&state=s-1');
    expect(await page.evaluate(() => location.hash)).toBe('#/sync');
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    const settled = navigations();
    await page.waitForTimeout(1000);
    expect(navigations()).toBe(settled); // no reload loop
    expect(settled).toBe(1); // the single navigation back into the app
  });

  test('a first-ever visit that arrives with an authorization code is not reloaded', async ({
    page,
  }) => {
    const navigations = countNavigations(page);
    await page.goto('./?code=abc123&state=s-1');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await expect(page.getByTestId('status-line')).toContainText('fallback');
    await page.waitForTimeout(1000);
    expect(navigations()).toBe(1); // the one-time code is not thrown away by an isolation reload
    expect(await page.evaluate(() => location.search)).toBe('?code=abc123&state=s-1');

    // The next load (app has handled the callback) is controlled from the first byte: isolated.
    await page.goto('./');
    await page.waitForFunction(() => window.crossOriginIsolated === true);
  });
});
