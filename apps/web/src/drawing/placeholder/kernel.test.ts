import type { Vec3, ViewProjectionRequest } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { PlaceholderDrawingKernel } from './kernel';
import {
  decodePlaceholderShape,
  encodePlaceholderShape,
  type PlaceholderBody,
  shapeFromRegen,
} from './shape';

/** A box with per-face vertices (as the tessellator emits them) and its 12 edges. */
function box(w: number, d: number, h: number): { body: PlaceholderBody; names: string[] } {
  const P: number[] = [];
  const I: number[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, e: Vec3) => {
    const o = P.length / 3;
    P.push(...a, ...b, ...c, ...e);
    I.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  const v = (x: number, y: number, z: number): Vec3 => [x * w, y * d, z * h];
  quad(v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)); // bottom
  quad(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)); // top
  quad(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)); // front
  quad(v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)); // back
  quad(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)); // left
  quad(v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)); // right
  const E: number[] = [];
  const R: number[] = [];
  const edge = (a: Vec3, b: Vec3) => {
    R.push(E.length / 3, 2);
    E.push(...a, ...b);
  };
  for (const z of [0, 1]) {
    edge(v(0, 0, z), v(1, 0, z));
    edge(v(1, 0, z), v(1, 1, z));
    edge(v(1, 1, z), v(0, 1, z));
    edge(v(0, 1, z), v(0, 0, z));
  }
  for (const [x, y] of [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ] as const)
    edge(v(x, y, 0), v(x, y, 1));
  return {
    body: {
      positions: new Float32Array(P),
      indices: new Uint32Array(I),
      edgePositions: new Float32Array(E),
      edgeRanges: new Uint32Array(R),
    },
    names: Array.from({ length: 12 }, (_, i) => `e${i}`),
  };
}

const FRONT = { x: [1, 0, 0] as Vec3, y: [0, 0, 1] as Vec3 };
const TOP = { x: [1, 0, 0] as Vec3, y: [0, 1, 0] as Vec3 };

async function load(body: PlaceholderBody, names: string[]) {
  const k = new PlaceholderDrawingKernel();
  const shape = {
    key: 'k',
    brep: encodePlaceholderShape([body]),
    edgeNames: names,
    faceNames: [],
    bounds: { min: [0, 0, 0] as Vec3, max: [10, 20, 30] as Vec3 },
  };
  expect(await k.loadShape(shape)).toEqual({ ok: true });
  return k;
}

const req = (
  f: { x: Vec3; y: Vec3 },
  extra: Partial<ViewProjectionRequest> = {},
): ViewProjectionRequest => ({
  shapeKey: 'k',
  frame: f,
  quality: 'draft',
  hidden: false,
  smooth: false,
  ...extra,
});

describe('placeholder drawing kernel', () => {
  it('round-trips the shape blob and refuses real BREP bytes', async () => {
    const { body } = box(10, 20, 30);
    const back = decodePlaceholderShape(encodePlaceholderShape([body]));
    expect(back?.[0]?.indices).toEqual(body.indices);
    expect(back?.[0]?.positions).toEqual(body.positions);
    const k = new PlaceholderDrawingKernel();
    const r = await k.loadShape({
      key: 'x',
      brep: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      edgeNames: [],
      faceNames: [],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    });
    expect(r.ok).toBe(false);
    expect(await k.hasShape('k')).toBe(false);
  });

  it('projects a box front view to its outline, named', async () => {
    const { body, names } = box(10, 20, 30);
    const k = await load(body, names);
    const r = await k.project(req(FRONT));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { curves, bounds } = r.value;
    expect(bounds).toEqual({ min: [0, 0], max: [10, 30] });
    const visible = curves.filter((c) => c.role === 'visible');
    expect(visible.filter((c) => c.curve.kind === 'line').length).toBeGreaterThanOrEqual(4);
    expect(visible.every((c) => c.edge === 'sharp')).toBe(true);
    expect(visible.some((c) => c.name === 'e0')).toBe(true);
    expect(curves.every((c) => c.role === 'visible')).toBe(true);
  });

  it('keeps hidden edges behind a wall only when asked', async () => {
    const a = box(10, 2, 10);
    const b = box(4, 6, 4);
    const move = (arr: Float32Array) => {
      const out = new Float32Array(arr);
      for (let i = 0; i < out.length; i += 3) {
        out[i] = (out[i] as number) + 3;
        out[i + 1] = (out[i + 1] as number) + 4;
        out[i + 2] = (out[i + 2] as number) + 3;
      }
      return out;
    };
    const k = new PlaceholderDrawingKernel();
    await k.loadShape({
      key: 'k',
      brep: encodePlaceholderShape([
        a.body,
        {
          ...b.body,
          positions: move(b.body.positions),
          edgePositions: move(b.body.edgePositions),
        },
      ]),
      edgeNames: [...a.names, ...b.names.map((n) => `b${n}`)],
      faceNames: [],
      bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    });
    const off = await k.project(req(FRONT));
    const on = await k.project(req(FRONT, { hidden: true }));
    if (!off.ok || !on.ok) throw new Error('project failed');
    expect(off.value.curves.some((c) => c.role === 'hidden')).toBe(false);
    const hidden = on.value.curves.filter((c) => c.role === 'hidden');
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((c) => c.name?.startsWith('be'))).toBe(true);
  });

  it('mirrors left and right for a side view (the frame decides, not the kernel)', async () => {
    const { body, names } = box(10, 20, 30);
    const k = await load(body, names);
    const right = await k.project(req({ x: [0, 1, 0], y: [0, 0, 1] }));
    const left = await k.project(req({ x: [0, -1, 0], y: [0, 0, 1] }));
    if (!right.ok || !left.ok) throw new Error('project failed');
    expect(right.value.bounds).toEqual({ min: [0, 0], max: [20, 30] });
    expect(left.value.bounds).toEqual({ min: [-20, 0], max: [0, 30] });
  });

  it('fits a circle seen face-on to an exact arc', async () => {
    const N = 48;
    const P: number[] = [10, 10, 4];
    const I: number[] = [];
    const E: number[] = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const p = [10 + 5 * Math.cos(a), 10 + 5 * Math.sin(a), 4];
      P.push(...p);
      E.push(...p);
      if (i > 0) I.push(0, i, i + 1);
    }
    const k = await load(
      {
        positions: new Float32Array(P),
        indices: new Uint32Array(I),
        edgePositions: new Float32Array(E),
        edgeRanges: new Uint32Array([0, N + 1]),
      },
      ['circle'],
    );
    const r = await k.project(req(TOP));
    if (!r.ok) throw new Error('project failed');
    const arc = r.value.curves.find((c) => c.name === 'circle');
    expect(arc?.curve.kind).toBe('arc');
    if (arc?.curve.kind !== 'arc') return;
    expect(arc.curve.radius).toBeCloseTo(5, 3);
    expect(arc.curve.center[0]).toBeCloseTo(10, 3);
    expect(arc.curve.end - arc.curve.start).toBeCloseTo(Math.PI * 2, 6);
    const side = await k.project(req(FRONT));
    if (!side.ok) throw new Error('project failed');
    expect(side.value.curves.every((c) => c.curve.kind !== 'arc')).toBe(true);
  });

  it('cuts a section: the far half only, with a cut face to hatch', async () => {
    const { body, names } = box(10, 20, 30);
    const k = await load(body, names);
    const r = await k.project(
      req(FRONT, {
        section: {
          cut: [
            [-5, 10, 0],
            [15, 10, 0],
          ],
          along: [0, 0, 1],
          look: [0, 1, 0],
          depth: 'full',
        },
      }),
    );
    if (!r.ok) throw new Error('project failed');
    expect(r.value.sectionFaces).toHaveLength(1);
    const loop = r.value.sectionFaces?.[0]?.loops[0]?.[0];
    expect(loop?.kind).toBe('polyline');
    if (loop?.kind !== 'polyline') return;
    const xs = loop.points.map((p) => p[0]);
    const ys = loop.points.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(0, 3);
    expect(Math.max(...xs)).toBeCloseTo(10, 3);
    expect(Math.max(...ys)).toBeCloseTo(30, 3);
  });

  it('clips a detail to its circle', async () => {
    const { body, names } = box(10, 20, 30);
    const k = await load(body, names);
    const r = await k.project(req(FRONT, { clip: { center: [0, 0], radius: 3 } }));
    if (!r.ok) throw new Error('project failed');
    for (const c of r.value.curves) {
      const pts =
        c.curve.kind === 'line'
          ? [c.curve.a, c.curve.b]
          : c.curve.kind === 'polyline'
            ? c.curve.points
            : [];
      for (const p of pts) expect(Math.hypot(p[0], p[1])).toBeLessThanOrEqual(3.001);
    }
    expect(r.value.curves.length).toBeGreaterThan(0);
  });

  it('names the shape from a regen result and keys it by content', () => {
    const { body } = box(10, 20, 30);
    const mesh = {
      ...body,
      normals: new Float32Array(0),
      faceRanges: new Uint32Array(0),
      faceNames: ['f0'],
      edgeNames: ['e0'],
      bbox: { min: [0, 0, 0] as Vec3, max: [10, 20, 30] as Vec3 },
    };
    const result = { bodies: [{ id: 'b', shape: 1, mesh }] } as never;
    const a = shapeFromRegen(result);
    const b = shapeFromRegen(result);
    expect(a.key).toBe(b.key);
    expect(a.bounds.max).toEqual([10, 20, 30]);
    expect(a.edgeNames).toEqual(['e0']);
  });
});
