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
- **Pages base path.** CI derives the base from the repository name
  (`/${{ github.event.repository.name }}/`), so the deploy works before and after the owner
  renames the repository on GitHub. After the rename, sign-in redirect URIs must change to
  `https://jackhale98.github.io/wren-cad/` (docs/SYNC_SETUP.md), and installed home-screen copies
  need reinstalling from the new address.

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
