/**
 * Feature control frame layout (ISO 1101:2017 / ASME Y14.5-2018 presentation; provisional,
 * secondary sources, owner D9). One row: the characteristic cell (square, frame height 2h), the
 * tolerance cell (zone shape, value, per-unit refinement, modifiers), then up to three datum
 * cells. Origin at the frame's bottom-left corner, sheet mm. Composite frames are refused until
 * P2 (ADR-090 Q1); the contract has no segments, so there is nothing to lay out for them.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  DatumCompartment,
  DatumRef,
  GeometricToleranceAnnotation,
  GpsStandard,
  MaterialCondition,
  ZoneModifier,
} from '@wren-cad/contracts';
import type { Primitive } from './display';
import { layoutRuns, runsWidth, type TextBlock } from './label-layout';
import { formatLength, type NumberStyle } from './numbers';
import { placeSymbol, type SymbolId, symbolGlyph } from './symbols';
import type { TextRun } from './tolerance';

/** Zone numbers, evaluated (mm). Absent value = the expression failed: shown as `?`. */
export interface ZoneValues {
  value?: number;
  projected?: number;
  unequal?: number;
  perUnit?: { value: number; length: number; width?: number };
}

export interface FrameInput {
  annotation: GeometricToleranceAnnotation;
  zone: ZoneValues;
  /** Letter of a datum reference; undefined = the datum it names no longer exists (`?`). */
  datumLabel: (ref: DatumRef) => string | undefined;
  /** The displaying drawing's standard (ISO writes UZ/CZ/SZ as text; ASME uses Ⓤ and ⬡ST). */
  standard: GpsStandard;
  numbers: NumberStyle;
  /** Text height h, sheet mm. */
  h: number;
}

export interface FrameCell {
  kind: 'characteristic' | 'tolerance' | 'datum';
  x: number;
  width: number;
}

export interface FrameLayout extends TextBlock {
  height: number;
  cells: FrameCell[];
  /** True when something in the frame could not be shown truthfully (`?` drawn). */
  incomplete: boolean;
}

const MATERIAL: Record<MaterialCondition, SymbolId> = { mmc: 'mmc', lmc: 'lmc' };

/** Zone modifiers that are text under ISO 1101 and symbols under ASME (or text in both). */
function modifierRuns(m: ZoneModifier, iso: boolean): TextRun[] {
  switch (m) {
    case 'freeState':
      return [{ kind: 'symbol', id: 'freeState' }];
    case 'tangentPlane':
      return [{ kind: 'symbol', id: 'tangentPlane' }];
    case 'statistical':
      return iso ? [{ kind: 'text', text: 'ST' }] : [{ kind: 'symbol', id: 'statistical' }];
    case 'combinedZone':
      return [{ kind: 'text', text: 'CZ' }];
    case 'separateZones':
      return [{ kind: 'text', text: 'SZ' }];
  }
}

const space: TextRun = { kind: 'text', text: ' ' };

/** The tolerance cell's runs, in ISO 1101 order (shape, size, refinements, modifiers). */
export function toleranceRuns(input: FrameInput): { runs: TextRun[]; incomplete: boolean } {
  const { annotation: a, zone, numbers } = input;
  const iso = input.standard.startsWith('ISO');
  const fmt = (x: number) => formatLength(x, numbers);
  const runs: TextRun[] = [];
  let incomplete = false;
  if (a.zone.shape === 'diameter') runs.push({ kind: 'text', text: 'Ø' });
  if (a.zone.shape === 'sphericalDiameter') runs.push({ kind: 'text', text: 'SØ' });
  if (zone.value === undefined) {
    runs.push({ kind: 'text', text: '?' });
    incomplete = true;
  } else runs.push({ kind: 'text', text: fmt(zone.value) });
  if (a.zone.perUnit) {
    const pu = zone.perUnit;
    if (!pu) {
      runs.push({ kind: 'text', text: '/?' });
      incomplete = true;
    } else {
      // The refinement `0.05/100` (or `/100×100` for an area) follows the overall zone value
      // (ISO stacks the two; one line here, provisional).
      const area = pu.width !== undefined ? `×${fmt(pu.width)}` : '';
      runs.push(space, { kind: 'text', text: `${fmt(pu.value)}/${fmt(pu.length)}${area}` });
    }
  }
  if (a.zone.unequal !== undefined) {
    const v = zone.unequal === undefined ? '?' : fmt(zone.unequal);
    if (zone.unequal === undefined) incomplete = true;
    if (iso) runs.push(space, { kind: 'text', text: `UZ${v.startsWith('-') ? '' : '+'}${v}` });
    else runs.push(space, { kind: 'symbol', id: 'unequal' }, { kind: 'text', text: v });
  }
  for (const m of a.zone.modifiers ?? []) runs.push(space, ...modifierRuns(m, iso));
  if (a.zone.material) runs.push(space, { kind: 'symbol', id: MATERIAL[a.zone.material] });
  if (a.zone.projected !== undefined) {
    const v = zone.projected === undefined ? '?' : fmt(zone.projected);
    if (zone.projected === undefined) incomplete = true;
    runs.push(space, { kind: 'symbol', id: 'projected' }, { kind: 'text', text: v });
  }
  return { runs: tidy(runs), incomplete };
}

/** Joins adjacent text runs and drops spaces next to symbols (symbols carry their own gap). */
function tidy(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  runs.forEach((r, i) => {
    const prev = out[out.length - 1];
    const next = runs[i + 1];
    if (r.kind === 'text' && r.text === ' ' && (prev?.kind === 'symbol' || next?.kind === 'symbol'))
      return;
    if (r.kind === 'text' && prev?.kind === 'text')
      out[out.length - 1] = { kind: 'text', text: prev.text + r.text };
    else out.push(r);
  });
  return out;
}

/** A datum compartment's runs: `A`, `A-B` (common datum), then its material condition. */
export function datumRuns(
  c: DatumCompartment,
  datumLabel: (ref: DatumRef) => string | undefined,
): { runs: TextRun[]; incomplete: boolean } {
  let incomplete = false;
  const letters = c.datums.map((d) => {
    const l = datumLabel(d);
    if (l === undefined || l === '') incomplete = true;
    return l || '?';
  });
  const runs: TextRun[] = [{ kind: 'text', text: letters.join('-') }];
  if (c.material) runs.push({ kind: 'symbol', id: MATERIAL[c.material] });
  return { runs, incomplete };
}

/** Lays out one feature control frame (origin bottom-left). */
export function layoutFrame(input: FrameInput): FrameLayout {
  const { h, annotation: a } = input;
  const H = 2 * h;
  const pad = 0.5 * h;
  const baseline = (H - h) / 2;
  const prims: Primitive[] = [];
  const cells: FrameCell[] = [];
  let x = 0;

  // Characteristic: a square cell with the symbol centred.
  const sym = symbolGlyph(a.characteristic);
  const symW = sym.advance * h;
  prims.push(...placeSymbol(a.characteristic, [(H - symW) / 2, baseline], h));
  cells.push({ kind: 'characteristic', x, width: H });
  x += H;

  const tol = toleranceRuns(input);
  let incomplete = tol.incomplete;
  const tolW = Math.max(H, runsWidth(tol.runs, h) + 2 * pad);
  prims.push(...layoutRuns(tol.runs, [x + pad, baseline], h).prims);
  cells.push({ kind: 'tolerance', x, width: tolW });
  x += tolW;

  for (const c of (a.datums ?? []).slice(0, 3)) {
    const d = datumRuns(c, input.datumLabel);
    incomplete ||= d.incomplete;
    const w = Math.max(H, runsWidth(d.runs, h) + 2 * pad);
    const tw = runsWidth(d.runs, h);
    prims.push(...layoutRuns(d.runs, [x + (w - tw) / 2, baseline], h).prims);
    cells.push({ kind: 'datum', x, width: w });
    x += w;
  }

  // Outline and cell dividers.
  prims.push({
    kind: 'polyline',
    closed: true,
    points: [
      [0, 0],
      [x, 0],
      [x, H],
      [0, H],
    ],
  });
  for (const c of cells.slice(1)) prims.push({ kind: 'line', a: [c.x, 0], b: [c.x, H] });

  let top = H;
  let bottom = 0;
  if (a.text?.above) {
    prims.push(...layoutRuns([{ kind: 'text', text: a.text.above }], [0, H + 0.5 * h], h).prims);
    top = H + 1.5 * h;
  }
  if (a.text?.below) {
    prims.push(...layoutRuns([{ kind: 'text', text: a.text.below }], [0, -1.5 * h], h).prims);
    bottom = -1.75 * h;
  }
  return {
    prims,
    width: x,
    height: H,
    cells,
    incomplete,
    box: { min: [0, bottom], max: [x, top] },
  };
}
