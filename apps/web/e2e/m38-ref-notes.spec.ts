import { expect, test } from '@playwright/test';
import { app, boot } from './helpers';

/**
 * M3.8: references that changed meaning. The regen reports merged refs (ADR-078) and, once
 * kernel-client produces it, grown ones; until then the status is stubbed through the test hook.
 * The feature shows a quiet badge; the inspector shows the old and new size with Accept and
 * Re-pick. Nothing blocks the regen and nothing is re-picked silently.
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
  if (!fillet || fillet.type !== 'fillet') throw new Error('no fillet in the demo');
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
  if (!fillet || fillet.type !== 'fillet' || !fillet.edges[0]) throw new Error('no fillet');
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
