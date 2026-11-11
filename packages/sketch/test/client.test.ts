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

describe('the deadline starts once the worker has loaded planegcs (review N5)', () => {
  /**
   * Workers that post the ready message (worker-protocol.ts) when `load` resolves; their solve
   * waits for it, like the real worker's first call while the Wasm downloads.
   */
  function loadingWorkers(solver: ReturnType<typeof createSketchSolver>) {
    const spawned: { terminated: boolean; ready: (ok?: boolean) => void; hang: boolean }[] = [];
    const ports: MessagePort[] = [];
    const createWorker = () => {
      const c = new MessageChannel();
      ports.push(c.port1, c.port2);
      let ready: (ok?: boolean) => void = () => {};
      const loaded = new Promise<void>((resolve) => {
        ready = (ok = true) => {
          c.port1.postMessage(
            ok ? { wrenSketch: 'ready' } : { wrenSketch: 'failed', message: 'HTTP 503' },
          );
          if (ok) resolve();
        };
      });
      const rec = { terminated: false, ready, hang: false };
      spawned.push(rec);
      expose(
        {
          solve: async (i: Parameters<SketchSolverApi['solve']>[0]) => {
            await loaded;
            if (rec.hang) return new Promise(() => {});
            return solver.solve(i);
          },
        } as unknown as SketchSolverApi,
        c.port1,
      );
      return Object.assign(c.port2, {
        terminate() {
          rec.terminated = true;
          c.port2.close();
        },
      }) as unknown as Worker;
    };
    return { spawned, ports, createWorker };
  }
  const input = () => {
    const b = new SketchBuilder();
    rectangle(b);
    return b.input();
  };

  it('a slow load longer than the deadline answers from the same worker', async () => {
    const solver = createSketchSolver();
    const w = loadingWorkers(solver);
    const client = createSketchSolverClient({
      createWorker: w.createWorker,
      signalsReady: true,
      timeoutMs: 100,
    });
    try {
      const call = client.api.solve(input());
      // A cold link: the Wasm takes three deadlines to arrive. Before, the worker was killed at
      // 100 ms and the next one downloaded it again.
      setTimeout(() => w.spawned[0]?.ready(), 300);
      expect((await call).status).toBe('solved');
      expect(w.spawned).toHaveLength(1);
      expect(w.spawned[0]?.terminated).toBe(false);
    } finally {
      client.dispose();
      for (const p of w.ports) p.close();
      solver.dispose();
    }
  });

  it('a worker still loading is never restarted; calls past the load limit reject', async () => {
    const solver = createSketchSolver();
    const w = loadingWorkers(solver);
    const client = createSketchSolverClient({
      createWorker: w.createWorker,
      signalsReady: true,
      timeoutMs: 50,
      loadTimeoutMs: 150,
    });
    try {
      await expect(client.api.solve(input())).rejects.toThrow(/still loading/);
      expect(w.spawned).toHaveLength(1);
      expect(w.spawned[0]?.terminated).toBe(false);
      w.spawned[0]?.ready();
      expect((await client.api.solve(input())).status).toBe('solved');
      expect(w.spawned).toHaveLength(1);
    } finally {
      client.dispose();
      for (const p of w.ports) p.close();
      solver.dispose();
    }
  });

  it('once loaded, a call that hangs still misses its deadline and the worker is restarted', async () => {
    const solver = createSketchSolver();
    const w = loadingWorkers(solver);
    const client = createSketchSolverClient({
      createWorker: w.createWorker,
      signalsReady: true,
      timeoutMs: 100,
    });
    try {
      w.spawned[0]?.ready();
      expect((await client.api.solve(input())).status).toBe('solved');
      const first = w.spawned[0];
      if (first) first.hang = true;
      await expect(client.api.solve(input())).rejects.toBeInstanceOf(SketchSolverTimeout);
      expect(first?.terminated).toBe(true);
      setTimeout(() => w.spawned[1]?.ready(), 10);
      expect((await client.api.solve(input())).status).toBe('solved');
      expect(w.spawned).toHaveLength(2);
    } finally {
      client.dispose();
      for (const p of w.ports) p.close();
      solver.dispose();
    }
  });

  it('a failed load fails the waiting calls at once', async () => {
    const solver = createSketchSolver();
    const w = loadingWorkers(solver);
    const client = createSketchSolverClient({
      createWorker: w.createWorker,
      signalsReady: true,
      loadTimeoutMs: 60_000,
    });
    try {
      const call = client.api.solve(input());
      w.spawned[0]?.ready(false);
      await expect(call).rejects.toThrow(/could not load \(HTTP 503\)/);
      expect(w.spawned[0]?.terminated).toBe(true);
    } finally {
      client.dispose();
      for (const p of w.ports) p.close();
      solver.dispose();
    }
  });
});
