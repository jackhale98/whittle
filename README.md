<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/svg/wren-mark-dark.svg">
  <img src="brand/svg/wren-mark-light.svg" alt="Wren logo" width="96">
</picture>

# Wren CAD

[![CI](https://github.com/jackhale98/wren-cad/actions/workflows/ci.yml/badge.svg)](https://github.com/jackhale98/wren-cad/actions/workflows/ci.yml)

Free, open-source parametric CAD that runs in your browser. Install it, work offline, and let the
OpenCASCADE geometry kernel run on your own device.

**Live app:** <https://jackhale98.github.io/wren-cad/>

Wren is early. Part modeling (M1) is built and deployed. Touch and tablet work (M2) is in
progress, and the rest of the roadmap is listed under [Coming next](#coming-next).

## Principles

- **Local-first.** Projects are saved on your device as you work. Editing never waits on a server.
- **Offline.** After the first visit, the app and the geometry kernel are cached. Airplane mode works.
- **Private.** Nothing leaves your device. There are no accounts, analytics or telemetry, and the
  diagnostics panel is local-only.
- **Open format.** A project is a folder of plain JSON files, zipped as `.wrencad`. The spec is
  CC-BY-4.0 and the JSON Schemas are published.
- **Free.** Wren is GPL-3.0-or-later.

## What you can do today

**Sketch**

- Sketch on the origin planes or on a planar face, with line and polyline, rectangle (corner,
  centre, 3-point), circle (centre, 3-point), arc (3-point, tangent, centre-point), slot and polygon.
- Add constraints (coincident, horizontal, vertical, parallel, perpendicular, tangent, equal,
  midpoint, concentric, symmetric, fix, point on curve) and dimensions (distance, horizontal and
  vertical distance, length, radius, diameter, angle). Dimension values accept expressions and units.
- Degrees of freedom are coloured as you work. Conflicts are explained in plain language with
  suggested fixes.
- Inference snaps while you draw, and construction geometry is supported.

**Model**

- Extrude (blind, up to a face, or through all), revolve, fillet, chamfer (distance, or distance and
  angle), and boolean (add, cut or intersect).
- Box and cylinder primitives, offset reference planes, and imported bodies.
- Multi-body parts, with body operations new, add, cut and intersect.
- A feature tree with a rollback bar. Edit, rename, suppress, reorder and delete features.

**Parameters**

- Named parameters with expressions and units, such as `25mm + 1/8in` or `sin(30deg)`.
- Renaming a parameter updates every reference to it in one undo step.

**Materials and mass**

- 16 built-in materials, or a custom density. A part shows volume, surface area, mass and centre of
  mass.

**Persistent references**

- Edges and faces are named from the model's construction history and checked with fingerprints.
- When a reference can't be matched with confidence, the feature is marked "needs attention". Wren
  shows the old location as a ghost and asks you to re-pick. It never guesses.

**Import and export**

- Import STEP (`.step`, `.stp`), IGES (`.iges`, `.igs`) and BREP (`.brep`, `.brp`) as solids.
  Import STL, OBJ, 3MF and GLB as reference meshes.
- Export STEP (AP214), STL (binary or ASCII, one merged file or one per body, three quality
  presets), 3MF, GLB, and `.wrencad` projects.

**Library and files**

- A local library with autosave (about half a second after edits settle), thumbnails, search,
  rename and delete.
- Open and save `.wrencad` files. Imported files and other extra files survive round trips.

**Install and updates**

- Install it as an app from the browser. Updates are checked when you return to the page and every
  30 minutes. You can also check from the command palette (⌘K).

## Browser support

| Browser                  | Status                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome and Edge          | Primary. Chromium end-to-end tests gate every deploy.                                                                                                                                                   |
| Safari 26+ and iPadOS    | Targeted. WebKit end-to-end tests run in CI but don't gate yet, and two offline tests are skipped on WebKit. Testing on a physical iPad is part of M2.                                                  |
| Firefox                  | Runs. Firefox end-to-end tests run in CI under a virtual display but don't gate yet.                                                                                                                    |

Wren needs WebAssembly, Web Workers, IndexedDB and either WebGPU or WebGL2. The viewport uses
WebGPU when available and falls back to WebGL2.

The kernel's threaded build needs cross-origin isolation. GitHub Pages can't send the required
headers, so Wren's service worker adds them. On the first visit the page reloads once. Where
isolation isn't available (some private windows and in-app browsers), Wren uses the
single-threaded kernel. The results are the same, but it is slower.

## Coming next

| Milestone                          | Scope                                                                                                   | Status                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| M0 Foundations                     | Monorepo, kernel, PWA, viewport                                                                         | Done                                                                |
| M1 Parametric part modeling        | Sketcher, features, persistent naming, file format, import and export                                    | Done and deployed                                                   |
| M2 Touch and tablet                | Tablet shell, Pencil sketching, push and pull, phone measure and section, tutorial                      | In progress: workstreams merged on the development branch, not yet in the app |
| M2.5 Sync and version control      | Storage providers (local folder, Dropbox, OneDrive, WebDAV, GitHub and more), history, branches, merge   | Planned                                                             |
| M3 Advanced features               | Shell, draft, sweep, loft, mirror, patterns, hole wizard, IGES import                                   | Planned                                                             |
| M4 Drawings                        | Sheets, views with hidden lines, dimensions, PDF, SVG and DXF export                                    | Planned                                                             |
| M5 STEP AP242 with PMI             | Model dimensions and tolerances written to STEP                                                         | Planned                                                             |
| M6 Assemblies                      | Mates, degrees of freedom, exploded views, bill of materials                                            | Planned                                                             |
| M7 v1.0                            | Hardening, accessibility, documentation site, release automation                                        | Planned                                                             |

The full plan is in [`docs/PLAN.md`](docs/PLAN.md).

## The open file format

A Wren project is a folder of deterministic JSON files (`wren.project.json`, `params.json`,
`parts/*.part.json`, and so on). A `.wrencad` file is that folder zipped. The same document always
produces byte-identical files, so projects diff and merge well in git.

- Specification: [`docs/FILE_FORMAT.md`](docs/FILE_FORMAT.md), licensed CC-BY-4.0.
- JSON Schemas: <https://jackhale98.github.io/wren-cad/schema/> (for example
  `wren-document.schema.json`).

## Develop

Requirements: Node 22 or later, pnpm 10.28 (`corepack enable` gives you the pinned version), and
Docker for the kernel build.

```sh
pnpm i                 # install
pnpm kernel:build      # build the OCCT Wasm kernel with Docker (slow; cached in CI)
pnpm dev               # run the app locally
pnpm test              # unit tests for every package
pnpm e2e               # build the app and run the Chromium end-to-end tests
pnpm perf              # performance budgets (see docs/ARCHITECTURE.md)
pnpm build             # production build, with third-party notices
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the rules, tests, and the kernel build.

Repository layout:

```text
apps/web/            the app: shells wiring, workbench, service worker, library, samples, E2E tests
packages/
  contracts/         shared types: document, kernel, sketch, viewport, store, io (lead-owned)
  document/          expressions and units, document store with undo, .wrencad codec, materials
  kernel/            OCCT 8 Wasm kernel: C++ facade and build configuration
  kernel-client/     kernel worker, Comlink client, regeneration engine
  sketch/            sketch solver worker (planegcs), DOF analysis, conflicts, inference
  viewport/          three.js viewport: picking, camera, overlays
  io/                STL, OBJ, 3MF and GLB; local library; file pickers
  ui/                design tokens, primitives, shells, feature tree, inspectors
  test-fixtures/     synthetic meshes and sketches for tests
brand/               logo, icons and loader (brand kit)
docs/                PLAN, ARCHITECTURE, USER_GUIDE, DECISIONS, FILE_FORMAT, DEPENDENCIES
scripts/             build helpers (third-party notices)
.github/workflows/   ci.yml (gates and Pages deploy) and kernel.yml (cached kernel build)
```

## Documentation

- [User guide](docs/USER_GUIDE.md): how to use the app.
- [Architecture](docs/ARCHITECTURE.md): how the pieces fit together.
- [Decisions](docs/DECISIONS.md): the non-obvious choices, one per entry.
- [File format](docs/FILE_FORMAT.md): the open project format.
- [Dependencies](docs/DEPENDENCIES.md): every runtime dependency, with license.
- [Changelog](CHANGELOG.md) and [Plan](docs/PLAN.md).

## Licence

Wren is free software under the
[GNU General Public License, version 3 or later](LICENSE) (GPL-3.0-or-later; see ADR-003 in
[`docs/DECISIONS.md`](docs/DECISIONS.md)).

- The geometry kernel is OpenCASCADE, which is LGPL-2.1 with the Open CASCADE exception. It ships
  as a separate `.wasm` and `.js`, built reproducibly from [`packages/kernel`](packages/kernel).
  The licence texts are in [`licenses/`](licenses).
- The built site includes `THIRD_PARTY_NOTICES.txt`, which lists the licences of every bundled
  package. It is generated by [`scripts/third-party-notices.mjs`](scripts/third-party-notices.mjs)
  during `pnpm build`.
- The file format specification is CC-BY-4.0.
