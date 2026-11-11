# @wren-cad/web

The Wren app. It is the composition root: it boots the kernel worker and the sketch worker, wires
the document store to the regeneration engine and the viewport, renders the shells from
`@wren-cad/ui`, and runs the PWA service worker. Kernel, document, sketch and viewport logic live in
their own packages. The app keeps the glue: the workbench, the boot order, and the rules for what
happens when a user acts.

The live build is at <https://jackhale98.github.io/wren-cad/>.

## Layout

```text
src/
  main.tsx              boot order: theme, workbench, kernel, service worker, React
  sw.ts                 the single service worker (precache, kernel cache, isolation headers)
  app/
    App.tsx             wires the shells to the workbench (commands, feature tree, params, export)
    workbench.ts        the controller: document store, regen loop, viewport, selection, tools, files
    ViewportHost.tsx    creates the viewport lazily, after the shell paints
    sketch-session.ts   sketch mode: tools, solves, drags, dimensions, conflicts
    state.ts, observable.ts, timing.ts   UI state, change notification, boot timing marks
  drawing/              M4 drawings: a lazy route over the model (ADR-092)
    DrawingRoute.tsx    the route: shell, tools, sheet, panels
    controller.ts       opens a drawing, keeps its build current, runs commands
    pipeline.ts         model data per configuration, views, projections, buildDrawing
    config-data.ts      regen result, resolutions and shape of each configuration
    interact.ts         what a press on the sheet means in each tool
    ops-views.ts, ops-annot.ts   view and annotation commands (one undo step each)
    placeholder/        the placeholder HLR worker (DrawingKernelApi over the regen meshes)
    kernel.ts           load-once and cache around any DrawingKernelApi
    exports.ts          PDF, SVG and DXF downloads
  model/
    engine.ts           boots the kernel client and picks the real engine (fake only in dev)
    modeling.ts         the regen loop: coarse on edit, fine when idle, stale-result handling
    heal.ts             folds rebound references into the next user edit (ADR-008 §1)
    attention.ts        ghosts and candidates for references that need attention
    import.ts           import features, attachment names, format detection
    frames.ts           origin and sketch plane frames
    fake-modeling.ts    main-thread stand-in for the engine, dev and tests only
  doc/
    library.ts          local library and .wrencad codec, loaded lazily
    autosave.ts         debounced save (500 ms) and save on hide
    mesh-cache.ts       the .wren/meshes cache (instant open)
  sketch/               sketch drawing, dimension editing and overlays
  selection/pick.ts     pick tolerances per pointer type, best hit vs "Which one?"
  features/factories.ts new-feature defaults and the command-bar tool requirements
  platform/             service worker registration, updates, install prompt, diagnostics and tiers,
                        isolation headers, page guards (touch), runtime state
  samples/bracket.ts    the demo bracket (the M1 acceptance part)
  ui/                   Inspector, Welcome, ViewportOverlays, LibraryPanel
public/_headers         isolation and cache headers for hosts that read this file
e2e/                    Playwright specs and fixtures (see below)
scripts/                icon generation, and the static server used by E2E tests
```

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm --filter @wren-cad/web dev` | Vite dev server. Base `/`. Sends the isolation headers itself. |
| `pnpm --filter @wren-cad/web build` | Production build to `dist/`. Base `/wren-cad/` (override with `WREN_BASE`). |
| `pnpm --filter @wren-cad/web preview` | Serves `dist/` with the isolation headers. |
| `pnpm --filter @wren-cad/web typecheck` | Five `tsc` projects: app, tests, service worker, Node config, E2E. |
| `pnpm --filter @wren-cad/web test` | `vitest run` over `src/**/*.test.ts`. |
| `pnpm --filter @wren-cad/web size` | `size-limit`: initial-route JavaScript ≤ 250 kB gzip (`.size-limit.mjs`). Run the build first. |
| `pnpm --filter @wren-cad/web e2e` | Builds, then runs the Chromium project. Also reachable as `pnpm e2e` from the root. |
| `pnpm --filter @wren-cad/web e2e:all` | Builds, then runs every browser project (Chromium, Firefox, WebKit). |
| `pnpm --filter @wren-cad/web perf` | Builds, then runs the `perf` project (`e2e/perf/*.perf.ts`), serially. |

The build writes the JSON Schemas to `dist/schema/`, so they are published at `/wren-cad/schema/`.
The root `pnpm build` then adds `THIRD_PARTY_NOTICES.txt` to `dist/`.

## Vite and the service worker

- `vite.config.ts` uses `vite-plugin-pwa` in `injectManifest` mode with `src/sw.ts`. Only one service
  worker is registered. Do not add `coi-serviceworker`, because only one worker can control a page
  (PLAN §8.3).
- The isolation headers (`COOP: same-origin`, `COEP: require-corp`, `CORP: same-origin`) are set for
  `server` and `preview`. The service worker adds the same headers on GitHub Pages
  (`src/platform/isolation-headers.ts`). `public/_headers` covers hosts that read it.
- The kernel's `.wasm` and glue are cached on first use, in the `whittle-kernel-v1` cache. They are
  not precached (ADR-005 §2).

## Tests

- **Unit tests (Vitest)** sit next to the source. They cover the regen loop (`model/modeling.test.ts`),
  healing, attention, imports, the fake engine, the library, autosave, the mesh cache, sketch drawing and
  dimensions, picking, and the platform code (tiers and diagnostics, isolation headers, page guards,
  service worker registration). The bracket sample is checked against the published schemas
  (`src/samples/schema.test.ts`).
- **E2E (Playwright)** lives in `e2e/`:
  - `bracket.spec.ts`: the M1 acceptance flow. Build a bracket from scratch, make three upstream edits,
    and round-trip through STEP.
  - `welcome.spec.ts`: the demo bracket, an edit to `width`, and the mass readout updating.
  - `m1.spec.ts`: sketch, dimension, extrude, history, reload and export. Also the library, which lists,
    renames and opens documents, and the palette's primitives.
  - `sketch.spec.ts`: a drag is one undo step, conflicts offer a fix, and a failing extrude leaves a ghost.
    Also the dimension tool.
  - `attention.spec.ts`: an edit that removes a reference shows "needs attention", a ghost and a one-click
    re-pick. Also "Which one?" for ambiguous candidates.
  - `files.spec.ts`: older `.wrencad` files never overwrite newer entries, attachments travel with the
    document, a cached document renders before the kernel is ready, and autosave is safe across switches.
  - `touch.spec.ts`: phone emulation, one-finger orbit, and two-finger pinch and pan.
  - `update.spec.ts`: automatic updates before interaction, the banner after it, and "Check for updates".
  - `app.spec.ts`: the forced WebGL2 backend renders the box, for deterministic CI.
  - `tour.spec.ts`: a plate with a hole, a select-first fillet, and the library grid, with screenshots.
  - `platform.spec.ts`: cross-origin isolation through the service worker (first-visit reload, headers,
    a shared-memory worker, deep links), offline use from cache, the single-threaded fallback, and the
    PWA manifest.
  - `perf/shell.perf.ts`: see below.
- **Server.** The E2E web server is `scripts/static-serve.mjs`. It serves `dist/` at the `/wren-cad/` base
  and sends no isolation headers, as GitHub Pages does. So isolation can only come from the service
  worker, which is what the test should prove. `--fixtures e2e/fixtures` serves the fixture files
  next to the build.
- **Ports.** Set `WREN_E2E_PORT` (default 4173) to run on another port.
- **Perf.** `e2e/perf/shell.perf.ts` asserts that the shell is visible in under 1.5 s (PLAN §10).

See [`CONTRIBUTING.md`](../../CONTRIBUTING.md#running-the-tests) for the full test commands.

## Dev-only and test-only code

- The fake engine (`model/fake-modeling.ts`) is a main-thread stand-in over the low-level kernel. It
  is selected with `?engine=fake`, but only in development builds (`import.meta.env.DEV`). Production
  builds do not contain it (ADR-007 §2, §7).
- Test hooks on `window` are used by the E2E tests to wait on app signals, such as `idle`,
  `sketchSettled` and the first rendered body, instead of sleeping.

## Design notes

- **The real engine is the default.** The app boots the kernel client as soon as `main.tsx` runs,
  before React renders, so the kernel compiles while the shell paints (ADR-007 §4).
- **The viewport is lazy.** It is a separate chunk, so the initial route stays inside its budget
  (ADR-005 §3). Its first frame has only a fill light, and the studio environment is built on idle
  (ADR-005 §4).
- **Cached open.** The last document is read from the library before React renders. Its cached meshes
  appear before the kernel is ready (ADR-008 §4).
- **Updates.** A new service worker is applied at once if the user has not interacted with the page,
  and otherwise shows an "Update available" banner. The page checks for updates on focus and every
  30 minutes (`src/platform/sw-register.ts`).
- **Tiers.** `detectTier` picks desktop, tablet or phone from pointer type, screen size, cores and
  memory. The tier chooses the shell and the regen cache size (`src/platform/diagnostics.ts`).
- **Welcome, not a landing page** (ADR-007 §3). The app lives at `/wren-cad/`, so an installed app keeps
  working. The welcome card offers the demo bracket, a new part, install, and the source and licence.

## Related

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md): the whole system.
- [`docs/USER_GUIDE.md`](../../docs/USER_GUIDE.md): what the app does for users.
- ADR-005, ADR-007 and ADR-008 in [`docs/DECISIONS.md`](../../docs/DECISIONS.md).
