import { expect, test } from '@playwright/test';
import { app, boot } from './helpers';

/**
 * The annotation and drawing half of the document package is a lazily loaded chunk (ADR-090
 * amendment). The library awaits it before it reads anything, so a document with annotations
 * survives a reload, and annotation commands work once the app is up.
 */

test.use({ viewport: { width: 1280, height: 720 } });

test('an annotation is added, saved and read back after a reload', async ({ page }) => {
  await boot(page);
  const a = app(page);
  await a.idle();
  // The support is a lazily loaded chunk: wait for it, as the drawing UI will.
  await page.evaluate(() =>
    (
      window as unknown as { __wrenApp: { drawingSupport(): Promise<void> } }
    ).__wrenApp.drawingSupport(),
  );
  const part = (await a.doc()).parts[0];
  expect(part).toBeDefined();
  const partId = (part as { id: string }).id;
  const ok = await a.apply({
    kind: 'addAnnotation',
    partId,
    annotation: {
      id: '01J00000000000000000000A01',
      kind: 'note',
      origin: { kind: 'model' },
      refs: [{ name: 'origin:XY', kind: 'face' }],
      text: 'BREAK SHARP EDGES',
    },
  });
  expect(ok).toBeTruthy();
  expect((await a.doc()).parts[0]?.annotations).toHaveLength(1);
  await a.flushSave();

  await page.reload();
  await page.evaluate(() =>
    (
      window as unknown as { __wren: { firstBodyRendered(): Promise<unknown> } }
    ).__wren.firstBodyRendered(),
  );
  await a.idle();
  const back = (await a.doc()).parts[0]?.annotations;
  expect(back?.map((x) => x.id)).toEqual(['01J00000000000000000000A01']);
});
