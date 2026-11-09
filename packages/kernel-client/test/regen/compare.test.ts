/**
 * Regen golden: regen slots and geometric compare (PLAN §8A.3, §12 M2.5, ADR-020 item 8). Real
 * kernel, real planegcs. Each fixture pair regenerates A in a version slot and B in `'main'`,
 * then checks B − A and A − B against analytic volumes (1e-6 relative), exact region bounding
 * boxes, face counts where meaningful, and that compare leaks no kernel handles.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type {
  GeometricDiff,
  Id,
  ImportFeature,
  MeshBuffers,
  RegenSlot,
  Vec3,
} from '@wren-cad/contracts';
import { type Endpoint, expose, wrap } from 'comlink';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelingWorkerApi } from '../../src/modeling-api';
import { sha256Hex } from '../../src/regen/imports';
import {
  ACCEPTANCE_PAIRS,
  type FixturePair,
  fromNothing,
  overlappingBodies,
  type Region,
  sameGeometryRewritten,
  tallerBox,
} from './compare-fixtures';
import {
  type Api,
  built,
  describeFailures,
  fid,
  loadApi,
  relClose,
  skipNote,
  states,
} from './helpers';

const OLD: RegenSlot = 'version:old';
const REL = 1e-6;

const faceCount = (m: MeshBuffers) => m.faceRanges.length / 2;

function expectBox(actual: { min: Vec3; max: Vec3 }, expected: { min: Vec3; max: Vec3 }): void {
  for (let i = 0; i < 3; i++) {
    expect(actual.min[i]).toBeCloseTo(expected.min[i] as number, 5);
    expect(actual.max[i]).toBeCloseTo(expected.max[i] as number, 5);
  }
}

function expectRegion(meshes: MeshBuffers[], volume: number, expected: Region): void {
  if (expected.bbox === null) {
    expect(meshes).toEqual([]);
    expect(volume).toBe(0);
    return;
  }
  expect(meshes).toHaveLength(1);
  const m = meshes[0] as MeshBuffers;
  expect(m.indices.length).toBeGreaterThan(0);
  expect(m.positions).toBeInstanceOf(Float32Array);
  relClose(volume, expected.volume, REL);
  expectBox(m.bbox, expected.bbox);
  if (expected.faces !== undefined) expect(faceCount(m)).toBe(expected.faces);
  // Every mesh vertex lies inside the region's box (the diff marks the right place).
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = m.positions[i + k] as number;
      expect(v).toBeGreaterThanOrEqual((expected.bbox.min[k] as number) - 1e-3);
      expect(v).toBeLessThanOrEqual((expected.bbox.max[k] as number) + 1e-3);
    }
  }
}

describe.skipIf(!built)(`regen golden: slots and geometric compare${skipNote}`, () => {
  let api: Api;
  beforeAll(async () => {
    api = await loadApi();
  }, 60_000);
  afterAll(() => {
    // Every test closes its parts: nothing may be left in the kernel.
    expect(api?.liveHandleCount()).toBe(0);
  });

  /** Regenerates A in a version slot and B in main, then compares them. */
  async function diffOf(pair: FixturePair, partId: Id): Promise<GeometricDiff> {
    const ra = await api.regenerate({ doc: pair.a, partId, quality: 'coarse', slot: OLD });
    expect(
      states(ra).every((s) => s === 'ok'),
      describeFailures(ra),
    ).toBe(true);
    const rb = await api.regenerate({ doc: pair.b, partId, quality: 'coarse' });
    expect(
      states(rb).every((s) => s === 'ok'),
      describeFailures(rb),
    ).toBe(true);
    const before = api.liveHandleCount();
    const d = await api.compare(partId, OLD, 'main', 'coarse');
    if (!d.ok) throw new Error(`compare failed: ${JSON.stringify(d.error)}`);
    // Every temporary union / difference shape was released.
    expect(api.liveHandleCount()).toBe(before);
    return d.value;
  }

  function checkPair(pair: FixturePair, d: GeometricDiff): void {
    expectRegion(d.added, d.addedVolume, pair.added);
    expectRegion(d.removed, d.removedVolume, pair.removed);
    relClose(d.a.mass.volume, pair.volumeA, REL);
    relClose(d.b.mass.volume, pair.volumeB, REL);
    // Conservation: B = A + added − removed.
    relClose(d.b.mass.volume - d.a.mass.volume, d.addedVolume - d.removedVolume, REL);
    expect(d.a.bbox).toEqual(d.a.mass.bbox);
    expect(d.b.bbox).toEqual(d.b.mass.bbox);
  }

  for (const [i, make] of ACCEPTANCE_PAIRS.entries()) {
    const pair = make();
    it(`fixture ${i + 1}: ${pair.name}`, async () => {
      const partId = pair.a.parts[0]?.id as Id;
      try {
        const d = await diffOf(pair, partId);
        checkPair(pair, d);
        console.info(
          `[compare] ${pair.name}: added ${d.addedVolume.toFixed(6)} mm³ (${d.added.map(faceCount).join(',') || '-'} faces), removed ${d.removedVolume.toFixed(6)} mm³ (${d.removed.map(faceCount).join(',') || '-'} faces)`,
        );
      } finally {
        await api.closePart(partId);
      }
    });
  }

  it('fixture 4 detail: the fillet change only removes material, along the filleted edge', async () => {
    const pair = ACCEPTANCE_PAIRS[3]?.() as FixturePair;
    const partId = pair.a.parts[0]?.id as Id;
    try {
      const d = await diffOf(pair, partId);
      expect(d.added).toEqual([]);
      expect(d.removedVolume).toBeGreaterThan(0);
      // Small: about 1 % of the box.
      expect(d.removedVolume / d.a.mass.volume).toBeLessThan(0.01);
    } finally {
      await api.closePart(partId);
    }
  });

  it('identical geometry with different definitions runs the booleans and is still empty', async () => {
    const pair = sameGeometryRewritten();
    const partId = pair.a.parts[0]?.id as Id;
    try {
      checkPair(pair, await diffOf(pair, partId));
    } finally {
      await api.closePart(partId);
    }
  });

  it('multi-body sides are unioned before cutting (overlap counted once)', async () => {
    const pair = overlappingBodies();
    const partId = pair.a.parts[0]?.id as Id;
    try {
      const d = await diffOf(pair, partId);
      checkPair(pair, d);
      // Not the 8000 mm³ sum of A's two bodies. (The fuse is not refined, so A's face count is
      // not meaningful here: coplanar faces stay split.)
      expect(d.a.mass.volume).toBeLessThan(7000);
      expectBox(d.a.bbox, { min: [0, 0, 0], max: [30, 20, 10] });
    } finally {
      await api.closePart(partId);
    }
  });

  it('a side without bodies: everything is added, its mass is zero', async () => {
    const pair = fromNothing();
    const partId = pair.a.parts[0]?.id as Id;
    try {
      const d = await diffOf(pair, partId);
      checkPair(pair, d);
      expect(d.a.mass.volume).toBe(0);
      expect(d.a.bbox).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
    } finally {
      await api.closePart(partId);
    }
  });

  it('compares two version slots, and in either order', async () => {
    const pair = tallerBox();
    const partId = pair.a.parts[0]?.id as Id;
    try {
      await api.regenerate({ doc: pair.a, partId, quality: 'fine', slot: 'version:a' });
      await api.regenerate({ doc: pair.b, partId, quality: 'fine', slot: 'version:b' });
      const fwd = await api.compare(partId, 'version:a', 'version:b', 'fine');
      const back = await api.compare(partId, 'version:b', 'version:a', 'fine');
      if (!fwd.ok || !back.ok) throw new Error('compare failed');
      relClose(fwd.value.addedVolume, pair.added.volume, REL);
      expect(fwd.value.removed).toEqual([]);
      relClose(back.value.removedVolume, pair.added.volume, REL);
      expect(back.value.added).toEqual([]);
      expect(fwd.value.added[0]?.indices.length).toBeGreaterThan(0);
      // compare touches its slots (a then b) for the LRU: the last call used `version:a` last.
      expect(api.engine.slots(partId)).toEqual(['version:a', 'version:b']);
    } finally {
      await api.closePart(partId);
    }
  });

  it('mesh reference bodies are left out with a warning naming the body', async () => {
    const pair = tallerBox();
    const partId = pair.a.parts[0]?.id as Id;
    const imp = fid('CIMP');
    try {
      // An STL of the taller box, imported as a mesh reference body beside A's box.
      await api.regenerate({ doc: pair.b, partId, quality: 'coarse' });
      const stl = await api.exportPart(partId, 'stl');
      if (!stl.ok) throw new Error(JSON.stringify(stl.error));
      await api.closePart(partId);
      const path = 'imports/box.stl';
      const feature: ImportFeature = {
        id: imp,
        type: 'import',
        name: 'Import',
        suppressed: false,
        source: { path, format: 'stl', sha256: await sha256Hex(stl.bytes), fileName: 'box.stl' },
        op: 'new',
      };
      const withMesh = structuredClone(pair.a);
      const p = withMesh.parts[0];
      p?.features.push(feature);
      if (p) p.rollbackIndex = p.features.length;
      await api.regenerate({ doc: pair.a, partId, quality: 'coarse', slot: OLD });
      const rb = await api.regenerate({
        doc: withMesh,
        partId,
        quality: 'coarse',
        attachments: { [path]: stl.bytes },
      });
      expect(states(rb), describeFailures(rb)).toEqual(['ok', 'ok', 'ok']);
      const d = await api.compare(partId, OLD, 'main', 'coarse');
      if (!d.ok) throw new Error(JSON.stringify(d.error));
      // The solid box is the same in both: nothing added or removed; the mesh body is skipped.
      expect(d.value.added).toEqual([]);
      expect(d.value.removed).toEqual([]);
      relClose(d.value.b.mass.volume, pair.volumeA, REL);
      expect(d.value.warnings).toEqual([
        {
          code: 'UNSUPPORTED_FEATURE',
          message: 'A mesh reference body in the live model is not compared',
          entityRefs: [`B${imp}`],
        },
      ]);
    } finally {
      await api.closePart(partId);
    }
  });

  it('missing or malformed slots are human-readable errors, never throws', async () => {
    const pair = tallerBox();
    const partId = pair.a.parts[0]?.id as Id;
    try {
      const none = await api.compare(partId, OLD, 'main', 'coarse');
      expect(none.ok).toBe(false);
      if (!none.ok) {
        expect(none.error.code).toBe('INVALID_INPUT');
        expect(none.error.message).toBe('Version old has not been regenerated');
      }
      await api.regenerate({ doc: pair.b, partId, quality: 'coarse' });
      const missing = await api.compare(partId, 'main', 'version:gone', 'coarse');
      expect(!missing.ok && missing.error.message).toBe('Version gone has not been regenerated');
      const bad = await api.compare(partId, 'main', 'v1' as RegenSlot, 'coarse');
      expect(!bad.ok && bad.error.code).toBe('INVALID_INPUT');
      const badQ = await api.compare(partId, 'main', 'main', 'ultra' as 'fine');
      expect(!badQ.ok && badQ.error.code).toBe('INVALID_INPUT');
      // Comparing a slot with itself is an empty diff.
      const self = await api.compare(partId, 'main', 'main', 'coarse');
      expect(self.ok && self.value.added.length + self.value.removed.length).toBe(0);
      await expect(
        api.regenerate({ doc: pair.b, partId, quality: 'coarse', slot: 'version:' as RegenSlot }),
      ).rejects.toThrow(TypeError);
    } finally {
      await api.closePart(partId);
    }
  });
});

describe.skipIf(!built)(`regen golden: slot isolation and memory${skipNote}`, () => {
  let api: Api;
  beforeAll(async () => {
    api = await loadApi();
  }, 60_000);

  it("regenerating a version slot leaves main's result, revision, cache and selection untouched", async () => {
    const pair = tallerBox();
    const partId = pair.a.parts[0]?.id as Id;
    try {
      const m1 = await api.regenerate({ doc: pair.b, partId, quality: 'coarse' });
      const m2 = await api.regenerate({ doc: pair.b, partId, quality: 'coarse' });
      expect(m2.cache).toEqual({ hits: 2, misses: 0 });
      const mainStats = api.engine.stats(partId);
      const shape = m2.bodies[0]?.shape;
      const ref = await api.refFor(partId, {
        bodyId: m2.bodies[0]?.id as string,
        kind: 'face',
        index: 0,
      });

      // A version slot regenerates from its own (cold) cache with its own revision counter.
      const v1 = await api.regenerate({ doc: pair.a, partId, quality: 'coarse', slot: OLD });
      expect(v1.revision).toBe(1);
      expect(v1.cache).toEqual({ hits: 0, misses: 2 });
      relClose(v1.bodies[0]?.massProperties?.volume ?? pair.volumeA, pair.volumeA, REL);
      const v2 = await api.regenerate({ doc: pair.a, partId, quality: 'coarse', slot: OLD });
      expect(v2.revision).toBe(2);
      expect(v2.cache).toEqual({ hits: 2, misses: 0 });

      // Main is untouched: same cache, same shapes, revision continues from its own counter.
      expect(api.engine.stats(partId)).toEqual(mainStats);
      expect(
        await api.refFor(partId, { bodyId: m2.bodies[0]?.id as string, kind: 'face', index: 0 }),
      ).toEqual(ref);
      const measured = await api.measure(partId, {
        bodyId: m2.bodies[0]?.id as string,
        kind: 'face',
        index: 0,
      });
      expect(measured.ok).toBe(true);
      const m3 = await api.regenerate({ doc: pair.b, partId, quality: 'coarse' });
      expect(m3.revision).toBe(m1.revision + 2);
      expect(m3.cache).toEqual({ hits: 2, misses: 0 });
      expect(m3.bodies[0]?.shape).toBe(shape);
      expect(api.engine.ownsHandle(v2.bodies[0]?.shape as number)).toBe(true);
      expect(v2.bodies[0]?.shape).not.toBe(shape);
    } finally {
      await api.closePart(partId);
    }
    expect(api.liveHandleCount()).toBe(0);
  });

  it('keeps at most 2 version slots per part (LRU), and configureRegen lowers the cap', async () => {
    const pair = tallerBox();
    const partId = pair.a.parts[0]?.id as Id;
    const other = fid('OTHERPART');
    const otherDoc = structuredClone(pair.a);
    (otherDoc.parts[0] as { id: Id }).id = other;
    try {
      await api.regenerate({ doc: pair.b, partId, quality: 'coarse' });
      const mainHandles = api.liveHandleCount();
      await api.regenerate({ doc: pair.a, partId, quality: 'coarse', slot: 'version:1' });
      await api.regenerate({ doc: pair.b, partId, quality: 'coarse', slot: 'version:2' });
      // Using version 1 makes version 2 the least recently used.
      expect((await api.compare(partId, 'version:1', 'main', 'coarse')).ok).toBe(true);
      await api.regenerate({ doc: pair.a, partId, quality: 'coarse', slot: 'version:3' });
      expect(api.engine.slots(partId)).toEqual(['main', 'version:3', 'version:1']);
      const gone = await api.compare(partId, 'version:2', 'main', 'coarse');
      expect(!gone.ok && gone.error.message).toBe('Version 2 has not been regenerated');
      // The cap is per part.
      await api.regenerate({ doc: otherDoc, partId: other, quality: 'coarse', slot: 'version:1' });
      expect(api.engine.slots(other)).toEqual(['version:1']);
      expect(api.engine.slots(partId)).toHaveLength(3);

      // A lower tier releases the least recently used version slots at once.
      await api.configureRegen({ maxVersionSlots: 1 });
      expect(api.engine.slots(partId)).toEqual(['main', 'version:3']);
      // Invalid values are ignored.
      await api.configureRegen({ maxVersionSlots: 0 });
      await api.regenerate({ doc: pair.a, partId, quality: 'coarse', slot: 'version:4' });
      expect(api.engine.slots(partId)).toEqual(['main', 'version:4']);

      // closePart with a slot closes only that slot; main keeps its shapes.
      await api.closePart(other, 'version:1');
      expect(api.engine.slots(other)).toEqual([]);
      await api.closePart(partId, 'version:4');
      expect(api.engine.slots(partId)).toEqual(['main']);
      expect(api.liveHandleCount()).toBe(mainHandles);
      const live = await api.exportPart(partId, 'brep');
      expect(live.ok).toBe(true);
    } finally {
      await api.configureRegen({ maxVersionSlots: 2 });
      await api.closePart(partId);
      await api.closePart(other);
    }
    expect(api.engine.slots(partId)).toEqual([]);
    expect(api.liveHandleCount()).toBe(0);
  });

  it('closePart without a slot closes every slot', async () => {
    const pair = tallerBox();
    const partId = pair.a.parts[0]?.id as Id;
    await api.regenerate({ doc: pair.b, partId, quality: 'coarse' });
    await api.regenerate({ doc: pair.a, partId, quality: 'coarse', slot: OLD });
    expect(api.liveHandleCount()).toBeGreaterThan(0);
    await api.closePart(partId);
    expect(api.engine.slots(partId)).toEqual([]);
    expect(api.liveHandleCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Over Comlink: diff meshes are transferred, not copied
// ---------------------------------------------------------------------------------------------

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

describe.skipIf(!built)(`compare over Comlink${skipNote}`, () => {
  it('transfers the added / removed mesh buffers', async () => {
    const worker = await loadApi();
    let sent: GeometricDiff | undefined;
    const exposed: ModelingWorkerApi = {
      ...worker,
      async compare(partId, a, b, quality) {
        const r = await worker.compare(partId, a, b, quality);
        if (r.ok) sent = r.value;
        return r;
      },
    };
    const { port1, port2 } = new MessageChannel();
    expose(exposed, nodeEndpoint(port1));
    const remote = wrap<ModelingWorkerApi>(nodeEndpoint(port2));
    const pair = tallerBox();
    const partId = pair.a.parts[0]?.id as Id;
    try {
      await remote.regenerate({ doc: pair.a, partId, quality: 'coarse', slot: OLD });
      await remote.regenerate({ doc: pair.b, partId, quality: 'coarse' });
      const d = await remote.compare(partId, OLD, 'main', 'coarse');
      if (!d.ok) throw new Error(JSON.stringify(d.error));
      expect(d.value.added[0]?.positions.length).toBeGreaterThan(0);
      relClose(d.value.addedVolume, pair.added.volume, REL);
      // The worker-side buffers were transferred (detached), not structured-cloned.
      expect(sent?.added[0]?.positions.buffer.byteLength).toBe(0);
      expect(sent?.added[0]?.indices.buffer.byteLength).toBe(0);
      await remote.closePart(partId);
      expect(worker.liveHandleCount()).toBe(0);
    } finally {
      port1.close();
      port2.close();
    }
  });
});
