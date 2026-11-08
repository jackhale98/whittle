/**
 * Kernel golden tests (PLAN §10 test pyramid): run the real Wasm kernel in Node, both variants.
 * Skipped (not failed) only when dist/ has not been built; CI runs them after `pnpm build`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  FeatureResult,
  KernelError,
  KernelVariant,
  MassProperties,
  NamingEntry,
  PrimitiveFeature,
  Result,
  Vec3,
} from '@whittle/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  instantiateKernel,
  KERNEL_ARTEFACT,
  type KernelInitModule,
  type MeshDataHandle,
  type RawKernelInfo,
  type WhittleKernelModule,
} from '../src/index';

const distDir = fileURLToPath(new URL('../dist/', import.meta.url));

const VARIANTS: { variant: KernelVariant; init: string }[] = [
  { variant: 'single', init: 'init.single.js' },
  { variant: 'threaded', init: 'init.multi.js' },
];

const FEATURE_ID = '01JBOX0000000000000000000A';
const PREFIX = `F${FEATURE_ID}:`;

function box(overrides: Partial<PrimitiveFeature> = {}): PrimitiveFeature {
  return {
    id: FEATURE_ID,
    type: 'primitive',
    name: 'Box',
    suppressed: false,
    op: 'new',
    shape: 'box',
    dx: '10 mm',
    dy: '20 mm',
    dz: '30 mm',
    ...overrides,
  } as PrimitiveFeature;
}

const values = (dx: number, dy: number, dz: number) => ({
  values: { '/dx': dx, '/dy': dy, '/dz': dz },
});

function parse<T>(json: string): Result<T> {
  return JSON.parse(json) as Result<T>;
}

function ok<T>(json: string): T {
  const r = parse<T>(json);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function err(json: string): KernelError {
  const r = parse<unknown>(json);
  if (r.ok) throw new Error(`expected error, got ${json}`);
  return r.error;
}

interface MeshMeta {
  faceNames: string[];
  edgeNames: string[];
  bbox: { min: Vec3; max: Vec3 };
}

interface CopiedMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceRanges: Uint32Array;
  edgePositions: Float32Array;
  edgeRanges: Uint32Array;
  meta: MeshMeta;
}

function meshShape(k: WhittleKernelModule, shape: number, linearDeflection = 0.1): CopiedMesh {
  const md: MeshDataHandle = new k.MeshData();
  try {
    ok<Record<string, never>>(
      k.mesh(shape, JSON.stringify({ linearDeflection, angularDeflection: 0.5 }), md),
    );
    return {
      positions: md.positions().slice(),
      normals: md.normals().slice(),
      indices: md.indices().slice(),
      faceRanges: md.faceRanges().slice(),
      edgePositions: md.edgePositions().slice(),
      edgeRanges: md.edgeRanges().slice(),
      meta: JSON.parse(md.metaJson()) as MeshMeta,
    };
  } finally {
    md.delete();
  }
}

function expectVec3Close(actual: readonly number[], expected: readonly number[], eps = 1e-6) {
  expect(actual).toHaveLength(3);
  for (let i = 0; i < 3; i++)
    expect(Math.abs((actual[i] ?? Number.NaN) - (expected[i] ?? 0))).toBeLessThan(eps);
}

const AXES = ['x', 'y', 'z'] as const;
const FACE_ROLES = AXES.flatMap((a) => [`face.${a}min`, `face.${a}max`]);
const EDGE_ROLES = (() => {
  const roles: string[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      for (const si of ['min', 'max']) {
        for (const sj of ['min', 'max']) {
          const pair = [`face.${AXES[i]}${si}`, `face.${AXES[j]}${sj}`].sort();
          roles.push(`edge(${pair[0]}|${pair[1]})`);
        }
      }
    }
  }
  return roles;
})();
const VERTEX_ROLES = ['min', 'max'].flatMap((x) =>
  ['min', 'max'].flatMap((y) => ['min', 'max'].map((z) => `vertex(${x},${y},${z})`)),
);

/** Expected outward normal of a box face role, in the box's local frame. */
function localNormal(role: string): Vec3 {
  const axis = AXES.indexOf(role.slice(5, 6) as (typeof AXES)[number]);
  const n: Vec3 = [0, 0, 0];
  n[axis] = role.endsWith('max') ? 1 : -1;
  return n;
}

function checkNaming(naming: NamingEntry[]) {
  expect(naming).toHaveLength(26);
  const names = naming.map((n) => n.name);
  expect(new Set(names).size).toBe(26);
  for (const n of naming) expect(n.name.startsWith(PREFIX)).toBe(true);
  const roles = (kind: NamingEntry['kind']) =>
    naming
      .filter((n) => n.kind === kind)
      .map((n) => n.name.slice(PREFIX.length))
      .sort();
  expect(roles('face')).toEqual([...FACE_ROLES].sort());
  expect(roles('edge')).toEqual([...EDGE_ROLES].sort());
  expect(roles('vertex')).toEqual([...VERTEX_ROLES].sort());
  for (const [kind, count] of [
    ['face', 6],
    ['edge', 12],
    ['vertex', 8],
  ] as const) {
    const indices = naming
      .filter((n) => n.kind === kind)
      .map((n) => n.index)
      .sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: count }, (_, i) => i));
  }
}

/**
 * Structural mesh checks shared by every box. `worldNormal` maps a local face normal to world.
 */
function checkBoxMesh(
  mesh: CopiedMesh,
  naming: NamingEntry[],
  bbox: { min: Vec3; max: Vec3 },
  worldNormal: (n: Vec3) => Vec3 = (n) => n,
) {
  const triangleCount = mesh.indices.length / 3;
  const vertexCount = mesh.positions.length / 3;
  expect(triangleCount).toBeGreaterThanOrEqual(12);
  expect(mesh.normals.length).toBe(mesh.positions.length);

  // 6 face ranges, contiguous, covering every triangle exactly once.
  expect(mesh.faceRanges.length).toBe(12);
  let next = 0;
  for (let f = 0; f < 6; f++) {
    expect(mesh.faceRanges[2 * f]).toBe(next);
    const count = mesh.faceRanges[2 * f + 1] ?? 0;
    expect(count).toBeGreaterThanOrEqual(2);
    next += count;
  }
  expect(next).toBe(triangleCount);

  // 12 edge polylines, each at least 2 points, covering edgePositions.
  expect(mesh.edgeRanges.length).toBe(24);
  let nextPoint = 0;
  for (let e = 0; e < 12; e++) {
    expect(mesh.edgeRanges[2 * e]).toBe(nextPoint);
    const count = mesh.edgeRanges[2 * e + 1] ?? 0;
    expect(count).toBeGreaterThanOrEqual(2);
    nextPoint += count;
  }
  expect(nextPoint * 3).toBe(mesh.edgePositions.length);

  for (const idx of mesh.indices) expect(idx).toBeLessThan(vertexCount);

  // Unit normals.
  for (let i = 0; i < vertexCount; i++) {
    const len = Math.hypot(
      mesh.normals[3 * i] ?? 0,
      mesh.normals[3 * i + 1] ?? 0,
      mesh.normals[3 * i + 2] ?? 0,
    );
    expect(Math.abs(len - 1)).toBeLessThan(1e-5);
  }

  // Positions (faces and edges) inside the bbox.
  const eps = 1e-4;
  for (const buf of [mesh.positions, mesh.edgePositions]) {
    for (let i = 0; i < buf.length; i++) {
      const a = i % 3;
      expect(buf[i]).toBeGreaterThanOrEqual((bbox.min[a] ?? 0) - eps);
      expect(buf[i]).toBeLessThanOrEqual((bbox.max[a] ?? 0) + eps);
    }
  }

  // Meta: names line up with the naming map's TopExp indices; bbox is exact.
  expect(mesh.meta.faceNames).toHaveLength(6);
  expect(mesh.meta.edgeNames).toHaveLength(12);
  for (const n of naming) {
    if (n.kind === 'face') expect(mesh.meta.faceNames[n.index]).toBe(n.name);
    if (n.kind === 'edge') expect(mesh.meta.edgeNames[n.index]).toBe(n.name);
  }
  expectVec3Close(mesh.meta.bbox.min, bbox.min);
  expectVec3Close(mesh.meta.bbox.max, bbox.max);

  // Per face: vertex normals equal the outward normal of its role, and winding agrees with them.
  for (let f = 0; f < 6; f++) {
    const role = (mesh.meta.faceNames[f] ?? '').slice(PREFIX.length);
    const expected = worldNormal(localNormal(role));
    const first = mesh.faceRanges[2 * f] ?? 0;
    const count = mesh.faceRanges[2 * f + 1] ?? 0;
    for (let t = first; t < first + count; t++) {
      const [a, b, c] = [
        mesh.indices[3 * t] ?? 0,
        mesh.indices[3 * t + 1] ?? 0,
        mesh.indices[3 * t + 2] ?? 0,
      ];
      const p = (i: number): Vec3 => [
        mesh.positions[3 * i] ?? 0,
        mesh.positions[3 * i + 1] ?? 0,
        mesh.positions[3 * i + 2] ?? 0,
      ];
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const geo = [
        (u[1] ?? 0) * (v[2] ?? 0) - (u[2] ?? 0) * (v[1] ?? 0),
        (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0),
        (u[0] ?? 0) * (v[1] ?? 0) - (u[1] ?? 0) * (v[0] ?? 0),
      ];
      const dot =
        (geo[0] ?? 0) * expected[0] + (geo[1] ?? 0) * expected[1] + (geo[2] ?? 0) * expected[2];
      expect(dot).toBeGreaterThan(0); // CCW seen from outside
      for (const i of [a, b, c]) {
        expectVec3Close(
          [mesh.normals[3 * i] ?? 0, mesh.normals[3 * i + 1] ?? 0, mesh.normals[3 * i + 2] ?? 0],
          expected,
          1e-5,
        );
      }
    }
  }
}

for (const { variant, init } of VARIANTS) {
  const initPath = `${distDir}${init}`;
  const built = existsSync(initPath);
  const title = built
    ? `kernel golden: box (${variant}, ${KERNEL_ARTEFACT[variant]}.wasm)`
    : `kernel golden: box (${variant}) — SKIPPED: ${initPath} missing; run \`pnpm --filter @whittle/kernel build\``;

  describe.skipIf(!built)(title, () => {
    let k: WhittleKernelModule;
    let initMs = 0;

    beforeAll(async () => {
      const started = performance.now();
      const mod = (await import(pathToFileURL(initPath).href)) as KernelInitModule;
      k = await instantiateKernel(mod);
      initMs = performance.now() - started;
      console.info(`[${variant}] Node cold init: ${initMs.toFixed(1)} ms`);
    }, 60_000);

    afterAll(() => {
      if (k) expect(k.liveHandleCount()).toBe(0);
    });

    it('reports identity', () => {
      const info = ok<RawKernelInfo>(k.kernelInfo());
      expect(info.occtVersion).toBe('8.0.1');
      expect(info.buildId).toMatch(/^[0-9a-f]{16}$/);
      expect(info.threads).toBe(variant === 'threaded');
      expect(initMs).toBeGreaterThan(0);
    });

    it('makes a 10×20×30 box with exact mass properties, naming and mesh', () => {
      const result = ok<FeatureResult>(
        k.execFeature(JSON.stringify(box()), JSON.stringify(values(10, 20, 30))),
      );
      expect(result.shape).toBeGreaterThan(0);
      expect(result.warnings).toEqual([]);
      checkNaming(result.naming);
      expect(k.liveHandleCount()).toBe(1);

      const mp = ok<MassProperties>(k.massProperties(result.shape));
      expect(Math.abs(mp.volume - 6000) / 6000).toBeLessThan(1e-9);
      expect(Math.abs(mp.area - 2200) / 2200).toBeLessThan(1e-9);
      expect(mp.faceCount).toBe(6);
      expect(mp.edgeCount).toBe(12);
      expect(mp.vertexCount).toBe(8);
      expectVec3Close(mp.centroid, [5, 10, 15], 1e-9);
      expectVec3Close(mp.bbox.min, [0, 0, 0]);
      expectVec3Close(mp.bbox.max, [10, 20, 30]);

      const coarse = meshShape(k, result.shape, 0.5);
      checkBoxMesh(coarse, result.naming, mp.bbox);
      // Re-meshing the same handle (another deflection) is allowed and stays consistent.
      const fine = meshShape(k, result.shape, 0.05);
      checkBoxMesh(fine, result.naming, mp.bbox);

      k.release(result.shape);
      k.release(result.shape); // double release is a no-op
      expect(k.liveHandleCount()).toBe(0);
    });

    it('places a box in a translated, rotated frame', () => {
      // Local X → world +Y, local Y = Z × X → world −X, local Z → world +Z.
      const frame = { origin: [100, -50, 7] as Vec3, z: [0, 0, 1] as Vec3, x: [0, 1, 0] as Vec3 };
      const result = ok<FeatureResult>(
        k.execFeature(JSON.stringify(box({ frame })), JSON.stringify(values(10, 20, 30))),
      );
      checkNaming(result.naming);
      const mp = ok<MassProperties>(k.massProperties(result.shape));
      expect(Math.abs(mp.volume - 6000) / 6000).toBeLessThan(1e-9);
      expect(Math.abs(mp.area - 2200) / 2200).toBeLessThan(1e-9);
      expectVec3Close(mp.centroid, [90, -45, 22], 1e-9);
      expectVec3Close(mp.bbox.min, [80, -50, 7]);
      expectVec3Close(mp.bbox.max, [100, -40, 37]);
      const toWorld = (n: Vec3): Vec3 => [-n[1], n[0], n[2]];
      checkBoxMesh(meshShape(k, result.shape), result.naming, mp.bbox, toWorld);
      k.release(result.shape);
    });

    it('returns structured errors and never throws', () => {
      const cases: { feature: string; inputs: string; code: KernelError['code'] }[] = [
        {
          feature: JSON.stringify(box()),
          inputs: JSON.stringify(values(-1, 20, 30)),
          code: 'INVALID_INPUT',
        },
        {
          feature: JSON.stringify(box()),
          inputs: JSON.stringify(values(10, 0, 30)),
          code: 'INVALID_INPUT',
        },
        {
          feature: JSON.stringify(box()),
          inputs: JSON.stringify(values(10, 20, 1e-9)),
          code: 'INVALID_INPUT',
        },
        {
          feature: JSON.stringify(box()),
          inputs: JSON.stringify({ values: { '/dx': 10 } }),
          code: 'INVALID_INPUT',
        },
        {
          feature: JSON.stringify(box()),
          inputs: JSON.stringify({ values: { '/dx': null, '/dy': 1, '/dz': 1 } }),
          code: 'INVALID_INPUT',
        },
        { feature: JSON.stringify(box()), inputs: '{"values":', code: 'INVALID_INPUT' },
        { feature: '[1,2', inputs: '{}', code: 'INVALID_INPUT' },
        {
          feature: JSON.stringify(
            box({ frame: { origin: [0, 0, 0], z: [0, 0, 1], x: [0, 0, 2] } }),
          ),
          inputs: JSON.stringify(values(1, 1, 1)),
          code: 'INVALID_INPUT',
        },
        {
          feature: JSON.stringify({
            id: 'F1',
            type: 'fillet',
            name: 'Fillet',
            suppressed: false,
            edges: [],
            radius: '1',
          }),
          inputs: JSON.stringify({ values: { '/radius': 1 } }),
          code: 'UNSUPPORTED_FEATURE',
        },
        {
          feature: JSON.stringify({ ...box(), shape: 'cylinder', radius: '1', height: '2' }),
          inputs: JSON.stringify({ values: { '/radius': 1, '/height': 2 } }),
          code: 'UNSUPPORTED_FEATURE',
        },
        {
          feature: JSON.stringify(box({ op: 'cut' })),
          inputs: JSON.stringify(values(1, 1, 1)),
          code: 'UNSUPPORTED_FEATURE',
        },
      ];
      for (const c of cases) {
        let raw = '';
        expect(() => {
          raw = k.execFeature(c.feature, c.inputs);
        }).not.toThrow();
        const e = err(raw);
        expect(e.code, `${c.feature} / ${c.inputs}`).toBe(c.code);
        expect(e.message.length).toBeGreaterThan(0);
      }
      const dxError = err(k.execFeature(JSON.stringify(box()), JSON.stringify(values(-1, 20, 30))));
      expect(dxError.hint).toMatch(/dx/);

      for (const handle of [0, -3, 9999]) {
        expect(err(k.massProperties(handle)).code).toBe('INVALID_HANDLE');
        const md = new k.MeshData();
        expect(
          err(k.mesh(handle, '{"linearDeflection":0.1,"angularDeflection":0.5}', md)).code,
        ).toBe('INVALID_HANDLE');
        md.delete();
        expect(() => k.release(handle)).not.toThrow();
      }

      // Bad mesh options on a live shape.
      const live = ok<FeatureResult>(
        k.execFeature(JSON.stringify(box()), JSON.stringify(values(1, 2, 3))),
      );
      const md = new k.MeshData();
      expect(
        err(k.mesh(live.shape, '{"linearDeflection":0,"angularDeflection":0.5}', md)).code,
      ).toBe('INVALID_INPUT');
      expect(err(k.mesh(live.shape, 'nope', md)).code).toBe('INVALID_INPUT');
      md.delete();
      k.release(live.shape);
      expect(k.liveHandleCount()).toBe(0);
    });

    it('releases every handle it hands out', () => {
      const shapes: number[] = [];
      for (let i = 1; i <= 25; i++) {
        shapes.push(
          ok<FeatureResult>(k.execFeature(JSON.stringify(box()), JSON.stringify(values(i, i, i))))
            .shape,
        );
      }
      expect(new Set(shapes).size).toBe(25);
      expect(k.liveHandleCount()).toBe(25);
      for (const s of shapes) k.release(s);
      expect(k.liveHandleCount()).toBe(0);
    });
  });
}
