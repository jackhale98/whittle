/**
 * "Needs attention" support (PLAN §7.3 rule 4): where an unresolved reference *used to be*, drawn
 * as a ghost from its stored fingerprint, and the candidate list for the "Which one?" chooser.
 *
 * The marker is a proxy, not the old geometry (which no longer exists): a face shows as a dashed
 * square of the old area in the old plane, an edge as a dashed ring with a small diamond at the old
 * centroid; both are translucent ghosts (viewport `setGhost`).
 */

import type {
  EntityRef,
  FeatureStatus,
  MeshBuffers,
  RegenResult,
  UnresolvedRef,
  Vec3,
} from '@whittle/contracts';

type V = [number, number, number];
const add = (a: V, b: V, s = 1): V => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V): V => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Two unit vectors spanning the plane perpendicular to `n`. */
function basis(n: V): [V, V] {
  const helper: V = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = norm(cross(n, helper));
  return [u, norm(cross(n, u))];
}

/** Dashed closed polyline as many 2-point edge polylines (`dashes` on, as many off). */
function dashed(points: V[], dashes: number): V[][] {
  const segs: V[][] = [];
  const n = points.length;
  const steps = dashes * 2;
  for (let k = 0; k < steps; k += 2) {
    const t0 = (k / steps) * n;
    const t1 = ((k + 1) / steps) * n;
    const p = (t: number): V => {
      const i = Math.floor(t) % n;
      const j = (i + 1) % n;
      const f = t - Math.floor(t);
      const a = points[i] as V;
      const b = points[j] as V;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    };
    segs.push([p(t0), p(t1)]);
  }
  return segs;
}

function buildMesh(tris: V[][], lines: V[][]): MeshBuffers {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const t of tris) {
    const [a, b, c] = t as [V, V, V];
    const nrm = norm(
      cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]),
    );
    for (const p of [a, b, c]) {
      indices.push(positions.length / 3);
      positions.push(...p);
      normals.push(...nrm);
    }
  }
  const edgePositions: number[] = [];
  const edgeRanges: number[] = [];
  for (const l of lines) {
    edgeRanges.push(edgePositions.length / 3, l.length);
    for (const p of l) edgePositions.push(...p);
  }
  const all = [...positions, ...edgePositions];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < all.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, all[i + k] as number);
      max[k] = Math.max(max[k] as number, all[i + k] as number);
    }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    faceRanges: new Uint32Array(tris.length ? [0, tris.length] : []),
    edgePositions: new Float32Array(edgePositions),
    edgeRanges: new Uint32Array(edgeRanges),
    faceNames: tris.length ? ['attention'] : [],
    edgeNames: lines.map(() => 'attention'),
    bbox: { min, max },
  };
}

/**
 * Ghost proxy of a reference's old location, or null without a fingerprint. `size` (mm) scales
 * edge/vertex markers (≈ 3 % of the part diagonal reads well).
 */
export function markerMesh(ref: EntityRef, size: number): MeshBuffers | null {
  const fp = ref.fingerprint;
  if (!fp) return null;
  const c = fp.centroid as V;
  if (ref.kind === 'face' && fp.normal) {
    const n = norm(fp.normal as V);
    const [u, v] = basis(n);
    const h = Math.max(Math.sqrt(fp.area ?? size * size) / 2, size / 2);
    const lift = add(c, n, Math.max(size * 0.02, 0.01)); // just above the old surface
    const corners: V[] = [
      add(add(lift, u, -h), v, -h),
      add(add(lift, u, h), v, -h),
      add(add(lift, u, h), v, h),
      add(add(lift, u, -h), v, h),
    ];
    const [a, b, d, e] = corners as [V, V, V, V];
    return buildMesh(
      [
        [a, b, d],
        [a, d, e],
      ],
      dashed(corners, 16),
    );
  }
  // Edge / vertex / region: a dashed ring around the old centroid plus a small diamond.
  const r = size;
  const ring: V[] = [];
  for (let i = 0; i < 32; i++) {
    const t = (i / 32) * 2 * Math.PI;
    ring.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t), c[2]]);
  }
  const ring2: V[] = ring.map((p) => [p[0], c[1], c[2] + (p[1] - c[1])]);
  const s = r * 0.35;
  const px: V = [c[0] + s, c[1], c[2]];
  const nx: V = [c[0] - s, c[1], c[2]];
  const py: V = [c[0], c[1] + s, c[2]];
  const ny: V = [c[0], c[1] - s, c[2]];
  const pz: V = [c[0], c[1], c[2] + s];
  const nz: V = [c[0], c[1], c[2] - s];
  const tris: V[][] = [
    [px, py, pz],
    [py, nx, pz],
    [nx, ny, pz],
    [ny, px, pz],
    [py, px, nz],
    [nx, py, nz],
    [ny, nx, nz],
    [px, ny, nz],
  ];
  return buildMesh(tris, [...dashed(ring, 12), ...dashed(ring2, 12)]);
}

export interface AttentionItem {
  featureId: string;
  unresolved: UnresolvedRef;
}

/** Unresolved references of features that need attention, in feature order. */
export function attentionItems(statuses: readonly FeatureStatus[] | undefined): AttentionItem[] {
  return (statuses ?? []).flatMap((s) =>
    s.state === 'needsAttention'
      ? (s.unresolved ?? []).map((unresolved) => ({ featureId: s.featureId, unresolved }))
      : [],
  );
}

/** Diagonal of all bodies' bounding boxes (mm); `fallback` without bodies. */
export function partDiagonal(result: RegenResult | undefined, fallback = 50): number {
  const bodies = result?.bodies ?? [];
  if (!bodies.length) return fallback;
  const min: V = [Infinity, Infinity, Infinity];
  const max: V = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, b.mesh.bbox.min[k] as number);
      max[k] = Math.max(max[k] as number, b.mesh.bbox.max[k] as number);
    }
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || fallback;
}

/** Where a candidate name lives in the current bodies (for refFor / highlighting). */
export function locateName(
  result: RegenResult | undefined,
  name: string,
  kind: EntityRef['kind'],
): { bodyId: string; kind: 'face' | 'edge'; index: number } | null {
  for (const b of result?.bodies ?? []) {
    if (kind === 'face') {
      const i = b.mesh.faceNames.indexOf(name);
      if (i >= 0) return { bodyId: b.id, kind: 'face', index: i };
    } else if (kind === 'edge') {
      const i = b.mesh.edgeNames.indexOf(name);
      if (i >= 0) return { bodyId: b.id, kind: 'edge', index: i };
    }
  }
  return null;
}
