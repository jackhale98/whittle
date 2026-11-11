// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `resolveHoleSize`: turns a hole's standard, size, fit and kind into the diameters and depths the
 * kernel drills (and a drawing's hole callout prints). Split from `hole-tables.ts` so the tables,
 * which the initial route needs, do not carry the resolver, which only the regen worker and the
 * drawing route use (ADR-092). All lengths are millimetres.
 */

import type { HoleFit, HoleSizeRow, HoleStandard } from '@wren-cad/contracts';
import { available, holeRow } from './hole-tables';

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

export interface HoleSizeInput {
  standard: HoleStandard;
  kind: 'simple' | 'counterbore' | 'countersink' | 'tapped';
  size: string;
  fit: HoleFit;
  /** Explicit diameter override (mm), already evaluated. */
  diameter?: number;
  counterbore?: { diameter?: number; depth?: number };
  /** `angle` in radians (an evaluated expression). */
  countersink?: { diameter?: number; angle?: number };
}

export interface ResolvedHoleSize {
  /** Clearance diameter, or the tap drill for tapped holes (mm). */
  diameter: number;
  counterbore?: { diameter: number; depth: number };
  /** `angle` in radians (included angle). */
  countersink?: { diameter: number; angle: number };
  /** Tapped holes: major diameter and pitch (mm) of the cosmetic thread. */
  thread?: { nominal: number; pitch: number };
  /** The table row used, when the size is in the table. */
  row?: HoleSizeRow;
}

export type HoleSizeResult =
  | { ok: true; value: ResolvedHoleSize }
  | { ok: false; message: string; hint: string; field: string };

const DEG = Math.PI / 180;

/**
 * Hole dimensions from the table, with explicit values overriding it: `diameter` overrides the
 * clearance (or tap drill), `counterbore` / `countersink` fields override theirs. A value the table
 * does not have for this size (e.g. a countersink for M24) must be given explicitly; it is never
 * extrapolated.
 */
export function resolveHoleSize(input: HoleSizeInput): HoleSizeResult {
  const row = holeRow(input.standard, input.size);
  const label = `${input.standard} ${input.size}`;
  const fail = (field: string, message: string, hint: string): HoleSizeResult => ({
    ok: false,
    message,
    hint,
    field,
  });
  const positive = (v: number | undefined) => v !== undefined && Number.isFinite(v) && v > 0;
  if (input.diameter !== undefined && !positive(input.diameter)) {
    return fail('/diameter', 'The hole diameter must be greater than zero', 'Enter a diameter.');
  }
  if (!row && input.diameter === undefined) {
    return fail(
      '/size',
      `${label} is not in the ${input.standard} hole table`,
      `Pick a size from the table, or enter a diameter.`,
    );
  }
  let diameter: number;
  if (input.diameter !== undefined) diameter = input.diameter;
  else {
    const r = row as HoleSizeRow;
    diameter = input.kind === 'tapped' ? r.tap.drill : r.clearance[input.fit];
  }
  const out: ResolvedHoleSize = { diameter };
  if (row) out.row = row;
  if (input.kind === 'tapped') {
    if (!row) {
      return fail(
        '/size',
        `${label} is not in the ${input.standard} thread table`,
        'Pick a thread size from the table.',
      );
    }
    out.thread = { nominal: row.nominal, pitch: row.tap.pitch };
  }
  if (input.kind === 'counterbore') {
    const d = input.counterbore?.diameter ?? row?.counterbore.diameter;
    const depth = input.counterbore?.depth ?? row?.counterbore.depth;
    if (d === undefined || !available(d)) {
      return fail(
        '/counterbore/diameter',
        `The ${input.standard} table has no counterbore for ${input.size}`,
        'Enter the counterbore diameter.',
      );
    }
    if (depth === undefined || !available(depth) || !(depth > 0)) {
      return fail(
        '/counterbore/depth',
        'The counterbore depth must be greater than zero',
        'Enter the counterbore depth.',
      );
    }
    if (!(d > diameter)) {
      return fail(
        '/counterbore/diameter',
        `The counterbore (${fmt(d)} mm) must be wider than the hole (${fmt(diameter)} mm)`,
        'Increase the counterbore diameter or reduce the hole diameter.',
      );
    }
    out.counterbore = { diameter: d, depth };
  }
  if (input.kind === 'countersink') {
    const d = input.countersink?.diameter ?? row?.countersink.diameter;
    const angle = input.countersink?.angle ?? (row ? row.countersink.angle * DEG : undefined);
    if (d === undefined || !available(d)) {
      return fail(
        '/countersink/diameter',
        `The ${input.standard} table has no countersink for ${input.size}`,
        'Enter the countersink diameter.',
      );
    }
    if (angle === undefined || !(angle > 0 && angle < Math.PI)) {
      return fail(
        '/countersink/angle',
        'The countersink angle must be between 0° and 180°',
        'Enter the countersink angle, e.g. 90°.',
      );
    }
    if (!(d > diameter)) {
      return fail(
        '/countersink/diameter',
        `The countersink (${fmt(d)} mm) must be wider than the hole (${fmt(diameter)} mm)`,
        'Increase the countersink diameter or reduce the hole diameter.',
      );
    }
    out.countersink = { diameter: d, angle };
  }
  return { ok: true, value: out };
}

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}
