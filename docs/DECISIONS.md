# Architecture Decision Records

Short log of non-obvious choices. One entry per decision: date, decision, why, alternatives.
Newest last. Superseded entries stay, marked **Superseded by ADR-xxx**.

---

## ADR-001 — Technology stack (2026-11-08)

**Decision.** Adopt the stack in PLAN §3:

| Area            | Choice                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| Kernel          | OCCT 8.0.1 → WebAssembly (see ADR-002 for the toolchain), coarse C++ façade                                     |
| Sketch solver   | `@salusoft89/planegcs` (LGPL-2.0-or-later)                                                                          |
| Rendering       | three.js `WebGPURenderer` with automatic WebGL2 fallback, used imperatively                                     |
| Picking         | GPU ID buffer + `three-mesh-bvh`                                                                                |
| App             | React 19 + TypeScript (strict) + Vite                                                                           |
| UI              | Radix primitives + Tailwind CSS v4 + tokens; Lucide icons; Motion                                               |
| State           | Zustand (UI) + own document store (JSON-patch undo/redo)                                                        |
| Worker RPC      | Comlink + transferables                                                                                         |
| Camera          | `camera-controls` + own gesture recogniser                                                                      |
| Storage         | IndexedDB (`idb`) + OPFS + File System Access API                                                               |
| Packaging       | Canonical folder of deterministic JSON; `.wrencad` = zipped folder (`fflate`)                                   |
| Sync / history  | `StorageProvider` adapters (Mycelium port), `HistoryStore` (isomorphic-git / snapshot DAG)                      |
| PWA             | `vite-plugin-pwa` `injectManifest`, single custom SW that also injects COOP/COEP                                |
| Tests           | Vitest, Playwright, C++/Node golden tests                                                                       |
| Lint/format     | Biome                                                                                                           |
| Package manager | pnpm workspaces                                                                                                 |
| License         | ~~Apache-2.0~~ **Superseded by ADR-003** (GPL-3.0-or-later); kernel ships as a separate, reproducibly built `.wasm` (LGPL-2.1 + OCCT exception) |

**Why.** See the rationale column in PLAN §3. In short: OCCT is the only mature open B-rep kernel;
everything else is the boring, well-maintained option with the largest ecosystem, and keeps the
document model plain JSON (CRDT-ready) and the main thread free of Wasm.

**Alternatives considered.** CadQuery/build123d via Pyodide (too heavy, slow start), replicad as the
core (we need XCAF/PMI, HLR, history APIs and a coarse façade anyway), react-three-fiber (a CAD
viewport needs imperative control). License alternatives AGPL-3.0 / GPL-3.0 remain open until the
Mycelium relicensing question is settled — **must be decided in an ADR before M2.5**.

**Version pins (M0, verified against the npm registry on 2026-11-08).** TypeScript 6.0.3 (not 7.x:
the native-port 7.0 line is recent and tooling compatibility is unproven; revisit in M1),
Vite 8.3.x, React 19.3.x, three 0.187.0, Vitest 5.1.0, Playwright 1.63.0 (matches the browsers pre-installed in the dev container), Biome 2.6.6,
vite-plugin-pwa 2.0.0 / Workbox 7.4.1, Tailwind 4.3.5. Exact pins live in each `package.json`
and in `docs/DEPENDENCIES.md`.

---

## ADR-002 — Kernel toolchain: `libcascade` / `@libcascade/toolchain` (2026-11-08)

**Context.** PLAN §3/§7.2 named "opencascade.js v3 custom-build toolchain (Docker) … via
`additionalCppFiles`". Verified on 2026-11-08:

- Upstream `donalffons/opencascade.js` is still at `2.0.0-beta.b5ff984` (OCCT 7.6, 2023). The v3 line
  lives in the **taucad fork** (`github.com/taucad/opencascade.js`) and is published to npm as
  **`libcascade`** (latest `3.1.0`, LGPL-2.1-only WITH Open-CASCADE-Exception-1.0) with a separate
  **`@libcascade/toolchain`** (`3.1.0`) for custom builds. It builds OCCT **8.0.1** with
  **Emscripten 6.0.5**, native Wasm exceptions, `DEPS.json` pins and per-build `provenance.json`.
- Custom builds are declared in a typed `libcascade.config.ts` (`defineBuild`). Own C++ is added with
  **`customBindings: [{ file, symbols }]`** — the v2 YAML `additionalCppFiles` key is replaced
  (`npx libcascade migrate` converts old YAML). Builds run in digest-pinned images
  `ghcr.io/taucad/opencascade.js:3.1.0-{single,multi}-threaded` (≈ 12 GB each on disk, 2.4 GB
  compressed).
- The prebuilt `libcascade` npm package already ships both `opencascade_single` and
  `opencascade_multi` variants with an `init` selector (threads iff `SharedArrayBuffer` and
  `crossOriginIsolated`).

**Decision.** Use `@libcascade/toolchain@3.1.0` with digest-pinned images to build our own kernel:
façade sources in `packages/kernel/src/*.cpp` registered via `customBindings`, a trimmed `bindings`
list, and two variants (`single`, `multi`) mapped to our artefact names `whittle-kernel-st` and
`whittle-kernel`. PLAN §3 and §7.2 are updated accordingly.

**Notes.** The toolchain authors measured that trimming 14 % of bound symbols saved only 0.9 % of
brotli size (embind registrations are GC roots); size wins come from not binding whole toolkits,
not from fine trimming. Track size per build in CI.

**Alternatives.** Direct CMake + Emscripten build of OCCT 8.0.1 (kept as the fallback spike);
using the prebuilt `libcascade` package with a JS-side façade (works, but violates the "coarse
boundary" rule and ships every binding).

---

## ADR-003 — License: GPL-3.0-or-later (2026-11-08)

**Decision.** Wren's own code is licensed **GPL-3.0-or-later** (owner decision, 2026-11-08). This
supersedes the Apache-2.0 row of ADR-001.

**Why.** Mycelium's sync layer (same author) is GPL-3.0; matching it lets `packages/sync` port its
provider adapters, auth flows and conflict handling directly (PLAN §8A) with no relicensing step.
Copyleft also keeps forks of Wren open.

**Consequences.**
- Every package declares `"license": "GPL-3.0-or-later"`; root `LICENSE` is the GPL-3.0 text.
- OCCT (LGPL-2.1 WITH Open-CASCADE-Exception-1.0) is GPL-compatible. We still ship it as a separate,
  reproducibly built `.wasm` with public build scripts.
- Dependencies must be GPL-3.0-compatible: MIT, BSD, ISC, Apache-2.0, MPL-2.0, LGPL, and
  LGPL-2.0-or-later (planegcs) all are. **GPL-2.0-only dependencies are not allowed.** Check this when
  adding entries to `docs/DEPENDENCIES.md`.
- Mycelium's GPL-3.0 code: if it is GPL-3.0-only, the combined work is effectively distributed under
  GPL-3.0. That is acceptable.

**Alternatives.** Apache-2.0 (would need the Mycelium module relicensed); AGPL-3.0 (also closes the
hosted-fork gap; may be revisited if share/collab hosting in §13 lands).

---

## ADR-004 — Materials and density are part of the document (2026-11-08)

**Decision.** `Part.material` is a structured `Material` (`libraryId?`, `name`, `density: Expr`,
`appearance?`, `properties?`), stored inline in the part file. It is not a free-text name or a
reference only. Density is an expression with units (`2.70 g/cm^3`, `0.0975 lb/in^3`).
packages/document resolves it to kg/mm³. `KernelApi.massProperties(shape, density?)` returns mass and
the inertia tensor when a density is given. Wren ships a built-in material library (M1); STEP
export writes material and density through `XCAFDoc_MaterialTool` (M5).

**Why.** Owner request (2026-11-08): users must be able to assign a material and density to parts.
Keeping the values inline keeps documents self-contained and mergeable by stable IDs, and survives
library changes. `libraryId` lets the UI offer "reset to library values".

**Consequences.** The expression/units engine must support compound units (mass/length³). The
inspector shows material and mass. BOMs (M6) list the material.

---

## ADR-005 — M0 integration decisions (2026-11-08)

1. **COEP `require-corp` everywhere** (SW, dev/preview server, `_headers`). Safari/WebKit has not
   shipped `credentialless` (through 26.5), so `credentialless` would leave every iOS browser
   un-isolated. All assets are self-hosted, so `require-corp` costs nothing. COOP `same-origin`
   severs `window.opener`, so OAuth flows (M2.5) must use redirects, not popups.
2. **Kernel Wasm is runtime-cached, not precached.** The SW precaches the app shell. The kernel
   `.wasm` and glue go in a `CacheFirst` `whittle-kernel-v1` cache the first time they load, so the
   first visit doesn't block SW install on megabytes and phones don't download a kernel they may never
   use. They are available offline after first use (verified by E2E).
3. **Lazy viewport.** three.js + the viewport is ≈ 240 KB gzip, nearly the whole 250 KB
   initial-route budget, so it is `import()`ed after the shell paints. Initial-route JS is 122 KB gzip.
4. **Studio environment built after the first body frame.** PMREM generation of the procedural
   `RoomEnvironment` compiles and renders several shader passes. Profiling on software GL
   (SwiftShader, as in CI and this dev container) showed it as a ≈ 1.6 s main-thread block before
   the first frame, and it starved the kernel worker's startup. The viewport now renders with a
   hemisphere fill light first and builds a 64² environment on idle after the first body frame.
   Warm time-to-box went from 2.5 s to ≈ 1.0 s on software GL.
5. **Kernel boot waits for the isolation outcome** (`whenIsolationSettled`), so a kernel is never
   booted in the document that the first-visit isolation reload discards. The threaded build is used
   iff `crossOriginIsolated`.
7. **Deploys are gated on CI** (reviewer M0 defect 6): the Pages deploy is the last job of `ci.yml`
   and needs lint, unit tests, build/size and the Chromium + package E2E suites. Firefox and WebKit
   E2E run but don't gate yet: on the first CI run, headless Firefox never rendered the box (cause
   under investigation; failures now surface their reason through `firstBodyRendered`), and
   Playwright WebKit cannot reload offline under a SW (harness limitation; those two tests are
   skipped on WebKit). Make them gating once they're green.
8. **Touch orbit fix.** The render-on-demand loop stopped between touch moves because camera-controls
   only applies drag deltas inside `update()`. The loop now ticks for as long as a pointer is down.
   Covered by phone-emulation E2E (`apps/web/e2e/touch.spec.ts`).
6. **CI visual baselines.** UI screenshot baselines were recorded in the dev container. CI runs the UI
   suite with `--ignore-snapshots` until CI-generated baselines are committed.

---

## ADR-006 — Expression semantics for bare numbers and units (2026-11-08)

**Decision.**
- A bare number takes the default unit of the dimension it is used as: length → the document length
  unit, angle → the document angle unit, mass → g, density → g/cm³, pressure → MPa.
- In `+`, `-`, `min`, `max` and `atan2`, a bare number next to a dimensioned operand takes that
  operand's default unit (`width + 5` in an mm document means 5 mm).
- `pi` is a plain number: write `sin(pi/2 rad)` in a degree document.
- A name resolves to a parameter before a unit, except directly after a number (`2 mm` is a unit,
  `mm` alone can be a parameter named `mm`, which is discouraged).
- Dimension vectors are `[length, mass, angle, time]`. Time exists only so that pressure and stress
  (MPa, GPa) in material properties type-check.
- Renaming a parameter rewrites every reference to it in one undo step.

**Why.** It matches how engineers type values ("5" in an mm document means 5 mm) and keeps unit
errors explicit. `5'6"` is not parsed as feet plus inches; write `5ft + 6in`.

---

## ADR-007 — M1 app integration decisions (2026-11-08)

1. **Picking rolls the model back to the feature's input.** While a feature's pick field (edges,
   faces) is active, the viewport shows the part as it was *before* that feature. Picks therefore
   always name input geometry, never geometry the feature itself created (Onshape behaves the same).
2. **Real regen engine by default.** `?engine=fake` (a main-thread stand-in over the low-level kernel)
   stays for fast UI work only. All E2E runs on the real engine.
3. **In-app welcome instead of a landing page** (owner decision). The app stays at `/wren-cad/`, so
   installed PWAs keep working. The welcome card offers the demo bracket, a new part, install, and
   the repo and licence links.
4. **Kernel boot starts before React's first render**, and download-progress updates are throttled
   (8/s). Warm first body went from 1.38 s to 0.81 s on software GL.
5. **Autosave** to the local library 500 ms after edits settle and on `visibilitychange: hidden`. The
   last document reopens on launch.

---

## ADR-008 — M1 gate fixes in the app (2026-11-08)

1. **Reference healing is folded into the next user edit.** `FeatureStatus.rebound` (name and
   fingerprint) is applied as extra patch ops in front of the user's next command, in the same undo
   step (`apps/web/src/model/heal.ts`). A standalone history entry would make the first undo a
   no-op, and the store has no history-free patch. Until then the engine keeps rebinding.
2. **Opening a `.wrencad` never overwrites a different library entry.** Same `meta.id` with
   different content (document files or extra files) opens as a new entry: new id, " (copy)" when
   the name is taken, and a non-modal note. Only an identical project reuses its entry.
3. **Imports.** Open/Import (inspector, ⌘O) and drag-and-drop add an `ImportFeature` to the open
   part; the library's and the welcome card's "Open or import…" start a new document for it (no
   part is being worked on there). Bytes live at `imports/<featureId>.<format>` and are sent to the
   engine once per part and worker (keyed by sha256), again after `closePart`.
4. **Mesh cache for instant open.** Fine meshes go to `.wren/meshes/` (FILE_FORMAT.md) with the
   document. On launch the last document is read before React renders and the viewport is created
   only after that read (≤ 400 ms): creating the view compiles shaders — a ≈ 0.5 s main-thread task
   on software GL — which otherwise delays the IndexedDB/OPFS read behind it. Cached open went from
   ≈ 0.9 s to ≈ 0.4 s (warm, SwiftShader); live regen then replaces the cached bodies.
5. **Library thumbnails are rate-limited** (first save, flushes, else every 30 s): reading back the
   WebGL canvas costs ≈ 200 ms on software GL and stalled interaction during editing.
6. **Sketch overlays track the camera adaptively**: every frame while it moves or a pointer is
   down, otherwise a 200 ms check. A perpetual `requestAnimationFrame` loop kept the compositor busy.
7. **The fake engine is dev/test only** (`import.meta.env.DEV`); production builds do not contain it.
8. **CI runs the web E2E with one worker** (2-vCPU runners, SwiftShader, Wasm threads). Heavy flows
   use `test.slow()`; tests wait on app signals (`sketchSettled`, `idle`, camera settled), not time.
9. **Sketch solver tolerance and coplanarity.** The solver treats a dimension within 1e-7 × sketch
   size as satisfied and does not move geometry, so two sketches each ~1e-5 mm off can leave
   sliver faces where faces should be coplanar. The acceptance E2E draws oversize so dimensions
   really solve; a polish step in `packages/sketch` is proposed for M2.


## ADR-009 — M2 touch & tablet: contracts and split (2026-11-08)

**Context.** M2 (PLAN §12) adds the tablet and phone shells, the gesture map, Pencil drawing with
primitive recognition, push/pull direct editing with a same-frame preview, and phone measure,
section and export.

**Decisions.**

1. **Gestures.** The viewport owns continuous navigation: orbit, pan, pinch-zoom and twist-roll.
   It only *reports* discrete gestures (`onGesture`: tap, double-tap, long-press, two- and
   three-finger tap); the app decides what each means. This keeps undo/redo and context menus
   out of the viewport.
2. **Palm rejection is an input policy, not app logic.** With `setInputPolicy({ penDraws })`, pen
   pointers never orbit, and touch taps are suppressed while a pen is down or was used within
   `palmRejectMs`. Fingers still navigate while the Pencil draws, as in Shapr3D.
3. **The push/pull preview is built by the viewport from meshes it already holds.**
   `setPreview({ kind: 'prism' })` translates the picked faces' triangles and adds side walls, with
   no kernel round trip, so feedback lands in the same frame (§10 ≤ 16 ms). The exact OCCT result
   is committed on release as a `PushPullFeature`. In M2 the kernel supports planar faces only:
   prism of the faces, then fuse (outward) or cut (inward), with names per naming.ts M2.
4. **Measure runs in the kernel (B-rep exact), section in the viewport.**
   `ModelingApi.measure(partId, a, b?)` uses BRepExtrema/GProp on the latest regen. The section
   is a clipping plane with stencil caps, so it needs no kernel work.
5. **Stroke recognition is a pure function in `packages/sketch`, run on the main thread** (no
   Wasm), so the clean-up shows while the stroke is still live. The result becomes entities plus
   constraints in the same way as the drawing tools' fragments.
6. **Phone tier loads the kernel lazily** (PLAN §8.4): the phone shell is a viewer of cached
   meshes until the user starts an edit or a measurement.
---

## ADR-010 — M2 platform: installed iPad PWA, tiers, CI performance budgets (2026-11-08)

1. **No page zoom, no page scroll, no browser chrome behaviour.** iOS Safari ignores
   `user-scalable=no`, so the viewport meta carries it (Chromium and Android honour it) and
   `platform/page-guards.ts` also cancels `gesturestart/change/end` and multi-touch `touchmove`.
   Double-tap zoom is prevented with `touch-action: manipulation` on `html`; the canvas stays
   `touch-action: none` and is unaffected (camera-controls reads pointer events, which cancelling
   touch/gesture events does not suppress; `touch.spec.ts` pinch still passes). `body` is
   `overflow: hidden` + `overscroll-behavior: none`, with `user-select: none` and
   `-webkit-touch-callout: none` except in inputs/textareas/`[data-selectable]`. Safe-area insets
   are exposed as `--safe-top/right/bottom/left` (`env(safe-area-inset-*, 0px)`). Cost: disabling
   page zoom is an accessibility trade-off (Lighthouse's `meta-viewport` audit flags it). The app
   must provide its own zoom (viewport camera, UI scale) instead; it is a CAD canvas, not a document.
2. **Status bar `default`**, not `black-translucent`: the shells follow light/dark themes and a
   translucent bar would put white text over the light theme. iOS 26 generates the splash screen
   from the manifest `background_color` and icon, so no per-device `apple-touch-startup-image` set.
   The manifest has one `theme_color`; light/dark theme colours come from the two
   `<meta name="theme-color" media=...>` tags.
3. **Tier detection.** A recognised UA decides first: iPhone/iPod = phone; iPad UA, or iPadOS in
   desktop-class mode (`platform MacIntel`/Macintosh UA with `maxTouchPoints > 1`; real Macs have 0) =
   tablet, even when a trackpad flips `(pointer: fine)`; Android with `Mobile` = phone, without =
   tablet. Everything else keeps the pointer + short-side rule. Touch-screen Windows laptops stay
   desktop. `platform/tier-policy.ts` is the one place for the tier's regen cache budget (desktop
   default 128, tablet 4, phone 2), mesh quality (phone `coarse`, others `fine`; PLAN's "medium"
   for tablets needs a third `MeshQuality` value, proposed to the contract owner) and kernel boot
   policy (`eager`, phone `onEdit`).
4. **CI performance gate.** `perf` job in `ci.yml` gates the Pages deploy: shell TTI (cold context,
   fast-4G throttle via CDP, first-document shell visible), peak memory, and the viewport package's
   `WREN_PERF=1` probes. Time budgets are multiplied by `PERF_FACTOR` (`e2e/perf/budgets.ts`):
   **3 on CI, 1.5 locally**, override with `WREN_PERF_FACTOR`. Rationale: the 2-vCPU runners have
   no GPU (SwiftShader) and measured 2-4x slower main-thread work than a mid-range laptop; 3 leaves
   headroom for noisy neighbours without hiding a 2x regression. Memory is not scaled.
5. **Memory measurement.** `performance.measureUserAgentSpecificMemory()` is preferred but headless
   Chromium reports it unavailable even when cross-origin isolated, so the test also reads the
   browser process tree's PSS from `/proc` (includes the kernel worker's Wasm and SwiftShader's
   software GPU buffers, so it over-states a real iPad tab) and the JS heap, and asserts the largest
   against 1 GB. Real-iPad numbers still need a Safari Web Inspector pass at the M2 gate.
6. **Lighthouse** runs via `@lhci/cli@0.16.0` (pinned, invoked with `npx`, not in the lockfile),
   non-gating, 3 runs, with warn-level assertions. Lighthouse 12+ has no PWA category, so
   installability is asserted in `pwa-shell.spec.ts` instead.
7. **E2E on slow runners.** CI runs Playwright with `--trace retain-on-failure` (still one worker);
   traces land in the existing failure-only `playwright-report-*` artefact. The installed-PWA
   checks run as `chromium-touch` (gating) and `webkit-ipad` (non-gating) projects.


## ADR-011 — M2 sketch: stroke recognition and solver polish (2026-11-08)

**Context.** ADR-009 item 5 puts Pencil recognition in `packages/sketch` as a main-thread pure
function; ADR-008 item 9 left driving dimensions up to 1e-7 × sketch size off after a solve.

**Decisions.**

1. **Recognition pipeline** (`packages/sketch/src/recognize.ts`): resample at bounding-box
   diagonal / 40 (ShortStraw), straw corner candidates, then per-segment total-least-squares
   lines with split / hook-drop / merge, and Pratt circle fits for whole-stroke circles and arcs.
   Thresholds are relative to the stroke length L, which is measured on the resampled polyline:
   per-sample jitter inflates the raw length up to 2× on slow strokes and would loosen every
   threshold. A 0.3 × tolerance floor absorbs hand noise on short strokes.
2. **Arc vs polyline vs circle vs oval.** A circle fit alone accepts polylines that turn one way
   and ovals. An arc must also have uniform turning (no 8% / 15% window holding a corner's share),
   beat a two-line model, and progress monotonically. A circle must have a principal-axis aspect
   ≤ 1.2 (ovals of 1.3 and above are reported as closed polylines with confidence 0.3). When in
   doubt, the result is the polyline: a stroke wrongly turned into an arc is worse than an arc
   kept as a stroke.
3. **Clean-up is exact.** Snapped vertices are intersections of the fitted lines, with exact
   coordinates on horizontal/vertical lines, so `strokeFragment` derives constraints from the
   geometry (only kinds in `implied`). The fragment solves without moving and has no redundant
   constraints (a direction union-find skips a loop's last right angle). `implied: ['coincident']`
   means the ends were joined; the fragment shares the point instead of adding a constraint.
4. **Rectangle tolerance is 2 × angleTolerance per corner** (12° by default). Snapping to an
   axis uses angleTolerance on the fitted orientation (circular mean of 4θ).
5. **Solver polish** (`packages/sketch/src/polish.ts`): after every accepted solve and drag step,
   minimum-norm Gauss–Newton steps (CG on J Jᵀ, unit-scaled rows, finite-difference Jacobian of
   our own residual rows) until every row is ≤ 1e-11 mm (1e-13 rad). The minimum-norm step keeps
   under-constrained geometry from drifting, and redundant consistent rows are harmless. Exact
   geometry is returned unchanged (no step is taken), and a step is kept only if it lowers the
   worst residual. The conflict search does not polish: it only needs yes/no answers. Cost: drag
   median on the 200-entity chain went from ≈ 0.50 ms to ≈ 0.57 ms. A polish with real work on
   200 entities takes ≈ 0.7 ms.
## ADR-012 — M2 UI: sheet, keypad and tablet rail (2026-11-08)

1. **The bottom sheet moves with a CSS transform, not Motion.** Motion's features load lazily (ADR-005
   keeps ~25 KB off the initial route), and a `style={{ y }}` motion value is not rendered until they
   arrive, so the sheet sat at its open position on first paint. The sheet now renders
   `translateY(...)` from React state: live under the finger, and a `transition` on
   `--duration-standard` (260 ms, mirrored in `tokens.css` from `motion.ts`) when it settles.
   `prefers-reduced-motion` already zeroes CSS transitions globally. Release velocity is projected
   over 180 ms (the `fast` preset) before picking the nearest snap; a fast flick always moves one snap.
2. **Stages use `overflow-clip`, not `hidden`.** A hidden box can be scrolled by focus or
   `scrollIntoView`, which dragged a translated sheet's off-screen part into view and shifted the
   whole stage by ~28 px.
3. **`Measurement` is declared in the UI package** (`measure/types.ts`) because `@wren-cad/contracts`
   has none yet (only `MassProperties`). It is structural: replace it with the contract type when the
   lead adds it (proposed diff in the M2 UI hand-off).
4. **Tablet rail groups.** Tools are reachable through their group (`[data-tool-group]`); a group
   with several tools opens a flyout containing the same `[data-tool]` buttons, so tests that click
   a tool on tablet must open its group first. Single-tool groups (Sketch, Inspect → Measure) stay
   one tap. The tutorial uses comma selectors (`[data-tool="x"], [data-tool-group="y"]`) to point at
   whichever is visible.
5. **The keypad is placed, not floated.** Below the field if it fits, else above, else docked at the
   bottom with a compact layout; it is portalled and follows the field every frame (sheets animate).
   Keys never take focus, and the keyboard toggle exists in both layouts. Parameter names come from
   `ParamNamesContext`, which the shells fill from `paramsTable`.
   *M2 gate:* landscape phones (844 × 390) are wide but short, so `placeKeypad` also tries beside
   the field (right, then left) and the top edge. When even the compact layout docked at the
   bottom would cover the field, it returns `scrollBy` and the keypad scrolls the field's
   sheet or panel (never the page, never a container of the 3D view, whose overlays would shift
   against the canvas) so the field sits just above it. The field is never left under the keypad.
6. **Touch targets are 44 px everywhere**, including `Segmented size="touch"` (was 40). The drag
   handle of a sheet is the one exception (28 px strip): the whole peek area drags and the handle is
   keyboard-operable.


## ADR-013 — Push/pull in the kernel: prism + boolean + seam merge (2026-11-08)

**Context.** M2 push/pull (`PushPullFeature`, naming.ts "M2 additions") moves planar faces of one
body along their outward normals by a signed distance. OCCT offers three routes: sweep each face
with `BRepPrimAPI_MakePrism` and fuse/cut the prisms; the form feature `BRepFeat_MakePrism`; or the
local-operation tools in `LocOpe`.

**Decision.**

1. **Prism + one boolean.** Each selected face is copied and swept by `d · n` (outward for d > 0,
   into the body for d < 0). Then all prisms go into one `BRepAlgoAPI_BooleanOperation`: fuse
   when d > 0, cut when d < 0. `BRepFeat_MakePrism` takes one sketch face and one direction per
   operation, so faces with different normals would need chained operations. Its history goes
   through `LocOpe` gluing maps; `Generated` is reliable only for the lateral faces of the basis,
   and its "from/until" face logic expects a sketch face lying on a support face. Prism + boolean
   gives exact `Generated` (walls from boundary edges, `LastShape` = the moved face) and the
   general boolean's `Modified`/`IsDeleted`. The faces are copied first, so the tool and the body
   share no topology, and the boolean sees the coincident faces geometrically.
2. **Seams are merged, but only the ones the operation created.** Without a merge, pulling a box
   top up leaves a seam line around the box, at the old height: the walls are coplanar with the
   sides but are separate faces. Pulling a pocket floor up flush leaves the floor as a separate
   face inside the top. So `ShapeUpgrade_UnifySameDomain` runs with every edge kept (`KeepShapes`)
   except the seams between faces on the same surface that are:
   - old face + wall,
   - old face + moved face,
   - wall + wall,
   - or two pieces of the same face.

   Vertices away from moved faces and walls are kept too. Two old faces never merge, so earlier
   coplanar splits are untouched. Two different moved faces never merge either: both keep their
   names.
3. **Name priority when faces merge: old > moved > wall.** A wall merged into an old side face
   takes that face's name, and the box keeps its six names. A moved face that ends up flush with
   an old face is swallowed: the old face keeps its name and the moved face's name disappears (the
   naming.ts "faces swallowed by the move disappear" rule). Walls that survive are
   `F<id>:side(<edge name>)`. Splits re-index `#k` as usual (`finalizeNamed`). Names flow through
   the boolean's history, then through the `BRepTools_History` of the unify and fix steps.
4. **Validity.** The result is checked with `BRepCheck_Analyzer`. `ShapeFix_Shape` runs only when
   the result is invalid, with names mapped through its re-shape history. If the result is still
   invalid, the call fails with `OPERATION_FAILED`; an invalid solid is never returned. If the
   push removes everything, it fails with `OPERATION_FAILED` ("removes the whole body", with a
   hint and the faces as `entityRefs`). A push that splits the body warns and returns the solids
   as one body.

**Consequences.** A pushed box stays a 6-face box, and downstream references to its faces and
edges keep resolving by exact name. A pocket pulled flush leaves no trace. The cost is one
UnifySameDomain pass, restricted to the operation's seams. Curved faces stay `UNSUPPORTED_FEATURE`
in M2. Offsetting curved faces (`BRepOffset_MakeOffset` with per-face offsets) is the natural M3
extension, and it would also extend non-perpendicular neighbours instead of adding walls.

**Addendum (M2 gate): one step per normal group.** Sweeping every face in one boolean leaves a
notch where two moved faces meet: pulling a plate's top and right side +5 gave the right bbox but
missed the 5 × 5 × length corner block (62500 instead of 63750 for 80 × 50 × 10). The regen engine
(`pushPullSteps`, kernel-client) now groups the selected faces by outward normal (equal within
1e-6 per component after normalising), sorts the groups by normal (x, then y, then z), and runs
one kernel push/pull per group, in that order. Before each later step it finds that group's faces
on the new body by persistent name; moved and untouched faces keep their names, so this is an
exact lookup, never a guess. A face that no longer exists by name (swallowed by an earlier step)
fails the feature (`UNRESOLVED_REFERENCE`, face named). At convex corners the result is the uniform
offset: the side moves after the top, when it is already taller. Inward pushes are unchanged
(top + side −3 is 77 × 50 × 7 either way). A single normal, or any curved face, still runs as one
step. The C++ façade did not change. The viewport preview draws one prism per group plus a fill
block for each convex edge shared by two groups (push-pull.ts), so it matches the result.

## ADR-014 — M2 viewport: camera veto, section caps, GPU prism (2026-11-08)

- **Camera veto.** Pen presses (with `penDraws`) and presses on handles are kept from the camera by a
  window-capture `pointerdown` that disables camera-controls (private `_enabled`) for that one
  event and restores it in a bubble listener and via `setTimeout(0)`. This relies on
  camera-controls internals, so the dependency is pinned to 3.1.2.
- **Double-tap fit** stays the M1 behaviour until the app subscribes to `onGesture`; from then on the
  viewport never acts on gestures itself.
- **Section.** A three.js `ClippingGroup` wraps the body root, the ID-buffer root and the
  highlights, so clipped geometry is neither drawn nor picked. The `WebGPURenderer` is created
  with `stencil: true`. Caps use a per-body stencil pass: a back-face increment, a front-face
  decrement, then a plane quad drawn where the count is non-zero, which also resets it. This
  assumes closed shells. WebGPU is untested in CI (no adapter) and needs a real-device check.
- **Prism preview.** The prism is built once from the faces' triangles and their boundary edges
  (welded by position). A per-vertex `lift` attribute plus direction and distance uniforms move it
  on the GPU, so a distance update allocates nothing. Cuts draw a second mesh with depth test off
  so they show through the solid. Measured on SwiftShader: p95 6.5 ms from handler to render
  (same frame).
- **Gesture timing** uses event timestamps, not handler time, so it survives main-thread stalls.
  The long-press timer gives queued moves 60 ms to cancel it when it fires late.

## ADR-015 — Feature tree: sketches nest under the feature that uses them (view only) (2026-11-08)

**Context.** The feature tree lists sketches and features in strict serial order. Most sketches feed
exactly one feature, so the tree carries a lot of near-duplicate rows. That hurts most in the phone
and tablet bottom sheet. SolidWorks and FreeCAD nest the sketch under its feature; Onshape, Fusion
360 and Shapr3D keep a flat history.

**Decision.** Nest by default, as a *presentation* of the flat feature list. The document, the
JSON Schema, regeneration and naming do not change. A flat ordered list is also what feature-level
diff and three-way merge (M2.5) work best on.

1. A sketch consumed by exactly one feature is shown as a collapsible child of that feature, wherever
   the feature sits in the list.
2. A sketch consumed by several features, or by none, stays top-level. A shared sketch carries a
   "used by N" badge.
3. Reordering a feature moves its nested sketch with it. The document order stays valid: the sketch
   comes immediately before its consumer.
4. The rollback bar cannot stop between a feature and its nested sketch. Rolling back above the
   feature rolls back both.
5. A new sketch shows top-level until a feature consumes it, then it tucks under that feature.
6. Deleting a feature asks inline (non-modal) whether to keep its nested sketch. A kept sketch pops
   out to the top level.
7. A view setting "Show sketches in the history" restores the flat serial list.

**Consequences.** Consumption is derived from the features' references (profile regions, axes,
up-to targets), so the tree needs a small pure helper that computes the nesting and is unit-tested.
Implemented in packages/ui (FeatureTree) and apps/web, after the M2 integration lands.
## ADR-016 — M2 app integration: gestures, direct editing, tiers (2026-11-08)

1. **One input path per pointer type.** With `onGesture` subscribed, touch taps select through
   the viewport's `tap` gesture and the workbench's pointer-up path ignores touch in model mode;
   mouse clicks (they carry Shift/⌘) and Pencil taps (with `penDraws` the viewport reports no pen
   gestures) keep pointer-up. Sketch mode keeps its own pointer path for every type. Double-tap
   zooms to the face (`zoomTo(centroid, faceRadius / 2)`, so the face fills the view) or fits on
   empty space, and is ignored while a sketch shape is in progress; long-press opens the context
   bubble (view actions on empty space); two/three-finger taps undo/redo in every mode.
2. **The context bubble hides while the camera moves** and appears 320 ms after a new selection
   (the double-tap window). It is anchored at `worldToScreen` of the picked point, recomputed
   when `onCamera` reports rest, so orbiting never re-renders the shell; the delay keeps a second
   tap of a double-tap on the model instead of on a bubble that popped up under the finger. The
   bubble's tip passes taps through. Tablet: Sketch / Push/pull (flat faces), Fillet / Chamfer
   (edges), Extrude / Cut / Revolve (regions), Measure; phone: Measure, Section (viewer-first).
3. **Push/pull** follows the viewport recipe (ADR-014): the arrow on the first face's centroid
   and normal, the drag projected on the screen image of the normal (snapped to 0.1 mm), handle
   and GPU prism updated inside the pointer handler, the chip once per frame. Faces of several
   normals preview as one prism per normal. A press on the arrow without a drag keeps it for a
   typed value. The preview stays up until the regen with the new feature lands (no flash of the
   old shape). Curved faces are refused before the drag (the prism cannot show them); the
   kernel's errors (e.g. "removes the whole body") are shown as a toast and on the feature.
4. **"Cut" for sketch regions** (bubble): an extrude with `op: 'cut'`, reversed, through all,
   with the profile pick field left open so more regions can be tapped. With no Hole tool yet,
   this is how the tutorial's holes are made. A visible sketch region drawn over a face now wins a
   tie with that face (`resolvePick`), so tapping a hole sketched on a face selects the hole.
5. **Pencil.** Touch tiers set `penDraws`. In sketch mode a pen press draws a stroke (a pen tap
   is a click for the active tool, a press on geometry with no tool drags it), recognised live
   (ink + cleaned-up shape as preview entities, a shape chip by the pen) and committed through
   `commitEdit` with the pending-click logic. Only open strokes' free ends get end-point
   inference: a hole's circle centre must not snap onto a nearby edge. Once the Pencil has been
   used in a sketch session, fingers no longer draw there (PLAN §9.3). Fingers can drag-to-draw
   two-click shapes (the press is the first click). Recognition is imported from
   `@wren-cad/sketch/recognize` only; the package root no longer re-exports it, since the root is
   on the initial route and the re-export would pull the recogniser into it.
6. **Tutorial conditions are document facts** (`app/tutorial.ts`): a sketch; a closed loop of
   ≥ 3 lines; a driving dimension not being edited; an extrude / a cut / a fillet that rebuilt;
   a parameter used by a feature whose value changed after it was first used; an export since
   the tour began. The tour starts on a new part. Coach cards for targets low on the screen dock
   at the top, and cards never cover the bubble, the value chip or the keypad.
7. **Tiers.** `policyFor(tier)`: the regen budget goes to the worker at creation and again via
   `configureRegen`; phones skip the fine pass and cache coarse meshes. Phones boot the kernel on
   the first edit (`apply`), measurement or exact export, or when the document has nothing
   cached; until then the cached meshes' first frame is the "first body" mark, and the loader only
   shows while the kernel is actually loading. Attention markers are `setMarkers` (dashed warning
   polylines and a dot) instead of ghost meshes.
8. **Overlays against the chrome.** Tablet and phone stages expose `--chrome-top`,
   `--chrome-left` and `--chrome-bottom` (the sheet's visible height at rest; on the tablet at
   least up to the bottom-right chips); the Library button, sketch status, sketch toolbar, prompt
   chip and toasts are placed with them. The app keeps the sheet snap and section (controlled
   props); a sheet the app opened for the user (a new feature's inspector, Measure on a tablet)
   collapses again on Done.
9. **Import attachments.** Saved files (library, `.wrencad`) never carry orphans: only the
   attachments the current document references, plus all non-import extra files. In memory an
   orphan stays while the undo/redo history still mentions its path
   (`DocumentStoreImpl.historyMentions`), so undoing the delete always finds the bytes; once the
   history has dropped it (it fell off the end, the redo branch was replaced, the document was
   closed) it is pruned at the next save.
10. **Tool groups.** Section joins Measure in the Inspect group, so Inspect is a flyout (ADR-012
    item 4's single-tool Inspect no longer holds). `toolGroups` is the single source of truth. (The
    desktop bar's temporary flat set, `commandBarTools`, is gone: ADR-017.)
11. **Cached open, profiled.** On SwiftShader the critical path is the library read (≈ 60–80 ms
    after the main chunk evaluates), the view's creation (≈ 40–60 ms) and its first frame with
    the cached bodies, which compiles their shaders (≈ 120–160 ms). Interleaved A/B runs (8 + 8
    reloads per variant) found no gain beyond run-to-run noise (± 40 ms under load) for: reading
    the library in a worker (worse: +55 ms, the worker's start-up outweighs the decode it saves),
    creating the view without waiting for the read (much worse, as in ADR-008 item 4), fetching
    three.js before React's first commit, deferring the idle shader warm-up past the cached frame,
    and dropping the view cube. None of them was kept.
12. **Fingers in sketch mode (M2 gate D1, D9).** Presses are tracked per pointer id (a pen and a
    finger, or two fingers, are down together). Before the Pencil is used, only a lone finger
    draws, drags or picks: the session withholds its press from camera-controls. When a second
    finger lands, the one-finger action is cancelled (a finger drag's first click is taken back)
    and the withheld finger is handed to camera-controls by re-dispatching its `pointerdown` on the
    canvas at its current position (a synthetic event the workbench ignores, `pointers.ts`).
    camera-controls then sees both fingers (pinch, pan, twist); the viewport's gesture recogniser
    already saw both (window capture), so two/three-finger taps undo/redo as in model mode, and
    their releases place nothing. With a drawing or dimension tool active, a double-tap is never
    "fit" (its taps are tool clicks).

## ADR-017 — Dimensions to the origin, axes, planes and model geometry (2026-11-08)

**Context.** Sketch dimensions and constraints could only reference the sketch's own entities. Users
could not dimension a hole "20 mm from the origin" or an edge "15 mm from the right plane", so they
had to anchor sketches with `fix`. That is fragile: it breaks design intent, and nothing follows
when the origin is meant.

**Decision.**

1. **Origin and axes (now).** Every sketch implicitly has a fixed origin point and its two axes:
   reserved ids `@origin`, `@x` and `@y` (contracts/sketch.ts). These are the part origin projected
   onto the sketch plane (sketch-local (0, 0), which is how sketch frames are already placed), and
   the lines through it along u and v.
   - They are drawn as reference geometry (a small origin glyph and thin dashed axes, distinct
     from construction lines). Dimension and constraint tools can pick them, and drawing inference
     snaps to them.
   - They are never stored in `entities`, never form profiles, and carry no degrees of freedom.
     The solver adds them as fixed geometry when a constraint references them. The regen engine
     uses the same solver core, so documents regenerate identically.
2. **Planes, model edges and vertices (M3, with Convert Entities).** Dimensioning or constraining to
   model geometry brings it into the sketch as a **linked reference entity** (projected, fixed,
   construction). It is the same mechanism as Convert Entities, with `construction: true`.
   - Origin planes and planes perpendicular to the sketch project to lines.
   - A lost source makes the sketch "needs attention" (ghost + Re-pick), never a silent re-pick.
   - Planes parallel to the sketch are dimensioned as the sketch plane's offset, not in-sketch.
**Implementation of item 1 (M2).**

- *Solver.* The references are added to the model (grounded parameters) only when a constraint
  uses them, so other sketches solve bit for bit as before. Each axis is a line from the origin to
  an internal unit point (`@x:end` / `@y:end`, reserved ids). A constraint that involves only
  references is ignored when it already holds and reported otherwise. Axes refuse length, midpoint
  and equal. The polish and the conflict search see them as ground, like `fix`ed geometry; they are
  never listed in `SketchConflict.fixed` and never offered for removal.
- *Inference.* Origin coincident 0.98 and axis point-on 0.68 (the user's geometry: 1 and 0.7), so
  a real point or curve at the same spot wins. Coincident with the origin always makes a new point
  plus a constraint (the origin is not an entity to merge into). A line whose two ends are on the
  same axis gets no extra horizontal/vertical, which would be redundant.
- *Picking.* The user's points, then the user's curves, then the origin, then the axes, nearest
  first within a tier. "Never block the user's geometry" includes curves: a line through the origin
  wins there, and its end point (if any) is the same place for dimensioning.
- *Dimensions.* Origin ↔ point is a two-point dimension (h/v/aligned by label placement); axis ↔
  point the perpendicular distance; axis ↔ line an angle from the axis, or a distance when parallel;
  the origin or an axis ↔ circle/arc measures to its centre (dimensioning holes is the common case).
- *Display.* Through the existing sketch overlay: the axes as construction (dashed) curves `@x` /
  `@y`, drawn first, across the visible view × 1.25 (redrawn when the view leaves that span or
  shrinks 2.5× inside it), the origin as a faded construction point `@origin` and a small solid
  cross (`@origin:glyph:*`, picked as the origin), all DOF `fixed`. Without a viewport style flag
  the axes share the dashed style of a fully constrained construction line and set the overlay's
  dash length (view-relative); a `reference` style flag on `SketchResult` curves/points is proposed
  for the lead (thin, muted, excluded from dash sizing).

## ADR-018 — Grouped desktop command bar and nested feature tree (2026-11-08)

**Grouped bar.**

1. **One definition.** The desktop `CommandBar` renders `toolGroups` like the tablet rail; the flat
   `commandBarTools` list was removed. Categories: Sketch (direct), Solid (extrude, push/pull,
   revolve), Modify (fillet, chamfer, shell, pattern), Hole (direct), Inspect (measure, section) and
   More. No Reference category yet: no plane/axis/point tool exists (M3); no sweep/loft/boolean tool
   ids exist, so none were invented. Hole left Solid for its own category (PLAN §9.1), so the tablet
   rail gained a Hole button.
2. **Face = last-used tool.** A category button shows the active tool of its group, else the last one
   used (`whittle.lastTools` in localStorage, written whenever the active tool changes, so shortcuts
   and the palette count), else the first. Click opens the flyout (it does not run the face tool:
   "one-click repeat" is the shortcut). Its accessible name is "<face>, <Category> tools", which
   contains the visible label (WCAG 2.5.3) and keeps `getByRole('button', { name: 'Extrude' })` for
   the flyout item. Touch and pen: a 420 ms hold or a 14 px upward drag opens it, and releasing over
   a tool picks it. Mouse presses never start the hold.
3. **Keyboard.** The Radix toolbar roves across categories; ArrowUp, Enter or Space opens a flyout
   with the face tool focused; arrows, Home and End move inside (disabled tools stay focusable so
   their hint can be read); Escape closes and returns to the category; Tab closes.
4. **Hints per tool.** `ToolDef.comingIn` (PLAN §12: shell, pattern and hole wizard are M3) feeds
   `toolHint`; a tool with no milestone says "Not available yet".
5. **E2E.** Desktop and tablet tests use `tool(page, id, how)` in `apps/web/e2e/helpers.ts`, which
   opens the category first. `data-tool` ids are unchanged; category buttons carry `data-tool-group`.

**Nested tree (ADR-015 implemented).**

6. **Derived, never stored.** `computeNesting` (packages/ui `logic/treeNesting.ts`) walks each
   non-sketch feature for entity references (duck-typed: `name` plus an entity `kind`) whose name
   starts `S<sketchId>:`. A suppressed consumer still consumes; sketch features are never consumers;
   a consumer listed before its sketch never nests it. One consumer nests; two or more (badge "used
   by N") or none stay top-level.
7. **Flat ARIA tree.** Rows stay siblings with `aria-level` 1 or 2, `aria-posinset`, `aria-setsize`
   and `aria-expanded` on parents, so row handling is unchanged. Expanded state is local and starts
   collapsed; selecting a nested sketch opens its parent. Keys: Right/Left expand, collapse, step in
   and out.
8. **Reordering a feature** moves it with its sketches via ordinary `moveFeature` steps
   (`planUnitMove`: sketches first going up, feature first going down; the block lands right after
   the feature of the item above). The tree reports them through `onReorder`; the app applies them as
   one undo step after a dry run on a scratch store (`reorderFeatures`), so a refusal leaves the
   document untouched. Without `onReorder` the steps go through `onMove` and are put back on a
   refusal. Nested sketches have no handle of their own.
9. **Rollback** positions between a nested sketch and its feature are not offered
   (`allowedRollbacks`): keyboard steps and drags skip them, "Roll to here" on a nested sketch rolls
   to after its feature.
10. **Delete** with nested sketches shows an inline group under the row (not a dialog, not a
    treeitem child of the tree root): "Delete sketch too", "Keep sketch", Cancel; Escape cancels.
    Both removals are one undo step (`onDelete(id, alsoIds)`).
11. **Setting.** "Show sketches in the history" (`whittle.nestSketches` = `flat`) lives in the row
    menu and the palette; the app owns the state and persists it with try/catch storage helpers.

## ADR-019 — M3 contracts (2026-11-08)

**Context.** The M3 contracts were written early, while the M2 deploy ran. M3 adds eleven feature types, linked sketch geometry and offset
dimensions, and every workstream implements against these contracts.

**Decision.**

1. **Order.** The PLAN order stands: M2.5 (connections, sync, version control) comes before M3.
   An earlier draft of this ADR put M3 first; the user confirmed M2.5 first. These contracts are
   additive and don't affect M2.5. M3's "versions/snapshots" item uses the M2.5 HistoryStore.
2. **New feature types** (`packages/contracts/src/document.ts`): `shell`, `draft`, `sweep`, `loft`,
   `mirror`, `linearPattern`, `circularPattern`, `hole`, `thread` (cosmetic), `axis`, `point`.
   Fillet and chamfer gain `propagate?: boolean` (absent means true, matching OCCT's default and
   M1 files).
3. **Reference geometry.** `plane` gains `threePoints`, `angle`, `normalToCurve`, `midplane` and
   `throughPoint` definitions plus `flip`. `axis` and `point` are first-class features with
   several definitions each (two points, an edge, a cylinder, two planes, a point and normal;
   coordinates, a vertex, a centre, a position along an edge, an intersection). Their names are
   `F…:axis`, `F…:point` and `F…:plane`, so they are referable like any other entity.
4. **Copies.** Mirror and both patterns share `CopySource`: either a list of features (re-applied
   as tool shapes, `shapes["tool:<id>"]`, with their ops in `values["/ops/<id>"]`) or whole bodies
   (optionally merged). Instance `k` names its entities `F…:inst<k>(N)`; mirrored ones
   `F…:mirror(N)`. `skip` lists suppressed instance indices, so removing an instance never
   renumbers the others.
5. **Holes.** `HoleFeature` places one or more points on a face (`frames["hole:i"]`) and refers to
   a standard table (`standards.ts`: ISO and ANSI rows with clearance per fit, counterbore,
   countersink and tap drill). The kind is simple, counterbore, countersink or tapped; explicit
   `diameter` overrides the table. Named roles: `:wall`, `:bottom`, `:tip`, `:cbore.wall`,
   `:cbore.floor`, `:csink`. A cosmetic `thread` records the standard and size on a cylindrical
   face; it changes no geometry, and M5 carries it into PMI.
6. **Linked sketch entities.** `EntityBase.source = { ref, approximate? }` marks an entity
   converted from a model edge or face outline. It is fixed for the solver and re-projected on each
   regen; a lost source is "needs attention" (ghost plus Re-pick), never a silent re-pick. Deleting
   `source` unlinks it. `approximate` flags a projection that had to be fitted (for example a
   B-spline edge seen at an angle).
7. **Offset dimension.** `DimensionConstraint` gains `{ kind: 'offset', sources, targets }`: one
   driving distance between a chain and its offset copy. Until the sketch package implements it, it
   is labelled and explained but reports "Offset dimensions are not supported yet", and the fake
   engine and the web helpers return no measured value.
8. **Expressions.** `exprFields` covers every new numeric field (counts and pattern parameters are
   `scalar`), and `entityRefs` covers every new reference, including linked sketch sources, so
   renaming, needs-attention and the nested tree work for the new types without per-type code.

**Consequences.** The JSON Schemas are regenerated (additive; `schemaVersion` unchanged because
every new field is optional or belongs to a new feature type). The fake engine reports the new
types as needing the real engine. The UI has names and icons for them; the inspectors arrive with
the UI workstream.

## ADR-020 — M2.5 contracts: connections, sync, history, merge, compare (2026-11-08)

**Context.** M2.5 (PLAN §8A, §12) follows M2. Mycelium (same author, GPL-3.0-or-later, so ADR-003
lets us port it) already has file-service adapters for Dropbox, OneDrive and WebDAV. It also has
an isomorphic-git repo wrapper, a two-way sync engine with a three-way merge, and a Cloudflare
Worker for the git CORS proxy, OAuth token exchange and WebDAV relay. Wren's canonical project
folder (`ProjectFiles`, docs/FILE_FORMAT.md) already exists. The contracts are in
`packages/contracts/src/sync.ts`; `ModelingApi.compare` and `RegenRequest.slot` are in
`modeling.ts`.

**Decision.**

1. **Two kinds of provider.** File services (`folder`, `dropbox`, `onedrive`, `gdrive`, `webdav`)
   implement `StorageProvider` and keep history with `SnapshotHistory`. Git hosts (`github`,
   `gitlab`, `bitbucket`, `forgejo`) don't pretend to be file stores: they use `GitHistory`
   (isomorphic-git), where versions are commits, branches are branches and releases are tags. This
   refines PLAN §8A.2's single interface, as Mycelium does, because git moves commits, not files.
2. **Errors are values** (`StorageResult`, `StorageErrorCode`), not Mycelium's thrown classes, so
   they cross the worker boundary like `KernelError`. Messages are human-readable and never contain
   a token.
3. **Optimistic concurrency everywhere.** A write or remove with `ifRev` succeeds only if the
   service still has that revision; `ifRev: null` means "create only". Nothing overwrites blindly.
4. **Sync** follows Mycelium's `syncFolder`: pull, then a three-way merge against the base, then
   push against the base's revision. Bases are stored as bytes keyed by SHA-256 hash. Mycelium's
   line merge is replaced by `DocMerger` on parsed documents, and non-JSON files (attachments,
   releases) conflict as whole files. The `.wren/` cache never syncs. The offline queue is
   `SyncState.pending`. Pushes are debounced (3 s); pulls happen on poll, focus and reconnect.
5. **Structural merge.** Arrays of items with ids merge as maps plus an order. Both sides editing
   the same leaf is a conflict (`bothModified`, `modifiedDeleted`, `bothAdded`), and two different
   reorders are an `order` conflict. `meta.modified` takes the later time. Conflict paths use ids,
   not indices. The merged document is always schema-valid. A reference the merge breaks shows up
   as "needs attention" on regen and is never silently re-picked. `DocDiffer` produces one-line
   feature diffs ("Fillet 3: radius 2 mm → 3 mm") from the same walk.
6. **Snapshot history** (`.wren-history/`) is append-only and content-addressed:
   - `versions/<id>.json` holds the metadata;
   - `snapshots/<hash>.zip` holds the packed files;
   - `refs/heads/<branch>/<versionId>` and `refs/releases/<name>` hold one empty file per head.

   Two devices adding versions offline therefore merge by union, never by conflict. A branch left
   with two heads shows as diverged and offers a merge. sync-engineer specifies the layout in
   docs/FILE_FORMAT.md. Named versions are never pruned. Automatic snapshots are pruned by
   `PrunePolicy`. A release is read-only.
7. **Credentials** live in `CredentialVault`, encrypted with a non-extractable AES-GCM key in
   IndexedDB. They are never in the document, never synced and never logged. A `Connection` holds
   no secrets.
8. **Geometric compare** runs in the kernel worker. `RegenRequest.slot` (`'main'` or
   `version:<id>`) keeps a second regeneration beside the live one, with its own cache.
   `compare(partId, a, b)` returns B − A (added) and A − B (removed) meshes, their volumes, and the
   mass and bounding box of each side. Implemented in kernel-client from existing façade
   operations (ADR-022).
9. **Hosted pieces.**
   - Dropbox and OneDrive need app registrations whose redirect URIs include Wren's Pages
     origin.
   - Git over HTTP from a browser always needs a CORS proxy, even with a fine-grained token.
   - Development uses the isomorphic-git public proxy. Production uses Mycelium's Worker, ported
     and restricted to Wren's origin.
   - These need the owner's accounts and settings; the app reads them from build-time config, and
     a missing key hides that provider instead of failing.

**Workstreams (PLAN §11.3).**

- **sync-engineer A:** `packages/sync` providers, `CredentialVault`, `SyncEngine` and OAuth PKCE,
  ported from Mycelium with its tests.
- **sync-engineer B:** `DocMerger`, `DocDiffer`, `SnapshotHistory` and `GitHistory`, plus the
  1,000-pair merge fuzz test.
- **modeling-engineer:** regen slots and `compare`, with kernel booleans and golden tests on five
  fixture pairs.
- **ui-engineer:** the connections panel, sync status chip, versions panel, branches, compare and
  merge UI.
- **platform-engineer:** the Worker port, `connect-src` and COEP for provider hosts, and the
  configuration plumbing.

## ADR-021 — Platform plumbing for sync: Worker, config, service worker rules

1. **Worker is a pnpm workspace package** (`@wren-cad/sync-worker`). Typecheck and `vitest` run under
   `pnpm -r` with the root toolchain and no extra dependencies. Wrangler is not installed: the
   scripts and docs use `npx wrangler@4.151.3`, so the lockfile and licence notices do not grow by
   the workerd binaries.
2. **Not `@isomorphic-git/cors-proxy`.** PLAN §8A.2 names that package; Mycelium's worker replaces it
   because it also does OAuth exchange and the WebDAV relay and is already tested. Its git proxy is
   stricter: three endpoints only, allow-listed hosts and origins, only git headers forwarded.
3. **Worker licence.** `worker/LICENSE` is the repository's GPL-3.0. Mycelium's `worker/` folder is
   Apache-2.0, so its licence text is kept in `worker/LICENSE-APACHE-2.0` with attribution in the
   file headers; the modified, combined worker is GPL-3.0-or-later (see the licence note below).
4. **Git proxy default.** `VITE_GIT_CORS_PROXY`, else `VITE_SYNC_WORKER_URL`, else, in development
   builds only, the public `cors.isomorphic-git.org` (marked `gitCorsProxyIsPublicDefault` so the UI
   warns that tokens pass through a third party). Production builds never use the public proxy:
   without one configured, git hosts are reached directly (M2.5 gate N4).
5. **OAuth redirect URI is the app base URL** (`https://jackhale98.github.io/wren-cad/`, with trailing
   slash), via `oauthRedirectUri()`. The service worker already serves the shell for any navigation
   in scope and preserves the URL, so no callback route or Pages 404 trick is needed.
6. **Service worker handles same-origin only, and never a request with `Authorization`**
   (`platform/sw-rules.ts`). Provider calls are cross-origin CORS fetches that no route matches;
   they bypass the worker, so COEP `require-corp` applies the browser's normal CORS check and they
   are never cached. E2E (`sync-plumbing.spec.ts`) proves this against a real second origin.
7. **No isolation reload on an OAuth callback load.** When the page URL carries `state` plus `code`
   or `error` and is not yet isolated, `initServiceWorker` skips the one-time isolation reload so
   the app can consume the code in this document; that session runs in fallback mode and the next
   load is isolated. Only the very first visit ever (no SW yet) is affected.

**Licence note (lead, 2026-11-08).** Mycelium's `worker/` is Apache-2.0, unlike the rest of
Mycelium, which is GPL-3.0. The port keeps Apache's licence text (`worker/LICENSE-APACHE-2.0`) and
attribution in the file headers. Wren's modifications and the combined worker are
GPL-3.0-or-later. Apache-2.0 code can be included in a GPL-3.0 work.

## ADR-022 — Regen slots and geometric compare without façade changes (2026-11-08)

**Context.** ADR-020 item 8 asks for regen slots and `ModelingApi.compare`. A C++ façade change
means a kernel rebuild in CI that takes about 30 minutes, and the façade already has a `boolean`
feature, `mesh`, `massProperties` and `release`.

**Decision.**

1. **Separate caches per slot.** Each `(partId, slot)` has its own `PartCache`: entries, latest
   state, ghosts, imports, `lastResolved` and revision. Main and a version slot don't share cache
   entries, even when they have features in common.
   - Isolation is then structural. Evicting entries in one slot can't release a shape the other
     slot uses, and main's hit counts and revision never move because of a version.
   - The cost is recomputing common features once per version slot.
2. **Memory.** Each part keeps at most 2 version slots by default (`maxVersionSlots`, minimum 1).
   The least recently used slot is evicted, and `regenerate` and `compare` both count as use. An
   evicted slot releases all its shapes. Each slot's cache uses the same `maxSpareResults` tier.
   Lowering the cap with `configureRegen` evicts at once rather than at the next regen, because
   memory pressure is the reason to lower it.
3. **Compare composes the `boolean` feature.**
   - A side with several solids is fused first (`op: 'add'`, target plus `tools…` shapes).
   - Then come two cuts: union(B) − union(A) and back.
   - The union matters: overlapping bodies would otherwise count their overlap twice in mass, and
     the per-body diffs would double-count too.
   - The result is one mesh per non-empty difference. A compound can hold several disjoint
     regions, and the façade has no call to split it into solids.
4. **Identical keys skip the booleans.** If both sides' solid bodies have the same content keys,
   they came from the same feature definitions, values and inputs, so their geometry is
   identical. compare returns an empty diff without running OCCT. If the geometry is identical but
   the definitions differ, the booleans still run, and OCCT returns empty results (tested).
5. **Noise threshold.** A difference with no faces, or with a volume at most 1e-9 of the larger
   side's volume, is reported as empty with volume 0, never as an error. On the fixtures OCCT
   returns exactly empty cuts, so the threshold is only a guard against sliver noise along
   coincident faces.
6. **Bodies left out.** Mesh-only reference bodies can't take part in a boolean, and sheets have
   no volume. Both are skipped, with a warning on `CompareOutput.warnings`, which is proposed for
   `GeometricDiff`.
7. **Selection stays on main.** `refFor`, `measure` and `exportPart` keep their signatures and
   always read `'main'`.

## ADR-023 — Sync engine details (M2.5 sync A)

**Context.** ADR-020 §4 fixes the shape of sync (Mycelium's `syncFolder`, `DocMerger`, bases by
hash). Porting it to a whole-document merge and to bytes raised several choices the ADR leaves
open. Mycelium (GPL-3.0-or-later) is ported per ADR-003; each ported file carries a provenance line.

**Decisions.**

1. **Edits are found by hashing, not only by `pending`.** Each round hashes the working copy and
   compares it with the bases' SHA-256, so an edit is never lost even if the queue was (a crash
   before `notifyLocalChange` persisted). `SyncState.pending` is still persisted (the offline
   queue and the status count) and is recomputed at the end of each round.
2. **Document files are the manifest, `params.json` and every file a base, local or remote
   manifest references.** The structural merge runs only when one of them changed on both sides;
   a clean merge rewrites them with `toFiles`, so slug renames and removals follow the merged
   document. Unreferenced `*.json` files are plain files (whole-file rules).
3. **Unresolved conflicts hold the cursor.** The cursor isn't advanced while conflicts are open,
   so every round re-reads the conflicting files and offers them again (and offers the newest
   remote edit). All document files are held back from upload while a document merge is
   conflicted, not just the conflicting ones, so the remote project stays consistent.
4. **A push `CONFLICT` marks the base stale** (`STALE_REV`, persisted): the next round re-reads
   that file directly whatever the listing says, merges, and only then pushes. `syncNow` runs up
   to four rounds, so a raced push usually converges within one call.
5. **Local writes are compare-and-swap** (`SyncLocalStore.writeFiles(changes, expected)`): a save
   during a round makes the round abandon (nothing committed) and run again. A hook
   (`onBeforeOverwrite`) receives the working copy before sync replaces or deletes local files, for
   an automatic local snapshot.
6. **Push order:** referenced files, then `params.json`, then the manifest, deletions last; a
   conflict on one document file stops the rest of the document's push that round. A device that
   lists midway (manifest naming a part not yet uploaded) gets `REMOTE` "isn't a complete project
   yet" and retries without committing.
7. **Rules for files:** every file syncs except `.wren/`, `.git/` and OS clutter (`.DS_Store`,
   `Thumbs.db`, `desktop.ini`, Office `~$` and LibreOffice `.~lock.` files). An edit beats a
   concurrent deletion (nothing is lost; Mycelium's rule). `remove(path, null)` succeeds only if
   the file is absent, matching `ifRev: null` = "only if it doesn't exist".
8. **Whole-file conflicts** use `MergeConflict` with id `file:<path>`, kind `bothModified`, `path`
   = the project-relative file path (not a JSON pointer), `subject: { kind: 'doc', label: path }`
   and the bytes as `base/ours/theirs`; `fileConflictPath()` tells them apart. See the contract
   proposal in the sync A report.
9. **Focus follow-up.** After a focus sync the engine checks once more 8 s later, so a change
   still inside the other device's 3 s debounce appears within 10 s of focusing (M2.5
   acceptance).
10. **OAuth.** Full-page redirects (COOP severs `window.opener`, ADR-010). Tokens go straight from
    the token response into the vault; `sessionStorage` holds only the PKCE verifier and state
    (15-minute expiry) and a non-secret result. The callback query is stripped only after the
    tokens are stored. Scopes: Dropbox `account_info.read files.metadata.read files.content.read
    files.content.write`; Microsoft `Files.ReadWrite` (own drive) and `Files.ReadWrite.All
    Sites.Read.All` only when SharePoint is asked for; Google `drive.file`.
11. **Vault.** One non-extractable AES-GCM-256 key per profile in IndexedDB, created once inside a
    transaction (two tabs agree on one key); a fresh 96-bit IV per write; the connection id is the
    AAD. A record that fails to decrypt reads as signed out.
12. **Folder provider revisions are `lastModified:size`,** checked just before writing (the File
    System Access API has no compare-and-swap); the race left is a desktop client replacing the
    file in that instant.

## ADR-024 — Google Drive (M2.5 sync A)

**Context.** Google's web-application OAuth clients need a client secret to trade a code, and
Google Identity Services would break self-hosting and COEP (lead, 2026-11-08).

**Decision.** Google sign-in uses the same redirect + PKCE flow, but the code and refresh token
are traded through the Worker (`/oauth/google/token`, `/oauth/google/refresh`, the same shape as
the git hosts' routes) via an injected `TokenExchange`. The Drive v3 provider is a typed stub
(`GDRIVE_AVAILABLE = false`) for now. Before building it: Drive v3 has no `If-Match` on media
updates, so optimistic concurrency would be check-then-write on `version`/`headRevisionId` (a race
window the other providers don't have), and `drive.file` means the folder picker must be Google's
Picker, not `browse()`.

## ADR-025 — M2.5 sync UI: controlled panels, inline flows, compare tokens

- **Presentational and controlled.** `ConnectionsPanel`, `SyncStatusChip`, `VersionsPanel`, `ComparePanel` and `MergePanel` take props and callbacks only. The add-connection flow is inline (provider, sign-in or fields, folders): the panel owns the typed fields and the current step, the host supplies `signingIn`, `browse` (the folder step) and `addError`. Removing a connection and marking a release also confirm inline, never in a dialog.
- **Provider icons are generic lucide icons**, never brand logos. Providers without an app key are shown disabled with the host's reason, not hidden, so the user knows why.
- **Compare colours.** New tokens `compare.added` / `compare.removed` (plus `-soft` fills), light and dark, each at least 4.5:1 on surface and on its soft fill. The added colour leans teal-green and the removed one orange-red, with different lightness, and both always carry a + or − glyph, so colour-blind users are not left relying on hue.
- **⌘S / Ctrl+S** (apps/web saves the project file on it, workbench `onKey`) is handled only while focus is inside the versions panel: it focuses the "Save version" field, or saves from it. It calls `preventDefault`, so the app-level handler yields. A global "save version" binding is the lead's call.
- **Diff subject icons** are inferred from the label's first word ("Fillet 3" is a fillet); hosts can pass `featureType`. Proposed contract field: `DiffSubject.featureType`.
- **ExpressionInput `largeText`** is opt-in (16 px on touch) so existing baselines are unchanged; the merge panel uses it.
- Panels use `density="touch"` (44 px targets, 16 px inputs) in the tablet and phone bottom sheet. They are not yet registered as shell tabs: that wiring belongs to apps/web.

## ADR-026 — Structural merge details (sync B, M2.5)

**Context.** ADR-020 item 5 fixes the merge rules at a high level. Implementing them on every
array and union in `document.ts` and `sketch.ts` needed several decisions the contract leaves open.
The 1,000-pair fuzz test made the gaps concrete.

**Decision.**

1. **Union variants merge whole.** An object whose `type`, `kind` or `shape` differs between any
   two versions is a single leaf, and so is a material whose `libraryId` differs. Merging the
   fields of two variants (an extrude `end` that is `throughAll` but keeps a `depth`) would break
   the schema. Entity references (`{name, kind, fingerprint}`) are always leaves, because a name
   and a fingerprint belong together.
2. **Order is merged on the items all three versions share.** The side that reordered them wins.
   Two different reorders, or the same new id placed differently by each side, are one `order`
   conflict per list. Added items are woven in after the nearest preceding shared item of their
   own version. Runs inserted at the same place are ordered by their first id (ULIDs: oldest
   first), so `merge(b, x, y)` and `merge(b, y, x)` give the same document when nothing conflicts.
   A delete wins over a move of the same item; that is not a conflict.
3. **`rollbackIndex` merges as "the bar sits before feature X".** It is mapped back to an index
   afterwards. As a number, features added on both sides would end up rolled back.
4. **Parameter names stay unique.** A name that only theirs introduced, by adding or renaming a
   parameter, and that clashes in the merge is a conflict on theirs' parameter. Taking "theirs"
   there throws `MergeResolutionError`; the user types a new name instead. `meta.created` takes
   the earlier time, and `meta.app` follows the later edit.
5. **`resolve()` re-runs the merge with the user's choices.** It does this when it has the result
   `merge()` returned (held in a `WeakMap`), so a restored feature returns to its own place.
   Resolving every conflict to "theirs" gives exactly `merge(b, theirs, ours).doc`, and the fuzz
   test checks this. A structured-cloned result falls back to patching by path. Choices that would
   make an invalid document throw. Conflict ids are `<kind>:<pointer>`, deterministic across runs.
6. **Whole projects.** `mergeProjectFiles` merges the model files with `DocMerger` and every other
   file as bytes. File conflicts share the result's `conflicts` list at `/files/<path>`, with
   `{ sha256, size }` per side. `resolveProjectFiles` applies both kinds. The sync engine can use
   the same function.

## ADR-027 — History backends (sync B, M2.5)

**Decision.**

1. **Snapshot history.** Automatic snapshots hang off the branch head and never become heads.
   Pruning them therefore can't disconnect the version graph, and named versions keep a clean
   chain. Releases are `refs/releases/<name>/<versionId>` files holding their metadata. They are
   not empty, but they are still immutable and union-safe. If a name was released twice offline,
   the earliest stands.
2. **The hash is SHA-256 over `path, length, bytes`**, not over the zip. Content identity then
   doesn't depend on fflate's DEFLATE output (FILE_FORMAT §9.3).
3. **`log` is topological**: children come before parents, and the newest of the ready versions
   comes first. Ordering by timestamp alone put a merge below its parent when two devices' clocks
   disagreed.
4. **GitHistory takes an injected isomorphic-git `fs`, `dir` and optional `gitdir`.** This is for
   a later "local git repo" mode over the user's own checkout through File System Access.
   - Without a remote, history works fully, and fetch, pull and push return a clear `NOT_FOUND`.
   - Refs, the index and the working tree are read on every call. `refresh()` drops cached
     packfile reads.
   - Wren only writes the paths it owns (model, `imports/`, `previews/`, `releases/`), so a
     README or CI config in the repository is never deleted or overwritten by a save.
5. **Git fetches all refs with tags.** isomorphic-git's `singleBranch` fetch never requests
   annotated tag objects, so releases made on another device would not arrive. Project
   repositories are small.
6. **Git automatic snapshots are local commits** under `refs/wren/auto/<oid>`. They are never
   pushed, so a GitHub history only shows the versions people named.
7. **Tests use LightningFS on fake-indexeddb** (the production fs, in memory) and a real
   `git http-backend`, as Mycelium's tests do.

## ADR-028 — Viewport compare overlay (M2.5)

- **Palette.** Added `#00a878` / removed `#c2410c` on light; `#3ddc97` / `#ff6a2e` on dark (bluish green and vermillion-leaning red, Okabe-Ito family). The pair differs by > 0.08 relative luminance in both themes (unit-tested), so protan/deutan viewers still separate them; edge style is a second, colour-free cue (added = solid edges, removed = dashed). Fills are 45 % (added) and 38 % (removed) opaque. Values live in `packages/viewport/src/compare.ts` (`COMPARE_COLORS`), because the `compare.added`/`compare.removed` tokens named in the contract do not exist in `@wren-cad/ui` yet; proposal: the UI package adopts these values and the viewport test asserts parity like it does for `OVERLAY_COLORS`.
- **Depth.** Ghosted bodies are transparent and write no depth, so the added fill is simply depth-tested (reads as solid, edges stay crisp) and the removed fill and dashed edges are drawn with the depth test off: removed material lies inside the old body and must show even if a caller sets `ghostOpacity: 1` (an opaque body would hide it). Cost: removed regions show through the added block, acceptable for a diff view.
- **Ghosting is derived, not stored.** `display.opacity` is never mutated; the drawn opacity is `min(own, ghost)` while an overlay is set, so `null` restores opacity, `transparent`, `depthWrite` and colour exactly. Body edges fade toward the background while comparing. Only a first set, a ghost change and `null` touch body materials; `show` toggles flip group visibility and a re-set with the same mesh arrays (identity) reuses GPU buffers.
- **Materials.** Fills and lines go through `sharedMaterial` (no shader work on toggling or re-setting); geometry is disposed on replace and remove.
- **Picking and clipping.** The overlay lives in the clipped body root but not in the ID scene or body map, so it is never picked and section planes clip it. Section caps are not drawn for overlay meshes.
- **Fit.** `fitAll` stays bodies-only; the engine adds `fitAll(animate, { includeOverlay: true })`. Proposal for the contract: add the optional second parameter to `Viewport.fitAll`, or have the app call it after `setCompare`.
- **Reduced motion.** There is no animation: ghosting and toggles are instant.
- **Perf on software GL.** Once the studio environment exists, any camera or state change costs 150-400 ms wall time on SwiftShader (also for a plain camera move), so the perf probe gates handler time (<= 16 ms p95) and reports render CPU time, gated with `WREN_PERF_ASSERT=1`.

## ADR-029 — Local git repo mode (M2.5, owner request 2026-11-08)

**Context.** Desktop users who already keep projects in git want Wren's versions to be their
repo's commits, not a parallel `.wren-history/`. The owner asked for this in M2.5.

**Decision.**

1. **Detection.** A `folder` connection (File System Access, desktop Chromium) whose picked
   folder contains `.git/` is a local git repo (`Connection.git = true`). The user picks the
   **repo root**, because File System Access can't walk up from a subfolder. The project is a
   folder inside it (`ProjectLink.path`, relative to the root, `''` for the root). Several
   projects can live in one repo.
2. **Working copy.** The project files on disk *are* the working copy. Wren saves to them
   directly (the folder provider and SyncEngine with no remote). No `.wren-history/` is written
   in this mode, and `.wren/` is added to the repo's `.gitignore` if it isn't already ignored
   (with the user's go-ahead shown inline).
3. **History.** `GitHistory` runs over a File System Access adapter for isomorphic-git's `fs`,
   with `dir` = the repo root and versioned paths limited to the project folder.
   - "Save version" makes a real commit of the project's files only; other changes in the repo
     are left alone.
   - Branches are the repo's branches, and releases are tags.
   - `workingChanges()` shows "Uncommitted changes".
   - `refresh()` and a re-read on window focus pick up commits, checkouts and repacks made by the
     user's own git.
4. **Remotes.** Pushing and pulling can stay with the user's git tools. When the repo has a
   remote (`remotes()`) and the user signs in to its host, Wren can also fetch, pull and push
   through the CORS proxy.
5. **Safety.**
   - Before switching branches or fast-forwarding, Wren refuses if the project has
     uncommitted changes (`workingChanges()`), and offers "Save version" first. It never
     force-checks-out over edits.
   - A repo mid-merge, mid-rebase or with a detached HEAD is shown read-only, with an
     explanation.
   - Git LFS pointers are left alone, and hooks don't run when Wren commits; both are stated
     in the UI.
6. **Browsers.** Desktop Chromium only, because Firefox and Safari have no directory picker.
   Elsewhere, local git mode is hidden with that reason, and hosted git connections still work.

## ADR-030 — Local git repo mode: the package layer (sync, ADR-029)

**Context.** ADR-029 makes a picked folder with `.git` the project's history. Doing that through
isomorphic-git over File System Access, in a repository the user also works on with their own
git, raised choices ADR-029 leaves open.

**Decision.**

1. **Commits are built from tree objects, not the index.** Wren writes the project's blobs,
   builds the project folder's tree and splices it into the parent commit's tree, rewriting only
   the trees on the path (one write per tree, nothing left dangling). Whatever else the user has
   staged or edited is neither committed nor touched. Hosted connections use the same path.
2. **Write order and compare-and-swap.** The steps are:
   - a preflight: each working file the commit changes must still hold the replaced commit's
     content, or already hold what is being committed. Anything else is someone's edit, so the
     commit is refused with `CONFLICT` and nothing is written. CRLF checkouts under
     `core.autocrlf` and smudged LFS content count as unchanged;
   - write the working files, skipping files whose bytes are already right, so the folder
     provider's `lastModified:size` revisions don't move for nothing;
   - write the commit object;
   - move the branch only if it still points where it did (`CONFLICT` if another git committed
     meanwhile);
   - update the index entries of the changed paths, with the files' own stats.

   File System Access has no exclusive create or rename, so Wren can't take git's
   `index.lock`. It refuses to start while one exists, and the remaining race is the instant
   between the check and the write (as in ADR-023 item 12).
3. **Never a forced checkout.** `switchBranch` and fast-forward `pull` refuse with `CONFLICT`
   while `workingChanges()` lists anything. They then check out without `force`, so another
   file's local edits that the switch would replace refuse it too (isomorphic-git's
   `CheckoutConflictError`, mapped to `CONFLICT` with the paths), and edits to files that are
   the same on both branches carry over, as in git. A fast-forward checks the tree out before it
   moves the branch. Hosted and local-only histories follow the same rules.
4. **Automatic snapshots are objects plus a ref.** Their commits go under
   `refs/wren/auto[/<project>]/<oid>` and change neither the branch, the index nor the
   working tree, so they never show as staged changes in the user's git and never block a
   switch.
5. **Scoping by `projectPath`.**
   - Files read back are project-relative.
   - `log()` is git's history simplification for the folder (`git log -- <folder>`): a commit is
     kept unless its project tree equals a parent's, and parents are rewritten to the nearest
     kept ancestors, so the graph stays connected. The interleaving test checks it against the
     CLI after every step.
   - Releases are tags named `<projectPath>/<name>`, so two projects can both have a "Rev A".
     The root project keeps unprefixed tags and lists all of them.
   - New files the repository ignores are left out of a commit, as `git add` would.
6. **Merges in a multi-project repository** also merge everything outside the project, whole
   file by blob id, so a pull or `commitMerge` never reverts the other side's changes to other
   projects. When both sides changed the same outside path, or a submodule or symlink, the
   merge is refused (`CONFLICT` / `UNSUPPORTED`) and left to the user's git tools, because the
   merge panel can't show those files.
7. **Status without rehashing.** `workingChanges()` walks HEAD, the working tree and the index
   for the project folder only. A file is clean, without being read, when its index entry has
   HEAD's blob and the same size and millisecond mtime. That works against an index the git CLI
   wrote, because inode, ctime and owner (which File System Access lacks) aren't compared. A
   file modified at or after the index's own mtime is hashed ("racy git"). isomorphic-git's
   `statusMatrix` rehashes once against a CLI index and is stats-only after its refresh.
8. **Finding the repository.**
   - A `.git` file (`gitdir:`) works when its target is inside the picked folder.
   - A linked worktree's `commondir` is supported by an fs view that serves per-worktree files
     (HEAD, index, MERGE_HEAD…) from the worktree's git directory and the rest from the common
     one, following git's `common_list`. isomorphic-git has no `commondir` support of its own.
   - Absolute targets, which `git worktree add` and submodules write, are `UNSUPPORTED`, with
     the reason.
   - A bare repository and SHA-256 repositories are detected: bare opens read-only, SHA-256 is
     `UNSUPPORTED`.
9. **Read-only states** are checked fresh before every write: merge, rebase, cherry-pick,
   revert, bisect, a detached HEAD, a bare repository, `index.lock`, and an index version other
   than 2. The refusal code is `CONFLICT`, with the explanation from `state()`. Proposal: a
   dedicated `READ_ONLY` code.
10. **LFS.** A smudged checkout counts as unchanged when its SHA-256 is the pointer's oid, and a
    commit keeps the pointer blob as it is. A changed LFS file is refused with `UNSUPPORTED`
    (Wren runs no clean filter). `read()` returns the pointer bytes.
11. **No symlinks.** `readlink` and `symlink` reject with `ENOENT` or `ENOTSUP`.
    isomorphic-git writes checkout files in parallel and only reports failures at the end, so a
    switch or fast-forward that would create or replace a symlink is refused (`UNSUPPORTED`)
    before anything is written (`symlinks: false`, which local mode sets).
12. **Reflog.** Wren appends git-format reflog entries for its commits, branch switches and
    fast-forwards when the repository keeps reflogs (`logs/` exists), so `git reflog` can always
    get back to an earlier state.

## ADR-031 — M2.5 integration in apps/web

1. **The library entry is the sync working copy.** `SyncLocalStore.readFiles` is the entry's
   canonical document files plus its extra files (never `.wren/`); `writeFiles` is a
   compare-and-swap run under the same lock as autosave (`libLocked`). Sync may replace the open
   document only when it is exactly the object last written to the library (no pending or
   in-flight save, no unsaved history files) and the user is not mid-edit (sketch session,
   push/pull drag, pointer down); otherwise it refuses, the app saves what is on screen (or waits
   for the edit to end) and the engine merges again. Without this an autosave queued behind a
   sync write could overwrite the merged result and the next push would drop the other device's
   edit.
2. **The merged document is loaded at the commit point, not when `SyncOutcome.files` arrives.**
   It is applied inside `writeFiles`, where it is atomic with saves, as one `patch` command
   ("Changes from another device") built with `diff`; the patch always sets `meta.modified` to
   the merged value and is not autosaved, so devices never ping-pong a fresh timestamp.
   `SyncOutcome.files` is then already on screen.
3. **Connections and links live in localStorage** (`whittle:connections`, `whittle:links`,
   `whittle:history-state:<id>`): small, never secret (tokens are only in the vault), and read
   synchronously at boot to decide whether the sync chunk is needed for the opening document. The
   contract says a `ProjectLink` is "stored with the library entry"; proposal: reword to "stored
   on this device beside the library entry".
4. **Git hosts link a repository, not a folder.** The token form gained a Repository field
   (`owner/name` or a full HTTPS URL); `ProjectLink.path` is the clone URL and the clone lives in
   `whittle-repo-<libraryId>`. The folder step shows that one repository: an empty one links the
   open project (first commit and push), one with commits opens as a new library project.
   Credentials are stored without an empty username, so GitHub always authenticates as
   `x-access-token`.
5. **Local git repo mode uses the same engine.** The project folder on disk syncs with the library
   entry through a `SyncEngine` whose provider is a `FolderProvider` over the picked root (no
   remote service), so outside edits are pulled on focus like any remote change, and
   `openLocalGitRepo` (ADR-030) commits it, scoped to the project folder (the root or any folder
   inside the repo; the folder step can also create one). The repo is opened without network
   access, and reopened with it only when `origin` is an HTTPS remote on a host the user signed in
   to in Connections; otherwise the panel says to push with their own git. `READ_ONLY` refusals
   show the `state()` explanation inline; `CONFLICT` (an outside edit or commit meanwhile) offers
   **Refresh**, which re-reads the repo and syncs the folder before the user retries.
6. **"Current" means content, not ancestry.** The versions panel marks a version Current only while
   the working copy's content hash equals it, so the version a user edited away from can be
   compared with what is on screen.
7. **Releases are of the current state only.** A release freezes `exportPart` (main slot) output, so
   it is refused unless the working copy is exactly that version (restore first).
8. **Test seam.** `globalThis.__wrenSyncOverrides` (set by a Playwright init script) rewrites
   provider origins to fakes, supplies public app keys the CI build lacks and replaces
   `showDirectoryPicker` (OPFS in E2E). Only script already in the page can set it; such script
   could read the vault anyway.
9. **Bundle.** The status chip and version button are a 2.4 KB lazy chunk; the controller chunk
   (`@wren-cad/sync`, isomorphic-git, merge, panels' logic) is ≈ 130 KB gzip and the panel chunk
   ≈ 15 KB, both loaded on first use. The initial route grew by ≈ 2.6 KB (workbench glue).
10. **Picked folders are cached in memory for the session.** `saveFolderHandle` still persists them
    for reloads, but the controller reuses the handle it was given instead of reading IndexedDB
    on every engine start. In this headless Chromium build, reading an OPFS directory handle back
    from IndexedDB takes the browser down (the put is fine), which the local-git E2E would
    otherwise hit; real picker handles are unaffected.
11. **A callback is ours only if this tab started a sign-in.** Boot completes a sign-in when the
    URL has `state` plus `code` or `error` *and* sessionStorage holds the pending PKCE record.
    A stray or bookmarked `?code=` is left as it is (the platform plumbing spec relies on this)
    and doesn't load the sync chunk.

## ADR-032 — Renamed from Whittle to Wren (Wren CAD) (2026-11-09)

**Context.** An unrelated open-source parametric CAD project on OpenCascade, also called Whittle
(MPL-2.0, browser and desktop), launched on GitHub on 2026-10-14, a month before this one. Sharing
a name in the same category would confuse users, search and issue reports. The owner chose
**Wren**, matching the bird mark, with **Wren CAD** where the name must be unique: the repository
`wren-cad`, the Pages path `/wren-cad/`, and the install name.

**Decision.** `scripts/rename-to-wren.py` rewrites the tracked files in one repeatable pass. It runs
on any branch that predates the rename before that branch is merged.

- **Renamed.**
  - Product and UI text: "Wren", or "Wren CAD" for the install name, title and README.
  - Package scope `@wren-cad/*` and type names (`WrenDoc`, ...).
  - Test hooks (`__wren*`) and environment variables (`WREN_*`).
  - The file format: `.wrencad` archives, `wren.project.json` with `format: "wren-project"`, and the
    `.wren/` cache and `.wren-history/` folders.
  - Schema files, `$id` URLs and docs.
  - Previous ADRs and CHANGELOG entries are rewritten as well, so the record reads consistently.
- **Kept, on purpose:**
  - Browser storage names and keys (IndexedDB databases such as `whittle-library`, localStorage and
    sessionStorage keys such as `whittle.theme` and `whittle:links`, service-worker cache names),
    and the OPFS library file names (`<id>.whittle`). The new Pages path is on the same origin, so
    existing libraries and settings survive the move.
  - Material library ids inside documents (`whittle:aluminium-6061-t6`), which are stable data ids.
  - The kernel's internal C++ and Wasm names (`whittle_*.cpp`, `whittle::`, `WhittleKernelModule`,
    `whittle-kernel*` artefacts). Renaming them would force a full kernel rebuild for no
    user-visible change; they may be renamed later.
- **Old files still open.** `.whittle` archives, `whittle.project.json`, `format: "whittle-project"`
  and a `.whittle/` cache folder are all read; files are always written with the new names.
  Automatic snapshots in local git repos written under `refs/whittle/auto/` before the rename are
  still listed and pruned; new ones go under `refs/wren/auto/`.
- **Every base-path use reads `WREN_BASE`** (build, E2E server and specs, Lighthouse CI config):
  the rename script turned a `/whittle/` that followed a digit into `/wren/`, and specs that
  hard-coded `/wren-cad/` broke on CI, which still builds at `/whittle/` until the repo is renamed.
- **Pages base path.** CI derives the base from the repository name
  (`/${{ github.event.repository.name }}/`), so the deploy works before and after the owner
  renames the repository on GitHub. After the rename, sign-in redirect URIs must change to
  `https://jackhale98.github.io/wren-cad/` (docs/SYNC_SETUP.md), and installed home-screen copies
  need reinstalling from the new address.
- **Done 2026-11-09:** the owner renamed the repository to `jackhale98/wren-cad`. The first build
  after the rename deploys at `/wren-cad/`; the build that ran just before it still referenced
  `/whittle/` assets, so the site was blank at the new address until that redeploy.

## ADR-033 — Offset dimension: solver rows and sign (sketch editing, M3)

1. **Sign (contracts, lead's convention).** Positive = right of the source's direction (outward
   of a CCW loop). The value's sign places the *reference pair* (the first pair whose source is a
   curve) exactly; every other pair keeps its side relative to the reference pair as read from
   the geometry handed to the solver. One value then drives a chain whose sources run different
   ways and both sides of a two-sided offset; flipping the sign flips all sides together, so the
   relative reading is stable from solve to solve. Zero is refused (no side). `offsetEntities`
   puts a right-hand pair first when there is one and otherwise stores the expression negated
   (`-5 mm`, `-(wall + 1 mm)`). Reference offsets measure signed.
2. **Rows.** Lines: both ends at the signed distance; arcs: concentric + radius r ± d; circles the
   same; join and cap arcs are `point → arc` pairs (centre on the source corner, radius |d|).
   A free chain end also lies on the source's normal through the matching source end ("square
   end"), so the offset follows the source's length. Where two targets meet tangentially, "on
   both" is degenerate (rank-deficient), so the joint keeps one membership plus the square end;
   lines give theirs up first, an arc at most one (its radius row and arc rule are its two). This
   keeps DOF exact: an offset adds no DOF and no redundancy (tested on lines, rectangles, slots).
   planegcs gets matching primitives; its point–line distance is unsigned, so the square end is
   a signed `l2l_angle_pppp` (±90°).
3. **Downstream solve.** When nothing but offsets (and the offset arcs' own arc rules) constrains
   the offset geometry, the sources are solved by planegcs without it and the offset geometry by
   sparse Gauss–Newton on the offset rows with everything else held. A 202-entity offset chain
   dragged went from ≈ 130 ms to ≈ 0.6 ms median (planegcs solved the whole chain densely). A user
   constraint on offset geometry, or dragging it, falls back to one joint solve; a joint solve that
   fails retries Newton on our signed rows (planegcs can settle on the wrong side).
4. **Geometry.** Convex corners get an arc around the source corner (`corners: 'sharp'` extends
   line–line ones); concave corners trim to the nearest carrier intersection. Arcs whose radius
   would be ≤ 0 and curves the trims turn inside out are left out with a note and their
   neighbours joined; results that cross themselves are refused; the built geometry must satisfy
   the solver's rows exactly or the call refuses. A seeded fuzz (400 random chains) checks this.

## ADR-034 — Linked (converted) entities in the solver and editing operations

1. **Fixed.** Entities with `source` are grounded in `buildModel` (all their parameters), like
   `fix`. Conflict search frees them (new `unlinked` model option) to find the minimal linked set
   that makes a conflict, lists it in `SketchConflict.fixed` and says "while Line 1 is linked to the
   model". No fix is offered for them yet (no `unlink` action in `SuggestedFix`).
2. **Re-projection keys on `ref.name` only.** Missing name → `lost` (entities untouched, still
   fixed); never matched to another edge. An exact entity keeps its id and, if the edge changed
   kind, changes kind in place with a note. A line keeps the orientation that moves its ends
   least. Approximate chains (fitted polylines) keep every entity: vertices move to the same
   fraction of length along the fresh polyline and arcs re-fit through their ends and middle.
3. **Arc `start`/`end` in projected curves** accept angles (rad) or points on the circle.

## ADR-035 — Trim, fillet/chamfer and mirror rewiring

1. **Trim** attaches new ends with `coincident` (on another entity's end) or `pointOn`; a middle
   trim splits, the new piece tied by `pointOn` × 2 (lines) or `equal` with a shared centre
   (arcs), and tangency moves to the piece that still touches. Dropped and reported: constraints
   on end points that were trimmed away or moved, a shortened line's `length`, `equal` length,
   `midpoint` and own h/v extent, and an offset pair whose target was trimmed. A circle becomes an
   arc with the same id. Nothing to trim to deletes the entity. Linked geometry is refused.
2. **Fillet/chamfer** keep the old corner as a construction "virtual sharp" (pointOn both curves)
   when anything refers to it (always for chamfers, whose distances are measured from it): a
   line's `length` becomes the distance from its far end to the sharp, its h/v extent and
   `midpoint` are rewritten onto it, so intent survives. Equal length is dropped and reported.
3. **Mirror** shares points that lie on the mirror line. "Mirror move" (originals removed)
   carries constraints over: reflection-invariant kinds as is, angles with their lines swapped,
   h/v distances swapped across a perpendicular axis, h/v constraints only for axis-aligned
   mirror lines; `fix` and anything mixing moved and unmoved geometry are dropped and reported.
4. **Entry point.** `@wren-cad/sketch/edit`, like `./recognize`, so the app's initial route does
   not load it.

## ADR-036 — M3 regen: copies, reference geometry, linked entities (modeling workstream)

**Context.** ADR-019 fixed the M3 feature types and the FeatureInputs keys. The regen engine
(packages/kernel-client `src/regen`) has to supply those inputs, keep every copy feature's tool
solids, resolve reference geometry the façade has no call for, and re-project linked sketch
entities, without ever guessing a reference.

**Decision.**

1. **Tool-shape cache.** Each solid feature (extrude, revolve, primitive, sweep, loft, hole)
   registers a `ToolSpec` when it evaluates ok: a key, its op code (`new`/`add` 0, `cut` 1,
   `intersect` 2) and a thunk that builds the tool (the feature alone, op `new`; a hole without
   `target`). The tool is built **lazily**, only when a mirror or pattern copies that feature, and
   stored as its own cache entry. Its key hashes the tool's own inputs (definition without op and
   scope, values, refs as content keys, frames), not the body it acts on, so editing the pattern
   or an unrelated part of the body reuses it, and editing the feature or anything it reads
   rebuilds it. Tool entries use the normal LRU (`maxSpareResults`); a pattern marks them used.
   Features that were never copied never pay for a tool.
2. **Copy targets.** Feature copies act on the one body their source features produced or
   changed (more than one is an error suggesting body copies); a copied feature that failed is
   `blocked`, one that is suppressed, later, or has no tool (fillet…) is an error, and a deleted
   one needs attention at `/source/features/i`. Body copies with `merge` keep the first source
   body's id and consume the others; without `merge` each copy is a new body, `B<featureId>` for
   one copy and `B<featureId>:<key>` (the kernel's `FeatureResult.bodies[].key`) for several.
3. **Pattern instances never rebind.** The fingerprint-only step of §7.3 never resolves a ref to
   `F<p>:inst<k>(N)` onto a sibling `inst<j>`, nor a ref to `N` onto one of its copies
   (`isOtherCopy`). Lowering a count or skipping an index makes refs to the removed instance
   "needs attention" even when another instance now sits exactly where it was. Counts must be
   whole numbers ≥ 1; skips outside `1…total-1` are ignored with a warning.
4. **Reference geometry in TypeScript.** Axes, points and the new planes are computed by the
   engine (`datums.ts`) from fingerprints and exact `measureShapes` closest points: straight
   edges (end points by probing; direction from the smaller geometric key), circles (circumcentre
   of probe points), cylinder axes (surface normals at probe points), sphere centres. Canonical
   senses and a 1e-10 snap keep cache keys stable. Axes and points have no kernel shape: they are
   frames in the walk state, referable as `F…:axis` / `F…:point` (revolve, patterns, holes, planes,
   sketches); new plane definitions reach the kernel as `{ kind: 'frame' }`, and the kernel never
   sees `flip` (the engine applies it). A position along a curved edge is `UNSUPPORTED_FEATURE`
   until the façade can evaluate curves.
5. **Sweep paths** are chained in the engine and passed in chain order: the feature's `path` is
   reordered to match, so `refs['/path/i']` stays a JSON pointer into the feature the kernel gets.
6. **Holes.** `frames['hole:i']`: origin = the point projected onto the face plane (a point more
   than 1e-6 × diag off it is an error), z = −outward normal, x from `planeFrame`. Table values are
   written at the feature's own pointers (`/diameter`, `/counterbore/*`, `/countersink/*`,
   angles rad), so the kernel reads one place whether the value came from the table or the user.
7. **Linked sketch entities.** Before a sketch solves, each distinct `source.ref` is resolved once
   (§7.3) and projected onto the sketch plane: the kernel's `projectEdges` / `projectFaceOutline`
   when present, else in TypeScript for reference geometry, other sketches' curves, straight edges
   and circles parallel to the sketch (others are `UNSUPPORTED_FEATURE`). The curves go to a
   `ReprojectLinked` function — packages/sketch's `reprojectLinked` once it lands, wired through
   `RegenEngineDeps.reprojectLinked`; `reprojectLinkedFallback` until then. Linked entities are
   grounded with `@linked:<id>` fix constraints (idempotent if the solver grounds them itself).
   The cache key holds the re-projected geometry, so an upstream edit that doesn't move a source
   leaves the sketch cached. A source that no longer resolves, or no longer fits its entity, makes
   the sketch "needs attention": `unresolved[].path = /entities/i/source/ref` and the entity names
   `S…:e(id)` / `S…:p(id)` in `error.entityRefs`. Nothing is re-picked.

**Proposed for the contracts / kernel engineer.**

- `execFeature(hole, inputs)` **without `target`** returns the drill solids alone (the hole's tool
  for patterns); copies of `bodies` without `merge` return one `FeatureResult.bodies` entry per
  copy with a stable `key`.
- Linear patterns: `frames.axis` is the first direction and `frames.second` the second (geometry
  only; the kernel applies `reverse`). Draft: `frames.neutral` always carries the neutral plane,
  with `refs['/neutral']` when it is a face or plane shape (origin planes have none).
- `UnresolvedRef.entity?: Id` (the linked sketch entity), instead of reading it from the path.
- `RegenResult.datums?: { featureId, kind: 'axis' | 'point', frame }[]` so the viewport can draw
  axes and points.
- `HoleSizeRow.countersink` / `counterbore` optional (see the hole-table ADR); today `NaN` marks a
  size the standard doesn't cover.

## ADR-037 — Hole and thread tables (M3)

**Decision.** The tables live in packages/document `hole-tables.ts` (`ISO_HOLES`, `ANSI_HOLES`,
`holeRow`, `resolveHoleSize`), in millimetres (ANSI converted × 25.4). ISO: ISO 273 fine / medium /
coarse as close / normal / loose for M1.6–M36, ISO 261/262 coarse pitches with DIN 336 / ISO 2306
tap drills, counterbores for ISO 4762 (Ø from DIN 974-2, depth = head height k = d, flush) and
countersinks for ISO 10642 at 90° (Ø = theoretical head diameter, flush; M3–M20, no M18). ANSI:
close-fit / free-fit clearance drills and 75 % UNC tap drills from the standard drill chart, loose
from ASME B18.2.8, B18.3 counterbores and B18.6.3 82° countersinks.

- A size a standard doesn't cover has `NaN` in that column (`available()`), and the hole then
  needs an explicit value; the engine never extrapolates a size.
- Explicit `diameter`, `counterbore.*` and `countersink.*` always override the table.
- **To check against the printed standards:** the ANSI `loose` column (recalled from ASME
  B18.2.8; #0, #1, #3 and #12 are ≈ free fit + 1/64 in because the table as recalled has no row for
  them), and the ISO 4762 counterbore depth convention (flush; some shops add 0.5 mm).

## ADR-038 — M3 UI: inspectors, hole wizard, tool groups, sketch-edit chrome

1. **Inspectors.** The shared field helpers moved to `inspector/fieldKit.tsx`; M3 field groups live in `m3Fields.tsx` and `HoleWizard.tsx`. Plane, axis and point get a native "Definition" select (many kinds) that swaps in an empty default definition. Live validation is a polite `role="status"` note (`data-testid="validation"`), warn or info. Pattern skip toggles are `aria-pressed` buttons; instance 1 (the original) is fixed.
2. **Hole wizard** is an inspector section. Tables arrive through `holeTables` (a `HoleTable` per standard), or `HoleWizard tables=[…]`. Resolved dimensions are read-only (`resolveHole`, pure). An unknown size is reported and never guessed. Diameter override is a switch that seeds the table value.
3. **Tool groups.** Sweep and loft join Solid, shell, draft and thread join Modify, and Hole stays a direct button (so existing `data-tool="hole"` e2e keeps working). Pattern (mirror, linear, circular) and Reference (plane, axis, point) are new categories. The old catch-all `pattern` ToolId is gone and `comingIn` hints are removed (the field remains for future milestones). Shortcuts: W sweep, ⇧W loft, T shell, ⇧T draft, O hole, ⇧O thread, I mirror, N linear, ⇧N circular, G plane, ⇧G axis, ⇧P point. They avoid the PLAN 9.4 keys and H, L, A, D, X, Space and 0–7 (test-enforced). The phone is a viewer and shows none of these.
4. **Sketch edit tools** sit behind one "Edit" menu button in the sketch toolbar, so the bar and the tablet rail keep their length. Sketch-mode shortcuts: O offset, V convert, T trim, E extend, F fillet, ⇧F chamfer, M mirror. Sketch mode has its own keymap, so these do not clash with the modelling shortcuts. The chrome panels (`OffsetPanel`, `ConvertPanel`, `LinkedEntityPanel`, `TrimExtendPanel`, `SketchCornerPanel`, `SketchMirrorPanel`) are controlled and presentational; the host draws the previews. `linkedEntityStyle` gives the overlay stroke styling.
5. **Cut tools and touch discoverability.** `extrudeCut` (⇧E) and `revolveCut` (⇧R) sit in Solid beside Extrude and Revolve; the host creates the same feature with `op: 'cut'`. Pattern `/Extrude/` no longer identifies Extrude alone (it also matches "Extruded cut"). The tablet rail's group buttons show a tool-count pill with a chevron instead of the tiny corner triangle, and the flyout lists every tool by label. `SketchToolbar` gains `density="touch"`: a short text label under every icon, 56 px targets, wrapping in a bar. Tapping the active sketch tool deselects it for every tool.

## ADR-039 — M3 kernel features: inputs, naming and semantics the contracts leave open

**Context.** ADR-019 defines the M3 feature types and `kernel.ts` lists their inputs in one line
each. Implementing them in the façade (packages/kernel, M3 kernel workstream) needed decisions the
contracts don't spell out. The regen engine (kernel-client) depends on these.

**Decision.**

1. **Pointers everywhere.** Every reference of an M3 feature arrives at its JSON pointer: as a
   sub-shape in `inputs.refs[P]`, or as a frame in `inputs.frames[P]` (origin planes, axes and
   points, and reference features). The `kernel.ts` role keys (`plane`, `axis`, `upTo`, …) are
   accepted as fallbacks. A frame reads as a plane, an axis or a point according to the
   definition; for `point.intersection`, according to the EntityRef `kind` in the feature.
2. **Hole values** use the feature's own pointers even when the field is absent from the feature
   (the engine fills them from the tables): `/diameter` (clearance or tap drill), `/end/depth`,
   `/tipAngle`, `/counterbore/diameter|depth`, `/countersink/diameter|angle`. Blind depth runs from
   the face to the end of the full-diameter wall; the drill point is extra. The tool starts
   `max(1, 2r)` above the face so the cut leaves no coincident skin.
3. **Tool solids for copies** are what a feature returns with `op: "new"`. `HoleFeature` has no
   `op`: a hole without `inputs.target` (as ADR-036 proposes), or with an extra `"op": "new"`,
   returns its drill solids; through-all tools are sized by the target when there is one, else
   10 m deep. `kernel.ts` should say it (proposal 2 below).
4. **Copies of intersect features are refused** (`UNSUPPORTED_FEATURE`): the original's
   intersect already confines the body to its tool, so intersecting with moved copies empties it.
5. **Instance order and spacing.** Linear `k = row · count + column` (the first direction runs
   along a row). Circular with `equalSpacing`: 360° → `angle / count`; a partial span →
   `angle / (count − 1)` (ends included); without it, `angle` is the step. Body copies without
   merge list every copy in `bodies` (keys `inst<k>:<i>` / `mirror:<i>`; the first is also
   `shape`), as ADR-036's `runCopy` expects. Linear patterns also read `frames.axis` /
   `frames.second` and drafts `frames.neutral` (ADR-036's keys); `reverse` is applied by the
   kernel.
6. **One boolean per copied feature**, all instances as tools of one `BRepAlgoAPI` call (General
   Fuse intersects them together, so hundreds of instances stay a single operation), with the
   inverted-solid check off and parallel mode in the threaded build. A balanced pairwise fuse was
   not needed: the 10 × 10 hole pattern is within budget as one call.
7. **Shell rims are one face per open face**, named `F…:rim(<open face>)`, not
   `F…:rim(<open face>|<edge>)` as naming.ts says: OCCT's thick solid builds the rim as the
   closing face's image (one annular face lying in the open face's plane), so there is no face per
   edge to name. Proposal 1 below.
8. **Shell joins are sharp** (`GeomAbs_Intersection`, like other CAD); when OCCT cannot intersect
   the offset faces it retries with arc joins and warns. No silent rounding.
9. **Draft direction** is the neutral plane's normal (a face's outward normal); the body narrows
   along it; `reverse` flips it. *Superseded by ADR-041: the
   normal is taken on the drafted faces' side.*
10. **Loft guides are ignored with a warning** (ThruSections has no guide input) and sections with
    holes are `UNSUPPORTED_FEATURE`.
11. **Import feature** placement moves the raw shapes (shared geometry) instead of the M1 BREP
    location rewrite; inputs are `shapes["source…"]` (raw `importFile` handles). Multi-solid new
    imports return `bodies` keyed `body#<k>` in geometric-key order.
12. **Reference geometry returns shapes**: `axis` an edge `F…:axis`, `point` a vertex `F…:point`,
    `plane` a face `F…:plane`, each with `frame`, so the viewport can draw them and the engine can
    keep resolving them like M1 datum planes. `thread` returns the body unchanged with the cylinder
    `frame` and `radius`.
13. **The perf golden gates min(wall, CPU) per run.** Wall time inflates on oversubscribed
    machines (load > 10 on 4 cores during this work); process CPU time inflates while V8 compiles
    the 21 MB module to optimised code on background threads (single-threaded runs showed CPU above
    wall) and, in the threaded build, when the boolean runs in parallel. Each run's cost is the
    smaller of the two, the gate is the best of five runs after three warm-ups, and both numbers
    are logged.
14. **IGES stays in the main kernel.** Measured with a `WREN_NO_IGES=1` production link, the
    reader costs +265 KiB brotli (5.7 % of 4.53 MiB). A lazily loaded side module (Emscripten
    dynamic linking alongside embind and native exceptions) isn't worth that; a separate exchange
    kernel loaded on first import is the plan if data exchange grows.
15. **Naming keys are computed on demand.** `finalizeNamed` / `deriveEdgeAndVertexNames` used to
    compute a centroid (surface or curve integral) for every face, edge and vertex; only names
    shared by several sub-shapes need one, so keys are now computed lazily for those groups. Same
    keys, same names; it saves ~40 ms on a plate with 100 holes. Holes build one revolved tool
    per distinct depth and move it to every point.

**Contract proposals** (lead-owned; not applied):

1. naming.ts M3: `F…:rim(<openFaceName>)` (one rim face per open face) instead of
   `F…:rim(<openFaceName>|<edge>)`.
2. kernel.ts `FeatureInputs` M3 doc: hole values at `/diameter`, `/end/depth`, `/tipAngle`,
   `/counterbore/*`, `/countersink/*`; tool solids for copies via `op: "new"` (hole: extra
   `"op": "new"`); frames keyed by pointer (`frames["/plane"]`, `frames["/direction"]`,
   `frames["/definition/a"]`, …); `import`: `shapes["source…"]`; body-copy keys `inst<k>:<i>`.
3. kernel.ts or modeling.ts: an import format type with `'iges'` (`ExportFormat` has no IGES;
   kernel-client uses `ShapeImportFormat = ExportFormat | 'iges'` meanwhile).
4. Optional: a `{ kind: 'ellipse' }` `ProjectedCurve` for circles seen obliquely (now polylines),
   and moving `ProjectedCurve` into contracts if the sketch package consumes it directly.

## ADR-040 — Fillet/chamfer `propagate: false` refuses instead of faking

**Context.** ADR-019 adds `propagate?: boolean` (default true) to fillet and chamfer.

**Finding.** OCCT 8.0.1 has no way to stop a blend at a tangent edge. Every
`BRepFilletAPI_MakeFillet::Add` and `BRepFilletAPI_MakeChamfer::Add` reaches
`ChFi3d_Builder::PerformElement` (`src/ModelingAlgorithms/TKFillet/ChFi3d/ChFi3d_Builder_1.cxx`,
called from `ChFi3d_FilBuilder.cxx:211` and `ChFi3d_ChBuilder.cxx:215/250/350/462`), whose loop
"find all mutually tangent edges" appends every neighbour whose faces are tangent to the spine.
There is no parameter, and `ResetContour`/`Remove` act on whole contours. Ending a blend inside a
tangent chain also needs an end cap OCCT doesn't build.

**Decision.** With `propagate: false`, after `Add` the façade compares the contours OCCT built
(`NbContours`, `NbEdges`, `Edge`) with the selection. Same edges → the normal result. More edges →
`UNSUPPORTED_FEATURE` "The fillet cannot stop at tangent edges: N tangent edges continue the
selection", hint "Turn on "Propagate along tangent edges", or select the whole tangent chain",
`entityRefs` = the selection plus the extra edges (so the UI can highlight them). Golden: one
straight top edge of an extruded slot (lines tangent to arcs) is refused with both arcs and the
other line; selecting the whole loop with `propagate: false` matches the propagated result; a box
edge with `propagate: false` is a normal fillet.

## ADR-041 — Draft pull direction: toward the drafted faces

**Context.** rp05-moulded-housing drafts a box's four side faces about its own bottom face and
expects the walls to lean inward going up (the parting line at the bottom, the mould pulled up).
ADR-039 item 9 took the pull direction from the neutral face's outward normal (-z for a bottom
face), so the walls leaned outward and every rp05 stage was 4.5–7.7 % too large. The outward
normal also made a face disagree with a datum plane lying on it (origin XY gave the opposite
taper), and a boss drafted about the plate face it stands on came out right only because that
face happens to point at the boss.

**Decision.** Supersedes ADR-039 item 9. The pull direction is the neutral plane's normal on the
side where the drafted faces are (the sign of their area-weighted mean distance from the plane).
A positive angle narrows the body along the pull direction, so the drafted faces lean inward
moving away from the neutral plane, whichever way the picked face or plane points. Faces centred
on the plane (a mid-plane neutral) use the plane's own normal: a face's outward normal, a frame's
z. `reverse` flips the result. This is the moulding meaning of a positive draft (SolidWorks-like:
the part releases along the pull direction). The pull direction comes from where the faces are,
not from how the face or plane was made. SolidWorks shows a pull arrow the user can flip; we
choose the side from the faces, and `reverse` is that flip.

**Proposed contract text** (`DraftFeature` in packages/contracts/src/document.ts):

```ts
/**
 * Taper `faces` by `angle` about the `neutral` plane. Each face keeps its line on the neutral
 * plane and turns about it. The pull direction is the neutral plane's normal on the side the
 * drafted faces are; a positive angle makes the body narrower along it (the faces lean inward
 * moving away from the neutral plane, as a moulded part needs). Faces centred on the plane use
 * the plane's own normal (a face's outward normal, a plane's +z). `reverse` flips the pull
 * direction, so the faces lean outward.
 */
```

## ADR-042 — Copies of through-all extrudes use a sized blind tool

**Context.** A mirror or pattern copies a feature's tool solid, built as the feature alone with
`op: 'new'` (ADR-036 item 1). The kernel refuses a through-all extrude without a body to size it,
so every copy of a through-all cut failed (rp10-comb-plate: the slot pattern and the mirrored ear
hole).

**Decision.** The engine builds a through-all extrude's tool as the same extrude made blind, in
the same direction (normal, reverse, symmetric). Its depth is sized when a copy runs, from the
copy's target body: `2 · (diagonal of the target and profile boxes + reach) + 1`, where reach is
how far a profile point can move (linear: the full span of both directions; circular: twice its
distance from the axis; mirror: twice its distance from the plane). So each copy still cuts
through the whole body. The depth is rounded up to a power of two and is part of the tool's cache
key, so small body edits reuse the tool. The kernel's through-all rule stays as it is (a tool can't
know its copies' placements); a hole's through-all tool keeps the kernel's 10 m fallback
(ADR-039 item 3).

## ADR-043 — M3 integration in apps/web

1. **Two tool flows.** M1 tools (extrude, revolve, fillet, chamfer, push/pull, and the new
   extruded / revolved cut) keep "prompt, then create on the first pick". M3 tools (sweep, loft,
   shell, draft, hole, thread, mirror, patterns, plane, axis, point) create their feature at once
   with defaults and empty references, open the inspector, and collect the references field by
   field (`FEATURE_PICKS` in `features/factories.ts`). A single field moves on after its pick; a
   list field stays open until Enter or another field (a sweep's profile moves on after one).
   Reason: these features have several required references and the inspector already shows every
   field; one prompt per field keeps act-first and select-first both working. While its picks are
   incomplete the feature shows its error in the tree, as M1's palette Plane did.
2. **Reference chips.** Origin planes and axes and plane / axis / point features have no pickable
   shape in the view (`RegenResult` carries no datums, ADR-036 proposal). A field that takes them
   shows chips beside the prompt (`referenceChoices`), limited to features before the one being
   edited. The reference-part README's "pick them in the tree" reads as "pick them from the chips".
3. **Mirror / pattern sources** are features: a tree click while `/source/features` is picked adds
   the feature instead of opening it, and a model click adds the latest feature named in the
   clicked face or edge. A feature selected in the tree when the tool starts is the first source.
4. **`acceptsFor(path, feature)`** decides kinds per path, and per definition kind for
   `/definition/a|b` (points for a two-point axis, planes for a midplane or two-plane axis).
5. **Sketch Edit menu.** `app/sketch-edit.ts` drives the packages/ui panels from `SketchUi.edit`
   and runs each operation through the session's edit queue (`commitEdit`, now with a label
   computed after the operation and no undo step when it refuses). `@wren-cad/sketch/edit` loads
   on first use. Convert entities projects in the kernel worker through `projectEdges` /
   `projectFaceOutline` on the picked body's shape and the sketch frame; refs for a face outline's
   edges come from `refFor` on the edge ordinals (mesh edge index = kernel ordinal).
6. **Linked re-projection.** `createModelingApi` defaults `reprojectLinked` to
   `reprojectLinkedSketch`: one-curve sources go to packages/sketch (what Convert makes); infinite
   lines (axes, plane traces) and multi-curve sources keep the engine fallback.
7. **Point tool** in the sketch toolbar (P): hole centres and the specs' `point` op had no way to be
   drawn. **Hole wizard** gained counterbore and countersink overrides (rp08's spec sets them).
8. **`propagate: false` refusals** are reworded in the app (`model/explain.ts`): the kernel's
   UNSUPPORTED_FEATURE `entityRefs` minus the selection are named from their persistent names
   ("the edge between the end face of Extrude 1 and the side of Arc 1 (Extrude 1)").
9. **Converted edges share corners.** `convertEntities` gained `join` (the app always passes it):
   a line or arc end on an existing linked point reuses it, so four converted top edges are one
   loop that Offset follows (rp07), not four separate lines each offset on its own side.
10. **Coplanar stacked regions.** All regions pick at 0 px and the nearest to the camera wins; when
    two are equally near (rp10's slot sketched on the XY plane over the plate's own sketch), the
    smaller region is the one under the cursor (`orderStackedRegions`), as a hole region over its
    face. Before, the order was whatever the viewport iterated, so the plate could be cut away.
11. **Bundle.** The Edit-menu panels and the hole tables load on demand; the initial route is
    243 kB gzip (budget 250 kB).
12. **Reference-part E2E** (`e2e/support/reference-ui.ts`): sketches are drawn 4 % oversize about
   the sketch origin, then dimensioned with the Dimension tool; a dimension the drawn constraints
   already imply (DOF unchanged) is undone, and every sketch must end fully defined. Camera
   framing uses `zoomTo`, the view keys and `lookAtPlane` (orbiting to look into a bore). Every
   pick goes to the point where the app itself (`resolveAt`) picks the named entity without a
   "Which one?" tie, nudging a few px off seams as a person would. Stages are the baseline with only that stage's
   dimensions changed (the README's definition), so the previous stage is reset first.

## ADR-044 — Imports through the kernel `import` feature; IGES end to end

**Context.** M1 placed and named imported B-rep bodies in TypeScript because the façade had no
transform or naming call: the engine exported the raw shapes as BREP, appended the placement to
the file's `Locations` table, read it back, and named the topology with a no-op `intersect`
against an enclosing box under the tag `<id>:face`, then translated the kernel's
`F<id>:face:unnamed#k` to `F<id>:face#k` in every name it received. M3 added the kernel `import`
feature (ADR-039 item 11) and an IGES reader, but the engine still used the workaround and
refused IGES (M3 gate blocker B1).

**Decision.**

1. **Placement and naming in the kernel.** The engine passes the raw `importFile` handles as
   `shapes["source:<k>"]` (k zero-padded, file order) and the frame it validated, orthonormalised
   from `frameMatrix`, to the kernel `import` feature with `op: "new"`. Bodies come back in
   geometric-key order: `shape` first, then `bodies` keyed `body#k`, which become `B<id>#k`.
2. **Names unchanged, checked against a golden.** The kernel names faces `F<id>:face#k` per body
   by the same geometric key (`finalizeNamed`) and derives edges and vertices the same way, so
   these are exactly the M1 names. `import-naming.test.ts` holds every face, edge and vertex name
   (with its centroid) and every body id to a golden recorded with the M1 engine before the switch:
   in place, moved, tilted, three solids in place and moved, cut, and add. No document migration
   or resolver fallback is needed, because stored references resolve by name as before. The name
   translation layer (`translateName`) and `placeBrep` are removed. A file whose box intersect
   failed in M1 (invalid geometry) had face-only names, and now also gets edge and vertex names.
   That only adds names.
3. **Body ops stay in the engine.** `add | cut | intersect` use the kernel-placed bodies as tools
   of one kernel `boolean` per target, as before. Tool faces are `F<id>:face(F<id>:face#k)`, the
   same as the kernel `import` op would give. The kernel's own body op fuses every scoped body into
   one for `add`, but the engine's rule (merge into the oldest touched body, warn about the rest)
   and its default-scope bbox prefilter must not change.
4. **IGES like STEP.** `importShapes(bytes, 'iges')`: loose faces are sewn, closed shells become
   solids, and the result is cached by sha256, placed, named and usable as a tool. A file that is
   not IGES is the reader's `INVALID_INPUT`.
5. **Open surfaces are never passed off as solids.** An IGES surface model that does not close
   comes in as a surface body, and GProp still reports a "volume" for it. A body whose edge names
   include a free edge `edge(F<id>:face#k)` (naming.ts; a closed solid has none apart from degenerate edges such as sphere poles and cone apexes, which are recognised by their fingerprint curve `degenerate` and skipped) gets an
   `OPERATION_FAILED` warning on `new` ("open surfaces, not closed solids", with the body ids). As
   the tool of add/cut/intersect it is refused (`INVALID_INPUT`) rather than left to OCCT's
   "boolean failed".
6. **Meshes keep TS placement.** STL/OBJ/3MF/GLB are parsed in TS (`@wren-cad/io`), so they are
   still placed with `placeMesh` and handed to the kernel as STL. The kernel `import` feature's
   mesh path keeps source order rather than the engine's geometric order of placed bbox centres.
7. **App.** The pickers offer `.igs` / `.iges`, drag and drop accepts them, and the PWA
   `file_handlers` list `model/iges`.

## ADR-045 — Kernel perf gates scale on CI like the web perf budgets (2026-11-09)

The first M3 run on CI failed one assertion: the 10 × 10 hole pattern took 326 ms against a 300 ms
budget (best of five warm runs, single-threaded Wasm, shared 2-vCPU runner). Locally it is well
inside. PLAN §10 budgets are for real hardware, and ADR-010 already scales the web perf budgets on
CI (`PERF_FACTOR`, 3 for software-rendered main-thread work). The kernel gates
(`packages/kernel/test/m3-copies.golden.test.ts`, `packages/kernel-client/test/regen/cache.test.ts`)
now use the same rule with a factor of 2 on CI (pure CPU, no software GL) and 1 elsewhere,
overridable with `WREN_PERF_FACTOR`. The measured times are still logged on every run, so a slow
creep shows up in the logs before it reaches the scaled gate.

## ADR-046 — M3.5 contracts: navigation, box pick, radial-menu gesture, sketch curves, error causes (2026-11-09)

Scope approved by the owner from the UX research report (`docs/ux-research/reports/CAD UI feedback and lessons.md`).

- **Navigation is a viewport setting, not app code.** `NavigationOptions` (preset, turntable or trackball, pivot `cursor` or `center`, pivot marker, invert zoom, speed) with `setNavigation` / `getNavigation`. Presets are named by behaviour (`rightOrbit`, `middleOrbit`, `middlePan`, `rightOrbitRepeat`), never by product; the settings UI may say "like SolidWorks / NX" as plain compatibility text. Left drag is never navigation under any preset, so the app owns picking and box selection. The research found Wren's orbit "off" because it pivoted on a stale target that pan and dolly-to-cursor drag into empty space, showed no pivot and used the left button; the pivot rule (point under the cursor, else the visible bodies' centre) and the marker follow Autodesk's Safe 3D Navigation findings and the MCAD defaults surveyed. The owner judged the SteeringWheels and ViewCube patents no obstacle for these generic behaviours (2026-11-09); Wren does not copy the wheel widget.
- **Right click is a gesture.** The viewport reports `contextMenu` for a secondary press released within its drag threshold (and `repeat: true` for a quick click under `rightOrbitRepeat`), and `setPivot` for a middle click on geometry under `middleOrbit`; a drag past the threshold navigates. The app draws the radial menu.
- **`pickRect`** returns window or crossing hits for box selection; the app decides the mode from the drag direction (left → right window, right → left crossing).
- **Sketch curves:** `SketchEllipticArc` and `SketchBSpline` (poles as point entities, clamped unless periodic, optional weights and knots). A spline drawn through points stores its interpolating poles plus the through points as point entities held by `pointOn`, so editing a through point reshapes the curve; the sketch workstream decides whether the solver holds the interpolation exactly or the tool recomputes the poles, and records it here. `tangent` now covers every curve; `curvature` (G2) reports an `unsupported` conflict where planegcs cannot express it. `RecognizedShape` gains `ellipse` and `spline` for the Pencil.
- **`SketchConflict.entities`** names the geometry to highlight, and `fixes[0]` is the suggestion (remove the most recently added constraint of the set unless a better-explained fix exists). The UI never shows bare constraint numbers (FreeCAD's "Redundant constraints: (61)" is the complaint).
- **`AttentionCause`** on `UnresolvedRef` and `FeatureStatus`: the upstream feature whose change, suppression, deletion, reordering or failure broke the reference or the feature. Reported only when the engine can tell, never guessed (the SolidWorks 2023 Top Ten #1 and #5 requests and the UIST 2024 DeCAD finding).
- **Placeholders.** So every workstream starts from a green tree, the lead added minimal cases for the new union members (control-polygon sampling, `null` closest points, "cannot be projected yet", no-op gestures, stub `setNavigation` / `pickRect`), each marked "M3.5 placeholder (ADR-046)". The workstreams replace them; the gate checks none remain.

- **Gate additions (2026-11-10):** `ViewportGesture.pointerId` (set on `longPress` and on a `contextMenu` raised while the pointer is down, so the radial menu can track a touch long-press until lift) and `PickHit.depth` (camera-ray distance, mm; the "Which one?" chooser's stable tie-break, kind then depth then id). ADR-049 (UI) and ADR-059 (integration) carry the implementation details of the radial menu, keymap, chooser and settings; read with this ADR.
- **Known limit (gate N6):** inside a sketch the radial menu opens with the mouse (right click) or the held key (Q) only: a touch long-press and a Pencil hold already mean other things there (selection and, ADR-061, grab). Revisit in M3.6 (e.g. a two-finger long-press).

## ADR-047 — M3.5 error causes: how the regen engine names the upstream feature (2026-11-09)

Modeling workstream (packages/kernel-client `src/regen/cause.ts`; README "Error causes").

- **Evidence, not heuristics.** Each regen records a walk per slot: each feature's definition and values, cache key, the features whose output it read, and the containers it set. A cause comes from one of three rules; anything else gets no cause.
  - Rule 1 reads it from the persistent name: a tagged feature that is deleted, suppressed, after the consumer, or failed.
  - Rule 2 derives it from the difference to the previous regen's walk.
  - Rule 3 carries it from the previous regen while it still holds.
- **Rule 2 needs the same stored ref to have resolved in the last regen.** The touchers of the name family are the features whose results set or removed a container holding it, plus the producer. They are tried nearest first:
  - A toucher that changed itself is the cause.
  - A toucher whose key changed only through its inputs hands over to a breadth-first walk of its dependencies, through features whose keys changed. The first level holding a changed or removed feature decides: one feature is the cause; several mean no cause.
  - This is the "nearest upstream feature that changed" rule for chains. A pocket whose floor vanished because the plate under it got thinner names the plate.
  - Fallback: a single change upstream of the consumer is the cause, because regeneration is deterministic.
- **Sticky causes.** The contract says "changed this regen". The engine keeps the cause while the ref stays broken, until the ref resolves or the cause stops holding, so an unrelated edit does not erase the explanation. Proposed contract wording: "since the reference last resolved".
- **Kinds.**
  - Added, unsuppressed and moved-above features are `changed`, with `detail` "added", "unsuppressed" or "moved". The contract has no `added` kind; the detail is enough.
  - `detail` labels sketch dimensions by kind ("horizontal distance 30 mm → 200 mm"), never by constraint id.
  - A blocked feature names what it waits on (`failed`): the referenced feature that failed itself, or the first feature that failed on its body. The UI follows `cause.featureId` to reach the root.
  - A feature's own edit is never its upstream cause.
- **Deps** come from three sources: reference name tags, copied features, and the last writer of each body that a feature acts on or whose content key it hashes (`Plan.reads` for implicit scopes).
- **Cost**: one canonical-JSON snapshot of each definition per regen, about 20 µs per feature.

## ADR-048 — M3.5 regen of the new curves: knot conventions, sampling, exact projections (2026-11-09)

Modeling workstream. The kernel and sketch workstreams should confirm or amend this (ADR-046).

- **Knot convention of `SketchBSpline`.** All three workstreams must agree on it.
  - `knots` are the distinct knot values and `multiplicities` their multiplicities. This is OCCT's `Geom_BSplineCurve` form. Give both or neither. For an open spline without `multiplicities`, the regen also reads a flat vector of length n + p + 1.
  - Open (clamped) default: knots `i/(n−p)`, i = 0…n−p, with multiplicities p+1, 1, …, 1, p+1.
  - Periodic default: knots `i/n`, i = 0…n, all multiplicity 1.
  - The domain is [0, 1] in both cases.
  - Periodic flat knots follow `BSplCLib::KnotSequence`: p+1−m₀ knots of the neighbouring period on each side, and pole i supported on flat knots i … i+p+1. So the default periodic cubic starts at (P₀ + 4P₁ + P₂)/6. The kernel's `Geom_BSplineCurve(poles, weights, knots, mults, p, periodic=true)` with these arrays should give the same curve and parametrisation. This follows from reading `BSplCLib` and has not been checked against a build yet; the kernel goldens should confirm it.
  - If all `weights` are equal, the spline is non-rational.
- **Sampling** for display produces exact points at the sketch chord tolerance. Sampling never feeds geometry; the kernel builds the exact edges.
  - Elliptic arcs: uniform in the parametric angle, with the step of a circle of the major radius.
  - Splines: de Boor, with per-span subdivision against 0.9 × the tolerance at the middle and quarter points.
- **Exact projection** of another sketch's curves:
  - Ellipses and elliptic arcs are exact when the planes are parallel. Otherwise the kernel's polyline is used, marked approximate.
  - B-splines are exact onto any plane that does not see them edge-on. Orthographic projection is affine, and B-splines (rational ones too) are affine invariant.
  - Proposed for the kernel's `projectEdges`: return the same exact `ellipse` / `ellipticArc` / `bspline` curves for model edges. kernel-client's `ProjectedCurve` already accepts them.
  - Proposed for packages/sketch `convertEntities` / `reprojectLinked`: create and follow `SketchEllipse`, `SketchEllipticArc` and `SketchBSpline` linked entities from those curves.
  - Until then, the engine's own fallback re-projects linked entities of these kinds in place. A spline whose source gains or loses poles is lost (needs attention), never refitted.


## ADR-049 — M3.5 UI: radial menu, chooser, keymap, navigation settings, errors at cause (2026-11-09)

Choices made by the UI workstream that the contracts and PLAN leave open. Fold into ADR-046 at the gate.

- **Radial geometry.** Eight fixed 45 degree sectors clockwise from north, the same on every surface; a flick in an empty or disabled sector does nothing (it never snaps to the nearest item). Items fill clockwise from north-east and north is reserved for Repeat, so Repeat is always in the same place. Pills are 128 px wide (88 px under 480 px viewports; the full label stays in the accessible name) on a 136 px ring, sized so neighbours never touch.
- **Flick versus hover.** *(Amended by ADR-076: the menu now draws at once and the flick works for the first 250 ms.)* Before the menu has drawn (250 ms for mouse and pen), moving 40 px toward an item selects it. After it has drawn, movement only highlights (held pointer) and a click or Enter selects, so moving the mouse away from an open menu is never a command. A held pointer (touch long-press) or held key selects on release and, lifted with no direction, stays open for a tap (a held key cancels: spring-loaded). Keyboard and touch sources draw at once.
- **Never act on a stale click.** The menu acts only on presses it saw begin after it mounted (or the explicitly `held` opening pointer). A press outside cancels it and that press's click is eaten (one-shot, 500 ms), as is the click after a held release. Cancelling swallows a click that would otherwise have reached the canvas: a second click is needed, which is the price of removing the SolidWorks mis-click.
- **Chooser order** is vertex, edge, face, body (the hardest target first, after the bubble-cursor result), then pick-ray depth, then id compared by code unit (locale-independent), so it is identical on every run. `PickCandidate.depth` is optional (an additive prop). Tab and Shift+Tab are captured at the document while the chooser is open, and the pure `cyclePreselection` is exported for the app to drive the viewport preselect without it.
- **Keymap model.** A binding is `Mod+Alt+Shift+<code>`; `Mod` is Cmd on macOS and Ctrl elsewhere, so one stored keymap works across platforms. A literal Ctrl on macOS or Meta elsewhere is not bindable (the OS's). Overrides are stored per command and replace the defaults; `[]` unbinds; locked commands (Esc, Space-repeat) cannot change. Contexts are `global`, `model`, `sketch`; commands conflict only when their contexts overlap, so P is Point in a sketch and Push/pull in the model. Browser-reserved keys have two severities: `blocked` (Ctrl/Cmd+W, T, N, Shift+N/T/W, Q, L, Tab, Ctrl+Tab, Ctrl+1-9, F11, F12 ...) cannot be assigned at all; `preventable` (Save, Open, Print, F5, Find ...) needs an explicit "Use anyway". The table is by-hand knowledge of Chrome, Edge, Firefox and Safari and must be rechecked when a browser changes; `docs/` has no source for it beyond the browsers' own shortcut pages.
- **Keymap storage** is the app's: `KeymapOverrides` is plain JSON (suggested key `wren.keymap`, via `readJson` / `writeJson`). The default keymap (`DEFAULT_COMMANDS`) reproduces `workbench.ts onKey` and the sketch toolbar, plus B, Shift+B, Shift+E and Shift+A for the four new curve tools (clash-free with every sketch tool; asserted by a test).
- **Settings key.** Navigation settings live under `wren.navigation` (new keys use the post-rename prefix; the legacy `whittle.*` keys keep their names so no user loses a setting). `sanitizeNavigation` clamps and defaults anything stored. There is no settings panel in the app yet (theme is a toolbar toggle, nest-sketches a palette command), so `NavigationSettings` is a stand-alone controlled panel for whichever surface the integration chooses.
- **Overlay.** Ctrl, Cmd or Alt held alone for 600 ms; any other key (a chord), a pointer press (Ctrl-click multi-select) or a wheel cancels it; its listeners are passive and never cancel events; it takes no focus.
- **Errors at the cause.** A sentence exists only when the engine reported an `AttentionCause`. A cause that was deleted, or whose id the app cannot name, is plain text, never a dead button. In a tree row the cause button is not a tab stop (a treeitem must not nest tab stops); the inspector has the keyboard path.
- **Sketch toolbar.** The four curve tools sit behind a "Curves" menu (like "Edit") rather than four more buttons on a bar that is already long on the tablet rail. The toolbar's own shortcut handler now matches `KeyboardEvent.code` (falling back to `key` for synthetic events), so it is layout-independent even before the keymap switch-over. `curvature` is added to the Constraints menu (disabled unless `enabledConstraints` allows it).
- **`FloatingLayer` anchors.** A point anchor `{ x, y }` is keyed by its coordinates: a fresh object on every render used to re-run the focus-restore effect and steal focus from the chooser on each hover.

## ADR-050 — Sketch B-splines: knots, periodic form, splines through points (M3.5, sketch workstream)

Confirms ADR-048's knot convention and decides how a spline drawn through points behaves (ADR-046 left that to the sketch workstream). packages/sketch `src/bspline.ts`; its de Boor matches kernel-client's `regen/curves.ts` to 1e-9 (clamped, periodic, rational, explicit knots).

- **Knots, multiplicities, weights (normative for the kernel).** `knots` are distinct and strictly increasing; `multiplicities` go with them (both or neither; the solver refuses one without the other).
  - Open splines are clamped: end multiplicities p + 1, interior 1…p, Σ multiplicities = n + p + 1, n ≥ p + 1. Default: knots i/(n − p), i = 0…n − p, multiplicities p + 1, 1, …, 1, p + 1.
  - Periodic splines: n ≥ p + 1 poles, Σ multiplicities − last = n, first and last multiplicity 1, interior ≤ p. Default: knots i/n, i = 0…n, all 1. Domain [knots₀, knots_last] ([0, 1] by default).
  - Weights omitted, or all equal: non-rational. Otherwise one positive weight per pole.
- **Periodic form.** Flat knots: the p knots of the previous period before knots₀, one period, then p + 1 knots of the next period. Unwrapped control points are poles 0…n − 1, then 0…p − 1 again. The span [k₀, k₁] uses poles 0…p, so a uniform cubic starts at (P₀ + 4P₁ + P₂)/6. planegcs 1.3.0 gives the same point (measured), and so does OCCT `Geom_BSplineCurve(…, periodic = true)` from the same arrays (via `BSplCLib::PoleIndex`). The kernel goldens should confirm the OCCT side.
- **Splines through points: the solver holds the interpolation exactly.**
  - The tool (and the Pencil) interpolate with knots *at* the through points' chord-length parameters (normalised to [0, 1]). So every through point sits at a knot.
  - Open: n = m + p − 1 poles. The end through points *are* the end poles (shared ids), and every inner through point has `pointOn` the spline. For a cubic the poles next to the ends are free **tangent handles**, starting at Bessel end tangents (the parabola through the first or last three points). Other degrees start with vanishing higher end derivatives.
  - Closed: periodic, n = m poles, every through point at a knot (`pointOn`), no handles.
  - The tool writes **`SketchBSpline.through`** (contract, accepted): the through points in order, the i-th at the i-th inner knot (every knot but the last when periodic). The solver takes it as the source of truth. A `pointOn` whose point is listed is a **knot point**: its curve parameter is that knot, fixed, wherever the point currently is (a point moved off its knot without a solve is pulled back). A `through` whose length doesn't match the inner knots, or repeats a point, fails the solve with a named reason. Listing a point doesn't hold it by itself: its `pointOn` does (removing that frees it).
  - **Fallback for documents without `through`** (none have shipped; kept for read compatibility): a `pointOn` on a spline with explicit `knots` whose point is within 1e-6 × the sketch size of an inner knot is a knot point.
  - Any other `pointOn` on a spline has a free curve parameter, so the point slides. On a clamped spline, past the ends, the curve continues polynomially (the carrier convention lines and arcs already follow).
  - With knot parameters fixed, the derived (non-handle) poles are a linear function of the through points and the handles. When nothing else constrains them, the solver solves them **downstream** (`offsetSplit`, generalised from offsets). Everything else solves first, without them, so dragging a through point moves only that point and reshapes its spline. The other through points stay put to the bit, and dragging back restores the original curve. Otherwise everything solves together.
  - DOF: open cubic through m points = 2m + 4 (the points plus the two handles); closed = 2m.
  - Rejected: free curve parameters for through points. They drift with every drag, make the other through points move, and leave the spline never fully defined. Recomputing the poles in the tool on every edit was rejected too: the solver couldn't drag or dimension a through point, and other constraints couldn't act on the shape.
- **Edits keep `through`.** A trimmed piece lists the original through points at its own inner knots (the pieces keep the original knot values). A mirrored copy lists the copies of its through points when they were mirrored too, else none (its symmetric poles carry the shape).

## ADR-051 — Sketch curves in the solver (M3.5, sketch workstream)

packages/sketch `src/model.ts`, `src/gcs.ts`, `src/solver.ts`. Our own residual rows stay the truth (verification, DOF, conflicts). planegcs solves where it can express the rows. Rows it can't express are marked `gcs: false` and finished by Newton on our rows (`polish`, ≤ 30 steps; ≤ 12 per drag frame).

- **Parameters.** Ellipses and elliptic arcs use planegcs' parametrisation: centre, focus and minor radius. An elliptic arc's start and end are points with internal on-ellipse rows (focal sum); planegcs uses `arc_of_ellipse` + `arc_of_ellipse_rules`. A spline has no parameters of its own (its poles are points). A free spline curve parameter is a model parameter mapped to a planegcs sketch parameter (`point_on_bspline`). A tangency between curves that share no point gets an internal contact point. Unconstrained DOF: ellipse 5, elliptic arc 7, spline 2 × poles.
- **Point on**: lines, circles, arcs (as before), ellipses and elliptic arcs (their ellipse), splines (above).
- **Tangent, every pair.** Lines run start → end, circles and conics CCW, splines with increasing u. These are planegcs' normal conventions, measured.
  - **At a shared point** (shared or coincident ends, or a point held on both), the row is regular: sin of the angle between the tangents at the joint (G1, either sense). A spline end's tangent is its end leg (P₁ − P₀). planegcs: lines and spline end legs use `parallel` (helper lines) and `perpendicular_pppp` against circles. Conics and points on splines use `angle_via_point` / `angle_via_point_and_param` at 0 or π, chosen from the current geometry.
  - **Elsewhere**, between two lines/circles/arcs: as before. Any pair involving an ellipse, elliptic arc or spline gets a contact point on both curves where the tangents are parallel, seeded at the curves' closest approach. Like lines and arcs, this holds on the carrier (a spline's polynomial continuation).
- **Curvature (G2)** = tangent at the shared point plus equal curvature vectors there (one row: their difference along A's normal, scaled to mm). Curvature vectors: lines 0; circles (c − P)/r²; ellipses ab/(r₁r₂)^{3/2} along the focal bisector; splines (C″ − (C″·T)T)/|C′|². Against a line, the row is the spline's third pole on its end leg's line (planegcs `point_on_line_ppp`). Otherwise there is no planegcs counterpart and Newton finishes it. Refused as `unsupported`, never dropped: no shared point ("…needs Spline 1 and Line 1 to share an end point"), no spline on either side. A tangent at the same joint is redundant, not a conflict.
- **Ellipse dimensions.** `radius` / `diameter` on an ellipse or elliptic arc take **`axis`** (contract, accepted): `major` (the default) or `minor`. The major radius √(|CF|² + b²) is Newton-finished: planegcs 1.3.0's `internal_alignment_point2ellipse` ignores its alignment type (measured). The minor radius is planegcs `equal` on the minor radius. Labels read "Minor radius …". The interim convention "a distance from an ellipse's centre to it is the minor radius" is dropped (nothing shipped with it): distances to ellipses and splines are refused with a plain reason. Pole-to-pole distances are point distances.
- **Equal** between ellipses and elliptic arcs: equal minor radii plus equal centre–focus distances (planegcs' `equal_radii_ee` rejects arcs of ellipses).
- **Drags.** Ellipses and elliptic arcs: the centre near it, else the grabbed curve point follows the cursor. Splines: the curve point at the grabbed parameter follows the cursor. Through points: see "Sketch B-splines". Budget: 200 entities with 20 through-point splines, median 1.4 ms per drag solve (test/drag-splines.test.ts).
- **Conflicts.** `entities` lists the user geometry the set's constraints act on (and the fixed or linked geometry that makes it conflict), never the origin or axes. `constraints` are in sketch order. `fixes[0]` removes the **most recently added** member (last by position); that is also the constraint the relaxed solution leaves out. Value changes and "make reference" follow it. Invalid or inexpressible constraints are `kind: 'unsupported'`. A `failed` result carries `error`, worded with entity names ("Spline 1: a degree-3 spline needs at least 4 control points"), and so do the explanations.

## ADR-052 — Pencil ovals and splines (M3.5, sketch workstream)

packages/sketch `src/recognize.ts`.

- **Ellipse.** A closed stroke that is not a circle is fitted with the centre and axes from its principal axes, and the radii by least squares on (x/a)² + (y/b)² = 1. It is an `ellipse` when the RMS / worst geometric deviation ≤ 4% / 12% of b and **a/b ≥ 1.25**. Circles keep the aspect ≤ 1.2 gate, so nearly round strokes are never ellipses. Rectangles fail the fit.
- **Spline.** A cubic through 4–12 evenly spaced fit points (5–14 closed; ends exact; inner points averaged with their neighbours) must follow the stroke within 2% of its length. Splines are tried only for strokes with curved pieces, closed non-circles, or ≥ 3 straight pieces **without a sharp corner**. A corner is sharp when ShortStraw's straw drops below 0.75 of its median: drawn corners measured ≤ 0.65, smooth bends ≥ 0.79. The spline must also fit no worse than the pieces' lines, or within hand noise with at most one point more than the polyline's vertices. A smooth stroke that fails all this stays a polyline (the old fallback).
- Results: the 30- and 300-stroke corpora stay at 100%, and the shaky corpus at 98.3%. Its misses are shaky short arcs, now read as splines rather than polylines. Ellipses: all 24 tested; shaky ovals ≥ 90%. Waves: ≥ 90% with a normal hand and ≥ 75% shaky; the rest stay polylines. Frozen fixtures: test/fixtures/m35-strokes.json, from the seeded pen model (no real pen recordings were available).
- `strokeFragment`: ellipse → centre point + ellipse; spline → the through-point spline tool.

## ADR-053 — Editing the new curves (M3.5, sketch workstream)

packages/sketch `src/edit/curve-ops.ts`, `trim.ts`, `mirror.ts`, `offset.ts`, `convert.ts`.

- **Intersections** of any two curves: crossings of their samplings refined by Newton on the exact curves. Tangential touches are not cut points. Lines, arcs and circles now also stop at ellipses, elliptic arcs and splines.
- **Trim.** An ellipse needs two cuts and becomes an elliptic arc (same id). An elliptic arc shortens or splits like an arc. The split-off piece shares the centre and is tied by `equal` + `pointOn`; its rotation is otherwise free.
- A spline **splits by knot insertion** (Boehm). The curve is unchanged, and the pieces keep the original knot values, so through points stay at their knots (and keep reshaping their piece). The piece that keeps an original end keeps its end pole; other poles are new. Through points on a removed part lose their `pointOn` (noted). A closed spline needs two cuts and becomes open (same id).
- **Extend.** Elliptic arcs extend along their ellipse. Splines and ellipses are refused with the reason.
- **Mirror.** Ellipses (`equal`; the rotation isn't tied, and a note says so), elliptic arcs (reversed sense, `equal`), splines (poles mirrored in order, same knots and weights; symmetric poles tie the whole curve).
- **Offset** refuses ellipses, elliptic arcs and splines: their offsets are not curves of the same kind, and Wren doesn't approximate them.
- **Fillet / chamfer** stay lines and arcs ("A corner is where two lines or arcs meet").
- **Convert Entities** (ADR-048's proposal, done). `ProjectedCurve` gains `ellipse`, `ellipticArc` (ends as points, CCW) and `bspline` (`SketchBSpline` fields, poles as coordinates). They become exact linked entities and are followed in place. A spline whose source gains or loses poles, or turns into another kind, is reported `lost` (needs attention) and never refitted; Re-pick refuses it with the reason.

## ADR-054 — Sketch regions in TypeScript (M3.5, sketch workstream)

packages/sketch `src/regions.ts`, `sketchRegions(entities)`. The kernel's regions (General Fuse + BOPAlgo_BuilderFace) stay the truth for profiles. This mirrors their rule for previews, picking and tests. Regions are the bounded faces of the arrangement of every non-construction curve. Curves are split where they cross or an end lies on them, within 1e-6 × the sketch size (the kernel's fuzzy value). Dangling pieces are dropped, and faces are traced on the half-edge graph. Outer loops are counter-clockwise; nested loops are holes and also regions of their own. Areas are exact per piece by Green's theorem: closed forms for lines and arcs, Gauss–Legendre per knot span for splines (exact to degree 8 when non-rational), per eighth turn for ellipses. They match a dense-polygon reference to ≤ 1e-6 relative.

## ADR-055 — Dimension annotations (M3.5, owner request, sketch workstream)

packages/sketch `src/annotation.ts`, `dimensionAnnotation(entities, constraint, value, options) → DimensionAnnotation` in sketch mm. The UI draws it, and dragging the label changes only `DimensionConstraint.label`.

- **Linear.** `distance`, `length`, `hDistance` (x), `vDistance` (y), and line and circle `offset`s give extension lines (1 mm gap, 1.5 mm overshoot by default) and a dimension line through the label with two arrows. Measurement is aligned for point–point and length, across the line for point–line and line–line, and axis-parallel for h/v. An extension starts at the nearest point of a line's extent, not at the foot point. A label beyond the extensions pulls the dimension line out to it.
- **Radial.** `radius` and `diameter` (on ellipses along the axis `axis` picks) draw a leader along the line through the centre towards the label. An arc gets an extension arc when the leader leaves its sweep.
- **Angular.** An arc at the label's distance from the lines' intersection. A label in the vertical sector shows the same angle there. A label outside the sector gets an extension arc. Extension lines are drawn where the arc lies beyond a line.
- **Arrows flip outside** (same tips, pointing in, with stubs) when the space can't hold the text (default 8 mm) plus two arrowheads.
- `dragDimensionLabel` keeps an h/v distance's text clear of its points' span, on the side it was dragged to. The dimension line then never crosses the measured geometry, and the placement still reads as horizontal or vertical.
- Proposed contract addition, if the type is shared beyond packages/sketch: `DimensionAnnotation` (extensions, lines, arcs, arrows, text, arrowsOutside) in contracts/sketch.ts. For now it is exported from `@wren-cad/sketch`.

## ADR-056 — M3.5 kernel: exact sketch splines and elliptic arcs, knot defaults, knot-aware mass properties, exact projection (2026-11-09)

**Sketch curves are exact OCCT edges.** `ellipticArc` is a `gp_Elips` (major axis at `rotation`;
`minorRadius > majorRadius` swaps the axes and turns the frame by π/2, like `ellipse`) trimmed with
`GC_MakeArcOfEllipse(…, Sense = true)`, counter-clockwise from `start` to `end`. `bspline` is a 3D
`Geom_BSplineCurve` in the sketch plane from the pole points, `weights`, `knots`/`multiplicities`,
`degree` and `periodic` (a 2D curve mapped onto the plane would be the same curve; the 3D one needs
no extra conversion and its pcurve on the plane is exact). A clamped spline shares the vertices of
its end poles with the lines and arcs that end there, so joints are topological, not fuzzy; a
spline whose last pole is its first (or coincides with it) is one closed edge, and a periodic one
is a closed edge on its own; both bound a face without another curve. The General Fuse path
(fuzzy 1e-6 mm) is unchanged: G1 joints (spline tangent to the line at the shared pole) produce
no extra pieces. A solver-tolerance gap between an end point and its ellipse (≤ 1e-6 · max(1, a))
widens that vertex's tolerance to fit instead of failing `BRepLib_MakeEdge` (the same for arcs).

**Knot defaults (contract: "omitted = uniform").** Clamped: multiplicity degree + 1 at both ends,
interior knots `i / (n − degree)` for `i = 1 … n − degree − 1` with multiplicity 1, where `n` is the
pole count (so knots lie in [0, 1]). Periodic: `n + 1` knots `i / n`, multiplicity 1 (period 1).
Both are computed with one IEEE division per knot, so JS (`i / spans`) reproduces them bit for
bit. Explicit knots are OCCT's form: distinct, strictly increasing knots plus multiplicities, given
together or not at all; as in ADR-048 (which this confirms), an open spline's `knots` without
`multiplicities` is read as a flat knot vector when it has n + degree + 1 values (equal neighbours
collapse, exact equality), and anything else without the pair is refused. ADR-048's periodic
parametrisation is confirmed against the build: `Geom_BSplineCurve(…, periodic = true)` with the
default knots starts at (P₀ + 4P₁ + P₂)/6 and keeps the pole order (golden), and the modeling
workstream's four `curves.golden.test.ts` goldens pass against this kernel. Non-periodic splines must be clamped (end multiplicities
degree + 1: the contract says they start at the first pole and end at the last); interior
multiplicities ≤ degree. Knot values are only relative ([0, 5, 10] is the curve of [0, 0.5, 1]).

**Validation.** Every OCCT refusal is checked first and reported as `INVALID_INPUT` naming
`S…:e(<id>)`: degree not an integer in 1 … 25, fewer than degree + 1 poles, a weight ≤ 0 or not one
per pole, knots/multiplicities of different lengths or without each other, non-increasing knots, an
unclamped end, an interior multiplicity above the degree, a wrong total ("5 control points of
degree 3 need 9 knots counting multiplicity (has 10)"; periodic: the multiplicities without the last
knot sum to `n`), all poles on one point; an elliptic arc whose end is off its ellipse, with no sweep
or non-positive radii. A `Standard_Failure` from the constructor (not expected) is still caught and
becomes `INVALID_INPUT`; anything later is caught at the boundary as before.

**Naming and fingerprints.** Unchanged scheme: `S…:e(<id>)`, `F…:side(S…:e(<id>))` (side faces
are `extrusion` / `revolution` surfaces of the spline), and the `edge(…)` / `vertex(…)` rules.
Nothing in the naming assumes analytic curves (centroids are GProp's, deterministic). B-spline
edges report curve `bspline` (rational ones too), elliptic arcs `ellipse`; regenerating gives
byte-identical naming and fingerprints. Fingerprint edge lengths of free-form curves now come from
`GCPnts_AbscissaPoint::Length` (adaptive per span, 1e-10): `LinearProperties` was 1.5e-7 off on a
rational quarter circle.

**Mass properties are knot-aware for spline profiles.** BRepGProp's default integrates each curve
and surface with one fixed Gauss rule over the whole parameter range (`BRepGProp_Face::
IntegrationOrder`, `UKnots`), not per knot span, so a piecewise B-spline profile came out 1e-5
(uniform cubic) to 3e-3 (a C1 rational circle) off, and the adaptive `Eps` variant splits only at
B-spline *surface* knots, which an extrusion or revolution of a spline curve does not have. For
shapes with a planar face bounded by a free-form edge or an extrusion/revolution of a free-form
curve, `massProperties` and `measure` now convert to NURBS (`BRepBuilderAPI_NurbsConvert`, exact)
and integrate adaptively (relative 1e-12 requested, better than 1e-9 achieved; the run time
hardly depends on it: 1e-6 and 1e-12 cost the same). That
is about 3× the default on those shapes (a 14-face filleted spline solid: about 0.5 s against
0.16 s in a dev `-O1` build); every other shape, including fillet corner patches, lofts and
imported B-spline surfaces, keeps the M3 path and cost. Fingerprint face areas and the naming
centroids keep the default everywhere (matching keys, not measurements). If spline parts make
regen too slow, the alternatives are per-face integration (convert only the swept faces) or
`VolumePropertiesGK` with `IsUseSpan`, which knows extrusion-of-B-spline spans but not revolutions.

**Exact projection (`exact: true`).** Projection along a plane normal is affine, so it maps a conic
to a conic and a (rational) B-spline to the B-spline with the projected poles and the same weights
and knots; no `GeomProjLib` call is needed and nothing is approximated, for any source
orientation (not just planar edges on a parallel plane). With `exact: true` on `projectEdges` /
`projectFaceOutline`, circles seen obliquely and ellipses come back as `ellipse` / `ellipticArc`
(principal axes from the 2 × 2 map of the conjugate semi-diameters; counter-clockwise; still
`circle` / `arc` when the projection is circular), B-spline and Bezier edges as `bspline` (trimmed
with `Segment`, which also clamps; a whole periodic curve stays periodic); edge-on projections and
other curve types are sampled as before. The flag is opt-in so the M3 consumers (kernel-client's
own `ProjectedCurve`) stay valid until the modeling workstream maps the new kinds onto
`SketchEllipse` / `SketchEllipticArc` / `SketchBSpline` linked entities; the façade types are
`ExactProjectedCurve` / `ExactProjectedEdge`.

## ADR-057 — M3.5 viewport navigation: implementation choices (2026-11-09)

- **Camera-controls only handles the wheel, two/three-finger touch and programmatic moves.** Every mouse button, one-finger touch and non-drawing pen is driven by a pure `NavigationMachine` and applied by writing the camera pose directly (`setLookAt` without a transition). `setOrbitPoint` was rejected: it stores the pivot as a focal offset, which `getCameraState`, `getRoll` and the standard-view maths would all have to understand. Instead the orbit rotates the whole pose rigidly about the pivot (so the pivot keeps its camera-space position, and therefore its screen position) and re-places the controls' target on the view axis at the unchanged orbit distance. `draggingSmoothTime` is 0.
- **Trackball is ours, not camera-controls'.** Up is carried with the camera (`camera.up` plus `updateCameraUp()`), so the spherical state never reaches a pole. Switching back to turntable levels the camera in place (same position and target, up = +Z).
- **Turntable axis is `camera.up`**, which is +Z unless the two-finger twist rolled the camera. Rolling is an explicit user act and the existing standard views reset it.
- **Right drag under `middleOrbit` pans and under `middlePan` orbits.** The contract leaves right drag open; "a drag past the threshold navigates" (ADR-046) needs a verb. Pan suits the middle-orbits family (a right drag has no other use there), orbit suits the middle-pans family (Onshape-like).
- **`rightOrbitRepeat` timing.** A click released in under 250 ms repeats (`repeat: true`); a longer press opens the menu on release, so the 250-350 ms gap is not a dead zone. The contract says a hold is at least about 350 ms; opening the menu earlier is the friendlier reading.
- **`setPivot` remembers the point only as the fallback for the next orbit that starts on empty space.** Orbits that start on geometry always re-pick, which is what keeps panning and zooming from leaving a stale pivot. The remembered point is dropped on pan, on a preset change, and when it leaves the screen.
- **No stall on orbit start.** If the ID image is stale and a visible body has no BVH yet and the scene has more than 150 000 triangles, the pick is skipped and the pivot falls back to the bodies' centre; building a 1M-triangle BVH takes hundreds of ms.
- **`pickRect` faces come from per-face pixel counts of the half-resolution ID image.** Window mode compares the in-rectangle count with the whole-image count (cached per image). Edges and vertices are projected polylines; occlusion uses a 5 x 5 ID-buffer neighbourhood as a cheap "nothing in front" test, then the BVH ray. A stale ID image falls back to projected triangles filtered by a ray grid. Default kinds exclude `region` and `handle`.
- **A pen without `penDraws` orbits like a finger** (unchanged), and palm-rejected touches do not start an orbit.
- **Extra engine API `getNavigationState()`** (not in the contract) exposes the drag mode, pivot, pivot source and marker state for tests and for the integration step.

## ADR-058 — Simulation: built-in mesher, solvers on the user's desktop (2026-11-10)

Owner direction. Wren will support structural (CalculiX), CFD (OpenFOAM) and multiphysics (Elmer FEM; GetDP for low-frequency electromagnetics) analysis as a post-v1.0 track (PLAN §12B), with a meshing spike now. Specialised solvers are preferred over a general FEniCSx PDE builder (owner, 2026-11-10): they bring validated physics, documentation and user trust per problem class; FEniCSx stays only as a possible later expert-script mode.

- **Wren is the pre- and post-processor; the user's installed solvers compute.** Porting OpenFOAM to the browser is unrealistic (size, MPI, runtime plugins, hour-long runs in a tab); CalculiX needs Fortran → Wasm and hits the 4 GB / iPad memory ceiling; FEniCSx JIT-compiles forms. Running them natively on the user's desktop removes the resource limits and the porting risk, and keeps compute local (no Wren-hosted service, consistent with the free, local-first model). Meshing and simulation are desktop only (owner, 2026-11-10), so the mesher is sized for desktop browsers, not tablet memory limits.
- **A browser cannot launch native programs**, so solving goes through (1) file handoff: a case folder with a run script in the project folder, results imported when they appear; then (2) an optional localhost "Wren Runner" that only launches configured solver executables, paired by one-time code, streaming progress. Chrome's local-network permission and Safari's localhost behaviour need verifying in S2.
- **The mesher is built in** (owner): interactive meshing with quality feedback is the core of pre-processing, it lets Wren own the persistent-name → physical-group mapping so loads survive design edits, and one mesh feeds every solver. Gmsh (GPL-2.0-or-later) compiled to Wasm against the kernel's OCCT build, in its own lazily loaded worker; Netgen (LGPL) is the fallback; TetGen (AGPL) is excluded. CFD volume meshing stays with OpenFOAM's `snappyHexMesh` locally (boundary layers, hex-dominant cells).
- **Licences:** CalculiX GPL-2.0+, Gmsh GPL-2.0+, OpenFOAM GPL-3.0, Elmer GPL/LGPL, GetDP GPL, FEniCSx LGPL-3.0 — all compatible with Wren's GPL-3.0.
- **Commit to one capability, design for many (owner, 2026-11-10).** After v1.0 CAD, only structural analysis with CalculiX (S1) is committed. Solver breadth is not what distinguishes Wren (FreeCAD's FEM workbench already drives several free solvers); the workflow is: loads on persistent names that survive edits, versioned studies, a clean setup and results flow. Each extra solver is a lasting cost (writers, readers, install guides, version drift, CI, support). A documented solver-backend interface (case writer, result reader, setup fields, install check), with CalculiX as the reference backend, keeps OpenFOAM, Elmer, GetDP and preCICE coupling (licence LGPL-3.0, compatible) open as on-demand or community-contributed extensions without committing the roadmap to them. Solvers are not bundled; Gmsh is, once adopted (to be recorded in docs/DEPENDENCIES.md then).

## ADR-059 — M3.5 integration in apps/web: input, settings, radial, lineage (2026-11-10)

Choices made while wiring the M3.5 packages into the app. To be folded into ADR-046 / ADR-049 at the gate.

- **Settings is a panel, not a dialog.** `ui.settings` (`navigation` | `keyboard`) shows a lazy `SettingsPanel` over the view (`role=region`, no focus trap, no `aria-modal`). Desktop and tablet float it at the top right; touch and phone fill the stage between the top chrome and the sheet. It opens from a gear button in the project bar (desktop and tablet) and from the command palette ("Settings", "Keyboard shortcuts") on every tier; the phone top bar has no room for another button, so the phone reaches it through More (the palette).
- **Storage.** `wren.navigation` (the UI package's `readNavigation` / `writeNavigation`) and `wren.keymap` (the overrides as JSON, written by `app/input.ts`; an empty keymap removes the key). Both are read at construction, so the first `setNavigation` and the first key press already use them.
- **Long press versus the bubble.** The context bubble stays on tap-select (touch tiers, after the double-tap window). A long press, which used to open the bubble (or its view actions on empty space), now opens the radial menu; the radial's empty-space set carries the view actions (Fit view, Isometric, Undo, Redo). The mouse's right click, a long press and a held key share one layout. The Pencil gets its own 500 ms hold in the app (the viewport reports no gestures for a pen that draws), so `longPress` events with `pointerType: 'pen'` are ignored to avoid a second open.
- **What the ring holds** (≤ 7 + Repeat, `app/radial.ts`): nothing selected: Sketch, Measure, Section, Fit view, Isometric, Undo, Redo; one flat face: Sketch, Push/pull, Hole, Shell, Draft, Measure, Section; a curved face: Thread, Shell, Draft, Measure; several flat faces: Push/pull, Shell, Draft, Measure; edges: Fillet, Chamfer, Measure; a vertex: Measure, Plane, Axis, Point; a region: Extrude, Cut, Revolve, Sweep; in a sketch: Line, Circle, Arc, Rectangle, Dimension, Spline (through), Finish. A right click on unselected geometry selects it first (replacing the selection); on empty space the ring follows the current selection. Repeat runs `ui.lastTool` (act-first tools set it) or, in a sketch, the last sketch tool.
- **The radial key is Q** (`RADIAL_COMMAND`, global): free in every context, not a browser shortcut on its own, left hand beside the tool keys. A test asserts it is clash-free against `DEFAULT_COMMANDS`. It is recorded in the keymap, so it can be rebound; the hold is spring-loaded (releasing with no direction cancels).
- **Keymap switch-over.** `workbench.onKey` builds the binding with `eventBindingId` and asks `matchCommand` for `['model','global']` or `['sketch','global']`. The sketch toolbar keeps its own window listener (it owns variant cycling) but asks the app's keymap through the new optional `matchShortcut` prop, so tool keys follow the overrides in the same contexts; Esc stays the toolbar's. Consequences: sketch tool keys cannot use Ctrl or Alt (the toolbar ignores chords); view keys 0-7 stay model-only (they were never active in a sketch); `palette` (⌘K) is listed in the editor but handled by the shell's palette. Enter ends an open spline in a sketch, and in the model Enter first advances a list pick, then takes Tab's preselection.
- **Box select.** A left press in model mode (mouse or Pencil, not touch) arms a box; past 5 px it is a rubber band (`ui.box`, solid for window, dashed for crossing, canvas-relative like every overlay). It is off while a tool is picking (prompt, inspector pick, measure, section pick, push/pull) because those are single picks. The press is captured by the canvas so the band survives leaving it. Release calls `pickRect` with the current pick kinds; a plain drag replaces the selection (an empty drag clears it), Shift adds, Ctrl/Cmd toggles what the box covers. References resolve in the background like a click's.
- **Tab cycling** works on `lastPick`, the candidates of the pointer's last move (all hits within tolerance, sorted by kind, depth, id), only when focus is on the page or the canvas, so Tab keeps moving focus through the panels. Tab sets the hover; a click without moving, or Enter, takes it. The order is the chooser's (`sortCandidates`); the chooser itself now receives `depth` and preselects on hover and Tab.
- **Errors at the cause.** The statuses go through `followBlockedCauses` after `explainStatus`: a blocked feature's cause is followed through other blocked features to the first one that is not blocked. A name memory (`rememberedName`) lets "Extrude 1 was deleted" name a feature that is no longer in the document; the cause is plain text and the inspector offers **Undo** (`FeatureInspector.onUndo`, a small UI addition). A status with no engine cause keeps the generic text.
- **Dimensions.** Labels use the sketch package's `dimensionAnnotation(...)` for their position and the drawing, projected through `worldToScreen`. A drag moves a transient `dimDrag` (nothing is stored while dragging); release stores `label` as one undo step "Move dimension". Radius/diameter leaders map to `leader`; the first dimension line to `line`, further stubs to `extensions`; only the first of several annotation arcs is drawn (angles), the extension arcs are dropped. For a camera that is not square to the sketch the angle arc is a circle through the projected start and end.
- **Lineage** (`model/lineage.ts`): "Made by" is the latest feature in history that the persistent name mentions (`nameTouchesFeature`), and the sketch its own refs name (else the sketch in the name). Parents are, for each reference the feature holds, the latest feature that name mentions (a fillet's edge names the extrude and its sketch: the extrude); children are the reverse. Pattern and mirror sources that are whole features count as parents.
- **Exact projection.** kernel-client always asks the kernel for `exact: true` in `projectEdges` and `projectFaceOutline`; every consumer (Convert Entities, re-pick, `reprojectLinked`) therefore gets exact ellipses, elliptic arcs and B-splines.
- **Bundle.** The initial route was already 253.6 kB gzip (over the 250 kB budget) when M3.5 merged. The feature inspector and its hole and thread fields, the sketch toolbar, the sketch overlay (glyphs, dimensions), the radial menu, the settings panel, the keymap editor and the shortcut overlay are lazy chunks, which brings it to 243.6 kB after adding the M3.5 code (keymap, input, lineage, box select, Tab).


## ADR-060 — Tablet: Select tool, Clear selection, sketch visibility follows UI state (2026-11-10)

- Context: the owner found no discoverable way to drop a sketch tool or clear a selection on a tablet, and a sketch could stay shown after the cut-revolve that used it.
- Decision: the sketch toolbar gets an explicit Select tool (pressed when no tool is active), and on touch a ✕ "Done with <tool>" beside it. Both call `onSelectTool` (drop the tool at once) rather than the Esc path, which first cancels work in progress. Clear selection is a plain ✕ on the context bubble and in the selection inspector (never Esc-only on touch). Sketch visibility is re-evaluated from a subscription to the UI state it depends on (edited feature, picking path, prompt, active sketch) instead of from a list of call sites, so every path (Done, clear, Esc, tree) agrees; a revolve's axis reference counts as consumed. The exact original repro was not found (Done already refreshed in the flows tried); the subscription removes the whole class.
- The radial menu chunk is prefetched 1.5 s after the app is ready, so a first flick is never lost to a lazy download.

## ADR-061 — Pencil hold-to-grab in sketch mode (2026-11-10)

- With no tool, a pen press on unselected geometry starts a stroke and arms a 300 ms timer. If the pen stays inside the stroke slop, the stroke is dropped and the same solver drag the mouse uses starts on the picked entity (points, circle centres, curves, lines), highlighted through `highlightEntities`. Moving first is a stroke, which keeps the existing start-snap to a node. Dimensioned geometry behaves as the solver's drag does today (driving dimensions hold). Hover needs no new code: the pen hover already feeds the sketch preselect.
- Touch and pen presses that the app keeps (sketch drawing and dimensioning) no longer also start a camera orbit: the viewport hands them to the navigation machine in the window's bubble phase, so `stopPropagation` on the canvas keeps them out. This fixed the bracket tutorial's rectangle drag.

## ADR-062 — Simulation S1: accuracy safeguards and results checks (2026-11-10)

From the structural FEA research (`docs/ux-research/reports/Structural FEA best practices.md`, with sources in `research_notes/Structural FEA best practices/`). This refines ADR-058 for S1. Most wrong results in CAD-embedded FEA come from modelling mistakes, not the solver: over- or under-constrained supports, singular peak stresses read as real, meshes too coarse where it matters, unit errors, and linear analysis used beyond small deflection or yield. Wren therefore treats the guard rails as part of the feature, not as polish.

- **C3D10 only in S1.** CalculiX's manual calls C3D4 too stiff. Shells and beams are deferred: ccx expands them into 3D elements internally, with renumbered output, "knots" and no `*TIE`. C3D10T is used once thermal stress arrives.
- **Wren writes the CalculiX deck itself**, not Gmsh's INP export. That export writes no element-face surfaces and adds the boundary triangles as plane-stress elements.
  - Wren's deck uses contiguous numbering and the checked tet10 node-order swap.
  - Set names are sanitised and mapped to persistent names.
  - The deck is always written in mm·N·s·K, converting from unit-carrying inputs.
  - A force is always a **total** over the selection, applied as consistent nodal loads.
- **Mesh quality policy.**
  - minDetJac ≤ 0 is never sent to the solver. Wren refines locally and re-meshes, and failing that falls back to straight-sided elements with a notice.
  - minSICN < 0.1 warns and shows where.
  - No OCC healing by default, because it renumbers faces and would break persistent names.
  - Tiny features are suppressed only explicitly ("Suppress in study"), never on loaded faces.
- **Pre-run checks block** runs that cannot succeed or cannot mean anything: a missing material or a value the study needs; supports that leave rigid-body motion free; a disconnected mesh; an unresolved reference; an invalid element.
- **Failure detection does not trust the exit code alone.** `*ERROR` lines, NaN residuals and missing results also mean failure. Known messages are translated into plain language.
- **Results checks on every result:**
  - equilibrium (reactions balance the loads);
  - mesh mass vs CAD mass;
  - a mesh error indicator (averaged vs unaveraged stress, labelled indicative);
  - markers at likely singularities (re-entrant edges, edges of fixed faces, point or edge loads), pointing users to read stress away from them;
  - a large-deflection flag (displacement above about 10% of part size);
  - yield exceedance;
  - modal mass coverage, with 6 rigid-body modes expected free-free;
  - thermal balance.
- **Honest display.**
  - Averaged nodal stress is labelled as such.
  - The deformation scale factor is always shown, and True scale is one click away.
  - Automatic legend limits clip at a high percentile, but the true maximum stays shown and marked.
  - Results are hashed against their inputs and shown "out of date" when anything changes, never silently mixed with new geometry.
- **Convergence:** a deterministic "Check convergence" (three mesh sizes, a 2% criterion on probe peaks and strain energy). A peak that keeps rising is reported as a singularity, not chased. Error-driven adaptivity comes later.
- **Verification in CI with the real solver**:
  - NAFEMS LE1, LE10 (face idealisation documented), FV32 and FV52;
  - analytic cases;
  - a free-free modal check;
  - an under-constrained model that must be blocked;
  - the load-persistence test.
  
  The plan's earlier "FV52-class free plate" was wrong: FV52 is a simply supported plate, and the free plate is FV12.

Alternatives considered: trusting the user to check results themselves, as most free tools do. Rejected because Wren targets non-experts, and an unchecked colourful plot is worse than none. A full adaptive solver in S1 was also considered and deferred: the deterministic convergence check gives most of the protection at a fraction of the cost. Effort for S1 rises to about 12–14 weeks.

## ADR-063 — Coplanar overlays: a relative clip-space depth bias replaces `polygonOffset` (2026-11-10)

M3.5 gate blocker B1. The first bias (ADR-057 era) added `P[2][2] * bias` to clip z with `bias = 0.002 * distance`. That is a view-space pull of about `bias * D / near`, and `near = max(0.002 r, (d - 2r) / 2)` collapses toward `0.002 r` once the camera is within about 2 scene radii, so hidden edges, ghost edges and inactive sketches were pulled through the part (the gate's repro: iso, dolly to 1 x radius, sketch 3 mm inside the face, pixel diff far above 150).

- **`polygonOffset` is not used for overlays.** WebGPU applies it only to triangle lists, in raw depth units, with a slope term that is zero for coplanar geometry, so the same scene would draw differently on the two backends. Replacing it with a vertex-stage shift gives one behaviour on WebGPU and WebGL2.
- **The shift is relative: the overlay moves to `p * (1 - eps)` in view space.** Screen x, y are unchanged (the ray is the same) and only clip z changes: with `clip.w = -p.z` held, `clip.z += P[2][3] * eps / (1 - eps)` (`projectionMatrix.elements[14]`; in TSL `cameraProjectionMatrix * (0,0,0,1)` `.z`). The near plane cancels out: the pull is exactly `eps * distance` for any near/far. Unit-tested against three 0.187 `PerspectiveCamera` matrices (`packages/viewport/test/overlays.test.ts`). The viewport is perspective only; an orthographic camera would need `clip.z += P[2][2] * delta` with `delta` proportional to the visible depth range.
- **`eps` is 0.5 % (lead, at the gate).** A sketch on a face is exactly coplanar and OCCT body edges share the face triangulation's boundary vertices, so the bias only has to beat depth precision, not a geometric gap. Every extra percent lets hidden geometry through thin walls: the workstream's first choice, 2.5 % (sized to keep a sketch 0.15 mm *below* a face visible at 0.5 scene radii), bled through a 1 mm wall at the iso fit (4,248 pixels). `coplanar.spec.ts` pins both sides at the iso fit, 1 x and 0.5 x radius, on WebGL2 and WebGL2 with `polygonOffset` stubbed: 0.03 mm below the face is drawn; 1 mm (a thin wall) and 3 mm stay hidden. The remaining cost: geometry closer than 0.5 % of the camera distance behind a face can show through.

## ADR-064 — Simulation: CalculiX in the browser for small models (2026-11-10)

Owner direction. This amends ADR-058, which kept every solve on the user's desktop partly because CalculiX "needs Fortran → Wasm and hits the 4 GB memory ceiling". The Fortran part is now shown to be solvable: freecad-web runs CalculiX 2.22 in the browser (f2c → Emscripten, SPOOLES + ARPACK, about 4.8 MB of Wasm, within 1% of beam theory on its tests, single-threaded, contact still broken). The memory ceiling remains, so the browser path is for **small models only**.

- **Why:** installing CalculiX and running a script is the biggest friction in the S1 flow. In-browser solving gives a zero-install first study, works on locked-down machines (schools, company laptops), and allows quick checks that re-solve as the design changes. Instant results are what Onshape users praise most.
- **Same backend, different executor:** the CalculiX deck writer, result reader, pre-run checks, failure classification and Results checks are shared. Only where `ccx` runs changes: a lazily loaded solver worker, file handoff or the Runner. The solver-backend interface gains an `executor` choice, not a second backend.
- **Routing by estimated size:** Wren estimates unknowns and SPOOLES memory (the manual's rule is about 32 GB per 1M equations) before each solve. Under the per-study-type limit measured in S0b (expected roughly 100k unknowns in wasm32) the model solves in the tab; above it, Wren says so plainly and offers the local solver. The user can always choose the local solver.
- **Costs accepted:**
  - Wren maintains its own CalculiX build for each release.
  - CI runs the benchmark suite on both the Wasm and the native builds, and their results must match.
  - Routines that are not ported must fail loudly.
  - Distributing the GPL Wasm requires publishing the build scripts and corresponding source.
  - A solve dies if the tab closes.
  - Expect native speed at best and slower in practice, single-threaded unless the pthreads build proves out.
- **Gate:** the S0b spike (PLAN §12B). If the Wasm build gives wrong answers or too small a limit, S1 ships with local solving only. Nothing else in S1 depends on it.

Alternatives considered:
- **Desktop-only solving (ADR-058 as written):** rejected for the first-run friction.
- **Hosted cloud solving:** rejected; it conflicts with free and local-first, and Fusion's per-solve credits are a top complaint.
- **Rewriting a small solver in Rust or TypeScript:** rejected; CalculiX is verified, and a new solver would need its own validation.

## ADR-065 — Long-press yields to queued input after a busy main thread (2026-11-10)

M3.5 gate finding. The gesture recogniser times presses from event timestamps (`eventTime`), which is correct when the main thread stalls: a press is as long as the finger was really down. But its long-press deadline is enforced by a timer. When work started by the press (a pick, a lazy chunk, a regen) keeps the main thread busy past the deadline, the timer and the queued lift become runnable together. Chromium could run the timer first, so a 50 ms tap fired as a long-press.

On a loaded phone run (E2E `m2-phone`, failing 10–30% on the M3.5 branch, never on main) that opened the radial menu in "held" mode. The user's next tap, on the context bubble's Measure, then counted as a press outside the menu: it cancelled the menu, and the menu's one-shot click guard swallowed the click.

- **Decision:** a long-press timer that fires more than `LONG_PRESS_JANK_MS` = 12 ms late (was 80 ms) gives queued input one `LONG_PRESS_GRACE_MS` (60 ms) chance first. So does a timer that fires while Chromium's `navigator.scheduling.isInputPending()` reports input waiting. 12 ms is a little above normal timer jitter.
- **Cost:** under load a genuine long-press can come up to 60 ms later.
- **Evidence:** `m2-phone` passes 20/20 with its original 5 s budget (before the fix: 2–3 failures in 10). `touch.spec.ts` gains a stall test as a guard; on its own it does not reproduce the race, since Chromium happened to deliver the lift first there.
- **Follow-up (not a blocker):** the radial menu could open in tap mode, not held mode, when its pointer has already lifted before the lazily loaded menu mounts.

## ADR-066 — Feature tree folders and per-sketch visibility are document data (M3.6, 2026-11-10)

Owner requests (M3.6).

- **Folders.**
  - **Structure.** `Part.folders` holds `FeatureFolder { id, name, features }`. The members are explicit ids forming a contiguous run in history order. Folders do not nest and never overlap.
  - **Explicit membership, not first/last bounds.** Folders merge cleanly by id: a rename on one branch and a move on another combine, and membership is a plain set to three-way merge. Collapsed/expanded is per-user UI state and is not stored, so toggling it never creates undo entries or history noise.
  - **Edits keep the run contiguous by construction** (rules in `Command`):
    - removing a feature drops it from its folder, and an emptied folder disappears;
    - moving a member outside its run takes it out of the folder;
    - a non-member moved or inserted strictly inside a run joins the folder;
    - landing just before the first or after the last member does not join.

    So no edit can split a run. The UI's "this will take Fillet 3 out of Mounting" confirmation is a courtesy, not a guard.
  - **Merges that produce a non-contiguous run** (each side moved features independently) are normalised deterministically:
    1. sort the members into history order;
    2. if the run is broken, extend it over the gap when that overlaps no other folder;
    3. otherwise keep the longest contiguous run, taking the earliest on a tie, and drop the rest from the folder.

    The merge report lists any membership change made this way.
- **Sketch visibility.** `SketchFeature.visibility` is `'auto' | 'shown' | 'hidden'`, with absent meaning `'auto'`.
  - `'auto'` keeps ADR-060: shown until consumed, then hidden.
  - The eye toggle in the tree (nested or flat) writes `'shown'` or `'hidden'`. "Show all / Hide all sketches" and a folder's "Show/Hide sketches" write them in one undo entry (`setSketchVisibility` with several ids). "Reset sketch visibility" writes `'auto'`.
  - It is document data rather than view state because a reviewer opening a shared file should see what the author chose to show (SOLIDWORKS stores it the same way).
- **Bulk suppress.** `setSuppressedMany` gives a folder's "Suppress all" one undo entry and one regeneration.
- **Schema.** These are additive fields, so `schemaVersion` goes from 1 to 2 with a no-op migration (FILE_FORMAT §7). M3.5's new curve kinds were added under v1 without a bump; this one bump covers both, so an older Wren shows "update" instead of a validation error.
- **Phone step-through needs no document change.** Stepping previews a rollback position by regenerating a copy of the document with a different `rollbackIndex`, and only "Keep this rollback" writes `setRollback`.

## ADR-067 — Folder rules the document layer had to interpret (M3.6, 2026-11-10)

Implements ADR-066 in `packages/document` (`folders.ts`, `commands.ts`).

- **Strict validation, repairing load.** `validateDoc` reports every folder problem (missing members, non-contiguous run, overlap, out of history order, empty folder). The load path (`migrateDoc`, hence `fromFiles` and `DocumentStore.load`) first runs `normalizeFolders` on parts whose folders are well-typed, so a merge that left a broken run loads repaired. Wrong types (a non-string name, `features` not an array) are load errors.
- **A feature held by two folders** (each branch added it to a different folder) stays with the folder of the lowest id.
- **A folder whose last member leaves goes** (M3.6 gate B1, replacing "a one-feature folder follows its member"). Moving a folder's only member is an ordinary `moveFeature`: the member leaves (and joins another folder if it lands strictly inside one's run), and the emptied folder is removed. Moving a whole folder is `moveFolder` (dragging the folder row). The exception made the store disagree with the tree, which predicts membership from the Command rules: dragging Extrude 2 (with its nested sketch) out of a folder created from it left an invisible folder holding only the sketch.
- **Raw `patch` commands** are normalised in the same undo entry; `addPart` repairs the folders it is given.
- **`moveFolder` and the rollback bar:** the run is evaluated iff it lands before the bar of the other features (the `moveFeature` rule for a run). It is refused when a member would cross geometry it uses or that uses it.
- **Labels for bulk commands** count the features actually changed and name the feature when there is one.

## ADR-068 — M3.6 in the app: one visibility resolver, a view-only step preview (M3.6, 2026-11-10)

Implements ADR-060, ADR-066 and ADR-067 in `apps/web`.

- **One resolver for sketch visibility.** `sketchShown` (`model/sketch-visibility.ts`) decides which sketches the viewport holds and which eyes the tree draws; the workbench keeps the resulting set in `shownSketchIds` and passes each sketch's resolved `shown` to the tree, so the eye cannot disagree with the viewport. Order of rules: the sketch being edited is shown; `'shown'` shows; a pick of regions, sketch curves or points shows (a hidden sketch must be pickable); `'hidden'` hides, even when nothing consumes it; otherwise the ADR-060 rule (shown while unconsumed or while its consumer is open in the inspector).
- **A rolled-back consumer does not consume.** Consumption now counts only features before the rollback bar (the previewed position during a step-through). Before, a sketch stayed hidden after its extrude was rolled back and the model showed nothing of it. The check is by index, so a suppressed consumer still hides the sketch, as before.
- **The step preview is a copy of the document, not a document change.** `Workbench.preview` holds a rollback position; `viewDoc()` returns the document with that `rollbackIndex` (memoised on the document identity, so the regen loop sees a stable value). It goes through the ordinary regen path, so the worker's per-feature result cache serves stepping back and forth (the features are unchanged; only the walk stops earlier), and nothing writes: `onRegen` treats the result as not current (no feature statuses, no mesh cache, no heals), no command is applied, so no undo entry, autosave or sync. `keepPreview` is the one write (`setRollback`, key `rollback`).
- **Any document change ends the preview** (`onDocChange`: an undo, a sync merge, a load), before the regen it triggers, so the full model comes back without a stale copy being drawn.
- **Collapsed folders and tree multi-selection are workbench UI state.** Collapsed ids are stored per document id in `localStorage` (`wren.collapsedFolders.<docId>`, try/catch), never in the file. The multi-selection lives in the workbench so the radial menu and the palette can act on it.
- **The radial menu leaves "Add to new folder" out when the picks cannot be grouped.** The ring has no room for a reason; the tree menu and the palette show it disabled with its reason.
- **Merge UI.** The merge panel takes `notes` (`mergeNotes(result)` summaries, shown even with no conflicts), a `conflictTitle` and a `conflictSummary`, so folder and visibility conflicts read as "Sketch 2 visibility: shown vs hidden". A clean version merge puts the notes in its toast.
- **Measured** (demo bracket, 6 steps, Chromium with software GL, phone viewport, coarse meshes): a step is on screen in 13 to 51 ms when the shape was shown before, 250 to 440 ms the first time a position is meshed (the regen results themselves are cached from the full-model regen).
- **The feature tree is its own chunk.** With the M3.6 tree (folders, prompts, step bar) in the shell, the initial route was 255.3 kB gzip (247.0 before M3.6, budget 250). `FeatureTree` and `PhoneFeatureTree` are now `React.lazy` in the shells (`TreePanel`, like `ParamsPanel`), and the nest-sketches preference moved to `logic/nestPref.ts` so the app can read it without importing the tree. Initial route: 243.3 kB gzip (sum of the `index.html` script chunks). The tree shows "Loading features…" for the moment its chunk takes on a cold visit.

### Amendment to ADR-068 (2026-11-10, owner request): the phone uses the real rollback bar

The phone's Features tab no longer has a step-through. Owner: "we don't need the next and back buttons ... just the tree and the drag line that lets the user change what's suppressed and rolled back to. The current view is too busy and confusing."

- The Features tab renders the same `FeatureTree` as the tablet sheet (`density="touch"`, via `TreePanel`). The rollback bar is draggable by touch: on touch density it is a 44 px target with a grab handle, and dragging writes `setRollback` as on desktop and tablet (an ordinary undoable edit; the regen follows live).
- A long press on a row opens its menu (Suppress / Unsuppress, Rename, Edit, the eye); suppression is a normal undoable edit.
- **Removed** (not kept as dead code): the document-neutral preview mode (`Workbench.preview`, `viewDoc()`'s preview copy, `previewRollback` / `keepPreview` / `endPreview`, the step timings and the `preview` / `previewTimings` test hooks), `PhoneFeatureTree` / `FeatureStepper` and `treeSteps` (`buildSteps`, `stepAt`, `stepLabel`) in `packages/ui`. The sketch-visibility resolver now reads `part.rollbackIndex` only, and "any document change ends the preview" no longer applies. The first bullets of ADR-068 about the preview are superseded by this note.

## ADR-069 — Addendum to ADR-057: wheel zoom is ours, anchored on the surface under the cursor (2026-11-10)

Owner report: desktop wheel zoom "very laggy, doesn't control well". Measured on the viewport harness and the demo bracket (Chromium, software GL), M3 (437f8a0) against the M3.5 head (836867c).

- **Cause 1: camera-controls' wheel dolly is wrong for pose-writing navigation.** It scales the distance to its *target* (the orbit rewrite of ADR-057 leaves the target wherever the last orbit put it, not on the surface the user looks at) and, because a wheel event sets `_isUserControllingDolly`, it eases with `draggingSmoothTime`. M3 had that at 0.06 s; ADR-057 set it to 0 so drags follow the pointer 1:1, which silently turned every wheel notch into an unsmoothed 16 % jump (and a 1M-triangle model scrolled through its own surface: the camera ended inside it). Near the target the step shrinks toward nothing, so the zoom crawled or stopped in front of a surface it had not reached.
- **Cause 2: rest-time work ran between notches.** `frame()` kicked the ID-buffer refresh (an extra render of the scene plus a readback) the moment the loop idled, about 0.2 s after a notch with `smoothTime` 0.18, and the BVH prebuild followed on the next idle slot. At 1M triangles that is a 384-456 ms task (measured) landing between two notches of a slow scroll.
- **The wheel is handled in `viewport.ts` (`onWheel`, `stepWheel`) with the pure maths in `zoom.ts`.** A capture listener on the canvas stops camera-controls' own wheel handler (and its ctrl+wheel pinch zoom). Each gesture resolves an anchor: the surface point under the cursor (ID buffer, or the BVH when the model is small; a BVH over 30 000 triangles is never built synchronously) or, on a miss, the point on the cursor ray at the depth of the scene centre. The camera slides along the cursor ray toward the anchor, so the anchor stays under the cursor and every notch scales the distance to it by `WHEEL_ZOOM_PER_NOTCH` (0.85). The controls' target is re-placed on the view axis at the anchor's depth, so `distance`, the clip planes and `dist` of the next orbit follow the surface the user is working on. The anchor is kept while the cursor stays within 3 px and the wheel turns at least every 400 ms, then re-picked. Distance to the anchor is clamped to [0.005, 200] scene radii.
- **Smoothing is frame-rate independent and modest:** exponential in log distance with `WHEEL_SMOOTH_TAU_S` = 0.05 (28 % of a notch on the first 60 Hz frame, 95 % in 150 ms). Reduced motion applies each notch at once. All constants are in `constants.ts`.
- **Interruptions.** Any other writer that moves the camera drops the gesture (the pose is compared with what the wheel last wrote). A drag that starts mid-zoom lands the zoom first. Wheel events during a drag are ignored.
- **Rest work waits for stillness.** The ID refresh starts after `REST_WORK_DEBOUNCE_MS` (220) without camera movement or wheel events; the BVH prebuild for a model over 150 000 triangles after `BVH_PREBUILD_QUIET_MS` (1500), because a build is one uninterruptible task. `whenPickReady()` skips the debounce (its guarantee is unchanged), and the orbit-start pick budget of ADR-057 is untouched.
- **Presets.** `setNavigation` never touched `controls.mouseButtons`; the preset only selects the `NavigationMachine` mapping, and no pointer event comes from the wheel. Under `middleOrbit` a loose wheel click is a middle click, which calls `clickSetPivot` (a pick, the pivot marker and a `setPivot` gesture); the wheel E2E presses the middle button between notches to show that the zoom is unaffected. The E2E runs the wheel cases under all four presets.

## ADR-070 — The regen engine split: an explicit context object, executors by feature family (H1, 2026-11-10)

`packages/kernel-client/src/regen/engine.ts` (4,714 lines) is split by responsibility without a behaviour change (module map in the package README and the engine header). Non-obvious choices:

- **An explicit `EngineCore` instead of `this`.** The executors were private methods sharing the engine's fields. They are now free functions taking `core: EngineCore` (the kernel, the lazy sketch solver, re-projection, mesh quality and the per-handle caches) only when they need it, plus the existing `WalkContext`. The per-part caches moved into `ResultCache`. A function's body is the method's body with `this.x` → `core.x` (or a direct call); names, messages, cache keys and error codes are unchanged. The split was generated mechanically from the original file, one module per commit, and each step was checked to contain every original method and declaration verbatim (whitespace and that plumbing aside).
- **Public types moved to `regen/types.ts` and are re-exported from `engine.ts`**, so every importer (the package index, `modeling-api.ts`, the tests) is untouched.
- **Body-modifying features (`exec-modify.ts`) are separate from solid-creating ones (`exec-solids.ts`)** to keep both well under 1,500 lines. `runOnBody` (shell, draft, hole) and `sameSolid` (cut, import) are shared across modules rather than duplicated.
- **Memory guard.** `RegenEngine.memoryStats()` and `ModelingApiInternals.memoryStats()` (live façade handles, the Wasm heap via the module's `wasmMemory`, cache entries and handles per slot, per-handle caches, configured bounds) are also exposed as `ModelingApi.memoryStats()`, which is now in the contract. The bounds are checked by `test/regen/memory.test.ts` at 200 features.

## ADR-071 — H1 guardrails: file sizes, bundle report, gating viewport perf, soak (2026-11-10)

- **File sizes.** `scripts/check-file-sizes.mjs` (`pnpm check:size`, also run by `pnpm lint` and the CI lint job) warns past 1,500 lines and fails past 2,500 for `.ts`/`.tsx` under `packages/*/src` and `apps/*/src`. Current offenders sit in `scripts/file-size-allowlist.json` with their line count as a ceiling; a listed file that grows fails, one that shrinks prints a note to lower the ceiling, one under 2,500 prints a note to delist it. On pull requests CI also runs it with `--base origin/<base>`, which fails a new entry or a raised ceiling in the list itself. Lines are counted as `wc -l` does; no comment stripping, so splitting is the only way down.
- **Bundle report.** `apps/web/scripts/bundle-report.mjs` (`pnpm --filter @wren-cad/web bundle-report`) lists every JS file in `dist/` with raw and gzip size and marks the ones `index.html` loads eagerly (same definition as `.size-limit.mjs`) as initial and the rest as lazy. It prints the initial-route headroom against 250 kB, appends Markdown to the job summary and uploads `bundle-report.{md,json}`. The gate remains `size-limit`. A new editor appearing in the initial list stopped lazy-loading.
- **Viewport perf probes gate.** The perf job runs `packages/viewport` probes with `WREN_PERF_ASSERT=1`; every time budget is multiplied by `PERF_FACTOR` (`packages/viewport/e2e/perf-budget.ts`: CI 3, local 1.5, `WREN_PERF_FACTOR` overrides; the same rule as ADR-010's `apps/web/e2e/perf/budgets.ts`). The compare "toggle" probe measures a frame's render CPU, about 20 ms on SwiftShader against the 16 ms real-hardware budget; it now gates at 16 x factor instead of staying informational. Picking gained two assertions (repeat picks <= 2 ms x factor, orbit render CPU with picking <= 8 ms x factor).
- **"Execution context was destroyed".** Not reproducible with a warm or a cold `node_modules/.vite` locally, so the cause is inferred: the dev-server harness re-optimises dependencies it discovers late and reloads the page, which kills an in-flight `page.evaluate`. The perf job therefore serves the harness's production build (`WREN_VIEWPORT_PREVIEW=1`: `vite build && vite preview`), which has no optimiser and no HMR. If it still appears on CI, the next suspect is a renderer crash from memory pressure at 1M triangles.
- **Soak.** `apps/web/e2e/soak.spec.ts`, Playwright project `soak`, skipped without `WREN_SOAK=1`, excluded from the other projects, run nightly and on demand by `.github/workflows/soak.yml` (not a job in `ci.yml`, so the nightly run does not repeat the suite). It reads kernel handles and the Wasm heap through `window.__wrenKernel` (`apps/web/src/app/kernel-memory.ts`) and the JS heap and process tree through CDP.
- **Kernel memory guard (app side).** `ModelingApi.memoryStats()` (contracts, ADR-070) feeds the Runtime panel (live handles, Wasm heap, regen cache entries and handles) and `window.__wrenKernel`. The Runtime panel of the desktop shell shows them (polled every 2 s while the panel is open, never otherwise). Tablet and phone shells have no Runtime panel yet.

- **Amendment (2026-11-11): the iPad tutorial E2E.** CI run #55 failed the touch-only bracket tutorial when its 300 s test timeout ran out, at about the same point on both attempts. Locally the test passes in about 250 s under load, including with 4× and 10× CPU throttling, and passes on both sides of the ADR-077 change. The 300 s figure is PLAN M2's human acceptance target on a real iPad, not a budget for an emulated touch run on a 2-vCPU software-rendered runner. Its assertion and timeout now scale by `PERF_FACTOR` like every other time budget, and the run time stays in the log. The real-device target is still checked by the device checklist.

## ADR-072 — Large-class splits: plain functions on an explicit context, delegates on the class (H1, 2026-11-10)

How H1 split `viewport.ts` (3,860 → 628 lines, 15 modules), `workbench.ts` (3,540 → 1,481 after later work, 13 modules) and the regen engine (ADR-070). The goal was to keep each public surface byte-for-byte the same while moving code out of the class.

- **Method shape.** Each moved method became an exported function whose first parameter is the instance or an explicit context: `fn(vp: ViewportImpl, …)` and `fn(wb: Workbench, …)`. The class keeps a one-line delegate with the same signature. Void methods call through, and async methods return the promise without becoming `async`, so microtask order is unchanged.
- **Visibility.** Fields and helpers the modules need lost `private`. The classes are wider internally, but the exported interfaces (`ViewportEngine`, the `Workbench` surface the app uses) did not change. Modules import the class as a type only, so there are no runtime import cycles.
- **Verification.** Moves were done by script and checked by diffing the moved bodies against the originals after normalising whitespace and the `this.` → context rewrite. No test expectation changed.
- **Size limits.** The file-size guardrail (ADR-071) now has an empty allow-list. No source file is over 2,500 lines. The ones over the 1,500 soft limit are `sketch/src/model.ts`, `sketch-session.ts`, `sync/controller.ts` and `git.ts` (`FeatureTree.tsx` is 1,237 lines after the folder and menu splits, under the limit), and they are the next candidates when they are next changed substantially.
- **Rejected alternatives.** Mixins and multiple inheritance were rejected because they hide where a method lives. A full rewrite into services was rejected because it is not behaviour-preserving, which H1 required.

## ADR-073 — Section view: an always-visible exit chip, a tiltable plane and its manipulator (2026-11-10)

Owner: "hard to turn off, and section doesn't let you rotate the cut plane at all." The root cause of the first was that `closeSection()` only hid the panel, so the cut stayed on with no control.

- **Chip, not a mode.** `SectionChip` (packages/ui) shows whenever `section.enabled`: Section, Flip, Edit, Exit section; 44 px targets on touch tiers, full labels, wraps rather than truncates on a narrow phone. It is a `<fieldset>`, not a dialog. It sits bottom-centre above the command bar or sheet (`--chrome-bottom`), and above the prompt chip, toast or sketch toolbar when one is up, so it never covers the view cube (top right), the top bar or the Library button (top left). Closing the panel (Edit again, or Esc) leaves it. `exitSection()` is the single exit path: enabled false, panel closed. Every way of turning the section off (`setSection({ enabled: false })`, which the panel switch and Exit use) also resets both tilts, so a new section starts level and nothing stays tilted behind the scenes.
- **Esc chain.** `cancel()` ends the section last, after a selection, the panel, the library, project and welcome overlays (and never in sketch mode), so Esc "exits when nothing else is active". An open panel is one more thing: the first Esc closes it, the second exits.
- **Plane maths** (`apps/web/src/model/section.ts`, pure, unit-tested). Each base plane has a right-handed frame (u, v, n0): X gives (Y, Z), Y gives (Z, X), Z gives (X, Y), and a face gets a deterministic u from the world axis least aligned with its normal. The normal is `Ru(a)·Rv(b)·n0`, i.e. in frame coordinates `(sin b, -cos b sin a, cos b cos a)`. This is invertible in closed form (`b = asin(n.u)`, `a = atan2(-n.v, n.n0)`), which makes "snap to the X/Y/Z planes" exact for any base. Two Euler-style angles cannot both be exact rotations about the plane's *current* in-plane axes: `b` is about the plane's current v axis (the manipulator's second arc), `a` about the fixed base u axis (the first arc). The offset stays "the world coordinate along the base axis" at zero tilt (the existing slider and E2E semantics), and a tilted plane moves along its normal through the part's bounding-box centre (axes) or the face centroid (faces). The range follows the tilted normal. Caps needed no change: the stencil cap quad is already built from an arbitrary normal.
- **Manipulator without a contract change.** `HandleSpec` only has `arrow`. The offset arrow is an `arrow` handle along the (flip-aware) normal. Each rotation arc is a dashed polyline `Marker` plus a short tangent `arrow` handle on it as the grab target, so hit areas are the handle ones (22 px tolerance on touch plus 8 px pad) and screen-space sizing comes free. The marker geometry is rebuilt on camera changes (once per frame) from a world-per-pixel estimate, so the arcs stay about 78 px in radius at any zoom. A real arc handle kind (a torus segment with exact arc hit testing) is the proposal below if the tangent grips prove too small or too ambiguous.
- **When it shows.** While the section is enabled (not only with the panel open), except in sketch mode, during push/pull and while picking a face. The owner asked for an easy exit and a rotatable plane, so discoverability beats the small clutter of a 156 px gizmo; the chip's Edit only toggles the numeric panel.
- **Drag.** Same recipe as push/pull: plane, handles and arcs are applied in the pointer handler, React catches up once per frame. An arc drag integrates the pointer's motion along the arc's screen tangent each event, so it follows the circle through any angle, and an end-on arc (under 10 px/rad) is ignored rather than jumping. Snapping: Shift (mouse) or a held second finger (touch) gives 15 degree steps; otherwise within 3 degrees of an X/Y/Z plane (either side) the normal snaps onto it. The second-finger rule is implemented but not covered by an E2E: the viewport may read the second touch as a pinch.
- **Persistence.** None. `SectionUi` (UI state) gains `tiltU` and `tiltV` (radians); a new axis, face or enable restarts level.
- **Probe.** The viewport's touch stats gained `sectionNormal`, `sectionOffset`, `capsDrawn` (bodies whose cap is drawn) and `capColor` (the cap fill, so E2E can count real cap pixels), and the app hooks `sectionGrips()`.
- **Manipulator and tools.** `SectionTool.onUiChange()` runs from the workbench's UI subscription, so the handles go away when push/pull or a sketch starts and return when it ends; camera re-placement also respects `wanted()`.
- **Phone tree.** The 44 px touch rollback bar now has its own 44 px gap in the list flow, where it sits (the bar is no longer drawn over the rows around it). The gap is excluded from the rollback stops, so they do not move while the bar is dragged, and a pointer position is mapped back to the layout without the gap.
- **Contract proposal (not made).** If arcs need to be first-class: `HandleSpec` gains `{ kind: 'arc'; origin: Vec3; axis: Vec3; start: Vec3; sweep: number; radius?: number }` (radius in CSS px, constant while zooming), drawn as a thick arc and hit-tested against the arc; `PickHit` for it stays `{ kind: 'handle', entity: <id> }`.



## ADR-074 — Part configurations: sparse overrides over an implicit Default, resolved before regen (M3.7, 2026-11-10)

Owner decisions D1–D4 are in PLAN §M3.7; the research is `docs/ux-research/reports/Drawings and configurations UX.md` (List 1).

- **Model.** `Part.configurations: Configuration[]` sits over an implicit **Default**, which is the part as stored, with `Part.activeConfigurationId` (absent = Default) and `Part.properties` (Default's part number and description).
  - **What a configuration stores:** only what differs from Default.
    - `params`: paramId → Expr. A configuration's override of a document-level parameter applies only while that part regenerates (D1).
    - `features`: featureId → `{ suppressed?, fields? }`. `fields` maps a JSON pointer inside the feature to a value: any `Expr` field, plus the option fields the document package lists in `CONFIGURABLE_OPTIONS` (D2).
    - `material` (`null` = none), `color` and `properties`.
  - **Identity:** everything is keyed by id, so renames never break merges or consumers.
  - **No derived configurations** (trap T5).
- **Resolution before regen.** The document package's `resolveConfiguration(doc, partId, configurationId?)` returns the effective document: Default plus overrides. Regen, the kernel and the cache need no changes. Cache keys are value-based, so switching between already-built configurations reuses results.
  - Background builds of non-active configurations use `RegenSlot` `config:<id>`, which keeps them in separate cache slots. They serve the rebuild-all status, per-configuration export and mass, and later drawings and assemblies.
  - An override that no longer applies (its feature, parameter or path is gone) makes that configuration's feature "needs attention". It is never silently dropped.
- **Edit scope at the point of edit** (Fusion's rule). The UI decides scope; the commands only express it.
  - Editing an inherited value edits Default with the ordinary commands, so it applies to all configurations that inherit. The UI shows an undoable "Changed in all N configurations" notice.
  - Editing an overridden value, or using the explicit "this configuration only" chip, writes `setConfigurationOverrides`.
  - There is no sticky scope mode (trap T1).
  - New features are never suppressed in other configurations automatically (T3).
- **Commands:**
  - `addConfiguration`, with `from: 'default' | id` (D3: the UI offers Default or Active, defaulting to Active);
  - `renameConfiguration`;
  - `removeConfiguration` (if it was active, Default becomes active);
  - `setActiveConfiguration`;
  - `setConfigurationOverrides`, a batch with one undo entry, used for a table paste;
  - `setPartProperties`.
- **Part number (D4).** When unset, a part number resolves to "<document name>-<configuration name>". Exports name files after it, and collisions warn, never overwrite.
- **Merge.** Structural merge (ADR-0xx M2.5) treats configurations as id-keyed records and each override as a cell. Edits to different cells merge cleanly; the same cell edited on both sides conflicts. A delete on one side against an edit on the other conflicts. Two sides adding the same name keep both ids, and the duplicate name is flagged.
- **Schema.** All additions are optional fields, so `schemaVersion` goes from 2 to 3 with a no-op migration (FILE_FORMAT §7).
- **Two kinds of "no longer applies"** (clarified at merge time):
  1. An override whose **feature or parameter is deleted** is removed together with it. This happens in the same undo entry when deleting in the app, and with a plain-language merge note when a merge deletes it ("Overrides of Fillet 3 in Long were removed with the feature"). The target is gone, so there is nothing left to attend to.
  2. An override whose target still exists but no longer fits (an invalid pointer, a wrong option value, a required expression left empty by a kind change) is **kept** and reported by `resolveConfiguration` as an issue. That configuration's feature shows "needs attention"; it is never silently dropped.

## ADR-075 — `packages/sketch` is `sideEffects: false`: the barrel stays out of the initial route (2026-11-10)

The initial route imports only `Namer` and `constraintLabel` from `@wren-cad/sketch`, but without a `sideEffects` flag Rollup kept every barrel module it could not prove pure. `bspline`, `geometry`, `tools`, `draft`, `curve-ops`, `annotation`, `inference` and `explain` then landed in the entry chunk or a shared `curve-ops` chunk that `index.html` loads eagerly (about 18 kB gzip). Marking the package `"sideEffects": false` lets the bundler drop them: the initial route went from 248.2 to 230.2 kB gzip (headroom 1.8 to 19.8 kB). The sketch modules are pure (no top-level mutation or registration); `./worker` and `./core` are entry points and are unaffected. If a sketch module ever needs an import-time side effect, list it in `sideEffects` instead of removing the flag.

## ADR-076 — The radial menu draws at once; flicks keep a 250 ms window (2026-11-10)

Owner feedback: on desktop, the right-click menu "takes a while to load". There were two causes:

1. ADR-046 held mouse and pen menus back for 250 ms, so a blind flick could run before anything drew.
2. `openRadial` awaited `selectHit`, which waits for the hit's persistent reference to come back from the kernel worker before opening. That round trip is slow while the kernel is regenerating or still booting.

**Decision.**
- **Every source draws at once.** `RadialMenu` keeps `drawDelay`, but it now defaults to 0.
- **Flicks keep a window.** A mouse or pen flick still works for `flickWindow` ms after the menu opens (default 250), drawn or not. Experts lose nothing, and everyone else sees the menu immediately.
- **Edge exception.** When the menu is pushed in from a screen edge, the pointer is no longer at its visible centre. In that case flicks stop once the menu is drawn, so the direction you see is always the direction that selects.
- **No kernel wait.** `openRadial` sets the selection synchronously and opens the menu; the reference resolves in the background, tracked so `idle()` still waits for it. The menu's items depend only on the selection, which is already set.

**Consequences.** Moving the mouse quickly toward an item in the first 250 ms selects it, which is the item the user was heading for. After the window, movement never selects, as before. User customisation of the ring and of the flick window is planned in M3.8.

## ADR-077 — Sketch dimensions: click selects, labels follow their geometry, leaders leave geometry grabbable (2026-11-10)

Owner bug report: after dimensioning a circle, its centre could not be grabbed, the circle seemed to "rotate about the dimension" when moved, and Delete did not remove a dimension. There were three causes:

1. A diameter leader runs through the centre point, and its 12 px transparent hit stroke took the press.
2. A placed label is stored in absolute sketch coordinates (`DimensionConstraint.label`), so when the circle moved, the leader swung round the fixed label.
3. A click on a driving label opened its editor, so Delete edited the field's text.

**Decision.**
- **Hit areas leave geometry free.** `DimensionGeometry.clear` lists points the hit area keeps 10 px clear of (`clipSegment`). For radius and diameter leaders these are the centre, both ends and the arrow tips. The strokes still draw in full.
- **Labels follow their geometry.** After every solve (`commitEdit`) and every drag step, `carryLabels` moves each placed label by the movement of its geometry anchor:
  - radius, diameter and ellipse dimensions follow the curve's centre, so a resize alone doesn't move the label;
  - a length dimension follows the line's midpoint;
  - a two-entity dimension follows the midpoint of its two anchors.
  
  The label change lands in the same undo step. The contract is unchanged: `label` stays absolute sketch mm.
- **Click selects, as in other CAD sketchers.**
  - A click on a label selects the dimension.
  - A click on the selected label, a double-click or Enter edits it.
  - Delete or Backspace (on the label or with it selected) removes it, and so does the Delete chip, shown with the radius/diameter and reference chips when the label is selected or being edited.
  - A label with no selection model (`onSelect` absent, e.g. the UI harness) still edits on a click.

## ADR-078 — Booleans merge the coplanar faces they create; absorbed names resolve as reported aliases (2026-11-10)

Owner: "Faces don't seem to merge properly. On the demo bracket the back face is split to two faces, and shelling even 2mm failed." (ADR-074 and ADR-075 were taken in parallel work; renumber on merge if needed.)

**Root causes.** (1) Only push/pull ran `ShapeUpgrade_UnifySameDomain` (ADR-013). Every other boolean (extrude/revolve/primitive/sweep/loft add, cut and intersect, the `boolean` feature, multi-region tools, pattern and mirror fuses, holes, imports with an op) left a tool face flush with a body face as two faces. The demo bracket had 19 faces: the back, left and right faces were each split at the plate's top (the M1 test bracket: 17 instead of 14). (2) `BRepOffsetAPI_MakeThickSolid`/`BRepOffset_MakeOffset` fails on those seams: before the merge, every bracket shell with an open face failed at 1, 2 and 5 mm, and the closed one at 2 and 5 mm (only closed 1 mm worked). The error was always "The shell is too thick for this body" (`OPERATION_FAILED`; OCCT `BRepOffset_Error 1`, a `Standard_NoSuchObject` "BRep_Tool:: no parameter on edge", or a result no smaller than the body). After the merge, 1 and 2 mm work closed and with the top, bottom or back open. (3) Separately, an open face that runs **tangentially** into a kept face (the plate front between the corner fillets, the sides, the plate top into the bend fillet, the upright front) fails in OCCT at any thickness ("result volume ≥ body"). (4) 5 mm inward cannot exist on the demo bracket: its plate and upright are 8 mm thick, and with the top open the 2 mm chamfer's inward offset meets the inner back wall below the top for t > (T − c)/(1 + √2) = 2.49 mm. 5 mm outward closes the Ø6 holes. These stay errors, now with the right message.

**Decision.**
1. **When unification runs.** After every boolean that goes through `booleanNamed` (packages/kernel `whittle_unify.cpp`), restricted to the seams that operation created: an edge between exactly two faces on the same surface that come from two different inputs (the target body and a tool, or two tools; every input is its own provenance group), or that are pieces of one input face the operation split. Two faces that were already on one input never merge, whether the input is the target or a tool body (an imported body with split faces used as a `boolean` tool or an import-with-op, body copies carrying earlier splits): earlier topology stays stable, and imported splits stay. A merge group never takes a second face of one input, nor faces of two target bodies, even through a face of another input (the seams to them stay). Faces of different result solids never merge (edges shared by two solids are kept, and cut/intersect still give one result per scope body). Vertices that touch no merging face are kept, so collinear edges elsewhere keep their split. `UnifyFaces` + `UnifyEdges`, `SetSafeInputMode(true)`, `KeepShapes` for everything else. A same-surface prefilter (same `Geom_Surface`, or equal plane / cylinder / cone / sphere within 1e-6 mm, 1e-9 rad) skips the call when nothing can merge, which is most booleans. A merge that changes the solid count or the volume (beyond 1e-9 relative), or turns a valid result invalid, is dropped and the seams stay. Push/pull keeps its ADR-013 rules.
2. **Naming rule for merged faces.** The merged face keeps the name of the earliest-created face: one that was on the body before the operation beats one the operation created; among equals, the smaller name in natural order (feature tags are ULIDs, so this is the earlier feature; digit runs compare as numbers, so `inst2(…)` beats `inst10(…)` and `#9` beats `#10`). On the bracket the back face is the plate's `F<plate>:side(…L3)`. Edges merge the same way: the merged edge's name is derived from the surviving face names, as for any edge. **Names never move.** Every sub-shape that survives keeps exactly the name it would have had without the merge: faces take their final pre-merge name (no `#k` renumbering of the pieces that did not merge), edges and vertices get their old name back where the derivation only moved an index, and a name that belonged to another sub-shape before is replaced by a fresh index of its family. So when piece `#0` of a split face merges away, `#1` and `#2` stay `#1` and `#2`. Before this rule they became `#0` and `#1`, and a ref to the old `#0` resolved by exact name to the wrong piece without any report.
3. **Absorbed names are aliases.** Every absorbed face name, and every edge and vertex name that changed because of the merge, stays in the feature's `NamingMap` as an extra entry with the same `kind` and `index` as the surviving sub-shape, after all primary entries. That includes pieces of one face merging back. A sub-shape that several old ones merged into, and that is now alone in its name family, takes the plain name `N`, and `N#0` and `N#1` are its aliases. Ties among pieces go to the smallest index. A face no merge touched keeps a lone `#k`. The first entry per index is the sub-shape's name, which is already how coincident sketch points work.
4. **How absorbed references resolve: a resolved alias with a recorded `via`, never silently.** The regen engine excludes alias entries from candidates. It collects them per walk (`ModelState.merged`, absorbed → survivor, including chains), because only the merging feature's result lists them. Resolution order is now: exact name, then merge alias, then name family, then fingerprint. The survivor is looked up only by its own name or its `#k` family, never by a fingerprint-only match. A current primary name always wins over an alias of the same name. **Conflicting aliases are unresolved.** Each operation derives its pre-merge names from its own inputs, so two features can list the same old name for different sub-shapes. For example, `vertex(P:xmax|P:ymin#0|P:ymin#1)` is the vertex at (10, 0, 2) for one add and the vertex at (10, 0, 5) for a later one. The walk's table keeps every survivor a name was given. A name with two survivors, itself or anywhere along its chain, is `ambiguous` (the survivors are the candidates, so the "Which one?" chooser offers them), the feature needs attention, and no fingerprint guess replaces it. (Before the second review the last writer won.) **Name families need containment.** Opening an old document goes through the name-family rule for every `#k` name the new topology no longer has. Its nearest-centroid pick can cross a notch. For example, a later cut splits the bottom front edge: the old piece `edge(P:ymin#3|P:zmin)` (x ∈ [6, 10]) is nearer `#0` (x ∈ [0, 4]) than `#1` (x ∈ [6, 40], which covers it). That rebound would then be healed into the document for good. So with a distance query (always in the regen engine) the pick must contain the ref's recorded location. A vertex must be at the same point. For an edge or face, the recorded centroid must lie on it, as close as the member's own centroid is, so curved edges and non-convex faces aren't misjudged; a face must also face the same way. So the nearest winner stands if it contains the location, else the one member that does is picked, else the ref is ambiguous. Weak (imported) names keep the fingerprint rule, because their geometry moves with the file. A rebound whose new name fails containment is not reported, so the app never heals onto it. No existing golden changed. A sweep golden (`kernel-client/test/regen/merge-sweep.test.ts`) resolves, after every step, every face, edge and vertex name the pre-ADR kernel gave nine flush-boolean scenarios (merge of `#0`, of `#1`, two merges in one op, a cut floor across two slots, a touching pattern, a merged mirror, and the first one followed by a notch, a slot or a boss): 5,454 names recorded in `fixtures/merge-sweep.pre-adr078.json`. Each must land on an entity that contains the old one, or stay unresolved. None lands elsewhere; without containment the notch case lands one name on the wrong edge. A ref resolved through an alias gets `via: 'merged'` and is reported in `FeatureStatus.merged: [{path, name, into}]`. It is not healed, so the stored name stays, and an edit that un-merges the faces (the upright moved off the back edge) brings the ref back to its own face by exact name. Shell open faces given as several now-merged faces map to the one merged face (one rim). A ref is never re-picked onto an unrelated face: no alias means the old order applies, and unresolved still means "needs attention". **Not reported: refs that resolve by exact name to a surviving face or edge that grew.** A downstream feature on the surviving name now acts on the merged geometry. For example, a fillet on `edge(plateBack|plateLeft)` used to round the 8 mm plate corner and now rounds the full 48 mm back corner. Faces that absorbed a sketch's plane or a shell's open face behave the same way. This is the intended merge, and the name and its history are the same, so it is not flagged; a feature whose result should stay local has to pick the geometry again after the merge.
5. **Shell.** When both joins fail and an inward shell's open face is G1 to a kept neighbour (`BRepLib::ContinuityOfFaces`), the shell is built by booleans: the void is the closed inward offset (which works there) plus, for each planar open face, a prism of its offset image back to the face's plane; the result is the body minus the void. Where the thick solid works this is the same solid. Where it doesn't, the walls along tangent faces end flush at the opening, and the open face's remains and the prism sides are `F…:rim(<open face>)`. Other failures stay errors. "The shell is too thick for this body" is reported only when a much thinner wall (min(t/4, 0.25 mm)) works; otherwise "The shell could not be built for this body", with OCCT's reasons in `detail`.

**Performance** (single-threaded kernel in Node, the same machine and load, old and new builds run back to back; the machine is shared, so ranges over three runs). The upright add that merges three face pairs on the bracket costs 10–12 ms per feature (median of 10 cold regens), against 8–10 ms before: about +2 ms for the seam scan, the unify, the validity and volume checks and the naming before and after. Booleans where nothing can merge pay only the edge scan with the same-surface prefilter. That is not measurable on the 50-feature part (24 hole cuts), where the one-dimension edit of the last feature has a median of 45–52 ms against 40–50 ms before (budget 300 ms, PLAN §10); its cold regen is 645–1005 ms against 748–822 ms. The bracket's full regen (9 features, fine) was 98–118 ms before and 122–170 ms after; the noise is larger than the difference. Kernel size: +9.3 KiB brotli single-threaded (4.54 MiB → 4.55 MiB), +7.2 KiB threaded.

**Changed expectations** (volumes and masses unchanged everywhere):
- kernel `pushpull.golden` "one of two coplanar adjacent top faces pulled": a two-box fuse is now 6 faces, not 10, so the split body comes from an imported IGES box with a split top (`igesBox(…, splitTopAt)`); after the pull it has 8 faces (was 11 from the 10-face body). The wall's name, centroid, normal and area, and the grown neighbours, are unchanged in meaning.
- kernel-client `fixtures/import-naming.golden.json`: re-recorded for the bracket-derived entries only (`bracket*`). The source STEP is the merged bracket: faces 17 → 14, edges 43 → 36, vertices 28 → 24 (bracket-add-moved 25/59/38 → 20/48/32; bracket-cut keeps 18/36/24 with renumbered `#k`). The box entries are byte-identical.
- Face counts that tests now assert: M1 bracket 17 → 14, demo bracket 19 → 16.

**Contract proposals** (lead-owned; not applied): (1) naming.ts: the merge rule and alias entries of items 1–3. (2) `FeatureStatus.merged?: { path: string; name: string; into: string }[]` (kernel-client `RegenFeatureStatus` carries it meanwhile). Wording in packages/kernel-client/README.md, "Kernel gaps and contract notes".

**Dependencies.** None new: `ShapeUpgrade_UnifySameDomain`, `BRepLib::ContinuityOfFaces` and the offset algorithms were already linked.

**Owner decision (2026-11-11): no backwards compatibility.** "We don't need backwards compatibility between old parts and the new kernel change — no one has used this app yet." Documents saved before ADR-078 are not supported and get no migration. Their stored names may resolve, need attention, or (in the cases the sweep doesn't cover) behave in other ways. The containment rule for name-family picks stays, because it is safer for any family pick, including within the new kernel. The pre-ADR sweep (`merge-sweep.test.ts`) stays as a naming regression test. No further work goes into upgrade-path cases.

## ADR-079 — M3.7 in the app: pill placement, background builds, export and ExpressionInput commits (2026-11-10)

- **Pill.** Desktop and tablet always show it (so a part with no configuration can make its first from the pill); the phone shows the chip only when the part has a configuration or the active id is missing, and only switches. The pill, the table panel and its table are separate lazy chunks.
- **Regen.** The workbench regenerates `wb.config.resolved().doc` (memoised per stored document, so its identity is stable for the regen loop). "Current" regen results, heals and the push/pull tool compare against that resolved document; the mesh cache is keyed by the stored document, which is what a reload reads.
- **Background builds.** After the active regen settles, the other configurations (Default included) regenerate one at a time on idle at coarse quality with `slot: config:<id>`. Only a summary (status, message, mass) is kept; the key is `valueKey` of the resolved document without configuration data, so unrelated configuration edits rebuild nothing. The current `kernel-client` accepts only `main` and `version:<id>` slots; until it accepts `config:`, the build falls back once per session to `version:config-<id>`. A missing active configuration is never built or exported.
- **Export of other configurations.** `exportPart` exports the latest `main` regen only, so "export all" runs inside `RegenLoop.exclusive`: regenerate each configuration in `main`, export, then regenerate the live model again (value-cached). Several files are plain downloads (a save dialog per file cannot hold a user gesture); the single-file export keeps the save dialog. A proposal for the kernel: an optional `slot` on `exportPart`.
- **ExpressionInput commits after previews.** It now calls `onCommit` when an edit that was previewed ends, even if the value equals the previewed one. Without it a preview-only edit never ended, so the undo group stayed open and the one-shot scope chip (trap T1) would have stayed on for the next edit.
- **Edit scope.** `planFeatureEdit` diffs the feature as the configuration shows it against the edited one: overridden pointers (or any configurable one with the chip) become overrides, everything else edits Default; Default never receives an override's value, and an override edited back to Default's value is cleared. "Suppress in all configurations" also clears the active configuration's own suppression override.

- **Gate-review amendments.**
  - `kernel-client` now accepts `config:<id>` regen slots with their own LRU budget (8 per part, separate from the 2 version slots of compare and merge preview); the `version:config-*` fallback is gone. A live `main` regen still waits behind a background build already running in the worker (the engine is serial and OCCT calls cannot be cancelled); builds run one at a time at coarse quality, so the wait is one build.
  - "Export all" holds the viewport while it uses `main` for other configurations: picks, `refFor` and measurements are refused with a visible "model is locked" state, because `EntityQuery` is an ordinal mesh index and would otherwise resolve against the wrong configuration. A configuration with resolved issues is skipped and named (the active one is refused on a single export too); a failed regen stops the export with a toast naming it and the files already saved.
  - Previews and sketch solves evaluate against the resolved active configuration. Sketch dimensions are not configurable (D2): editing one changes Default, and the sketch panel says so. A missing active configuration blocks edits (it would otherwise change Default silently); the Params tab clears an override typed back to Default's value.
  - **The golden configuration part is synthetic.** It is a plate, boss and hole built from primitives (`apps/web/e2e/support/config-part.ts`) with closed-form masses, not a §12A reference part checked in FreeCAD. It tests the configuration machinery (resolution, slots, masses per configuration), not modelling capability, and its volumes are exact sums and differences of boxes and a cylinder, so an independent solver would only repeat the formula. Configuring the real reference parts, FreeCAD-checked, is left to the certification-style suite.

## ADR-080 — Parameters you can find and apply: autocomplete, Make parameter, link display, Used by, drag (2026-11-10)

Owner feedback: "how do we apply parameters to actual dimensions? I couldn't find a way to utilize them." Typing a name into a value field worked, but nothing on a desktop said so. Other CAD tools solve it with autocomplete in the dimension box (Fusion), named variables you pick (Onshape) and linked values (SolidWorks).

**Decision.** Four additions to every value field, none of them a dialog (PLAN §9.2):
- **Autocomplete.** `ExpressionInput` offers matching parameters with their evaluated values in an inline listbox. The input is a plain textbox until the list opens, then it is an ARIA combobox (`role=combobox`, `aria-expanded`, `aria-controls`, `aria-activedescendant`). ↑/↓ move and wrap; Enter and Tab accept; Esc closes the list and keeps the edit. The identifier under the caret is replaced, so it works mid-formula. An identifier after a number is a unit (`25mm`, `2 mm`) and is never completed. `fx`, a leading `=` (dropped) and Alt+↓ open the full list. Enter on a name that is already complete commits as before. The role is not permanent because 100+ tests and E2E steps select fields as `textbox`.
- **Make parameter.** The last row of the full list. It opens an inline form (name, the expression it will get, live validation). A bare number takes the field's unit (`12` becomes `12 mm`). Names are checked against existing parameters, units and built-ins (`logic/paramName.ts`; `apps/web` has a test that the lists match the document's `UNITS`, `FUNCTIONS` and `CONSTANTS`). The host does it as one undo step: `Workbench.makeParameter` adds the parameter and sets `joinKey`, so every `apply` until `endMakeParameter` merges into the same history entry and `commit()` is a no-op. A sketch dimension commits through the sketch queue, so `endMakeParameter` waits for it to land.
- **Link display.** A field whose text refers to a parameter gets an `fx` badge, an accent colour and a screen-reader description. A dimension label shows `width = Ø80` (exact name) or an `fx` badge (formula). The accessible name starts with the visible text (WCAG 2.5.3, axe `label-content-name-mismatch`), and the badge is CSS, not text. "Used by N" in the Params tab, from `paramUsage(doc)` (`apps/web/src/app/param-usage.ts`): direct references through `exprFields`, one entry per field, reference dimensions skipped. It is computed in a lazy chunk. An entry selects the feature; a sketch dimension opens the sketch and selects the dimension (`selectParamUse`).
- **Drag.** The Params tab has a link button per parameter. Drag uses pointer events, because HTML5 drag and drop does not fire for touch. `logic/paramDrag.ts` keeps a registry of drop targets (`data-param-drop`), finds the one under the pointer with `elementsFromPoint` (so it works over the HTML overlays on the viewport), and shows a ghost chip. Fields and dimension labels register themselves. A drop commits the name in one undo step. Esc cancels a drag.

**Values come from the host.** The shell builds `ParamLinksContext` from `paramsTable.params` and the app's own `evaluate`, so the list shows exactly what the document evaluates to (including the resolved configuration once `evaluate` takes it). The UI never evaluates parameters itself.

**Bundle.** Measured on the dev branch at the gate-fix merge: 246.79 kB gzip of 250 kB (the feature itself added about 1.1 kB to the initial route; the list, form, fx button, badge and drop registration are one lazy chunk, `ParamAssist`, and `paramUsage` / `selectParamUse` are lazy too).

**Parameter edits redraw an open sketch.** The document stores the last solved geometry, so a parameter change used to leave an open sketch stale until its next solve. `Workbench.applyRefit` (used by `ConfigController.updateParam`, both Default and override edits) applies the parameter edit under a join key, then `SketchSession.refit()` re-solves with the new values (the resolved configuration) and writes the moved geometry and carried labels. The refit joins the parameter edit's undo step, so there is no step of its own and undo restores both. A drag in flight is left alone (its next step solves with the new values anyway), and an unchanged solve writes nothing.

**Contracts.** No change. Proposal for the lead, optional: a `ParamUse` shape in `contracts` if the sync/compare features want to show where a parameter is used.

## ADR-081 — Drawings before MBD, on one shared 3D annotation core (owner, 2026-11-10)

**Context.** The owner asked whether M5 (STEP AP242 MBD/PMI) should come before M4 (drawings). Modern CAD defines annotations once on the 3D model and lets drawings reuse them. Building drawings first risks a drawing-only dimension model that has to be rebuilt for MBD. On the other side:
- Wren's users (makers, small shops, engineers working alone) get parts made from PDF and DXF drawings. Few of the tools those shops use consume semantic PMI.
- M5 is harder to verify: OCCT has gaps with third-party PMI, and acceptance needs the NIST analyzer and third-party CAD.
- M4's acceptance is concrete: 1:1 PDF prints, and DXF opened in LibreCAD in CI.
- Most of what M5 needs is drawing work anyway: tolerance and fit formatting, GD&T frames, text and leader layout, attachment and dangling detection.

**Decision.** Keep M4 before M5, but M4 builds the **shared annotation core** first:
- **Storage.** A part-level, id-keyed `Part.annotations` set replaces `FeatureBase.annotations` (with a migration).
- **Semantics.** Annotations reference model geometry by `EntityRef`. They are optionally bound to a driving dimension (`source`). Drawing views store only per-view placements.
- **Shared code.** Formatting and layout are written once.
- **References.** Unresolved references are "needs attention".
- **Configuration overrides.** Overrides on annotations are id-keyed, which closes the M3.7 gate finding.

M5 then becomes:
- 3D display and editing on annotation planes, with saved views;
- the XCAF semantic plus presentation export, reusing M4's layout code;
- PMI import;
- validation.

**Consequences.**
- The M4 contracts step changes `document.ts` (`Part.annotations`, an annotation `source`, drawing view placements) and needs a schema bump with a migration. The lead owns this.
- M4 is slightly larger. M5 is smaller and less risky.
- Drawings and the STEP export can never disagree about a dimension, because they show the same object.

**Gate fixes (ADR-080 amendment).**
- **Enter never rewrites typed text.** Nothing in the list is highlighted until the user presses an arrow key; Enter and Tab accept only a highlighted entry, and otherwise Enter commits the field as typed (so `2*pi` stays `2*pi` with a parameter `pitch`). Only prefix matches open the list; substring matches may follow but never open it alone.
- **One rule for names after numbers: the engine's.** A name after a number is a unit only if it is a unit (`5 mm`); `2 width` is 2 * width. `paramRefs` (badge, "Used by") follows that, and the test evaluator in the UI harness does too.
- **Used by covers configurations.** Parameter overrides and feature field overrides in `part.configurations` are listed with the configuration's name; choosing one switches to that configuration, then selects the feature.
- A wrong-kind drop on a dimension label opens its editor with the name and the error (`seedDraft`), and the drag reports it as not dropped. The popup measures on open, resize and scroll, not every frame. Tab in the Make parameter form cancels it. IME composition is not treated as Enter or an arrow. `Workbench.makeParameter` refuses unit names. The shell re-evaluates parameter values only when `params` or the host's `version` token changes.

**Refit is Default-only; configurations redraw as display state (ADR-080 amendment 2).** The first refit solved with the resolved configuration and wrote into the stored sketch, so a "This configuration only" edit (or a configuration switch) could leave Default's geometry moved under Default's own dimensions. Now:
- `SketchSession.refit()` runs only for Default-scoped parameter edits (`Workbench.applyRefit`), solves with **Default's** values (`this.wb.doc`), and joins the edit's undo step as before. Configuration-scoped edits (`ConfigController.updateParam` with `scope: 'configuration'`) are a plain apply and never refit.
- An open sketch is drawn from `SketchUi.shown`: the solve for the values in force (the active configuration's), valid only for the exact stored `entities` array it was solved from (`displayFeature`). It is display state: no document write, no undo entry. `onDocChange` compares a key of the resolved dimension values and redraws when it changes (parameter or override edits, configuration switches, undo/redo of them); entering a sketch redraws too. After a Default refit the same redraw shows the active configuration's geometry on top.
- `applyRefit` is serialised: a second parameter commit waits for the first refit, so each edit keeps its own undo step and geometry.
- Also: popups re-place on the host's `wren:reposition` event (sent on camera changes) as well as resize and scroll; Shift+Tab leaves the Make parameter form like Tab; `paramRefs` follows number lexing (`1e3` is not a use of a parameter `e3`).

**Display state stays in step with the stored sketch (ADR-080 amendment 3).** `onDocChange` recomputes `shown` (`redraw()`) whenever the stored entities or constraints changed and no drag is in flight, not only when the dimension values changed, so undo/redo of a move, add or delete in a configuration draws the Big solve instead of stale stored geometry. Drawing inference and snapping read the displayed geometry (`data()` goes through `displayFeature`); picks already use the drawn curves. Known and unchanged: a geometry edit made inside a configuration is solved with that configuration's values and stored in the shared sketch.

## ADR-082 — Cloudflare Pages serves a CI-built `cloudflare-pages` branch, with no build step (2026-11-11)
Hosting roadmap step 3 (PLAN §13), on the owner's domain wren-cad.app. The owner connects Cloudflare Pages through Cloudflare's own Git integration, so GitHub holds no Cloudflare token.

- **Why a deploy branch.** Cloudflare's build servers cannot build the OCCT kernel (Docker/Emscripten, cached as an artefact by `kernel.yml`). The `cloudflare` job in `ci.yml` rebuilds only the web app (`WREN_BASE=/`, reusing the `kernel-dist` artefact) and force-pushes `dist` as one orphan commit to `cloudflare-pages`; Cloudflare serves it with an empty build command. It runs after the same gates as `pages`, on pushes to `main` only, and is the only job with `contents: write`. The GitHub Pages build (`/wren-cad/`) is unchanged.
- **Headers.** `public/_headers` sends the same COOP/COEP/CORP as the service worker: `require-corp`, because Safari has no `credentialless` (ADR-005, sw.ts). Hashed `/assets/*` (kernel included) are immutable; the shell, `sw.js` and the manifest are `no-cache`. Cloudflare joins a header set by several matching rules, so the Cache-Control rules are on disjoint paths. A unit test compares `_headers` to the service worker's values.
- **Routing.** There is no path router. Cloudflare's SPA mode (unknown path gives `index.html`, 200) applies only when `404.html` is absent, so `scripts/cloudflare-dist.mjs` removes it from this build; no `_redirects`.
- **No-op shim.** On an isolated first load the page does not reload (`shouldReloadForIsolation`), and `withIsolationHeaders` returns a response that already has the three policies unchanged (redirected responses are still rebuilt). The service worker stays: offline, precache and the kernel cache are still wanted.
- **Size guard.** The same script fails the job if any file is over 25 MiB, Cloudflare Pages' per-file limit. The threaded kernel is 20.8 MiB today, so there is about 4 MiB of headroom; a kernel that grows past it needs the Wasm split or served from R2.
- **Worker.** `ALLOWED_ORIGINS` gains `https://wren-cad.app` (exact; `www` redirects to the apex and is not an origin). Not deployed by this change.
- **Preview deploys.** Not set up; see docs/DEPLOY.md.
- **Schema ids** keep `jackhale98.github.io/wren-cad/schema/...`: they identify the format, and changing them would be a format change.

- **Amendment (2026-11-11): Workers with static assets, not Pages.** The owner's dashboard labels the Pages Git flow legacy and created a Worker connected with Workers Builds. That Worker served the "Hello world" template, because the branch had no build input and no Wrangler config.
  - The branch layout is now `public/` plus a generated, assets-only `wrangler.jsonc`: no `main`, `assets.directory ./public`, `not_found_handling: single-page-application`, and a pinned past `compatibility_date`.
  - The Worker deploys it with `npx wrangler deploy` and no build command, because CI already built the site with the cached kernel.
  - The Worker name comes from the repository variable `CLOUDFLARE_WORKER_NAME` (default `wren-cad`). It is validated against Cloudflare's name rule, because Workers Builds rejects a config whose name differs from the Worker's.
  - Verified locally with `wrangler deploy --dry-run` (wrangler 4.160): it read 120 asset files.
  - `_headers`, the 25 MiB per-file limit and the SPA fallback carry over unchanged.

## ADR-083 — CI for fast feedback: dev-branch runs, a smoke tier first, eight shards, Firefox and WebKit nightly (owner, 2026-11-11)
The owner's complaint: a 30-minute wait to fail, then another 30 after the fix. The repository is public, so runner minutes are free; the cost to optimise is wall time.

- **Triggers.** `ci.yml` runs on pushes to `main` and `claude/**`, on pull requests and on demand. `pages` and `cloudflare` keep their `main`-only `if:` guards, so dev-branch runs never deploy. `paths-ignore` (`docs/**`, `**/*.md`, `brand/**`) skips docs-only pushes; none is a build input (the app's brand assets are `apps/web/public/brand`, and tests that mention `.md` write their own fixtures). Pull requests are not path-filtered, so a required check cannot hang pending.
- **Concurrency.** A newer push to the same non-main ref cancels the in-progress run; `main` is never cancelled. Known cost: cancelling during a kernel cache miss throws away that build (the cache is saved only on success), so the next push pays the ~20 minutes again.
- **Smoke tier.** Tests tagged `@smoke` in their titles (`--grep @smoke`, chromium and chromium-touch): boot and box, sketch to extrude to reload to export, dimension edit, fillet and needs-attention, push/pull (mouse and touch), undo/redo, configurations switch/save/reload/STEP export, parameter autocomplete, radial menu, touch bubble, SW isolation, installed-PWA chrome. About 3 minutes of tests. `e2e`, `e2e-reference`, `package-e2e` and `perf` need `smoke`, so a broken build fails in minutes and the expensive jobs never start. The deploy jobs list `smoke` too. Tag, do not list: a new smoke test is one word in its title. Keep the tier under 5 minutes; the 80 s STEP bracket acceptance test stays in the shards.
- **Shards.** Chromium goes from 4 to 8 shards (155 tests, 19-20 each, ~10 min plus setup, 25 min limit) with `fail-fast: true`: one red shard cancels the others. Playwright's one CI retry absorbs single flakes. Reference parts stay at 3 shards (10 tests, ~7 min each): not the long pole. The long poles are now the viewport/UI package suites, perf (serial by design) and a kernel cache miss.
- **Firefox and WebKit** move to `soak.yml` (nightly, on demand): same projects, same 3-way sharding, never gating, a per-shard summary and report artefacts. They stay out of the gating runner pool. ADR-005 section 7 still describes why they do not gate.
- **Unchanged.** Kernel cache, size budget, non-gating Lighthouse, perf gate.


### ADR-083 amendment — main only fast-forwards to commits that passed on the dev branch (owner, 2026-11-11)
- **Rule.** A `verified` job in `ci.yml` asks the Actions API, on pushes to `main`, for a completed run of this same workflow with `head_sha == github.sha`, `event == push`, `conclusion == success`, a `claude/**` branch and `head_repository == this repository`, other than the current run. If one exists, `main` skips lint, test, smoke, both e2e jobs, package-e2e, perf and Lighthouse, and runs only kernel (cache hit), build and the two deploys. The run URL goes to the job summary. Fork and pull request runs never count.
- **Fallback.** A direct push to `main`, a failed or cancelled dev run, or any API error gives `verified=false` and the full pipeline runs as before. The deploy `if:` is `!cancelled()` and build succeeded and (verified or all seven gating jobs succeeded), so a failed gating job never deploys.
- **Trade-off.** The dev run tested the commit, but on the dev branch's runners at that time: a merge commit that differs from every tested commit is unverified and runs in full, and a flake-free dev run is trusted even if the base image moved since. The build for deploy is still redone on main with the main-only base path settings. Perf now needs only `build` and package-e2e only `lint`, so both run beside smoke; smoke still gates the chromium and reference shards.

## ADR-084 — Large-part regen: cheap bounds, memoised sub-shape queries, mass properties off the critical path (2026-11-11)

The stress part (packages/test-fixtures/stress-part: 100 features, 409 faces, ABS) took about 175 s CPU for a cold regen and 7 s to edit its last feature (PLAN §10: 300 ms). A V8 profile put ~88 % of it in mass-property integration (`massProperties`: adaptive volume and area integration of a NURBS-converted copy of the body) called where nothing needed a volume. Geometry, naming and every golden stay identical; this changes when and how often things are computed. Checked by a state-by-state A/B of the stress part against the previous engine and kernel (fingerprints, bboxes, mesh positions, face and edge names, statuses, warnings, rebound and merged refs, final mass properties): byte-identical.

- **`bounds(shape)` (façade, new).** `massProperties`' bounding box (`exactBounds`: `BRepBndLib::AddOptimal` without the tolerance gap) and topology counts, with nothing integrated. The bounding-box prefilters of solid features and imports, the through-all depth of copied cuts and `sameSolid` read it (`EngineCore.boundsOf`, cached per handle). Same box, so the prefilters decide exactly as before. Against a kernel build without the entry point the worker falls back to `massProperties` (the entry is optional in `facade.ts`, so an older `dist` still loads).
- **`sameSolid` checks cheap invariants first.** Different face or edge counts (always "changed" before) or a box that moved by more than 1e-6 of its diagonal mean changed; only bodies that agree on all of them are integrated and their volumes compared, as before. The box test is loose on purpose: anything closer falls through to the old volume rule. One edge case does change: a cut with the same counts that shaves less than 1e-9·V off a body but moves its box by more than 1e-6 of the diagonal (a sliver at the box's extreme) used to count as "unchanged" and now counts as changed (the body takes the cut's result and the "does not touch" warning goes). That is the more correct answer; no golden has such a cut.
- **Per-sub-shape memo in the façade.** With the integrations gone, `exactBounds` and `fingerprints` of the growing body were the next cost (440 ms and 250 ms on the final body, every feature). A boolean's result shares most faces and edges (TShapes) with its input, so each face's `AddOptimal` contribution and each face's and edge's fingerprint JSON are memoised per oriented sub-shape (`std::hash<TopoDS_Shape>`, `IsEqual`), computed by the same code from the same sub-shape: byte-identical results (`packages/kernel/test/memo.golden.test.ts` builds a feature chain in a warm and a fresh instance and compares every answer as raw JSON). A face's contribution is `AddOptimal` on a compound holding only that face, which runs exactly that face's loop iteration; `Bnd_Box::Update` is min/max, so the union does not depend on order. Entries hold their TShape; the ones nothing else references are swept after releases and when the memo doubles. Caveat: a face or edge whose area / length is zero falls back to `boxCenter` for its centroid, and `BRepBndLib::Add` uses the triangulation when there is one, so that centroid depends on whether the sub-shape was meshed. The memo keeps the first value computed (before, each new handle recomputed it, so the value could differ by handle with meshing). Only degenerate zero-measure entities are affected; their centroids carry no area or length evidence for resolution anyway. Now 1 ms and 6 ms. Mass properties cannot be memoised this way: OCCT integrates each face about the whole shape's rough barycentre.
- **Fingerprints stay complete.** Fingerprinting only the referenced entities (or lazily) would also have changed `partDiag`'s box, and with it the resolution tolerances. The memo removes the cost and leaves resolution as it was.
- **Mass properties only where asked.** A regen integrates only its final bodies, and only as `RegenRequest.massProperties` says (contract, accepted with this ADR, commit 7f3aebf): omitted = when the part has a material, `true` = always, `false` = never, even with a material. The engine uses `request.massProperties ?? part.material !== undefined`. `ModelingApi.massProperties` goes through the engine: serialised with regens and, for regen-owned handles, served from the same per-handle cache. The app's live regen loop sends `true` only while mass properties are known to be cheap for the part (the last separate fetch took at most 40 ms and the last inline regen stayed within 300 ms; and always with a material when no density resolver is given). Otherwise it sends `false` and fetches them with `massProperties(shape, density)` at the material's density (resolved as the engine does) once nothing else is queued, after the fine pass (`RegenLoopOptions.onMass`, `density`; `whenIdle` waits, so test hooks and E2E still read volumes). The memo is keyed by shape and density, so a density edit (same shapes) never serves the old mass. Configuration builds and compare keep `true`.
- **Pending, never stale.** While the live result has a body without mass properties, `massSummary()` is undefined and `massPending()` true: the part inspector shows "Calculating mass properties…" (`aria-busy`, `MassReadout pending`) and the configurations' mass column "Calculating…", never a partial sum, a zero or the previous geometry's value. A finished fetch settles the revision even if it failed (no mass shown rather than an endless pending state). Compare and measure compute their own values and are unaffected; exports carry no mass. This costs 0.8 kB gzip on the initial route (247.8 of 250 kB).
- **Blocked features.** The 6-17 s each that features after a failure spent were these integrations. Now the 76 features blocked by an early shell failure take about 1 s together, so the walk is unchanged: skipping their planning would drop their `rebound` and `merged` reports and change cause attribution, for little gain.
- **Spare cache sized by the part.** The default `maxSpareResults` is now automatic: at least 128, or three earlier full states of the part (three times the latest regen's entries) when that is more, while the Wasm heap is under 1.5 GiB. With 128, a 100-feature part kept one earlier state, so the second undo of an early edit regenerated 32 features (51 s); now it is a cache hit. A configured value (tablet 4, phone 2) stays a hard bound. `memoryStats().regen.limits.maxSpareResults` reports the effective bound (with the automatic budget, the largest slot's; 128 with no part open).
- **Add-on: `FeatureStatus.grown` (M3.8, contract 2919e00).** Reported only when the resolved body face or edge is a merge survivor in this walk (it absorbed other names per the merge table, ADR-078) and its area / length is more than 1.5× the stored fingerprint's and more than 1 mm² / 1 mm larger; only for refs resolved by exact name or merge alias, never vertices, sketch regions or planes. Growth alone was not enough evidence: widening the demo bracket 80 → 130 mm grew sketch-plane faces 4000 → 6500 mm² and was reported (review N1); a parameter edit is meant to resize faces. Measured from the per-handle fingerprints, which the memo above makes cheap, so referenced sub-shapes only cost a lookup.
  - **Amendment (M3.8 follow-up, gate review N1): only names absorbed after the ref was made count.** "Survivor in this walk" was still too weak: a shell whose open face is the bracket's merged back face, picked after the merge (3840 mm²), reported 3840 → 6240 mm² on an ordinary width edit, and Accept (bound to the rounded size) never stuck. Now a ref is reported only when its survivor absorbed a name it had **not** absorbed when the ref was made, and it grew past the threshold. The baseline is session-local, with no document or contract change: `PartCache.absorbed` maps a ref's identity (kind, name, exact fingerprint) to the set of names its entity had absorbed. `refFor` records it from the latest walk's merge table (now kept in `pc.latest.merged`). Each regen in which the ref resolves without being reported adds to it (union, never removed, so a merge that an edit undoes and redoes is still the one picked). A reported ref keeps its baseline, so the note stays until it is re-picked (the app hides accepted notes). Bounded at 4096 refs, least recently used out.
  - Considered: comparing with the entity's measure in the last regen (a session `lastKnown` size). Rejected, because a parameter edit grows a merged face past 1.5× just as a merge does (3840 → 6240 is 1.63×). The absorbed-name set tells the two apart. A `Fingerprint.absorbed` count stored in the document would also cover reopened documents, but it is a schema change. It is not needed for the reported case, so it is not proposed now.
  - **Limit.** A ref first seen in a session (a reopened document, a version slot) has no baseline. Then any survivor grown past the threshold is reported, as before this amendment. So a document saved after a large parameter edit can show the note once more on reopening. Accept clears it for that size. The ADR-078 fillet case (picked at 8 mm before the upright existed, 48 mm after) is reported both in-session and on reopening. Goldens: `unify.golden.test.ts` (both cases, plus `closePart` for a fresh session), `apps/web/src/samples/bracket.test.ts` (the reviewer's repro on the demo), E2E `m38-ref-notes.spec.ts` (real, unstubbed).
- **Numbers** (Node, single-threaded kernel, CPU ms; before at load ~1 on 4 cores; inline = `massProperties: true`; deferred = `false` with the ABS material, the live loop's path, measured at load ~9.5): cold regen 177 123 → 17 577 inline / 10 415 deferred; edit the last feature 7 186 → 6 485 / **181** (+ 6 451 for the deferred fetch, off the critical path); a mid feature 121 486 → 9 949 / 3 981; the shell wall 173 798 → 13 131 / 7 196; cache hits unchanged (20-60 ms); the second undo of an early edit 51 404 (32 misses) → 21 (all hits).

## ADR-085 — Radial menu customisation: per-context rings, saved beside the keymap (owner, 2026-11-11)

Owner: "it would be good to allow users to customize" the quick access wheel (PLAN M3.8).

**Decision.**
- **Eight contexts**: empty space, face, edge, vertex, body or mixed, feature in the tree, sketch idle, sketch with a selection. Each ring has seven positions plus the fixed Repeat slot. A sketch-region selection keeps its built-in ring (not in the owner's list; cheap to add later).
- **No behaviour change by default.** A context with no stored ring runs today's `modelRadialIds` / `sketchRadialIds`, including the variants (curved face, several faces). The editor shows one representative default per context (for Face: one flat face). A stored ring is one fixed ring for the whole context. Its positions are the existing fill order (NE, E, SE, S, SW, W, NW), so slot N of a stored ring is where today's N-th item sits.
- **Stable positions.** Inapplicable items are disabled (`applies()` in `radial-config.ts`), never removed, and empty slots stay empty. The feature context falls back to a customised Empty space ring.
- **Registry only.** Ids are the tool ids, the bubble actions (`cut`, view and history) and `sketch:*` in sketch contexts. Anything else is dropped.
- **Persistence.** `wren.radial` in localStorage, per device, written only when something differs from the defaults. `version: 1`; version 0 (plain id lists with no gaps) migrates; newer versions are ignored and reported. Unknown ids, duplicates and surplus entries are dropped, and the unknown ids are listed in the editor. It is a separate key from `wren.keymap`, because the keymap's shape is command id to bindings, but it is read, reset, exported and imported with the same pattern. There is no app-wide settings export yet; the editor has its own Export and Import (JSON).
- **Flicks.** `flickWindow` 0 to 400 ms (default 250; 0 = off) and "Draw after a delay" (default off) map to `RadialMenu`'s `flickWindow` and `drawDelay` (= the window).
- **Editor.** A settings section (lazy chunk, no dialog): HTML drag and drop for pointers, "choose a slot, then a command" for keyboard and touch, a live region for the status. The ring is drawn as an ellipse so seven 44 px pills fit a 390 px panel.
- **Cost.** Everything new lives in lazy chunks (the layer, the settings panel); the initial route gains only a palette entry and a type widening.

## ADR-086 — Phone overlays get one home and a framed view; references that changed meaning get a quiet note (2026-11-11)

Owner screenshot: after "section by face" on a phone, the selection bubble, a floating section chip and the sheet's Section tab all stayed up, the view cube sat on the kernel pill and the model was mostly hidden. PLAN M3.8 items "Phone overlays stay out of the way" and "Show references that changed meaning".

**Overlays**
- **Bubble.** `ui.bubbleDismissed` holds the selection key whose bubble an action closed. The bubble shows again only for a different selection (the key is released when the selection changes, so reselecting the same face works). Its obstacle list now includes the view cube, the Library button and the bottom stack; it re-measures after commit, and a squeezed placement that still overlaps something hides it (it is the lowest priority).
- **One bottom stack.** Sketch toolbar or prompt, section chip and toast share one `overlay-stack` column above the sheet (`flex-col-reverse`), replacing three hand-tuned bottom offsets. They cannot intersect by construction.
- **One home.** Phone, sheet open on Section: the section chip hides; on Measure: the prompt chip hides. The tab already has the switch, Flip, the offset and the instruction. Collapsed, the chip shows.
- **Framing.** `ViewportEngine.setFrameInsets({top,right,bottom,left})` (packages/viewport) sizes and centres fits in the free canvas area (`fitInsetFrame`: the sphere fits the free width and height, the target shifts along the camera's right/up axes) and moves the view cube below the top inset. It does not move the camera. `apps/web/src/app/framing.ts` measures the insets from the top bar, the sheet height (`ShellProps.onSheetHeight`) and the bottom stack, then re-fits when a section or measure starts and when the sheet height changes. Phone only; tablet and desktop keep their fits. Because the contract `Viewport` does not declare it yet, the app reaches it through a local type; **proposed contract change:** add `setFrameInsets(insets: {top:number;right:number;bottom:number;left:number}): void` to `TouchViewport`.
- **Unit never truncated.** The section offset field is 12 rem wide (`w-48`); the slider gives way.
- Cost: collapsing or opening the sheet now re-fits the camera on a phone (keeps the view direction, resets zoom and pan).

**Reference notes**
- The UI reads `FeatureStatus.merged` and `.grown` (contract 2919e00). Tree row: a muted line "Uses a merged face or edge" / "Check this reference" (state `ok` only; an attention state wins). Inspector: a `RefNotes` list with the old and new size for grown refs, **Accept** and **Re-pick**.
- **Where Accept lives.** `localStorage` on this device, per document id, keyed by feature, kind, path and name, bound to the value it acknowledged (the surviving name, or the size rounded to 0.1). It clears again when that value changes. It is not in the document, so it does not sync and is not undoable. **Proposed contract change** for a synced version: `Feature.acknowledged?: { path: string; name: string; value: string }[]`, written by an undoable command; the app's `refAcks.apply` would read it instead of storage. Not done here because contracts are lead-owned.
- Re-pick reuses `wb.repick(featureId, path)`; nothing is re-picked silently and the regen is never blocked.
- kernel-client produces `grown` (ADR-084 add-on and amendment). The E2E covers it twice. The real kernel runs on the demo bracket: a fillet edge picked before the upright existed is flagged, Accept clears it, and a width edit flags nothing. The `stubRefNotes` test hook, an overlay applied wherever statuses are read, still drives the UI states the demo can't reach (a note that grows again, a merged edge).

- **Lead decisions (2026-11-11).**
  - **Accepted:** `TouchViewport.setFrameInsets?(insets: Partial<FrameInsets>)` and `FrameInsets` are in the contracts. The app no longer uses a local widening type.
  - **Declined for now:** a synced `Feature.acknowledged` field. Accepting a reference note stays per device (`localStorage`, per document and reference). A note that comes back on another device is harmless, and it is not worth a schema bump yet. Revisit if notes become common, for example once imported parts merge faces.

- **Amendment (owner, 2026-11-11): the sheet moves the view, it does not re-frame it.** The cost noted above (collapsing or opening the sheet reset zoom and pan) is gone. `setFrameInsets` now trucks the camera when the insets change after bodies exist: the camera and target move along the camera's right/up axes (`insetPan`, packages/viewport `views.ts`) by the shift of the free area's centre, so what the user was looking at stays at the centre of the uncovered area. Distance (zoom) and orientation are untouched; it is idempotent for equal insets and snaps (no tween, because the sheet is animating itself and repeated height reports must not lose partial moves; this also makes it reduced-motion safe). `framing.ts` `onSheetHeight` only calls `setFrameInsets`; no `fitAll`. A full re-frame happens only when a mode (section, measure) starts (`reframeSoon`). Contract unchanged (`setFrameInsets` keeps its signature; the behaviour is internal to the viewport). The phone visual-baseline E2E now waits for the sheet to settle itself, since the camera re-fit no longer gives it time.

## ADR-087 — Sketch input: implied constraints by click role, a right click finishes, two-point splines (M3.8, 2026-11-11)

Owner feedback: "putting a point over an existing visible point [should add] the coincident constraint", "no way to finish … one spline line with two points", "maybe a right click should finish the current tool".

**Decision.**
- **What is shown is what is committed.** `move()` (apps/web `sketch/draw.ts`) gives each click a role from the tool and how many clicks are placed (`nextRole`):
  - `point`: a corner, centre, end or pole. Every point snap is kept.
  - `curve`: the new curve passes through it without a point of its own (a circle's rim, the three points of a 3-point circle, a 3-point arc's middle, an ellipse's axis end). Only a snap onto an existing point is kept, as `pointOn(existing, curve)`.
  - `free`: a size or direction (a slot's width, a 3-point rectangle's depth, an ellipse's second radius, an elliptic arc's axis and ends). No snap at all.
  - A centre arc's end is projected onto its circle. It takes only a snap onto an existing point, or the origin, that lies on that circle within the snap tolerance. That point is reused (the match tolerance is `Anchor.near`). Reference parts rp03 and rp06 draw their arcs this way and need the binding to be fully defined (dev CI run 42976110170).
  
  `glyphs` lists exactly what the click commits. `bindAnchors` applies it to any tool fragment, and a per-tool test checks shown == committed (`sketch/implied.test.ts`).
- **Reuse, not coincident.** A `point` click on an existing point makes the fragment use that point (`reusePoints` in packages/sketch): no duplicate point, no `coincident`. Fragment points are matched by position, visible ones first, so construction points (a polygon's or centre rectangle's centre, a control spline's inner poles) bind too. They did not before. Pencil open ends reuse the same way. The Point tool on an existing point adds nothing and selects it.
- **Alignment guides commit unless redundant** (lead review). A guide level with another point, or the origin, snaps the cursor. It is committed as `horizontalPoints` / `verticalPoints`, with a solid glyph, unless `AlignmentClasses` says it is already implied. Only then is it drawn as a dashed preview line with no glyph. The same check drops a line's redundant H/V: a line rectangle whose fourth corner snapped level with the start closes with no extra `vertical` (H, V, H, `verticalPoints`).
- **No redundant H/V.** `AlignmentClasses` (packages/sketch `implied.ts`) is a union-find of points that share an x or a y through coincident, horizontal/vertical lines and pairs, axis `pointOn` and `fix`. A line's H/V snap whose two ends are already aligned shows no glyph and is not committed. This replaces the narrower "both ends on one axis" rule.
- **Finish without Esc.** `finishTool`: a spline is committed open with the points so far, a line chain ends where it is, and any other partly placed shape is dropped (it cannot be finished early). `gestureAction` maps a mouse `contextMenu` click to `finish` in sketch mode while a shape is in progress, under every preset and for a quick `rightOrbitRepeat` click too. Otherwise the radial menu opens as before. Right-drag is untouched, because the viewport only reports a click inside its drag threshold.
  - The toggle "Right click finishes the current sketch tool" (Settings → Navigation → Sketching, default on) is stored per device under `wren.sketchInput`. It is not in `NavigationOptions`, which is a contract. The shortcut overlay lists it as a fixed row (`ShortcutOverlay.extras`).
  - Touch shows **Finish** beside Done while a chain or spline is in progress.
  - Enter now also ends a line chain.
- **Two-point splines** were already valid in the tools and the solver (through: a clamped Bézier cubic with chord-direction end tangents and two free handles, 8 DOF; control: degree 1). Both now finish by Enter, a right click and Finish, and they regenerate (E2E).

**Not done.** An elliptic arc's start and end are projected onto the ellipse, so they never bind to a point.

**Contracts.** No change.

## ADR-088 — Sketch solver calls have a deadline; the edit queue always moves on (2026-11-11)

CI run 42966684008, shard 7: `sketch-touch.spec.ts` "a one-finger drag on empty space orbits…" hung twice in `sketchSettled()` after a Pencil line, Esc and deselecting the tool. Every await in the sketch session's edit queue (`serial`) is a solver call, and that sequence has no drag. So a settle can only hang there if a call to the sketch worker is never answered. Comlink never rejects a call to a worker that died or stopped responding, so the queue, `whenSettled` and the app's `idle()` waited forever. It did not reproduce locally: 22 repeats under load, 10 of them with 4× CPU throttling.

**Decision.**
- **A deadline on every call.** `createSketchSolverClient` gives each call a deadline (`timeoutMs`, default 20 s; a 200-entity solve measured 22–83 ms in Node). Past the deadline, or on the worker's `error` event, all of that worker's unanswered calls reject (`SketchSolverTimeout`). The worker is then terminated and the next call spawns a fresh one; old drag sessions reject.
- **Failures don't stall the queue.**
  - `commitEdit` lands an edit unsolved when its solve fails, so a click is never lost.
  - Redraw and DOF re-solves keep the last display, with no unhandled rejection.
  - `endDrag` keeps what the drag steps applied.
- **A latent drag hang, fixed.** A drag step that rejected left `inFlight` set forever. The release's queued task polled it and blocked every later edit. Drag steps are now one promise that always settles (`try/finally`), and `endDrag` and `whenSettled` await it instead of polling.
- **Diagnosable.** `SketchSession.settleState()` (test hook `sketchSettleState`) names the queued task that is running and for how long. The E2E `settled()` helper fails after 45 s with that state, instead of timing out the whole test silently.
- **Amendment (M3.8 follow-up, review N4/N5).**
  - **The deadline starts once planegcs is loaded.** The worker posts one plain message besides Comlink: `{ wrenSketch: 'ready' }`, or `{ wrenSketch: 'failed', message }` if planegcs can't load (`packages/sketch/src/worker-protocol.ts`; Comlink ignores messages without its `id`). `SketchSolverApi` is unchanged. A call to a loaded worker has the 20 s deadline from the call. A call made while the worker is loading has its deadline start at the ready message. Before, a cold, slow link could take longer than 20 s to download the Wasm, and each restart downloaded it again. A loading worker is never restarted. A call that has waited `loadTimeoutMs` (120 s) for it rejects, and the worker keeps loading for the next call, so the edit queue still moves on. A `failed` message fails the waiting calls at once, and the next call spawns a fresh worker. Custom `createWorker` workers count as ready at once unless `signalsReady` is set.
  - **A release applies the last move.** The drag step loop stopped at `this.drag === d`. A release during a slow solve cleared `this.drag`, so the pending last position was dropped, and the geometry ended where the previous step landed (the flaky "hold on a circle edge then move" under load). `DragSteps` (`apps/web/src/app/drag-steps.ts`) runs the steps, latest position wins. `finish(true)` on a release waits for the step in flight, then applies the pending position before `endDrag`. A cancel or a pinch taking over drops it.

## ADR-089 — Initial-route headroom pass: 249.3 to 234.7 kB gzip (2026-11-11)

The initial route sat at 249.3 of 250 kB (0.7 kB headroom), too tight for M4. Chunks are assigned per module, so a module that one eager caller imports for one small export drags its whole body, and everything it imports, into the entry chunk. Measured with a throwaway Rollup `generateBundle` module-size dump (not committed), then rebuilt after each step. Sizes are `pnpm size` (gzip).

| Change | Initial route (kB) |
| --- | ---: |
| Baseline | 249.33 |
| `packages/document` `"sideEffects": false`, and `codec.ts` split so `archive.ts` (zip read/write, `fromFiles`, `projectCodec`) and with it fflate stay out of the eager chunk (`slugify`, `canonicalJson` stay in `codec.ts`; `canonicalBytes` uses `TextEncoder`) | 242.28 |
| `config-export` imported inside `exportDoc` (already async) | 241.96 |
| Touch shells (`TabletShell`, `PhoneShell`, `BottomSheet`) are lazy chunks; `preloadShell(tier)` runs in `main.tsx` before the first render on phone and tablet, and a loaded shell renders synchronously (no Suspense fallback). Desktop is unchanged | 238.09 |
| `ConfigStatusLabel` moved out of `ConfigurationPill.tsx`, so the pill (already a lazy chunk) is no longer pulled in by the Part inspector | 235.73 |
| `ConfigNotices` lazy (rendered only when there is a notice) | 235.06 |
| `WhichOneChooserLazy` (idle prefetch with the radial chunk) | 234.69 |

Result: 234.7 kB, headroom 15.3 kB. No behaviour change. `sideEffects: false` on document is safe because it has no import-time registration (same rule as ADR-075).

**Time to interactive** (perf project, cold shell on fast 4G, three runs each): before 1262 to 1270 ms, after 1184 to 1196 ms (budget 2250). Warm shell visible 117 to 398 ms before, 189 to 224 ms after (noise). Phones and tablets now fetch one extra chunk before the first render (precached after the first visit); not measured on a throttled phone profile.

**Tried, no gain:** `sideEffects: false` on io, sync and viewport (0 kB).

**Not moved, and why:** `PushPullTool`, `SectionTool` and `MeasureTool` (about 6 kB gzip) are built in the `Workbench` constructor and called synchronously from the pointer path (first interaction), so they need an async facade first. `ConfigController` with config-model and config-commands (about 17 kB) is a `Workbench` member used by the inspector and tree on first paint. `test-hooks.ts` (8.8 kB raw) is read synchronously by E2E (`__wrenApp`). `workbox-window` is on the cross-origin-isolation boot path. motion-dom (11 kB) is what `m` components need. `react-dom` is the floor. These are the candidates if M4 needs more room.

### ADR-084 amendment — the no-overlap rule covers tablet and desktop (2026-11-11)
- The iPad tutorial broke because the inline extrude depth field (anchored at its profile) sat under the picking chip's Cancel button. The rule now holds on every tier: `apps/web/src/ui/obstacles.ts` measures the floating chrome (top bar, rail, sheets, view cube, Library, keypad, the bottom stack), and anchored overlays avoid it. Priority, high to low: shell chrome, bottom stack, inline value fields (extrude depth, push/pull `ValueChip`, new `obstacles` prop), context bubble. The lower one moves (`placeBubble`) or, for the bubble, hides.
- `ExtrudeDepth` moved to its own lazy chunk (initial route 231.9 kB gzip). E2E `m38-tablet-overlays.spec.ts` asserts the depth field is the `elementFromPoint` target and that no overlay boxes intersect.

## ADR-090 — M4 contracts: part-level annotations, flat id-keyed drawings, HLR in a drawing worker; schema v4 (2026-11-11)

Applied from the drawing-engineer's proposal (`docs/proposals/M4-contracts.md`, the rationale, migration and validation rules). New contract files `annotation.ts` (shared core, ADR-081) and `drawing.ts`; changes in `document.ts`, `store.ts`, `modeling.ts`, `sync.ts`. `SCHEMA_VERSION` is 4.

**Decisions (proposal §9):**
1. Annotations live on `Part.annotations`, id-keyed and sorted by id. `origin` records provenance. Drawings store placements, never copies.
2. All of an annotation's geometry is in `refs: EntityRef[]` with a parallel `at: RefPoint[]`: one resolution and one reattach path for every kind.
3. A dimension's value is `source`, else `nominal`, else measured. `AnnotationResolution.value` is absent whenever the state is not `ok`, so a stale number is never shown.
4. Datum references are ids, with an unbound `{ label }` form that needs attention.
5. GD&T and surface finish carry a standard. Illegal symbols are refused or flagged with an explanation, never converted.
6. Configuration overrides of annotations are keyed by annotation id (`Configuration.annotations`). This closes the M3.7 gate finding about list positions.
7. Suppression in a configuration shows as "not in this configuration", not as needs attention.
8. Drawing collections are flat, with `sheetId` / `viewId`. Only `sheets` is ordered.
9. Projected and section views are stored relative to their parent. The side follows the projection, so switching first/third angle needs no edit.
10. The view centre is the projected 3D bounding box.
11. Everything on a sheet is in sheet mm, origin bottom-left, y up. The style is stored in full and the template version is pinned, so app updates never move an existing drawing.
12. A missing configuration id needs attention, never a fallback.
13. The v3 → v4 migration mints no ids. Feature-level `PmiAnnotation`s move to `Part.annotations`. Placeholder drawings (id + name only) are removed with a note.
14. HLR runs in a separate drawing worker. `ModelingApi.shapeForDrawing` hands over BREP bytes plus persistent edge and face names. Draft (PolyAlgo) output comes first, then exact.
15. Formatting and layout are one worker-safe module, `@wren-cad/drawing/annotation`, shared with M5.

**Changes while applying:**
- The drawing's hole table is `DrawingHoleTable`, because `HoleTable` is already the standards hole-size table.
- `DrawingDefaults` lives in `drawing.ts`. `RegenRequest.annotations` and `RegenResult.annotations` are plain optional fields; the proposal's `*4` interfaces are folded into the real types.
- New commands not yet implemented return "not available yet" from `compileCommand`. `shapeForDrawing` returns `UNSUPPORTED_FEATURE` until the workstreams land.

**Owner decisions (2026-11-11):**
- **D4, DXF:** in-house writer, no new dependency. R12 CNC-safe profile first, then R2000.
- **D5, font:** Osifont, if its licence checks out upstream. Record it in DEPENDENCIES first. Fallback is Noto Sans (OFL-1.1). GD&T and hole symbols are vector glyphs in both cases.
- **D6:** drawing dimensions are read-only in M4.
- **D7:** PDF/A and PDF layers are deferred. M4 writes vector PDF 1.7 at true scale.
- **D8:** markup is local-first, in `Drawing.markup`.
- **D9, standards:** provisional for now. Goldens built from public and secondary sources are marked "provisional (secondary sources)". The owner buys or borrows ISO 1101 and ASME Y14.5 first, then we re-verify.
- **D10:** an explicit standard and projection choice at the first drawing, remembered in `drawingDefaults`.

**Lead answers to the open questions:**
- **Q1:** composite frames are rejected with a clear message until P2.
- **Q2:** placeholder drawings are removed (no file in the wild has one).
- **Q3:** an unreleased output shows the last release with `*` and "Not released".
- **Q4:** markup goes in its own `drawings/<slug>.markup.json` once markup ships.
- **Q5:** `direction` stays a `Vec3` for now; an additive change later if needed.
- **Q6:** plain arrays for now; packed polylines only if the budget needs them.
- **Q7:** custom title-block templates are P2.

### ADR-090 amendment — kernel-client: annotation resolution and `shapeForDrawing` (2026-11-11)

Modeling workstream (packages/kernel-client). Details and numbers are in that package's README, "M4 annotations and drawings".

1. **When resolution runs.** After the walk, against the final state of the regenerated slot, only when `request.annotations ?? part.annotations.length > 0`. The engine reads annotations as the configuration-resolved document carries them, as it does for features. It does not apply `Configuration.annotations` a second time, because a background build's document is already that configuration's. Annotations never reach a feature's definition, values, cache key or walk entry. The old `/annotations/` filters (engine, attribution, `definition`) are gone.
2. **Suppressed, exactly.** The state is `suppressed` when the annotation is suppressed, when its source feature is, or when **every** unresolved ref has the structural cause `suppressed`. This also covers a suppressed datum or applied-to dimension. A dimension between a suppressed boss and the base plate is therefore "not in this configuration", not "needs attention". If any ref is missing for another reason, the state is `needsAttention`. Suppressed resolutions carry only `cause` (no anchors, value or unresolved list).
3. **Causes.** The annotation is a consumer after the last feature (cause.ts rules 1-3). Rule 2 applies only when the same stored ref resolved in the regen right before. A needs-attention resolution is therefore reused from that regen only. Datum letters and annotation ids are not persistent names and get no cause, so a label such as `BB` is never read as a body tag.
4. **Values.** `value` = source ?? nominal ?? measured, and is absent whenever the state is not ok (T1). A valued kind with no value at all (two points with no direction and no source or nominal, non-parallel faces) is `needsAttention` with an `error` that says why. `featureField` paths must be among the feature's `exprFields`. A missing constraint or field is `/source` missing with cause `changed`. A source feature that failed gives `cause: failed`. Radius and diameter sources are converted to the annotation's kind. A hole's value is its diameter; for a tapped hole it is the thread nominal. Ordinates are reported as absolute values.
5. **Hole instances** are the hole's `…:wall` faces in the final bodies, with pattern and mirror copies unwrapped. Split pieces count once, and the originals come first.
6. **Reuse and cost.** Resolutions are memoised per slot and annotation id. The key is the final state's content keys, the merge table, the feature states and keys, the parameters, and the annotation with its datums and applied-to dimension. Geometry probes are memoised per handle. On the stress part, 50 annotations add nothing to an unchanged regen and about 50 ms to the first regen after an edit. Last-feature edit: 191 ms CPU against 145 ms (budget 300 ms). Without annotations the stress benchmark is unchanged.
7. **`shapeForDrawing`.** It writes one BREP of the non-mesh bodies (a compound when there are several) through the existing `exportShapes(…, 'brep')`. No new façade entry is needed. The names are each body's primary names by TopExp index, concatenated, which is the BREP's `MapShapes` order. The round-trip test checks counts and per-index fingerprints. **Change from the proposal wording: `key` is not the app's `valueKey`** (that lives in apps/web and hashes the resolved document, annotations included). It is the hash of the final bodies' (id, content key). Equal `valueKey`s give equal keys; the key also stays equal across annotation-only edits and configurations that build the same geometry. So the drawing worker reloads only when the shape or its names may have changed.
8. **Kernel gap found (not edited here; for the kernel engineer).** `planeOf` ignores left-handed plane frames, so chamfer faces get an inward fingerprint normal and kernel face–face angles are reported as their supplement. Annotations take the sign from the render mesh meanwhile. The fix is one line, but it changes those faces' fingerprints. Also proposed: a minimal `subShapeGeometry(shape, kind, index)` that returns exact line, circle, cylinder, sphere and plane data, to replace about 27 probe measurements per round ref.

### ADR-090 amendment: no migrations before 1.0 (2026-11-11)

Owner decision: nobody uses the app yet, so there is no backwards compatibility. There is no v3 to v4 migration, and the old steps (unversioned, v1, v2, v3) are deleted with their fixtures and tests. `MIGRATIONS` is an empty registry; the framework and the "newer version" refusal stay because they cost nothing. A file whose `schemaVersion` is below `SCHEMA_VERSION` is refused on load with "This file was made by an earlier preview of Wren and can't be opened" and is never converted. Feature-level `PmiAnnotation` handling is gone entirely. The proposal's migration rules (§7) and its fixtures are void. Schema bumps before 1.0 do not migrate; the first bump after 1.0 adds the first step.

### ADR-090 amendment: document workstream choices (2026-11-11)

- **ISO 286 from the ISO 286-1 formulas, provisional (secondary sources).** `iso286.ts` computes IT grades (`i = 0.45 cbrt(D) + 0.001 D`, grade multipliers) and fundamental deviations from their closed formulas; no table is copied. Results carry `provisional: true`. The printed tables round some cells by rules that are not published as formulas, so a few cells differ by one step (Ø20 d9 is -64/-116 here against -65/-117 printed; Ø10 H7 is +14 against +15). The goldens say so, and the owner re-verifies when the standards are bought. Letters without a closed formula (`c`, `cd`, `j`, `p`, `r`, and `s` up to 50 mm) are reported as unsupported and the formatter shows the symbol without deviations; nothing is guessed. Sizes above 500 mm are unsupported.
- **GD&T and datum rules are data** in `annotation-rules.ts`: characteristic and modifier refusals per standard, no MMC/LMC on surface controls, form frames take no datum, orientation and runout frames need one, datum letters never use I, O or Q (one to three capitals), unique per part. All marked provisional. The datum-count and MMC rules use the contract's `refsDoNotFit` kind because `AnnotationIssue` has no better one; a dedicated kind is a contract proposal.
- **`DocumentStore.load` returns `notes`** (what loading repaired, from `normalizeDrawings`) as an extra field next to `ApplyResult`, and `MigrateResult` carries `notes`. `ApplyResult` itself is lead-owned and unchanged.
- **Validation: `style` numbers are positive except `hatch.angle`**, which is any finite number (0 and -45 are normal angles). Precisions are integers 0 to 6.
- **`normalizeDrawings` repairs a little more than the proposal lists.** Tables, notes and markup whose sheet is missing move to the first sheet, like views. A markup anchor to a missing placement or view is cleared and the markup stays. Sheet numbers are rounded to 0.001 mm there too, so a text-merged drawing normalises to the same bytes. Notes are structured (`kind`, `drawingId`, `message`).
- **Command rules.** `addAnnotation` refuses an origin drawing that does not exist. `updateDrawing` refuses to change the subject part while the drawing has placements (the placements would be dropped on the next load). `addDrawing` refuses a drawing that `normalizeDrawings` would repair, instead of repairing it silently. `duplicateDrawing` inserts the copy right after its source. `setTitleBlockFields` stores `''` as a deliberate blank and `null` clears the slot; an empty `fields` object is removed. `applyTemplate` checks the version against `LATEST_TEMPLATE_VERSION` in `drawings.ts`, which the drawing package raises when it ships a new layout. `removeSheet` removes the sheet's own views, tables, notes and markup, and the placements, marks and hole tables hanging on those views; a view on another sheet that was derived from a removed view stays and needs attention (missing parent). `removeAnnotation` with a drawing-origin annotation does not touch other annotations. `removeViews` clears markup anchors that pointed at removed placements or views.
- **`removeViews { dependents: 'detach' }` only detaches projected and iso children.** A section or detail view cannot be a base view (it would show the whole part, not the cut or the clip), so the command refuses and names it; the user removes it too. A detached child gets its resolved orientation (a standard view name when it is exactly one, else a matrix), its resolved sheet position, and any inherited scale and display baked in. The frame maths (`view-frames.ts`: Z-up, front = n -Y, projected views, iso from a corner of the parent, rotation CCW) is pure and exported; the drawing package should reuse it or replace it by one shared implementation. Section frames are not resolved (they follow the cut line), so a projected view of a section cannot be detached either.
- **Param usage** lists annotation expressions in the Params tab as `kind: 'feature'` entries without a `featureId` (labelled "Part: diameter dimension"), so the UI type did not change.
- **Sheet quantities are rounded to 0.001 mm by the commands** (`roundSheet`): positions, offsets, distances, strokes and style numbers. Part-mm fields (cut points, detail centre and radius, anchored offsets) and unit vectors are left alone.

### ADR-090 amendment: drawing support is a lazily loaded chunk (2026-11-11)

The M4 document work added about 16 kB gzip to the initial route (231.9 to 248.27 kB, budget 250), because the store statically reached the annotation and drawing validators, command compilers, `annotation-rules`, `iso286` and `view-frames`. They now load on demand and the initial route is 235.4 kB.

- **Registry.** `@wren-cad/document` (the core entry) keeps the core command switch, `validateDoc`, the configuration code and `annotation-fields.ts` (kinds, `annotationExprFields`, `ANNOTATION_CONFIGURABLE_OPTIONS`, `describeAnnotation`, which the Params tab and configurations need). Everything else is in `@wren-cad/document/drawing` (`src/drawing.ts`): annotation and drawing validation, both command compilers, `normalizeDrawings`, `annotationIssues` and the rule tables, ISO 286, `view-frames`, `planDuplicateDrawing`. `registerDrawingSupport()` installs the validators and compilers into `drawing-hooks.ts`.
- **Until registered, nothing misapplies.** Annotation and drawing commands fail with "Drawing support has not loaded yet", and `load`, `migrateDoc` and `validateDoc` refuse a document that has annotations, drawings, drawing defaults or annotation overrides, with the same message. A document without them loads as before.
- **App.** `apps/web/src/doc/drawing-support.ts` `ensureDrawingSupport()` is awaited by `createDocLibrary` (so stored documents), by opening a `.wrencad`, and by the sync controller's `openNew`. The workbench also starts it once the screen is ready. The M4 drawing UI must `await ensureDrawingSupport()` before its first annotation or drawing command. `__wrenApp.drawingSupport()` exposes it to E2E.
- **Tests.** The document suite registers the support in `test/setup.ts`; `drawing-support.test.ts` checks the unregistered behaviour on a fresh module copy. `e2e/drawing-support.spec.ts` adds an annotation, saves, reloads and reads it back. Other packages' tests are unchanged; they do not use annotated documents.
- **API change.** The core entry no longer exports the drawing modules; import them from `@wren-cad/document/drawing`.

### ADR-090 amendment: sync workstream, the drawing merge (2026-11-11)

Sync workstream (packages/sync), proposal §5. Code: `merge/tree.ts` (`COLLECTIONS`, `UNORDERED_COLLECTIONS`), `merge/drawing-merge.ts` (the dependent-edit rule and the notes), `merge/drawing-labels.ts`, `merge/drawing-diff.ts`. Tests: `test/drawings.test.ts` (one test per row of the §5 table) and `test/drawings-fuzz.test.ts`.

- **Collections.** The old feature-level `annotations` path is gone. `Part.annotations` and the drawing's `views`, `placements`, `centerMarks`, `tables`, `notes` and `markup` merge by id, are written sorted by id and never give an `order` conflict. `sheets` stays ordered: two different reorders are an `order` conflict.
- **Owners and closures.** The dependent-edit rule is applied to three kinds of owner. An annotation owns its placements in the drawings of its part. A view owns its placements, centre marks, hole tables and the views derived from it, transitively. A sheet owns its views (with their closures), tables and notes; the proposal only lists annotations and views, but `removeSheet` cascades the same way. When one side (D) deletes an owner the other side (K) keeps, the owner's closure is what K has under it that D no longer has.
  - If K changed the owner, or added or edited anything in its closure, the result is one `modifiedDeleted` conflict on the owner. The conflict lists its closure in `StructuralMergeConflict.dependents` (subject, pointer, K's value, and whether it was added, edited or unchanged). `text` reads "kept (1 dependent added: 1 placement)" against "deleted".
  - The closure follows the owner's resolution, so there is one decision and no separate conflict per placement. Kept: K's versions come back, including the unchanged placements that D's cascade removed. Deleted: they go. An owner inside the closure of another conflicted owner is decided with it, so deleting a view with an edited child is one conflict, on the view.
  - The decision is made before the walk, so the same rule holds when `resolve` re-runs the merge. A result patched by path (after a structured clone) applies `dependents` by pointer.
- **Unchanged closures go with the owner, with a note.** Notes: `placementRemovedWithAnnotation` (one per annotation and drawing) and `placementRemovedWithView` (one per outermost removed view; the summary also counts centre marks, hole tables and derived views). The notes come from comparing the sides with the normalised result, so they also cover what `normalizeDrawings` dropped. The normaliser's own drop notes are therefore not passed on. Its move and anchor notes (`viewMovedToFirstSheet`, `itemMovedToFirstSheet`, `markupAnchorCleared`) are passed on.
- **Annotation overrides are quiet dependents** (ADR-074 kind 1). They belong to the annotation's closure but never make it conflict. Without a conflict they are removed with the annotation, even when K edited them. This avoids a cell-level conflict about an override of something that is gone. The note `overrideRemovedWithAnnotation` (a `ConfigurationNote`) is given both when a dangling group is dropped and when a side's cascade removed groups the other side still had. If the annotation is kept by a conflict, its overrides come back. `Configuration.annotations` merges cell by cell like feature overrides: `annotations/<aid>/suppressed` and `annotations/<aid>/fields/<pointer>` are cells.
- **Markup is append-mostly.** Adds from both sides are kept. A delete against a resolve (only `resolved` became true) is a delete: both close the markup. A delete against a reopen or any other edit is a `modifiedDeleted` conflict. A markup is never a dependent: when its anchor goes, it only loses the anchor.
- **Duplicates.**
  - `duplicatePlacementDropped`: the normaliser keeps the smaller id. The note names the dropped id and `keptId`.
  - `duplicateDatumLabel` and `duplicatePromotion`: both annotations are kept and flagged when no single version already had all of them. A promotion is the same kind with the same `sketchDimension` or `featureField` source. The notes carry the annotation ids, so the panel's "Merge duplicates" can act on them; that command is not part of sync.
- **A drawing keeps a sheet.** If each side removed the sheets the other kept, the merge would leave none, which `validateDoc` refuses. The sheets either side still has are kept (base order, then id), with the note `lastSheetKept`, which is outside `DrawingMergeNoteKind`. A by-path resolution that empties `sheets` keeps the merged sheets.
- **After the walk:** annotations sorted by id, configurations reconciled, last sheets kept, then `normalizeDrawings` (injectable as `StructuralMergerOptions.normalizeDrawings`). `merge` and `resolve` call `registerDrawingSupport()`, so validating a merged document with drawings works without the app having loaded the chunk. The sync package is a lazy chunk itself, so importing `@wren-cad/document/drawing` adds nothing to the initial route.
- **Labels.** The labels use only what the document knows, never the kernel.
  - A dimension shows its nominal or its source expression, with lengths in the document's unit shown bare: "Dimension Ø6", "Dimension depth". A measured-only dimension reads "Diameter dimension".
  - Other annotations: "Datum A", "Position Ø0.1", "Note “…”".
  - Views: "View Front", "Section A–A", "Detail B". A projected view is named by `resolveViewFrame` and `namedViewOf` when it shows exactly one standard view ("View Top"), else "Projected view (top of View Front)".
  - Others: "Sheet 2"; a placement is "Dimension Ø6 in View Front".
  - In a document with more than one drawing, labels add "in <drawing>".
  - **There is no centre-mark subject kind,** so a centre mark is shown as part of its view (`kind: 'view'`, the view's id). Adding a `centerMark` kind is a possible contract change.
- **The drawing compare** (`drawingChanges`, `annotationChanges`) gives a line for each added, removed or changed sheet, view, placement, centre mark, table, note and markup. Annotation lines show value and tolerance changes ("Dimension Ø6: nominal 6 mm → 8 mm"). Layout changes read "moved", a `sheetId` or `viewId` change reads "moved to Sheet 2", and a refs change reads "reattached". Every subject carries `drawingId` and the item id.

## ADR-091 — M4 drawing package: one display list, in-house PDF and DXF writers, Osifont (2026-11-11)

`packages/drawing` (`@wren-cad/drawing`) is the drawing workstream's row of the M4 proposal (§12).

**Shape of the package.**
- It is DOM-free and Wasm-free. Kernel results (`ViewProjection`, `AnnotationResolution`) arrive as data. Model data arrives as data or injected functions: expression values, ISO 286 deviations, `annotationIssues` and title block data. The package is therefore built and tested against mocks and runs in any worker.
- Entries:
  - `.`: templates, styles, views, placement, import, needs attention, sheets;
  - `/annotation`: the worker-safe core shared with M5;
  - `/svg`, `/pdf`, `/dxf`, `/font`.
- `sideEffects: false`. The app does not import the package yet; the drawing route will load it lazily, so nothing lands on the initial route.
- Sizes (`pnpm --filter @wren-cad/drawing size`, minified / gzip):
  - annotation: 51.5 / 16.1 KB;
  - root: 122.2 / 35.6 KB;
  - svg: 18.2 / 5.8 KB;
  - pdf: 35.9 / 12.7 KB, with fflate;
  - dxf: 30.7 / 9.0 KB;
  - font file: 76.6 KB gzip, fetched only by the drawing route and the PDF export.

**One display list.**
- Every sheet is composed once into a list of primitives (line, polyline, arc, ellipse, spline, fill, text) in sheet mm, origin bottom-left, y up.
- Each primitive carries:
  - a line role (`visible`, `hidden`, `tangent`, `center`, `dimension`, `hatch`, `cuttingPlane`, `cuttingPlaneEnd`, `frame`, `thin`, `text`);
  - its source (view edge, placement, title block slot …);
  - the attention flag.
- SVG, PDF and DXF only translate the list; none of them lays anything out.
- One mapping, `roleStroke`, gives all three their widths and dash patterns:
  - widths from the ISO 128 line groups, ASME 0.6/0.3, and the ISO 5457 frame at 0.7 mm;
  - ISO 128-2 dash patterns in multiples of the line width d: dashed 12d/3d, long-dash dot 24d/3d/0.5d/3d.
- Symbols are never font glyphs. The symbol library draws them as paths in units of h: every GD&T characteristic and modifier, ⌴ ⌵ ↧, datum triangles, surface texture and projection symbols.

**Font (owner D5): Osifont, licence verified upstream.**
- The upstream README (github.com/hikikomori82/osifont) ships `osifont-lgpl3fe.ttf` under "GNU LGPL version 3 with GPL font exception". The font's own name table (ID 0) carries the same statement and the exception text.
- LGPL-3.0 is compatible with Wren's GPL-3.0-or-later. The exception covers documents that embed the font or unaltered portions of it, which is what the PDF writer does.
- A pinned copy (SHA-256 `81880ba0…320b6`, version 0.1.20221020) is self-hosted in `packages/drawing/assets/fonts` with its notice. The licence is in `licenses/LGPL-3.0.txt` and in the third-party notices script. The Noto Sans fallback was not needed.
- Text height is the ISO 3098 nominal height h, the cap height: font size = h · unitsPerEm / capHeight.
- Layout never reads the font file. It uses generated advance widths in `src/font/osifont-metrics.ts`, regenerated by `pnpm metrics` and checked against the TTF in a test.
- Kerning is off in every renderer, so text sits identically everywhere: SVG sets `font-kerning:none`, the PDF places glyphs by advance, and DXF has no kerning.
- Characters the font lacks are replaced before layout: − → -, ′ ″ → ' ".

**PDF 1.7 is written in-house, not with pdf-lib or jsPDF.**

Why:
- The requirements are a glyph-id-preserving subset of a TrueType font, `/ViewerPreferences << /PrintScaling /None /Enforce [/PrintScaling] >>`, exact point coordinates and byte-for-byte reproducible output.
- pdf-lib needs `@pdf-lib/fontkit`, which is large, to embed and subset TrueType, and it writes its own producer metadata. jsPDF embeds whole fonts.
- The writer is about 600 lines with no new dependency. fflate, already in the workspace, compresses the streams.

Decisions:
- **Coordinates.** The MediaBox is the sheet in points. mm → pt happens once, when numbers are written (× 72/25.4, three decimals), with no `cm` matrix. Content-stream coordinates are therefore directly measurable:
  - the 100 mm reference graduation is exactly 283.465 pt;
  - a 100 mm part edge is 283.465 pt at 1:1 and 141.732 pt at 1:2;
  - a 0.35 mm line is `0.992 w`.
- **Fonts.**
  - Type0 / CIDFontType2, Identity-H, `/CIDToGIDMap /Identity`, `/W` from the font's advances, and ToUnicode for copy and search.
  - The subset keeps every glyph id and empties unused glyphs; composites keep their components. GSUB/GPOS/GDEF are dropped, and `name` is kept because it carries the licence.
  - The subset tag and the file `/ID` are hashes of the content. There is no date unless the caller passes one.
- **Curves.** Arcs and ellipses are cubic Béziers of at most 90° each. Splines are flattened to 2 µm; an exact B-spline → Bézier conversion can come later if a reviewer wants it.
- **Scale bar.** It is the ISO 5457 metric reference graduation, 100 mm in 10 mm steps. The template draws it in the left filing margin, centred on the left centring mark and clear of the zone letters, with the sheet scale beside it. ASME sheets get the same graduation (it is not a Y14.1 item), so every export can be checked with a ruler.
- **Deferred.** PDF/A and layers stay deferred (D7).
- **Extra check.** When poppler (`pdfinfo`, `pdftotext`) is installed, a test reads the page size, version and text from the file.

**DXF is written in-house (owner D4).**
- **R12 (AC1009), "CNC-safe".**
  - Sections: HEADER, TABLES (LTYPE, LAYER, STYLE) and ENTITIES only; no handles.
  - Entities: LINE, ARC, CIRCLE, POLYLINE and TEXT.
  - Ellipses and splines are flattened (0.01 mm by default). Fills (arrowheads, datum triangles) become closed polylines. `geometryOnly` drops text.
- **R2000 (AC1015).**
  - Handles, owners and `$HANDSEED`.
  - Tables: VPORT, LTYPE, LAYER, STYLE, VIEW, UCS, APPID, DIMSTYLE and BLOCK_RECORD.
  - Model and paper space blocks; OBJECTS with the root dictionary, ACAD_GROUP and the Model/Layout1 layouts.
  - Header: `$INSUNITS = 4`, `$MEASUREMENT = 1`, `$LTSCALE = 1`, `$LWDISPLAY = 1`.
  - One layer per role with its lineweight. The ISO line types are in absolute mm at the thin width. The text style points at `osifont.ttf`; CAD substitutes its own font when that is absent.
  - Entities: LINE, ARC, CIRCLE, LWPOLYLINE, ELLIPSE, SPLINE (exact, rational when weighted), TEXT, and SOLID for fills.
  - Dimensions are exploded.
  - Hatching is exported as LINEs on the HATCH layer, not as HATCH entities: simpler, CAM-safe and identical in every reader. Revisit if users want editable hatches.
- **Both profiles.**
  - Doubles always carry a decimal point, at most 6 decimals and never an exponent.
  - Ø ° ± are written as `%%c %%d %%p`; other non-ASCII as `\U+XXXX`.
  - Attention items are colour 1.
- **Tests.** Goldens (`test/golden/*.dxf`) plus an audit written in the test. The audit checks:
  - section order and group code pairs;
  - unique hex handles;
  - that every 330/340/350 pointer resolves;
  - that `$HANDSEED` is above every handle;
  - that every referenced layer, line type and text style exists.
- **CI to do.** Python ezdxf and LibreCAD are not available offline here.
  - The ezdxf audit test is in place and skips without `ezdxf`. CI should `pip install ezdxf`.
  - CI should add a headless LibreCAD `dxf2pdf` conversion of both goldens (PLAN M4 accept).
  - QCAD stays best effort.

**Templates (provisional, secondary sources, owner D9).**
- **ISO 5457 v1.**
  - Margins 20/10 mm and a 0.7 mm frame.
  - Grid fields of 50 mm measured from the centring marks, with the end fields taking the rest. This rule reproduces the A0–A4 field counts, 24×16 … 6×4.
  - Numbers run left to right, letters top to bottom, without I and O.
  - Centring marks, and thin corner trim marks.
  - ISO 7200 title block, 180 × 56 mm, with all 21 slots.
- **ASME Y14.1 v1.**
  - Margins of 0.38/0.25 in on A and B, 0.5 in on C–E.
  - Equal zones, numbered right to left from the lower right and lettered bottom to top: A 2×2, B 4×2, C 6×4, D 8×4, E 10×6.
  - Title block 170 × 60 mm. It has no `language` cell; text for that slot is kept and listed as unused.
- **Versions.** The generator registry keeps every version. A version newer than the app is refused with "update Wren"; the sheet then falls back to v1 for display, and the problem is listed.

**Layout conventions.**
- **Linear dimensions.**
  - The measuring direction is made readable first: +x, else +y.
  - The offset is measured along that direction's left normal, from the outermost measured point on that side. A positive offset is therefore above a horizontal dimension and left of a vertical one.
  - A lane's side must match the measuring axis: top/bottom for horizontal, left/right for vertical. A mismatch is flagged.
- **Diameters and radii.** A diameter seen side-on (a cylinder) takes a lane or offset across its silhouettes. Radius and diameter radial layouts need the circle face-on.
- **Sizes.** Stacked deviations and limits are 0.7 h. A frame is 2 h high with a square symbol cell. Per-unit refinements are written on one line; stacking them, as ISO does, comes later.
- **Ordinates** are drawn one by one; the shared `0` label per group is a follow-up.
- **Presets.**
  - The ISO preset uses `.` as the decimal mark. ISO 80000-1 allows both, and the style can change it.
  - DMS angles: `anglePrecision` 0 shows degrees, 1–2 minutes, 3–4 seconds, and above 4 adds decimals of seconds.

**Import planner.**
- Existing annotations are checked by default. Promoted driving dimensions are unchecked, because they carry no tolerance.
- **Sketch dimensions:**
  - h/v distances become `linear` along the sketch's u/v;
  - point–point distances and lengths become `aligned` between the sketch points;
  - radius, diameter and angle keep their kind;
  - offsets are not promotable.
- **Extrude depth:** `linear` between `F:start` and `F:end`, along the profile sketch's normal.
- **Fillet, chamfer, hole and revolve** follow the ADR-090 table.
- **View choice.** For a promotion, the sketch frame decides. Where that is not enough (fillet, chamfer, revolve), the injected anchor resolver decides. Without a resolver the candidate is listed as "no geometry" and never placed on a guess.
- **Lanes** are packed per side, shortest first. Neighbours share a lane when their spans plus 4 h do not overlap. Existing lane placements reserve their whole lane.

**Needs attention.**
- **Severities.**
  - Attention:
    - unresolved refs;
    - value mismatch;
    - illegal for the standard;
    - unbound or duplicate datums;
    - missing configuration or part;
    - end-on geometry;
    - a layout that doesn't fit;
    - missing anchors or attach target.
  - Warning:
    - standard mismatch;
    - duplicate callout;
    - placed twice;
    - a view in another configuration.
  - Info: "not in this configuration".
- Each entry carries the sheet, the grid zone and the upstream `cause`.
- Placement-level kinds the contract does not have (`layoutDoesNotFit`, `anchorsMissing`, `attachTargetMissing`) are package types (`PlacementIssue`).
- **Proposal for the lead:** add them to `AnnotationIssue` if the UI wants one typed list.

**Not done in this step.**
- Automatic centre lines on cylinders seen side-on: `ViewProjection` has no axes. Centre marks on face-on circles are done.
- Ordinate groups.
- Exact B-spline → Bézier conversion in the PDF.
- The ezdxf and LibreCAD CI jobs.
- Re-verifying every provisional golden against the standards (D9).

### ADR-083 amendment: a verified main push reuses the dev run's kernel (2026-11-11)
- **Problem:** GitHub's cache is scoped by branch, so main cannot restore a kernel cached on a `claude/**` branch. The first main push after any kernel change therefore rebuilt OCCT in Docker, about 45 minutes, before the deploy.
- **Change:** the `verified` job now also outputs the id of the dev run that passed the commit. `kernel.yml` takes it as `from_run`. On a cache miss it downloads that run's `kernel-dist` artefact instead of building.
  - It skips `kernel:test`, because that run already tested the same commit.
  - The cache step's post job saves the downloaded dist to main's cache.
  - With no verified run, the old path runs unchanged.
- (Same day) Browser installs on CI now go through `scripts/ci-install-browsers.sh`. Run #81 lost six browser jobs at once when the runners could not resolve the Ubuntu mirrors. The script retries `--with-deps` twice with a back-off. If the mirrors are still down, it installs the browser alone with a warning; the runner image already has Chromium's libraries.

## ADR-092 — M4 drawing route: a lazy route over the model, a placeholder HLR kernel behind `DrawingKernelApi`, phone is review-only (2026-11-11)

UI workstream for M4 (apps/web `src/drawing`, packages/ui `src/drawing`). The drawing package (ADR-091), the document commands and the regen's annotation resolutions (ADR-090) were already in place. The HLR drawing worker was not, so the route runs against a placeholder.

**Route**
- `DrawingRoute` is a lazy chunk, rendered full-screen over the model when `ui.drawing` is set. The model stays mounted and `inert` underneath, so the regen keeps running (the route reads its resolutions) and focus cannot escape into it. `wb.openDrawing(id | null)` opens it (`null` = a new drawing). The app's own keys are ignored while it is open, except undo, redo, save and open.
- Entry points: ⌘K "New drawing", and a **Drawings** section in the part inspector (desktop, tablet) and in the phone's Parts tab. It lists, opens, renames and deletes (inline confirmation, no dialog) and makes a new one.
- All state shown is rebuilt from the document: `DrawingController` runs `runPipeline` (config data per configuration, then `solveViews`, then projections from the kernel, then `buildDrawing`) whenever the document or the regen changes. Every edit is a document command, so undo, redo, sync and save need nothing new. Drags share a coalescing key and close on release.
- `@wren-cad/ui/drawing` is a separate entry of packages/ui (presentational, like the rest of the package). Nothing from it is in the initial route.

**D10 (explicit standard and projection)**
- The first drawing of a project shows `StandardChoice` inline in the route, not in a dialog. Create stays disabled until a projection is chosen: ISO is preselected as a standard, but the projection is never defaulted from it. `setDrawingDefaults` stores the choice. Later drawings are created at once from it, and the template, sheet (A3 or ANSI B), style and projection follow the standard. The projection can be changed per drawing in the Sheet panel. Changing the family changes sheet and style, so it is a new drawing.

**Initial route: 235.4 kB gzip before, 235.96 after (the budget for this step was 236; the hard limit is 250)**
- A first build with the route wired in measured 244.6 kB. Nothing in it was eager. The cause was chunking. A lazy chunk that statically imports `@wren-cad/document/drawing` makes the bundler split about a dozen modules that the initial chunk shares with it (expressions, configurations, tools, …) into separate small chunks, and gzip of split chunks is worse than gzip of one: +9 kB. The route reads that module as `drawingDocument()` from `doc/drawing-support.ts` (set when `ensureDrawingSupport()` loads it) and never imports it. Direct imports of the core `@wren-cad/document` are fine.
- `resolveHoleSize` moved to its own module `hole-size.ts` (re-exported from the document index and from the drawing chunk; this and its test import are the document package's only changes). Used by the drawing route from the tables' module it would have pulled 0.75 kB gzip into the shared `hole-tables` chunk.
- One rolldown `codeSplitting` group in `vite.config.ts` keeps four small shared modules (`references`, `check`, `annotation-fields`, `hole-tables`) in one chunk (−0.4 kB).
- The route has its own `EmptyState`: importing the shell's dragged the shell's tool definitions into a shared chunk.
- A rule for future lazy routes: run `pnpm --filter @wren-cad/web size` after wiring one in. The cost of a lazy chunk is what it makes the bundler share, not its own size. `pnpm --filter @wren-cad/web bundle-report` lists the initial chunks.
- The Osifont TTF is a hashed asset, fetched by the sheet's `@font-face` and by the PDF export only. The service worker runtime-caches it (`isDrawingFont`, cache `whittle-font-v1`), so a drawing exports to PDF offline.

**The placeholder drawing kernel (not HLR)**
- `src/drawing/placeholder/`: a worker implementing `DrawingKernelApi` over Comlink. `ShapeForDrawing.brep` carries the regen's render meshes in a small binary layout (`WRENPH01`), not BREP. The real worker will refuse that layout and read real bytes. `drawing/kernel.ts` wraps either one with load-once, a projection cache (240 entries) and a reload when the worker evicted a shape.
- What it does: projects the meshes' B-rep edge polylines and the silhouettes of curved faces (tessellation edges whose two triangles face opposite ways). Visibility comes from a software depth buffer (700 px along the longer side, 3×3 neighbourhood, depth bias 0.4 % of the bounding diagonal). Edges are smooth when the dihedral angle is under 8°. Circles are fitted in 3D, and those seen face-on are returned as exact `arc` curves. Sections keep the far half space (stepped cuts take the nearest segment's plane per triangle), cap by the cut loops and return the loops for hatching. Details clip to the circle.
- Known approximations: visibility is ±1 px; silhouettes sit on tessellation facets; ellipses and splines are polylines; `quality: 'exact'` equals `'draft'`; a section does not mend the mesh. The route says so with an "Approximate edges" badge in the top bar. Dimensions are exact: they come from the real regen's `AnnotationResolution`s.
- **Swap**: `createDrawingKernel()` in `drawing/kernel.ts` returns the placeholder. The real worker replaces it there, and `shapeFor` (regen result to `ShapeForDrawing`) becomes `ModelingApi.shapeForDrawing(partId, slot)`. Nothing else depends on how projections are made. Unit tests (`placeholder/kernel.test.ts`) fix the placeholder's behaviour. The E2E asserts view structure and dimension values, not edge counts.

**Views and interaction (PLAN §9.2)**
- Tools: Select (default), Add view (panel), Section, Detail, Dimension, Datum, Tolerance frame, Surface finish, Note, Import. A prompt chip says what to pick and Esc leaves the tool.
- Views: base (the six standard orientations, one tap each), top and side views of a base, isometric, section (drag the cut line across a view; the viewing side and depth are in the inspector) and detail (drag a circle; the scale is the largest ISO series ratio above the parent's that makes it about 55 mm across). **Projected views are dragged out of a selected view** by one of four arrows. The side follows the projection (`sideForDirection`), the view stays on the axis (`aligned`), and a second view on the same side is refused with a message. Switching first and third angle changes the drawing's `projection` only: the stored views are byte-identical (E2E) and the aligned views mirror.
- Moving a view drags it (free) or slides it along its axis (aligned, never closer than 5 mm). The scale is an inline expression field (`1:2`, `2`, `1/4`; `1:2` is read as `1/2`). Label, display, configuration, position and distance are inline fields too, the alternative to dragging (WCAG 2.5.7).
- Configuration: the drawing's (Sheet panel) and each view's (view inspector). A view's own configuration is badged in the list, the header and the inspector. Each configuration is regenerated in its own `config:<id>` slot (as the configuration builds do, ADR-074) and memoised by what the regen reads. A configuration that no longer exists shows as "Missing configuration" and is a needs-attention entry; it never falls back to Default (T13). Limit: annotation expressions are evaluated in the drawing's configuration.
- **Dimension tool** picks named edges on a view. A circle is a diameter (Alt or Shift: radius; an arc is a radius). Two parallel straight edges are a linear dimension along the view's horizontal or vertical (the lane side follows where they were picked, in the next free lane), or their natural separation when they are not axis-aligned. An edge and a circle measure to the centre; two circles along the larger separation. One straight edge picked twice is its length (`aligned`, `start`/`end`). Non-parallel edges and curved edges are refused with the reason, never guessed. The tool creates a part annotation with `origin: drawing` and its placement in one `addAnnotation` with `place` (one undo step), and selects it.
- Datums, frames, surface finishes and notes attach to a picked **edge**, because the sheet cannot pick a face before the real HLR reports faces. The contract's `refs` kinds are not narrowed, so the kernel resolves them. M5 will want faces, and these are one reattach away. A frame defaults to flatness (position with a Ø zone and the first datum on a circle), a finish to Ra 1.6 µm, and datum letters skip I, O and Q. Everything else is edited inline in the annotation inspector: the characteristic (the drawing standard's refusals are disabled with their reason, never converted), zone, Ø, material condition, up to three datums chosen from the part, finish parameters, note text, and a hole callout's lines.
- **Tolerance field**: type it as written (`±0.1`, `+0.2/-0.1`, `H7`, `H7/g6`, `[10]`, `(10)`, `10 10.1/9.95`). `parseTolerance` reads it. The field shows what it understood, or why it could not, commits on Enter or blur and reverts on Esc. Empty clears.
- **Promoted driving dimensions are read-only (D6)**: no stated-value field, the source feature is named, and "change it there". Tolerance and text stay editable, because they belong to the annotation.
- **Dragging an annotation** between lanes: lane layouts follow the pointer's distance from the view outline and may flip to the opposite side of the same axis; offsets move along the dimension line's normal; radial leaders follow angle and distance from their circle; leader text keeps its offset. One undo step per drag ("Move annotation").
- **Import model annotations**: `planImport`, then a checklist (promoted driving dimensions start unchecked, existing ones checked; rows with no suitable view say why), then `importCommand`, which is one `placeAnnotations` step. A second import offers nothing: nothing is placed twice.
- **Title block**: the Title block panel lists every cell of the template with its source (From the model; text; Overrides the model, with the model's value and one tap back). Clicking a cell on the sheet opens an inline editor over it (Enter commits, Esc leaves; typing the model's own text clears the override). Text is stored where it already lives (the sheet's fields, else the drawing's).
- **Needs attention** (aggregation from packages/drawing; the entries of one annotation merge into one row): sheet, grid zone, plain-language message, search, select (which switches sheet), and **Reattach…**, which asks for the new edges in order and applies one `reattachAnnotation`. A resolution that is not `ok` never shows a value (T1). While the model has changed and its regen has not arrived (`pending`: the freshness key of the last regen against the current model, ignoring the drawings), the sheet is kept, its annotations are dimmed and the viewer is `aria-busy`. Export waits.
- **Export**: PDF (vector, true scale), SVG, DXF R12 and R2000, for the current sheet or all of them. The renderers and the font load on the first export. The E2E checks the PDF's MediaBox (A3 landscape: 1190.55 × 841.89 pt) and `PrintScaling None`, the DXF versions (`AC1009`, `AC1015`) and the SVG's size in mm.
- **Hole callouts** come from Hole features (import). The numbers are the feature's, from the ISO/ANSI tables (`resolveHoleSize`) and its expressions, so editing the hole updates every view (E2E: M6 to M8 turns Ø6.6 THRU into Ø9). Workaround: the regen resolves a hole callout's `instances` but gives it no `anchors`, so the leader had nothing to attach to. `hole-anchors.ts` reads the first instance's cylinder from the render mesh (normals perpendicular to the axis, points one radius from it). Remove it when the kernel reports the anchor (proposal 1 below).

**Phone and tablet (PLAN §9.1: phone editing is parameters and simple features)**
- Tablet: the same tools in a horizontal strip over the sheet, a bottom panel with the same tabs, 44 px targets. One finger moves a view or drags an arrow out, two fingers pinch and pan, a double tap fits.
- **Phone is review-only for drawings**: open from the Parts tab, pan, pinch, double-tap to fit, the Views list, the needs-attention list (no Reattach) and Export. There is no toolbar, undo, inspector, import, title block or settings, no new drawing, and the drawings list has no rename or delete. PLAN does not ask for editing drawings on a phone. Revisit if users ask.

**Accessibility**
- The sheet is an `application` group named with its content ("Sheet 1 of …: 3 views, 19 annotations, 2 needing attention"). It has keyboard pan (arrows), zoom (+, −) and fit (0), plus visible zoom buttons. Every drag has an inline alternative. The toolbar is a Radix toolbar (one tab stop). Axe (serious and critical) runs on every panel and state in the E2E and on every gallery state (about 240 baselines: desktop light and dark, phone, and the tablet where touch changes the layout).

**Not done, or approximate**
- Cut lines are two points (offset and half sections need vertex editing: the store and the layout already support more points). A new section is placed freely, not aligned.
- No ordinate groups, bolt circles, centre-line tool, weld symbols (P2), hole table or balloons (M6/P2). Part properties tables are composed, but the UI cannot add one yet. Sheets can be added and exported, but views cannot be moved between sheets in the UI.
- Promoted sketch dimensions measured from `@origin` (the sketch's origin) do not resolve in the kernel, so they show as needs attention, honestly. Neither does an extrude depth whose start face is merged into another body.
- Fillet, chamfer and revolve promotions list as "No geometry to place it on": they need an anchor resolver (a drawing-worker or regen query by `EntityRef`).

**Proposals for the lead**
1. kernel-client: give a hole callout's resolution `anchors` (the first instance's circle), then delete `hole-anchors.ts`.
2. contracts or kernel-client: an anchor-by-`EntityRef` query so import can place fillet, chamfer and revolve dimensions.
3. Drawing worker: when real HLR lands, name the silhouettes of cylinders (faces) so datums and finishes can attach to faces.
4. packages/drawing: `PlacementIssue` kinds in `AnnotationIssue` (already proposed in ADR-091) would remove the route's merge of two entries per annotation.
