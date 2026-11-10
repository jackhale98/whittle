import type { Vec3 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  rotateAbout,
  SECTION_AXIS_SNAP_DEG,
  type SectionSettings,
  sectionFrame,
  sectionGeometry,
  sectionPlane,
  sectionRange,
  snapTilts,
  tiltAxes,
  tiltedNormal,
  tiltsForNormal,
} from './section';

const D = Math.PI / 180;
const bounds = { min: [0, 0, 0] as Vec3, max: [20, 10, 4] as Vec3 }; // centre (10, 5, 2)
const base: SectionSettings = {
  enabled: true,
  axis: 'z',
  offset: 2,
  flipped: false,
  face: null,
};
const close = (a: readonly number[], b: readonly number[], digits = 9) => {
  expect(a).toHaveLength(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i] as number, digits));
};

describe('section frame', () => {
  it('is right-handed for every axis (u × v = n0)', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const f = sectionFrame({ axis, face: null });
      expect(f).not.toBeNull();
      if (!f) continue;
      const c: Vec3 = [
        f.u[1] * f.v[2] - f.u[2] * f.v[1],
        f.u[2] * f.v[0] - f.u[0] * f.v[2],
        f.u[0] * f.v[1] - f.u[1] * f.v[0],
      ];
      close(c, f.n0);
    }
  });
  it('a face frame is orthonormal around the face normal', () => {
    const f = sectionFrame({ axis: 'face', face: { origin: [0, 0, 0], normal: [0, 3, 4] } });
    if (!f) throw new Error('no frame');
    close(f.n0, [0, 0.6, 0.8]);
    expect(f.u[0] * f.n0[0] + f.u[1] * f.n0[1] + f.u[2] * f.n0[2]).toBeCloseTo(0, 9);
    expect(Math.hypot(...f.u)).toBeCloseTo(1, 9);
    expect(sectionFrame({ axis: 'face', face: null })).toBeNull();
  });
});

describe('tilted normal', () => {
  const f = sectionFrame({ axis: 'z', face: null }) as NonNullable<ReturnType<typeof sectionFrame>>;
  it('zero tilt is the base normal', () => {
    close(tiltedNormal(f, 0, 0), [0, 0, 1]);
  });
  it('tilting about u = X by 90 degrees turns +Z to -Y; about v = Y by 90 degrees to +X', () => {
    close(tiltedNormal(f, 90 * D, 0), [0, -1, 0]);
    close(tiltedNormal(f, 0, 90 * D), [1, 0, 0]);
  });
  it('matches the closed form (sin b, -cos b sin a, cos b cos a) in frame coordinates', () => {
    const a = 25 * D;
    const b = -40 * D;
    close(tiltedNormal(f, a, b), [
      Math.sin(b),
      -Math.cos(b) * Math.sin(a),
      Math.cos(b) * Math.cos(a),
    ]);
  });
  it('tiltsForNormal inverts it over the sphere', () => {
    for (const [a, b] of [
      [0, 0],
      [20, 30],
      [-120, 45],
      [170, -60],
      [90, 10],
    ] as const) {
      const n = tiltedNormal(f, a * D, b * D);
      const t = tiltsForNormal(f, n);
      close(tiltedNormal(f, t.tiltU, t.tiltV), n);
    }
  });
  it('the second axis follows the first tilt (it stays in the plane)', () => {
    const a = 35 * D;
    const b = 20 * D;
    const n = tiltedNormal(f, a, b);
    const ax = tiltAxes(f, a);
    expect(ax.v[0] * n[0] + ax.v[1] * n[1] + ax.v[2] * n[2]).toBeCloseTo(0, 9);
    close(rotateAbout(ax.v, n, 0), ax.v);
  });
});

describe('section plane with tilt, offset and flip', () => {
  it('at zero tilt an axis plane is the old "z = offset" plane, now through the part centre', () => {
    const p = sectionPlane(base, bounds);
    close(p?.origin ?? [], [10, 5, 2]);
    close(p?.normal ?? [], [0, 0, 1]);
    expect(p?.caps).toBe(true);
    close(sectionPlane({ ...base, offset: 3.5 }, bounds)?.origin ?? [], [10, 5, 3.5]);
  });
  it('a tilted plane pivots about the centre and the offset moves along the tilted normal', () => {
    const t = { ...base, tiltU: 30 * D, offset: 2 };
    const n = tiltedNormal(
      sectionFrame(t) as NonNullable<ReturnType<typeof sectionFrame>>,
      30 * D,
      0,
    );
    const p0 = sectionPlane(t, bounds);
    close(p0?.origin ?? [], [10, 5, 2]); // offset == centre: through the centre
    const p1 = sectionPlane({ ...t, offset: 4 }, bounds);
    close(p1?.origin ?? [], [10 + n[0] * 2, 5 + n[1] * 2, 2 + n[2] * 2]);
    close(p1?.normal ?? [], n);
  });
  it('flip reverses the normal and keeps the origin', () => {
    const t = { ...base, tiltU: 20 * D, tiltV: 10 * D };
    const a = sectionPlane(t, bounds);
    const b = sectionPlane({ ...t, flipped: true }, bounds);
    close(b?.origin ?? [], a?.origin ?? []);
    close(
      b?.normal ?? [],
      (a?.normal ?? [0, 0, 0]).map((x) => -x),
    );
  });
  it('face base: tilts and offsets start at the face centroid, along the tilted normal', () => {
    const face = { origin: [4, 5, 6] as Vec3, normal: [0, 0, 1] as Vec3 };
    const s: SectionSettings = {
      ...base,
      axis: 'face',
      face,
      offset: -2,
      tiltU: 0,
      tiltV: 0,
    };
    close(sectionPlane(s, bounds)?.origin ?? [], [4, 5, 4]);
    const tilted = { ...s, tiltV: 45 * D };
    const g = sectionGeometry(tilted, bounds);
    close(g?.normal ?? [], [Math.SQRT1_2, 0, Math.SQRT1_2]);
    close(g?.origin ?? [], [4 - 2 * Math.SQRT1_2, 5, 6 - 2 * Math.SQRT1_2]);
    expect(sectionPlane({ ...s, face: null }, bounds)).toBeNull();
    expect(sectionPlane({ ...s, enabled: false }, bounds)).toBeNull();
  });
  it('the slider range follows the tilted normal and keeps the old extents at zero tilt', () => {
    expect(sectionRange(base, bounds)).toEqual({ min: 0, max: 4 });
    expect(sectionRange({ ...base, axis: 'x' }, bounds)).toEqual({ min: 0, max: 20 });
    const r = sectionRange({ ...base, tiltV: 90 * D }, bounds); // normal along +X: extent 20
    expect(r.max - r.min).toBeCloseTo(20, 9);
    expect(r.min + (r.max - r.min) / 2).toBeCloseTo(2, 9); // centred on the centre (offset 2 = c0)
    expect(sectionRange(base, null)).toEqual({ min: -50, max: 50 });
  });
});

describe('snapping', () => {
  const f = sectionFrame({ axis: 'z', face: null }) as NonNullable<ReturnType<typeof sectionFrame>>;
  it('snaps onto an X/Y/Z plane within about 3 degrees, not beyond', () => {
    const near = snapTilts(f, 2 * D, -1.5 * D, false);
    expect(near.to).toBe('axis');
    close(tiltedNormal(f, near.tiltU, near.tiltV), [0, 0, 1]);
    const far = snapTilts(f, (SECTION_AXIS_SNAP_DEG + 2) * D, 0, false);
    expect(far.to).toBeNull();
    expect(far.tiltU).toBeCloseTo((SECTION_AXIS_SNAP_DEG + 2) * D, 12);
  });
  it('snaps onto another world plane (about 90 degrees of tilt) and its opposite side', () => {
    const s = snapTilts(f, 88 * D, 0, false);
    expect(s.to).toBe('axis');
    close(tiltedNormal(f, s.tiltU, s.tiltV), [0, -1, 0]);
    const o = snapTilts(f, 178.5 * D, 1 * D, false);
    close(tiltedNormal(f, o.tiltU, o.tiltV), [0, 0, -1]);
  });
  it('a face base snaps to world planes too', () => {
    const ff = sectionFrame({
      axis: 'face',
      face: { origin: [0, 0, 0], normal: [0, Math.SQRT1_2, Math.SQRT1_2] },
    }) as NonNullable<ReturnType<typeof sectionFrame>>;
    const tilt = tiltsForNormal(ff, [0, 1, 0.03]);
    const s = snapTilts(ff, tilt.tiltU, tilt.tiltV, false);
    expect(s.to).toBe('axis');
    close(tiltedNormal(ff, s.tiltU, s.tiltV), [0, 1, 0]);
  });
  it('Shift or a held finger snaps both angles to 15 degree steps', () => {
    const s = snapTilts(f, 37 * D, -52 * D, true);
    expect(s.to).toBe('step');
    expect(s.tiltU / D).toBeCloseTo(30, 9);
    expect(s.tiltV / D).toBeCloseTo(-45, 9);
    expect(snapTilts(f, 8 * D, 0, true).tiltU / D).toBeCloseTo(15, 9);
  });
});
