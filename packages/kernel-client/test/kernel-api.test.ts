/**
 * Drives the kernel worker's API object directly in Node against the built kernel (both
 * variants), plus once over a real MessageChannel to prove mesh buffers are transferred.
 * Skipped when packages/kernel/dist is missing (run `pnpm --filter @wren-cad/kernel build`).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type {
  FeatureResult,
  Frame,
  KernelApi,
  KernelStatus,
  KernelVariant,
  MeshBuffers,
  PrimitiveFeature,
  Result,
} from '@wren-cad/contracts';
import type { KernelInitModule } from '@wren-cad/kernel';
import { type Endpoint, expose, wrap } from 'comlink';
import { describe, expect, it } from 'vitest';
import { createKernelApi, type KernelApiDeps } from '../src/kernel-api';

const dist = fileURLToPath(new URL('../../kernel/dist/', import.meta.url));
const built = existsSync(`${dist}init.single.js`) && existsSync(`${dist}init.multi.js`);
const skipNote = built
  ? ''
  : ' — SKIPPED: packages/kernel/dist missing; run `pnpm --filter @wren-cad/kernel build`';

const variants: KernelApiDeps['variants'] = {
  single: {
    load: () => import(pathToFileURL(`${dist}init.single.js`).href) as Promise<KernelInitModule>,
  },
  threaded: {
    load: () => import(pathToFileURL(`${dist}init.multi.js`).href) as Promise<KernelInitModule>,
  },
};
const wasmFile: Record<KernelVariant, string> = {
  single: `${dist}whittle-kernel-st.wasm`,
  threaded: `${dist}whittle-kernel.wasm`,
};

const feature: PrimitiveFeature = {
  id: '01JCLIENTBOX00000000000000',
  type: 'primitive',
  name: 'Box',
  suppressed: false,
  op: 'new',
  shape: 'box',
  dx: '10',
  dy: '20',
  dz: '30',
};
const inputs = { values: { '/dx': 10, '/dy': 20, '/dz': 30 } };
const meshOptions = { linearDeflection: 0.1, angularDeflection: 0.5 };

/** Minimal Comlink endpoint over a Node MessagePort (same idea as comlink's node-adapter). */
function nodeEndpoint(port: MessagePort): Endpoint {
  const listeners = new Map<EventListenerOrEventListenerObject, (data: unknown) => void>();
  return {
    postMessage: (message: unknown, transfer?: Transferable[]) =>
      port.postMessage(message, transfer as Parameters<MessagePort['postMessage']>[1]),
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      const wrapped = (data: unknown) => {
        const event = { data } as MessageEvent;
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      };
      listeners.set(listener, wrapped);
      port.on('message', wrapped);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      const wrapped = listeners.get(listener);
      if (wrapped) port.off('message', wrapped);
      listeners.delete(listener);
    },
  };
}

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** A fetch that streams a local file in small chunks, like a network response. */
function fileFetch(path: string): typeof fetch {
  return (async () => {
    const stream = Readable.toWeb(
      createReadStream(path, { highWaterMark: 256 * 1024 }),
    ) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/wasm',
        'content-length': String(statSync(path).size),
      },
    });
  }) as typeof fetch;
}

function expectOwnedBuffers(buffers: MeshBuffers) {
  for (const view of [
    buffers.positions,
    buffers.normals,
    buffers.indices,
    buffers.faceRanges,
    buffers.edgePositions,
    buffers.edgeRanges,
  ]) {
    // Copied out of the Wasm heap into a fresh, exactly-sized, non-shared ArrayBuffer.
    expect(view.buffer).toBeInstanceOf(ArrayBuffer);
    expect(view.byteOffset).toBe(0);
    expect(view.byteLength).toBe(view.buffer.byteLength);
  }
}

describe.skipIf(!built)(`kernel worker API (Node, direct)${skipNote}`, () => {
  for (const variant of ['single', 'threaded'] as const) {
    it(`loads the ${variant} kernel and evaluates, meshes and releases a box`, async () => {
      const statuses: KernelStatus[] = [];
      const api = createKernelApi({ variants, onStatus: (s) => statuses.push(s) });

      const early = await api.execFeature(feature, inputs);
      expect(early.ok ? null : early.error.code).toBe('NOT_INITIALISED');

      const info = unwrap(await api.init({ variant }));
      expect(info.variant).toBe(variant);
      expect(info.occtVersion).toBe('8.0.1');
      expect(info.buildId).toMatch(/^[0-9a-f]{16}$/);
      expect(info.initMs).toBeGreaterThan(0);
      console.info(
        `[${variant}] worker API init (Node, glue-located wasm): ${info.initMs.toFixed(1)} ms`,
      );
      expect(statuses.map((s) => s.state)).toEqual(['compiling', 'ready']);

      // init is idempotent; switching variants needs a new worker.
      expect(unwrap(await api.init())).toEqual(info);
      const other = await api.init({ variant: variant === 'single' ? 'threaded' : 'single' });
      expect(other.ok).toBe(false);

      const result: FeatureResult = unwrap(await api.execFeature(feature, inputs));
      expect(result.naming).toHaveLength(26);
      const mp = unwrap(await api.massProperties(result.shape));
      expect(mp.volume).toBeCloseTo(6000, 9);

      const mesh = unwrap(await api.mesh(result.shape, meshOptions));
      expectOwnedBuffers(mesh);
      expect(mesh.faceRanges.length).toBe(12);
      expect(mesh.edgeRanges.length).toBe(24);
      expect(mesh.faceNames).toHaveLength(6);
      expect(mesh.edgeNames).toHaveLength(12);
      expect(mesh.bbox).toEqual({ min: [0, 0, 0], max: [10, 20, 30] });
      const triangles = mesh.indices.length / 3;
      expect((mesh.faceRanges[10] ?? 0) + (mesh.faceRanges[11] ?? 0)).toBe(triangles);

      const bad = await api.mesh(424242, meshOptions);
      expect(bad.ok ? null : bad.error.code).toBe('INVALID_HANDLE');

      await api.release(result.shape);
      expect(api.liveHandleCount()).toBe(0);
    }, 60_000);

    it(`streams the ${variant} wasm with download progress (instantiateWasm path)`, async () => {
      const statuses: KernelStatus[] = [];
      const path = wasmFile[variant];
      const api = createKernelApi({
        variants: {
          ...variants,
          [variant]: { ...variants[variant], wasmUrl: 'https://example.invalid/kernel.wasm' },
        },
        fetch: fileFetch(path),
        onStatus: (s) => statuses.push(s),
      });
      const info = unwrap(await api.init({ variant }));
      console.info(
        `[${variant}] worker API init (Node, streaming compile): ${info.initMs.toFixed(1)} ms`,
      );
      const states = statuses.map((s) => s.state);
      expect(states[0]).toBe('downloading');
      expect(states.at(-2)).toBe('compiling');
      expect(states.at(-1)).toBe('ready');
      const downloads = statuses.filter(
        (s): s is Extract<KernelStatus, { state: 'downloading' }> => s.state === 'downloading',
      );
      const size = statSync(path).size;
      expect(downloads.length).toBeGreaterThan(2);
      expect(downloads.at(-1)?.loaded).toBe(size);
      expect(downloads.at(-1)?.total).toBe(size);
      for (let i = 1; i < downloads.length; i++) {
        expect(downloads[i]?.loaded ?? 0).toBeGreaterThanOrEqual(downloads[i - 1]?.loaded ?? 0);
      }
      const result = unwrap(await api.execFeature(feature, inputs));
      expect(unwrap(await api.massProperties(result.shape)).area).toBeCloseTo(2200, 9);
      await api.release(result.shape);
      expect(api.liveHandleCount()).toBe(0);
    }, 60_000);
  }

  it('reports a failed wasm download as an error status, not a hang', async () => {
    const statuses: KernelStatus[] = [];
    const api = createKernelApi({
      variants: {
        ...variants,
        single: { ...variants.single, wasmUrl: 'https://example.invalid/missing.wasm' },
      },
      fetch: (async () => new Response('nope', { status: 404 })) as typeof fetch,
      onStatus: (s) => statuses.push(s),
    });
    const r = await api.init({ variant: 'single' });
    expect(r.ok).toBe(false);
    expect(statuses.at(-1)?.state).toBe('error');
  }, 60_000);
});

describe.skipIf(!built)(`kernel worker low-level M1 API (Node, direct)${skipNote}`, () => {
  for (const variant of ['single', 'threaded'] as const) {
    it(`${variant}: fingerprints, density, STEP/STL export and import through MEMFS`, async () => {
      const api = createKernelApi({ variants });
      unwrap(await api.init(variant === 'threaded' ? { variant, threads: 2 } : { variant }));
      const box = unwrap(await api.execFeature(feature, inputs));

      const fp = unwrap(await api.fingerprints(box.shape));
      expect(fp.faces).toHaveLength(6);
      expect(fp.edges).toHaveLength(12);

      const mp = unwrap(await api.massProperties(box.shape, 2.7e-6));
      expect(mp.mass).toBeCloseTo(0.0162, 12);
      expect(mp.inertia?.[0]).toBeCloseTo((0.0162 * 1300) / 12, 9);
      expect(unwrap(await api.massProperties(box.shape)).mass).toBeUndefined();
      const badDensity = await api.massProperties(box.shape, -1);
      expect(badDensity.ok ? null : badDensity.error.code).toBe('INVALID_INPUT');

      const step = unwrap(await api.exportShapes([{ shape: box.shape, name: 'Box' }], 'step'));
      expect(step).toHaveLength(1);
      const bytes = step[0]?.bytes ?? new Uint8Array();
      expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
      expect(bytes.byteLength).toBe(bytes.buffer.byteLength);
      expect(new TextDecoder().decode(bytes.subarray(0, 13))).toBe('ISO-10303-21;');

      const bodies = unwrap(await api.importShapes(bytes, 'step'));
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.name).toBe('Box');
      const back = unwrap(await api.massProperties(bodies[0]?.shape ?? 0));
      expect(Math.abs(back.volume - 6000) / 6000).toBeLessThan(1e-6);

      const stl = unwrap(
        await api.exportShapes([{ shape: box.shape, name: 'Box' }], 'stl', { stlBinary: true }),
      );
      expect(stl[0]?.bytes.byteLength).toBe(84 + 12 * 50);

      const garbage = await api.importShapes(new TextEncoder().encode('nope'), 'step');
      expect(garbage.ok ? null : garbage.error.code).toBe('INVALID_INPUT');
      const missing = await api.exportShapes([{ shape: 424242, name: 'x' }], 'brep');
      expect(missing.ok ? null : missing.error.code).toBe('INVALID_HANDLE');

      const threads = unwrap(await api.configureThreads(1));
      expect(threads.threads).toBe(1);

      for (const b of bodies) await api.release(b.shape);
      await api.release(box.shape);
      expect(api.liveHandleCount()).toBe(0);
    }, 60_000);
  }

  it('M3: projectEdges / projectFaceOutline and IGES go through the worker API', async () => {
    const api = createKernelApi({ variants });
    unwrap(await api.init({ variant: 'single' }));
    const box = unwrap(await api.execFeature(feature, inputs));
    const plane: Frame = { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] };
    const edges = unwrap(await api.projectEdges(box.shape, [...Array(12).keys()], plane));
    expect(edges).toHaveLength(12);
    // The four vertical edges project to points (no curves); the other eight are lines.
    expect(edges.filter((e) => e.curves.length === 0)).toHaveLength(4);
    expect(edges.flatMap((e) => e.curves).every((c) => c.kind === 'line')).toBe(true);
    const fp = unwrap(await api.fingerprints(box.shape));
    const top = fp.faces.findIndex((f) => Math.abs(f.centroid[2] - 30) < 1e-9);
    const outline = unwrap(await api.projectFaceOutline(box.shape, top, plane));
    expect(outline).toHaveLength(4);
    expect(outline.every((e) => e.loop === 0 && e.curves[0]?.kind === 'line')).toBe(true);
    const bad = await api.projectEdges(box.shape, [99], plane);
    expect(bad.ok ? null : bad.error.code).toBe('UNRESOLVED_REFERENCE');
    const iges = await api.importShapes(new TextEncoder().encode('not iges'), 'iges');
    expect(iges.ok ? null : iges.error.code).toBe('INVALID_INPUT');
    await api.release(box.shape);
    expect(api.liveHandleCount()).toBe(0);
  }, 60_000);

  it('M3.5: projections ask the kernel for exact curves (a circle seen obliquely is an ellipse)', async () => {
    const api = createKernelApi({ variants });
    unwrap(await api.init({ variant: 'single' }));
    const cyl = unwrap(
      await api.execFeature(
        { ...feature, shape: 'cylinder', radius: '5', height: '10' } as PrimitiveFeature,
        { values: { '/radius': 5, '/height': 10 } },
      ),
    );
    const fp = unwrap(await api.fingerprints(cyl.shape));
    // A plane tilted 45 degrees about X: the cylinder's two circular rims are no longer circles.
    const s = Math.SQRT1_2;
    const plane: Frame = { origin: [0, 0, 0], z: [0, -s, s], x: [1, 0, 0] };
    const edges = unwrap(
      await api.projectEdges(
        cyl.shape,
        fp.edges.map((_, i) => i),
        plane,
      ),
    );
    const kinds = new Set(edges.flatMap((e) => e.curves.map((c) => c.kind)));
    expect(kinds.has('ellipse') || kinds.has('ellipticArc')).toBe(true);
    expect(kinds.has('polyline')).toBe(false);
    const ell = edges
      .flatMap((e) => e.curves)
      .find((c) => c.kind === 'ellipse' || c.kind === 'ellipticArc');
    if (ell && 'majorRadius' in ell) {
      expect(ell.majorRadius).toBeCloseTo(5, 6);
      expect(ell.minorRadius).toBeCloseTo(5 * s, 6);
    }
    await api.release(cyl.shape);
    expect(api.liveHandleCount()).toBe(0);
  }, 60_000);

  it('rejects a bad thread count for the threaded kernel', async () => {
    const api = createKernelApi({ variants });
    const r = await api.init({ variant: 'threaded', threads: 0 });
    expect(r.ok ? null : r.error.code).toBe('INVALID_INPUT');
  });
});

describe.skipIf(!built)(`kernel worker API over Comlink (MessageChannel)${skipNote}`, () => {
  it('transfers mesh buffers instead of structured-cloning them', async () => {
    const api = createKernelApi({ variants });
    let lastMesh: Result<MeshBuffers> | undefined;
    const exposed: KernelApi = {
      ...api,
      async mesh(shape, options) {
        lastMesh = await api.mesh(shape, options);
        return lastMesh;
      },
    };
    const { port1, port2 } = new MessageChannel();
    expose(exposed, nodeEndpoint(port1));
    const remote = wrap<KernelApi>(nodeEndpoint(port2));
    try {
      unwrap(await remote.init({ variant: 'single' }));
      const result = unwrap(await remote.execFeature(feature, inputs));
      const mesh = unwrap(await remote.mesh(result.shape, meshOptions));
      expect(mesh.positions).toBeInstanceOf(Float32Array);
      expect(mesh.indices).toBeInstanceOf(Uint32Array);
      expect(mesh.positions.length).toBeGreaterThan(0);
      expectOwnedBuffers(mesh);
      // The worker-side copies were transferred: their buffers are detached.
      const sent = lastMesh?.ok ? lastMesh.value : undefined;
      expect(sent).toBeDefined();
      expect(sent?.positions.buffer.byteLength).toBe(0);
      expect(sent?.normals.buffer.byteLength).toBe(0);
      expect(sent?.indices.buffer.byteLength).toBe(0);
      expect(sent?.edgePositions.buffer.byteLength).toBe(0);
      await remote.release(result.shape);
      expect(api.liveHandleCount()).toBe(0);
    } finally {
      port1.close();
      port2.close();
    }
  }, 60_000);
});
