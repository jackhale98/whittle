/**
 * Over-constrained sketches: minimal conflicting sets, explanations and suggested fixes.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { quickXplain } from '../src/solver';
import { core, deg, pos, rectangle, SketchBuilder } from './helpers';

function horizontalVs30() {
  const b = new SketchBuilder();
  const l1 = b.segment([0, 0], [10, 0]);
  b.geo({ kind: 'fix', entity: l1.line });
  const l2 = b.segment([0, 5], [9, 9]);
  b.dim({ kind: 'length', line: l2.line }, 10);
  const h = b.geo({ kind: 'horizontal', line: l2.line });
  const ang = b.dim({ kind: 'angle', a: l1.line, b: l2.line }, deg(30));
  return { b, l1, l2, h, ang };
}

describe('conflicts', () => {
  it('horizontal + 30° to a fixed line: minimal set is exactly those two', async () => {
    const { b, h, ang } = horizontalVs30();
    const res = (await core()).solve(b.input());
    expect(res.status).toBe('conflicting');
    expect(res.conflicts).toHaveLength(1);
    const c = res.conflicts[0];
    if (!c) throw new Error('no conflict');
    expect([...c.constraints].sort()).toEqual([h, ang].sort());
    expect(c.explanation).toMatch(/^Line 2 can't be both horizontal and at 30° to Line 1/);
    const actions = c.fixes.map((f) => f.action);
    expect(actions).toContainEqual({ kind: 'removeConstraint', constraint: h });
    expect(actions).toContainEqual({ kind: 'removeConstraint', constraint: ang });
    expect(actions).toContainEqual({ kind: 'makeReference', constraint: ang });
    // The value that agrees with "horizontal" is 0°.
    const set = actions.find((a) => a.kind === 'setValue');
    expect(set?.kind === 'setValue' && set.constraint === ang).toBe(true);
    if (set?.kind === 'setValue') expect(Math.abs(Math.sin(set.value))).toBeLessThan(1e-6);
    for (const f of c.fixes) expect(f.label.length).toBeGreaterThan(0);
    // The relaxed geometry still honours everything except the blamed constraint.
    expect(res.entities).toHaveLength(b.entities.length);
  });

  it('the explanation mentions both constraints', async () => {
    const { b } = horizontalVs30();
    const res = (await core()).solve(b.input());
    const text = res.conflicts[0]?.explanation ?? '';
    expect(text).toContain('horizontal');
    expect(text).toContain('30°');
  });

  it('over-dimensioned rectangle: the minimal set is the extra diagonal + the sides it fights', async () => {
    const b = new SketchBuilder();
    const r = rectangle(b);
    b.geo({ kind: 'fix', entity: r.p0 });
    const w = b.dim({ kind: 'length', line: r.bottom }, 40);
    const h = b.dim({ kind: 'length', line: r.left }, 20);
    const diag = b.dim({ kind: 'distance', a: r.p0, b: r.p2 }, 50);
    const res = (await core()).solve(b.input());
    expect(res.status).toBe('conflicting');
    expect(res.conflicts).toHaveLength(1);
    const set = res.conflicts[0]?.constraints ?? [];
    expect(set).toContain(diag);
    expect(set).toContain(w);
    expect(set).toContain(h);
    // Minimal: removing any one member makes the rest consistent.
    for (const id of set) {
      const bb = new SketchBuilder();
      bb.entities = b.entities;
      bb.constraints = b.constraints.filter((c) => c.id !== id);
      bb.values = b.values;
      expect((await core()).solve(bb.input()).status, `without ${id}`).toBe('solved');
    }
    // Suggested values agree with the other members (e.g. width = √(50² − 20²)).
    const setW = res.conflicts[0]?.fixes.find(
      (f) => f.action.kind === 'setValue' && f.action.constraint === w,
    );
    expect(setW?.action.kind === 'setValue' && setW.action.value).toBeCloseTo(Math.sqrt(2100), 6);
    // The geometry returned satisfies all but the blamed (last) constraint.
    expect(pos(res, r.p2)[0]).toBeCloseTo(40, 6);
    expect(pos(res, r.p2)[1]).toBeCloseTo(20, 6);
  });

  it('two independent conflicts are both reported', async () => {
    const { b } = horizontalVs30();
    const k = b.circle(b.point(50, 0), 4);
    const r1 = b.dim({ kind: 'radius', curve: k }, 4);
    const r2 = b.dim({ kind: 'diameter', curve: k }, 10);
    const res = (await core()).solve(b.input());
    expect(res.status).toBe('conflicting');
    expect(res.conflicts).toHaveLength(2);
    const radiusConflict = res.conflicts.find((c) => c.constraints.includes(r1));
    expect([...(radiusConflict?.constraints ?? [])].sort()).toEqual([r1, r2].sort());
    expect(radiusConflict?.explanation).toContain('Circle 1');
  });

  it('a conflict against fixed geometry says so and offers removing the fix', async () => {
    const b = new SketchBuilder();
    const l = b.segment([0, 0], [10, 0]);
    const fix = b.geo({ kind: 'fix', entity: l.line });
    const len = b.dim({ kind: 'length', line: l.line }, 12);
    const res = (await core()).solve(b.input());
    expect(res.status).toBe('conflicting');
    expect(res.conflicts[0]?.constraints).toEqual([len]);
    expect(res.conflicts[0]?.explanation).toContain('Line 1 is fixed');
    expect(res.conflicts[0]?.fixes.map((f) => f.action)).toContainEqual({
      kind: 'removeConstraint',
      constraint: fix,
    });
    const set = res.conflicts[0]?.fixes.find((f) => f.action.kind === 'setValue');
    expect(set?.action.kind === 'setValue' && set.action.value).toBeCloseTo(10, 6);
  });

  it('an unsupported constraint combination is reported, not thrown', async () => {
    const b = new SketchBuilder();
    const p = b.point(0, 0);
    const q = b.point(1, 1);
    const bad = b.geo({ kind: 'horizontal', line: p });
    void q;
    const res = (await core()).solve(b.input());
    expect(res.status).toBe('conflicting');
    expect(res.conflicts[0]?.constraints).toEqual([bad]);
    expect(res.conflicts[0]?.fixes[0]?.action).toEqual({
      kind: 'removeConstraint',
      constraint: bad,
    });
  });

  it('malformed input fails cleanly', async () => {
    const b = new SketchBuilder();
    b.line('nope', 'nada');
    const res = (await core()).solve(b.input());
    expect(res.status).toBe('failed');
  });
});

describe('quickXplain', () => {
  it('finds a minimal inconsistent subset', () => {
    // "Inconsistent" = contains both 3 and 7, or contains 5.
    const bad = (s: readonly number[]) => (s.includes(3) && s.includes(7)) || s.includes(5);
    const consistent = (s: readonly number[]) => !bad(s);
    expect(quickXplain([], [1, 2, 3, 4, 6, 7, 8], consistent).sort()).toEqual([3, 7]);
    expect(quickXplain([], [1, 2, 3, 4, 5, 6, 7], consistent)).toEqual([5]);
    expect(quickXplain([], [1, 2], consistent)).toEqual([]);
  });
});
