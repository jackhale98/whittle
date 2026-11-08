import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { lookAtPlanePose, type PlaneFrame, rayToPlane } from '../src/plane';

const topPlane: PlaneFrame = {
  origin: [0, 0, 20],
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

describe('rayToPlane', () => {
  it('intersects and returns plane-local coordinates', () => {
    const r = rayToPlane([3, 4, 30], [0, 0, -1], topPlane);
    expect(r?.local).toEqual([3, 4]);
    expect(r?.t).toBeCloseTo(10);
    expect(r?.point).toEqual([3, 4, 20]);
  });

  it('uses the plane frame (origin offset and rotated axes)', () => {
    const plane: PlaneFrame = { origin: [10, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
    const r = rayToPlane([30, 2, 3], [-1, 0, 0], plane);
    expect(r?.local[0]).toBeCloseTo(2);
    expect(r?.local[1]).toBeCloseTo(3);
  });

  it('returns null when parallel or behind the ray', () => {
    expect(rayToPlane([0, 0, 30], [1, 0, 0], topPlane)).toBeNull();
    expect(rayToPlane([0, 0, 10], [0, 0, -1], topPlane)).toBeNull();
  });

  it('round trips with a perspective camera (worldToScreen <-> screenToPlane)', () => {
    const cam = new PerspectiveCamera(35, 1.5, 0.1, 1000);
    cam.up.set(0, 0, 1);
    cam.position.set(60, -80, 70);
    cam.lookAt(20, 15, 20);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const W = 900;
    const H = 600;
    for (const [x, y] of [
      [12, 7],
      [-30, 44],
      [0, 0],
    ] as const) {
      const ndc = new Vector3(x, y, 20).project(cam);
      const sx = (ndc.x * 0.5 + 0.5) * W;
      const sy = (1 - (ndc.y * 0.5 + 0.5)) * H;
      // inverse
      const p = new Vector3((sx / W) * 2 - 1, -(sy / H) * 2 + 1, 0.5).unproject(cam);
      const o = cam.position;
      const d = p.sub(o).normalize();
      const hit = rayToPlane([o.x, o.y, o.z], [d.x, d.y, d.z], topPlane);
      expect(hit?.local[0]).toBeCloseTo(x, 3);
      expect(hit?.local[1]).toBeCloseTo(y, 3);
    }
  });
});

describe('lookAtPlanePose', () => {
  it('looks along -z from the +z side, target projected onto the plane', () => {
    const p = lookAtPlanePose(topPlane, [5, 6, 0], 100);
    expect(p.target).toEqual([5, 6, 20]);
    expect(p.position[0]).toBeCloseTo(5);
    expect(p.position[2]).toBeCloseTo(120);
  });

  it('nudges horizontal planes so plane.y is screen-up', () => {
    const p = lookAtPlanePose(topPlane, [0, 0, 20], 100);
    // Camera slightly toward -y => it looks toward +y => +y is up on screen.
    expect(p.position[1]).toBeLessThan(0);
    expect(Math.abs(p.position[1])).toBeLessThan(1);
  });

  it('does not nudge vertical planes (world +Z stays up)', () => {
    const front: PlaneFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] };
    const p = lookAtPlanePose(front, [3, 9, 4], 50);
    expect(p.target).toEqual([3, 0, 4]);
    expect(p.position).toEqual([3, -50, 4]);
  });
});
