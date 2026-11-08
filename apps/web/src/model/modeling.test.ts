import type { RegenRequest, RegenResult, WhittleDoc } from '@whittle/contracts';
import { newDoc } from '@whittle/document';
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
    let doc: WhittleDoc = newDoc({ firstPart: 'P' });
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
    let doc: WhittleDoc = newDoc({ firstPart: 'P' });
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
});
