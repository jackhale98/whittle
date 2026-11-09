import { Group, type Material, type Mesh } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  disposeOverlay,
  makeDot,
  makeLines,
  overlayBiasFor,
  sharedOverlayMaterialCount,
} from '../src/overlays';

const segs = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0]);
const style = { color: '#336699', width: 2, onTop: true, renderOrder: 3 } as const;

describe('overlay materials are shared by style', () => {
  it('rebuilding an overlay many times (one per Pencil move) reuses its materials', () => {
    const build = () => {
      const g = new Group();
      g.add(makeLines(segs, style));
      g.add(makeLines(segs, { ...style, dashed: true, dash: 1.03 }));
      g.add(makeDot(8, '#ffffff', '#000000', 4, [0, 0, 0]).sprite);
      return g;
    };
    const first = build();
    const before = sharedOverlayMaterialCount();
    const a = (first.children[0] as Mesh).material as Material;
    for (let i = 0; i < 200; i++) disposeOverlay(build());
    expect(sharedOverlayMaterialCount()).toBe(before);
    const again = build();
    expect((again.children[0] as Mesh).material).toBe(a);
    // A slightly different dash length (the view moved a little) lands in the same bucket.
    const near = makeLines(segs, { ...style, dashed: true, dash: 1.05 });
    expect(near.material).toBe((again.children[1] as Mesh).material);
  });

  it('disposing an overlay never disposes a shared material', () => {
    const g = new Group();
    const lines = makeLines(segs, { ...style, color: '#123456' });
    g.add(lines);
    const m = lines.material as Material;
    let disposed = false;
    m.addEventListener('dispose', () => {
      disposed = true;
    });
    disposeOverlay(g);
    expect(disposed).toBe(false);
  });

  it('the cache is bounded; an evicted style stops being shared and is freed with its overlay', () => {
    const first = makeLines(segs, { ...style, color: '#000001' });
    const m = first.material as Material;
    for (let i = 2; i < 400; i++)
      makeLines(segs, { ...style, color: `#${i.toString(16).padStart(6, '0')}` });
    expect(sharedOverlayMaterialCount()).toBeLessThanOrEqual(256);
    let disposed = false;
    m.addEventListener('dispose', () => {
      disposed = true;
    });
    disposeOverlay(first);
    expect(disposed).toBe(true);
  });
});

describe('coplanar depth bias (replaces polygonOffset, which WebGPU does not honour)', () => {
  it('scales with the view distance and has a scene-scaled floor', () => {
    expect(overlayBiasFor(100, 50)).toBeCloseTo(0.2, 6);
    expect(overlayBiasFor(1000, 50)).toBeCloseTo(2, 6);
    expect(overlayBiasFor(0, 50)).toBeCloseTo(0.005, 6);
  });
  it('coplanar overlay materials no longer rely on polygonOffset', () => {
    const lines = makeLines(segs, { ...style, onTop: false });
    expect((lines.material as Material & { polygonOffset: boolean }).polygonOffset).toBe(false);
  });
});
