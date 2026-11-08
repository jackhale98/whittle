/**
 * Measurement readings for the phone Measure panel.
 *
 * `@whittle/contracts` has no `Measurement` type yet (only `MassProperties`), so the UI declares
 * the structural shape it needs here. It is meant to be replaced by (or aliased to) the contract
 * type once the lead adds it: see the proposed diff in the M2 UI hand-off. Canonical units: mm,
 * mm^2 and radians, exactly as the kernel reports them.
 */

export type Vec3 = readonly [number, number, number];

export type Measurement =
  | { kind: 'distance'; value: number; delta?: Vec3 }
  | { kind: 'angle'; value: number }
  | { kind: 'length'; value: number }
  | { kind: 'area'; value: number }
  | { kind: 'radius'; value: number; diameter?: boolean }
  | { kind: 'position'; value: Vec3 };

export type MeasurementKind = Measurement['kind'];

/** A picked thing the measurement is computed from. */
export interface MeasureTarget {
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

export const measurementLabel = (m: Measurement): string =>
  m.kind === 'radius' && m.diameter ? 'Diameter' : KIND_LABEL[m.kind];

const fmt = (n: number, digits: number, grouping = true): string =>
  n
    .toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: grouping,
    })
    .replace('-', '−');

export interface MeasurementReading {
  label: string;
  /** Number text with a true minus sign and fixed decimals so columns line up. */
  value: string;
  unit: string;
  /** Extra axis readouts (ΔX/ΔY/ΔZ, or X/Y/Z for a position). */
  parts?: ReadonlyArray<{ axis: string; value: string }>;
}

/** Formats a measurement for display in `units` (length units only; angles are always degrees). */
export function readMeasurement(m: Measurement, units: MeasureUnits = 'mm'): MeasurementReading {
  const len = (mm: number) => (units === 'in' ? mm / MM_PER_IN : mm);
  const d = units === 'in' ? 4 : 2;
  const label = measurementLabel(m);
  switch (m.kind) {
    case 'distance':
      return {
        label,
        value: fmt(len(m.value), d),
        unit: units,
        parts: m.delta
          ? (['X', 'Y', 'Z'] as const).map((axis, i) => ({
              axis: `Δ${axis}`,
              value: fmt(len(m.delta?.[i] ?? 0), d),
            }))
          : undefined,
      };
    case 'length':
      return { label, value: fmt(len(m.value), d), unit: units };
    case 'radius':
      return { label, value: fmt(len(m.value), d), unit: units };
    case 'angle':
      return { label, value: fmt((m.value * 180) / Math.PI, 2), unit: '°' };
    case 'area':
      return {
        label,
        value: fmt(
          units === 'in' ? m.value / (MM_PER_IN * MM_PER_IN) : m.value,
          units === 'in' ? 4 : 1,
        ),
        unit: `${units}²`,
      };
    case 'position':
      return {
        label,
        value: m.value.map((v) => fmt(len(v), d)).join(', '),
        unit: units,
        parts: (['X', 'Y', 'Z'] as const).map((axis, i) => ({
          axis,
          value: fmt(len(m.value[i] ?? 0), d),
        })),
      };
  }
}

/** Spoken form: "Distance 42.50 millimetres". */
export function speakMeasurement(m: Measurement, units: MeasureUnits = 'mm'): string {
  const r = readMeasurement(m, units);
  const unit = r.unit === '°' ? 'degrees' : units === 'in' ? 'inches' : 'millimetres';
  const sq = m.kind === 'area' ? 'square ' : '';
  return m.kind === 'position'
    ? `${r.label} ${r.parts?.map((p) => `${p.axis} ${p.value}`).join(', ')} ${unit}`
    : `${r.label} ${r.value} ${sq}${unit}`;
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
