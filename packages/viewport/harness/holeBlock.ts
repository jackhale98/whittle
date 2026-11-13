import type { MeshBuffers } from '@wren-cad/contracts';

type V3 = [number, number, number];

export interface HoleBlockOptions {
  /** Hole rectangle on the top face (x0, y0, x1, y1), mm. */
  hole: [number, number, number, number];
  /** Hole depth from the top, mm (blind: less than `dz`). */
  depth: number;
}

/** Face names of the hole, in the order of `holeBlock`'s face ranges. */
export const HOLE_FACES = ['hole.xmin', 'hole.xmax', 'hole.ymin', 'hole.ymax'] as const;
export const HOLE_FLOOR = 'hole.floor';

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * A `dx` x `dy` x `dz` block (min corner at the origin) with a rectangular blind hole in its top
 * face: the owner's case for ADR-098 ("when I look on a hole straight on I shouldn't see the bottom
 * of it"). One B-rep face per named face; the top face is four quads around the hole. Face names:
 * `face.xmin|xmax|ymin|ymax|zmin|zmax` (zmax is the top), `hole.xmin|xmax|ymin|ymax` (the walls,
 * named by the side of the hole they stand on) and `hole.floor`.
 */
export function holeBlock(dx: number, dy: number, dz: number, o: HoleBlockOptions): MeshBuffers {
  const [hx0, hy0, hx1, hy1] = o.hole;
  const zf = dz - o.depth;
  const faces: Array<{ name: string; normal: V3; quads: V3[][] }> = [
    {
      name: 'face.xmin',
      normal: [-1, 0, 0],
      quads: [
        [
          [0, 0, 0],
          [0, dy, 0],
          [0, dy, dz],
          [0, 0, dz],
        ],
      ],
    },
    {
      name: 'face.xmax',
      normal: [1, 0, 0],
      quads: [
        [
          [dx, 0, 0],
          [dx, dy, 0],
          [dx, dy, dz],
          [dx, 0, dz],
        ],
      ],
    },
    {
      name: 'face.ymin',
      normal: [0, -1, 0],
      quads: [
        [
          [0, 0, 0],
          [dx, 0, 0],
          [dx, 0, dz],
          [0, 0, dz],
        ],
      ],
    },
    {
      name: 'face.ymax',
      normal: [0, 1, 0],
      quads: [
        [
          [0, dy, 0],
          [dx, dy, 0],
          [dx, dy, dz],
          [0, dy, dz],
        ],
      ],
    },
    {
      name: 'face.zmin',
      normal: [0, 0, -1],
      quads: [
        [
          [0, 0, 0],
          [dx, 0, 0],
          [dx, dy, 0],
          [0, dy, 0],
        ],
      ],
    },
    {
      name: 'face.zmax',
      normal: [0, 0, 1],
      quads: [
        [
          [0, 0, dz],
          [dx, 0, dz],
          [dx, hy0, dz],
          [0, hy0, dz],
        ],
        [
          [0, hy1, dz],
          [dx, hy1, dz],
          [dx, dy, dz],
          [0, dy, dz],
        ],
        [
          [0, hy0, dz],
          [hx0, hy0, dz],
          [hx0, hy1, dz],
          [0, hy1, dz],
        ],
        [
          [hx1, hy0, dz],
          [dx, hy0, dz],
          [dx, hy1, dz],
          [hx1, hy1, dz],
        ],
      ],
    },
    // Hole walls: the normal points into the hole (out of the material).
    {
      name: 'hole.xmin',
      normal: [1, 0, 0],
      quads: [
        [
          [hx0, hy0, zf],
          [hx0, hy1, zf],
          [hx0, hy1, dz],
          [hx0, hy0, dz],
        ],
      ],
    },
    {
      name: 'hole.xmax',
      normal: [-1, 0, 0],
      quads: [
        [
          [hx1, hy0, zf],
          [hx1, hy1, zf],
          [hx1, hy1, dz],
          [hx1, hy0, dz],
        ],
      ],
    },
    {
      name: 'hole.ymin',
      normal: [0, 1, 0],
      quads: [
        [
          [hx0, hy0, zf],
          [hx1, hy0, zf],
          [hx1, hy0, dz],
          [hx0, hy0, dz],
        ],
      ],
    },
    {
      name: 'hole.ymax',
      normal: [0, -1, 0],
      quads: [
        [
          [hx0, hy1, zf],
          [hx1, hy1, zf],
          [hx1, hy1, dz],
          [hx0, hy1, dz],
        ],
      ],
    },
    {
      name: HOLE_FLOOR,
      normal: [0, 0, 1],
      quads: [
        [
          [hx0, hy0, zf],
          [hx1, hy0, zf],
          [hx1, hy1, zf],
          [hx0, hy1, zf],
        ],
      ],
    },
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceRanges: number[] = [];
  for (const face of faces) {
    const first = indices.length / 3;
    for (const q of face.quads) {
      // Counter-clockwise seen from the side the normal points to.
      let c = q;
      const n = cross(sub(c[1] as V3, c[0] as V3), sub(c[2] as V3, c[0] as V3));
      if (n[0] * face.normal[0] + n[1] * face.normal[1] + n[2] * face.normal[2] < 0) {
        c = [...q].reverse();
      }
      const base = positions.length / 3;
      for (const p of c) {
        positions.push(...(p as V3));
        normals.push(...face.normal);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    faceRanges.push(first, indices.length / 3 - first);
  }

  // Edges: the block's 12, the hole rim, the hole's vertical edges and its floor outline.
  const edgePoints: number[] = [];
  const edgeRanges: number[] = [];
  const edge = (...pts: V3[]) => {
    edgeRanges.push(edgePoints.length / 3, pts.length);
    for (const p of pts) edgePoints.push(...p);
  };
  const box: V3[] = [
    [0, 0, 0],
    [dx, 0, 0],
    [dx, dy, 0],
    [0, dy, 0],
    [0, 0, dz],
    [dx, 0, dz],
    [dx, dy, dz],
    [0, dy, dz],
  ];
  for (const [a, b] of [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ] as const) {
    edge(box[a] as V3, box[b] as V3);
  }
  const rim: V3[] = [
    [hx0, hy0, dz],
    [hx1, hy0, dz],
    [hx1, hy1, dz],
    [hx0, hy1, dz],
  ];
  const floor: V3[] = rim.map((p) => [p[0], p[1], zf] as V3);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    edge(rim[i] as V3, rim[j] as V3);
    edge(floor[i] as V3, floor[j] as V3);
    edge(floor[i] as V3, rim[i] as V3);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    faceRanges: new Uint32Array(faceRanges),
    edgePositions: new Float32Array(edgePoints),
    edgeRanges: new Uint32Array(edgeRanges),
    faceNames: faces.map((f) => f.name),
    edgeNames: Array.from({ length: edgeRanges.length / 2 }, (_, i) => `edge${i}`),
    bbox: { min: [0, 0, 0], max: [dx, dy, dz] },
  };
}
