/**
 * Translucent preview objects (push/pull prism, arbitrary mesh). The prism is built once from
 * `prism.ts` data; its distance and direction are TSL uniforms, so a drag updates them without
 * touching the geometry or allocating (PLAN §10: same-frame feedback).
 */

import type { MeshBuffers } from '@wren-cad/contracts';
import {
  abs,
  cross,
  dFdx,
  dFdy,
  mix,
  normalize,
  positionLocal,
  positionView,
  attribute as tslAttribute,
  uniform,
} from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import { meshBuffersToGeometry } from './geometry';
import type { PrismGeometry } from './prism';

export const PREVIEW_ORDER = 40;
export const PREVIEW_OPACITY = 0.46;

export interface PreviewColors {
  add: string;
  cut: string;
}

/** Flat facet shading in view space, so the translucent solid still reads as a solid. */
function facetShade() {
  const n = normalize(cross(dFdx(positionView), dFdy(positionView)));
  return mix(0.62, 1, abs(n.z));
}

export class PrismPreview {
  /** Holds the "add" mesh (depth-tested) and the "cut" mesh (drawn through the solid). */
  readonly mesh: Group;
  private readonly addMesh: Mesh;
  private readonly cutMesh: Mesh;
  private readonly material: MeshBasicNodeMaterial;
  private readonly cutMaterial: MeshBasicNodeMaterial;
  private readonly dirU = uniform(new Vector3(0, 0, 1));
  private readonly distU = uniform(0);
  private readonly colorU = uniform(new Color());
  private readonly addColor = new Color();
  private readonly cutColor = new Color();
  private sign = 1;

  constructor(prism: PrismGeometry, colors: PreviewColors) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(prism.positions, 3));
    geometry.setAttribute('lift', new BufferAttribute(prism.lift, 1));
    geometry.setIndex(new BufferAttribute(prism.indices, 1));
    const m = new MeshBasicNodeMaterial({
      transparent: true,
      opacity: PREVIEW_OPACITY,
      depthWrite: false,
      side: DoubleSide,
    });
    m.positionNode = positionLocal.add(
      this.dirU.mul(this.distU).mul(tslAttribute('lift', 'float')),
    );
    m.colorNode = this.colorU.mul(facetShade());
    this.material = m;
    // A cut lies inside the solid, so it must show through the body: same shader, no depth test.
    const cutM = m.clone();
    cutM.depthTest = false;
    this.cutMaterial = cutM;
    this.addMesh = new Mesh(geometry, m);
    this.cutMesh = new Mesh(geometry, cutM);
    this.mesh = new Group();
    for (const mesh of [this.addMesh, this.cutMesh]) {
      mesh.frustumCulled = false; // the lift moves vertices outside the static bounds
      mesh.renderOrder = PREVIEW_ORDER;
      this.mesh.add(mesh);
    }
    this.cutMesh.visible = false;
    this.setColors(colors);
  }

  setColors(colors: PreviewColors): void {
    this.addColor.set(colors.add);
    this.cutColor.set(colors.cut);
    this.colorU.value.copy(this.sign >= 0 ? this.addColor : this.cutColor);
  }

  /** Allocation-free: three uniform writes. */
  update(direction: readonly [number, number, number], distance: number): void {
    this.dirU.value.set(direction[0], direction[1], direction[2]);
    this.distU.value = distance;
    const sign = distance >= 0 ? 1 : -1;
    if (sign !== this.sign) {
      this.sign = sign;
      this.colorU.value.copy(sign >= 0 ? this.addColor : this.cutColor);
      this.addMesh.visible = sign >= 0;
      this.cutMesh.visible = sign < 0;
    }
  }

  dispose(): void {
    this.addMesh.geometry.dispose();
    this.material.dispose();
    this.cutMaterial.dispose();
  }
}

export class MeshPreview {
  readonly mesh: Mesh;
  private readonly material: MeshBasicNodeMaterial;
  private readonly colorU = uniform(new Color());

  constructor(mesh: MeshBuffers, color: string, opacity: number) {
    this.colorU.value.set(color);
    this.material = new MeshBasicNodeMaterial({
      transparent: true,
      opacity,
      depthWrite: false,
      side: DoubleSide,
    });
    this.material.colorNode = this.colorU.mul(facetShade());
    this.mesh = new Mesh(meshBuffersToGeometry(mesh), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = PREVIEW_ORDER;
  }

  setColor(color: string): void {
    this.colorU.value.set(color);
  }

  /**
   * New geometry, same material: an updated mesh preview (e.g. push/pull corner fills during a
   * drag) never builds a new shader, only small vertex buffers.
   */
  setMesh(mesh: MeshBuffers): void {
    this.mesh.geometry.dispose();
    this.mesh.geometry = meshBuffersToGeometry(mesh);
  }

  setOpacity(opacity: number): void {
    this.material.opacity = opacity;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
