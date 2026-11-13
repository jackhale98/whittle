/**
 * three.js object factories for selection highlights, sketch overlays and ghosts. Everything
 * here is drawn on top of the shaded body (polygon offset / depth function / render order) and
 * owns its materials; geometries that share attributes with a body are detached before disposal
 * so the body's GPU buffers survive.
 */

import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import {
  cameraProjectionMatrix,
  float,
  length,
  mix,
  modelViewMatrix,
  select,
  smoothstep,
  color as tslColor,
  uniform,
  uv,
  vec4,
} from 'three/tsl';
import {
  type BufferGeometry,
  Color,
  DoubleSide,
  LessEqualDepth,
  Line2NodeMaterial,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  type Object3D,
  Sprite,
  SpriteNodeMaterial,
} from 'three/webgpu';
import { viewUniforms } from './viewUniforms';

/**
 * Scale node for constant-pixel sprites (`sizeAttenuation: false`). three multiplies such a sprite
 * by its view depth when the *camera object* is not an `OrthographicCamera`, and the viewport's
 * camera is always a `PerspectiveCamera` (ADR-098). In perspective that is the intended
 * "world per pixel at this depth"; in orthographic this node divides the depth out again, so the
 * CPU-side scale (`px * 2 / (height * P11)`, see `sizeDots`) is the on-screen size in both. A sprite
 * at depth 0 (on the camera plane) would divide by zero: the depth is held away from 0.
 */
export function constantPixelScale() {
  const depth = modelViewMatrix.mul(vec4(0, 0, 0, 1)).z.negate();
  const safe = select(depth.abs().lessThan(1e-6), float(1e-6), depth);
  return select(viewUniforms.ortho.greaterThan(0.5), float(1).div(safe), float(1));
}

/**
 * Relative depth bias: a coplanar overlay is moved toward the camera along its own view ray by a
 * fraction of its distance (see `overlayBiasFor`, `biasedClipZ`). Set every frame.
 *
 * Why not `polygonOffset`: WebGPU only applies it to triangle lists, in raw depth-buffer units
 * (about 1e-7 of the range on a float depth buffer) and with a slope term that is zero for a
 * coplanar surface, so on the WebGPU backend a sketch on a face lost the depth test and
 * vanished. A clip-space z shift in the vertex stage behaves the same on both backends.
 */
export const overlayDepthBias = uniform(0);
/**
 * Orthographic form of the pull (ADR-098): a view-space distance toward the camera. Zero in
 * perspective (where `overlayDepthBias` is used) and `overlayDepthBias` is zero in orthographic.
 */
export const overlayDepthDelta = uniform(0);

/**
 * Fraction of its own distance an overlay is pulled toward the camera: 0.5 %. A sketch on a face is
 * exactly coplanar and body edges share the face triangulation's boundary vertices, so the bias only
 * has to beat depth precision; a larger one lets hidden edges show through thin walls (2.5 % bled
 * through a 1 mm wall at the iso fit). `coplanar.spec.ts` pins both sides of the trade-off.
 */
export const OVERLAY_BIAS_FRACTION = 5e-3;

/** The uniform value for a fraction `eps`: the factor `eps / (1 - eps)` used by `biasedClipZ`. */
export function overlayBiasFor(eps: number = OVERLAY_BIAS_FRACTION): number {
  return eps / (1 - eps);
}

/**
 * Clip z of a point moved to p * (1 - eps) in view space, keeping clip x, y, w (so its screen
 * position) unchanged. For a perspective matrix clip.w = -p.z and clip.z = P22 p.z + P23, so
 * z' / w = (P22 p.z (1 - eps) + P23) / (-p.z (1 - eps)); with w held at -p.z that is
 * clip.z + P23 * eps / (1 - eps). `p23` is `projectionMatrix.elements[14]`, `k` = `overlayBiasFor`.
 * The shift scales with the point's own distance and does not involve the near plane.
 */
export function biasedClipZ(clipZ: number, p23: number, k: number): number {
  return clipZ + p23 * k;
}

/**
 * Orthographic pull (ADR-098). Clip z is linear in view z (`clip.z = P22 z + P23`, w = 1), so
 * moving a point `delta` toward the camera (view z + delta) is `clip.z + P22 * delta`; P22 is
 * negative, so clip z falls (nearer) on both the WebGL and WebGPU depth conventions.
 */
export function biasedClipZOrtho(clipZ: number, p22: number, delta: number): number {
  return clipZ + p22 * delta;
}

/**
 * The orthographic pull distance: the same 0.5 % of the *zoom* distance (camera to target, which
 * sets the view height) that perspective pulls by at the target, so zoomed in hidden edges do not
 * show through thin walls any more than they do in perspective. It never drops below a few
 * hundred depth-buffer steps of the near-far `range` (a coplanar sketch must still win at any
 * zoom): 4e-6 of the range is about 60 steps of a 24-bit buffer.
 */
export function orthoOverlayDelta(
  distance: number,
  range: number,
  eps: number = OVERLAY_BIAS_FRACTION,
): number {
  return Math.max(distance * eps, range * 4e-6);
}

/**
 * Pull a material's geometry toward the camera by a relative `overlayDepthBias` without moving it
 * on screen: only clip-space z changes (z += P[2][3] * k; x, y, w untouched). Replaces
 * `polygonOffset` for surfaces that lie exactly on a body face or edge.
 */
export function applyDepthBias<M extends Material>(material: M): M {
  const m = material as unknown as {
    setupVertex: (builder: unknown) => ReturnType<typeof vec4>;
  };
  const base = m.setupVertex;
  m.setupVertex = function (this: unknown, builder: unknown) {
    const clip = base.call(this, builder);
    // P * (0, 0, 0, 1) is the projection's last column; .z is elements[14].
    const p23 = cameraProjectionMatrix.mul(vec4(0, 0, 0, 1)).z;
    // Orthographic: P22 is the z column's own z (elements[10]); `overlayDepthDelta` is 0 in perspective.
    const p22 = cameraProjectionMatrix.mul(vec4(0, 0, 1, 0)).z;
    return vec4(
      clip.x,
      clip.y,
      clip.z.add(p23.mul(overlayDepthBias)).add(p22.mul(overlayDepthDelta)),
      clip.w,
    );
  };
  material.needsUpdate = true;
  return material;
}

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

/**
 * Overlay materials are shared by style. Overlays (sketches, previews, markers) are rebuilt on
 * every update, as often as every Pencil move; a new node material per object rebuilt its node
 * graph and could compile a shader each time (≈ 0.8 s per pen move on software GL). Shared
 * materials are flagged and never disposed with an overlay. The set of styles is small and bounded.
 */
const SHARED = 'wrenSharedOverlayMaterial';
const shared = new Map<string, Material>();
const MAX_SHARED = 256;

function sharedMaterial<M extends Material>(key: string, create: () => M): M {
  const hit = shared.get(key);
  if (hit) return hit as M;
  const m = create();
  m.userData[SHARED] = true;
  if (shared.size >= MAX_SHARED) {
    // Forget the oldest style. It stops being shared, so the overlays still using it dispose it
    // with themselves (three re-creates GPU resources if another one still draws with it).
    const first = shared.keys().next().value;
    if (first !== undefined) {
      const old = shared.get(first);
      if (old) old.userData[SHARED] = false;
      shared.delete(first);
    }
  }
  shared.set(key, m);
  return m;
}

/** Number of distinct shared overlay materials (tests: overlay rebuilds must not grow it). */
export function sharedOverlayMaterialCount(): number {
  return shared.size;
}

/** Dash lengths in quarter-octave steps, so a slowly changing extent reuses the same material. */
function quantiseDash(dash: number): number {
  return 2 ** (Math.round(Math.log2(Math.max(dash, 1e-6)) * 4) / 4);
}

/** Fat lines from independent segment pairs (x0 y0 z0 x1 y1 z1 ...). */
export function makeLines(segments: Float32Array, style: LineStyle): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(segments);
  const dashed = style.dashed === true;
  const dash = dashed ? quantiseDash(style.dash ?? 1) : 1;
  const key = `line|${style.color}|${style.width}|${dashed}|${dash}|${style.onTop}`;
  const material = sharedMaterial(key, () => {
    const m = new Line2NodeMaterial({
      color: style.color,
      linewidth: style.width,
      dashed,
      dashSize: dash,
      gapSize: dash * 0.6,
    });
    m.depthTest = !style.onTop;
    m.depthFunc = LessEqualDepth;
    m.depthWrite = false;
    if (!style.onTop) applyDepthBias(m);
    return m;
  });
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
  const material = sharedMaterial(`fill|${colorHex}|${opacity}|${onTop}`, () => {
    const m = new MeshBasicNodeMaterial({
      color: new Color(colorHex),
      transparent: true,
      opacity,
      depthWrite: false,
      side: DoubleSide,
    });
    m.depthTest = !onTop;
    m.depthFunc = LessEqualDepth;
    if (!onTop) applyDepthBias(m);
    return m;
  });
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
  const material = sharedMaterial(`dot|${fill}|${outline}`, () => {
    const m = new SpriteNodeMaterial({ sizeAttenuation: false, transparent: true });
    m.scaleNode = constantPixelScale();
    const d = length(uv().sub(0.5)).mul(2);
    m.colorNode = mix(
      tslColor(new Color(outline)),
      tslColor(new Color(fill)),
      float(1).sub(smoothstep(0.62, 0.72, d)),
    );
    m.opacityNode = float(1).sub(smoothstep(0.9, 1.0, d));
    m.depthTest = false;
    m.depthWrite = false;
    return m;
  });
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
    const free = (x: Material) => {
      if (!x.userData[SHARED]) x.dispose(); // shared overlay materials outlive overlays
    };
    if (Array.isArray(mat)) for (const x of mat) free(x);
    else if (mat) free(mat);
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
