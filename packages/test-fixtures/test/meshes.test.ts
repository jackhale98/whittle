import type { MeshBuffers } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { boxMesh, denseMesh } from '../src/meshes';

/** Structural invariants every MeshBuffers must satisfy (see kernel.ts). */
function checkInvariants(m: MeshBuffers) {
  const vertexCount = m.positions.length / 3;
  expect(Number.isInteger(vertexCount)).toBe(true);
  expect(m.normals.length).toBe(m.positions.length);
  expect(m.indices.length % 3).toBe(0);
  for (const i of m.indices) expect(i).toBeLessThan(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const len = Math.hypot(m.normals[v * 3]!, m.normals[v * 3 + 1]!, m.normals[v * 3 + 2]!);
    expect(len).toBeCloseTo(1, 4);
  }
  // Face ranges tile the triangle list contiguously.
  const triCount = m.indices.length / 3;
  let next = 0;
  for (let f = 0; f < m.faceRanges.length / 2; f++) {
    expect(m.faceRanges[2 * f]).toBe(next);
    next += m.faceRanges[2 * f + 1]!;
  }
  expect(next).toBe(triCount);
  expect(m.faceNames.length).toBe(m.faceRanges.length / 2);
  // Edge ranges tile the point list.
  const pointCount = m.edgePositions.length / 3;
  let nextPt = 0;
  for (let e = 0; e < m.edgeRanges.length / 2; e++) {
    expect(m.edgeRanges[2 * e]).toBe(nextPt);
    nextPt += m.edgeRanges[2 * e + 1]!;
  }
  expect(nextPt).toBe(pointCount);
  expect(m.edgeNames.length).toBe(m.edgeRanges.length / 2);
  // bbox contains all vertices.
  for (let v = 0; v < vertexCount; v++) {
    for (let k = 0; k < 3; k++) {
      const x = m.positions[v * 3 + k]!;
      expect(x).toBeGreaterThanOrEqual(m.bbox.min[k]! - 1e-4);
      expect(x).toBeLessThanOrEqual(m.bbox.max[k]! + 1e-4);
    }
  }
}

function signedVolume(m: MeshBuffers): number {
  let vol = 0;
  for (let t = 0; t < m.indices.length / 3; t++) {
    const p = (k: number) => {
      const i = m.indices[3 * t + k]!;
      return [m.positions[3 * i]!, m.positions[3 * i + 1]!, m.positions[3 * i + 2]!] as const;
    };
    const [a, b, c] = [p(0), p(1), p(2)];
    vol +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return vol;
}

describe('boxMesh', () => {
  const m = boxMesh(40, 30, 20);

  it('has box topology: 24 vertices, 12 triangles, 6 faces, 12 edges', () => {
    expect(m.positions.length / 3).toBe(24);
    expect(m.indices.length / 3).toBe(12);
    expect(m.faceRanges.length / 2).toBe(6);
    expect(m.edgeRanges.length / 2).toBe(12);
    checkInvariants(m);
  });

  it('names faces and edges by primitive roles, edge roles sorted', () => {
    expect([...m.faceNames].sort()).toEqual([
      'face.xmax',
      'face.xmin',
      'face.ymax',
      'face.ymin',
      'face.zmax',
      'face.zmin',
    ]);
    expect(new Set(m.edgeNames).size).toBe(12);
    for (const n of m.edgeNames) {
      const mm = /^edge\((face\.[xyz](?:min|max))\|(face\.[xyz](?:min|max))\)$/.exec(n);
      expect(mm, n).not.toBeNull();
      expect(mm![1]! < mm![2]!).toBe(true);
    }
  });

  it('winds outward: positive signed volume equal to the box volume', () => {
    expect(signedVolume(m)).toBeCloseTo(40 * 30 * 20, 3);
  });

  it('every triangle normal agrees with its vertex normals', () => {
    for (let t = 0; t < m.indices.length / 3; t++) {
      const [a, b, c] = [m.indices[3 * t]!, m.indices[3 * t + 1]!, m.indices[3 * t + 2]!];
      const p = (i: number) => [
        m.positions[3 * i]!,
        m.positions[3 * i + 1]!,
        m.positions[3 * i + 2]!,
      ];
      const [pa, pb, pc] = [p(a), p(b), p(c)] as [number[], number[], number[]];
      const u = pb.map((v, k) => v - pa[k]!);
      const w = pc.map((v, k) => v - pa[k]!);
      const n = [
        u[1]! * w[2]! - u[2]! * w[1]!,
        u[2]! * w[0]! - u[0]! * w[2]!,
        u[0]! * w[1]! - u[1]! * w[0]!,
      ];
      const vn = [m.normals[3 * a]!, m.normals[3 * a + 1]!, m.normals[3 * a + 2]!];
      expect(n[0]! * vn[0]! + n[1]! * vn[1]! + n[2]! * vn[2]!).toBeGreaterThan(0);
    }
  });

  it('edges run along bbox edges; origin and feature tag are honoured', () => {
    const t = boxMesh(1, 2, 3, { origin: [10, 20, 30], featureTag: 'F01J' });
    expect(t.bbox).toEqual({ min: [10, 20, 30], max: [11, 22, 33] });
    expect(t.faceNames[0]).toBe('F01J:face.xmin');
    expect(t.edgeNames[0]).toMatch(/^F01J:edge\(/);
    checkInvariants(t);
    let total = 0;
    for (let e = 0; e < 12; e++) {
      const i = t.edgeRanges[2 * e]! * 3;
      total += Math.hypot(
        t.edgePositions[i + 3]! - t.edgePositions[i]!,
        t.edgePositions[i + 4]! - t.edgePositions[i + 1]!,
        t.edgePositions[i + 5]! - t.edgePositions[i + 2]!,
      );
    }
    expect(total).toBeCloseTo(4 * (1 + 2 + 3), 4);
  });
});

// The 1M-triangle case takes seconds on a loaded runner: explicit timeouts, not the 5 s default.
describe('denseMesh', () => {
  it.each([1_000, 50_000, 1_000_000])('approximates %i triangles', { timeout: 30_000 }, (n) => {
    const m = denseMesh(n);
    const tris = m.indices.length / 3;
    expect(tris).toBeGreaterThan(n * 0.95);
    expect(tris).toBeLessThan(n * 1.05);
    expect(m.faceRanges[1]).toBe(tris);
    expect(m.normals.length).toBe(m.positions.length);
  });

  it('is structurally valid and encloses roughly a sphere volume', { timeout: 30_000 }, () => {
    const m = denseMesh(20_000, 10);
    checkInvariants(m);
    expect(signedVolume(m)).toBeGreaterThan(0.98 * ((4 / 3) * Math.PI * 1000));
  });
});
