/**
 * Ground helpers: a fading "infinite" grid (TSL node material, so it works on both WebGPU and
 * WebGL2 backends) and a soft contact shadow quad.
 */

import {
  abs,
  cameraPosition,
  float,
  fract,
  fwidth,
  length,
  max,
  min,
  mix,
  normalize,
  positionWorld,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import {
  CanvasTexture,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector2,
} from 'three/webgpu';
import type { Palette } from './themes';

export class Grid {
  readonly mesh: Mesh;
  private readonly material: MeshBasicNodeMaterial;
  private readonly cell = uniform(10);
  private readonly center = uniform(new Vector2());
  private readonly radius = uniform(100);
  private readonly minorColor = uniform(new Color());
  private readonly majorColor = uniform(new Color());
  private readonly axisXColor = uniform(new Color());
  private readonly axisYColor = uniform(new Color());

  constructor() {
    const p = positionWorld.xy;

    // Anti-aliased line coverage for a lattice with the given world-space pitch.
    const lattice = (pitch: ReturnType<typeof float>) => {
      const q = p.div(pitch);
      const w = fwidth(q);
      const d = abs(fract(q.sub(0.5)).sub(0.5)).div(w);
      const coverage = float(1).sub(min(min(d.x, d.y), 1));
      // Fade a lattice out when its lines get closer than a few pixels (avoids moire).
      const density = float(1).sub(smoothstep(0.12, 0.5, max(w.x, w.y)));
      return coverage.mul(density);
    };

    const minor = lattice(float(this.cell));
    const major = lattice(float(this.cell.mul(10)));

    const axis = (coord: typeof p.x) => {
      const w = fwidth(coord);
      return float(1).sub(min(abs(coord).div(w).mul(0.7), 1));
    };
    const axisX = axis(p.y); // the X axis is the line y = 0
    const axisY = axis(p.x);

    let colour = mix(this.minorColor, this.majorColor, major);
    colour = mix(colour, this.axisXColor, axisX);
    colour = mix(colour, this.axisYColor, axisY);

    const lineAlpha = max(minor.mul(0.35), max(major.mul(0.75), max(axisX, axisY).mul(0.9)));
    const radial = float(1).sub(
      smoothstep(this.radius.mul(0.3), this.radius, length(p.sub(this.center))),
    );
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const grazing = smoothstep(0.015, 0.18, abs(viewDir.z));

    this.material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    this.material.colorNode = vec3(colour);
    this.material.opacityNode = lineAlpha.mul(radial).mul(grazing);

    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.mesh.renderOrder = -2;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = true;
  }

  /** Place the grid on the plane z = `z`, centred on (cx, cy), fading out at `radius`. */
  place(cx: number, cy: number, z: number, radius: number, cell: number): void {
    this.mesh.position.set(cx, cy, z);
    this.mesh.scale.set(radius, radius, 1);
    this.radius.value = radius;
    this.center.value.set(cx, cy);
    this.cell.value = cell;
  }

  setPalette(p: Palette): void {
    this.minorColor.value.set(p.grid);
    this.majorColor.value.set(p.gridMajor);
    this.axisXColor.value.set(p.axisX);
    this.axisYColor.value.set(p.axisY);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** Fraction of the canvas covered by the shadow caster rectangle (the rest is blur falloff). */
const SHADOW_CORE = 0.6;

function makeShadowTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const core = size * SHADOW_CORE;
    const off = size * 4;
    ctx.shadowColor = 'rgba(0,0,0,1)';
    ctx.shadowBlur = size * 0.09;
    ctx.shadowOffsetX = off;
    ctx.fillStyle = '#000';
    ctx.fillRect((size - core) / 2 - off, (size - core) / 2, core, core);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

export class ContactShadow {
  readonly mesh: Mesh;
  private readonly material: MeshBasicNodeMaterial;
  private readonly texture: CanvasTexture;

  constructor() {
    this.texture = makeShadowTexture();
    this.material = new MeshBasicNodeMaterial({
      map: this.texture,
      color: 0x000000,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  /** Footprint (width x depth) centred at (cx, cy) on the plane z. */
  place(cx: number, cy: number, z: number, width: number, depth: number): void {
    this.mesh.position.set(cx, cy, z);
    this.mesh.scale.set(width / SHADOW_CORE, depth / SHADOW_CORE, 1);
  }

  setPalette(p: Palette): void {
    this.material.opacity = p.shadow;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
