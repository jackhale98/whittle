import type { MeshBuffers } from '@whittle/contracts';
import { newDoc, projectCodec } from '@whittle/document';
import { describe, expect, it } from 'vitest';
import {
  decodeCache,
  decodeMesh,
  docKey,
  encodeCache,
  encodeMesh,
  MESH_INDEX,
  withoutMeshes,
} from './mesh-cache';

const mesh = (offset = 0): MeshBuffers => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, offset]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  faceRanges: new Uint32Array([0, 1]),
  edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
  edgeRanges: new Uint32Array([0, 2]),
  vertexPositions: new Float32Array([0, 0, 0]),
  faceNames: ['F1:face.top'],
  edgeNames: ['F1:edge(a|b)'],
  bbox: { min: [0, 0, 0], max: [1, 1, offset] },
});

describe('mesh cache', () => {
  it('round-trips a body mesh through the compact binary form', () => {
    const m = mesh(0.5);
    const bytes = encodeMesh(m);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('WMB1');
    // Unaligned, as zip entries are.
    const shifted = new Uint8Array(bytes.byteLength + 1);
    shifted.set(bytes, 1);
    expect(decodeMesh(shifted.subarray(1))).toEqual(m);
    expect(() => decodeMesh(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
  });

  it('is keyed by the document content and ignored when stale', () => {
    const doc = newDoc({ name: 'A', firstPart: 'P' });
    const key = docKey(doc);
    // Renames and timestamps do not change the key; geometry inputs do.
    expect(docKey({ ...doc, meta: { ...doc.meta, name: 'B', modified: 'x' } })).toBe(key);
    expect(docKey({ ...doc, params: [{ id: 'x', name: 'w', expr: '1 mm' }] })).not.toBe(key);

    const files = encodeCache({
      key,
      bodies: [{ id: 'B01J#0', mesh: mesh() }],
      sketches: [
        {
          featureId: 'S',
          curves: [
            { entity: 'e', points: new Float32Array([0, 0, 0, 1, 2, 3]), construction: false },
          ],
          regions: [],
          frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
        },
      ],
    });
    expect([...files.keys()].sort()).toEqual(['meshes/B01J_0.bin', MESH_INDEX]);
    const back = decodeCache(files, key);
    expect(back?.bodies[0]?.id).toBe('B01J#0');
    expect(back?.bodies[0]?.mesh).toEqual(mesh());
    expect(Array.from(back?.sketches[0]?.curves[0]?.points ?? [])).toEqual([0, 0, 0, 1, 2, 3]);
    expect(decodeCache(files, 'other')).toBeNull();
    expect(decodeCache(new Map(), key)).toBeNull();
    const broken = new Map(files);
    broken.delete('meshes/B01J_0.bin');
    expect(decodeCache(broken, key)).toBeNull();

    // It travels in the .whittle cache and survives the codec.
    const other = new Map([['thumbs/x.png', new Uint8Array([1])]]);
    const zipped = projectCodec.toWhittle(doc, new Map([...other, ...files]));
    const { cache } = projectCodec.fromWhittle(zipped);
    expect(decodeCache(cache, key)?.bodies).toHaveLength(1);
    expect([...withoutMeshes(cache).keys()]).toEqual(['thumbs/x.png']);
  });
});
