import { describe, expect, it } from 'vitest';
import { attentionItems, attentionMarkers, partDiagonal } from './attention';
import { IMPORT_EXTENSIONS, importFeature, importFormat, importName, sha256Hex } from './import';

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

  it('pickers offer only formats the engine reads (IGES is recognised, not offered)', () => {
    expect(IMPORT_EXTENSIONS).toContain('.step');
    expect(IMPORT_EXTENSIONS).toContain('.stl');
    expect(IMPORT_EXTENSIONS).not.toContain('.igs');
    expect(IMPORT_EXTENSIONS).not.toContain('.iges');
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
  it('marks an edge or a face at its fingerprint', () => {
    const edge = attentionMarkers(
      { name: 'e', kind: 'edge', fingerprint: { centroid: [10, 0, 5], length: 8 } },
      2,
    );
    expect(edge?.map((m) => m.kind)).toEqual(['polyline', 'polyline', 'point']);
    expect(edge?.every((m) => m.tone === 'warning')).toBe(true);
    const xs = edge?.[0]?.points.map((p) => p[0]) ?? [];
    expect(Math.min(...xs)).toBeCloseTo(8);
    expect(Math.max(...xs)).toBeCloseTo(12);
    expect(edge?.[0]?.dashed).toBe(true);
    const face = attentionMarkers(
      {
        name: 'f',
        kind: 'face',
        fingerprint: { centroid: [0, 0, 10], normal: [0, 0, 1], area: 100 },
      },
      2,
    );
    const sq = face?.[0]?.points ?? [];
    expect(sq).toHaveLength(5); // a closed 10 × 10 square in the old plane
    expect(Math.max(...sq.map((p) => p[0])) - Math.min(...sq.map((p) => p[0]))).toBeCloseTo(10);
    expect(Math.min(...sq.map((p) => p[2]))).toBeGreaterThan(10);
    expect(attentionMarkers({ name: 'x', kind: 'edge' }, 2)).toBeNull();
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
