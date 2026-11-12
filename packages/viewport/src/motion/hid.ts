/**
 * The thin WebHID layer of the 3D mouse adapter (ADR-096): finds granted devices, pairs on a user
 * gesture, opens, turns reports into `MotionSample`s and button events, and drives the
 * `MotionInputState` the diagnostics panel shows. Everything is feature-detected: without
 * `navigator.hid` (Safari, Firefox, iPad) it reports `unsupported` and never throws.
 */

import type {
  MotionInputState,
  MotionSample,
  MotionSettings,
} from '@wren-cad/contracts';
import {
  DEFAULT_FULL_SCALE,
  findMotionDevice,
  MOTION_USAGE,
  MOTION_USAGE_PAGE,
  MOTION_VENDOR_IDS,
  motionDeviceFilters,
} from './devices';
import { AxisAccumulator, buttonChanges, parseReport, pressedButtons } from './report';

// ---- structural WebHID types (the DOM lib has none; tests inject fakes) ----------------------

export interface HIDInputReportEventLike {
  reportId: number;
  data: DataView;
  timeStamp?: number;
}

export interface HIDDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly opened: boolean;
  readonly collections?: ReadonlyArray<{ usagePage?: number; usage?: number }>;
  open(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: 'inputreport', listener: (e: HIDInputReportEventLike) => void): void;
  removeEventListener(type: 'inputreport', listener: (e: HIDInputReportEventLike) => void): void;
}

export interface HIDLike {
  getDevices(): Promise<HIDDeviceLike[]>;
  requestDevice(options: {
    filters: Array<{ vendorId?: number; productId?: number; usagePage?: number; usage?: number }>;
  }): Promise<HIDDeviceLike[]>;
  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (e: { device: HIDDeviceLike }) => void,
  ): void;
  removeEventListener(
    type: 'connect' | 'disconnect',
    listener: (e: { device: HIDDeviceLike }) => void,
  ): void;
}

// ---- public API -------------------------------------------------------------------------------

export interface MotionInput {
  state(): MotionInputState;
  /** Live: throttled to about 10 Hz for the UI; discrete transitions are delivered at once. */
  onState(listener: (s: MotionInputState) => void): () => void;
  /** Must be called from a user gesture (`navigator.hid.requestDevice`). Resolves when granted or cancelled. */
  pair(): Promise<void>;
  setSettings(s: MotionSettings): void;
  dispose(): void;
}

export interface MotionInputOptions {
  settings: MotionSettings;
  /** Filtered samples, at report rate. */
  onSample: (s: MotionSample) => void;
  /** 1-based button number. */
  onButton: (button: number, down: boolean) => void;
  /** Injectable for tests; `navigator.hid` by default. */
  hid?: HIDLike;
}

/** A device that opened but sent nothing for this long is reported as `noReports`. */
export const NO_REPORTS_MS = 3000;
/** `onState` rate limit for the continuously changing fields (axis bars, buttons). */
export const STATE_THROTTLE_MS = 100;
/** localStorage key: a device was granted before (so an unplugged one reads `disconnected`). */
export const PAIRED_FLAG_KEY = 'wren.motion.paired';

export function hasWebHID(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator && !!(navigator as { hid?: unknown }).hid;
}

function defaultHid(): HIDLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as unknown as { hid?: HIDLike }).hid ?? undefined;
}

function readFlag(): boolean {
  try {
    return globalThis.localStorage?.getItem(PAIRED_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function writeFlag(v: boolean): void {
  try {
    if (v) globalThis.localStorage?.setItem(PAIRED_FLAG_KEY, '1');
    else globalThis.localStorage?.removeItem(PAIRED_FLAG_KEY);
  } catch {
    // storage unavailable: `disconnected` falls back to `notPaired`
  }
}

/** Is this granted device a 3D mouse (table, vendor or multi-axis collection)? */
export function isMotionDevice(d: HIDDeviceLike): boolean {
  if (findMotionDevice(d.vendorId, d.productId)) return true;
  if (d.collections?.some((c) => c.usagePage === MOTION_USAGE_PAGE && c.usage === MOTION_USAGE)) {
    return true;
  }
  // Without collection info only trust the vendor ids of the family.
  return !d.collections && MOTION_VENDOR_IDS.includes(d.vendorId);
}

interface Track {
  dev: HIDDeviceLike;
  fullScale: number;
  name: string;
  acc: AxisAccumulator;
  mask: number;
  got: boolean;
  /** No report within `NO_REPORTS_MS`, or the open failed (a driver may hold the device). */
  silent: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  onReport: (e: HIDInputReportEventLike) => void;
}

export function createMotionInput(opts: MotionInputOptions): MotionInput {
  const hid = opts.hid ?? defaultHid();
  let settings = opts.settings;
  let disposed = false;
  let paired = readFlag();
  let last: MotionSample | undefined;
  const tracks = new Map<HIDDeviceLike, Track>();
  const listeners = new Set<(s: MotionInputState) => void>();
  let lastEmit = 0;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const state = (): MotionInputState => {
    if (!hid) return { path: 'none', state: 'unsupported' };
    const t = tracks.values().next().value as Track | undefined;
    if (!t) return { path: 'none', state: paired ? 'disconnected' : 'notPaired' };
    return {
      path: 'webhid',
      state: t.got || !t.silent ? 'live' : 'noReports',
      device: { name: t.name, vendorId: t.dev.vendorId, productId: t.dev.productId },
      ...(last ? { last } : {}),
      buttons: pressedButtons(t.mask),
    };
  };

  const emit = () => {
    lastEmit = now();
    if (emitTimer !== null) {
      clearTimeout(emitTimer);
      emitTimer = null;
    }
    const s = state();
    for (const l of [...listeners]) {
      try {
        l(s);
      } catch (err) {
        console.error('motion state listener failed', err);
      }
    }
  };
  /** Transitions go out at once; axis and button changes at most every `STATE_THROTTLE_MS`. */
  const publish = (urgent: boolean) => {
    if (disposed) return;
    const wait = STATE_THROTTLE_MS - (now() - lastEmit);
    if (urgent || wait <= 0) emit();
    else if (emitTimer === null) emitTimer = setTimeout(emit, wait);
  };

  const sample = (s: MotionSample) => {
    try {
      opts.onSample(s);
    } catch (err) {
      console.error('motion sample handler failed', err);
    }
  };
  const button = (b: number, down: boolean) => {
    try {
      opts.onButton(b, down);
    } catch (err) {
      console.error('motion button handler failed', err);
    }
  };

  const attach = (dev: HIDDeviceLike) => {
    if (disposed || tracks.has(dev) || !isMotionDevice(dev)) return;
    const info = findMotionDevice(dev.vendorId, dev.productId);
    const t: Track = {
      dev,
      fullScale: info?.fullScale ?? DEFAULT_FULL_SCALE,
      name: dev.productName || info?.name || '3D mouse',
      acc: new AxisAccumulator(),
      mask: 0,
      got: false,
      silent: false,
      timer: null,
      onReport: (e) => report(t, e),
    };
    tracks.set(dev, t);
    paired = true;
    writeFlag(true);
    dev.addEventListener('inputreport', t.onReport);
    publish(true);
    const open = dev.opened ? Promise.resolve() : dev.open();
    open.then(
      () => {
        if (disposed || tracks.get(dev) !== t) return;
        t.timer = setTimeout(() => {
          t.timer = null;
          if (!t.got && tracks.get(dev) === t) {
            t.silent = true;
            publish(true);
          }
        }, NO_REPORTS_MS);
      },
      () => {
        // The browser could not open it (another program, usually the vendor driver, holds it).
        if (disposed || tracks.get(dev) !== t) return;
        t.silent = true;
        publish(true);
      },
    );
  };

  const report = (t: Track, e: HIDInputReportEventLike) => {
    if (disposed) return;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    } catch {
      return;
    }
    const rep = parseReport(e.reportId, bytes);
    if (rep.kind === 'unknown') return;
    const first = !t.got;
    t.got = true;
    t.silent = false;
    if (t.timer !== null) {
      clearTimeout(t.timer);
      t.timer = null;
    }
    if (rep.kind === 'buttons') {
      const changes = buttonChanges(t.mask, rep.mask);
      t.mask = rep.mask;
      for (const c of changes) button(c.button, c.down);
      publish(first || changes.length > 0);
      return;
    }
    if (!t.acc.apply(rep)) return;
    const ts = e.timeStamp;
    const time = ts && ts > 0 && Math.abs(now() - ts) < 10_000 ? ts : now();
    last = t.acc.sample(settings, time, t.fullScale);
    sample(last);
    publish(first);
  };

  const release = (t: Track) => {
    if (t.timer !== null) clearTimeout(t.timer);
    t.timer = null;
    t.dev.removeEventListener('inputreport', t.onReport);
    // A device that vanishes mid-gesture must not leave the view moving or a button held.
    for (const c of buttonChanges(t.mask, 0)) button(c.button, false);
    t.mask = 0;
    t.acc.reset();
    last = t.acc.sample(settings, now(), t.fullScale);
    sample(last);
  };

  const onConnect = (e: { device: HIDDeviceLike }) => attach(e.device);
  const onDisconnect = (e: { device: HIDDeviceLike }) => {
    const t =
      tracks.get(e.device) ??
      [...tracks.values()].find(
        (x) => x.dev.vendorId === e.device.vendorId && x.dev.productId === e.device.productId,
      );
    if (!t) return;
    tracks.delete(t.dev);
    release(t);
    last = undefined;
    publish(true);
  };

  if (hid) {
    try {
      hid.addEventListener('connect', onConnect);
      hid.addEventListener('disconnect', onDisconnect);
    } catch {
      // an exotic implementation: pairing still works
    }
    void (async () => {
      try {
        for (const d of await hid.getDevices()) attach(d);
      } catch {
        // permissions policy or a locked-down browser: treat as nothing granted
      }
      publish(true);
    })();
  }

  return {
    state,
    onState(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async pair() {
      if (!hid || disposed) return;
      try {
        const devices = await hid.requestDevice({ filters: motionDeviceFilters() });
        for (const d of devices) attach(d);
      } catch {
        // cancelled, no user gesture, or blocked by policy: the state already says why
      }
    },
    setSettings(s) {
      settings = s;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (emitTimer !== null) clearTimeout(emitTimer);
      try {
        hid?.removeEventListener('connect', onConnect);
        hid?.removeEventListener('disconnect', onDisconnect);
      } catch {
        // ignore
      }
      for (const t of tracks.values()) {
        if (t.timer !== null) clearTimeout(t.timer);
        t.dev.removeEventListener('inputreport', t.onReport);
        void t.dev.close().catch(() => undefined);
      }
      tracks.clear();
      listeners.clear();
    },
  };
}
