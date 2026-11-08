import type { Page } from '@playwright/test';
import type { WhittleDoc, WhittleTestHooks } from '@whittle/contracts';

/** App-level E2E hooks (`window.__whittleApp`, see src/app/workbench.ts `testHooks`). */
export interface AppHooks {
  doc(): WhittleDoc;
  regen(): {
    revision: number;
    bodies: { id: string; volume: number | null }[];
    features: { id: string; state: string }[];
    sketches: { id: string; regions: string[] }[];
  } | null;
  idle(): Promise<void>;
  flushSave(): Promise<void>;
  sketch(): { status: string; dof: number } | null;
}

type W = { __whittle: WhittleTestHooks; __whittleApp: AppHooks };

/** Opens the app (real regen engine unless `query` says `engine=fake`) and waits for the first regen to render. */
export async function boot(page: Page, query = ''): Promise<void> {
  await page.goto(`./?${query}`);
  await page.waitForFunction(() => window.crossOriginIsolated === true);
  await page.evaluate(() => (window as unknown as W).__whittle.firstBodyRendered());
}

export const app = (page: Page) => ({
  doc: () => page.evaluate(() => (window as unknown as W).__whittleApp.doc()),
  regen: () => page.evaluate(() => (window as unknown as W).__whittleApp.regen()),
  idle: () => page.evaluate(() => (window as unknown as W).__whittleApp.idle()),
  flushSave: () => page.evaluate(() => (window as unknown as W).__whittleApp.flushSave()),
  sketch: () => page.evaluate(() => (window as unknown as W).__whittleApp.sketch()),
});

/** Runs a ⌘K palette command by its label. */
export async function palette(page: Page, label: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await page.keyboard.type(label);
  await page
    .getByRole('option', { name: new RegExp(`^${label}`) })
    .first()
    .click();
  await dialog.waitFor({ state: 'hidden' });
}

/** Adds a 40 × 30 × 20 box through the palette and waits for it to render. */
export async function addBox(page: Page): Promise<void> {
  await palette(page, 'Box');
  await app(page).idle();
}

/** Page coordinates of a world point (mm). */
export async function toPage(
  page: Page,
  p: [number, number, number],
): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('viewport-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const s = await page.evaluate(
    (q) =>
      (
        window as unknown as {
          __whittleViewport: {
            worldToScreen(p: [number, number, number]): { x: number; y: number };
          };
        }
      ).__whittleViewport.worldToScreen(q),
    p,
  );
  return { x: box.x + s.x, y: box.y + s.y };
}

/** Waits until the camera stops moving (animated transitions). */
export async function cameraStill(page: Page): Promise<void> {
  let last = '';
  for (let i = 0; i < 60; i++) {
    const s = await page.evaluate(() =>
      JSON.stringify(
        (
          window as unknown as { __whittleViewport: { getCameraState(): unknown } }
        ).__whittleViewport.getCameraState(),
      ),
    );
    if (s === last) return;
    last = s;
    await page.waitForTimeout(100);
  }
}

/** Clicks a point on the sketch plane z = 0. */
export async function clickAt(page: Page, x: number, y: number, z = 0): Promise<void> {
  const p = await toPage(page, [x, y, z]);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
}
