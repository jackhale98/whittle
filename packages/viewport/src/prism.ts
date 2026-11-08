/**
 * Push/pull preview geometry (PLAN §9.2): the selected faces' triangles plus side walls along their
 * boundary edges. The mesh is built once at distance 0; every vertex carries a `lift` weight
 * (0 = stays on the original face, 1 = moves with the cap), and the GPU places it at
 * `position + direction * distance * lift`. Updating the distance is then a uniform write.
 */

import type { MeshBuffers } from '@whittle/contracts';

export interface PrismGeometry {
  /** Vertex positions at distance 0 (cap vertices first, then wall vertices). */
  positions: Float32Array;
  /** 1 for cap vertices and the far side of walls, 0 for the wall vertices on the original face. */
  lift: Float32Array;
  /** Cap triangles (original winding) followed by wall triangles. */
  indices: Uint32Array;
  capTriangles: number;
  wallTriangles: number;
  /** Boundary edges as [a, b] vertex indices into the *source* mesh, in triangle winding order. */
  boundary: Array<[number, number]>;
}

/** Triangle index ranges (first triangle, count) of the requested faces; unknown faces skipped. */
export function faceTriangleRanges(
  faceRanges: Uint32Array,
  faces: readonly number[],
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const f of faces) {
    if (!Number.isInteger(f) || f < 0 || 2 * f + 1 >= faceRanges.length) continue;
    out.push([faceRanges[2 * f] as number, faceRanges[2 * f + 1] as number]);
  }
  return out;
}

/**
 * Boundary edges of a triangle set: undirected edges used by exactly one triangle in the set.
 * Vertices are welded by position (kernel meshes duplicate vertices along face seams), so the
 * seam between two selected, adjacent faces is interior, not boundary. Returned edges keep the
 * source indices and the winding direction of the one triangle that uses them.
 */
export function boundaryEdges(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  ranges: ReadonlyArray<readonly [number, number]>,
  weldEps = 1e-6,
): Array<[number, number]> {
  const weld = new Map<string, number>();
  const weldId = new Map<number, number>();
  const idOf = (v: number): number => {
    let id = weldId.get(v);
    if (id !== undefined) return id;
    const key = `${Math.round((positions[3 * v] as number) / weldEps)},${Math.round(
      (positions[3 * v + 1] as number) / weldEps,
    )},${Math.round((positions[3 * v + 2] as number) / weldEps)}`;
    id = weld.get(key);
    if (id === undefined) {
      id = weld.size;
      weld.set(key, id);
    }
    weldId.set(v, id);
    return id;
  };
  // key = low * 2^26 + high would overflow past 67M welded vertices; faces are far smaller.
  const edgeKey = (a: number, b: number) => (a < b ? a * 67108864 + b : b * 67108864 + a);
  const count = new Map<number, number>();
  const first = new Map<number, [number, number]>();
  for (const [firstTri, nTri] of ranges) {
    for (let t = firstTri; t < firstTri + nTri; t++) {
      const v0 = indices[3 * t] as number;
      const v1 = indices[3 * t + 1] as number;
      const v2 = indices[3 * t + 2] as number;
      const w0 = idOf(v0);
      const w1 = idOf(v1);
      const w2 = idOf(v2);
      const pairs: Array<[number, number, number, number]> = [
        [w0, w1, v0, v1],
        [w1, w2, v1, v2],
        [w2, w0, v2, v0],
      ];
      for (const [a, b, va, vb] of pairs) {
        if (a === b) continue; // degenerate after welding
        const k = edgeKey(a, b);
        count.set(k, (count.get(k) ?? 0) + 1);
        if (!first.has(k)) first.set(k, [va, vb]);
      }
    }
  }
  const out: Array<[number, number]> = [];
  for (const [k, n] of count) if (n === 1) out.push(first.get(k) as [number, number]);
  return out;
}

/** Build the prism for `faces` of `mesh`. Returns null when no valid face has triangles. */
export function buildPrism(mesh: MeshBuffers, faces: readonly number[]): PrismGeometry | null {
  const ranges = faceTriangleRanges(mesh.faceRanges, faces).filter(([, n]) => n > 0);
  if (ranges.length === 0) return null;
  const boundary = boundaryEdges(mesh.positions, mesh.indices, ranges);

  let capTris = 0;
  for (const [, n] of ranges) capTris += n;
  const capVerts = capTris * 3; // unshared: simple, and cheap enough for one-off builds
  const wallVerts = boundary.length * 4;
  const positions = new Float32Array((capVerts + wallVerts) * 3);
  const lift = new Float32Array(capVerts + wallVerts);
  const indices = new Uint32Array(capTris * 3 + boundary.length * 6);

  let v = 0;
  let i = 0;
  for (const [first, n] of ranges) {
    for (let t = first; t < first + n; t++) {
      for (let k = 0; k < 3; k++) {
        const src = mesh.indices[3 * t + k] as number;
        positions[3 * v] = mesh.positions[3 * src] as number;
        positions[3 * v + 1] = mesh.positions[3 * src + 1] as number;
        positions[3 * v + 2] = mesh.positions[3 * src + 2] as number;
        lift[v] = 1;
        indices[i++] = v;
        v++;
      }
    }
  }
  for (const [a, b] of boundary) {
    const base = v;
    // a0, b0 stay on the face; a1, b1 move with the cap.
    for (const [src, l] of [
      [a, 0],
      [b, 0],
      [a, 1],
      [b, 1],
    ] as const) {
      positions[3 * v] = mesh.positions[3 * src] as number;
      positions[3 * v + 1] = mesh.positions[3 * src + 1] as number;
      positions[3 * v + 2] = mesh.positions[3 * src + 2] as number;
      lift[v] = l;
      v++;
    }
    indices[i++] = base;
    indices[i++] = base + 1;
    indices[i++] = base + 3;
    indices[i++] = base;
    indices[i++] = base + 3;
    indices[i++] = base + 2;
  }
  return {
    positions,
    lift,
    indices,
    capTriangles: capTris,
    wallTriangles: boundary.length * 2,
    boundary,
  };
}

/** Position of vertex `i` of a prism at `distance` along unit `direction` (tests, CPU fallback). */
export function liftedPosition(
  prism: PrismGeometry,
  i: number,
  direction: readonly [number, number, number],
  distance: number,
): [number, number, number] {
  const l = (prism.lift[i] as number) * distance;
  return [
    (prism.positions[3 * i] as number) + direction[0] * l,
    (prism.positions[3 * i + 1] as number) + direction[1] * l,
    (prism.positions[3 * i + 2] as number) + direction[2] * l,
  ];
}
