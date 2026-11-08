/** Sketch overlay colour mapping (PLAN §9.5). Pure. */

import type { DofState } from '@whittle/contracts';
import type { OverlayColors } from './themes';

export function mixHex(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16);
  const pb = Number.parseInt(b.slice(1), 16);
  const ch = (shift: number) => {
    const va = (pa >> shift) & 0xff;
    const vb = (pb >> shift) & 0xff;
    return Math.round(va + (vb - va) * t);
  };
  const v = (ch(16) << 16) | (ch(8) << 8) | ch(0);
  return `#${v.toString(16).padStart(6, '0')}`;
}

/**
 * free -> under-constrained blue; partial -> blue pulled toward the fully constrained tone;
 * fixed -> fully constrained (near-black on light, white on dark); conflicting -> red.
 * Entities without DOF info are drawn under-constrained.
 */
export function entityColor(
  c: OverlayColors,
  state: DofState | undefined,
  conflicting: boolean,
): string {
  if (conflicting) return c.danger;
  switch (state) {
    case 'fixed':
      return c.fullyConstrained;
    case 'partial':
      return mixHex(c.underConstrained, c.fullyConstrained, 0.45);
    default:
      return c.underConstrained;
  }
}
