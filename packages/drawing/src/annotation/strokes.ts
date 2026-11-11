/**
 * Line roles → width and line type, the one mapping SVG, PDF and DXF share (ADR-090 §3.2):
 * visible, frame and cutting-plane ends thick; hidden, centre, dimension, hatch and the rest thin.
 * Widths come from the ISO 128-2 line groups (thick:thin = 2:1) or the ASME Y14.2 preset
 * (0.6/0.3); dash lengths follow ISO 128-2 in multiples of the line width d (provisional,
 * secondary sources, owner D9).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DrawingStyle, LineGroupId } from '@wren-cad/contracts';
import type { LineType, StrokeRole } from './display';

export const LINE_GROUPS: Readonly<Record<LineGroupId, { thick: number; thin: number }>> = {
  'iso-0.25': { thick: 0.25, thin: 0.13 },
  'iso-0.35': { thick: 0.35, thin: 0.18 },
  'iso-0.5': { thick: 0.5, thin: 0.25 },
  'iso-0.7': { thick: 0.7, thin: 0.35 },
  'asme-0.6': { thick: 0.6, thin: 0.3 },
};

export function lineWidths(style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>): {
  thick: number;
  thin: number;
} {
  return style.lineWidths ?? LINE_GROUPS[style.lineGroup];
}

export interface Stroke {
  /** Line width, sheet mm. */
  width: number;
  type: LineType;
  /** Dash pattern (on, off, on, off …), sheet mm; empty = continuous. */
  dash: number[];
}

const THICK_ROLES: ReadonlySet<StrokeRole> = new Set(['visible', 'cuttingPlaneEnd', 'frame']);

export function roleLineType(role: StrokeRole): LineType {
  if (role === 'hidden') return 'dashed';
  if (role === 'center' || role === 'cuttingPlane') return 'center';
  return 'continuous';
}

/** ISO 128-2 patterns in multiples of d: 02 dashed 12d/3d; 04 long-dash dot 24d/3d/0.5d/3d. */
export function dashPattern(type: LineType, d: number): number[] {
  if (type === 'dashed') return [12 * d, 3 * d];
  if (type === 'center') return [24 * d, 3 * d, 0.5 * d, 3 * d];
  return [];
}

/** The drawing frame's width: ISO 5457 asks for 0.7 mm; ASME sheets use the thick line. */
export function frameWidth(style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>): number {
  const { thick } = lineWidths(style);
  return style.lineGroup.startsWith('iso') ? Math.max(0.7, thick) : thick;
}

export function roleStroke(
  role: StrokeRole,
  style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>,
): Stroke {
  const w = lineWidths(style);
  const width = role === 'frame' ? frameWidth(style) : THICK_ROLES.has(role) ? w.thick : w.thin;
  const type = roleLineType(role);
  return { width, type, dash: dashPattern(type, width) };
}
