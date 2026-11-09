/** Viewport palettes (CSS hex, sRGB). Calm, product-render look: cool neutral greys. */

export interface Palette {
  background: string;
  body: string;
  edge: string;
  grid: string;
  gridMajor: string;
  axisX: string;
  axisY: string;
  /** Contact shadow darkness 0-1. */
  shadow: number;
  /** Environment light multiplier. */
  envIntensity: number;
  keyLight: number;
}

export const PALETTES: Readonly<Record<'light' | 'dark', Palette>> = {
  light: {
    background: '#eceff3',
    body: '#b4bdc9',
    edge: '#262d38',
    grid: '#9aa4b2',
    gridMajor: '#7b8696',
    axisX: '#d9534f',
    axisY: '#3f9a63',
    shadow: 0.42,
    envIntensity: 0.62,
    keyLight: 0.5,
  },
  dark: {
    background: '#14171c',
    body: '#8d97a6',
    edge: '#05070a',
    grid: '#5d6674',
    gridMajor: '#8791a1',
    axisX: '#e0605c',
    axisY: '#52b27a',
    shadow: 0.6,
    envIntensity: 0.65,
    keyLight: 0.9,
  },
};

/**
 * Selection / sketch / chrome colours. Mirrors the `@wren-cad/ui` design tokens (kept as a local
 * copy so the lazy viewport chunk does not pull in the UI package; `test/themes.test.ts` asserts
 * parity with `colors` from `@wren-cad/ui`).
 */
export interface OverlayColors {
  accent: string;
  accentFg: string;
  underConstrained: string;
  fullyConstrained: string;
  danger: string;
  surface: string;
  surface2: string;
  border: string;
  borderStrong: string;
  fg: string;
  fgMuted: string;
}

export const OVERLAY_COLORS: Readonly<Record<'light' | 'dark', OverlayColors>> = {
  light: {
    accent: '#0b5fe8',
    accentFg: '#ffffff',
    underConstrained: '#2f6df6',
    fullyConstrained: '#111827',
    danger: '#d0281c',
    surface: '#ffffff',
    surface2: '#f3f5f9',
    border: '#d9dfe9',
    borderStrong: '#76839a',
    fg: '#0f1729',
    fgMuted: '#46536b',
  },
  dark: {
    accent: '#5b9bff',
    accentFg: '#04132e',
    underConstrained: '#5b8dff',
    fullyConstrained: '#f4f6fb',
    danger: '#ff6b5e',
    surface: '#171b25',
    surface2: '#1f2430',
    border: '#2b3243',
    borderStrong: '#6e7a93',
    fg: '#e8ecf4',
    fgMuted: '#a5b0c5',
  },
};

/** Marker tones (`Marker.tone`); accent/muted/error mirror the overlay tokens, warning is amber. */
export type MarkerTones = Readonly<Record<'accent' | 'muted' | 'warning' | 'error', string>>;

export const MARKER_TONES: Readonly<Record<'light' | 'dark', MarkerTones>> = {
  light: {
    accent: OVERLAY_COLORS.light.accent,
    muted: OVERLAY_COLORS.light.borderStrong,
    warning: '#c27c00',
    error: OVERLAY_COLORS.light.danger,
  },
  dark: {
    accent: OVERLAY_COLORS.dark.accent,
    muted: OVERLAY_COLORS.dark.borderStrong,
    warning: '#ffb938',
    error: OVERLAY_COLORS.dark.danger,
  },
};
