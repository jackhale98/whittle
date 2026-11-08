/**
 * three.js object factories for selection highlights, sketch overlays and ghosts. Everything
 * here is drawn on top of the shaded body (polygon offset / depth function / render order) and
 * owns its materials; geometries that share attributes with a body are detached before disposal
 * so the body's GPU buffers survive.
 */

import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { float, length, mix, smoothstep, color as tslColor, uv } from 'three/tsl';
import {
  type BufferGeometry,
  Color,
  DoubleSide,
  LessEqualDepth,
  Line2NodeMaterial,
  Mesh,
  MeshBasicNodeMaterial,
  type Object3D,
  Sprite,
  SpriteNodeMaterial,
} from 'three/webgpu';

export interface LineStyle {
  color: string;
  /** Logical px. */
  width: number;
  dashed?: boolean;
  /** World-unit dash length when dashed. */
  dash?: number;
  /** Draw above all geometry (sketch editing). */
  onTop: boolean;
  renderOrder: number;
}

/** Fat lines from independent segment pairs (x0 y0 z0 x1 y1 z1 ...). */
export function makeLines(segments: Float32Array, style: LineStyle): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(segments);
  const material = new Line2NodeMaterial({
    color: style.color,
    linewidth: style.width,
    dashed: style.dashed === true,
    dashSize: style.dash ?? 1,
    gapSize: (style.dash ?? 1) * 0.6,
  });
  material.depthTest = !style.onTop;
  material.depthFunc = LessEqualDepth;
  material.depthWrite = false;
  if (!style.onTop) {
    material.polygonOffset = true;
    material.polygonOffsetFactor = -2;
    material.polygonOffsetUnits = -2;
  }
  const lines = new LineSegments2(geometry, material);
  if (style.dashed) lines.computeLineDistances();
  lines.frustumCulled = false;
  lines.renderOrder = style.renderOrder;
  return lines;
}

/** Translucent fill over a (sub)range of an existing indexed geometry, or a whole geometry. */
export function makeFill(
  geometry: BufferGeometry,
  colorHex: string,
  opacity: number,
  onTop: boolean,
  renderOrder: number,
): Mesh {
  const material = new MeshBasicNodeMaterial({
    color: new Color(colorHex),
    transparent: true,
    opacity,
    depthWrite: false,
    side: DoubleSide,
  });
  material.depthTest = !onTop;
  material.depthFunc = LessEqualDepth;
  if (!onTop) {
    material.polygonOffset = true;
    material.polygonOffsetFactor = -2;
    material.polygonOffsetUnits = -2;
  }
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  return mesh;
}

export interface Dot {
  sprite: Sprite;
  /** Diameter in CSS px. */
  px: number;
}

/** Screen-sized round dot with a thin outline (constant pixel size, see `sizeDots`). */
export function makeDot(
  px: number,
  fill: string,
  outline: string,
  renderOrder: number,
  at: readonly [number, number, number],
): Dot {
  const material = new SpriteNodeMaterial({ sizeAttenuation: false, transparent: true });
  const d = length(uv().sub(0.5)).mul(2);
  material.colorNode = mix(
    tslColor(new Color(outline)),
    tslColor(new Color(fill)),
    float(1).sub(smoothstep(0.62, 0.72, d)),
  );
  material.opacityNode = float(1).sub(smoothstep(0.9, 1.0, d));
  material.depthTest = false;
  material.depthWrite = false;
  const sprite = new Sprite(material);
  sprite.position.set(at[0], at[1], at[2]);
  sprite.renderOrder = renderOrder;
  sprite.frustumCulled = false;
  return { sprite, px };
}

/**
 * Set sprite scales so dots are `px` CSS px across. With `sizeAttenuation: false` a sprite scale
 * s covers `s * P11 / 2` of the viewport height (P11 = projection[1][1]).
 */
export function sizeDots(dots: readonly Dot[], p11: number, heightCss: number): void {
  for (const d of dots) {
    const s = (2 * d.px) / (Math.max(heightCss, 1) * Math.max(p11, 1e-6));
    d.sprite.scale.set(s, s, 1);
  }
}

/** Dispose an overlay object's materials and geometry; shared attributes are detached first. */
export function disposeOverlay(obj: Object3D, sharedAttributes = false): void {
  obj.traverse((o) => {
    const m = o as Mesh;
    // Sprites share one static quad geometry; never touch it.
    if (m.geometry && !(o as Sprite).isSprite) {
      const g = m.geometry;
      if (sharedAttributes) {
        for (const name of Object.keys(g.attributes)) g.deleteAttribute(name);
        g.setIndex(null);
      }
      g.dispose();
    }
    const mat = (o as Mesh).material;
    if (Array.isArray(mat)) for (const x of mat) x.dispose();
    else mat?.dispose();
  });
}

/** Segments for one polyline range (x y z triplets) as independent pairs. */
export function polylineSegments(
  positions: ArrayLike<number>,
  first: number,
  count: number,
): Float32Array {
  const n = Math.max(0, count - 1);
  const out = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const a = 3 * (first + i);
    for (let k = 0; k < 6; k++) out[6 * i + k] = positions[a + k] as number;
  }
  return out;
}
