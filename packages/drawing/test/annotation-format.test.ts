import { describe, expect, it } from 'vitest';
import {
  dimensionLabel,
  evaluateTolerance,
  type FitDeviationLookup,
  formatAngle,
  formatLength,
  formatScale,
  labelText,
  type NumberStyle,
  parseScaleInput,
  parseTolerance,
} from '../src/annotation';
import { stylePreset } from '../src/style';

const iso: NumberStyle = stylePreset('iso').numbers;
const deg = Math.PI / 180;

describe('number formatting', () => {
  it('rounds half away from zero without binary surprises', () => {
    expect(formatLength(1.005, iso)).toBe('1.01');
    expect(formatLength(-1.005, iso)).toBe('-1.01');
    expect(formatLength(2.675, iso)).toBe('2.68');
  });
  it('strips or keeps trailing zeros', () => {
    expect(formatLength(12.5, iso)).toBe('12.5');
    expect(formatLength(12, iso)).toBe('12');
    expect(formatLength(12.5, { ...iso, trailingZeros: 'keep' })).toBe('12.50');
  });
  it('uses the decimal mark', () => {
    expect(formatLength(0.25, { ...iso, decimal: ',' })).toBe('0,25');
  });
  it('never shows -0 and signs on request', () => {
    expect(formatLength(-0.0001, iso)).toBe('0');
    expect(formatLength(0.1, iso, { sign: true })).toBe('+0.1');
    expect(formatLength(0, iso, { sign: true })).toBe('0');
    expect(formatLength(-0.05, iso, { sign: true })).toBe('-0.05');
  });
  it('honours an explicit precision', () => {
    expect(formatLength(1.23456, iso, { precision: 3 })).toBe('1.235');
    expect(formatLength(1.23456, iso, { precision: 0 })).toBe('1');
  });
  it('formats decimal angles', () => {
    expect(formatAngle(30 * deg, iso)).toBe('30°');
    expect(formatAngle(22.25 * deg, iso)).toBe('22.3°');
  });
  it('formats DMS angles', () => {
    const dms = { ...iso, angleFormat: 'dms' as const };
    expect(formatAngle((30 + 15 / 60 + 20 / 3600) * deg, dms, { precision: 4 })).toBe(`30°15'20"`);
    expect(formatAngle((30 + 15 / 60) * deg, dms, { precision: 2 })).toBe(`30°15'`);
    expect(formatAngle(45 * deg, dms, { precision: 0 })).toBe('45°');
    expect(formatAngle((59 + 59.9 / 60) * deg, dms, { precision: 2 })).toBe(`60°0'`);
  });
  it('formats and parses scales', () => {
    expect(formatScale(0.5)).toBe('1:2');
    expect(formatScale(2)).toBe('2:1');
    expect(formatScale(1)).toBe('1:1');
    expect(parseScaleInput('1:2')).toBe('1/2');
    expect(parseScaleInput('2:1')).toBe('2');
    expect(parseScaleInput('1/5')).toBe('1/5');
    expect(parseScaleInput('abc')).toBeNull();
  });
});

describe('tolerance parser (one test per form, ADR-090 §2.4)', () => {
  it('symmetric ±0.1', () => {
    expect(parseTolerance('±0.1')).toEqual({
      ok: true,
      tolerance: { kind: 'symmetric', value: '0.1 mm' },
    });
    expect(parseTolerance('10 ±0.1')).toEqual({
      ok: true,
      nominal: '10 mm',
      tolerance: { kind: 'symmetric', value: '0.1 mm' },
    });
    expect(parseTolerance('+-0,05')).toMatchObject({ ok: true, tolerance: { value: '0.05 mm' } });
  });
  it('bilateral +0.1/-0.05', () => {
    expect(parseTolerance('+0.1/-0.05')).toEqual({
      ok: true,
      tolerance: { kind: 'bilateral', upper: '0.1 mm', lower: '-0.05 mm' },
    });
    expect(parseTolerance('10 +0.1 −0.05')).toMatchObject({
      ok: true,
      nominal: '10 mm',
      tolerance: { kind: 'bilateral', upper: '0.1 mm', lower: '-0.05 mm' },
    });
    expect(parseTolerance('0/-0.05')).toMatchObject({
      tolerance: { upper: '0 mm', lower: '-0.05 mm' },
    });
  });
  it('refuses a bilateral tolerance written lower first', () => {
    expect(parseTolerance('-0.05/+0.1')).toMatchObject({ ok: false });
  });
  it('limits 10.1/9.95 are stored as deviations from the nominal at entry', () => {
    expect(parseTolerance('10.1/9.95', { nominal: 10 })).toEqual({
      ok: true,
      tolerance: { kind: 'limits', upper: '0.1 mm', lower: '-0.05 mm' },
    });
    expect(parseTolerance('10 10.1/9.95')).toMatchObject({
      nominal: '10 mm',
      tolerance: { kind: 'limits' },
    });
    expect(parseTolerance('10.1/9.95')).toMatchObject({ ok: false });
  });
  it('basic [10] and reference (10)', () => {
    expect(parseTolerance('[10]')).toEqual({
      ok: true,
      nominal: '10 mm',
      tolerance: { kind: 'basic' },
    });
    expect(parseTolerance('(10)')).toEqual({
      ok: true,
      nominal: '10 mm',
      tolerance: { kind: 'reference' },
    });
    expect(parseTolerance('[]')).toEqual({ ok: true, tolerance: { kind: 'basic' } });
  });
  it('fit H7, g6 and H7/g6', () => {
    expect(parseTolerance('H7')).toEqual({
      ok: true,
      tolerance: { kind: 'fit', hole: 'H7', show: 'symbol' },
    });
    expect(parseTolerance('g6')).toEqual({
      ok: true,
      tolerance: { kind: 'fit', shaft: 'g6', show: 'symbol' },
    });
    expect(parseTolerance('Ø20 H7/g6')).toEqual({
      ok: true,
      nominal: '20 mm',
      tolerance: { kind: 'fit', hole: 'H7', shaft: 'g6', show: 'symbol' },
    });
    expect(parseTolerance('H7 (+0.021/0)')).toMatchObject({
      tolerance: { show: 'symbolAndDeviations' },
    });
    expect(parseTolerance('20.021/20 (H7)')).toMatchObject({
      tolerance: { kind: 'fit', show: 'limitsAndSymbol' },
    });
  });
  it('refuses swapped and invalid fit classes', () => {
    expect(parseTolerance('g6/H7')).toMatchObject({ ok: false });
    expect(parseTolerance('H19')).toMatchObject({ ok: false });
  });
  it('clears on an empty field and explains what it cannot read', () => {
    expect(parseTolerance('  ')).toEqual({ ok: true, tolerance: null });
    const bad = parseTolerance('about 0.1');
    expect(bad.ok).toBe(false);
  });
  it('writes angle deviations in degrees', () => {
    expect(parseTolerance('±0.5', { quantity: 'angle' })).toMatchObject({
      tolerance: { value: '0.5 deg' },
    });
  });
});

describe('dimension labels', () => {
  const label = (
    value: number | undefined,
    extra: Partial<Parameters<typeof dimensionLabel>[0]> = {},
  ) => labelText(dimensionLabel({ value, quantity: 'length', numbers: iso, ...extra }));

  it('prefixes N× from the resolved count only when asked and only above one', () => {
    expect(label(6, { text: { count: true }, count: 4 })).toBe('4× 6');
    expect(label(6, { text: { count: true }, count: 1 })).toBe('6');
    expect(label(6, { text: { count: true } })).toBe('6');
    expect(label(6, { count: 4 })).toBe('6');
    expect(label(undefined, { text: { count: true }, count: 4 })).toBe('4× ?');
  });
  it('shows ? and no number when the value is absent (trap T1)', () => {
    expect(label(undefined, { tolerance: { kind: 'symmetric', value: 0.1 } })).toBe('?');
  });
  it('formats each tolerance kind', () => {
    expect(label(10, { tolerance: { kind: 'symmetric', value: 0.1 } })).toBe('10 ±0.1');
    expect(label(10, { tolerance: { kind: 'bilateral', upper: 0.1, lower: -0.05 } })).toBe(
      '10 +0.1/-0.05',
    );
    expect(label(10, { tolerance: { kind: 'limits', upper: 0.1, lower: -0.05 } })).toBe(
      '10.1/9.95',
    );
    expect(label(10, { tolerance: { kind: 'basic' } })).toBe('[10]');
    expect(label(10, { tolerance: { kind: 'reference' } })).toBe('(10)');
    expect(label(20, { size: 'diameter', text: { prefix: '4× ' } })).toBe('4× Ø20');
  });
  it('shows ISO 286 fits through the injected deviation table', () => {
    const table: FitDeviationLookup = (c) =>
      c === 'H7'
        ? { upper: 0.021, lower: 0 }
        : c === 'g6'
          ? { upper: -0.007, lower: -0.02 }
          : undefined;
    const fit = (show: 'symbol' | 'symbolAndDeviations' | 'limitsAndSymbol', shaft?: string) =>
      dimensionLabel({
        value: 20,
        quantity: 'length',
        size: 'diameter',
        numbers: { ...iso, lengthPrecision: 3 },
        tolerance: { kind: 'fit', hole: 'H7', ...(shaft ? { shaft } : {}), show },
        fitDeviations: table,
      });
    expect(labelText(fit('symbol'))).toBe('Ø20 H7');
    expect(labelText(fit('symbol', 'g6'))).toBe('Ø20 H7/g6');
    expect(labelText(fit('symbolAndDeviations'))).toBe('Ø20 H7 (+0.021/0)');
    expect(labelText(fit('limitsAndSymbol'))).toBe('Ø20.021/20 (H7)');
    expect(labelText(fit('symbolAndDeviations', 'g6'))).toContain('H7/g6');
  });
  it('falls back to the symbol and warns when the table has no entry', () => {
    const l = dimensionLabel({
      value: 20,
      quantity: 'length',
      numbers: iso,
      tolerance: { kind: 'fit', hole: 'H7', show: 'symbolAndDeviations' },
    });
    expect(labelText(l)).toBe('20 H7');
    expect(l.warnings).toContain('fitDeviationsUnknown');
  });
  it('evaluates tolerance expressions and fails without guessing', () => {
    const ev = (e: string) => (e === 'bad' ? undefined : Number.parseFloat(e));
    expect(
      evaluateTolerance({ kind: 'bilateral', upper: '0.1 mm', lower: '-0.05 mm' }, ev),
    ).toEqual({
      kind: 'bilateral',
      upper: 0.1,
      lower: -0.05,
    });
    expect(evaluateTolerance({ kind: 'symmetric', value: 'bad' }, ev)).toBeNull();
  });
  it('formats angles with angle tolerances', () => {
    expect(
      labelText(
        dimensionLabel({
          value: 30 * deg,
          quantity: 'angle',
          numbers: iso,
          tolerance: { kind: 'symmetric', value: 0.5 * deg },
        }),
      ),
    ).toBe('30° ±0.5°');
  });
});
