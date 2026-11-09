import { describe, expect, it } from 'vitest';
import { colors } from '../../ui/src/tokens';
import { COMPARE_COLORS } from '../src/compare';
import { entityColor, mixHex } from '../src/sketchStyle';
import { OVERLAY_COLORS } from '../src/themes';

describe('overlay colours mirror @wren-cad/ui tokens', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: every mirrored token is identical`, () => {
      for (const [key, value] of Object.entries(OVERLAY_COLORS[theme])) {
        expect(value, `${theme}.${key}`).toBe(colors[theme][key as keyof (typeof colors)['light']]);
      }
    });
  }
});

describe('compare colours mirror the @wren-cad/ui swatch tokens (ADR-028)', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: the compare panel legend shows exactly what the viewport draws`, () => {
      expect(COMPARE_COLORS[theme].added).toBe(colors[theme].compareAddedSwatch);
      expect(COMPARE_COLORS[theme].removed).toBe(colors[theme].compareRemovedSwatch);
    });
  }
});

describe('sketch DOF colouring (PLAN §9.5)', () => {
  for (const theme of ['light', 'dark'] as const) {
    const c = OVERLAY_COLORS[theme];
    it(`${theme}: free blue, fixed near-black/white, conflicting red`, () => {
      expect(entityColor(c, 'free', false)).toBe(c.underConstrained);
      expect(entityColor(c, undefined, false)).toBe(c.underConstrained);
      expect(entityColor(c, 'fixed', false)).toBe(c.fullyConstrained);
      expect(entityColor(c, 'fixed', true)).toBe(c.danger);
      expect(entityColor(c, 'free', true)).toBe(c.danger);
    });
  }

  it('fully constrained is dark on light and light on dark', () => {
    const lum = (hex: string) => {
      const n = Number.parseInt(hex.slice(1), 16);
      return ((n >> 16) & 255) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11;
    };
    expect(lum(entityColor(OVERLAY_COLORS.light, 'fixed', false))).toBeLessThan(40);
    expect(lum(entityColor(OVERLAY_COLORS.dark, 'fixed', false))).toBeGreaterThan(215);
  });

  it('partial lies between under-constrained and fully constrained', () => {
    const c = OVERLAY_COLORS.light;
    const p = entityColor(c, 'partial', false);
    expect(p).not.toBe(c.underConstrained);
    expect(p).not.toBe(c.fullyConstrained);
    expect(p).toBe(mixHex(c.underConstrained, c.fullyConstrained, 0.45));
  });
});

describe('mixHex', () => {
  it('interpolates per channel', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#102030', '#304050', 0.5)).toBe('#203040');
  });
});
