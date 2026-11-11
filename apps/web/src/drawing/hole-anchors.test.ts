import type { Annotation, AnnotationResolution, RegenResult } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { cylinderAnchor, withHoleAnchors } from './hole-anchors';

/** A cylinder wall (radius r, along z from 0 to h, centre (cx, cy)) as the tessellator emits it. */
function wall(r: number, h: number, cx: number, cy: number, n = 24) {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    positions.push(cx + r * nx, cy + r * ny, 0, cx + r * nx, cy + r * ny, h);
    normals.push(nx, ny, 0, nx, ny, 0);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(2 * i, 2 * j, 2 * i + 1, 2 * j, 2 * j + 1, 2 * i + 1);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    faceRanges: new Uint32Array([0, n * 2]),
    faceNames: ['F1:wall'],
    edgePositions: new Float32Array(),
    edgeRanges: new Uint32Array(),
    edgeNames: [],
    bbox: {
      min: [0, 0, 0] as [number, number, number],
      max: [1, 1, 1] as [number, number, number],
    },
  };
}

describe('the hole circle read from the render mesh (a workaround, ADR-092)', () => {
  it('finds a cylinder wall’s axis, centre and radius', () => {
    const a = cylinderAnchor(wall(3.3, 10, 15, 25), 0);
    expect(a?.kind).toBe('circle');
    if (a?.kind !== 'circle') return;
    expect(a.radius).toBeCloseTo(3.3, 2);
    expect(a.center[0]).toBeCloseTo(15, 3);
    expect(a.center[1]).toBeCloseTo(25, 3);
    expect(Math.abs(a.normal[2])).toBeCloseTo(1, 6);
  });

  it('refuses a plane', () => {
    const plane = {
      ...wall(1, 1, 0, 0),
      normals: new Float32Array(Array.from({ length: 48 * 3 }, (_, i) => (i % 3 === 2 ? 1 : 0))),
    };
    expect(cylinderAnchor(plane, 0)).toBeNull();
  });

  it('adds an anchor to a hole callout without one, and only to that', () => {
    const callout: Annotation = {
      id: 'H',
      kind: 'holeCallout',
      origin: { kind: 'model' },
      refs: [],
      source: { kind: 'feature', featureId: 'F' },
    };
    const dimension: Annotation = {
      id: 'L',
      kind: 'linear',
      origin: { kind: 'model' },
      refs: [],
    };
    const res: AnnotationResolution[] = [
      {
        annotationId: 'H',
        state: 'ok',
        value: 6.6,
        instances: [{ name: 'F1:wall', kind: 'face' }],
      },
      { annotationId: 'L', state: 'ok', value: 10 },
    ];
    const result = {
      annotations: res,
      bodies: [{ id: 'B', shape: 1, mesh: wall(3.3, 10, 15, 25) }],
    } as unknown as RegenResult;
    const out = withHoleAnchors(result, [callout, dimension]);
    expect(out[0]?.anchors?.[0]?.kind).toBe('circle');
    expect(out[1]).toBe(res[1]);
    // One that needs attention carries no anchor, and nothing is guessed for an unknown face.
    const bad = withHoleAnchors(
      {
        ...result,
        annotations: [{ ...(res[0] as AnnotationResolution), state: 'needsAttention' }],
      } as RegenResult,
      [callout],
    );
    expect(bad[0]?.anchors).toBeUndefined();
    const unknown = withHoleAnchors(
      {
        ...result,
        annotations: [
          { ...(res[0] as AnnotationResolution), instances: [{ name: 'nope', kind: 'face' }] },
        ],
      } as RegenResult,
      [callout],
    );
    expect(unknown[0]?.anchors).toBeUndefined();
  });
});
