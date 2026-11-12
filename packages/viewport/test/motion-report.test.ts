import { DEFAULT_MOTION_SETTINGS, type MotionSettings } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  findMotionDevice,
  MOTION_DEVICES,
  MOTION_USAGE,
  MOTION_USAGE_PAGE,
  motionDeviceFilters,
} from '../src/motion/devices';
import {
  AxisAccumulator,
  buttonChanges,
  conditionAxes,
  deviceToScreen,
  normalizeCounts,
  parseReport,
  pressedButtons,
} from '../src/motion/report';

/**
 * Report payloads (without the report id) written out byte by byte from the published layouts:
 * int16 little-endian, so 350 counts (full scale) = 5e 01 and -175 = 51 ff. Two models:
 * - classic, separate reports (vendor 0x046d, product 0xc626): id 1 translation, id 2 rotation;
 * - compact, combined (vendor 0x256f, product 0xc635): one 12-byte id-1 report.
 */
const CLASSIC = {
  pushRight: [0x5e, 0x01, 0x00, 0x00, 0x00, 0x00], // id 1: x = +350
  pullToward: [0x00, 0x00, 0xaf, 0x00, 0x00, 0x00], // id 1: y = +175
  pullUp: [0x00, 0x00, 0x00, 0x00, 0x51, 0xff], // id 1: z = -175 (up is negative z)
  tiltForward: [0x5e, 0x01, 0x00, 0x00, 0x00, 0x00], // id 2: rx = +350
  twist: [0x00, 0x00, 0x00, 0x00, 0xaf, 0x00], // id 2: rz = +175
  rest: [0, 0, 0, 0, 0, 0],
};
const COMPACT = {
  // x=+350, y=0, z=0, rx=0, ry=-175, rz=+175
  mixed: [0x5e, 0x01, 0, 0, 0, 0, 0, 0, 0x51, 0xff, 0xaf, 0x00],
  rest: new Array(12).fill(0) as number[],
};

const S = DEFAULT_MOTION_SETTINGS;
const approx = (a: readonly number[], b: readonly number[], eps = 1e-9) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, -Math.log10(eps)));

describe('parseReport', () => {
  it('parses a separate translation report (id 1, 6 bytes)', () => {
    expect(parseReport(1, CLASSIC.pushRight)).toEqual({ kind: 'translation', counts: [350, 0, 0] });
    expect(parseReport(1, CLASSIC.pullUp)).toEqual({ kind: 'translation', counts: [0, 0, -175] });
  });
  it('parses a separate rotation report (id 2)', () => {
    expect(parseReport(2, CLASSIC.tiltForward)).toEqual({ kind: 'rotation', counts: [350, 0, 0] });
    expect(parseReport(2, CLASSIC.twist)).toEqual({ kind: 'rotation', counts: [0, 0, 175] });
  });
  it('parses the combined 12-byte id-1 report', () => {
    expect(parseReport(1, COMPACT.mixed)).toEqual({
      kind: 'combined',
      t: [350, 0, 0],
      r: [0, -175, 175],
    });
  });
  it('reads signed int16 limits', () => {
    expect(parseReport(1, [0xff, 0x7f, 0x00, 0x80, 0xff, 0xff])).toEqual({
      kind: 'translation',
      counts: [32767, -32768, -1],
    });
  });
  it('parses the button mask (id 3), up to 32 buttons', () => {
    expect(parseReport(3, [0x05, 0, 0, 0])).toEqual({ kind: 'buttons', mask: 5 });
    expect(parseReport(3, [0x00, 0x80])).toEqual({ kind: 'buttons', mask: 0x8000 });
    expect(parseReport(3, [0, 0, 0, 0x80])).toEqual({ kind: 'buttons', mask: 0x80000000 });
  });
  it('never throws on short, empty or unknown reports', () => {
    expect(parseReport(1, [1, 2, 3])).toEqual({ kind: 'unknown' });
    expect(parseReport(2, [])).toEqual({ kind: 'unknown' });
    expect(parseReport(3, [])).toEqual({ kind: 'unknown' });
    expect(parseReport(9, [1, 2, 3, 4, 5, 6])).toEqual({ kind: 'unknown' });
    expect(parseReport(0, [])).toEqual({ kind: 'unknown' });
  });
});

describe('buttons', () => {
  it('reports 1-based transitions in order', () => {
    expect(buttonChanges(0, 0b101)).toEqual([
      { button: 1, down: true },
      { button: 3, down: true },
    ]);
    expect(buttonChanges(0b101, 0b100)).toEqual([{ button: 1, down: false }]);
    expect(buttonChanges(0b100, 0b100)).toEqual([]);
    expect(buttonChanges(0, 0x80000000)).toEqual([{ button: 32, down: true }]);
  });
  it('lists the pressed buttons', () => {
    expect(pressedButtons(0b1010)).toEqual([2, 4]);
    expect(pressedButtons(0)).toEqual([]);
  });
});

describe('normalisation and axis mapping', () => {
  it('normalises by full scale and clamps to [-1, 1]', () => {
    expect(normalizeCounts([350, -175, 0])).toEqual([1, -0.5, 0]);
    expect(normalizeCounts([700, -700, 1], 350)).toEqual([1, -1, 1 / 350]);
    expect(normalizeCounts([100, 0, 0], 200)).toEqual([0.5, 0, 0]);
    expect(normalizeCounts([100, 0, 0], 0)).toEqual([100 / 350, 0, 0]); // bad scale: default
  });

  // The documented device -> screen mapping (see report.ts).
  const sample = (reports: Array<[number, number[]]>, settings: MotionSettings = S) => {
    const acc = new AxisAccumulator();
    for (const [id, data] of reports) acc.apply(parseReport(id, data));
    return acc.sample({ ...settings, deadZone: 0 }, 0);
  };
  it('push right = +t.x', () => {
    approx(sample([[1, CLASSIC.pushRight]]).t, [1, 0, 0]);
  });
  it('pull up = +t.y', () => {
    approx(sample([[1, CLASSIC.pullUp]]).t, [0, 0.5, 0]);
  });
  it('pull toward the user = +t.z', () => {
    approx(sample([[1, CLASSIC.pullToward]]).t, [0, 0, 0.5]);
  });
  it('tilt forward = +r.x', () => {
    approx(sample([[2, CLASSIC.tiltForward]]).r, [1, 0, 0]);
  });
  it('twist = r.z', () => {
    approx(sample([[2, CLASSIC.twist]]).r, [0, 0, 0.5]);
  });
  it('keeps the other half when only one split report arrives', () => {
    const acc = new AxisAccumulator();
    acc.apply(parseReport(1, CLASSIC.pushRight));
    acc.apply(parseReport(2, CLASSIC.twist));
    const a = acc.sample({ ...S, deadZone: 0 }, 5);
    approx(a.t, [1, 0, 0]);
    approx(a.r, [0, 0, 0.5]);
    expect(a.time).toBe(5);
    acc.apply(parseReport(1, CLASSIC.rest)); // translation released, rotation still held
    const b = acc.sample({ ...S, deadZone: 0 }, 6);
    approx(b.t, [0, 0, 0]);
    approx(b.r, [0, 0, 0.5]);
  });
  it('maps a combined report on a second model', () => {
    const a = sample([[1, COMPACT.mixed]]);
    approx(a.t, [1, 0, 0]);
    approx(a.r, [0, -0.5, 0.5]);
    const z = sample([[1, COMPACT.rest]]);
    expect(z.t).toEqual([0, 0, 0]);
    expect(z.r).toEqual([0, 0, 0]);
  });
  it('deviceToScreen swaps y and z and flips the vertical', () => {
    expect(deviceToScreen({ t: [1, 2, 3], r: [4, 5, 6] })).toEqual({
      t: [1, -3, 2],
      r: [4, 5, 6],
    });
  });
  it('honours a per-model full scale', () => {
    const acc = new AxisAccumulator();
    acc.apply(parseReport(1, CLASSIC.pushRight)); // 350 counts
    expect(acc.sample({ ...S, deadZone: 0 }, 0, 700).t[0]).toBeCloseTo(0.5);
  });
});

describe('conditionAxes', () => {
  const screen = (t: [number, number, number], r: [number, number, number]) => ({ t, r });
  it('zeroes values inside the dead zone and rescales the rest to reach 1', () => {
    const c = conditionAxes(screen([0.03, 0.5, -1], [0, 0, 0.04]), { ...S, deadZone: 0.04 });
    expect(c.t[0]).toBe(0);
    expect(c.r[2]).toBe(0); // exactly on the boundary is still dead
    expect(c.t[1]).toBeCloseTo((0.5 - 0.04) / 0.96);
    expect(c.t[2]).toBeCloseTo(-1);
  });
  it('applies sensitivity and clamps', () => {
    const c = conditionAxes(screen([0.5, 0, 0], [0, 0, 0]), { ...S, deadZone: 0, sensitivity: 4 });
    expect(c.t[0]).toBe(1);
    const h = conditionAxes(screen([0.5, 0, 0], [0, 0, 0]), { ...S, deadZone: 0, sensitivity: 0.5 });
    expect(h.t[0]).toBeCloseTo(0.25);
  });
  it('inverts per axis', () => {
    const c = conditionAxes(screen([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), {
      ...S,
      deadZone: 0,
      invert: { tx: true, ty: false, tz: true, rx: false, ry: true, rz: false },
    });
    expect([...c.t, ...c.r]).toEqual([-0.5, 0.5, -0.5, 0.5, -0.5, 0.5]);
  });
  it('dominant axis lets only the strongest through', () => {
    const c = conditionAxes(screen([0.2, 0.9, 0.3], [0.5, -0.1, 0.4]), {
      ...S,
      deadZone: 0,
      dominant: true,
    });
    expect(c.t).toEqual([0, 0.9, 0]);
    expect(c.r).toEqual([0, 0, 0]);
  });
  it('the rotate and translate switches zero their half', () => {
    const base = screen([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    const noRot = conditionAxes(base, { ...S, deadZone: 0, rotate: false });
    expect(noRot.r).toEqual([0, 0, 0]);
    expect(noRot.t).toEqual([0.5, 0.5, 0.5]);
    const noTr = conditionAxes(base, { ...S, deadZone: 0, translate: false });
    expect(noTr.t).toEqual([0, 0, 0]);
    expect(noTr.r).toEqual([0.5, 0.5, 0.5]);
  });
  it('never returns -0', () => {
    const c = conditionAxes(screen([-0.01, 0, 0], [0, 0, 0]), S);
    expect(Object.is(c.t[0], 0)).toBe(true);
  });
});

describe('device table', () => {
  it('covers both vendor ids with known products and unique keys', () => {
    expect(MOTION_DEVICES.some((d) => d.vendorId === 0x046d)).toBe(true);
    expect(MOTION_DEVICES.some((d) => d.vendorId === 0x256f)).toBe(true);
    const keys = MOTION_DEVICES.map((d) => `${d.vendorId}:${d.productId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(findMotionDevice(0x046d, 0xc626)?.layout).toBe('separate');
    expect(findMotionDevice(0x256f, 0xc635)?.layout).toBe('combined');
    expect(findMotionDevice(0x1234, 0x5678)).toBeUndefined();
  });
  it('filters by multi-axis controller usage and by vendor', () => {
    const f = motionDeviceFilters();
    expect(f).toContainEqual({ usagePage: MOTION_USAGE_PAGE, usage: MOTION_USAGE });
    expect(f.map((x) => x.vendorId).filter(Boolean)).toEqual([0x046d, 0x256f]);
    expect(MOTION_USAGE_PAGE).toBe(0x01);
    expect(MOTION_USAGE).toBe(0x08);
  });
});
