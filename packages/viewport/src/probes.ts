import type { ViewportStats } from '@wren-cad/contracts';
import { Vector3 } from 'three/webgpu';
import { compareBounds } from './compare';
import type { BodyMaterialState, CameraState, CompareStats, PickStats, TouchStats } from './types';
import type { ViewportImpl } from './viewport';

export function stats(vp: ViewportImpl): ViewportStats {
  let triangles = 0;
  for (const e of vp.bodies.values()) if (e.display.visible) triangles += e.triangles;
  const n = vp.frameTimes.length;
  const frameMs = n === 0 ? 0 : vp.frameTimes.reduce((a, b) => a + b, 0) / n;
  return { backend: vp.backend, frameMs, triangles, drawCalls: vp.lastDrawCalls };
}

export function getRenderCount(vp: ViewportImpl): number {
  return vp.renderCount;
}

export function isCameraMoving(vp: ViewportImpl): boolean {
  // `controls.active` only clears on a "rest" frame, which never comes when smoothing is off
  // (reduced motion): the 'sleep' event is the reliable end of a transition.
  return (
    vp.interacting ||
    vp.motionState.integ.active ||
    (vp.wheel !== null && !vp.wheel.settled) ||
    (vp.controls.active && vp.cameraAwake)
  );
}

export function getPickStats(vp: ViewportImpl): PickStats {
  return { ...vp.pickStats };
}

export function getCameraState(vp: ViewportImpl): CameraState {
  const p = vp.controls.getPosition(new Vector3());
  const t = vp.controls.getTarget(new Vector3());
  return {
    position: [p.x, p.y, p.z],
    target: [t.x, t.y, t.z],
    distance: p.distanceTo(t),
  };
}

export function getCompareStats(vp: ViewportImpl): CompareStats {
  const c = vp.compare;
  return {
    active: c !== null,
    show: c?.overlay.show ?? 'both',
    addedMeshes: c?.overlay.added.length ?? 0,
    removedMeshes: c?.overlay.removed.length ?? 0,
    ghostOpacity: c ? c.ghost : null,
    geometryBuilds: vp.compareBuilds,
    bounds: c ? compareBounds(c.overlay) : null,
  };
}

export function getBodyMaterialState(vp: ViewportImpl, id: string): BodyMaterialState | null {
  const e = vp.bodies.get(id);
  if (!e) return null;
  return {
    opacity: e.material.opacity,
    transparent: e.material.transparent,
    depthWrite: e.material.depthWrite,
    color: `#${e.material.color.getHexString()}`,
  };
}

export function getTouchStats(vp: ViewportImpl): TouchStats {
  let capsDrawn = 0;
  let capColor: string | null = null;
  for (const e of vp.bodies.values()) {
    if (!e.cap?.quad.visible) continue;
    capsDrawn++;
    capColor ??= `#${e.cap.quadMat.color.getHexString()}`;
  }
  return {
    ...vp.touchStats,
    sectionNormal: vp.section ? [...vp.section.eq.n] : null,
    sectionOffset: vp.section ? vp.section.eq.offset : null,
    capsDrawn,
    capColor,
  };
}
