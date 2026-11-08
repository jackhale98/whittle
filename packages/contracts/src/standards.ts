/**
 * Hole and thread standards tables (M3 hole wizard). Lead-owned types; the data lives in
 * packages/document (`hole-tables.ts`), checked against the published standards in its tests.
 * All lengths in millimetres (ANSI rows are converted from inches, exactly).
 */

export type HoleStandard = 'ISO' | 'ANSI';
export type HoleFit = 'close' | 'normal' | 'loose';

/** One nominal size of a fastener: clearance, counterbore/countersink and tap data. */
export interface HoleSizeRow {
  /** Table key shown to users, e.g. "M6", "#10", "1/4". */
  size: string;
  /** Nominal (major) diameter. */
  nominal: number;
  /** Clearance hole diameters (ISO 273 / ASME B18.2.8). */
  clearance: Record<HoleFit, number>;
  /** Socket-head cap screw counterbore (ISO 4762 / ASME B18.3). */
  counterbore: { diameter: number; depth: number };
  /** Flat-head countersink (ISO 10642 90° / ASME 82°). */
  countersink: { diameter: number; angle: number };
  /** Coarse thread: tap drill diameter and pitch (ISO 261 / UNC). */
  tap: { drill: number; pitch: number };
}

export interface HoleTable {
  standard: HoleStandard;
  rows: readonly HoleSizeRow[];
}
