/**
 * Recognised stroke → sketch fragment (entities + constraints with fresh ids), built with the
 * same drawing-tool helpers as click-drawing (tools.ts), so the app merges it like any tool
 * fragment (`mergeFragment`) and then applies inference to existing points, as in
 * apps/web/src/sketch/draw.ts.
 *
 * Constraints come from the clean-up: only kinds listed in `recognition.implied`, and only
 * where the cleaned geometry satisfies them exactly (a snapped horizontal edge has identical y
 * at both ends), so the fragment solves without moving. No constraint is redundant: in a closed
 * polyline, a perpendicular whose two lines' directions are already related (through other
 * perpendiculars or horizontal/vertical) is left out.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchConstraint, StrokeRecognition, Vec2 } from '@wren-cad/contracts';
import {
  arcCenterTool,
  circleCenterTool,
  lineTool,
  newId,
  polylineTool,
  rectangle3PointTool,
  rectangleCornerTool,
  type SketchFragment,
  type ToolOptions,
} from './tools';

/** |cos| below this (relative) counts as exactly perpendicular after clean-up. */
const PERP_EPS = 1e-9;

/**
 * Converts a recognition into a fragment. Null for a scribble (an erase gesture: the app
 * deletes what it crosses) and for degenerate shapes.
 */
export function strokeFragment(
  recognition: StrokeRecognition,
  options: ToolOptions = {},
): SketchFragment | null {
  const nextId = options.id ?? newId;
  const opts: ToolOptions = { ...options, id: nextId };
  const implied = new Set(recognition.implied);
  const shape = recognition.shape;
  switch (shape.kind) {
    case 'scribble':
      return null;
    case 'line': {
      if (shape.from[0] === shape.to[0] && shape.from[1] === shape.to[1]) return null;
      const frag = lineTool(shape.from, shape.to, opts);
      const line = frag.entities.find((e) => e.kind === 'line')?.id as Id;
      const dir = axisOf(shape.from, shape.to);
      if (dir && implied.has(dir))
        frag.constraints.push({ id: nextId(), kind: dir, line } as SketchConstraint);
      return frag;
    }
    case 'circle':
      return shape.radius > 0 ? circleCenterTool(shape.center, shape.radius, opts) : null;
    case 'arc':
      return arcCenterTool(shape.center, shape.start, shape.end, opts);
    case 'rectangle': {
      const [a, b, c] = shape.corners;
      const axisAligned =
        implied.has('horizontal') &&
        implied.has('vertical') &&
        shape.corners.every((p, i) => {
          const q = shape.corners[(i + 1) % 4] as Vec2;
          return p[0] === q[0] || p[1] === q[1];
        });
      if (axisAligned) return rectangleCornerTool(a, c, opts);
      return rectangle3PointTool(a, b, c, opts);
    }
    case 'polyline':
      return polylineFragment(shape.points, shape.closed, implied, opts, nextId);
  }
}

function axisOf(a: Vec2, b: Vec2): 'horizontal' | 'vertical' | null {
  if (a[1] === b[1] && a[0] !== b[0]) return 'horizontal';
  if (a[0] === b[0] && a[1] !== b[1]) return 'vertical';
  return null;
}

function polylineFragment(
  points: readonly Vec2[],
  closedIn: boolean,
  implied: ReadonlySet<string>,
  opts: ToolOptions,
  nextId: () => Id,
): SketchFragment | null {
  const pts = points.filter((p, i) => {
    const q = points[i - 1];
    return !q || p[0] !== q[0] || p[1] !== q[1];
  });
  if (closedIn && pts.length > 1) {
    const f = pts[0] as Vec2;
    const l = pts[pts.length - 1] as Vec2;
    if (f[0] === l[0] && f[1] === l[1]) pts.pop();
  }
  if (pts.length < 2) return null;
  const closed = closedIn && pts.length > 2;
  const frag = polylineTool(pts, { ...opts, closed });
  const lines = frag.entities.filter((e) => e.kind === 'line').map((e) => e.id);
  const seg = (i: number): [Vec2, Vec2] => [pts[i] as Vec2, pts[(i + 1) % pts.length] as Vec2];

  // Direction groups: lines whose relative angle is already fixed. AXIS = horizontal/vertical.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) as string;
    parent.set(a, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const AXIS = '#axis';

  lines.forEach((line, i) => {
    const [a, b] = seg(i);
    const dir = axisOf(a, b);
    if (dir && implied.has(dir)) {
      frag.constraints.push({ id: nextId(), kind: dir, line } as SketchConstraint);
      union(line, AXIS);
    }
  });
  if (implied.has('perpendicular')) {
    const pairs = closed ? lines.length : lines.length - 1;
    for (let i = 0; i < pairs; i++) {
      const j = (i + 1) % lines.length;
      const la = lines[i] as Id;
      const lb = lines[j] as Id;
      if (find(la) === find(lb)) continue;
      const [a0, a1] = seg(i);
      const [b0, b1] = seg(j);
      const u: Vec2 = [a1[0] - a0[0], a1[1] - a0[1]];
      const v: Vec2 = [b1[0] - b0[0], b1[1] - b0[1]];
      const d = Math.abs(u[0] * v[0] + u[1] * v[1]);
      if (d > PERP_EPS * Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1])) continue;
      frag.constraints.push({ id: nextId(), kind: 'perpendicular', a: la, b: lb });
      union(la, lb);
    }
  }
  return frag;
}
