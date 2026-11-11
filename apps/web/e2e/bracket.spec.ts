import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { app, boot, cameraStill, sketchOn, toPage } from './helpers';
import { schemaErrors } from './schema';

/**
 * M1 acceptance (PLAN §12), entirely through the UI on the real regen engine: a bracket built from
 * scratch — plate sketched on Top and dimensioned with parameters, four through holes sketched on
 * the plate's top face, the upright sketched on the plate's back face, select-first fillets on the
 * outer vertical edges and the bend, a chamfer on the upright's top edge. Its volume matches the
 * analytic value; changing three upstream parameters regenerates every feature and the new volume
 * matches too; the STEP export re-imported through Open/Import has the same volume (1e-6 rel).
 */

test.use({ viewport: { width: 1280, height: 720 } });

type V3 = [number, number, number];

interface Dims {
  width: number;
  depth: number;
  thickness: number;
  height: number;
  hole_d: number;
  corner_r: number;
  bend_r: number;
  chamfer_d: number;
}

/** Independent analytic volume (mm³). */
function volume(d: Dims): number {
  const k = 1 - Math.PI / 4;
  return (
    d.width * d.depth * d.thickness - // plate
    4 * Math.PI * (d.hole_d / 2) ** 2 * d.thickness - // four through holes
    2 * k * d.corner_r ** 2 * d.thickness + // two rounded outer vertical edges
    d.width * d.thickness * d.height + // upright above the plate
    k * d.bend_r ** 2 * d.width - // concave bend fillet adds material
    0.5 * d.chamfer_d ** 2 * d.width // chamfer on the upright's top front edge
  );
}

const DIMS: Dims = {
  width: 80,
  depth: 50,
  thickness: 8,
  height: 40,
  hole_d: 6,
  corner_r: 5,
  bend_r: 3,
  chamfer_d: 2,
};

async function clickWorld(page: Page, p: V3): Promise<void> {
  const s = await toPage(page, p);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** Dimension tool: pick entities at `picks`, place the label at `label`, type `expr`. */
async function dimension(page: Page, picks: V3[], label: V3, expr: string): Promise<void> {
  const a = app(page);
  for (const p of picks) await clickWorld(page, p);
  await clickWorld(page, label);
  const editor = page.getByTestId('dimension-editor').getByRole('textbox');
  await expect(editor).toBeFocused();
  await editor.fill(expr);
  await editor.press('Enter');
  await expect(editor).toBeHidden();
  await a.settled();
}

/** The sketch at feature index `i` is anchored by a coincidence with its origin, not a `fix`. */
async function expectAtOrigin(page: Page, i: number): Promise<void> {
  const f = (await app(page).doc()).parts[0]?.features[i];
  if (f?.type !== 'sketch') throw new Error(`feature ${i} is not a sketch`);
  expect(f.constraints.some((c) => c.kind === 'fix')).toBe(false);
  expect(f.constraints.filter((c) => c.kind === 'coincident' && c.b === '@origin')).toHaveLength(1);
}

async function addParam(page: Page, name: string, expr: string): Promise<void> {
  await page.getByRole('button', { name: 'Add parameter' }).click();
  const n = page.getByRole('textbox', { name: /^Name of parameter/ }).last();
  await n.fill(name);
  await n.press('Enter');
  const e = page.getByRole('textbox', { name: `Expression for ${name}` });
  await e.fill(expr);
  await e.press('Enter');
}

async function setParam(page: Page, name: string, expr: string): Promise<void> {
  const e = page.getByRole('textbox', { name: `Expression for ${name}` });
  await e.fill(expr);
  await e.press('Enter');
}

/** Select-first on a body: click a face/edge at a world point (waits for the selection ref). */
async function selectAt(page: Page, p: V3, kind: 'face' | 'edge', additive = false) {
  await page.evaluate(() =>
    (
      window as unknown as { __wrenViewport: { whenPickReady(): Promise<void> } }
    ).__wrenViewport.whenPickReady(),
  );
  const s = await toPage(page, p);
  if (additive) await page.keyboard.down('Shift');
  await page.mouse.move(s.x, s.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.up();
  if (additive) await page.keyboard.up('Shift');
  await expect(page.getByTestId('selection-inspector')).toContainText(kind);
}

async function view(page: Page, key: string): Promise<void> {
  await page.locator('body').click({ position: { x: 2, y: 2 } }); // focus out of inputs
  await page.keyboard.press(key);
  await cameraStill(page);
}

/** The face hit straight through a world point in the current view (null: looking through). */
async function faceAt(page: Page, p: V3): Promise<V3 | null> {
  await page.evaluate(() =>
    (
      window as unknown as { __wrenViewport: { whenPickReady(): Promise<void> } }
    ).__wrenViewport.whenPickReady(),
  );
  const s = await toPage(page, p);
  return page.evaluate(({ x, y }) => {
    const v = (
      window as unknown as {
        __wrenViewport: {
          pick(x: number, y: number, o: { kinds: string[] }): { point: V3 }[];
        };
      }
    ).__wrenViewport;
    const r = document.querySelector('[data-testid="viewport-canvas"]')?.getBoundingClientRect();
    return v.pick(x - (r?.left ?? 0), y - (r?.top ?? 0), { kinds: ['face'] })[0]?.point ?? null;
  }, s);
}

async function featureStates(page: Page): Promise<string[]> {
  return ((await app(page).regen())?.features ?? []).map((f) => f.state);
}

async function totalVolume(page: Page): Promise<number> {
  const r = await app(page).regen();
  return (r?.bodies ?? []).reduce((n, b) => n + (b.volume ?? 0), 0);
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

test('M1 acceptance: bracket from scratch, three upstream edits, STEP round trip', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    const w = window as unknown as { showSaveFilePicker?: unknown; showOpenFilePicker?: unknown };
    w.showSaveFilePicker = undefined; // downloads, not the File System Access picker
    w.showOpenFilePicker = undefined; // <input type=file>, so Playwright can choose the file
  });
  const t0 = Date.now();
  await boot(page);
  const a = app(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();

  // 1. Parameters in the Params table.
  await page.getByRole('tab', { name: 'Params' }).click();
  for (const [n, e] of [
    ['width', '80 mm'],
    ['depth', '50 mm'],
    ['thickness', '8 mm'],
    ['height', '40 mm'],
    ['hole_spacing', '40 mm'],
  ] as const)
    await addParam(page, n, e);
  await expect(page.getByTestId('param-value')).toHaveCount(5);
  await page.getByRole('tab', { name: 'Features' }).click();

  // 2. Plate: rectangle on Top, its corner snapped onto the sketch origin (coincident with
  // `@origin`, no `fix`), width × depth.
  await page.keyboard.press('s');
  await sketchOn(page, 'Top');
  await page.getByRole('button', { name: 'Rectangle' }).click();
  await clickWorld(page, [0, 0, 0]);
  // Drawn oversize on purpose: the solver then moves the geometry onto the dimensions exactly. (A
  // click that lands within ~1e-5 mm counts as already satisfied, and two sketches that are each
  // 1e-5 mm off leave slivers where faces should be coplanar.)
  await clickWorld(page, [83, 53, 0]);
  await a.settled();
  await page.keyboard.press('Escape'); // select tool
  await expectAtOrigin(page, 0);
  await page.keyboard.press('d');
  // Labels inside the outline: the new sketch's view is framed for an empty part.
  await dimension(page, [[41, 0, 0]], [41, 6, 0], 'width');
  await dimension(page, [[80, 28, 0]], [72, 28, 0], 'depth');
  expect((await a.sketch())?.dof).toBe(0);
  await page.getByTestId('finish-sketch').click();

  // 3. Extrude by `thickness`.
  await page.keyboard.press('e');
  await a.idle();
  await clickWorld(page, [40, 25, 0]);
  const depth = page.getByTestId('extrude-depth-input').getByRole('textbox');
  await depth.fill('thickness');
  await depth.press('Enter');
  await a.idle();
  expect(await featureStates(page)).toEqual(['ok', 'ok']);
  expect(rel(await totalVolume(page), 80 * 50 * 8)).toBeLessThan(1e-6);
  await page.getByRole('button', { name: 'Done' }).click();

  // 4. Holes: sketch on the plate's top face (select first), four circles, two rows spaced by
  // `hole_spacing`, Ø 6. The left column is dimensioned from the sketch origin (the part origin
  // projected onto the face: world (0, 0, 8)).
  await view(page, '5'); // top
  await selectAt(page, [40, 25, 8], 'face');
  await page.keyboard.press('s');
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
  await a.idle(); // a sketch on a face gets its plane from the regen, then the camera turns to it
  await cameraStill(page);
  const T = 8;
  await page.getByRole('button', { name: 'Circle' }).click();
  for (const [x, y] of [
    [20, 11],
    [60, 11],
    [20, 31],
    [60, 31],
  ] as const) {
    await clickWorld(page, [x, y, T]);
    await clickWorld(page, [x + 3.6, y, T]);
  }
  await a.settled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  // Left column from the origin: label above a centre and the origin → horizontal, beside them →
  // vertical (clear of the axes, which the dimension tool would pick).
  await dimension(
    page,
    [
      [20, 11, T],
      [0, 0, T],
    ],
    [4, 17, T],
    '20 mm',
  );
  await dimension(
    page,
    [
      [20, 11, T],
      [0, 0, T],
    ],
    [28, 4, T],
    '11 mm',
  );
  await dimension(
    page,
    [
      [20, 31, T],
      [0, 0, T],
    ],
    [4, 41, T],
    '20 mm',
  );
  await dimension(
    page,
    [
      [20, 31, T],
      [0, 0, T],
    ],
    [28, 20, T],
    '31 mm',
  );
  // Two centres, label below the pair: a horizontal distance.
  await dimension(
    page,
    [
      [20, 11, T],
      [60, 11, T],
    ],
    [40, 5, T],
    'hole_spacing',
  );
  await dimension(
    page,
    [
      [20, 31, T],
      [60, 31, T],
    ],
    [40, 37, T],
    'hole_spacing',
  );

  // Vertical alignment of the right column, label beside it: a vertical distance.
  await dimension(
    page,
    [
      [60, 11, T],
      [60, 31, T],
    ],
    [66, 21, T],
    '20 mm',
  );
  for (const [x, y] of [
    [20, 11],
    [60, 11],
    [20, 31],
    [60, 31],
  ] as const)
    await dimension(page, [[x - 3.6, y, T]], [x - 6, y + 5, T], '6 mm');
  const holes = (await a.doc()).parts[0]?.features[2];
  if (holes?.type !== 'sketch') throw new Error('no hole sketch');
  expect(holes.constraints.filter((c) => c.kind === 'hDistance')).toHaveLength(4);
  expect(holes.constraints.filter((c) => c.kind === 'vDistance')).toHaveLength(3);
  expect(holes.constraints.some((c) => c.kind === 'fix')).toBe(false);
  // M3.8 (ADR-087): placing the hole centres level with / above one another commits the snapped
  // alignments (horizontalPoints / verticalPoints, only when not redundant), which also pins the
  // right column's height that used to stay free: the hole pattern is now fully defined.
  expect(holes.constraints.filter((c) => c.kind === 'horizontalPoints')).toHaveLength(2);
  expect(holes.constraints.filter((c) => c.kind === 'verticalPoints')).toHaveLength(2);
  expect((await a.sketch())?.conflicts ?? []).toEqual([]);
  expect((await a.sketch())?.dof).toBe(0);
  expect(holes.constraints.filter((c) => c.kind === 'diameter')).toHaveLength(4);
  await page.getByTestId('finish-sketch').click();

  // 5. Cut through all (reverse: into the plate).
  await page.keyboard.press('e');
  await a.idle();
  await clickWorld(page, [20, 11, T]);
  for (const [x, y] of [
    [60, 11],
    [20, 31],
    [60, 31],
  ] as const)
    await clickWorld(page, [x, y, T]);
  const inspector = page.getByTestId('feature-inspector');
  await inspector.getByRole('radio', { name: 'Through all' }).click();
  await inspector.getByRole('radio', { name: 'Reverse' }).click();
  await inspector.getByRole('radio', { name: 'Cut' }).click();
  await a.idle();
  expect(await featureStates(page)).toEqual(['ok', 'ok', 'ok', 'ok']);
  expect(rel(await totalVolume(page), 80 * 50 * 8 - 4 * Math.PI * 9 * 8)).toBeLessThan(1e-6);
  await page.getByRole('button', { name: 'Done' }).click();

  // 6. Upright: sketched on the plate's back face (sketch u = −x, v = z), extruded back into
  // the plate by `thickness` and added.
  await view(page, '2'); // back
  await selectAt(page, [40, 50, 4], 'face');
  await page.keyboard.press('s');
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
  await a.idle();
  await cameraStill(page);
  await page.getByRole('button', { name: 'Rectangle' }).click();
  // The corner snaps onto the sketch origin (world (0, 50, 0) on this face).
  await clickWorld(page, [0, 50, 0]);
  // Drawn short (the view is framed on the plate) and oversize; the dimensions size it.
  await clickWorld(page, [83, 50, 30]);
  await a.settled();
  await page.keyboard.press('Escape');
  await expectAtOrigin(page, 4);
  await page.keyboard.press('d');
  await dimension(page, [[41, 50, 0]], [41, 50, 6], 'width');
  await dimension(page, [[0, 50, 15]], [6, 50, 15], 'thickness + height');
  expect((await a.sketch())?.dof).toBe(0);
  await page.getByTestId('finish-sketch').click();
  await page.keyboard.press('e');
  await a.idle();
  await clickWorld(page, [40, 50, 24]);
  await inspector.getByRole('radio', { name: 'Reverse' }).click();
  await depth.fill('thickness');
  await depth.press('Enter');
  await a.idle();
  expect(await featureStates(page)).toEqual(Array(6).fill('ok'));
  await page.getByRole('button', { name: 'Done' }).click();

  // 7. Select first, act second: fillet the two outer vertical edges (R5), then the bend (R3),
  // then chamfer the upright's top front edge (2 mm).
  await view(page, '0'); // iso
  await selectAt(page, [0, 0, 4], 'edge');
  await selectAt(page, [80, 0, 4], 'edge', true);
  await expect(page.getByTestId('selection-inspector')).toContainText('2 edges');
  await page.keyboard.press('f');
  const radius = inspector.getByRole('textbox', { name: 'Radius' });
  await radius.fill('5 mm');
  await radius.press('Enter');
  await page.getByRole('button', { name: 'Done' }).click();
  await a.idle();
  await selectAt(page, [40, 42, 8], 'edge');
  await page.keyboard.press('f');
  await radius.fill('3 mm');
  await radius.press('Enter');
  await page.getByRole('button', { name: 'Done' }).click();
  await a.idle();
  await selectAt(page, [40, 42, 48], 'edge');
  await page.keyboard.press('c');
  await inspector.getByRole('textbox', { name: 'Distance' }).fill('2 mm');
  await inspector.getByRole('textbox', { name: 'Distance' }).press('Enter');
  await page.getByRole('button', { name: 'Done' }).click();
  await a.idle();

  expect(await featureStates(page)).toEqual(Array(9).fill('ok'));
  const v1 = await totalVolume(page);
  const e1 = volume(DIMS);
  expect(rel(v1, e1)).toBeLessThan(1e-6);
  // The inspector's mass properties show the same volume (cm³).
  await expect(page.getByTestId('mass-readout').locator('[data-prop="volume"]')).toContainText(
    String(Math.floor(e1 / 1000)),
  );
  await page.screenshot({ path: 'test-results/m1-bracket-built.png' });

  // 8. Three upstream dimensions in the Params table → every feature still ok.
  await page.getByRole('tab', { name: 'Params' }).click();
  await setParam(page, 'width', '100 mm');
  await setParam(page, 'thickness', '10 mm');
  await setParam(page, 'hole_spacing', '50 mm');
  await a.idle();
  expect(await featureStates(page)).toEqual(Array(9).fill('ok'));
  const v2 = await totalVolume(page);
  const e2 = volume({ ...DIMS, width: 100, thickness: 10 });
  expect(rel(v2, e2)).toBeLessThan(1e-6);
  // hole_spacing doesn't change the volume: check the holes moved. Looking straight down, the
  // left column (fixed at x = 20) and the right column (now x = 20 + 50) are see-through; where
  // the right column used to be (x = 60) is solid plate top (z = thickness = 10).
  await view(page, '5');
  for (const y of [11, 31]) {
    expect(await faceAt(page, [20, y, 10]), `left hole at y=${y}`).toBeNull();
    expect(await faceAt(page, [70, y, 10]), `moved hole at y=${y}`).toBeNull();
    const solid = await faceAt(page, [60, y, 10]);
    expect(solid?.[2] ?? Number.NaN, `old hole position at y=${y}`).toBeCloseTo(10, 3);
  }
  await page.getByRole('tab', { name: 'Features' }).click();
  await page.screenshot({ path: 'test-results/m1-bracket-edited.png' });

  // The document the UI produced validates against the published JSON Schemas.
  const doc = await a.doc();
  expect(schemaErrors(doc)).toEqual([]);

  // 9. Export → STEP (a download), then Open/Import it into a new document.
  await page.getByRole('button', { name: 'Export' }).click();
  const form = page.getByTestId('export-form');
  await form.getByRole('radio', { name: /STEP/ }).click();
  const download = page.waitForEvent('download');
  await form.getByRole('button', { name: /^Export/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.step$/);
  const stepPath = info.outputPath('bracket.step');
  await file.saveAs(stepPath);
  expect(readFileSync(stepPath, 'utf8')).toContain('ISO-10303-21');

  await a.flushSave();
  await page.getByTestId('library-button').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('library-open-file').click();
  await (await chooser).setFiles(stepPath);
  await expect(page.getByTestId('feature-tree')).toContainText('bracket');
  await a.idle();
  const imported = await a.regen();
  const importState = imported?.features[0];
  expect(
    imported?.features.map((f) => f.state),
    importState?.error,
  ).toEqual(['ok']);
  const v3 = await totalVolume(page);
  info.annotations.push({
    type: 'volumes',
    description: `built ${v1} (analytic ${e1}); edited ${v2} (analytic ${e2}); STEP re-import ${v3} (rel ${rel(v3, v2)}); ${Date.now() - t0} ms`,
  });
  console.log(info.annotations.at(-1)?.description);
  expect(rel(v3, v2)).toBeLessThan(1e-6);
  // The STEP bytes travel with the document as an attachment.
  const files = await a.projectFiles();
  expect(files.extra).toHaveLength(1);
  expect(files.extra[0]).toMatch(/^imports\/[0-9A-Z]{26}\.step$/);
  await page.screenshot({ path: 'test-results/m1-bracket-step-import.png' });
});
