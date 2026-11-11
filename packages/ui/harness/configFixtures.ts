import type {
  ConfigColumn,
  ConfigTableDefault,
  ConfigTableRow,
  ConfigurationSummary,
} from '../src';
import { configTargetKey } from '../src';

/** M3.7 sample data: a bracket with two parameters, a hole, a suppressible fillet, material and part number. */
export const configColumns: ConfigColumn[] = [
  { target: { kind: 'param', paramId: 'p-w' }, label: 'Width', unit: 'mm', kind: 'expr' },
  { target: { kind: 'param', paramId: 'p-h' }, label: 'Height', unit: 'mm', kind: 'expr' },
  {
    target: { kind: 'field', featureId: 'e1', path: '/end/depth' },
    label: 'Extrude 1 depth',
    unit: 'mm',
    kind: 'expr',
  },
  {
    target: { kind: 'field', featureId: 'h1', path: '/size' },
    label: 'Hole 1 size',
    kind: 'option',
    options: [{ value: 'M4' }, { value: 'M5' }, { value: 'M6', label: 'M6 clearance' }],
  },
  { target: { kind: 'suppressed', featureId: 'f1' }, label: 'Fillet 1', kind: 'bool' },
  { target: { kind: 'material' }, label: 'Material', kind: 'material' },
  { target: { kind: 'property', key: 'partNumber' }, label: 'Part number', kind: 'text' },
  { target: { kind: 'property', key: 'description' }, label: 'Description', kind: 'text' },
];

const key = (i: number) => configTargetKey((configColumns[i] as ConfigColumn).target);

export const alu = {
  libraryId: 'wren:aluminium-6061',
  name: 'Aluminium 6061',
  density: '2.70 g/cm^3',
};
export const steel = { libraryId: 'wren:steel-1018', name: 'Steel 1018', density: '7.87 g/cm^3' };
export const configMaterials = [
  { ...alu, category: 'Aluminium' },
  { ...steel, category: 'Steel' },
];

export const configDefault: ConfigTableDefault = {
  values: {
    [key(0)]: '40 mm',
    [key(1)]: '20 mm',
    [key(2)]: '8 mm',
    [key(3)]: 'M4',
    [key(4)]: false,
    [key(5)]: alu,
    [key(6)]: 'BR-100',
    [key(7)]: 'Mounting bracket',
  },
  status: 'ok',
  mass: '84.2 g',
};

export const configRows: ConfigTableRow[] = [
  {
    id: 'c-long',
    name: 'Long',
    status: 'ok',
    mass: '168.4 g',
    overrides: { [key(0)]: '80 mm', [key(3)]: 'M6', [key(6)]: 'BR-100-L' },
    placeholders: { [key(6)]: 'Bracket-Long' },
  },
  {
    id: 'c-steel',
    name: 'Steel',
    status: 'attention',
    statusMessage: 'Hole 1 lost its edge because Extrude 1 changed',
    mass: '244.5 g',
    overrides: { [key(5)]: steel, [key(4)]: true },
  },
  { id: 'c-tall', name: 'Tall', status: 'failed', statusMessage: 'Fillet 1 failed', overrides: {} },
  { id: 'c-new', name: 'Prototype', status: 'unbuilt', overrides: { [key(1)]: '35 mm' } },
];

export const configSummaries: ConfigurationSummary[] = configRows.map((r) => ({
  id: r.id,
  name: r.name,
  status: r.status,
  ...(r.statusMessage ? { statusMessage: r.statusMessage } : {}),
}));

/** `n` configurations over the sample columns, for the responsiveness test (50 × 8 here; the test widens it). */
export function manyRows(n: number): ConfigTableRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    name: `Variant ${i + 1}`,
    status: 'ok' as const,
    mass: `${(80 + i).toFixed(1)} g`,
    overrides: { [key(0)]: `${40 + i} mm` },
  }));
}
