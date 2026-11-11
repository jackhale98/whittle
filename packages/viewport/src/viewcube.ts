/**
 * View cube (PLAN §9.1): an orthographic SVG cube in the canvas' top-right corner. Faces, edges
 * and corners are click targets that animate the camera to the matching standard view. Hit
 * testing is plain math (no DOM picking), so it is unit-testable and cheap.
 */

import type { StandardView } from '@wren-cad/contracts';
import type { OverlayColors } from './themes';
import type { Vec3 } from './views';

export interface CubeFace {
  name: Exclude<StandardView, 'iso'>;
  label: string;
  /** Outward normal. */
  n: Vec3;
  /** Label "right" and "up" directions (world), so text reads upright from outside. */
  r: Vec3;
  u: Vec3;
}

export const CUBE_FACES: readonly CubeFace[] = [
  { name: 'front', label: 'FRONT', n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] },
  { name: 'back', label: 'BACK', n: [0, 1, 0], r: [-1, 0, 0], u: [0, 0, 1] },
  { name: 'left', label: 'LEFT', n: [-1, 0, 0], r: [0, -1, 0], u: [0, 0, 1] },
  { name: 'right', label: 'RIGHT', n: [1, 0, 0], r: [0, 1, 0], u: [0, 0, 1] },
  { name: 'top', label: 'TOP', n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
  { name: 'bottom', label: 'BOTTOM', n: [0, 0, -1], r: [1, 0, 0], u: [0, -1, 0] },
];

/** Camera basis in world space: screen-right, screen-up and the direction toward the camera. */
export interface CubeBasis {
  right: Vec3;
  up: Vec3;
  back: Vec3;
}

export type CubeRegionKind = 'face' | 'edge' | 'corner';

export interface CubeHit {
  /** Unit vector from the cube centre toward the new camera position. */
  dir: Vec3;
  kind: CubeRegionKind;
  /** Standard view name for face hits. */
  view: StandardView | null;
}

/** Fraction of a face (each side, 0..1 of the half-width) that belongs to the edge/corner bands. */
export const ZONE_MARGIN = 0.275;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function zoneOf(a: number, margin = ZONE_MARGIN): -1 | 0 | 1 {
  const lim = 1 - 2 * margin; // zone boundary in [-1,1] face coordinates
  return a < -lim ? -1 : a > lim ? 1 : 0;
}

/** Direction + kind for the zone (za, zb) of a face. */
export function zoneDirection(face: CubeFace, za: number, zb: number): CubeHit {
  const d: Vec3 = [
    face.n[0] + za * face.r[0] + zb * face.u[0],
    face.n[1] + za * face.r[1] + zb * face.u[1],
    face.n[2] + za * face.r[2] + zb * face.u[2],
  ];
  const len = Math.hypot(d[0], d[1], d[2]);
  const dir: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
  const n = (za !== 0 ? 1 : 0) + (zb !== 0 ? 1 : 0);
  return {
    dir,
    kind: n === 0 ? 'face' : n === 1 ? 'edge' : 'corner',
    view: n === 0 ? face.name : null,
  };
}

/**
 * Hit test in cube space. (sx, sy) is the pointer relative to the cube centre in units where the
 * cube's half-edge is 1 (x right, y up).
 */
export function cubeHitTest(basis: CubeBasis, sx: number, sy: number): CubeHit | null {
  for (const f of CUBE_FACES) {
    if (dot(f.n, basis.back) <= 1e-6) continue;
    // screen = n + a*r + b*u projected; solve the 2x2 for (a, b).
    const nx = dot(f.n, basis.right);
    const ny = dot(f.n, basis.up);
    const rx = dot(f.r, basis.right);
    const ry = dot(f.r, basis.up);
    const ux = dot(f.u, basis.right);
    const uy = dot(f.u, basis.up);
    const det = rx * uy - ux * ry;
    if (Math.abs(det) < 1e-9) continue;
    const px = sx - nx;
    const py = sy - ny;
    const a = (px * uy - ux * py) / det;
    const b = (rx * py - ry * px) / det;
    if (Math.abs(a) <= 1 && Math.abs(b) <= 1) return zoneDirection(f, zoneOf(a), zoneOf(b));
  }
  return null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_BOX = 132;
/** Projected half-edge in viewBox units (cube corners reach ~1.73x this). */
const S = 34;

interface FaceNodes {
  face: CubeFace;
  group: SVGGElement;
  base: SVGRectElement;
  label: SVGTextElement;
  zones: Array<{ rect: SVGRectElement; hit: CubeHit }>;
}

export interface ViewCubeOptions {
  host: HTMLElement;
  /** Called with the unit direction toward the new camera position. */
  onSelect: (hit: CubeHit) => void;
  colors: OverlayColors;
  touch: boolean;
}

/** SVG view cube. Call `update(basis)` whenever the camera orientation changes. */
export class ViewCube {
  readonly element: SVGSVGElement;
  private readonly nodes: FaceNodes[] = [];
  private colors: OverlayColors;
  private basis: CubeBasis = { right: [1, 0, 0], up: [0, 0, 1], back: [0, -1, 0] };
  private hover: Vec3 | null = null;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly opts: ViewCubeOptions) {
    this.colors = opts.colors;
    const size = opts.touch ? 112 : 96;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `${-VIEW_BOX / 2} ${-VIEW_BOX / 2} ${VIEW_BOX} ${VIEW_BOX}`);
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', 'View cube');
    svg.dataset.testid = 'view-cube';
    Object.assign(svg.style, {
      position: 'absolute',
      width: `${size}px`,
      height: `${size}px`,
      touchAction: 'none',
      userSelect: 'none',
      cursor: 'pointer',
      overflow: 'visible',
      zIndex: '5',
    });
    this.element = svg;

    for (const face of CUBE_FACES) {
      const group = document.createElementNS(SVG_NS, 'g');
      const base = document.createElementNS(SVG_NS, 'rect');
      base.setAttribute('x', '-1');
      base.setAttribute('y', '-1');
      base.setAttribute('width', '2');
      base.setAttribute('height', '2');
      base.setAttribute('rx', '0.12');
      base.setAttribute('stroke-width', '1.25');
      base.setAttribute('vector-effect', 'non-scaling-stroke');
      group.append(base);

      const zones: FaceNodes['zones'] = [];
      const lim = 1 - 2 * ZONE_MARGIN;
      for (const za of [-1, 0, 1] as const) {
        for (const zb of [-1, 0, 1] as const) {
          const r = document.createElementNS(SVG_NS, 'rect');
          const x0 = za === -1 ? -1 : za === 0 ? -lim : lim;
          const x1 = za === -1 ? -lim : za === 0 ? lim : 1;
          const y0 = zb === -1 ? -1 : zb === 0 ? -lim : lim;
          const y1 = zb === -1 ? -lim : zb === 0 ? lim : 1;
          r.setAttribute('x', String(x0));
          r.setAttribute('y', String(y0));
          r.setAttribute('width', String(x1 - x0));
          r.setAttribute('height', String(y1 - y0));
          r.setAttribute('fill', 'none');
          group.append(r);
          zones.push({ rect: r, hit: zoneDirection(face, za, zb) });
        }
      }

      const label = document.createElementNS(SVG_NS, 'text');
      label.textContent = face.label;
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.setAttribute('transform', 'scale(1,-1)');
      label.setAttribute('font-size', face.label.length > 5 ? '0.3' : '0.36');
      label.setAttribute('font-weight', '600');
      label.setAttribute('letter-spacing', '0.02');
      label.setAttribute('font-family', "'Inter Variable', ui-sans-serif, system-ui, sans-serif");
      label.style.pointerEvents = 'none';
      group.append(label);
      svg.append(group);
      this.nodes.push({ face, group, base, label, zones });
    }

    this.bind(svg);
    opts.host.append(svg);
    this.applyColors();
    this.update(this.basis);
  }

  setColors(colors: OverlayColors): void {
    this.colors = colors;
    this.applyColors();
    this.update(this.basis);
  }

  /** Position the cube in the host (the canvas' offset parent) at the canvas' top-right. */
  place(canvas: HTMLElement, insets: { top: number; right: number } = { top: 0, right: 0 }): void {
    const size = this.element.clientWidth || 96;
    const margin = 10;
    this.element.style.left = `${canvas.offsetLeft + canvas.clientWidth - size - margin - insets.right}px`;
    this.element.style.top = `${canvas.offsetTop + margin + insets.top}px`;
  }

  update(basis: CubeBasis): void {
    this.basis = basis;
    for (const n of this.nodes) {
      const facing = dot(n.face.n, basis.back);
      if (facing <= 1e-6) {
        n.group.setAttribute('display', 'none');
        continue;
      }
      n.group.removeAttribute('display');
      // Local face coords (a, b), b up -> screen px (SVG y down).
      const rx = dot(n.face.r, basis.right) * S;
      const ry = -dot(n.face.r, basis.up) * S;
      const ux = dot(n.face.u, basis.right) * S;
      const uy = -dot(n.face.u, basis.up) * S;
      const ex = dot(n.face.n, basis.right) * S;
      const ey = -dot(n.face.n, basis.up) * S;
      n.group.setAttribute('transform', `matrix(${rx} ${ry} ${ux} ${uy} ${ex} ${ey})`);
      // Slight shading by facing so the cube reads as solid.
      n.base.setAttribute('fill-opacity', String(0.78 + 0.22 * Math.min(1, facing)));
    }
    this.applyHover();
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup.length = 0;
    this.element.remove();
  }

  // ---------------------------------------------------------------- internals

  private applyColors(): void {
    const c = this.colors;
    for (const n of this.nodes) {
      n.base.setAttribute('fill', c.surface);
      n.base.setAttribute('stroke', c.borderStrong);
      n.label.setAttribute('fill', c.fg);
      for (const z of n.zones) {
        z.rect.setAttribute('stroke', z.hit.kind === 'face' ? 'none' : c.border);
        z.rect.setAttribute('stroke-width', '0.5');
        z.rect.setAttribute('vector-effect', 'non-scaling-stroke');
      }
    }
    this.applyHover();
  }

  private applyHover(): void {
    const h = this.hover;
    for (const n of this.nodes) {
      for (const z of n.zones) {
        const on =
          h !== null &&
          Math.abs(z.hit.dir[0] - h[0]) < 1e-6 &&
          Math.abs(z.hit.dir[1] - h[1]) < 1e-6 &&
          Math.abs(z.hit.dir[2] - h[2]) < 1e-6;
        z.rect.setAttribute('fill', on ? this.colors.accent : 'none');
        z.rect.setAttribute('fill-opacity', on ? '0.55' : '1');
      }
    }
  }

  private hitAt(e: PointerEvent): CubeHit | null {
    const r = this.element.getBoundingClientRect();
    const k = VIEW_BOX / r.width;
    const sx = ((e.clientX - r.left - r.width / 2) * k) / S;
    const sy = (-(e.clientY - r.top - r.height / 2) * k) / S;
    return cubeHitTest(this.basis, sx, sy);
  }

  private bind(svg: SVGSVGElement): void {
    const on = <K extends keyof SVGElementEventMap>(
      type: K,
      fn: (e: SVGElementEventMap[K]) => void,
    ) => {
      svg.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => svg.removeEventListener(type, fn as EventListener));
    };
    let down: { x: number; y: number; hit: CubeHit | null } | null = null;
    on('pointermove', (e) => {
      const hit = e.pointerType === 'touch' ? null : this.hitAt(e);
      this.hover = hit ? hit.dir : null;
      this.applyHover();
    });
    on('pointerleave', () => {
      this.hover = null;
      this.applyHover();
    });
    on('pointerdown', (e) => {
      e.stopPropagation();
      down = { x: e.clientX, y: e.clientY, hit: this.hitAt(e) };
      if (e.pointerType === 'touch' && down.hit) {
        this.hover = down.hit.dir;
        this.applyHover();
      }
    });
    on('pointerup', (e) => {
      e.stopPropagation();
      const d = down;
      down = null;
      this.hover = null;
      this.applyHover();
      if (!d?.hit) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) return;
      this.opts.onSelect(d.hit);
    });
    on('pointercancel', () => {
      down = null;
      this.hover = null;
      this.applyHover();
    });
    // Keep the canvas' double-tap / orbit gestures from seeing events that start on the cube.
    for (const t of ['dblclick', 'contextmenu', 'wheel'] as const) {
      on(t, (e) => {
        e.stopPropagation();
        if (t !== 'wheel') e.preventDefault();
      });
    }
  }
}
