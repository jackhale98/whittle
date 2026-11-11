/**
 * Reference geometry in the view (ADR-093): translucent plane squares with an outline and a name
 * label, dash-dot axes and crosshair points, drawn after the bodies without writing depth. They
 * are picked as `F<id>:plane` (face), `F<id>:axis` (edge) and `F<id>:point` (vertex), highlighted
 * on hover and selection, and the world origin planes and axes follow a separate toggle.
 */

import type { HighlightItem, PickHit, PickKind, Vec3 } from '@wren-cad/contracts';
import { float, max, smoothstep, abs as tslAbs, color as tslColor, uv } from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Sprite,
  SpriteNodeMaterial,
  SRGBColorSpace,
} from 'three/webgpu';
import { REFERENCE_ENTITY } from './ids';
import { type Dot, disposeOverlay, makeFill, makeLines } from './overlays';
import { closestOnPolyline, type ProjectFn } from './pick';
import {
  axisEnds,
  dashDotSegments,
  MIN_ORIGIN_EXTENT,
  originReferences,
  outlineSegments,
  planeCorners,
  rayHitsPlane,
} from './refgeom';
import { requestRender } from './renderLoop';
import type { ReferenceStats, ViewportReference } from './types';
import type { ViewportImpl } from './viewport';

const PLANE_FILL = 0.12;
const ORDER = 10;
const LABEL_PX = 14;

interface Label {
  sprite: Sprite;
  aspect: number;
  material: SpriteNodeMaterial;
  texture: CanvasTexture;
}

export class ReferenceLayer {
  readonly group = new Group();
  /** Crosshair sprites, sized to constant screen px each frame. */
  dots: Dot[] = [];
  private labels: Label[] = [];
  private cross = new Map<string, SpriteNodeMaterial>();
  private refs: readonly ViewportReference[] = [];
  private originOn = false;
  private origins: ViewportReference[] = [];
  private originExtent = 0;

  constructor(private readonly vp: ViewportImpl) {
    this.group.renderOrder = ORDER;
    vp.scene.add(this.group);
  }

  /** Everything drawn and pickable: the given references, then the origin ones when shown. */
  all(): readonly ViewportReference[] {
    return this.originOn ? [...this.refs, ...this.origins] : this.refs;
  }

  get hasAny(): boolean {
    return this.refs.length > 0 || this.originOn;
  }

  setReferences(refs: readonly ViewportReference[]): void {
    this.refs = refs.map((r) => ({ ...r }));
    this.rebuild();
  }

  setOrigin(show: boolean): void {
    if (show === this.originOn) return;
    this.originOn = show;
    this.refreshOrigin();
    this.rebuild();
  }

  /** The scene grew or shrank: the origin planes follow its size. */
  sceneChanged(): void {
    if (!this.originOn) return;
    const before = this.originExtent;
    this.refreshOrigin();
    if (this.originExtent !== before) this.rebuild();
  }

  private refreshOrigin(): void {
    this.originExtent = Math.max(MIN_ORIGIN_EXTENT, 1.2 * this.vp.sceneRadius);
    this.origins = this.originOn ? originReferences(this.originExtent) : [];
  }

  stats(): ReferenceStats {
    const all = this.all();
    return {
      planes: all.filter((r) => r.kind === 'plane').length,
      axes: all.filter((r) => r.kind === 'axis').length,
      points: all.filter((r) => r.kind === 'point').length,
      originShown: this.originOn,
      names: all.map((r) => r.name),
    };
  }

  /** Redraw everything (set changed, theme changed). */
  rebuild(): void {
    this.clear();
    const ui = this.vp.ui;
    for (const r of this.all()) {
      // Origin ones are quieter than the document's own reference geometry.
      const quiet = r.origin === true;
      this.draw(r, ui.reference, quiet ? 0.07 : PLANE_FILL, quiet ? 1.2 : 1.8, this.group, ORDER);
    }
    // Not in the ID buffer: no pick image to invalidate.
    requestRender(this.vp);
  }

  private clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      disposeOverlay(child, true);
    }
    for (const l of this.labels) {
      l.material.dispose();
      l.texture.dispose();
    }
    this.labels = [];
    this.dots = [];
  }

  /** Draw one reference into `into` (the layer's group, or the highlight group). */
  draw(
    r: ViewportReference,
    colorHex: string,
    fill: number,
    width: number,
    into: Group,
    order: number,
    withLabel = true,
  ): void {
    const f = r.frame;
    if (r.kind === 'plane') {
      const q = planeCorners(f, r.extent);
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(Float32Array.from(q.flat()), 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      into.add(makeFill(g, colorHex, fill, false, order));
      into.add(
        makeLines(outlineSegments(f, r.extent), {
          color: colorHex,
          width,
          onTop: false,
          renderOrder: order + 1,
        }),
      );
      if (withLabel && r.label) this.label(r.label, q[2] as Vec3, [1, 1], colorHex, into, order);
    } else if (r.kind === 'axis') {
      into.add(
        makeLines(dashDotSegments(f, r.extent), {
          color: colorHex,
          width,
          onTop: false,
          renderOrder: order + 1,
        }),
      );
      const [, end] = axisEnds(f, r.extent);
      if (withLabel && r.label) this.label(r.label, end as Vec3, [0, 0.5], colorHex, into, order);
    } else {
      const sprite = this.crosshair(colorHex, order + 3, f.origin);
      into.add(sprite.sprite);
      this.dots.push(sprite);
      if (withLabel && r.label) this.label(r.label, f.origin, [-0.4, -0.2], colorHex, into, order);
    }
  }

  private crosshair(colorHex: string, order: number, at: Vec3): Dot {
    let material = this.cross.get(colorHex);
    if (!material) {
      material = new SpriteNodeMaterial({ sizeAttenuation: false, transparent: true });
      const p = uv().sub(0.5);
      const bar = (a: typeof p.x, b: typeof p.x) =>
        float(1)
          .sub(smoothstep(0.045, 0.085, tslAbs(a)))
          .mul(float(1).sub(smoothstep(0.42, 0.5, tslAbs(b))));
      material.colorNode = tslColor(new Color(colorHex));
      material.opacityNode = max(bar(p.x, p.y), bar(p.y, p.x));
      material.depthTest = false;
      material.depthWrite = false;
      this.cross.set(colorHex, material);
    }
    const sprite = new Sprite(material);
    sprite.position.set(at[0], at[1], at[2]);
    sprite.renderOrder = order;
    sprite.frustumCulled = false;
    return { sprite, px: 14 };
  }

  private label(
    text: string,
    at: Vec3,
    center: [number, number],
    colorHex: string,
    into: Group,
    order: number,
  ): void {
    if (typeof document === 'undefined') return;
    const scale = 2;
    const font = `600 ${12 * scale}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 8 * scale;
    const h = 18 * scale;
    canvas.width = w;
    canvas.height = h;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4 * scale;
    ctx.strokeStyle = this.vp.ui.surface;
    ctx.strokeText(text, 4 * scale, h / 2);
    ctx.fillStyle = colorHex;
    ctx.fillText(text, 4 * scale, h / 2);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const material = new SpriteNodeMaterial({
      map: texture,
      sizeAttenuation: false,
      transparent: true,
    });
    material.depthTest = false;
    material.depthWrite = false;
    const sprite = new Sprite(material);
    sprite.position.set(at[0], at[1], at[2]);
    sprite.center.set(center[0], center[1]);
    sprite.renderOrder = order + 4;
    sprite.frustumCulled = false;
    into.add(sprite);
    this.labels.push({ sprite, aspect: w / h, material, texture });
  }

  /** Constant screen size for crosshairs and labels. */
  size(p11: number, heightCss: number): void {
    const k = 2 / (Math.max(heightCss, 1) * Math.max(p11, 1e-6));
    for (const d of this.dots) d.sprite.scale.set(k * d.px, k * d.px, 1);
    for (const l of this.labels) l.sprite.scale.set(k * LABEL_PX * l.aspect, k * LABEL_PX, 1);
  }

  /** Hover / selection highlight of one reference, added to the viewport's highlight group. */
  highlight(
    item: HighlightItem,
    colorHex: string,
    fill: number,
    width: number,
    order: number,
  ): void {
    const r = this.all().find((x) => x.name === item.bodyId);
    if (!r) return;
    const before = this.dots.length;
    this.draw(r, colorHex, fill, width, this.vp.highlightGroup, order, false);
    for (const d of this.dots.slice(before)) {
      d.px = 20;
      this.vp.highlightDots.push(d);
    }
    this.dots.length = before;
  }

  /** Picks at a screen point: points and axes by distance, planes by ray. */
  pick(
    ray: { origin: Vec3; dir: Vec3 },
    project: ProjectFn,
    x: number,
    y: number,
    tol: number,
    want: (k: PickKind) => boolean,
    /** A plane is only hit when its distance along the ray is below this (0 = never). */
    nearerThan: number,
    visibleAt: (p: Vec3) => boolean,
  ): PickHit[] {
    const out: PickHit[] = [];
    for (const r of this.all()) {
      const f = r.frame;
      if (r.kind === 'point') {
        if (!want('vertex')) continue;
        const h = closestOnPolyline(Float32Array.from(f.origin), 0, 1, project, x, y);
        if (h && h.distancePx <= tol) out.push(hit(r, 'vertex', h.point, h.distancePx));
      } else if (r.kind === 'axis') {
        if (!want('edge')) continue;
        const [a, b] = axisEnds(f, r.extent);
        const h = closestOnPolyline(Float32Array.from([...a, ...b]), 0, 2, project, x, y);
        if (h && h.distancePx <= tol && visibleAt(h.point)) {
          out.push(hit(r, 'edge', h.point, h.distancePx));
        }
      } else {
        if (!want('face')) continue;
        const h = rayHitsPlane(ray.origin, ray.dir, f, r.extent);
        if (h && h.t < nearerThan) {
          const n: Vec3 =
            h.t >= 0 && ray.dir[0] * f.z[0] + ray.dir[1] * f.z[1] + ray.dir[2] * f.z[2] > 0
              ? [-f.z[0], -f.z[1], -f.z[2]]
              : [...f.z];
          const p = hit(r, 'face', h.point, 0);
          p.normal = n;
          out.push(p);
        }
      }
    }
    return out;
  }

  dispose(): void {
    this.clear();
    for (const m of this.cross.values()) m.dispose();
    this.cross.clear();
    this.vp.scene.remove(this.group);
  }
}

function hit(r: ViewportReference, kind: PickKind, point: Vec3, distancePx: number): PickHit {
  return { bodyId: r.name, kind, index: 0, entity: REFERENCE_ENTITY, point, distancePx };
}
