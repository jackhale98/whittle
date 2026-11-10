import type { BodyDisplay, MeshBuffers } from '@wren-cad/contracts';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import {
  type BufferAttribute,
  Color,
  FrontSide,
  Group,
  Line2NodeMaterial,
  Mesh,
  MeshStandardNodeMaterial,
  PMREMGenerator,
  Vector3,
} from 'three/webgpu';
import { previewColors, rebuildHighlights, refreshPreviewsFor } from './adornments';
import { effectiveOpacity } from './compare';
import { buildCompare } from './compareView';
import { edgesToSegments, meshBuffersToGeometry } from './geometry';
import {
  type BodyEntry,
  DEFAULT_BODY_COLOR_KEY,
  DEFAULT_DISPLAY,
  type GhostEntry,
  stripUndefined,
} from './internal';
import { buildPivotMarker } from './navControl';
import { applyDepthBias, disposeOverlay } from './overlays';
import { invalidatePickData } from './picking';
import { requestRender } from './renderLoop';
import { applyCapState, disposeCap, ensureCap, placeCaps } from './sectionView';
import { anySketchActive } from './sketchOverlays';
import { mixHex } from './sketchStyle';
import { OVERLAY_COLORS, PALETTES } from './themes';
import type { ViewportImpl } from './viewport';
import {
  type Bounds,
  boundsCenter,
  boundsRadius,
  EMPTY_BOUNDS,
  gridCellSize,
  unionBounds,
} from './views';

export function setBody(
  vp: ViewportImpl,
  id: string,
  mesh: MeshBuffers,
  display: BodyDisplay = {},
): void {
  if (vp.disposed) return;
  // The first body has priority over the environment; build it right after that frame.
  queueMicrotask(() => scheduleEnvironment(vp));
  const wasEmpty = vp.bodies.size === 0;
  const previous = vp.bodies.get(id);
  const merged: Required<BodyDisplay> = {
    ...DEFAULT_DISPLAY,
    ...previous?.display,
    ...stripUndefined(display),
  };

  const bounds: Bounds = { min: [...mesh.bbox.min], max: [...mesh.bbox.max] };
  let entry: BodyEntry;
  if (previous) {
    // Cheap replace (coarse <-> fine during drags): keep the mesh, material (no shader
    // recompile), group and line object; only swap or refill the geometry.
    entry = previous;
    replaceGeometry(vp, entry, mesh);
    entry.buffers = mesh;
    entry.triangles = mesh.indices.length / 3;
    entry.bounds = bounds;
    entry.display = merged;
  } else {
    const geometry = meshBuffersToGeometry(mesh);
    const material = createBodyMaterial(vp, resolveBodyColor(vp, merged.color));
    const object = new Mesh(geometry, material);
    object.frustumCulled = false;
    const group = new Group();
    group.add(object);
    vp.bodyRoot.add(group);
    entry = {
      group,
      object,
      lines: null,
      material,
      geometry,
      buffers: mesh,
      triangles: mesh.indices.length / 3,
      bounds,
      display: merged,
      bvh: null,
      triFace: null,
      vertices: null,
      faceLayout: null,
      idMesh: null,
      idBuiltBase: -1,
      idBase: 0,
      cap: null,
    };
    vp.bodies.set(id, entry);
    setEdges(vp, entry, mesh);
    if (vp.section) ensureCap(vp, entry);
  }
  invalidatePickData(vp, entry);
  applyDisplay(vp, entry);
  updateSceneBounds(vp);
  if (wasEmpty) vp.fitAll(false);
  vp.viewVersion++;
  rebuildHighlights(vp);
  if (previous) refreshPreviewsFor(vp, id);
  requestRender(vp);
}

export function removeBody(vp: ViewportImpl, id: string): void {
  const entry = vp.bodies.get(id);
  if (!entry) return;
  disposeBody(vp, entry);
  vp.bodies.delete(id);
  updateSceneBounds(vp);
  vp.viewVersion++;
  rebuildHighlights(vp);
  requestRender(vp);
}

export function setDisplay(vp: ViewportImpl, id: string, display: BodyDisplay): void {
  const entry = vp.bodies.get(id);
  if (!entry) return;
  entry.display = { ...entry.display, ...stripUndefined(display) };
  applyDisplay(vp, entry);
  updateSceneBounds(vp);
  vp.viewVersion++;
  requestRender(vp);
}

export function setTheme(vp: ViewportImpl, theme: 'light' | 'dark'): void {
  vp.theme = theme;
  vp.palette = PALETTES[theme];
  vp.ui = OVERLAY_COLORS[theme];
  applyPalette(vp);
  for (const e of vp.bodies.values()) applyDisplay(vp, e);
  vp.cube?.setColors(vp.ui);
  rebuildHighlights(vp);
  for (const [id, s] of [...vp.sketches]) vp.setSketch(id, s.overlay);
  for (const [id, g] of [...vp.ghosts]) rebuildGhostColors(vp, id, g);
  if (vp.compare) buildCompare(vp, vp.compare.overlay);
  for (const p of vp.previews.values()) {
    if (p.kind === 'prism') p.view.setColors(previewColors(vp));
    else p.view.setColor(vp.ui.accent);
  }
  for (const h of vp.handles.values()) {
    h.setColors(vp.ui.accent, mixHex(vp.ui.accent, '#ffffff', 0.45));
  }
  for (const [id, m] of [...vp.markerSets]) vp.setMarkers(id, m.markers);
  if (vp.pivotMarker) buildPivotMarker(vp);
  requestRender(vp);
}

export function setGhost(vp: ViewportImpl, bodyId: string, mesh: MeshBuffers | null): void {
  const prev = vp.ghosts.get(bodyId);
  if (prev) {
    vp.bodyRoot.remove(prev.group);
    disposeOverlay(prev.group);
    vp.ghosts.delete(bodyId);
  }
  if (mesh && !vp.disposed) {
    const material = new MeshStandardNodeMaterial({
      color: ghostColor(vp),
      roughness: 0.6,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: FrontSide,
    });
    const m = new Mesh(meshBuffersToGeometry(mesh), material);
    m.frustumCulled = false;
    m.renderOrder = 2;
    const group = new Group();
    group.add(m);
    let lineMaterial: Line2NodeMaterial | null = null;
    const segs = edgesToSegments(mesh.edgePositions, mesh.edgeRanges);
    if (segs.length > 0) {
      const g = new LineSegmentsGeometry();
      g.setPositions(segs);
      lineMaterial = applyDepthBias(
        new Line2NodeMaterial({ color: ghostEdgeColor(vp), linewidth: 1.2 }),
      );
      const l = new LineSegments2(g, lineMaterial);
      l.frustumCulled = false;
      l.renderOrder = 3;
      group.add(l);
    }
    vp.bodyRoot.add(group);
    vp.ghosts.set(bodyId, { group, material, lineMaterial });
  }
  requestRender(vp);
}

export function applyDimming(vp: ViewportImpl): void {
  for (const e of vp.bodies.values()) applyDisplay(vp, e);
  vp.edgeMaterial.color.set(bodyEdgeColor(vp));
}

/** Body edge colour: faded toward the background while sketching or comparing. */
export function bodyEdgeColor(vp: ViewportImpl): string {
  const p = vp.palette;
  if (anySketchActive(vp)) return mixHex(p.edge, p.background, 0.65);
  if (vp.compare) return mixHex(p.edge, p.background, 0.6);
  return p.edge;
}

export function ghostColor(vp: ViewportImpl): string {
  return mixHex(vp.palette.body, vp.ui.danger, 0.35);
}

export function ghostEdgeColor(vp: ViewportImpl): string {
  return mixHex(vp.palette.edge, vp.palette.background, 0.45);
}

export function rebuildGhostColors(vp: ViewportImpl, _id: string, g: GhostEntry): void {
  g.material.color.set(ghostColor(vp));
  g.lineMaterial?.color.set(ghostEdgeColor(vp));
}

/** Swap geometry in place: refill same-size buffers, otherwise replace the geometry object. */
export function replaceGeometry(vp: ViewportImpl, e: BodyEntry, mesh: MeshBuffers): void {
  const g = e.geometry;
  const pos = g.getAttribute('position') as BufferAttribute;
  const nor = g.getAttribute('normal') as BufferAttribute;
  const idx = g.index as BufferAttribute;
  if (
    pos.array.length === mesh.positions.length &&
    nor.array.length === mesh.normals.length &&
    idx.array.length === mesh.indices.length
  ) {
    pos.array = mesh.positions;
    nor.array = mesh.normals;
    idx.array = mesh.indices;
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    idx.needsUpdate = true;
    const { min, max } = mesh.bbox;
    g.boundingSphere?.center.set(
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    );
    g.boundingSphere?.set(
      g.boundingSphere.center,
      Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2,
    );
    g.userData.faces = { faceRanges: mesh.faceRanges, faceNames: mesh.faceNames };
  } else {
    const next = meshBuffersToGeometry(mesh);
    e.object.geometry = next;
    e.geometry = next;
    if (e.cap) {
      e.cap.back.geometry = next;
      e.cap.front.geometry = next;
    }
    g.dispose();
  }
  setEdges(vp, e, mesh);
}

export function setEdges(vp: ViewportImpl, e: BodyEntry, mesh: MeshBuffers): void {
  const segments = edgesToSegments(mesh.edgePositions, mesh.edgeRanges);
  if (segments.length === 0) {
    if (e.lines) {
      e.group.remove(e.lines);
      e.lines.geometry.dispose();
      e.lines = null;
    }
    return;
  }
  const lineGeometry = new LineSegmentsGeometry();
  lineGeometry.setPositions(segments);
  if (e.lines) {
    const old = e.lines.geometry;
    e.lines.geometry = lineGeometry;
    old.dispose();
  } else {
    e.lines = new LineSegments2(lineGeometry, vp.edgeMaterial);
    e.lines.frustumCulled = false;
    e.group.add(e.lines);
  }
}

/** Builds the studio environment once, on idle after the next presented frame. */
export function scheduleEnvironment(vp: ViewportImpl): void {
  if (vp.envScheduled || vp.disposed) return;
  vp.envScheduled = true;
  void vp.nextFrame().then(() => {
    const build = () => {
      if (vp.disposed) return;
      const pmrem = new PMREMGenerator(vp.renderer);
      // 64² faces: CAD materials are rough, so a small environment looks the same.
      const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04, 0.1, 100, { size: 64 });
      pmrem.dispose();
      vp.envTarget = envRT;
      vp.scene.environment = envRT.texture;
      vp.scene.remove(vp.fillLight);
      vp.touchStats.environmentReady = true;
      requestRender(vp);
    };
    const ric = (
      globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
    ).requestIdleCallback;
    if (ric) ric(build, { timeout: 500 });
    else setTimeout(build, 0);
  });
}

export function updateSceneBounds(vp: ViewportImpl): void {
  const visible = bodyBoundsList(vp);
  vp.sceneBounds = unionBounds(visible) ?? EMPTY_BOUNDS;
  vp.sceneRadius = boundsRadius(vp.sceneBounds);
  const [cx, cy] = boundsCenter(vp.sceneBounds);
  const { min, max } = vp.sceneBounds;
  const eps = Math.max(vp.sceneRadius * 0.0004, 1e-4);

  vp.grid.place(cx, cy, min[2] - eps * 2, vp.sceneRadius * 9, gridCellSize(vp.sceneRadius));
  vp.shadow.place(cx, cy, min[2] - eps, Math.max(max[0] - min[0], 1), Math.max(max[1] - min[1], 1));
  vp.shadow.mesh.visible = visible.length > 0;
  vp.controls.minDistance = vp.sceneRadius * 0.05;
  vp.controls.maxDistance = vp.sceneRadius * 40;
  vp.keyLight.position
    .set(-0.4, -0.6, 0.9)
    .multiplyScalar(vp.sceneRadius * 6)
    .add(new Vector3(cx, cy, 0));
  placeCaps(vp);
}

export function applyPalette(vp: ViewportImpl): void {
  const p = vp.palette;
  vp.scene.background = new Color(p.background);
  vp.edgeMaterial.color.set(bodyEdgeColor(vp));
  vp.grid.setPalette(p);
  vp.shadow.setPalette(p);
  vp.scene.environmentIntensity = p.envIntensity;
  vp.keyLight.intensity = p.keyLight;
}

export function createBodyMaterial(_vp: ViewportImpl, color: string): MeshStandardNodeMaterial {
  return new MeshStandardNodeMaterial({
    color,
    roughness: 0.52,
    metalness: 0.0,
    side: FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

/** Body colour as drawn: dimmed toward the background while a sketch is being edited. */
export function effectiveBodyColor(vp: ViewportImpl, e: BodyEntry): string {
  const base = resolveBodyColor(vp, e.display.color);
  return anySketchActive(vp) ? mixHex(base, vp.palette.background, 0.6) : base;
}

export function resolveBodyColor(vp: ViewportImpl, color: string): string {
  return color === DEFAULT_BODY_COLOR_KEY ? vp.palette.body : color;
}

/** Opacity as drawn: the body's own, or the compare ghost opacity while an overlay is set. */
export function drawnOpacity(vp: ViewportImpl, e: BodyEntry): number {
  return effectiveOpacity(e.display.opacity, vp.compare ? vp.compare.ghost : null);
}

export function bodyBoundsList(vp: ViewportImpl): Bounds[] {
  return [...vp.bodies.values()].filter((b) => b.display.visible).map((b) => b.bounds);
}

export function applyDisplay(vp: ViewportImpl, e: BodyEntry): void {
  e.group.visible = e.display.visible;
  // While a sketch is being edited the rest of the model recedes toward the background.
  e.material.color.set(effectiveBodyColor(vp, e));
  const opacity = drawnOpacity(vp, e);
  const translucent = opacity < 1;
  e.material.transparent = translucent;
  e.material.opacity = opacity;
  e.material.depthWrite = !translucent;
  e.material.needsUpdate = true;
  applyCapState(vp, e);
}

export function disposeBody(vp: ViewportImpl, e: BodyEntry): void {
  vp.bodyRoot.remove(e.group);
  disposeCap(vp, e);
  if (e.idMesh) {
    vp.idRoot.remove(e.idMesh);
    disposeOverlay(e.idMesh, true);
    e.idMesh = null;
  }
  e.geometry.dispose();
  e.material.dispose();
  e.lines?.geometry.dispose();
}
