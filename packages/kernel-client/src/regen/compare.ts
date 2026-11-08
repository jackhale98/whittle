/**
 * Geometric compare (PLAN §8A.3, ADR-020 item 8): the material version B adds to version A
 * (B − A) and the material it removes (A − B), computed by composing existing façade calls only:
 * the `boolean` feature through `execFeature` (fuse to union each side's solids, then cut),
 * `mesh`, `massProperties` and `release`. No façade (C++) changes.
 *
 * Every temporary shape is released before returning, also on failure. The diff meshes are fresh
 * buffers owned by the caller (transferred across the worker boundary, never copied).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  BooleanFeature,
  Feature,
  FeatureInputs,
  FeatureResult,
  GeometricDiff,
  KernelError,
  MassProperties,
  MeshBuffers,
  MeshOptions,
  NamingMap,
  Result,
  ShapeHandle,
  Vec3,
} from '@whittle/contracts';

/** The façade calls compare needs (the engine passes its name-translating `exec`). */
export interface DiffKernel {
  exec(feature: Feature, inputs: FeatureInputs): Promise<Result<FeatureResult>>;
  mesh(shape: ShapeHandle, options: MeshOptions): Promise<Result<MeshBuffers>>;
  massProperties(shape: ShapeHandle, density?: number): Promise<Result<MassProperties>>;
  release(shape: ShapeHandle): Promise<void>;
}

/** One side of a compare: the solid bodies of a slot's latest regen. */
export interface DiffSide {
  /** User-facing name of the side, e.g. "the live model" or "version 3f2a". */
  label: string;
  /** Solid bodies with their document naming (engine-owned shapes: never released here). */
  bodies: { shape: ShapeHandle; naming: NamingMap }[];
  /** Content keys of those bodies: equal sorted lists mean identical geometry. */
  keys: string[];
  /** kg/mm³ of the slot's part material, if any. */
  density?: number;
}

/**
 * `GeometricDiff` plus non-fatal warnings (bodies left out of the compare, e.g. mesh-only
 * reference bodies). Proposed for the contract, as `RegenFeatureStatus.warnings` was.
 */
export interface CompareOutput extends GeometricDiff {
  warnings?: KernelError[];
}

/**
 * A difference whose volume is at most this fraction of the larger side's volume is boolean
 * noise (slivers along coincident faces), reported as empty with volume 0.
 */
export const DIFF_NOISE = 1e-9;

/** Feature id used for the compare booleans (names are internal; diff meshes are unnamed regions). */
const COMPARE_ID = 'COMPARE';
const INTERNAL_PREFIX = `F${COMPARE_ID}:`;

const kerr = (code: KernelError['code'], message: string, extra: Partial<KernelError> = {}) =>
  ({ code, message, ...extra }) as KernelError;

function booleanFeature(op: BooleanFeature['op'], tools: number): BooleanFeature {
  return {
    id: COMPARE_ID,
    type: 'boolean',
    name: 'Compare',
    suppressed: false,
    op,
    target: { name: 'compare:target', kind: 'body' },
    tools: Array.from({ length: tools }, (_, i) => ({ name: `compare:tool${i}`, kind: 'body' })),
    keepTools: true,
  };
}

/** `inputs` for a boolean of `target` with `tools` (façade keys `tools…`, sorted). */
function booleanInputs(target: ShapeHandle, tools: ShapeHandle[]): FeatureInputs {
  const shapes: Record<string, ShapeHandle> = {};
  tools.forEach((t, i) => {
    shapes[`tools${String(i).padStart(4, '0')}`] = t;
  });
  return { target, shapes, values: {} };
}

const ZERO: Vec3 = [0, 0, 0];

function emptyMass(density: number | undefined): MassProperties {
  const m: MassProperties = {
    volume: 0,
    area: 0,
    centroid: [...ZERO],
    bbox: { min: [...ZERO], max: [...ZERO] },
    faceCount: 0,
    edgeCount: 0,
    vertexCount: 0,
  };
  if (density !== undefined && density > 0) {
    m.mass = 0;
    m.inertia = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  }
  return m;
}

function sameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((k, i) => k === sb[i]);
}

function namesByIndex(naming: NamingMap, kind: 'face' | 'edge', count: number): string[] {
  const out = new Array<string>(count).fill('');
  for (const n of naming) {
    if (n.kind !== kind || n.index < 0 || n.index >= count) continue;
    if (!n.name.startsWith(INTERNAL_PREFIX)) out[n.index] = n.name;
  }
  return out;
}

/**
 * Computes B − A and A − B. `meshOptions` are the viewport deflections for the requested quality.
 * Errors are `KernelError`s with a user-facing message; the raw cause goes to `detail`.
 */
export async function geometricDiff(
  kernel: DiffKernel,
  a: DiffSide,
  b: DiffSide,
  meshOptions: MeshOptions,
): Promise<Result<CompareOutput>> {
  const temps: ShapeHandle[] = [];
  try {
    const ua = await union(kernel, a, temps);
    if (!ua.ok) return ua;
    const ub = await union(kernel, b, temps);
    if (!ub.ok) return ub;
    const ma = await sideMass(kernel, a, ua.value);
    if (!ma.ok) return ma;
    const mb = await sideMass(kernel, b, ub.value);
    if (!mb.ok) return mb;

    const out: CompareOutput = {
      added: [],
      removed: [],
      addedVolume: 0,
      removedVolume: 0,
      a: { mass: ma.value, bbox: ma.value.bbox },
      b: { mass: mb.value, bbox: mb.value.bbox },
    };
    // Same content keys: the same features on the same inputs, hence identical geometry.
    if (sameKeys(a.keys, b.keys)) return { ok: true, value: out };

    const noise = DIFF_NOISE * Math.max(1, ma.value.volume, mb.value.volume);
    const added = await difference(kernel, ub.value, ua.value, meshOptions, noise, temps, {
      what: 'added',
      from: b.label,
      minus: a.label,
    });
    if (!added.ok) return added;
    const removed = await difference(kernel, ua.value, ub.value, meshOptions, noise, temps, {
      what: 'removed',
      from: a.label,
      minus: b.label,
    });
    if (!removed.ok) return removed;
    if (added.value) {
      out.added = [added.value.mesh];
      out.addedVolume = added.value.volume;
    }
    if (removed.value) {
      out.removed = [removed.value.mesh];
      out.removedVolume = removed.value.volume;
    }
    return { ok: true, value: out };
  } finally {
    for (const h of temps) await kernel.release(h);
  }
}

/** The union of a side's solids: none → null, one → that body, several → a fused temporary. */
async function union(
  kernel: DiffKernel,
  side: DiffSide,
  temps: ShapeHandle[],
): Promise<Result<{ shape: ShapeHandle; naming: NamingMap } | null>> {
  const [first, ...rest] = side.bodies;
  if (first === undefined) return { ok: true, value: null };
  if (rest.length === 0) return { ok: true, value: first };
  const r = await kernel.exec(
    booleanFeature('add', rest.length),
    booleanInputs(
      first.shape,
      rest.map((x) => x.shape),
    ),
  );
  if (!r.ok) {
    return {
      ok: false,
      error: kerr('OPERATION_FAILED', `Could not combine the bodies of ${side.label}`, {
        hint: 'One of its bodies may be invalid; check the model for errors.',
        detail: r.error.detail ?? r.error.message,
      }),
    };
  }
  temps.push(r.value.shape);
  for (const extra of r.value.bodies ?? []) temps.push(extra.shape);
  return { ok: true, value: { shape: r.value.shape, naming: r.value.naming } };
}

async function sideMass(
  kernel: DiffKernel,
  side: DiffSide,
  u: { shape: ShapeHandle } | null,
): Promise<Result<MassProperties>> {
  if (!u) return { ok: true, value: emptyMass(side.density) };
  const r = await kernel.massProperties(u.shape, side.density);
  if (r.ok) return r;
  return {
    ok: false,
    error: kerr('OPERATION_FAILED', `Could not measure ${side.label}`, {
      detail: r.error.detail ?? r.error.message,
    }),
  };
}

/** `from − minus`, meshed; null when empty (no faces, or volume within boolean noise). */
async function difference(
  kernel: DiffKernel,
  from: { shape: ShapeHandle; naming: NamingMap } | null,
  minus: { shape: ShapeHandle } | null,
  meshOptions: MeshOptions,
  noise: number,
  temps: ShapeHandle[],
  labels: { what: 'added' | 'removed'; from: string; minus: string },
): Promise<Result<{ mesh: MeshBuffers; volume: number } | null>> {
  if (!from) return { ok: true, value: null };
  let shape = from.shape;
  let naming = from.naming;
  if (minus) {
    const r = await kernel.exec(booleanFeature('cut', 1), booleanInputs(from.shape, [minus.shape]));
    if (!r.ok) {
      return {
        ok: false,
        error: kerr(
          'OPERATION_FAILED',
          `Could not work out the material ${labels.what} between ${labels.minus} and ${labels.from}`,
          {
            hint: 'The boolean difference failed; try comparing again after fixing any model errors.',
            detail: r.error.detail ?? r.error.message,
          },
        ),
      };
    }
    temps.push(r.value.shape);
    for (const extra of r.value.bodies ?? []) temps.push(extra.shape);
    shape = r.value.shape;
    naming = r.value.naming;
  }
  const mp = await kernel.massProperties(shape);
  if (!mp.ok) {
    return {
      ok: false,
      error: kerr('OPERATION_FAILED', `Could not measure the ${labels.what} material`, {
        detail: mp.error.detail ?? mp.error.message,
      }),
    };
  }
  const volume = Math.abs(mp.value.volume);
  if (mp.value.faceCount === 0 || volume <= noise) return { ok: true, value: null };
  const m = await kernel.mesh(shape, meshOptions);
  if (!m.ok) {
    return {
      ok: false,
      error: kerr('OPERATION_FAILED', `Could not display the ${labels.what} material`, {
        detail: m.error.detail ?? m.error.message,
      }),
    };
  }
  // Document names (as for bodies): faces of `from` keep theirs; faces the cut took from the
  // other side carry the internal compare id and are left unnamed.
  const mesh = m.value;
  mesh.faceNames = namesByIndex(naming, 'face', mesh.faceRanges.length / 2);
  mesh.edgeNames = namesByIndex(naming, 'edge', mesh.edgeRanges.length / 2);
  return { ok: true, value: { mesh, volume } };
}
