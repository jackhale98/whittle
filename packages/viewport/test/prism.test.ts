import type { MeshBuffers } from '@whittle/contracts';
import { boxMesh, denseMesh } from '@whittle/test-fixtures';
import { describe, expect, it } from 'vitest';
import { boundaryEdges, buildPrism, faceTriangleRanges, liftedPosition } from '../src/prism';
import { isClipped, keptRayRange, sectionEq, threePlane } from '../src/section';

const faceIndex = (mesh: MeshBuffers, name: string) => mesh.faceNames.indexOf(name);

describe('boundary edges', () => {
  it('a single box face has its 4 outline edges as boundary', () => {
    const mesh = boxMesh(40, 30, 20);
    const f = faceIndex(mesh, 'face.zmax');
    const edges = boundaryEdges(
      mesh.positions,
      mesh.indices,
      faceTriangleRanges(mesh.faceRanges, [f]),
    );
    expect(edges).toHaveLength(4); // the shared diagonal is used twice -> interior
  });

  it('boundary vertices lie on the face outline', () => {
    const mesh = boxMesh(40, 30, 20);
    const f = faceIndex(mesh, 'face.zmax');
    const edges = boundaryEdges(
      mesh.positions,
      mesh.indices,
      faceTriangleRanges(mesh.faceRanges, [f]),
    );
    for (const [a, b] of edges) {
      for (const v of [a, b]) {
        expect(mesh.positions[3 * v + 2]).toBe(20);
        const x = mesh.positions[3 * v] as number;
        const y = mesh.positions[3 * v + 1] as number;
        expect(x === 0 || x === 40 || y === 0 || y === 30).toBe(true);
      }
    }
  });

  it('edges between two selected faces are interior (welded by position, not by index)', () => {
    const mesh = boxMesh(40, 30, 20);
    const faces = [faceIndex(mesh, 'face.zmax'), faceIndex(mesh, 'face.xmax')];
    const edges = boundaryEdges(
      mesh.positions,
      mesh.indices,
      faceTriangleRanges(mesh.faceRanges, faces),
    );
    // two quads sharing one edge: 4 + 4 - 2 = 6 boundary edges
    expect(edges).toHaveLength(6);
  });

  it('all six faces of a closed box have no boundary at all', () => {
    const mesh = boxMesh(10, 10, 10);
    const all = [0, 1, 2, 3, 4, 5];
    expect(
      boundaryEdges(mesh.positions, mesh.indices, faceTriangleRanges(mesh.faceRanges, all)),
    ).toEqual([]);
  });

  it('a lone triangle fan from a dense sphere patch has a closed ring boundary', () => {
    const mesh = denseMesh(2000, 20);
    const edges = boundaryEdges(mesh.positions, mesh.indices, [[0, 40]]);
    expect(edges.length).toBeGreaterThan(3);
  });

  it('ignores unknown faces', () => {
    const mesh = boxMesh(1, 1, 1);
    expect(faceTriangleRanges(mesh.faceRanges, [-1, 99, 1.5])).toEqual([]);
    expect(buildPrism(mesh, [99])).toBeNull();
  });
});

describe('prism building', () => {
  const mesh = boxMesh(40, 30, 20);
  const top = faceIndex(mesh, 'face.zmax');

  it('has the face triangles as a cap plus two wall triangles per boundary edge', () => {
    const p = buildPrism(mesh, [top]);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.capTriangles).toBe(2);
    expect(p.boundary).toHaveLength(4);
    expect(p.wallTriangles).toBe(8);
    expect(p.indices.length).toBe((2 + 8) * 3);
    expect(p.positions.length).toBe((6 + 16) * 3);
    expect(p.lift.length).toBe(22);
    for (const i of p.indices) expect(i).toBeLessThan(22);
  });

  it('at distance d the cap is translated by direction*d and walls span from face to cap', () => {
    const p = buildPrism(mesh, [top]);
    if (!p) throw new Error('prism');
    const dir = [0, 0, 1] as const;
    const d = 15;
    for (let i = 0; i < p.lift.length; i++) {
      const [, , z] = liftedPosition(p, i, dir, d);
      expect(z).toBeCloseTo(20 + (p.lift[i] as number) * d, 5);
    }
    // 6 cap vertices all lifted, walls: half lifted.
    const lifted = [...p.lift].filter((l) => l === 1).length;
    expect(lifted).toBe(6 + 8);
    // negative distance previews a cut: the cap goes inside the body
    const [, , zIn] = liftedPosition(p, 0, dir, -5);
    expect(zIn).toBeCloseTo(15, 5);
  });

  it('builds once; distance only changes the lift product (positions untouched)', () => {
    const p = buildPrism(mesh, [top]);
    if (!p) throw new Error('prism');
    const before = Float32Array.from(p.positions);
    liftedPosition(p, 3, [0, 0, 1], 99);
    expect([...p.positions]).toEqual([...before]);
  });

  it('merges adjacent selected faces into one prism outline', () => {
    const p = buildPrism(mesh, [top, faceIndex(mesh, 'face.xmax')]);
    expect(p?.capTriangles).toBe(4);
    expect(p?.boundary).toHaveLength(6);
  });

  it('wall triangles reference only wall vertices', () => {
    const p = buildPrism(mesh, [top]);
    if (!p) throw new Error('prism');
    const capVerts = p.capTriangles * 3;
    for (let i = p.capTriangles * 3; i < p.indices.length; i++) {
      expect(p.indices[i] as number).toBeGreaterThanOrEqual(capVerts);
    }
  });
});

describe('section maths', () => {
  const eq = sectionEq({ origin: [20, 0, 0], normal: [2, 0, 0] });

  it('normalises and clips the +normal side', () => {
    expect(eq?.n).toEqual([1, 0, 0]);
    expect(isClipped(eq, [25, 0, 0])).toBe(true);
    expect(isClipped(eq, [15, 0, 0])).toBe(false);
    expect(isClipped(null, [1e9, 0, 0])).toBe(false);
  });

  it('rejects a zero normal', () => {
    expect(sectionEq({ origin: [0, 0, 0], normal: [0, 0, 0] })).toBeNull();
  });

  it('expresses the plane for three.js (negative distance = clipped)', () => {
    if (!eq) throw new Error('eq');
    const tp = threePlane(eq);
    const dist = (p: number[]) =>
      tp.normal[0] * (p[0] as number) +
      tp.normal[1] * (p[1] as number) +
      tp.normal[2] * (p[2] as number) +
      tp.constant;
    expect(dist([25, 0, 0])).toBeLessThan(0);
    expect(dist([15, 0, 0])).toBeGreaterThan(0);
  });

  it('restricts rays to the surviving part', () => {
    // ray along +x from x=0: kept until the plane at t=20
    expect(keptRayRange(eq, [0, 0, 0], [1, 0, 0])).toEqual([0, 20]);
    // ray along -x from x=40: starts clipped, kept for t >= 20
    expect(keptRayRange(eq, [40, 0, 0], [-1, 0, 0])).toEqual([20, Number.POSITIVE_INFINITY]);
    // starting on the clipped side moving away: nothing survives
    expect(keptRayRange(eq, [40, 0, 0], [1, 0, 0])).toBeNull();
    // parallel to the plane
    expect(keptRayRange(eq, [0, 5, 0], [0, 1, 0])).toEqual([0, Number.POSITIVE_INFINITY]);
    expect(keptRayRange(eq, [30, 5, 0], [0, 1, 0])).toBeNull();
    // maxT caps both ends
    expect(keptRayRange(eq, [0, 0, 0], [1, 0, 0], 10)).toEqual([0, 10]);
    expect(keptRayRange(eq, [40, 0, 0], [-1, 0, 0], 10)).toBeNull();
    expect(keptRayRange(null, [0, 0, 0], [1, 0, 0], 7)).toEqual([0, 7]);
  });
});
