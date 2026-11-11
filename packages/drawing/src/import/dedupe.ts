/**
 * "Never places a dimension twice" (PLAN §12 M4): two dimensions are the same when they measure
 * along the same direction between the same geometry, which on a drawing means they would draw
 * one dimension line between the same two extension lines (ISO 129-1: each dimension once).
 *
 * - Linear, aligned and ordinate: the measuring direction (sign-free) and the two measured
 *   coordinates along it. The hole sketch's `20` from the origin to each of two holes in one column
 *   is one dimension, and so are the plate's and the upright's `80` over the same x range.
 * - Radius and diameter: the kind, the radius and the circle's axis line.
 *
 * Other kinds (angles, callouts, GD&T, notes) are never merged. Without geometry, nothing is.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Annotation, AnnotationAnchor, Vec3 } from '@wren-cad/contracts';
import { dot3, len3, norm3, scale3, sub3 } from '../annotation/geom';
import { anchorPoints } from '../placement/anchors';

/** 1 µm (and 1e-6 on unit vectors): far below anything a drawing distinguishes. */
const q = (x: number) => {
  const r = Math.round(x * 1e3) / 1e3;
  return Object.is(r, -0) ? '0' : String(r);
};
const qd = (x: number) => {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

/** A direction without its sign: the first non-zero component positive. */
function signless(d: Vec3): Vec3 {
  const n = norm3(d);
  for (const c of n) {
    if (Math.abs(c) < 1e-9) continue;
    return c < 0 ? scale3(n, -1) : n;
  }
  return n;
}

function mean(ps: Vec3[]): Vec3 | null {
  if (ps.length === 0) return null;
  const s: Vec3 = [0, 0, 0];
  for (const p of ps) {
    s[0] += p[0];
    s[1] += p[1];
    s[2] += p[2];
  }
  return scale3(s, 1 / ps.length);
}

/**
 * The distance a linear, aligned or ordinate dimension measures between its anchors (mm), or null
 * without the geometry to tell. Zero when the two coincide along its direction.
 */
export function measuredLength(
  a: Annotation,
  anchors: readonly (AnnotationAnchor | null)[] | undefined,
): number | null {
  const m = measured(a, anchors);
  return m ? Math.abs(m.s1 - m.s0) : null;
}

function measured(
  a: Annotation,
  anchors: readonly (AnnotationAnchor | null)[] | undefined,
): { u: Vec3; s0: number; s1: number } | null {
  if (!anchors) return null;
  if (a.kind !== 'linear' && a.kind !== 'aligned' && a.kind !== 'ordinate') return null;
  const a0 = anchors[0];
  const a1 = anchors[1];
  if (!a0 || !a1) return null;
  const P = anchorPoints(a0, a.at?.[0]);
  const Q = anchorPoints(a1, a.at?.[1]);
  let d: Vec3 | undefined;
  if (a.kind !== 'aligned') d = a.direction;
  if (!d && a.kind !== 'aligned' && a0.kind === 'plane') d = a0.normal;
  if (!d) {
    const p = mean(P);
    const r = mean(Q);
    if (!p || !r) return null;
    d = sub3(r, p);
  }
  if (len3(d) < 1e-9 || !P.length || !Q.length) return null;
  const u = signless(d);
  const s = (ps: Vec3[]) => ps.reduce((acc, p) => acc + dot3(p, u), 0) / ps.length;
  return { u, s0: s(P), s1: s(Q) };
}

/**
 * The geometry key of a dimension, or null when it has none to compare (another kind, missing
 * anchors, a degenerate measurement).
 */
export function measureKey(
  a: Annotation,
  anchors: readonly (AnnotationAnchor | null)[] | undefined,
): string | null {
  if (!anchors) return null;
  switch (a.kind) {
    case 'linear':
    case 'aligned':
    case 'ordinate': {
      const m = measured(a, anchors);
      if (!m || Math.abs(m.s1 - m.s0) < 1e-9) return null;
      const { u, s0, s1 } = m;
      return `L|${u.map(qd).join(',')}|${q(Math.min(s0, s1))}|${q(Math.max(s0, s1))}`;
    }
    case 'radius':
    case 'diameter': {
      const c = anchors[0];
      if (c?.kind !== 'circle') return null;
      const n = signless(c.normal);
      // The axis line by its point nearest the origin.
      const foot = sub3(c.center, scale3(n, dot3(c.center, n)));
      return `${a.kind}|${q(c.radius)}|${n.map(qd).join(',')}|${foot.map(q).join(',')}`;
    }
    default:
      return null;
  }
}
