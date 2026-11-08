/**
 * Measurement readings for the Measure panel (phone sheet, desktop/tablet Inspect tool).
 *
 * Values are the contract's `Measurement` (packages/contracts kernel.ts), exactly as the kernel
 * reports them: mm, mm² and radians. One measurement can carry several quantities (a distance and
 * the angle between two faces; an edge's length and its radius): the reading leads with one and
 * lists the others as extra rows.
 */

import type { Measurement } from '@whittle/contracts';

export type { Measurement };

export type Vec3 = readonly [number, number, number];

/** The quantity a reading leads with (`readMeasurement`). */
export type MeasurementKind = 'distance' | 'angle' | 'length' | 'area' | 'radius' | 'position';

/** A picked thing the measurement is computed from (shown in the panel's "Picked" list). */
export interface MeasureTargetItem {
  id: string;
  /** Human text such as "Face · Top" or "Edge 4". */
  label: string;
  kind?: 'face' | 'edge' | 'vertex' | 'point' | 'body';
}

export type MeasureUnits = 'mm' | 'in';

const MM_PER_IN = 25.4;

const KIND_LABEL: Record<MeasurementKind, string> = {
  distance: 'Distance',
  angle: 'Angle',
  length: 'Length',
  area: 'Area',
  radius: 'Radius',
  position: 'Position',
};

/** The leading quantity: distance, then length, area, radius, angle, position. */
export function measurementKind(m: Measurement): MeasurementKind | null {
  if (m.distance) return 'distance';
  if (m.length !== undefined) return 'length';
  if (m.area !== undefined) return 'area';
  if (m.radius !== undefined) return 'radius';
  if (m.angle !== undefined) return 'angle';
  if (m.position) return 'position';
  return null;
}

const fmt = (n: number, digits: number, grouping = true): string =>
  n
    .toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: grouping,
    })
    .replace('-', '−');

export interface MeasurementExtra {
  label: string;
  value: string;
  unit: string;
}

export interface MeasurementReading {
  kind: MeasurementKind;
  label: string;
  /** Number text with a true minus sign and fixed decimals so columns line up. */
  value: string;
  unit: string;
  /** Extra axis readouts (ΔX/ΔY/ΔZ, or X/Y/Z for a position). */
  parts?: ReadonlyArray<{ axis: string; value: string }>;
  /** Further quantities of the same measurement (the angle beside a distance, radius, Ø). */
  extra?: readonly MeasurementExtra[];
}

/**
 * Formats a measurement for display in `units` (length units only; angles are always degrees).
 * Null for a measurement without any quantity.
 */
export function readMeasurement(
  m: Measurement,
  units: MeasureUnits = 'mm',
): MeasurementReading | null {
  const kind = measurementKind(m);
  if (!kind) return null;
  const len = (mm: number) => fmt(units === 'in' ? mm / MM_PER_IN : mm, units === 'in' ? 4 : 2);
  const area = (mm2: number) =>
    fmt(units === 'in' ? mm2 / (MM_PER_IN * MM_PER_IN) : mm2, units === 'in' ? 4 : 1);
  const deg = (rad: number) => fmt((rad * 180) / Math.PI, 2);

  const extra: MeasurementExtra[] = [];
  if (kind !== 'angle' && m.angle !== undefined)
    extra.push({ label: 'Angle', value: deg(m.angle), unit: '°' });
  if (kind !== 'length' && m.length !== undefined)
    extra.push({ label: 'Length', value: len(m.length), unit: units });
  if (kind !== 'area' && m.area !== undefined)
    extra.push({ label: 'Area', value: area(m.area), unit: `${units}²` });
  if (kind !== 'radius' && m.radius !== undefined)
    extra.push({ label: 'Radius', value: len(m.radius), unit: units });
  if (m.radius !== undefined)
    extra.push({ label: 'Diameter', value: len(2 * m.radius), unit: units });

  const label = KIND_LABEL[kind];
  const base = (value: string, unit: string): MeasurementReading => ({
    kind,
    label,
    value,
    unit,
    ...(extra.length ? { extra } : {}),
  });
  switch (kind) {
    case 'distance': {
      const d = m.distance as NonNullable<Measurement['distance']>;
      return {
        ...base(len(d.value), units),
        parts: (['X', 'Y', 'Z'] as const).map((axis, i) => ({
          axis: `Δ${axis}`,
          value: len((d.b[i] ?? 0) - (d.a[i] ?? 0)),
        })),
      };
    }
    case 'length':
      return base(len(m.length as number), units);
    case 'radius':
      return base(len(m.radius as number), units);
    case 'angle':
      return base(deg(m.angle as number), '°');
    case 'area':
      return base(area(m.area as number), `${units}²`);
    case 'position': {
      const p = m.position as Vec3;
      return {
        ...base(p.map((v) => len(v)).join(', '), units),
        parts: (['X', 'Y', 'Z'] as const).map((axis, i) => ({ axis, value: len(p[i] ?? 0) })),
      };
    }
  }
}

/** Spoken form: "Distance 42.50 millimetres, angle 90.00 degrees". */
export function speakMeasurement(m: Measurement, units: MeasureUnits = 'mm'): string {
  const r = readMeasurement(m, units);
  if (!r) return '';
  const word = (unit: string) =>
    unit === '°'
      ? 'degrees'
      : `${unit.endsWith('²') ? 'square ' : ''}${units === 'in' ? 'inches' : 'millimetres'}`;
  const head =
    r.kind === 'position'
      ? `${r.label} ${r.parts?.map((p) => `${p.axis} ${p.value}`).join(', ')} ${word(r.unit)}`
      : `${r.label} ${r.value} ${word(r.unit)}`;
  const tail = (r.extra ?? []).map((x) => `${x.label.toLowerCase()} ${x.value} ${word(x.unit)}`);
  return [head, ...tail].join(', ');
}

/** Lengths typed into the Section value field: "12", "12mm", "0.5in", "1.5 cm". Returns mm or null. */
export function parseLengthMm(text: string, defaultUnit: MeasureUnits = 'mm'): number | null {
  const m = /^\s*([+-]?\s*\d*\.?\d+(?:e[+-]?\d+)?)\s*(mm|cm|m|in|")?\s*$/i.exec(
    text.replace('−', '-'),
  );
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/\s/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = (m[2] ?? defaultUnit).toLowerCase();
  return u === 'mm' ? n : u === 'cm' ? n * 10 : u === 'm' ? n * 1000 : n * MM_PER_IN;
}

export function formatLengthMm(mm: number, units: MeasureUnits = 'mm'): string {
  return units === 'in' ? `${(mm / MM_PER_IN).toFixed(3)}in` : `${mm.toFixed(2)}mm`;
}
