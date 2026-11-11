/**
 * `@wren-cad/drawing/dxf`: the in-house DXF writer (owner D4, no dependency), one sheet per
 * file, sheet mm: `renderDxf(list, style, { profile: 'r12' })` for the CNC-safe R12 profile,
 * `'r2000'` for the full one with handles, lineweights and `$INSUNITS = 4`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DrawingStyle } from '@wren-cad/contracts';
import type { DisplayList } from '../annotation/display';
import { type DxfR12Options, renderDxfR12 } from './r12';
import { type DxfR2000Options, renderDxfR2000 } from './r2000';

export * from './common';
export * from './r12';
export * from './r2000';

export type DxfProfile = 'r12' | 'r2000';

export function renderDxf(
  list: DisplayList,
  style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>,
  options: { profile: DxfProfile } & DxfR12Options & DxfR2000Options,
): string {
  return options.profile === 'r12'
    ? renderDxfR12(list, style, options)
    : renderDxfR2000(list, style, options);
}
