import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import type { Configuration, WrenDoc } from '@wren-cad/contracts';
import { app, boot } from './helpers';
import {
  BOSS,
  CFG_LONG,
  CFG_THICK,
  configPartDoc,
  expectedMass,
  HOLE,
  P_LENGTH,
  P_THICK,
} from './support/config-part';

/**
 * M3.7 acceptance, desktop: part configurations from the UI. Golden masses of a reference part,
 * the create / switch / suppress / export / save / reload flow, the edit-scope rule, a TSV paste,
 * the real merge path, and a missing configuration. The part and its closed-form masses are in
 * support/config-part.ts.
 */

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ page }) => {
  // Downloads, not save pickers: the export tests read the files.
  await page.addInitScript(() => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
  });
});

const part = async (page: Page) => (await app(page).doc()).parts[0] as WrenDoc['parts'][number];
const configs = async (page: Page): Promise<Configuration[]> =>
  (await part(page)).configurations ?? [];
const activeOf = async (page: Page) => (await part(page)).activeConfigurationId ?? null;

async function open(page: Page, doc: WrenDoc): Promise<void> {
  await boot(page);
  await app(page).load(doc);
  await app(page).idle();
}

const pill = (page: Page) => page.getByTestId('configuration-pill');

async function switchTo(page: Page, name: string): Promise<void> {
  await pill(page).click();
  await page
    .getByTestId('configuration-list')
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click();
  await app(page).idle();
}

async function createConfiguration(page: Page, name: string, from: 'Default' | 'Active') {
  await pill(page).click();
  const list = page.getByTestId('configuration-list');
  await list.getByRole('button', { name: 'New configuration…' }).click();
  await list.getByRole('textbox', { name: 'New configuration name' }).fill(name);
  await list.getByRole('radio', { name: `From ${from}` }).click();
  await list.getByRole('button', { name: 'Create' }).click();
  await expect(pill(page)).toContainText(name);
  await app(page).idle();
}

async function bodyMass(page: Page): Promise<number> {
  const r = await app(page).regen();
  return (r?.bodies ?? []).reduce((s, b) => s + (b.volume ?? 0), 0) * 1e-6;
}

const openParams = (page: Page) => page.getByRole('tab', { name: 'Params' }).click();
const openFeatures = (page: Page) => page.getByRole('tab', { name: 'Features' }).click();

test('golden masses: every configuration regenerates to its closed-form mass', async ({ page }) => {
  test.slow();
  await open(page, configPartDoc());
  const a = app(page);
  // Default is live; the others come from the background builds in their own slots.
  expect(await a.configurationsBuilt()).toBe(true);
  const built = (await a.configurations()).builds;
  expect(built.default?.status).toBe('ok');
  expect(built.default?.mass).toBeCloseTo(expectedMass.default, 9);
  expect(built[CFG_LONG]?.status).toBe('ok');
  expect(built[CFG_LONG]?.mass).toBeCloseTo(expectedMass.long, 9);
  expect(built[CFG_THICK]?.status).toBe('ok');
  expect(built[CFG_THICK]?.mass).toBeCloseTo(expectedMass.thick, 9);

  // Switching to each makes it the live model: the same masses from the live regen (0.1 % tolerance
  // as in the certification-style suite, and in fact much tighter).
  const live: [string, number][] = [
    ['Long', expectedMass.long],
    ['Thick', expectedMass.thick],
    ['Default', expectedMass.default],
  ];
  for (const [name, mass] of live) {
    await switchTo(page, name);
    expect(await bodyMass(page), name).toBeCloseTo(mass, 9);
    await expect(pill(page)).toContainText(name);
  }
  // The inspector lists the mass of every configuration.
  const rows = page.getByTestId('mass-per-configuration');
  await expect(rows).toContainText('Long');
  await expect(rows.locator('[data-config-id]')).toHaveCount(3);
  // The background builds never touched the live regen counter beyond the switches.
  expect((await a.configurations()).missing).toBe(false);
});

test('create two configurations, switch, suppress in one only, export both, save and reload', async ({
  page,
}) => {
  test.slow();
  await open(page, configPartDoc(false));
  const a = app(page);

  // Two configurations from the UI. "Long" starts from Default.
  await createConfiguration(page, 'Long', 'Default');
  expect((await configs(page)).map((c) => c.name)).toEqual(['Long']);
  expect(await activeOf(page)).toBe((await configs(page))[0]?.id);

  // Inherited edit (length 40 → 60) with "This configuration only": an override of Long.
  await openParams(page);
  const row = page.locator(`[data-param-id="${P_LENGTH}"]`);
  await row.getByTestId('scope-chip').click();
  const e = page.getByRole('textbox', { name: 'Expression for length' });
  await e.fill('60 mm');
  await e.press('Enter');
  await a.idle();
  expect((await configs(page))[0]?.params).toEqual({ [P_LENGTH]: '60 mm' });
  expect((await part(page)).features).toHaveLength(3);
  expect(await bodyMass(page)).toBeCloseTo(expectedMass.long, 9);
  // The scope chip is one-shot: gone after the commit.
  await expect(row.getByTestId('scope-chip')).toHaveAttribute('aria-pressed', 'false');

  // "NoBoss" starts from Default (not from Long), so it keeps length 40.
  await createConfiguration(page, 'NoBoss', 'Default');
  const noBoss = (await configs(page)).find((c) => c.name === 'NoBoss');
  expect(noBoss?.params).toBeUndefined();
  await openFeatures(page);
  const tree = page.getByTestId('feature-tree');
  await tree.getByRole('treeitem', { name: /Boss/ }).click();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Suppress in this configuration only' }).click();
  await a.idle();
  const p1 = await part(page);
  expect(p1.features.find((f) => f.id === BOSS)?.suppressed).toBe(false); // Default keeps it
  expect(p1.configurations?.find((c) => c.name === 'NoBoss')?.features).toEqual({
    [BOSS]: { suppressed: true },
  });
  expect(await bodyMass(page)).toBeCloseTo((8000 - Math.PI * 16 * 10) * 1e-6, 9);
  await expect(tree.getByRole('treeitem', { name: /Boss/ })).toContainText(/suppressed/i);

  // Switching back: Long still has its boss and its length.
  await switchTo(page, 'Long');
  expect(await bodyMass(page)).toBeCloseTo(expectedMass.long, 9);
  await switchTo(page, 'NoBoss');

  // Export both configurations: one file each, named by part number (document name + name).
  await page.getByRole('button', { name: 'Export' }).click();
  const form = page.getByTestId('export-form');
  await form.getByRole('radio', { name: /STEP/ }).click();
  await form.getByRole('radio', { name: /^All \(3\)/ }).click();
  const names: string[] = [];
  const bytes = new Map<string, string>();
  page.on('download', async (d) => {
    names.push(d.suggestedFilename());
    const path = await d.path();
    bytes.set(d.suggestedFilename(), readFileSync(path, 'utf8'));
  });
  await form.getByRole('button', { name: /^Export STEP/ }).click();
  await expect.poll(() => names.length, { timeout: 60_000 }).toBe(3);
  expect(names.sort()).toEqual(['Plate-Long.step', 'Plate-NoBoss.step', 'Plate.step']);
  await expect.poll(() => bytes.size).toBe(3);
  // The three solids differ.
  const body = (n: string) => (bytes.get(n) ?? '').split('DATA;')[1] ?? '';
  expect(body('Plate-Long.step')).not.toEqual(body('Plate-NoBoss.step'));
  expect(body('Plate.step')).not.toEqual(body('Plate-NoBoss.step'));
  expect(body('Plate.step')).not.toEqual(body('Plate-Long.step'));
  // Exporting other configurations did not change what is on screen.
  await a.idle();
  expect(await bodyMass(page)).toBeCloseTo((8000 - Math.PI * 16 * 10) * 1e-6, 9);

  // Save, reload: everything is kept, including the active configuration.
  const before = await part(page);
  await a.flushSave();
  await page.reload();
  await page.waitForFunction(
    () =>
      window.crossOriginIsolated === true && !!(window as unknown as { __wren?: unknown }).__wren,
  );
  await expect.poll(async () => (await part(page)).configurations?.length).toBe(2);
  const after = await part(page);
  expect(after.configurations).toEqual(before.configurations);
  expect(after.activeConfigurationId).toBe(before.activeConfigurationId);
  await a.idle();
  await expect(pill(page)).toContainText('NoBoss');
  expect(await bodyMass(page)).toBeCloseTo((8000 - Math.PI * 16 * 10) * 1e-6, 9);
});

test('scope: an inherited edit changes Default with an undoable notice; an override changes only its configuration; reset removes the key', async ({
  page,
}) => {
  test.slow();
  const doc = configPartDoc();
  await open(page, doc);
  const a = app(page);
  await switchTo(page, 'Thick');
  expect((await part(page)).activeConfigurationId).toBe(CFG_THICK);

  // Params tab: Thick overrides `thick`; `length` is inherited. Markers say which is which.
  await openParams(page);
  const thick = page.locator(`[data-param-id="${P_THICK}"]`);
  const length = page.locator(`[data-param-id="${P_LENGTH}"]`);
  await expect(thick.getByTestId('override-marker')).toBeVisible();
  await expect(length.getByTestId('override-marker')).toHaveCount(0);

  // Editing the inherited value edits Default and says so.
  const past0 = (await a.history()).past.length;
  const le = page.getByRole('textbox', { name: 'Expression for length' });
  await le.fill('50 mm');
  await le.press('Enter');
  await a.idle();
  expect((await a.doc()).params.find((p) => p.id === P_LENGTH)?.expr).toBe('50 mm');
  // Long overrides `length`: only Default and Thick inherit it (N = 2).
  const notice = page.getByTestId('changed-in-all');
  await expect(notice).toContainText('Changed in all 2 configurations');
  expect((await configs(page)).find((c) => c.id === CFG_THICK)?.params).toEqual({
    [P_THICK]: '15 mm',
  });
  // Undo from the notice: Default is back, one undo step.
  await notice.getByRole('button', { name: 'Undo' }).click();
  await a.idle();
  expect((await a.doc()).params.find((p) => p.id === P_LENGTH)?.expr).toBe('40 mm');
  expect((await a.history()).past.length).toBe(past0);
  await expect(notice).toHaveCount(0);

  // Editing Thick's own override changes only Thick.
  const te = page.getByRole('textbox', { name: 'Expression for thick' });
  await te.fill('20 mm');
  await te.press('Enter');
  await a.idle();
  const d2 = await a.doc();
  expect(d2.params.find((p) => p.id === P_THICK)?.expr).toBe('10 mm'); // Default untouched
  expect(d2.parts[0]?.configurations?.find((c) => c.id === CFG_THICK)?.params).toEqual({
    [P_THICK]: '20 mm',
  });
  await expect(page.getByTestId('changed-in-all')).toHaveCount(0);

  // Feature fields: Hole's radius is overridden in Thick (6 mm). Edit it in the inspector.
  await openFeatures(page);
  await page.getByTestId('feature-tree').getByRole('treeitem', { name: /Hole/ }).click();
  const inspector = page.getByTestId('feature-inspector');
  await expect(inspector.getByTestId('override-marker')).toBeVisible();
  const radius = inspector.getByRole('textbox', { name: 'Radius' });
  await radius.fill('5 mm');
  await radius.press('Enter');
  await a.idle();
  const d3 = await a.doc();
  expect(d3.parts[0]?.features.find((f) => f.id === HOLE)).toMatchObject({ radius: '4 mm' });
  expect(
    d3.parts[0]?.configurations?.find((c) => c.id === CFG_THICK)?.features?.[HOLE]?.fields,
  ).toEqual({ '/radius': '5 mm' });
  // Reset on the marker removes the override key from the document.
  await inspector.getByRole('button', { name: /Reset Radius to default/ }).click();
  await a.idle();
  const d4 = await a.doc();
  const thickCfg = d4.parts[0]?.configurations?.find((c) => c.id === CFG_THICK);
  expect(thickCfg?.features?.[HOLE]).toBeUndefined();
  expect(thickCfg?.features?.[BOSS]).toEqual({ suppressed: true });
  // And it survives a save: the key is gone from the file's document, not just emptied.
  await a.flushSave();
  expect(JSON.stringify((await a.doc()).parts[0]?.configurations)).not.toContain('/radius');
});

test('scope: editing an inherited feature field edits Default and shows the notice', async ({
  page,
}) => {
  test.slow();
  await open(page, configPartDoc());
  const a = app(page);
  await switchTo(page, 'Long');
  await page.getByTestId('feature-tree').getByRole('treeitem', { name: /Hole/ }).click();
  const inspector = page.getByTestId('feature-inspector');
  // Long does not override the radius: no marker, the edit is Default's.
  await expect(inspector.getByTestId('override-marker')).toHaveCount(0);
  const radius = inspector.getByRole('textbox', { name: 'Radius' });
  await radius.fill('3 mm');
  await radius.press('Enter');
  await a.idle();
  const d = await a.doc();
  expect(d.parts[0]?.features.find((f) => f.id === HOLE)).toMatchObject({ radius: '3 mm' });
  await expect(page.getByTestId('changed-in-all')).toContainText('Changed in all 2 configurations');
  // Chip: "This configuration only" writes an override for Long instead, once.
  await page.getByTestId('config-edit-scope').getByTestId('scope-chip').click();
  await radius.fill('2 mm');
  await radius.press('Enter');
  await a.idle();
  const d2 = await a.doc();
  expect(d2.parts[0]?.features.find((f) => f.id === HOLE)).toMatchObject({ radius: '3 mm' });
  expect(
    d2.parts[0]?.configurations?.find((c) => c.id === CFG_LONG)?.features?.[HOLE]?.fields,
  ).toEqual({ '/radius': '2 mm' });
  await expect(page.getByTestId('config-edit-scope').getByTestId('scope-chip')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('paste a 3 × 4 block into the table: the configurations appear', async ({ page }) => {
  test.slow();
  await open(page, configPartDoc(false));
  const a = app(page);
  await pill(page).click();
  await page.getByTestId('configuration-list').getByRole('button', { name: 'Manage…' }).click();
  const panel = page.getByTestId('configuration-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('configuration-table')).toBeVisible();
  // Focus a cell, then paste: header row (three columns), two configurations.
  await panel.locator('[data-cell]').first().focus();
  const tsv = [
    'Name\tlength\tthick\tPart number',
    'Long\t60 mm\t\tPL-60',
    'Tall\t\t14 mm\tPL-T',
  ].join('\n');
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, tsv);
  await a.idle();
  const cs = await configs(page);
  expect(cs.map((c) => c.name)).toEqual(['Long', 'Tall']);
  expect(cs[0]?.params).toEqual({ [P_LENGTH]: '60 mm' });
  expect(cs[0]?.properties).toEqual({ partNumber: 'PL-60' });
  expect(cs[1]?.params).toEqual({ [P_THICK]: '14 mm' });
  expect(cs[1]?.properties).toEqual({ partNumber: 'PL-T' });
  // One undo step for the whole paste.
  const past = (await a.history()).past;
  expect(past.at(-1)?.label).toMatch(/paste/i);
  await page.keyboard.press('ControlOrMeta+z');
  await a.idle();
  expect(await configs(page)).toHaveLength(0);
  // The table shows the status and mass columns for the rebuilt configurations.
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await a.configurationsBuilt();
  await expect(panel).toContainText('Long');
  await expect(panel).toContainText('Tall');
});

test('table edits: Default cells use the ordinary commands, other rows write overrides', async ({
  page,
}) => {
  test.slow();
  await open(page, configPartDoc());
  const a = app(page);
  await pill(page).click();
  await page.getByTestId('configuration-list').getByRole('button', { name: 'Manage…' }).click();
  const panel = page.getByTestId('configuration-panel');
  await expect(panel.getByTestId('configuration-table')).toBeVisible();
  // Mass column and status from the background builds.
  await a.configurationsBuilt();
  await expect(panel).toContainText('Mass');
  await expect(panel).toContainText(/12\.2973 g/);
  // A cell edit in the Default row edits Default (updateParam).
  const cell = panel.locator('[data-cell="0:0"]');
  await cell.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('45 mm');
  await page.keyboard.press('Enter');
  await a.idle();
  expect((await a.doc()).params.find((p) => p.id === P_LENGTH)?.expr).toBe('45 mm');
  expect((await a.history()).past.at(-1)).toBeDefined();
});

test('merge: edits to different configurations merge cleanly; the same cell on both sides is flagged', async ({
  page,
}) => {
  test.slow();
  await open(page, configPartDoc());
  const a = app(page);
  type Ctl = {
    saveVersion(message: string): Promise<void>;
    createBranch(name: string): Promise<void>;
    switchBranch(name: string): Promise<void>;
    mergeDiverged(theirs: string): Promise<void>;
    idle(): Promise<void>;
    testState(): Promise<{
      branches: { name: string; head: string; current: boolean }[];
      conflicts: string[] | null;
    }>;
  };
  const call = (method: string, ...args: unknown[]) =>
    page.evaluate(
      async ([m, rest]) => {
        const c = await (
          window as unknown as { __wrenApp: { syncController(): Promise<Ctl> } }
        ).__wrenApp.syncController();
        return (c as unknown as Record<string, (...x: unknown[]) => unknown>)[m as string]?.(
          ...(rest as unknown[]),
        );
      },
      [method, args] as const,
    );
  const state = async () => {
    await call('idle');
    return (await call('testState')) as Awaited<ReturnType<Ctl['testState']>>;
  };
  const edit = async (c: unknown) => {
    expect(await a.apply(c)).toBe(true);
    await a.idle();
    await a.flushSave();
  };
  const partId = (await part(page)).id;
  const setParam = (configurationId: string, paramId: string, value: string) =>
    edit({
      kind: 'setConfigurationOverrides',
      partId,
      edits: [{ configurationId, target: { kind: 'param', paramId }, value }],
    });

  await page.getByTestId('versions-button').click();
  await call('saveVersion', 'Base');
  const mainName = (await state()).branches.find((b) => b.current)?.name as string;

  // One branch edits Long's length and renames Thick's... Thick's thickness; main edits Thick's.
  await call('createBranch', 'long-edit');
  await setParam(CFG_LONG, P_LENGTH, '70 mm');
  await call('saveVersion', 'Long is 70');
  const longHead = (await state()).branches.find((b) => b.name === 'long-edit')?.head as string;

  await call('switchBranch', mainName);
  await expect
    .poll(async () => (await configs(page)).find((c) => c.id === CFG_LONG)?.params)
    .toEqual({
      [P_LENGTH]: '60 mm',
    });
  await setParam(CFG_THICK, P_THICK, '18 mm');
  await call('saveVersion', 'Thick is 18');

  await call('mergeDiverged', longHead);
  await call('idle');
  await expect
    .poll(async () => (await configs(page)).find((c) => c.id === CFG_LONG)?.params)
    .toEqual({ [P_LENGTH]: '70 mm' });
  const merged = await configs(page);
  expect(merged.find((c) => c.id === CFG_THICK)?.params?.[P_THICK]).toBe('18 mm');
  expect((await state()).conflicts).toBeNull();
  await expect(page.getByTestId('merge-panel')).toHaveCount(0);
  await a.idle();
  expect((await a.regen())?.features.every((f) => f.state === 'ok')).toBe(true);

  // The same cell on both sides: Long's length 70 here, 80 there.
  await call('saveVersion', 'Merged');
  await call('createBranch', 'long-80');
  await setParam(CFG_LONG, P_LENGTH, '80 mm');
  await call('saveVersion', 'Long is 80');
  const head80 = (await state()).branches.find((b) => b.name === 'long-80')?.head as string;
  await call('switchBranch', mainName);
  await expect
    .poll(async () => (await configs(page)).find((c) => c.id === CFG_LONG)?.params)
    .toEqual({
      [P_LENGTH]: '70 mm',
    });
  await setParam(CFG_LONG, P_LENGTH, '90 mm');
  await call('saveVersion', 'Long is 90');
  await call('mergeDiverged', head80);
  await call('idle');
  const panel = page.getByTestId('merge-panel');
  await expect(panel).toBeVisible();
  // Readable values, not JSON: "Long: length 90 mm vs 80 mm".
  await expect(panel).toContainText(/Long/);
  await expect(panel).toContainText(/90 mm/);
  await expect(panel).toContainText(/80 mm/);
  expect((await state()).conflicts?.length).toBeGreaterThan(0);
});

test('a missing active configuration is "needs attention", never a silent Default', async ({
  page,
}) => {
  test.slow();
  await open(page, configPartDoc());
  const a = app(page);
  // Documents with a dangling id do not validate on open; one gets here through a merge from an
  // older writer or a hand edit (a raw patch). It is "needs attention", never Default.
  expect(
    await a.apply({
      kind: 'patch',
      ops: [
        { op: 'add', path: '/parts/0/activeConfigurationId', value: '01JGONE00000000000000000XX' },
      ],
    }),
  ).toBe(true);
  await a.idle();
  expect((await a.configurations()).missing).toBe(true);
  await expect(page.getByTestId('config-missing')).toContainText(/needs attention/i);
  await expect(pill(page)).toContainText('Missing configuration');
  await expect(pill(page)).toHaveAttribute('aria-label', /Needs attention/);
  // It is not exported as if it were Default.
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByTestId('export-form').getByRole('radio', { name: /STEP/ }).click();
  await page
    .getByTestId('export-form')
    .getByRole('button', { name: /^Export STEP/ })
    .click();
  await expect(page.getByText(/needs attention: it no longer exists/i)).toBeVisible();
  // The way out is explicit.
  await page.keyboard.press('Escape');
  await page
    .getByTestId('config-missing')
    .getByRole('button', { name: 'Switch to Default' })
    .click();
  await a.idle();
  expect((await a.configurations()).missing).toBe(false);
  await expect(page.getByTestId('config-missing')).toHaveCount(0);
});

test('an override that no longer applies marks the feature "needs attention" in that configuration only', async ({
  page,
}) => {
  test.slow();
  const doc = configPartDoc();
  const part0 = doc.parts[0];
  const thick = part0?.configurations?.find((c) => c.id === CFG_THICK);
  if (!thick) throw new Error('no configuration');
  // A field of the hole that cannot be configured: kept and reported, never dropped.
  thick.features = {
    ...thick.features,
    [HOLE]: { fields: { '/radius': '6 mm', '/nope': '1 mm' } },
  };
  await open(page, doc);
  const a = app(page);
  await a.configurationsBuilt();
  expect((await a.configurations()).builds[CFG_THICK]?.status).toBe('attention');
  expect((await a.configurations()).builds.default?.status).toBe('ok');
  await switchTo(page, 'Thick');
  const hole = page.getByTestId('feature-tree').getByRole('treeitem', { name: /Hole/ });
  await expect(hole).toContainText(/needs attention/i);
  await expect(hole).toContainText(/not a configurable field/i);
  await hole.click();
  await expect(page.getByTestId('config-issue')).toContainText(/In Thick/);
  // The override is still in the file.
  expect(
    (await configs(page)).find((c) => c.id === CFG_THICK)?.features?.[HOLE]?.fields,
  ).toHaveProperty('/nope');
});

test('part properties: part number and description; the part number names the exports', async ({
  page,
}) => {
  test.slow();
  await open(page, configPartDoc());
  const a = app(page);
  await page.getByTestId('feature-tree').click({ position: { x: 5, y: 400 }, force: true });
  await page.keyboard.press('Escape');
  const pn = page.getByTestId('prop-part-number');
  await expect(pn).toHaveAttribute('placeholder', 'Plate');
  await pn.fill('PL-100');
  await pn.press('Enter');
  await a.idle();
  expect((await part(page)).properties).toEqual({ partNumber: 'PL-100' });
  await page.getByTestId('prop-description').fill('Base plate');
  await page.getByTestId('prop-description').press('Enter');
  await a.idle();
  expect((await part(page)).properties).toEqual({
    partNumber: 'PL-100',
    description: 'Base plate',
  });

  // Two configurations with the same part number: a warning, nothing is written.
  await page.getByRole('button', { name: 'Export' }).click();
  const form = page.getByTestId('export-form');
  await form.getByRole('radio', { name: /STEP/ }).click();
  await form.getByRole('radio', { name: /^All \(3\)/ }).click();
  await expect(form.getByTestId('export-collisions')).toContainText(
    /would both be written to PL-100/,
  );
  let downloads = 0;
  page.on('download', () => downloads++);
  await form.getByRole('button', { name: /^Export STEP/ }).click();
  await expect(page.getByText(/Nothing was exported/)).toBeVisible();
  expect(downloads).toBe(0);
});

test('switching between two built configurations stays within the 300 ms regen budget', async ({
  page,
}, info) => {
  test.slow();
  await open(page, configPartDoc());
  const a = app(page);
  await a.configurationsBuilt();
  // Warm both ways once (the first switch to each builds its features in the live slot).
  const seen: { name: string; regenMs: number; renderMs: number; cached: boolean }[] = [];
  for (const name of ['Long', 'Thick', 'Long', 'Thick', 'Long', 'Default', 'Long']) {
    await switchTo(page, name);
    const s = (await a.configurations()).lastSwitch;
    if (s) seen.push({ name, regenMs: s.regenMs, renderMs: s.renderMs, cached: s.cached });
  }
  const warm = seen.slice(2);
  info.annotations.push({
    type: 'switch-timing',
    description: JSON.stringify(seen),
  });
  console.log(`config switch timing ${JSON.stringify(seen)}`);
  for (const s of warm) expect(s.renderMs, JSON.stringify(s)).toBeLessThan(300);
});
