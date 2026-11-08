import type { Expr, Material } from '@whittle/contracts';

/** One entry of the built-in (or user) material library. */
export interface MaterialLibraryItem {
  libraryId: string;
  name: string;
  /** Group heading: "Steel", "Aluminium", "Plastic", "Wood"… */
  category: string;
  /** Density expression with units, e.g. `"2.70 g/cm^3"`. */
  density: Expr;
  /** Swatch colour (CSS hex). */
  appearance?: string;
}

export const toMaterial = (m: MaterialLibraryItem): Material => ({
  libraryId: m.libraryId,
  name: m.name,
  density: m.density,
  appearance: m.appearance,
});

export const SWATCHES = [
  '#9aa4b2',
  '#c9ced6',
  '#b08d57',
  '#d6b25e',
  '#6f8fb0',
  '#7b6ad4',
  '#c4575a',
  '#8c6b4a',
  '#4a5a6a',
  '#e8e4da',
] as const;
