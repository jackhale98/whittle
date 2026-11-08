import type { MeshBuffers } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import {
  distanceExpr,
  dragDistance,
  faceInfo,
  groupByNormal,
  type SectionSettings,
  sectionPlane,
  sectionRange,
  snapDistance,
  unionBounds,
} from './faces';

/** Face 0: a 10 × 20 square at z = 5 facing +Z; face 1: a bent pair (not planar). */
function mesh(): MeshBuffers {
  const positions = new Float32Array([
    // face 0 (two triangles, CCW seen from +Z)
    0, 0, 5, 10, 0, 5, 10, 20, 5, 0, 20, 5,
    // face 1: one triangle facing +X, one facing +Y
    0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0,
  ]);
  return {
    positions,
    normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 7, 8, 9]),
    faceRanges: new Uint32Array([0, 2, 2, 2]),
    edgePositions: new Float32Array(),
    edgeRanges: new Uint32Array(),
    faceNames: ['top', 'bent'],
    edgeNames: [],
    bbox: { min: [0, 0, 0], max: [10, 20, 5] },
  };
}

describe('face geometry from meshes', () => {
  it('finds the centroid, normal, area and flatness of a face', () => {
    const f = faceInfo(mesh(), 0);
    expect(f?.planar).toBe(true);
    expect(f?.area).toBeCloseTo(200);
    expect(f?.centroid[0]).toBeCloseTo(5);
    expect(f?.centroid[1]).toBeCloseTo(10);
    expect(f?.centroid[2]).toBeCloseTo(5);
    expect(f?.normal).toEqual([0, 0, 1]);
    expect(f?.radius).toBeCloseTo(Math.hypot(10, 20) / 2);
  });
  it('a bent face is not planar; a missing face is null', () => {
    expect(faceInfo(mesh(), 1)?.planar).toBe(false);
    expect(faceInfo(mesh(), 7)).toBeNull();
  });
  it('groups faces by normal (one prism preview per direction)', () => {
    expect(
      groupByNormal([
        { index: 0, normal: [0, 0, 1] },
        { index: 3, normal: [1, 0, 0] },
        { index: 4, normal: [0, 0, 1] },
      ]),
    ).toEqual([
      { normal: [0, 0, 1], faces: [0, 4] },
      { normal: [1, 0, 0], faces: [3] },
    ]);
  });
});

describe('push/pull drag', () => {
  it('projects the pointer delta onto the screen image of the normal', () => {
    // 10 mm along the normal shows as 100 px straight up the screen.
    const axis = { x: 0, y: -100 };
    expect(dragDistance({ dx: 0, dy: -50 }, axis, 10)).toBeCloseTo(5);
    expect(dragDistance({ dx: 30, dy: 20 }, axis, 10)).toBeCloseTo(-2); // sideways is ignored
    expect(dragDistance({ dx: 0, dy: -50 }, { x: 0.5, y: 0.5 }, 10)).toBeNull(); // end-on
  });
  it('snaps drags to 0.1 mm and writes ASCII expressions', () => {
    expect(snapDistance(12.345)).toBe(12.3);
    expect(distanceExpr(-3)).toBe('-3 mm');
    expect(distanceExpr(-0)).toBe('0 mm');
    expect(distanceExpr(1 / 3)).toBe('0.333 mm');
  });
});

describe('section planes', () => {
  const bounds = unionBounds([
    { min: [0, 0, 0], max: [10, 20, 5] },
    { min: [-5, 2, 1], max: [3, 4, 30] },
  ]);
  const base: SectionSettings = {
    enabled: true,
    axis: 'z',
    offset: 12,
    flipped: false,
    face: null,
  };
  it('the slider spans the part along the axis', () => {
    expect(bounds).toEqual({ min: [-5, 0, 0], max: [10, 20, 30] });
    expect(sectionRange(base, bounds)).toEqual({ min: 0, max: 30 });
    expect(sectionRange({ ...base, axis: 'x' }, bounds)).toEqual({ min: -5, max: 10 });
    expect(sectionRange(base, null)).toEqual({ min: -50, max: 50 });
    expect(unionBounds([])).toBeNull();
  });
  it('axis planes: origin at the offset, flip reverses the clipped side, caps on', () => {
    expect(sectionPlane(base)).toEqual({ origin: [0, 0, 12], normal: [0, 0, 1], caps: true });
    expect(sectionPlane({ ...base, flipped: true })?.normal).toEqual([-0, -0, -1]);
    expect(sectionPlane({ ...base, enabled: false })).toBeNull();
  });
  it('face planes: measured from the face along its normal', () => {
    const face = {
      origin: [0, 0, 5] as [number, number, number],
      normal: [0, 0, 1] as [number, number, number],
    };
    const s = { ...base, axis: 'face' as const, face, offset: -2 };
    expect(sectionPlane(s)?.origin).toEqual([0, 0, 3]);
    expect(sectionRange(s, bounds)).toEqual({ min: -5, max: 25 });
    expect(sectionPlane({ ...s, face: null })).toBeNull();
  });
});
