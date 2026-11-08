/**
 * Synthetic `MeshBuffers` fixtures. They follow the index-space rules documented on `MeshBuffers`
 * in @whittle/contracts exactly, so the viewport can be developed and benchmarked before the real
 * kernel mesher is wired in.
 */

import type { MeshBuffers } from '@whittle/contracts';

type V3 = [number, number, number];

const AXES = ['x', 'y', 'z'] as const;

interface BoxFace {
  /** Primitive role (PLAN §7.3 / naming.ts), e.g. `face.xmin`. */
  role: string;
  /** Four corners, counter-clockwise seen from outside. */
  corners: [V3, V3, V3, V3];
  normal: V3;
}

export interface BoxMeshOptions {
  /** Optional feature tag prefix, e.g. `F01J` gives `F01J:face.xmin`. */
  featureTag?: string;
  /** Local-frame position of the min corner. Default [0, 0, 0]. */
  origin?: V3;
}

/**
 * Axis-aligned box spanning `origin … origin + (dx, dy, dz)`.
 *
 * Structure: 24 vertices (4 per face, flat normals), 12 triangles, 6 face ranges of 2 triangles,
 * 12 edge polylines of 2 points each, face names `face.<axis>min|max`, edge names
 * `edge(<faceRoleA>|<faceRoleB>)` (roles sorted lexicographically).
 */
export function boxMesh(
  dx: number,
  dy: number,
  dz: number,
  options: BoxMeshOptions = {},
): MeshBuffers {
  const [ox, oy, oz] = options.origin ?? [0, 0, 0];
  const x0 = ox;
  const x1 = ox + dx;
  const y0 = oy;
  const y1 = oy + dy;
  const z0 = oz;
  const z1 = oz + dz;
  const tag = options.featureTag ? `${options.featureTag}:` : '';

  const faces: BoxFace[] = [
    {
      role: 'face.xmin',
      normal: [-1, 0, 0],
      corners: [
        [x0, y1, z0],
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
      ],
    },
    {
      role: 'face.xmax',
      normal: [1, 0, 0],
      corners: [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
    },
    {
      role: 'face.ymin',
      normal: [0, -1, 0],
      corners: [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ],
    },
    {
      role: 'face.ymax',
      normal: [0, 1, 0],
      corners: [
        [x1, y1, z0],
        [x0, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
      ],
    },
    {
      role: 'face.zmin',
      normal: [0, 0, -1],
      corners: [
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y0, z0],
        [x0, y0, z0],
      ],
    },
    {
      role: 'face.zmax',
      normal: [0, 0, 1],
      corners: [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
    },
  ];

  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const indices = new Uint32Array(12 * 3);
  const faceRanges = new Uint32Array(6 * 2);
  const faceNames: string[] = [];

  faces.forEach((face, f) => {
    face.corners.forEach((c, i) => {
      positions.set(c, (f * 4 + i) * 3);
      normals.set(face.normal, (f * 4 + i) * 3);
    });
    const v = f * 4;
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], f * 6);
    faceRanges[f * 2] = f * 2;
    faceRanges[f * 2 + 1] = 2;
    faceNames.push(`${tag}${face.role}`);
  });

  // 12 edges: for each axis `c`, four edges run along it, one per (a, b) min/max corner pair.
  const edgePoints: number[] = [];
  const edgeRanges: number[] = [];
  const edgeNames: string[] = [];
  const lo = [x0, y0, z0];
  const hi = [x1, y1, z1];
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3;
    const c = (a + 2) % 3;
    for (const sa of [0, 1]) {
      for (const sb of [0, 1]) {
        const start: number[] = [0, 0, 0];
        const end: number[] = [0, 0, 0];
        start[a] = end[a] = (sa ? hi : lo)[a] as number;
        start[b] = end[b] = (sb ? hi : lo)[b] as number;
        start[c] = lo[c] as number;
        end[c] = hi[c] as number;
        edgeRanges.push(edgePoints.length / 3, 2);
        edgePoints.push(...start, ...end);
        const roles = [
          `face.${AXES[a]}${sa ? 'max' : 'min'}`,
          `face.${AXES[b]}${sb ? 'max' : 'min'}`,
        ].sort();
        edgeNames.push(`${tag}edge(${roles[0]}|${roles[1]})`);
      }
    }
  }

  return {
    positions,
    normals,
    indices,
    faceRanges,
    edgePositions: new Float32Array(edgePoints),
    edgeRanges: new Uint32Array(edgeRanges),
    faceNames,
    edgeNames,
    bbox: { min: [x0, y0, z0], max: [x1, y1, z1] },
  };
}

/**
 * A smooth UV sphere tessellated to roughly `targetTriangles` triangles, for perf benchmarks.
 * One B-rep "face"; the seam meridian and the equator are the edge polylines. Vertices are shared
 * (smooth normals).
 */
export function denseMesh(targetTriangles: number, radius = 50): MeshBuffers {
  // Triangles = 2 * segments * (rings - 1) (the pole rows are single triangles per segment).
  const rings = Math.max(3, Math.round(Math.sqrt(targetTriangles / 4)));
  const segments = Math.max(3, Math.round(targetTriangles / (2 * rings - 2)));
  const vertCount = (rings + 1) * (segments + 1);
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  let p = 0;
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const nx = sp * Math.cos(theta);
      const ny = sp * Math.sin(theta);
      positions[p] = nx * radius;
      positions[p + 1] = ny * radius;
      positions[p + 2] = cp * radius;
      normals[p] = nx;
      normals[p + 1] = ny;
      normals[p + 2] = cp;
      p += 3;
    }
  }
  const triCount = 2 * segments * (rings - 1);
  const indices = new Uint32Array(triCount * 3);
  let k = 0;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      if (r !== 0) {
        indices[k++] = a;
        indices[k++] = b;
        indices[k++] = a + 1;
      }
      if (r !== rings - 1) {
        indices[k++] = a + 1;
        indices[k++] = b;
        indices[k++] = b + 1;
      }
    }
  }

  const meridian: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    meridian.push(Math.sin(phi) * radius, 0, Math.cos(phi) * radius);
  }
  const equator: number[] = [];
  const eqSeg = 96;
  for (let s = 0; s <= eqSeg; s++) {
    const theta = (s / eqSeg) * Math.PI * 2;
    equator.push(Math.cos(theta) * radius, Math.sin(theta) * radius, 0);
  }

  return {
    positions,
    normals,
    indices,
    faceRanges: new Uint32Array([0, triCount]),
    edgePositions: new Float32Array([...meridian, ...equator]),
    edgeRanges: new Uint32Array([0, rings + 1, rings + 1, eqSeg + 1]),
    faceNames: ['face.sphere'],
    edgeNames: ['edge(meridian)', 'edge(equator)'],
    bbox: { min: [-radius, -radius, -radius], max: [radius, radius, radius] },
  };
}
