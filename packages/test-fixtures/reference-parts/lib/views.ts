/**
 * The view specs the reference drawings share (third-angle projection, ISO-style layout: the top
 * view above the front view). See `DrawingViewSpec`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DrawingViewSpec } from './types';

/** The front view, the base view of a drawing that has a top view below nothing but itself. */
export const FRONT: DrawingViewSpec = {
  id: 'front',
  caption: 'Front',
  kind: 'base',
  orientation: 'front',
  axes: ['X', 'Z'],
};

/** The top view projected from the front view: above it in third angle. */
export const TOP_OF_FRONT: DrawingViewSpec = {
  id: 'top',
  caption: 'Top',
  kind: 'projected',
  orientation: 'top',
  parent: 'front',
  side: 'above',
  axes: ['X', 'Y'],
};

/** The top view as a base view, for drawings whose other view is a section of it. */
export const TOP: DrawingViewSpec = {
  id: 'top',
  caption: 'Top',
  kind: 'base',
  orientation: 'top',
  axes: ['X', 'Y'],
};

/**
 * A full or stepped section of the top view, seen from the front. `cut` is in the top view's drawn
 * coordinates (part X, Y); the viewer looks to the left of the line's direction (+Y for a cut that
 * runs along +X), towards the back, so the front half is removed.
 */
export function frontSection(
  caption: string,
  cut: [number, number][],
  side: 'below' | 'right',
): DrawingViewSpec {
  return {
    id: 'front-section',
    caption,
    kind: 'section',
    orientation: 'front',
    parent: 'top',
    side,
    axes: ['X', 'Z'],
    section: { letter: 'A', cut, look: 'left' },
  };
}
