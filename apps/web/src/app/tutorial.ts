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
 * True when the sketch contains a closed loop of at least three non-construction lines (joined
 * through shared points or coincident constraints). Other lines (open, stray, construction) don't
 * matter: one stray line must not hide a finished rectangle.
 */
export function hasClosedLoop(f: Pick<SketchFeature, 'entities' | 'constraints'>): boolean {
  const find = (map: Map<Id, Id>, x: Id): Id => {
    let r = x;
    for (let next = map.get(r); next !== undefined && next !== r; next = map.get(r)) r = next;
    return r;
  };
  // Points joined by coincident constraints are one vertex.
  const joined = new Map<Id, Id>();
  for (const c of f.constraints) {
    if (c.kind !== 'coincident') continue;
    const a = find(joined, c.a);
    const b = find(joined, c.b);
    if (a !== b) joined.set(a, b);
  }
  // In a simple graph (vertices: joined points; edges: distinct lines) there is a cycle, always of
  // three or more edges, exactly when an edge joins two vertices that are already connected.
  const comp = new Map<Id, Id>();
  const edges = new Set<string>();
  for (const l of f.entities) {
    if (l.kind !== 'line' || l.construction) continue;
    const a = find(joined, l.start);
    const b = find(joined, l.end);
    if (a === b) continue; // degenerate
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (edges.has(key)) continue; // two lines over the same two points are no loop
    edges.add(key);
    const ra = find(comp, a);
    const rb = find(comp, b);
    if (ra === rb) return true;
    comp.set(ra, rb);
  }
  return false;
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
