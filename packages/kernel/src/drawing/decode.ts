/**
 * Drawing façade result → contracts `ViewProjection` parts: validates every `Curve2` (a malformed
 * result is an INTERNAL error, never drawn), maps edge indices to persistent names and names the
 * section faces. Pure (no Wasm).
 *
 * Names: `index` is the input edge in TopExp::MapShapes order of the loaded BREP, so it names
 * `ShapeForDrawing.edgeNames[index]`. Outlines have no edge; their `face` is the input face they
 * outline, in the same order, so it names `ShapeForDrawing.faceNames[face]` (ADR-090 amendment,
 * second gate round). A seam that lies on a silhouette carries both: its edge and the face it
 * outlines. An empty name, an index of −1 or an unnamed shape leaves the curve without
 * that name. An index past the names is a mismatch between shape and names and fails the call: a
 * curve is never given a guessed name (CLAUDE.md, never silently guess a topological reference).
 * In section views an edge of a cut face carries `cutFace`: the input face the cut passes through
 * along it, in the same order, so it names `faceNames[cutFace]` (M4.1, ADR-095). The same rules
 * apply: −1, absent or an empty name leaves `cutFace` absent; an index past the names fails.
 *
 * Section faces have no model counterpart (they lie on the cutting surface): they are named
 * `section:<segment>#<k>`, segment = the cut-line segment, k = their order on it (left to right,
 * then bottom to top in the view). The names are stable for an unchanged cut and part.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Curve2,
  EdgeClass,
  KernelError,
  LineRole,
  ProjectedCurve,
  Result,
  ViewProjection,
} from '@wren-cad/contracts';

const TWO_PI = 2 * Math.PI;
const ROLES: readonly LineRole[] = ['visible', 'hidden'];
const CLASSES: readonly EdgeClass[] = ['sharp', 'smooth', 'outline', 'sewn'];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec2 = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]);
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const internal = (message: string, detail?: string): { ok: false; error: KernelError } => ({
  ok: false,
  error:
    detail === undefined ? { code: 'INTERNAL', message } : { code: 'INTERNAL', message, detail },
});

/**
 * A validated, normalised copy of a façade curve, or null. Arcs and ellipses: start < end, span
 * ≤ 2π, a full curve exactly 0 → 2π. B-splines: knots non-decreasing, `poles + degree + 1` of
 * them, weights (when present) positive and one per pole.
 */
export function decodeCurve(v: unknown): Curve2 | null {
  if (!isObj(v)) return null;
  switch (v.kind) {
    case 'line':
      return isVec2(v.a) && isVec2(v.b) ? { kind: 'line', a: v.a, b: v.b } : null;
    case 'arc':
    case 'ellipse': {
      if (!isVec2(v.center) || !finite(v.start) || !finite(v.end)) return null;
      const span = v.end - v.start;
      if (!(span > 0) || span > TWO_PI + 1e-9) return null;
      const full = span >= TWO_PI - 1e-9;
      const start = full ? 0 : v.start;
      const end = full ? TWO_PI : v.end;
      if (v.kind === 'arc') {
        return finite(v.radius) && v.radius > 0
          ? { kind: 'arc', center: v.center, radius: v.radius, start, end }
          : null;
      }
      if (!isVec2(v.major) || !finite(v.ratio) || !(v.ratio > 0) || v.ratio > 1 + 1e-12)
        return null;
      if (!(Math.hypot(v.major[0], v.major[1]) > 0)) return null;
      return { kind: 'ellipse', center: v.center, major: v.major, ratio: v.ratio, start, end };
    }
    case 'bspline': {
      const { degree, poles, knots, weights } = v;
      if (!Number.isInteger(degree) || (degree as number) < 1) return null;
      if (!Array.isArray(poles) || poles.length < 2 || !poles.every(isVec2)) return null;
      if (!Array.isArray(knots) || !knots.every(finite)) return null;
      if (knots.length !== poles.length + (degree as number) + 1) return null;
      for (let i = 1; i < knots.length; i++) {
        if ((knots[i] as number) < (knots[i - 1] as number)) return null;
      }
      const out: Curve2 = { kind: 'bspline', degree: degree as number, poles, knots };
      if (weights !== undefined) {
        if (!Array.isArray(weights) || weights.length !== poles.length) return null;
        if (!weights.every((w) => finite(w) && w > 0)) return null;
        out.weights = weights;
      }
      return out;
    }
    case 'polyline':
      return Array.isArray(v.points) && v.points.length >= 2 && v.points.every(isVec2)
        ? { kind: 'polyline', points: v.points }
        : null;
    default:
      return null;
  }
}

/** The decoded parts of a façade projection (the API adds key, bounds and ms). */
export type DecodedProjection = Pick<ViewProjection, 'curves' | 'sectionFaces'>;

/**
 * Decodes a façade `RawProjection` (as parsed JSON). `edgeNames` and `faceNames` are the loaded
 * shape's (`ShapeForDrawing.edgeNames` / `faceNames`; empty for an unnamed shape). `section`:
 * whether the request had one (only then is `sectionFaces` present).
 */
export function decodeProjection(
  raw: unknown,
  edgeNames: readonly string[],
  faceNames: readonly string[],
  section: boolean,
): Result<DecodedProjection> {
  if (!isObj(raw) || !Array.isArray(raw.curves)) {
    return internal('The drawing kernel returned a malformed projection');
  }
  const curves: ProjectedCurve[] = [];
  for (let i = 0; i < raw.curves.length; i++) {
    const c: unknown = raw.curves[i];
    if (!isObj(c)) return internal('The drawing kernel returned a malformed curve', `curve ${i}`);
    const role = c.role as LineRole;
    const edge = c.edge as EdgeClass;
    if (
      !ROLES.includes(role) ||
      !CLASSES.includes(edge) ||
      !Number.isInteger(c.index) ||
      (c.face !== undefined && !Number.isInteger(c.face)) ||
      (c.cutFace !== undefined && !Number.isInteger(c.cutFace))
    ) {
      return internal('The drawing kernel returned a malformed curve', `curve ${i}`);
    }
    const curve = decodeCurve(c.curve);
    if (curve === null) {
      return internal(
        'The drawing kernel returned a malformed curve',
        `curve ${i}: ${JSON.stringify(c.curve).slice(0, 200)}`,
      );
    }
    const index = c.index as number;
    const out: ProjectedCurve = { role, edge, curve };
    if (index >= 0 && edgeNames.length > 0) {
      if (index >= edgeNames.length) {
        return internal(
          "The part's edge names do not match its shape",
          `edge ${index} of a shape with ${edgeNames.length} named edges`,
        );
      }
      const name = edgeNames[index];
      if (name !== undefined && name !== '' && edge !== 'outline') out.name = name;
    }
    // The façade sets `face` on outlines and on seams that lie on a silhouette.
    const face = c.face === undefined ? -1 : (c.face as number);
    if (face >= 0 && faceNames.length > 0) {
      if (face >= faceNames.length) {
        return internal(
          "The part's face names do not match its shape",
          `face ${face} of a shape with ${faceNames.length} named faces`,
        );
      }
      const name = faceNames[face];
      if (name !== undefined && name !== '') out.face = name;
    }
    // Section views: an edge of a cut face names the model face the cut passes through there.
    const cutFace = c.cutFace === undefined ? -1 : (c.cutFace as number);
    if (cutFace >= 0 && faceNames.length > 0) {
      if (cutFace >= faceNames.length) {
        return internal(
          "The part's face names do not match its shape",
          `cut face ${cutFace} of a shape with ${faceNames.length} named faces`,
        );
      }
      const name = faceNames[cutFace];
      if (name !== undefined && name !== '') out.cutFace = name;
    }
    curves.push(out);
  }
  if (!section) return { ok: true, value: { curves } };
  const faces = raw.sectionFaces;
  if (!Array.isArray(faces)) return internal('The drawing kernel returned no section faces');
  const sectionFaces: NonNullable<ViewProjection['sectionFaces']> = [];
  const perSegment = new Map<number, number>();
  for (let i = 0; i < faces.length; i++) {
    const f: unknown = faces[i];
    if (!isObj(f) || !Number.isInteger(f.segment) || !Array.isArray(f.loops)) {
      return internal('The drawing kernel returned a malformed section face', `face ${i}`);
    }
    const loops: Curve2[][] = [];
    for (const loop of f.loops as unknown[]) {
      if (!Array.isArray(loop)) {
        return internal('The drawing kernel returned a malformed section face', `face ${i}`);
      }
      const decoded: Curve2[] = [];
      for (const c of loop) {
        const curve = decodeCurve(c);
        if (curve === null) {
          return internal('The drawing kernel returned a malformed section loop', `face ${i}`);
        }
        decoded.push(curve);
      }
      if (decoded.length > 0) loops.push(decoded);
    }
    const segment = f.segment as number;
    const k = perSegment.get(segment) ?? 0;
    perSegment.set(segment, k + 1);
    sectionFaces.push({ face: `section:${segment}#${k}`, loops });
  }
  return { ok: true, value: { curves, sectionFaces } };
}
