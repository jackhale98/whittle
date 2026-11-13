import type { HandleSpec, HighlightItem, Marker, PreviewSpec, Vec3 } from '@wren-cad/contracts';
import { BufferGeometry, Group } from 'three/webgpu';
import { HANDLE_PICK_PAD_PX } from './constants';
import { meshBuffersToGeometry } from './geometry';
import { ArrowHandle } from './handles';
import { faceDrawRange, REFERENCE_ENTITY } from './ids';
import { type PreviewEntry, sameFaces } from './internal';
import {
  type Dot,
  disposeOverlay,
  makeDot,
  makeFill,
  makeLines,
  polylineSegments,
} from './overlays';
import { distPointSegment2D } from './pick';
import { projector, syncCameraMatrices, vertexPositions } from './picking';
import { MeshPreview, PrismPreview } from './preview';
import { buildPrism } from './prism';
import { cameraWorldPerPixel } from './projection';
import { requestRender } from './renderLoop';
import { mixHex } from './sketchStyle';
import { MARKER_TONES } from './themes';
import type { ViewportImpl } from './viewport';

export function setHighlights(
  vp: ViewportImpl,
  highlights: { selected: HighlightItem[]; preselected: HighlightItem[] },
): void {
  vp.highlights = {
    selected: [...highlights.selected],
    preselected: [...highlights.preselected],
  };
  rebuildHighlights(vp);
  requestRender(vp);
}

export function clearHighlightObjects(vp: ViewportImpl): void {
  for (const child of [...vp.highlightGroup.children]) {
    vp.highlightGroup.remove(child);
    disposeOverlay(child, true);
  }
  vp.highlightDots = [];
}

export function rebuildHighlights(vp: ViewportImpl): void {
  clearHighlightObjects(vp);
  const ui = vp.ui;
  const pre = {
    fill: 0.16,
    edge: mixHex(ui.accent, vp.palette.edge, 0.15),
    width: 2.8,
    dot: 9,
    ring: 'ghost' as const,
  };
  const sel = { fill: 0.34, edge: ui.accent, width: 3.6, dot: 11, ring: 'solid' as const };
  const apply = (items: HighlightItem[], style: typeof pre | typeof sel, order: number) => {
    for (const item of items) addHighlight(vp, item, style, order);
  };
  // Preselection first so selection draws over it where they overlap.
  apply(vp.highlights.preselected, pre, 21);
  apply(vp.highlights.selected, sel, 22);
}

export function addHighlight(
  vp: ViewportImpl,
  item: HighlightItem,
  style: { fill: number; edge: string; width: number; dot: number },
  order: number,
): void {
  const ui = vp.ui;
  if (item.entity === REFERENCE_ENTITY) {
    // Reference geometry (ADR-093): the plane / axis / point, in the accent colour.
    vp.references.highlight(item, style.edge, style.fill, style.width, order);
    return;
  }
  const onTopSketch = vp.sketches.get(item.bodyId)?.overlay.active === true;
  if (item.kind === 'face') {
    const e = vp.bodies.get(item.bodyId);
    if (!e) return;
    const range = faceDrawRange(e.buffers.faceRanges, item.index, e.triangles);
    if (!range) return;
    const g = new BufferGeometry();
    g.setAttribute('position', e.geometry.getAttribute('position'));
    g.setIndex(e.geometry.index);
    g.setDrawRange(range.start, range.count);
    vp.highlightGroup.add(makeFill(g, ui.accent, style.fill, false, order));
  } else if (item.kind === 'edge') {
    const e = vp.bodies.get(item.bodyId);
    if (!e) return;
    const { edgeRanges, edgePositions } = e.buffers;
    if (2 * item.index + 1 >= edgeRanges.length) return;
    const first = edgeRanges[2 * item.index] as number;
    const count = edgeRanges[2 * item.index + 1] as number;
    const segs = polylineSegments(edgePositions, first, count);
    if (segs.length === 0) return;
    vp.highlightGroup.add(
      makeLines(segs, {
        color: style.edge,
        width: style.width,
        onTop: false,
        renderOrder: order,
      }),
    );
  } else if (item.kind === 'vertex') {
    const e = vp.bodies.get(item.bodyId);
    const v = e ? vertexPositions(vp, e) : null;
    if (!v || 3 * item.index + 2 >= v.length) return;
    const dot = makeDot(style.dot, style.edge, ui.surface, order + 5, [
      v[3 * item.index] as number,
      v[3 * item.index + 1] as number,
      v[3 * item.index + 2] as number,
    ]);
    vp.highlightGroup.add(dot.sprite);
    vp.highlightDots.push(dot);
  } else {
    const s = vp.sketches.get(item.bodyId);
    if (!s) return;
    const onTop = s.overlay.active === true || onTopSketch;
    if (item.kind === 'sketchCurve') {
      const c = s.curves.find((x) => x.entity === item.entity) ?? s.curves[item.index];
      if (!c || c.isPoint) return;
      vp.highlightGroup.add(
        makeLines(polylineSegments(c.points, 0, c.points.length / 3), {
          color: style.edge,
          width: style.width + 0.6,
          onTop,
          renderOrder: order + 8,
        }),
      );
    } else if (item.kind === 'sketchPoint') {
      const c = s.curves.find((x) => x.entity === item.entity) ?? s.curves[item.index];
      if (!c?.isPoint) return;
      const dot = makeDot(style.dot + 2, style.edge, ui.surface, order + 12, [
        c.points[0] as number,
        c.points[1] as number,
        c.points[2] as number,
      ]);
      vp.highlightGroup.add(dot.sprite);
      vp.highlightDots.push(dot);
    } else if (item.kind === 'region') {
      const r = s.regions[item.index];
      if (!r) return;
      vp.highlightGroup.add(
        makeFill(meshBuffersToGeometry(r.mesh), ui.accent, style.fill, onTop, order + 6),
      );
    }
  }
}

export function getHandleScreenLength(vp: ViewportImpl, id: string): number | null {
  const h = vp.handles.get(id);
  if (!h) return null;
  const wpp = cameraWorldPerPixel(vp, depthOf(vp, h.origin));
  const world = h.place(wpp);
  const a = vp.worldToScreen(h.origin);
  const tip: Vec3 = [
    h.origin[0] + h.direction[0] * world,
    h.origin[1] + h.direction[1] * world,
    h.origin[2] + h.direction[2] * world,
  ];
  const b = vp.worldToScreen(tip);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function setPreview(vp: ViewportImpl, id: string, spec: PreviewSpec | null): void {
  if (vp.disposed) return;
  const prev = vp.previews.get(id);
  if (spec === null) {
    if (prev) removePreview(vp, id, prev);
    requestRender(vp);
    return;
  }
  if (spec.kind === 'prism') {
    const body = vp.bodies.get(spec.bodyId);
    if (!body) {
      if (prev) removePreview(vp, id, prev);
      return;
    }
    if (
      prev?.kind === 'prism' &&
      prev.bodyId === spec.bodyId &&
      prev.buffers === body.buffers &&
      sameFaces(prev.faces, spec.faces)
    ) {
      // The same-frame path: three uniform writes, no allocation, no geometry work.
      prev.spec = spec;
      prev.view.update(spec.direction, spec.distance);
      vp.previewDirty = true;
      requestRender(vp);
      return;
    }
    if (prev) removePreview(vp, id, prev);
    const prism = buildPrism(body.buffers, spec.faces);
    if (!prism) return;
    vp.touchStats.prismBuilds++;
    const view = new PrismPreview(prism, previewColors(vp));
    view.update(spec.direction, spec.distance);
    vp.scene.add(view.mesh);
    vp.previews.set(id, {
      kind: 'prism',
      view,
      bodyId: spec.bodyId,
      faces: [...spec.faces],
      buffers: body.buffers,
      spec,
    });
  } else if (prev?.kind === 'mesh') {
    // Updated in place: the material (and its compiled shader) is kept.
    prev.view.setMesh(spec.mesh);
    prev.view.setColor(vp.ui.accent);
    prev.view.setOpacity(spec.opacity ?? 0.4);
  } else {
    if (prev) removePreview(vp, id, prev);
    const view = new MeshPreview(spec.mesh, vp.ui.accent, spec.opacity ?? 0.4);
    vp.scene.add(view.mesh);
    vp.previews.set(id, { kind: 'mesh', view });
  }
  vp.previewDirty = true;
  requestRender(vp);
}

export function removePreview(vp: ViewportImpl, id: string, p: PreviewEntry): void {
  vp.scene.remove(p.view.mesh);
  p.view.dispose();
  vp.previews.delete(id);
}

export function previewColors(vp: ViewportImpl): { add: string; cut: string } {
  return { add: vp.ui.accent, cut: vp.ui.danger };
}

/** A body's buffers changed: rebuild prism previews that were made from the old ones. */
export function refreshPreviewsFor(vp: ViewportImpl, bodyId: string): void {
  for (const [id, p] of [...vp.previews]) {
    if (p.kind === 'prism' && p.bodyId === bodyId) vp.setPreview(id, p.spec);
  }
}

export function setHandle(vp: ViewportImpl, id: string, handle: HandleSpec | null): void {
  if (vp.disposed) return;
  const prev = vp.handles.get(id);
  if (handle === null || handle.kind !== 'arrow') {
    if (prev) {
      vp.scene.remove(prev.group);
      prev.dispose();
      vp.handles.delete(id);
      if (vp.hoveredHandle === id) setHoveredHandle(vp, null);
    }
    requestRender(vp);
    return;
  }
  if (prev) {
    prev.apply(handle);
  } else {
    const h = new ArrowHandle(handle, vp.ui.accent, mixHex(vp.ui.accent, '#ffffff', 0.45));
    vp.scene.add(h.group);
    vp.handles.set(id, h);
  }
  requestRender(vp);
}

export function setHoveredHandle(vp: ViewportImpl, id: string | null): void {
  if (id === vp.hoveredHandle) return;
  if (vp.hoveredHandle) vp.handles.get(vp.hoveredHandle)?.setHover(false);
  vp.hoveredHandle = id;
  if (id) vp.handles.get(id)?.setHover(true);
  vp.touchStats.handleHover = id;
  requestRender(vp);
}

/** Nearest handle within `tolerancePx` of a screen point (arrow thickness is added). */
export function handleAt(
  vp: ViewportImpl,
  x: number,
  y: number,
  tolerancePx: number,
): { id: string; distancePx: number } | null {
  if (vp.handles.size === 0) return null;
  const project = projector(vp);
  const a = { x: 0, y: 0 };
  const b = { x: 0, y: 0 };
  let best: { id: string; distancePx: number } | null = null;
  for (const [id, handle] of vp.handles) {
    const [ox, oy, oz] = handle.origin;
    const len = handle.lengthPx * cameraWorldPerPixel(vp, depthOf(vp, handle.origin));
    if (!project(ox, oy, oz, a)) continue;
    const ex = ox + handle.direction[0] * len;
    const ey = oy + handle.direction[1] * len;
    const ez = oz + handle.direction[2] * len;
    if (!project(ex, ey, ez, b)) continue;
    const d = distPointSegment2D(x, y, a.x, a.y, b.x, b.y).d;
    if (d <= tolerancePx + HANDLE_PICK_PAD_PX && (!best || d < best.distancePx)) {
      best = { id, distancePx: d };
    }
  }
  return best;
}

/** Distance of a world point in front of the camera plane. */
export function depthOf(vp: ViewportImpl, p: Vec3): number {
  syncCameraMatrices(vp);
  const m = vp.camera.matrixWorldInverse.elements;
  return -(
    (m[2] as number) * p[0] +
    (m[6] as number) * p[1] +
    (m[10] as number) * p[2] +
    (m[14] as number)
  );
}

export function setMarkers(vp: ViewportImpl, id: string, markers: Marker[] | null): void {
  if (vp.disposed) return;
  const prev = vp.markerSets.get(id);
  if (prev) {
    vp.scene.remove(prev.group);
    disposeOverlay(prev.group);
    vp.markerSets.delete(id);
  }
  if (markers && markers.length > 0) {
    const tones = MARKER_TONES[vp.theme];
    const group = new Group();
    const dots: Dot[] = [];
    const dash = Math.max(vp.sceneRadius / 45, 1e-3);
    const buckets = new Map<string, { color: string; dashed: boolean; segs: number[] }>();
    for (const m of markers) {
      const color = tones[m.tone ?? 'accent'];
      if (m.kind === 'point') {
        for (const p of m.points) {
          const dot = makeDot(10, color, vp.palette.background, 45, p);
          group.add(dot.sprite);
          dots.push(dot);
        }
        continue;
      }
      const dashed = m.dashed === true;
      const key = `${color}|${dashed ? 'd' : 's'}`;
      const b = buckets.get(key) ?? { color, dashed, segs: [] as number[] };
      buckets.set(key, b);
      for (let i = 0; i + 1 < m.points.length; i++) {
        b.segs.push(...(m.points[i] as Vec3), ...(m.points[i + 1] as Vec3));
      }
    }
    for (const b of buckets.values()) {
      if (b.segs.length === 0) continue;
      group.add(
        makeLines(Float32Array.from(b.segs), {
          color: b.color,
          width: 2.6,
          dashed: b.dashed,
          dash,
          onTop: true,
          renderOrder: 44,
        }),
      );
    }
    vp.scene.add(group);
    vp.markerSets.set(id, { group, dots, markers });
  }
  requestRender(vp);
}
