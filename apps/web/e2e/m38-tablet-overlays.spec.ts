import { devices, expect, test } from '@playwright/test';
import { app, boot, cameraStill, toPage, touch } from './helpers';
import { expectNoIntersections, overlayBoxes } from './support/overlays';

/**
 * M3.8, tablet: the no-intersection rule holds beyond the phone. After a sketch rectangle, Finish,
 * tap the region and Extrude from the bubble, the inline depth field is the hit target (the
 * picking status chip's Cancel button must not cover it) and no floating overlay overlaps another.
 */

test.use({
  viewport: { width: 1180, height: 820 },
  userAgent: devices['iPad Pro 11'].userAgent,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

test('tablet: the extrude depth field is the hit target and no overlays intersect', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  const a = app(page);
  const t = await touch(page);
  await page.getByRole('button', { name: 'Close welcome' }).tap();
  const onView = async (p: [number, number, number]) => {
    const q = await toPage(page, p);
    await expect
      .poll(() =>
        page.evaluate((q) => document.elementFromPoint(q.x, q.y)?.getAttribute('data-testid'), q),
      )
      .toBe('viewport-canvas');
    return q;
  };

  await page.getByRole('button', { name: 'Sketch', exact: true }).tap();
  await page.getByTestId('plane-chooser').getByRole('button', { name: /Top/ }).tap();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
  await cameraStill(page);
  await page.locator('[data-tool="rectangle"]').tap();
  await t.drag(await onView([0, -10, 0]), await onView([60, 30, 0]), 16);
  await a.settled();
  await page
    .getByRole('toolbar', { name: 'Sketch tools' })
    .getByRole('button', { name: 'Finish sketch' })
    .tap();
  await a.idle();
  await t.tap([await onView([30, 10, 0])]);
  await a.idle();
  await page.getByTestId('context-bubble').locator('[data-action="extrude"]').tap();
  await a.idle();
  await cameraStill(page);

  const depth = page.getByTestId('extrude-depth-input').getByRole('textbox');
  await expect(depth).toBeVisible();
  await expectNoIntersections(await overlayBoxes(page));
  const hit = await depth.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return e === el || el.contains(e);
  });
  expect(hit, 'the depth field is what a tap at its centre reaches').toBe(true);
  await depth.tap();
  await expect(page.getByTestId('keypad')).toBeVisible();
});
