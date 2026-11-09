import type { HoleFeature, HoleSizeRow, HoleTable } from '@whittle/contracts';

export interface ResolvedDim {
  key: string;
  label: string;
  /** Millimetres (or degrees for `unit: 'deg'`), straight from the table or the override. */
  value: number;
  unit: 'mm' | 'deg';
  /** Comes from an override rather than the table. */
  overridden?: boolean;
}

export const rowOf = (table: HoleTable | undefined, size: string): HoleSizeRow | undefined =>
  table?.rows.find((r) => r.size === size);

/** The table diameter the override replaces: clearance for plain holes, tap drill for tapped. */
export function tableDiameter(f: HoleFeature, row: HoleSizeRow): number {
  return f.kind === 'tapped' ? row.tap.drill : row.clearance[f.fit];
}

/**
 * The dimensions a hole resolves to from its table row, in display order. `override` is the
 * evaluated diameter override in mm when one is set and valid. Pure, so the wizard and tests agree.
 */
export function resolveHole(
  f: Pick<HoleFeature, 'kind' | 'fit' | 'size'>,
  row: HoleSizeRow,
  override?: number,
): ResolvedDim[] {
  const base = f.kind === 'tapped' ? row.tap.drill : row.clearance[f.fit];
  const dia: ResolvedDim = {
    key: 'diameter',
    label: f.kind === 'tapped' ? 'Tap drill Ø' : 'Hole Ø',
    value: override ?? base,
    unit: 'mm',
    ...(override !== undefined ? { overridden: true } : {}),
  };
  switch (f.kind) {
    case 'simple':
      return [dia];
    case 'counterbore':
      return [
        dia,
        { key: 'cbDiameter', label: 'Counterbore Ø', value: row.counterbore.diameter, unit: 'mm' },
        { key: 'cbDepth', label: 'Counterbore depth', value: row.counterbore.depth, unit: 'mm' },
      ];
    case 'countersink':
      return [
        dia,
        { key: 'csDiameter', label: 'Countersink Ø', value: row.countersink.diameter, unit: 'mm' },
        { key: 'csAngle', label: 'Countersink angle', value: row.countersink.angle, unit: 'deg' },
      ];
    case 'tapped':
      return [
        dia,
        { key: 'thread', label: `Thread ${row.size} pitch`, value: row.tap.pitch, unit: 'mm' },
      ];
  }
}
