import { MathUtils, PerspectiveCamera } from 'three/webgpu';

/**
 * The viewport's single camera (ADR-098). It is a `PerspectiveCamera` as far as camera-controls and
 * the rest of the viewport are concerned (position, target distance, dolly and truck all keep their
 * perspective meaning); in orthographic mode only the projection matrix differs. The view height is
 * the height the perspective camera would show at the *target*: `2 * focusDistance * tan(fov / 2)`.
 *
 * That choice makes the two modes agree on everything that matters:
 *  - switching projection keeps the target and the apparent size of whatever is at the target, so
 *    nothing jumps;
 *  - zooming by scaling the camera position about an anchor (the wheel, pinch, 3D mouse) scales the
 *    view height by the same factor, so the anchor stays under the cursor with no ortho-specific
 *    zoom code;
 *  - a pan of `wpp` world units per pixel is `2 * halfHeight / height` in both.
 *
 * Near and far are set by `syncProjection` from the scene bounds (ortho depth is linear and the
 * camera may sit anywhere along the view axis, so near can be negative).
 */
export class ViewCamera extends PerspectiveCamera {
  /** True: parallel projection. */
  orthographic = false;
  /** Camera-to-target distance, kept current by `syncProjection` (ortho view height). */
  focusDistance = 1;

  override updateProjectionMatrix(): void {
    if (!this.orthographic) {
      super.updateProjectionMatrix();
      return;
    }
    const halfH =
      (Math.max(this.focusDistance, 1e-9) * Math.tan(MathUtils.DEG2RAD * 0.5 * this.fov)) /
      this.zoom;
    const halfW = halfH * this.aspect;
    this.projectionMatrix.makeOrthographic(
      -halfW,
      halfW,
      halfH,
      -halfH,
      this.near,
      this.far,
      this.coordinateSystem,
      this.reversedDepth,
    );
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }
}
