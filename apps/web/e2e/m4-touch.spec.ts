import AxeBuilder from '@axe-core/playwright';
import { devices, expect, type Page, test } from '@playwright/test';
import type { Drawing } from '@wren-cad/contracts';
import { app, touch } from './helpers';
import { fixtureDrawing } from './support/drawing-fixture';
import {
  built,
  cornerEdges,
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
    // Every view is projected by the real kernel (draft first, exact when idle).
    expect(s2.projectionProblems).toEqual([]);
    expect(s2.views.every((v) => v.curves > 0)).toBe(true);
    await drawing(page).exact();
    expect((await drawing(page).state()).quality).toBe('exact');
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

  test('the P1 tools work with fingers: angle, part properties table, print, half section, keypad fields', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { __prints: number }).__prints = 0;
      window.print = () => {
        (window as unknown as { __prints: number }).__prints += 1;
      };
    });
    await openDemo(page);
    await newDrawing(page);
    const t = await touch(page);
    await page.getByTestId('drawing-panel-toggle').tap();
    await panelTab(page, 'Views').tap();
    await page.getByTestId('add-standard-views').tap();
    await expect.poll(async () => (await drawing(page).state()).views.length).toBe(3);
    const s = await built(page);
    await page.getByTestId('drawing-panel-toggle').tap();

    const front = viewOf(s, 'base');
    if (!front) throw new Error('no front view');
    // A half section: draw the cut with a finger, then bend it with a tap.
    const [minX, minY] = front.outline?.min ?? [0, 0];
    const [maxX, maxY] = front.outline?.max ?? [0, 0];
    await page.locator('[data-tool="section"]').tap();
    const y = (minY + maxY) / 2;
    await t.drag(await sheetToPage(page, [minX + 1, y]), await sheetToPage(page, [maxX - 1, y]));
    await expect
      .poll(async () => (await drawing(page).state()).views.some((v) => v.kind === 'section'))
      .toBe(true);
    await built(page);
    await page.getByTestId('drawing-panel-toggle').tap();
    await page.getByTestId('cut-half').tap();
    await expect
      .poll(async () => {
        const v = ((await drawings(page))[0] as Drawing).views.find((x) => x.kind === 'section');
        return v && 'cut' in v ? v.cut.length : 0;
      })
      .toBe(3);
    await a11y(page);
    await page.getByTestId('drawing-panel-toggle').tap();

    // Angle: two taps on edges that meet at a corner of the front view.
    const [horiz, vert] = await cornerEdges(page, front.id);
    const tool = page.locator('[data-tool="angle"]');
    expect((await tool.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
    await tool.tap();
    await expect(page.getByTestId('prompt-chip')).toContainText('first');
    await t.tap([await sheetToPage(page, horiz.at)]);
    await expect(page.getByTestId('prompt-chip')).toContainText('second edge');
    await t.tap([await sheetToPage(page, vert.at)]);
    await expect
      .poll(async () => ((await app(page).doc()).parts[0]?.annotations ?? []).map((a) => a.kind))
      .toEqual(['angle']);
    // The arc radius is a keypad field on touch: AC, 1, 8, Enter.
    await page.getByTestId('drawing-panel-toggle').tap();
    await panelTab(page, 'Inspector').tap();
    await page.getByRole('textbox', { name: 'Arc radius (mm)' }).tap();
    const keypad = page.getByTestId('keypad');
    await expect(keypad).toBeVisible();
    await keypad.getByRole('button', { name: 'AC (clear)' }).tap();
    await keypad.getByRole('button', { name: '1', exact: true }).tap();
    await keypad.getByRole('button', { name: '8', exact: true }).tap();
    await keypad.getByRole('button', { name: 'Enter' }).tap();
    await expect
      .poll(async () => {
        const p = ((await drawings(page))[0] as Drawing).placements[0];
        return p?.layout.kind === 'arc' ? p.layout.radius : null;
      })
      .toBe(18);
    await a11y(page);
    await page.getByTestId('drawing-panel-toggle').tap();

    // The part properties table is one tap on the rail.
    await page.locator('[data-tool="table"]').tap();
    await expect.poll(async () => ((await drawings(page))[0] as Drawing).tables.length).toBe(1);
    await built(page);
    expect((await drawing(page).state()).texts).toContain('PART NO.');
    await page.getByTestId('drawing-panel-toggle').tap();
    await expect(page.getByTestId('table-inspector')).toBeVisible();
    await page.getByRole('switch', { name: 'Configuration' }).tap();
    await expect
      .poll(
        async () =>
          (((await drawings(page))[0] as Drawing).tables[0] as { columns: string[] }).columns,
      )
      .toContain('configuration');
    await a11y(page);

    // Print is a button in the Export panel.
    await panelTab(page, 'Export').tap();
    await page.locator('[data-export="print"]').tap();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints))
      .toBe(1);
    await expect(page.locator('#wren-print svg')).toHaveAttribute('width', '420mm');
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.getByTestId('drawing-panel-toggle').tap();
  });

  test('ordinate and chamfer tools work with fingers', async ({ page }) => {
    await openDemo(page);
    await newDrawing(page);
    const t = await touch(page);
    await page.getByTestId('drawing-panel-toggle').tap();
    await panelTab(page, 'Views').tap();
    await page.getByTestId('add-standard-views').tap();
    await expect.poll(async () => (await drawing(page).state()).views.length).toBe(3);
    const s = await built(page);
    await page.getByTestId('drawing-panel-toggle').tap();
    const annotationKinds = async () =>
      ((await app(page).doc()).parts[0]?.annotations ?? []).map((a) => a.kind);

    // Ordinate: the origin and a feature, by tapping vertical edges at three places of one view.
    for (const v of s.views) {
      const verticals = (await drawing(page).edges(v.id))
        .filter((e) => e.kind === 'line' && e.a && e.b && Math.abs(e.a[0] - e.b[0]) < 0.01)
        .sort((p, q) => p.at[0] - q.at[0]);
      const origin = verticals[0];
      const feature = verticals.at(-1);
      if (!origin || !feature || feature.at[0] - origin.at[0] < 20) continue;
      await page.locator('[data-tool="ordinate"]').tap();
      await t.tap([await sheetToPage(page, origin.at)]);
      await expect(page.getByTestId('prompt-chip')).toContainText('feature');
      await t.tap([await sheetToPage(page, feature.at)]);
      await expect.poll(annotationKinds).toEqual(['ordinate']);
      break;
    }
    await page.locator('[data-tool="ordinate"]').tap(); // off again
    await expect.poll(async () => (await drawing(page).state()).tool).toBe('select');

    // Chamfer: tap an edge of the chamfer's face.
    for (const v of s.views) {
      const edge = (await drawing(page).edges(v.id)).find(
        (e) => e.kind === 'line' && /:chamfer\(/.test(e.name),
      );
      if (!edge) continue;
      await page.locator('[data-tool="chamfer"]').tap();
      await t.tap([await sheetToPage(page, edge.at)]);
      await expect.poll(annotationKinds).toEqual(['ordinate', 'chamfer']);
      break;
    }
    await page.getByTestId('drawing-panel-toggle').tap();
    await a11y(page);
  });

  test('sheet tabs with fingers: add, switch, rename, reorder, move a view, delete; undo each (ADR-094)', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await page.getByTestId('drawing-panel-toggle').tap();
    await panelTab(page, 'Views').tap();
    await page.getByTestId('add-standard-views').tap();
    await expect.poll(async () => (await drawing(page).state()).views.length).toBe(3);
    await built(page);
    await page.getByTestId('drawing-panel-toggle').tap();
    const tabs = page.getByTestId('sheet-tabs');
    const tab = (n: number) =>
      tabs.getByRole('button', { name: new RegExp(`^${n} .*, sheet ${n} of \\d+$`) });
    const sheets = async () => ((await drawings(page))[0] as Drawing).sheets;
    const undo = () => page.getByTestId('drawing-undo').tap();
    // 44 px targets along the sheet's edge.
    const tb = await tab(1).boundingBox();
    expect(tb?.height ?? 0).toBeGreaterThanOrEqual(44);
    const add = tabs.getByTestId('sheet-add');
    expect((await add.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    await add.tap();
    await expect.poll(async () => (await sheets()).length).toBe(2);
    await expect(tab(2)).toHaveAttribute('aria-current', 'page');
    await undo();
    await expect.poll(async () => (await sheets()).length).toBe(1);
    await add.tap();
    await expect.poll(async () => (await sheets()).length).toBe(2);
    const [s1, s2] = (await sheets()).map((s) => s.id) as [string, string];
    await tab(1).tap();
    await expect.poll(async () => (await drawing(page).state()).sheetId).toBe(s1);

    // Rename on the tab, with the on-screen keyboard's Enter.
    await tab(2).tap();
    await tabs.getByTestId('sheet-rename-start').tap();
    const name = tabs.getByRole('textbox', { name: 'Name of sheet 2' });
    await name.fill('Sections');
    await name.press('Enter');
    await expect.poll(async () => (await sheets())[1]?.name).toBe('Sections');
    await undo();
    await expect.poll(async () => (await sheets())[1]?.name).not.toBe('Sections');
    // Reorder with the move buttons (the alternative to dragging a tab).
    await tabs.getByTestId('sheet-move-left').tap();
    await expect.poll(async () => (await sheets()).map((s) => s.id)).toEqual([s2, s1]);
    await undo();
    await expect.poll(async () => (await sheets()).map((s) => s.id)).toEqual([s1, s2]);

    // Move the front view (and its aligned views) to sheet 2 from the inspector. Selected from
    // the Views list (the tap-on-the-sheet selection is covered by the first tablet test).
    await tab(1).tap();
    const s = await built(page);
    const front = viewOf(s, 'base');
    if (!front) throw new Error('no front view');
    await page.getByTestId('drawing-panel-toggle').tap();
    await panelTab(page, 'Views').tap();
    await page.locator(`[data-view-row="${front.id}"]`).tap();
    await expect.poll(async () => (await drawing(page).state()).selected?.kind).toBe('view');
    await panelTab(page, 'Inspector').tap();
    await page.getByRole('combobox', { name: 'On sheet' }).selectOption(s2);
    await expect
      .poll(
        async () =>
          ((await drawings(page))[0] as Drawing).views.filter((v) => v.sheetId === s2).length,
      )
      .toBe(3);
    await undo();
    await expect
      .poll(
        async () =>
          ((await drawings(page))[0] as Drawing).views.filter((v) => v.sheetId === s1).length,
      )
      .toBe(3);

    // Delete with the inline confirmation.
    await tab(2).tap();
    await tabs.getByTestId('sheet-delete').tap();
    await a11y(page);
    await tabs.getByTestId('sheet-delete-confirm').tap();
    await expect.poll(async () => (await sheets()).length).toBe(1);
    await undo();
    await expect.poll(async () => (await sheets()).length).toBe(2);
    await a11y(page);
  });

  test('datums and frames with fingers: on a surface and on a feature of size; undo each (ADR-094)', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await page.getByTestId('drawing-panel-toggle').tap();
    await panelTab(page, 'Views').tap();
    await page.getByTestId('add-standard-views').tap();
    await expect.poll(async () => (await drawing(page).state()).views.length).toBe(3);
    await page.getByTestId('drawing-panel-toggle').tap();
    await drawing(page).exact();
    const s = await built(page);
    const top = viewOf(s, 'projected', 'top');
    if (!top) throw new Error('no top view');
    const edges = await drawing(page).edges(top.id);
    const side = edges
      .filter(
        (e) =>
          e.kind === 'line' &&
          e.a &&
          e.b &&
          Math.abs(e.a[0] - e.b[0]) < 0.01 &&
          Math.abs(e.a[1] - e.b[1]) > 30,
      )
      .sort((p, q) => p.at[0] - q.at[0])[0];
    const hole = edges
      .filter(
        (e) =>
          e.kind === 'arc' &&
          e.start !== undefined &&
          e.end !== undefined &&
          Math.abs(e.end - e.start - 2 * Math.PI) < 1e-6,
      )
      .sort((p, q) => (p.radius ?? 0) - (q.radius ?? 0))[0];
    if (!side || !hole) throw new Error('no geometry');
    const t = await touch(page);
    const tapAt = async (p: [number, number]) => t.tap([await sheetToPage(page, p)]);
    const of = async (kind: string) =>
      ((await app(page).doc()).parts[0]?.annotations ?? []).filter((a) => a.kind === kind);
    const undo = () => page.getByTestId('drawing-undo').tap();

    // On a surface: the datum refs the face of the line tapped; the frame too.
    await page.locator('[data-tool="datum"]').tap();
    await tapAt(side.at);
    await expect.poll(async () => (await of('datumFeature')).length).toBe(1);
    expect((await of('datumFeature'))[0]?.refs[0]?.kind).toBe('face');
    await undo();
    await expect.poll(async () => (await of('datumFeature')).length).toBe(0);
    await page.getByTestId('drawing-redo').tap();
    await expect.poll(async () => (await of('datumFeature')).length).toBe(1);
    // A finger slides the triangle past the line's end onto its extension: a preview, then one
    // edit on release (ADR-094).
    await page.locator('[data-tool="select"]').tap();
    await drawing(page).exact();
    await built(page);
    const sd = (await of('datumFeature'))[0];
    const sp = (await drawing(page).placements()).find((p) => p.annotationId === sd?.id);
    if (!sp?.text || !sp.leader?.on) throw new Error('no datum placement');
    await tapAt(sp.text);
    await expect
      .poll(async () => (await drawing(page).state()).selected)
      .toMatchObject({
        kind: 'placement',
        id: sp.id,
      });
    const [q0, q1] = sp.leader.on;
    const h0 = (await app(page).history()).past.length;
    const fromP = await sheetToPage(page, sp.leader.at);
    const toP = await sheetToPage(page, [
      q0[0] + (q1[0] - q0[0]) * 1.2 + 2,
      q0[1] + (q1[1] - q0[1]) * 1.2,
    ]);
    await t.drag(fromP, toP);
    await expect
      .poll(async () => {
        const pl = ((await drawings(page))[0] as Drawing).placements.find((x) => x.id === sp.id);
        return pl?.layout.kind === 'leader' && pl.layout.attach.kind === 'ref'
          ? (pl.layout.attach.t ?? 0.5)
          : null;
      })
      .toBeGreaterThan(1.05);
    expect((await app(page).history()).past.length).toBe(h0 + 1);
    await undo();
    await page.locator('[data-tool="gdt"]').tap();
    await tapAt(side.at);
    await expect.poll(async () => (await of('geometricTolerance')).length).toBe(1);
    await undo();
    await expect.poll(async () => (await of('geometricTolerance')).length).toBe(0);

    // On a feature of size: a diameter first, then the datum and the frame on it. A finger's pick
    // is wider: tap the circle where only it is within reach.
    const c0 = await sheetToPage(page, [0, 0]);
    const c10 = await sheetToPage(page, [10, 0]);
    const reach = (14 * 10) / Math.abs(c10.x - c0.x);
    let onCircle: [number, number] | null = null;
    const r = hole.radius ?? 0;
    const centre: [number, number] = [
      hole.at[0] - r * Math.cos(((hole.start ?? 0) + (hole.end ?? 0)) / 2),
      hole.at[1] - r * Math.sin(((hole.start ?? 0) + (hole.end ?? 0)) / 2),
    ];
    for (let k = 0; k < 16 && !onCircle; k++) {
      const a = (k * Math.PI) / 8;
      const p: [number, number] = [centre[0] + r * Math.cos(a), centre[1] + r * Math.sin(a)];
      const h = (await drawing(page).hit(p, reach)) as { pick: { name: string } | null };
      // Not under the prompt chip or a toast floating over the sheet.
      const q = await sheetToPage(page, p);
      const free = await page.evaluate(
        ([x, y]) =>
          !!document
            .elementFromPoint(x as number, y as number)
            ?.closest('[data-testid="sheet-svg"]'),
        [q.x, q.y] as const,
      );
      if (h.pick?.name === hole.name && free) onCircle = p;
    }
    if (!onCircle) throw new Error('no clear spot on the circle');
    // The undo above rebuilt the draft (polylines): circles are picked on the exact edges.
    await built(page);
    await drawing(page).exact();
    await page.locator('[data-tool="dimension"]').tap();
    // The tool waits after a circle (M4.1): the same circle tapped again is its diameter.
    await tapAt(onCircle);
    await expect(page.getByTestId('prompt-chip')).toContainText('same circle again');
    await tapAt(onCircle);
    await expect.poll(async () => (await of('diameter')).length).toBe(1);
    await built(page);
    const dia = (await of('diameter'))[0];
    const dp = (await drawing(page).placements()).find((p) => p.annotationId === dia?.id);
    if (!dp?.text) throw new Error('no diameter text');
    await page.locator('[data-tool="datum"]').tap();
    await tapAt(dp.text);
    await expect.poll(async () => (await of('datumFeature')).length).toBe(2);
    const fos = (await of('datumFeature')).find(
      (a) => a.kind === 'datumFeature' && a.appliesTo === dia?.id,
    );
    expect(fos).toBeTruthy();
    await built(page);
    const fp = (await drawing(page).placements()).find((p) => p.annotationId === fos?.id);
    expect(fp?.layout.attach?.kind).toBe('dimensionLine');
    await undo();
    await expect.poll(async () => (await of('datumFeature')).length).toBe(1);
    await page.locator('[data-tool="gdt"]').tap();
    await tapAt(dp.text);
    await expect.poll(async () => (await of('geometricTolerance')).length).toBe(1);
    const frame = (await of('geometricTolerance'))[0] as { appliesTo?: string };
    expect(frame.appliesTo).toBe(dia?.id);
    await undo();
    await expect.poll(async () => (await of('geometricTolerance')).length).toBe(0);
    await a11y(page);
  });

  test('M4.1 with fingers: two holes tapped are a centre distance; centre lines show while measuring; a diameter’s form', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await page.getByTestId('drawing-panel-toggle').tap();
    await panelTab(page, 'Views').tap();
    await page.getByTestId('add-standard-views').tap();
    await expect.poll(async () => (await drawing(page).state()).views.length).toBe(3);
    await page.getByTestId('drawing-panel-toggle').tap();
    await drawing(page).exact();
    const s = await built(page);
    const top = viewOf(s, 'projected', 'top');
    if (!top) throw new Error('no top view');
    const holes = (await drawing(page).edges(top.id))
      .filter(
        (e) =>
          e.kind === 'arc' &&
          e.radius !== undefined &&
          e.radius < 4 &&
          e.start !== undefined &&
          e.end !== undefined &&
          Math.abs(e.end - e.start - 2 * Math.PI) < 1e-6,
      )
      .sort((p, q) => p.at[1] - q.at[1] || p.at[0] - q.at[0]);
    const [a, b] = holes;
    if (!a || !b) throw new Error('no holes');
    const t = await touch(page);
    const tapAt = async (p: [number, number]) => t.tap([await sheetToPage(page, p)]);
    const anns = async () => (await app(page).doc()).parts[0]?.annotations ?? [];

    await page.locator('[data-tool="dimension"]').tap();
    // The measuring tools show the construction candidates over the sheet.
    await expect(page.getByTestId('construction-candidates')).toHaveCount(1);
    await tapAt(a.at);
    await expect(page.getByTestId('prompt-chip')).toContainText('same circle again');
    await tapAt(b.at);
    await expect.poll(async () => (await anns()).length).toBe(1);
    expect((await anns())[0]).toMatchObject({ kind: 'linear', at: ['center', 'center'] });

    // The same hole tapped twice: its diameter; the inspector turns it into linear across.
    await built(page);
    await drawing(page).exact();
    await tapAt(a.at);
    await tapAt(a.at);
    await expect.poll(async () => (await anns()).length).toBe(2);
    const dia = (await anns())[1];
    expect(dia?.kind).toBe('diameter');
    await built(page);
    await page.getByTestId('drawing-panel-toggle').tap();
    const across = page
      .getByRole('radiogroup', { name: 'Dimension form' })
      .getByRole('radio', { name: 'Linear across, horizontal' });
    const box = await across.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await across.tap();
    await expect
      .poll(async () => (await anns()).find((x) => x.id === dia?.id)?.kind)
      .toBe('linear');
    await a11y(page);
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
    // The real drawing kernel's exact edges, with their model names: a phone shows what an export
    // contains. The Ø6 holes are whole circles of radius 3 in the view that looks down them.
    await expect(page.getByTestId('placeholder-badge')).toHaveCount(0);
    await drawing(page).exact();
    expect((await drawing(page).state()).projectionProblems).toEqual([]);
    const projections = await Promise.all(s.views.map((v) => drawing(page).projection(v.id)));
    expect(projections.every((p) => p?.quality === 'exact')).toBe(true);
    const circles = projections
      .flatMap((p) => p?.curves ?? [])
      .filter(
        (k) =>
          k.role === 'visible' &&
          k.kind === 'arc' &&
          Math.abs((k.sweep ?? 0) - 2 * Math.PI) < 1e-6 &&
          Math.abs((k.radius ?? 0) - 3) < 1e-6,
      );
    expect(circles.length).toBeGreaterThanOrEqual(4);
    expect(circles.every((k) => (k.name ?? '').length > 0)).toBe(true);
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

  test('sheet tabs on the phone switch sheets only (review); Ctrl+PageDown too (ADR-094)', async ({
    page,
  }) => {
    await openDemo(page);
    const a = app(page);
    await page.evaluate(() =>
      (
        window as unknown as { __wrenApp: { drawingSupport(): Promise<void> } }
      ).__wrenApp.drawingSupport(),
    );
    const partId = (await a.doc()).parts[0]?.id as string;
    const d = fixtureDrawing(partId);
    const second = {
      ...(d.sheets[0] as Drawing['sheets'][number]),
      id: 'S2PHONE',
      name: 'Details',
    };
    expect(
      await a.apply({ kind: 'addDrawing', drawing: { ...d, sheets: [...d.sheets, second] } }),
    ).toBe(true);
    await page
      .getByRole('group', { name: 'Viewer tools' })
      .getByRole('button', { name: 'Parts' })
      .tap();
    await page.getByTestId('drawings-section').getByTestId('drawing-open').tap();
    await expect(page.getByTestId('sheet-viewer')).toBeVisible();
    await built(page);
    const tabs = page.getByTestId('sheet-tabs');
    await expect(tabs).toBeVisible();
    await expect(tabs.getByTestId('sheet-tab')).toHaveCount(2);
    // Review only: no add, rename, reorder or delete.
    await expect(tabs.getByTestId('sheet-add')).toHaveCount(0);
    await expect(tabs.getByTestId('sheet-actions')).toHaveCount(0);
    const tab2 = tabs.getByRole('button', { name: /^2 Details, sheet 2 of 2$/ });
    expect((await tab2.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await tab2.tap();
    await expect.poll(async () => (await drawing(page).state()).sheetId).toBe('S2PHONE');
    expect((await built(page)).texts).toContain('2 / 2');
    await page.keyboard.press('Control+PageUp');
    await expect.poll(async () => (await drawing(page).state()).sheetId).not.toBe('S2PHONE');
    await a11y(page);
    // Nothing was edited.
    expect((await drawings(page))[0]?.sheets.map((s) => s.name)).toEqual([
      d.sheets[0]?.name,
      'Details',
    ]);
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

// ------------------------------------------------------------------------------------------------
// Drawing usability (ADR-094) with fingers: dimension text and detail circle handles are 44 px
// targets, and dragging them is a preview with one commit.
// ------------------------------------------------------------------------------------------------

test.describe('tablet drags (ADR-094)', () => {
  test.use({
    viewport: { width: 1180, height: 820 },
    userAgent: devices['iPad Pro 11'].userAgent,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  test.slow();

  const historyLen = async (page: Page) => (await app(page).history()).past.length;
  const unit = (a: [number, number], b: [number, number]): [number, number] => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };

  async function viewsOnTablet(page: Page) {
    await openDemo(page);
    await newDrawing(page, { projection: 'First angle' });
    await page.getByTestId('drawing-panel-toggle').tap();
    await panelTab(page, 'Views').tap();
    await page.getByTestId('add-standard-views').tap();
    await expect.poll(async () => (await drawing(page).state()).views.length).toBe(3);
    return built(page);
  }

  test('a dimension text is dragged with a finger: along its line and across it, one step', async ({
    page,
  }) => {
    await viewsOnTablet(page);
    await panelTab(page, 'Import').tap();
    await page.getByTestId('import-open').tap();
    await page.getByRole('button', { name: 'Check all' }).tap();
    await page.getByTestId('import-place').tap();
    await expect(page.getByTestId('drawing-toast')).toContainText('Placed');
    await built(page);
    await page.getByTestId('drawing-panel-toggle').tap();
    const pl = (await drawing(page).placements()).find(
      (p) => p.layout.kind === 'lane' && p.line && p.box,
    );
    if (!pl?.line || !pl.box) throw new Error('no linear dimension');
    const t = await touch(page);
    const centre: [number, number] = [
      (pl.box.min[0] + pl.box.max[0]) / 2,
      (pl.box.min[1] + pl.box.max[1]) / 2,
    ];
    const u = unit(pl.line[0], pl.line[1]);
    const a = await sheetToPage(page, [0, 0]);
    const b = await sheetToPage(page, [10, 0]);
    const k = (b.x - a.x) / 10;
    const from = await sheetToPage(page, centre);
    // A tap selects the dimension, and its text gets a grab outline.
    await t.tap([from]);
    await expect.poll(async () => (await drawing(page).state()).selected?.id).toBe(pl.id);
    await expect(page.getByTestId('text-grab')).toBeVisible();
    const before = await historyLen(page);
    // Drag 12 mm along the line, and 8 mm across it, with one finger.
    const to = {
      x: from.x + u[0] * 12 * k + -u[1] * -8 * k,
      y: from.y - u[1] * 12 * k - u[0] * -8 * k,
    };
    await t.down([from]);
    for (let i = 1; i <= 10; i++)
      await t.move([
        { x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 },
      ]);
    await expect(page.getByTestId('text-side-hint')).toBeVisible();
    expect(await historyLen(page)).toBe(before);
    await t.up();
    await expect.poll(() => historyLen(page)).toBe(before + 1);
    const stored = ((await drawings(page))[0] as Drawing).placements.find((p) => p.id === pl.id);
    expect(Math.abs(stored?.text?.shift ?? 0)).toBeGreaterThan(5);
    expect(['above', 'below', 'inline']).toContain(stored?.text?.side);
    await a11y(page);
  });

  test('the detail circle has 44 px handles; a finger resizes it live and commits once', async ({
    page,
  }) => {
    const s = await viewsOnTablet(page);
    await page.getByTestId('drawing-panel-toggle').tap();
    const tv = viewOf(s, 'projected', 'top');
    if (!tv?.outline) throw new Error('no top view');
    const t = await touch(page);
    await page.locator('[data-tool="detail"]').tap();
    const cx = tv.outline.min[0] + 14;
    const cy = (tv.outline.min[1] + tv.outline.max[1]) / 2;
    await t.drag(await sheetToPage(page, [cx, cy]), await sheetToPage(page, [cx + 8, cy]));
    await expect
      .poll(async () => (await drawing(page).state()).views.some((v) => v.kind === 'detail'))
      .toBe(true);
    const s2 = await built(page);
    const detail = viewOf(s2, 'detail');
    if (!detail) throw new Error('no detail');
    await page.getByTestId('drawing-panel-toggle').tap();
    await panelTab(page, 'Views').tap();
    await page.locator(`[data-view-row="${detail.id}"]`).tap();
    await expect.poll(async () => (await drawing(page).state()).selected?.id).toBe(detail.id);
    await page.getByTestId('drawing-panel-toggle').tap();
    const radius = page.locator('[data-testid="detail-handle"][data-kind="radius"] circle').first();
    const hb = await radius.boundingBox();
    if (!hb) throw new Error('no handle');
    expect(hb.width).toBeGreaterThanOrEqual(44);
    const r0 =
      (await drawing(page).state()).views.find((v) => v.id === detail.id)?.clip?.radius ?? 0;
    const from = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
    const before = await historyLen(page);
    await t.down([from]);
    for (let i = 1; i <= 10; i++) await t.move([{ x: from.x + i * 4, y: from.y }]);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector('[data-transient="model"]')?.childElementCount ?? 0,
        ),
      )
      .toBeGreaterThan(0);
    expect(await historyLen(page)).toBe(before);
    await t.up();
    await expect.poll(() => historyLen(page)).toBe(before + 1);
    await built(page);
    const r1 =
      (await drawing(page).state()).views.find((v) => v.id === detail.id)?.clip?.radius ?? 0;
    expect(r1).toBeGreaterThan(r0 + 1);
    await a11y(page);
  });
});
