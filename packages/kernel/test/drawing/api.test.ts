/**
 * The drawing worker API (src/drawing/api.ts) against a fake drawing façade: lazy init and variant
 * choice, MEMFS hand-off, idempotent loads, name checks, the LRU, request mapping, decoding and
 * recovery after a Wasm trap. No Wasm.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ShapeForDrawing, ViewProjectionRequest } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { createDrawingKernelApi, type DrawingKernelDeps } from '../../src/drawing/api';
import type {
  DrawingKernelModule,
  FacadeProjectRequest,
  RawProjection,
} from '../../src/drawing/facade';
import { Lru } from '../../src/drawing/lru';
import { tolerancesFor } from '../../src/drawing/request';
import type { KernelModuleOptions } from '../../src/facade';

const ok = (value: unknown) => JSON.stringify({ ok: true, value });

/** A drawing façade whose "BREP" is JSON `{edges, faces}`; records every call. */
class FakeDrawingKernel implements DrawingKernelModule {
  readonly files = new Map<string, Uint8Array>();
  readonly live = new Map<number, { edges: number; faces: number }>();
  readonly loads: string[] = [];
  readonly projects: { handle: number; request: FacadeProjectRequest }[] = [];
  readonly released: number[] = [];
  readonly threadsConfigured: number[] = [];
  next = 1;
  result: RawProjection = {
    curves: [
      { role: 'visible', edge: 'sharp', index: 0, curve: { kind: 'line', a: [0, 0], b: [1, 0] } },
      {
        role: 'hidden',
        edge: 'sharp',
        index: 1,
        curve: { kind: 'arc', center: [0, 0], radius: 5, start: 0, end: 2 * Math.PI },
      },
      {
        role: 'visible',
        edge: 'outline',
        index: -1,
        face: 0,
        curve: { kind: 'line', a: [0, 0], b: [0, 1] },
      },
    ],
    sectionFaces: [],
    stats: { hlrMs: 1, cutMs: 0, edges: 3, faces: 2 },
  };
  trap = false;
  constructor(readonly threads: boolean) {}
  readonly FS = {
    readFile: (path: string) => this.files.get(path) ?? new Uint8Array(),
    writeFile: (path: string, data: Uint8Array) => {
      this.files.set(path, data.slice());
    },
    unlink: (path: string) => {
      this.files.delete(path);
    },
  };
  readonly wasmMemory = {} as WebAssembly.Memory;
  drawingInfo() {
    return ok({ occtVersion: '8.0.1', buildId: 'fake', threads: this.threads, kind: 'drawing' });
  }
  loadShape(path: string) {
    this.loads.push(path);
    const bytes = this.files.get(path);
    if (bytes === undefined)
      return JSON.stringify({ ok: false, error: { code: 'INVALID_INPUT', message: 'no file' } });
    const { edges, faces } = JSON.parse(new TextDecoder().decode(bytes)) as {
      edges: number;
      faces: number;
    };
    const handle = this.next++;
    this.live.set(handle, { edges, faces });
    return ok({ handle, edges, faces, solids: 1 });
  }
  project(handle: number, requestJson: string) {
    if (this.trap) throw new WebAssembly.RuntimeError('unreachable');
    this.projects.push({ handle, request: JSON.parse(requestJson) as FacadeProjectRequest });
    return ok(this.result);
  }
  configureThreads(count: number) {
    this.threadsConfigured.push(count);
    return ok({ threads: count, max: 8 });
  }
  release(handle: number) {
    this.released.push(handle);
    this.live.delete(handle);
  }
  liveHandleCount() {
    return this.live.size;
  }
}

function setup(over: Partial<DrawingKernelDeps> = {}) {
  const instances: FakeDrawingKernel[] = [];
  const options: (KernelModuleOptions & { threadCount?: number })[] = [];
  const source = (threads: boolean) => ({
    load: async () => ({
      createInstance: async (o?: KernelModuleOptions & { threadCount?: number }) => {
        options.push(o ?? {});
        const k = new FakeDrawingKernel(threads);
        instances.push(k);
        return k;
      },
    }),
  });
  let t = 0;
  const api = createDrawingKernelApi({
    variants: { single: source(false), threaded: source(true) },
    canUseThreads: () => false,
    now: () => (t += 5),
    ...over,
  });
  return { api, instances, options };
}

const brep = (edges: number, faces: number) =>
  new TextEncoder().encode(JSON.stringify({ edges, faces }));

const shape = (key: string, over: Partial<ShapeForDrawing> = {}): ShapeForDrawing => ({
  key,
  brep: brep(2, 1),
  edgeNames: ['F1:edge(a|b)', 'F1:edge(b|c)'],
  faceNames: ['F1:face.top'],
  bounds: { min: [0, 0, 0], max: [40, 30, 10] },
  ...over,
});

const front: ViewProjectionRequest = {
  shapeKey: 'p1',
  frame: { x: [1, 0, 0], y: [0, 0, 1] },
  quality: 'exact',
  hidden: true,
  smooth: true,
};

describe('Lru', () => {
  it('evicts the least recently used by count and bytes, keeping the newest', () => {
    const lru = new Lru<string>({ maxEntries: 2, maxBytes: 100 });
    expect(lru.set('a', 'A', 10)).toEqual([]);
    expect(lru.set('b', 'B', 10)).toEqual([]);
    lru.get('a'); // a is now newest
    expect(lru.set('c', 'C', 10)).toEqual(['B']);
    expect(lru.keys()).toEqual(['a', 'c']);
    expect(lru.set('d', 'D', 95)).toEqual(['A', 'C']);
    expect(lru.keys()).toEqual(['d']);
    expect(lru.set('e', 'E', 500)).toEqual(['D']); // too big, but the newest stays
    expect(lru.bytes).toBe(500);
    expect(lru.set('e', 'E2', 1)).toEqual(['E']);
    expect(lru.delete('e')).toBe('E2');
    expect(lru.size).toBe(0);
  });
});

describe('createDrawingKernelApi', () => {
  it('loads the single-threaded kernel lazily, once', async () => {
    const { api, instances } = setup();
    expect(await api.hasShape('p1')).toBe(false);
    expect(instances).toHaveLength(0);
    await Promise.all([api.loadShape(shape('p1')), api.loadShape(shape('p2'))]);
    expect(instances).toHaveLength(1);
    expect(await api.stats()).toMatchObject({ shapes: 2, liveHandles: 2, variant: 'single' });
  });

  it('picks the threaded kernel when threads are available and caps its pool', async () => {
    const { api, instances, options } = setup({ canUseThreads: () => true, threads: 2 });
    const r = await api.init();
    expect(r.ok && r.value.variant).toBe('threaded');
    expect(options[0]?.threadCount).toBe(2);
    expect(instances[0]?.threadsConfigured).toEqual([2]);
  });

  it('refuses a module that is not the drawing kernel', async () => {
    const api = createDrawingKernelApi({
      canUseThreads: () => false,
      variants: {
        single: { load: async () => ({ createInstance: async () => ({ kernelInfo: () => '' }) }) },
        threaded: { load: async () => ({ createInstance: async () => ({}) }) },
      },
    });
    const r = await api.init();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INTERNAL');
  });

  it('hands the BREP over through MEMFS and unlinks it; loads once per key', async () => {
    const { api, instances } = setup();
    expect(await api.loadShape(shape('p1'))).toEqual({ ok: true });
    expect(await api.loadShape(shape('p1'))).toEqual({ ok: true });
    const k = instances[0] as FakeDrawingKernel;
    expect(k.loads).toHaveLength(1);
    expect(k.loads[0]).toMatch(/^\/wren-drawing-\d+\.brep$/);
    expect(k.files.size).toBe(0);
    expect(await api.hasShape('p1')).toBe(true);
  });

  it('refuses names that do not match the BREP and releases the handle', async () => {
    const { api, instances } = setup();
    const r = await api.loadShape(shape('p1', { edgeNames: ['only one'] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_INPUT');
      expect(r.error.detail).toContain('2 edges');
    }
    const k = instances[0] as FakeDrawingKernel;
    expect(k.liveHandleCount()).toBe(0);
    expect(await api.hasShape('p1')).toBe(false);
    // An unnamed shape (no names at all) is fine.
    expect((await api.loadShape(shape('p2', { edgeNames: [], faceNames: [] }))).ok).toBe(true);
  });

  it('validates the shape before touching the kernel', async () => {
    const { api, instances } = setup();
    for (const bad of [
      shape('', {}),
      shape('p1', { brep: new Uint8Array() }),
      shape('p1', { bounds: { min: [0, 0, Number.NaN], max: [1, 1, 1] } }),
    ]) {
      const r = await api.loadShape(bad);
      expect(r.ok).toBe(false);
    }
    expect(instances).toHaveLength(0);
  });

  it('evicts least recently used shapes and releases their handles', async () => {
    const { api, instances } = setup({ maxShapes: 2 });
    await api.loadShape(shape('a'));
    await api.loadShape(shape('b'));
    await api.loadShape(shape('a')); // touch a
    await api.loadShape(shape('c'));
    const k = instances[0] as FakeDrawingKernel;
    expect(k.released).toEqual([2]); // b
    expect(await api.hasShape('b')).toBe(false);
    expect(await api.hasShape('a')).toBe(true);
    await api.releaseShape('a');
    expect(k.released).toEqual([2, 1]);
    expect(k.liveHandleCount()).toBe(1);
  });

  it('projects: maps the request, names the curves, bounds and key', async () => {
    const { api, instances } = setup();
    await api.loadShape(shape('p1'));
    const r = await api.project({ ...front, frame: { x: [2, 0, 0], y: [0, 0, 5] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const k = instances[0] as FakeDrawingKernel;
    expect(k.projects[0]?.request).toEqual({
      frame: { x: [1, 0, 0], y: [0, 0, 1] },
      quality: 'exact',
      hidden: true,
      smooth: true,
      ...tolerancesFor({ min: [0, 0, 0], max: [40, 30, 10] }),
    });
    expect(r.value.curves.map((c) => [c.role, c.edge, c.name, c.face])).toEqual([
      ['visible', 'sharp', 'F1:edge(a|b)', undefined],
      ['hidden', 'sharp', 'F1:edge(b|c)', undefined],
      ['visible', 'outline', undefined, 'F1:face.top'],
    ]);
    expect(r.value.bounds).toEqual({ min: [0, 0], max: [40, 10] });
    expect(r.value.key).toMatch(/^p1:[0-9a-f]{16}$/);
    expect(r.value.ms).toBe(5);
    expect(r.value.sectionFaces).toBeUndefined();
  });

  it('section requests return named section faces', async () => {
    const { api, instances } = setup();
    await api.loadShape(shape('p1'));
    const k = instances[0] as FakeDrawingKernel;
    k.result = {
      ...k.result,
      sectionFaces: [{ segment: 0, loops: [[{ kind: 'line', a: [0, 0], b: [1, 0] }]] }],
    };
    const r = await api.project({
      ...front,
      section: {
        cut: [
          [0, 15, 10],
          [40, 15, 10],
        ],
        along: [0, 0, -1],
        look: [0, 1, 0],
        depth: 'full',
      },
    });
    expect(r.ok && r.value.sectionFaces?.map((f) => f.face)).toEqual(['section:0#0']);
    expect(k.projects[0]?.request.section?.depth).toBe('full');
  });

  it('detail views take their bounds from the clip circle', async () => {
    const { api } = setup();
    await api.loadShape(shape('p1'));
    const r = await api.project({ ...front, clip: { center: [20, 5], radius: 3 } });
    expect(r.ok && r.value.bounds).toEqual({ min: [17, 2], max: [23, 8] });
  });

  it('an unloaded key is INVALID_HANDLE; bad requests are INVALID_INPUT', async () => {
    const { api } = setup();
    const missing = await api.project(front);
    expect(missing.ok === false && missing.error.code).toBe('INVALID_HANDLE');
    await api.loadShape(shape('p1'));
    const bad = await api.project({ ...front, quality: 'best' as 'exact' });
    expect(bad.ok === false && bad.error.code).toBe('INVALID_INPUT');
  });

  it('a malformed façade result is INTERNAL', async () => {
    const { api, instances } = setup();
    await api.loadShape(shape('p1'));
    const k = instances[0] as FakeDrawingKernel;
    k.result = {
      ...k.result,
      curves: [
        { role: 'visible', edge: 'sharp', index: 9, curve: { kind: 'line', a: [0, 0], b: [1, 0] } },
      ],
    };
    const r = await api.project(front);
    expect(r.ok === false && r.error.code).toBe('INTERNAL');
  });

  it('a Wasm trap drops the kernel; the next load starts a fresh one', async () => {
    const { api, instances } = setup();
    await api.loadShape(shape('p1'));
    (instances[0] as FakeDrawingKernel).trap = true;
    const r = await api.project(front);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INTERNAL');
      expect(r.error.hint).toContain('load the shape again');
    }
    expect(await api.hasShape('p1')).toBe(false);
    expect((await api.project(front)).ok).toBe(false);
    expect((await api.loadShape(shape('p1'))).ok).toBe(true);
    expect(instances).toHaveLength(2);
    expect((await api.project(front)).ok).toBe(true);
  });
});
