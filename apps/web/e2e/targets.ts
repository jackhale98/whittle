import { expect, type Locator } from '@playwright/test';

/** ADR-012 item 6: touch tiers give every control a target of at least 44 × 44 CSS px. */
export const TOUCH_TARGET = 44;

/** Asserts a visible control is at least 44 px in both directions (sub-pixel rounding allowed). */
export async function expectTouchTarget(control: Locator, what: string): Promise<void> {
  await expect(control, what).toBeVisible();
  const b = await control.boundingBox();
  const size = `${what}: ${b ? `${b.width.toFixed(1)}×${b.height.toFixed(1)}` : 'no box'}`;
  expect(b?.width ?? 0, size).toBeGreaterThanOrEqual(TOUCH_TARGET - 0.5);
  expect(b?.height ?? 0, size).toBeGreaterThanOrEqual(TOUCH_TARGET - 0.5);
}
