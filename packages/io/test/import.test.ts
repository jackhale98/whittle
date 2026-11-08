// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  analyzeStl,
  detectMeshFormat,
  IoError,
  import3mf,
  importGlb,
  importMesh,
  importObj,
  importStl,
  meshToStl,
  to3mf,
  toGlb,
} from '../src';
import { boxMesh } from './helpers';

const fx = (n: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url))));
const enc = new TextEncoder();

function expectIoError(fn: () => unknown, code?: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(IoError);
    if (code) expect((e as IoError).code).toBe(code);
    return;
  }
  throw new Error('expected IoError');
}

describe('STL import', () => {
  it('ASCII fixture', () => {
    const [b] = importStl(fx('tetra.stl'), { name: 'tetra' });
    expect(b?.mesh.indices.length).toBe(12);
    expect(b?.mesh.faceRanges).toEqual(Uint32Array.from([0, 4]));
    expect(b?.mesh.edgePositions.length).toBe(0);
    expect(b?.mesh.bbox).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(analyzeStl(fx('tetra.stl')).volume).toBeCloseTo(1 / 6, 9);
  });
  it('binary round trip keeps geometry', () => {
    const bin = meshToStl([{ mesh: boxMesh(10, 20, 30) }]);
    const [b] = importStl(bin);
    expect(b?.mesh.bbox).toEqual({ min: [0, 0, 0], max: [10, 20, 30] });
    expect(b?.mesh.normals.length).toBe(b?.mesh.positions.length);
    expect(analyzeStl(meshToStl([{ mesh: b?.mesh as never }])).volume).toBeCloseTo(6000, 6);
  });
  it('rejects junk with clear errors', () => {
    expectIoError(() => importStl(fx('two-vertex-facet.stl')), 'malformed');
    expectIoError(() => importStl(fx('nan.stl')), 'malformed');
    expectIoError(() => importStl(fx('junk.bin')), 'malformed');
    expectIoError(() => importStl(new Uint8Array(10)), 'malformed');
    expectIoError(() => importStl(enc.encode('solid x\nendsolid x\n')), 'empty');
  });
  it('binary header lying about triangle count is rejected, not allocated', () => {
    const b = new Uint8Array(84 + 50);
    new DataView(b.buffer).setUint32(80, 0xffffffff, true);
    expectIoError(() => importStl(b), 'malformed');
  });
  it('enforces size and triangle caps', () => {
    const bin = meshToStl([{ mesh: boxMesh(1, 1, 1) }]);
    expectIoError(() => importStl(bin, { limits: { maxBytes: 100 } }), 'too-large');
    expectIoError(() => importStl(bin, { limits: { maxTriangles: 5 } }), 'too-large');
    const asc = meshToStl([{ mesh: boxMesh(1, 1, 1) }], { binary: false });
    expectIoError(() => importStl(asc, { limits: { maxTriangles: 5 } }), 'too-large');
  });
});

describe('OBJ import', () => {
  it('fan-triangulates quads and uses vn', () => {
    const [b] = importObj(fx('cube.obj'));
    expect(b?.name).toBe('Cube');
    expect((b?.mesh.indices.length ?? 0) / 3).toBe(12);
    expect(b?.mesh.bbox).toEqual({ min: [0, 0, 0], max: [10, 10, 10] });
    expect(Array.from(b?.mesh.normals.slice(0, 3) ?? [])).toEqual([0, 0, -1]);
    const a = analyzeStl(meshToStl([{ mesh: b?.mesh as never }]));
    expect(a.watertight).toBe(true);
    expect(a.volume).toBeCloseTo(1000, 6);
  });
  it('splits objects and supports negative indices', () => {
    const r = importObj(fx('negative.obj'));
    expect(r.map((b) => b.name)).toEqual(['Two', 'Other']);
    expect(r[0]?.mesh.indices.length).toBe(6);
  });
  it('rejects bad indices, empty and size', () => {
    expectIoError(() => importObj(fx('bad-index.obj')), 'malformed');
    expectIoError(() => importObj('# nothing\n'), 'empty');
    expectIoError(() => importObj('f 1 2\n'), 'malformed');
    expectIoError(() => importObj(fx('cube.obj'), { limits: { maxBytes: 10 } }), 'too-large');
    expectIoError(() => importObj(fx('cube.obj'), { limits: { maxTriangles: 3 } }), 'too-large');
  });
});

describe('3MF import', () => {
  it('reads back what we write', () => {
    const out = import3mf(
      to3mf(
        [
          { name: 'A', mesh: boxMesh(10, 20, 30) },
          { name: 'B', mesh: boxMesh(1, 1, 1, 5, 5, 5) },
        ],
        'millimeter',
      ),
    );
    expect(out.map((b) => b.name)).toEqual(['A', 'B']);
    expect(out[0]?.mesh.bbox).toEqual({ min: [0, 0, 0], max: [10, 20, 30] });
    expect((out[0]?.mesh.indices.length ?? 0) / 3).toBe(12);
    expect(analyzeStl(meshToStl([{ mesh: out[0]?.mesh as never }])).volume).toBeCloseTo(6000, 4);
  });

  const tri =
    '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>';
  const pkg = (model: string, extra: Record<string, Uint8Array> = {}) =>
    zipSync({
      '_rels/.rels': enc.encode(
        '<Relationships xmlns="r"><Relationship Target="/3D/3dmodel.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
      ),
      '3D/3dmodel.model': enc.encode(model),
      ...extra,
    });

  it('slicer-style: components, transforms, inch units, namespaces, comments', () => {
    const model = `<?xml version="1.0"?><!-- slicer --><model unit="inch" xmlns="x" xmlns:p="p">
      <resources>
        <object id="1" type="model">${tri}</object>
        <object id="2" type="model" name="Asm"><components>
          <component objectid="1" transform="1 0 0 0 1 0 0 0 1 1 0 0"/>
          <component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 2 0"/>
        </components></object>
      </resources>
      <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 3" p:uuid="u"/></build></model>`;
    const out = import3mf(pkg(model));
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('Asm');
    expect((out[0]?.mesh.indices.length ?? 0) / 3).toBe(2);
    const b = out[0]?.mesh.bbox;
    expect(b?.min[0]).toBeCloseTo(0, 5);
    expect(b?.max[0]).toBeCloseTo(2 * 25.4, 4); // second tri x up to 1in, first shifted 1in
    expect(b?.max[1]).toBeCloseTo(3 * 25.4, 4);
    expect(b?.min[2]).toBeCloseTo(3 * 25.4, 4);
  });
  it('without build items imports model objects', () => {
    const out = import3mf(
      pkg(
        `<model unit="millimeter"><resources><object id="1" type="model">${tri}</object></resources></model>`,
      ),
    );
    expect(out).toHaveLength(1);
  });
  it('rejects malformed packages', () => {
    expectIoError(() => import3mf(fx('junk.bin')), 'malformed');
    expectIoError(() => import3mf(zipSync({ 'a.txt': enc.encode('hi') })), 'malformed');
    expectIoError(
      () =>
        import3mf(
          pkg(
            `<model><resources><object id="1">${tri.replace('v3="2"', 'v3="7"')}</object></resources><build><item objectid="1"/></build></model>`,
          ),
        ),
      'malformed',
    );
    expectIoError(
      () =>
        import3mf(pkg('<model><resources></resources><build><item objectid="4"/></build></model>')),
      'malformed',
    );
    expectIoError(() => import3mf(pkg('<model><resources></resources></model>')), 'empty');
    expectIoError(
      () =>
        import3mf(
          pkg(
            `<model><resources><object id="1">${tri}</object></resources><build><item objectid="1"/></build></model>`,
          ),
          { limits: { maxTriangles: 0 } },
        ),
      'too-large',
    );
  });
  it('guards against zip bombs via entry size', () => {
    const big = pkg(`<model>${' '.repeat(2_000_000)}</model>`);
    expectIoError(() => import3mf(big, { limits: { maxBytes: 1_000_000 } }), 'too-large');
  });
  it('detects self-referencing components', () => {
    const model = `<model><resources><object id="1"><components><component objectid="1"/></components></object></resources><build><item objectid="1"/></build></model>`;
    expectIoError(() => import3mf(pkg(model)), 'malformed');
  });
});

describe('GLB import', () => {
  it('round-trips our exporter (mm -> m -> mm), multiple bodies', () => {
    const out = importGlb(
      toGlb([
        { name: 'A', mesh: boxMesh(10, 20, 30) },
        { name: 'B', mesh: boxMesh(1, 1, 1, 100, 0, 0) },
      ]),
    );
    expect(out.map((b) => b.name)).toEqual(['A', 'B']);
    const bb = out[0]?.mesh.bbox;
    expect(bb?.max[0]).toBeCloseTo(10, 4);
    expect(bb?.max[2]).toBeCloseTo(30, 4);
    expect(out[1]?.mesh.bbox.min[0]).toBeCloseTo(100, 4);
    expect((out[0]?.mesh.indices.length ?? 0) / 3).toBe(12);
    // normals kept from file
    expect(Array.from(out[0]?.mesh.normals.slice(0, 3) ?? [])).toEqual([0, 0, -1]);
  });
  it('applies node transforms (TRS and matrix, nested)', () => {
    const base = toGlb([{ name: 'A', mesh: boxMesh(1, 1, 1) }]);
    const dv = new DataView(base.buffer, base.byteOffset);
    const jl = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(base.subarray(20, 20 + jl)));
    json.nodes = [
      { name: 'parent', translation: [1, 0, 0], scale: [2, 2, 2], children: [1] },
      { name: 'child', mesh: 0, translation: [0, 1, 0] },
    ];
    json.scenes = [{ nodes: [0] }];
    const js = new TextEncoder().encode(JSON.stringify(json));
    const padded = new Uint8Array((js.length + 3) & ~3).fill(0x20);
    padded.set(js);
    const rest = base.subarray(20 + jl);
    const out = new Uint8Array(20 + padded.length + rest.length);
    out.set(base.subarray(0, 12));
    new DataView(out.buffer).setUint32(8, out.length, true);
    new DataView(out.buffer).setUint32(12, padded.length, true);
    new DataView(out.buffer).setUint32(16, 0x4e4f534a, true);
    out.set(padded, 20);
    out.set(rest, 20 + padded.length);
    const [b] = importGlb(out);
    // child at y=1 (metres), box 1mm = 0.001 m; parent scale 2 + translate x 1 m.
    expect(b?.name).toBe('child');
    expect(b?.mesh.bbox.min[0]).toBeCloseTo(1000, 3);
    expect(b?.mesh.bbox.min[1]).toBeCloseTo(2000, 3);
    expect(b?.mesh.bbox.max[0]).toBeCloseTo(1002, 3);
  });
  it('rejects junk', () => {
    expectIoError(() => importGlb(fx('junk.bin')), 'malformed');
    expectIoError(() => importGlb(new Uint8Array(4)), 'malformed');
    const good = toGlb([{ name: 'A', mesh: boxMesh(1, 1, 1) }]);
    expectIoError(() => importGlb(good.subarray(0, good.length - 40)), 'malformed');
    const bad = good.slice();
    new DataView(bad.buffer).setUint32(4, 1, true);
    expectIoError(() => importGlb(bad), 'unsupported');
    expectIoError(() => importGlb(toGlb([])), 'empty');
    expectIoError(() => importGlb(good, { limits: { maxTriangles: 3 } }), 'too-large');
  });
});

describe('importMesh dispatch', () => {
  it('detects formats by content then extension', () => {
    expect(detectMeshFormat(fx('tetra.stl'))).toBe('stl');
    expect(detectMeshFormat(meshToStl([{ mesh: boxMesh(1, 1, 1) }]))).toBe('stl');
    expect(detectMeshFormat(fx('cube.obj'), 'x.obj')).toBe('obj');
    expect(detectMeshFormat(fx('cube.obj'))).toBe('obj');
    expect(detectMeshFormat(to3mf([{ name: 'a', mesh: boxMesh(1, 1, 1) }], 'millimeter'))).toBe(
      '3mf',
    );
    expect(detectMeshFormat(toGlb([{ name: 'a', mesh: boxMesh(1, 1, 1) }]))).toBe('glb');
    expect(detectMeshFormat(fx('junk.bin'))).toBeUndefined();
  });
  it('imports and names by file', () => {
    expect(importMesh(fx('tetra.stl'), 'C:\\x\\part.stl')[0]?.name).toBe('part');
    expectIoError(() => importMesh(fx('junk.bin'), 'junk.bin'), 'unsupported');
  });
});
