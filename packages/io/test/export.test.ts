// SPDX-License-Identifier: GPL-3.0-or-later
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  analyzeStl,
  checkMesh,
  meshExporters,
  meshToStl,
  parseStl,
  to3mf,
  toGlb,
  weldMesh,
} from '../src';
import { scanXml } from '../src/xml';
import { boxMesh, openBox } from './helpers';

const dec = new TextDecoder();

describe('weldMesh / checkMesh', () => {
  it('welds a 24-vertex box to 8 vertices, 12 triangles', () => {
    const b = boxMesh(10, 20, 30);
    const w = weldMesh(b.positions, b.indices);
    expect(w.vertices.length / 3).toBe(8);
    expect(w.triangles.length / 3).toBe(12);
    const r = checkMesh(w.vertices, w.triangles);
    expect(r.valid).toBe(true);
    expect(r.signedVolume).toBeCloseTo(6000, 6);
  });
  it('flags open boxes and flipped winding', () => {
    const o = openBox(1, 1, 1);
    const w = weldMesh(o.positions, o.indices);
    expect(checkMesh(w.vertices, w.triangles).boundaryEdges).toBe(4);
    const b = boxMesh(1, 1, 1);
    const flipped = Uint32Array.from(b.indices);
    for (let i = 0; i < 6; i++) {
      const t = flipped[i * 3 + 1] as number;
      flipped[i * 3 + 1] = flipped[i * 3 + 2] as number;
      flipped[i * 3 + 2] = t;
    }
    const wf = weldMesh(b.positions, flipped);
    const rf = checkMesh(wf.vertices, wf.triangles);
    expect(rf.inconsistentEdges).toBeGreaterThan(0);
    expect(rf.valid).toBe(false);
  });
  it('drops degenerate triangles and rejects bad indices', () => {
    const pos = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 2, 2]);
    const w = weldMesh(pos, Uint32Array.from([0, 1, 2, 0, 0, 1]));
    expect(w.degenerateRemoved).toBe(1);
    expect(() => weldMesh(pos, Uint32Array.from([0, 1, 9]))).toThrow(RangeError);
  });
});

describe('3MF export', () => {
  const body = { name: 'Plate <A&B>', mesh: boxMesh(10, 20, 30), color: '#ff8000' };
  const bytes = to3mf([body], 'millimeter');
  const files = unzipSync(bytes);

  it('has the required OPC parts, content types first', () => {
    expect(Object.keys(files)).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    expect(dec.decode(files['[Content_Types].xml'])).toContain(
      'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
    );
    expect(dec.decode(files['_rels/.rels'])).toContain('Target="/3D/3dmodel.model"');
  });
  it('is well-formed XML with unit, welded counts, material and escaped name', () => {
    const xml = dec.decode(files['3D/3dmodel.model']);
    const stack: string[] = [];
    const counts: Record<string, number> = {};
    let attrs: Record<string, Record<string, string>> = {};
    scanXml(xml, {
      open(n, a, sc) {
        counts[n] = (counts[n] ?? 0) + 1;
        attrs[n] = a;
        if (!sc) stack.push(n);
      },
      close(n) {
        if (stack[stack.length - 1] === n) stack.pop();
      },
    });
    expect(stack).toEqual([]);
    expect(counts.vertex).toBe(8);
    expect(counts.triangle).toBe(12);
    expect(counts.object).toBe(1);
    expect(counts.item).toBe(1);
    expect(attrs.model?.unit).toBe('millimeter');
    expect(attrs.object?.type).toBe('model');
    expect(attrs.object?.name).toBe('Plate <A&B>');
    expect(attrs.object?.pid).toBe(attrs.basematerials?.id);
    expect(attrs.base?.displaycolor).toBe('#FF8000FF');
    expect(xml).toContain('name="Plate &lt;A&amp;B&gt;"');
    attrs = {};
  });
  it('every triangle references valid vertices with consistent outward winding', () => {
    const xml = dec.decode(files['3D/3dmodel.model']);
    const v: number[] = [];
    const t: number[] = [];
    scanXml(xml, {
      open(n, a) {
        if (n === 'vertex') v.push(Number(a.x), Number(a.y), Number(a.z));
        if (n === 'triangle') t.push(Number(a.v1), Number(a.v2), Number(a.v3));
      },
      close() {},
    });
    expect(t.every((i) => Number.isInteger(i) && i >= 0 && i < v.length / 3)).toBe(true);
    const r = checkMesh(v, t);
    expect(r.valid).toBe(true);
    expect(r.signedVolume).toBeCloseTo(6000, 6);
  });
  it('is deterministic', () => {
    expect(Array.from(to3mf([body], 'millimeter'))).toEqual(Array.from(bytes));
  });
  it('reports non-manifold bodies and skips empty ones', () => {
    const reports: boolean[] = [];
    const empty = { ...boxMesh(1, 1, 1), indices: new Uint32Array(0) };
    const out = to3mf(
      [
        { name: 'open', mesh: openBox(1, 1, 1) },
        { name: 'empty', mesh: empty },
      ],
      'millimeter',
      { onReport: (_n, r) => reports.push(r.valid) },
    );
    expect(reports).toEqual([false, false]);
    const xml = dec.decode(unzipSync(out)['3D/3dmodel.model']);
    expect(xml.match(/<object /g)?.length).toBe(1);
  });
  it('exposes MeshExporters', () => {
    expect(meshExporters.to3mf([body], 'millimeter').byteLength).toBe(bytes.byteLength);
    expect(meshExporters.toGlb([body]).byteLength).toBeGreaterThan(0);
  });
});

interface ParsedGlb {
  json: {
    asset: { version: string };
    scenes: { nodes: number[] }[];
    nodes: { name: string; mesh: number }[];
    meshes: {
      name: string;
      primitives: { attributes: Record<string, number>; indices: number; material: number }[];
    }[];
    materials: { pbrMetallicRoughness: { baseColorFactor: number[] } }[];
    accessors: {
      bufferView: number;
      componentType: number;
      count: number;
      type: string;
      min?: number[];
      max?: number[];
    }[];
    bufferViews: { byteOffset: number; byteLength: number }[];
    buffers: { byteLength: number }[];
  };
  bin: Uint8Array;
  total: number;
}

function parseGlb(b: Uint8Array): ParsedGlb {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  expect(dv.getUint32(0, true)).toBe(0x46546c67);
  expect(dv.getUint32(4, true)).toBe(2);
  const total = dv.getUint32(8, true);
  expect(total).toBe(b.byteLength);
  expect(total % 4).toBe(0);
  const jl = dv.getUint32(12, true);
  expect(dv.getUint32(16, true)).toBe(0x4e4f534a);
  expect(jl % 4).toBe(0);
  const json = JSON.parse(dec.decode(b.subarray(20, 20 + jl)));
  const p = 20 + jl;
  const bl = dv.getUint32(p, true);
  expect(dv.getUint32(p + 4, true)).toBe(0x004e4942);
  expect(bl % 4).toBe(0);
  expect(p + 8 + bl).toBe(total);
  return { json, bin: b.subarray(p + 8, p + 8 + bl), total };
}

describe('GLB export', () => {
  const glb = toGlb([
    { name: 'Box', mesh: boxMesh(10, 20, 30), color: '#336699' },
    { name: 'Other', mesh: boxMesh(1, 1, 1, 100, 0, 0) },
  ]);
  const g = parseGlb(glb);

  it('has valid container structure and structure counts', () => {
    expect(g.json.asset.version).toBe('2.0');
    expect(g.json.nodes.map((n) => n.name)).toEqual(['Box', 'Other']);
    expect(g.json.scenes[0]?.nodes).toEqual([0, 1]);
    expect(g.json.meshes).toHaveLength(2);
    expect(g.json.buffers[0]?.byteLength).toBe(g.bin.byteLength);
  });
  it('bufferViews are 4-byte aligned and in bounds; accessors consistent', () => {
    for (const bv of g.json.bufferViews) {
      expect(bv.byteOffset % 4).toBe(0);
      expect(bv.byteOffset + bv.byteLength).toBeLessThanOrEqual(g.bin.byteLength);
    }
    for (const m of g.json.meshes) {
      const prim = m.primitives[0];
      const pos = g.json.accessors[prim?.attributes.POSITION as number];
      expect(pos?.type).toBe('VEC3');
      expect(pos?.count).toBe(24);
      expect(pos?.min).toHaveLength(3);
      expect(pos?.max).toHaveLength(3);
      expect(g.json.accessors[prim?.attributes.NORMAL as number]?.count).toBe(24);
      expect(g.json.accessors[prim?.indices as number]?.count).toBe(36);
    }
  });
  it('POSITION is in metres (mm x 0.001) with accurate min/max', () => {
    const pos = g.json.accessors[g.json.meshes[0]?.primitives[0]?.attributes.POSITION as number];
    expect(pos?.min?.map((v) => +v.toFixed(6))).toEqual([0, 0, 0]);
    expect(pos?.max?.map((v) => +v.toFixed(6))).toEqual([0.01, 0.02, 0.03]);
    const bv = g.json.bufferViews[pos?.bufferView as number];
    const f = new Float32Array(
      g.bin.slice(bv?.byteOffset, (bv?.byteOffset ?? 0) + (bv?.byteLength ?? 0)).buffer,
    );
    expect(Math.max(...f)).toBeCloseTo(0.03, 6);
  });
  it('material colour is linear PBR', () => {
    const c = g.json.materials[0]?.pbrMetallicRoughness.baseColorFactor ?? [];
    expect(c[0]).toBeCloseTo(0.0331, 3); // 0x33 sRGB -> linear
    expect(c[2]).toBeCloseTo(0.3185, 3); // 0x99
    expect(c[3]).toBe(1);
  });
  it('handles zero bodies', () => {
    const empty = toGlb([]);
    const dv = new DataView(empty.buffer);
    expect(dv.getUint32(8, true)).toBe(empty.byteLength);
  });
});

describe('STL helpers', () => {
  const box = { name: 'b', mesh: boxMesh(10, 20, 30) };
  it('binary has right size and round trips', () => {
    const bin = meshToStl([box]);
    expect(bin.byteLength).toBe(84 + 12 * 50);
    expect(parseStl(bin).length).toBe(12 * 9);
  });
  it('ascii round trips to the same triangles as binary', () => {
    const asc = meshToStl([box], { binary: false });
    expect(dec.decode(asc.subarray(0, 8))).toBe('solid b\n');
    expect(Array.from(parseStl(asc))).toEqual(Array.from(parseStl(meshToStl([box]))));
  });
  it('analyze: watertight box, volume 6000, bbox', () => {
    for (const binary of [true, false]) {
      const a = analyzeStl(meshToStl([box], { binary }));
      expect(a.triangles).toBe(12);
      expect(a.watertight).toBe(true);
      expect(Math.abs(a.volume - 6000)).toBeLessThan(1e-6);
      expect(a.bbox).toEqual({ min: [0, 0, 0], max: [10, 20, 30] });
    }
  });
  it('analyze: open box is not watertight', () => {
    const a = analyzeStl(meshToStl([{ mesh: openBox(10, 20, 30) }]));
    expect(a.triangles).toBe(10);
    expect(a.watertight).toBe(false);
    expect(a.boundaryEdges).toBe(4);
  });
  it('multiple bodies concatenate', () => {
    const a = analyzeStl(meshToStl([box, { mesh: boxMesh(1, 1, 1, 50, 0, 0) }]));
    expect(a.triangles).toBe(24);
    expect(a.watertight).toBe(true);
    expect(a.volume).toBeCloseTo(6001, 6);
  });
});
