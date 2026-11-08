import { boxMesh } from '@whittle/test-fixtures';
import { describe, expect, it } from 'vitest';
import {
  decodeId,
  deriveVertices,
  encodeId,
  faceDrawRange,
  faceIdPerVertex,
  idAtPixel,
  MAX_ID,
  NO_FACE,
  triangleToFace,
} from '../src/ids';

describe('id encoding', () => {
  it('round trips the full 24-bit range', () => {
    for (const id of [0, 1, 255, 256, 65535, 65536, 123456, MAX_ID]) {
      const [r, g, b] = encodeId(id);
      expect(decodeId(r, g, b)).toBe(id);
    }
  });

  it('packs big-endian into RGB', () => {
    expect(encodeId(0x010203)).toEqual([1, 2, 3]);
  });
});

describe('idAtPixel', () => {
  // 2x2 image, rows stored bottom-first (WebGL): bottom row ids 1,2; top row ids 3,4.
  const px = (id: number) => [...encodeId(id), 255];
  const data = Uint8Array.from([...px(1), ...px(2), ...px(3), ...px(4)]);

  it('reads WebGL (bottom-up) readbacks', () => {
    expect(idAtPixel(data, 2, 2, 0, 0, true)).toBe(3); // top-left of the image
    expect(idAtPixel(data, 2, 2, 1, 1, true)).toBe(2); // bottom-right
  });

  it('reads WebGPU (top-down) readbacks', () => {
    expect(idAtPixel(data, 2, 2, 0, 0, false)).toBe(1);
    expect(idAtPixel(data, 2, 2, 1, 1, false)).toBe(4);
  });

  it('clamps out-of-range and fractional coordinates', () => {
    expect(idAtPixel(data, 2, 2, 99, -5, false)).toBe(2);
    expect(idAtPixel(data, 2, 2, 0.9, 0.9, false)).toBe(1);
  });
});

describe('faceIdPerVertex', () => {
  it('maps per-face vertices directly (no copies) for the box fixture', () => {
    const box = boxMesh(1, 1, 1);
    const l = faceIdPerVertex(box.positions.length / 3, box.indices, box.faceRanges);
    expect(l.appended.length).toBe(0);
    expect(l.indices).toBe(box.indices);
    for (let f = 0; f < 6; f++) {
      for (let k = 0; k < 4; k++) expect(l.faceOfVertex[f * 4 + k]).toBe(f);
    }
  });

  it('duplicates vertices shared between faces', () => {
    // Two triangles sharing vertices 1 and 2, in different faces.
    const indices = Uint32Array.from([0, 1, 2, 1, 3, 2]);
    const l = faceIdPerVertex(4, indices, Uint32Array.from([0, 1, 1, 1]));
    expect(l.appended.length).toBe(2);
    expect([...l.appended].sort()).toEqual([1, 2]);
    expect(l.indices).not.toBe(indices);
    expect(indices[3]).toBe(1); // input untouched
    // Every vertex referenced by face 1's triangle belongs to face 1.
    for (const slot of [3, 4, 5]) {
      expect(l.faceOfVertex[l.indices[slot] as number]).toBe(1);
    }
    for (const slot of [0, 1, 2]) {
      expect(l.faceOfVertex[l.indices[slot] as number]).toBe(0);
    }
  });

  it('marks unreferenced vertices', () => {
    const l = faceIdPerVertex(4, Uint32Array.from([0, 1, 2]), Uint32Array.from([0, 1]));
    expect(l.faceOfVertex[3]).toBe(NO_FACE);
  });
});

describe('face ranges', () => {
  it('maps triangles to faces', () => {
    const t = triangleToFace(Uint32Array.from([0, 2, 2, 3]), 6);
    expect([...t]).toEqual([0, 0, 1, 1, 1, NO_FACE]);
  });

  it('gives index-buffer draw ranges for highlight overlays', () => {
    const box = boxMesh(1, 2, 3);
    expect(faceDrawRange(box.faceRanges, 0, 12)).toEqual({ start: 0, count: 6 });
    expect(faceDrawRange(box.faceRanges, 5, 12)).toEqual({ start: 30, count: 6 });
    expect(faceDrawRange(box.faceRanges, 6, 12)).toBeNull();
    expect(faceDrawRange(box.faceRanges, -1, 12)).toBeNull();
  });

  it('clamps ranges that run past the index buffer', () => {
    expect(faceDrawRange(Uint32Array.from([2, 10]), 0, 4)).toEqual({ start: 6, count: 6 });
    expect(faceDrawRange(Uint32Array.from([9, 3]), 0, 4)).toBeNull();
  });
});

describe('deriveVertices', () => {
  it('derives the 8 distinct box corners in order of first appearance', () => {
    const box = boxMesh(40, 30, 20);
    const v = deriveVertices(box.edgePositions, box.edgeRanges, box.bbox);
    expect(v.length / 3).toBe(8);
    expect([...v.slice(0, 6)]).toEqual([0, 0, 0, 0, 0, 20]); // vertices 0 and 1
    expect([...v.slice(21, 24)]).toEqual([40, 30, 20]); // vertex 7
  });

  it('merges coincident closed-loop endpoints into one vertex', () => {
    const loop = Float32Array.from([1, 0, 0, 0, 1, 0, -1, 0, 0, 1, 0, 0]);
    const v = deriveVertices(loop, Uint32Array.from([0, 4]), {
      min: [-1, -1, 0],
      max: [1, 1, 0],
    });
    expect(v.length / 3).toBe(1);
  });
});
