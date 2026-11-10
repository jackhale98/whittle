import type { PickHit, PickKind, PickOptions, Vec3 } from '@wren-cad/contracts';
import {
  BufferAttribute,
  BufferGeometry,
  FrontSide,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  Ray,
  RenderTarget,
  Vector3,
} from 'three/webgpu';
import { MeshBVH } from 'three-mesh-bvh';
import { handleAt } from './adornments';
import { BVH_PREBUILD_QUIET_MS, REST_WORK_DEBOUNCE_MS } from './constants';
import type { ArrowHandle } from './handles';
import {
  deriveVertices,
  encodeId,
  faceIdPerVertex,
  idAtPixel,
  MAX_ID,
  NO_FACE,
  triangleToFace,
} from './ids';
import {
  type BodyEntry,
  DEFAULT_TOLERANCE_PX,
  ID_SCALE,
  LARGE_FACE_TRIANGLES,
  NAV_SYNC_BVH_TRIANGLES,
} from './internal';
import { disposeOverlay } from './overlays';
import {
  bestCandidate,
  closestOnPolyline,
  type ProjectFn,
  raycastTriangles,
  sortByDistance,
} from './pick';
import { requestRender, scheduleRestWork } from './renderLoop';
import { isClipped, keptRayRange } from './section';
import type { ViewportImpl } from './viewport';

export function pick(vp: ViewportImpl, x: number, y: number, options: PickOptions = {}): PickHit[] {
  if (vp.disposed) return [];
  enablePicking(vp);
  const tol = options.tolerancePx ?? DEFAULT_TOLERANCE_PX;
  const want = (k: PickKind) => !options.kinds || options.kinds.includes(k);
  const out: PickHit[] = [];
  // Handles sit above everything.
  const handleHits: PickHit[] = [];
  if (want('handle') && vp.handles.size > 0) {
    const h = handleAt(vp, x, y, tol);
    if (h) {
      const handle = vp.handles.get(h.id) as ArrowHandle;
      handleHits.push({
        bodyId: h.id,
        kind: 'handle',
        index: 0,
        entity: h.id,
        point: [...handle.origin],
        distancePx: h.distancePx,
      });
    }
    if (handleHits.length > 0 && !options.all) return withDepth(vp, handleHits);
  }
  const ray = rayAt(vp, x, y);
  const project = projector(vp);
  const sectionEq = vp.section?.eq ?? null;
  const anySketchActive = [...vp.sketches.values()].some((s) => s.overlay.active);

  // Sketch entities.
  if (want('sketchCurve') || want('sketchPoint') || want('region')) {
    for (const [featureId, s] of vp.sketches) {
      s.curves.forEach((c, i) => {
        const kind: PickKind = c.isPoint ? 'sketchPoint' : 'sketchCurve';
        if (!want(kind)) return;
        const h = closestOnPolyline(c.points, 0, c.points.length / 3, project, x, y);
        if (h && h.distancePx <= tol) {
          out.push({
            bodyId: featureId,
            kind,
            index: i,
            entity: c.entity,
            point: h.point,
            distancePx: h.distancePx,
          });
        }
      });
      if (want('region')) {
        s.regions.forEach((r, i) => {
          const tri = raycastTriangles(
            ray.origin,
            ray.dir,
            r.mesh.positions,
            r.mesh.indices,
            0,
            r.mesh.indices.length / 3,
            false,
          );
          if (tri) {
            out.push({
              bodyId: featureId,
              kind: 'region',
              index: i,
              entity: r.name,
              point: [
                ray.origin[0] + ray.dir[0] * tri.t,
                ray.origin[1] + ray.dir[1] * tri.t,
                ray.origin[2] + ray.dir[2] * tri.t,
              ],
              distancePx: 0,
            });
          }
        });
      }
    }
  }

  // Body vertices and edges (screen-space distance, occlusion-tested).
  const thin: PickHit[] = [];
  for (const [id, e] of vp.bodies) {
    if (!e.display.visible) continue;
    if (want('vertex')) {
      const v = vertexPositions(vp, e);
      for (let i = 0; i < v.length / 3; i++) {
        const h = closestOnPolyline(v, i, 1, project, x, y);
        if (h && h.distancePx <= tol && !isClipped(sectionEq, h.point, 1e-6)) {
          thin.push({
            bodyId: id,
            kind: 'vertex',
            index: i,
            point: h.point,
            distancePx: h.distancePx,
          });
        }
      }
    }
    if (want('edge')) {
      const { edgePositions, edgeRanges } = e.buffers;
      const pointCount = edgePositions.length / 3;
      for (let i = 0; i < edgeRanges.length / 2; i++) {
        const first = edgeRanges[2 * i] as number;
        const count = Math.min(edgeRanges[2 * i + 1] as number, pointCount - first);
        const h = closestOnPolyline(edgePositions, first, count, project, x, y);
        if (h && h.distancePx <= tol && !isClipped(sectionEq, h.point, 1e-6)) {
          thin.push({
            bodyId: id,
            kind: 'edge',
            index: i,
            point: h.point,
            distancePx: h.distancePx,
          });
        }
      }
    }
  }
  for (const t of thin) {
    if (anySketchActive || isVisiblePoint(vp, ray.origin, t.point)) out.push(t);
  }

  // Faces (ID buffer, BVH fallback).
  if (want('face') && !anySketchActive) {
    const f = pickFace(vp, x, y, ray);
    if (f) out.push(f);
  }

  if (options.all) return withDepth(vp, [...handleHits, ...sortByDistance(out)]);
  const best = bestCandidate(out);
  return best ? withDepth(vp, [best]) : [];
}

/** Stamp hits with their distance from the camera (mm), the chooser's stable tie-break. */
export function withDepth(vp: ViewportImpl, hits: PickHit[]): PickHit[] {
  const o = vp.camera.position;
  for (const h of hits) {
    h.depth = Math.hypot(h.point[0] - o.x, h.point[1] - o.y, h.point[2] - o.z);
  }
  return hits;
}

export function whenPickReady(vp: ViewportImpl): Promise<void> {
  if (vp.disposed) return Promise.resolve();
  enablePicking(vp);
  if (idFresh(vp)) return Promise.resolve();
  return new Promise((resolve) => {
    vp.pickWaiters.push(resolve);
    requestRender(vp);
    // Someone is waiting: no debounce (the frame loop may be idle, so ask directly).
    if (!vp.raf) scheduleRestWork(vp);
  });
}

export function enablePicking(vp: ViewportImpl): void {
  if (vp.pickingEnabled) return;
  vp.pickingEnabled = true;
  requestRender(vp);
}

export function idFresh(vp: ViewportImpl): boolean {
  return vp.idImage !== null && vp.idImage.version === vp.viewVersion;
}

export function syncCameraMatrices(vp: ViewportImpl): void {
  vp.camera.updateMatrixWorld();
  vp.camera.matrixWorldInverse.copy(vp.camera.matrixWorld).invert();
}

export function rayAt(vp: ViewportImpl, x: number, y: number): { origin: Vec3; dir: Vec3 } {
  syncCameraMatrices(vp);
  const w = vp.canvas.clientWidth || 1;
  const h = vp.canvas.clientHeight || 1;
  const p = new Vector3((x / w) * 2 - 1, -(y / h) * 2 + 1, 0.5).unproject(vp.camera);
  const o = vp.camera.position;
  const d = p.sub(o).normalize();
  return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] };
}

/** World -> CSS px projector for the current camera (allocation-free per call). */
export function projector(vp: ViewportImpl): ProjectFn {
  syncCameraMatrices(vp);
  const m = new Matrix4().multiplyMatrices(
    vp.camera.projectionMatrix,
    vp.camera.matrixWorldInverse,
  ).elements;
  const w = vp.canvas.clientWidth || 1;
  const h = vp.canvas.clientHeight || 1;
  const m0 = m[0] as number;
  const m1 = m[1] as number;
  const m3 = m[3] as number;
  const m4 = m[4] as number;
  const m5 = m[5] as number;
  const m7 = m[7] as number;
  const m8 = m[8] as number;
  const m9 = m[9] as number;
  const m11 = m[11] as number;
  const m12 = m[12] as number;
  const m13 = m[13] as number;
  const m15 = m[15] as number;
  return (x, y, z, out) => {
    const cw = m3 * x + m7 * y + m11 * z + m15;
    if (cw <= 1e-9) return false;
    const cx = m0 * x + m4 * y + m8 * z + m12;
    const cy = m1 * x + m5 * y + m9 * z + m13;
    out.x = (cx / cw) * 0.5 * w + 0.5 * w;
    out.y = (1 - cy / cw) * 0.5 * h;
    return true;
  };
}

export function invalidatePickData(vp: ViewportImpl, e: BodyEntry): void {
  e.bvh = null;
  e.triFace = null;
  e.vertices = null;
  e.faceLayout = null;
  e.idBuiltBase = -1;
  if (e.idMesh) {
    vp.idRoot.remove(e.idMesh);
    disposeOverlay(e.idMesh, true);
    e.idMesh = null;
  }
}

export function vertexPositions(_vp: ViewportImpl, e: BodyEntry): Float32Array {
  e.vertices ??= deriveVertices(e.buffers.edgePositions, e.buffers.edgeRanges, e.buffers.bbox);
  return e.vertices;
}

export function bvhFor(vp: ViewportImpl, e: BodyEntry): MeshBVH {
  if (!e.bvh) {
    const t0 = performance.now();
    // `indirect` keeps the kernel's index buffer untouched (it is shared with the GPU geometry).
    e.bvh = new MeshBVH(e.geometry, { indirect: true });
    vp.pickStats.lastBvhBuildMs = performance.now() - t0;
  }
  return e.bvh;
}

export function triFaceFor(_vp: ViewportImpl, e: BodyEntry): Uint32Array {
  e.triFace ??= triangleToFace(e.buffers.faceRanges, e.triangles);
  return e.triFace;
}

/** True when no visible body lies between the camera and `point`. */
export function isVisiblePoint(vp: ViewportImpl, origin: Vec3, point: Vec3): boolean {
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const dz = point[2] - origin[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-9) return true;
  const eps = dist * 3e-3 + vp.sceneRadius * 2e-3;
  const dir: Vec3 = [dx / dist, dy / dist, dz / dist];
  const ray = new Ray(
    new Vector3(origin[0], origin[1], origin[2]),
    new Vector3(dir[0], dir[1], dir[2]),
  );
  // Geometry removed by the section cannot occlude.
  const range = keptRayRange(vp.section?.eq ?? null, origin, dir, Math.max(dist - eps, 0));
  if (!range) return true;
  for (const e of vp.bodies.values()) {
    if (!e.display.visible) continue;
    const hit = bvhFor(vp, e).raycastFirst(ray, FrontSide, range[0], range[1]);
    if (hit) return false;
  }
  return true;
}

export function pickFace(
  vp: ViewportImpl,
  x: number,
  y: number,
  ray: { origin: Vec3; dir: Vec3 },
): PickHit | null {
  // 1. ID buffer, when current.
  if (idFresh(vp) && vp.idImage) {
    const img = vp.idImage;
    const id = idAtPixel(
      img.data,
      img.w,
      img.h,
      (x * img.w) / (vp.canvas.clientWidth || 1),
      (y * img.h) / (vp.canvas.clientHeight || 1),
      vp.backend === 'webgl2',
    );
    if (id === 0) {
      vp.pickStats.idBufferPicks++;
      return null;
    }
    const slot = vp.idLayout.find((l) => id - 1 >= l.base && id - 1 < l.base + l.faces);
    if (slot) {
      vp.pickStats.idBufferPicks++;
      const face = id - 1 - slot.base;
      const hit = faceHit(vp, slot.id, slot.entry, face, ray);
      if (hit && !isClipped(vp.section?.eq ?? null, hit.point, 1e-6)) return hit;
      // The pixel's face was missed by the exact ray (silhouette rounding): use the BVH.
    }
  }
  // 2. CPU fallback: nearest front-facing triangle over all visible bodies.
  vp.pickStats.fallbackPicks++;
  let best: {
    id: string;
    e: BodyEntry;
    dist: number;
    tri: number;
    nx: number;
    ny: number;
    nz: number;
    px: number;
    py: number;
    pz: number;
  } | null = null;
  const r = new Ray(
    new Vector3(ray.origin[0], ray.origin[1], ray.origin[2]),
    new Vector3(ray.dir[0], ray.dir[1], ray.dir[2]),
  );
  const range = keptRayRange(vp.section?.eq ?? null, ray.origin, ray.dir);
  if (!range) return null;
  for (const [id, e] of vp.bodies) {
    if (!e.display.visible) continue;
    const hit = bvhFor(vp, e).raycastFirst(r, FrontSide, range[0], range[1]);
    if (hit && hit.faceIndex != null && (!best || hit.distance < best.dist)) {
      best = {
        id,
        e,
        dist: hit.distance,
        tri: hit.faceIndex,
        nx: hit.face?.normal.x ?? 0,
        ny: hit.face?.normal.y ?? 0,
        nz: hit.face?.normal.z ?? 0,
        px: hit.point.x,
        py: hit.point.y,
        pz: hit.point.z,
      };
    }
  }
  if (!best) return null;
  const face = triFaceFor(vp, best.e)[best.tri];
  if (face === undefined || face === NO_FACE) return null;
  return {
    bodyId: best.id,
    kind: 'face',
    index: face,
    point: [best.px, best.py, best.pz],
    normal: [best.nx, best.ny, best.nz],
    distancePx: 0,
  };
}

/** Exact hit point and smooth normal of the ray on one face (brute force over its triangles). */
export function faceHit(
  _vp: ViewportImpl,
  bodyId: string,
  e: BodyEntry,
  face: number,
  ray: { origin: Vec3; dir: Vec3 },
): PickHit | null {
  const { faceRanges, indices, positions, normals } = e.buffers;
  if (2 * face + 1 >= faceRanges.length) return null;
  const first = faceRanges[2 * face] as number;
  const count = faceRanges[2 * face + 1] as number;
  // Huge faces (dense imports) are cheaper through the BVH than brute force.
  if (count > LARGE_FACE_TRIANGLES) return null;
  const hit = raycastTriangles(ray.origin, ray.dir, positions, indices, first, count, true);
  if (!hit) return null;
  const ia = indices[3 * hit.tri] as number;
  const ib = indices[3 * hit.tri + 1] as number;
  const ic = indices[3 * hit.tri + 2] as number;
  const wa = 1 - hit.u - hit.v;
  const n: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    n[k] =
      wa * (normals[3 * ia + k] as number) +
      hit.u * (normals[3 * ib + k] as number) +
      hit.v * (normals[3 * ic + k] as number);
  }
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return {
    bodyId,
    kind: 'face',
    index: face,
    point: [
      ray.origin[0] + ray.dir[0] * hit.t,
      ray.origin[1] + ray.dir[1] * hit.t,
      ray.origin[2] + ray.dir[2] * hit.t,
    ],
    normal: [n[0] / len, n[1] / len, n[2] / len],
    distancePx: 0,
  };
}

/**
 * Render body face ids into the offscreen target and read it back asynchronously. Runs when the
 * view is idle, so orbiting never pays for it; `pick` uses the result while it is current and
 * the BVH otherwise.
 */
export function kickIdRefresh(vp: ViewportImpl): void {
  if (!vp.pickingEnabled || vp.idBusy || vp.disposed || idFresh(vp)) return;
  const w = vp.canvas.clientWidth;
  const h = vp.canvas.clientHeight;
  if (w === 0 || h === 0) return;
  const rw = Math.max(1, Math.round(w * ID_SCALE));
  const rh = Math.max(1, Math.round(h * ID_SCALE));
  const version = vp.viewVersion;
  const t0 = performance.now();

  if (!vp.idTarget) {
    vp.idTarget = new RenderTarget(rw, rh, {
      depthBuffer: true,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
    });
  } else if (vp.idTarget.width !== rw || vp.idTarget.height !== rh) {
    vp.idTarget.setSize(rw, rh);
  }

  // Lay out ids and (re)build id geometry for bodies that need it.
  vp.idLayout = [];
  let base = 0;
  for (const [id, e] of vp.bodies) {
    const faces = e.buffers.faceRanges.length / 2;
    if (!e.display.visible || faces === 0 || base + faces > MAX_ID - 1) {
      if (e.idMesh) e.idMesh.visible = false;
      continue;
    }
    e.idBase = base;
    ensureIdMesh(vp, e);
    if (e.idMesh) e.idMesh.visible = true;
    vp.idLayout.push({ id, entry: e, base, faces });
    base += faces;
  }

  const r = vp.renderer;
  const prevTarget = r.getRenderTarget();
  syncCameraMatrices(vp);
  r.setRenderTarget(vp.idTarget);
  r.render(vp.idScene, vp.camera);
  r.setRenderTarget(prevTarget);

  vp.idBusy = true;
  const target = vp.idTarget;
  void r
    .readRenderTargetPixelsAsync(target, 0, 0, rw, rh)
    .then((data) => {
      vp.idImage = { data: data as Uint8Array, w: rw, h: rh, version };
      vp.pickStats.idRefreshes++;
      vp.pickStats.lastIdRefreshMs = performance.now() - t0;
    })
    .catch((err) => {
      console.warn('[wren/viewport] ID buffer readback failed', err);
    })
    .finally(() => {
      vp.idBusy = false;
      if (vp.disposed) return;
      prebuildBvh(vp);
      if (idFresh(vp)) {
        const waiters = vp.pickWaiters;
        vp.pickWaiters = [];
        for (const wk of waiters) wk();
      } else {
        requestRender(vp); // the view moved meanwhile; refresh again when idle
      }
    });
}

export function hasBody(vp: ViewportImpl, e: BodyEntry): boolean {
  for (const b of vp.bodies.values()) if (b === e) return true;
  return false;
}

/** Build missing BVHs one body per idle slot so the first edge/occlusion pick does not stall. */
export function prebuildBvh(vp: ViewportImpl): void {
  const next = [...vp.bodies.values()].find((b) => b.display.visible && !b.bvh);
  if (!next) return;
  const run = () => {
    if (vp.disposed || next.bvh || !hasBody(vp, next)) return;
    // A build is one uninterruptible task (hundreds of ms at 1M triangles): never start one
    // while the camera moves or the wheel has just turned; try again after a quiet spell.
    const need =
      next.triangles > NAV_SYNC_BVH_TRIANGLES ? BVH_PREBUILD_QUIET_MS : REST_WORK_DEBOUNCE_MS;
    const quietFor = performance.now() - vp.lastActivityAt;
    if (vp.isCameraMoving() || vp.nav || quietFor < need) {
      setTimeout(wait, Math.max(REST_WORK_DEBOUNCE_MS, need - quietFor));
      return;
    }
    bvhFor(vp, next);
    prebuildBvh(vp);
  };
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  const wait = () => (ric ? ric(run) : run());
  setTimeout(wait, 50);
}

export function ensureIdMesh(vp: ViewportImpl, e: BodyEntry): void {
  if (e.idMesh && e.idBuiltBase === e.idBase) return;
  if (!e.faceLayout) {
    e.faceLayout = faceIdPerVertex(
      e.buffers.positions.length / 3,
      e.buffers.indices,
      e.buffers.faceRanges,
    );
  }
  const layout = e.faceLayout;
  const nVerts = layout.faceOfVertex.length;
  const colors = new Uint8Array(nVerts * 3);
  for (let v = 0; v < nVerts; v++) {
    const f = layout.faceOfVertex[v] as number;
    if (f === NO_FACE) continue;
    const [r, g, b] = encodeId(e.idBase + f + 1);
    colors[3 * v] = r;
    colors[3 * v + 1] = g;
    colors[3 * v + 2] = b;
  }
  if (e.idMesh) {
    // Same mesh version, shifted base: refill the colour attribute in place.
    const attr = e.idMesh.geometry.getAttribute('color') as BufferAttribute;
    attr.array = colors;
    attr.needsUpdate = true;
    e.idBuiltBase = e.idBase;
    return;
  }
  const geometry = new BufferGeometry();
  if (layout.appended.length === 0) {
    geometry.setAttribute('position', e.geometry.getAttribute('position'));
    geometry.setIndex(e.geometry.index);
  } else {
    const src = e.buffers.positions;
    const n = src.length / 3;
    const pos = new Float32Array(nVerts * 3);
    pos.set(src);
    for (let i = 0; i < layout.appended.length; i++) {
      const s = (layout.appended[i] as number) * 3;
      pos[3 * (n + i)] = src[s] as number;
      pos[3 * (n + i) + 1] = src[s + 1] as number;
      pos[3 * (n + i) + 2] = src[s + 2] as number;
    }
    geometry.setAttribute('position', new BufferAttribute(pos, 3));
    geometry.setIndex(new BufferAttribute(layout.indices, 1));
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3, true));
  const material = new MeshBasicNodeMaterial({ vertexColors: true, side: FrontSide });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  vp.idRoot.add(mesh);
  e.idMesh = mesh;
  e.idBuiltBase = e.idBase;
}
