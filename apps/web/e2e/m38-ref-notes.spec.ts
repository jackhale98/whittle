import { expect, type Page, test } from '@playwright/test';
import type { Feature } from '@wren-cad/contracts';
import { app, boot } from './helpers';

/**
 * M3.8: references that changed meaning. The regen reports merged refs (ADR-078) and grown ones.
 * The first two tests stub the status through the test hook (UI states the demo can't reach on
 * its own); the last two use the real kernel. The feature shows a quiet badge; the inspector shows
 * the old and new size with Accept and Re-pick. Nothing blocks the regen and nothing is re-picked
 * silently.
 */

test('a grown fillet edge is flagged; Accept clears it until it grows again; Re-pick starts picking', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  const a = app(page);
  await page.getByTestId('open-demo').click();
  await expect.poll(async () => (await a.doc()).parts[0]?.features.length).toBeGreaterThan(0);
  await a.idle();
  const doc = await a.doc();
  const fillet = doc.parts[0]?.features.find((f) => f.type === 'fillet');
  if (fillet?.type !== 'fillet') throw new Error('no fillet in the demo');
  const edge = fillet.edges[0];
  if (!edge) throw new Error('fillet has no edge');
  const volume0 = (await a.regen())?.bodies[0]?.volume;

  await a.stubRefNotes(fillet.id, {
    grown: [{ path: '/edges/0', name: edge.name, was: 8, now: 48 }],
  });
  // The row carries a quiet note, not a warning.
  const row = page.locator(`[data-feature-id="${fillet.id}"]`);
  await expect(row.getByTestId('feature-message')).toHaveText(/Check this reference/);
  await expect(row.getByTestId('feature-message')).not.toHaveClass(/warning/);

  await a.editFeature(fillet.id);
  const note = page.getByTestId('ref-note');
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('data-kind', 'grown');
  await expect(page.getByTestId('ref-note-detail')).toContainText('8 mm');
  await expect(page.getByTestId('ref-note-detail')).toContainText('48 mm');

  // Accept stores the acknowledgement; the document and the geometry are untouched.
  const past = (await a.history()).past.length;
  await page.getByTestId('ref-accept').click();
  await expect(page.getByTestId('ref-note')).toHaveCount(0);
  await expect(row.getByTestId('feature-message')).toHaveCount(0);
  expect((await a.history()).past.length).toBe(past);
  expect((await a.regen())?.bodies[0]?.volume).toBe(volume0);

  // It grew again: the note comes back.
  await a.stubRefNotes(fillet.id, {
    grown: [{ path: '/edges/0', name: edge.name, was: 8, now: 90 }],
  });
  await expect(page.getByTestId('ref-note')).toBeVisible();
  await expect(page.getByTestId('ref-note-detail')).toContainText('90 mm');

  // Re-pick enters the existing re-pick flow for that field; nothing is re-picked on its own.
  await page.getByTestId('ref-repick').click();
  await expect.poll(async () => (await a.ui()).picking?.path).toBe('/edges/0');
  expect((await a.history()).past.length).toBe(past);
});

test('a merged reference shows "uses a merged edge"', async ({ page }) => {
  test.slow();
  await boot(page);
  const a = app(page);
  await page.getByTestId('open-demo').click();
  await expect.poll(async () => (await a.doc()).parts[0]?.features.length).toBeGreaterThan(0);
  await a.idle();
  const fillet = (await a.doc()).parts[0]?.features.find((f) => f.type === 'fillet');
  if (fillet?.type !== 'fillet' || !fillet.edges[0]) throw new Error('no fillet');
  await a.stubRefNotes(fillet.id, {
    merged: [{ path: '/edges/0', name: fillet.edges[0].name, into: 'edge(merged|other)' }],
  });
  await expect(
    page.locator(`[data-feature-id="${fillet.id}"]`).getByTestId('feature-message'),
  ).toHaveText(/Uses a merged face or edge/);
  await a.editFeature(fillet.id);
  await expect(page.getByTestId('ref-note')).toHaveAttribute('data-kind', 'merged');
  await expect(page.getByTestId('ref-note-detail')).toContainText('edge(merged|other)');
  await page.getByTestId('ref-accept').click();
  await expect(page.getByTestId('ref-note')).toHaveCount(0);
});

// Real `grown` (nothing stubbed): the demo bracket with a feature appended, on the real kernel.

const side = (e: string, s: string, entity: string) => `F${e}:side(S${s}:e(${entity}))`;

/** Opens the demo bracket and appends `extra` (built from the demo's plate ids). */
async function demoWith(page: Page, extra: (ids: { S1: string; E1: string }) => Feature[]) {
  await boot(page);
  const a = app(page);
  await page.getByTestId('open-demo').click();
  await expect.poll(async () => (await a.doc()).parts[0]?.features.length).toBeGreaterThan(0);
  await a.idle();
  const doc = structuredClone(await a.doc());
  const part = doc.parts[0];
  if (!part) throw new Error('no part');
  const S1 = part.features[0]?.id;
  const E1 = part.features[1]?.id;
  if (!S1 || !E1) throw new Error('no plate');
  part.features.push(...extra({ S1, E1 }));
  part.rollbackIndex = part.features.length;
  await a.load(doc);
  await a.idle();
  return a;
}

async function setWidth(page: Page, expr: string) {
  await page.getByRole('tab', { name: 'Params' }).click();
  const e = page.getByRole('textbox', { name: 'Expression for width' });
  await e.fill(expr);
  await e.press('Enter');
}

const CORNER = '01JC00000000000000000000CF';
const SHELL = '01JC00000000000000000000SH';

test('real grown: a fillet edge picked before the upright flags; Accept clears; a width edit adds nothing', async ({
  page,
}) => {
  test.slow();
  // The plate's back-left vertical edge as picked before the upright existed (8 mm). The upright's
  // merge makes it the 48 mm corner (ADR-078): the kernel reports it as grown.
  const a = await demoWith(page, ({ S1, E1 }) => [
    {
      id: CORNER,
      type: 'fillet',
      name: 'Back corner fillet',
      suppressed: false,
      edges: [
        {
          name: `edge(${[side(E1, S1, 'L3'), side(E1, S1, 'L4')].sort().join('|')})`,
          kind: 'edge',
          fingerprint: { centroid: [0, 50, 4], length: 8 },
        },
      ],
      radius: '2 mm',
    },
  ]);
  const status = async () => (await a.regen())?.features.find((f) => f.id === CORNER);
  expect((await status())?.state).toBe('ok');
  const g = (await status())?.grown?.[0];
  expect(g?.path).toBe('/edges/0');
  expect(g?.was).toBe(8);
  expect(g?.now).toBeCloseTo(48, 6);

  const row = page.locator(`[data-feature-id="${CORNER}"]`);
  await expect(row.getByTestId('feature-message')).toHaveText(/Check this reference/);
  await a.editFeature(CORNER);
  await expect(page.getByTestId('ref-note')).toHaveAttribute('data-kind', 'grown');
  await expect(page.getByTestId('ref-note-detail')).toContainText('48 mm');
  await page.getByTestId('ref-accept').click();
  await expect(page.getByTestId('ref-note')).toHaveCount(0);
  await expect(row.getByTestId('feature-message')).toHaveCount(0);

  // An ordinary width edit: the corner is still 48 mm (the acknowledgement holds), and nothing
  // else is reported as grown.
  await setWidth(page, '130 mm');
  await a.idle();
  const r = await a.regen();
  expect(r?.features.map((f) => f.state)).toEqual(Array(10).fill('ok'));
  expect(r?.features.filter((f) => f.grown && f.id !== CORNER)).toEqual([]);
  await page.getByRole('tab', { name: 'Features' }).click();
  await expect(page.getByTestId('feature-message')).toHaveCount(0);
});

test('real grown: a face picked after the merge is not flagged when the width grows it', async ({
  page,
}) => {
  test.slow();
  // The merged back face as picked on the demo (80 × 48 = 3840 mm²), opened by a shell. Width
  // 130 mm makes it 6240 mm²: a parameter edit, not "grown" (review N1).
  const a = await demoWith(page, ({ S1, E1 }) => [
    {
      id: SHELL,
      type: 'shell',
      name: 'Shell',
      suppressed: false,
      openFaces: [
        {
          name: side(E1, S1, 'L3'),
          kind: 'face',
          fingerprint: { centroid: [40, 50, 24], normal: [0, 1, 0], area: 3840 },
        },
      ],
      thickness: '1 mm',
      direction: 'inward',
    },
  ]);
  expect((await a.regen())?.features.map((f) => f.state)).toEqual(Array(10).fill('ok'));
  await setWidth(page, '130 mm');
  await a.idle();
  const r = await a.regen();
  expect((await a.doc()).params.find((p) => p.name === 'width')?.expr).toBe('130 mm');
  expect(r?.features.map((f) => f.state)).toEqual(Array(10).fill('ok'));
  expect(r?.features.find((f) => f.id === SHELL)?.grown).toBeUndefined();
  await page.getByRole('tab', { name: 'Features' }).click();
  await expect(
    page.locator(`[data-feature-id="${SHELL}"]`).getByTestId('feature-message'),
  ).toHaveCount(0);
});
