import {
  DEFAULT_MOTION_SETTINGS,
  type MotionInputState,
  type MotionSample,
} from '@wren-cad/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMotionInput,
  type HIDDeviceLike,
  type HIDInputReportEventLike,
  type HIDLike,
  NO_REPORTS_MS,
  PAIRED_FLAG_KEY,
  STATE_THROTTLE_MS,
} from '../src/motion/hid';

class FakeDevice implements HIDDeviceLike {
  opened = false;
  openError: Error | null = null;
  closed = false;
  private readonly ls = new Set<(e: HIDInputReportEventLike) => void>();
  constructor(
    readonly vendorId = 0x256f,
    readonly productId = 0xc635,
    readonly productName = 'Test 6-DoF',
    readonly collections: Array<{ usagePage?: number; usage?: number }> = [
      { usagePage: 1, usage: 8 },
    ],
  ) {}
  async open() {
    if (this.openError) throw this.openError;
    this.opened = true;
  }
  async close() {
    this.opened = false;
    this.closed = true;
  }
  addEventListener(_t: 'inputreport', l: (e: HIDInputReportEventLike) => void) {
    this.ls.add(l);
  }
  removeEventListener(_t: 'inputreport', l: (e: HIDInputReportEventLike) => void) {
    this.ls.delete(l);
  }
  get listenerCount() {
    return this.ls.size;
  }
  report(reportId: number, bytes: number[]) {
    const data = new DataView(new Uint8Array(bytes).buffer);
    for (const l of [...this.ls]) l({ reportId, data });
  }
}

class FakeHid implements HIDLike {
  granted: FakeDevice[] = [];
  chooser: FakeDevice[] | Error = [];
  requested: unknown[] = [];
  private readonly ls = new Map<string, Set<(e: { device: HIDDeviceLike }) => void>>();
  async getDevices() {
    return this.granted;
  }
  async requestDevice(o: unknown) {
    this.requested.push(o);
    if (this.chooser instanceof Error) throw this.chooser;
    this.granted.push(...this.chooser);
    return this.chooser;
  }
  addEventListener(t: string, l: (e: { device: HIDDeviceLike }) => void) {
    if (!this.ls.has(t)) this.ls.set(t, new Set());
    this.ls.get(t)?.add(l);
  }
  removeEventListener(t: string, l: (e: { device: HIDDeviceLike }) => void) {
    this.ls.get(t)?.delete(l);
  }
  fire(t: 'connect' | 'disconnect', device: FakeDevice) {
    for (const l of [...(this.ls.get(t) ?? [])]) l({ device });
  }
  listenerCount(t: string) {
    return this.ls.get(t)?.size ?? 0;
  }
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function make(hid: FakeHid | undefined, over: { hidOff?: boolean } = {}) {
  const samples: MotionSample[] = [];
  const buttons: Array<[number, boolean]> = [];
  const input = createMotionInput({
    settings: DEFAULT_MOTION_SETTINGS,
    onSample: (s) => samples.push(s),
    onButton: (b, d) => buttons.push([b, d]),
    ...(hid && !over.hidOff ? { hid } : {}),
  });
  return { input, samples, buttons };
}

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.useFakeTimers();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});
afterEach(() => {
  vi.useRealTimers();
  (globalThis as { localStorage?: unknown }).localStorage = undefined;
});

describe('createMotionInput states', () => {
  it('is unsupported without WebHID and never throws', async () => {
    const saved = (globalThis as { navigator?: unknown }).navigator;
    // Node 22 has a navigator without `hid`: this is the Safari / Firefox situation.
    const { input } = make(undefined);
    expect(input.state()).toEqual({ path: 'none', state: 'unsupported' });
    await expect(input.pair()).resolves.toBeUndefined();
    input.setSettings(DEFAULT_MOTION_SETTINGS);
    input.dispose();
    expect((globalThis as { navigator?: unknown }).navigator).toBe(saved);
  });

  it('is notPaired when nothing was granted', async () => {
    const { input } = make(new FakeHid());
    await flush();
    expect(input.state()).toEqual({ path: 'none', state: 'notPaired' });
  });

  it('reconnects a granted device on load, then goes live on the first report', async () => {
    const hid = new FakeHid();
    const dev = new FakeDevice();
    hid.granted = [dev];
    const { input, samples } = make(hid);
    const seen: MotionInputState[] = [];
    input.onState((s) => seen.push(s));
    await flush();
    expect(dev.opened).toBe(true);
    const waiting = input.state();
    expect(waiting.path).toBe('webhid');
    if (waiting.path === 'webhid') {
      expect(waiting.state).toBe('live'); // opened, waiting for the first report (< 3 s)
      expect(waiting.last).toBeUndefined();
      expect(waiting.device).toEqual({ name: 'Test 6-DoF', vendorId: 0x256f, productId: 0xc635 });
    }
    dev.report(1, [0x5e, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.t[0]).toBeCloseTo(1);
    const live = input.state();
    expect(live.path === 'webhid' && live.state === 'live' && live.last?.t[0]).toBeCloseTo(1);
    expect(seen.at(-1)?.path).toBe('webhid'); // the first report is delivered at once
  });

  it('reports noReports when opened but silent for about 3 s, and recovers on a report', async () => {
    const hid = new FakeHid();
    const dev = new FakeDevice();
    hid.granted = [dev];
    const { input } = make(hid);
    await flush();
    vi.advanceTimersByTime(NO_REPORTS_MS - 1);
    expect(input.state()).toMatchObject({ path: 'webhid', state: 'live' });
    vi.advanceTimersByTime(2);
    expect(input.state()).toMatchObject({ path: 'webhid', state: 'noReports' });
    dev.report(2, [0, 0, 0, 0, 0xaf, 0]);
    expect(input.state()).toMatchObject({ path: 'webhid', state: 'live' });
  });

  it('reports noReports at once when the open fails (a driver holds the device)', async () => {
    const hid = new FakeHid();
    const dev = new FakeDevice();
    dev.openError = new Error('Failed to open the device');
    hid.granted = [dev];
    const { input } = make(hid);
    await flush();
    expect(input.state()).toMatchObject({ path: 'webhid', state: 'noReports' });
  });

  it('pair() asks for multi-axis controllers and the vendor ids, and attaches the device', async () => {
    const hid = new FakeHid();
    const dev = new FakeDevice(0x046d, 0xc626, '');
    hid.chooser = [dev];
    const { input } = make(hid);
    await flush();
    await input.pair();
    await flush();
    const req = hid.requested[0] as { filters: Array<Record<string, number>> };
    expect(req.filters).toContainEqual({ usagePage: 1, usage: 8 });
    expect(
      req.filters.some((f) => f.vendorId === 0x046d && f.usagePage === 1 && f.usage === 8),
    ).toBe(true);
    expect(req.filters.some((f) => f.vendorId === 0x256f)).toBe(true);
    const s = input.state();
    expect(s.path === 'webhid' && s.device.name).toBe('3D mouse (entry)'); // table name, no product name
    expect(store.get(PAIRED_FLAG_KEY)).toBe('1');
  });

  it('a cancelled or failing chooser resolves quietly', async () => {
    const hid = new FakeHid();
    hid.chooser = new Error('NotAllowedError');
    const { input } = make(hid);
    await flush();
    await expect(input.pair()).resolves.toBeUndefined();
    expect(input.state()).toEqual({ path: 'none', state: 'notPaired' });
    hid.chooser = [];
    await expect(input.pair()).resolves.toBeUndefined();
  });

  it('handles connect and disconnect events', async () => {
    const hid = new FakeHid();
    const { input, samples, buttons } = make(hid);
    await flush();
    const dev = new FakeDevice();
    hid.fire('connect', dev);
    await flush();
    expect(input.state()).toMatchObject({ path: 'webhid' });
    dev.report(3, [0b10, 0, 0, 0]);
    dev.report(1, [0x5e, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(buttons).toEqual([[2, true]]);
    hid.fire('disconnect', dev);
    // A zero sample stops the view and the held button is released.
    expect(samples.at(-1)).toMatchObject({ t: [0, 0, 0], r: [0, 0, 0] });
    expect(buttons.at(-1)).toEqual([2, false]);
    expect(input.state()).toEqual({ path: 'none', state: 'disconnected' });
    expect(dev.listenerCount).toBe(0);
    hid.fire('connect', dev);
    await flush();
    expect(input.state()).toMatchObject({ path: 'webhid' });
  });

  it('reads disconnected (not notPaired) for a device paired in an earlier visit', async () => {
    store.set(PAIRED_FLAG_KEY, '1');
    const { input } = make(new FakeHid());
    await flush();
    expect(input.state()).toEqual({ path: 'none', state: 'disconnected' });
  });

  it('ignores devices that are not 3D mice', async () => {
    const hid = new FakeHid();
    hid.granted = [new FakeDevice(0x1234, 0x1, 'Pad', [{ usagePage: 1, usage: 5 }])];
    const { input } = make(hid);
    await flush();
    expect(input.state()).toEqual({ path: 'none', state: 'notPaired' });
  });

  it('accepts an unknown product that exposes the multi-axis usage', async () => {
    const hid = new FakeHid();
    hid.granted = [new FakeDevice(0x1234, 0x1, 'Other 6-DoF', [{ usagePage: 1, usage: 8 }])];
    const { input } = make(hid);
    await flush();
    expect(input.state()).toMatchObject({ path: 'webhid', device: { name: 'Other 6-DoF' } });
  });

  it('separate translation and rotation reports each produce a sample with the other half held', async () => {
    const hid = new FakeHid();
    const dev = new FakeDevice(0x046d, 0xc626);
    hid.granted = [dev];
    const { input, samples } = make(hid);
    await flush();
    dev.report(1, [0x5e, 0x01, 0, 0, 0, 0]);
    dev.report(2, [0, 0, 0, 0, 0xaf, 0]);
    expect(samples).toHaveLength(2);
    expect(samples[1]?.t[0]).toBeCloseTo(1);
    expect(samples[1]?.r[2]).toBeCloseTo((0.5 - 0.04) / 0.96);
    input.dispose();
  });

  it('applies new settings to later reports', async () => {
    const hid = new FakeHid();
    const dev = new FakeDevice();
    hid.granted = [dev];
    const { input, samples } = make(hid);
    await flush();
    input.setSettings({ ...DEFAULT_MOTION_SETTINGS, deadZone: 0, translate: false });
    dev.report(1, [0x5e, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(samples[0]?.t).toEqual([0, 0, 0]);
  });

  it('throttles live state to about 10 Hz but delivers transitions at once', async () => {
    const hid = new FakeHid();
    const dev = new FakeDevice();
    hid.granted = [dev];
    const { input } = make(hid);
    const seen: MotionInputState[] = [];
    input.onState((s) => seen.push(s));
    await flush();
    dev.report(1, [0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // first report: urgent
    vi.advanceTimersByTime(STATE_THROTTLE_MS + 1);
    seen.length = 0;
    for (let i = 0; i < 50; i++) {
      dev.report(1, [0x20 + i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      vi.advanceTimersByTime(8); // 125 Hz
    }
    expect(seen.length).toBeLessThanOrEqual(5); // 400 ms of reports
    expect(seen.length).toBeGreaterThanOrEqual(3);
    seen.length = 0;
    hid.fire('disconnect', dev);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ path: 'none', state: 'disconnected' });
  });

  it('dispose detaches everything and closes the device', async () => {
    const hid = new FakeHid();
    const dev = new FakeDevice();
    hid.granted = [dev];
    const { input, samples } = make(hid);
    await flush();
    input.dispose();
    await flush();
    expect(dev.listenerCount).toBe(0);
    expect(dev.closed).toBe(true);
    expect(hid.listenerCount('connect')).toBe(0);
    expect(hid.listenerCount('disconnect')).toBe(0);
    dev.report(1, [0x5e, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(samples).toHaveLength(0);
  });

  it('onButton delivers every edge, including taps shorter than the state throttle', async () => {
    const hid = new FakeHid();
    const dev = new FakeDevice();
    hid.granted = [dev];
    const { input } = make(hid);
    const got: Array<[number, boolean]> = [];
    const off = input.onButton((b, d) => got.push([b, d]));
    await flush();
    dev.report(3, [1, 0, 0, 0]);
    dev.report(3, [0, 0, 0, 0]);
    expect(got).toEqual([
      [1, true],
      [1, false],
    ]);
    off();
    dev.report(3, [1, 0, 0, 0]);
    expect(got).toHaveLength(2);
  });

  it('survives a throwing consumer', async () => {
    const hid = new FakeHid();
    const dev = new FakeDevice();
    hid.granted = [dev];
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const input = createMotionInput({
      settings: DEFAULT_MOTION_SETTINGS,
      onSample: () => {
        throw new Error('boom');
      },
      onButton: () => {
        throw new Error('boom');
      },
      hid,
    });
    await flush();
    expect(() => dev.report(1, [0x5e, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).not.toThrow();
    expect(() => dev.report(3, [1, 0, 0, 0])).not.toThrow();
    err.mockRestore();
    input.dispose();
  });
});
