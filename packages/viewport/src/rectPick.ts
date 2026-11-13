import type { PickHit, PickKind, RectPickOptions, ScreenRect, Vec3 } from '@wren-cad/contracts';
import { FrontSide, Ray, Vector3 } from 'three/webgpu';
import { idAtPixel } from './ids';
import { EDGE_SAMPLE_FRACTIONS, sub3 } from './internal';
import {
  countIdPixels,
  normalizeRect,
  pointInRect,
  polylineVsRect,
  type Rect,
  triangleTouchesRect,
} from './navigation';
import { KIND_PRIORITY, type ProjectFn } from './pick';
import {
  enablePicking,
  faceHit,
  idFresh,
  isVisiblePoint,
  pickFace,
  projector,
  rayAt,
  syncCameraMatrices,
  vertexPositions,
} from './picking';
import { depthFromEye } from './projection';
import { isClipped } from './section';
import type { ViewportImpl } from './viewport';
import { boundsCenter } from './views';

/**
 * Everything in a screen rectangle. `window` = entirely inside, `crossing` = touching.
 * Faces come from the ID buffer (visible pixels; `await whenPickReady()` first for an exact
 * answer, otherwise a geometric test filtered by sampled rays), edges and vertices from their
 * projected polylines, occlusion-tested against the BVH when `visibleOnly` (default). Sketch
 * entities are never occlusion-tested. Default kinds: face, edge, vertex, sketchPoint,
 * sketchCurve (regions and handles only when asked for). Nearest to the camera first.
 */
export function pickRect(
  vp: ViewportImpl,
  rectIn: ScreenRect,
  options: RectPickOptions,
): PickHit[] {
  if (vp.disposed) return [];
  const rect = normalizeRect(rectIn);
  const windowMode = options.mode === 'window';
  const visibleOnly = options.visibleOnly !== false;
  const want = (k: PickKind) =>
    options.kinds ? options.kinds.includes(k) : k !== 'handle' && k !== 'region';
  enablePicking(vp);
  syncCameraMatrices(vp);
  const project = projector(vp);
  const o = vp.camera.position;
  const origin: Vec3 = [o.x, o.y, o.z]; // perspective sight lines; orthographic ones are rebuilt per point
  const sectionEq = vp.section?.eq ?? null;
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  const found: PickHit[] = [];
  const seen = new Set<string>();
  const add = (h: PickHit) => {
    const key = `${h.kind}|${h.bodyId}|${h.index}|${h.entity ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(h);
  };
  const tmp = { x: 0, y: 0 };
  const scratch: number[] = [];
  /** Project a polyline into `scratch` (NaN = behind the camera). */
  const projectPoints = (src: ArrayLike<number>, first: number, count: number): void => {
    scratch.length = 0;
    for (let i = 0; i < count; i++) {
      const j = 3 * (first + i);
      if (project(src[j] as number, src[j + 1] as number, src[j + 2] as number, tmp)) {
        scratch.push(tmp.x, tmp.y);
      } else {
        scratch.push(Number.NaN, Number.NaN);
      }
    }
  };
  /** Index of the projected point nearest the rect centre (in-rect points preferred). */
  const nearestIndex = (count: number): number => {
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const x = scratch[2 * i] as number;
      if (Number.isNaN(x)) continue;
      const y = scratch[2 * i + 1] as number;
      const d = Math.hypot(x - cx, y - cy) + (pointInRect(x, y, rect) ? 0 : 1e6);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return Math.max(best, 0);
  };
  const dist2c = (k: number) =>
    Math.hypot((scratch[2 * k] as number) - cx, (scratch[2 * k + 1] as number) - cy);

  // ---- sketch entities
  if (want('sketchCurve') || want('sketchPoint') || want('region')) {
    for (const [featureId, s] of vp.sketches) {
      s.curves.forEach((c, i) => {
        const kind: PickKind = c.isPoint ? 'sketchPoint' : 'sketchCurve';
        if (!want(kind)) return;
        const n = c.points.length / 3;
        projectPoints(c.points, 0, n);
        const r = polylineVsRect(scratch, n, rect);
        if (!(windowMode ? r.inside : r.touches)) return;
        const k = nearestIndex(n);
        add({
          bodyId: featureId,
          kind,
          index: i,
          entity: c.entity,
          point: [
            c.points[3 * k] as number,
            c.points[3 * k + 1] as number,
            c.points[3 * k + 2] as number,
          ],
          distancePx: dist2c(k),
        });
      });
      if (want('region')) {
        s.regions.forEach((r, i) => {
          const { positions, indices } = r.mesh;
          projectPoints(positions, 0, positions.length / 3);
          let any = false;
          let all = indices.length > 0;
          for (let t = 0; t < indices.length; t += 3) {
            const a = indices[t] as number;
            const b = indices[t + 1] as number;
            const d = indices[t + 2] as number;
            const ax = scratch[2 * a] as number;
            const bx = scratch[2 * b] as number;
            const dx = scratch[2 * d] as number;
            if (Number.isNaN(ax) || Number.isNaN(bx) || Number.isNaN(dx)) {
              all = false;
              continue;
            }
            const ay = scratch[2 * a + 1] as number;
            const by = scratch[2 * b + 1] as number;
            const dy = scratch[2 * d + 1] as number;
            if (
              !(pointInRect(ax, ay, rect) && pointInRect(bx, by, rect) && pointInRect(dx, dy, rect))
            ) {
              all = false;
            }
            if (!any && triangleTouchesRect(ax, ay, bx, by, dx, dy, rect)) any = true;
          }
          if (!(windowMode ? all : any)) return;
          add({
            bodyId: featureId,
            kind: 'region',
            index: i,
            entity: r.name,
            point: [positions[0] as number, positions[1] as number, positions[2] as number],
            distancePx: 0,
          });
        });
      }
    }
  }

  // ---- occlusion of a world point by the visible bodies
  const img = idFresh(vp) ? vp.idImage : null;
  const flip = vp.backend === 'webgl2';
  const pointVisible = (p: Vec3): boolean => {
    if (isClipped(sectionEq, p, 1e-6)) return false;
    if (!visibleOnly) return true;
    if (img && project(p[0], p[1], p[2], tmp)) {
      // Over background (no surface within a pixel or two): nothing can be in front.
      const px = Math.floor((tmp.x * img.w) / (vp.canvas.clientWidth || 1));
      const py = Math.floor((tmp.y * img.h) / (vp.canvas.clientHeight || 1));
      let covered = false;
      for (let dy = -2; dy <= 2 && !covered; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (idAtPixel(img.data, img.w, img.h, px + dx, py + dy, flip) !== 0) {
            covered = true;
            break;
          }
        }
      }
      if (!covered) return true;
    }
    return isVisiblePoint(vp, origin, p);
  };

  // ---- body vertices and edges
  for (const [id, e] of vp.bodies) {
    if (!e.display.visible) continue;
    if (want('vertex')) {
      const v = vertexPositions(vp, e);
      for (let i = 0; i < v.length / 3; i++) {
        const p: Vec3 = [v[3 * i] as number, v[3 * i + 1] as number, v[3 * i + 2] as number];
        if (!project(p[0], p[1], p[2], tmp) || !pointInRect(tmp.x, tmp.y, rect)) continue;
        if (!pointVisible(p)) continue;
        add({
          bodyId: id,
          kind: 'vertex',
          index: i,
          point: p,
          distancePx: Math.hypot(tmp.x - cx, tmp.y - cy),
        });
      }
    }
    if (want('edge')) {
      const { edgePositions, edgeRanges } = e.buffers;
      const pointCount = edgePositions.length / 3;
      for (let i = 0; i < edgeRanges.length / 2; i++) {
        const first = edgeRanges[2 * i] as number;
        const count = Math.min(edgeRanges[2 * i + 1] as number, pointCount - first);
        if (count < 1) continue;
        projectPoints(edgePositions, first, count);
        const r = polylineVsRect(scratch, count, rect);
        if (!(windowMode ? r.inside : r.touches)) continue;
        // Visible when any of a few points along the edge (never just its endpoints: a hidden
        // edge of a box ends on visible vertices) inside the rectangle is unoccluded.
        const at = (k: number): Vec3 => {
          const g = 3 * (first + k);
          return [
            edgePositions[g] as number,
            edgePositions[g + 1] as number,
            edgePositions[g + 2] as number,
          ];
        };
        const near = nearestIndex(count);
        const samples: Vec3[] = [];
        let total = 0;
        for (let k = 1; k < count; k++) total += Math.hypot(...sub3(at(k), at(k - 1)));
        for (const f of EDGE_SAMPLE_FRACTIONS) {
          let want = f * total;
          for (let k = 1; k < count; k++) {
            const a0 = at(k - 1);
            const seg = sub3(at(k), a0);
            const len = Math.hypot(...seg);
            if (want <= len || k === count - 1) {
              const t = len > 0 ? Math.min(1, want / len) : 0;
              const q: Vec3 = [a0[0] + seg[0] * t, a0[1] + seg[1] * t, a0[2] + seg[2] * t];
              if (project(q[0], q[1], q[2], tmp) && pointInRect(tmp.x, tmp.y, rect))
                samples.push(q);
              break;
            }
            want -= len;
          }
        }
        if (samples.length === 0) samples.push(at(near));
        let visible = false;
        for (const q of samples) {
          if (pointVisible(q)) {
            visible = true;
            break;
          }
        }
        if (!visible) continue;
        add({ bodyId: id, kind: 'edge', index: i, point: at(near), distancePx: dist2c(near) });
      }
    }
  }

  // ---- faces
  if (want('face')) {
    if (visibleOnly && img) rectFacesFromIds(vp, rect, windowMode, img, add);
    else rectFacesGeometric(vp, rect, windowMode, visibleOnly, project, add);
  }

  // Nearest to the camera first (kind priority breaks ties).
  const depth = (h: PickHit) => depthFromEye(vp, h.point);
  return found
    .map((h) => ({ h, d: depth(h) }))
    .sort((a, b) => a.d - b.d || KIND_PRIORITY[a.h.kind] - KIND_PRIORITY[b.h.kind])
    .map((x) => ({ ...x.h, depth: x.d }));
}

/** Per-id pixel totals of the whole ID image (cached per image). */
export function idTotals(
  vp: ViewportImpl,
  img: { data: Uint8Array; w: number; h: number },
  faceTotal: number,
): Uint32Array {
  if (vp.idTotalsCache?.img === img) return vp.idTotalsCache.counts;
  const counts = new Uint32Array(faceTotal + 1);
  const flip = vp.backend === 'webgl2';
  countIdPixels(img.data, img.w, img.h, flip, 0, 0, img.w - 1, img.h - 1, counts);
  vp.idTotalsCache = { img, counts };
  return counts;
}

export function rectFacesFromIds(
  vp: ViewportImpl,
  rect: Rect,
  windowMode: boolean,
  img: { data: Uint8Array; w: number; h: number },
  add: (h: PickHit) => void,
): void {
  const last = vp.idLayout[vp.idLayout.length - 1];
  if (!last) return;
  const faceTotal = last.base + last.faces;
  const sx = img.w / (vp.canvas.clientWidth || 1);
  const sy = img.h / (vp.canvas.clientHeight || 1);
  // A pixel belongs to the rectangle when its centre does.
  const x0 = Math.ceil(rect.x0 * sx - 0.5);
  const x1 = Math.floor(rect.x1 * sx - 0.5);
  const y0 = Math.ceil(rect.y0 * sy - 0.5);
  const y1 = Math.floor(rect.y1 * sy - 0.5);
  const inside = new Uint32Array(faceTotal + 1);
  const firstX = new Int32Array(faceTotal + 1);
  const firstY = new Int32Array(faceTotal + 1);
  const flip = vp.backend === 'webgl2';
  countIdPixels(img.data, img.w, img.h, flip, x0, y0, x1, y1, inside, firstX, firstY);
  const totals = windowMode ? idTotals(vp, img, faceTotal) : null;
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  for (const slot of vp.idLayout) {
    for (let f = 0; f < slot.faces; f++) {
      const id = slot.base + f + 1;
      const n = inside[id] as number;
      if (n === 0) continue;
      if (totals && n !== (totals[id] as number)) continue;
      const px = ((firstX[id] as number) + 0.5) / sx;
      const py = ((firstY[id] as number) + 0.5) / sy;
      const ray = rayAt(vp, px, py);
      let hit = faceHit(vp, slot.id, slot.entry, f, ray);
      if (!hit && slot.entry.bvh) {
        const r = new Ray(
          new Vector3(ray.origin[0], ray.origin[1], ray.origin[2]),
          new Vector3(ray.dir[0], ray.dir[1], ray.dir[2]),
        );
        const bh = slot.entry.bvh.raycastFirst(r, FrontSide);
        if (bh) {
          hit = {
            bodyId: slot.id,
            kind: 'face',
            index: f,
            point: [bh.point.x, bh.point.y, bh.point.z],
            normal: [bh.face?.normal.x ?? 0, bh.face?.normal.y ?? 0, bh.face?.normal.z ?? 0],
            distancePx: 0,
          };
        }
      }
      if (!hit) {
        // A huge face without a BVH: approximate with the body's centre depth on the pixel ray.
        const c = boundsCenter(slot.entry.bounds);
        const t = Math.max(
          0,
          (c[0] - ray.origin[0]) * ray.dir[0] +
            (c[1] - ray.origin[1]) * ray.dir[1] +
            (c[2] - ray.origin[2]) * ray.dir[2],
        );
        hit = {
          bodyId: slot.id,
          kind: 'face',
          index: f,
          point: [
            ray.origin[0] + ray.dir[0] * t,
            ray.origin[1] + ray.dir[1] * t,
            ray.origin[2] + ray.dir[2] * t,
          ],
          distancePx: 0,
        };
      }
      add({ ...hit, distancePx: Math.hypot(px - cx, py - cy) });
    }
  }
}

/**
 * Faces by projected triangles (no ID buffer): `visibleOnly` keeps those a sampled ray grid
 * over the rectangle can see (approximate; await `whenPickReady()` for the exact ID path).
 */
export function rectFacesGeometric(
  vp: ViewportImpl,
  rect: Rect,
  windowMode: boolean,
  visibleOnly: boolean,
  project: ProjectFn,
  add: (h: PickHit) => void,
): void {
  let sampled: Set<string> | null = null;
  if (visibleOnly) {
    sampled = new Set();
    const w = vp.canvas.clientWidth || 1;
    const h = vp.canvas.clientHeight || 1;
    const gx0 = Math.max(0, rect.x0);
    const gy0 = Math.max(0, rect.y0);
    const gx1 = Math.min(w, rect.x1);
    const gy1 = Math.min(h, rect.y1);
    const n = 32;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = gx0 + ((gx1 - gx0) * i) / n;
        const y = gy0 + ((gy1 - gy0) * j) / n;
        const f = pickFace(vp, x, y, rayAt(vp, x, y));
        if (f) sampled.add(`${f.bodyId}|${f.index}`);
      }
    }
  }
  const tmp = { x: 0, y: 0 };
  for (const [id, e] of vp.bodies) {
    if (!e.display.visible) continue;
    const { positions, indices, faceRanges } = e.buffers;
    const nv = positions.length / 3;
    const sp = new Float32Array(nv * 2);
    for (let i = 0; i < nv; i++) {
      const ok = project(
        positions[3 * i] as number,
        positions[3 * i + 1] as number,
        positions[3 * i + 2] as number,
        tmp,
      );
      sp[2 * i] = ok ? tmp.x : Number.NaN;
      sp[2 * i + 1] = ok ? tmp.y : Number.NaN;
    }
    const faces = faceRanges.length / 2;
    for (let f = 0; f < faces; f++) {
      if (sampled && !sampled.has(`${id}|${f}`)) continue;
      const first = faceRanges[2 * f] as number;
      const count = faceRanges[2 * f + 1] as number;
      let all = count > 0;
      let any = false;
      let rep = -1;
      for (let t = first; t < first + count; t++) {
        const a = indices[3 * t] as number;
        const b = indices[3 * t + 1] as number;
        const c = indices[3 * t + 2] as number;
        const ax = sp[2 * a] as number;
        const bx = sp[2 * b] as number;
        const cx = sp[2 * c] as number;
        if (Number.isNaN(ax) || Number.isNaN(bx) || Number.isNaN(cx)) {
          all = false;
          if (windowMode) break;
          continue;
        }
        const ay = sp[2 * a + 1] as number;
        const by = sp[2 * b + 1] as number;
        const cy = sp[2 * c + 1] as number;
        if (
          !(pointInRect(ax, ay, rect) && pointInRect(bx, by, rect) && pointInRect(cx, cy, rect))
        ) {
          all = false;
        }
        if (triangleTouchesRect(ax, ay, bx, by, cx, cy, rect)) {
          any = true;
          if (rep < 0) rep = t;
        }
        if (windowMode ? !all : any) break;
      }
      if (!(windowMode ? all : any)) continue;
      const a = (indices[3 * (rep >= 0 ? rep : first)] as number) * 3;
      add({
        bodyId: id,
        kind: 'face',
        index: f,
        point: [positions[a] as number, positions[a + 1] as number, positions[a + 2] as number],
        distancePx: 0,
      });
    }
  }
}
