# @wren-cad/viewport

The 3D viewport: an imperative three.js engine that draws bodies, ghosts, sketches and markers,
and handles the camera, picking and the view cube. The app creates one viewport, on the main thread,
after the shell has painted. The geometry arrives as transferred mesh buffers from the kernel worker.

## Exports

The entry is `src/index.ts`.

| Export | What it is |
| --- | --- |
| `createViewport(canvas, options)` | Creates a `ViewportEngine` (implements `InteractiveViewport` from `@wren-cad/contracts`) |
| `ViewportEngine`, `ViewportEngineOptions`, `ViewportEventMap`, `CameraState`, `PickStats` | The engine's extended surface: camera state, render count, pick statistics, context-loss events |
| `VIEW_DIRECTIONS`, `cameraPositionFor`, `fitDistance`, `clipPlanes`, `unionBounds`, `gridCellSize` | Camera and view maths, unit-testable without a GPU |
| `meshBuffersToGeometry`, `edgesToSegments` | Converts `MeshBuffers` (from `@wren-cad/contracts`) into three.js geometry and edge segments |
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
- **Camera.** `camera-controls` owns the wheel (dolly to the cursor), two-finger pinch/pan and every
  programmatic move (fit, `setView`, `lookAtPlane`, which ease unless reduced motion is on). Mouse
  buttons, one-finger touch and non-drawing pen are handled by `NavigationMachine` (`src/navigation.ts`,
  pure and unit-tested) and applied in `viewport.ts`, so the pivot, the marker and the 1:1 drag are
  ours. See "Navigation (M3.5)" below. Double-click or double-tap fits the view until an app calls
  `onGesture`.
- **Module map (H1 split).** `src/viewport.ts` holds `ViewportImpl` (state, construction, the
  public methods as one-line delegates) and `createViewport`. Each responsibility lives in a sibling
  module of plain functions taking the engine as `vp`: `bodies.ts` (meshes, materials, edges,
  ghosts, theme), `picking.ts` (ID buffer, point pick, BVH prebuild), `rectPick.ts` (box select),
  `camera.ts` (controls config, fit, standard views, roll), `wheel.ts` (ADR-069 wheel zoom),
  `navControl.ts` (NavigationMachine glue, pivot, marker), `input.ts` (pointer gestures, palm
  rejection, long press), `sketchOverlays.ts`, `adornments.ts` (highlights, markers, handles,
  previews), `sectionView.ts`, `compareView.ts`, `renderLoop.ts` (wake/sleep, rest work, warm-up,
  context loss) and `probes.ts` (test diagnostics). Shared types and constants are in `types.ts`
  (public) and `internal.ts`. New engine behaviour goes in the matching module, not in `viewport.ts`.
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
- **Reduced motion.** `reducedMotion: true` (or the system `prefers-reduced-motion`) disables camera easing. Dragging never eased in the first place.

## Tests and scripts

| Command | What it does |
| --- | --- |
| `pnpm --filter @wren-cad/viewport test` | `vitest run` over `test/` (views, the view cube, geometry and picking maths) |
| `pnpm --filter @wren-cad/viewport typecheck` | `tsc -p .` |
| `pnpm --filter @wren-cad/viewport harness` | A Vite page that mounts the engine with test meshes, for manual work |
| `pnpm --filter @wren-cad/viewport e2e` | Playwright tests in `e2e/` (`viewport.spec.ts`, `picking.spec.ts`, `navigation.spec.ts`, ...): orbit, zoom, fit, pinch, picking tolerances, sketch overlays, pivot, presets, box selection |
| `pnpm --filter @wren-cad/viewport perf` | Opt-in probes that set `WREN_PERF=1`: a 1-million-triangle model orbiting, and picking on the same model. Expect minutes on software GL. They log numbers and assert only that they ran. |

The E2E tests run in CI's package-E2E job (Chromium, software GL). Fixtures come from
[`@wren-cad/test-fixtures`](../test-fixtures).

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

## Compare overlay (M2.5)

`setCompare({ added, removed, ghostOpacity?, show? })` draws added material green and removed red over
the live bodies, which fade to `ghostOpacity` (default 0.15); `setCompare(null)` restores them.
Test hooks on the engine: `getCompareStats()` (active, show, mesh counts, ghost opacity, geometry
builds, bounds) and `getBodyMaterialState(id)`. `fitAll(animate, { includeOverlay: true })` frames
the overlay. Palette and rendering choices: see ADR-028 in docs/DECISIONS.md.

## Navigation (M3.5, ADR-046)

`setNavigation(partial)` / `getNavigation()` take the contract's `NavigationOptions`.

- **Left drag never navigates**, under any preset. The viewport leaves left pointer events to the
  app (picking, box select, sketch tools); the tap recogniser (`gestures.ts`) still sees left presses.
- **Buttons per preset**
  - `rightOrbit` (default): right drag orbits, middle drag pans, right click = `contextMenu`.
  - `middleOrbit`: middle drag orbits, Ctrl+middle pans, right drag pans, middle click on geometry =
    `setPivot`, right click = `contextMenu`.
  - `middlePan`: middle drag pans, Shift+middle orbits, right drag orbits, right click = `contextMenu`.
  - `rightOrbitRepeat`: as `rightOrbit`, but a right click released within 250 ms emits
    `contextMenu` with `repeat: true`; slower presses emit a plain `contextMenu`.
  - A secondary press released within 4 px is a click; past 4 px it navigates and emits no gesture.
    The browser context menu is always suppressed. The wheel zooms to the cursor under every preset;
    `invertZoom` reverses wheel and pinch.
- **Pivot.** An orbit picks the surface point under the pointer (ID buffer when current, BVH when
  cheap) when the drag passes its threshold, and rotates the camera rigidly about it, so that point
  keeps its screen position. On a miss: a still-visible middle-click pivot, else the centre of the
  visible bodies' bounds if in front of the camera and on screen, else the surface under the viewport
  centre, else a point on the view axis. `pivot: 'center'` always uses the bodies' centre. The pick is
  skipped (centre fallback) rather than stalling on a missing BVH of a very large model. Pan grabs the
  scene at the same depth, so the point under the cursor follows it.
- **Marker.** A ring and dot in the theme's accent and background tokens (constant 22/8 px) shows
  while orbiting when `showPivot` is set. A `setPivot` click flashes it for 700 ms.
- **Turntable / trackball.** Turntable rotates about the camera's up axis (+Z unless a two-finger twist
  rolled it) and stops 0.5 degrees short of the poles. Trackball rotates about the camera's own axes
  (up is carried with the camera, so there is no pole). Switching back to turntable levels the camera.
  Standard views and the view cube level it too.
- **1:1 dragging.** Orbit and pan write the camera pose directly each pointer event: no smoothing, no
  inertia. `rotateSpeed` (0.25-4) scales the gain; a full canvas height of drag is one turn at speed 1.
- **Touch and pen.** One finger orbits about the first finger's surface point after 8 px; a second
  finger hands over to camera-controls' pinch/pan and the orbit does not resume. A pen with
  `penDraws` never navigates. A pen without it orbits like a finger.
- **`pickRect(rect, {mode, kinds, visibleOnly})`.** `window` returns what lies entirely inside,
  `crossing` what touches. Faces use the ID buffer's visible pixels (counted per face inside the
  rectangle against the whole image), edges and vertices their projected polylines, occlusion-tested
  with sampled points when `visibleOnly` (default). Sketch entities are never occlusion-tested. Hits
  are unique and sorted nearest to the camera first. Default kinds are face, edge, vertex,
  sketchPoint and sketchCurve. `await whenPickReady()` first: with a stale ID image faces fall back to
  a geometric test filtered by a 33 x 33 ray grid (approximate). The ID image is half resolution:
  faces thinner than about 2 px may be missed.
- **Diagnostics.** `getNavigationState()` (engine extra, not in the contract) reports the drag mode,
  pivot, pivot source, marker visibility and the pivot's screen position, for tests.

### Measured picking budgets (1M-triangle probe, 2026-11-10)

`WREN_PERF=1 WREN_PERF_ASSERT=1 pnpm exec playwright test e2e/navigation.spec.ts -g "perf probe"`
(software WebGL2, headless Chromium, loaded machine):

| Measure | Budget | Measured |
| --- | --- | --- |
| Orbit-start pivot pick (median of 5) | 2 ms | **0.20 ms** (runs 0.50 / 0.20 / 0.20 / 0.20 / 0.10) |
| Full-screen `pickRect`, crossing | 16 ms | **8.5 ms** |
| Full-screen `pickRect`, window, first call (builds per-image totals) | 16 ms | **2.9 ms** (1.7 ms repeat) |

## Coplanar overlays: depth bias

Sketches, region fills, highlights and body/ghost edges lie exactly on faces. `polygonOffset` is not
used (WebGPU ignores it for lines and coplanar slopes). `applyDepthBias` (`overlays.ts`) moves each
overlay vertex to `p * (1 - 0.005)` in view space: screen x, y and w are unchanged and clip z gets
`+ P[2][3] * eps / (1 - eps)`. The pull is 0.5 % of the point's own distance, independent of the
near plane. See ADR-063 in `docs/DECISIONS.md`.
