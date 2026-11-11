import AxeBuilder from '@axe-core/playwright';
import { devices, expect, type Page, test } from '@playwright/test';
import type { Drawing } from '@wren-cad/contracts';
import { app, touch } from './helpers';
import { fixtureDrawing } from './support/drawing-fixture';
import {
  built,
  drawing,
  newDrawing,
  openDemo,
  panelTab,
  sheetToPage,
  viewOf,
} from './support/drawing-ui';

/**
 * M4 drawings on touch (PLAN §9.1, §9.3). Tablet: the same tools on a rail, a bottom panel, drags
 * and pinches with fingers. Phone: the drawing is for review (open, pan, zoom, the lists, export),
 * with no editing tools: PLAN §9.1 limits phone editing to parameters and simple features.
 */

const serious = (r: {
  violations: Array<{ impact?: string | null; id: string; nodes: Array<{ target: unknown[] }> }>;
}) =>
  r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
const a11y = async (page: Page) =>
  expect(
    serious(await new AxeBuilder({ page }).include('[data-testid="drawing-route"]').analyze()),
  ).toEqual([]);

const drawings = async (page: Page): Promise<Drawing[]> => (await app(page).doc()).drawings;

test.describe('tablet', () => {
  test.use({
    viewport: { width: 1180, height: 820 },
    userAgent: devices['iPad Pro 11'].userAgent,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  test.slow();

  test('a drawing is made and edited with fingers: tools on a rail, a bottom panel, drag-out views', async ({
    page,
  }) => {
    await openDemo(page);
    // The explicit standard and projection choice, inline, with 44 px targets.
    const { palette } = await import('./helpers');
    await palette(page, 'New drawing');
    const card = page.getByTestId('standard-choice');
    await expect(card).toBeVisible();
    await a11y(page);
    await card.getByRole('radio', { name: /^First angle/ }).check({ force: true });
    const confirm = page.getByTestId('standard-confirm');
    const cb = await confirm.boundingBox();
    expect(cb?.height ?? 0).toBeGreaterThanOrEqual(44);
    await confirm.tap();
    await expect(page.getByTestId('sheet-viewer')).toBeVisible();
    const s0 = await built(page);
    await expect(page.getByTestId('drawing-shell')).toHaveAttribute('data-tier', 'tablet');

    // The tool rail is there, with touch-sized buttons.
    const tool = page.locator('[data-tool="dimension"]');
    const tb = await tool.boundingBox();
    expect(tb?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(tb?.height ?? 0).toBeGreaterThanOrEqual(44);

    // The bottom panel opens from its handle and lists the views.
    await page.getByTestId('drawing-panel-toggle').tap();
    await panelTab(page, 'Views').tap();
    await page.getByTestId('add-standard-views').tap();
    await expect.poll(async () => (await drawing(page).state()).views.length).toBe(3);
    await built(page);
    await a11y(page);
    // Collapse it for the sheet.
    await page.getByTestId('drawing-panel-toggle').tap();

    // Select the top view with a tap and drag an arrow out of it with one finger: a view derived
    // from a projected view aligns to it, and follows the projection method too.
    const s1 = await drawing(page).state();
    const top = viewOf(s1, 'projected', 'top');
    if (!top?.outline) throw new Error('no top view');
    const edge = (await drawing(page).edges(top.id)).find((e) => e.kind === 'line');
    if (!edge) throw new Error('no edge');
    const t = await touch(page);
    const at = await sheetToPage(page, edge.at);
    await t.tap([at]);
    await expect.poll(async () => (await drawing(page).state()).selected?.kind).toBe('view');
    const handle = page.locator('[data-testid="view-handle"][data-dir="1,0"] circle').first();
    const hb = await handle.boundingBox();
    if (!hb) throw new Error('no handle');
    const from = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
    // First angle: dragged right, so the new view is seen from the left of the top view.
    const to = await sheetToPage(page, [top.outline.max[0] + 90, top.position?.[1] ?? 0]);
    await t.drag(from, to);
    await expect.poll(async () => (await drawing(page).state()).views.length).toBe(4);
    const s2 = await built(page);
    const child = s2.views.find(
      (v) =>
        v.kind === 'projected' &&
        v.id !== top.id &&
        v.from === 'left' &&
        v.layout === 'aligned' &&
        v.position?.[1] === top.position?.[1],
    );
    expect(child).toBeTruthy();
    expect((child?.position?.[0] ?? 0) > (top.position?.[0] ?? 0)).toBe(true);
    void s0;

    // Two fingers zoom the sheet, one finger pans it, a double tap fits it.
    const viewer = page.getByTestId('sheet-viewer');
    const box = await viewer.boundingBox();
    if (!box) throw new Error('no viewer');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const zoom = async () => Number(await viewer.getAttribute('data-zoom'));
    const z0 = await zoom();
    await t.down([
      { x: cx - 40, y: cy },
      { x: cx + 40, y: cy },
    ]);
    for (let i = 1; i <= 8; i++)
      await t.move([
        { x: cx - 40 - i * 10, y: cy },
        { x: cx + 40 + i * 10, y: cy },
      ]);
    await t.up();
    await expect.poll(zoom).toBeGreaterThan(z0);
    await t.doubleTap({ x: cx, y: box.y + 8 });
    await expect.poll(zoom).toBe(100);
  });

  test('every panel is reachable and accessible on the tablet', async ({ page }) => {
    await openDemo(page);
    await newDrawing(page);
    await page.getByTestId('drawing-panel-toggle').tap();
    for (const name of [
      'Inspector',
      'Views',
      'Import',
      'Attention',
      'Title block',
      'Sheet',
      'Export',
    ]) {
      await panelTab(page, name).tap();
      await expect(panelTab(page, name)).toHaveAttribute('aria-selected', 'true');
      await a11y(page);
    }
  });
});

test.describe('phone: review only', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: devices['iPhone 13'].userAgent,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  test.slow();

  /** Opens the demo bracket with a drawing in the document and the drawing open. */
  async function openFixtureDrawing(page: Page) {
    await openDemo(page);
    const a = app(page);
    await page.evaluate(() =>
      (
        window as unknown as { __wrenApp: { drawingSupport(): Promise<void> } }
      ).__wrenApp.drawingSupport(),
    );
    const partId = (await a.doc()).parts[0]?.id as string;
    expect(await a.apply({ kind: 'addDrawing', drawing: fixtureDrawing(partId) })).toBe(true);
    // The Parts tab lists drawings: open it from there.
    await page
      .getByRole('group', { name: 'Viewer tools' })
      .getByRole('button', { name: 'Parts' })
      .tap();
    const section = page.getByTestId('drawings-section');
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByTestId('drawing-open')).toHaveCount(1);
    // Review only: no new drawing, no rename or delete.
    await expect(section.getByTestId('drawing-new')).toHaveCount(0);
    await expect(section.getByTestId('drawing-delete')).toHaveCount(0);
    await section.getByTestId('drawing-open').tap();
    await expect(page.getByTestId('sheet-viewer')).toBeVisible();
    return built(page);
  }

  test('open, look, pan, zoom and export; there are no editing tools', async ({ page }) => {
    const s = await openFixtureDrawing(page);
    expect(s.views.map((v) => v.kind)).toEqual(['base', 'projected']);
    expect(s.views.every((v) => v.curves > 0 && v.problems.length === 0)).toBe(true);
    await expect(page.getByTestId('drawing-shell')).toHaveAttribute('data-tier', 'phone');
    await expect(page.getByTestId('drawing-toolbar')).toHaveCount(0);
    await expect(page.getByTestId('drawing-undo')).toHaveCount(0);

    // The sheet fits the phone, and a double tap fits it again after a pinch.
    const viewer = page.getByTestId('sheet-viewer');
    const box = await viewer.boundingBox();
    if (!box) throw new Error('no viewer');
    expect(box.width).toBeLessThanOrEqual(390);
    const t = await touch(page);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const zoom = async () => Number(await viewer.getAttribute('data-zoom'));
    const z0 = await zoom();
    await t.down([
      { x: cx - 30, y: cy },
      { x: cx + 30, y: cy },
    ]);
    for (let i = 1; i <= 6; i++)
      await t.move([
        { x: cx - 30 - i * 12, y: cy },
        { x: cx + 30 + i * 12, y: cy },
      ]);
    await t.up();
    await expect.poll(zoom).toBeGreaterThan(z0);
    // One finger on empty paper pans.
    const content = page.getByTestId('drawing-sheet-content');
    const t0 = await content.getAttribute('transform');
    await t.drag({ x: box.x + 20, y: box.y + 20 }, { x: box.x + 90, y: box.y + 70 });
    expect(await content.getAttribute('transform')).not.toBe(t0);

    // The panels: views (read only), needs attention, export.
    await page.getByTestId('drawing-panel-toggle').tap();
    await expect(page.getByTestId('views-panel')).toBeVisible();
    await expect(page.getByTestId('add-standard-views')).toHaveCount(0);
    await expect(page.getByTestId('view-picker')).toHaveCount(0);
    await panelTab(page, 'Attention').tap();
    await expect(page.getByTestId('attention-panel')).toBeVisible();
    await a11y(page);
    await panelTab(page, 'Export').tap();
    await a11y(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-export="pdf"]').tap(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);

    // Back to the model.
    await page.getByTestId('drawing-back').tap();
    await expect(page.getByTestId('drawing-route')).toHaveCount(0);
    expect((await drawings(page)).length).toBe(1);
  });

  test('an annotation that needs attention is listed on the phone, with no value', async ({
    page,
  }) => {
    await openFixtureDrawing(page);
    const a = app(page);
    const d = (await drawings(page))[0] as Drawing;
    const front = d.views[0];
    const partId = (await a.doc()).parts[0]?.id as string;
    expect(
      await a.apply({
        kind: 'addAnnotation',
        partId,
        annotation: {
          id: '01J0000000000000000000R011',
          kind: 'aligned',
          origin: { kind: 'drawing', drawingId: d.id },
          refs: [
            { name: 'edge(gone|1)', kind: 'edge' },
            { name: 'edge(gone|2)', kind: 'edge' },
          ],
          at: ['start', 'start'],
        },
        place: {
          drawingId: d.id,
          placement: {
            id: '01J0000000000000000000R012',
            viewId: front?.id as string,
            annotationId: '01J0000000000000000000R011',
            layout: { kind: 'offset', distance: 10 },
          },
        },
      }),
    ).toBe(true);
    await expect
      .poll(async () => (await drawing(page).state()).attention.length)
      .toBeGreaterThan(0);
    await page.getByTestId('drawing-panel-toggle').tap();
    await panelTab(page, 'Attention').tap();
    await expect(page.getByTestId('attention-panel')).toContainText('Needs attention');
    // Review only: reattach is an edit.
    await expect(page.locator('[data-reattach]')).toHaveCount(0);
  });
});
