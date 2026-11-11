/**
 * Worker protocol: the client talks Comlink to an exposed solver (a MessageChannel stands in for
 * the worker so planegcs runs in Node), and the async `createSketchSolver()` API round-trips.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchSolverApi } from '@wren-cad/contracts';
import { expose } from 'comlink';
import { afterAll, describe, expect, it } from 'vitest';
import { createSketchSolverClient, SketchSolverTimeout } from '../src/client';
import { createSketchSolver } from '../src/core';
import { rectangle, SketchBuilder } from './helpers';

describe('createSketchSolverClient', () => {
  const solver = createSketchSolver();
  const channel = new MessageChannel();
  const api: SketchSolverApi = {
    solve: (i) => solver.solve(i),
    beginDrag: (i, e, g) => solver.beginDrag(i, e, g),
    drag: (s, t) => solver.drag(s, t),
    endDrag: (s) => solver.endDrag(s),
    infer: (i, c, d, t) => solver.infer(i, c, d, t),
  };
  expose(api, channel.port1);
  let terminated = false;
  const fakeWorker = Object.assign(channel.port2, {
    terminate() {
      terminated = true;
      channel.port2.close();
    },
  }) as unknown as Worker;
  const client = createSketchSolverClient({ createWorker: () => fakeWorker });

  afterAll(() => {
    client.dispose();
    channel.port1.close();
    solver.dispose();
  });

  it('solves, drags and infers through the proxy', async () => {
    const b = new SketchBuilder();
    const r = rectangle(b);
    b.geo({ kind: 'fix', entity: r.p0 });
    const res = await client.api.solve(b.input());
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(2);
    const p2 = res.entities.find((e) => e.id === r.p2);
    if (p2?.kind !== 'point') throw new Error('p2');
    const { session } = await client.api.beginDrag(b.input(), r.p2, [p2.x, p2.y]);
    const moved = await client.api.drag(session, [p2.x + 5, p2.y + 5]);
    expect(moved.status).toBe('solved');
    const end = await client.api.endDrag(session);
    const q = end.entities.find((e) => e.id === r.p2);
    expect(q?.kind === 'point' && q.x).toBeCloseTo(p2.x + 5, 6);
    const inferred = await client.api.infer(b.input(), [0.1, 0.1], null, 1);
    expect(inferred[0]?.constraint.kind).toBe('coincident');
  });

  it('dispose terminates the worker', () => {
    client.dispose();
    expect(terminated).toBe(true);
  });
});

describe('a worker that stops answering (M3.8 settle hang)', () => {
  it('rejects past the deadline, terminates it and answers from a fresh worker', async () => {
    // The first worker swallows every message (a crashed or hung worker); the second one works.
    const solver = createSketchSolver();
    const spawned: { terminated: boolean; port: MessagePort }[] = [];
    const channels: MessageChannel[] = [];
    const createWorker = () => {
      const channel = new MessageChannel();
      channels.push(channel);
      if (spawned.length > 0)
        expose(
          {
            solve: (i: Parameters<SketchSolverApi['solve']>[0]) => solver.solve(i),
          } as unknown as SketchSolverApi,
          channel.port1,
        );
      const rec = { terminated: false, port: channel.port2 };
      spawned.push(rec);
      return Object.assign(channel.port2, {
        terminate() {
          rec.terminated = true;
          channel.port2.close();
        },
      }) as unknown as Worker;
    };
    const client = createSketchSolverClient({ createWorker, timeoutMs: 150 });
    const b = new SketchBuilder();
    rectangle(b);
    try {
      // Without the deadline this await never returned, and nor did anything queued behind it.
      await expect(client.api.solve(b.input())).rejects.toBeInstanceOf(SketchSolverTimeout);
      expect(spawned[0]?.terminated).toBe(true);
      const res = await client.api.solve(b.input());
      expect(res.status).toBe('solved');
      expect(spawned).toHaveLength(2);
    } finally {
      client.dispose();
      for (const c of channels) c.port1.close();
      solver.dispose();
    }
  });

  it('a worker error fails its unanswered calls at once', async () => {
    const ports: MessagePort[] = [];
    const client = createSketchSolverClient({
      createWorker: () => {
        const c = new MessageChannel();
        ports.push(c.port1, c.port2);
        return Object.assign(c.port2, { terminate() {} }) as unknown as Worker;
      },
      timeoutMs: 60_000,
    });
    try {
      const call = client.api.solve({ entities: [], constraints: [], values: {} });
      ports[1]?.dispatchEvent(new Event('error'));
      await expect(call).rejects.toThrow(/restarted/);
    } finally {
      client.dispose();
      for (const p of ports) p.close();
    }
  });

  it('a disposed client rejects instead of spawning', async () => {
    const client = createSketchSolverClient({
      createWorker: () =>
        Object.assign(new MessageChannel().port2, { terminate() {} }) as unknown as Worker,
    });
    client.dispose();
    await expect(client.api.solve({ entities: [], constraints: [], values: {} })).rejects.toThrow(
      /disposed/,
    );
  });
});
