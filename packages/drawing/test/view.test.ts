import type { Vec3 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  isoFrame,
  orientationFrame,
  partToSheet,
  projectionRequest,
  rotateFrame,
  type SolvedView,
  sideFrame,
  solveViews,
  viewOutline,
} from '../src/view';
import { drawing, evaluate, PART_BOUNDS } from './fixtures';

const close = (a: Vec3, b: Vec3) => {
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i] as number, 9);
};

function solved(d = drawing()) {
  const m = solveViews({ drawing: d, bounds: PART_BOUNDS, evaluate });
  const get = (id: string) => {
    const v = m.get(id);
    if (!v?.ok) throw new Error(`${id} failed: ${JSON.stringify(v && !v.ok ? v.problems : null)}`);
    return v;
  };
  return { m, get };
}

describe('frames', () => {
  it('named views follow the viewport directions (front looks along +Y, Z up)', () => {
    const f = orientationFrame({ kind: 'named', name: 'front' });
    close(f.n, [0, -1, 0]);
    close(orientationFrame({ kind: 'named', name: 'top' }).n, [0, 0, 1]);
    close(orientationFrame({ kind: 'named', name: 'right' }).n, [1, 0, 0]);
    close(orientationFrame({ kind: 'named', name: 'left' }).n, [-1, 0, 0]);
    close(orientationFrame({ kind: 'named', name: 'back' }).n, [0, 1, 0]);
    close(orientationFrame({ kind: 'named', name: 'bottom' }).n, [0, 0, -1]);
  });
  it('projected sides of the front view are the named views', () => {
    const front = orientationFrame({ kind: 'named', name: 'front' });
    for (const [side, name] of [
      [[0, 1], 'top'],
      [[0, -1], 'bottom'],
      [[1, 0], 'right'],
      [[-1, 0], 'left'],
    ] as const) {
      const f = sideFrame(front, [side[0], side[1]]);
      const g = orientationFrame({ kind: 'named', name });
      close(f.x, g.x);
      close(f.y, g.y);
    }
  });
  it('isometric matches the viewport iso direction', () => {
    const f = isoFrame(orientationFrame({ kind: 'named', name: 'front' }), 'topRight');
    const s = 1 / Math.sqrt(3);
    close(f.n, [s, -s, s]);
    expect(f.y[2]).toBeGreaterThan(0);
  });
  it('re-orthonormalises matrix orientations', () => {
    const f = orientationFrame({ kind: 'matrix', x: [2, 0, 0], y: [0.001, 0, 1] });
    close(f.x, [1, 0, 0]);
    close(f.y, [0, 0, 1]);
  });
  it('rotation turns the content CCW', () => {
    const f = rotateFrame(orientationFrame({ kind: 'named', name: 'front' }), Math.PI / 2);
    // A point on +X (right) now appears at the top of the view.
    expect(f.y[0]).toBeCloseTo(1);
  });
});

describe('solveViews', () => {
  it('places first-angle children opposite the side they are seen from', () => {
    const { get } = solved();
    const base = get('V1');
    expect(get('V2').position).toEqual([base.position[0], base.position[1] - 90]);
    expect(get('V3').position).toEqual([base.position[0] - 120, base.position[1]]);
  });
  it('switching to third angle mirrors aligned views with zero view edits', () => {
    const d1 = drawing();
    const d3 = drawing({ projection: 'third' });
    expect(d3.views).toEqual(d1.views);
    const { get } = solved(d3);
    const base = get('V1');
    expect(get('V2').position).toEqual([base.position[0], base.position[1] + 90]);
    expect(get('V3').position).toEqual([base.position[0] + 120, base.position[1]]);
  });
  it('centres a view on its projected 3D bounding box', () => {
    const { get } = solved();
    const v = get('V1');
    expect(v.center).toEqual([50, 20]);
    expect(partToSheet(v, [50, 0, 20])).toEqual([190, 190]);
    expect(viewOutline(v)).toEqual({ min: [140, 170], max: [240, 210] });
  });
  it('derives scales: sheet for base, parent for projected, own for detail', () => {
    const d = drawing();
    d.sheets[0]!.scale = '1/2';
    d.views.push({
      id: 'V6',
      sheetId: 'S1',
      kind: 'detail',
      parentId: 'V2',
      letter: 'B',
      center: { kind: 'free', at: [50, 30] },
      radius: 15,
      scale: '2',
      layout: { kind: 'free', position: [60, 60] },
    });
    const { get } = solved(d);
    expect(get('V1').scale).toBe(0.5);
    expect(get('V2').scale).toBe(0.5);
    expect(get('V6').scale).toBe(2);
    expect(get('V6').clip).toEqual({ center: [50, 30], radius: 15 });
    expect(get('V6').center).toEqual([50, 30]);
  });
  it('re-derives children when the parent rotates (T5)', () => {
    const d = drawing();
    const v1 = d.views[0]!;
    if (v1.kind === 'base') v1.rotation = '90deg';
    const { get } = solved(d);
    const top = get('V2');
    const base = get('V1');
    // The top view is still seen from the parent's top: its n is the parent's (rotated) y.
    close(top.frame.n, base.frame.y);
  });
  it('builds the section request from the cut line', () => {
    const { get } = solved();
    const s = get('V4');
    expect(s.section?.cut).toEqual([
      [50, 0, -10],
      [50, 0, 50],
    ]);
    close(s.section!.along, [0, 1, 0]);
    close(s.section!.look, [1, 0, 0]);
    // The viewer looks along +X, i.e. the view is a left-side view of the cut.
    close(s.frame.n, [-1, 0, 0]);
    const req = projectionRequest(s, 'shape', 'exact');
    expect(req.section?.depth).toBe('full');
    expect(req.frame).toEqual({ x: s.frame.x, y: s.frame.y });
  });
  it('maps display to hidden/smooth flags', () => {
    const d = drawing();
    d.views[0]!.display = { lines: 'visibleAndHidden', tangentEdges: 'thin' };
    const { get } = solved(d);
    const r = projectionRequest(get('V2') as SolvedView, 'k', 'draft');
    expect(r.hidden).toBe(true);
    expect(r.smooth).toBe(true);
  });
  it('flags missing parents, cycles, bad scales and unresolved anchors; never guesses', () => {
    const d = drawing({}, [
      {
        id: 'B',
        sheetId: 'S1',
        kind: 'base',
        orientation: { kind: 'named', name: 'front' },
        scale: 'oops',
        layout: { kind: 'free', position: [0, 0] },
      },
      {
        id: 'C1',
        sheetId: 'S1',
        kind: 'projected',
        parentId: 'C2',
        from: 'top',
        layout: { kind: 'aligned', distance: 10 },
      },
      {
        id: 'C2',
        sheetId: 'S1',
        kind: 'projected',
        parentId: 'C1',
        from: 'top',
        layout: { kind: 'aligned', distance: 10 },
      },
      {
        id: 'M',
        sheetId: 'S1',
        kind: 'iso',
        parentId: 'gone',
        corner: 'topLeft',
        layout: { kind: 'free', position: [0, 0] },
      },
      {
        id: 'OK',
        sheetId: 'S1',
        kind: 'base',
        orientation: { kind: 'named', name: 'top' },
        layout: { kind: 'free', position: [0, 0] },
      },
      {
        id: 'S',
        sheetId: 'S1',
        kind: 'section',
        parentId: 'OK',
        letter: 'A',
        look: 'left',
        cut: [
          { kind: 'ref', ref: { name: 'F9:gone', kind: 'edge' }, point: 'center' },
          { kind: 'free', at: [0, 10] },
        ],
        layout: { kind: 'aligned', distance: 50 },
      },
    ]);
    const m = solveViews({
      drawing: d,
      bounds: PART_BOUNDS,
      evaluate,
      resolveRef: () => undefined,
    });
    const problems = (id: string) => {
      const v = m.get(id);
      return v && !v.ok ? v.problems.map((p) => p.kind) : [];
    };
    expect(problems('B')).toEqual(['scaleInvalid']);
    expect(problems('C1')).toEqual(['parentCycle']);
    expect(problems('C2')).toEqual(['parentCycle']);
    expect(problems('M')).toEqual(['parentMissing']);
    expect(problems('S')).toEqual(['pointUnresolved']);
    expect(m.get('OK')?.ok).toBe(true);
  });
  it('follows a resolved anchored point (a section through a hole axis)', () => {
    const d = drawing();
    const s = d.views[3]!;
    if (s.kind === 'section')
      s.cut[0] = {
        kind: 'ref',
        ref: { name: 'F2:bore', kind: 'face' },
        point: 'axis',
        offset: [0, -50],
      };
    const m = solveViews({
      drawing: d,
      bounds: PART_BOUNDS,
      evaluate,
      resolveRef: () => [50, 30, 40],
    });
    const v = m.get('V4');
    expect(v?.ok && v.section?.cut[0]).toEqual([50, 0, -10]);
  });
});
