/**
 * Regen golden 8 (M1 acceptance): materials → mass, STEP export of the bracket re-imported with
 * the same volume (1e-6 relative), watertight STL, per-body zips; plus `refFor` (picking →
 * persistent reference) and one round trip over Comlink with transferred buffers.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { EntityRef, RegenResult } from '@whittle/contracts';
import { materialFromLibrary } from '@whittle/document';
import { analyzeStl } from '@whittle/io';
import { type Endpoint, expose, wrap } from 'comlink';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelingWorkerApi } from '../../src/modeling-api';
import { B, BRACKET_DIMS, bracketDoc, bracketVolume } from './bracket';
import {
  type Api,
  built,
  describeFailures,
  extrude,
  fid,
  loadApi,
  makeDoc,
  part,
  region,
  relClose,
  Sk,
  skipNote,
  states,
  withParams,
} from './helpers';

const PART = fid('PART');

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

function aluminiumBracket() {
  const doc = bracketDoc();
  const m = materialFromLibrary('whittle:aluminium-6061-t6');
  if (!m) throw new Error('library material missing');
  part(doc).material = m;
  return doc;
}

describe.skipIf(!built)(`regen golden: materials, export, picking${skipNote}`, () => {
  let api: Api;
  let r: RegenResult;
  beforeAll(async () => {
    api = await loadApi();
    r = await api.regenerate({ doc: aluminiumBracket(), partId: PART, quality: 'fine' });
  }, 60_000);
  afterAll(async () => {
    await api?.closePart(PART);
  });

  it('a material gives every body mass and inertia (no request flag needed)', () => {
    expect(
      states(r as Parameters<typeof states>[0]),
      describeFailures(r as Parameters<typeof states>[0]),
    ).toEqual(Array(9).fill('ok'));
    const mp = r.bodies[0]?.massProperties;
    const v = bracketVolume(BRACKET_DIMS);
    relClose(mp?.volume ?? 0, v, 1e-7);
    // 2.70 g/cm³ = 2.7e-6 kg/mm³.
    relClose(mp?.mass ?? 0, v * 2.7e-6, 1e-7);
    expect(mp?.inertia).toHaveLength(9);
  });

  it('STEP (AP214 default, AP242 accepted) re-imports with the same volume (1e-6)', async () => {
    const v = r.bodies[0]?.massProperties?.volume ?? 0;
    for (const stepSchema of [undefined, 'AP242'] as const) {
      const out = await api.exportPart(PART, 'step', stepSchema ? { stepSchema } : {});
      if (!out.ok) throw new Error(JSON.stringify(out.error));
      const text = new TextDecoder().decode(out.bytes.subarray(0, 2000));
      expect(text).toMatch(/^ISO-10303-21;/);
      expect(text).toMatch(stepSchema === 'AP242' ? /AP242/ : /AUTOMOTIVE_DESIGN/);
      const back = await api.importFile(out.bytes, 'step');
      if (!back.ok) throw new Error(JSON.stringify(back.error));
      expect(back.bodies).toHaveLength(1);
      const b = back.bodies[0] as (typeof back.bodies)[0];
      expect(b.name).toBe('Bracket');
      expect(b.mesh.indices.length).toBeGreaterThan(0);
      const mp = await api.massProperties(b.shape);
      if (!mp.ok) throw new Error(JSON.stringify(mp.error));
      relClose(mp.value.volume, v, 1e-6);
      await api.release(b.shape);
    }
  });

  it('STL is watertight and its volume matches the B-rep within the deflection', async () => {
    const v = r.bodies[0]?.massProperties?.volume ?? 0;
    for (const stlBinary of [true, false]) {
      const out = await api.exportPart(PART, 'stl', {
        stlBinary,
        linearDeflection: 0.02,
        angularDeflection: 0.25,
      });
      if (!out.ok) throw new Error(JSON.stringify(out.error));
      const a = analyzeStl(out.bytes);
      expect(a.watertight).toBe(true);
      expect(a.boundaryEdges).toBe(0);
      expect(a.nonManifoldEdges).toBe(0);
      relClose(a.volume, v, 2e-3);
    }
    const brep = await api.exportPart(PART, 'brep');
    expect(brep.ok).toBe(true);
    const back = brep.ok ? await api.importFile(brep.bytes, 'brep') : null;
    if (!back?.ok) throw new Error('brep re-import failed');
    const mp = await api.massProperties((back.bodies[0] as { shape: number }).shape);
    relClose(mp.ok ? mp.value.volume : 0, v, 1e-9);
    for (const b of back.bodies) await api.release(b.shape);
  });

  it('per-body STL is a zip; options.bodies filters', async () => {
    const MP = fid('MP2');
    const A = fid('XA');
    const AS = fid('XAS');
    const BB = fid('XB');
    const BS = fid('XBS');
    const rect = (id: string, x0: number) => {
      const s = new Sk();
      s.rect('p', 'L', x0, 0, x0 + 10, 10);
      for (const p of ['pa', 'pb', 'pc', 'pd']) s.geo({ kind: 'fix', entity: p });
      return s.feature(id);
    };
    const doc = makeDoc(
      {},
      [
        rect(AS, 0),
        extrude(A, [region(AS, 'L1,L2,L3,L4')], '10'),
        rect(BS, 20),
        extrude(BB, [region(BS, 'L1,L2,L3,L4')], '5'),
      ],
      MP,
    );
    const rr = await api.regenerate({ doc, partId: MP, quality: 'coarse' });
    expect(rr.bodies).toHaveLength(2);
    const zip = await api.exportPart(MP, 'stl', { stlPerBody: true });
    if (!zip.ok) throw new Error(JSON.stringify(zip.error));
    const files = unzipSync(zip.bytes);
    const names = Object.keys(files).sort();
    expect(names).toHaveLength(2);
    for (const n of names) {
      expect(n).toMatch(/\.stl$/);
      expect(analyzeStl(files[n] as Uint8Array).watertight).toBe(true);
    }
    const one = await api.exportPart(MP, 'stl', { bodies: [`B${BB}`] });
    if (!one.ok) throw new Error(JSON.stringify(one.error));
    relClose(analyzeStl(one.bytes).volume, 500, 1e-6);
    const none = await api.exportPart(MP, 'stl', { bodies: ['Bnope'] });
    expect(none.ok).toBe(false);
    const never = await api.exportPart(fid('NOPART'), 'step');
    expect(never.ok ? '' : never.error.message).toMatch(/not been regenerated/);
    await api.closePart(MP);
  });

  it('refFor: a picked face/edge becomes a ref that resolves back to the same entity', async () => {
    const body = r.bodies[0];
    if (!body) throw new Error('no body');
    const top = `F${B.E3}:end`;
    const fi = body.mesh.faceNames.indexOf(top);
    const ref = await api.refFor(PART, { bodyId: body.id, kind: 'face', index: fi });
    expect(ref?.name).toBe(top);
    expect(ref?.kind).toBe('face');
    expect(ref?.fingerprint?.normal).toEqual([0, 0, 1]);
    expect(ref?.fingerprint?.centroid[2]).toBeCloseTo(48, 9);
    const ei = 3;
    const eref = await api.refFor(PART, { bodyId: body.id, kind: 'edge', index: ei });
    expect(eref?.name).toBe(body.mesh.edgeNames[ei]);
    expect(eref?.fingerprint?.length).toBeGreaterThan(0);
    const vref = await api.refFor(PART, { bodyId: body.id, kind: 'vertex', index: 0 });
    expect(vref?.kind).toBe('vertex');
    expect(await api.refFor(PART, { bodyId: 'Bnope', kind: 'face', index: 0 })).toBeNull();
    expect(await api.refFor(PART, { bodyId: body.id, kind: 'face', index: 9999 })).toBeNull();

    // Sketch on the picked face: resolves (with its fingerprint) and sits at the upright's top.
    const s = new Sk();
    s.circle('C', 40, 46, 1);
    s.geo({ kind: 'fix', entity: 'Cc' });
    const doc = aluminiumBracket();
    const SP = fid('PICK');
    part(doc).features.push(s.feature(SP, ref as EntityRef));
    part(doc).rollbackIndex += 1;
    const rr = await api.regenerate({ doc, partId: PART, quality: 'coarse' });
    expect(rr.features.at(-1)?.state).toBe('ok');
    expect(rr.sketches.find((x) => x.featureId === SP)?.frame.origin).toEqual([0, 0, 48]);
    // Back to the plain bracket for the other tests.
    r = await api.regenerate({ doc: aluminiumBracket(), partId: PART, quality: 'fine' });
  });

  it('over Comlink: regenerate transfers its buffers and the worker cache stays intact', async () => {
    const worker = await loadApi();
    let sent: RegenResult | undefined;
    const exposed: ModelingWorkerApi = {
      ...worker,
      async regenerate(request) {
        sent = await worker.regenerate(request);
        return sent;
      },
    };
    const { port1, port2 } = new MessageChannel();
    expose(exposed, nodeEndpoint(port1));
    const remote = wrap<ModelingWorkerApi>(nodeEndpoint(port2));
    try {
      const doc = bracketDoc();
      const a = await remote.regenerate({
        doc,
        partId: PART,
        quality: 'coarse',
        massProperties: true,
      });
      expect(a.features.map((f) => f.state)).toEqual(Array(9).fill('ok'));
      const mesh = a.bodies[0]?.mesh;
      expect(mesh?.positions).toBeInstanceOf(Float32Array);
      expect(mesh?.positions.length).toBeGreaterThan(0);
      expect(a.sketches[0]?.curves[0]?.points).toBeInstanceOf(Float32Array);
      expect(a.sketches[0]?.regions[0]?.mesh.indices.length).toBeGreaterThan(0);
      // The worker-side copies were transferred (detached), not structured-cloned.
      expect(sent?.bodies[0]?.mesh.positions.buffer.byteLength).toBe(0);
      expect(sent?.sketches[0]?.curves[0]?.points.buffer.byteLength).toBe(0);
      // Fully cached second run still delivers complete meshes (copies of the cached ones).
      const b = await remote.regenerate({
        doc: withParams(doc, {}),
        partId: PART,
        quality: 'coarse',
        massProperties: true,
      });
      expect(b.cache).toEqual({ hits: 9, misses: 0 });
      expect(b.bodies[0]?.mesh.positions.length).toBe(mesh?.positions.length);
      relClose(b.bodies[0]?.massProperties?.volume ?? 0, bracketVolume(BRACKET_DIMS), 1e-7);
      const step = await remote.exportPart(PART, 'step');
      expect(step.ok && step.bytes.byteLength > 1000).toBe(true);
      const ref = await remote.refFor(PART, { bodyId: `B${B.E1}`, kind: 'face', index: 0 });
      expect(typeof ref?.name).toBe('string');
      await remote.closePart(PART);
      expect(worker.liveHandleCount()).toBe(0);
    } finally {
      port1.close();
      port2.close();
    }
  });
});
