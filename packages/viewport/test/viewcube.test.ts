import { describe, expect, it } from 'vitest';
import { CUBE_FACES, type CubeBasis, cubeHitTest, zoneDirection, zoneOf } from '../src/viewcube';
import type { Vec3 } from '../src/views';

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Camera basis for a camera at direction `dir` from the target, world +Z up. */
function basisFor(dir: Vec3): CubeBasis {
  const back = norm(dir);
  const horizontal = Math.abs(back[2]) > 0.9999;
  const right = norm(cross(horizontal ? [0, 1, 0] : [0, 0, 1], back));
  const up = cross(back, right);
  return { right, up, back };
}

const close = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;

describe('view cube hit testing', () => {
  it('front view: centre is the front face (camera at -Y)', () => {
    const hit = cubeHitTest(basisFor([0, -1, 0]), 0, 0);
    expect(hit?.kind).toBe('face');
    expect(hit?.view).toBe('front');
    expect(close(hit?.dir ?? [0, 0, 0], [0, -1, 0])).toBe(true);
  });

  it('every standard view is reachable from its own direction', () => {
    for (const f of CUBE_FACES) {
      const hit = cubeHitTest(basisFor(f.n), 0, 0);
      expect(hit?.view, f.name).toBe(f.name);
    }
  });

  it('edges: a band at the right of the front face selects front+right', () => {
    const basis = basisFor([0, -1, 0]);
    const hit = cubeHitTest(basis, 0.9, 0);
    expect(hit?.kind).toBe('edge');
    const s = Math.SQRT1_2;
    expect(close(hit?.dir ?? [0, 0, 0], [s, -s, 0])).toBe(true);
    expect(hit?.view).toBeNull();
  });

  it('corners: the top-right corner of the front face selects the (+x,-y,+z) corner', () => {
    const hit = cubeHitTest(basisFor([0, -1, 0]), 0.9, 0.9);
    expect(hit?.kind).toBe('corner');
    const s = 1 / Math.sqrt(3);
    expect(close(hit?.dir ?? [0, 0, 0], [s, -s, s])).toBe(true);
  });

  it('outside the cube is not a hit; back faces are never hit', () => {
    expect(cubeHitTest(basisFor([0, -1, 0]), 1.5, 0)).toBeNull();
    const hit = cubeHitTest(basisFor([1, -1, 1]), 0, 0);
    expect(hit && hit.dir[0] * 1 + hit.dir[1] * -1 + hit.dir[2] > 0).toBe(true);
  });

  it('iso view: the cube centre shows the shared corner', () => {
    const hit = cubeHitTest(basisFor([1, -1, 1]), 0, 0);
    expect(hit?.kind).toBe('corner');
    const s = 1 / Math.sqrt(3);
    expect(close(hit?.dir ?? [0, 0, 0], [s, -s, s])).toBe(true);
  });

  it('adjacent faces agree on the direction of their shared edge band', () => {
    const front = CUBE_FACES.find((f) => f.name === 'front');
    const right = CUBE_FACES.find((f) => f.name === 'right');
    if (!front || !right) throw new Error('faces');
    // front's +x band (za=+1) and right's -y band (za=-1: right.r = +y so -y is za=-1).
    const a = zoneDirection(front, 1, 0).dir;
    const b = zoneDirection(right, -1, 0).dir;
    expect(close(a, b)).toBe(true);
  });

  it('zones split each axis into thirds-ish bands', () => {
    expect(zoneOf(-0.9)).toBe(-1);
    expect(zoneOf(0)).toBe(0);
    expect(zoneOf(0.9)).toBe(1);
  });
});
