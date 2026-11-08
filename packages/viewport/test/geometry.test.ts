import { boxMesh } from '@whittle/test-fixtures';
import { describe, expect, it } from 'vitest';
import { edgesToSegments, meshBuffersToGeometry } from '../src/geometry';

describe('meshBuffersToGeometry', () => {
  const mesh = boxMesh(40, 30, 20);
  const geo = meshBuffersToGeometry(mesh);

  it('shares the kernel buffers without copying', () => {
    expect(geo.getAttribute('position').array).toBe(mesh.positions);
    expect(geo.getAttribute('normal').array).toBe(mesh.normals);
    expect(geo.getIndex()?.array).toBe(mesh.indices);
    expect(geo.getIndex()?.count).toBe(36);
  });

  it('uses the kernel bbox for bounds and keeps face ranges for picking', () => {
    expect(geo.boundingSphere?.center.toArray()).toEqual([20, 15, 10]);
    expect(geo.boundingSphere?.radius).toBeCloseTo(Math.hypot(40, 30, 20) / 2, 5);
    expect(geo.userData.faces.faceRanges).toBe(mesh.faceRanges);
    expect(geo.userData.faces.faceNames).toEqual(mesh.faceNames);
  });
});

describe('edgesToSegments', () => {
  it('turns each 2-point box edge into one segment', () => {
    const mesh = boxMesh(1, 2, 3);
    const seg = edgesToSegments(mesh.edgePositions, mesh.edgeRanges);
    expect(seg.length).toBe(12 * 6);
    expect(Array.from(seg)).toEqual(Array.from(mesh.edgePositions));
  });

  it('expands an n-point polyline into n-1 consecutive segment pairs', () => {
    const pts = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1]);
    const seg = edgesToSegments(pts, new Uint32Array([0, 4]));
    expect(Array.from(seg)).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1]);
  });

  it('handles several polylines, skips degenerate ones and clamps overruns', () => {
    const pts = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 5, 5, 5]);
    // polyline A: points 0-1; B: single point (skipped); C: claims 10 points from point 2 -> clamped to 2.
    const seg = edgesToSegments(pts, new Uint32Array([0, 2, 2, 1, 2, 10]));
    expect(Array.from(seg)).toEqual([0, 0, 0, 1, 0, 0, 2, 0, 0, 5, 5, 5]);
  });

  it('returns an empty array for no edges', () => {
    expect(edgesToSegments(new Float32Array(0), new Uint32Array(0)).length).toBe(0);
  });
});
