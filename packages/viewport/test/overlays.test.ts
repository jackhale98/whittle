import {
  Group,
  type Material,
  type Matrix4,
  type Mesh,
  PerspectiveCamera,
  Vector3,
  Vector4,
} from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  biasedClipZ,
  disposeOverlay,
  makeDot,
  makeLines,
  OVERLAY_BIAS_FRACTION,
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
  const clipOf = (P: Matrix4, v: Vector3, s = 1) =>
    new Vector4(v.x * s, v.y * s, v.z * s, 1).applyMatrix4(P);
  const cases = [
    { near: 0.05, far: 500 },
    { near: 5, far: 500 },
    { near: 40, far: 5000 },
  ];
  it.each(cases)('keeps screen x, y and w, shifts z toward the camera ($near)', ({ near, far }) => {
    const cam = new PerspectiveCamera(45, 1.5, near, far);
    cam.updateProjectionMatrix();
    const P = cam.projectionMatrix;
    const k = overlayBiasFor();
    const eps = OVERLAY_BIAS_FRACTION;
    for (const d of [near * 1.5, near * 3, near + 80]) {
      const p = new Vector3(3, -2, -d);
      const c = clipOf(P, p);
      const z = biasedClipZ(c.z, P.elements[14] as number, k);
      // Moving the view-space point to p * (1 - eps) gives the same NDC x, y and z.
      const q = clipOf(P, p, 1 - eps);
      expect(q.x / q.w).toBeCloseTo(c.x / c.w, 9);
      expect(q.y / q.w).toBeCloseTo(c.y / c.w, 9);
      expect(z / c.w).toBeCloseTo(q.z / q.w, 9);
      // Closer to the camera (smaller NDC z), by an amount that depends only on the distance.
      expect(z / c.w).toBeLessThan(c.z / c.w);
    }
  });
  it('the view-space pull is a fixed fraction of the distance whatever the near plane', () => {
    const pulls = cases.map(({ near, far }) => {
      const cam = new PerspectiveCamera(45, 1.5, near, far);
      cam.updateProjectionMatrix();
      const P = cam.projectionMatrix;
      const d = 100;
      const c = clipOf(P, new Vector3(0, 0, -d));
      const zb = biasedClipZ(c.z, P.elements[14] as number, overlayBiasFor());
      // Invert NDC z = (P22 z + P23) / -z for the view depth of the biased point.
      const ndc = zb / c.w;
      const p22 = P.elements[10] as number;
      const p23 = P.elements[14] as number;
      const depth = p23 / (-ndc - p22);
      return d + depth; // depth is the (negative) view z
    });
    for (const pull of pulls) expect(pull).toBeCloseTo(100 * OVERLAY_BIAS_FRACTION, 6);
  });
  it('coplanar overlay materials no longer rely on polygonOffset', () => {
    const lines = makeLines(segs, { ...style, onTop: false });
    expect((lines.material as Material & { polygonOffset: boolean }).polygonOffset).toBe(false);
  });
});
