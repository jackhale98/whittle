/**
 * Pure helpers for `ImportFeature` regeneration: attachment hashing, rigid placement frames (as a
 * 3×4 matrix, applied to B-rep files by rewriting their BREP location table and to meshes
 * directly), the persistent-name translation for imported topology and geometric ordering keys.
 *
 * Why BREP rewriting: the kernel façade has no "transform shape" call yet (see README, kernel
 * gaps). A BREP file's root shape carries an index into its `Locations` table, so appending one
 * elementary location and pointing the root at it places the whole file exactly (no re-meshing,
 * no geometry approximation).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Frame, MeshBuffers, NamingMap, Vec3 } from '@whittle/contracts';
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

/**
 * Places a BREP text (as written by `BRepTools::Write`, any version) by `m`: appends an
 * elementary location to the `Locations` table and makes the root shape use it (composed with the
 * root's own location when it has one). Null when the text does not look like a BREP file.
 */
export function placeBrep(brep: string, m: Matrix34): string | null {
  const head = /(^|\n)Locations (\d+)\r?\n/.exec(brep);
  if (!head) return null;
  const count = Number(head[2]);
  const next = brep.indexOf('\nCurve2ds', head.index + head[0].length - 1);
  // The root shape is the last line: <orientation><tshape index> <location index>.
  const root = /([+\-ie])(\d+) (\d+)\s*$/.exec(brep);
  if (next < 0 || !root || root.index < next) return null;
  const f = (v: number) => (Object.is(v, -0) ? '0' : String(v));
  const rows = [0, 4, 8].map((r) => [0, 1, 2, 3].map((c) => f(m[r + c] as number)).join(' '));
  const placement = count + 1;
  let entries = `1\n${rows.join('\n')}\n`;
  let rootLocation = placement;
  const own = Number(root[3]);
  if (own !== 0) {
    // Composite (type 2) entries are read as L = Lk^pk · … · L1^p1: own location first, then ours.
    entries += `2  ${own} 1 ${placement} 1 0\n`;
    rootLocation = placement + 1;
  }
  const added = rootLocation - count;
  const before = brep.slice(0, head.index + (head[1] ?? '').length);
  const table = brep.slice(head.index + head[0].length, next + 1);
  const rest = brep.slice(next + 1, root.index);
  return `${before}Locations ${count + added}\n${table}${entries}${rest}${root[1]}${root[2]} ${rootLocation}\n`;
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

/**
 * Feature id the engine passes to the kernel for the operation that names an import's topology.
 * The kernel's last-resort fallback for faces without history is `F<tag>:unnamed`, so with this
 * tag every imported face comes out as `F<id>:face:unnamed#k` (k by the kernel's geometric key)
 * and edges/vertices are derived from those face names by the kernel itself.
 */
export const importNamingTag = (featureId: string): string => `${featureId}:face`;

const IMPORT_FALLBACK = /:face:unnamed/g;

/**
 * Kernel name → document name: `F<id>:face:unnamed` → `F<id>:face` (naming.ts / ImportFeature:
 * imported faces are `F<id>:face#k`). Stateless and injective: feature ids are alphanumeric, so
 * `:face:unnamed` only ever comes from {@link importNamingTag}. Identity for every other name.
 */
export function translateName(name: string): string {
  return name.includes(':face:unnamed') ? name.replace(IMPORT_FALLBACK, ':face') : name;
}

export function translateNaming(naming: NamingMap): NamingMap {
  return naming.some((n) => n.name.includes(':face:unnamed'))
    ? naming.map((n) => ({ ...n, name: translateName(n.name) }))
    : naming;
}

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

/**
 * TS-side names for topology the kernel could not name: faces `F<id>:face#k` ordered by the
 * geometric key of their centroids (no `#k` for a single face). Edges/vertices get no names.
 */
export function faceNamesByKey(featureId: string, centroids: Vec3[]): NamingMap {
  const base = `F${featureId}:face`;
  if (centroids.length === 1) return [{ name: base, kind: 'face', index: 0 }];
  const order = centroids
    .map((c, i) => ({ c, i }))
    .sort((a, b) => compareGeoKey(a.c, b.c) || a.i - b.i);
  return order.map((o, k) => ({ name: `${base}#${k}`, kind: 'face' as const, index: o.i }));
}
