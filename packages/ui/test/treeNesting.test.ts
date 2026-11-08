import type { Feature } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import {
  allowedRollbacks,
  computeNesting,
  planUnitMove,
  referencedNames,
  sharedCount,
  snapRollback,
  topLevel,
} from '../src/logic/treeNesting';

/* ------------------------------------------------------------- minimal documents */

const base = (id: string, name = id) => ({ id, name, suppressed: false });
const region = (sketch: string, n = 1) => ({
  name: `S${sketch}:region(e${n})`,
  kind: 'region' as const,
});

const sketch = (id: string, on = 'origin:XY'): Feature => ({
  ...base(id),
  type: 'sketch',
  on: { name: on, kind: 'face' },
  entities: [],
  constraints: [],
});
const extrude = (id: string, sketches: string[], extra: Partial<Feature> = {}): Feature =>
  ({
    ...base(id),
    type: 'extrude',
    profile: sketches.map((s) => region(s)),
    direction: 'normal',
    end: { kind: 'blind', depth: '10 mm' },
    op: 'new',
    ...extra,
  }) as Feature;
const revolve = (id: string, sketch: string, axis = 'origin:Z'): Feature => ({
  ...base(id),
  type: 'revolve',
  profile: [region(sketch)],
  axis: { name: axis, kind: 'edge' },
  angle: '360 deg',
  direction: 'normal',
  op: 'new',
});
const fillet = (id: string, edge: string): Feature => ({
  ...base(id),
  type: 'fillet',
  edges: [{ name: edge, kind: 'edge' }],
  radius: '1 mm',
});
const importer = (id: string): Feature => ({
  ...base(id),
  type: 'import',
  source: { path: 'imports/x.step', format: 'step', sha256: 'ab', fileName: 'x.step' },
  op: 'new',
});

const ids = (fs: readonly Feature[]) => fs.map((f) => f.id);

describe('referencedNames', () => {
  it('finds profile, axis, up-to target, scopes and annotations', () => {
    const f = extrude('E', ['A'], {
      end: { kind: 'upTo', target: { name: 'SB:region(e1)', kind: 'region' } },
      scope: { kind: 'bodies', bodies: [{ name: 'BX', kind: 'body' }] },
      annotations: [
        { id: 'P', kind: 'linear', refs: [{ name: 'SC:e(e2)', kind: 'edge' }] },
      ] as never,
    });
    expect(referencedNames(f).sort()).toEqual(
      ['BX', 'SA:region(e1)', 'SB:region(e1)', 'SC:e(e2)'].sort(),
    );
  });
  it('ignores display names and kinds that are not entity references', () => {
    expect(referencedNames({ name: 'Sketch 1', type: 'sketch' })).toEqual([]);
    expect(referencedNames({ name: 'SA:x', kind: 'blind' })).toEqual([]);
  });
});

describe('computeNesting', () => {
  it('nests a sketch consumed by exactly one feature under it', () => {
    const fs = [sketch('A'), extrude('E', ['A'])];
    const n = computeNesting(fs);
    expect(n.parentOf.get('A')).toBe('E');
    expect(n.childrenOf.get('E')).toEqual(['A']);
    expect(topLevel(fs, n)).toEqual(['E']);
    expect(sharedCount(n, 'A')).toBe(0);
  });

  it('keeps a shared sketch top-level with a used-by count', () => {
    const fs = [sketch('A'), extrude('E1', ['A']), extrude('E2', ['A'], { op: 'cut' } as never)];
    const n = computeNesting(fs);
    expect(n.parentOf.size).toBe(0);
    expect(topLevel(fs, n)).toEqual(['A', 'E1', 'E2']);
    expect(sharedCount(n, 'A')).toBe(2);
    expect(n.consumers.get('A')).toEqual(['E1', 'E2']);
  });

  it('keeps an unused sketch top-level (a new sketch until something consumes it)', () => {
    const fs = [sketch('A'), sketch('B'), extrude('E', ['A'])];
    const n = computeNesting(fs);
    expect(topLevel(fs, n)).toEqual(['B', 'E']);
    expect(sharedCount(n, 'B')).toBe(0);
    expect(n.consumers.has('B')).toBe(false);
    // ... and tucks under the feature as soon as one consumes it
    const after = [...fs, extrude('E2', ['B'])];
    expect(computeNesting(after).parentOf.get('B')).toBe('E2');
  });

  it('counts an up-to target as consumption', () => {
    const fs = [
      sketch('A'),
      sketch('B'),
      extrude('E', ['A'], {
        end: { kind: 'upTo', target: { name: 'SB:region(e1)', kind: 'region' } },
      } as never),
    ];
    const n = computeNesting(fs);
    expect(n.childrenOf.get('E')).toEqual(['A', 'B']);
    expect(topLevel(fs, n)).toEqual(['E']);
  });

  it('counts a revolve axis taken from a sketch line (axis only, no profile of it)', () => {
    const fs = [sketch('P'), sketch('L'), revolve('R', 'P', 'SL:e(e1)')];
    const n = computeNesting(fs);
    expect(n.parentOf.get('L')).toBe('R');
    expect(n.parentOf.get('P')).toBe('R');
    // a sketch that is only the axis of one feature and the profile of another is shared
    const fs2 = [sketch('P'), sketch('L'), revolve('R', 'P', 'SL:e(e1)'), extrude('E', ['L'])];
    const n2 = computeNesting(fs2);
    expect(n2.parentOf.has('L')).toBe(false);
    expect(sharedCount(n2, 'L')).toBe(2);
  });

  it('a suppressed consumer still holds its sketch', () => {
    const e = { ...extrude('E', ['A']), suppressed: true } as Feature;
    const n = computeNesting([sketch('A'), e]);
    expect(n.parentOf.get('A')).toBe('E');
  });

  it('a second consumer that is suppressed still makes the sketch shared', () => {
    const e2 = { ...extrude('E2', ['A']), suppressed: true } as Feature;
    const n = computeNesting([sketch('A'), extrude('E1', ['A']), e2]);
    expect(sharedCount(n, 'A')).toBe(2);
  });

  it('imports and primitives consume nothing; a fillet of an extrude does not consume its sketch', () => {
    const fs = [
      importer('I'),
      sketch('A'),
      extrude('E', ['A']),
      // edge names carry the sketch only inside: F…:side(SA:e1)
      fillet('F', 'edge(FE:side(SA:e(e1))|FE:end)'),
    ];
    const n = computeNesting(fs);
    expect(n.parentOf.get('A')).toBe('E');
    expect(n.childrenOf.has('I')).toBe(false);
    expect(n.consumers.get('A')).toEqual(['E']);
    expect(topLevel(fs, n)).toEqual(['I', 'E', 'F']);
  });

  it('a sketch placed on another sketch does not consume it (one level deep)', () => {
    const fs = [sketch('A'), sketch('B', 'SA:region(e1)'), extrude('E', ['B'])];
    const n = computeNesting(fs);
    expect(n.parentOf.has('A')).toBe(false);
    expect(n.parentOf.get('B')).toBe('E');
  });

  it('does not nest under a consumer listed before the sketch', () => {
    const fs = [extrude('E', ['A']), sketch('A')];
    const n = computeNesting(fs);
    expect(n.parentOf.size).toBe(0);
    expect(topLevel(fs, n)).toEqual(['E', 'A']);
  });

  it('sketch ids that merely share a prefix do not collide', () => {
    const fs = [sketch('A'), sketch('AB'), extrude('E', ['AB'])];
    const n = computeNesting(fs);
    expect(n.parentOf.get('AB')).toBe('E');
    expect(n.parentOf.has('A')).toBe(false);
  });
});

describe('allowedRollbacks / snapRollback', () => {
  it('forbids stopping between a feature and its nested sketch', () => {
    const fs = [sketch('A'), extrude('E', ['A']), sketch('B'), extrude('G', ['B'])];
    const n = computeNesting(fs);
    // positions: 0 | A 1 E 2 | B 3 G 4 ; nested A->E blocks r=1,2? r=1 splits (A | E); r=2 is after E
    expect(allowedRollbacks(fs, n)).toEqual([0, 2, 4]);
  });
  it('is every position when nothing is nested', () => {
    const fs = [sketch('A'), extrude('E', ['A']), extrude('F', ['A'])];
    expect(allowedRollbacks(fs, computeNesting(fs))).toEqual([0, 1, 2, 3]);
  });
  it('a non-adjacent nested sketch blocks everything between it and its feature', () => {
    const fs = [sketch('A'), sketch('B'), extrude('E', ['A'])];
    expect(allowedRollbacks(fs, computeNesting(fs))).toEqual([0, 3]);
  });
  it('snaps to the nearest allowed stop', () => {
    const allowed = [0, 2, 4];
    expect(snapRollback(1, allowed, 1)).toBe(2);
    expect(snapRollback(1, allowed, -1)).toBe(0);
    expect(snapRollback(3, allowed)).toBe(2); // ties go back
    expect(snapRollback(4, allowed)).toBe(4);
    expect(snapRollback(9, allowed, 1)).toBe(4);
  });
});

/** Applies steps as the document's `moveFeature` does. */
function apply(fs: readonly Feature[], steps: ReturnType<typeof planUnitMove>): string[] {
  const out = ids(fs);
  for (const s of steps) {
    const from = out.indexOf(s.id);
    expect(from).toBe(s.from);
    out.splice(from, 1);
    out.splice(s.toIndex, 0, s.id);
  }
  return out;
}

describe('planUnitMove', () => {
  const fs = [
    sketch('A'),
    extrude('E1', ['A']),
    sketch('B'),
    extrude('E2', ['B']),
    fillet('F', 'edge(FE2:end)'),
  ];
  const n = computeNesting(fs);

  it('top-level items are E1, E2, F', () => {
    expect(topLevel(fs, n)).toEqual(['E1', 'E2', 'F']);
  });

  it('moving a feature up takes its sketch along, sketch immediately before it', () => {
    const steps = planUnitMove(fs, n, 'E2', 0);
    expect(apply(fs, steps)).toEqual(['B', 'E2', 'A', 'E1', 'F']);
    // sketch moves first so no intermediate state puts the feature above its sketch
    expect(steps.map((s) => s.id)).toEqual(['B', 'E2']);
  });

  it('moving a feature down takes its sketch along, feature first', () => {
    const steps = planUnitMove(fs, n, 'E1', 1);
    expect(apply(fs, steps)).toEqual(['B', 'E2', 'A', 'E1', 'F']);
    expect(steps.map((s) => s.id)).toEqual(['E1', 'A']);
  });

  it('moving to the end', () => {
    expect(apply(fs, planUnitMove(fs, n, 'E1', 2))).toEqual(['B', 'E2', 'F', 'A', 'E1']);
  });

  it('a move to its own slot is a no-op', () => {
    expect(planUnitMove(fs, n, 'E1', 0)).toEqual([]);
    expect(planUnitMove(fs, n, 'E2', 1)).toEqual([]);
  });

  it('a lone top-level feature moves with one step, like a flat reorder', () => {
    const flat = computeNesting(fs.filter((f) => f.type !== 'sketch'));
    const only = fs.filter((f) => f.type !== 'sketch');
    expect(planUnitMove(only, flat, 'F', 0)).toEqual([{ id: 'F', from: 2, toIndex: 0 }]);
    expect(planUnitMove(only, flat, 'E1', 1)).toEqual([{ id: 'E1', from: 0, toIndex: 1 }]);
  });

  it('moves an unnested feature past a whole nested unit', () => {
    // F (top-level, last) to the front: before A, the first member of E1's unit
    expect(apply(fs, planUnitMove(fs, n, 'F', 0))).toEqual(['F', 'A', 'E1', 'B', 'E2']);
    // and a top-level shared sketch moves as a single item
    const shared = [
      sketch('S'),
      extrude('X', ['S']),
      extrude('Y', ['S']),
      fillet('F2', 'edge(FY:end)'),
    ];
    const sn = computeNesting(shared);
    expect(apply(shared, planUnitMove(shared, sn, 'F2', 0))).toEqual(['F2', 'S', 'X', 'Y']);
  });

  it('gathers a non-adjacent sketch next to its feature', () => {
    const gap = [sketch('A'), sketch('B'), extrude('E', ['A'])];
    const gn = computeNesting(gap);
    expect(apply(gap, planUnitMove(gap, gn, 'E', 0))).toEqual(['A', 'E', 'B']);
  });

  it('every plan ends valid: each nested sketch directly before its feature', () => {
    for (const id of ['E1', 'E2', 'F']) {
      for (let to = 0; to < 3; to++) {
        const order = apply(fs, planUnitMove(fs, n, id, to));
        for (const [s, p] of n.parentOf) expect(order.indexOf(p)).toBe(order.indexOf(s) + 1);
        const tops = order.filter((x) => !n.parentOf.has(x));
        expect(tops.indexOf(id)).toBe(to);
      }
    }
  });
});
