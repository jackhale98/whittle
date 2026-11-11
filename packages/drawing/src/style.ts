/**
 * Style and standard presets for new drawings (ADR-090 §3.2). The full style is copied into the
 * drawing at creation and stored, so changing a preset here never changes an existing drawing.
 * ISO values: ADR-055 (1 mm extension gap, 1.5 mm overshoot), ISO 128-2 line group 0.5, ISO 3098
 * heights. ASME values: Y14.2 (0.6/0.3 lines, 3 mm lettering) and Y14.5 spacing in mm. Provisional
 * (secondary sources, owner D9).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DrawingStandard, DrawingStyle } from '@wren-cad/contracts';

export type StandardFamily = DrawingStandard['family'];

const ISO_STYLE: DrawingStyle = {
  lineGroup: 'iso-0.5',
  text: { dimension: 3.5, note: 3.5, viewLabel: 5, title: 7 },
  font: 'osifont',
  dimension: {
    extensionGap: 1,
    extensionOvershoot: 1.5,
    arrow: { kind: 'filledClosed', length: 3, angle: 30 },
    firstLane: 10,
    laneSpacing: 7,
    textOrientation: 'aligned',
    textPosition: 'above',
  },
  numbers: {
    decimal: '.',
    lengthPrecision: 2,
    anglePrecision: 1,
    trailingZeros: 'strip',
    angleFormat: 'decimal',
  },
  hatch: { pattern: 'iso-general', angle: 45, spacing: 2.5 },
  view: {
    lines: 'visible',
    tangentEdges: 'off',
    centerMarks: true,
    centerLines: true,
    threads: true,
  },
};

const ASME_STYLE: DrawingStyle = {
  lineGroup: 'asme-0.6',
  text: { dimension: 3, note: 3, viewLabel: 6, title: 6 },
  font: 'osifont',
  dimension: {
    extensionGap: 1.5,
    extensionOvershoot: 3,
    // Arrowhead width:length 1:3 (Y14.2) → included angle 2·atan(1/6) ≈ 19°.
    arrow: { kind: 'filledClosed', length: 3, angle: 19 },
    firstLane: 10,
    laneSpacing: 6,
    textOrientation: 'unidirectional',
    textPosition: 'inline',
  },
  numbers: {
    decimal: '.',
    lengthPrecision: 2,
    anglePrecision: 1,
    trailingZeros: 'strip',
    angleFormat: 'decimal',
  },
  hatch: { pattern: 'iso-general', angle: 45, spacing: 3 },
  view: {
    lines: 'visible',
    tangentEdges: 'off',
    centerMarks: true,
    centerLines: true,
    threads: true,
  },
};

/** A fresh copy of the preset style (callers store it in the drawing). */
export function stylePreset(family: StandardFamily): DrawingStyle {
  return structuredClone(family === 'iso' ? ISO_STYLE : ASME_STYLE);
}

/** The default standard for a family (D10 asks the user once; this is what the chooser offers). */
export function standardPreset(family: StandardFamily): DrawingStandard {
  return family === 'iso'
    ? {
        family: 'iso',
        gps: 'ISO 1101:2017',
        surfaceFinish: 'ISO 21920-1:2021',
        generalTolerance: 'ISO 2768-mK',
      }
    : { family: 'asme', gps: 'ASME Y14.5-2018', surfaceFinish: 'ASME Y14.36-2018' };
}

/** Rounds every sheet-space number to 0.001 mm, as the store does (quiet diffs, ADR-090 §3.2). */
export function roundStyle(style: DrawingStyle): DrawingStyle {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'number') return Number.isInteger(v) ? v : r(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(style) as DrawingStyle;
}
