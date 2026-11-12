/**
 * Product gaps the certification-style drawing suite finds. M4.1 (ADR-095) closed all 16 that the
 * M4 gate listed (94 of 94 specified dimensions are made with Wren's drawing tools), so the table
 * is empty. It stays as the place to record a gap the suite finds again: a spec drawing item that
 * Wren's drawing tools cannot make, with a gap id and the reason found. Nothing is faked: the spec
 * test (m4-reference-drawings.spec.ts) skips the dimension and requires that it stays unmet;
 * `WREN_CERT_ALL=1` re-checks every entry.
 */

export interface Gap {
  /** Spec dimension names (`DrawingDimSpec.name`) this gap leaves unmet. */
  dims: string[];
  /** The spec item, as a person reads it. */
  what: string;
  reason: string;
}

export const GAPS: Record<string, Gap[]> = {};
