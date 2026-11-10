/**
 * Phone step-through (M3.6): the stops a "previous / next feature" control visits.
 *
 * A step is a rollback position `r` (1..n): the model as it is after feature `r - 1`. Rules:
 * - A feature and its nested sketch are one step (the rollback bar cannot stop between them, ADR-015).
 * - An expanded folder steps through its members one by one.
 * - A **collapsed folder is one step**: stepping over it shows the model after its last member. The
 *   reviewer chose to fold it away, so the review does not reopen it. Expanding it steps inside.
 */

import type { Id } from '@wren-cad/contracts';
import { folderRange, type TreeFolder } from './treeFolders';
import { allowedRollbacks, computeNesting, snapRollback } from './treeNesting';

export interface Step {
  /** The `rollbackIndex` this step previews. */
  index: number;
  /** "Fillet 2", or the folder's name when the step is a whole collapsed folder. */
  label: string;
  /** Set when the step stands for a collapsed folder. */
  folderId?: Id;
}

export function buildSteps(
  features: readonly { id: Id; type: string; name: string }[],
  folders: readonly TreeFolder[] = [],
  collapsed: ReadonlySet<Id> = new Set(),
  nest = true,
): Step[] {
  const nesting = nest ? computeNesting(features) : computeNesting([]);
  const closed = folders
    .filter((f) => collapsed.has(f.id))
    .map((f) => ({ f, run: folderRange(features, f) }))
    .filter((x): x is { f: TreeFolder; run: { start: number; end: number } } => x.run !== null);
  const steps: Step[] = [];
  for (const r of allowedRollbacks(features, nesting)) {
    if (r < 1) continue;
    if (closed.some(({ run }) => r > run.start + 0 && r <= run.end)) continue;
    const ended = closed.find(({ run }) => run.end + 1 === r);
    if (ended) steps.push({ index: r, label: ended.f.name, folderId: ended.f.id });
    else steps.push({ index: r, label: features[r - 1]?.name ?? '' });
  }
  return steps;
}

/** The step (0-based) whose position is at or nearest below `rollback`. */
export function stepAt(steps: readonly Step[], rollback: number): number {
  if (steps.length === 0) return 0;
  const idx = steps.map((s) => s.index);
  const snapped = snapRollback(rollback, idx, -1);
  return Math.max(0, idx.indexOf(snapped));
}

/** "3 of 12 · Fillet 2" */
export function stepLabel(steps: readonly Step[], at: number): string {
  const s = steps[at];
  return s ? `${at + 1} of ${steps.length} · ${s.label}` : 'No features';
}
