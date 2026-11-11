/**
 * Section hatching (ISO 128-50 general hatching: thin lines at an angle and spacing, sheet mm),
 * clipped to the cut faces' loops with the even-odd rule. Pure: it runs in the drawing worker
 * next to the projection (trap T12) or anywhere else.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { HatchStyle, Vec2 } from '@wren-cad/contracts';
import { rotate2 } from '../annotation/geom';

/** Hatch segments for closed polygons (sheet mm). `iso-metal-cross` adds lines at angle + 90°. */
export function hatchLines(loops: readonly Vec2[][], style: HatchStyle): [Vec2, Vec2][] {
  if (style.pattern === 'none' || style.pattern === 'solid' || !(style.spacing > 0)) return [];
  const out = hatchAt(loops, (style.angle * Math.PI) / 180, style.spacing);
  if (style.pattern === 'iso-metal-cross')
    out.push(...hatchAt(loops, ((style.angle + 90) * Math.PI) / 180, style.spacing));
  return out;
}

function hatchAt(loops: readonly Vec2[][], angle: number, spacing: number): [Vec2, Vec2][] {
  // Rotate the polygons so hatch lines are horizontal, scan, rotate back.
  const rl = loops.map((l) => l.map((p) => rotate2(p, -angle)));
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const l of rl)
    for (const p of l) {
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
  if (!Number.isFinite(minY)) return [];
  const out: [Vec2, Vec2][] = [];
  // Lines on a global grid (multiples of spacing) so adjacent faces' hatching lines up.
  const first = Math.ceil(minY / spacing) * spacing;
  for (let y = first; y <= maxY; y += spacing) {
    const xs: number[] = [];
    for (const l of rl) {
      for (let i = 0; i < l.length; i++) {
        const a = l[i] as Vec2;
        const b = l[(i + 1) % l.length] as Vec2;
        // Half-open rule avoids double counting vertices.
        if (a[1] <= y !== b[1] <= y) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = xs[i] as number;
      const x1 = xs[i + 1] as number;
      if (x1 - x0 > 1e-9) out.push([rotate2([x0, y], angle), rotate2([x1, y], angle)]);
    }
  }
  return out;
}
