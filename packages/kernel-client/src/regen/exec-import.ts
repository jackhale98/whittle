/**
 * Import features: STEP/IGES/BREP solids (named by the kernel `import` feature) and mesh
 * reference bodies (STL/OBJ/3MF/GLB), cached per part by sha256.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Frame,
  ImportFeature,
  KernelError,
  NamingMap,
  ResolvedRef,
  Result,
  ShapeHandle,
  UnresolvedRef,
  Vec3,
} from '@wren-cad/contracts';
import { IoError, importMesh, meshToStl } from '@wren-cad/io';
import type { EngineCore } from './core';
import { sameSolid } from './exec-solids';
import { boxDiagonal, boxesOverlap, emptyBox, extendBox } from './geometry';
import { hashKey } from './hash';
import { hasFreeEdges, kerr } from './helpers';
import {
  compareGeoKey,
  frameMatrix,
  isIdentity,
  type Matrix34,
  placeMesh,
  sha256Hex,
} from './imports';
import { scopeBodies } from './refs';
import type { BodyState, EntryResult, Planned, RawImport, WalkContext } from './state';

const MESH_FORMATS: ReadonlySet<ImportFeature['source']['format']> = new Set([
  'stl',
  'obj',
  '3mf',
  'glb',
]);

const IDENTITY_FRAME: Frame = { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] };

export async function planImport(
  core: EngineCore,
  ctx: WalkContext,
  f: ImportFeature,
): Promise<Planned> {
  const unresolved: UnresolvedRef[] = [];
  const format = f.source.format;
  const taintNew = [`B${f.id}`];
  const meshFormat = MESH_FORMATS.has(format);
  if (meshFormat && f.op !== 'new') {
    return {
      unresolved,
      taint: taintNew,
      error: kerr('INVALID_INPUT', 'A mesh file can only be imported as a new reference body', {
        hint: 'Set the operation to New, or import a STEP file to combine it with bodies.',
      }),
    };
  }
  const m = frameMatrix(f.frame ?? IDENTITY_FRAME);
  if (!m) {
    return {
      unresolved,
      taint: taintNew,
      error: kerr('INVALID_INPUT', 'The placement of the imported file is invalid', {
        hint: 'Use non-zero, non-parallel Z and X directions.',
      }),
    };
  }
  const sha = f.source.sha256.toLowerCase();
  ctx.usedImports.add(sha);
  const scoped =
    f.op === 'new'
      ? { bodies: [] as BodyState[], mode: 'bodies' as const }
      : scopeBodies(ctx, f.scope, unresolved);
  if ('error' in scoped && scoped.error) {
    return { unresolved, taint: scoped.bodies.map((b) => b.id), error: scoped.error };
  }
  const taint = f.op === 'new' ? taintNew : scoped.bodies.map((b) => b.id);
  const involved = new Set<string>();
  if (scoped.mode === 'bodies') for (const b of scoped.bodies) involved.add(b.id);
  else if (f.op !== 'new') {
    for (const t of ctx.tainted.keys()) if (!ctx.state.bodies.has(t)) involved.add(t);
  }
  const key = hashKey({
    t: 'import',
    id: f.id,
    sha,
    format,
    placement: m,
    op: f.op,
    scope: scoped.mode,
    bodies: scoped.bodies.map((b) => [b.id, b.key]),
  });
  return {
    unresolved,
    taint,
    plan: {
      key,
      involved: [...involved],
      reads: scoped.bodies.map((b) => b.id),
      run: () => runImport(core, ctx, f, m, scoped, key),
    },
  };
}

/** The attachment's raw shapes/meshes: from the per-part cache by sha256, else from the request. */
async function rawImport(
  core: EngineCore,
  ctx: WalkContext,
  f: ImportFeature,
): Promise<Result<RawImport>> {
  const sha = f.source.sha256.toLowerCase();
  const format = f.source.format;
  const cached = ctx.pc.imports.get(sha);
  if (cached && cached.format === format) return { ok: true, value: cached };
  const bytes = ctx.attachments[f.source.path];
  const label = f.source.fileName || f.source.path;
  if (!bytes) {
    return {
      ok: false,
      error: kerr('INVALID_INPUT', 'The imported file is missing from this project', {
        hint: `Import ${label} again.`,
        detail: `attachment ${f.source.path} (sha256 ${sha}) was not provided`,
      }),
    };
  }
  const actual = await sha256Hex(bytes);
  if (actual !== sha) {
    return {
      ok: false,
      error: kerr(
        'INVALID_INPUT',
        'The imported file has changed since it was imported (its checksum does not match)',
        {
          hint: `Import ${label} again.`,
          detail: `sha256 of ${f.source.path}: ${actual}, expected ${sha}`,
        },
      ),
    };
  }
  const raw: RawImport = { sha, format, shapes: [], meshes: [], lastUsed: ctx.pc.tick };
  if (MESH_FORMATS.has(format)) {
    try {
      raw.meshes = importMesh(bytes, f.source.fileName || `import.${format}`).map((x) => x.mesh);
    } catch (e) {
      return {
        ok: false,
        error: kerr(
          'INVALID_INPUT',
          e instanceof IoError ? e.message : 'The mesh file could not be read',
          {
            detail: String(e),
          },
        ),
      };
    }
    if (raw.meshes.length === 0) {
      return { ok: false, error: kerr('INVALID_INPUT', 'The mesh file contains no triangles') };
    }
  } else {
    // IGES (M3): the kernel sews loose faces; closed shells become solids, open ones stay
    // shell bodies (whittle_io.cpp importIges).
    const r = await core.kernel.importShapes(
      bytes,
      format === 'brep' ? 'brep' : format === 'iges' ? 'iges' : 'step',
    );
    if (!r.ok) return r;
    raw.shapes = r.value.map((b) => b.shape);
    for (const h of raw.shapes) core.ownedHandles.add(h);
    if (raw.shapes.length === 0) {
      return { ok: false, error: kerr('INVALID_INPUT', 'The file contains no solids') };
    }
  }
  if (cached) await core.releaseRaw(cached);
  ctx.pc.imports.set(sha, raw);
  return { ok: true, value: raw };
}

/**
 * Placed, named B-rep bodies of an import (fresh handles the caller owns) from the kernel's
 * `import` feature (ADR-039 item 11): the raw shapes go in as `shapes["source:<k>"]` in file
 * order, the kernel moves them by the frame (shared geometry, no re-import) and names faces
 * `F<id>:face#k` per body by geometric key, edges and vertices from their adjacent faces.
 * Bodies come back ordered by the geometric key of their volume centroids (`shape` first, then
 * `bodies` keyed `body#k`). These are the names the M1 engine gave, so stored references keep
 * resolving (ADR-044; test/regen/import-naming.test.ts).
 */
async function namedSolids(
  core: EngineCore,
  f: ImportFeature,
  raw: RawImport,
  m: Matrix34,
): Promise<
  Result<{ bodies: { shape: ShapeHandle; naming: NamingMap }[]; warnings: KernelError[] }>
> {
  const width = Math.max(4, String(raw.shapes.length - 1).length);
  const shapes: Record<string, ShapeHandle> = {};
  raw.shapes.forEach((h, i) => {
    shapes[`source:${String(i).padStart(width, '0')}`] = h;
  });
  // The frame as the engine validated and orthonormalised it (frameMatrix columns).
  const frame: Frame = {
    origin: [m[3], m[7], m[11]],
    z: [m[2], m[6], m[10]],
    x: [m[0], m[4], m[8]],
  };
  const { scope: _scope, ...feature } = f;
  const r = await core.exec({ ...feature, op: 'new', frame }, { values: {}, shapes });
  if (!r.ok) return r;
  const rank = (key: string) => Number(/^body#(\d+)$/.exec(key)?.[1] ?? Number.NaN);
  const extra = [...(r.value.bodies ?? [])];
  if (extra.some((b) => !Number.isInteger(rank(b.key)))) {
    for (const b of extra) await core.releaseHandle(b.shape);
    await core.releaseHandle(r.value.shape);
    return {
      ok: false,
      error: kerr('INTERNAL', 'The imported bodies could not be ordered', {
        detail: `kernel body keys: ${extra.map((b) => b.key).join(', ')}`,
      }),
    };
  }
  extra.sort((a, b) => rank(a.key) - rank(b.key));
  const bodies = [
    { shape: r.value.shape, naming: r.value.naming },
    ...extra.map((b) => ({ shape: b.shape, naming: b.naming })),
  ];
  return { ok: true, value: { bodies, warnings: r.value.warnings } };
}

/** Mesh reference bodies (fresh handles): placed in TS, handed to the kernel as STL. */
async function meshBodies(
  core: EngineCore,
  f: ImportFeature,
  raw: RawImport,
  m: Matrix34,
): Promise<Result<{ shape: ShapeHandle; naming: NamingMap }[]>> {
  const placed = raw.meshes.map((mesh) => (isIdentity(m) ? mesh : placeMesh(mesh, m)));
  const order = placed
    .map((mesh, i) => ({
      mesh,
      i,
      c: [0, 1, 2].map(
        (k) => ((mesh.bbox.min[k] as number) + (mesh.bbox.max[k] as number)) / 2,
      ) as Vec3,
    }))
    .sort((a, b) => compareGeoKey(a.c, b.c) || a.i - b.i);
  const out: { shape: ShapeHandle; naming: NamingMap }[] = [];
  for (const o of order) {
    const r = await core.kernel.importShapes(meshToStl([{ name: 'mesh', mesh: o.mesh }]), 'stl');
    if (!r.ok) {
      for (const x of out) await core.releaseHandle(x.shape);
      return r;
    }
    for (const b of r.value)
      out.push({ shape: b.shape, naming: [{ name: `F${f.id}:face`, kind: 'face', index: 0 }] });
  }
  return { ok: true, value: out };
}

async function runImport(
  core: EngineCore,
  ctx: WalkContext,
  f: ImportFeature,
  m: Matrix34,
  scoped: { bodies: BodyState[]; mode: 'default' | 'all' | 'bodies' },
  key: string,
): Promise<{ result: EntryResult; owned: ShapeHandle[]; transient?: boolean }> {
  const fail = (error: KernelError) => ({ result: { ok: false as const, error }, owned: [] });
  const raw = await rawImport(core, ctx, f);
  // Missing/mismatching attachments are not cached: the next request may carry the file.
  if (!raw.ok) return { ...fail(raw.error), transient: true };
  const meshOnly = raw.value.meshes.length > 0;
  let tools: { shape: ShapeHandle; naming: NamingMap }[];
  let warnings: KernelError[] = [];
  if (meshOnly) {
    const r = await meshBodies(core, f, raw.value, m);
    if (!r.ok) return fail(r.error);
    tools = r.value;
  } else {
    const r = await namedSolids(core, f, raw.value, m);
    if (!r.ok) return fail(r.error);
    tools = r.value.bodies;
    warnings = r.value.warnings;
  }
  const bodyId = (k: number) => (tools.length === 1 ? `B${f.id}` : `B${f.id}#${k}`);
  // Open surfaces (IGES surface models whose faces do not close, loose faces): never passed
  // off as solids. Their volume and mass mean nothing, and booleans with them are refused.
  const open: string[] = [];
  if (!meshOnly) {
    for (const [k, t] of tools.entries()) {
      const fp = await core.fingerprints(t.shape);
      if (hasFreeEdges(t.naming, f.id, fp)) open.push(bodyId(k));
    }
  }
  if (open.length > 0) {
    const what =
      open.length === tools.length ? 'The imported file has' : 'Some imported bodies have';
    if (f.op !== 'new') {
      for (const t of tools) await core.releaseHandle(t.shape);
      return fail(
        kerr(
          'INVALID_INPUT',
          `${what} open surfaces, so it cannot ${f.op === 'add' ? 'add to' : f.op} a body`,
          {
            hint: 'Set the operation to New, or close the gaps (or export a solid) in the other program.',
            entityRefs: open,
          },
        ),
      );
    }
    warnings.push(
      kerr('OPERATION_FAILED', `${what} open surfaces, not closed solids`, {
        hint: 'Their volume and mass are not meaningful. Close the gaps or export a solid in the other program.',
        entityRefs: open,
      }),
    );
  }
  const asNew = (extra: KernelError[]) => {
    const set: BodyState[] = tools.map((t, k) => {
      const id = bodyId(k);
      const b: BodyState = { id, shape: t.shape, naming: t.naming, key: `${key}/${id}` };
      if (meshOnly) b.meshOnly = true;
      return b;
    });
    return {
      result: {
        ok: true as const,
        set,
        remove: [],
        touched: [],
        warnings: [...extra, ...warnings],
      },
      owned: tools.map((t) => t.shape),
    };
  };
  if (f.op === 'new') return asNew([]);

  const dropTools = async () => {
    for (const t of tools) await core.releaseHandle(t.shape);
  };
  let candidates = scoped.bodies;
  if (scoped.mode === 'default' && candidates.length > 0) {
    const tb = emptyBox();
    for (const t of tools) {
      const mp = await core.massOf(t.shape);
      if (mp) {
        extendBox(tb, mp.bbox.min);
        extendBox(tb, mp.bbox.max);
      }
    }
    const tol = 1e-6 * Math.max(1, boxDiagonal(tb));
    const kept: BodyState[] = [];
    for (const b of candidates) {
      const bb = await core.massOf(b.shape);
      if (!bb || boxesOverlap(bb.bbox, tb, tol)) kept.push(b);
    }
    candidates = kept;
  }
  if (candidates.length === 0) {
    if (f.op === 'add' && scoped.mode === 'default') {
      return asNew([
        kerr(
          'OPERATION_FAILED',
          scoped.bodies.length === 0
            ? 'There is no body to add to; created a new body'
            : 'The imported shape touches no body; created a new body',
        ),
      ]);
    }
    await dropTools();
    if (f.op === 'cut' && scoped.mode === 'default' && scoped.bodies.length > 0) {
      return {
        result: {
          ok: true,
          set: [],
          remove: [],
          touched: [],
          warnings: [kerr('OPERATION_FAILED', 'The imported shape does not touch any body')],
        },
        owned: [],
      };
    }
    return fail(
      kerr('INVALID_INPUT', `There is no body to ${f.op === 'add' ? 'add to' : f.op}`, {
        hint: 'Create a body first, or set the operation to New.',
      }),
    );
  }
  const booleanWith = (target: BodyState) => {
    const refs: Record<string, ResolvedRef> = {
      '/target': { shape: target.shape, kind: 'body', index: 0 },
    };
    tools.forEach((t, i) => {
      refs[`/tools/${i}`] = { shape: t.shape, kind: 'body', index: 0 };
    });
    const op = f.op === 'new' ? 'add' : f.op;
    return core.exec(
      {
        id: f.id,
        type: 'boolean',
        name: f.name,
        suppressed: false,
        op,
        target: { name: target.id, kind: 'body' },
        tools: tools.map((_, i) => ({ name: `tool${i}`, kind: 'body' as const })),
        keepTools: false,
      },
      { values: {}, refs },
    );
  };

  const set: BodyState[] = [];
  const owned: ShapeHandle[] = [];
  const touched: string[] = [];
  const targets = f.op === 'add' ? candidates.slice(0, 1) : candidates;
  if (f.op === 'add' && candidates.length > 1) {
    warnings.push(
      kerr(
        'OPERATION_FAILED',
        `The imported shape was merged into ${(candidates[0] as BodyState).id} only; it also touches ${candidates
          .slice(1)
          .map((b) => b.id)
          .join(', ')}`,
        { hint: 'Pick the bodies to merge with in the feature’s scope.' },
      ),
    );
  }
  let firstError: KernelError | null = null;
  for (const b of targets) {
    const r = await booleanWith(b);
    if (!r.ok) {
      firstError ??= r.error;
      if (scoped.mode === 'bodies' || f.op === 'add') break;
      continue;
    }
    for (const extra of r.value.bodies ?? []) await core.releaseHandle(extra.shape);
    if (
      f.op === 'cut' &&
      scoped.mode !== 'bodies' &&
      (await sameSolid(core, b.shape, r.value.shape))
    ) {
      await core.releaseHandle(r.value.shape);
      continue;
    }
    set.push({ id: b.id, shape: r.value.shape, naming: r.value.naming, key: `${key}/${b.id}` });
    owned.push(r.value.shape);
    touched.push(b.id);
    warnings.push(...r.value.warnings);
  }
  await dropTools();
  if (firstError && (scoped.mode === 'bodies' || f.op === 'add' || set.length === 0)) {
    for (const h of owned) await core.releaseHandle(h);
    return fail(firstError);
  }
  if (f.op === 'cut' && touched.length === 0) {
    warnings.push(kerr('OPERATION_FAILED', 'The imported shape does not touch any body'));
  }
  return { result: { ok: true, set, remove: [], touched, warnings }, owned };
}
