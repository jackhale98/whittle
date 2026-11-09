/**
 * Pure helpers for `ImportFeature` regeneration: attachment hashing, rigid placement frames (as a
 * 3×4 matrix: validated here, passed to the kernel's `import` feature as an orthonormal frame for
 * B-rep files, applied to meshes directly), weak-name detection and geometric ordering keys.
 *
 * B-rep placement and naming happen in the kernel (`execImport`, ADR-039 item 11). The M1 BREP
 * location rewrite (`placeBrep`) and the `F<id>:face:unnamed` name translation went with it.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Frame, MeshBuffers, Vec3 } from '@wren-cad/contracts';
import { cross, dot, norm, normalize, scale, sub } from './geometry';

/** Lower-case hex SHA-256 of `bytes` (WebCrypto: available in workers and Node ≥ 18). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Row-major 3×4 rigid transform [R | t]: world = R·p + t. */
export type Matrix34 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * The rigid transform of a placement frame (local → world): columns X, Y = Z × X, Z and the
 * origin. `x` is orthogonalised against `z`. Null when the frame is degenerate (zero or parallel
 * axes, non-finite numbers).
 */
export function frameMatrix(frame: Frame): Matrix34 | null {
  const all = [...frame.origin, ...frame.z, ...frame.x];
  if (!all.every(Number.isFinite)) return null;
  if (norm(frame.z) < 1e-12) return null;
  const z = normalize(frame.z);
  const xr = sub(frame.x, scale(z, dot(frame.x, z)));
  if (norm(xr) < 1e-9 * Math.max(1, norm(frame.x))) return null;
  const x = normalize(xr);
  const y = cross(z, x);
  const o = frame.origin;
  return [x[0], y[0], z[0], o[0], x[1], y[1], z[1], o[1], x[2], y[2], z[2], o[2]];
}

export function isIdentity(m: Matrix34): boolean {
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  return m.every((v, i) => Math.abs(v - (id[i] as number)) < 1e-15);
}

export function applyPoint(m: Matrix34, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

function applyVector(m: Matrix34, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
  ];
}

/** A mesh moved by `m` (positions, normals, edge polylines, vertices, bbox). */
export function placeMesh(mesh: MeshBuffers, m: Matrix34): MeshBuffers {
  const mapPoints = (src: Float32Array, vectors: boolean): Float32Array => {
    const out = new Float32Array(src.length);
    for (let i = 0; i + 2 < src.length; i += 3) {
      const p: Vec3 = [src[i] as number, src[i + 1] as number, src[i + 2] as number];
      const q = vectors ? applyVector(m, p) : applyPoint(m, p);
      out[i] = q[0];
      out[i + 1] = q[1];
      out[i + 2] = q[2];
    }
    return out;
  };
  const positions = mapPoints(mesh.positions, false);
  const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k] as number;
      if (v < (min[k] as number)) min[k] = v;
      if (v > (max[k] as number)) max[k] = v;
    }
  }
  const out: MeshBuffers = {
    positions,
    normals: mapPoints(mesh.normals, true),
    indices: mesh.indices.slice(),
    faceRanges: mesh.faceRanges.slice(),
    edgePositions: mapPoints(mesh.edgePositions, false),
    edgeRanges: mesh.edgeRanges.slice(),
    faceNames: [...mesh.faceNames],
    edgeNames: [...mesh.edgeNames],
    bbox: positions.length > 0 ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] },
  };
  if (mesh.vertexPositions) out.vertexPositions = mapPoints(mesh.vertexPositions, false);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------------------------

/** Does `name` contain imported topology of one of `importIds` (`F<id>:face…`)? */
export function mentionsImport(name: string, importIds: ReadonlySet<string>): boolean {
  if (importIds.size === 0) return false;
  for (const id of importIds) if (name.includes(`F${id}:face`)) return true;
  return false;
}

/** Deterministic geometric key (naming.ts): x, then y, then z, rounded to 1e-6 mm. */
export function compareGeoKey(a: Vec3, b: Vec3): number {
  for (let k = 0; k < 3; k++) {
    const d = Math.round((a[k] as number) * 1e6) - Math.round((b[k] as number) * 1e6);
    if (d !== 0) return d;
  }
  return 0;
}
