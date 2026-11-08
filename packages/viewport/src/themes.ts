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
