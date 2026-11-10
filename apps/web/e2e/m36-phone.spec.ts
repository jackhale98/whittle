import { devices, expect, type Page, test } from '@playwright/test';
import { app, boot } from './helpers';

/**
 * M3.6 acceptance, phone: the Features tab steps through the demo bracket. At each step the
 * viewport shows that intermediate state (asserted on the regen result the viewport was given:
 * body count, volume, face count), the document is never changed by a preview, and only
 * "Keep this rollback" writes it.
 */

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: devices['iPhone 13'].userAgent,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

const tab = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Viewer tools' }).getByRole('button', { name });

/** The demo bracket's dimensions (src/samples/bracket.ts `BRACKET_PARAMS`), in mm. */
const DIM: Record<string, number> = {
  width: 80,
  depth: 50,
  thickness: 8,
  hole_d: 6,
  height: 40,
  corner_r: 5,
  bend_r: 3,
  chamfer_d: 2,
};
const num = (key: string) => DIM[key] ?? 0;

/** Analytic volume of the finished bracket (src/samples/bracket.ts `demoBracketVolume`). */
function bracketVolume(): number {
  const k = 1 - Math.PI / 4;
  return (
    num('width') * num('depth') * num('thickness') -
    4 * Math.PI * (num('hole_d') / 2) ** 2 * num('thickness') -
    2 * k * num('corner_r') ** 2 * num('thickness') +
    num('width') * num('thickness') * num('height') +
    k * num('bend_r') ** 2 * num('width') -
    0.5 * num('chamfer_d') ** 2 * num('width')
  );
}

/** The steps of the nested tree: a feature and its sketch are one step (ADR-015). */
const STEPS = [
  { label: 'Plate', rollback: 2 },
  { label: 'Holes', rollback: 4 },
  { label: 'Upright', rollback: 6 },
  { label: 'Corner fillets', rollback: 7 },
  { label: 'Bend fillet', rollback: 8 },
  { label: 'Top chamfer', rollback: 9 },
] as const;

async function openDemo(page: Page) {
  await boot(page);
  const a = app(page);
  await page.getByTestId('open-demo').tap();
  await expect.poll(async () => (await a.doc()).parts[0]?.features.length).toBeGreaterThan(0);
  await a.idle();
  return a;
}

test('phone step-through: each step shows its intermediate model; the document never changes; Keep writes the rollback', async ({
  page,
}) => {
  test.slow();
  const a = await openDemo(page);
  const doc0 = await a.doc();
  const n = doc0.parts[0]?.features.length ?? 0;
  expect(n).toBe(9);
  const past0 = (await a.history()).past.length;

  await tab(page, 'Features').tap();
  const tree = page.getByTestId('phone-feature-tree');
  await expect(tree).toBeVisible();
  const label = page.getByTestId('step-label');
  await expect(label).toHaveText('6 of 6 · Top chamfer');
  expect(await a.preview()).toBeNull();

  const full = await a.regen();
  const fullVolume = full?.bodies[0]?.volume ?? 0;
  expect(fullVolume).toBeCloseTo(bracketVolume(), 1);

  type Seen = { rollback: number | null; bodies: number; volume: number; faces: number };
  const seen = new Map<number, Seen>();
  const showStep = async (i: number) => {
    const s = STEPS[i] as (typeof STEPS)[number];
    await expect(label).toHaveText(`${i + 1} of 6 · ${s.label}`);
    await a.idle();
    const r = await a.regen();
    expect(r?.rollback).toBe(s.rollback);
    expect(r?.source).toBe('live');
    // The viewport holds exactly the bodies of this step's result.
    expect((await a.shownBodies()).sort()).toEqual((r?.bodies ?? []).map((b) => b.id).sort());
    const got = {
      rollback: r?.rollback ?? null,
      bodies: r?.bodies.length ?? 0,
      volume: r?.bodies[0]?.volume ?? 0,
      faces: r?.bodies[0]?.faces ?? 0,
    };
    seen.set(s.rollback, got);
    expect(await a.preview()).toBe(s.rollback === n ? null : s.rollback);
    return got;
  };

  // Backwards, from the full model to the first feature.
  const prev = page.getByRole('button', { name: 'Previous feature' });
  const next = page.getByRole('button', { name: 'Next feature' });
  for (let i = STEPS.length - 2; i >= 0; i--) {
    await prev.tap();
    await showStep(i);
  }
  const t = (key: string) => num(key);
  // Plate: one body, an 80 × 50 × 8 box: 6 faces.
  const plate = seen.get(2) as Seen;
  expect(plate.bodies).toBe(1);
  expect(plate.faces).toBe(6);
  expect(plate.volume).toBeCloseTo(t('width') * t('depth') * t('thickness'), 3);
  // Holes: four through-holes (a cylinder face each).
  const holes = seen.get(4) as Seen;
  expect(holes.bodies).toBe(1);
  expect(holes.faces).toBe(10);
  expect(holes.volume).toBeCloseTo(
    plate.volume - 4 * Math.PI * (t('hole_d') / 2) ** 2 * t('thickness'),
    2,
  );
  // Upright adds its volume; the three finishing features each change the face count again.
  const upright = seen.get(6) as Seen;
  expect(upright.volume).toBeCloseTo(holes.volume + t('width') * t('thickness') * t('height'), 2);
  expect(upright.faces).toBeGreaterThan(holes.faces);
  expect(seen.get(7)?.faces).toBeGreaterThan(upright.faces);
  expect(seen.get(8)?.faces).toBeGreaterThan(seen.get(7)?.faces ?? 0);
  // Every step is one body and volumes are all different: the viewport really moved.
  expect(new Set([...seen.values()].map((s) => s.volume.toFixed(3))).size).toBe(5);

  // The document was never touched: same document, no undo entry.
  expect(await a.doc()).toEqual(doc0);
  expect((await a.history()).past.length).toBe(past0);

  // Forwards again (warm: every feature result is cached), then the scrubber.
  for (let i = 1; i < STEPS.length - 1; i++) {
    await next.tap();
    await showStep(i);
  }
  await page.getByTestId('step-scrubber').fill('1');
  await showStep(1);
  const timings = await a.previewTimings();
  const warm = timings.filter((x) => x.cached);
  console.log(
    `step-through timings (ms, ask to frame): ${timings.map((x) => `${x.index}${x.cached ? 'w' : 'c'}=${x.ms}`).join(' ')}`,
  );
  expect(warm.length).toBeGreaterThan(0);
  for (const w of warm) expect(w.ms).toBeLessThan(1000);

  // Back to the full model without keeping anything.
  await page.getByRole('button', { name: 'Back to full model' }).tap();
  await expect.poll(() => a.preview()).toBeNull();
  await a.idle();
  const back = await a.regen();
  expect(back?.rollback).toBe(n);
  expect(back?.bodies[0]?.volume).toBeCloseTo(fullVolume, 6);
  await expect(label).toHaveText('6 of 6 · Top chamfer');
  expect(await a.doc()).toEqual(doc0);
  expect((await a.history()).past.length).toBe(past0);

  // Leaving the tab mid-preview restores the full model too.
  await prev.tap();
  await a.idle();
  expect(await a.preview()).toBe(8);
  await tab(page, 'Params').tap();
  await expect.poll(() => a.preview()).toBeNull();
  await a.idle();
  expect((await a.regen())?.rollback).toBe(n);
  expect(await a.doc()).toEqual(doc0);

  // An edit that arrives during a preview ends it cleanly (undo, sync and loads come this way).
  await tab(page, 'Features').tap();
  await prev.tap();
  await a.idle();
  expect(await a.preview()).toBe(8);
  expect(await a.apply({ kind: 'setDocName', name: 'Renamed' })).toBe(true);
  await expect.poll(() => a.preview()).toBeNull();
  await a.idle();
  expect((await a.regen())?.rollback).toBe(n);
  expect((await a.doc()).meta.name).toBe('Renamed');
  await expect(label).toHaveText('6 of 6 · Top chamfer');

  // Keep this rollback writes `setRollback`: one undo entry, and the model stays there.
  const past1 = (await a.history()).past.length;
  await prev.tap();
  await prev.tap();
  await showStep(3);
  await page.getByRole('button', { name: 'Keep this rollback' }).tap();
  await expect.poll(async () => (await a.doc()).parts[0]?.rollbackIndex).toBe(7);
  await expect.poll(() => a.preview()).toBeNull();
  expect((await a.history()).past.length).toBe(past1 + 1);
  await a.idle();
  expect((await a.regen())?.rollback).toBe(7);
  await expect(label).toHaveText('4 of 6 · Corner fillets');
});
