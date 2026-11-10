/**
 * What the radial menu offers (PLAN 9.4, ADR-049): at most seven items by selection type, plus the
 * fixed Repeat slot the menu draws itself. Pure: the lazy layer adds labels and icons.
 *
 * Ids are the app's: a model tool id (`pushPull`), a bubble action (`cut`, `section`), a view
 * action (`fit`, `iso`, `undo`, `redo`) or, in a sketch, `sketch:<tool>` and `sketch:finish`.
 */

import type { PickKind } from '@wren-cad/contracts';

export interface RadialSelection {
  kind: PickKind;
  /** Faces: flat. */
  planar?: boolean;
}

export const MAX_RADIAL_ITEMS = 7;

/** Model mode, by what is selected. */
export function modelRadialIds(sel: readonly RadialSelection[]): string[] {
  if (sel.length === 0) return ['sketch', 'measure', 'section', 'fit', 'iso', 'undo', 'redo'];
  const all = (k: PickKind) => sel.every((s) => s.kind === k);
  const planar = sel.every((s) => s.planar === true);
  if (all('region')) return ['extrude', 'cut', 'revolve', 'sweep'];
  if (all('edge')) return ['fillet', 'chamfer', 'measure'];
  if (all('vertex')) return ['measure', 'plane', 'axis', 'point'];
  if (all('face')) {
    if (sel.length === 1)
      return planar
        ? ['sketch', 'pushPull', 'hole', 'shell', 'draft', 'measure', 'section']
        : ['thread', 'shell', 'draft', 'measure'];
    return planar ? ['pushPull', 'shell', 'draft', 'measure'] : ['shell', 'draft', 'measure'];
  }
  return ['measure', 'fit', 'undo', 'redo'];
}

/** Sketch mode: the drawing tools, then Dimension and Finish. */
export function sketchRadialIds(): string[] {
  return [
    'sketch:line',
    'sketch:circle',
    'sketch:arc',
    'sketch:rectangle',
    'sketch:dimension',
    'sketch:splineThrough',
    'sketch:finish',
  ];
}

/** The tool a sketch radial id starts (null for Finish). */
export function sketchToolOf(id: string): string | null {
  return id.startsWith('sketch:') && id !== 'sketch:finish' ? id.slice('sketch:'.length) : null;
}
