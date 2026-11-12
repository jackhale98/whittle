/**
 * Pure 3D mouse HID report parsing and axis conditioning (no DOM; ADR-096).
 *
 * Report layouts (WebHID hands over the payload without the report id):
 * - id 1, 6 bytes: translation, 3 x int16 little-endian (device x, y, z).
 * - id 2, 6 bytes: rotation, 3 x int16 LE (device rx, ry, rz).
 * - id 1, 12 bytes: both at once (translation then rotation); newer models.
 * - id 3: button bitmask, bit 0 = button 1 (up to 32 buttons, little-endian bytes).
 *
 * Device frame (raw counts): x to the right, y toward the user, z down, so pushing the cap right
 * is +x, pulling it toward you is +y and pushing it down is +z. For rotation the sign convention
 * is "natural": tilting forward, tilting right and twisting clockwise (seen from above) read
 * positive. These signs follow the published layouts and are on the owner's real-device
 * checklist; a model that differs is corrected with the per-axis invert settings.
 *
 * Screen axes (`MotionSample`): x right, y up, z toward the viewer.
 *   t.x = device x            push right        -> +t.x
 *   t.y = -device z           pull up           -> +t.y (push down is -t.y)
 *   t.z = device y            pull toward you   -> +t.z (push away is -t.z)
 *   r.x = device rx           tilt forward      -> +r.x
 *   r.y = device ry           tilt right        -> +r.y
 *   r.z = device rz           twist clockwise   -> +r.z
 */

import type { MotionSample, MotionSettings, Vec3 } from '@wren-cad/contracts';
import { DEFAULT_FULL_SCALE } from './devices';

export type ParsedReport =
  | { kind: 'translation'; counts: Vec3 }
  | { kind: 'rotation'; counts: Vec3 }
  | { kind: 'combined'; t: Vec3; r: Vec3 }
  | { kind: 'buttons'; mask: number }
  | { kind: 'unknown' };

const i16 = (b: ArrayLike<number>, o: number): number => {
  const v = ((b[o] as number) & 0xff) | (((b[o + 1] as number) & 0xff) << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
};

/** Parse one input report. `data` excludes the report id. Never throws; bad input is `unknown`. */
export function parseReport(reportId: number, data: ArrayLike<number>): ParsedReport {
  const n = data.length;
  if (reportId === 1) {
    if (n >= 12) {
      return {
        kind: 'combined',
        t: [i16(data, 0), i16(data, 2), i16(data, 4)],
        r: [i16(data, 6), i16(data, 8), i16(data, 10)],
      };
    }
    if (n >= 6) return { kind: 'translation', counts: [i16(data, 0), i16(data, 2), i16(data, 4)] };
  } else if (reportId === 2) {
    if (n >= 6) return { kind: 'rotation', counts: [i16(data, 0), i16(data, 2), i16(data, 4)] };
  } else if (reportId === 3 && n >= 1) {
    let mask = 0;
    for (let i = 0; i < Math.min(n, 4); i++) mask |= ((data[i] as number) & 0xff) << (8 * i);
    return { kind: 'buttons', mask: mask >>> 0 };
  }
  return { kind: 'unknown' };
}

/** Button transitions between two masks: 1-based button numbers, ascending. */
export function buttonChanges(
  prev: number,
  next: number,
): Array<{ button: number; down: boolean }> {
  const out: Array<{ button: number; down: boolean }> = [];
  const diff = (prev ^ next) >>> 0;
  for (let i = 0; i < 32; i++) {
    if ((diff >>> i) & 1) out.push({ button: i + 1, down: ((next >>> i) & 1) === 1 });
  }
  return out;
}

/** Pressed buttons (1-based, ascending) of a mask. */
export function pressedButtons(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) if ((mask >>> i) & 1) out.push(i + 1);
  return out;
}

/** Device axes in counts (or normalised): translation then rotation, in the device frame. */
export interface RawAxes {
  t: Vec3;
  r: Vec3;
}

const clamp1 = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);

/** Counts to [-1, 1] by full scale. */
export function normalizeCounts(counts: Vec3, fullScale = DEFAULT_FULL_SCALE): Vec3 {
  const s = fullScale > 0 ? fullScale : DEFAULT_FULL_SCALE;
  return [clamp1(counts[0] / s), clamp1(counts[1] / s), clamp1(counts[2] / s)];
}

/** Device frame to screen axes (see the table above). */
export function deviceToScreen(a: RawAxes): { t: Vec3; r: Vec3 } {
  return {
    // `+ 0` turns -0 into 0 so a resting device compares equal to zero.
    t: [a.t[0], -a.t[2] + 0, a.t[1]],
    r: [a.r[0], a.r[1], a.r[2]],
  };
}

/**
 * Conditioning on normalised screen axes: dead zone (rescaled so the output still reaches 1),
 * dominant axis, rotate/translate switches, per-axis inversion, sensitivity, clamp to [-1, 1].
 */
export function conditionAxes(
  screen: { t: Vec3; r: Vec3 },
  s: MotionSettings,
): { t: Vec3; r: Vec3 } {
  const dz = Math.min(Math.max(s.deadZone, 0), 0.95);
  const v = [...screen.t, ...screen.r].map((x) => {
    const a = Math.abs(x);
    if (a <= dz) return 0;
    return Math.sign(x) * ((a - dz) / (1 - dz));
  });
  if (s.dominant) {
    let best = -1;
    let bestAbs = 0;
    for (let i = 0; i < 6; i++) {
      const a = Math.abs(v[i] as number);
      if (a > bestAbs) {
        bestAbs = a;
        best = i;
      }
    }
    for (let i = 0; i < 6; i++) if (i !== best) v[i] = 0;
  }
  const inv = [s.invert.tx, s.invert.ty, s.invert.tz, s.invert.rx, s.invert.ry, s.invert.rz];
  const gain = Number.isFinite(s.sensitivity) ? s.sensitivity : 1;
  const out = v.map((x, i) => {
    const off = i < 3 ? !s.translate : !s.rotate;
    if (off) return 0;
    return clamp1((inv[i] ? -x : x) * gain) + 0;
  });
  return {
    t: [out[0] as number, out[1] as number, out[2] as number],
    r: [out[3] as number, out[4] as number, out[5] as number],
  };
}

/** Accumulates split translation and rotation reports into one device state. */
export class AxisAccumulator {
  private t: Vec3 = [0, 0, 0];
  private r: Vec3 = [0, 0, 0];

  /** Applies a motion report; returns false for reports that carry no motion (buttons...). */
  apply(rep: ParsedReport): boolean {
    switch (rep.kind) {
      case 'translation':
        this.t = rep.counts;
        return true;
      case 'rotation':
        this.r = rep.counts;
        return true;
      case 'combined':
        this.t = rep.t;
        this.r = rep.r;
        return true;
      default:
        return false;
    }
  }

  reset(): void {
    this.t = [0, 0, 0];
    this.r = [0, 0, 0];
  }

  sample(settings: MotionSettings, time: number, fullScale = DEFAULT_FULL_SCALE): MotionSample {
    const screen = deviceToScreen({
      t: normalizeCounts(this.t, fullScale),
      r: normalizeCounts(this.r, fullScale),
    });
    const c = conditionAxes(screen, settings);
    return { t: c.t, r: c.r, time };
  }
}
