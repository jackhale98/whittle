import type { SyncStatus } from '@whittle/contracts';
import { PARAMS_FILE, toFiles } from '@whittle/document';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_WAIT,
  nextCheckDelay,
  SAVE_DATA_MAX_WAIT,
  SAVE_DATA_WAIT,
} from '../../src/engine/schedule';
import { MemoryProvider } from '../../src/providers/memory';
import { Device, fakeEnvironment, LINK } from '../support/device';
import { makeDoc, paramOf, withParam } from '../support/project';

const MINUTE = 60_000;

// Ported from Mycelium src/lib/sync/schedule.test.ts.
describe('nextCheckDelay', () => {
  it('starts at the service pace and doubles while quiet, up to five minutes', () => {
    const at = (quiet: number) => nextCheckDelay({ base: MINUTE, quiet, saveData: false });
    expect([0, 1, 2, 3, 4, 20].map(at)).toEqual([
      MINUTE,
      2 * MINUTE,
      4 * MINUTE,
      MAX_WAIT,
      MAX_WAIT,
      MAX_WAIT,
    ]);
  });

  it('keeps a slow service at its own pace', () => {
    expect(nextCheckDelay({ base: 5 * MINUTE, quiet: 0, saveData: false })).toBe(5 * MINUTE);
    expect(nextCheckDelay({ base: 5 * MINUTE, quiet: 3, saveData: false })).toBe(5 * MINUTE);
  });

  it('checks far less often with Data Saver on', () => {
    expect(nextCheckDelay({ base: MINUTE, quiet: 0, saveData: true })).toBe(SAVE_DATA_WAIT);
    expect(nextCheckDelay({ base: MINUTE, quiet: 5, saveData: true })).toBe(SAVE_DATA_MAX_WAIT);
  });
});

const devices: Device[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  for (const d of devices.splice(0)) d.engine.dispose();
  vi.useRealTimers();
});

const abs = (p: string) => `${LINK.path}/${p}`;

/** A remote with a project, and a device with its own window events, already synced. */
async function setup(remote = new MemoryProvider()) {
  if (!remote.files.size) for (const [p, b] of toFiles(makeDoc())) remote.put(abs(p), b);
  const ev = fakeEnvironment();
  const d = new Device(remote, undefined, {
    environment: ev.env,
    debounceMs: 3_000,
    syncOnStart: true,
  });
  devices.push(d);
  await d.engine.idle();
  return { remote, d, ev };
}

/** Advances fake time, letting rounds started by timers finish in between. */
async function advance(device: Device | Device[], ms: number, step = 250) {
  const all = Array.isArray(device) ? device : [device];
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - t));
    for (const d of all) await d.engine.idle();
  }
}

describe('sync engine scheduling (fake timers)', () => {
  it('debounces pushes until edits settle (3 s)', async () => {
    const { remote, d } = await setup();
    const writes = remote.calls.write;
    d.saveDoc(withParam(d.doc(), 'width', '41 mm'));
    await advance(d, 1_000);
    d.saveDoc(withParam(d.doc(), 'width', '42 mm'));
    await advance(d, 1_000);
    d.saveDoc(withParam(d.doc(), 'width', '43 mm'));
    await advance(d, 2_750);
    expect(remote.calls.write).toBe(writes);
    expect(d.engine.status()).toMatchObject({ state: 'idle', pending: 1 });
    await advance(d, 500);
    expect(remote.calls.write).toBe(writes + 1);
    expect(remote.text(abs(PARAMS_FILE))).toContain('43 mm');
    expect(d.engine.status()).toMatchObject({ state: 'idle', pending: 0 });
  });

  it('shows a change made on device A on device B within 10 s of B gaining focus', async () => {
    const { remote, d: a } = await setup();
    const { d: b, ev: bEv } = await setup(remote);
    // Long enough that B's poll can't be what finds it.
    await advance([a, b], 1_000);
    a.saveDoc(withParam(a.doc(), 'height', '27 mm'));
    await advance([a, b], 3_500); // A's debounced push has landed
    expect(remote.text(abs(PARAMS_FILE))).toContain('27 mm');
    expect(paramOf(b.doc(), 'height')).toBe('20 mm');
    const focusedAt = Date.now();
    bEv.focus();
    let seenAt: number | null = null;
    for (let t = 0; t <= 10_000 && seenAt === null; t += 250) {
      await advance([a, b], 250);
      if (paramOf(b.doc(), 'height') === '27 mm') seenAt = Date.now();
    }
    expect(seenAt).not.toBeNull();
    expect(seenAt! - focusedAt).toBeLessThanOrEqual(10_000);
  });

  it('still shows it within 10 s when B gains focus while A’s push is still settling', async () => {
    const { remote, d: a } = await setup();
    const { d: b, ev: bEv } = await setup(remote);
    a.saveDoc(withParam(a.doc(), 'height', '28 mm'));
    const focusedAt = Date.now();
    bEv.focus(); // A hasn't pushed yet (3 s debounce)
    await advance([a, b], 500);
    expect(paramOf(b.doc(), 'height')).toBe('20 mm');
    let seenAt: number | null = null;
    for (let t = 0; t <= 10_000 && seenAt === null; t += 250) {
      await advance([a, b], 250);
      if (paramOf(b.doc(), 'height') === '28 mm') seenAt = Date.now();
    }
    expect(seenAt).not.toBeNull();
    // Rechecks at 3, 6 and 9 s: a push landing ~3 s after focus is seen by the 6 s check,
    // leaving margin under the 10 s acceptance on slow devices.
    expect(seenAt! - focusedAt).toBeLessThanOrEqual(6_500);
  });

  it('polls at the provider’s pace, and stretches while quiet', async () => {
    const remote = new MemoryProvider({ pollMs: 60_000 });
    const { d } = await setup(remote);
    const lists = remote.calls.list;
    await advance(d, 59_000, 1_000);
    expect(remote.calls.list).toBe(lists);
    await advance(d, 2_000, 1_000);
    expect(remote.calls.list).toBe(lists + 1);
    // Quiet: the next check waits longer (2 minutes after a quiet one).
    await advance(d, 61_000, 1_000);
    expect(remote.calls.list).toBe(lists + 1);
    remote.put(abs('notes/x.txt'), 'x');
    await advance(d, 60_000, 1_000);
    expect(remote.calls.list).toBe(lists + 2);
    expect(d.store.text('notes/x.txt')).toBe('x');
  });

  it('doesn’t poll while the page is hidden', async () => {
    const remote = new MemoryProvider({ pollMs: 10_000 });
    const { d, ev } = await setup(remote);
    ev.state.visible = false;
    const lists = remote.calls.list;
    await advance(d, 120_000, 5_000);
    expect(remote.calls.list).toBe(lists);
  });

  it('holds edits while offline and replays them when the device comes back online', async () => {
    const { remote, d, ev } = await setup();
    const statuses: SyncStatus['state'][] = [];
    d.engine.subscribe((s) => statuses.push(s.state));
    ev.goOffline();
    d.save('imports/z.step', 'Z');
    await advance(d, 4_000);
    expect(remote.text(abs('imports/z.step'))).toBeUndefined();
    expect(d.engine.status()).toEqual({ state: 'offline', pending: 1 });
    ev.goOnline();
    await advance(d, 250);
    expect(remote.text(abs('imports/z.step'))).toBe('Z');
    expect(d.engine.status()).toMatchObject({ state: 'idle', pending: 0 });
    expect(statuses).toContain('syncing');
  });

  it('stops all timers and listeners on dispose', async () => {
    const remote = new MemoryProvider({ pollMs: 1_000 });
    const { d, ev } = await setup(remote);
    d.engine.dispose();
    const lists = remote.calls.list;
    d.store.save('notes/a.txt', 'a');
    d.engine.notifyLocalChange(['notes/a.txt']);
    ev.focus();
    await advance(d, 30_000, 1_000);
    expect(remote.calls.list).toBe(lists);
    expect(remote.calls.write).toBe(0);
  });
});
