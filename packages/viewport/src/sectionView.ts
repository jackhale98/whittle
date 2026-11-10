import type { SectionPlane } from '@wren-cad/contracts';
import {
  AlwaysStencilFunc,
  BackSide,
  DecrementWrapStencilOp,
  DoubleSide,
  FrontSide,
  IncrementWrapStencilOp,
  Mesh,
  MeshBasicNodeMaterial,
  NotEqualStencilFunc,
  PlaneGeometry,
  Quaternion,
  ReplaceStencilOp,
  type StencilOp,
  Vector3,
} from 'three/webgpu';
import { drawnOpacity, effectiveBodyColor } from './bodies';
import type { BodyEntry } from './internal';
import { requestRender } from './renderLoop';
import { sectionEq, threePlane } from './section';
import { mixHex } from './sketchStyle';
import type { ViewportImpl } from './viewport';
import { boundsCenter } from './views';

export function setSection(vp: ViewportImpl, section: SectionPlane | null): void {
  if (vp.disposed) return;
  const eq = section ? sectionEq(section) : null;
  if (!section || !eq) {
    vp.section = null;
    vp.bodyRoot.enabled = false;
    vp.idRoot.enabled = false;
    for (const e of vp.bodies.values()) applyCapState(vp, e);
  } else {
    const tp = threePlane(eq);
    vp.sectionPlane.normal.set(tp.normal[0], tp.normal[1], tp.normal[2]);
    vp.sectionPlane.constant = tp.constant;
    vp.section = { eq, caps: section.caps !== false };
    vp.bodyRoot.enabled = true;
    vp.idRoot.enabled = true;
    for (const e of vp.bodies.values()) {
      if (vp.section.caps) ensureCap(vp, e);
      applyCapState(vp, e);
    }
    placeCaps(vp);
  }
  vp.touchStats.sectionActive = vp.section !== null;
  vp.viewVersion++;
  requestRender(vp);
}

export function ensureCap(vp: ViewportImpl, e: BodyEntry): void {
  if (e.cap) return;
  const stencil = (m: MeshBasicNodeMaterial, op: StencilOp) => {
    m.colorWrite = false;
    m.depthWrite = false;
    m.depthTest = false;
    m.stencilWrite = true;
    m.stencilFunc = AlwaysStencilFunc;
    m.stencilFail = op;
    m.stencilZFail = op;
    m.stencilZPass = op;
  };
  // Count back faces up and front faces down (clipped geometry only): non-zero = inside solid.
  const backMat = new MeshBasicNodeMaterial({ side: BackSide });
  stencil(backMat, IncrementWrapStencilOp);
  const frontMat = new MeshBasicNodeMaterial({ side: FrontSide });
  stencil(frontMat, DecrementWrapStencilOp);
  // The cap: a plane quad drawn where the count is non-zero; it also resets the count to 0.
  const quadMat = new MeshBasicNodeMaterial({ side: DoubleSide });
  quadMat.stencilWrite = true;
  quadMat.stencilRef = 0;
  quadMat.stencilFunc = NotEqualStencilFunc;
  quadMat.stencilFail = ReplaceStencilOp;
  quadMat.stencilZFail = ReplaceStencilOp;
  quadMat.stencilZPass = ReplaceStencilOp;
  const base = 1000 + 3 * vp.capCounter++;
  const back = new Mesh(e.geometry, backMat);
  const front = new Mesh(e.geometry, frontMat);
  const quad = new Mesh(new PlaneGeometry(1, 1), quadMat);
  for (const [m, order] of [
    [back, base],
    [front, base + 1],
    [quad, base + 2],
  ] as const) {
    m.frustumCulled = false;
    m.renderOrder = order;
  }
  e.group.add(back, front); // inside the clipping group: only the kept half is counted
  vp.scene.add(quad); // outside it: the cap lies exactly on the plane
  e.cap = { back, front, quad, backMat, frontMat, quadMat };
}

export function applyCapState(vp: ViewportImpl, e: BodyEntry): void {
  const cap = e.cap;
  if (!cap) return;
  const on = vp.section?.caps === true && e.display.visible && drawnOpacity(vp, e) >= 1;
  cap.back.visible = on;
  cap.front.visible = on;
  cap.quad.visible = on;
  if (on) cap.quadMat.color.set(mixHex(effectiveBodyColor(vp, e), '#000000', 0.2));
}

export function placeCaps(vp: ViewportImpl): void {
  const sec = vp.section;
  if (!sec) return;
  const c = boundsCenter(vp.sceneBounds);
  const n = sec.eq.n;
  const d = n[0] * c[0] + n[1] * c[1] + n[2] * c[2] - sec.eq.offset;
  const q = new Quaternion().setFromUnitVectors(
    new Vector3(0, 0, 1),
    new Vector3(n[0], n[1], n[2]),
  );
  const size = Math.max(vp.sceneRadius * 2.6, 1);
  for (const e of vp.bodies.values()) {
    if (!e.cap) continue;
    e.cap.quad.position.set(c[0] - n[0] * d, c[1] - n[1] * d, c[2] - n[2] * d);
    e.cap.quad.quaternion.copy(q);
    e.cap.quad.scale.set(size, size, 1);
  }
}

export function disposeCap(vp: ViewportImpl, e: BodyEntry): void {
  const cap = e.cap;
  if (!cap) return;
  e.group.remove(cap.back, cap.front);
  vp.scene.remove(cap.quad);
  cap.quad.geometry.dispose();
  cap.backMat.dispose();
  cap.frontMat.dispose();
  cap.quadMat.dispose();
  e.cap = null;
}
