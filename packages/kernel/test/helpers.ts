/**
 * Shared helpers for the kernel golden tests (Node, real Wasm, both variants).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  Feature,
  FeatureInputs,
  FeatureResult,
  Frame,
  KernelError,
  KernelVariant,
  MassProperties,
  NamingEntry,
  Result,
  ShapeFingerprints,
  SketchEntity,
  Vec3,
} from '@wren-cad/contracts';
import {
  instantiateKernel,
  KERNEL_ARTEFACT,
  type KernelInitModule,
  type MeshDataHandle,
  type WhittleKernelModule,
} from '../src/index';

const distDir = fileURLToPath(new URL('../dist/', import.meta.url));

export const VARIANTS: { variant: KernelVariant; init: string }[] = [
  { variant: 'single', init: 'init.single.js' },
  { variant: 'threaded', init: 'init.multi.js' },
];

/** Imports and instantiates a variant's kernel (for use in beforeAll). */
export async function loadVariant(variant: KernelVariant): Promise<WhittleKernelModule> {
  const entry = VARIANTS.find((v) => v.variant === variant);
  if (entry === undefined) throw new Error(`unknown variant ${variant}`);
  const mod = (await import(pathToFileURL(`${distDir}${entry.init}`).href)) as KernelInitModule;
  return instantiateKernel(mod);
}

export function variantBuilt(variant: KernelVariant): boolean {
  const entry = VARIANTS.find((v) => v.variant === variant);
  return entry !== undefined && existsSync(`${distDir}${entry.init}`);
}

export function suiteTitle(suite: string, variant: KernelVariant): string {
  return variantBuilt(variant)
    ? `kernel golden: ${suite} (${variant}, ${KERNEL_ARTEFACT[variant]}.wasm)`
    : `kernel golden: ${suite} (${variant}) — SKIPPED: dist/ missing; run \`pnpm --filter @wren-cad/kernel build\``;
}

export function parse<T>(json: string): Result<T> {
  return JSON.parse(json) as Result<T>;
}

export function ok<T>(json: string): T {
  const r = parse<T>(json);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

export function err(json: string): KernelError {
  const r = parse<unknown>(json);
  if (r.ok) throw new Error(`expected error, got ${json.slice(0, 400)}`);
  return r.error;
}

/** FeatureResult plus the façade's extra fields. */
export interface RawFeatureResult extends FeatureResult {
  frame?: Frame;
  regions?: string[];
  bodies?: { key: string; shape: number; naming: NamingEntry[] }[];
}

/** Tracks every handle a test creates so it can be released (leak checks). */
export class Session {
  readonly handles: number[] = [];
  constructor(readonly k: WhittleKernelModule) {}

  exec(feature: Feature | Record<string, unknown>, inputs: FeatureInputs): RawFeatureResult {
    const r = ok<RawFeatureResult>(
      this.k.execFeature(JSON.stringify(feature), JSON.stringify(inputs)),
    );
    this.handles.push(r.shape);
    for (const b of r.bodies ?? []) this.handles.push(b.shape);
    return r;
  }

  fail(feature: Feature | Record<string, unknown>, inputs: FeatureInputs): KernelError {
    let raw = '';
    raw = this.k.execFeature(JSON.stringify(feature), JSON.stringify(inputs));
    return err(raw);
  }

  mass(shape: number, density = 0): MassProperties {
    return ok<MassProperties>(this.k.massProperties(shape, density));
  }

  fingerprints(shape: number): ShapeFingerprints {
    return ok<ShapeFingerprints>(this.k.fingerprints(shape));
  }

  releaseAll(): void {
    for (const h of this.handles) this.k.release(h);
    this.handles.length = 0;
  }
}

export function names(result: FeatureResult, kind?: NamingEntry['kind']): string[] {
  return result.naming.filter((n) => kind === undefined || n.kind === kind).map((n) => n.name);
}

export function indexOf(result: FeatureResult, name: string, kind: NamingEntry['kind']): number {
  const hits = result.naming.filter((n) => n.name === name && n.kind === kind);
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one ${kind} named ${name}, found ${hits.length}; have:\n${names(result, kind).join('\n')}`,
    );
  }
  return hits[0]?.index ?? -1;
}

export function relClose(actual: number, expected: number, rel = 1e-9): void {
  const scale = Math.max(1, Math.abs(expected));
  if (Math.abs(actual - expected) > rel * scale) {
    throw new Error(`expected ${expected}, got ${actual} (rel tol ${rel})`);
  }
}

export function vecClose(actual: readonly number[], expected: readonly number[], eps = 1e-6): void {
  for (let i = 0; i < 3; i++) {
    if (Math.abs((actual[i] ?? Number.NaN) - (expected[i] ?? 0)) > eps) {
      throw new Error(`expected [${expected.join(', ')}], got [${actual.join(', ')}]`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Feature builders
// ---------------------------------------------------------------------------------------------

export const XY: Frame = { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] };

export function frameAt(origin: Vec3, z: Vec3 = [0, 0, 1], x: Vec3 = [1, 0, 0]): Frame {
  return { origin, z, x };
}

export function pt(id: string, x: number, y: number, construction = false): SketchEntity {
  return { id, kind: 'point', x, y, construction };
}

export function line(id: string, start: string, end: string, construction = false): SketchEntity {
  return { id, kind: 'line', start, end, construction };
}

/** Rectangle [x0,x1]×[y0,y1]: points `${p}1..4`, lines L1 (bottom), L2 (right), L3 (top), L4 (left). */
export function rect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  p = 'p',
  l = 'L',
): SketchEntity[] {
  return [
    pt(`${p}1`, x0, y0),
    pt(`${p}2`, x1, y0),
    pt(`${p}3`, x1, y1),
    pt(`${p}4`, x0, y1),
    line(`${l}1`, `${p}1`, `${p}2`),
    line(`${l}2`, `${p}2`, `${p}3`),
    line(`${l}3`, `${p}3`, `${p}4`),
    line(`${l}4`, `${p}4`, `${p}1`),
  ];
}

export function circle(id: string, cx: number, cy: number, r: number): SketchEntity[] {
  return [
    pt(`${id}c`, cx, cy),
    { id, kind: 'circle', center: `${id}c`, radius: r, construction: false },
  ];
}

export function sketch(id: string, entities: SketchEntity[]): Feature {
  return {
    id,
    type: 'sketch',
    name: 'Sketch',
    suppressed: false,
    on: { name: 'origin:XY', kind: 'face' },
    entities,
    constraints: [],
  };
}

export function sketchInputs(plane: Frame = XY): FeatureInputs {
  return { values: {}, frames: { plane } };
}

export function extrude(
  id: string,
  options: {
    direction?: 'normal' | 'reverse' | 'symmetric';
    end?: 'blind' | 'throughAll' | 'upTo';
    op?: 'new' | 'add' | 'cut' | 'intersect';
    profiles?: number;
  } = {},
): Feature {
  const end =
    options.end === 'throughAll'
      ? ({ kind: 'throughAll' } as const)
      : options.end === 'upTo'
        ? ({ kind: 'upTo', target: { name: 'target', kind: 'face' } } as const)
        : ({ kind: 'blind', depth: '10 mm' } as const);
  return {
    id,
    type: 'extrude',
    name: 'Extrude',
    suppressed: false,
    profile: Array.from({ length: options.profiles ?? 1 }, () => ({
      name: 'region',
      kind: 'region' as const,
    })),
    direction: options.direction ?? 'normal',
    end,
    op: options.op ?? 'new',
  };
}

export function profileRefs(sketchShape: number, faceIndices: number[]): FeatureInputs['refs'] {
  const refs: NonNullable<FeatureInputs['refs']> = {};
  faceIndices.forEach((index, i) => {
    refs[`/profile/${i}`] = { shape: sketchShape, kind: 'face', index };
  });
  return refs;
}

/** Sketch region face indices by name prefix. */
export function regionIndex(result: FeatureResult, name: string): number {
  return indexOf(result, name, 'face');
}

export function boxFeature(
  id: string,
  frame?: Frame,
  op: 'new' | 'add' | 'cut' | 'intersect' = 'new',
): Feature {
  return {
    id,
    type: 'primitive',
    name: 'Box',
    suppressed: false,
    op,
    shape: 'box',
    dx: '1',
    dy: '1',
    dz: '1',
    ...(frame === undefined ? {} : { frame }),
  } as Feature;
}

export const boxValues = (dx: number, dy: number, dz: number) => ({
  values: { '/dx': dx, '/dy': dy, '/dz': dz },
});

export interface CopiedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  faceRanges: Uint32Array;
  edgeRanges: Uint32Array;
  meta: { faceNames: string[]; edgeNames: string[] };
}

export function meshShape(
  k: WhittleKernelModule,
  shape: number,
  linearDeflection = 0.1,
  angularDeflection = 0.5,
): CopiedMesh {
  const md: MeshDataHandle = new k.MeshData();
  try {
    ok<Record<string, never>>(
      k.mesh(shape, JSON.stringify({ linearDeflection, angularDeflection }), md),
    );
    return {
      positions: md.positions().slice(),
      indices: md.indices().slice(),
      faceRanges: md.faceRanges().slice(),
      edgeRanges: md.edgeRanges().slice(),
      meta: JSON.parse(md.metaJson()) as CopiedMesh['meta'],
    };
  } finally {
    md.delete();
  }
}
