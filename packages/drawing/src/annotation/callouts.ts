/**
 * Text lines and small layouts for datum feature symbols, surface texture symbols, hole callouts,
 * chamfer callouts and notes (ISO 1101, ISO 21920-1, ASME Y14.5 presentation; provisional,
 * secondary sources, owner D9). Pure and worker-safe.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SurfaceFinishAnnotation, SurfaceLay, Vec2 } from '@wren-cad/contracts';
import type { Primitive } from './display';
import { layoutLines, layoutRuns, runsWidth, type TextBlock } from './label-layout';
import { formatAngle, formatLength, type NumberStyle } from './numbers';
import { placeSymbol, SURFACE_SYMBOL, type SymbolId } from './symbols';
import { dimensionLabel, labelText, type TextRun, type ToleranceValue } from './tolerance';

// ---------------------------------------------------------------------------------------------
// Datum feature symbol
// ---------------------------------------------------------------------------------------------

/**
 * The datum letter in its square frame (2h high, at least 2h wide). Origin at the middle of the
 * frame's bottom edge, where the leader to the datum triangle starts.
 */
export function layoutDatumBox(label: string, h: number): TextBlock & { attention: boolean } {
  const H = 2 * h;
  const text = label || '?';
  const tw = runsWidth([{ kind: 'text', text }], h);
  const w = Math.max(H, tw + h);
  const prims: Primitive[] = [
    {
      kind: 'polyline',
      closed: true,
      points: [
        [-w / 2, 0],
        [w / 2, 0],
        [w / 2, H],
        [-w / 2, H],
      ],
    },
    ...layoutRuns([{ kind: 'text', text }], [-tw / 2, (H - h) / 2], h).prims,
  ];
  return { prims, width: w, box: { min: [-w / 2, 0], max: [w / 2, H] }, attention: !label };
}

// ---------------------------------------------------------------------------------------------
// Surface texture
// ---------------------------------------------------------------------------------------------

const LAY_RUNS: Record<SurfaceLay, TextRun> = {
  parallel: { kind: 'text', text: '=' },
  perpendicular: { kind: 'symbol', id: 'layPerpendicular' },
  crossed: { kind: 'text', text: 'X' },
  multiDirectional: { kind: 'text', text: 'M' },
  circular: { kind: 'text', text: 'C' },
  radial: { kind: 'text', text: 'R' },
  particulate: { kind: 'text', text: 'P' },
};

/** Evaluated surface texture values (mm); a missing entry = the expression failed (`?`). */
export interface SurfaceValues {
  requirements: (number | undefined)[];
  allowance?: number;
}

/** One requirement line, e.g. `Ra 1.6`, `L Ra 0.8`, `0.8/Rz 6.3`, `Ra max 1.6` (ISO 1302 rule). */
export function surfaceRequirementText(
  a: SurfaceFinishAnnotation,
  index: number,
  valueMm: number | undefined,
  numbers: NumberStyle,
): string {
  const r = a.requirements[index];
  if (!r) return '';
  const std = a.standard ?? 'ISO 21920-1:2021';
  const both = a.requirements.some((q) => q.limit === 'lower');
  const limit = r.limit === 'lower' ? 'L ' : both ? 'U ' : '';
  // Only the non-default acceptance rule is written (ISO 21920-1 default: max; ISO 1302: 16 %).
  let rule = '';
  if (std === 'ISO 1302:2002' && r.acceptance === 'max') rule = 'max';
  if (std !== 'ISO 1302:2002' && r.acceptance === '16%') rule = '16%';
  const um =
    valueMm === undefined
      ? '?'
      : formatLength(valueMm * 1000, { ...numbers, trailingZeros: 'strip' }, { precision: 3 });
  const filter = r.filter ? `${r.filter}/` : '';
  return `${limit}${filter}${r.parameter}${rule ? ` ${rule}` : ''} ${um}`;
}

/**
 * Surface texture symbol with its texts in ISO 21920-1 / ISO 1302 positions: requirements a, b
 * under the extension line right of the long leg, the method c above it, the lay d at the lower
 * right, the allowance e left of the short leg. Origin at the apex (on the surface), y up.
 */
export function layoutSurfaceFinish(
  a: SurfaceFinishAnnotation,
  values: SurfaceValues,
  numbers: NumberStyle,
  h: number,
): TextBlock & { attention: boolean } {
  const id: SymbolId =
    a.process === 'removalRequired'
      ? 'surfaceRemovalRequired'
      : a.process === 'removalProhibited'
        ? 'surfaceRemovalProhibited'
        : 'surfaceBasic';
  const prims = placeSymbol(id, [0, 0], h);
  const { long, short, legX } = SURFACE_SYMBOL;
  const top: Vec2 = [legX(long) * h, long * h];
  const reqs = a.requirements.map((_, i) =>
    surfaceRequirementText(a, i, values.requirements[i], numbers),
  );
  const attention =
    values.requirements.some((v, i) => v === undefined && a.requirements[i]) ||
    (a.allowance !== undefined && values.allowance === undefined);
  const x0 = top[0] + 0.3 * h;
  const lines = reqs.map((t) => [{ kind: 'text', text: t }] as TextRun[]);
  const below = layoutLines(lines, [x0, top[1] - 1.4 * h], h);
  prims.push(...below.prims);
  let width = below.width;
  if (a.method) {
    const m = layoutRuns([{ kind: 'text', text: a.method }], [x0, top[1] + 0.4 * h], h);
    prims.push(...m.prims);
    width = Math.max(width, m.width);
  }
  // The extension line exists once there is something to write on it.
  if (width > 0) prims.push({ kind: 'line', a: top, b: [x0 + width + 0.3 * h, top[1]] });
  if (a.allAround) prims.push(...placeSymbol('allAround', top, h));
  if (a.lay) {
    prims.push(...layoutRuns([LAY_RUNS[a.lay]], [legX(1.2) * h + 0.5 * h, 0.15 * h], h).prims);
  }
  let minX = -legX(short) * h;
  if (a.allowance !== undefined) {
    const t = values.allowance === undefined ? '?' : formatLength(values.allowance, numbers);
    const w = runsWidth([{ kind: 'text', text: t }], h);
    const ex = -legX(short) * h - 0.4 * h - w;
    prims.push(...layoutRuns([{ kind: 'text', text: t }], [ex, 0.4 * h], h).prims);
    minX = ex;
  }
  const maxX = Math.max(top[0], x0 + width + 0.3 * h);
  return {
    prims,
    width: maxX - minX,
    box: {
      min: [minX, Math.min(0, below.box.min[1])],
      max: [maxX, top[1] + (a.method ? 1.4 * h : 0)],
    },
    attention,
  };
}

// ---------------------------------------------------------------------------------------------
// Hole callouts
// ---------------------------------------------------------------------------------------------

/** Hole data for a callout, evaluated (mm, rad) from the `HoleFeature` / `ThreadFeature`. */
export interface HoleCalloutData {
  /** Instances including pattern copies (`AnnotationResolution.instances`). */
  count: number;
  kind: 'simple' | 'counterbore' | 'countersink' | 'tapped' | 'thread';
  /** Hole (drill) diameter. Absent for a cosmetic thread on a shaft. */
  diameter?: number;
  depth?: number | 'thru';
  /** Thread designation (`M6`, `M6x0.75`, `1/4-20 UNC`) and its class (`6H`). */
  thread?: { designation: string; class?: string; depth?: number | 'thru' };
  counterbore?: { diameter: number; depth: number };
  countersink?: { diameter: number; angle: number };
  /** Tolerance on the hole diameter (fits included). */
  tolerance?: ToleranceValue;
}

export interface HoleCalloutShow {
  count?: boolean;
  depth?: boolean;
  thread?: boolean;
  counterbore?: boolean;
  countersink?: boolean;
}

/**
 * The callout's lines (ASME Y14.5 / ISO 15786-style; provisional): `4× M6-6H ↧12`,
 * `Ø5 ↧15`, `⌴ Ø11 ↧6.8`, `⌵ Ø12 × 90°`, `THRU` for through holes.
 */
export function holeCalloutLines(
  data: HoleCalloutData,
  numbers: NumberStyle,
  show: HoleCalloutShow = {},
): TextRun[][] {
  const on = (k: keyof HoleCalloutShow) => show[k] !== false;
  const len = (x: number) => formatLength(x, numbers);
  const depthRuns = (d: number | 'thru' | undefined): TextRun[] => {
    if (d === undefined || !on('depth')) return [];
    if (d === 'thru') return [{ kind: 'text', text: ' THRU' }];
    return [
      { kind: 'symbol', id: 'depth' },
      { kind: 'text', text: len(d) },
    ];
  };
  const count: TextRun[] =
    on('count') && data.count > 1 ? [{ kind: 'text', text: `${data.count}× ` }] : [];
  const sizeText = (d: number) =>
    labelText(
      dimensionLabel({
        value: d,
        quantity: 'length',
        size: 'diameter',
        tolerance: data.tolerance,
        numbers,
      }),
    );
  const lines: TextRun[][] = [];
  if ((data.kind === 'tapped' || data.kind === 'thread') && data.thread && on('thread')) {
    const t = data.thread;
    lines.push([
      ...count,
      { kind: 'text', text: `${t.designation}${t.class ? `-${t.class}` : ''}` },
      ...depthRuns(t.depth),
    ]);
    if (data.diameter !== undefined && data.kind === 'tapped')
      lines.push([{ kind: 'text', text: sizeText(data.diameter) }, ...depthRuns(data.depth)]);
  } else if (data.diameter !== undefined) {
    lines.push([
      ...count,
      { kind: 'text', text: sizeText(data.diameter) },
      ...depthRuns(data.depth),
    ]);
  }
  if (data.counterbore && on('counterbore')) {
    lines.push([
      { kind: 'symbol', id: 'counterbore' },
      { kind: 'text', text: `Ø${len(data.counterbore.diameter)}` },
      { kind: 'symbol', id: 'depth' },
      { kind: 'text', text: len(data.counterbore.depth) },
    ]);
  }
  if (data.countersink && on('countersink')) {
    lines.push([
      { kind: 'symbol', id: 'countersink' },
      {
        kind: 'text',
        text: `Ø${len(data.countersink.diameter)} × ${formatAngle(data.countersink.angle, numbers)}`,
      },
    ]);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Chamfers and notes
// ---------------------------------------------------------------------------------------------

/** `2 × 45°` (distance × angle) or `2 × 3` (two distances). */
export function chamferText(
  form: 'distanceAngle' | 'twoDistances',
  values: { distance?: number; angle?: number; distance2?: number },
  numbers: NumberStyle,
): string {
  const d = values.distance === undefined ? '?' : formatLength(values.distance, numbers);
  if (form === 'distanceAngle') {
    const a = values.angle === undefined ? '?' : formatAngle(values.angle, numbers);
    return `${d} × ${a}`;
  }
  const d2 = values.distance2 === undefined ? '?' : formatLength(values.distance2, numbers);
  return `${d} × ${d2}`;
}

/** A note's lines (after `{slot}` resolution). */
export function noteLines(text: string): TextRun[][] {
  return text.split('\n').map((t) => [{ kind: 'text', text: t }]);
}
