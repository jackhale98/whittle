import { expect, type Page, test } from '@playwright/test';
import { addBox, app, boot, cameraStill, palette, toPage, topCenter, touchStats } from './helpers';

/**
 * M2 on the desktop shell (mouse + keyboard): push/pull with the arrow handle, its same-frame
 * prism preview and the value chip; the Inspect → Measure tool with markers and the panel; the
 * section view; attention markers as viewport markers; import attachments kept while undo can
 * restore them.
 */

const SHOTS = process.env.WREN_SHOTS;

async function box(page: Page) {
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await addBox(page);
  await app(page).idle();
  // The box opens in the inspector; leave it so taps select geometry.
  await page.keyboard.press('Escape');
  await cameraStill(page);
}

const volume = async (page: Page) => (await app(page).regen())?.bodies[0]?.volume ?? 0;

/** Page point `px` CSS px along the screen image of the +Z axis from a world point. */
async function alongZ(page: Page, p: [number, number, number], px: number) {
  const a = await toPage(page, p);
  const b = await toPage(page, [p[0], p[1], p[2] + 5]);
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: a.x + ((b.x - a.x) / l) * px, y: a.y + ((b.y - a.y) / l) * px };
}

test('push/pull: arrow on the face, same-frame preview, chip, release records the feature', async ({
  page,
}) => {
  test.slow();
  await box(page);
  const a = app(page);
  expect(await volume(page)).toBeCloseTo(24_000, 0);
  const b = (await a.regen())?.bodies[0]?.bbox;
  const top: [number, number, number] = [
    ((b?.min[0] ?? 0) + (b?.max[0] ?? 0)) / 2,
    ((b?.min[1] ?? 0) + (b?.max[1] ?? 0)) / 2,
    b?.max[2] ?? 0,
  ];

  // Select first, act second: the top face, then P.
  const c = await topCenter(page);
  await page.mouse.click(c.x, c.y);
  await a.idle();
  expect((await a.ui()).selection).toEqual(['face']);
  await page.keyboard.press('p');
  await expect.poll(async () => (await a.ui()).pushPull?.faces).toBe(1);
  await expect(page.getByTestId('value-chip')).toBeVisible();
  await expect(page.getByTestId('prompt-chip')).toContainText('Drag the arrow');

  // Drag the arrow up: the prism previews in the same frame, built once.
  const before = await touchStats(page);
  const grip = await alongZ(page, top, 40);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  const camera = await page.evaluate(() =>
    JSON.stringify(
      (
        window as unknown as { __wrenViewport: { getCameraState(): unknown } }
      ).__wrenViewport.getCameraState(),
    ),
  );
  const to = await alongZ(page, top, 40 + 120);
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await expect.poll(async () => (await a.ui()).pushPull?.dragging).toBe(true);
  const during = await touchStats(page);
  expect(during.prismBuilds).toBe(before.prismBuilds + 1); // distance updates never rebuild
  expect(during.lastPreviewPresentedAt).toBeGreaterThan(before.lastPreviewPresentedAt);
  const pulled = (await a.ui()).pushPull?.distance ?? 0;
  expect(pulled).toBeGreaterThan(2);
  await expect(page.getByTestId('value-chip')).toContainText('mm');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-push-pull-drag.png` });
  await page.mouse.up();
  await a.idle();

  // A press on the arrow never orbits.
  expect(
    await page.evaluate(() =>
      JSON.stringify(
        (
          window as unknown as { __wrenViewport: { getCameraState(): unknown } }
        ).__wrenViewport.getCameraState(),
      ),
    ),
  ).toBe(camera);
  const pp = (await a.doc()).parts[0]?.features.at(-1);
  expect(pp?.type).toBe('pushPull');
  if (pp?.type !== 'pushPull') throw new Error('no push/pull');
  expect(pp.faces).toHaveLength(1);
  const d = Number.parseFloat(pp.distance);
  expect(d).toBeCloseTo(pulled, 5);
  expect(await volume(page)).toBeCloseTo(40 * 30 * (20 + d), 0);
  expect((await a.regen())?.features.every((f) => f.state === 'ok')).toBe(true);
  expect((await a.ui()).pushPull).toBeNull();

  // Undo removes it, redo brings it back.
  await page.keyboard.press('ControlOrMeta+z');
  await a.idle();
  expect(await volume(page)).toBeCloseTo(24_000, 0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await a.idle();
  expect((await a.doc()).parts[0]?.features.at(-1)?.type).toBe('pushPull');

  // Act first: the tool, then a face; type an exact value with an expression on the chip.
  await page.keyboard.press('Escape');
  // (Push/pull lives in the Solid group, not on the flat desktop bar: the palette has it.)
  await palette(page, 'Push/pull');
  await expect(page.getByTestId('prompt-chip')).toContainText('flat face');
  const c2 = await topCenter(page);
  await page.mouse.click(c2.x, c2.y);
  await expect.poll(async () => (await a.ui()).pushPull?.faces).toBe(1);
  await page.getByTestId('value-chip').getByRole('button').click();
  const input = page.getByTestId('value-chip-input').getByRole('textbox');
  await input.fill('-(2 + 3) mm');
  await input.press('Enter');
  await a.idle();
  const pp2 = (await a.doc()).parts[0]?.features.at(-1);
  expect(pp2?.type === 'pushPull' && pp2.distance).toBe('-(2 + 3) mm');
  expect(await volume(page)).toBeCloseTo(40 * 30 * (20 + d - 5), 0);

  // Editable in the inspector like any feature.
  await page
    .getByTestId('feature-tree')
    .getByRole('treeitem', { name: /Push\/pull 2/ })
    .click();
  const field = page.getByTestId('feature-inspector').getByRole('textbox', { name: /Distance/ });
  await field.fill('-3 mm');
  await field.press('Enter');
  await a.idle();
  expect(await volume(page)).toBeCloseTo(40 * 30 * (20 + d - 3), 0);

  // A push that removes the whole body fails with the kernel's message, and turns red.
  await field.fill(`-${20 + d + 5} mm`);
  await field.press('Enter');
  await a.idle();
  const status = (await a.regen())?.features.at(-1);
  expect(status?.state).toBe('error');
  expect(status?.error).toMatch(/removes the whole body/);
  await expect(page.getByTestId('feature-inspector').getByRole('alert')).toContainText(
    'removes the whole body',
  );
});

test('measure: two faces give their distance and angle, with markers, label and the panel', async ({
  page,
}) => {
  test.slow();
  await box(page);
  const a = app(page);
  const b = (await a.regen())?.bodies[0]?.bbox;
  if (!b) throw new Error('no body');
  await page.keyboard.press('m');
  await expect(page.getByTestId('measure-inspector')).toBeVisible();
  await expect(page.getByTestId('prompt-chip')).toContainText('to measure');

  // The top face: its area.
  const top = await topCenter(page);
  await page.mouse.click(top.x, top.y);
  await a.idle();
  await expect.poll(async () => (await a.ui()).measure?.results.at(-1)?.area).toBeCloseTo(1200, 3);
  await expect(page.getByTestId('measure-reading')).toHaveAttribute('data-kind', 'area');
  await expect(page.getByTestId('measure-label')).toContainText('1,200.0 mm²');

  // A side face (−Y): its distance from the top face is 0 (they meet), at 90°.
  const side = await toPage(page, [
    ((b.min[0] ?? 0) + (b.max[0] ?? 0)) / 2,
    b.min[1] ?? 0,
    ((b.min[2] ?? 0) + (b.max[2] ?? 0)) / 2,
  ]);
  await page.mouse.click(side.x, side.y);
  await a.idle();
  const m = (await a.ui()).measure;
  expect(m?.picks).toEqual(['face', 'face']);
  expect(m?.results.at(-1)?.distance?.value).toBeCloseTo(0, 6);
  expect(m?.results.at(-1)?.angle).toBeCloseTo(Math.PI / 2, 6);
  await expect(page.getByTestId('measure-extra')).toContainText('90.00');

  // A third pick starts over; Escape ends measuring and removes the markers.
  await page.mouse.click(top.x, top.y);
  await a.idle();
  expect((await a.ui()).measure?.picks).toEqual(['face']);
  await expect(page.getByTestId('measure-history').getByRole('listitem')).toHaveCount(2);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-measure.png` });
  await page.keyboard.press('Escape');
  expect((await a.ui()).measure).toBeNull();
  await expect(page.getByTestId('measure-label')).toHaveCount(0);
});

test('section: ⌘K Section view, axis, offset within the part, flip, off', async ({ page }) => {
  test.slow();
  await box(page);
  const a = app(page);
  await palette(page, 'Section view');
  const panel = page.getByTestId('section-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('switch', { name: 'Section view' }).click();
  await expect.poll(async () => (await touchStats(page)).sectionActive).toBe(true);
  const s = (await a.ui()).section;
  expect(s.enabled).toBe(true);
  expect(s.axis).toBe('z');
  const b = (await a.regen())?.bodies[0]?.bbox;
  expect(s.offset).toBeCloseTo(((b?.min[2] ?? 0) + (b?.max[2] ?? 0)) / 2, 6); // mid-part
  await panel.getByRole('radio', { name: 'X' }).click();
  expect((await a.ui()).section.axis).toBe('x');
  const slider = panel.getByRole('slider', { name: 'Section offset' });
  expect(Number(await slider.getAttribute('min'))).toBeCloseTo(b?.min[0] ?? 0, 3);
  expect(Number(await slider.getAttribute('max'))).toBeCloseTo(b?.max[0] ?? 0, 3);
  const value = panel.getByTestId('section-offset-value').getByRole('textbox');
  await value.fill('5mm');
  await value.press('Enter');
  expect((await a.ui()).section.offset).toBe(5);
  await panel.getByRole('switch', { name: 'Flip side' }).click();
  expect((await a.ui()).section.flipped).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-section.png` });
  await panel.getByRole('switch', { name: 'Section view' }).click();
  await expect.poll(async () => (await touchStats(page)).sectionActive).toBe(false);
});

/** A binary STL of an axis-aligned cube (12 triangles), `s` mm (as in files.spec.ts). */
function cubeStl(s: number): string {
  const v = (i: number) => [i & 1 ? s : 0, i & 2 ? s : 0, i & 4 ? s : 0];
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const tris = quads.flatMap(([a, b, c, d]) => [
    [a, b, c],
    [a, c, d],
  ]) as number[][];
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const o = 84 + i * 50 + 12;
    t.forEach((idx, k) => {
      const p = v(idx);
      for (let j = 0; j < 3; j++) buf.writeFloatLE(p[j] as number, o + k * 12 + j * 4);
    });
  });
  return buf.toString('base64');
}

test('a deleted import’s attachment is never saved, but undo still finds its bytes', async ({
  page,
}) => {
  test.slow();
  await box(page);
  const a = app(page);
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'cube.stl', { type: 'model/stl' }));
    const target = document.querySelector('[data-testid="viewport-canvas"]') as HTMLElement;
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  }, cubeStl(10));
  const tree = page.getByTestId('feature-tree');
  await expect(tree).toContainText('cube');
  await a.idle();
  const imported = (await a.doc()).parts[0]?.features[1];
  if (imported?.type !== 'import') throw new Error('no import feature');
  const path = imported.source.path;
  const id = (await a.doc()).meta.id ?? '';
  await a.flushSave();
  expect(await a.libraryFiles(id)).toContain(path);

  // Delete the import: the saved project drops the attachment; memory keeps it for undo.
  await tree.getByRole('treeitem', { name: /cube/ }).click();
  await tree.getByRole('treeitem', { name: /cube/ }).press('Delete');
  await a.idle();
  expect((await a.doc()).parts[0]?.features).toHaveLength(1);
  await a.flushSave();
  expect(await a.libraryFiles(id)).not.toContain(path);
  expect((await a.projectFiles()).extra).toContain(path);

  // Undo brings the import back with its bytes: it rebuilds, and the next save carries it again.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+z');
  await a.idle();
  expect((await a.regen())?.features.map((f) => f.state)).toEqual(['ok', 'ok']);
  await a.flushSave();
  expect(await a.libraryFiles(id)).toContain(path);
});

test('a selected vertex stays selected through a regen that does not move it (D6)', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await addBox(page);
  const a = app(page);
  await a.idle();
  const inspector = page.getByTestId('feature-inspector');
  const height = inspector.getByRole('textbox', { name: 'Height (Z)' });
  await expect(height).toBeVisible();
  await height.fill('35 mm');
  await height.press('Enter');
  await a.idle();
  await page.keyboard.press('Escape');
  await cameraStill(page);
  const b = (await a.regen())?.bodies[0]?.bbox;
  if (!b) throw new Error('no body');

  // A bottom corner the viewport can pick as a vertex (not hidden behind the box).
  const corners: [number, number, number][] = [];
  for (const x of [b.min[0] ?? 0, b.max[0] ?? 0])
    for (const y of [b.min[1] ?? 0, b.max[1] ?? 0]) corners.push([x, y, b.min[2] ?? 0]);
  // A corner is a near-tie of the vertex and its edges: choose the vertex in "Which one?".
  let picked: [number, number, number] | null = null;
  for (const c of corners) {
    const s = await toPage(page, c);
    await page.mouse.click(s.x, s.y);
    await a.idle();
    const u = await a.ui();
    if (u.chooser?.includes('vertex')) {
      const options = page.getByRole('listbox').getByRole('option');
      await options.nth(u.chooser.indexOf('vertex')).click();
      await a.idle();
    }
    if ((await a.ui()).selection.includes('vertex')) {
      picked = c;
      break;
    }
    await page.keyboard.press('Escape');
  }
  if (!picked) throw new Error('no pickable bottom corner');
  const before = (await a.ui()).selectionKeys;
  expect(before).toHaveLength(1);
  expect(before[0]).toContain('|vertex|');

  // Undo back to the 20 mm box: a regen in which the bottom corners stay put, so the vertex is
  // re-found (in the viewport's own vertex numbering), not dropped.
  await page.keyboard.press('ControlOrMeta+z');
  await a.idle();
  const after = await a.regen();
  expect(after?.bodies[0]?.bbox.max[2]).toBeCloseTo((b.min[2] ?? 0) + 20, 6);
  const sel = (await a.ui()).selectionKeys;
  expect(sel).toHaveLength(1);
  expect(sel[0]).toContain('|vertex|');
  // The remapped index is the vertex at the same place: picking there again gives the same key.
  const s = await toPage(page, picked);
  const hit = await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('[data-testid="viewport-canvas"]') as HTMLElement;
    const r = canvas.getBoundingClientRect();
    const v = (
      window as unknown as {
        __wrenViewport: {
          pick(x: number, y: number, o: object): { kind: string; index: number }[];
        };
      }
    ).__wrenViewport;
    return v.pick(x - r.left, y - r.top, { kinds: ['vertex'], tolerancePx: 6 })[0] ?? null;
  }, s);
  expect(hit?.kind).toBe('vertex');
  expect(sel[0]).toContain(`|vertex|${hit?.index}|`);
});
