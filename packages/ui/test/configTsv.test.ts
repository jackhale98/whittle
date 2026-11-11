import { describe, expect, it } from 'vitest';
import {
  type ConfigColumn,
  configTargetKey,
  parseTsv,
  planPaste,
  resolveEditScope,
  sameCellValue,
  transposeGrid,
} from '../src';

const cols: ConfigColumn[] = [
  { target: { kind: 'param', paramId: 'p1' }, label: 'Width', unit: 'mm', kind: 'expr' },
  { target: { kind: 'param', paramId: 'p2' }, label: 'Height', unit: 'mm', kind: 'expr' },
  { target: { kind: 'suppressed', featureId: 'f1' }, label: 'Hole 1', kind: 'bool' },
  {
    target: { kind: 'field', featureId: 'f2', path: '/size' },
    label: 'Hole size',
    kind: 'option',
    options: [{ value: 'M4' }, { value: 'M6', label: 'M6 clearance' }],
  },
  { target: { kind: 'property', key: 'partNumber' }, label: 'Part number', kind: 'text' },
];
const k = (i: number) => configTargetKey((cols[i] as ConfigColumn).target);
const defaults = { [k(0)]: '40 mm', [k(1)]: '20 mm', [k(2)]: false, [k(3)]: 'M4' };
const rows = [{ id: 'c1', name: 'Long', overrides: { [k(0)]: '80 mm' } }];

describe('parseTsv', () => {
  it('splits tabs and newlines, drops one trailing newline, pads rows', () => {
    expect(parseTsv('a\tb\tc\r\nd\te\n')).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', ''],
    ]);
  });
  it('reads quoted cells with tabs, newlines and doubled quotes', () => {
    expect(parseTsv('"a\tb"\t"x\ny"\t"say ""hi"""')).toEqual([['a\tb', 'x\ny', 'say "hi"']]);
  });
  it('keeps empty cells and handles empty input', () => {
    expect(parseTsv('a\t\tc')).toEqual([['a', '', 'c']]);
    expect(parseTsv('')).toEqual([]);
  });
  it('transposes a rectangle', () => {
    expect(
      transposeGrid([
        ['a', 'b'],
        ['c', 'd'],
      ]),
    ).toEqual([
      ['a', 'c'],
      ['b', 'd'],
    ]);
  });
});

describe('planPaste', () => {
  const plan = (text: string, over: Partial<Parameters<typeof planPaste>[0]> = {}) =>
    planPaste({ grid: parseTsv(text), columns: cols, rows, defaults, ...over });

  it('creates configurations for unknown names and updates existing ones (header row)', () => {
    const p = plan('\tWidth\tHeight\nLong\t90 mm\t25 mm\nShort\t30 mm\t20 mm\nTall\t40 mm\t60 mm');
    expect(p.header).toBe(true);
    expect(p.create).toEqual(['Short', 'Tall']);
    expect(p.edits).toEqual([
      { row: { kind: 'existing', id: 'c1' }, target: cols[0]?.target, value: '90 mm' },
      { row: { kind: 'existing', id: 'c1' }, target: cols[1]?.target, value: '25 mm' },
      { row: { kind: 'new', name: 'Short' }, target: cols[0]?.target, value: '30 mm' },
      // Short's Height equals Default: no override is stored
      { row: { kind: 'new', name: 'Tall' }, target: cols[1]?.target, value: '60 mm' },
    ]);
    expect(p.ignored).toEqual([]);
  });

  it('a value equal to Default clears an existing override instead of copying it', () => {
    const p = plan('Long\t40 mm');
    expect(p.header).toBe(false);
    expect(p.edits).toEqual([{ row: { kind: 'existing', id: 'c1' }, target: cols[0]?.target }]);
  });

  it('skips values equal to what the cell already shows and empty cells', () => {
    expect(plan('Long\t80 mm\t').edits).toEqual([]);
  });

  it('without a header, cells start at the focused column', () => {
    const p = plan('Long\ttrue\tM6 clearance', { startColumn: 2 });
    expect(p.edits).toEqual([
      { row: { kind: 'existing', id: 'c1' }, target: cols[2]?.target, value: true },
      { row: { kind: 'existing', id: 'c1' }, target: cols[3]?.target, value: 'M6' },
    ]);
  });

  it('Default is a row; names match case-insensitively', () => {
    const p = plan('default\t50 mm\nLONG\t1 mm');
    expect(p.create).toEqual([]);
    expect(p.edits[0]).toEqual({
      row: { kind: 'default' },
      target: cols[0]?.target,
      value: '50 mm',
    });
    expect(p.edits[1]?.row).toEqual({ kind: 'existing', id: 'c1' });
  });

  it('reports what it cannot apply instead of guessing', () => {
    const p = plan('\tWidth\tNope\tHole 1\nLong\t1 mm\t5\tmaybe', {
      validateExpr: (e) => (e.startsWith('1') ? 'Bad value' : undefined),
    });
    expect(p.edits).toEqual([]);
    expect(p.ignored.map((i) => i.reason)).toEqual([
      'No column with this name',
      'Bad value',
      'Expected yes or no',
    ]);
  });

  it('reads a transposed block (configurations across the top)', () => {
    const p = plan('\tShort\nWidth\t30 mm\nHeight\t20 mm', { transposed: true, startColumn: 0 });
    expect(p.create).toEqual(['Short']);
    expect(p.edits).toEqual([
      { row: { kind: 'new', name: 'Short' }, target: cols[0]?.target, value: '30 mm' },
    ]);
  });

  it('text cells and rows without a name', () => {
    const p = plan('\tPart number\nLong\tBR-80\n\t5');
    expect(p.edits).toEqual([
      { row: { kind: 'existing', id: 'c1' }, target: cols[4]?.target, value: 'BR-80' },
    ]);
    expect(p.ignored[0]?.reason).toMatch(/no configuration name/);
  });
});

describe('model helpers', () => {
  it('sameCellValue compares strings trimmed and materials by id', () => {
    expect(sameCellValue(' 5 mm', '5 mm')).toBe(true);
    expect(sameCellValue(5, '5')).toBe(false);
    expect(sameCellValue(null, undefined)).toBe(true);
    expect(
      sameCellValue(
        { libraryId: 'a', name: 'A', density: '1 g/cm^3' },
        { libraryId: 'a', name: 'A2', density: '1 g/cm^3' },
      ),
    ).toBe(true);
  });
  it('resolveEditScope follows the Fusion rule and never sticks', () => {
    const base = { activeIsDefault: false, overridden: false, chip: false };
    expect(resolveEditScope(base)).toBe('all');
    expect(resolveEditScope({ ...base, overridden: true })).toBe('configuration');
    expect(resolveEditScope({ ...base, chip: true })).toBe('configuration');
    expect(resolveEditScope({ ...base, activeIsDefault: true, overridden: true, chip: true })).toBe(
      'all',
    );
  });
});
