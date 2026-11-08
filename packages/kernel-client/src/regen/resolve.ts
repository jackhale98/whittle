/**
 * Persistent reference resolution (PLAN §7.3). Never guesses: a reference either resolves to
 * exactly one sub-shape by evidence that clearly singles it out, or it is reported unresolved
 * (`missing` / `ambiguous` with candidates) and the feature goes to "needs attention".
 *
 * Order:
 *  1. Exact name, exactly one match → resolved. (A `#k` split name is re-checked against its
 *     fingerprint when the split family has several members; a clear fingerprint winner overrides
 *     the index, otherwise the exact name stands.)
 *  2. Name family: the same name once every `#k` split suffix in it is ignored (the entity — or a
 *     face its edge/vertex name is built from — was split, or split pieces merged back), or several
 *     exact matches → disambiguate by fingerprint: nearest centroid
 *     among candidates whose normal agrees, accepted only within the loose tolerance and with a
 *     clear margin over the runner-up.
 *  3. No name match → fingerprint-only: candidates of the same kind within the strict tolerance
 *     (centroid, normal, area/length all agree); exactly one → resolved.
 *  4. Otherwise unresolved.
 *
 * Tolerances are relative to `diag`, the diagonal of the part's current bounding box (all body
 * vertices; sketch geometry when there are no bodies):
 *  - strict (fingerprint-only): centroid within 1e-3·diag (≥ 1e-6 mm), normals within ~0.8°
 *    (dot ≥ 0.9999), area / length within 0.1 % relative;
 *  - loose (name family): centroid within 0.25·diag, normals within ~18° (dot ≥ 0.95);
 *  - margin: winner distance ≤ ½ × runner-up distance and ≥ 1e-3·diag apart.
 *
 * `planeLike` (sketch planes, offset planes, up-to targets): only the plane of a face matters, so
 * ambiguity among coplanar planar faces with the same outward normal is not ambiguity — any of
 * them yields the identical plane, and the nearest is returned.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { EntityRef, Fingerprint, ShapeFingerprints, Vec3 } from '@whittle/contracts';
import { dist, dot, normalize } from './geometry';

export type SubKind = 'face' | 'edge' | 'vertex';

/** One named sub-shape a reference may resolve to. */
export interface Candidate {
  shape: number;
  kind: SubKind;
  index: number;
  name: string;
  /** Who owns the shape: a body id (`B…`), or `sketch:<id>` / `plane:<id>`. */
  owner: string;
}

export interface ResolvedTarget extends Candidate {
  /** How it was resolved (for diagnostics / healing stale refs). */
  via: 'name' | 'name+fingerprint' | 'fingerprint';
}

export type Resolution =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; reason: 'missing' | 'ambiguous'; candidates?: string[] };

export interface ResolveContext {
  /** Part bounding-box diagonal (mm) the tolerances scale with. */
  diag: number;
  /** Only the supporting plane matters (sketch planes etc.). */
  planeLike?: boolean;
  /** Fingerprints of a candidate shape (cached by the caller); null when unavailable. */
  fingerprints(shape: number): Promise<ShapeFingerprints | null>;
}

export const TOLERANCE = {
  strictRel: 1e-3,
  strictAbs: 1e-6,
  strictNormalDot: 0.9999,
  strictMeasureRel: 1e-3,
  looseRel: 0.25,
  looseNormalDot: 0.95,
  marginRatio: 0.5,
  marginRel: 1e-3,
  /** planeLike: coplanar when offsets agree within this × diag (≥ 1e-6 mm). */
  coplanarRel: 1e-6,
} as const;

const SPLIT = /#\d+/;
const SPLITS = /#\d+/g;

/** Name with every `#k` split suffix removed (also inside `edge(…)` / `vertex(…)` names). */
export function baseName(name: string): string {
  return name.replace(SPLITS, '');
}

interface Measured {
  c: Candidate;
  centroid: Vec3;
  normal?: Vec3;
  measure?: number;
}

async function measure(c: Candidate, ctx: ResolveContext): Promise<Measured | null> {
  const fp = await ctx.fingerprints(c.shape);
  if (fp === null) return null;
  if (c.kind === 'face') {
    const f = fp.faces[c.index];
    if (!f) return null;
    return f.normal === undefined
      ? { c, centroid: f.centroid, measure: f.area }
      : { c, centroid: f.centroid, normal: f.normal, measure: f.area };
  }
  if (c.kind === 'edge') {
    const e = fp.edges[c.index];
    return e ? { c, centroid: e.centroid, measure: e.length } : null;
  }
  const v = fp.vertices[c.index];
  return v ? { c, centroid: v.point } : null;
}

const refMeasure = (fp: Fingerprint): number | undefined => fp.area ?? fp.length;

function relDiff(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12);
}

/** All measured candidates are planar with the same outward normal and plane offset. */
function coplanar(ms: Measured[], diag: number): boolean {
  const first = ms[0];
  if (!first?.normal) return false;
  const n = normalize(first.normal);
  const d0 = dot(first.centroid, n);
  const tol = Math.max(TOLERANCE.coplanarRel * diag, 1e-6);
  return ms.every(
    (m) =>
      m.normal !== undefined &&
      dot(normalize(m.normal), n) > 1 - 1e-9 &&
      Math.abs(dot(m.centroid, n) - d0) <= tol,
  );
}

async function measureAll(cands: Candidate[], ctx: ResolveContext): Promise<Measured[]> {
  const out: Measured[] = [];
  for (const c of cands) {
    const m = await measure(c, ctx);
    if (m) out.push(m);
  }
  return out;
}

/** Disambiguates a name family (or duplicate exact names) by fingerprint. */
async function disambiguate(
  ref: EntityRef,
  family: Candidate[],
  ctx: ResolveContext,
): Promise<Resolution> {
  const names = family.map((c) => c.name);
  const ms = await measureAll(family, ctx);
  if (ctx.planeLike && ms.length === family.length && coplanar(ms, ctx.diag)) {
    const fp = ref.fingerprint;
    const sorted = fp
      ? [...ms].sort((a, b) => dist(a.centroid, fp.centroid) - dist(b.centroid, fp.centroid))
      : ms;
    const best = sorted[0] as Measured;
    return { ok: true, target: { ...best.c, via: 'name+fingerprint' } };
  }
  const fp = ref.fingerprint;
  if (!fp) return { ok: false, reason: 'ambiguous', candidates: names };
  const loose = TOLERANCE.looseRel * ctx.diag;
  const scored = ms
    .filter(
      (m) =>
        fp.normal === undefined ||
        m.normal === undefined ||
        dot(normalize(fp.normal), normalize(m.normal)) >= TOLERANCE.looseNormalDot,
    )
    .map((m) => ({ m, d: dist(m.centroid, fp.centroid) }))
    .sort((a, b) => a.d - b.d);
  const best = scored[0];
  if (!best || best.d > loose) return { ok: false, reason: 'ambiguous', candidates: names };
  const next = scored[1];
  if (
    next &&
    !(best.d <= TOLERANCE.marginRatio * next.d && next.d - best.d >= TOLERANCE.marginRel * ctx.diag)
  ) {
    return { ok: false, reason: 'ambiguous', candidates: names };
  }
  return { ok: true, target: { ...best.m.c, via: 'name+fingerprint' } };
}

/** Fingerprint-only match within the strict tolerance. */
async function byFingerprint(
  ref: EntityRef,
  cands: Candidate[],
  ctx: ResolveContext,
): Promise<Resolution> {
  const fp = ref.fingerprint;
  if (!fp) return { ok: false, reason: 'missing' };
  const tol = Math.max(TOLERANCE.strictRel * ctx.diag, TOLERANCE.strictAbs);
  const want = refMeasure(fp);
  const hits: { m: Measured; d: number }[] = [];
  for (const m of await measureAll(cands, ctx)) {
    const d = dist(m.centroid, fp.centroid);
    if (d > tol) continue;
    if (fp.normal !== undefined && m.normal !== undefined) {
      if (dot(normalize(fp.normal), normalize(m.normal)) < TOLERANCE.strictNormalDot) continue;
    } else if ((fp.normal === undefined) !== (m.normal === undefined) && m.c.kind === 'face') {
      continue; // planar vs curved face
    }
    if (want !== undefined && m.measure !== undefined) {
      if (relDiff(want, m.measure) > TOLERANCE.strictMeasureRel) continue;
    }
    hits.push({ m, d });
  }
  if (hits.length === 0) return { ok: false, reason: 'missing' };
  if (
    hits.length === 1 ||
    (ctx.planeLike &&
      coplanar(
        hits.map((h) => h.m),
        ctx.diag,
      ))
  ) {
    hits.sort((a, b) => a.d - b.d);
    return { ok: true, target: { ...(hits[0] as { m: Measured }).m.c, via: 'fingerprint' } };
  }
  return { ok: false, reason: 'ambiguous', candidates: hits.map((h) => h.m.c.name) };
}

/** Resolves `ref` among `cands` (already filtered to the right kind and search space). */
export async function resolveRef(
  ref: EntityRef,
  cands: Candidate[],
  ctx: ResolveContext,
): Promise<Resolution> {
  const exact = cands.filter((c) => c.name === ref.name);
  const base = baseName(ref.name);
  const family = cands.filter((c) => baseName(c.name) === base);
  if (exact.length === 1) {
    const only = exact[0] as Candidate;
    if (SPLIT.test(ref.name) && ref.fingerprint && family.length > 1) {
      const d = await disambiguate(ref, family, ctx);
      if (d.ok) return d;
    }
    return { ok: true, target: { ...only, via: 'name' } };
  }
  if (exact.length > 1) return disambiguate(ref, exact, ctx);
  if (family.length > 1) return disambiguate(ref, family, ctx);
  if (family.length === 1) {
    const only = family[0] as Candidate;
    // `X#k` → only `X` left: the split pieces merged back into one entity.
    if (!SPLIT.test(only.name)) return { ok: true, target: { ...only, via: 'name' } };
    // `X#k` → only `X#j` left: one piece vanished; accept only on strict fingerprint evidence
    // (the surviving piece may well be a different one).
    const d = await byFingerprint(ref, family, ctx);
    return d.ok ? d : { ok: false, reason: 'missing' };
  }
  return byFingerprint(ref, cands, ctx);
}
