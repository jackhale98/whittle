import { expect, type Locator, type Page, test } from '@playwright/test';
import type { Feature, WrenDoc } from '@wren-cad/contracts';
import { app, boot } from './helpers';

/**
 * M3.6 acceptance, feature tree folders on the desktop: create a folder from three features,
 * rename it inline, collapse and expand it, drag it to a new valid position, suppress it (one undo
 * entry), and it survives save -> reload (collapsed state too, as per-document UI state).
 */

const tree = (page: Page) => page.getByTestId('feature-tree');
const row = (page: Page, name: string) =>
  tree(page)
    .getByRole('treeitem', { name: new RegExp(`^${name}`) })
    .first();
const folderRow = (page: Page) => tree(page).locator('[data-folder-id]');
const part = async (page: Page) => (await app(page).doc()).parts[0] as WrenDoc['parts'][number];
const names = (features: readonly Feature[]) => features.map((f) => f.name);

async function openDemoDesktop(page: Page) {
  await boot(page);
  await page.getByTestId('open-demo').click();
  await expect.poll(async () => (await part(page)).features.length).toBe(9);
  await app(page).idle();
}

/** Mouse drag on a grip: down, move in steps, up (the tree's pointer-captured drag). */
async function dragGrip(page: Page, grip: Locator, toY: number) {
  const box = await grip.boundingBox();
  if (!box) throw new Error('no grip');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) await page.mouse.move(x, y + ((toY - y) * i) / steps);
  await page.mouse.up();
}

test('folders: create from three features, rename inline, collapse, drag, suppress as one undo, save and reload', async ({
  page,
}) => {
  test.slow();
  await openDemoDesktop(page);
  const a = app(page);
  const doc0 = await part(page);
  const order0 = names(doc0.features);
  expect(order0).toEqual([
    'Plate sketch',
    'Plate',
    'Hole sketch',
    'Holes',
    'Upright sketch',
    'Upright',
    'Corner fillets',
    'Bend fillet',
    'Top chamfer',
  ]);

  // Create: Upright (with its sketch) and Corner fillets are three features in a run.
  await row(page, 'Upright').click();
  await row(page, 'Corner fillets').click({ modifiers: ['ControlOrMeta'] });
  await row(page, 'Corner fillets').click({ button: 'right', modifiers: ['ControlOrMeta'] });
  await page.getByRole('menuitem', { name: 'Add to new folder' }).click();
  await expect.poll(async () => (await part(page)).folders?.length ?? 0).toBe(1);
  const folder = (await part(page)).folders?.[0];
  expect(folder?.name).toBe('Folder 1');
  expect(folder?.features).toEqual(doc0.features.slice(4, 7).map((f) => f.id));
  expect((await a.history()).past.at(-1)?.label).toMatch(/folder/i);

  // The name opens for inline editing: commit it, then rename with F2.
  const name = page.getByRole('textbox', { name: 'Rename folder Folder 1' });
  await expect(name).toBeFocused();
  await name.fill('Mounting');
  await name.press('Enter');
  await expect.poll(async () => (await part(page)).folders?.[0]?.name).toBe('Mounting');
  await folderRow(page).focus();
  await page.keyboard.press('F2');
  const again = page.getByRole('textbox', { name: 'Rename folder Mounting' });
  await again.fill('Upright group');
  await again.press('Enter');
  await expect.poll(async () => (await part(page)).folders?.[0]?.name).toBe('Upright group');
  await expect(folderRow(page)).toContainText('Upright group');

  // Collapse and expand: UI state only. No undo entry, the document is unchanged.
  const folderId = (await part(page)).folders?.[0]?.id as string;
  const pastBeforeCollapse = (await a.history()).past.length;
  const toggle = folderRow(page).getByTestId('folder-toggle');
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(folderRow(page).getByTestId('folder-count')).toBeVisible();
  await expect(row(page, 'Corner fillets')).toHaveCount(0);
  expect(await a.collapsedFolders()).toEqual([folderId]);
  await toggle.click();
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'Corner fillets')).toBeVisible();
  expect(await a.collapsedFolders()).toEqual([]);
  expect((await a.history()).past.length).toBe(pastBeforeCollapse);

  // Drag the folder above "Holes": a valid position (the store accepts it).
  const holes = await row(page, 'Holes').boundingBox();
  if (!holes) throw new Error('no Holes row');
  await folderRow(page).hover();
  const pastBeforeMove = (await a.history()).past.length;
  await dragGrip(page, folderRow(page).locator('[data-grip]'), holes.y + 1);
  await expect
    .poll(async () => names((await part(page)).features))
    .toEqual([
      'Plate sketch',
      'Plate',
      'Upright sketch',
      'Upright',
      'Corner fillets',
      'Hole sketch',
      'Holes',
      'Bend fillet',
      'Top chamfer',
    ]);
  expect((await part(page)).folders?.[0]?.features).toEqual(
    doc0.features
      .filter((f) => ['Upright sketch', 'Upright', 'Corner fillets'].includes(f.name))
      .map((f) => f.id),
  );
  expect((await a.history()).past.length).toBe(pastBeforeMove + 1);

  // Suppress the folder: all three at once, one undo entry.
  const pastBeforeSuppress = (await a.history()).past.length;
  await folderRow(page).locator('[aria-label="Actions for folder Upright group"]').click();
  await page.getByRole('menuitem', { name: 'Suppress all' }).click();
  await expect
    .poll(async () => (await part(page)).features.filter((f) => f.suppressed).map((f) => f.name))
    .toEqual(['Upright sketch', 'Upright', 'Corner fillets']);
  const hist = await a.history();
  expect(hist.past.length).toBe(pastBeforeSuppress + 1);
  expect(hist.past.at(-1)?.label).toMatch(/suppress/i);

  // One undo restores all three.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(async () => (await part(page)).features.filter((f) => f.suppressed).length)
    .toBe(0);
  expect((await a.history()).past.length).toBe(pastBeforeSuppress);
  // ...and the folder is still there with its three members.
  expect((await part(page)).folders?.[0]?.features).toHaveLength(3);

  // Collapsed state and the folder survive save -> reload.
  await folderRow(page).getByTestId('folder-toggle').click();
  expect(await a.collapsedFolders()).toEqual([folderId]);
  await a.idle();
  await a.flushSave();
  const saved = await part(page);
  await page.reload();
  await boot(page);
  await expect.poll(async () => (await part(page)).folders?.length ?? 0).toBe(1);
  expect((await part(page)).folders).toEqual(saved.folders);
  expect(names((await part(page)).features)).toEqual(names(saved.features));
  await expect(folderRow(page)).toContainText('Upright group');
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'false');
  expect(await a.collapsedFolders()).toEqual([folderId]);
});
