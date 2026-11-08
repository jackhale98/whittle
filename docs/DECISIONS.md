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
| Packaging       | Canonical folder of deterministic JSON; `.whittle` = zipped folder (`fflate`)                                   |
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

**Decision.** Whittle's own code is licensed **GPL-3.0-or-later** (owner decision, 2026-11-08). This
supersedes the Apache-2.0 row of ADR-001.

**Why.** Mycelium's sync layer (same author) is GPL-3.0; matching it lets `packages/sync` port its
provider adapters, auth flows and conflict handling directly (PLAN §8A) with no relicensing step.
Copyleft also keeps forks of Whittle open.

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
the inertia tensor when a density is given. Whittle ships a built-in material library (M1); STEP
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
3. **In-app welcome instead of a landing page** (owner decision). The app stays at `/whittle/`, so
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
2. **Opening a `.whittle` never overwrites a different library entry.** Same `meta.id` with
   different content (document files or extra files) opens as a new entry: new id, " (copy)" when
   the name is taken, and a non-modal note. Only an identical project reuses its entry.
3. **Imports.** Open/Import (inspector, ⌘O) and drag-and-drop add an `ImportFeature` to the open
   part; the library's and the welcome card's "Open or import…" start a new document for it (no
   part is being worked on there). Bytes live at `imports/<featureId>.<format>` and are sent to the
   engine once per part and worker (keyed by sha256), again after `closePart`.
4. **Mesh cache for instant open.** Fine meshes go to `.whittle/meshes/` (FILE_FORMAT.md) with the
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
   `WHITTLE_PERF=1` probes. Time budgets are multiplied by `PERF_FACTOR` (`e2e/perf/budgets.ts`):
   **3 on CI, 1.5 locally**, override with `WHITTLE_PERF_FACTOR`. Rationale: the 2-vCPU runners have
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
3. **`Measurement` is declared in the UI package** (`measure/types.ts`) because `@whittle/contracts`
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

## ADR-015 — M2 app integration: gestures, direct editing, tiers (2026-11-08)

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
   `@whittle/sketch/recognize` only; the package root no longer re-exports it, since the root is
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
9. **Import attachments.** Saved files (library, `.whittle`) never carry orphans: only the
   attachments the current document references, plus all non-import extra files. In memory an
   orphan stays while the undo/redo history still mentions its path
   (`DocumentStoreImpl.historyMentions`), so undoing the delete always finds the bytes; once the
   history has dropped it (it fell off the end, the redo branch was replaced, the document was
   closed) it is pruned at the next save.
10. **Tool groups.** Section joins Measure in the Inspect group, so Inspect is a flyout (ADR-012
    item 4's single-tool Inspect no longer holds). `toolGroups` is the single source of truth; the
    desktop command bar keeps PLAN §9.1's flat set (`commandBarTools`): Push/pull and Section are
    reached from their groups, the palette, shortcuts (P) and context actions.
11. **Cached open, profiled.** On SwiftShader the critical path is the library read (≈ 60–80 ms
    after the main chunk evaluates), the view's creation (≈ 40–60 ms) and its first frame with
    the cached bodies, which compiles their shaders (≈ 120–160 ms). Interleaved A/B runs (8 + 8
    reloads per variant) found no gain beyond run-to-run noise (± 40 ms under load) for: reading
    the library in a worker (worse: +55 ms, the worker's start-up outweighs the decode it saves),
    creating the view without waiting for the read (much worse, as in ADR-008 item 4), fetching
    three.js before React's first commit, deferring the idle shader warm-up past the cached frame,
    and dropping the view cube. None of them was kept.
