import type { SketchEntity, StrokeSample, Vec2 } from '@wren-cad/contracts';
import { lineTool } from '@wren-cad/sketch';
import { recognizeStroke } from '@wren-cad/sketch/recognize';
import { describe, expect, it } from 'vitest';
import type { SketchData } from './draw';
import { crossedEntities, segmentDistance, simplify, strokeEdit } from './stroke';

/** A hand-drawn-ish stroke through `corners` (`n` samples per side, a little jitter). */
function stroke(corners: Vec2[], n = 25, jitter = 0.05): StrokeSample[] {
  const out: StrokeSample[] = [];
  let t = 0;
  for (let i = 0; i + 1 < corners.length; i++) {
    const a = corners[i] as Vec2;
    const b = corners[i + 1] as Vec2;
    for (let k = 0; k < n; k++) {
      const u = k / n;
      const wob = Math.sin((t + 1) * 1.7) * jitter;
      out.push({
        x: a[0] + (b[0] - a[0]) * u + wob,
        y: a[1] + (b[1] - a[1]) * u - wob,
        t: t++ * 8,
      });
    }
  }
  const last = corners[corners.length - 1] as Vec2;
  out.push({ x: last[0], y: last[1], t: t * 8 });
  return out;
}
const pts = (s: StrokeSample[]): Vec2[] => s.map((p) => [p.x, p.y]);
const empty: SketchData = { entities: [], constraints: [] };
const curves = (es: readonly SketchEntity[]) => es.filter((e) => e.kind !== 'point');

describe('Pencil strokes → sketch edits', () => {
  it('a rectangle becomes four constrained lines', () => {
    const s = stroke([
      [0, 0],
      [40, 0],
      [40, 20],
      [0, 20],
      [0, 0],
    ]);
    const r = strokeEdit(recognizeStroke(s, { tolerance: 2 }), pts(s), empty, 2);
    expect(r?.kind).toBe('add');
    if (r?.kind !== 'add') return;
    expect(r.shape).toBe('rectangle');
    expect(curves(r.edit.entities).map((e) => e.kind)).toEqual(['line', 'line', 'line', 'line']);
    expect(r.edit.constraints.map((c) => c.kind).sort()).toEqual([
      'horizontal',
      'horizontal',
      'vertical',
      'vertical',
    ]);
  });

  it('a line ending on an existing point merges with it (end-point inference)', () => {
    const existing = lineTool([0, 0], [30, 0]);
    const sketch: SketchData = existing;
    const end = existing.entities.find((e) => e.kind === 'point' && e.x === 30);
    const s = stroke([
      [30.6, 0.4],
      [30.4, 25],
    ]);
    const r = strokeEdit(recognizeStroke(s, { tolerance: 2 }), pts(s), sketch, 2);
    expect(r?.kind).toBe('add');
    if (r?.kind !== 'add') return;
    expect(r.shape).toBe('line');
    const coincident = r.edit.constraints.find((c) => c.kind === 'coincident');
    expect(coincident && 'b' in coincident ? coincident.b : null).toBe(end?.id);
  });

  it('a circle keeps its centre: closed shapes get no end-point snaps', () => {
    const ring: Vec2[] = [];
    for (let i = 0; i <= 48; i++) {
      const t = (i / 48) * 2 * Math.PI;
      ring.push([10 * Math.cos(t), 10 * Math.sin(t)]);
    }
    const s = stroke(ring, 2, 0.02);
    const sketch: SketchData = lineTool([-20, 0.5], [20, 0.5]); // passes by the centre
    const r = strokeEdit(recognizeStroke(s, { tolerance: 2 }), pts(s), sketch, 2);
    expect(r?.kind === 'add' && r.shape).toBe('circle');
    if (r?.kind === 'add') expect(r.edit.constraints).toEqual([]);
  });

  it('an unsure stroke is kept as a polyline', () => {
    const s = stroke([
      [0, 0],
      [10, 3],
    ]);
    const rec = recognizeStroke(s, { tolerance: 1 });
    if (!rec) throw new Error('no recognition');
    const unsure = {
      ...rec,
      confidence: 0.2,
      shape: { kind: 'circle' as const, center: [0, 0] as Vec2, radius: 4 },
    };
    const r = strokeEdit(unsure, pts(s), empty, 1);
    expect(r?.kind === 'add' && r.shape).toBe('polyline');
    if (r?.kind === 'add')
      expect(curves(r.edit.entities).every((e) => e.kind === 'line')).toBe(true);
  });

  it('a scribble erases what it crosses', () => {
    const a = lineTool([0, 0], [40, 0]);
    const b = lineTool([0, 30], [40, 30]);
    const sketch: SketchData = {
      entities: [...a.entities, ...b.entities],
      constraints: [],
    };
    const line = (f: typeof a) => f.entities.find((e) => e.kind === 'line')?.id;
    const scribble: Vec2[] = [];
    for (let i = 0; i < 12; i++) scribble.push([10 + (i % 2) * 8, -4 + i * 0.6]);
    const r = strokeEdit(
      { shape: { kind: 'scribble', points: scribble }, confidence: 0.9, implied: [] },
      scribble,
      sketch,
      2,
    );
    expect(r).toEqual({ kind: 'erase', ids: [line(a)] });
    expect(
      crossedEntities(
        sketch,
        [
          [100, 100],
          [101, 101],
        ],
        1,
      ),
    ).toEqual([]);
    expect(strokeEdit(null, [], sketch, 1)).toBeNull();
  });

  it('geometry helpers: segment distance and simplification', () => {
    expect(segmentDistance([0, 0], [10, 0], [5, -1], [5, 1])).toBe(0);
    expect(segmentDistance([0, 0], [10, 0], [0, 3], [10, 3])).toBeCloseTo(3);
    expect(
      simplify(
        [
          [0, 0],
          [5, 0.01],
          [10, 0],
          [10, 10],
        ],
        0.1,
      ),
    ).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });
});
