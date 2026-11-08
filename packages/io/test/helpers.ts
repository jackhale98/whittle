// SPDX-License-Identifier: GPL-3.0-or-later
import type { MeshBuffers } from '@whittle/contracts';

/** Box with per-face duplicated vertices (24 verts, 12 tris), outward CCW winding, like regen output. */
export function boxMesh(w: number, d: number, h: number, ox = 0, oy = 0, oz = 0): MeshBuffers {
  // [normal, 4 corners CCW seen from outside]
  const x0 = ox;
  const x1 = ox + w;
  const y0 = oy;
  const y1 = oy + d;
  const z0 = oz;
  const z1 = oz + h;
  const faces: [number[], number[][]][] = [
    [
      [0, 0, -1],
      [
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y0, z0],
      ],
    ],
    [
      [0, 0, 1],
      [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
    ],
    [
      [0, -1, 0],
      [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ],
    ],
    [
      [0, 1, 0],
      [
        [x0, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
      ],
    ],
    [
      [-1, 0, 0],
      [
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
      ],
    ],
    [
      [1, 0, 0],
      [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
    ],
  ];
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const ranges: number[] = [];
  faces.forEach(([n, corners], f) => {
    const base = f * 4;
    for (const c of corners) {
      pos.push(...c);
      nrm.push(...n);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    ranges.push(f * 2, 2);
  });
  return {
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nrm),
    indices: Uint32Array.from(idx),
    faceRanges: Uint32Array.from(ranges),
    edgePositions: new Float32Array(0),
    edgeRanges: new Uint32Array(0),
    faceNames: ['bottom', 'top', 'front', 'back', 'left', 'right'],
    edgeNames: [],
    bbox: { min: [x0, y0, z0], max: [x1, y1, z1] },
  };
}

/** Same box with one face (the top, two triangles) removed. */
export function openBox(w: number, d: number, h: number): MeshBuffers {
  const b = boxMesh(w, d, h);
  return { ...b, indices: Uint32Array.from([...b.indices].filter((_, i) => i < 6 || i >= 12)) };
}
