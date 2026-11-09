// SPDX-License-Identifier: GPL-3.0-or-later
import type { EvalScope, NamedDimension } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  editDistance,
  expressionEngine as engine,
  formatNumber,
  isReservedName,
  parse,
  suggest,
  tokenize,
  validateParamName,
} from '../src';

const scope = (
  params: Record<string, string> = {},
  length: EvalScope['defaultLengthUnit'] = 'mm',
  angle: EvalScope['defaultAngleUnit'] = 'deg',
): EvalScope => ({ params, defaultLengthUnit: length, defaultAngleUnit: angle });

function val(expr: string, expected: NamedDimension = 'scalar', s: EvalScope = scope()): number {
  const r = engine.evaluate(expr, expected, s);
  if (!r.ok) throw new Error(`${expr}: ${r.error.message}`);
  return r.value;
}

function fails(expr: string, expected: NamedDimension = 'scalar', s: EvalScope = scope()) {
  const r = engine.evaluate(expr, expected, s);
  if (r.ok) throw new Error(`${expr} should fail but gave ${r.value}`);
  return r.error;
}

describe('tokenizer & parser', () => {
  it('tokenizes numbers in all supported forms', () => {
    const nums = (s: string) => tokenize(s).flatMap((t) => (t.k === 'num' ? [t.v] : []));
    expect(nums('1/8')).toEqual([1, 8]);
    expect(nums('.5 1e3 2.5E-2 10.')).toEqual([0.5, 1000, 0.025, 10]);
  });

  it('does not treat the e of a unit-like suffix as an exponent', () => {
    expect(tokenize('2em').map((t) => t.k)).toEqual(['num', 'id', 'eof']);
  });

  it('respects precedence and associativity', () => {
    expect(val('1 + 2 * 3')).toBe(7);
    expect(val('(1 + 2) * 3')).toBe(9);
    expect(val('2 ^ 3 ^ 2')).toBe(512);
    expect(val('-2 ^ 2')).toBe(-4);
    expect(val('2 ^ -1')).toBe(0.5);
    expect(val('10 - 3 - 2')).toBe(5);
    expect(val('24 / 4 / 2')).toBe(3);
    expect(val('--3')).toBe(3);
    expect(val('+3')).toBe(3);
    expect(val('1/8')).toBe(0.125);
  });

  it('accepts typographic operators', () => {
    expect(val('3 × 4')).toBe(12);
    expect(val('8 ÷ 2')).toBe(4);
    expect(val('5 − 2')).toBe(3);
  });

  it('is a pure tree walk: rejects code-like input instead of executing it', () => {
    for (const bad of [
      'constructor',
      'process.exit(1)',
      '__proto__',
      'a=1',
      'alert(1)',
      'x => x',
    ]) {
      const r = engine.evaluate(bad, 'scalar', scope());
      expect(r.ok).toBe(false);
    }
  });

  it('parses without throwing for the happy path', () => {
    expect(parse('25mm + 1/8in').t).toBe('bin');
  });

  it('reports syntax errors with spans', () => {
    const e1 = fails('1 +');
    expect(e1.message).toMatch(/ends early/);
    const e2 = fails('(1 + 2');
    expect(e2.message).toMatch(/Missing closing parenthesis/);
    expect(e2.span).toEqual([0, 1]);
    const e3 = fails('1 + 2)');
    expect(e3.message).toMatch(/Unmatched closing/);
    expect(e3.span).toEqual([5, 6]);
    const e4 = fails('1 $ 2');
    expect(e4.message).toMatch(/Unexpected character ‘\$’/);
    expect(e4.span).toEqual([2, 3]);
    const e5 = fails('2 3');
    expect(e5.message).toMatch(/Unexpected number ‘3’/);
    expect(fails('').message).toBe('Empty expression');
    expect(fails('   ').message).toBe('Empty expression');
  });
});

describe('units & conversion', () => {
  it('converts lengths to mm', () => {
    expect(val('25mm', 'length')).toBe(25);
    expect(val('2.5cm', 'length')).toBeCloseTo(25, 12);
    expect(val('1m', 'length')).toBe(1000);
    expect(val('1in', 'length')).toBeCloseTo(25.4, 12);
    expect(val('1ft', 'length')).toBeCloseTo(304.8, 12);
    expect(val('3"', 'length')).toBeCloseTo(76.2, 12);
    expect(val("2'", 'length')).toBeCloseTo(609.6, 12);
  });

  it('25mm + 1/8in = 28.175 mm', () => {
    expect(val('25mm + 1/8in', 'length')).toBeCloseTo(28.175, 10);
    expect(val('25mm + 1/8 in', 'length')).toBeCloseTo(28.175, 10);
  });

  it('converts angles to radians', () => {
    expect(val('30deg', 'angle')).toBeCloseTo(Math.PI / 6, 12);
    expect(val('30°', 'angle')).toBeCloseTo(Math.PI / 6, 12);
    expect(val('pi rad', 'angle')).toBeCloseTo(Math.PI, 12);
    expect(val('0.5 rad', 'angle')).toBe(0.5);
  });

  it('converts mass and compound units to canonical kg/mm³', () => {
    expect(val('1g', 'mass')).toBeCloseTo(1e-3, 15);
    expect(val('1lb', 'mass')).toBeCloseTo(0.45359237, 12);
    expect(val('2.7 g/cm^3', 'density')).toBeCloseTo(2.7e-6, 15);
    expect(val('2700 kg/m^3', 'density')).toBeCloseTo(2.7e-6, 15);
    expect(val('0.0975 lb/in^3', 'density')).toBeCloseTo((0.0975 * 0.45359237) / 25.4 ** 3, 15);
    // lb/in^3 vs g/cm^3: 0.0975 lb/in³ ≈ 2.699 g/cm³
    expect(val('0.0975 lb/in^3', 'density') * 1e6).toBeCloseTo(2.699, 2);
  });

  it('knows areas and volumes', () => {
    expect(val('2cm * 3cm', 'area')).toBeCloseTo(600, 10);
    expect(val('1cm^3', 'volume')).toBeCloseTo(1000, 10);
    expect(val('(10mm)^2', 'area')).toBeCloseTo(100, 10);
    expect(val('sqrt(100mm^2)', 'length')).toBeCloseTo(10, 10);
  });

  it('knows pressure units for material properties', () => {
    // 200 GPa = 2e11 Pa; canonical kg/(mm s²): Pa = 1e-3
    const r = engine.evaluateAny('200 GPa', scope());
    expect(r.ok && r.value).toBeCloseTo(2e8, 0);
    const mpa = engine.evaluateAny('250 MPa', scope());
    const pa = engine.evaluateAny('250e6 Pa', scope());
    expect(mpa.ok && pa.ok && mpa.value).toBeCloseTo(pa.ok ? pa.value : 0, 3);
  });

  it('gives bare numbers the document default unit', () => {
    expect(val('25', 'length')).toBe(25);
    expect(val('1', 'length', scope({}, 'in'))).toBeCloseTo(25.4, 12);
    expect(val('90', 'angle')).toBeCloseTo(Math.PI / 2, 12);
    expect(val('90', 'angle', scope({}, 'mm', 'rad'))).toBe(90);
    expect(val('4', 'area', scope({}, 'cm'))).toBeCloseTo(400, 10);
    expect(val('7.85', 'density')).toBeCloseTo(7.85e-6, 15);
    expect(val('5', 'mass')).toBeCloseTo(5e-3, 15);
  });

  it('lets a bare number join a dimensioned operand in + and -', () => {
    expect(val('10mm + 5', 'length')).toBe(15);
    expect(val('5 + 1in', 'length', scope({}, 'mm'))).toBeCloseTo(30.4, 10);
    expect(val('45deg + 45', 'angle')).toBeCloseTo(Math.PI / 2, 12);
    const s = scope({ width: '40mm' });
    expect(val('width/2 + 3', 'length', s)).toBe(23);
  });

  it('formats for display', () => {
    expect(engine.format(28.175, 'length')).toBe('28.175 mm');
    expect(engine.format(25.4, 'length', 'in')).toBe('1 in');
    expect(engine.format(3.175, 'length', 'in')).toBe('0.125 in');
    expect(engine.format(Math.PI / 6, 'angle', 'deg')).toBe('30°');
    expect(engine.format(1, 'angle', 'rad')).toBe('1 rad');
    expect(engine.format(2.7e-6, 'density', 'g/cm^3')).toBe('2.7 g/cm^3');
    expect(engine.format(2.7e-6, 'density')).toBe('2.7 g/cm^3');
    expect(engine.format(0.1 + 0.2, 'scalar')).toBe('0.3');
    expect(engine.format(0, 'length')).toBe('0 mm');
    expect(engine.format(-0, 'length')).toBe('0 mm');
    expect(engine.format(-12.5, 'length')).toBe('-12.5 mm');
    expect(engine.format(1234567.891, 'length')).toBe('1234568 mm');
    expect(engine.format(100, 'area', 'cm^2')).toBe('1 cm^2');
  });

  it('falls back to the default unit when the display unit is wrong', () => {
    expect(engine.format(10, 'length', 'deg')).toBe('10 mm');
    expect(engine.format(10, 'length', 'nonsense')).toBe('10 mm');
  });

  it('formatNumber is tabular-friendly (no grouping, no sci-notation in normal ranges)', () => {
    expect(formatNumber(1e9)).toBe('1000000000');
    expect(formatNumber(0.000123)).toBe('0.000123');
    expect(formatNumber(1e-9)).toBe('1e-9');
    expect(formatNumber(12.30000001)).toBe('12.3');
  });

  it('round-trips format → evaluate', () => {
    for (const v of [28.175, 0.5, 1234.5678, 3.2159]) {
      const text = engine.format(v, 'length');
      expect(val(text, 'length')).toBeCloseTo(v, 3);
    }
    const t = engine.format(Math.PI / 6, 'angle');
    expect(val(t, 'angle')).toBeCloseTo(Math.PI / 6, 6);
  });
});

describe('functions', () => {
  it('trig takes angles; bare numbers use the document angle unit', () => {
    expect(val('sin(30deg)')).toBeCloseTo(0.5, 12);
    expect(val('sin(30)')).toBeCloseTo(0.5, 12);
    expect(val('sin(30)', 'scalar', scope({}, 'mm', 'rad'))).toBeCloseTo(Math.sin(30), 12);
    expect(val('cos(60deg)')).toBeCloseTo(0.5, 12);
    expect(val('tan(45deg)')).toBeCloseTo(1, 12);
    expect(val('sin(pi/2 rad)')).toBeCloseTo(1, 12);
    expect(val('sin(0.5 rad)')).toBeCloseTo(Math.sin(0.5), 12);
  });

  it('inverse trig returns angles', () => {
    expect(val('asin(0.5)', 'angle')).toBeCloseTo(Math.PI / 6, 12);
    expect(val('acos(0.5)', 'angle')).toBeCloseTo(Math.PI / 3, 12);
    expect(val('atan(1)', 'angle')).toBeCloseTo(Math.PI / 4, 12);
    expect(val('atan2(10mm, 10mm)', 'angle')).toBeCloseTo(Math.PI / 4, 12);
    expect(val('atan2(1in, 25.4mm)', 'angle')).toBeCloseTo(Math.PI / 4, 12);
  });

  it('sqrt/abs/min/max/round/floor/ceil keep dimensions', () => {
    expect(val('sqrt(16)')).toBe(4);
    expect(val('abs(-3mm)', 'length')).toBe(3);
    expect(val('min(3mm, 1in, 2cm)', 'length')).toBe(3);
    expect(val('max(3mm, 1in, 2cm)', 'length')).toBeCloseTo(25.4, 12);
    expect(val('max(3mm, 2)', 'length')).toBe(3);
    expect(val('round(2.6)')).toBe(3);
    expect(val('floor(2.9)')).toBe(2);
    expect(val('ceil(2.1)')).toBe(3);
    expect(val('round(2.6mm)', 'length')).toBe(3);
    // Rounded in the user's unit (inches), not canonical mm.
    expect(val('round(1.4in)', 'length', scope({}, 'in'))).toBeCloseTo(25.4, 10);
    expect(val('floor(2.9999999999999)', 'scalar')).toBe(3);
  });

  it('pi is available; π too', () => {
    expect(val('pi')).toBeCloseTo(Math.PI, 12);
    expect(val('2π')).toBeCloseTo(2 * Math.PI, 12);
    expect(val('pi * (5mm)^2', 'area')).toBeCloseTo(Math.PI * 25, 10);
  });

  it('checks arity, domains and function names', () => {
    expect(fails('sin()').message).toMatch(/sin\(\) takes 1 argument, got 0/);
    expect(fails('atan2(1)').message).toMatch(/atan2\(\) takes 2 arguments/);
    expect(fails('sqrt(-1)').message).toMatch(/negative/);
    expect(fails('asin(2)').message).toMatch(/between -1 and 1/);
    expect(fails('tan(90)').message).toMatch(/undefined/);
    expect(fails('sin(5mm)').message).toMatch(/takes an angle, not a length/);
    expect(fails('sinn(1)').message).toBe('Unknown function ‘sinn’ — did you mean ‘sin’?');
    expect(fails('sin + 1').message).toMatch(/is a function/);
  });
});

describe('parameters', () => {
  const s = scope({ width: '40mm', half: 'width / 2', ratio: '0.5', angle1: '30deg', n: '3' });

  it('resolves references transitively and reports dependencies', () => {
    const r = engine.evaluate('half + 1in', 'length', s);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBeCloseTo(45.4, 10);
      expect(r.dependsOn).toEqual(['half', 'width']);
    }
  });

  it('keeps unitless params flexible', () => {
    expect(val('width * ratio', 'length', s)).toBe(20);
    expect(val('n * 2mm', 'length', s)).toBe(6);
    expect(val('2 n', 'scalar', s)).toBe(6);
    expect(val('sin(angle1)', 'scalar', s)).toBeCloseTo(0.5, 12);
  });

  it('suggests close parameter names', () => {
    const e = fails('widht * 2', 'length', s);
    expect(e.message).toBe('Unknown parameter ‘widht’ — did you mean ‘width’?');
    expect(e.span).toEqual([0, 5]);
    expect(fails('zzzzzz', 'length', s).message).toBe('Unknown parameter ‘zzzzzz’');
    expect(fails('Width', 'length', s).message).toMatch(/did you mean ‘width’/);
  });

  it('suggests close unit names after a number', () => {
    const e = fails('25mmm', 'length');
    expect(e.message).toBe('Unknown unit ‘mmm’ — did you mean ‘mm’?');
    expect(e.span).toEqual([2, 5]);
  });

  it('detects cycles and reports them', () => {
    const c = scope({ a: 'b + 1', b: 'c * 2', c: 'a / 3' });
    const e = fails('a', 'scalar', c);
    expect(e.message).toMatch(/Circular reference: a → b → c → a/);
    expect(e.cycle).toEqual(['a', 'b', 'c']);
    const self = fails('x', 'scalar', scope({ x: 'x + 1' }));
    expect(self.cycle).toEqual(['x']);
    // The cycle is found from any entry point, and an unrelated param is unaffected.
    const mixed = scope({ a: 'b', b: 'a', ok: '5' });
    expect(fails('b + 1', 'scalar', mixed).cycle).toBeDefined();
    expect(val('ok', 'scalar', mixed)).toBe(5);
    // Errors point at the reference in the expression being edited.
    expect(fails('1 + a', 'scalar', mixed).span).toEqual([4, 5]);
  });

  it('wraps errors inside referenced parameters', () => {
    const w = scope({ bad: 'widht', ok: '2', user: 'bad + ok', width: '3' });
    const e = fails('user * 2', 'scalar', w);
    expect(e.message).toBe(
      'Parameter ‘bad’ has an error: Unknown parameter ‘widht’ — did you mean ‘width’?',
    );
    expect(e.span).toEqual([0, 4]);
  });

  it('stays fast on diamond-shaped graphs with a failing leaf', () => {
    const params: Record<string, string> = { p0: 'nope' };
    for (let i = 1; i < 40; i++) params[`p${i}`] = `p${i - 1} + p${i - 1}`;
    const t = Date.now();
    expect(engine.evaluate('p39', 'scalar', scope(params)).ok).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('a unit-looking parameter name wins unless it directly follows a number', () => {
    const w = scope({ N: '12' });
    expect(val('N * 2', 'scalar', w)).toBe(24);
    const newton = engine.evaluateAny('5 N', scope()); // a unit (newton) right after a number
    expect(newton.ok && newton.value).toBe(5000);
    expect(val('2mm * N', 'length', w)).toBe(24);
  });

  it('parameters called like Object.prototype members are not found', () => {
    expect(fails('toString', 'scalar', scope()).message).toMatch(/Unknown parameter/);
    expect(fails('hasOwnProperty', 'scalar', scope()).message).toMatch(/Unknown parameter/);
  });

  it('validates parameter names', () => {
    expect(validateParamName('width')).toBeUndefined();
    expect(validateParamName('wall_2')).toBeUndefined();
    expect(validateParamName('2wall')).toMatch(/not a valid/);
    expect(validateParamName('a b')).toMatch(/not a valid/);
    expect(validateParamName('sin')).toMatch(/reserved/);
    expect(validateParamName('pi')).toMatch(/reserved/);
    expect(validateParamName('')).toMatch(/needs a name/);
    expect(isReservedName('sqrt')).toBe(true);
    expect(isReservedName('mm')).toBe(false);
  });

  it('bind() shares parameter results across evaluations', () => {
    const session = engine.bind(s);
    const a = session.evaluate('half', 'length');
    const b = session.evaluate('half * 2', 'length');
    expect(a.ok && a.value).toBe(20);
    expect(b.ok && b.value).toBe(40);
  });
});

describe('dimension checking', () => {
  it('rejects adding mismatched dimensions, with a span', () => {
    const e = fails('10mm + 30deg', 'length');
    expect(e.message).toBe("Can't add a length and an angle");
    expect(e.span).toEqual([0, 12]);
    expect(fails('10mm - 2g', 'length').message).toBe("Can't subtract a length and a mass");
    expect(fails('min(1mm, 1deg)', 'length').message).toMatch(
      /Can't compare a length and an angle/,
    );
  });

  it('rejects the wrong final dimension', () => {
    const e = fails('30deg', 'length');
    expect(e.message).toBe('Expected a length, but this is an angle');
    expect(e.span).toEqual([0, 5]);
    expect(fails('  30deg  ', 'length').span).toEqual([2, 7]);
    expect(fails('5mm', 'scalar').message).toBe('Expected a plain number, but this is a length');
    expect(fails('5mm * 5mm', 'length').message).toBe('Expected a length, but this is an area');
    expect(fails('2.7 g/cm^3', 'mass').message).toMatch(/Expected a mass, but this is a density/);
  });

  it('exponents must be plain numbers; powers combine dimensions', () => {
    expect(fails('2 ^ (3mm)').message).toMatch(/exponent must be a plain number/);
    expect(val('(2mm) ^ 2', 'area')).toBe(4);
    expect(val('2mm^2', 'area')).toBe(2);
  });

  it('guards arithmetic', () => {
    expect(fails('1 / 0').message).toBe('Division by zero');
    expect(fails('1mm / (2mm - 2mm)').message).toBe('Division by zero');
    expect(fails('(-8) ^ 0.5').message).toMatch(/not a real number/);
    expect(fails('10 ^ 1000').message).toMatch(/finite/);
  });
});

describe('edit distance', () => {
  it('counts transpositions as one edit', () => {
    expect(editDistance('widht', 'width')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
  });
  it('suggests only within tolerance', () => {
    expect(suggest('lenght', ['length', 'width'])).toBe('length');
    expect(suggest('abc', ['width'])).toBeUndefined();
    expect(suggest('ab', ['ac'])).toBeUndefined();
  });
});
