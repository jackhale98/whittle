/**
 * The "make a bracket" tutorial's step conditions (PLAN §9.2, `bracketTutorial` in packages/ui):
 * each step completes when the real document reaches it, never through a "Next" button. Pure:
 * the app evaluates the current step against a snapshot after every change and calls `advance`.
 */

import type { Feature, FeatureStatus, Id, SketchFeature, WhittleDoc } from '@whittle/contracts';
import { isDimension } from '@whittle/contracts';

export interface TutorialSnapshot {
  doc: WhittleDoc;
  /** Statuses of the last regen of this document (undefined before the first). */
  statuses: readonly FeatureStatus[] | undefined;
  /** The dimension whose value is being typed in sketch mode, if any. */
  editingDimension: Id | null;
  /** Exports since the tutorial started. */
  exports: number;
  /** Values of the parameters features use, as first seen in use (`trackParams`). */
  paramsInUse: Readonly<Record<string, string>>;
}

const features = (doc: WhittleDoc): readonly Feature[] => doc.parts[0]?.features ?? [];

const ok = (s: TutorialSnapshot, f: Feature) => {
  const st = s.statuses?.find((x) => x.featureId === f.id);
  return st === undefined ? s.statuses === undefined : st.state === 'ok';
};

/**
 * True when the sketch has a closed loop of at least three non-construction lines: every line
 * end is shared by two lines (through shared points or coincident constraints).
 */
export function hasClosedLoop(f: Pick<SketchFeature, 'entities' | 'constraints'>): boolean {
  const parent = new Map<Id, Id>();
  const find = (x: Id): Id => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r) as Id;
    return r;
  };
  for (const c of f.constraints) if (c.kind === 'coincident') parent.set(find(c.a), find(c.b));
  const lines = f.entities.filter((e) => e.kind === 'line' && !e.construction);
  if (lines.length < 3) return false;
  const degree = new Map<Id, number>();
  for (const l of lines)
    if (l.kind === 'line')
      for (const p of [l.start, l.end]) degree.set(find(p), (degree.get(find(p)) ?? 0) + 1);
  let closed = 0;
  for (const d of degree.values()) if (d >= 2) closed++;
  return closed >= 3 && [...degree.values()].filter((d) => d < 2).length === 0;
}

/** Parameter names a feature mentions in its expressions (word match on the stored JSON). */
export function paramsUsed(doc: WhittleDoc): string[] {
  const text = features(doc)
    .map((f) => JSON.stringify(f))
    .join('\n');
  return doc.params
    .filter((p) => new RegExp(`(^|[^A-Za-z0-9_])${p.name}([^A-Za-z0-9_]|$)`).test(text))
    .map((p) => p.name);
}

/**
 * Records the value of each parameter the first time a feature uses it; `changed` once one of
 * them has a different value than when it was first used.
 */
export function trackParams(
  seen: Readonly<Record<string, string>>,
  doc: WhittleDoc,
): { seen: Record<string, string>; changed: boolean } {
  const out: Record<string, string> = { ...seen };
  let changed = false;
  for (const name of paramsUsed(doc)) {
    const expr = doc.params.find((p) => p.name === name)?.expr ?? '';
    if (out[name] === undefined) out[name] = expr;
    else if (out[name] !== expr) changed = true;
  }
  return { seen: out, changed };
}

/** Whether tutorial step `id` (bracketTutorial ids) is complete in this snapshot. */
export function stepDone(id: string, s: TutorialSnapshot): boolean {
  const fs = features(s.doc);
  const sketches = fs.filter((f): f is SketchFeature => f.type === 'sketch');
  switch (id) {
    case 'sketch':
      return sketches.length > 0;
    case 'rectangle':
      return sketches.some(hasClosedLoop);
    case 'dimension':
      return (
        s.editingDimension === null &&
        sketches.some((f) => f.constraints.some((c) => isDimension(c) && c.driving))
      );
    case 'extrude':
      return fs.some((f) => f.type === 'extrude' && f.op !== 'cut' && ok(s, f));
    case 'holes':
      return fs.some((f) => f.type === 'extrude' && f.op === 'cut' && ok(s, f));
    case 'fillet':
      return fs.some((f) => f.type === 'fillet' && ok(s, f));
    case 'params':
      return trackParams(s.paramsInUse, s.doc).changed;
    case 'export':
      return s.exports > 0;
    default:
      return false;
  }
}
