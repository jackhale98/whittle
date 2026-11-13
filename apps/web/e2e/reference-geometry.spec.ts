import AxeBuilder from '@axe-core/playwright';
import { devices, expect, type Page, test } from '@playwright/test';
import type { PlaneFeature, WrenDoc } from '@wren-cad/contracts';
import { addBox, app, boot, cameraStill, openPanel, palette, toPage } from './helpers';

/**
 * ADR-093 acceptance: a reference plane, axis or point made in the model view is drawn, picked
 * as `F<id>:plane` / `:axis` / `:point`, and has an eye in the feature tree that hides it in the
 * viewport (not drawn, not pickable) and persists across a reload; the origin planes and axes
 * follow a per-device toggle and show while the sketch plane chooser is open.
 */

type Stats = {
  planes: number;
  axes: number;
  points: number;
  originShown: boolean;
  names: string[];
};
type VP = { __wrenViewport: { getReferenceStats(): Stats } };
const stats = (page: Page) =>
  page.evaluate(() => (window as unknown as VP).__wrenViewport.getReferenceStats());
const part = async (page: Page) => (await app(page).doc()).parts[0] as WrenDoc['parts'][number];
const features = async (page: Page) => (await part(page)).features;
const tree = (page: Page) => page.getByTestId('feature-tree');

/** What a click at a world point would pick (the mouse resolution of the current mode). */
async function pickWorld(page: Page, p: [number, number, number]) {
  const at = await toPage(page, p);
  const box = (await page.getByTestId('viewport-canvas').boundingBox()) as {
    x: number;
    y: number;
  };
  return page.evaluate(
    ([x, y]) =>
      (
        window as unknown as {
          __wrenApp: {
            resolveAt(
              x: number,
              y: number,
            ): { best: { bodyId: string; kind: string; entity?: string } | null };
          };
        }
      ).__wrenApp.resolveAt(x as number, y as number).best,
    [at.x - box.x, at.y - box.y],
  );
}

/**
 * A world point on a reference plane at height `z` that is on screen and whose click picks `name`
 * (clear of the body and of the chrome).
 */
async function visiblePointOn(
  page: Page,
  name: string,
  z: number,
): Promise<[number, number, number]> {
  const box = (await page.getByTestId('viewport-canvas').boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  for (let x = -40; x <= 48; x += 8) {
    for (let y = -40; y <= 48; y += 8) {
      const at = await toPage(page, [x, y, z]);
      const inside =
        at.x > box.x + 40 &&
        at.x < box.x + box.width - 40 &&
        at.y > box.y + 40 &&
        at.y < box.y + box.height - 40;
      if (inside && (await pickWorld(page, [x, y, z]))?.bodyId === name) return [x, y, z];
    }
  }
  throw new Error(`no visible point picks ${name}`);
}

/** Frame the box and the axis beside it (the default view fits the box alone). */
async function frameAxis(page: Page) {
  await page.evaluate(() =>
    (
      window as unknown as { __wrenViewport: { zoomTo(p: number[], r: number, a: boolean): void } }
    ).__wrenViewport.zoomTo([0, 10, 10], 130, false),
  );
  await cameraStill(page);
}

/** A point along the axis x = -20, z = 0 that is on screen and whose click picks `name`. */
async function visiblePointOnAxis(page: Page, name: string): Promise<[number, number, number]> {
  const box = (await page.getByTestId('viewport-canvas').boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  for (let y = -48; y <= 48; y += 4) {
    const at = await toPage(page, [-20, y, 0]);
    const inside =
      at.x > box.x + 40 &&
      at.x < box.x + box.width - 40 &&
      at.y > box.y + 40 &&
      at.y < box.y + box.height - 40;
    if (inside && (await pickWorld(page, [-20, y, 0]))?.bodyId === name) return [-20, y, 0];
  }
  throw new Error(`no visible point picks ${name}`);
}

/** Pixels of the viewport canvas within `tol` of a colour (the reference tint). */
async function countColour(page: Page, rgb: [number, number, number], tol: number) {
  const png = await page.getByTestId('viewport-canvas').screenshot();
  return page.evaluate(
    async ({ data, target, t }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (
          Math.hypot(
            (px[i] as number) - target[0],
            (px[i + 1] as number) - target[1],
            (px[i + 2] as number) - target[2],
          ) <= t
        )
          n++;
      }
      return n;
    },
    { data: png.toString('base64'), target: rgb, t: tol },
  );
}
const LIGHT_REF: [number, number, number] = [15, 118, 110]; // --color-reference (light)

const id = (n: number) => `01J${String(n).padStart(23, '0')}`;
const PART_ID = async (page: Page) => (await part(page)).id;

/** Two points and an axis through them: x = -20, z = 0, along Y (clear of the box). */
async function addAxis(page: Page) {
  const pid = await PART_ID(page);
  const a = app(page);
  const pt = (n: number, y: string) => ({
    id: id(n),
    type: 'point',
    name: `Point ${n - 900}`,
    suppressed: false,
    definition: { kind: 'coordinates', x: '-20 mm', y, z: '0 mm' },
  });
  for (const [n, y] of [
    [901, '0 mm'],
    [902, '10 mm'],
  ] as const) {
    a.apply({ kind: 'addFeature', partId: pid, feature: pt(n, y) });
  }
  a.apply({
    kind: 'addFeature',
    partId: pid,
    feature: {
      id: id(903),
      type: 'axis',
      name: 'Axis 1',
      suppressed: false,
      definition: {
        kind: 'twoPoints',
        a: { name: `F${id(901)}:point`, kind: 'vertex' },
        b: { name: `F${id(902)}:point`, kind: 'vertex' },
      },
    },
  });
  await a.idle();
  return id(903);
}

/** The demo bracket gives the touch shells a model and a tree to work in. */
async function openDemo(page: Page) {
  await boot(page);
  await page.getByTestId('open-demo').tap();
  await expect.poll(async () => (await features(page)).length).toBeGreaterThan(0);
  await app(page).idle();
}

/** The eye of a feature row in the tree. */
const eye = (page: Page, name: string) =>
  tree(page).getByRole('button', { name: new RegExp(`^(Show|Hide) ${name}$`) });

test('a new offset plane is drawn and pickable, its eye hides it across a reload, and a picked plane starts a sketch', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  await addBox(page);
  const a = app(page);

  // Make a plane in the model view (the "Plane" tool).
  await palette(page, 'Plane');
  // The tool asks for the plane to offset from: the XY chip is that pick (the offset is 20 mm).
  await page.getByTestId('reference-chooser').locator('[data-ref="origin:XY"]').click();
  await a.idle();
  await expect.poll(async () => (await stats(page)).originShown).toBe(false);
  const plane = (await features(page)).find((f) => f.type === 'plane') as PlaneFeature;
  expect(plane.visibility).toBeUndefined();
  const name = `F${plane.id}:plane`;

  // Visible at once: handed to the viewport, tinted pixels on the canvas, pickable.
  await expect.poll(async () => (await stats(page)).names).toEqual([name]);
  expect(await stats(page)).toMatchObject({ planes: 1, axes: 0, points: 0, originShown: false });
  await expect.poll(() => countColour(page, LIGHT_REF, 40)).toBeGreaterThan(100);
  await expect(eye(page, plane.name)).toHaveAttribute('data-shown', 'true');
  const onPlane = await visiblePointOn(page, name, 20);
  expect(await pickWorld(page, onPlane)).toMatchObject({
    bodyId: name,
    kind: 'face',
    entity: 'reference',
  });

  // Hide it from the tree: gone from the view, not pickable, one document change.
  const past = (await a.history()).past.length;
  await eye(page, plane.name).click();
  await expect.poll(async () => (await stats(page)).planes).toBe(0);
  expect(((await features(page)).find((f) => f.id === plane.id) as PlaneFeature).visibility).toBe(
    'hidden',
  );
  expect((await a.history()).past.length).toBe(past + 1);
  expect(await pickWorld(page, onPlane)).toBeNull();
  await expect.poll(() => countColour(page, LIGHT_REF, 40)).toBeLessThan(20);
  await expect(eye(page, plane.name)).toHaveAttribute('data-shown', 'false');
  await expect(eye(page, plane.name)).toHaveAccessibleName(`Show ${plane.name}`);

  // It stays hidden after save -> reload.
  await a.idle();
  await a.flushSave();
  await page.reload();
  await boot(page);
  await a.idle();
  expect(((await features(page)).find((f) => f.id === plane.id) as PlaneFeature).visibility).toBe(
    'hidden',
  );
  expect((await stats(page)).planes).toBe(0);
  await expect(eye(page, plane.name)).toHaveAttribute('data-shown', 'false');

  // Show it again, then click it in the view and sketch on it.
  await eye(page, plane.name).click();
  await expect.poll(async () => (await stats(page)).names).toEqual([name]);
  const at = await toPage(page, onPlane);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await a.ui()).selectionKeys).toEqual([`${name}|face|0|reference`]);
  await palette(page, 'Sketch');
  await expect.poll(async () => (await a.ui()).sketch?.featureId ?? null).not.toBeNull();
  const sketch = (await features(page)).find((f) => f.type === 'sketch');
  expect(sketch && 'on' in sketch ? sketch.on.name : null).toBe(name);

  // The new eye is a real control: labelled, keyboard-reachable names, no serious axe findings.
  await page.keyboard.press('Escape');
  const serious = (
    await new AxeBuilder({ page }).include('[data-testid="feature-tree"]').analyze()
  ).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious).toEqual([]);
});

test('"Show origin planes" is a per-device toggle; the sketch plane chooser shows them while open', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  await addBox(page);
  const a = app(page);
  expect(await stats(page)).toMatchObject({ originShown: false, planes: 0 });
  // Hidden by default; the chooser shows them while it is open and only then.
  await palette(page, 'Sketch');
  await expect(page.getByTestId('plane-chooser')).toBeVisible();
  await expect.poll(async () => (await stats(page)).names).toContain('origin:XY');
  expect(await pickWorld(page, [-30, -30, 0])).toMatchObject({ bodyId: 'origin:XY' });
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await stats(page)).originShown).toBe(false);

  // The toggle, kept on this device (localStorage), not in the document.
  const before = JSON.stringify((await a.doc()).parts);
  await palette(page, 'Show origin planes');
  await expect.poll(async () => (await stats(page)).names).toHaveLength(7);
  expect((await stats(page)).names).toEqual(
    expect.arrayContaining([
      'origin:XY',
      'origin:XZ',
      'origin:YZ',
      'origin:X',
      'origin:Y',
      'origin:Z',
    ]),
  );
  expect(JSON.stringify((await a.doc()).parts)).toBe(before);
  expect(await page.evaluate(() => localStorage.getItem('wren.view.originPlanes'))).toBe('1');
  await page.reload();
  await boot(page);
  await expect.poll(async () => (await stats(page)).originShown).toBe(true);
  // An origin axis is pickable as an edge (just past the box).
  expect(await pickWorld(page, [47, 0, 0])).toMatchObject({ bodyId: 'origin:X', kind: 'edge' });
  await palette(page, 'Hide origin planes');
  await expect.poll(async () => (await stats(page)).originShown).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('wren.view.originPlanes'))).toBeNull();
});

test('an axis gets the same treatment: drawn, picked as an edge, hidden from the tree across a reload, and used as a revolve axis', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  await addBox(page);
  const a = app(page);
  const axis = await addAxis(page);
  const name = `F${axis}:axis`;
  await frameAxis(page);

  // Visible as soon as it exists; picked as an edge with its persistent name.
  await expect.poll(async () => (await stats(page)).axes).toBe(1);
  expect((await stats(page)).points).toBe(2);
  expect((await stats(page)).names).toContain(name);
  await expect(eye(page, 'Axis 1')).toHaveAttribute('data-shown', 'true');
  const onAxis = await visiblePointOnAxis(page, name);
  expect(await pickWorld(page, onAxis)).toMatchObject({
    bodyId: name,
    kind: 'edge',
    entity: 'reference',
  });

  // Hide it: not drawn, not pickable; survives a reload; show again.
  await eye(page, 'Axis 1').click();
  await expect.poll(async () => (await stats(page)).axes).toBe(0);
  expect(await pickWorld(page, onAxis)).toBeNull();
  await a.idle();
  await a.flushSave();
  await page.reload();
  await boot(page);
  await a.idle();
  expect((await stats(page)).axes).toBe(0);
  await expect(eye(page, 'Axis 1')).toHaveAttribute('data-shown', 'false');
  await eye(page, 'Axis 1').click();
  await expect.poll(async () => (await stats(page)).axes).toBe(1);
  await frameAxis(page); // a reload resets the camera
  const clickAt = await visiblePointOnAxis(page, name);

  // A revolve whose axis is the one picked in the view: sketch on XY, ring 10..20 mm from the axis.
  const pid = await PART_ID(page);
  const ent = (e: object) => ({ construction: false, ...e });
  const sk = {
    id: id(910),
    type: 'sketch',
    name: 'Ring',
    suppressed: false,
    on: { name: 'origin:XY', kind: 'face' },
    entities: [
      ent({ id: 'pa', kind: 'point', x: -10, y: 0 }),
      ent({ id: 'pb', kind: 'point', x: 0, y: 0 }),
      ent({ id: 'pc', kind: 'point', x: 0, y: 15 }),
      ent({ id: 'pd', kind: 'point', x: -10, y: 15 }),
      ent({ id: 'L1', kind: 'line', start: 'pa', end: 'pb' }),
      ent({ id: 'L2', kind: 'line', start: 'pb', end: 'pc' }),
      ent({ id: 'L3', kind: 'line', start: 'pc', end: 'pd' }),
      ent({ id: 'L4', kind: 'line', start: 'pd', end: 'pa' }),
    ],
    constraints: [
      { id: 'k1', kind: 'horizontal', line: 'L1' },
      { id: 'k2', kind: 'horizontal', line: 'L3' },
      { id: 'k3', kind: 'vertical', line: 'L2' },
      { id: 'k4', kind: 'vertical', line: 'L4' },
      { id: 'k5', kind: 'fix', entity: 'pa' },
    ],
  };
  a.apply({ kind: 'addFeature', partId: pid, feature: sk });
  a.apply({
    kind: 'addFeature',
    partId: pid,
    feature: {
      id: id(911),
      type: 'revolve',
      name: 'Revolve 1',
      suppressed: false,
      profile: [{ name: `S${id(910)}:region(L1,L2,L3,L4)`, kind: 'region' }],
      axis: { name: 'origin:Y', kind: 'edge' },
      angle: '360 deg',
      direction: 'normal',
      op: 'new',
    },
  });
  await a.idle();
  // Open the revolve, change its axis and click the axis in the view.
  await a.editFeature(id(911));
  await page
    .getByTestId('pick-axis')
    .getByRole('button', { name: /^Change/ })
    .click();
  const at = await toPage(page, clickAt);
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(async () => {
      const r = (await features(page)).find((f) => f.id === id(911));
      return r && 'axis' in r ? r.axis.name : null;
    })
    .toBe(name);
  await a.idle();
  const regen = await a.regen();
  expect(regen?.features.find((f) => f.id === id(911))?.state).toBe('ok');
  // r from 10 to 20 mm about the picked axis, 15 mm tall: pi (20^2 - 10^2) 15.
  const ring = regen?.bodies.find((b) => b.id === `B${id(911)}`)?.volume ?? 0;
  expect(ring).toBeCloseTo(Math.PI * 300 * 15, -1);
});

test.describe('tablet', () => {
  test.use({
    viewport: { width: 1180, height: 820 },
    userAgent: devices['iPad Pro 11'].userAgent,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });

  test('the eye of a plane, axis and point works by touch in the tablet feature panel', async ({
    page,
  }) => {
    test.slow();
    await openDemo(page);
    const a = app(page);
    const pid = await PART_ID(page);
    a.apply({
      kind: 'addFeature',
      partId: pid,
      feature: {
        id: id(920),
        type: 'plane',
        name: 'Plane 1',
        suppressed: false,
        definition: {
          kind: 'offset',
          from: { name: 'origin:XY', kind: 'face' },
          distance: '20 mm',
        },
      },
    });
    await addAxis(page);
    await a.idle();
    expect(await stats(page)).toMatchObject({ planes: 1, axes: 1, points: 2 });
    await openPanel(page, 'left'); // docked at 1180 wide; a tap on its button otherwise
    for (const [label, key] of [
      ['Plane 1', 'planes'],
      ['Axis 1', 'axes'],
      ['Point 1', 'points'],
    ] as const) {
      const e = eye(page, label);
      expect((await e.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await e.tap();
      await expect.poll(async () => (await stats(page))[key]).toBe(key === 'points' ? 1 : 0);
      await e.tap();
      await expect.poll(async () => (await stats(page))[key]).toBe(key === 'points' ? 2 : 1);
    }
    const serious = (
      await new AxeBuilder({ page }).include('[data-testid="feature-tree"]').analyze()
    ).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious).toEqual([]);
  });
});

test.describe('phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: devices['iPhone 13'].userAgent,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  test('the Features tab has the eye on a plane and an axis', async ({ page }) => {
    test.slow();
    await openDemo(page);
    const a = app(page);
    const pid = await PART_ID(page);
    a.apply({
      kind: 'addFeature',
      partId: pid,
      feature: {
        id: id(930),
        type: 'plane',
        name: 'Plane 1',
        suppressed: false,
        definition: {
          kind: 'offset',
          from: { name: 'origin:XY', kind: 'face' },
          distance: '20 mm',
        },
      },
    });
    await addAxis(page);
    await a.idle();
    expect(await stats(page)).toMatchObject({ planes: 1, axes: 1 });
    await page
      .getByRole('group', { name: 'Viewer tools' })
      .getByRole('button', { name: 'Features' })
      .tap();
    await expect(tree(page)).toBeVisible();
    for (const [label, key] of [
      ['Plane 1', 'planes'],
      ['Axis 1', 'axes'],
    ] as const) {
      const e = eye(page, label);
      await e.scrollIntoViewIfNeeded();
      expect((await e.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await e.tap();
      await expect.poll(async () => (await stats(page))[key]).toBe(0);
      expect(
        (await features(page)).find((f) => f.name === label && 'visibility' in f),
      ).toMatchObject({ visibility: 'hidden' });
      await e.tap();
      await expect.poll(async () => (await stats(page))[key]).toBe(1);
    }
  });
});
