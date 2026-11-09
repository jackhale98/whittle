// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

test('library saves, lists, opens and removes through real IndexedDB + OPFS', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__io !== undefined);
  const r = await page.evaluate(() => window.__io.run(`e2e-${Date.now()}`));
  expect(r.backend).toBe('opfs');
  expect(r.listedNames).toEqual(['Harness Part']);
  expect(r.openedName).toBe('Harness Part');
  expect(r.foundCount).toBe(1);
  expect(r.afterCount).toBe(0);
  expect(r.thumbMagic).toEqual([137, 80, 78, 71]);
  expect(r.thumbBytes).toBeGreaterThan(50);

  // The OPFS file really is gone after remove.
  const leftover = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('whittle-library', { create: true });
    const names: string[] = [];
    for await (const [name] of (
      dir as unknown as { entries(): AsyncIterable<[string, unknown]> }
    ).entries()) {
      names.push(name);
    }
    return names.filter((n) => n.endsWith('.whittle')); // storage name kept (ADR-032)
  });
  expect(leftover).toEqual([]);
});
