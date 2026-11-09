import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { docWith, fid } from './fixtures';
import { app, boot } from './helpers';

/**
 * IGES import end to end (M3 gate B1): the Open/Import picker offers .igs/.iges, a surface-model
 * IGES (a 40 × 25 × 10 block as six bounded planes, the kernel goldens' writer) comes in as a
 * solid through the picker and through drag and drop, and works as a cut tool chosen in the
 * inspector. Its bytes travel with the project like a STEP attachment.
 */

test.use({ viewport: { width: 1280, height: 720 } });

const FIXTURE = fileURLToPath(new URL('./fixtures/block-40x25x10.igs', import.meta.url));
const BLOCK = 40 * 25 * 10;

test.beforeEach(async ({ page }) => {
  // The <input type=file> fallback, so the chooser's accept list can be checked.
  await page.addInitScript(() => {
    (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker = undefined;
  });
});

test('IGES: picker and drop import a sewn solid, which then cuts a plate', async ({ page }) => {
  test.slow();
  await boot(page);
  const a = app(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  // A 100 × 100 × 5 plate under the block's corner (the block spans 0…40 × 0…25 × 0…10).
  await a.load(
    docWith('IGES', {}, [
      {
        id: fid('PLATE'),
        type: 'primitive',
        name: 'Plate',
        suppressed: false,
        shape: 'box',
        dx: '100 mm',
        dy: '100 mm',
        dz: '5 mm',
        op: 'new',
      },
    ]),
  );
  await a.idle();
  expect((await a.regen())?.features.map((f) => f.state)).toEqual(['ok']);

  // 1. The picker offers IGES; the file imports into the open part as a new body.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open or import…' }).click();
  const picker = await chooser;
  const accept = await picker.element().evaluate((el) => (el as HTMLInputElement).accept);
  expect(accept.split(',')).toEqual(expect.arrayContaining(['.igs', '.iges', '.step']));
  await picker.setFiles(FIXTURE);
  await expect(page.getByTestId('feature-tree')).toContainText('block-40x25x10');
  await a.idle();
  let r = await a.regen();
  expect(
    r?.features.map((f) => f.state),
    JSON.stringify(r?.features),
  ).toEqual(['ok', 'ok']);
  const imported = (await a.doc()).parts[0]?.features[1];
  if (imported?.type !== 'import') throw new Error('no import feature');
  expect(imported.source.format).toBe('iges');
  expect(imported.source.fileName).toBe('block-40x25x10.igs');
  expect(imported.source.path).toBe(`imports/${imported.id}.iges`);
  const block = r?.bodies.find((b) => b.id === `B${imported.id}`);
  expect(Math.abs((block?.volume ?? 0) - BLOCK) / BLOCK).toBeLessThan(1e-9);
  for (const [v, e] of [
    [block?.bbox.min, [0, 0, 0]],
    [block?.bbox.max, [40, 25, 10]],
  ] as const) {
    for (let k = 0; k < 3; k++) expect(v?.[k]).toBeCloseTo(e[k] as number, 6);
  }
  expect((await a.projectFiles()).extra).toEqual([`imports/${imported.id}.iges`]);

  // 2. Cut: the imported solid as a tool, chosen in its inspector.
  await page
    .getByTestId('feature-tree')
    .getByRole('treeitem', { name: /block-40x25x10/ })
    .click();
  const inspector = page.getByTestId('feature-inspector');
  await expect(inspector).toContainText('IGES');
  await inspector.getByRole('radio', { name: 'Cut' }).click();
  await a.idle();
  r = await a.regen();
  expect(r?.features.map((f) => f.state)).toEqual(['ok', 'ok']);
  expect(r?.bodies.map((b) => b.id)).toEqual([`B${fid('PLATE')}`]);
  const plate = 100 * 100 * 5 - 40 * 25 * 5;
  expect(Math.abs((r?.bodies[0]?.volume ?? 0) - plate) / plate).toBeLessThan(1e-9);

  // 3. Drag and drop a .iges file onto the viewport: a second import, a new body.
  const b64 = readFileSync(FIXTURE).toString('base64');
  await page.evaluate((data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'block.iges', { type: 'model/iges' }));
    const target = document.querySelector('[data-testid="viewport-canvas"]') as HTMLElement;
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  }, b64);
  await expect(page.getByTestId('feature-tree')).toContainText('block');
  await expect.poll(async () => (await a.doc()).parts[0]?.features.length).toBe(3);
  await a.idle();
  r = await a.regen();
  expect(r?.features.map((f) => f.state)).toEqual(['ok', 'ok', 'ok']);
  const dropped = (await a.doc()).parts[0]?.features[2];
  if (dropped?.type !== 'import') throw new Error('no dropped import feature');
  expect(dropped.source.format).toBe('iges');
  expect(dropped.source.path).toBe(`imports/${dropped.id}.iges`);
  const second = r?.bodies.find((b) => b.id === `B${dropped.id}`);
  expect(Math.abs((second?.volume ?? 0) - BLOCK) / BLOCK).toBeLessThan(1e-9);
  await page.screenshot({ path: 'test-results/m3-iges-import.png' });
});
