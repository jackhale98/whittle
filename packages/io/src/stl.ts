// SPDX-License-Identifier: GPL-3.0-or-later
import type { MeshBuffers, Vec3 } from '@wren-cad/contracts';
import { checkSize, checkTriangles, type ImportLimits, IoError, resolveLimits } from './errors';
import { meshFromSoup, WELD_TOLERANCE } from './mesh';

export interface StlBody {
  name?: string;
  mesh: MeshBuffers;
}

/**
 * Serialise mesh-only bodies to STL. Binary (default) concatenates all bodies into one solid;
 * ASCII writes one `solid` per body. Facet normals are recomputed from the triangle winding.
 */
export function meshToStl(bodies: StlBody[], options: { binary?: boolean } = {}): Uint8Array {
  const binary = options.binary ?? true;
  let nTris = 0;
  for (const b of bodies) nTris += Math.floor(b.mesh.indices.length / 3);
  if (binary) {
    const out = new Uint8Array(84 + nTris * 50);
    const dv = new DataView(out.buffer);
    out.set(new TextEncoder().encode('Wren binary STL'.padEnd(80, ' ')), 0);
    dv.setUint32(80, nTris, true);
    let o = 84;
    for (const b of bodies) {
      forEachTriangle(b.mesh, (n, p) => {
        for (let i = 0; i < 3; i++) dv.setFloat32(o + i * 4, n[i] as number, true);
        for (let v = 0; v < 3; v++) {
          for (let i = 0; i < 3; i++)
            dv.setFloat32(o + 12 + v * 12 + i * 4, p[v * 3 + i] as number, true);
        }
        o += 50;
      });
    }
    return out;
  }
  const lines: string[] = [];
  bodies.forEach((b, i) => {
    const name = (b.name || `body${i + 1}`).replace(/[\r\n]/g, ' ');
    lines.push(`solid ${name}`);
    forEachTriangle(b.mesh, (n, p) => {
      lines.push(`  facet normal ${n[0]} ${n[1]} ${n[2]}`, '    outer loop');
      for (let v = 0; v < 3; v++) {
        lines.push(`      vertex ${p[v * 3]} ${p[v * 3 + 1]} ${p[v * 3 + 2]}`);
      }
      lines.push('    endloop', '  endfacet');
    });
    lines.push(`endsolid ${name}`);
  });
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

function forEachTriangle(mesh: MeshBuffers, cb: (normal: number[], pts: number[]) => void): void {
  const { positions, indices } = mesh;
  const nv = positions.length / 3;
  const p = new Array<number>(9);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let v = 0; v < 3; v++) {
      const i = indices[t + v] as number;
      if (i >= nv) throw new IoError('malformed', 'Mesh references a missing vertex');
      p[v * 3] = positions[i * 3] as number;
      p[v * 3 + 1] = positions[i * 3 + 1] as number;
      p[v * 3 + 2] = positions[i * 3 + 2] as number;
    }
    const ux = (p[3] as number) - (p[0] as number);
    const uy = (p[4] as number) - (p[1] as number);
    const uz = (p[5] as number) - (p[2] as number);
    const wx = (p[6] as number) - (p[0] as number);
    const wy = (p[7] as number) - (p[1] as number);
    const wz = (p[8] as number) - (p[2] as number);
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) {
      nx /= l;
      ny /= l;
      nz /= l;
    }
    cb([nx, ny, nz], p);
  }
}

// --- parsing -------------------------------------------------------------------------------

/** True when `bytes` is exactly a binary STL (size matches the header's triangle count). */
function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 84) return false;
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  return 84 + n * 50 === bytes.byteLength;
}

/** Parse STL (binary/ASCII auto-detected) to an unshared triangle soup: 9 floats per triangle. */
export function parseStl(bytes: Uint8Array, limits?: Partial<ImportLimits>): Float32Array {
  const lim = resolveLimits(limits);
  checkSize(bytes, lim, 'STL file');
  if (looksBinary(bytes)) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(80, true);
    checkTriangles(n, lim, 'STL file');
    const out = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) {
      const base = 84 + t * 50 + 12;
      for (let k = 0; k < 9; k++) out[t * 9 + k] = dv.getFloat32(base + k * 4, true);
    }
    return finite(out);
  }
  // ASCII: must start (after whitespace) with "solid".
  const head = new TextDecoder()
    .decode(bytes.subarray(0, Math.min(bytes.byteLength, 512)))
    .trimStart();
  if (!/^solid/i.test(head)) {
    throw new IoError(
      'malformed',
      bytes.byteLength >= 84
        ? 'Not a valid STL file: the binary size does not match its triangle count and it is not ASCII.'
        : 'Not a valid STL file: too short.',
    );
  }
  const text = new TextDecoder().decode(bytes);
  const re = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g;
  const verts: number[] = [];
  const maxCorners = lim.maxTriangles * 3;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    verts.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (verts.length / 3 > maxCorners) checkTriangles(verts.length / 9, lim, 'STL file');
  }
  if (verts.length % 9 !== 0) {
    throw new IoError('malformed', 'ASCII STL has a facet without exactly three vertices.');
  }
  return finite(Float32Array.from(verts));
}

function finite(a: Float32Array): Float32Array {
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]))
      throw new IoError('malformed', 'STL contains a non-numeric coordinate.');
  }
  return a;
}

/** STL to a reference body (single face range, flat normals, no edges). */
export function importStl(
  bytes: Uint8Array,
  options: { name?: string; limits?: Partial<ImportLimits> } = {},
): { name: string; mesh: MeshBuffers }[] {
  const soup = parseStl(bytes, options.limits);
  if (soup.length === 0) throw new IoError('empty', 'The STL file contains no triangles.');
  const name = options.name ?? 'STL body';
  return [{ name, mesh: meshFromSoup(soup, name) }];
}

// --- analysis ------------------------------------------------------------------------------

export interface StlAnalysis {
  /** Non-degenerate triangles analysed. */
  triangles: number;
  /** Every edge shared by exactly two triangles after welding (and at least one triangle). */
  watertight: boolean;
  /** Signed tetra-sum volume, mm³ (positive for outward CCW winding). */
  volume: number;
  bbox: { min: Vec3; max: Vec3 };
  boundaryEdges: number;
  nonManifoldEdges: number;
}

/** Verify an STL export: triangle count, watertightness, signed volume and bounding box. */
export function analyzeStl(
  bytes: Uint8Array,
  options: { tolerance?: number; limits?: Partial<ImportLimits> } = {},
): StlAnalysis {
  const soup = parseStl(bytes, options.limits);
  const inv = 1 / (options.tolerance ?? WELD_TOLERANCE);
  const ids = new Map<string, number>();
  const verts: number[] = [];
  const nCorners = soup.length / 3;
  const remap = new Uint32Array(nCorners);
  for (let i = 0; i < nCorners; i++) {
    const x = soup[i * 3] as number;
    const y = soup[i * 3 + 1] as number;
    const z = soup[i * 3 + 2] as number;
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      ids.set(key, id);
      verts.push(x, y, z);
    }
    remap[i] = id;
  }
  const edges = new Map<number, number>();
  const stride = verts.length / 3 + 1;
  let volume = 0;
  let count = 0;
  for (let t = 0; t + 2 < nCorners; t += 3) {
    const a = remap[t] as number;
    const b = remap[t + 1] as number;
    const c = remap[t + 2] as number;
    if (a === b || b === c || a === c) continue;
    count++;
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = Math.min(p, q) * stride + Math.max(p, q);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    const ax = verts[a * 3] as number;
    const ay = verts[a * 3 + 1] as number;
    const az = verts[a * 3 + 2] as number;
    const bx = verts[b * 3] as number;
    const by = verts[b * 3 + 1] as number;
    const bz = verts[b * 3 + 2] as number;
    const cx = verts[c * 3] as number;
    const cy = verts[c * 3 + 1] as number;
    const cz = verts[c * 3 + 2] as number;
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  let boundary = 0;
  let nonManifold = 0;
  for (const n of edges.values()) {
    if (n === 1) boundary++;
    else if (n !== 2) nonManifold++;
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = verts[i + a] as number;
      if (v < (min[a] as number)) min[a] = v;
      if (v > (max[a] as number)) max[a] = v;
    }
  }
  if (verts.length === 0) {
    min.fill(0);
    max.fill(0);
  }
  return {
    triangles: count,
    watertight: count > 0 && boundary === 0 && nonManifold === 0,
    volume,
    bbox: { min, max },
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
  };
}
