/**
 * Pencil primitive recognition (ADR-009 item 5) on synthetic hand-drawn strokes (seeded, see
 * strokes.ts), the stroke → fragment helper, and the ≤ 2 ms budget for a 500-sample stroke.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { StrokeRecognition, StrokeSample, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { recognizeStroke, strokeFragment } from '../src/recognize';
import { core } from './helpers';
import {
  corpus,
  type Generated,
  genArc,
  genCircle,
  genLine,
  genOval,
  genPolyline,
  genRectangle,
  genScribble,
  genTriangle,
  genZigzag,
  HAND,
  type Label,
  penStroke,
  polylinePath,
  range,
  SHAKY,
  seeded,
  withPen,
} from './strokes';

const TOL = 2;
const DEG = Math.PI / 180;
const recognize = (s: readonly StrokeSample[], angleTolerance?: number) =>
  recognizeStroke(
    s,
    angleTolerance === undefined ? { tolerance: TOL } : { tolerance: TOL, angleTolerance },
  );
const d = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const rot = (p: Vec2, a: number, c: Vec2 = [0, 0]): Vec2 => [
  c[0] + p[0] * Math.cos(a) - p[1] * Math.sin(a),
  c[1] + p[0] * Math.sin(a) + p[1] * Math.cos(a),
];

function must(r: StrokeRecognition | null): StrokeRecognition {
  if (!r) throw new Error('not recognised');
  expect(r.confidence).toBeGreaterThanOrEqual(0);
  expect(r.confidence).toBeLessThanOrEqual(1);
  return r;
}

/** Every truth vertex has a recognised vertex within `tol` (and the counts match). */
function matchVertices(got: readonly Vec2[], truth: readonly Vec2[], tol: number) {
  expect(got).toHaveLength(truth.length);
  for (const t of truth) {
    const best = Math.min(...got.map((g) => d(g, t)));
    expect(best, `vertex ${t} (closest ${best.toFixed(2)} mm)`).toBeLessThan(tol);
  }
}

/** Draws `vertices` by hand (closed or open), with overshoot at corners. */
function handPolyline(rng: () => number, vertices: Vec2[], closed: boolean, endGap = 0.5) {
  const { path, corners } = polylinePath(vertices, { closed, over: 1.5, endGap });
  return penStroke(path, corners, rng);
}

const ccwSweep = (c: Vec2, s: Vec2, e: Vec2) => {
  const a = Math.atan2(e[1] - c[1], e[0] - c[0]) - Math.atan2(s[1] - c[1], s[0] - c[0]);
  return ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
};

describe('recognizeStroke: shapes', () => {
  it('lines, with endpoints where they were drawn', () => {
    const rng = seeded(11);
    for (let i = 0; i < 10; i++) {
      const g = genLine(rng, range(rng, 10, 80) * DEG);
      const r = must(recognize(g.samples));
      expect(r.shape.kind, g.note).toBe('line');
      if (r.shape.kind !== 'line') continue;
      const [a, b] = g.truth.vertices as [Vec2, Vec2];
      expect(d(r.shape.from, a)).toBeLessThan(2);
      expect(d(r.shape.to, b)).toBeLessThan(2);
      expect(r.implied).toEqual([]);
      expect(r.confidence).toBeGreaterThan(0.5);
    }
  });

  it('near-horizontal and near-vertical lines snap exactly', () => {
    const rng = seeded(12);
    for (let i = 0; i < 8; i++) {
      const vertical = i % 2 === 1;
      const tilt = range(rng, -4, 4) * DEG;
      const g = genLine(rng, (vertical ? 90 * DEG : i % 4 === 0 ? 180 * DEG : 0) + tilt);
      const r = must(recognize(g.samples));
      if (r.shape.kind !== 'line') throw new Error(`${g.note}: ${r.shape.kind}`);
      if (vertical) {
        expect(r.shape.from[0]).toBe(r.shape.to[0]);
        expect(r.implied).toEqual(['vertical']);
      } else {
        expect(r.shape.from[1]).toBe(r.shape.to[1]);
        expect(r.implied).toEqual(['horizontal']);
      }
    }
    // Outside the angle tolerance: no snap.
    const g = genLine(seeded(3), 12 * DEG);
    const r = must(recognize(g.samples));
    expect(r.shape.kind).toBe('line');
    expect(r.implied).toEqual([]);
    // A wider angle tolerance snaps it.
    expect(must(recognize(g.samples, 15 * DEG)).implied).toEqual(['horizontal']);
  });

  it('open polylines keep their corners', () => {
    const rng = seeded(13);
    for (let i = 0; i < 9; i++) {
      const g = genPolyline(rng, 2 + (i % 3));
      const r = must(recognize(g.samples));
      if (r.shape.kind !== 'polyline') throw new Error(`${g.note}: ${r.shape.kind}`);
      expect(r.shape.closed).toBe(false);
      expect(r.shape.points).toHaveLength((g.truth.vertices as Vec2[]).length);
      // Vertex accuracy without snapping (snaps rotate edges on purpose).
      const raw = must(recognize(g.samples, 0));
      if (raw.shape.kind !== 'polyline') throw new Error(`${g.note}: ${raw.shape.kind}`);
      matchVertices(raw.shape.points, g.truth.vertices as Vec2[], 3.5);
    }
  });

  it('axis-aligned rectangles (drawn up to 2° off) snap to exact horizontal/vertical edges', () => {
    const rng = seeded(14);
    for (let i = 0; i < 10; i++) {
      const g = genRectangle(rng, range(rng, -2, 2) * DEG, i % 3 === 2);
      const r = must(recognize(g.samples));
      if (r.shape.kind !== 'rectangle') throw new Error(`${g.note}: ${r.shape.kind}`);
      const c = r.shape.corners;
      for (let k = 0; k < 4; k++) {
        const p = c[k] as Vec2;
        const q = c[(k + 1) % 4] as Vec2;
        expect(p[0] === q[0] || p[1] === q[1]).toBe(true);
      }
      expect(r.implied).toEqual(['horizontal', 'vertical', 'coincident']);
      matchVertices(c, g.truth.vertices as Vec2[], 4);
      expect(r.confidence).toBeGreaterThan(0.6);
    }
  });

  it('rotated rectangles stay rotated, with exact right angles and the drawn orientation', () => {
    const rng = seeded(15);
    for (let i = 0; i < 10; i++) {
      const angle = range(rng, 12, 78) * DEG;
      const g = genRectangle(rng, angle);
      const r = must(recognize(g.samples));
      if (r.shape.kind !== 'rectangle') throw new Error(`${g.note}: ${r.shape.kind}`);
      const [c0, c1, c2, c3] = r.shape.corners;
      const u: Vec2 = [c1[0] - c0[0], c1[1] - c0[1]];
      const v: Vec2 = [c3[0] - c0[0], c3[1] - c0[1]];
      expect(Math.abs(u[0] * v[0] + u[1] * v[1])).toBeLessThan(
        1e-9 * Math.hypot(...u) * Math.hypot(...v),
      );
      // Opposite corners: a parallelogram that is a rectangle.
      expect(d([c0[0] + c2[0], c0[1] + c2[1]], [c1[0] + c3[0], c1[1] + c3[1]])).toBeLessThan(1e-9);
      // CCW.
      expect(u[0] * v[1] - u[1] * v[0]).toBeGreaterThan(0);
      const edge = Math.atan2(u[1], u[0]);
      const off = ((((edge - angle) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) / DEG;
      // Overshoot at the corners tilts the drawn edges by up to ~3.5°.
      expect(Math.min(off, 90 - off), g.note).toBeLessThan(4.5);
      expect(r.implied).toEqual(['parallel', 'perpendicular', 'coincident']);
      matchVertices(r.shape.corners, g.truth.vertices as Vec2[], 4);
    }
  });

  it('near-misses stay polylines', () => {
    const rng = seeded(16);
    const w = 60;
    const h = 40;
    const cot70 = 1 / Math.tan(70 * DEG);
    const cases: { name: string; v: Vec2[]; closed: boolean; endGap?: number; points: number }[] = [
      {
        name: 'parallelogram (70°/110°)',
        v: [
          [0, 0],
          [w, 0],
          [w + h * cot70, h],
          [h * cot70, h],
        ],
        closed: true,
        points: 4,
      },
      {
        name: 'trapezoid',
        v: [
          [0, 0],
          [w, 0],
          [w - 15, h],
          [15, h],
        ],
        closed: true,
        points: 4,
      },
      {
        name: 'rectangle left open (10 mm gap > tolerance)',
        v: [
          [0, 0],
          [w, 0],
          [w, h],
          [0, h],
        ],
        closed: true,
        endGap: 10,
        points: 5,
      },
      {
        name: 'pentagon with one notch',
        v: [
          [0, 0],
          [w, 0],
          [w, h],
          [w / 2, h + 15],
          [0, h],
        ],
        closed: true,
        points: 5,
      },
      {
        name: 'line with a 25° bend',
        v: [[0, 0], [50, 0], rot([50, 0], 25 * DEG, [50, 0])],
        closed: false,
        points: 3,
      },
    ];
    for (const c of cases) {
      const at = rot([range(rng, -100, 100), range(rng, -100, 100)], 0);
      const v = c.v.map((p) => rot(p, 20 * DEG, at));
      const r = must(recognize(handPolyline(rng, v, c.closed, c.endGap)));
      if (r.shape.kind !== 'polyline') throw new Error(`${c.name}: ${r.shape.kind}`);
      expect(r.shape.points, c.name).toHaveLength(c.points);
      expect(r.shape.closed, c.name).toBe(c.closed && c.endGap === undefined);
    }
  });

  it('circles: centre and radius by least squares', () => {
    const rng = seeded(17);
    for (let i = 0; i < 12; i++) {
      const g = genCircle(rng);
      const r = must(recognize(g.samples));
      if (r.shape.kind !== 'circle') throw new Error(`${g.note}: ${r.shape.kind}`);
      expect(d(r.shape.center, g.truth.center as Vec2)).toBeLessThan(1.5);
      expect(Math.abs(r.shape.radius / (g.truth.radius as number) - 1)).toBeLessThan(0.06);
      expect(r.confidence).toBeGreaterThan(0.5);
    }
  });

  it('an oval with aspect ratio over 1.3 is not a circle', () => {
    const rng = seeded(18);
    for (let i = 0; i < 20; i++) {
      const ratio = 1.3 + 0.015 * i;
      const g = genOval(rng, ratio);
      const r = must(recognize(g.samples));
      expect(r.shape.kind, g.note).not.toBe('circle');
      expect(r.shape.kind, g.note).toBe('polyline');
      if (r.shape.kind === 'polyline') expect(r.shape.closed).toBe(true);
      expect(r.confidence, g.note).toBeLessThan(0.5);
    }
  });

  it('arcs are reported counter-clockwise whichever way they were drawn', () => {
    const rng = seeded(19);
    for (const sweepDeg of [75, 120, 180, 250]) {
      for (const ccw of [true, false]) {
        const g = genArc(rng, sweepDeg, ccw);
        const r = must(recognize(g.samples));
        if (r.shape.kind !== 'arc') throw new Error(`${g.note}: ${r.shape.kind}`);
        const { center, radius, start, end } = r.shape;
        // Short arcs pin the centre and radius less well (small sagitta).
        const short = sweepDeg < 100;
        expect(d(center, g.truth.center as Vec2), g.note).toBeLessThan(
          Math.max(2, (short ? 0.15 : 0.08) * (g.truth.radius as number)),
        );
        expect(Math.abs(radius / (g.truth.radius as number) - 1)).toBeLessThan(short ? 0.12 : 0.06);
        expect(Math.abs(d(start, center) - radius)).toBeLessThan(1e-9);
        expect(Math.abs(d(end, center) - radius)).toBeLessThan(1e-9);
        expect(Math.abs(ccwSweep(center, start, end) / DEG - sweepDeg), g.note).toBeLessThan(10);
        // Drawn CCW: starts at the first sample; drawn CW: the ends swap.
        const first = g.samples[0] as StrokeSample;
        const last = g.samples[g.samples.length - 1] as StrokeSample;
        const [s, e] = ccw ? [first, last] : [last, first];
        expect(d(start, [s.x, s.y])).toBeLessThan(2.5);
        expect(d(end, [e.x, e.y])).toBeLessThan(2.5);
      }
    }
  });

  it('a hand-drawn closed triangle closes onto its start', () => {
    const rng = seeded(20);
    for (let i = 0; i < 8; i++) {
      const g = genTriangle(rng);
      const r = must(recognize(g.samples));
      if (r.shape.kind !== 'polyline') throw new Error(`${g.note}: ${r.shape.kind}`);
      expect(r.shape.closed).toBe(true);
      expect(r.shape.points).toHaveLength(3);
      expect(r.implied).toContain('coincident');
      // Vertex accuracy without snapping (a near-horizontal edge would rightly move them).
      const raw = must(recognize(g.samples, 0));
      if (raw.shape.kind !== 'polyline') throw new Error(`${g.note}: ${raw.shape.kind}`);
      expect(raw.implied).toEqual(['coincident']);
      matchVertices(raw.shape.points, g.truth.vertices as Vec2[], 3);
    }
  });

  it('scribble vs zigzag line', () => {
    const rng = seeded(21);
    for (let i = 0; i < 10; i++) {
      const s = genScribble(rng);
      const r = must(recognize(s.samples));
      expect(r.shape.kind, s.note).toBe('scribble');
      if (r.shape.kind === 'scribble') expect(r.shape.points.length).toBeGreaterThan(10);
      const z = genZigzag(rng);
      const q = must(recognize(z.samples));
      if (q.shape.kind !== 'polyline') throw new Error(`${z.note}: ${q.shape.kind}`);
      expect(q.shape.closed).toBe(false);
      expect(q.shape.points).toHaveLength((z.truth.vertices as Vec2[]).length);
      const raw = must(recognize(z.samples, 0));
      if (raw.shape.kind !== 'polyline') throw new Error(`${z.note}: ${raw.shape.kind}`);
      matchVertices(raw.shape.points, z.truth.vertices as Vec2[], 3.5);
    }
  });
});

describe('recognizeStroke: clean-up', () => {
  it('snaps near-H/V segments and near-right corners of a polyline', () => {
    const rng = seeded(31);
    // An "L" drawn 3° off axis: both edges snap, the corner is exact.
    const l = must(
      recognize(
        handPolyline(
          rng,
          [
            [0, 50],
            [0, 0],
            [60, 0],
          ].map((p) => rot(p as Vec2, 3 * DEG, [10, 10])),
          false,
        ),
      ),
    );
    if (l.shape.kind !== 'polyline') throw new Error(l.shape.kind);
    const [a, b, c] = l.shape.points as [Vec2, Vec2, Vec2];
    expect(a[0]).toBe(b[0]);
    expect(b[1]).toBe(c[1]);
    expect([...l.implied].sort()).toEqual(['horizontal', 'vertical']);
    // A rotated "L" with an 88° corner: the corner becomes exactly 90°.
    const p = must(
      recognize(
        handPolyline(
          rng,
          [rot([50, 0], 88 * DEG), [0, 0], [60, 0]].map((q) => rot(q as Vec2, 30 * DEG, [5, 5])),
          false,
        ),
      ),
    );
    if (p.shape.kind !== 'polyline') throw new Error(p.shape.kind);
    const [p0, p1, p2] = p.shape.points as [Vec2, Vec2, Vec2];
    const u: Vec2 = [p1[0] - p0[0], p1[1] - p0[1]];
    const v: Vec2 = [p2[0] - p1[0], p2[1] - p1[1]];
    expect(
      Math.abs(u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v)),
    ).toBeLessThan(1e-12);
    expect(p.implied).toEqual(['perpendicular']);
  });

  it('closes within tolerance, not beyond', () => {
    const rng = seeded(32);
    const tri: Vec2[] = [
      [0, 0],
      [60, 20],
      [20, 45],
    ];
    const near = must(recognize(handPolyline(rng, tri, true, 1.5)));
    expect(near.shape.kind === 'polyline' && near.shape.closed).toBe(true);
    const far = must(recognize(handPolyline(rng, tri, true, 6)));
    expect(far.shape.kind === 'polyline' && !far.shape.closed).toBe(true);
    // Overshooting past the start closes too.
    const over = must(recognize(handPolyline(rng, tri, true, -8)));
    if (over.shape.kind !== 'polyline') throw new Error(over.shape.kind);
    expect(over.shape.closed).toBe(true);
    matchVertices(over.shape.points, tri, 3);
  });

  it('degenerate strokes are null; non-finite samples are ignored', () => {
    const s = (pts: Vec2[]): StrokeSample[] => pts.map(([x, y], t) => ({ x, y, t }));
    expect(recognizeStroke([], { tolerance: 2 })).toBeNull();
    expect(
      recognize(
        s([
          [0, 0],
          [10, 0],
          [20, 0],
          [30, 0],
        ]),
      ),
    ).toBeNull();
    expect(recognize(s(Array.from({ length: 20 }, () => [5, 5] as Vec2)))).toBeNull();
    // Shorter than 1.5 × tolerance: a tap, not a line.
    expect(recognize(s(Array.from({ length: 20 }, (_, i) => [i * 0.1, 0] as Vec2)))).toBeNull();
    const line = s(Array.from({ length: 30 }, (_, i) => [i * 2, 0] as Vec2));
    line.splice(10, 0, { x: Number.NaN, y: 0, t: 0 }, { x: 1, y: Number.POSITIVE_INFINITY, t: 0 });
    expect(must(recognize(line)).shape.kind).toBe('line');
  });
});

describe('recognizeStroke: corpus accuracy', () => {
  function confusion(items: Generated[]) {
    const labels: Label[] = ['line', 'polyline', 'rectangle', 'circle', 'arc', 'scribble'];
    const m = new Map<string, number>();
    let ok = 0;
    const misses: string[] = [];
    for (const g of items) {
      const got = recognize(g.samples)?.shape.kind ?? 'null';
      m.set(`${g.label}>${got}`, (m.get(`${g.label}>${got}`) ?? 0) + 1);
      if (got === g.label) ok++;
      else misses.push(`${g.note} → ${got}`);
    }
    const cols = [...labels, 'null'];
    const table = [
      `${'drawn \\ got'.padEnd(12)}${cols.map((c) => c.slice(0, 5).padStart(6)).join('')}`,
      ...labels.map(
        (l) =>
          `${l.padEnd(12)}${cols.map((c) => String(m.get(`${l}>${c}`) ?? 0).padStart(6)).join('')}`,
      ),
    ].join('\n');
    return { accuracy: ok / items.length, table, misses };
  }

  it('≥ 95% on the 30-stroke corpus', () => {
    const { accuracy, table, misses } = confusion(corpus(2026, 5));
    console.log(`[recognize] 30-stroke corpus: ${(accuracy * 100).toFixed(1)}%\n${table}`);
    expect(misses).toEqual([]);
    expect(accuracy).toBeGreaterThanOrEqual(0.95);
  });

  it('≥ 95% on larger corpora, also with a shakier hand', () => {
    const hand = confusion(withPen(HAND, () => corpus(7, 50)));
    const shaky = confusion(withPen(SHAKY, () => corpus(7, 50)));
    console.log(
      `[recognize] 300 strokes: ${(hand.accuracy * 100).toFixed(1)}%; shaky hand: ${(shaky.accuracy * 100).toFixed(1)}%\n${shaky.table}\n${shaky.misses.join('\n')}`,
    );
    expect(hand.accuracy).toBeGreaterThanOrEqual(0.98);
    expect(shaky.accuracy).toBeGreaterThanOrEqual(0.95);
  });
});

/** Re-interpolates a stroke to exactly `n` samples (keeping its noise). */
function resampleTo(s: readonly StrokeSample[], n: number): StrokeSample[] {
  const out: StrokeSample[] = [];
  for (let i = 0; i < n; i++) {
    const f = (i * (s.length - 1)) / (n - 1);
    const k = Math.min(s.length - 2, Math.floor(f));
    const t = f - k;
    const a = s[k] as StrokeSample;
    const b = s[k + 1] as StrokeSample;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, t: a.t + (b.t - a.t) * t });
  }
  return out;
}

describe('recognizeStroke: speed', () => {
  it('≤ 2 ms for a 500-sample stroke', () => {
    const rng = seeded(41);
    const shapes = [
      genRectangle(rng),
      genCircle(rng),
      genScribble(rng),
      genZigzag(rng),
      genArc(rng),
    ];
    const report: string[] = [];
    let worstMedian = 0;
    for (const g of shapes) {
      const s = resampleTo(g.samples, 500);
      for (let i = 0; i < 30; i++) recognize(s);
      const times: number[] = [];
      for (let i = 0; i < 101; i++) {
        const t0 = performance.now();
        recognize(s);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const median = times[50] as number;
      worstMedian = Math.max(worstMedian, median);
      report.push(`${g.label} ${median.toFixed(3)} ms (p95 ${(times[95] as number).toFixed(3)})`);
    }
    console.log(`[recognize perf] 500 samples: ${report.join('; ')}`);
    // Budget 2 ms; CI containers can be slow, fail only far beyond it.
    expect(worstMedian).toBeLessThan(process.env.CI ? 6 : 2);
  });
});

describe('strokeFragment', () => {
  async function solveFrag(r: StrokeRecognition) {
    const f = strokeFragment(r);
    if (!f) throw new Error('no fragment');
    const res = (await core()).solve({
      entities: f.entities,
      constraints: f.constraints,
      values: {},
    });
    expect(res.status, JSON.stringify(res.conflicts)).toBe('solved');
    expect(res.redundant).toEqual([]);
    // The cleaned geometry already satisfies its constraints: nothing moves.
    res.entities.forEach((e, i) => {
      const before = f.entities[i];
      if (e.kind === 'point' && before?.kind === 'point') {
        expect(Math.abs(e.x - before.x)).toBeLessThan(1e-9);
        expect(Math.abs(e.y - before.y)).toBeLessThan(1e-9);
      }
    });
    return { f, res };
  }
  const kinds = (f: { constraints: { kind: string }[] }) => f.constraints.map((c) => c.kind).sort();

  it('every shape becomes solvable entities + constraints with the expected DOF', async () => {
    const rng = seeded(51);
    const hLine = must(recognize(genLine(rng, 2 * DEG).samples));
    let out = await solveFrag(hLine);
    expect(kinds(out.f)).toEqual(['horizontal']);
    expect(out.res.dof).toBe(3);

    out = await solveFrag(must(recognize(genLine(rng, 40 * DEG).samples)));
    expect(out.f.constraints).toEqual([]);
    expect(out.res.dof).toBe(4);

    out = await solveFrag(must(recognize(genRectangle(rng, 1 * DEG).samples)));
    expect(kinds(out.f)).toEqual(['horizontal', 'horizontal', 'vertical', 'vertical']);
    expect(out.res.dof).toBe(4);

    const rotated = must(recognize(genRectangle(rng, 35 * DEG).samples));
    out = await solveFrag(rotated);
    expect(kinds(out.f)).toEqual(['parallel', 'parallel', 'perpendicular']);
    expect(out.res.dof).toBe(5);

    out = await solveFrag(must(recognize(genCircle(rng).samples)));
    expect(out.f.entities.map((e) => e.kind).sort()).toEqual(['circle', 'point']);
    expect(out.res.dof).toBe(3);

    const arc = must(recognize(genArc(rng, 140, false).samples));
    out = await solveFrag(arc);
    const a = out.f.entities.find((e) => e.kind === 'arc');
    if (a?.kind !== 'arc' || arc.shape.kind !== 'arc') throw new Error('no arc');
    const start = out.f.entities.find((e) => e.id === a.start);
    expect(start?.kind === 'point' && d([start.x, start.y], arc.shape.start)).toBeLessThan(1e-9);
    expect(out.res.dof).toBe(5);

    out = await solveFrag(must(recognize(genTriangle(rng).samples)));
    expect(out.f.entities.filter((e) => e.kind === 'line')).toHaveLength(3);
    expect(out.f.entities.filter((e) => e.kind === 'point')).toHaveLength(3);
    // 3 points; each snap (H/V edge, right corner) removes one.
    expect(out.res.dof).toBe(6 - out.f.constraints.length);

    expect(strokeFragment(must(recognize(genScribble(rng).samples)))).toBeNull();
  });

  it('a rectilinear closed polyline gets H/V; a rotated one gets non-redundant perpendiculars', async () => {
    const rng = seeded(52);
    const L: Vec2[] = (
      [
        [0, 0],
        [70, 0],
        [70, 30],
        [30, 30],
        [30, 60],
        [0, 60],
      ] as Vec2[]
    ).map(([x, y]) => [1.5 * x, 1.5 * y]);
    const axis = must(
      recognize(
        handPolyline(
          rng,
          L.map((p) => rot(p, 1 * DEG, [5, 5])),
          true,
        ),
      ),
    );
    if (axis.shape.kind !== 'polyline') throw new Error(axis.shape.kind);
    expect(axis.shape.points).toHaveLength(6);
    let out = await solveFrag(axis);
    expect(kinds(out.f)).toEqual([...Array(3).fill('horizontal'), ...Array(3).fill('vertical')]);
    expect(out.res.dof).toBe(6);

    const turned = must(
      recognize(
        handPolyline(
          rng,
          L.map((p) => rot(p, 30 * DEG, [5, 5])),
          true,
        ),
      ),
    );
    if (turned.shape.kind !== 'polyline') throw new Error(turned.shape.kind);
    out = await solveFrag(turned);
    // Six right angles around a loop, but only five are independent.
    expect(kinds(out.f)).toEqual(Array(5).fill('perpendicular'));
    expect(out.res.dof).toBe(7);
  });

  it('uses the given id generator (fresh ids)', () => {
    let n = 0;
    const r = must(recognize(genRectangle(seeded(53), 0).samples));
    const f = strokeFragment(r, { id: () => `x${n++}` });
    const ids = [...(f?.entities ?? []), ...(f?.constraints ?? [])].map((e) => e.id);
    expect(ids.every((id) => id.startsWith('x'))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    const g = strokeFragment(r);
    expect(g?.entities[0]?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
