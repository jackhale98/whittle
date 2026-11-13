import { OrthographicCamera, PerspectiveCamera, Vector3, Vector4 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { worldPerPixel } from '../src/handles';
import { type PivotInput, resolvePivot } from '../src/navigation';
import {
  biasedClipZ,
  biasedClipZOrtho,
  OVERLAY_BIAS_FRACTION,
  orthoOverlayDelta,
  overlayBiasFor,
} from '../src/overlays';
import { ViewCamera } from '../src/viewCamera';
import { fitDistance, fitInsetFrame, ORTHO_DEPTH_REACH_RADII, orthoClipPlanes } from '../src/views';
import { zoomFrame, zoomPose } from '../src/zoom';

const FOV = 35;

function orthoCamera(distance: number, aspect = 1.6): ViewCamera {
  const cam = new ViewCamera(FOV, aspect, 0.1, 1000);
  cam.orthographic = true;
  cam.focusDistance = distance;
  cam.near = -50;
  cam.far = 500;
  cam.updateProjectionMatrix();
  return cam;
}

describe('ViewCamera', () => {
  it('perspective mode is a plain PerspectiveCamera', () => {
    const cam = new ViewCamera(FOV, 1.6, 0.5, 500);
    const ref = new PerspectiveCamera(FOV, 1.6, 0.5, 500);
    expect(cam.projectionMatrix.elements).toEqual(ref.projectionMatrix.elements);
    expect(cam.isPerspectiveCamera).toBe(true);
  });

  it('orthographic mode builds the OrthographicCamera matrix for the view height at the target', () => {
    const d = 120;
    const cam = orthoCamera(d);
    const halfH = d * Math.tan((FOV * Math.PI) / 360);
    const ref = new OrthographicCamera(-halfH * 1.6, halfH * 1.6, halfH, -halfH, -50, 500);
    for (let i = 0; i < 16; i++) {
      expect(cam.projectionMatrix.elements[i]).toBeCloseTo(
        ref.projectionMatrix.elements[i] as number,
        9,
      );
    }
    expect(cam.projectionMatrix.elements[11]).toBe(0);
  });

  it('shows what the perspective camera shows at the target plane (no jump on switching)', () => {
    const d = 90;
    const persp = new ViewCamera(FOV, 1.6, 1, 1000);
    persp.position.set(0, -d, 0);
    persp.up.set(0, 0, 1);
    persp.lookAt(0, 0, 0);
    persp.updateMatrixWorld();
    const ortho = orthoCamera(d);
    ortho.position.copy(persp.position);
    ortho.up.set(0, 0, 1);
    ortho.quaternion.copy(persp.quaternion);
    ortho.updateMatrixWorld();
    for (const p of [new Vector3(0, 0, 0), new Vector3(13, 0, -7), new Vector3(-40, 0, 20)]) {
      const a = p.clone().project(persp);
      const b = p.clone().project(ortho);
      expect(b.x).toBeCloseTo(a.x, 9);
      expect(b.y).toBeCloseTo(a.y, 9);
    }
    // Off the target plane they differ: that is the point of the projection.
    const near = new Vector3(13, -30, -7);
    expect(near.clone().project(ortho).x).not.toBeCloseTo(near.clone().project(persp).x, 3);
  });

  it('scaling the camera about an anchor keeps the anchor on screen: zoom without ortho-specific code', () => {
    const d0 = 100;
    const cam = orthoCamera(d0);
    const target = new Vector3(0, 0, 0);
    cam.position.set(60, -80, 50).setLength(d0).add(target);
    cam.up.set(0, 0, 1);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    const anchor = new Vector3(14, 6, -9);
    const before = anchor.clone().project(cam);
    const fwd = target.clone().sub(cam.position).normalize();
    const frame = zoomFrame(
      [cam.position.x, cam.position.y, cam.position.z],
      [fwd.x, fwd.y, fwd.z],
      [anchor.x, anchor.y, anchor.z],
      d0, // orthographic: the view height follows the target distance
    );
    expect(frame).not.toBeNull();
    const dist0 = cam.position.distanceTo(anchor);
    for (const k of [0.85, 0.85 ** 6, 3, 40]) {
      const pose = zoomPose(frame!, dist0 * k);
      cam.position.set(...pose.position);
      cam.up.set(0, 0, 1);
      cam.lookAt(new Vector3(...pose.target));
      // The view height follows the camera-to-target distance, as `syncProjection` sets it.
      cam.focusDistance = cam.position.distanceTo(new Vector3(...pose.target));
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      const after = anchor.clone().project(cam);
      expect(after.x).toBeCloseTo(before.x, 8);
      expect(after.y).toBeCloseTo(before.y, 8);
      expect(cam.focusDistance / d0).toBeCloseTo(k, 8);
    }
  });
});

describe('orthographic framing', () => {
  it('fitDistance: the sphere exactly fits the smaller half extent, at any aspect', () => {
    const r = 10;
    for (const aspect of [0.5, 1, 1.6]) {
      const d = fitDistance(r, FOV, aspect, 1, true);
      const halfH = d * Math.tan((FOV * Math.PI) / 360);
      expect(Math.min(halfH, halfH * aspect)).toBeCloseTo(r, 9);
    }
    // Perspective is unchanged, and ortho sits closer (tan < sin cannot hold; check the ratio).
    expect(fitDistance(10, FOV, 1.6)).toBeCloseTo(fitDistance(10, FOV, 1.6, 1.2, false));
    expect(fitDistance(10, FOV, 1.6, 1, true)).toBeLessThan(fitDistance(10, FOV, 1.6, 1, false));
  });

  it('fitInsetFrame: ortho fits the free area and keeps the same shift per pixel', () => {
    const ins = { top: 40, right: 0, bottom: 300, left: 0 };
    const o = fitInsetFrame(50, FOV, 800, 600, ins, 1.2, true);
    const p = fitInsetFrame(50, FOV, 800, 600, ins, 1.2, false);
    const halfH = o.distance * Math.tan((FOV * Math.PI) / 360);
    const free = (600 - 340) / 600; // the free area's share of the view height
    expect(halfH * free).toBeCloseTo(50 * 1.2, 6);
    expect(o.distance).toBeLessThan(p.distance);
    // The centring shift is the free area's centre offset at that distance: (dy px) * (world per px).
    expect(o.shiftUp).toBeCloseTo(((40 - 300) / 2) * ((2 * halfH) / 600), 9);
  });

  it('orthoClipPlanes: the scene is inside at any camera position along the view axis', () => {
    const r = 30;
    for (const centreDepth of [-500, -10, 0, 40, 5000]) {
      const { near, far } = orthoClipPlanes(centreDepth, r);
      expect(near).toBeLessThan(centreDepth - r);
      expect(far).toBeGreaterThan(centreDepth + r);
      expect(far - near).toBeCloseTo(2 * r * ORTHO_DEPTH_REACH_RADII, 9);
    }
    expect(orthoClipPlanes(0, 0).far).toBeGreaterThan(0);
  });
});

describe('world per pixel', () => {
  it('perspective grows with depth; orthographic does not', () => {
    const p11 = 1 / Math.tan((FOV * Math.PI) / 360);
    expect(worldPerPixel(200, p11, 800)).toBeCloseTo(2 * worldPerPixel(100, p11, 800), 12);
    const halfH = 50;
    const o = worldPerPixel(10, 1 / halfH, 800, true);
    expect(o).toBeCloseTo((2 * halfH) / 800, 12);
    expect(worldPerPixel(10_000, 1 / halfH, 800, true)).toBe(o);
    expect(worldPerPixel(-5, 1 / halfH, 800, true)).toBe(o);
  });
});

describe('overlay depth pull, orthographic form', () => {
  it('clip.z += P22 * delta moves a point exactly delta toward the camera', () => {
    const cam = new OrthographicCamera(-40, 40, 25, -25, -30, 300);
    cam.position.set(0, 0, 100);
    cam.updateMatrixWorld();
    const p = new Vector3(5, 3, -20); // 120 in front of the camera
    const delta = 0.8;
    const view = p.clone().applyMatrix4(cam.matrixWorldInverse);
    const clip = new Vector4(view.x, view.y, view.z, 1).applyMatrix4(cam.projectionMatrix);
    const pulled = biasedClipZOrtho(clip.z, cam.projectionMatrix.elements[10] as number, delta);
    const moved = new Vector4(view.x, view.y, view.z + delta, 1).applyMatrix4(cam.projectionMatrix);
    expect(pulled).toBeCloseTo(moved.z, 10);
    expect(pulled).toBeLessThan(clip.z); // nearer on the WebGL depth convention
    expect(clip.w).toBe(1); // x, y, w untouched: the point does not move on screen
  });

  it('is the same for the WebGPU depth convention', () => {
    const cam = new OrthographicCamera(-40, 40, 25, -25, -30, 300);
    cam.coordinateSystem = 2001; // WebGPUCoordinateSystem
    cam.updateProjectionMatrix();
    const p22 = cam.projectionMatrix.elements[10] as number;
    expect(p22).toBeLessThan(0);
    expect(biasedClipZOrtho(0.4, p22, 0.5)).toBeLessThan(0.4);
  });

  it('the perspective form is untouched', () => {
    const cam = new PerspectiveCamera(35, 1.6, 0.5, 500);
    const k = overlayBiasFor();
    const p23 = cam.projectionMatrix.elements[14] as number;
    expect(biasedClipZ(0.2, p23, k)).toBeCloseTo(0.2 + p23 * k, 12);
  });

  it('orthoOverlayDelta: 0.5 % of the zoom distance, never below a few depth steps', () => {
    expect(orthoOverlayDelta(100, 600)).toBeCloseTo(100 * OVERLAY_BIAS_FRACTION, 12);
    // Zoomed far in the relative pull would vanish into depth precision: the floor holds it.
    const range = 600;
    expect(orthoOverlayDelta(1e-4, range)).toBeCloseTo(range * 4e-6, 12);
    expect(orthoOverlayDelta(1e-4, range) / range).toBeGreaterThan(2 ** -24 * 32);
  });
});

describe('pivot in an orthographic view', () => {
  const base = (over: Partial<PivotInput>): PivotInput => ({
    mode: 'cursor',
    hit: null,
    override: null,
    center: [0, 0, 0],
    centerHit: () => null,
    // Looking down -Y from y = 0: the centre is at depth 0 (not in front by the perspective rule).
    project: (p) => ({ nx: p[0] / 50, ny: p[2] / 50, depth: p[1] * -1, front: true }),
    cameraPosition: [0, 0, 0],
    forward: [0, 1, 0],
    fallbackDistance: 80,
    ...over,
  });

  it('a surface point behind the camera plane is still a valid pivot (the near plane is behind it)', () => {
    const r = resolvePivot(base({ hit: [3, -20, 4] }));
    expect(r).toEqual({ point: [3, -20, 4], source: 'surface' });
  });

  it('perspective default: depth <= 0 is behind the eye', () => {
    const r = resolvePivot(
      base({
        hit: [3, -20, 4],
        project: (p) => ({ nx: 0, ny: 0, depth: p[1] }),
      }),
    );
    expect(r.source).not.toBe('surface');
  });

  it('the axis fallback places the pivot at the centre depth, even a negative one', () => {
    const r = resolvePivot(
      base({
        center: [0, -30, 0],
        project: (p) => ({ nx: 0, ny: 0, depth: p[1], front: true }),
        cameraPosition: [0, 0, 0],
        mode: 'center',
      }),
    );
    expect(r.source).toBe('center');
    const far = resolvePivot(
      base({
        mode: 'cursor',
        center: [900, -30, 0],
        project: (p) => ({ nx: p[0] / 50, ny: 0, depth: p[1], front: true }),
      }),
    );
    // The centre is off screen, no hit, no centre hit: on the view axis at the centre's depth.
    expect(far.source).toBe('axis');
    expect(far.point[1]).toBeCloseTo(-30, 9);
  });
});
