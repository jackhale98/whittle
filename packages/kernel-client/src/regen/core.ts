/**
 * Services shared by the engine and the feature executors: the kernel, the lazily loaded
 * sketch solver, linked-entity re-projection and the per-handle caches (fingerprints, mass
 * properties, meshes, probed geometry), which are dropped when a handle is released.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Feature,
  FeatureInputs,
  FeatureResult,
  MassProperties,
  MeshBuffers,
  MeshQuality,
  Result,
  ShapeFingerprints,
  ShapeHandle,
} from '@wren-cad/contracts';
import { edgeCircle, edgeEndpoints, edgeLine, faceAxis, type GeoQuery } from './datums';
import { type ReprojectLinked, reprojectLinkedFallback } from './linked';
import type { CacheEntry, RawImport } from './state';
import { MESH_QUALITY, type RegenEngineDeps, type SketchSolve } from './types';

export class EngineCore {
  readonly kernel: RegenEngineDeps['kernel'];
  readonly solverLoader: RegenEngineDeps['sketchSolver'];
  solver: SketchSolve | null = null;
  readonly reproject: ReprojectLinked;
  /** Per-handle memo of probed geometry (lines, circles, axes, end points); dropped on release. */
  private readonly geoMemo = new Map<string, unknown>();
  readonly quality: Record<MeshQuality, { linearDeflection: number; angularDeflection: number }>;
  /** Per-handle caches; dropped when the handle is released. */
  private readonly fps = new Map<ShapeHandle, ShapeFingerprints | null>();
  private readonly mass = new Map<string, MassProperties | null>();
  private readonly meshes = new Map<string, MeshBuffers>();
  /** Every handle owned by a cache entry (the UI must never release these). */
  readonly ownedHandles = new Set<ShapeHandle>();

  constructor(deps: RegenEngineDeps) {
    this.kernel = deps.kernel;
    this.solverLoader = deps.sketchSolver;
    this.reproject = deps.reprojectLinked ?? reprojectLinkedFallback;
    this.quality = { ...MESH_QUALITY, ...deps.options?.meshQuality };
  }

  async fingerprints(shape: ShapeHandle): Promise<ShapeFingerprints | null> {
    if (this.fps.has(shape)) return this.fps.get(shape) ?? null;
    const r = await this.kernel.fingerprints(shape);
    const v = r.ok ? r.value : null;
    this.fps.set(shape, v);
    return v;
  }

  async massOf(shape: ShapeHandle, density?: number): Promise<MassProperties | null> {
    const k = `${shape}|${density ?? 0}`;
    if (this.mass.has(k)) return this.mass.get(k) ?? null;
    const r = await this.kernel.massProperties(shape, density);
    const v = r.ok ? r.value : null;
    this.mass.set(k, v);
    return v;
  }

  async meshOf(shape: ShapeHandle, quality: MeshQuality): Promise<MeshBuffers | null> {
    const k = `${shape}|${quality}`;
    const cached = this.meshes.get(k);
    if (cached) return cached;
    const r = await this.kernel.mesh(shape, { ...this.quality[quality], relative: true });
    if (!r.ok) return null;
    this.meshes.set(k, r.value);
    return r.value;
  }

  async releaseHandle(shape: ShapeHandle): Promise<void> {
    this.ownedHandles.delete(shape);
    this.fps.delete(shape);
    for (const k of [...this.mass.keys()]) if (k.startsWith(`${shape}|`)) this.mass.delete(k);
    this.meshes.delete(`${shape}|coarse`);
    this.meshes.delete(`${shape}|fine`);
    for (const k of [...this.geoMemo.keys()]) if (k.startsWith(`${shape}|`)) this.geoMemo.delete(k);
    await this.kernel.release(shape);
  }

  async releaseEntry(e: CacheEntry): Promise<void> {
    for (const h of e.owned) await this.releaseHandle(h);
    e.owned = [];
  }

  async releaseRaw(raw: RawImport): Promise<void> {
    for (const h of raw.shapes) await this.releaseHandle(h);
    raw.shapes = [];
  }

  /**
   * `execFeature`. Every kernel feature call of the engine goes through here. (Kernel names are
   * document names: the M1 translation of imported names, `F<id>:face:unnamed` → `F<id>:face`,
   * went with the kernel `import` feature, which names imported faces `F<id>:face#k` itself.)
   */
  exec(feature: Feature, inputs: FeatureInputs): Promise<Result<FeatureResult>> {
    return this.kernel.execFeature(feature, inputs);
  }

  geo(): GeoQuery {
    return {
      fingerprints: (shape) => this.fingerprints(shape),
      measure: (a, b) => this.kernel.measureShapes(a, b),
    };
  }

  /** Memoised per handle (engine-owned handles keep their geometry; dropped on release). */
  async memo<T>(shape: ShapeHandle, what: string, fn: () => Promise<T>): Promise<T> {
    const k = `${shape}|${what}`;
    if (this.geoMemo.has(k)) return this.geoMemo.get(k) as T;
    const v = await fn();
    this.geoMemo.set(k, v);
    return v;
  }

  lineOfEdge(t: { shape: ShapeHandle; index: number }) {
    return this.memo(t.shape, `line:${t.index}`, () => edgeLine(this.geo(), t.shape, t.index));
  }

  circleOfEdge(t: { shape: ShapeHandle; index: number }) {
    return this.memo(t.shape, `circle:${t.index}`, () => edgeCircle(this.geo(), t.shape, t.index));
  }

  axisOfFace(t: { shape: ShapeHandle; index: number }) {
    return this.memo(t.shape, `axis:${t.index}`, () => faceAxis(this.geo(), t.shape, t.index));
  }

  endpointsOf(t: { shape: ShapeHandle; index: number }, tol: number) {
    return this.memo(t.shape, `ends:${t.index}:${tol}`, () =>
      edgeEndpoints(this.geo(), t.shape, t.index, tol),
    );
  }
}
