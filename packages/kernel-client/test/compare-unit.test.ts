/**
 * `geometricDiff` failure paths and noise handling with a scripted fake kernel (no Wasm): failed
 * booleans become human-readable `KernelError`s, temporaries are always released, and slivers
 * within boolean noise are reported as an empty difference.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  BooleanFeature,
  Feature,
  FeatureInputs,
  MassProperties,
  MeshBuffers,
  Result,
  ShapeHandle,
} from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import { type DiffKernel, type DiffSide, geometricDiff } from '../src/regen/compare';

const OPTS = { linearDeflection: 0.004, angularDeflection: 0.5, relative: true };

function mass(volume: number, faceCount = volume > 0 ? 6 : 0): MassProperties {
  return {
    volume,
    area: 0,
    centroid: [0, 0, 0],
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    faceCount,
    edgeCount: 0,
    vertexCount: 0,
  };
}

const MESH: MeshBuffers = {
  positions: new Float32Array(9),
  normals: new Float32Array(9),
  indices: new Uint32Array([0, 1, 2]),
  faceRanges: new Uint32Array([0, 1]),
  edgePositions: new Float32Array(0),
  edgeRanges: new Uint32Array(0),
  faceNames: ['kernel-name'],
  edgeNames: [],
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
};

/** A fake kernel: shapes are numbers; `volumes` gives each shape's volume. */
class FakeKernel implements DiffKernel {
  next = 100;
  live = new Set<ShapeHandle>();
  released: ShapeHandle[] = [];
  calls: { op: BooleanFeature['op']; inputs: FeatureInputs }[] = [];
  constructor(
    private readonly volumes: Map<ShapeHandle, number>,
    private readonly results: (op: BooleanFeature['op']) => Result<number>,
  ) {}
  async exec(feature: Feature, inputs: FeatureInputs) {
    const op = (feature as BooleanFeature).op;
    this.calls.push({ op, inputs });
    const r = this.results(op);
    if (!r.ok) return r;
    const shape = this.next++;
    this.live.add(shape);
    this.volumes.set(shape, r.value);
    const name = { name: `FCOMPARE:face(x)`, kind: 'face' as const, index: 0 };
    return { ok: true as const, value: { shape, naming: [name], warnings: [] } };
  }
  async mesh() {
    return { ok: true as const, value: structuredClone(MESH) };
  }
  async massProperties(shape: ShapeHandle) {
    return { ok: true as const, value: mass(this.volumes.get(shape) ?? 0) };
  }
  async release(shape: ShapeHandle) {
    this.live.delete(shape);
    this.released.push(shape);
  }
}

const side = (label: string, shapes: ShapeHandle[], keys = shapes.map(String)): DiffSide => ({
  label,
  bodies: shapes.map((shape) => ({ shape, naming: [] })),
  keys,
});

const failure = (message: string): Result<number> => ({
  ok: false,
  error: { code: 'OCCT_EXCEPTION', message, detail: 'BOPAlgo_AlertTooFewArguments' },
});

describe('geometricDiff (fake kernel)', () => {
  it('a failed cut is an OPERATION_FAILED error naming both sides; temporaries are released', async () => {
    const vols = new Map([
      [1, 10],
      [2, 10],
      [3, 12],
    ]);
    const k = new FakeKernel(vols, (op) =>
      op === 'cut' ? failure('boom') : { ok: true, value: 20 },
    );
    const r = await geometricDiff(k, side('version 1', [1, 2]), side('the live model', [3]), OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('OPERATION_FAILED');
    expect(r.error.message).toBe(
      'Could not work out the material added between version 1 and the live model',
    );
    expect(r.error.detail).toBe('BOPAlgo_AlertTooFewArguments');
    expect(r.error.hint).toBeTruthy();
    // The union of A was created and released; engine-owned bodies were never released.
    expect(k.calls.map((c) => c.op)).toEqual(['add', 'cut']);
    expect(k.live.size).toBe(0);
    expect(k.released).toEqual([100]);
  });

  it('a failed union is an error naming the side', async () => {
    const k = new FakeKernel(new Map(), () => failure('fuse failed'));
    const r = await geometricDiff(k, side('version 7', [1, 2]), side('the live model', [3]), OPTS);
    expect(!r.ok && r.error.message).toBe('Could not combine the bodies of version 7');
    expect(k.released).toEqual([]);
  });

  it('unions with tools in key order and cuts union(B) − union(A) and back', async () => {
    const vols = new Map([
      [1, 10],
      [2, 10],
      [3, 10],
      [4, 10],
    ]);
    let n = 0;
    const k = new FakeKernel(vols, (op) => ({ ok: true, value: op === 'add' ? 18 : ++n }));
    const r = await geometricDiff(k, side('A', [1, 2]), side('B', [3, 4]), OPTS);
    if (!r.ok) throw new Error(r.error.message);
    const [ua, ub, added, removed] = k.calls;
    expect(ua?.inputs).toMatchObject({ target: 1, shapes: { tools0000: 2 } });
    expect(ub?.inputs).toMatchObject({ target: 3, shapes: { tools0000: 4 } });
    expect(added?.inputs).toMatchObject({ target: 101, shapes: { tools0000: 100 } });
    expect(removed?.inputs).toMatchObject({ target: 100, shapes: { tools0000: 101 } });
    expect(r.value.addedVolume).toBe(1);
    expect(r.value.removedVolume).toBe(2);
    expect(r.value.a.mass.volume).toBe(18);
    // Names that carry the internal compare id are not document names: left empty.
    expect(r.value.added[0]?.faceNames).toEqual(['']);
    expect(k.live.size).toBe(0);
  });

  it('slivers within boolean noise are an empty difference with volume 0', async () => {
    const vols = new Map([
      [1, 1000],
      [2, 1000],
    ]);
    const k = new FakeKernel(vols, () => ({ ok: true, value: 1e-9 }));
    const r = await geometricDiff(k, side('A', [1]), side('B', [2]), OPTS);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toMatchObject({ added: [], removed: [], addedVolume: 0, removedVolume: 0 });
    expect(k.live.size).toBe(0);
  });

  it('equal body content keys short-cut to an empty diff without booleans', async () => {
    const vols = new Map([
      [1, 5],
      [2, 5],
    ]);
    const k = new FakeKernel(vols, () => failure('must not run'));
    const r = await geometricDiff(k, side('A', [1], ['k']), side('B', [2], ['k']), OPTS);
    expect(r.ok && r.value.addedVolume + r.value.removedVolume).toBe(0);
    expect(k.calls).toEqual([]);
  });

  it('two empty sides: empty diff and zero mass (with a density: zero mass and inertia)', async () => {
    const k = new FakeKernel(new Map(), () => failure('must not run'));
    const a: DiffSide = { ...side('A', []), density: 2.7e-6 };
    const r = await geometricDiff(k, a, side('B', []), OPTS);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.a.mass.mass).toBe(0);
    expect(r.value.b.mass.mass).toBeUndefined();
    expect(r.value.added).toEqual([]);
  });
});
