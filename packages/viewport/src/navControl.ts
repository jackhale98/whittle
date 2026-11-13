import type { NavigationOptions, PickHit, Vec3 } from '@wren-cad/contracts';
import { Group, Vector3 } from 'three/webgpu';
import { bodyBoundsList } from './bodies';
import { resetRoll } from './camera';
import {
  PIVOT_DOT_PX,
  PIVOT_FLASH_MS,
  PIVOT_RING_PX,
  ROTATE_SPEED_MAX,
  ROTATE_SPEED_MIN,
} from './constants';
import { emitGesture } from './input';
import { cross3, NAV_SYNC_BVH_TRIANGLES } from './internal';
import {
  type NavOutput,
  orbitTrackball,
  orbitTurntable,
  orthonormalize,
  type PivotSource,
  type Pose,
  resolvePivot,
} from './navigation';
import { type Dot, disposeOverlay, makeDot } from './overlays';
import { enablePicking, idFresh, pickFace, rayAt, syncCameraMatrices } from './picking';
import { cameraWorldPerPixel, setProjection } from './projection';
import { requestRender } from './renderLoop';
import type { NavigationState } from './types';
import type { ViewportImpl } from './viewport';
import { boundsCenter } from './views';
import { stepWheel } from './wheel';

export function setNavigation(vp: ViewportImpl, options: Partial<NavigationOptions>): void {
  const prev = vp.navigation;
  const next: NavigationOptions = { ...prev, ...options };
  const speed = Number.isFinite(next.rotateSpeed) ? next.rotateSpeed : 1;
  next.rotateSpeed = Math.min(ROTATE_SPEED_MAX, Math.max(ROTATE_SPEED_MIN, speed));
  vp.navigation = next;
  vp.navMachine.setPreset(next.preset);
  vp.controls.dollySpeed = next.invertZoom ? -1 : 1;
  if (next.preset !== prev.preset) vp.pivotOverride = null;
  if (next.projection !== prev.projection) {
    // ADR-098: same pose and target, so the view keeps its size at the target.
    setProjection(vp, next.projection !== 'perspective');
    requestRender(vp);
  }
  if (!next.showPivot) hidePivotMarker(vp);
  if (next.orbit === 'turntable' && prev.orbit !== 'turntable') {
    // Back to a level camera. Keep the view (position and target) and only change "up".
    const pos = vp.controls.getPosition(new Vector3());
    const tgt = vp.controls.getTarget(new Vector3());
    if (resetRoll(vp)) {
      void vp.controls.setLookAt(pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, false);
      vp.controls.update(0);
      requestRender(vp);
    }
  }
}

export function getNavigation(vp: ViewportImpl): NavigationOptions {
  return { ...vp.navigation };
}

export function getNavigationState(vp: ViewportImpl): NavigationState {
  const p = vp.nav?.pivot ?? vp.lastPivot?.point ?? null;
  const s = p ? vp.worldToScreen(p) : null;
  return {
    dragging: vp.nav?.mode ?? null,
    pivot: p ? [p[0], p[1], p[2]] : null,
    pivotSource: vp.lastPivot?.source ?? null,
    markerVisible: vp.pivotMarker?.group.visible === true,
    motionActive: vp.motionState.integ.active,
    motionFrames: vp.motionState.frames,
    motionApplyMs: vp.motionState.applyMs,
    pivotScreen: s ? { x: s.x, y: s.y } : null,
    lastPivotMs: vp.lastPivotMs,
  };
}

/** Current (displayed) camera pose from the controls, and the orbit distance. */
export function readPose(vp: ViewportImpl): { pose: Pose; dist: number } {
  const p = vp.controls.getPosition(new Vector3(), false);
  const t = vp.controls.getTarget(new Vector3(), false);
  const f = t.clone().sub(p);
  let dist = f.length();
  if (dist < 1e-9) {
    dist = Math.max(vp.sceneRadius, 1);
    vp.camera.getWorldDirection(f);
  }
  f.normalize();
  const u = vp.camera.up;
  return {
    pose: orthonormalize({ pos: [p.x, p.y, p.z], fwd: [f.x, f.y, f.z], up: [u.x, u.y, u.z] }),
    dist,
  };
}

/** Move the camera to `pose` at once (no smoothing: a drag follows the pointer 1:1). */
export function writePose(vp: ViewportImpl, pose: Pose, dist: number, setUp: boolean): void {
  if (setUp) {
    vp.camera.up.set(pose.up[0], pose.up[1], pose.up[2]);
    vp.controls.updateCameraUp();
  }
  const [px, py, pz] = pose.pos;
  vp.cameraAwake = true;
  void vp.controls.setLookAt(
    px,
    py,
    pz,
    px + pose.fwd[0] * dist,
    py + pose.fwd[1] * dist,
    pz + pose.fwd[2] * dist,
    false,
  );
  requestRender(vp);
}

/** Surface point under (x, y) for navigation: ID buffer when current, BVH when cheap, else null. */
export function navSurfaceHit(
  vp: ViewportImpl,
  x: number,
  y: number,
  maxSyncBvhTriangles = NAV_SYNC_BVH_TRIANGLES,
): PickHit | null {
  let tris = 0;
  let unbuilt = false;
  for (const e of vp.bodies.values()) {
    if (!e.display.visible) continue;
    tris += e.triangles;
    if (!e.bvh) unbuilt = true;
  }
  if (tris === 0) return null;
  enablePicking(vp);
  // Never stall an orbit start on a multi-hundred-ms BVH build: fall back to the centre.
  if (!idFresh(vp) && unbuilt && tris > maxSyncBvhTriangles) return null;
  return pickFace(vp, x, y, rayAt(vp, x, y));
}

export function resolveNavPivot(
  vp: ViewportImpl,
  x: number,
  y: number,
): { point: Vec3; source: PivotSource } {
  syncCameraMatrices(vp);
  const { pose, dist } = readPose(vp);
  const ortho = vp.camera.orthographic;
  const v = new Vector3();
  const project = (p: Vec3) => {
    v.set(p[0], p[1], p[2]).applyMatrix4(vp.camera.matrixWorldInverse);
    const depth = -v.z;
    // Orthographic: a point behind the camera plane is still drawn (the near plane is behind the
    // camera), so only depth outside the clip range is "not in front".
    const front = ortho ? depth >= vp.camera.near && depth <= vp.camera.far : depth > 0;
    if (!front) return { nx: 0, ny: 0, depth, front };
    v.applyMatrix4(vp.camera.projectionMatrix);
    return { nx: v.x, ny: v.y, depth, front };
  };
  const anyVisible = bodyBoundsList(vp).length > 0;
  const center = anyVisible ? boundsCenter(vp.sceneBounds) : null;
  const hit = vp.navigation.pivot === 'cursor' ? navSurfaceHit(vp, x, y) : null;
  const w = vp.canvas.clientWidth || 1;
  const h = vp.canvas.clientHeight || 1;
  return resolvePivot({
    mode: vp.navigation.pivot,
    hit: hit ? hit.point : null,
    override: vp.pivotOverride,
    center,
    centerHit: () => navSurfaceHit(vp, w / 2, h / 2)?.point ?? null,
    project,
    cameraPosition: pose.pos,
    forward: pose.fwd,
    fallbackDistance: dist,
  });
}

export function beginNav(vp: ViewportImpl, o: Extract<NavOutput, { type: 'begin' }>): void {
  if (o.pointerType === 'touch' && vp.recognizer.palmRejected(performance.now())) {
    dispatchNav(vp, vp.navMachine.abort());
    return;
  }
  // A drag starting mid-zoom lands the zoom first, so no wheel steps are lost.
  if (vp.wheel && !vp.wheel.settled) {
    vp.wheel.current = vp.wheel.goal;
    stepWheel(vp, 0, true);
    vp.controls.update(0);
  }
  const t0 = performance.now();
  const r = resolveNavPivot(vp, o.x, o.y);
  vp.lastPivotMs = performance.now() - t0;
  const { pose, dist } = readPose(vp);
  let wpp = 0;
  if (o.mode === 'pan') {
    const d =
      (r.point[0] - pose.pos[0]) * pose.fwd[0] +
      (r.point[1] - pose.pos[1]) * pose.fwd[1] +
      (r.point[2] - pose.pos[2]) * pose.fwd[2];
    wpp = cameraWorldPerPixel(vp, d);
  }
  vp.nav = { mode: o.mode, pivot: r.point, source: r.source, dist, wpp };
  vp.lastPivot = r;
  vp.interacting = true;
  clearTimeout(vp.pivotFlashTimer);
  if (o.mode === 'orbit' && vp.navigation.showPivot) showPivotMarker(vp, r.point);
  requestRender(vp);
}

export function dragNav(vp: ViewportImpl, mode: 'orbit' | 'pan', dx: number, dy: number): void {
  const n = vp.nav;
  if (!n || n.mode !== mode) return;
  const { pose } = readPose(vp);
  if (mode === 'pan') {
    const right = cross3(pose.fwd, pose.up);
    const s = n.wpp;
    const m: Vec3 = [
      (-right[0] * dx + pose.up[0] * dy) * s,
      (-right[1] * dx + pose.up[1] * dy) * s,
      (-right[2] * dx + pose.up[2] * dy) * s,
    ];
    vp.pivotOverride = null; // the view moved: a remembered pivot no longer means "here"
    writePose(
      vp,
      { ...pose, pos: [pose.pos[0] + m[0], pose.pos[1] + m[1], pose.pos[2] + m[2]] },
      n.dist,
      false,
    );
    return;
  }
  const k = ((2 * Math.PI) / Math.max(vp.canvas.clientHeight, 1)) * vp.navigation.rotateSpeed;
  if (vp.navigation.orbit === 'trackball') {
    writePose(vp, orbitTrackball(pose, n.pivot, dx, dy, k), n.dist, true);
  } else {
    const u = vp.camera.up;
    writePose(vp, orbitTurntable(pose, n.pivot, [u.x, u.y, u.z], dx, dy, k), n.dist, false);
  }
}

export function endNav(vp: ViewportImpl): void {
  if (!vp.nav) return;
  vp.nav = null;
  vp.interacting = false;
  hidePivotMarker(vp);
  requestRender(vp);
}

/** Apply the state machine's outputs. */
export function dispatchNav(vp: ViewportImpl, outputs: NavOutput[]): void {
  for (const o of outputs) {
    switch (o.type) {
      case 'begin':
        beginNav(vp, o);
        break;
      case 'drag':
        dragNav(vp, o.mode, o.dx, o.dy);
        break;
      case 'end':
        endNav(vp);
        break;
      case 'click':
        if (o.kind === 'contextMenu') {
          emitGesture(vp, {
            kind: 'contextMenu',
            x: o.x,
            y: o.y,
            pointerType: 'mouse',
            ...(o.repeat ? { repeat: true } : {}),
          });
        } else {
          clickSetPivot(vp, o.x, o.y);
        }
        break;
    }
  }
}

/** Middle click under `middleOrbit`: on geometry it becomes the pivot of the next miss-orbit. */
export function clickSetPivot(vp: ViewportImpl, x: number, y: number): void {
  const hit = navSurfaceHit(vp, x, y);
  if (!hit) return;
  vp.pivotOverride = [hit.point[0], hit.point[1], hit.point[2]];
  vp.lastPivot = { point: vp.pivotOverride, source: 'surface' };
  if (vp.navigation.showPivot) {
    showPivotMarker(vp, vp.pivotOverride);
    clearTimeout(vp.pivotFlashTimer);
    vp.pivotFlashTimer = window.setTimeout(() => {
      if (!vp.nav) hidePivotMarker(vp);
    }, PIVOT_FLASH_MS);
  }
  emitGesture(vp, { kind: 'setPivot', x, y, pointerType: 'mouse' });
}

// ---- pivot marker (ring + dot, theme tokens, constant pixel size)
export function buildPivotMarker(vp: ViewportImpl): void {
  const visible = vp.pivotMarker?.group.visible === true;
  const at = vp.pivotMarker?.dots[0]?.sprite.position;
  if (vp.pivotMarker) {
    vp.scene.remove(vp.pivotMarker.group);
    disposeOverlay(vp.pivotMarker.group);
  }
  const group = new Group();
  // Ring: accent outline around a halo in the viewport background (legible on both themes);
  // dot: accent core with a background outline.
  const ring = makeDot(PIVOT_RING_PX, vp.palette.background, vp.ui.accent, 46, [0, 0, 0]);
  const dot = makeDot(PIVOT_DOT_PX, vp.ui.accent, vp.palette.background, 47, [0, 0, 0]);
  if (at) for (const d of [ring, dot]) d.sprite.position.copy(at);
  group.add(ring.sprite, dot.sprite);
  group.visible = visible;
  vp.scene.add(group);
  vp.pivotMarker = { group, dots: [ring, dot] };
}

export function showPivotMarker(vp: ViewportImpl, p: Vec3): void {
  if (!vp.pivotMarker) buildPivotMarker(vp);
  const m = vp.pivotMarker as { group: Group; dots: Dot[] };
  for (const d of m.dots) d.sprite.position.set(p[0], p[1], p[2]);
  m.group.visible = true;
  requestRender(vp);
}

export function hidePivotMarker(vp: ViewportImpl): void {
  clearTimeout(vp.pivotFlashTimer);
  if (!vp.pivotMarker?.group.visible) return;
  vp.pivotMarker.group.visible = false;
  requestRender(vp);
}
