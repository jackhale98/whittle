/**
 * Pure helpers for ID-buffer picking and topology bookkeeping. No three.js dependency, so they
 * are unit-testable in Node.
 *
 * Face ids are 24-bit (`globalFaceIndex + 1`, 0 = background) packed into RGB. Edges and vertices
 * are not drawn into the ID buffer; they are picked by screen-space distance (see pick.ts).
 */

import type { Vec3 } from '@wren-cad/contracts';

/** Largest encodable id (24 bit). */
export const MAX_ID = 0xffffff;
export const NO_FACE = 0xffffffff;

export function encodeId(id: number): [number, number, number] {
  return [(id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff];
}

export function decodeId(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

/**
 * Read the id at pixel (px, py) of an RGBA8 readback `data` of size w x h. `py` counts from the
 * top of the image. WebGL readbacks start at the bottom row (`flipY` = true); WebGPU readbacks
 * start at the top row.
 */
export function idAtPixel(
  data: ArrayLike<number>,
  w: number,
  h: number,
  px: number,
  py: number,
  flipY: boolean,
): number {
  const x = Math.min(w - 1, Math.max(0, Math.floor(px)));
  const yTop = Math.min(h - 1, Math.max(0, Math.floor(py)));
  const row = flipY ? h - 1 - yTop : yTop;
  const o = (row * w + x) * 4;
  return decodeId(data[o] as number, data[o + 1] as number, data[o + 2] as number);
}

export interface FaceIdLayout {
  /** Index buffer to render with: the input array itself when no vertex is shared across faces. */
  indices: Uint32Array;
  /** For appended (duplicated) vertices: the source vertex they copy. Empty when nothing shared. */
  appended: Uint32Array;
  /** Face ordinal per vertex (original vertices first, then appended); NO_FACE if unreferenced. */
  faceOfVertex: Uint32Array;
}

/**
 * Assign every vertex to exactly one face so a per-vertex colour can carry the face id. Kernel
 * meshes normally have per-face vertices; if any vertex is shared between faces it is duplicated
 * for the later faces (indices are copied only in that case).
 */
export function faceIdPerVertex(
  vertexCount: number,
  indices: Uint32Array,
  faceRanges: Uint32Array,
): FaceIdLayout {
  const faceOf = new Uint32Array(vertexCount).fill(NO_FACE);
  let out = indices;
  const appendedSrc: number[] = [];
  const appendedFace: number[] = [];
  const faceCount = Math.floor(faceRanges.length / 2);
  const triTotal = Math.floor(indices.length / 3);
  for (let f = 0; f < faceCount; f++) {
    const first = faceRanges[2 * f] as number;
    const end = Math.min(triTotal, first + (faceRanges[2 * f + 1] as number));
    let dup: Map<number, number> | null = null;
    for (let t = first; t < end; t++) {
      for (let k = 0; k < 3; k++) {
        const slot = 3 * t + k;
        const v = out[slot] as number;
        const cur = faceOf[v] as number;
        if (cur === NO_FACE) {
          faceOf[v] = f;
        } else if (cur !== f) {
          if (out === indices) out = indices.slice();
          dup ??= new Map();
          let nv = dup.get(v);
          if (nv === undefined) {
            nv = vertexCount + appendedSrc.length;
            appendedSrc.push(v);
            appendedFace.push(f);
            dup.set(v, nv);
          }
          out[slot] = nv;
        }
      }
    }
  }
  const all = new Uint32Array(vertexCount + appendedSrc.length);
  all.set(faceOf);
  for (let i = 0; i < appendedFace.length; i++) all[vertexCount + i] = appendedFace[i] as number;
  return { indices: out, appended: Uint32Array.from(appendedSrc), faceOfVertex: all };
}

/** Triangle -> face ordinal lookup (NO_FACE for triangles outside every range). */
export function triangleToFace(faceRanges: Uint32Array, triangleCount: number): Uint32Array {
  const out = new Uint32Array(triangleCount).fill(NO_FACE);
  const n = Math.floor(faceRanges.length / 2);
  for (let f = 0; f < n; f++) {
    const first = faceRanges[2 * f] as number;
    const end = Math.min(triangleCount, first + (faceRanges[2 * f + 1] as number));
    for (let t = first; t < end; t++) out[t] = f;
  }
  return out;
}

/** Index-buffer draw range (in indices, not triangles) of one face, for highlight overlays. */
export function faceDrawRange(
  faceRanges: Uint32Array,
  ordinal: number,
  triangleCount: number,
): { start: number; count: number } | null {
  if (ordinal < 0 || 2 * ordinal + 1 >= faceRanges.length) return null;
  const first = faceRanges[2 * ordinal] as number;
  const end = Math.min(triangleCount, first + (faceRanges[2 * ordinal + 1] as number));
  if (end <= first) return null;
  return { start: first * 3, count: (end - first) * 3 };
}

/**
 * B-rep vertices are not part of `MeshBuffers`, so they are derived: the distinct endpoints of
 * the edge polylines, numbered in order of first appearance. (Contract proposal: ship
 * `vertexPositions` from the kernel so ordinals match TopExp.)
 */
export function deriveVertices(
  edgePositions: Float32Array,
  edgeRanges: Uint32Array,
  bbox: { min: Vec3; max: Vec3 },
): Float32Array {
  const diag = Math.hypot(
    bbox.max[0] - bbox.min[0],
    bbox.max[1] - bbox.min[1],
    bbox.max[2] - bbox.min[2],
  );
  const eps = Math.max(diag * 1e-6, 1e-6);
  const seen = new Set<string>();
  const out: number[] = [];
  const pointCount = Math.floor(edgePositions.length / 3);
  const add = (p: number) => {
    const x = edgePositions[3 * p] as number;
    const y = edgePositions[3 * p + 1] as number;
    const z = edgePositions[3 * p + 2] as number;
    const key = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(x, y, z);
    }
  };
  for (let e = 0; e < Math.floor(edgeRanges.length / 2); e++) {
    const first = edgeRanges[2 * e] as number;
    const count = Math.min(edgeRanges[2 * e + 1] as number, pointCount - first);
    if (count < 1) continue;
    add(first);
    add(first + count - 1);
  }
  return Float32Array.from(out);
}

/**
 * `PickHit.entity` / `HighlightItem.entity` of reference geometry (ADR-093). The hit bodyId is the
 * persistent name (F<id>:plane, F<id>:axis, F<id>:point, origin:XY, origin:X, ...) and its kind is
 * face / edge / vertex, so the app maps it to an EntityRef without asking the kernel.
 */
export const REFERENCE_ENTITY = 'reference';
