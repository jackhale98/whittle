/**
 * The section plane manipulator (owner's "Section view fixes", PLAN §9): while a section is on, an
 * arrow along the plane's normal moves it and two arcs tilt it about its in-plane axes. It is built
 * from the viewport's existing handle and marker APIs (no contract change): the offset arrow is an
 * `arrow` handle; each rotation arc is a dashed polyline marker with a short tangent `arrow` handle
 * on it as the grab target (hit tolerance is the handle one: 22 px on touch, plus pad).
 *
 * Drag recipe (same as push/pull): everything is applied in the pointer handler (plane, handles,
 * markers), the React state catches up once per frame. A rotation drag integrates the pointer's
 * movement along the arc's screen tangent, so it follows the circle through any angle. Shift
 * (mouse) or a second finger held down (touch) snaps both tilts to 15 degree steps; otherwise the
 * normal snaps onto an X/Y/Z plane when within 3 degrees.
 */

import type { HandleSpec, Marker, Vec3 } from '@wren-cad/contracts';
import { dragDistance, snapDistance } from '../model/faces';
import {
  rotateAbout,
  type SectionFrame,
  type SectionSettings,
  sectionGeometry,
  sectionPlane,
  sectionRange,
  snapTilts,
  tiltAxes,
} from '../model/section';
import type { Workbench } from './workbench';

const OFFSET = 'sec:offset';
const ARC_U = 'sec:arc-u';
const ARC_V = 'sec:arc-v';
const MARKERS = 'sec:arcs';
const IDS = [OFFSET, ARC_U, ARC_V] as const;
type HandleId = (typeof IDS)[number];

/** Screen sizes (CSS px). */
const RADIUS_PX = 78;
const ARROW_PX = 64;
const GRIP_PX = 56;
const ARC_SPAN = (50 * Math.PI) / 180;
/** Below this many px per radian the arc is end-on and a drag would be ill-conditioned. */
const MIN_PX_PER_RAD = 10;

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Where the arrow, arcs and grips are, for settings (world space; sizes from `wpp`). */
export interface SectionRig {
  origin: Vec3;
  /** The plane's actual normal (flip included): the clipped side. */
  normal: Vec3;
  /** Fixed tilt axis and the carried one (both in-plane). */
  axisU: Vec3;
  axisV: Vec3;
  /** In-plane directions toward the two arcs' centres. */
  dirU: Vec3;
  dirV: Vec3;
  frame: SectionFrame;
}

/** Pure: the manipulator's directions for the settings (null without a plane). */
export function sectionRig(s: SectionSettings, bounds: Parameters<typeof sectionGeometry>[1]) {
  const g = sectionGeometry(s, bounds);
  if (!g) return null;
  const a = s.tiltU ?? 0;
  const b = s.tiltV ?? 0;
  const ax = tiltAxes(g.frame, a);
  // The plane's own axes: R·v = Ru(a)·v and R·u = Ru(a)·Rv(b)·u.
  const planeU = rotateAbout(rotateAbout(g.frame.u, g.frame.v, b), g.frame.u, a);
  const sign = s.flipped ? -1 : 1;
  const rig: SectionRig = {
    origin: g.origin,
    normal: [g.normal[0] * sign, g.normal[1] * sign, g.normal[2] * sign],
    axisU: ax.u,
    axisV: ax.v,
    // Arc U rotates about the fixed u: its grip sits on the carried v edge; arc V about the carried
    // v, on the plane's u edge.
    dirU: ax.v,
    dirV: planeU,
    frame: g.frame,
  };
  return rig;
}

interface Drag {
  kind: HandleId;
  pointerId: number;
  x: number;
  y: number;
  moved: boolean;
  /** Offset drag: the offset and the screen image of the normal at the start. */
  startOffset: number;
  axis: { x: number; y: number };
  axisMm: number;
  /** Tilt drag: the unsnapped angles. */
  rawU: number;
  rawV: number;
}

export class SectionTool {
  private drag: Drag | null = null;
  private live: SectionSettings | null = null;
  private shown = false;
  private raf = 0;
  private placeRaf = 0;
  /** Touch pointers other than the dragging one: a held second finger snaps to 15 degrees. */
  private readonly held = new Set<number>();
  private readonly onWindowDown = (e: PointerEvent) => {
    if (this.drag && e.pointerType === 'touch' && e.pointerId !== this.drag.pointerId)
      this.held.add(e.pointerId);
  };
  private readonly onWindowUp = (e: PointerEvent) => {
    this.held.delete(e.pointerId);
  };

  constructor(private readonly wb: Workbench) {}

  get dragging(): boolean {
    return this.drag !== null;
  }

  private settings(): SectionSettings {
    return this.live ?? this.wb.sectionSettings();
  }

  private wanted(): boolean {
    const u = this.wb.ui.get();
    return u.section.enabled && !u.section.picking && !u.sketch && !u.pushPull;
  }

  /** Test hook: where each grip is (canvas CSS px, the middle of its arrow) and its unit screen direction; null when hidden. */
  grips(): Record<string, { x: number; y: number; dx: number; dy: number }> | null {
    const v = this.wb.viewport;
    if (!v || !this.shown) return null;
    const out: Record<string, { x: number; y: number; dx: number; dy: number }> = {};
    for (const [id, g] of this.gripSpecs) {
      const half = (g.lengthPx / 2) * g.wpp;
      const p = v.worldToScreen(add(g.origin, g.direction, half));
      const a = v.worldToScreen(g.origin);
      const l = Math.hypot(p.x - a.x, p.y - a.y) || 1;
      // The arrow's screen direction (unit), for dragging along it.
      out[id] = { x: p.x, y: p.y, dx: (p.x - a.x) / l, dy: (p.y - a.y) / l };
    }
    return out;
  }

  private readonly gripSpecs = new Map<
    string,
    { origin: Vec3; direction: Vec3; lengthPx: number; wpp: number }
  >();

  /** The state or the geometry changed: show, move or hide the manipulator. */
  sync(): void {
    if (!this.wanted()) {
      this.hide();
      return;
    }
    if (this.drag) return; // the drag drives it
    this.place(this.settings());
  }

  /** The camera moved: the screen-sized parts follow, at most once per frame. */
  onCamera(): void {
    if (!this.shown || this.placeRaf) return;
    this.placeRaf = requestAnimationFrame(() => {
      this.placeRaf = 0;
      if (this.shown) this.place(this.settings());
    });
  }

  private hide(): void {
    if (this.drag) this.endDrag();
    if (!this.shown) return;
    this.shown = false;
    const v = this.wb.viewport;
    this.gripSpecs.clear();
    for (const id of IDS) v?.setHandle(id, null);
    v?.setMarkers(MARKERS, null);
  }

  /** World size of one CSS px at the origin (the section's own pixel scale). */
  private worldPerPx(at: Vec3): number | null {
    const v = this.wb.viewport;
    if (!v) return null;
    const o = v.worldToScreen(at);
    if (!o.visible) return null;
    // Screen image of the three world axes (1 mm each): their 2x3 matrix M. Directions across the
    // view map to screen with the largest singular value of M, so 1 / sigma_max is mm per px.
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const e of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as Vec3[]) {
      const p = v.worldToScreen(add(at, e));
      const dx = p.x - o.x;
      const dy = p.y - o.y;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    const tr = sxx + syy;
    const det = sxx * syy - sxy * sxy;
    const sigma = Math.sqrt(tr / 2 + Math.sqrt(Math.max(tr * tr * 0.25 - det, 0)));
    return sigma < 1e-6 ? null : 1 / sigma;
  }

  /** Sends the handles and arcs for `s` to the viewport. Synchronous. */
  private place(s: SectionSettings): void {
    const v = this.wb.viewport;
    const rig = sectionRig(s, this.wb.bounds());
    if (!v || !rig) return;
    const wpp = this.worldPerPx(rig.origin);
    if (wpp === null) return;
    this.shown = true;
    const r = RADIUS_PX * wpp;
    const arrow: HandleSpec = {
      kind: 'arrow',
      origin: rig.origin,
      direction: rig.normal,
      length: ARROW_PX,
    };
    v.setHandle(OFFSET, arrow);
    this.gripSpecs.set(OFFSET, {
      origin: rig.origin,
      direction: rig.normal,
      lengthPx: ARROW_PX,
      wpp,
    });
    const markers: Marker[] = [];
    // The plane's outline.
    const [e1, e2] = [rig.dirU, rig.dirV];
    const c = (a: number, b: number): Vec3 => add(add(rig.origin, e1, a * r), e2, b * r);
    markers.push({
      kind: 'polyline',
      points: [c(1, 1), c(-1, 1), c(-1, -1), c(1, -1), c(1, 1)],
      tone: 'muted',
      dashed: true,
    });
    for (const [id, axis, dir] of [
      [ARC_U, rig.axisU, rig.dirU],
      [ARC_V, rig.axisV, rig.dirV],
    ] as const) {
      const tangent = cross(axis, dir);
      const points: Vec3[] = [];
      for (let i = 0; i <= 16; i++) {
        const t = -ARC_SPAN + (2 * ARC_SPAN * i) / 16;
        points.push(
          add(
            rig.origin,
            [
              dir[0] * Math.cos(t) + tangent[0] * Math.sin(t),
              dir[1] * Math.cos(t) + tangent[1] * Math.sin(t),
              dir[2] * Math.cos(t) + tangent[2] * Math.sin(t),
            ],
            r,
          ),
        );
      }
      markers.push({ kind: 'polyline', points, tone: 'accent' });
      const grip = add(add(rig.origin, dir, r), tangent, -(GRIP_PX / 2) * wpp);
      v.setHandle(id, { kind: 'arrow', origin: grip, direction: tangent, length: GRIP_PX });
      this.gripSpecs.set(id, { origin: grip, direction: tangent, lengthPx: GRIP_PX, wpp });
    }
    v.setMarkers(MARKERS, markers);
  }

  // ---------------------------------------------------------------- drag

  onPointerDown(e: PointerEvent): boolean {
    const v = this.wb.viewport;
    if (!v || e.button !== 0 || !this.wanted() || !this.shown) return false;
    const { x, y } = this.wb.local(e);
    const hit = this.wb
      .pickAt(x, y, e.pointerType, ['handle'], false)
      .find((h) => h.kind === 'handle' && IDS.includes((h.entity ?? h.bodyId) as HandleId));
    if (!hit) return false;
    const kind = (hit.entity ?? hit.bodyId) as HandleId;
    const s = this.wb.sectionSettings();
    const rig = sectionRig(s, this.wb.bounds());
    if (!rig) return false;
    const axisMm = Math.max(this.sectionSpan() * 0.2, 1);
    const a = v.worldToScreen(rig.origin);
    const b = v.worldToScreen(add(rig.origin, rig.normal, axisMm));
    this.live = s;
    this.drag = {
      kind,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      startOffset: s.offset,
      axis: { x: b.x - a.x, y: b.y - a.y },
      axisMm,
      rawU: s.tiltU ?? 0,
      rawV: s.tiltV ?? 0,
    };
    this.held.clear();
    window.addEventListener('pointerdown', this.onWindowDown, true);
    window.addEventListener('pointerup', this.onWindowUp, true);
    window.addEventListener('pointercancel', this.onWindowUp, true);
    (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
    // preventDefault below also skips the browser's focus move: leave a panel field (which commits
    // a valid edit) so Esc and the shortcuts reach the app, not the text field.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    e.preventDefault();
    return true;
  }

  private sectionSpan(): number {
    const r = sectionRange(this.wb.sectionSettings(), this.wb.bounds());
    return r.max - r.min;
  }

  onPointerMove(e: PointerEvent): boolean {
    const d = this.drag;
    const v = this.wb.viewport;
    if (!d || !v || e.pointerId !== d.pointerId) return false;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return true;
    d.moved = true;
    const cur = this.live ?? this.wb.sectionSettings();
    let next: SectionSettings | null = null;
    if (d.kind === OFFSET) {
      const delta = dragDistance({ dx: e.clientX - d.x, dy: e.clientY - d.y }, d.axis, d.axisMm);
      if (delta === null) return true;
      const r = sectionRange(cur, this.wb.bounds());
      const sign = cur.flipped ? -1 : 1;
      const off = snapDistance(d.startOffset + sign * delta);
      next = { ...cur, offset: Math.min(r.max, Math.max(r.min, off)) };
    } else {
      // Integrate along the arc's screen tangent so the drag follows the circle.
      const rig = sectionRig(cur, this.wb.bounds());
      const wpp = rig ? this.worldPerPx(rig.origin) : null;
      if (!rig || wpp === null) return true;
      const [axis, dir] = d.kind === ARC_U ? [rig.axisU, rig.dirU] : [rig.axisV, rig.dirV];
      const r = RADIUS_PX * wpp;
      const g = add(rig.origin, dir, r);
      const t = cross(axis, dir);
      const sg = v.worldToScreen(g);
      const st = v.worldToScreen(add(g, t, r)); // one radian along the tangent
      const tx = st.x - sg.x;
      const ty = st.y - sg.y;
      const l2 = tx * tx + ty * ty;
      const lastX = this.lastMove?.x ?? d.x;
      const lastY = this.lastMove?.y ?? d.y;
      this.lastMove = { x: e.clientX, y: e.clientY };
      if (l2 < MIN_PX_PER_RAD * MIN_PX_PER_RAD) return true;
      const rad = ((e.clientX - lastX) * tx + (e.clientY - lastY) * ty) / l2;
      if (d.kind === ARC_U) d.rawU += rad;
      else d.rawV += rad;
      const snapped = snapTilts(rig.frame, d.rawU, d.rawV, e.shiftKey || this.held.size > 0);
      next = { ...cur, tiltU: snapped.tiltU, tiltV: snapped.tiltV };
    }
    this.apply(next);
    return true;
  }

  private lastMove: { x: number; y: number } | null = null;

  /** Plane, handles and arcs in the same frame as the pointer event; the UI catches up later. */
  private apply(s: SectionSettings): void {
    const v = this.wb.viewport;
    this.live = s;
    if (v) {
      const plane = sectionPlane(s, this.wb.bounds());
      this.wb.lastSection = JSON.stringify(plane);
      v.setSection(plane);
    }
    this.place(s);
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.flush();
    });
  }

  private flush(): void {
    const s = this.live;
    if (!s) return;
    this.wb.ui.set((u) => ({
      ...u,
      section: {
        ...u.section,
        offset: s.offset,
        tiltU: s.tiltU ?? 0,
        tiltV: s.tiltV ?? 0,
      },
    }));
  }

  private endDrag(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.flush();
    this.drag = null;
    this.live = null;
    this.lastMove = null;
    this.held.clear();
    window.removeEventListener('pointerdown', this.onWindowDown, true);
    window.removeEventListener('pointerup', this.onWindowUp, true);
    window.removeEventListener('pointercancel', this.onWindowUp, true);
  }

  onPointerUp(e: PointerEvent): boolean {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return false;
    this.endDrag();
    this.wb.syncSection();
    return true;
  }

  onPointerCancel(e: PointerEvent): void {
    this.onPointerUp(e);
  }
}
