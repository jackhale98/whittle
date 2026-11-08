# Architecture Decision Records

Short log of non-obvious choices. One entry per decision: date, decision, why, alternatives.
Newest last. Superseded entries stay, marked **Superseded by ADR-xxx**.

---

## ADR-001 — Technology stack (2026-11-08)

**Decision.** Adopt the stack in PLAN §3:

| Area            | Choice                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| Kernel          | OCCT 8.0.1 → WebAssembly (see ADR-002 for the toolchain), coarse C++ façade                                     |
| Sketch solver   | `@salusoft89/planegcs` (MulanPSL-2.0)                                                                           |
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
| License         | Apache-2.0 for Whittle code; kernel ships as a separate, reproducibly built `.wasm` (LGPL-2.1 + OCCT exception) |

**Why.** See the rationale column in PLAN §3. In short: OCCT is the only mature open B-rep kernel;
everything else is the boring, well-maintained option with the largest ecosystem, and keeps the
document model plain JSON (CRDT-ready) and the main thread free of Wasm.

**Alternatives considered.** CadQuery/build123d via Pyodide (too heavy, slow start), replicad as the
core (we need XCAF/PMI, HLR, history APIs and a coarse façade anyway), react-three-fiber (a CAD
viewport needs imperative control). License alternatives AGPL-3.0 / GPL-3.0 remain open until the
Mycelium relicensing question is settled — **must be decided in an ADR before M2.5**.

**Version pins (M0, verified against the npm registry on 2026-11-08).** TypeScript 6.0.3 (not 7.x:
the native-port 7.0 line is recent and tooling compatibility is unproven; revisit in M1),
Vite 8.3.x, React 19.3.x, three 0.187.0, Vitest 5.1.0, Playwright 1.65.0, Biome 2.6.6,
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
