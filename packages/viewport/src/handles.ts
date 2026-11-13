/**
 * Screen-constant-size 3D arrow handle (push/pull). The arrow is modelled with unit length along
 * +Z; each frame it is scaled so it spans `lengthPx` CSS px at its own depth, whatever the zoom.
 */

import type { HandleSpec, Vec3 } from '@wren-cad/contracts';
import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { HANDLE_LENGTH_PX } from './constants';

export const HANDLE_ORDER = 60;
const Z = new Vector3(0, 0, 1);
const SHAFT = 0.68;

function arrowParts(): [CylinderGeometry, ConeGeometry] {
  const shaft = new CylinderGeometry(0.028, 0.028, SHAFT, 12, 1);
  shaft.rotateX(Math.PI / 2);
  shaft.translate(0, 0, SHAFT / 2);
  const head = new ConeGeometry(0.09, 1 - SHAFT, 16, 1);
  head.rotateX(Math.PI / 2);
  head.translate(0, 0, SHAFT + (1 - SHAFT) / 2);
  return [shaft, head];
}

export class ArrowHandle {
  readonly group = new Group();
  private readonly material: MeshBasicNodeMaterial;
  private readonly base = new Color();
  private readonly hot = new Color();
  private hover = false;
  private readonly q = new Quaternion();
  /** Constant on-screen length in CSS px. */
  lengthPx: number;
  origin: Vec3;
  direction: Vec3;

  constructor(spec: Extract<HandleSpec, { kind: 'arrow' }>, color: string, hotColor: string) {
    this.material = new MeshBasicNodeMaterial({ color });
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.transparent = true; // drawn after opaque geometry, on top of it
    const [shaft, head] = arrowParts();
    for (const g of [shaft, head]) {
      const m = new Mesh(g, this.material);
      m.frustumCulled = false;
      m.renderOrder = HANDLE_ORDER;
      this.group.add(m);
    }
    this.group.renderOrder = HANDLE_ORDER;
    this.base.set(color);
    this.hot.set(hotColor);
    this.origin = [...spec.origin];
    this.direction = [...spec.direction];
    this.lengthPx = spec.length ?? HANDLE_LENGTH_PX;
    this.apply(spec);
  }

  apply(spec: Extract<HandleSpec, { kind: 'arrow' }>): void {
    this.origin = [...spec.origin];
    const d = new Vector3(spec.direction[0], spec.direction[1], spec.direction[2]);
    if (d.lengthSq() < 1e-12) d.copy(Z);
    d.normalize();
    this.direction = [d.x, d.y, d.z];
    this.lengthPx = spec.length ?? HANDLE_LENGTH_PX;
    this.group.position.set(spec.origin[0], spec.origin[1], spec.origin[2]);
    this.q.setFromUnitVectors(Z, d);
    this.group.quaternion.copy(this.q);
  }

  setColors(color: string, hotColor: string): void {
    this.base.set(color);
    this.hot.set(hotColor);
    this.paint();
  }

  setHover(hover: boolean): boolean {
    if (hover === this.hover) return false;
    this.hover = hover;
    this.paint();
    return true;
  }

  get hovered(): boolean {
    return this.hover;
  }

  private paint(): void {
    this.material.color.copy(this.hover ? this.hot : this.base);
  }

  /** Scale so the arrow is `lengthPx` long (x1.12 on hover) given world units per CSS px. */
  place(worldPerPx: number): number {
    const world = this.lengthPx * worldPerPx * (this.hover ? 1.12 : 1);
    this.group.scale.setScalar(world);
    return world;
  }

  dispose(): void {
    for (const c of this.group.children) (c as Mesh).geometry.dispose();
    this.material.dispose();
  }
}

/**
 * World units covered by one CSS px: at `depth` for a vertical-FOV perspective camera, anywhere for
 * an orthographic one (`p11` = 1 / half view height, ADR-098; `depth` is ignored).
 */
export function worldPerPixel(
  depth: number,
  p11: number,
  heightCss: number,
  orthographic = false,
): number {
  const d = orthographic ? 1 : Math.max(depth, 1e-6);
  return (2 * d) / (Math.max(p11, 1e-6) * Math.max(heightCss, 1));
}
