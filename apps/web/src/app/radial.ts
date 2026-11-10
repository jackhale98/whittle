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

/** The radial item that groups the features picked in the tree into a new folder (M3.6). */
export const RADIAL_ADD_FOLDER = 'folder:add';

/**
 * Model mode, by what is selected. `folderable`: several features are picked in the feature tree
 * and they can become one folder. Nothing in the viewport is selected then, so the menu leads with
 * "Add to new folder". The radial has no room for a reason, so when the picks cannot be grouped
 * (not a contiguous run, already in a folder) the item is left out; the tree's menu and the
 * palette name the reason.
 */
export function modelRadialIds(
  sel: readonly RadialSelection[],
  opts: { folderable?: boolean } = {},
): string[] {
  if (sel.length === 0 && opts.folderable)
    return [RADIAL_ADD_FOLDER, 'measure', 'section', 'fit', 'iso', 'undo', 'redo'];
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
