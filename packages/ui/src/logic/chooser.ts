/**
 * Stable ordering and Tab cycling for the "Which one?" chooser (PLAN 9.2, ADR-046). Rhino's
 * overlap menu is criticised for an order nobody can state; ours is: kind priority, then depth,
 * then id. The same candidates always list the same way, on every run and every device.
 */

export type CandidateKind = 'face' | 'edge' | 'vertex' | 'body';

/**
 * Smaller targets first: a vertex is the hardest thing to hit, so when it is among the candidates
 * it is the first one offered, then edges, faces, bodies.
 */
export const KIND_PRIORITY: Readonly<Record<CandidateKind, number>> = {
  vertex: 0,
  edge: 1,
  face: 2,
  body: 3,
};

export interface Orderable {
  id: string;
  kind: CandidateKind;
  /** Distance along the pick ray (any consistent unit); nearer first. Unknown sorts last. */
  depth?: number | undefined;
}

/** Code-unit comparison, not `localeCompare`: identical in every locale. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareCandidates(a: Orderable, b: Orderable): number {
  const k = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
  if (k !== 0) return k;
  const da = a.depth ?? Number.POSITIVE_INFINITY;
  const db = b.depth ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da < db ? -1 : 1;
  return byCodeUnit(a.id, b.id);
}

/** A sorted copy: kind priority, then depth, then id. */
export function sortCandidates<T extends Orderable>(candidates: readonly T[]): T[] {
  return [...candidates].sort(compareCandidates);
}

/**
 * Next preselection for Tab (`step` 1) or Shift+Tab (-1) over `ids` (already in display order),
 * wrapping at both ends. From no preselection (`current` null or unknown) Tab goes to the first
 * and Shift+Tab to the last. Pure so apps/web can drive the viewport preselect without the
 * chooser open (a still pointer, Tab held over overlapping geometry).
 */
export function cyclePreselection(
  ids: readonly string[],
  current: string | null | undefined,
  step: 1 | -1,
): string | null {
  if (ids.length === 0) return null;
  const i = current == null ? -1 : ids.indexOf(current);
  if (i < 0) return (step === 1 ? ids[0] : ids[ids.length - 1]) ?? null;
  return ids[(i + step + ids.length) % ids.length] ?? null;
}
