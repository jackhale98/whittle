/**
 * Reference resolution against the walk state (PLAN §7.3): the candidates of a stored
 * `EntityRef` among the bodies, sketches and planes built so far, resolved by resolve.ts
 * (exact name, then name + fingerprint, then fingerprint, else unresolved: never guessed),
 * with rebound refs and `lastKnown` fingerprints recorded for the app. Names a boolean merged into
 * another face resolve to it through the kernel's merge aliases, reported as `merged` (ADR-078).
 * Also the plane-, axis-
 * and point-like references of the M3 reference geometry, and body scopes.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  BodyScope,
  EntityRef,
  Fingerprint,
  Frame,
  KernelError,
  NamingMap,
  ShapeFingerprints,
  ShapeHandle,
  UnresolvedRef,
  Vec3,
} from '@wren-cad/contracts';
import type { EngineCore } from './core';
import { frameLine, type Line } from './datums';
import {
  type Box3,
  boxDiagonal,
  emptyBox,
  extendBox,
  normalize,
  ORIGIN_AXES,
  ORIGIN_PLANES,
  planeFrame,
  sub,
} from './geometry';
import { kerr, meshOnlyError } from './helpers';
import { mentionsImport } from './imports';
import {
  baseName,
  type Candidate,
  containsLocation,
  type Resolution,
  type ResolvedTarget,
  resolveRef,
  type SubKind,
} from './resolve';
import {
  type BodyState,
  type ModelState,
  mergeLookup,
  primaryNaming,
  type WalkContext,
} from './state';
import type { ReboundRef, RegenUnresolvedRef } from './types';

export const SKETCH_TAG = /^S([0-9A-Za-z]+):/;

export const PLANE_NAME = /^F([0-9A-Za-z]+):plane$/;

export const AXIS_NAME = /^F([0-9A-Za-z]+):axis$/;

export const POINT_NAME = /^F([0-9A-Za-z]+):point$/;

export async function partDiag(core: EngineCore, ctx: WalkContext): Promise<number> {
  if (ctx.diag && ctx.diag.version === ctx.state.version) return ctx.diag.value;
  const box: Box3 = emptyBox();
  const shapes =
    ctx.state.bodies.size > 0
      ? [...ctx.state.bodies.values()].map((b) => b.shape)
      : [...ctx.state.sketches.values()].map((s) => s.shape);
  for (const s of shapes) {
    const fp = await core.fingerprints(s);
    for (const v of fp?.vertices ?? []) extendBox(box, v.point);
    for (const f of fp?.faces ?? []) extendBox(box, f.centroid);
  }
  const d = boxDiagonal(box);
  const value = d > 1e-9 ? d : 100;
  ctx.diag = { version: ctx.state.version, value };
  return value;
}

function candidates(ctx: WalkContext, ref: EntityRef, kind: SubKind): Candidate[] {
  const fromMap = (shape: ShapeHandle, naming: NamingMap, owner: string): Candidate[] =>
    naming
      .filter((n) => n.kind === kind)
      .map((n) => ({ shape, kind, index: n.index, name: n.name, owner }));
  const sk = SKETCH_TAG.exec(ref.name);
  if (sk || ref.kind === 'region') {
    const id = sk?.[1];
    const s = id === undefined ? undefined : ctx.state.sketches.get(id);
    return s ? fromMap(s.shape, s.naming, `sketch:${s.id}`) : [];
  }
  const pl = PLANE_NAME.exec(ref.name);
  if (pl) {
    const p = ctx.state.planes.get(pl[1] as string);
    return p ? fromMap(p.shape, p.naming, `plane:${p.id}`) : [];
  }
  // Bodies: primary names only. A body naming map lists the names a boolean merged away after
  // them (aliases of the surviving sub-shape); those resolve through `resolveWithMerges`, reported.
  const out: Candidate[] = [];
  for (const b of ctx.state.bodies.values()) {
    out.push(...fromMap(b.shape, primaryNaming(b.naming), b.id));
  }
  return out;
}

/**
 * Resolution with the walk's merge table (PLAN §7.3, ADR-078), in this order:
 *  1. a current primary name equal to the ref's wins: an alias never shadows a primary name;
 *  2. a name that was merged into different sub-shapes (two features listed it for different
 *     survivors, or a survivor on its chain was) is unresolved: `ambiguous`, with the survivors as
 *     candidates; neither is picked, and no fingerprint guess replaces it;
 *  3. a merged name resolves to its survivor (nearest in the chain first), keeping the ref's
 *     fingerprint for split survivors, among the survivor's name family only (exact or `#k`; never
 *     a fingerprint-only match); the caller reports it as `merged`;
 *  4. otherwise resolve.ts (name family, fingerprint, else unresolved).
 */
export async function resolveWithMerges(
  ref: EntityRef,
  kind: SubKind,
  cands: Candidate[],
  state: ModelState,
  rc: Parameters<typeof resolveRef>[2],
): Promise<Resolution> {
  if (cands.some((c) => c.name === ref.name)) return resolveRef(ref, cands, rc);
  const m = mergeLookup(state, kind, ref.name);
  if (m.conflict) return { ok: false, reason: 'ambiguous', candidates: m.conflict };
  for (const into of m.chain) {
    const family = cands.filter((c) => baseName(c.name) === baseName(into));
    if (family.length === 0) continue;
    const r = await resolveRef({ ...ref, name: into }, family, rc);
    if (r.ok) return { ok: true, target: { ...r.target, via: 'merged' } };
  }
  return resolveRef(ref, cands, rc);
}

/** Resolves a face/edge/vertex/region ref; records unresolved refs under `path`. */
export async function resolveSub(
  core: EngineCore,
  ctx: WalkContext,
  ref: EntityRef,
  path: string,
  unresolved: UnresolvedRef[],
  planeLike = false,
): Promise<ResolvedTarget | null> {
  const kind = refKind(ref);
  if (kind === 'body') {
    unresolved.push({ path, ref, reason: 'missing' });
    return null;
  }
  const cands = candidates(ctx, ref, kind);
  const rc = {
    diag: await partDiag(core, ctx),
    planeLike,
    fingerprints: (s: ShapeHandle) => core.fingerprints(s),
    weak: (name: string) => mentionsImport(name, ctx.importIds),
    distance: async (c: Candidate, point: Vec3) => {
      const m = await core.kernel.measureShapes(
        { shape: c.shape, kind: c.kind, index: c.index },
        { point },
      );
      return m.ok ? (m.value.distance?.value ?? null) : null;
    },
  };
  // Order (PLAN §7.3, ADR-078): exact name, then a merge alias (history evidence; conflicting
  // aliases are unresolved), then the name family and fingerprints (resolve.ts).
  const r = await resolveWithMerges(ref, kind, cands, ctx.state, rc);
  const memo = `${ctx.current.featureId}|${path}`;
  if (r.ok) {
    const t = r.target;
    ctx.pc.lastResolved.set(memo, { shape: t.shape, kind: t.kind, index: t.index });
    if (t.name === ref.name && t.via === 'name') return t;
    if (t.via === 'merged') {
      // Reported, not healed: the stored name stays valid (and returns to its own face if an
      // upstream edit un-merges it).
      ctx.current.merged.push({ path, name: ref.name, into: t.name });
      return t;
    }
    const fp = await core.fingerprints(t.shape);
    const now = fp ? fingerprintOf(fp, t.kind, t.index) : undefined;
    // Rebound: the name changed, or fingerprint evidence picked it and the stored fingerprint
    // is out of date (the app heals both).
    const stale = !ref.fingerprint || !now || !sameFingerprint(ref.fingerprint, now);
    // Never heal a stored name onto an entity that doesn't contain where the ref was recorded
    // (the app writes rebound names into the document). Imported (weak) names are geometric
    // order and are re-recorded after a file replacement, so they keep healing.
    const renamedOff =
      t.name !== ref.name &&
      ref.fingerprint !== undefined &&
      now !== undefined &&
      !rc.weak(ref.name) &&
      (await containsLocation(
        ref.fingerprint,
        { c: t, centroid: now.centroid, ...(now.normal ? { normal: now.normal } : {}) },
        rc,
      )) === false;
    if (!renamedOff && (t.name !== ref.name || stale)) {
      const rebound: ReboundRef = { path, name: t.name };
      if (now) rebound.fingerprint = now;
      ctx.current.rebound.push(rebound);
    }
    return t;
  }
  const u: RegenUnresolvedRef = { path, ref, reason: r.reason };
  if (r.candidates) u.candidates = r.candidates;
  const last = ctx.pc.lastResolved.get(memo);
  if (last && !ref.fingerprint && core.ownedHandles.has(last.shape)) {
    const fp = await core.fingerprints(last.shape);
    const lastKnown = fp ? fingerprintOf(fp, last.kind, last.index) : undefined;
    if (lastKnown) u.lastKnown = lastKnown;
  }
  unresolved.push(u);
  return null;
}

export function resolveBody(
  ctx: WalkContext,
  ref: EntityRef,
  path: string,
  unresolved: UnresolvedRef[],
): BodyState | null {
  const b = ctx.state.bodies.get(ref.name);
  if (b) return b;
  unresolved.push({ path, ref, reason: 'missing' });
  return null;
}

/** A resolved planar face/plane ref → deterministic frame (see `planeFrame`). */
async function frameOfTarget(core: EngineCore, t: ResolvedTarget): Promise<Frame | KernelError> {
  if (t.kind !== 'face')
    return kerr('INVALID_INPUT', 'Pick a flat face or a plane', { entityRefs: [t.name] });
  const fp = await core.fingerprints(t.shape);
  const face = fp?.faces[t.index];
  if (!face?.normal) {
    return kerr('INVALID_INPUT', 'The selected face is not flat', {
      hint: 'Pick a planar face or a plane.',
      entityRefs: [t.name],
    });
  }
  return planeFrame(face.centroid, face.normal);
}

/**
 * A plane-like ref (sketch `on`, plane `from`, extrude up-to): origin planes and construction
 * planes by name, faces by planeLike resolution. Returns the frame, or null when unresolved.
 */
export async function resolvePlane(
  core: EngineCore,
  ctx: WalkContext,
  ref: EntityRef,
  path: string,
  unresolved: UnresolvedRef[],
): Promise<{ frame: Frame; target?: ResolvedTarget; shapeKey: string } | KernelError | null> {
  const origin = ORIGIN_PLANES[ref.name];
  if (origin) return { frame: origin, shapeKey: ref.name };
  const pl = PLANE_NAME.exec(ref.name);
  if (pl) {
    const p = ctx.state.planes.get(pl[1] as string);
    if (p) {
      return {
        frame: p.frame,
        target: {
          shape: p.shape,
          kind: 'face',
          index: 0,
          name: ref.name,
          owner: `plane:${p.id}`,
          via: 'name',
        },
        shapeKey: p.key,
      };
    }
  }
  const t = await resolveSub(core, ctx, ref, path, unresolved, true);
  if (!t) return null;
  if (t.owner.startsWith('plane:')) {
    // Construction planes carry their own frame.
    const p = ctx.state.planes.get(t.owner.slice('plane:'.length));
    if (p) return { frame: p.frame, target: t, shapeKey: p.key };
  }
  const frame = await frameOfTarget(core, t);
  if ('code' in frame) return frame;
  return { frame, target: t, shapeKey: ctx.state.keyOf(t.shape) ?? '' };
}

export function refKeyOf(ctx: WalkContext, t: ResolvedTarget): [string, string, number] {
  return [ctx.state.keyOf(t.shape) ?? '', t.kind, t.index];
}

/** Body scope of a solid feature: explicit bodies, all, or the default "touched" scope. */
export function scopeBodies(
  ctx: WalkContext,
  scope: BodyScope | undefined,
  unresolved: UnresolvedRef[],
): { bodies: BodyState[]; mode: 'default' | 'all' | 'bodies'; error?: KernelError } {
  if (scope?.kind === 'bodies') {
    const bodies: BodyState[] = [];
    scope.bodies.forEach((ref, i) => {
      const b = resolveBody(ctx, ref, `/scope/bodies/${i}`, unresolved);
      if (b) bodies.push(b);
    });
    const mesh = bodies.find((b) => b.meshOnly);
    if (mesh) return { bodies, mode: 'bodies', error: meshOnlyError('changed', mesh.id) };
    return { bodies, mode: 'bodies' };
  }
  // Mesh reference bodies are never part of an implicit scope.
  return {
    bodies: [...ctx.state.bodies.values()].filter((b) => !b.meshOnly),
    mode: scope?.kind === 'all' ? 'all' : 'default',
  };
}

/**
 * An axis-like reference → a line: origin axes, axis features (`F…:axis`), straight edges (in
 * their geometric-key direction), circular edges and cylindrical faces (their axis, canonical
 * direction). With `planeNormal` (linear pattern directions) planes and flat faces give their
 * normal, and circular edges are refused (no direction).
 */
export async function resolveAxis(
  core: EngineCore,
  ctx: WalkContext,
  ref: EntityRef,
  path: string,
  unresolved: UnresolvedRef[],
  planeNormal: boolean,
): Promise<{ line: Line; owner?: string } | KernelError | null> {
  const origin = ORIGIN_AXES[ref.name];
  if (origin) return { line: frameLine(origin) };
  const ax = AXIS_NAME.exec(ref.name);
  if (ax) {
    const d = ctx.state.datums.get(ax[1] as string);
    if (d?.kind === 'axis') return { line: frameLine(d.frame) };
    unresolved.push({ path, ref, reason: 'missing' });
    return null;
  }
  const bad = (message: string) =>
    kerr('INVALID_INPUT', message, {
      hint: planeNormal
        ? 'Pick a straight edge, an axis, a plane or a flat face.'
        : 'Pick an axis, a straight or circular edge, or a cylindrical face.',
      entityRefs: [ref.name],
    });
  if (ORIGIN_PLANES[ref.name] || PLANE_NAME.test(ref.name)) {
    if (!planeNormal) return bad('A plane is not an axis');
    const p = await resolvePlane(core, ctx, ref, path, unresolved);
    if (!p || 'code' in p) return p;
    const out: { line: Line; owner?: string } = { line: frameLine(p.frame) };
    if (p.target?.owner) out.owner = p.target.owner;
    return out;
  }
  const t = await resolveSub(core, ctx, ref, path, unresolved);
  if (!t) return null;
  if (t.kind === 'edge') {
    const l = await core.lineOfEdge(t);
    if (l) return { line: { origin: l.a, dir: normalize(sub(l.b, l.a)) }, owner: t.owner };
    const c = await core.circleOfEdge(t);
    if (c) {
      if (planeNormal) return bad('A circular edge has no direction; pick a straight edge');
      return { line: { origin: c.centre, dir: c.normal }, owner: t.owner };
    }
    return bad('This edge is neither straight nor circular');
  }
  if (t.kind === 'face') {
    const fp = await core.fingerprints(t.shape);
    const face = fp?.faces[t.index];
    if (face?.normal) {
      if (!planeNormal) return bad('A flat face has no axis');
      return { line: { origin: face.centroid, dir: normalize(face.normal) }, owner: t.owner };
    }
    const a = await core.axisOfFace(t);
    if (a) return { line: { origin: a.origin, dir: a.dir }, owner: t.owner };
    return bad('This face has no axis');
  }
  return bad('A vertex has no direction');
}

/**
 * A point-like reference → a world point: `origin:O`, point features (`F…:point`), vertices and
 * sketch points (`S…:p(id)`), and circular edges (their centre).
 */
export async function resolvePoint(
  core: EngineCore,
  ctx: WalkContext,
  ref: EntityRef,
  path: string,
  unresolved: UnresolvedRef[],
): Promise<{ point: Vec3; owner?: string } | KernelError | null> {
  if (ref.name === 'origin:O') return { point: [0, 0, 0] };
  const pm = POINT_NAME.exec(ref.name);
  if (pm) {
    const d = ctx.state.datums.get(pm[1] as string);
    if (d?.kind === 'point') return { point: d.frame.origin };
    unresolved.push({ path, ref, reason: 'missing' });
    return null;
  }
  const t = await resolveSub(core, ctx, ref, path, unresolved);
  if (!t) return null;
  if (t.kind === 'vertex') {
    const fp = await core.fingerprints(t.shape);
    const v = fp?.vertices[t.index];
    if (v) return { point: v.point, owner: t.owner };
  }
  if (t.kind === 'edge') {
    const c = await core.circleOfEdge(t);
    if (c) return { point: c.centre, owner: t.owner };
  }
  return kerr('INVALID_INPUT', 'Pick a point, a vertex or a circular edge (its centre)', {
    entityRefs: [ref.name],
  });
}

/** A line or a plane (for intersection points). */
export async function resolveLineOrPlane(
  core: EngineCore,
  ctx: WalkContext,
  ref: EntityRef,
  path: string,
  unresolved: UnresolvedRef[],
): Promise<{ line: Line } | { plane: Frame } | KernelError | null> {
  if (ORIGIN_PLANES[ref.name] || PLANE_NAME.test(ref.name) || ref.kind === 'face') {
    const p = await resolvePlane(core, ctx, ref, path, unresolved);
    if (!p || 'code' in p) return p;
    return { plane: p.frame };
  }
  const a = await resolveAxis(core, ctx, ref, path, unresolved, false);
  if (!a || 'code' in a) return a;
  return { line: a.line };
}

function refKind(ref: EntityRef): SubKind | 'body' {
  return ref.kind === 'region' ? 'face' : ref.kind;
}

/** The fingerprint stored with a ref to sub-shape `index` of `kind`. */
export function fingerprintOf(
  fp: ShapeFingerprints,
  kind: SubKind,
  index: number,
): Fingerprint | undefined {
  if (kind === 'face') {
    const f = fp.faces[index];
    if (!f) return undefined;
    return f.normal
      ? { centroid: f.centroid, normal: f.normal, area: f.area }
      : { centroid: f.centroid, area: f.area };
  }
  if (kind === 'edge') {
    const e = fp.edges[index];
    return e ? { centroid: e.centroid, length: e.length } : undefined;
  }
  const v = fp.vertices[index];
  return v ? { centroid: v.point } : undefined;
}

/** Equal up to float noise (1e-6 mm, 1e-9 relative). */
function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) <= 1e-6 + 1e-9 * Math.abs(x);
  const vec = (x: Vec3 | undefined, y: Vec3 | undefined) =>
    x === undefined || y === undefined ? x === y : x.every((v, i) => close(v, y[i] as number));
  const num = (x: number | undefined, y: number | undefined) =>
    x === undefined || y === undefined ? x === y : close(x, y);
  return (
    vec(a.centroid, b.centroid) &&
    vec(a.normal, b.normal) &&
    num(a.area, b.area) &&
    num(a.length, b.length)
  );
}
