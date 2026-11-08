# @whittle/viewport

The 3D viewport: an imperative three.js engine that draws bodies, ghosts, sketches and markers,
and handles the camera, picking and the view cube. The app creates one viewport, on the main thread,
after the shell has painted. The geometry arrives as transferred mesh buffers from the kernel worker.

## Exports

The entry is `src/index.ts`.

| Export | What it is |
| --- | --- |
| `createViewport(canvas, options)` | Creates a `ViewportEngine` (implements `InteractiveViewport` from `@whittle/contracts`) |
| `ViewportEngine`, `ViewportEngineOptions`, `ViewportEventMap`, `CameraState`, `PickStats` | The engine's extended surface: camera state, render count, pick statistics, context-loss events |
| `VIEW_DIRECTIONS`, `cameraPositionFor`, `fitDistance`, `clipPlanes`, `unionBounds`, `gridCellSize` | Camera and view maths, unit-testable without a GPU |
| `meshBuffersToGeometry`, `edgesToSegments` | Converts `MeshBuffers` (from `@whittle/contracts`) into three.js geometry and edge segments |
| `closestOnPolyline`, `defaultTolerance`, `distPointSegment2D` | Screen-space picking helpers for edges and vertices |
| `lookAtPlanePose`, `rayToPlane`, `PlaneFrame` | Plane helpers used by sketch-on-face |
| `entityColor` | The sketch colour for a DOF state (`free`, `partial`, `fixed`) or a conflict |

The options are `ViewportOptions` in `packages/contracts/src/viewport.ts`: `backend` (`'auto'`, `'webgpu'`
or `'webgl2'`), `maxPixelRatio`, `theme`, `reducedMotion` and `viewCube`.

## Design points

- **Renderer.** `WebGPURenderer` from three.js, with automatic WebGL2 fallback. `backend: 'auto'` tries
  WebGPU first. CI forces `webgl2` for deterministic screenshots. The backend in use is reported in
  the runtime diagnostics.
- **On-demand rendering.** A frame is drawn only when something changed: a camera move, a pointer
  down, new geometry, or a sketch overlay update. `getRenderCount()` lets tests assert this.
- **Camera.** `camera-controls`. Left drag orbits, right and middle drag pan, the wheel zooms toward
  the cursor. Touch: one finger orbits, two fingers pinch and pan. Double-click or double-tap fits the
  view. Touch orbit ticks the render loop while a pointer is down, because camera-controls only applies
  drag deltas inside `update()` (ADR-005 §8).
- **Studio light.** The first frame uses a hemisphere fill light. The procedural studio environment is
  built on idle after the first body frame, because its shader passes cost about 1.6 s on software GL
  (ADR-005 §4).
- **Edges.** Fat lines (`LineSegments2`), so edges have a constant width on screen.
- **Picking.** Face picks come from a GPU ID buffer at half the canvas resolution, read back
  asynchronously. The buffer is refreshed when the camera or scene changes. When it isn't ready, the
  engine uses a `three-mesh-bvh` raycast. Faces with more than 20 000 triangles always use the BVH
  instead of a brute-force test. `whenPickReady()` resolves when the buffer matches the current view.
  Edges and vertices are chosen by screen-space distance. The default tolerance is 6 CSS px
  (`defaultTolerance`), and callers pass a larger value for touch and pen.
- **Ghosts and markers.** `setGhost` draws a translucent proxy, for the last good geometry of a
  failing feature, or for the old place of a reference that needs attention.
- **Sketch overlays.** Each sketch is drawn as curves, points and filled regions, coloured by the DOF
  state. Overlays follow the camera adaptively: every frame while the camera moves, and a 200 ms check
  otherwise (ADR-007 §6).
- **View cube.** An orthographic SVG cube in the top-right corner. Click a face, edge or corner to
  animate to that standard view. Hit testing is plain maths, so it is unit-tested. Turn it off with
  `viewCube: false`.
- **Context loss.** A lost GPU context emits `contextlost` with a reason. When it comes back, the engine
  emits `contextrestored`. Hosts subscribe with `on(type, callback)`.
- **Reduced motion.** `reducedMotion: true` disables camera animation and damping.

## Tests and scripts

| Command | What it does |
| --- | --- |
| `pnpm --filter @whittle/viewport test` | `vitest run` over `test/` (views, the view cube, geometry and picking maths) |
| `pnpm --filter @whittle/viewport typecheck` | `tsc -p .` |
| `pnpm --filter @whittle/viewport harness` | A Vite page that mounts the engine with test meshes, for manual work |
| `pnpm --filter @whittle/viewport e2e` | Playwright tests in `e2e/` (`viewport.spec.ts`, `picking.spec.ts`): orbit, zoom, fit, pinch, picking tolerances, sketch overlays |
| `pnpm --filter @whittle/viewport perf` | Opt-in probes that set `WHITTLE_PERF=1`: a 1-million-triangle model orbiting, and picking on the same model. Expect minutes on software GL. They log numbers and assert only that they ran. |

The E2E tests run in CI's package-E2E job (Chromium, software GL). Fixtures come from
[`@whittle/test-fixtures`](../test-fixtures).

## Dependencies

- `three` 0.187.0 (MIT): the renderer, the WebGPU and WebGL2 backends, the addons (line and environment).
- `camera-controls` 3.1.2 (MIT): orbit, pan and zoom.
- `three-mesh-bvh` 0.9.18 (MIT): fallback face picking.

See [`docs/DEPENDENCIES.md`](../../docs/DEPENDENCIES.md) for licences and sizes.

## Related

- [`packages/contracts/src/viewport.ts`](../contracts/src/viewport.ts): the `Viewport` contract.
- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md), section 6: the viewport in context.
- ADR-005 (lazy viewport, first-frame environment, touch orbit) and ADR-007 (picking rolls back to the input):
  [`docs/DECISIONS.md`](../../docs/DECISIONS.md).
