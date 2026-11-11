// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  ANSI_HOLES,
  available,
  HOLE_TABLES,
  holeRow,
  ISO_HOLES,
} from '../src/hole-tables';
import { resolveHoleSize } from '../src/hole-size';

const inch = (v: number) => v * 25.4;
const DEG = Math.PI / 180;

describe('ISO hole table', () => {
  it('covers M1.6 to M36 (ISO 261 preferred and second-choice sizes)', () => {
    expect(ISO_HOLES.rows.map((r) => r.size)).toEqual([
      'M1.6',
      'M2',
      'M2.5',
      'M3',
      'M4',
      'M5',
      'M6',
      'M8',
      'M10',
      'M12',
      'M14',
      'M16',
      'M18',
      'M20',
      'M22',
      'M24',
      'M27',
      'M30',
      'M33',
      'M36',
    ]);
  });

  it('ISO 273 clearance spot values (fine / medium / coarse)', () => {
    expect(holeRow('ISO', 'M3')?.clearance).toEqual({ close: 3.2, normal: 3.4, loose: 3.6 });
    expect(holeRow('ISO', 'M6')?.clearance).toEqual({ close: 6.4, normal: 6.6, loose: 7 });
    expect(holeRow('ISO', 'M8')?.clearance).toEqual({ close: 8.4, normal: 9, loose: 10 });
    expect(holeRow('ISO', 'M12')?.clearance).toEqual({ close: 13, normal: 13.5, loose: 14.5 });
    expect(holeRow('ISO', 'M20')?.clearance).toEqual({ close: 21, normal: 22, loose: 24 });
    expect(holeRow('ISO', 'M36')?.clearance).toEqual({ close: 37, normal: 39, loose: 42 });
  });

  it('ISO 262 coarse pitches and tap drills', () => {
    expect(holeRow('ISO', 'M1.6')?.tap).toEqual({ drill: 1.25, pitch: 0.35 });
    expect(holeRow('ISO', 'M3')?.tap).toEqual({ drill: 2.5, pitch: 0.5 });
    expect(holeRow('ISO', 'M6')?.tap).toEqual({ drill: 5, pitch: 1 });
    expect(holeRow('ISO', 'M8')?.tap).toEqual({ drill: 6.8, pitch: 1.25 });
    expect(holeRow('ISO', 'M10')?.tap).toEqual({ drill: 8.5, pitch: 1.5 });
    expect(holeRow('ISO', 'M12')?.tap).toEqual({ drill: 10.2, pitch: 1.75 });
    expect(holeRow('ISO', 'M24')?.tap).toEqual({ drill: 21, pitch: 3 });
    expect(holeRow('ISO', 'M36')?.tap).toEqual({ drill: 32, pitch: 4 });
  });

  it('ISO 4762 counterbores and ISO 10642 countersinks', () => {
    expect(holeRow('ISO', 'M6')?.counterbore).toEqual({ diameter: 11, depth: 6 });
    expect(holeRow('ISO', 'M8')?.counterbore).toEqual({ diameter: 15, depth: 8 });
    expect(holeRow('ISO', 'M10')?.counterbore).toEqual({ diameter: 18, depth: 10 });
    expect(holeRow('ISO', 'M6')?.countersink).toEqual({ diameter: 13.44, angle: 90 });
    expect(holeRow('ISO', 'M10')?.countersink).toEqual({ diameter: 22.4, angle: 90 });
    // ISO 10642 stops at M20 and has no M18.
    for (const s of ['M1.6', 'M2', 'M2.5', 'M18', 'M22', 'M24', 'M36']) {
      expect(available(holeRow('ISO', s)?.countersink.diameter ?? 0), s).toBe(false);
    }
  });
});

describe('ANSI hole table', () => {
  it('covers #0 to 1 in, in millimetres', () => {
    expect(ANSI_HOLES.rows.map((r) => r.size)).toEqual([
      '#0',
      '#1',
      '#2',
      '#3',
      '#4',
      '#5',
      '#6',
      '#8',
      '#10',
      '#12',
      '1/4',
      '5/16',
      '3/8',
      '7/16',
      '1/2',
      '5/8',
      '3/4',
      '7/8',
      '1',
    ]);
    expect(holeRow('ANSI', '1/4')?.nominal).toBeCloseTo(6.35, 12);
    expect(holeRow('ANSI', '#10')?.nominal).toBeCloseTo(inch(0.19), 12);
  });

  it('close / free-fit clearance drills and UNC tap drills', () => {
    const r = holeRow('ANSI', '1/4');
    expect(r?.clearance.close).toBeCloseTo(inch(0.257), 9); // F
    expect(r?.clearance.normal).toBeCloseTo(inch(0.266), 9); // H
    expect(r?.tap.drill).toBeCloseTo(inch(0.201), 9); // #7
    expect(r?.tap.pitch).toBeCloseTo(25.4 / 20, 9);
    const n10 = holeRow('ANSI', '#10');
    expect(n10?.clearance.close).toBeCloseTo(inch(0.196), 9); // #9
    expect(n10?.clearance.normal).toBeCloseTo(inch(0.201), 9); // #7
    expect(n10?.tap.drill).toBeCloseTo(inch(0.1495), 9); // #25 for 10-24
    expect(holeRow('ANSI', '1/2')?.tap.drill).toBeCloseTo(inch(27 / 64), 4);
    expect(holeRow('ANSI', '1')?.tap.drill).toBeCloseTo(inch(0.875), 9);
    expect(holeRow('ANSI', '#4')?.tap.drill).toBeCloseTo(inch(0.089), 9); // #43
  });

  it('82° countersinks; none for 7/8 and 1; no counterbore for #12', () => {
    expect(holeRow('ANSI', '1/4')?.countersink.angle).toBe(82);
    expect(holeRow('ANSI', '1/4')?.countersink.diameter).toBeCloseTo(inch(0.507), 9);
    expect(available(holeRow('ANSI', '7/8')?.countersink.diameter ?? 0)).toBe(false);
    expect(available(holeRow('ANSI', '#12')?.counterbore.diameter ?? 0)).toBe(false);
  });
});

describe('table invariants', () => {
  for (const table of Object.values(HOLE_TABLES)) {
    for (const r of table.rows) {
      it(`${table.standard} ${r.size}: drill < nominal < close < normal < loose < counterbore`, () => {
        expect(r.tap.drill).toBeLessThan(r.nominal);
        expect(r.nominal).toBeLessThan(r.clearance.close);
        expect(r.clearance.close).toBeLessThan(r.clearance.normal);
        expect(r.clearance.normal).toBeLessThan(r.clearance.loose);
        if (available(r.counterbore.diameter)) {
          expect(r.counterbore.diameter).toBeGreaterThan(r.clearance.loose);
          expect(r.counterbore.depth).toBeCloseTo(r.nominal, 12);
        }
        if (available(r.countersink.diameter)) {
          expect(r.countersink.diameter).toBeGreaterThan(r.clearance.loose);
        }
        expect(r.tap.pitch).toBeGreaterThan(0);
      });
    }
  }
});

describe('resolveHoleSize', () => {
  it('simple holes use the clearance for the fit; tapped holes the tap drill', () => {
    const base = { standard: 'ISO' as const, size: 'M6', fit: 'normal' as const };
    expect(resolveHoleSize({ ...base, kind: 'simple' })).toMatchObject({
      ok: true,
      value: { diameter: 6.6 },
    });
    expect(resolveHoleSize({ ...base, kind: 'simple', fit: 'close' })).toMatchObject({
      ok: true,
      value: { diameter: 6.4 },
    });
    expect(resolveHoleSize({ ...base, kind: 'tapped' })).toMatchObject({
      ok: true,
      value: { diameter: 5, thread: { nominal: 6, pitch: 1 } },
    });
  });

  it('explicit values override the table', () => {
    const r = resolveHoleSize({
      standard: 'ISO',
      size: 'M6',
      fit: 'normal',
      kind: 'counterbore',
      diameter: 7,
      counterbore: { depth: 6.5 },
    });
    expect(r).toMatchObject({
      ok: true,
      value: { diameter: 7, counterbore: { diameter: 11, depth: 6.5 } },
    });
  });

  it('countersinks carry the table angle in radians', () => {
    const r = resolveHoleSize({ standard: 'ISO', size: 'M8', fit: 'normal', kind: 'countersink' });
    expect(r.ok && r.value.countersink?.angle).toBeCloseTo(90 * DEG, 12);
    expect(r.ok && r.value.countersink?.diameter).toBe(17.92);
    const a = resolveHoleSize({ standard: 'ANSI', size: '#8', fit: 'normal', kind: 'countersink' });
    expect(a.ok && a.value.countersink?.angle).toBeCloseTo(82 * DEG, 12);
  });

  it('a size outside the table needs explicit values, never an extrapolation', () => {
    expect(
      resolveHoleSize({ standard: 'ISO', size: 'M7', fit: 'normal', kind: 'simple' }),
    ).toMatchObject({ ok: false, field: '/size' });
    expect(
      resolveHoleSize({
        standard: 'ISO',
        size: 'M7',
        fit: 'normal',
        kind: 'simple',
        diameter: 7.4,
      }),
    ).toMatchObject({ ok: true, value: { diameter: 7.4 } });
    expect(
      resolveHoleSize({ standard: 'ISO', size: 'M24', fit: 'normal', kind: 'countersink' }),
    ).toMatchObject({ ok: false, field: '/countersink/diameter' });
    expect(
      resolveHoleSize({
        standard: 'ISO',
        size: 'M24',
        fit: 'normal',
        kind: 'countersink',
        countersink: { diameter: 50 },
      }),
    ).toMatchObject({ ok: true, value: { countersink: { diameter: 50 } } });
    expect(
      resolveHoleSize({ standard: 'ANSI', size: 'M6', fit: 'normal', kind: 'tapped', diameter: 5 }),
    ).toMatchObject({ ok: false, field: '/size' });
  });

  it('rejects counterbores no wider than the hole and non-positive diameters', () => {
    expect(
      resolveHoleSize({
        standard: 'ISO',
        size: 'M6',
        fit: 'normal',
        kind: 'counterbore',
        counterbore: { diameter: 6 },
      }),
    ).toMatchObject({ ok: false, field: '/counterbore/diameter' });
    expect(
      resolveHoleSize({ standard: 'ISO', size: 'M6', fit: 'normal', kind: 'simple', diameter: 0 }),
    ).toMatchObject({ ok: false, field: '/diameter' });
  });

  it('size keys ignore case and spaces', () => {
    expect(holeRow('ISO', ' m6 ')?.size).toBe('M6');
    expect(holeRow('ANSI', '1/4')?.size).toBe('1/4');
    expect(holeRow('ANSI', '1/3')).toBeUndefined();
  });
});
