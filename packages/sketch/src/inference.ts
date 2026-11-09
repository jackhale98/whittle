/**
 * Constraint inference while drawing (PLAN §2.1 "Inferred constraints while drawing"). Pure
 * geometry — no solver. Candidates reference the point under the cursor as `CURSOR_POINT` and
 * the entity being drawn as `DRAWING_ENTITY`; the UI substitutes real ids on commit.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  GeometricConstraint,
  Id,
  InferenceCandidate,
  SketchEntityKind,
  SketchSolveInput,
  Vec2,
} from '@wren-cad/contracts';
import {
  add,
  arcGeom,
  closestOnEntity,
  closestParam,
  cross,
  dist,
  dot,
  indexEntities,
  len,
  lineGeom,
  normalize,
  paramCurve,
  perp,
  pointPos,
  scale,
  sub,
} from './geometry';
import { SKETCH_ORIGIN, SKETCH_X_AXIS, SKETCH_Y_AXIS } from './references';

/** Placeholder id for the point being placed at the cursor. */
export const CURSOR_POINT = '@cursor';
/** Placeholder id for the entity being drawn (e.g. the rubber-band line). */
export const DRAWING_ENTITY = '@drawing';

/** Angular tolerance for horizontal/vertical/parallel/perpendicular/tangent snaps. */
export const ANGLE_TOLERANCE = (3 * Math.PI) / 180;

const WEIGHT = {
  coincident: 1,
  midpoint: 0.95,
  horizontal: 0.85,
  vertical: 0.85,
  tangent: 0.8,
  pointOn: 0.7,
  perpendicular: 0.65,
  parallel: 0.6,
  equal: 0.5,
  align: 0.4,
} as const;

/**
 * The origin and axes (ADR-017) rank just below the same snap on the user's own geometry, so a
 * real point or curve at the same spot always wins.
 */
const REFERENCE_WEIGHT = {
  coincident: 0.98,
  pointOn: 0.68,
} as const;

const MAX_CANDIDATES = 12;
const MAX_DIRECTION_LINES = 8;

/**
 * A geometric constraint without its id. The contract's `Omit<GeometricConstraint, 'id'>` is not
 * distributive over the union (it keeps only `kind`), so we build candidates with this type and
 * hand them over as the contract type (see the proposed contract diff).
 */
export type ConstraintDraft = GeometricConstraint extends infer C
  ? C extends GeometricConstraint
    ? Omit<C, 'id'>
    : never
  : never;
type Draft = ConstraintDraft;
type ContractDraft = InferenceCandidate['constraint'];

export interface DrawingState {
  kind: SketchEntityKind;
  /** Anchor of the entity being drawn: a line's start, a circle's/arc's centre. */
  from?: Vec2;
}

export function infer(
  input: SketchSolveInput,
  cursor: Vec2,
  drawing: DrawingState | null,
  tolerance: number,
): InferenceCandidate[] {
  const tol = Math.max(tolerance, 1e-9);
  const index = indexEntities(input.entities);
  const from = drawing?.from;
  const out: InferenceCandidate[] = [];
  const push = (constraint: Draft, snapped: Vec2, weight: number, closeness: number) => {
    const score = weight * (1 - 0.5 * Math.min(1, Math.max(0, closeness)));
    out.push({
      constraint: constraint as ContractDraft,
      snapped,
      score: Math.round(score * 1e6) / 1e6,
    });
  };
  const atFrom = (p: Vec2) => from !== undefined && dist(p, from) < 1e-9;

  // 1. Points (endpoints, centres, free points) and alignment guides.
  const align: { c: { constraint: Draft; snapped: Vec2; score: number }; d: number }[] = [];
  for (const e of input.entities) {
    if (e.kind !== 'point') continue;
    const p: Vec2 = [e.x, e.y];
    if (atFrom(p)) continue;
    const d = dist(cursor, p);
    if (d <= tol) {
      push({ kind: 'coincident', a: CURSOR_POINT, b: e.id }, p, WEIGHT.coincident, d / tol);
      continue;
    }
    const dy = Math.abs(cursor[1] - p[1]);
    if (dy <= tol) {
      align.push({
        c: {
          constraint: { kind: 'horizontalPoints', a: CURSOR_POINT, b: e.id },
          snapped: [cursor[0], p[1]],
          score: WEIGHT.align * (1 - (0.5 * dy) / tol),
        },
        d,
      });
    }
    const dx = Math.abs(cursor[0] - p[0]);
    if (dx <= tol) {
      align.push({
        c: {
          constraint: { kind: 'verticalPoints', a: CURSOR_POINT, b: e.id },
          snapped: [p[0], cursor[1]],
          score: WEIGHT.align * (1 - (0.5 * dx) / tol),
        },
        d,
      });
    }
  }

  // 1b. The origin: coincident snap, else horizontal/vertical alignment guides from it.
  const origin: Vec2 = [0, 0];
  const nearOrigin = !atFrom(origin) && dist(cursor, origin) <= tol;
  if (!atFrom(origin)) {
    const d = dist(cursor, origin);
    if (d <= tol) {
      push(
        { kind: 'coincident', a: CURSOR_POINT, b: SKETCH_ORIGIN },
        origin,
        REFERENCE_WEIGHT.coincident,
        d / tol,
      );
    } else {
      const dy = Math.abs(cursor[1]);
      if (dy <= tol) {
        align.push({
          c: {
            constraint: { kind: 'horizontalPoints', a: CURSOR_POINT, b: SKETCH_ORIGIN },
            snapped: [cursor[0], 0],
            score: WEIGHT.align * (1 - (0.5 * dy) / tol),
          },
          d,
        });
      }
      const dx = Math.abs(cursor[0]);
      if (dx <= tol) {
        align.push({
          c: {
            constraint: { kind: 'verticalPoints', a: CURSOR_POINT, b: SKETCH_ORIGIN },
            snapped: [0, cursor[1]],
            score: WEIGHT.align * (1 - (0.5 * dx) / tol),
          },
          d,
        });
      }
    }
  }

  // 1c. The axes: point on the horizontal (v = 0) / vertical (u = 0) axis. Not offered at the
  //     origin itself (coincident says more).
  if (!nearOrigin) {
    const onX = Math.abs(cursor[1]);
    if (onX <= tol)
      push(
        { kind: 'pointOn', point: CURSOR_POINT, on: SKETCH_X_AXIS },
        [cursor[0], 0],
        REFERENCE_WEIGHT.pointOn,
        onX / tol,
      );
    const onY = Math.abs(cursor[0]);
    if (onY <= tol)
      push(
        { kind: 'pointOn', point: CURSOR_POINT, on: SKETCH_Y_AXIS },
        [0, cursor[1]],
        REFERENCE_WEIGHT.pointOn,
        onY / tol,
      );
  }

  // 2. Midpoints and curves.
  for (const e of input.entities) {
    if (e.kind === 'point') continue;
    if (e.kind === 'line') {
      const { a, b } = lineGeom(index, e);
      const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const dm = dist(cursor, m);
      if (dm <= tol && !atFrom(m)) {
        push({ kind: 'midpoint', point: CURSOR_POINT, line: e.id }, m, WEIGHT.midpoint, dm / tol);
      }
    }
    const q = closestOnEntity(index, e, cursor);
    if (!q) continue;
    const dq = dist(cursor, q);
    if (dq <= tol)
      push({ kind: 'pointOn', point: CURSOR_POINT, on: e.id }, q, WEIGHT.pointOn, dq / tol);
  }

  // 3. Directional inferences for the entity being drawn.
  if (drawing && from && dist(from, cursor) > tol) {
    const v = sub(cursor, from);
    const u = normalize(v);
    const vl = len(v);
    /** Tangent to curves of `kinds` passing through `from`, when the drawn direction is close. */
    const curveTangents = (kinds: readonly SketchEntityKind[]) => {
      const sinTol = Math.sin(ANGLE_TOLERANCE);
      for (const e of input.entities) {
        if (!kinds.includes(e.kind)) continue;
        const curve = paramCurve(index, e);
        if (!curve) continue;
        const t = closestParam(curve, from, 48);
        const q = curve.at(t);
        const scaleRef = Math.max(1, len(from));
        if (dist(q, from) > 1e-6 * scaleRef) continue;
        const d = normalize(curve.d1(t));
        if (len(d) === 0) continue;
        const s = cross(u, d);
        if (Math.abs(s) > sinTol) continue;
        push(
          { kind: 'tangent', a: DRAWING_ENTITY, b: e.id },
          add(from, scale(d, dot(v, d))),
          WEIGHT.tangent,
          Math.abs(Math.asin(Math.max(-1, Math.min(1, s)))) / ANGLE_TOLERANCE,
        );
      }
    };
    if (drawing.kind === 'line') {
      const sinTol = Math.sin(ANGLE_TOLERANCE);
      // Horizontal / vertical.
      if (Math.abs(u[1]) <= sinTol) {
        push(
          { kind: 'horizontal', line: DRAWING_ENTITY },
          [cursor[0], from[1]],
          WEIGHT.horizontal,
          Math.abs(Math.asin(u[1])) / ANGLE_TOLERANCE,
        );
      }
      if (Math.abs(u[0]) <= sinTol) {
        push(
          { kind: 'vertical', line: DRAWING_ENTITY },
          [from[0], cursor[1]],
          WEIGHT.vertical,
          Math.abs(Math.asin(u[0])) / ANGLE_TOLERANCE,
        );
      }
      // Parallel / perpendicular to nearby lines; equal length.
      const lines = input.entities
        .filter((e) => e.kind === 'line')
        .map((e) => {
          const g = lineGeom(index, e);
          const near = Math.min(
            dist(cursor, closestOnEntity(index, e, cursor) ?? g.a),
            dist(from, closestOnEntity(index, e, from) ?? g.a),
          );
          return { e, g, near };
        })
        .filter((l) => len(sub(l.g.b, l.g.a)) > 1e-9)
        .sort((a, b) => a.near - b.near);
      for (const [k, l] of lines.entries()) {
        const d = normalize(sub(l.g.b, l.g.a));
        if (k < MAX_DIRECTION_LINES) {
          const s = cross(u, d);
          const c = dot(u, d);
          if (Math.abs(s) <= sinTol) {
            push(
              { kind: 'parallel', a: DRAWING_ENTITY, b: l.e.id },
              add(from, scale(d, dot(v, d))),
              WEIGHT.parallel,
              Math.abs(Math.asin(s)) / ANGLE_TOLERANCE,
            );
          } else if (Math.abs(c) <= sinTol) {
            const n = perp(d);
            push(
              { kind: 'perpendicular', a: DRAWING_ENTITY, b: l.e.id },
              add(from, scale(n, dot(v, n))),
              WEIGHT.perpendicular,
              Math.abs(Math.asin(c)) / ANGLE_TOLERANCE,
            );
          }
        }
        const target = len(sub(l.g.b, l.g.a));
        if (Math.abs(vl - target) <= tol) {
          push(
            { kind: 'equal', a: DRAWING_ENTITY, b: l.e.id },
            add(from, scale(u, target)),
            WEIGHT.equal,
            Math.abs(vl - target) / tol,
          );
        }
      }
      // Tangent: continuing from an arc/circle endpoint, or touching a circle/arc.
      for (const e of input.entities) {
        if (e.kind !== 'arc' && e.kind !== 'circle') continue;
        const c = pointPos(index, e.center);
        const r = e.kind === 'circle' ? e.radius : arcGeom(index, e).r;
        if (r <= 1e-9) continue;
        const onCurve = Math.abs(dist(from, c) - r) < 1e-6 * Math.max(1, r);
        if (onCurve) {
          const t = normalize(perp(sub(from, c)));
          const s = cross(u, t);
          if (Math.abs(s) <= sinTol) {
            push(
              { kind: 'tangent', a: DRAWING_ENTITY, b: e.id },
              add(from, scale(t, dot(v, t))),
              WEIGHT.tangent,
              Math.abs(Math.asin(s)) / ANGLE_TOLERANCE,
            );
          }
          continue;
        }
        const dc = dist(from, c);
        if (dc <= r) continue;
        const alpha = Math.acos(r / dc);
        const beta = Math.atan2(from[1] - c[1], from[0] - c[0]);
        for (const sign of [1, -1]) {
          const tp: Vec2 = [
            c[0] + r * Math.cos(beta + sign * alpha),
            c[1] + r * Math.sin(beta + sign * alpha),
          ];
          if (e.kind === 'arc') {
            const g = arcGeom(index, e);
            const ang = Math.atan2(tp[1] - c[1], tp[0] - c[0]);
            const rel = (((ang - g.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            if (rel > g.sweep + 1e-9) continue;
          }
          const dt = dist(cursor, tp);
          if (dt <= tol)
            push({ kind: 'tangent', a: DRAWING_ENTITY, b: e.id }, tp, WEIGHT.tangent, dt / tol);
        }
      }
      // Tangent continuation from an ellipse, elliptic arc or spline the line starts on.
      curveTangents(['ellipse', 'ellipticArc', 'bspline']);
    } else if (drawing.kind === 'bspline') {
      // A spline's first leg sets its end tangent: continue any curve it starts on.
      curveTangents(['line', 'circle', 'arc', 'ellipse', 'ellipticArc', 'bspline']);
    } else if (drawing.kind === 'circle' || drawing.kind === 'arc') {
      // Equal radius with existing circles/arcs (from = centre).
      for (const e of input.entities) {
        if (e.kind !== 'circle' && e.kind !== 'arc') continue;
        const r = e.kind === 'circle' ? e.radius : arcGeom(index, e).r;
        if (Math.abs(vl - r) <= tol) {
          push(
            { kind: 'equal', a: DRAWING_ENTITY, b: e.id },
            add(from, scale(u, r)),
            WEIGHT.equal,
            Math.abs(vl - r) / tol,
          );
        }
      }
    }
  }

  // Alignment guides: only the nearest horizontal and vertical one.
  align.sort((a, b) => a.d - b.d);
  const seen = new Set<string>();
  for (const a of align) {
    if (seen.has(a.c.constraint.kind)) continue;
    seen.add(a.c.constraint.kind);
    out.push({
      constraint: a.c.constraint as ContractDraft,
      snapped: a.c.snapped,
      score: Math.round(a.c.score * 1e6) / 1e6,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, MAX_CANDIDATES);
}

/** Replaces the inference placeholders in a candidate constraint with real ids. */
export function bindCandidate(
  constraint: Draft | ContractDraft,
  ids: { cursorPoint?: Id; drawingEntity?: Id },
): Draft {
  const map = (v: unknown): unknown => {
    if (v === CURSOR_POINT && ids.cursorPoint) return ids.cursorPoint;
    if (v === DRAWING_ENTITY && ids.drawingEntity) return ids.drawingEntity;
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(constraint)) out[k] = map(v);
  return out as Draft;
}
