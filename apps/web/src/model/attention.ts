/**
 * "Needs attention" support (PLAN §7.3 rule 4): where an unresolved reference *used to be*, drawn
 * from its stored fingerprint, and the candidate list for the "Which one?" chooser.
 *
 * The marker is a proxy, not the old geometry (which no longer exists): a face shows as a dashed
 * square of the old area in the old plane, an edge or vertex as two dashed rings around the old
 * centroid with a dot at its centre. They are viewport markers (`setMarkers`, warning tone).
 */

import type {
  EntityRef,
  FeatureStatus,
  Marker,
  RegenResult,
  UnresolvedRef,
} from '@wren-cad/contracts';

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

/** A closed ring of `n` points around `c` in the plane of `u`, `v`. */
function ring(c: V, u: V, v: V, r: number, n = 32): V[] {
  const out: V[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI;
    out.push(add(add(c, u, r * Math.cos(t)), v, r * Math.sin(t)));
  }
  return out;
}

/**
 * Markers at a reference's old location, or null without a fingerprint. `size` (mm) scales edge
 * and vertex markers (≈ 5 % of the part diagonal reads well).
 */
export function attentionMarkers(ref: EntityRef, size: number): Marker[] | null {
  const fp = ref.fingerprint;
  if (!fp) return null;
  const c = fp.centroid as V;
  if (ref.kind === 'face' && fp.normal) {
    const n = norm(fp.normal as V);
    const [u, v] = basis(n);
    const h = Math.max(Math.sqrt(fp.area ?? size * size) / 2, size / 2);
    const lift = add(c, n, Math.max(size * 0.02, 0.01)); // just above the old surface
    const square: V[] = [
      add(add(lift, u, -h), v, -h),
      add(add(lift, u, h), v, -h),
      add(add(lift, u, h), v, h),
      add(add(lift, u, -h), v, h),
    ];
    return [
      { kind: 'polyline', points: [...square, square[0] as V], tone: 'warning', dashed: true },
      { kind: 'point', points: [lift], tone: 'warning' },
    ];
  }
  // Edge / vertex / region: two dashed rings (XY and XZ) around the old centroid plus a dot.
  return [
    {
      kind: 'polyline',
      points: ring(c, [1, 0, 0], [0, 1, 0], size),
      tone: 'warning',
      dashed: true,
    },
    {
      kind: 'polyline',
      points: ring(c, [1, 0, 0], [0, 0, 1], size),
      tone: 'warning',
      dashed: true,
    },
    { kind: 'point', points: [c], tone: 'warning' },
  ];
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
