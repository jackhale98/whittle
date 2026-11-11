import { expect, type Page, test } from '@playwright/test';

/**
 * Installed-PWA chrome behaviour (PLAN §12 M2: "no browser chrome or page zoom interferes").
 * Runs in two projects (playwright.config.ts): `chromium-touch` (gating, touch emulation at iPad
 * Pro 11 size) and `webkit-ipad` (Playwright's "iPad Pro 11" on WebKit, non-gating). WebKit has
 * no multi-touch synthesis, so the pinch is exercised there through the Safari `gesture*` events
 * the page guard cancels; Chromium also gets a real two-finger CDP pinch.
 */

async function open(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => window.crossOriginIsolated === true);
  await expect(page.getByTestId('app-shell')).toBeVisible();
}

const scale = (page: Page) => page.evaluate(() => window.visualViewport?.scale ?? 1);
const scroll = (page: Page) =>
  page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    top: document.scrollingElement?.scrollTop ?? 0,
    overflow:
      (document.scrollingElement?.scrollHeight ?? 0) - document.documentElement.clientHeight,
  }));

test('page-level CSS: manipulation touch-action, no overscroll, no selection on chrome @smoke', async ({
  page,
}) => {
  await open(page);
  const s = await page.evaluate(() => {
    const html = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    return {
      touchAction: html.touchAction,
      overscroll: html.overscrollBehaviorY,
      bodyOverflow: body.overflow,
      userSelect: body.userSelect || body.getPropertyValue('-webkit-user-select'),
      safeTop: html.getPropertyValue('--safe-top').trim(),
    };
  });
  expect(s.touchAction).toBe('manipulation');
  expect(s.overscroll).toBe('none');
  expect(s.bodyOverflow).toBe('hidden');
  expect(s.userSelect).toBe('none');
  expect(s.safeTop).not.toBe(''); // env(safe-area-inset-top, 0px) is exposed for the shells
});

test('the manifest is standalone, any orientation, with display_override', async ({ page }) => {
  await open(page);
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href;
    return href ? ((await (await fetch(href)).json()) as Record<string, unknown>) : null;
  });
  expect(manifest).not.toBeNull();
  expect(manifest?.display).toBe('standalone');
  expect(manifest?.orientation).toBe('any');
  expect(manifest?.display_override).toContain('standalone');
  const metas = await page.evaluate(() =>
    [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('media')),
  );
  expect(metas).toEqual(
    expect.arrayContaining(['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)']),
  );
});

test('Safari gesture events (pinch-zoom of the page) are cancelled', async ({ page }) => {
  await open(page);
  const prevented = await page.evaluate(() =>
    ['gesturestart', 'gesturechange', 'gestureend'].map((type) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    }),
  );
  expect(prevented).toEqual([true, true, true]);
});

test('a pinch on the chrome does not zoom the page', async ({ page, browserName }) => {
  await open(page);
  expect(await scale(page)).toBe(1);
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    const y = 24; // the top bar: shell chrome, not the viewport canvas
    const at = (k: number) => [
      { x: 380 - 30 * k, y, id: 1 },
      { x: 454 + 30 * k, y, id: 2 },
    ];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
    for (let k = 1; k <= 8; k++)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  expect(await scale(page)).toBe(1);
  expect(await page.evaluate(() => window.innerWidth)).toBe(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});

test('a double-tap on the chrome does not zoom the page', async ({ page }) => {
  await open(page);
  await page.touchscreen.tap(6, 6);
  await page.touchscreen.tap(6, 6);
  await page.waitForTimeout(400);
  expect(await scale(page)).toBe(1);
});

test('the page does not scroll @smoke', async ({ page, browserName }) => {
  await open(page);
  await page.evaluate(() => window.scrollTo(0, 5000));
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.synthesizeScrollGesture', {
      x: 20,
      y: 600,
      yDistance: -400,
      gestureSourceType: 'touch',
    });
  }
  const s = await scroll(page);
  expect(s.y).toBe(0);
  expect(s.x).toBe(0);
  expect(s.top).toBe(0);
  expect(s.overflow).toBeLessThanOrEqual(0);
});

test('fields use 16 px text on touch, so focusing one never zooms the page', async ({ page }) => {
  await open(page);
  const sizes = await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:200px;top:200px;z-index:2147483647';
    host.innerHTML =
      '<input class="text-ui" aria-label="probe"><span data-field-mirror class="text-ui">x</span><button class="text-ui">b</button>';
    document.body.appendChild(host);
    const px = (sel: string) => getComputedStyle(host.querySelector(sel) as Element).fontSize;
    return { input: px('input'), mirror: px('[data-field-mirror]'), chrome: px('button') };
  });
  // The expression input and its mirror layer stay in step; other chrome keeps its 13 px.
  expect(sizes.input).toBe('16px');
  expect(sizes.mirror).toBe('16px');
  expect(sizes.chrome).not.toBe('16px');
  await page.getByLabel('probe').tap();
  await page.waitForTimeout(300);
  expect(await scale(page)).toBe(1);
});
