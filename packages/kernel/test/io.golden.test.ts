/**
 * Kernel golden tests for data exchange (STEP AP214/AP203/AP242, STL, BREP), mass properties with
 * density (ADR-004), fingerprints and thread configuration. Golden numbers are analytic.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { KernelError } from '@whittle/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RawExportResult, RawImportResult, WhittleKernelModule } from '../src/index';
import {
  boxFeature,
  boxValues,
  circle,
  err,
  extrude,
  frameAt,
  indexOf,
  loadVariant,
  meshShape,
  ok,
  profileRefs,
  rect,
  relClose,
  Session,
  sketch,
  sketchInputs,
  suiteTitle,
  VARIANTS,
  variantBuilt,
  vecClose,
} from './helpers';

const SK = '01JSKETCH00000000000000001';
const EX = '01JEXTRUDE0000000000000001';
const FI = '01JFILLET00000000000000001';
const BOX = '01JBOX00000000000000000001';
const PI = Math.PI;

interface Stl {
  /** 9 floats per triangle. */
  triangles: Float32Array;
}

function parseBinaryStl(bytes: Uint8Array): Stl {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  expect(bytes.byteLength).toBe(84 + 50 * count);
  const triangles = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    for (let i = 0; i < 9; i++)
      triangles[t * 9 + i] = view.getFloat32(84 + t * 50 + 12 + i * 4, true);
  }
  return { triangles };
}

function parseAsciiStl(text: string): Stl {
  const values: number[] = [];
  for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) {
    values.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return { triangles: new Float32Array(values) };
}

/** Every edge shared by exactly two triangles, with opposite orientation; signed volume. */
function analyseStl(stl: Stl): { watertight: boolean; volume: number; triangles: number } {
  const ids = new Map<string, number>();
  const id = (i: number) => {
    const t = stl.triangles;
    const key = `${t[i]},${t[i + 1]},${t[i + 2]}`;
    let v = ids.get(key);
    if (v === undefined) {
      v = ids.size;
      ids.set(key, v);
    }
    return v;
  };
  const directed = new Map<string, number>();
  let volume = 0;
  const n = stl.triangles.length / 9;
  for (let t = 0; t < n; t++) {
    const base = t * 9;
    const a = id(base);
    const b = id(base + 3);
    const c = id(base + 6);
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = `${p}>${q}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
    const tr = stl.triangles;
    const [x0, y0, z0] = [tr[base] ?? 0, tr[base + 1] ?? 0, tr[base + 2] ?? 0];
    const [x1, y1, z1] = [tr[base + 3] ?? 0, tr[base + 4] ?? 0, tr[base + 5] ?? 0];
    const [x2, y2, z2] = [tr[base + 6] ?? 0, tr[base + 7] ?? 0, tr[base + 8] ?? 0];
    volume += (x0 * (y1 * z2 - z1 * y2) - y0 * (x1 * z2 - z1 * x2) + z0 * (x1 * y2 - y1 * x2)) / 6;
  }
  let watertight = true;
  for (const [key, count] of directed) {
    const [p, q] = key.split('>');
    if (count !== 1 || directed.get(`${q}>${p}`) !== 1) {
      watertight = false;
      break;
    }
  }
  return { watertight, volume, triangles: n };
}

for (const { variant } of VARIANTS) {
  describe.skipIf(!variantBuilt(variant))(suiteTitle('io + mass', variant), () => {
    let k: WhittleKernelModule;
    let s: Session;
    let baseline = 0;

    beforeAll(async () => {
      k = await loadVariant(variant);
      baseline = k.liveHandleCount();
    }, 60_000);

    afterEach(() => {
      s?.releaseAll();
      expect(k.liveHandleCount()).toBe(baseline);
    });

    afterAll(() => {
      if (k) expect(k.liveHandleCount()).toBe(baseline);
    });

    const session = () => {
      s = new Session(k);
      return s;
    };

    /** 40×30×10 plate, Ø10 hole, one filleted vertical corner (r = 3). */
    const bracket = (ss: Session) => {
      const sk = ss.exec(
        sketch(SK, [...rect(0, 0, 40, 30), ...circle('C1', 20, 15, 5)]),
        sketchInputs(),
      );
      const ex = ss.exec(extrude(EX), {
        values: { '/end/depth': 10 },
        refs: profileRefs(sk.shape, [indexOf(sk, `S${SK}:region(L1,L2,L3,L4|C1)`, 'face')]),
      });
      const edge = `edge(F${EX}:side(S${SK}:e(L1))|F${EX}:side(S${SK}:e(L2)))`;
      const fil = ss.exec(
        {
          id: FI,
          type: 'fillet',
          name: 'Fillet',
          suppressed: false,
          edges: [{ name: edge, kind: 'edge' }],
          radius: '3',
        },
        {
          values: { '/radius': 3 },
          target: ex.shape,
          refs: { '/edges/0': { shape: ex.shape, kind: 'edge', index: indexOf(ex, edge, 'edge') } },
        },
      );
      return fil;
    };
    const bracketVolume = 40 * 30 * 10 - PI * 25 * 10 - (1 - PI / 4) * 9 * 10;

    /** Runs exportShapes, reads and unlinks every file. */
    const exportFiles = (shapes: unknown[], format: string, options: object = {}) => {
      const r = ok<RawExportResult>(
        k.exportShapes(JSON.stringify(shapes), format, JSON.stringify(options)),
      );
      expect(r.files[0]?.path).toBe(r.path);
      return r.files.map((f) => {
        const bytes = k.FS.readFile(f.path, { encoding: 'binary' }).slice();
        k.FS.unlink(f.path);
        return { name: f.name, bytes };
      });
    };
    let importCounter = 0;
    const importBytes = (bytes: Uint8Array, format: string): RawImportResult => {
      const path = `/tmp/test-import-${++importCounter}.${format}`;
      k.FS.writeFile(path, bytes);
      try {
        const r = ok<RawImportResult>(k.importFile(path, format));
        for (const b of r.bodies) s.handles.push(b.shape);
        return r;
      } finally {
        k.FS.unlink(path);
      }
    };

    it('STEP AP214 export → import round trip: volume within 1e-6, name kept', () => {
      const ss = session();
      const body = bracket(ss);
      const v = ss.mass(body.shape).volume;
      relClose(v, bracketVolume, 1e-9);
      const [file] = exportFiles(
        [{ shape: body.shape, name: 'Bracket', color: '#3366cc' }],
        'step',
        { stepSchema: 'AP214' },
      );
      const text = new TextDecoder().decode(file?.bytes);
      expect(text.startsWith('ISO-10303-21;')).toBe(true);
      expect(text).toMatch(/AUTOMOTIVE_DESIGN/);
      expect(text).toMatch(/'Bracket'/);
      expect(text).toMatch(/COLOUR_RGB/);
      const imported = importBytes(file?.bytes ?? new Uint8Array(), 'step');
      expect(imported.bodies).toHaveLength(1);
      expect(imported.bodies[0]?.name).toBe('Bracket');
      const mp = ss.mass(imported.bodies[0]?.shape ?? 0);
      relClose(mp.volume, v, 1e-6);
      expect(mp.faceCount).toBe(ss.mass(body.shape).faceCount);
      // Imported bodies mesh like any other.
      expect(meshShape(k, imported.bodies[0]?.shape ?? 0, 0.1).indices.length).toBeGreaterThan(0);
    });

    it('STEP schemas AP203 and AP242; several bodies', () => {
      const ss = session();
      const a = ss.exec(boxFeature(BOX), boxValues(10, 10, 10));
      const b = ss.exec(boxFeature(BOX, frameAt([20, 0, 0])), boxValues(5, 5, 5));
      const shapes = [
        { shape: a.shape, name: 'A' },
        { shape: b.shape, name: 'B' },
      ];
      const ap203 = new TextDecoder().decode(
        exportFiles(shapes, 'step', { stepSchema: 'AP203' })[0]?.bytes,
      );
      expect(ap203).toMatch(/CONFIG_CONTROL_DESIGN/);
      const ap242Bytes =
        exportFiles(shapes, 'step', { stepSchema: 'AP242' })[0]?.bytes ?? new Uint8Array();
      expect(new TextDecoder().decode(ap242Bytes)).toMatch(/AP242/);
      const back = importBytes(ap242Bytes, 'step');
      expect(back.bodies.map((x) => x.name).sort()).toEqual(['A', 'B']);
      const volumes = back.bodies.map((x) => ss.mass(x.shape).volume).sort((p, q) => p - q);
      relClose(volumes[0] ?? 0, 125, 1e-6);
      relClose(volumes[1] ?? 0, 1000, 1e-6);
      const bb = back.bodies.find((x) => x.name === 'B');
      vecClose(ss.mass(bb?.shape ?? 0).centroid, [22.5, 2.5, 2.5], 1e-6);
    });

    it('BREP round trip is exact', () => {
      const ss = session();
      const body = bracket(ss);
      const [file] = exportFiles([{ shape: body.shape, name: 'Bracket' }], 'brep');
      const back = importBytes(file?.bytes ?? new Uint8Array(), 'brep');
      expect(back.bodies).toHaveLength(1);
      const a = ss.mass(body.shape);
      const b = ss.mass(back.bodies[0]?.shape ?? 0);
      relClose(b.volume, a.volume, 1e-12);
      relClose(b.area, a.area, 1e-12);
      expect(b.faceCount).toBe(a.faceCount);
      expect(b.edgeCount).toBe(a.edgeCount);
    });

    it('binary STL is watertight and matches the B-rep volume within the deflection', () => {
      const ss = session();
      const body = bracket(ss);
      const mp = ss.mass(body.shape);
      for (const linearDeflection of [0.1, 0.01]) {
        const [file] = exportFiles([{ shape: body.shape, name: 'Bracket' }], 'stl', {
          stlBinary: true,
          linearDeflection,
          angularDeflection: 0.25,
        });
        const stl = analyseStl(parseBinaryStl(file?.bytes ?? new Uint8Array()));
        expect(stl.watertight).toBe(true);
        expect(stl.triangles).toBeGreaterThan(20);
        expect(Math.abs(stl.volume - mp.volume)).toBeLessThanOrEqual(mp.area * linearDeflection);
      }
      // The export meshes a copy: the viewport mesh of the body is unaffected (coarse stays coarse).
      const coarse = meshShape(k, body.shape, 1, 0.5).indices.length;
      exportFiles([{ shape: body.shape, name: 'Bracket' }], 'stl', { linearDeflection: 0.005 });
      expect(meshShape(k, body.shape, 1, 0.5).indices.length).toBe(coarse);
    });

    it('ASCII STL, per-body files, STL import', () => {
      const ss = session();
      const a = ss.exec(boxFeature(BOX), boxValues(10, 20, 30));
      const b = ss.exec(boxFeature(BOX, frameAt([50, 0, 0])), boxValues(1, 2, 3));
      const [ascii] = exportFiles([{ shape: a.shape, name: 'Box A' }], 'stl', { stlBinary: false });
      const text = new TextDecoder().decode(ascii?.bytes);
      expect(text.startsWith('solid Box A\n')).toBe(true);
      expect(text.trimEnd().endsWith('endsolid Box A')).toBe(true);
      const parsed = analyseStl(parseAsciiStl(text));
      expect(parsed.watertight).toBe(true);
      expect(parsed.triangles).toBe(12);
      relClose(parsed.volume, 6000, 1e-6);
      const per = exportFiles(
        [
          { shape: a.shape, name: 'A' },
          { shape: b.shape, name: 'B' },
        ],
        'stl',
        { stlPerBody: true },
      );
      expect(per.map((f) => f.name)).toEqual(['A', 'B']);
      relClose(analyseStl(parseBinaryStl(per[1]?.bytes ?? new Uint8Array())).volume, 6, 1e-6);
      const merged = exportFiles(
        [
          { shape: a.shape, name: 'A' },
          { shape: b.shape, name: 'B' },
        ],
        'stl',
      );
      expect(merged).toHaveLength(1);
      relClose(analyseStl(parseBinaryStl(merged[0]?.bytes ?? new Uint8Array())).volume, 6006, 1e-6);
      // STL import gives a mesh-only body that still meshes and measures.
      const back = importBytes(per[0]?.bytes ?? new Uint8Array(), 'stl');
      expect(back.bodies).toHaveLength(1);
      const m = meshShape(k, back.bodies[0]?.shape ?? 0, 0.1);
      expect(m.indices.length / 3).toBe(12);
      expect(m.faceRanges.length).toBe(2);
      const mp = ss.mass(back.bodies[0]?.shape ?? 0);
      vecClose(mp.bbox.min, [0, 0, 0], 1e-5);
      vecClose(mp.bbox.max, [10, 20, 30], 1e-5);
    });

    it('export/import errors are structured', () => {
      const codes = (json: string): KernelError['code'] => err(json).code;
      expect(codes(k.exportShapes('[{"shape":424242,"name":"x"}]', 'step', '{}'))).toBe(
        'INVALID_HANDLE',
      );
      expect(codes(k.exportShapes('[]', 'step', '{}'))).toBe('INVALID_INPUT');
      expect(codes(k.exportShapes('nope', 'step', '{}'))).toBe('INVALID_INPUT');
      const ss = session();
      const a = ss.exec(boxFeature(BOX), boxValues(1, 1, 1));
      const one = JSON.stringify([{ shape: a.shape, name: 'a' }]);
      expect(codes(k.exportShapes(one, 'obj', '{}'))).toBe('INVALID_INPUT');
      expect(codes(k.exportShapes(one, 'step', '{"stepSchema":"AP999"}'))).toBe('INVALID_INPUT');
      expect(codes(k.exportShapes(one, 'stl', '{"linearDeflection":-1}'))).toBe('INVALID_INPUT');
      k.FS.writeFile('/tmp/garbage.step', new TextEncoder().encode('not a step file'));
      expect(codes(k.importFile('/tmp/garbage.step', 'step'))).toBe('INVALID_INPUT');
      expect(codes(k.importFile('/tmp/garbage.step', 'brep'))).toBe('INVALID_INPUT');
      k.FS.unlink('/tmp/garbage.step');
      expect(codes(k.importFile('/tmp/missing.stl', 'stl'))).toBe('INVALID_INPUT');
      expect(codes(k.importFile('/tmp/missing.stl', 'iges'))).toBe('INVALID_INPUT');
    });

    describe('mass properties', () => {
      it('aluminium 10×20×30 box: mass 0.0162 kg and the analytic inertia tensor', () => {
        const ss = session();
        const box = ss.exec(boxFeature(BOX), boxValues(10, 20, 30));
        const mp = ss.mass(box.shape, 2.7e-6);
        relClose(mp.mass ?? 0, 0.0162, 1e-12);
        const m = 0.0162;
        const I = mp.inertia ?? [];
        expect(I).toHaveLength(9);
        relClose(I[0] ?? 0, (m * (20 ** 2 + 30 ** 2)) / 12, 1e-9);
        relClose(I[4] ?? 0, (m * (10 ** 2 + 30 ** 2)) / 12, 1e-9);
        relClose(I[8] ?? 0, (m * (10 ** 2 + 20 ** 2)) / 12, 1e-9);
        for (const i of [1, 2, 3, 5, 6, 7]) expect(Math.abs(I[i] ?? 1)).toBeLessThan(1e-12);
        // Geometry only without density.
        const plain = ss.mass(box.shape);
        expect(plain.mass).toBeUndefined();
        expect(plain.inertia).toBeUndefined();
        expect(err(k.massProperties(box.shape, -1)).code).toBe('INVALID_INPUT');
      });

      it('L-shaped body: products of inertia follow the standard tensor sign (−∫xy dm)', () => {
        const ss = session();
        const a = ss.exec(boxFeature(BOX), boxValues(20, 10, 10));
        const l = ss.exec(boxFeature('01JBOX00000000000000000003', frameAt([0, 10, 0]), 'add'), {
          ...boxValues(10, 10, 10),
          target: a.shape,
        });
        const rho = 1e-6;
        const mp = ss.mass(l.shape, rho);
        relClose(mp.volume, 3000, 1e-9);
        vecClose(mp.centroid, [25 / 3, 25 / 3, 5], 1e-9);
        // ∫(x−cx)(y−cy) dV = 2000·(10−25/3)(5−25/3) + 1000·(5−25/3)(15−25/3) = −100000/3.
        const pxy = 2000 * (10 - 25 / 3) * (5 - 25 / 3) + 1000 * (5 - 25 / 3) * (15 - 25 / 3);
        const I = mp.inertia ?? [];
        relClose(I[1] ?? 0, -pxy * rho, 1e-9);
        relClose(I[3] ?? 0, -pxy * rho, 1e-9);
        expect(Math.abs(I[2] ?? 1)).toBeLessThan(1e-12);
      });
    });

    it('fingerprints follow TopExp order', () => {
      const ss = session();
      const box = ss.exec(boxFeature(BOX), boxValues(10, 20, 30));
      const fp = ss.fingerprints(box.shape);
      expect(fp.faces).toHaveLength(6);
      expect(fp.edges).toHaveLength(12);
      expect(fp.vertices).toHaveLength(8);
      const zmax = fp.faces[indexOf(box, `F${BOX}:face.zmax`, 'face')];
      vecClose(zmax?.centroid ?? [], [5, 10, 30]);
      vecClose(zmax?.normal ?? [], [0, 0, 1], 1e-12);
      relClose(zmax?.area ?? 0, 200);
      expect(zmax?.surface).toBe('plane');
      const e = fp.edges[indexOf(box, `F${BOX}:edge(face.xmin|face.ymin)`, 'edge')];
      vecClose(e?.centroid ?? [], [0, 0, 15]);
      relClose(e?.length ?? 0, 30);
      expect(e?.curve).toBe('line');
      const v = fp.vertices[indexOf(box, `F${BOX}:vertex(max,max,max)`, 'vertex')];
      vecClose(v?.point ?? [], [10, 20, 30]);
      expect(err(k.fingerprints(424242)).code).toBe('INVALID_HANDLE');
    });

    it('configureThreads', () => {
      const r = ok<{ threads: number; max: number }>(k.configureThreads(2));
      if (variant === 'single') {
        expect(r).toEqual({ threads: 1, max: 1 });
      } else {
        expect(r.threads).toBeGreaterThanOrEqual(1);
        expect(r.threads).toBeLessThanOrEqual(Math.max(2, r.max));
        // Meshing still works on the resized pool.
        const ss = session();
        const box = ss.exec(boxFeature(BOX), boxValues(1, 2, 3));
        expect(meshShape(k, box.shape).indices.length).toBeGreaterThan(0);
        ok(k.configureThreads(r.max));
      }
      expect(err(k.configureThreads(0)).code).toBe('INVALID_INPUT');
    });
  });
}
