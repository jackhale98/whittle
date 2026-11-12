import { expect, type Page, test } from '@playwright/test';
import type { Annotation, WrenDoc } from '@wren-cad/contracts';
import { buildDoc, PARTS } from '@wren-cad/test-fixtures/reference-parts';
import { app, boot } from './helpers';
import {
  built,
  drag,
  drawing,
  type Edge,
  newDrawing,
  openDemo,
  panelTab,
  sheetToPage,
  viewOf,
} from './support/drawing-ui';

/**
 * M4.1 pick flows (ADR-095) on the demo bracket and two reference parts, desktop, against the real
 * drawing kernel: construction geometry while measuring, centre to centre, a circle's size in
 * linear form, hidden lines, a radius on a fillet's spline outline, and section cut edges. The
 * certification rows themselves are in m4-reference-drawings.spec.ts.
 */

test.use({ viewport: { width: 1440, height: 900 } });
test.slow();

const part = async (page: Page) => (await app(page).doc()).parts[0] as WrenDoc['parts'][number];
const annotations = async (page: Page): Promise<Annotation[]> =>
  (await part(page)).annotations ?? [];
const historyLen = async (page: Page) => (await app(page).history()).past.length;
const resolutionOf = async (page: Page, id: string) =>
  (await drawing(page).state()).resolutions.find((r) => r.id === id);

const click = async (page: Page, p: [number, number], modifier?: 'Shift' | 'Alt') => {
  const at = await sheetToPage(page, p);
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.click(at.x, at.y);
  if (modifier) await page.keyboard.up(modifier);
};

/** Zooms the sheet in around a sheet point (wheel), so a pick near geometry is unambiguous. */
const zoomAt = async (page: Page, p: [number, number]) => {
  const at = await sheetToPage(page, p);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -900);
};

async function bracketViews(page: Page) {
  await openDemo(page);
  await newDrawing(page);
  await panelTab(page, 'Views').click();
  await page.getByTestId('add-standard-views').click();
  await expect.poll(async () => (await drawing(page).state()).views.length).toBe(3);
  await built(page);
  // Circles are arcs in the exact edges (the draft has polylines).
  await drawing(page).exact();
  const s = await built(page);
  const top = viewOf(s, 'projected', 'top');
  const front = viewOf(s, 'base');
  if (!top || !front) throw new Error('no views');
  return { top, front };
}

/** The bracket's Ø6 holes in the top view (whole circles of the smallest radius), left to right. */
async function holes(page: Page, viewId: string) {
  const whole = (e: Edge) =>
    e.kind === 'arc' &&
    e.start !== undefined &&
    e.end !== undefined &&
    Math.abs(e.end - e.start - 2 * Math.PI) < 1e-6;
  const arcs = (await drawing(page).edges(viewId)).filter(whole);
  const r = Math.min(...arcs.map((e) => e.radius ?? 0));
  return arcs
    .filter((e) => Math.abs((e.radius ?? 0) - r) < 1e-6)
    .map((e) => {
      const m = ((e.start ?? 0) + (e.end ?? 0)) / 2;
      const c: [number, number] = [e.at[0] - r * Math.cos(m), e.at[1] - r * Math.sin(m)];
      return { edge: e, centre: c, r };
    })
    .sort((p, q) => p.centre[1] - q.centre[1] || p.centre[0] - q.centre[0]);
}

test.describe('circles: centre to centre, diameter, radius, linear across (M4.1)', () => {
  test('the tool waits after a circle; another circle is a centre distance', async ({ page }) => {
    const { top } = await bracketViews(page);
    const [a, b] = await holes(page, top.id);
    if (!a || !b) throw new Error('no holes');
    await page.locator('[data-tool="dimension"]').click();
    await click(page, a.edge.at);
    await expect(page.getByTestId('prompt-chip')).toContainText(
      'Pick a second edge or circle, or the same circle again for its diameter (Alt: radius)',
    );
    expect(await annotations(page)).toHaveLength(0);
    await click(page, b.edge.at);
    await expect.poll(async () => (await annotations(page)).length).toBe(1);
    const d = (await annotations(page))[0] as Extract<Annotation, { kind: 'linear' }>;
    expect(d.kind).toBe('linear');
    expect(d.at).toEqual(['center', 'center']);
    expect(d.refs.map((r) => r.name)).toEqual([a.edge.name, b.edge.name]);
    // Along the view's x: the holes are 40 apart.
    await expect.poll(async () => (await resolutionOf(page, d.id))?.value).toBeCloseTo(40, 6);
  });

  test('the same circle again is its diameter, Alt its radius, Shift its size in linear form', async ({
    page,
  }) => {
    const { top } = await bracketViews(page);
    const [a] = await holes(page, top.id);
    if (!a) throw new Error('no hole');
    await page.locator('[data-tool="dimension"]').click();
    const kinds = async () => (await annotations(page)).map((x) => x.kind);

    await click(page, a.edge.at);
    await click(page, a.edge.at);
    await expect.poll(kinds).toEqual(['diameter']);
    await built(page);
    await drawing(page).exact();
    await click(page, a.edge.at);
    await click(page, a.edge.at, 'Alt');
    await expect.poll(kinds).toEqual(['diameter', 'radius']);

    // Shift on the second pick, at the circle's side: across it along x, at its extremes.
    const side: [number, number] = [a.centre[0] + a.r, a.centre[1]];
    const before = await historyLen(page);
    await built(page);
    await drawing(page).exact();
    await click(page, a.edge.at);
    await click(page, side, 'Shift');
    await expect.poll(async () => (await kinds()).length).toBe(3);
    expect(await historyLen(page)).toBe(before + 1);
    const across = (await annotations(page))[2] as Extract<Annotation, { kind: 'linear' }>;
    expect(across).toMatchObject({ kind: 'linear', at: ['min', 'max'] });
    expect(across.direction?.map((v) => v + 0)).toEqual([1, 0, 0]);
    expect(across.refs[0]?.name).toBe(a.edge.name);
    expect(across.refs[1]?.name).toBe(a.edge.name);
    await expect.poll(async () => (await resolutionOf(page, across.id))?.value).toBeCloseTo(6, 6);
    // Its extension lines stand at the circle's extremes, 6 apart.
    await built(page);
    const pl = (await drawing(page).placements()).find((p) => p.annotationId === across.id);
    const line = pl?.line;
    if (!line) throw new Error('no dimension line');
    expect(Math.abs(line[1][0] - line[0][0])).toBeCloseTo(2 * a.r, 3);
    expect(Math.min(line[0][0], line[1][0])).toBeCloseTo(a.centre[0] - a.r, 3);
  });

  test('the inspector switches a diameter to linear across and back, one undo step each', async ({
    page,
  }) => {
    const { top } = await bracketViews(page);
    const [a] = await holes(page, top.id);
    if (!a) throw new Error('no hole');
    await page.locator('[data-tool="dimension"]').click();
    await click(page, a.edge.at);
    await click(page, a.edge.at);
    await expect.poll(async () => (await annotations(page)).length).toBe(1);
    const id = (await annotations(page))[0]?.id as string;
    await built(page);
    const form = page.getByRole('radiogroup', { name: 'Dimension form' });
    await expect(form.getByRole('radio', { name: 'Diameter' })).toBeChecked();
    const before = await historyLen(page);
    await form.getByRole('radio', { name: 'Linear across, vertical' }).click();
    await expect
      .poll(async () => (await annotations(page)).find((x) => x.id === id)?.kind)
      .toBe('linear');
    expect(await historyLen(page)).toBe(before + 1);
    const lin = (await annotations(page))[0] as Extract<Annotation, { kind: 'linear' }>;
    expect(lin).toMatchObject({ at: ['min', 'max'], direction: [0, 1, 0] });
    await expect.poll(async () => (await resolutionOf(page, id))?.value).toBeCloseTo(6, 6);
    const pl = (await drawing(page).placements()).find((p) => p.annotationId === id);
    expect(pl?.layout).toMatchObject({ kind: 'lane' });
    await page.getByTestId('drawing-undo').click();
    await expect
      .poll(async () => (await annotations(page)).find((x) => x.id === id)?.kind)
      .toBe('diameter');
    expect(
      (await drawing(page).placements()).find((p) => p.annotationId === id)?.layout,
    ).toMatchObject({ kind: 'radial' });
  });
});

test.describe('construction geometry while measuring (M4.1)', () => {
  test('centre lines show while the Dimension tool is on; a pick stores the exact name, and the sheet draws it', async ({
    page,
  }) => {
    const { top } = await bracketViews(page);
    // No candidates outside the measuring tools.
    await expect(page.getByTestId('construction-candidates')).toHaveCount(0);
    await page.locator('[data-tool="dimension"]').click();
    const cands = page.getByTestId('construction-candidates');
    await expect(cands).toHaveCount(1);
    // The origin's Y axis shows in the top and the side view.
    await expect(cands.locator('[data-construction="origin:Y"]')).toHaveCount(2);
    const y = (await drawing(page).edges(top.id, { construction: true })).find(
      (e) => e.construction === 'origin:Y',
    );
    if (!y?.a || !y.b || !top.outline) throw new Error('no origin:Y');
    // The axis runs past the part by 3 mm: pick it there, where no model edge is near.
    const past: [number, number] = [y.a[0], top.outline.max[1] + 2.2];
    await zoomAt(page, past);
    const h = (await drawing(page).hit(past, 0.5)).pick as { name: string; construction?: boolean };
    expect(h).toMatchObject({ name: 'origin:Y', construction: true });
    await click(page, past);
    await expect(page.getByTestId('prompt-chip')).toContainText('second edge');
    // The plate's right side, parallel to it: the plate's width from the origin.
    const right = (await drawing(page).edges(top.id))
      .filter((e) => e.kind === 'line' && e.a && e.b && Math.abs(e.a[0] - e.b[0]) < 0.01)
      .sort((p, q) => q.at[0] - p.at[0])[0];
    if (!right) throw new Error('no right side');
    await click(page, right.at);
    await expect.poll(async () => (await annotations(page)).length).toBe(1);
    const d = (await annotations(page))[0] as Extract<Annotation, { kind: 'linear' }>;
    expect(d.refs[0]).toEqual({ name: 'origin:Y', kind: 'edge' });
    expect(d.direction?.map((v) => v + 0)).toEqual([1, 0, 0]);
    await expect.poll(async () => (await resolutionOf(page, d.id))?.value).toBeCloseTo(80, 6);
    // Out of the tool the candidates go; the used ref stays, drawn by the sheet.
    await page.getByTestId('sheet-viewer').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('construction-candidates')).toHaveCount(0);
    await expect.poll(async () => (await drawing(page).state()).construction).toContain('origin:Y');
  });
});

test.describe('hidden lines are picked when the view draws them (M4.1)', () => {
  test('a hidden hole wall in the front view dimensions to the plate side', async ({ page }) => {
    const { front } = await bracketViews(page);
    await panelTab(page, 'Views').click();
    await page.locator(`[data-view-row="${front.id}"]`).click();
    await page
      .getByRole('radiogroup', { name: 'Lines shown' })
      .getByRole('radio', { name: 'With hidden' })
      .click();
    await drawing(page).exact();
    await built(page);
    const edges = await drawing(page).edges(front.id);
    const hidden = edges.filter((e) => e.role === 'hidden' && e.kind === 'line' && e.a && e.b);
    expect(hidden.length).toBeGreaterThan(0);
    // One a click picks as hidden (not under a visible line), vertical.
    let target: Edge | undefined;
    for (const e of hidden) {
      if (!e.a || !e.b || Math.abs(e.a[0] - e.b[0]) > 0.01) continue;
      const h = (await drawing(page).hit(e.at, 0.5)).pick as { name: string; role?: string } | null;
      if (h?.role === 'hidden' && h.name === e.name) {
        target = e;
        break;
      }
    }
    if (!target) throw new Error('no pickable hidden line');
    const left = edges
      .filter(
        (e) =>
          e.role === 'visible' &&
          e.kind === 'line' &&
          e.a &&
          e.b &&
          Math.abs(e.a[0] - e.b[0]) < 0.01,
      )
      .sort((p, q) => p.at[0] - q.at[0])[0];
    if (!left) throw new Error('no left side');
    await page.locator('[data-tool="dimension"]').click();
    await zoomAt(page, [(target.at[0] + left.at[0]) / 2, (target.at[1] + left.at[1]) / 2]);
    await click(page, target.at);
    await click(page, left.at);
    await expect.poll(async () => (await annotations(page)).length).toBe(1);
    const d = (await annotations(page))[0] as Annotation;
    expect(d.refs[0]?.name).toBe(target.name);
    await expect.poll(async () => (await resolutionOf(page, d.id))?.state).toBe('ok');
    expect((await resolutionOf(page, d.id))?.value).toBeCloseTo(
      Math.abs(target.at[0] - left.at[0]),
      3,
    );
  });
});

test.describe('a radius on a fillet’s spline outline (M4.1, rp02)', () => {
  test('one pick on the outline gives the fillet radius on its torus face', async ({ page }) => {
    await boot(page);
    const rp02 = PARTS.find((x) => x.id.startsWith('rp02'));
    if (!rp02) throw new Error('no rp02');
    await app(page).load(buildDoc(rp02));
    await app(page).idle();
    const s = await newDrawing(page);
    const front = viewOf(s, 'base');
    if (!front) throw new Error('no front view');
    await drawing(page).exact();
    await built(page);
    const spline = (await drawing(page).edges(front.id)).find(
      (e) => e.kind === 'spline' && (e.face ?? '').includes(':fillet('),
    );
    if (!spline?.face) throw new Error('no spline outline of the fillet');
    const h = (await drawing(page).hit(spline.at, 0.3)).pick as { shape: string; ref: string };
    expect(h).toMatchObject({ shape: 'other', ref: 'face' });
    await page.locator('[data-tool="dimension"]').click();
    await zoomAt(page, spline.at);
    await click(page, spline.at);
    await expect
      .poll(async () => (await annotations(page)).filter((a) => a.kind === 'radius').length)
      .toBe(1);
    const r = (await annotations(page)).find((a) => a.kind === 'radius') as Annotation;
    expect(r.refs).toEqual([expect.objectContaining({ name: spline.face, kind: 'face' })]);
    await expect.poll(async () => (await resolutionOf(page, r.id))?.value).toBeCloseTo(3, 6);
    const pl = (await drawing(page).placements()).find((p) => p.annotationId === r.id);
    expect(pl?.attention).toBe(false);
    expect(pl?.layout).toMatchObject({ kind: 'radial' });
  });
});

test.describe('section cut edges (M4.1, needs ProjectedCurve.cutFace)', () => {
  test('two cut lines of a hole wall are its diameter; the pick refs the model face', async ({
    page,
  }) => {
    const { top } = await bracketViews(page);
    const [a] = await holes(page, top.id);
    if (!a || !top.outline) throw new Error('no hole');
    // A section through the first row of holes, along the view's x.
    await page.locator('[data-tool="section"]').click();
    await drag(
      page,
      await sheetToPage(page, [top.outline.min[0] + 1, a.centre[1]]),
      await sheetToPage(page, [top.outline.max[0] - 1, a.centre[1]]),
    );
    await expect
      .poll(async () => (await drawing(page).state()).views.some((v) => v.kind === 'section'))
      .toBe(true);
    await drawing(page).exact();
    const s = await built(page);
    const section = viewOf(s, 'section');
    if (!section) throw new Error('no section');
    const proj = await drawing(page).projection(section.id);
    test.skip(
      !(proj?.curves ?? []).some((k) => k.cutFace),
      'The drawing kernel in packages/kernel/drawing/dist predates ProjectedCurve.cutFace (ADR-095, workstream A); rebuild it to run this.',
    );
    // The hole wall's two cut lines: one face, parallel, apart.
    const cuts = (await drawing(page).edges(section.id)).filter(
      (e) => e.cut && e.kind === 'line' && e.a && e.b && Math.abs(e.a[0] - e.b[0]) < 1e-3,
    );
    const byFace = new Map<string, Edge[]>();
    for (const e of cuts) byFace.set(e.cut as string, [...(byFace.get(e.cut as string) ?? []), e]);
    const wall = [...byFace.values()].find(
      (l) => l.length >= 2 && Math.abs((l[0] as Edge).at[0] - (l[1] as Edge).at[0]) > 1,
    );
    if (!wall) throw new Error('no hole wall cut on both sides');
    const [w0, w1] = wall as [Edge, Edge];
    const h = (await drawing(page).hit(w0.at, 0.3)).pick as {
      name: string;
      ref: string;
      cut?: boolean;
    };
    expect(h).toMatchObject({ name: w0.cut, ref: 'face', cut: true });
    await page.locator('[data-tool="dimension"]').click();
    await zoomAt(page, w0.at);
    await click(page, w0.at);
    await click(page, w1.at);
    await expect.poll(async () => (await annotations(page)).length).toBe(1);
    const d = (await annotations(page))[0] as Annotation;
    expect(d.kind).toBe('diameter');
    expect(d.refs).toEqual([expect.objectContaining({ name: w0.cut, kind: 'face' })]);
    await expect.poll(async () => (await resolutionOf(page, d.id))?.value).toBeCloseTo(6, 6);
  });

  test('a draft angle in the rp05 section: from the bottom’s normal, with Shift', async ({
    page,
  }) => {
    await boot(page);
    const rp05 = PARTS.find((x) => x.id.startsWith('rp05'));
    if (!rp05) throw new Error('no rp05');
    await app(page).load(buildDoc(rp05));
    await app(page).idle();
    const s0 = await newDrawing(page);
    const front = viewOf(s0, 'base');
    if (!front?.outline) throw new Error('no front view');
    const { min, max } = front.outline;
    const y = (min[1] + max[1]) / 2;
    await page.locator('[data-tool="section"]').click();
    // A vertical cut through the middle: the walls and the bottom are cut.
    const x = (min[0] + max[0]) / 2;
    await drag(
      page,
      await sheetToPage(page, [x, max[1] - 1]),
      await sheetToPage(page, [x, min[1] + 1]),
    );
    await expect
      .poll(async () => (await drawing(page).state()).views.some((v) => v.kind === 'section'))
      .toBe(true);
    await drawing(page).exact();
    const s = await built(page);
    const section = viewOf(s, 'section');
    if (!section) throw new Error(`no section (${y})`);
    const proj = await drawing(page).projection(section.id);
    test.skip(
      !(proj?.curves ?? []).some((k) => k.cutFace),
      'The drawing kernel in packages/kernel/drawing/dist predates ProjectedCurve.cutFace (ADR-095, workstream A); rebuild it to run this.',
    );
    const cuts = (await drawing(page).edges(section.id)).filter(
      (e) => e.cut && e.kind === 'line' && e.a && e.b,
    );
    const slope = (e: Edge) => {
      const [p, q] = [e.a as [number, number], e.b as [number, number]];
      return Math.abs(Math.atan2(q[0] - p[0], q[1] - p[1]));
    };
    // A wall a few degrees off vertical, and a horizontal bottom line meeting it.
    const walls = cuts.filter((e) => {
      const a = (slope(e) * 180) / Math.PI;
      return (a > 1 && a < 10) || (a > 170 && a < 179);
    });
    const meets = (w: Edge, f: Edge) =>
      [w.a, w.b].some((p) =>
        [f.a, f.b].some((q) => p && q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05),
      );
    let pair: [Edge, Edge] | undefined;
    for (const w of walls) {
      // The lowest horizontal cut line meeting the wall: the bottom (the neutral face), not the
      // rim at the top.
      const f = cuts
        .filter((e) => e !== w && e.a && e.b && Math.abs(e.a[1] - e.b[1]) < 1e-3 && meets(w, e))
        .sort((p, q) => p.at[1] - q.at[1])[0];
      if (f) {
        pair = [w, f];
        break;
      }
    }
    if (!pair) throw new Error('no drafted wall meeting a horizontal cut line');
    const [wall, floor] = pair;
    await page.locator('[data-tool="angle"]').click();
    // Zoomed in about the middle of the two lines, so both stay on screen.
    await zoomAt(page, [(wall.at[0] + floor.at[0]) / 2, (wall.at[1] + floor.at[1]) / 2]);
    await click(page, wall.at);
    await expect(page.getByTestId('prompt-chip')).toContainText('Shift');
    await click(page, floor.at, 'Shift');
    await expect
      .poll(async () => (await annotations(page)).filter((a) => a.kind === 'angle').length)
      .toBe(1);
    const g = (await annotations(page)).find((a) => a.kind === 'angle') as Annotation;
    expect(g.at).toEqual(['self', 'axis']);
    expect(g.refs.map((r) => r.kind)).toEqual(['face', 'face']);
    await expect
      .poll(async () => (((await resolutionOf(page, g.id))?.value ?? 0) * 180) / Math.PI)
      .toBeCloseTo(3, 4);
    // The inspector's switch says so, and turns it back into the angle between the faces.
    const sw = page.getByRole('switch', { name: 'From the normal of the second face' });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.click();
    await expect
      .poll(async () => (await annotations(page)).find((a) => a.id === g.id)?.at)
      .toEqual(['self', 'self']);
  });
});
