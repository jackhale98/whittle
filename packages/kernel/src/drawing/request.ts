/**
 * `ViewProjectionRequest` → drawing façade request: validation, the orthonormal frame, tolerances
 * from the part size, the projected bounds and the cache key. Pure (no Wasm), so the main thread
 * and tests may import it.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  KernelError,
  Result,
  ShapeForDrawing,
  Vec2,
  Vec3,
  ViewProjectionRequest,
} from '@wren-cad/contracts';
import type { FacadeProjectRequest } from './facade';

const fail = (message: string, hint?: string): { ok: false; error: KernelError } => ({
  ok: false,
  error:
    hint === undefined
      ? { code: 'INVALID_INPUT', message }
      : { code: 'INVALID_INPUT', message, hint },
});

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every(finite);

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3) => Math.sqrt(dot(a, a));

/** View right/up made orthonormal (Gram–Schmidt on `y`), or null when degenerate. */
export function orthonormalFrame(frame: { x: Vec3; y: Vec3 }): { x: Vec3; y: Vec3 } | null {
  const lx = norm(frame.x);
  if (!(lx > 1e-12)) return null;
  const x = scale(frame.x, 1 / lx);
  const y0 = sub(frame.y, scale(x, dot(frame.y, x)));
  const ly = norm(y0);
  if (!(ly > 1e-9 * Math.max(1, norm(frame.y)))) return null;
  return { x, y: scale(y0, 1 / ly) };
}

/** Draft tessellation and curve sampling tolerances for a part of this size (mm, rad). */
export function tolerancesFor(bounds: ShapeForDrawing['bounds']): {
  linearDeflection: number;
  angularDeflection: number;
  sampleTolerance: number;
} {
  const diag = norm(sub(bounds.max, bounds.min));
  const size = Number.isFinite(diag) && diag > 0 ? diag : 100;
  return {
    // 1/500 of the part (0.2 mm on a 100 mm part): finer than a 0.25 mm line at 1:1 on the sheet.
    linearDeflection: Math.min(2, Math.max(0.01, size * 2e-3)),
    angularDeflection: 0.35,
    // Exact output: only offset and intersection curves are sampled; 1e-5 of the part.
    sampleTolerance: Math.min(0.01, Math.max(1e-4, size * 1e-5)),
  };
}

/**
 * Validates a request and builds the façade's. `bounds` is the loaded shape's 3D box (from
 * `ShapeForDrawing`).
 */
export function toFacadeRequest(
  request: ViewProjectionRequest,
  bounds: ShapeForDrawing['bounds'],
): Result<FacadeProjectRequest> {
  if (typeof request.shapeKey !== 'string' || request.shapeKey === '') {
    return fail('A projection needs the key of a loaded shape');
  }
  const f = request.frame;
  if (f === null || typeof f !== 'object' || !isVec(f.x, 3) || !isVec(f.y, 3)) {
    return fail('The view frame needs finite x and y vectors');
  }
  const frame = orthonormalFrame(f);
  if (frame === null) return fail('The view frame is degenerate (x and y are parallel or zero)');
  if (request.quality !== 'draft' && request.quality !== 'exact') {
    return fail("quality must be 'draft' or 'exact'");
  }
  if (typeof request.hidden !== 'boolean' || typeof request.smooth !== 'boolean') {
    return fail('hidden and smooth must be booleans');
  }
  const out: FacadeProjectRequest = {
    frame,
    quality: request.quality,
    hidden: request.hidden,
    smooth: request.smooth,
    ...tolerancesFor(bounds),
  };
  if (request.section !== undefined) {
    const s = request.section;
    if (!Array.isArray(s.cut) || s.cut.length < 2 || !s.cut.every((p) => isVec(p, 3))) {
      return fail('A section cut line needs at least two finite points');
    }
    if (!isVec(s.along, 3) || !(norm(s.along) > 1e-12)) {
      return fail("The section's sweep direction must be a non-zero vector");
    }
    if (!isVec(s.look, 3) || !(norm(s.look) > 1e-12)) {
      return fail("The section's viewing direction must be a non-zero vector");
    }
    if (s.depth !== 'full' && s.depth !== 'slice')
      return fail("section depth must be 'full' or 'slice'");
    out.section = { cut: s.cut, along: s.along, look: s.look, depth: s.depth };
  }
  if (request.clip !== undefined) {
    const c = request.clip;
    if (!isVec(c.center, 2) || !finite(c.radius) || !(c.radius > 0)) {
      return fail('A detail clip needs a finite centre and a positive radius');
    }
    out.clip = { center: c.center, radius: c.radius };
  }
  return { ok: true, value: out };
}

/**
 * The view's bounds (ADR-090 §10): the 8 corners of the part's 3D box projected with the frame,
 * so draft and exact results lay out identically. Detail views: the clip circle's box.
 */
export function viewBounds(
  bounds: ShapeForDrawing['bounds'],
  frame: { x: Vec3; y: Vec3 },
  clip?: { center: Vec2; radius: number },
): { min: Vec2; max: Vec2 } {
  if (clip !== undefined) {
    const [cx, cy] = clip.center;
    return { min: [cx - clip.radius, cy - clip.radius], max: [cx + clip.radius, cy + clip.radius] };
  }
  const min: Vec2 = [Infinity, Infinity];
  const max: Vec2 = [-Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p: Vec3 = [
      i & 1 ? bounds.max[0] : bounds.min[0],
      i & 2 ? bounds.max[1] : bounds.min[1],
      i & 4 ? bounds.max[2] : bounds.min[2],
    ];
    const u = dot(p, frame.x);
    const v = dot(p, frame.y);
    min[0] = Math.min(min[0], u);
    min[1] = Math.min(min[1], v);
    max[0] = Math.max(max[0], u);
    max[1] = Math.max(max[1], v);
  }
  return { min, max };
}

/** JSON with object keys sorted (stable across property order). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 64-bit FNV-1a of a string (UTF-16 code units), as 16 hex digits. */
export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * The projection output format, salted into every `ViewProjection.key`. Bump it whenever the
 * drawing kernel returns more (or different) data for an unchanged request, so projections cached
 * from an older kernel are not reused.
 *  - 1 (implicit, no salt): M4.
 *  - 2: section cut edges carry `cutFace` (M4.1, ADR-095).
 */
export const PROJECTION_FORMAT = 2;

/**
 * `ViewProjection.key`: the shape key plus a hash of the projection format and every other
 * request field, so equal requests on an equal shape share a `.wren/` cache entry.
 */
export function projectionKey(request: ViewProjectionRequest): string {
  const { shapeKey, ...rest } = request;
  return `${shapeKey}:${fnv1a64(`v${PROJECTION_FORMAT}:${canonicalJson(rest)}`)}`;
}
