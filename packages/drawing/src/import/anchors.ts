/**
 * Anchors for promoted dimensions (ADR-092 proposal 2, ADR-090 amendment 4).
 *
 * The planner is synchronous, so the app asks the kernel once: `importAnchorQueries(part, frames)`
 * lists every ref the promotions could use, `ModelingApi.annotationAnchors(partId, queries, slot)`
 * answers them, and `anchorLookup(queries, answers)` is the map handed to `planImport` as
 * `anchors`. An answer without an anchor is never replaced by a guess.
 *
 * Without answers the planner still lays sketch dimensions out from the sketch's own geometry
 * (`sketchAnchor`: the stored entity positions on the regen's sketch frame). That is layout and
 * duplicate detection only; the value and the needs-attention state are always the kernel's.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  AnchorAnswer,
  AnchorQuery,
  AnnotationAnchor,
  EntityRef,
  Id,
  Part,
  SketchFeature,
  Vec3,
} from '@wren-cad/contracts';
import { collectPromotions, type Promotion, type SketchFrame } from './promote';

/** The lookup key of one query: ref name, point qualifier and annotation kind. */
export function anchorQueryKey(q: AnchorQuery): string {
  return `${q.ref.name}\u0000${q.at ?? 'self'}\u0000${q.annotationKind ?? ''}`;
}

/** The planner's lookup from one `annotationAnchors` call (answers are in query order). */
export function anchorLookup(
  queries: readonly AnchorQuery[],
  answers: readonly AnchorAnswer[],
): Map<string, AnchorAnswer> {
  const out = new Map<string, AnchorAnswer>();
  queries.forEach((q, i) => {
    const a = answers[i];
    if (a) out.set(anchorQueryKey(q), a);
  });
  return out;
}

/** The queries for one promotion: every ref of every ref choice, for the draft's kind. */
export function promotionQueries(p: Promotion): AnchorQuery[] {
  const lists = p.choices ?? [p.draft.refs];
  const out: AnchorQuery[] = [];
  for (const refs of lists)
    refs.forEach((ref, i) => {
      const at = p.draft.at?.[i];
      out.push({
        ref,
        ...(at && at !== 'self' ? { at } : {}),
        annotationKind: p.draft.kind,
      });
    });
  return out;
}

/**
 * Every anchor query "Import model annotations" can use for this part, deduplicated and in a
 * stable order. Ask them in one `annotationAnchors` call, in the slot of the drawing's
 * configuration, and pass `anchorLookup(queries, answers)` to `planImport`.
 */
export function importAnchorQueries(
  part: Part,
  sketchFrames: ReadonlyMap<Id, SketchFrame> = new Map(),
): AnchorQuery[] {
  const { promotions } = collectPromotions(part, sketchFrames);
  const seen = new Set<string>();
  const out: AnchorQuery[] = [];
  for (const p of promotions)
    for (const q of promotionQueries(p)) {
      const k = anchorQueryKey(q);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(q);
    }
  return out;
}

const SKETCH_ENTITY = /^S([^:]+):(p|e)\((.+)\)$/;

/**
 * The geometry of a sketch ref from the sketch itself: its stored (solved) entity positions on
 * the regen's sketch frame. Layout only; undefined for anything that is not a sketch point, line,
 * circle or arc of a sketch with a known frame.
 */
export function sketchAnchor(
  ref: EntityRef,
  sketches: ReadonlyMap<Id, SketchFeature>,
  frames: ReadonlyMap<Id, SketchFrame>,
): AnnotationAnchor | undefined {
  const m = SKETCH_ENTITY.exec(ref.name);
  if (!m) return undefined;
  const f = sketches.get(m[1] as string);
  const frame = frames.get(m[1] as string);
  if (!f || !frame) return undefined;
  const to3 = (x: number, y: number): Vec3 => [
    frame.origin[0] + x * frame.x[0] + y * frame.y[0],
    frame.origin[1] + x * frame.x[1] + y * frame.y[1],
    frame.origin[2] + x * frame.x[2] + y * frame.y[2],
  ];
  const id = m[3] as string;
  if (id === '@origin') return { kind: 'point', at: frame.origin };
  const byId = new Map(f.entities.map((e) => [e.id, e]));
  const pt = (pid: Id): Vec3 | undefined => {
    const e = byId.get(pid);
    return e?.kind === 'point' ? to3(e.x, e.y) : undefined;
  };
  const e = byId.get(id);
  if (!e) return undefined;
  switch (e.kind) {
    case 'point':
      return { kind: 'point', at: to3(e.x, e.y) };
    case 'line': {
      const a = pt(e.start);
      const b = pt(e.end);
      return a && b ? { kind: 'line', a, b } : undefined;
    }
    case 'circle': {
      const c = pt(e.center);
      return c ? { kind: 'circle', center: c, normal: frame.z, radius: e.radius } : undefined;
    }
    case 'arc': {
      const c = pt(e.center);
      const s = pt(e.start);
      const t = pt(e.end);
      if (!c || !s || !t) return undefined;
      const radius = Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]);
      return { kind: 'circle', center: c, normal: frame.z, radius, start: s, end: t };
    }
    default:
      return undefined;
  }
}
