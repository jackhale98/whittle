/**
 * Main-thread client: status stream and lifecycle, against a fake worker (no Wasm needed).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { KernelStatus } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import { createKernelClient } from '../src/client';
import { statusMessage } from '../src/protocol';

class FakeWorker extends EventTarget {
  posted: unknown[] = [];
  terminated = false;
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function setup(autoInit = false) {
  const worker = new FakeWorker();
  const client = createKernelClient({ autoInit, createWorker: () => worker as unknown as Worker });
  return { worker, client };
}

describe('createKernelClient', () => {
  it('streams worker lifecycle statuses to subscribers', () => {
    const { worker, client } = setup();
    const seen: KernelStatus[] = [];
    const unsubscribe = client.status.subscribe((s) => seen.push(s));
    expect(seen).toEqual([{ state: 'idle' }]);

    const info = {
      variant: 'single',
      occtVersion: '8.0.1',
      buildId: '0123456789abcdef',
      initMs: 12,
    } as const;
    worker.emit(statusMessage({ state: 'downloading', loaded: 10, total: 100 }));
    worker.emit({ unrelated: true }); // Comlink traffic and other messages are ignored
    worker.emit(statusMessage({ state: 'compiling' }));
    worker.emit(statusMessage({ state: 'ready', info }));
    expect(seen.map((s) => s.state)).toEqual(['idle', 'downloading', 'compiling', 'ready']);
    expect(client.status.current).toEqual({ state: 'ready', info });

    unsubscribe();
    worker.emit(statusMessage({ state: 'compiling' }));
    expect(seen).toHaveLength(4);
    client.dispose();
  });

  it('turns worker errors into an error status', () => {
    const { worker, client } = setup();
    // Node has no ErrorEvent global; an Event with `message` is what the client reads.
    worker.dispatchEvent(Object.assign(new Event('error'), { message: 'boom' }));
    expect(client.status.current.state).toBe('error');
    if (client.status.current.state === 'error') {
      expect(client.status.current.error.code).toBe('INTERNAL');
      expect(client.status.current.error.detail).toBe('boom');
    }
    client.dispose();
  });

  it('sends the regen budget to the worker before init', () => {
    const worker = new FakeWorker();
    const client = createKernelClient({
      regen: { maxSpareResults: 16 },
      variant: 'single',
      createWorker: () => worker as unknown as Worker,
    });
    const calls = worker.posted.map((m) => m as { path?: string[]; argumentList?: unknown[] });
    expect(calls.map((m) => m.path?.[0])).toEqual(['configureRegen', 'init']);
    expect(JSON.stringify(calls[0]?.argumentList)).toContain('16');
    // The regen option is not an init option.
    expect(JSON.stringify(calls[1]?.argumentList)).not.toContain('maxSpareResults');
    client.dispose();
  });

  it('starts init automatically and terminates the worker on dispose', () => {
    const { worker, client } = setup(true);
    // Comlink posted the init() call to the worker.
    expect(worker.posted.length).toBe(1);
    client.dispose();
    expect(worker.terminated).toBe(true);
    client.dispose(); // idempotent
  });
});
