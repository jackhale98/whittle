/**
 * Worker protocol: the client talks Comlink to an exposed solver (a MessageChannel stands in for
 * the worker so planegcs runs in Node), and the async `createSketchSolver()` API round-trips.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchSolverApi } from '@wren-cad/contracts';
import { expose } from 'comlink';
import { afterAll, describe, expect, it } from 'vitest';
import { createSketchSolverClient } from '../src/client';
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
