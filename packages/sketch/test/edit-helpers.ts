/**
 * Helpers for the sketch-editing tests: sketches from point lists, solving an edited sketch, and
 * geometric checks.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Id,
  SketchConstraint,
  SketchEntity,
  SketchSolveResult,
  Vec2,
} from '@whittle/contracts';
import { expect } from 'vitest';
import type { SketchData, SketchEdit, SketchEditResult } from '../src/edit/draft';
import { core } from './helpers';

/** Sequential readable ids for edits (`n1`, `n2`, …). */
export function ids(prefix = 'n'): () => Id {
  let i = 0;
  return () => `${prefix}${++i}`;
}

export function ok(r: SketchEditResult): SketchEdit {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
}

export function ent(s: SketchData, id: Id): SketchEntity {
  const e = s.entities.find((x) => x.id === id);
  if (!e) throw new Error(`no ${id}`);
  return e;
}

export function at(s: SketchData | SketchSolveResult, id: Id): Vec2 {
  const e = s.entities.find((x) => x.id === id);
  if (e?.kind !== 'point') throw new Error(`${id} is not a point`);
  return [e.x, e.y];
}

export function lineEnds(s: SketchData | SketchSolveResult, id: Id): [Vec2, Vec2] {
  const e = s.entities.find((x) => x.id === id);
  if (e?.kind !== 'line') throw new Error(`${id} is not a line`);
  return [at(s, e.start), at(s, e.end)];
}

export function arcOf(s: SketchData | SketchSolveResult, id: Id) {
  const e = s.entities.find((x) => x.id === id);
  if (e?.kind !== 'arc') throw new Error(`${id} is not an arc`);
  const c = at(s, e.center);
  const a = at(s, e.start);
  const b = at(s, e.end);
  return { c, start: a, end: b, r: Math.hypot(a[0] - c[0], a[1] - c[1]) };
}

export function kindOf(s: SketchData, id: Id): SketchEntity['kind'] {
  return ent(s, id).kind;
}

export function constraint(s: SketchData, id: Id): SketchConstraint {
  const c = s.constraints.find((x) => x.id === id);
  if (!c) throw new Error(`no constraint ${id}`);
  return c;
}

export function offsetOf(s: SketchData) {
  const c = s.constraints.find((x) => x.kind === 'offset');
  if (c?.kind !== 'offset') throw new Error('no offset');
  return c;
}

export async function solve(
  s: SketchData,
  values: Record<Id, number> = {},
): Promise<SketchSolveResult> {
  return (await core()).solve({
    entities: structuredClone(s.entities),
    constraints: structuredClone(s.constraints),
    values,
  });
}

/** Signed distance (left positive) from p to the line a→b. */
export function sideDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / Math.hypot(dx, dy);
}

export function close(a: Vec2, b: Vec2, digits = 7) {
  expect(a[0]).toBeCloseTo(b[0], digits);
  expect(a[1]).toBeCloseTo(b[1], digits);
}

/** Every entity moved by less than `tol` between two states. */
export function unchanged(a: SketchData, b: SketchSolveResult, tol = 1e-7) {
  for (const e of a.entities) {
    if (e.kind !== 'point') continue;
    const q = at(b, e.id);
    expect(Math.hypot(q[0] - e.x, q[1] - e.y), e.id).toBeLessThan(tol);
  }
}

/** Builds a sketch with ids p1… / l1… from a polyline (optionally closed). */
export function polyline(points: Vec2[], closed = false): SketchData & { lines: Id[]; points: Id[] } {
  const entities: SketchEntity[] = [];
  const pts = points.map((p, i) => {
    const id = `p${i + 1}`;
    entities.push({ id, kind: 'point', construction: false, x: p[0], y: p[1] });
    return id;
  });
  const lines: Id[] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const id = `l${i + 1}`;
    entities.push({
      id,
      kind: 'line',
      construction: false,
      start: pts[i] as Id,
      end: pts[(i + 1) % pts.length] as Id,
    });
    lines.push(id);
  }
  return { entities, constraints: [], lines, points: pts };
}

export function fixAll(s: SketchData, which: readonly Id[]): SketchData {
  return {
    entities: s.entities,
    constraints: [
      ...s.constraints,
      ...which.map((id, i): SketchConstraint => ({ id: `fix${i}`, kind: 'fix', entity: id })),
    ],
  };
}
