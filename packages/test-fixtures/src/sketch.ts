/**
 * Synthetic `SketchResult` fixture: a rectangle, a circle and a few extras on a horizontal plane,
 * following the SketchResult contract (world-space polylines per entity, triangulated regions).
 */

import type { MeshBuffers, SketchResult } from '@wren-cad/contracts';

type V3 = [number, number, number];

function fan(center: V3, ring: V3[], name: string): MeshBuffers {
  const positions = new Float32Array((ring.length + 1) * 3);
  positions.set(center, 0);
  ring.forEach((p, i) => {
    positions.set(p, 3 * (i + 1));
  });
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < normals.length; i += 3) normals[i + 2] = 1;
  const tris = ring.length;
  const indices = new Uint32Array(tris * 3);
  for (let i = 0; i < tris; i++) {
    indices[3 * i] = 0;
    indices[3 * i + 1] = 1 + i;
    indices[3 * i + 2] = 1 + ((i + 1) % ring.length);
  }
  let min: V3 = [Infinity, Infinity, Infinity];
  let max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of [center, ...ring]) {
    min = [Math.min(min[0], p[0]), Math.min(min[1], p[1]), Math.min(min[2], p[2])];
    max = [Math.max(max[0], p[0]), Math.max(max[1], p[1]), Math.max(max[2], p[2])];
  }
  return {
    positions,
    normals,
    indices,
    faceRanges: new Uint32Array([0, tris]),
    edgePositions: new Float32Array(0),
    edgeRanges: new Uint32Array(0),
    faceNames: [name],
    edgeNames: [],
    bbox: { min, max },
  };
}

/**
 * Sketch on the plane z = `z` (origin at the world origin, x/y axes aligned). Entities:
 * `l1..l4` rectangle (5,5)-(35,25), `c1` circle centre (20,15) r 6, `k1` a dashed construction
 * line, `p1` a point. Regions: the rectangle (index 0) and the circle (index 1, drawn over it).
 */
export function sketchFixture(z = 20, featureId = 'F02'): SketchResult {
  const pt = (x: number, y: number): V3 => [x, y, z];
  const line = (entity: string, a: V3, b: V3, construction = false) => ({
    entity,
    points: Float32Array.from([...a, ...b]),
    construction,
  });
  const corners = [pt(5, 5), pt(35, 5), pt(35, 25), pt(5, 25)];
  const circleN = 64;
  const ring: V3[] = [];
  for (let i = 0; i < circleN; i++) {
    const a = (i / circleN) * Math.PI * 2;
    ring.push(pt(20 + 6 * Math.cos(a), 15 + 6 * Math.sin(a)));
  }
  return {
    featureId,
    curves: [
      line('l1', corners[0] as V3, corners[1] as V3),
      line('l2', corners[1] as V3, corners[2] as V3),
      line('l3', corners[2] as V3, corners[3] as V3),
      line('l4', corners[3] as V3, corners[0] as V3),
      {
        entity: 'c1',
        points: Float32Array.from([...ring, ring[0] as V3].flat()),
        construction: false,
      },
      line('k1', pt(5, 15), pt(35, 15), true),
      { entity: 'p1', points: Float32Array.from(pt(28, 20)), construction: false },
    ],
    regions: [
      { name: `${featureId}:region.0`, mesh: fan(pt(20, 15), corners, `${featureId}:region.0`) },
      { name: `${featureId}:region.1`, mesh: fan(pt(20, 15), ring, `${featureId}:region.1`) },
    ],
    frame: { origin: [0, 0, z], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
  };
}
