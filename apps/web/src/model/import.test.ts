import { describe, expect, it } from 'vitest';
import { attentionItems, markerMesh, partDiagonal } from './attention';
import { importFeature, importFormat, importName, sha256Hex } from './import';

describe('import', () => {
  it('maps file extensions to import formats', () => {
    expect(importFormat('a.STEP')).toBe('step');
    expect(importFormat('a.stp')).toBe('step');
    expect(importFormat('a.igs')).toBe('iges');
    expect(importFormat('a.brep')).toBe('brep');
    expect(importFormat('a.stl')).toBe('stl');
    expect(importFormat('a.obj')).toBe('obj');
    expect(importFormat('a.3mf')).toBe('3mf');
    expect(importFormat('a.glb')).toBe('glb');
    expect(importFormat('a.whittle')).toBeNull();
    expect(importFormat('noext')).toBeNull();
  });

  it('hashes with WebCrypto and builds an import feature with its attachment path', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const part = { features: [] };
    const made = await importFeature(part, 'bracket.stp', new Uint8Array([1, 2]));
    expect(made?.feature.type).toBe('import');
    expect(made?.feature.name).toBe('bracket');
    expect(made?.feature.source.format).toBe('step');
    expect(made?.feature.source.fileName).toBe('bracket.stp');
    expect(made?.path).toBe(`imports/${made?.feature.id}.step`);
    expect(made?.feature.source.path).toBe(made?.path);
    expect(await importFeature(part, 'notes.txt', new Uint8Array())).toBeNull();
    expect(importName({ features: [{ name: 'bracket' } as never] }, 'bracket.step')).toBe(
      'bracket 2',
    );
  });
});

describe('needs attention', () => {
  it('ghosts an edge or a face at its fingerprint', () => {
    const edge = markerMesh(
      { name: 'e', kind: 'edge', fingerprint: { centroid: [10, 0, 5], length: 8 } },
      2,
    );
    expect(edge?.indices.length).toBe(24); // a small diamond
    expect(edge?.edgeRanges.length).toBeGreaterThan(0); // dashed rings
    expect(edge?.bbox.min[0]).toBeCloseTo(8);
    expect(edge?.bbox.max[0]).toBeCloseTo(12);
    const face = markerMesh(
      {
        name: 'f',
        kind: 'face',
        fingerprint: { centroid: [0, 0, 10], normal: [0, 0, 1], area: 100 },
      },
      2,
    );
    expect(face?.indices.length).toBe(6); // a 10 × 10 square in the old plane
    expect((face?.bbox.max[0] ?? 0) - (face?.bbox.min[0] ?? 0)).toBeCloseTo(10);
    expect(face?.bbox.min[2]).toBeGreaterThan(10);
    expect(markerMesh({ name: 'x', kind: 'edge' }, 2)).toBeNull();
  });

  it('lists unresolved references of features that need attention', () => {
    const ref = { name: 'e', kind: 'edge' as const };
    expect(
      attentionItems([
        { featureId: 'A', state: 'ok', cached: false, ms: 0 },
        {
          featureId: 'B',
          state: 'needsAttention',
          cached: false,
          ms: 0,
          unresolved: [{ path: '/edges/0', ref, reason: 'missing' }],
        },
      ]),
    ).toEqual([{ featureId: 'B', unresolved: { path: '/edges/0', ref, reason: 'missing' } }]);
    expect(partDiagonal(undefined, 7)).toBe(7);
  });
});
