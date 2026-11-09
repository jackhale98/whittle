/**
 * Offset fuzz: random open and closed chains of lines and arcs, random distances and sides. Every
 * call either refuses with a reason or returns valid geometry: no crossings, no degenerate curves,
 * exact offsets that the solver accepts unchanged and keeps through a distance change.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchEntity, Vec2 } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import { arcFromPoints, type Curve, extentIntersections } from '../src/edit/curves';
import { type OffsetOptions, offsetEntities } from '../src/edit/offset';
import { buildModel, violatedRows } from '../src/model';
import { fixAll, offsetOf, sideDist, solve, sv } from './edit-helpers';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random chain: vertices on a rough loop (closed) or a walk (open); some edges are arcs. */
function randomChain(r: () => number) {
  const n = 2 + Math.floor(r() * 7);
  const closed = n >= 3 && r() < 0.5;
  const pts: Vec2[] = [];
  if (closed) {
    const rad = 10 + r() * 30;
    const angles = Array.from({ length: n }, () => r() * Math.PI * 2).sort((a, b) => a - b);
    for (const a of angles) {
      const k = rad * (0.6 + 0.4 * r());
      pts.push([Math.cos(a) * k, Math.sin(a) * k]);
    }
  } else {
    let p: Vec2 = [0, 0];
    let heading = r() * Math.PI * 2;
    pts.push(p);
    for (let i = 0; i < n; i++) {
      heading += (r() - 0.5) * 2.5;
      const step = 5 + r() * 25;
      p = [p[0] + Math.cos(heading) * step, p[1] + Math.sin(heading) * step];
      pts.push(p);
    }
  }
  const entities: SketchEntity[] = pts.map((p, i) => ({
    id: `p${i}`,
    kind: 'point',
    construction: false,
    x: p[0],
    y: p[1],
  }));
  const curves: Id[] = [];
  const edges = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < edges; i++) {
    const a = `p${i}`;
    const b = `p${(i + 1) % pts.length}`;
    const pa = pts[i] as Vec2;
    const pb = pts[(i + 1) % pts.length] as Vec2;
    if (r() < 0.35) {
      // An arc through both ends with a random bulge (centre on the perpendicular bisector).
      const m: Vec2 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      const d: Vec2 = [pb[0] - pa[0], pb[1] - pa[1]];
      const len = Math.hypot(d[0], d[1]);
      // Mostly gentle minor arcs (centre ≥ 0.4 × chord off the bisector's foot); sometimes
      // anything, including major arcs that loop back.
      const wild = r() < 0.3;
      const sign = r() < 0.5 ? -1 : 1;
      const off = wild ? (r() - 0.5) * 3 * len : sign * (0.4 + r() * 1.5) * len;
      const c: Vec2 = [m[0] - (d[1] / len) * off, m[1] + (d[0] / len) * off];
      const cid = `c${i}`;
      entities.push({ id: cid, kind: 'point', construction: false, x: c[0], y: c[1] });
      // Counter-clockwise from a to b (centre on the left) is the minor arc.
      const ccw = wild ? r() < 0.5 : off > 0;
      entities.push({
        id: `a${i}`,
        kind: 'arc',
        construction: false,
        center: cid,
        start: ccw ? a : b,
        end: ccw ? b : a,
      });
      // Arc ends must be equidistant from the centre: they are (bisector).
      curves.push(`a${i}`);
    } else {
      entities.push({ id: `l${i}`, kind: 'line', construction: false, start: a, end: b });
      curves.push(`l${i}`);
    }
  }
  return { sketch: { entities, constraints: [] }, curves, closed };
}

function curveOf(entities: readonly SketchEntity[], id: Id): Curve | null {
  const pos = (pid: Id): Vec2 => {
    const p = entities.find((e) => e.id === pid);
    if (p?.kind !== 'point') throw new Error(pid);
    return [p.x, p.y];
  };
  const e = entities.find((x) => x.id === id);
  if (e?.kind === 'line') return { kind: 'line', a: pos(e.start), b: pos(e.end) };
  if (e?.kind === 'arc') return arcFromPoints(pos(e.center), pos(e.start), pos(e.end));
  if (e?.kind === 'circle') return { kind: 'circle', c: pos(e.center), r: e.radius };
  return null;
}

/** Self-intersection check of the result, independent of the implementation's own guard. */
function crossings(entities: readonly SketchEntity[], ids: readonly Id[], scale: number): string[] {
  const tol = 1e-6 * scale;
  const out: string[] = [];
  const ends = (c: Curve): Vec2[] => {
    if (c.kind === 'line') return [c.a, c.b];
    if (c.kind === 'arc') {
      const p = (a: number): Vec2 => [c.c[0] + Math.cos(a) * c.r, c.c[1] + Math.sin(a) * c.r];
      return [p(c.a0), p(c.a0 + c.sweep)];
    }
    return [];
  };
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = curveOf(entities, ids[i] as Id) as Curve;
      const b = curveOf(entities, ids[j] as Id) as Curve;
      const joins = ends(a).filter((p) =>
        ends(b).some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol),
      );
      const xs = extentIntersections(a, b, tol).filter(
        (x) => !joins.some((s) => Math.hypot(s[0] - x[0], s[1] - x[1]) < 1e3 * tol),
      );
      if (xs.length) out.push(`${ids[i]} × ${ids[j]}`);
    }
  }
  return out;
}

describe('offset fuzz', () => {
  it('random chains: valid offsets or clean refusals (400 cases)', async () => {
    const r = rng(20261109);
    let accepted = 0;
    let refused = 0;
    const sides: OffsetOptions['side'][] = ['left', 'right', 'both', 'inside', 'outside'];
    for (let n = 0; n < 400; n++) {
      const { sketch, curves, closed } = randomChain(r);
      const d = 0.2 + r() * 12;
      const side = sides[Math.floor(r() * sides.length)] as OffsetOptions['side'];
      const cap = (['none', 'line', 'arc'] as const)[Math.floor(r() * 3)];
      const corners = r() < 0.2 ? 'sharp' : 'round';
      const label = `case ${n} (closed=${closed}, d=${d.toFixed(2)}, ${String(side)}, ${cap}, ${corners})`;
      let res: ReturnType<typeof offsetEntities>;
      try {
        res = offsetEntities(sketch, curves, { distance: d, side, cap, corners });
      } catch (err) {
        throw new Error(`${label} threw: ${String(err)}`);
      }
      if (!res.ok) {
        refused++;
        if (process.env.FUZZ_VERBOSE) console.info(label, res.reason);
        expect(res.reason.length, label).toBeGreaterThan(10);
        continue;
      }
      accepted++;
      const off = offsetOf(res.sketch);
      const created = res.created.filter((id) => {
        const e = res.sketch.entities.find((x) => x.id === id);
        return e && e.kind !== 'point';
      });
      // Non-degenerate output.
      for (const id of created) {
        const c = curveOf(res.sketch.entities, id) as Curve;
        if (c.kind === 'line')
          expect(Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]), label).toBeGreaterThan(1e-7);
        else expect(c.r, label).toBeGreaterThan(1e-7);
      }
      // No crossings.
      expect(crossings(res.sketch.entities, created, 100), label).toEqual([]);
      // Exact: every offset row holds on the result.
      const model = buildModel({ ...res.sketch, values: { [off.id]: sv(off, d) } });
      expect(model.invalid.size, label).toBe(0);
      expect(violatedRows(model, model.x0).length, label).toBe(0);
      // Lines are parallel at d from their sources.
      off.targets.forEach((t, i) => {
        const s = curveOf(res.sketch.entities, off.sources[i] as Id);
        const c = curveOf(res.sketch.entities, t);
        if (s?.kind === 'line' && c?.kind === 'line') {
          expect(Math.abs(sideDist(c.a, s.a, s.b)), label).toBeCloseTo(d, 7);
          expect(Math.abs(sideDist(c.b, s.a, s.b)), label).toBeCloseTo(d, 7);
        }
      });
      // The solver accepts it as is, and follows a smaller distance.
      const fixed = fixAll(res.sketch, curves);
      const same = await solve(fixed, { [off.id]: sv(off, d) });
      expect(same.status, label).toBe('solved');
      const smaller = await solve(fixed, { [off.id]: sv(off, d * 0.95) });
      expect(smaller.status, label).toBe('solved');
    }
    console.info(`[offset fuzz] accepted ${accepted}, refused ${refused}`);
    // The generator exercises both outcomes.
    expect(accepted).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(5);
  }, 60_000);
});
