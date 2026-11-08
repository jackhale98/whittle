/**
 * Drives the kernel worker's API object directly in Node against the built kernel (both
 * variants), plus once over a real MessageChannel to prove mesh buffers are transferred.
 * Skipped when packages/kernel/dist is missing (run `pnpm --filter @whittle/kernel build`).
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type {
  FeatureResult,
  KernelApi,
  KernelStatus,
  KernelVariant,
  MeshBuffers,
  PrimitiveFeature,
  Result,
} from '@whittle/contracts';
import type { KernelInitModule } from '@whittle/kernel';
import { type Endpoint, expose, wrap } from 'comlink';
import { describe, expect, it } from 'vitest';
import { createKernelApi, type KernelApiDeps } from '../src/kernel-api';

const dist = fileURLToPath(new URL('../../kernel/dist/', import.meta.url));
const built = existsSync(`${dist}init.single.js`) && existsSync(`${dist}init.multi.js`);
const skipNote = built
  ? ''
  : ' — SKIPPED: packages/kernel/dist missing; run `pnpm --filter @whittle/kernel build`';

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
