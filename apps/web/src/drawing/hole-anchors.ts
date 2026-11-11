/**
 * WORKAROUND (ADR-092): the regen resolves a hole callout's instances (`AnnotationResolution.instances`)
 * but gives it no `anchors`, so a leader has nothing to attach to ("its geometry could not be
 * found"). Until the kernel reports the first instance's circle, the route reads it from the
 * regen's render mesh: the hole wall is a cylinder, so its vertex normals are all perpendicular to
 * the axis, and its points are one radius from it. The anchor is approximate (tessellated) and used
 * only to place the leader; the callout's numbers come from the feature, never from here.
 */

import type {
  Annotation,
  AnnotationAnchor,
  AnnotationResolution,
  RegenResult,
  Vec3,
} from '@wren-cad/contracts';

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** The circle of a cylindrical face of one body's mesh, or null when it is not one. */
export function cylinderAnchor(
  mesh: RegenResult['bodies'][number]['mesh'],
  faceIndex: number,
): AnnotationAnchor | null {
  const first = mesh.faceRanges[2 * faceIndex];
  const count = mesh.faceRanges[2 * faceIndex + 1];
  if (first === undefined || !count) return null;
  const pts: V3[] = [];
  const nrm: V3[] = [];
  for (let t = first; t < first + count; t++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[3 * t + k] as number;
      pts.push([
        mesh.positions[3 * v] as number,
        mesh.positions[3 * v + 1] as number,
        mesh.positions[3 * v + 2] as number,
      ]);
      nrm.push([
        mesh.normals[3 * v] as number,
        mesh.normals[3 * v + 1] as number,
        mesh.normals[3 * v + 2] as number,
      ]);
    }
  }
  const a = nrm[0];
  if (!a) return null;
  // The normal most perpendicular to the first: together they span the plane the normals sweep.
  let b = nrm[0] as V3;
  let best = 2;
  for (const n of nrm) {
    const d = Math.abs(dot(a, n));
    if (d < best) {
      best = d;
      b = n;
    }
  }
  const axis = cross(a, b);
  const len = Math.hypot(...axis);
  if (len < 0.3) return null; // all normals parallel: a plane, not a cylinder
  const u: V3 = [axis[0] / len, axis[1] / len, axis[2] / len];
  // Every normal must be perpendicular to the axis.
  if (nrm.some((n) => Math.abs(dot(n, u)) > 0.05)) return null;
  const c: V3 = [0, 0, 0];
  for (const p of pts)
    for (let k = 0; k < 3; k++) c[k] = (c[k] as number) + (p[k] as number) / pts.length;
  let r = 0;
  for (const p of pts) {
    const d: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const along = dot(d, u);
    r += Math.hypot(d[0] - along * u[0], d[1] - along * u[1], d[2] - along * u[2]);
  }
  return { kind: 'circle', center: c as Vec3, normal: u as Vec3, radius: r / pts.length };
}

/** The result's resolutions, with an anchor added to each hole callout that has none. */
export function withHoleAnchors(
  result: RegenResult,
  annotations: readonly Annotation[],
): AnnotationResolution[] {
  const holes = new Set(annotations.flatMap((a) => (a.kind === 'holeCallout' ? [a.id] : [])));
  return (result.annotations ?? []).map((res) => {
    const first = res.instances?.[0];
    if (!holes.has(res.annotationId) || res.state !== 'ok' || res.anchors?.length || !first)
      return res;
    for (const body of result.bodies) {
      const i = body.mesh.faceNames.indexOf(first.name);
      if (i < 0) continue;
      const anchor = cylinderAnchor(body.mesh, i);
      return anchor ? { ...res, anchors: [anchor] } : res;
    }
    return res;
  });
}
