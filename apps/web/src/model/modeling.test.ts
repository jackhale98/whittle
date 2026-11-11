import type { MassProperties, RegenRequest, RegenResult, WrenDoc } from '@wren-cad/contracts';
import { newDoc } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import {
  createRegenLoop,
  type IdleScheduler,
  type ModelingPort,
  type RegenOutcome,
} from './modeling';

interface Pending {
  request: RegenRequest;
  resolve(r: RegenResult): void;
  reject(e: unknown): void;
}

function scripted() {
  const calls: Pending[] = [];
  let revision = 0;
  const port: ModelingPort = {
    regenerate: (request) =>
      new Promise<RegenResult>((resolve, reject) => calls.push({ request, resolve, reject })),
    refFor: async () => null,
    exportPart: async () => ({ ok: true, bytes: new Uint8Array() }),
    importFile: async () => ({ ok: true, bodies: [] }),
    closePart: async () => {},
  };
  const answer = (i: number, rev = ++revision) => {
    const c = calls[i];
    if (!c) throw new Error(`no call ${i}`);
    c.resolve({
      partId: c.request.partId,
      revision: rev,
      features: [],
      bodies: [],
      sketches: [],
      totalMs: 1,
      cache: { hits: 0, misses: 0 },
    });
  };
  return { port, calls, answer };
}

function manualIdle() {
  const queue: Array<() => void> = [];
  const idle: IdleScheduler = (run) => {
    queue.push(run);
    return () => {
      const i = queue.indexOf(run);
      if (i >= 0) queue.splice(i, 1);
    };
  };
  const flush = () => {
    for (const fn of queue.splice(0)) fn();
  };
  return { idle, flush, queue };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('regen loop', () => {
  it('coarse immediately, fine on idle, one call in flight, latest doc wins', async () => {
    let doc: WrenDoc = newDoc({ firstPart: 'P' });
    const s = scripted();
    const idle = manualIdle();
    const got: RegenOutcome[] = [];
    const loop = createRegenLoop({
      port: s.port,
      getDoc: () => doc,
      onResult: (o) => got.push(o),
      idle: idle.idle,
    });

    loop.request();
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.request.quality).toBe('coarse');

    // Three edits while the first call runs → exactly one follow-up with the latest doc.
    const d1 = { ...doc, meta: { ...doc.meta, name: '1' } };
    doc = d1;
    loop.request();
    doc = { ...doc, meta: { ...doc.meta, name: '2' } };
    loop.request();
    const d3 = { ...doc, meta: { ...doc.meta, name: '3' } };
    doc = d3;
    loop.request();
    expect(s.calls).toHaveLength(1);

    s.answer(0);
    await tick();
    expect(got).toHaveLength(1);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]?.request.doc).toBe(d3);
    expect(idle.queue).toHaveLength(0); // no fine pass for a superseded doc

    s.answer(1);
    await tick();
    expect(got.map((o) => o.doc.meta.name)).toEqual([newDoc().meta.name, '3']);
    expect(idle.queue).toHaveLength(1);

    let idleResolved = false;
    void loop.whenIdle().then(() => {
      idleResolved = true;
    });
    idle.flush();
    expect(s.calls[2]?.request.quality).toBe('fine');
    s.answer(2);
    await tick();
    expect(got.at(-1)?.quality).toBe('fine');
    expect(idleResolved).toBe(true);
    expect(loop.calls).toBe(3);
  });

  it('drops stale results by revision and fine results for an outdated document', async () => {
    let doc: WrenDoc = newDoc({ firstPart: 'P' });
    const s = scripted();
    const idle = manualIdle();
    const got: RegenOutcome[] = [];
    const loop = createRegenLoop({
      port: s.port,
      getDoc: () => doc,
      onResult: (o) => got.push(o),
      idle: idle.idle,
    });
    loop.request();
    s.answer(0, 5);
    await tick();
    idle.flush(); // fine starts
    expect(s.calls[1]?.request.quality).toBe('fine');
    doc = { ...doc, meta: { ...doc.meta, name: 'edited' } };
    loop.request(); // queued behind the fine call
    s.answer(1, 6); // fine for the old doc: dropped
    await tick();
    expect(got).toHaveLength(1);
    expect(s.calls[2]?.request.quality).toBe('coarse');
    s.answer(2, 4); // revision went backwards: stale, dropped
    await tick();
    expect(got).toHaveLength(1);
    loop.dispose();
  });

  it('reports engine failures and keeps going', async () => {
    const doc = newDoc({ firstPart: 'P' });
    const s = scripted();
    const errors: string[] = [];
    const loop = createRegenLoop({
      port: s.port,
      getDoc: () => doc,
      onResult: () => {},
      onError: (e) => errors.push(e.message),
      fine: false,
    });
    loop.request();
    s.calls[0]?.reject(new Error('worker died'));
    await tick();
    expect(errors).toHaveLength(1);
    loop.request();
    expect(s.calls).toHaveLength(2);
  });

  it('sends each attachment once per engine lifetime (keyed by sha256), resending after a failure', async () => {
    let doc: WrenDoc = newDoc({ firstPart: 'P' });
    const s = scripted();
    const a = { path: 'imports/A.step', sha256: 'aa', bytes: new Uint8Array([1, 2, 3]) };
    const b = { path: 'imports/B.stl', sha256: 'bb', bytes: new Uint8Array([4]) };
    let list = [a];
    const loop = createRegenLoop({
      port: s.port,
      getDoc: () => doc,
      onResult: () => {},
      onError: () => {},
      fine: false,
      attachments: () => list,
    });
    loop.request();
    s.calls[0]?.reject(new Error('worker hiccup'));
    await tick();
    doc = { ...doc };
    loop.request();
    expect(Object.keys(s.calls[1]?.request.attachments ?? {})).toEqual(['imports/A.step']);
    s.answer(1);
    await tick();
    list = [a, b];
    doc = { ...doc };
    loop.request();
    expect(s.calls[2]?.request.attachments).toEqual({ 'imports/B.stl': b.bytes });
    s.answer(2);
    await tick();
    doc = { ...doc };
    loop.request();
    expect(s.calls[3]?.request.attachments).toBeUndefined();
    const part = doc.parts[0]?.id;
    expect([...loop.sentAttachments].sort()).toEqual([`${part}:aa`, `${part}:bb`]);
    // The part was closed in the engine: its attachments go again.
    s.answer(3);
    await tick();
    loop.forget(part as string);
    doc = { ...doc };
    loop.request();
    expect(Object.keys(s.calls[4]?.request.attachments ?? {}).sort()).toEqual([
      'imports/A.step',
      'imports/B.stl',
    ]);
  });

  it('ADR-084: mass properties come after the geometry, inline again once they are cheap', async () => {
    let doc: WrenDoc = newDoc({ firstPart: 'P' });
    const calls: { request: RegenRequest; resolve(r: RegenResult): void }[] = [];
    const massCalls: { shape: number; resolve(): void }[] = [];
    const mp = (volume: number): MassProperties => ({
      volume,
      area: 1,
      centroid: [0, 0, 0],
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      faceCount: 6,
      edgeCount: 12,
      vertexCount: 8,
    });
    const port: ModelingPort = {
      regenerate: (request) => new Promise((resolve) => calls.push({ request, resolve })),
      refFor: async () => null,
      exportPart: async () => ({ ok: true, bytes: new Uint8Array() }),
      importFile: async () => ({ ok: true, bodies: [] }),
      closePart: async () => {},
      massProperties: (shape) =>
        new Promise((resolve) =>
          massCalls.push({ shape, resolve: () => resolve({ ok: true, value: mp(shape * 10) }) }),
        ),
    };
    const result = (i: number, shapes: number[], totalMs = 1, withMass = false): RegenResult => ({
      partId: calls[i]?.request.partId ?? '',
      revision: i + 1,
      features: [],
      bodies: shapes.map((shape) => ({
        id: `B${shape}`,
        shape,
        mesh: { faceNames: [] } as unknown as RegenResult['bodies'][number]['mesh'],
        ...(withMass ? { massProperties: mp(shape * 10) } : {}),
      })),
      sketches: [],
      totalMs,
      cache: { hits: 0, misses: 0 },
    });
    const got: RegenOutcome[] = [];
    const massed: RegenOutcome[] = [];
    const loop = createRegenLoop({
      port,
      getDoc: () => doc,
      onResult: (o) => got.push(o),
      onMass: (o) => massed.push(o),
      fine: false,
    });

    // 1. Unknown cost: the regen does not ask for mass; they follow, and idle waits for them.
    loop.request();
    expect(calls[0]?.request.massProperties).toBe(false);
    let idle = false;
    void loop.whenIdle().then(() => {
      idle = true;
    });
    calls[0]?.resolve(result(0, [7]));
    await tick();
    expect(got[0]?.result.bodies[0]?.massProperties).toBeUndefined();
    expect(massCalls.map((c) => c.shape)).toEqual([7]);
    expect(idle).toBe(false);
    massCalls[0]?.resolve();
    await tick();
    expect(massed[0]?.result.bodies[0]?.massProperties?.volume).toBe(70);
    expect(massed[0]?.result.revision).toBe(1);
    expect(idle).toBe(true);

    // 2. That fetch was fast: the next regen asks for them inline, nothing is fetched after it.
    doc = { ...doc };
    loop.request();
    expect(calls[1]?.request.massProperties).toBe(true);
    calls[1]?.resolve(result(1, [7, 8], 500, true));
    await tick();
    expect(massCalls).toHaveLength(1);
    expect(massed).toHaveLength(1);

    // 3. That inline regen blew the edit budget: deferred again. Known shapes are filled in at
    // once (no gap in the readout), only the new one is fetched, and an edit goes first.
    doc = { ...doc };
    loop.request();
    expect(calls[2]?.request.massProperties).toBe(false);
    calls[2]?.resolve(result(2, [7, 9]));
    await tick();
    expect(got[2]?.result.bodies.map((b) => b.massProperties?.volume)).toEqual([70, undefined]);
    expect(massCalls.map((c) => c.shape)).toEqual([7, 9]);
    doc = { ...doc };
    loop.request(); // an edit while the mass of 9 is in flight: it is dropped, the regen goes first
    massCalls[1]?.resolve();
    await tick();
    expect(calls).toHaveLength(4);
    expect(massed).toHaveLength(1);
    calls[3]?.resolve(result(3, [7, 10]));
    await tick();
    expect(got[3]?.result.bodies[0]?.massProperties?.volume).toBe(70);
    expect(massCalls.map((c) => c.shape)).toEqual([7, 9, 10]);
    massCalls[2]?.resolve();
    await tick();
    expect(massed.at(-1)?.result.revision).toBe(4);
    expect(massed.at(-1)?.result.bodies.map((b) => b.massProperties?.volume)).toEqual([70, 100]);
  });

  it('ADR-084: a part with a material regenerates with massProperties false and fetches at its density', async () => {
    let density = 1e-6;
    const base = newDoc({ firstPart: 'P' });
    const withMaterial = (d: WrenDoc): WrenDoc => ({
      ...d,
      parts: d.parts.map((p) => ({ ...p, material: { name: 'X', density: `${density} kg/mm^3` } })),
    });
    let doc = withMaterial(base);
    const calls: { request: RegenRequest; resolve(r: RegenResult): void }[] = [];
    const fetched: { shape: number; density: number | undefined }[] = [];
    const port: ModelingPort = {
      regenerate: (request) => new Promise((resolve) => calls.push({ request, resolve })),
      refFor: async () => null,
      exportPart: async () => ({ ok: true, bytes: new Uint8Array() }),
      importFile: async () => ({ ok: true, bodies: [] }),
      closePart: async () => {},
      massProperties: async (shape, d) => {
        fetched.push({ shape, density: d });
        // Slow enough that the loop stays deferred.
        await new Promise((r) => setTimeout(r, 60));
        return {
          ok: true,
          value: {
            volume: 1,
            area: 1,
            centroid: [0, 0, 0],
            ...(d === undefined ? {} : { mass: d }),
            bbox: { min: [0, 0, 0], max: [1, 1, 1] },
            faceCount: 6,
            edgeCount: 12,
            vertexCount: 8,
          },
        };
      },
    };
    const answer = (i: number) =>
      calls[i]?.resolve({
        partId: calls[i]?.request.partId ?? '',
        revision: i + 1,
        features: [],
        bodies: [
          {
            id: 'B1',
            shape: 7,
            mesh: { faceNames: [] } as unknown as RegenResult['bodies'][number]['mesh'],
          },
        ],
        sketches: [],
        totalMs: 1,
        cache: { hits: 0, misses: 0 },
      });
    const massed: RegenOutcome[] = [];
    const got: RegenOutcome[] = [];
    const loop = createRegenLoop({
      port,
      getDoc: () => doc,
      onResult: (o) => got.push(o),
      onMass: (o) => massed.push(o),
      density: () => density,
      fine: false,
    });
    loop.request();
    expect(calls[0]?.request.massProperties).toBe(false);
    answer(0);
    await loop.whenIdle();
    expect(fetched).toEqual([{ shape: 7, density: 1e-6 }]);
    expect(massed.at(-1)?.result.bodies[0]?.massProperties?.mass).toBe(1e-6);

    // A density edit keeps the shape: the memo must not serve the old density's mass.
    density = 2e-6;
    doc = withMaterial(base);
    loop.request();
    expect(calls[1]?.request.massProperties).toBe(false);
    answer(1);
    await tick();
    expect(got.at(-1)?.result.bodies[0]?.massProperties).toBeUndefined();
    await loop.whenIdle();
    expect(fetched.at(-1)).toEqual({ shape: 7, density: 2e-6 });
    expect(massed.at(-1)?.result.bodies[0]?.massProperties?.mass).toBe(2e-6);

    // Without a density resolver a material part keeps its mass inline (the engine's density).
    const inlineCalls: RegenRequest[] = [];
    const l2 = createRegenLoop({
      port: {
        ...port,
        regenerate: (r) => {
          inlineCalls.push(r);
          return new Promise(() => {});
        },
      },
      getDoc: () => doc,
      onResult: () => {},
      onMass: () => {},
      fine: false,
    });
    l2.request();
    expect(inlineCalls[0]?.massProperties).toBe(true);
    l2.dispose();
  });
});
