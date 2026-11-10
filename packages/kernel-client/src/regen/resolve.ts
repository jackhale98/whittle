/**
 * Persistent reference resolution (PLAN §7.3). Never guesses: a reference either resolves to
 * exactly one sub-shape by evidence that clearly singles it out, or it is reported unresolved
 * (`missing` / `ambiguous` with candidates) and the feature goes to "needs attention".
 *
 * Order:
 *  1. Exact name, exactly one match → resolved. (A `#k` split name — or a weak, imported name —
 *     is re-checked against its fingerprint when its family has several members; a clear
 *     fingerprint winner overrides the index; otherwise the exact name stands only while it is
 *     plausibly the same entity — near, normal agreeing and overlapping the old location — else
 *     unresolved.)
 *  2. Name family: the same name once every `#k` split suffix in it is ignored (the entity — or a
 *     face its edge/vertex name is built from — was split, or split pieces merged back), or several
 *     exact matches → disambiguate by fingerprint: nearest centroid
 *     among candidates whose normal agrees, accepted only within the loose tolerance and with a
 *     clear margin over every other member (normal-rejected ones included).
 *  3. No name match → fingerprint-only: candidates of the same kind within the strict tolerance
 *     (centroid, normal, area/length all agree); exactly one → resolved.
 *  4. Otherwise unresolved.
 *
 * Copies (M3 mirror / patterns, naming.ts): `F<p>:inst<k>(N)` and `F<p>:mirror(N)` are distinct
 * entities by construction. A fingerprint-only match (3) never lands on another instance of the
 * same source (`inst<j>` for a ref to `inst<k>`) nor on a copy of the referenced original — when a
 * pattern count drops or an index is skipped, a ref to the removed instance is unresolved even if
 * another copy now sits where it was.
 *
 * Tolerances are relative to `diag`, the diagonal of the part's current bounding box (all body
 * vertices; sketch geometry when there are no bodies):
 *  - strict (fingerprint-only): centroid within 1e-3·diag (≥ 1e-6 mm), normals within ~0.8°
 *    (dot ≥ 0.9999), area / length within 0.1 % relative;
 *  - loose (name family): centroid within 0.25·diag, normals within ~18° (dot ≥ 0.95);
 *  - margin: winner distance ≤ ½ × runner-up distance and ≥ 1e-3·diag apart;
 *  - weak names (imports): radius 0.1·diag, area/length within 25 %, planar vs curved must match.
 *
 * `planeLike` (sketch planes, offset planes, up-to targets): only the plane of a face matters, so
 * ambiguity among coplanar planar faces with the same outward normal is not ambiguity — any of
 * them yields the identical plane, and the nearest is returned.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { EntityRef, Fingerprint, ShapeFingerprints, Vec3 } from '@wren-cad/contracts';
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
  /**
   * How it was resolved (for diagnostics / healing stale refs). `merged`: a boolean merged the
   * stored name's face (edge, vertex) into another one, which it resolved to (refs.ts, ADR-076).
   */
  via: 'name' | 'name+fingerprint' | 'fingerprint' | 'merged';
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
  /**
   * Names whose `#k` indices are pure geometric order with no construction history behind them
   * (imported topology): the index alone is no evidence once the geometry may have changed.
   */
  weak?: (name: string) => boolean;
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
  /** Weak (imported) names: tighter family search radius and the measure must roughly agree. */
  weakRel: 0.1,
  weakMeasureRel: 0.25,
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

/** The candidate agrees with the ref's normal (weak names: planar vs curved must agree too). */
function normalAgrees(fp: Fingerprint, m: Measured, weak: boolean): boolean {
  if (fp.normal !== undefined && m.normal !== undefined) {
    return dot(normalize(fp.normal), normalize(m.normal)) >= TOLERANCE.looseNormalDot;
  }
  return !weak || m.c.kind !== 'face' || (fp.normal === undefined) === (m.normal === undefined);
}

/**
 * Disambiguates a name family (or duplicate exact names) by fingerprint: the nearest candidate
 * whose normal agrees, within the search radius, by a clear margin over **every** other member —
 * including members rejected for their normal (a nearer member facing the other way means the
 * evidence is contradictory, so it is ambiguous rather than a pick).
 */
async function disambiguate(
  ref: EntityRef,
  family: Candidate[],
  ctx: ResolveContext,
  weak = false,
  /** Weak names: also require the area/length to roughly agree (not for plane-like refs). */
  checkMeasure = weak,
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
  const radius = (weak ? TOLERANCE.weakRel : TOLERANCE.looseRel) * ctx.diag;
  const want = refMeasure(fp);
  const all = ms.map((m) => ({ m, d: dist(m.centroid, fp.centroid) })).sort((a, b) => a.d - b.d);
  const accepted = all.filter(
    ({ m }) =>
      normalAgrees(fp, m, weak) &&
      (!checkMeasure ||
        ctx.planeLike === true ||
        want === undefined ||
        m.measure === undefined ||
        relDiff(want, m.measure) <= TOLERANCE.weakMeasureRel),
  );
  const best = accepted[0];
  if (!best || best.d > radius) return { ok: false, reason: 'ambiguous', candidates: names };
  const next = all.find((x) => x !== best);
  if (
    next &&
    !(best.d <= TOLERANCE.marginRatio * next.d && next.d - best.d >= TOLERANCE.marginRel * ctx.diag)
  ) {
    return { ok: false, reason: 'ambiguous', candidates: names };
  }
  return { ok: true, target: { ...best.m.c, via: 'name+fingerprint' } };
}

/**
 * Could the exact-name candidate still be the referenced entity? Split names: within the family
 * search radius of the ref's fingerprint with an agreeing normal. Weak (imported) names: it must
 * be the clear nearest normal-compatible member of its family (its area/length may have changed,
 * e.g. through a downstream fillet).
 */
async function plausible(
  ref: EntityRef,
  only: Candidate,
  family: Candidate[],
  ctx: ResolveContext,
  weak: boolean,
): Promise<boolean> {
  const fp = ref.fingerprint;
  if (!fp) return true;
  if (weak) {
    const d = await disambiguate(ref, family, ctx, true, false);
    return d.ok && d.target.shape === only.shape && d.target.index === only.index;
  }
  const m = await measure(only, ctx);
  if (!m) return true;
  // The two entities must overlap: centroids no farther apart than their combined reach (the
  // "radius" their area/length implies). An index that moved to a piece elsewhere is no evidence.
  const reach = (kind: SubKind, v: number | undefined) =>
    v === undefined
      ? 0
      : kind === 'face'
        ? Math.sqrt(Math.abs(v))
        : kind === 'edge'
          ? Math.abs(v) / 2
          : 0;
  const overlap =
    reach(only.kind, refMeasure(fp)) +
    reach(only.kind, m.measure) +
    Math.max(TOLERANCE.strictRel * ctx.diag, TOLERANCE.strictAbs);
  const d = dist(m.centroid, fp.centroid);
  return d <= TOLERANCE.looseRel * ctx.diag && d <= overlap && normalAgrees(fp, m, false);
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

const INSTANCES = /:inst\d+\(/g;
const COPY_ROLE = /:(?:inst\d+|mirror)\(/;

/**
 * Is `cand` a different copy of what `ref` names: a sibling instance (`inst<j>` vs `inst<k>` of
 * the same source) or a copy (`…:inst<k>(N)`, `…:mirror(N)`) of the original `N` itself?
 */
export function isOtherCopy(refName: string, cand: string): boolean {
  if (cand === refName) return false;
  const generic = (n: string) => n.replace(INSTANCES, ':inst*(');
  if (generic(refName) !== refName && generic(refName) === generic(cand)) return true;
  return cand.endsWith(`(${refName})`) && COPY_ROLE.test(cand);
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
  const weak = ctx.weak?.(ref.name) === true;
  if (exact.length === 1) {
    const only = exact[0] as Candidate;
    if ((SPLIT.test(ref.name) || weak) && ref.fingerprint && family.length > 1) {
      const d = await disambiguate(ref, family, ctx, weak);
      if (d.ok) return d;
      // No clear fingerprint winner: the exact `#k` stands only while it is still plausibly the
      // same entity (an index silently moves to another piece when an earlier piece vanishes).
      if (!(await plausible(ref, only, family, ctx, weak))) {
        return d.candidates
          ? { ok: false, reason: 'ambiguous', candidates: d.candidates }
          : { ok: false, reason: 'missing' };
      }
    }
    return { ok: true, target: { ...only, via: 'name' } };
  }
  if (exact.length > 1) return disambiguate(ref, exact, ctx, weak);
  if (family.length > 1) return disambiguate(ref, family, ctx, weak);
  if (family.length === 1) {
    const only = family[0] as Candidate;
    // `X#k` → only `X` left: the split pieces merged back into one entity.
    if (!SPLIT.test(only.name) && !weak) return { ok: true, target: { ...only, via: 'name' } };
    // `X#k` → only `X#j` left: one piece vanished; accept only on strict fingerprint evidence
    // (the surviving piece may well be a different one). Weak (imported) names: likewise.
    const d = await byFingerprint(ref, family, ctx);
    if (d.ok) return d;
    if (weak && !ref.fingerprint && !SPLIT.test(only.name)) {
      return { ok: true, target: { ...only, via: 'name' } };
    }
    return { ok: false, reason: 'missing' };
  }
  return byFingerprint(
    ref,
    cands.filter((c) => !isOtherCopy(ref.name, c.name)),
    ctx,
  );
}
