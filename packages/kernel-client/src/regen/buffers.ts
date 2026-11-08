/**
 * Mesh buffer utilities: copies for transfer (cached meshes stay intact in the worker), region
 * sub-meshes of a sketch shape, and collecting transferables from results.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { MeshBuffers, NamingMap, RegenResult, Vec3 } from '@whittle/contracts';

/** A deep copy whose typed arrays own fresh ArrayBuffers (safe to transfer). */
export function copyMesh(m: MeshBuffers): MeshBuffers {
  const out: MeshBuffers = {
    positions: m.positions.slice(),
    normals: m.normals.slice(),
    indices: m.indices.slice(),
    faceRanges: m.faceRanges.slice(),
    edgePositions: m.edgePositions.slice(),
    edgeRanges: m.edgeRanges.slice(),
    faceNames: [...m.faceNames],
    edgeNames: [...m.edgeNames],
    bbox: { min: [...m.bbox.min] as Vec3, max: [...m.bbox.max] as Vec3 },
  };
  if (m.vertexPositions) out.vertexPositions = m.vertexPositions.slice();
  return out;
}

/** Bytes held by a mesh's typed arrays. */
export function meshBytes(m: MeshBuffers): number {
  return (
    m.positions.byteLength +
    m.normals.byteLength +
    m.indices.byteLength +
    m.faceRanges.byteLength +
    m.edgePositions.byteLength +
    m.edgeRanges.byteLength +
    (m.vertexPositions?.byteLength ?? 0)
  );
}

/** The triangles of one B-rep face as a stand-alone mesh (re-indexed, no edges). */
export function faceSubMesh(m: MeshBuffers, face: number, name: string): MeshBuffers {
  const first = m.faceRanges[2 * face] ?? 0;
  const count = m.faceRanges[2 * face + 1] ?? 0;
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const normals: number[] = [];
  const indices = new Uint32Array(count * 3);
  const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const src = m.indices[3 * (first + t) + k] as number;
      let dst = remap.get(src);
      if (dst === undefined) {
        dst = positions.length / 3;
        remap.set(src, dst);
        for (let a = 0; a < 3; a++) {
          const p = m.positions[3 * src + a] as number;
          positions.push(p);
          normals.push(m.normals[3 * src + a] as number);
          if (p < (min[a] as number)) min[a] = p;
          if (p > (max[a] as number)) max[a] = p;
        }
      }
      indices[3 * t + k] = dst;
    }
  }
  if (positions.length === 0) {
    min.fill(0);
    max.fill(0);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices,
    faceRanges: new Uint32Array([0, count]),
    edgePositions: new Float32Array(0),
    edgeRanges: new Uint32Array(0),
    faceNames: [name],
    edgeNames: [],
    bbox: { min, max },
  };
}

/** Face index of a named face in a naming map, or -1. */
export function faceIndex(naming: NamingMap, name: string): number {
  return naming.find((n) => n.kind === 'face' && n.name === name)?.index ?? -1;
}

function meshTransferables(m: MeshBuffers, out: ArrayBuffer[]): void {
  for (const a of [
    m.positions,
    m.normals,
    m.indices,
    m.faceRanges,
    m.edgePositions,
    m.edgeRanges,
    m.vertexPositions,
  ]) {
    if (a && a.buffer instanceof ArrayBuffer && !out.includes(a.buffer)) out.push(a.buffer);
  }
}

/** Every ArrayBuffer in a regen result (all freshly allocated copies, safe to transfer). */
export function regenTransferables(r: RegenResult & { ghosts?: { mesh: MeshBuffers }[] }) {
  const out: ArrayBuffer[] = [];
  for (const b of r.bodies) meshTransferables(b.mesh, out);
  for (const g of r.ghosts ?? []) meshTransferables(g.mesh, out);
  for (const s of r.sketches) {
    for (const c of s.curves) {
      if (c.points.buffer instanceof ArrayBuffer && !out.includes(c.points.buffer)) {
        out.push(c.points.buffer);
      }
    }
    for (const reg of s.regions) meshTransferables(reg.mesh, out);
  }
  return out;
}

export function meshListTransferables(meshes: MeshBuffers[]): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const m of meshes) meshTransferables(m, out);
  return out;
}
