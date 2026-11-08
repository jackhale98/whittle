import { expect, type Page, test } from '@playwright/test';
import { pocketDoc, slotDoc } from './fixtures';
import { app, boot, cameraStill, toPage } from './helpers';

/**
 * "Needs attention" (PLAN §7.3 rule 4, M1 gate defect 8): an upstream edit removes a fillet's edge
 * → the feature is flagged, its old location is ghosted, the inspector offers a one-click re-pick,
 * and re-picking makes it ok. An edge split in two equal pieces offers the candidates in the
 * "Which one?" chooser.
 */

test.use({ viewport: { width: 1280, height: 720 } });

async function clickEdge(page: Page, p: [number, number, number]): Promise<void> {
  await page.evaluate(() =>
    (
      window as unknown as { __whittleViewport: { whenPickReady(): Promise<void> } }
    ).__whittleViewport.whenPickReady(),
  );
  const s = await toPage(page, p);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.up();
}

test('an edit removes a fillet edge → needs attention, ghost, one-click re-pick → ok', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  const a = app(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await a.load(pocketDoc());
  await a.idle();
  expect((await a.regen())?.features.map((f) => f.state)).toEqual(Array(5).fill('ok'));

  // Move the pocket off the plate: the fillet's corner edge no longer exists.
  await page.getByRole('tab', { name: 'Params' }).click();
  const x = page.getByRole('textbox', { name: 'Expression for pocket_x' });
  await x.fill('200 mm');
  await x.press('Enter');
  await a.idle();
  const r = await a.regen();
  expect(r?.features.map((f) => f.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'needsAttention']);
  expect(r?.features[4]?.unresolved?.[0]?.reason).toBe('missing');
  // The old location is ghosted.
  expect(await a.attentionMarkers()).toEqual([`attention:${r?.features[4]?.id}:/edges/0`]);

  await page.getByRole('tab', { name: 'Features' }).click();
  const item = page.getByTestId('feature-tree').getByRole('treeitem', { name: /Pocket fillet/ });
  await expect(item).toContainText(/needs attention/i);
  await item.click();
  const banner = page.getByTestId('feature-inspector').getByRole('alert');
  await expect(banner).toContainText('A reference needs your attention.');
  await page.keyboard.press('0');
  await cameraStill(page);
  await page.screenshot({ path: 'test-results/m1-needs-attention.png' });

  // One click: picking the missing edge; the model shows the fillet's input.
  await banner.getByTestId('repick').click();
  await expect.poll(async () => (await a.ui()).picking?.path).toBe('/edges/0');
  await a.idle();
  await clickEdge(page, [40, 0, 10]); // the plate's front top edge
  await expect.poll(async () => (await a.ui()).picking).toBeNull();
  await a.idle();
  const fixed = await a.regen();
  expect(fixed?.features.map((f) => f.state)).toEqual(Array(5).fill('ok'));
  expect(await a.attentionMarkers()).toEqual([]);
  const f = (await a.doc()).parts[0]?.features[4];
  if (f?.type !== 'fillet') throw new Error('no fillet');
  expect(f.edges[0]?.fingerprint?.centroid[1]).toBeCloseTo(0, 3);
  expect(f.edges[0]?.fingerprint?.centroid[2]).toBeCloseTo(10, 3);
});

test('an edge split in two equal pieces: "Which one?" lists the candidates', async ({ page }) => {
  test.slow();
  await boot(page);
  const a = app(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await a.load(slotDoc());
  await a.idle();
  const r = await a.regen();
  expect(r?.features.map((f) => f.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'needsAttention']);
  const u = r?.features[4]?.unresolved?.[0];
  expect(u?.reason).toBe('ambiguous');
  expect(u?.candidates).toHaveLength(2);

  await page
    .getByTestId('feature-tree')
    .getByRole('treeitem', { name: /Front fillet/ })
    .click();
  await page.keyboard.press('0');
  await cameraStill(page);
  await page.getByTestId('feature-inspector').getByTestId('repick').click();
  const chooser = page.getByRole('listbox');
  await expect(chooser.getByRole('option')).toHaveCount(2);
  await expect(chooser).toContainText('Edge of Plate');
  await page.screenshot({ path: 'test-results/m1-which-one-candidates.png' });
  await chooser.getByRole('option').first().click();
  await a.idle();
  expect((await a.regen())?.features.map((f) => f.state)).toEqual(Array(5).fill('ok'));
  const f = (await a.doc()).parts[0]?.features[4];
  if (f?.type !== 'fillet') throw new Error('no fillet');
  expect(u?.candidates).toContain(f.edges[0]?.name);
});
