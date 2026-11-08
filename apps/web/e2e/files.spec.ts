import { readFileSync, writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import type { WhittleDoc } from '@whittle/contracts';
import { projectCodec } from '@whittle/document';
import { docWith, fid } from './fixtures';
import { app, boot } from './helpers';

/**
 * Files and the library (M1 gate defects 2, 3, 5, 6): opening a .whittle never overwrites a
 * different library entry, attachments and other project files travel with the document
 * (library, .whittle, reload), files dropped on the viewport import, and a cached document is on
 * screen before the kernel is ready.
 */

test.use({ viewport: { width: 1280, height: 720 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { showSaveFilePicker?: unknown; showOpenFilePicker?: unknown };
    w.showSaveFilePicker = undefined;
    w.showOpenFilePicker = undefined;
  });
});

async function download(page: Page, run: () => Promise<void>, path: string): Promise<string> {
  const d = page.waitForEvent('download');
  await run();
  await (await d).saveAs(path);
  return path;
}

async function openFile(page: Page, path: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open or import…' }).click();
  await (await chooser).setFiles(path);
}

const widthOf = (doc: WhittleDoc) => doc.params.find((p) => p.name === 'width')?.expr;

/** A binary STL of an axis-aligned cube (12 triangles), `s` mm. */
function cubeStl(s: number): Buffer {
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
  return buf;
}

test('opening an older .whittle file never overwrites the newer library entry', async ({
  page,
}, info) => {
  test.slow();
  await boot(page);
  const a = app(page);
  await page.getByTestId('open-demo').click();
  await a.idle();
  await a.flushSave();
  const old = await download(
    page,
    () => page.getByRole('button', { name: 'Save file' }).click(),
    info.outputPath('demo.whittle'),
  );

  // Edit width; autosave writes the newer version under the same library id.
  await page.getByRole('tab', { name: 'Params' }).click();
  const width = page.getByRole('textbox', { name: 'Expression for width' });
  await width.fill('100 mm');
  await width.press('Enter');
  await a.idle();
  await a.flushSave();
  const newer = (await a.doc()).meta.id;
  expect((await a.library()).filter((e) => e.id === newer)).toHaveLength(1);

  // Open the old file: it becomes a new entry; the newer version is untouched.
  await openFile(page, old);
  await expect(page.getByTestId('toast')).toContainText('Opened as “Demo bracket (copy)”');
  await a.flushSave();
  const opened = await a.doc();
  expect(opened.meta.id).not.toBe(newer);
  expect(opened.meta.name).toBe('Demo bracket (copy)');
  expect(widthOf(opened)).toBe('80 mm');
  const names = (await a.library()).map((e) => e.name).sort();
  expect(names).toEqual(['Demo bracket', 'Demo bracket (copy)']);
  await page.screenshot({ path: 'test-results/m1-open-copy.png' });

  // Both versions are there: the library's "Demo bracket" still has width 100.
  await page.getByTestId('library-button').click();
  await page
    .getByTestId('library-item')
    .filter({ hasText: /^Demo bracket(?! \(copy\))/ })
    .getByRole('button', { name: /^Open/ })
    .first()
    .click();
  await expect.poll(async () => (await a.doc()).meta.id).toBe(newer);
  expect(widthOf(await a.doc())).toBe('100 mm');

  // Re-opening a file identical to its library entry reuses that entry.
  const same = await download(
    page,
    () => page.getByRole('button', { name: 'Save file' }).click(),
    info.outputPath('same.whittle'),
  );
  await openFile(page, same);
  await a.flushSave();
  expect((await a.doc()).meta.id).toBe(newer);
  expect(await a.library()).toHaveLength(2);
});

test('attachments and other project files travel with the document; drop to import', async ({
  page,
}, info) => {
  test.slow();
  // A project with files outside the document model (previews/, releases/).
  const doc = docWith('Extras', {}, [
    {
      id: fid('BOX'),
      type: 'primitive',
      name: 'Box 1',
      suppressed: false,
      shape: 'box',
      dx: '20 mm',
      dy: '20 mm',
      dz: '20 mm',
      op: 'new',
    },
  ]);
  const extra = new Map<string, Uint8Array>([
    ['previews/extras.stl', new Uint8Array(cubeStl(5))],
    ['releases/rev-A/notes.txt', new TextEncoder().encode('Released for the M1 gate\n')],
  ]);
  const projectPath = info.outputPath('extras.whittle');
  writeFileSync(projectPath, projectCodec.toWhittle(doc, undefined, extra));

  await boot(page);
  const a = app(page);
  await openFile(page, projectPath);
  await expect(page.getByTestId('feature-tree')).toContainText('Box 1');
  await a.idle();

  // Drop an STL on the viewport: an import feature in the current part.
  const stl = cubeStl(10).toString('base64');
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'cube.stl', { type: 'model/stl' }));
    const target = document.querySelector('[data-testid="viewport-canvas"]') as HTMLElement;
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  }, stl);
  await expect(page.getByTestId('feature-tree')).toContainText('cube');
  await a.idle();
  let r = await a.regen();
  expect(r?.features.map((f) => f.state)).toEqual(['ok', 'ok']);
  expect(r?.bodies).toHaveLength(2);
  const imported = (await a.doc()).parts[0]?.features[1];
  if (imported?.type !== 'import') throw new Error('no import feature');
  expect(imported.source.path).toBe(`imports/${imported.id}.stl`);
  expect(imported.source.fileName).toBe('cube.stl');
  expect(imported.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(await a.sentAttachments()).toEqual([
    `${(await a.doc()).parts[0]?.id}:${imported.source.sha256}`,
  ]);
  const expected = [
    `imports/${imported.id}.stl`,
    'previews/extras.stl',
    'releases/rev-A/notes.txt',
  ].sort();
  expect((await a.projectFiles()).extra).toEqual(expected);

  // Library round trip (reload = a new kernel worker: the attachment is sent again).
  await a.flushSave();
  await page.reload();
  await page.evaluate(() =>
    (
      window as unknown as { __whittle: { firstBodyRendered(): Promise<unknown> } }
    ).__whittle.firstBodyRendered(),
  );
  await a.idle();
  expect((await a.projectFiles()).extra).toEqual(expected);
  r = await a.regen();
  expect(r?.features.map((f) => f.state)).toEqual(['ok', 'ok']);
  expect(await a.sentAttachments()).toHaveLength(1);

  // .whittle export keeps every file.
  const out = await download(
    page,
    () => page.getByRole('button', { name: 'Save file' }).click(),
    info.outputPath('extras-out.whittle'),
  );
  const back = projectCodec.fromWhittle(new Uint8Array(readFileSync(out)));
  expect([...(back.extra?.keys() ?? [])].sort()).toEqual(expected);
  expect(new TextDecoder().decode(back.extra?.get('releases/rev-A/notes.txt'))).toBe(
    'Released for the M1 gate\n',
  );
  expect(back.doc.parts[0]?.features.map((f) => f.type)).toEqual(['primitive', 'import']);
});

test('a cached document renders before the kernel is ready (≤ 500 ms), then goes live', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  const a = app(page);
  await page.getByTestId('open-demo').click();
  await a.idle();
  expect(await a.cacheSaved()).toBe(true);
  const files = await a.projectFiles();
  expect(files.cache).toContain('meshes/index.json');
  const live = await a.regen();

  // Warm reload: the library's mesh cache is drawn first, the regen replaces it.
  await page.reload();

  await page.evaluate(() =>
    (
      window as unknown as { __whittle: { firstBodyRendered(): Promise<unknown> } }
    ).__whittle.firstBodyRendered(),
  );
  const marks = await a.marks();
  console.log(`cached open: ${JSON.stringify(marks)}`);
  expect(marks.cachedBodyMs).toBeLessThan(500);
  expect(marks.cachedBodyMs).toBeLessThan(marks.kernelReadyMs as number);
  expect(marks.cachedBodyMs).toBeLessThan(marks.firstBodyMs as number);
  await a.idle();
  const after = await a.regen();
  expect(after?.source).toBe('live');
  expect(after?.bodies.map((b) => b.id)).toEqual(live?.bodies.map((b) => b.id));
  expect(after?.features.every((f) => f.state === 'ok')).toBe(true);
});
