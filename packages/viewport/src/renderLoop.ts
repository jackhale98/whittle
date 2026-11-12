import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { BufferAttribute, BufferGeometry, Mesh, Scene } from 'three/webgpu';
import { depthOf } from './adornments';
import { createBodyMaterial } from './bodies';
import { emitCamera } from './camera';
import { REST_WORK_DEBOUNCE_MS } from './constants';
import { worldPerPixel } from './handles';
import { stepMotion } from './motion/nav';
import {
  disposeOverlay,
  makeDot,
  makeFill,
  makeLines,
  overlayBiasFor,
  overlayDepthBias,
  sizeDots,
} from './overlays';
import { idFresh, kickIdRefresh } from './picking';
import type { ViewportImpl } from './viewport';
import { clipPlanes } from './views';
import { stepWheel } from './wheel';

export function resize(vp: ViewportImpl): void {
  if (vp.disposed) return;
  const w = vp.canvas.clientWidth;
  const h = vp.canvas.clientHeight;
  if (w === 0 || h === 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, vp.maxPixelRatio);
  vp.renderer.setPixelRatio(dpr);
  vp.renderer.setSize(w, h, false);
  vp.camera.aspect = w / h;
  vp.camera.updateProjectionMatrix();
  vp.cube?.place(vp.canvas, vp.frameInsets);
  vp.viewVersion++;
  requestRender(vp);
}

export function nextFrame(vp: ViewportImpl): Promise<void> {
  if (vp.disposed) return Promise.resolve();
  return new Promise((resolve) => {
    vp.waiters.push(resolve);
    requestRender(vp);
  });
}

export function attachContextHandlers(vp: ViewportImpl): void {
  const lost = (ev: Event) => {
    ev.preventDefault(); // lets the browser restore the context
    vp.emit('contextlost', { reason: 'webglcontextlost' });
  };
  const restored = () => {
    // Resources are re-created lazily by the renderer; force a full redraw and re-pick.
    vp.viewVersion++;
    vp.idImage = null;
    vp.emit('contextrestored', {});
    requestRender(vp);
  };
  vp.canvas.addEventListener('webglcontextlost', lost);
  vp.canvas.addEventListener('webglcontextrestored', restored);
  vp.cleanup.push(() => {
    vp.canvas.removeEventListener('webglcontextlost', lost);
    vp.canvas.removeEventListener('webglcontextrestored', restored);
  });
  const device = (
    vp.renderer.backend as {
      device?: { lost?: Promise<{ message?: string; reason?: string }> };
    }
  ).device;
  void device?.lost?.then((info) => {
    if (!vp.disposed) {
      vp.emit('contextlost', {
        reason: `webgpu device lost: ${info.reason ?? info.message ?? ''}`,
      });
    }
  });
}

/**
 * Compiles the shader variants every first frame needs (body, edges, overlays) on an idle frame
 * after creation, so the first `setBody` does not stall on program compilation (PLAN §10).
 */
export function scheduleWarmup(vp: ViewportImpl): void {
  const run = async () => {
    if (vp.disposed) return;
    const t0 = performance.now();
    const warm = new Scene();
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    geometry.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
    );
    geometry.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));
    const material = createBodyMaterial(vp, vp.palette.body);
    const body = new Mesh(geometry, material);
    body.frustumCulled = false;
    const edgeGeometry = new LineSegmentsGeometry();
    edgeGeometry.setPositions(new Float32Array([0, 0, 0, 1, 0, 0]));
    const edges = new LineSegments2(edgeGeometry, vp.edgeMaterial);
    edges.frustumCulled = false;
    const fill = makeFill(geometry, vp.ui.accent, 0.3, false, 5);
    const lines = makeLines(new Float32Array([0, 0, 0, 1, 1, 0]), {
      color: vp.ui.accent,
      width: 2,
      onTop: false,
      renderOrder: 5,
    });
    const dot = makeDot(8, vp.ui.accent, vp.palette.background, 5, [0, 0, 0]);
    warm.add(body, edges, fill, lines, dot.sprite);
    try {
      await vp.renderer.compileAsync(warm, vp.camera, vp.scene);
    } catch {
      // warm-up is best effort
    }
    geometry.dispose();
    edgeGeometry.dispose();
    material.dispose();
    for (const o of [fill, lines]) disposeOverlay(o, true);
    disposeOverlay(dot.sprite);
    vp.touchStats.warmMs = performance.now() - t0;
  };
  const ric = (
    globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
  ).requestIdleCallback;
  const kick = () => void run();
  if (ric) ric(kick, { timeout: 300 });
  else setTimeout(kick, 0);
}

export function requestRender(vp: ViewportImpl): void {
  vp.dirty = true;
  schedule(vp);
}

export function schedule(vp: ViewportImpl): void {
  if (vp.raf || vp.disposed) return;
  vp.raf = requestAnimationFrame((t) => frame(vp, t));
}

export function frame(vp: ViewportImpl, now: number): void {
  vp.raf = 0;
  if (vp.disposed) return;
  const dt = vp.lastFrameTime === 0 ? 1 / 60 : Math.min((now - vp.lastFrameTime) / 1000, 0.1);
  vp.lastFrameTime = now;

  const wheeling = stepWheel(vp, dt);
  const motioning = stepMotion(vp);
  const moving = vp.controls.update(dt) || wheeling || motioning;
  if (moving) vp.lastActivityAt = performance.now();
  if (moving || vp.dirty) {
    vp.dirty = false;
    renderOnce(vp);
    if (vp.previewDirty) {
      vp.previewDirty = false;
      vp.touchStats.lastPreviewPresentedAt = vp.renderCount;
    }
    const waiters = vp.waiters;
    vp.waiters = [];
    for (const w of waiters) w();
  }
  emitCamera(vp);
  // While a pointer is down the loop must keep ticking even if nothing moved this frame:
  // camera-controls only applies pointer deltas inside update() (`_dragNeedsUpdate`), and it
  // emits no event on pointermove, so an idle loop would swallow touch drags.
  if (moving || vp.interacting) {
    schedule(vp);
  } else {
    // Idle: stop the loop; the next frame's dt must not include the idle gap.
    vp.lastFrameTime = 0;
    // Settled: refresh the face ID buffer if picking is in use and the view changed, once the
    // camera has been still for a moment (never between two wheel notches).
    scheduleRestWork(vp);
  }
}

/**
 * ID refresh (an extra render of the scene plus a readback) and BVH prebuild are rest work: they
 * wait for `REST_WORK_DEBOUNCE_MS` of stillness, except when someone awaits `whenPickReady()`.
 */
export function scheduleRestWork(vp: ViewportImpl): void {
  clearTimeout(vp.restTimer);
  vp.restTimer = 0;
  if (vp.pickWaiters.length > 0) {
    kickIdRefresh(vp);
    return;
  }
  if (!vp.pickingEnabled || vp.idBusy || idFresh(vp)) return;
  vp.restTimer = window.setTimeout(() => {
    vp.restTimer = 0;
    if (vp.disposed || vp.raf || vp.isCameraMoving()) return; // the frame loop reschedules
    kickIdRefresh(vp);
  }, REST_WORK_DEBOUNCE_MS);
}

export function renderOnce(vp: ViewportImpl): void {
  const { near, far } = clipPlanes(vp.controls.distance, vp.sceneRadius);
  if (near !== vp.camera.near || far !== vp.camera.far) {
    vp.camera.near = near;
    vp.camera.far = far;
    vp.camera.updateProjectionMatrix();
  }
  overlayDepthBias.value = overlayBiasFor();
  const p11 = vp.camera.projectionMatrix.elements[5] as number;
  const heightCss = vp.canvas.clientHeight;
  sizeDots(
    [
      ...vp.highlightDots,
      ...[...vp.sketches.values()].flatMap((s) => s.dots),
      ...[...vp.markerSets.values()].flatMap((m) => m.dots),
      ...(vp.pivotMarker ? vp.pivotMarker.dots : []),
    ],
    p11,
    heightCss,
  );
  vp.references.size(p11, heightCss);
  for (const h of vp.handles.values()) {
    h.place(worldPerPixel(depthOf(vp, h.origin), p11, heightCss));
  }
  const t0 = performance.now();
  vp.renderer.render(vp.scene, vp.camera);
  const dt = performance.now() - t0;
  vp.renderCount++;
  vp.frameTimes.push(dt);
  if (vp.frameTimes.length > 60) vp.frameTimes.shift();
  vp.lastDrawCalls = vp.renderer.info.render.drawCalls;

  // Camera changes invalidate the ID image; the view cube follows the camera orientation.
  const m = vp.camera.matrixWorld.elements;
  const key = [
    ...m,
    vp.camera.projectionMatrix.elements[0] as number,
    vp.camera.projectionMatrix.elements[5] as number,
  ];
  if (key.length !== vp.cameraKey.length || key.some((v, i) => v !== vp.cameraKey[i])) {
    vp.cameraKey = key;
    vp.cameraChangedSinceEmit = true;
    vp.viewVersion++;
    vp.cube?.update({
      right: [m[0] as number, m[1] as number, m[2] as number],
      up: [m[4] as number, m[5] as number, m[6] as number],
      back: [m[8] as number, m[9] as number, m[10] as number],
    });
  }
}
