// SPDX-License-Identifier: GPL-3.0-or-later
import type { MeshBuffers, Vec3 } from '@whittle/contracts';

export interface NamedMesh {
  name: string;
  mesh: MeshBuffers;
  /** `#rrggbb` (or `rrggbb` / `#rgb`). */
  color?: string;
}

export interface WeldedMesh {
  /** xyz triplets. */
  vertices: Float64Array;
  /** Triangle vertex indices, degenerate triangles removed. */
  triangles: Uint32Array;
  /** Triangles dropped because two or more corners welded together (or zero area). */
  degenerateRemoved: number;
}

/** Default weld tolerance, mm. */
export const WELD_TOLERANCE = 1e-4;

/**
 * Merge vertices closer than `tolerance` (grid quantisation; MeshBuffers repeats vertices per
 * face) and drop degenerate triangles. First-seen vertex position wins.
 */
export function weldMesh(
  positions: ArrayLike<number>,
  indices: ArrayLike<number> | undefined,
  tolerance = WELD_TOLERANCE,
): WeldedMesh {
  const nVerts = Math.floor(positions.length / 3);
  const nIdx = indices ? indices.length : nVerts;
  const inv = 1 / tolerance;
  const map = new Map<string, number>();
  const remap = new Uint32Array(nVerts);
  const out: number[] = [];
  for (let i = 0; i < nVerts; i++) {
    const x = positions[i * 3] as number;
    const y = positions[i * 3 + 1] as number;
    const z = positions[i * 3 + 2] as number;
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      map.set(key, id);
      out.push(x, y, z);
    }
    remap[i] = id;
  }
  const vertices = Float64Array.from(out);
  const tris: number[] = [];
  let degenerateRemoved = 0;
  for (let t = 0; t + 2 < nIdx; t += 3) {
    const a0 = indices ? (indices[t] as number) : t;
    const b0 = indices ? (indices[t + 1] as number) : t + 1;
    const c0 = indices ? (indices[t + 2] as number) : t + 2;
    if (a0 >= nVerts || b0 >= nVerts || c0 >= nVerts) {
      throw new RangeError(`triangle ${t / 3} references a vertex out of range`);
    }
    const a = remap[a0] as number;
    const b = remap[b0] as number;
    const c = remap[c0] as number;
    if (a === b || b === c || a === c || triArea2(vertices, a, b, c) === 0) {
      degenerateRemoved++;
      continue;
    }
    tris.push(a, b, c);
  }
  return { vertices, triangles: Uint32Array.from(tris), degenerateRemoved };
}

function triArea2(v: Float64Array, a: number, b: number, c: number): number {
  const ux = (v[b * 3] as number) - (v[a * 3] as number);
  const uy = (v[b * 3 + 1] as number) - (v[a * 3 + 1] as number);
  const uz = (v[b * 3 + 2] as number) - (v[a * 3 + 2] as number);
  const wx = (v[c * 3] as number) - (v[a * 3] as number);
  const wy = (v[c * 3 + 1] as number) - (v[a * 3 + 1] as number);
  const wz = (v[c * 3 + 2] as number) - (v[a * 3 + 2] as number);
  const cx = uy * wz - uz * wy;
  const cy = uz * wx - ux * wz;
  const cz = ux * wy - uy * wx;
  return cx * cx + cy * cy + cz * cz;
}

export interface MeshReport {
  vertices: number;
  triangles: number;
  /** Edges used by exactly one triangle (open boundary). */
  boundaryEdges: number;
  /** Edges used by more than two triangles. */
  nonManifoldEdges: number;
  /** Directed edges used more than once: neighbouring triangles with opposite orientation. */
  inconsistentEdges: number;
  /** Triangles that reference out-of-range vertices or repeat a vertex (always 0 after weld). */
  invalidTriangles: number;
  /** Signed volume, mm³. Positive = outward-facing (CCW) winding for a closed mesh. */
  signedVolume: number;
  /** Closed, 2-manifold, consistently wound and outward (signedVolume > 0). */
  valid: boolean;
}

/** Check the 3MF-relevant mesh requirements on an already welded mesh. */
export function checkMesh(vertices: ArrayLike<number>, triangles: ArrayLike<number>): MeshReport {
  const nv = Math.floor(vertices.length / 3);
  const nt = Math.floor(triangles.length / 3);
  const undirected = new Map<number, number>();
  const directed = new Map<number, number>();
  const stride = nv + 1;
  let invalid = 0;
  let vol = 0;
  for (let t = 0; t < nt; t++) {
    const a = triangles[t * 3] as number;
    const b = triangles[t * 3 + 1] as number;
    const c = triangles[t * 3 + 2] as number;
    if (a >= nv || b >= nv || c >= nv || a === b || b === c || a === c) {
      invalid++;
      continue;
    }
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const lo = Math.min(p, q);
      const hi = Math.max(p, q);
      const uk = lo * stride + hi;
      undirected.set(uk, (undirected.get(uk) ?? 0) + 1);
      const dk = p * stride + q;
      directed.set(dk, (directed.get(dk) ?? 0) + 1);
    }
    const ax = vertices[a * 3] as number;
    const ay = vertices[a * 3 + 1] as number;
    const az = vertices[a * 3 + 2] as number;
    const bx = vertices[b * 3] as number;
    const by = vertices[b * 3 + 1] as number;
    const bz = vertices[b * 3 + 2] as number;
    const cx = vertices[c * 3] as number;
    const cy = vertices[c * 3 + 1] as number;
    const cz = vertices[c * 3 + 2] as number;
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  let boundary = 0;
  let nonManifold = 0;
  for (const n of undirected.values()) {
    if (n === 1) boundary++;
    else if (n > 2) nonManifold++;
  }
  let inconsistent = 0;
  for (const n of directed.values()) if (n > 1) inconsistent++;
  return {
    vertices: nv,
    triangles: nt,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    inconsistentEdges: inconsistent,
    invalidTriangles: invalid,
    signedVolume: vol,
    valid:
      nt > 0 &&
      invalid === 0 &&
      boundary === 0 &&
      nonManifold === 0 &&
      inconsistent === 0 &&
      vol > 0,
  };
}

/** Bounding box of xyz triplets. Empty input gives a zero box at the origin. */
export function bboxOf(positions: ArrayLike<number>): { min: Vec3; max: Vec3 } {
  if (positions.length < 3) return { min: [0, 0, 0], max: [0, 0, 0] };
  let minX = Number.POSITIVE_INFINITY;
  let minY = minX;
  let minZ = minX;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = maxX;
  let maxZ = maxX;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i] as number;
    const y = positions[i + 1] as number;
    const z = positions[i + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function unit(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return l > 0 && Number.isFinite(l) ? [x / l, y / l, z / l] : [0, 0, 0];
}

/**
 * Build a reference-body MeshBuffers from a triangle soup (3 corners per triangle, unshared).
 * Single face range, no edges. Flat normals are computed unless `normals` (per corner) is given.
 */
export function meshFromSoup(
  positions: Float32Array,
  name = '',
  normals?: Float32Array,
): MeshBuffers {
  const nTris = Math.floor(positions.length / 9);
  const pos = positions.length === nTris * 9 ? positions : positions.slice(0, nTris * 9);
  const nrm = new Float32Array(nTris * 9);
  const haveNormals = normals !== undefined && normals.length >= nTris * 9;
  for (let t = 0; t < nTris; t++) {
    const o = t * 9;
    if (haveNormals) {
      for (let k = 0; k < 3; k++) {
        const [x, y, z] = unit(
          normals[o + k * 3] as number,
          normals[o + k * 3 + 1] as number,
          normals[o + k * 3 + 2] as number,
        );
        nrm[o + k * 3] = x;
        nrm[o + k * 3 + 1] = y;
        nrm[o + k * 3 + 2] = z;
      }
      if (nrm[o] !== 0 || nrm[o + 1] !== 0 || nrm[o + 2] !== 0) continue;
    }
    const ux = (pos[o + 3] as number) - (pos[o] as number);
    const uy = (pos[o + 4] as number) - (pos[o + 1] as number);
    const uz = (pos[o + 5] as number) - (pos[o + 2] as number);
    const wx = (pos[o + 6] as number) - (pos[o] as number);
    const wy = (pos[o + 7] as number) - (pos[o + 1] as number);
    const wz = (pos[o + 8] as number) - (pos[o + 2] as number);
    const [nx, ny, nz] = unit(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    for (let k = 0; k < 3; k++) {
      nrm[o + k * 3] = nx;
      nrm[o + k * 3 + 1] = ny;
      nrm[o + k * 3 + 2] = nz;
    }
  }
  const indices = new Uint32Array(nTris * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return {
    positions: pos,
    normals: nrm,
    indices,
    faceRanges: new Uint32Array([0, nTris]),
    edgePositions: new Float32Array(0),
    edgeRanges: new Uint32Array(0),
    faceNames: [name],
    edgeNames: [],
    bbox: bboxOf(pos),
  };
}

/** Parse `#rrggbb`, `rrggbb`, `#rgb` (alpha ignored) → [r,g,b] 0..255, or undefined if invalid. */
export function parseColor(color: string | undefined): [number, number, number] | undefined {
  if (!color) return undefined;
  let h = color.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.replace(/./g, (c) => c + c);
  if (/^[0-9a-fA-F]{8}$/.test(h)) h = h.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return undefined;
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

/** Number → short decimal string (8 significant digits); never `-0`. */
export function fmt(n: number): string {
  if (n === 0 || !Number.isFinite(n)) return '0';
  return String(Number(n.toPrecision(8)));
}
