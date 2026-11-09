/**
 * MeshBuffers -> three.js conversion helpers. Only core three classes are used here so the
 * module is testable in Node.
 */

import type { MeshBuffers } from '@wren-cad/contracts';
import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';

export interface FaceRangeInfo {
  /** [firstTriangle, triangleCount] pairs, one per B-rep face (as in MeshBuffers). */
  faceRanges: Uint32Array;
  faceNames: string[];
}

/**
 * Build an indexed BufferGeometry sharing the kernel's typed arrays (no copy). Per-face ranges are
 * kept in `geometry.userData.faces` for the future ID-buffer picking pass (M1); bounds come from
 * the kernel bbox so no O(n) scan is needed for 1M-triangle meshes.
 */
export function meshBuffersToGeometry(mesh: MeshBuffers): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));

  const { min, max } = mesh.bbox;
  const center = new Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
  geometry.boundingSphere = new Sphere(center, radius);

  const faces: FaceRangeInfo = { faceRanges: mesh.faceRanges, faceNames: mesh.faceNames };
  geometry.userData.faces = faces;
  return geometry;
}

/**
 * Convert edge polylines (`edgePositions` + `edgeRanges`) into independent segment pairs
 * (x0 y0 z0 x1 y1 z1 per segment), as expected by LineSegmentsGeometry. Ranges that run past the
 * end of `edgePositions` are clamped; polylines with fewer than two points are skipped.
 */
export function edgesToSegments(
  edgePositions: Float32Array,
  edgeRanges: Uint32Array,
): Float32Array {
  const pointCount = Math.floor(edgePositions.length / 3);
  const rangeCount = Math.floor(edgeRanges.length / 2);

  let segments = 0;
  const spans: Array<[number, number]> = [];
  for (let e = 0; e < rangeCount; e++) {
    const first = edgeRanges[2 * e] as number;
    const count = Math.min(edgeRanges[2 * e + 1] as number, Math.max(0, pointCount - first));
    if (count >= 2) {
      spans.push([first, count]);
      segments += count - 1;
    }
  }

  const out = new Float32Array(segments * 6);
  let o = 0;
  for (const [first, count] of spans) {
    for (let i = 0; i < count - 1; i++) {
      const a = (first + i) * 3;
      out[o++] = edgePositions[a] as number;
      out[o++] = edgePositions[a + 1] as number;
      out[o++] = edgePositions[a + 2] as number;
      out[o++] = edgePositions[a + 3] as number;
      out[o++] = edgePositions[a + 4] as number;
      out[o++] = edgePositions[a + 5] as number;
    }
  }
  return out;
}
