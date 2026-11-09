import { expect, type Page, test } from '@playwright/test';
import type { Id, SketchEntity, SketchFeature } from '@wren-cad/contracts';
import { addBox, app, boot, cameraStill, clickAt, sketchOn, toPage } from './helpers';

/**
 * M3 sketch editing through the real app (PLAN §12 M3, ADR-033…035; blocker B3): trim, extend,
 * sketch fillet / chamfer, mirror, convert entities, unlink and the lost-source Re-pick. Everything
 * is driven through the UI (Edit menu, viewport clicks, the panels' fields); the document is only
 * read. Each operation is checked for its resulting geometry and constraints and for being exactly
 * one undo step named after the operation (undo restores, redo reapplies).
 */

test.use({ viewport: { width: 1440, height: 900 } });

type P = [number, number];

const sketches = async (page: Page): Promise<SketchFeature[]> =>
  (await app(page).doc()).parts[0]?.features.filter(
    (f): f is SketchFeature => f.type === 'sketch',
  ) ?? [];

/** The last sketch of the part (the one being edited). */
async function sketchOf(page: Page): Promise<SketchFeature> {
  const f = (await sketches(page)).at(-1);
  if (!f) throw new Error('no sketch');
  return f;
}

const pos = (f: SketchFeature, id: Id): P => {
  const e = f.entities.find((x) => x.id === id);
  if (e?.kind !== 'point') throw new Error(`no point ${id}`);
  return [e.x, e.y];
};

interface Seg {
  id: Id;
  a: P;
  b: P;
  start: Id;
  end: Id;
  construction: boolean;
  linked: boolean;
}

const segs = (f: SketchFeature): Seg[] =>
  f.entities.flatMap((e) =>
    e.kind === 'line'
      ? [
          {
            id: e.id,
            a: pos(f, e.start),
            b: pos(f, e.end),
            start: e.start,
            end: e.end,
            construction: e.construction,
            linked: !!e.source,
          },
        ]
      : [],
  );

const near = (p: P, q: P, tol = 1e-3) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;
const lineBetween = (f: SketchFeature, p: P, q: P): Seg | undefined =>
  segs(f).find((s) => (near(s.a, p) && near(s.b, q)) || (near(s.a, q) && near(s.b, p)));

/** Page point of a sketch-plane point (the sketches here are on Top, z = 0). */
const at = (page: Page, [x, y]: P) => toPage(page, [x, y, 0]);

async function click(page: Page, p: P): Promise<void> {
  const s = await at(page, p);
  await page.mouse.move(s.x, s.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
}

/** Opens a blank sketch on Top and draws each chain (click, click, Esc) with the line tool. */
async function drawSketch(page: Page, lines: P[][], construction: P[][] = []): Promise<void> {
  await boot(page);
  await page.keyboard.press('s');
  await sketchOn(page, 'Top');
  const draw = async (chain: P[]) => {
    await page.keyboard.press('l');
    for (const p of chain) await clickAt(page, p[0], p[1]);
    await page.keyboard.press('Escape'); // ends the chain
    await app(page).settled();
  };
  for (const chain of lines) await draw(chain);
  if (construction.length) {
    await page.keyboard.press('x');
    for (const chain of construction) await draw(chain);
    await page.keyboard.press('x');
  }
  await page.keyboard.press('Escape');
  await app(page).settled();
}

/** Edit menu → item (the entry's label starts with `label`). */
async function editTool(page: Page, label: string): Promise<void> {
  const bar = page.getByRole('toolbar', { name: 'Sketch tools' });
  await bar.getByRole('button', { name: 'Edit' }).click();
  await page
    .locator('[role^="menuitem"]', { hasText: new RegExp(`^${label}`) })
    .first()
    .click();
  await expect.poll(async () => (await app(page).ui()).sketch?.edit?.tool).toBeTruthy();
}

async function leaveTool(page: Page): Promise<void> {
  for (let i = 0; i < 3 && (await app(page).ui()).sketch?.tool; i++)
    await page.keyboard.press('Escape');
  await app(page).settled();
}

const strip = (f: SketchFeature) => ({ entities: f.entities, constraints: f.constraints });

/**
 * Runs `operate` and checks it was one undo step labelled like `label`: undo restores the sketch
 * exactly as it was, redo gives the result back. Returns the sketch after the operation.
 */
async function oneStep(
  page: Page,
  label: RegExp,
  operate: () => Promise<void>,
): Promise<SketchFeature> {
  const a = app(page);
  await a.settled();
  const before = strip(await sketchOf(page));
  const steps = (await a.history()).past.length;
  await operate();
  await a.settled();
  await a.idle();
  const after = await sketchOf(page);
  const h = await a.history();
  expect(h.past.length, 'one undo step').toBe(steps + 1);
  expect(h.past.at(-1)?.label).toMatch(label);
  expect(strip(after)).not.toEqual(before);

  await leaveTool(page);
  await page.keyboard.press('ControlOrMeta+z');
  await a.settled();
  await a.idle();
  expect(strip(await sketchOf(page)), 'undo restores').toEqual(before);
  expect((await a.history()).past.length).toBe(steps);
  expect((await a.history()).future[0]?.label).toMatch(label);

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await a.settled();
  await a.idle();
  expect(strip(await sketchOf(page)), 'redo reapplies').toEqual(strip(after));
  expect((await a.history()).past.at(-1)?.label).toMatch(label);
  return sketchOf(page);
}

const constraintsOf = (f: SketchFeature, kind: string) =>
  f.constraints.filter((c) => c.kind === kind);
const entityCount = (f: SketchFeature, kind: SketchEntity['kind']) =>
  f.entities.filter((e) => e.kind === kind).length;

// Two crossing lines (no axis-aligned snaps): A (5,5)-(45,25) and B (5,25)-(45,5) cross at (25,15).
const A: P[] = [
  [5, 5],
  [45, 25],
];
const B: P[] = [
  [5, 25],
  [45, 5],
];

test('trim: one side of a crossing line is cut away at the intersection; one undo step', async ({
  page,
}) => {
  test.slow();
  await drawSketch(page, [A, B]);
  const before = await sketchOf(page);
  expect(lineBetween(before, A[0] as P, A[1] as P)).toBeTruthy();
  expect(lineBetween(before, B[0] as P, B[1] as P)).toBeTruthy();

  const after = await oneStep(page, /^Trim /, async () => {
    await editTool(page, 'Trim');
    await click(page, [10, 7.5]); // the near-start half of A
  });
  // A keeps only the part from the crossing to its far end; B is untouched.
  expect(lineBetween(after, [25, 15], A[1] as P)).toBeTruthy();
  expect(lineBetween(after, A[0] as P, A[1] as P)).toBeUndefined();
  expect(lineBetween(after, B[0] as P, B[1] as P)).toBeTruthy();
  expect(segs(after)).toHaveLength(2);
  // The cut end is attached to B, so it stays on it when B moves.
  const cut = lineBetween(after, [25, 15], A[1] as P);
  const bLine = lineBetween(after, B[0] as P, B[1] as P);
  const end = near(pos(after, cut?.start as Id), [25, 15]) ? cut?.start : cut?.end;
  expect(
    after.constraints.some((c) => c.kind === 'pointOn' && c.point === end && c.on === bLine?.id),
    'trimmed end is on B',
  ).toBe(true);
});

test('extend: a line grows to meet another; one undo step', async ({ page }) => {
  test.slow();
  // C is aimed at the longer L and stops short of it; both are off the axes.
  const C: P[] = [
    [5, 5],
    [20, 12],
  ];
  const L: P[] = [
    [40, 2],
    [44, 38],
  ];
  await drawSketch(page, [C, L]);
  const before = await sketchOf(page);
  const cBefore = lineBetween(before, C[0] as P, C[1] as P);
  const lBefore = lineBetween(before, L[0] as P, L[1] as P);
  expect(cBefore && lBefore).toBeTruthy();

  const after = await oneStep(page, /^Extend /, async () => {
    await editTool(page, 'Extend');
    await click(page, [17, 10.67]); // nearer the free end of C
  });
  const c = segs(after).find((s) => s.id === cBefore?.id);
  const l = segs(after).find((s) => s.id === lBefore?.id);
  if (!c || !l) throw new Error('lines lost');
  // The start is where it was; the end is now on L (x = 40 + 4 (y - 2) / 36) and on C's carrier.
  expect(near(c.a, [5, 5], 1e-3)).toBe(true);
  const [x1, y1] = c.b;
  expect(x1).toBeGreaterThan(20);
  expect(x1).toBeCloseTo(40 + (4 * (y1 - 2)) / 36, 3);
  expect((y1 - 5) / (x1 - 5)).toBeCloseTo(7 / 15, 4);
  expect(
    after.constraints.some((k) => k.kind === 'pointOn' && k.point === c.end && k.on === l.id),
    'extended end is on L',
  ).toBe(true);
  expect(
    constraintsOf(after, 'pointOn').length + constraintsOf(after, 'coincident').length,
  ).toBeGreaterThan(0);
  expect(entityCount(after, 'line')).toBe(2);
});

// A corner of two lines off the axes: arms (8,36)-(12,10) and (12,10)-(44,18).
const CORNER: P[] = [
  [8, 36],
  [12, 10],
  [44, 18],
];

const dist = (p: P, q: P) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** Sets the corner panel's value field to `expr` (committed on blur) and presses Apply. */
async function applyCorner(page: Page, field: string, expr: string): Promise<void> {
  const panel = page.getByTestId('corner-panel');
  const value = panel.getByRole('textbox', { name: field });
  await value.fill(expr);
  await value.press('Tab');
  await panel.getByRole('button', { name: /Apply/ }).click();
}

test('sketch fillet: radius typed with units makes a tangent arc; one undo step', async ({
  page,
}) => {
  test.slow();
  await drawSketch(page, [CORNER]);
  const before = await sketchOf(page);
  const corner = before.entities.find(
    (e) => e.kind === 'point' && Math.abs(e.x - 12) < 1e-3 && Math.abs(e.y - 10) < 1e-3,
  );
  if (!corner) throw new Error('no corner point');

  const after = await oneStep(page, /^Fillet .* \(R12 mm\)$/, async () => {
    await editTool(page, 'Sketch fillet');
    await click(page, [12, 10]);
    await expect.poll(async () => (await app(page).ui()).sketch?.edit?.picks).toBe(1);
    await applyCorner(page, 'Corner radius', '1 cm + 2 mm');
  });
  const arcs = after.entities.filter((e) => e.kind === 'arc');
  expect(arcs).toHaveLength(1);
  const arc = arcs[0];
  if (arc?.kind !== 'arc') throw new Error('no arc');
  // Radius 12 mm, tangent to both arms, and the arms stop at the arc's ends.
  expect(dist(pos(after, arc.center), pos(after, arc.start))).toBeCloseTo(12, 3);
  expect(dist(pos(after, arc.center), pos(after, arc.end))).toBeCloseTo(12, 3);
  const radius = after.constraints.find((c) => c.kind === 'radius' && c.curve === arc.id);
  expect(radius).toMatchObject({ driving: true, value: '1 cm + 2 mm' });
  expect(constraintsOf(after, 'tangent')).toHaveLength(2);
  const lines = segs(after);
  expect(lines).toHaveLength(2);
  for (const l of lines) {
    const ends = [l.start, l.end];
    expect(ends.some((e) => e === arc.start || e === arc.end)).toBe(true);
    expect(ends).not.toContain(corner.id);
  }
  // The far ends of the arms are where they were drawn.
  expect(lines.some((l) => near(l.a, [8, 36]) || near(l.b, [8, 36]))).toBe(true);
  expect(lines.some((l) => near(l.a, [44, 18]) || near(l.b, [44, 18]))).toBe(true);
});

test('sketch chamfer: distance typed with units cuts the corner; one undo step', async ({
  page,
}) => {
  test.slow();
  await drawSketch(page, [CORNER]);
  const before = await sketchOf(page);
  const after = await oneStep(page, /^Chamfer .* \(12\.7 mm\)$/, async () => {
    await editTool(page, 'Sketch chamfer');
    await click(page, [12, 10]);
    await expect.poll(async () => (await app(page).ui()).sketch?.edit?.picks).toBe(1);
    await applyCorner(page, 'Corner distance', '0.5 in');
  });
  const lines = segs(after);
  expect(lines).toHaveLength(3);
  expect(entityCount(after, 'arc')).toBe(0);
  // The new line joins the two arms 12.7 mm from the old corner along each.
  const c = lines.find((l) => !segs(before).some((b) => b.id === l.id));
  if (!c) throw new Error('no chamfer line');
  const alongA = Math.hypot(4, 26);
  const alongB = Math.hypot(32, 8);
  const onArm = (p: P) =>
    near(p, [12 - (4 / alongA) * 12.7, 10 + (26 / alongA) * 12.7]) ||
    near(p, [12 + (32 / alongB) * 12.7, 10 + (8 / alongB) * 12.7]);
  expect(onArm(c.a) && onArm(c.b)).toBe(true);
  const dims = constraintsOf(after, 'distance');
  expect(dims).toHaveLength(2);
  for (const d of dims) expect(d).toMatchObject({ driving: true, value: '0.5 in' });
  // The arms end on the chamfer, not at the corner.
  for (const l of lines.filter((x) => x.id !== c.id)) {
    expect([l.start, l.end].some((e) => e === c.start || e === c.end)).toBe(true);
  }
});

test('mirror: entities are copied across a construction line, kept symmetric', async ({ page }) => {
  test.slow();
  const L: P[] = [
    [10, 10],
    [30, 20],
  ];
  const M: P[] = [
    [50, 0],
    [60, 40],
  ];
  await drawSketch(page, [L], [M]);
  const before = await sketchOf(page);
  const axis = lineBetween(before, M[0] as P, M[1] as P);
  const src = lineBetween(before, L[0] as P, L[1] as P);
  if (!axis || !src) throw new Error('lines not drawn');
  expect(axis.construction).toBe(true);
  expect(src.construction).toBe(false);

  const after = await oneStep(page, /^Mirror .* about /, async () => {
    await editTool(page, 'Mirror');
    await click(page, [20, 15]);
    await expect.poll(async () => (await app(page).ui()).sketch?.edit?.picks).toBe(1);
    const panel = page.getByTestId('mirror-panel');
    await panel.getByRole('radio', { name: /Mirror line/ }).click();
    await click(page, [55, 20]);
    await expect(panel.getByRole('radio', { name: /Mirror line ✓/ })).toBeVisible();
    await panel.getByRole('button', { name: /Apply/ }).click();
  });
  const reflect = (p: P): P => {
    const u: P = [10 / Math.hypot(10, 40), 40 / Math.hypot(10, 40)];
    const d: P = [p[0] - 50, p[1]];
    const k = d[0] * u[0] + d[1] * u[1];
    return [50 + 2 * k * u[0] - d[0], 2 * k * u[1] - d[1]];
  };
  const copy = lineBetween(after, reflect(L[0] as P), reflect(L[1] as P));
  expect(copy, 'mirrored line').toBeTruthy();
  expect(copy?.construction).toBe(false);
  // The original and the mirror line are unchanged.
  expect(lineBetween(after, L[0] as P, L[1] as P)).toBeTruthy();
  expect(lineBetween(after, M[0] as P, M[1] as P)?.id).toBe(axis.id);
  // Both end-point pairs are symmetric about the construction line.
  const sym = constraintsOf(after, 'symmetric');
  expect(sym).toHaveLength(2);
  for (const c of sym) expect(c).toMatchObject({ about: axis.id });
  const pairs = new Set(sym.map((c) => (c.kind === 'symmetric' ? c.a : '')));
  expect(pairs).toEqual(new Set([src.start, src.end]));
});

/** A box in the model, then an empty sketch on Top over it. Returns the box's bounding box. */
async function boxThenSketch(page: Page) {
  await boot(page);
  await addBox(page);
  const bbox = (await app(page).regen())?.bodies[0]?.bbox;
  if (!bbox) throw new Error('no body');
  await page.keyboard.press('s');
  await sketchOn(page, 'Top');
  return bbox;
}

/**
 * A point on the box's top edge at y = max (the nearest edge to the camera from Top), at 85 % of
 * its length: the middle is under the floating tool panel.
 */
const topEdgeAt = (b: { min: number[]; max: number[] }): [number, number, number] => [
  (b.min[0] ?? 0) + 0.85 * ((b.max[0] ?? 0) - (b.min[0] ?? 0)),
  b.max[1] ?? 0,
  b.max[2] ?? 0,
];

/** Clicks the model edge at a world point (sketch mode shows the model behind the sketch). */
async function clickModel(page: Page, w: [number, number, number]): Promise<void> {
  await page.evaluate(() =>
    (
      window as unknown as { __wrenViewport: { whenPickReady(): Promise<void> } }
    ).__wrenViewport.whenPickReady(),
  );
  const s = await toPage(page, w);
  await page.mouse.move(s.x, s.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
}

async function convertEdge(page: Page, w: [number, number, number]): Promise<void> {
  await editTool(page, 'Convert entities');
  await clickModel(page, w);
  await expect.poll(async () => (await app(page).ui()).sketch?.edit?.model).toBe(1);
  await page.getByTestId('convert-panel').getByRole('button', { name: 'Convert' }).click();
}

test('convert entities from a model edge, then Unlink keeps the geometry in place', async ({
  page,
}) => {
  test.slow();
  const bbox = await boxThenSketch(page);
  const a = app(page);
  const w = topEdgeAt(bbox);
  const x0 = bbox.min[0] ?? 0;
  const x1 = bbox.max[0] ?? 0;
  const y = bbox.max[1] ?? 0;

  const converted = await oneStep(page, /^Convert 1 edge$/, () => convertEdge(page, w));
  const line = segs(converted).find((s) => s.linked);
  if (!line) throw new Error('no linked line');
  expect(segs(converted)).toHaveLength(1);
  expect(lineBetween(converted, [x0, y], [x1, y])?.id).toBe(line.id);
  const src = converted.entities.find((e) => e.id === line.id)?.source;
  expect(src?.ref.kind).toBe('edge');
  expect(src?.ref.name).toBeTruthy();
  // Nothing needs attention.
  expect((await a.regen())?.features.every((f) => f.state === 'ok')).toBe(true);
  await leaveTool(page);

  // Select the linked line: the panel names its source and offers Unlink.
  await click(page, [w[0], y]);
  const panel = page.getByTestId('linked-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Re-pick' })).toHaveCount(0);

  const unlinked = await oneStep(page, /^Unlink /, async () => {
    await panel.getByRole('button', { name: 'Unlink' }).click();
  });
  const free = segs(unlinked);
  expect(free).toHaveLength(1);
  expect(free[0]?.id).toBe(line.id);
  expect(free[0]?.linked).toBe(false);
  expect(unlinked.entities.every((e) => !e.source)).toBe(true);
  // It stays exactly where it was.
  expect(near(free[0]?.a as P, line.a, 1e-6) && near(free[0]?.b as P, line.b, 1e-6)).toBe(true);
  await a.idle();
  expect((await a.regen())?.features.every((f) => f.state === 'ok')).toBe(true);
  await expect(page.getByTestId('linked-panel')).toHaveCount(0);
});

test('lost source: needs attention with the ghost and Re-pick, never silently re-picked', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  const a = app(page);
  await addBox(page);
  const bbox = (await a.regen())?.bodies[0]?.bbox;
  if (!bbox) throw new Error('no body');
  const x0 = bbox.min[0] ?? 0;
  const x1 = bbox.max[0] ?? 0;
  const yMax = bbox.max[1] ?? 0;
  const zMax = bbox.max[2] ?? 0;
  const xs = x0 + 0.85 * (x1 - x0);

  // Fillet the box's top back edge (R5): its new boundary on the top face, y = yMax - 5, is the
  // edge the sketch will follow.
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('0'); // iso
  await cameraStill(page);
  await clickModel(page, [(x0 + x1) / 2, yMax, zMax]);
  await expect(page.getByTestId('selection-inspector')).toContainText('edge');
  await page.keyboard.press('f');
  const radius = page.getByTestId('feature-inspector').getByRole('textbox', { name: 'Radius' });
  await radius.fill('5 mm');
  await radius.press('Enter');
  await page.getByRole('button', { name: 'Done' }).click();
  await a.idle();
  expect((await a.regen())?.features.map((f) => f.state)).toEqual(['ok', 'ok']);

  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  await sketchOn(page, 'Top');
  const yEdge = yMax - 5;
  await convertEdge(page, [xs, yEdge, zMax]);
  await expect.poll(async () => segs(await sketchOf(page)).length).toBe(1);
  await a.idle();
  const linked = await sketchOf(page);
  const line = segs(linked)[0];
  if (!line?.linked) throw new Error('not linked');
  expect(lineBetween(linked, [x0, yEdge], [x1, yEdge])).toBeTruthy();
  const was = linked.entities.find((e) => e.id === line.id)?.source?.ref;
  expect(was?.name).toBeTruthy();
  await leaveTool(page);
  await page.getByTestId('finish-sketch').click();
  await a.idle();
  expect((await a.regen())?.features.map((f) => f.state)).toEqual(['ok', 'ok', 'ok']);

  // Upstream change: suppress the fillet. Its edge is gone; the box's own top edge (y = yMax) is
  // still there to tempt a silent re-pick.
  const tree = page.getByTestId('feature-tree');
  await tree.getByRole('treeitem', { name: /Fillet/ }).click();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Suppress' }).click();
  await a.idle();
  const r = await a.regen();
  const sk = r?.features.at(-1);
  expect(sk?.state).toBe('needsAttention');
  expect(sk?.unresolved?.[0]?.path).toMatch(/^\/entities\/\d+\/source\/ref$/);
  expect(sk?.unresolved?.[0]?.reason).toBe('missing');
  expect(sk?.rebound ?? []).toEqual([]);
  // The old location is ghosted in the viewport.
  expect((await a.attentionMarkers()).some((m) => m.startsWith(`attention:${sk?.id}:`))).toBe(true);
  const item = tree.getByRole('treeitem', { name: /Sketch 1/ });
  await expect(item).toContainText(/needs attention/i);
  // Nothing was re-picked behind our back: the same source, the geometry kept where it was.
  const lost = await sketchOf(page);
  expect(lost.entities.find((e) => e.id === line.id)?.source?.ref).toEqual(was);
  expect(lineBetween(lost, [x0, yEdge], [x1, yEdge])?.id).toBe(line.id);

  // Back into the sketch: the linked panel says it is lost and offers Re-pick (and Unlink).
  await item.click();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
  await cameraStill(page);
  await click(page, [xs, yEdge]);
  const panel = page.getByTestId('linked-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-state="lost"]')).toBeVisible();
  await expect(panel.getByRole('alert')).toContainText('Wren will not guess');
  await expect(panel.getByRole('button', { name: 'Unlink' })).toBeVisible();
  await page.screenshot({ path: 'test-results/m3-linked-lost.png' });

  // Re-pick: the next model edge click is the new source (the box's top back edge).
  const fixed = await oneStep(page, /^Re-pick /, async () => {
    await panel.getByRole('button', { name: 'Re-pick' }).click();
    await expect.poll(async () => (await app(page).ui()).sketch?.edit?.tool).toBe('convert');
    await clickModel(page, [xs, yMax, zMax]);
  });
  const now = fixed.entities.find((e) => e.id === line.id);
  expect(now?.source?.ref.name).toBeTruthy();
  expect(now?.source?.ref.name).not.toBe(was?.name);
  expect(lineBetween(fixed, [x0, yMax], [x1, yMax])?.id).toBe(line.id);
  await a.idle();
  const ok = await a.regen();
  expect(ok?.features.map((f) => f.state)).toEqual(['ok', 'suppressed', 'ok']);
  expect(ok?.features.at(-1)?.unresolved ?? []).toEqual([]);
  await expect(item).not.toContainText(/needs attention/i);
  expect(await a.attentionMarkers()).toEqual([]);
  await expect(page.getByTestId('linked-panel').locator('[data-state="lost"]')).toHaveCount(0);
});
