import { devices, test } from '@playwright/test';
import { app } from './helpers';
import { fixtureDrawing } from './support/drawing-fixture';
import { built, drawing, newDrawing, openDemo, panelTab, sheetToPage, viewOf } from './support/drawing-ui';

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('shots', async ({ page }) => {
    test.slow();
    await openDemo(page);
    await newDrawing(page);
    await panelTab(page, 'Views').click();
    await page.getByTestId('add-standard-views').click();
    await built(page);
    await page.screenshot({ path: '/tmp/claude-0/s-views.png' });
    await panelTab(page, 'Import').click();
    await page.getByTestId('import-open').click();
    await page.getByRole('button', { name: 'Check all' }).click();
    await page.getByTestId('import-place').click();
    await built(page);
    const s = await drawing(page).state();
    const pl = (await drawing(page).placements()).find((p) => p.text);
    if (pl?.text) {
      const at = await sheetToPage(page, pl.text);
      await page.mouse.click(at.x, at.y);
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: '/tmp/claude-0/s-annot.png' });
    const front = viewOf(s, 'base');
    await panelTab(page, 'Views').click();
    await page.locator(`[data-view-row="${front?.id}"]`).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: '/tmp/claude-0/s-view.png' });
    await panelTab(page, 'Attention').click();
    await page.screenshot({ path: '/tmp/claude-0/s-att.png' });
  });
});

test.describe('tablet', () => {
  test.use({
    viewport: { width: 1180, height: 820 },
    userAgent: devices['iPad Pro 11'].userAgent,
    isMobile: true,
    hasTouch: true,
  });
  test('shots', async ({ page }) => {
    test.slow();
    await openDemo(page);
    await newDrawing(page);
    await page.getByTestId('drawing-panel-toggle').tap();
    await panelTab(page, 'Views').tap();
    await page.getByTestId('add-standard-views').tap();
    await built(page);
    await page.screenshot({ path: '/tmp/claude-0/t-views.png' });
  });
});

test.describe('phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: devices['iPhone 13'].userAgent,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  test('shots', async ({ page }) => {
    test.slow();
    await openDemo(page);
    const a = app(page);
    await page.evaluate(() => (window as unknown as { __wrenApp: { drawingSupport(): Promise<void> } }).__wrenApp.drawingSupport());
    const partId = (await a.doc()).parts[0]?.id as string;
    await a.apply({ kind: 'addDrawing', drawing: fixtureDrawing(partId) });
    await page.getByRole('group', { name: 'Viewer tools' }).getByRole('button', { name: 'Parts' }).tap();
    await page.screenshot({ path: '/tmp/claude-0/p-parts.png' });
    await page.getByTestId('drawings-section').getByTestId('drawing-open').tap();
    await built(page);
    await page.screenshot({ path: '/tmp/claude-0/p-sheet.png' });
    await page.getByTestId('drawing-panel-toggle').tap();
    await page.screenshot({ path: '/tmp/claude-0/p-panel.png' });
  });
});
