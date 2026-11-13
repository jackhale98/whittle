# Wren — Design & Build Plan

> **Wren** is a free, open-source, browser-native parametric CAD app. It installs as a PWA, works offline, and runs the geometry kernel entirely on the user's device. Desktop gets the full feature set. Tablets get a Shapr3D-class touch and Pencil experience. Phones get excellent viewing and light editing.
>
> This document is the single source of truth for building Wren with Claude Code and subagents. Read it fully before writing code. When this plan and reality disagree (an API has changed, say), verify against official docs, update this plan in the same PR, and note the change in `docs/DECISIONS.md`.

---

## 0. How to use this plan (instructions for Claude Code)

1. Put this file in the repo as `docs/PLAN.md`. Create `CLAUDE.md` from **Appendix A** and the subagent files from **Appendix B** (`.claude/agents/*.md`).
2. Work milestone by milestone (§12). Inside a milestone:
   1. **The lead writes the contracts first.** These are the TypeScript interfaces and the C++ façade header for every package boundary the milestone touches (§6, §7). Commit them before fanning out.
   2. **Fan out** to subagents by package ownership (§11). Run independent agents in parallel in separate worktrees. Never give two agents the same files.
   3. **Integrate** on the main branch. Run the full test suite and the performance budget checks (§10).
   4. **Gate.** The `reviewer` subagent checks the milestone's acceptance criteria independently. It has not seen the work being produced. Fix what it finds before starting the next milestone.
3. Keep `docs/DECISIONS.md` as a short ADR log: one entry per non-obvious choice (date, decision, why, alternatives considered).
4. Prefer boring, well-maintained dependencies. Pin exact versions. Before adding a runtime dependency, check its license, bundle size and maintenance status, and record it in `docs/DEPENDENCIES.md`.

---

## 1. Product vision & principles

**Goal:** Wren should feel faster and friendlier than Onshape, while being free and open, and still produce manufacturable, standards-compliant output (STEP AP242 with dimensions and tolerances, and fully dimensioned drawings).

**Principles, in priority order:**

1. **Instant.** Every interaction gives feedback within one frame. Geometry never blocks the UI. Show a cheap preview while the user drags, and compute the exact result when they release.
2. **Obvious.** No modal dialogs for modeling. Tools appear in context next to the selection. Every value is editable inline and accepts expressions with units (`25mm + 1/8in`, `width/2`).
3. **Forgiving.** Unlimited undo and redo. Non-destructive history. Failures are explained in human terms ("Fillet radius is too large for this edge; max ≈ 2.4 mm") and never corrupt the model.
4. **Precise.** Real B-rep solids (OpenCascade), exact dimensions and units, and output that other CAD systems accept.
5. **Yours.** Local-first. No account is required. Files are open and documented (`.wrencad`). It works offline.
6. **Beautiful.** It has a calm, modern visual language and polished motion. The viewport looks like a product render, not a debug view.

**Non-goals for v1:** real-time multi-user collaboration (prepare for it, don't build it), CAM, FEA in v1.0 itself (simulation is a post-v1.0 track, §12B, with an early meshing spike), rendering beyond the high-quality viewport, sheet-metal, and surfacing beyond loft/sweep/fill.

---

## 2. Feature scope (target: best-in-class parity, phased)

Priority: **P0** = MVP (M1–M2), **P1** = v1.0 (M3–M6), **P2** = after v1.0.

### 2.1 Sketching

| Feature                                                                                                                      | Pri   |
| ---------------------------------------------------------------------------------------------------------------------------- | ----- |
| Line, polyline, rectangle (corner/center/3-point), circle (center/3-point), arc (3-point/tangent/center), slot, polygon      | P0    |
| Constraints: coincident, horizontal, vertical, parallel, perpendicular, tangent, equal, midpoint, concentric, symmetric, fix | P0    |
| Dimensions: distance, horizontal/vertical distance, radius, diameter, angle; driving and driven (reference)                  | P0    |
| Inferred constraints while drawing (auto-snap with subtle glyphs)                                                            | P0    |
| Under-, fully- and over-constrained colouring; conflict explanation with a one-click fix                                     | P0    |
| Construction geometry, trim/extend/split, offset, mirror, fillet/chamfer in sketch                                           | P0/P1 |
| Project/convert edges (linked to the model), sketch on any planar face or plane, intersection curves                        | P1 (M3, first) |
| Ellipse, spline (B-spline via control points), text (to profile), DXF/SVG import into sketch                                 | P1/P2 |
| Pencil handwriting recognition for primitives (line/arc/circle/rectangle)                                                    | P1    |

### 2.2 Part modeling

| Feature                                                                                                                                                  | Pri                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Extrude (blind, symmetric, up-to-face, through-all; add/cut/intersect/new body), revolve                                                                 | P0                        |
| Fillet (constant), chamfer (distance, distance-angle), booleans, multi-body                                                                              | P0                        |
| Feature tree: rollback bar, reorder, suppress, edit, rename, failure badges; a sketch used by exactly one feature nests under it (view only, ADR-015)        | P0                        |
| Variables/parameters table with expressions and units                                                                                                    | P0                        |
| Direct push/pull of faces, recorded as parametric features                                                                                               | P0 (tablet), P1 (desktop) |
| Shell, draft, sweep, loft, mirror, linear and circular pattern, hole wizard (simple/counterbore/countersink/tapped, ISO + ANSI tables), cosmetic threads | P1                        |
| Reference planes, axes and points; measure; mass properties; section view; interference check                                                            | P1                        |
| **Materials:** assign a material per part from a built-in library (steels, aluminium alloys, brass, titanium, common plastics such as ABS/PLA/PETG/nylon, wood) or a custom one; editable density with units (`2.70 g/cm^3`); appearance colour; mass, centre of mass and inertia in mass properties; material and density written to STEP (XCAF `XCAFDoc_MaterialTool`) and shown in BOMs | P0 (assign + density, M1) / P1 (mass properties, STEP, BOM; M3–M6) |
| Variable fillet, face fillet, split body, thicken, offset/replace face, move face, delete face (defeature)                                               | P2                        |
| Configurations: part configurations (parameter values, feature suppression, material) in M3.7; assembly configurations in M6. Derived parts stay P2.     | P1 (M3.7 / M6)            |

### 2.3 Assemblies (M6)

| Feature                                                                                                                          | Pri |
| -------------------------------------------------------------------------------------------------------------------------------- | --- |
| Insert parts (multi-part documents), instances, fasten/revolute/slider/cylindrical/planar/ball mates, degrees-of-freedom display | P1  |
| Exploded views, BOM, assembly STEP export                                                                                        | P1  |
| Mate limits, gears and racks, motion study                                                                                       | P2  |

### 2.4 Drawings (M4)

| Feature                                                                                                            | Pri |
| ------------------------------------------------------------------------------------------------------------------ | --- |
| Sheets (ISO A0–A4 and ANSI A–E), editable title-block templates, first/third-angle projection                      | P1  |
| Views: base, projected, isometric, section (full/half/offset), detail, broken-out (P2), auxiliary (P2)             | P1  |
| Exact hidden-line removal (HLR); visible, hidden, tangent and centre lines; centre marks                           | P1  |
| Dimensions: linear, aligned, ordinate, radial, diameter, angular, chamfer; tolerances (±, limits, ISO 286 fits)    | P1  |
| "Import model annotations": pull the model's PMI dimensions into views automatically                               | P1  |
| GD&T feature control frames, datum symbols, surface finish, weld symbols (P2), notes, leaders, balloons, BOM table | P1  |
| Associative: drawings update when the model changes; dangling references are flagged                               | P1  |
| Export PDF (vector), SVG, DXF; print                                                                               | P1  |

### 2.5 Data exchange

| Format                                                                           | Import                | Export                     | Pri                      |
| -------------------------------------------------------------------------------- | --------------------- | -------------------------- | ------------------------ |
| STEP AP242 with **semantic + presentation PMI** (dimensions, tolerances, datums) | ✓ (display PMI)       | ✓                          | P0 (geometry) / P1 (PMI) |
| STEP AP214/AP203                                                                 | ✓                     | ✓                          | P0                       |
| IGES, BREP                                                                       | ✓                     | ✓                          | P1                       |
| STL, 3MF, OBJ, glTF/GLB                                                          | ✓ (as mesh reference) | ✓                          | P0                       |
| DXF, SVG (2D)                                                                    | ✓ (into sketch)       | ✓ (from sketch or drawing) | P1                       |
| `.wrencad` (native, open, zip + JSON)                                            | ✓                     | ✓                          | P0                       |

### 2.6 Platform & UX

| Feature                                                                                                                                                                                  | Pri                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Installable PWA, offline, file handling ("Open with Wren" for .wren/.step on desktop)                                                                                              | P0                         |
| Adaptive shells: desktop / tablet / phone (§9)                                                                                                                                           | P0                         |
| Command palette (⌘K), full keyboard shortcuts, light/dark themes                                                                                                                         | P0                         |
| Local document library (IndexedDB/OPFS) with thumbnails and search; save to disk (File System Access API)                                                                                | P0                         |
| **Connections:** keep projects in Dropbox, OneDrive/SharePoint, Nextcloud/WebDAV, Google Drive, a local synced folder, or a git host (GitHub/GitLab/Forgejo), with background sync (§8A) | P0 (M2.5)                  |
| **Version control:** named versions, branches, feature and geometric compare, three-way merge, releases (Rev A/B…) (§8A.3)                                                               | P0 (M2.5)                  |
| Share as link (read-only viewer), comments                                                                                                                                               | P2 (needs Cloudflare, §13) |

---

## 3. Key technical decisions (with rationale)

| Area            | Decision                                                                                                                                                                                                                                                                                      | Why / notes                                                                                                                                                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geometry kernel | **OpenCASCADE Technology (OCCT) 8.0.x**, compiled to WebAssembly                                                                                                                                                                                                                              | It's the only mature open-source B-rep kernel. OCCT 8.0.0 GA shipped 2026-05-07 and 8.0.1 is current. It's LGPL-2.1 with exception.                                                                                                                                                                                                    |
| Kernel build    | **opencascade.js v3 custom-build toolchain** — now published as **`libcascade`** / **`@libcascade/toolchain`** (taucad fork, Docker) — with **our own C++ façade** compiled in via the toolchain's `customBindings` (formerly `additionalCppFiles`; see ADR-002)                              | v3 builds OCCT 8.0.1 with Emscripten 6.0.5, native Wasm exceptions, pinned `DEPS.json` and provenance. A coarse façade keeps the JS↔Wasm boundary small and the binary trimmed. Fallback: a direct CMake + Emscripten build of OCCT (keep a spike branch).                                                                             |
| Sketch solver   | **`@salusoft89/planegcs`** (FreeCAD's PlaneGCS in Wasm)                                                                                                                                                                                                                                       | It's battle-tested in FreeCAD and has a broad constraint set. Its `temporary` constraints suit mouse and finger dragging. License is LGPL-2.0-or-later (GPL-3.0-compatible; corrected 2026-11-08, see DEPENDENCIES.md). Known gap: B-splines aren't fully supported, and some constraints misbehave as _non-driving_, so compute driven dimensions ourselves (measure geometry after solving). |
| Rendering       | **three.js `WebGPURenderer`**, which falls back to WebGL2 automatically                                                                                                                                                                                                                       | WebGPU is now in all major browsers, including Safari 26 on iOS and iPadOS. Use the viewport imperatively, not through React.                                                                                                                                                                                                          |
| Picking         | GPU ID-buffer picking for faces, edges and vertices, plus **three-mesh-bvh** for ray queries and snapping                                                                                                                                                                                     | Precise, fast selection of thin edges on touch screens.                                                                                                                                                                                                                                                                                |
| App framework   | **React 19 + TypeScript (strict) + Vite**                                                                                                                                                                                                                                                     | Largest ecosystem; the agents know it best. React renders only the UI chrome. The viewport, kernel and solver live outside React.                                                                                                                                                                                                      |
| UI primitives   | **Radix UI primitives + Tailwind CSS v4 + design tokens**, **Lucide** icons, **Motion** for animation                                                                                                                                                                                         | Accessible, unstyled primitives with our own look. No heavy component kit.                                                                                                                                                                                                                                                             |
| State           | **Zustand** (UI state) + our own **document store** (immutable feature list, patch-based undo/redo)                                                                                                                                                                                           | The document model must stay serialisable and CRDT-ready (Yjs later).                                                                                                                                                                                                                                                                  |
| Worker RPC      | **Comlink**, with Transferable `ArrayBuffer`s for meshes                                                                                                                                                                                                                                      | Simple, typed, zero-copy.                                                                                                                                                                                                                                                                                                              |
| Camera          | **camera-controls** (yomotsu) plus our own gesture recogniser                                                                                                                                                                                                                                 | Smooth damping, touch-friendly, orbit-around-cursor.                                                                                                                                                                                                                                                                                   |
| Storage         | IndexedDB (`idb`) for metadata, OPFS for blobs, File System Access API for "Save to disk" (fallback: download)                                                                                                                                                                                | Local-first and fast.                                                                                                                                                                                                                                                                                                                  |
| File packaging  | Canonical form is a **folder of deterministic text files** (§8A.1); `.wrencad` is that folder zipped with `fflate` for sharing                                                                                                                                                                | Text-first source makes git-style diff and merge possible.                                                                                                                                                                                                                                                                             |
| Cloud sync      | One `StorageProvider` interface. Adapters ported from the **Mycelium** app (Dropbox, OneDrive/SharePoint, WebDAV/Nextcloud, GitHub/GitLab/Bitbucket), plus Google Drive and local folders (§8A.2)                                                                                             | The adapters already work in a static PWA.                                                                                                                                                                                                                                                                                             |
| Version control | `HistoryStore` with two backends: **isomorphic-git** (git hosts) and **snapshot DAG** (cloud drives/local). Feature-level three-way merge; kernel-computed geometric diff (§8A.3)                                                                                                             | No mature open-source "git for CAD" exists; our text format makes one feasible.                                                                                                                                                                                                                                                        |
| Drawings        | **SVG DOM** editor (crisp, printable), HLR from OCCT (`HLRBRep_PolyAlgo` for fast drafts, `HLRBRep_Algo` for exact final output) in a separate worker; PDF via **jsPDF + svg2pdf.js**; DXF via a DXF writer library (evaluate `@tarikjabiri/dxf`, otherwise write a minimal R12/R2000 writer) |                                                                                                                                                                                                                                                                                                                                        |
| PWA             | **vite-plugin-pwa** (Workbox) in `injectManifest` mode with a **custom service worker**                                                                                                                                                                                                       | The service worker also injects COOP/COEP headers (§8.3).                                                                                                                                                                                                                                                                              |
| Tests           | Vitest (unit, with Wasm in Node), Playwright (E2E plus screenshot diffs), C++ tests for the façade                                                                                                                                                                                            |                                                                                                                                                                                                                                                                                                                                        |
| Lint/format     | Biome                                                                                                                                                                                                                                                                                         | It's fast, and there's one tool.                                                                                                                                                                                                                                                                                                       |
| Package manager | pnpm workspaces                                                                                                                                                                                                                                                                               |                                                                                                                                                                                                                                                                                                                                        |
| License | **GPL-3.0-or-later** for Wren's code (ADR-003), matching Mycelium so its sync layer can be ported directly. The kernel ships as a separate `.wasm` (OCCT, LGPL-2.1 with exception — GPL-compatible) with public, reproducible build scripts, which satisfies OCCT's LGPL relinking expectation | Alternatives considered: Apache-2.0 (needed a Mycelium relicense) and AGPL-3.0 (also covers SaaS forks). |

**Explicitly rejected:**

- **CadQuery / build123d via Pyodide** as the core. Downloading the Python runtime is too heavy, startup is too slow, and it adds a double layer of bindings. These could come later as an optional "code CAD" panel through OCP.wasm.
- **replicad** as the core. It's excellent for code-CAD, but we need a custom build (XCAF/PMI, HLR, history APIs) and a coarse façade anyway. Borrow ideas from it freely.
- **react-three-fiber** for the main viewport. A CAD viewport needs imperative control over selection buffers, line rendering and frame scheduling.

---

## 4. System architecture

```
┌──────────────────────────────── Main thread ────────────────────────────────┐
│  React UI shells (desktop / tablet / phone)                                  │
│     │ commands                         ▲ state                               │
│  Command bus ──► Document store (features, sketches, params, history)       │
│     │                                   │                                    │
│  Viewport engine (three.js WebGPU) ◄── mesh/edge buffers (transferred)       │
│  Gesture & pen recogniser · Picking (ID buffer + BVH) · Overlays (HTML/SVG)  │
└───────┬──────────────────────────────┬──────────────────────┬───────────────┘
        │ Comlink                       │ Comlink              │ Comlink
┌───────▼────────┐            ┌─────────▼────────┐   ┌─────────▼──────────┐
│ Kernel worker  │            │ Sketch worker    │   │ Drawing worker     │
│ OCCT Wasm      │            │ planegcs Wasm    │   │ OCCT Wasm (HLR,    │
│ (pthreads when │            │ (solve, drag)    │   │ lazy-loaded)       │
│ isolated)      │            └──────────────────┘   └────────────────────┘
│ · regen engine │
│ · shape cache  │   I/O (STEP/IGES/BREP/STL/3MF) also runs in the kernel worker
│ · naming map   │
│ · meshing      │
└────────────────┘
```

**Rules:**

- The main thread never calls Wasm directly.
- The kernel worker owns all OCCT shapes. The main thread only holds IDs and render buffers.
- **Feature-level regeneration:** a feature's output is cached by a hash of its definition plus the hashes of its inputs. Editing feature _k_ recomputes only features _k…n_.
- **Two meshing levels:** coarse while dragging or orbiting (fast), fine on idle (quality). Meshes are cached in the `.wrencad` file so a document opens and renders _before_ the kernel has loaded.
- **Kernel boot is non-blocking:** the app shell becomes interactive first, and the kernel streams and compiles in the background (`WebAssembly.instantiateStreaming`). The service worker caches it after the first load.
- **Two kernel builds:** a threaded build (needs cross-origin isolation, §8.3) and a single-threaded fallback. Pick one at runtime with `crossOriginIsolated`.

---

## 5. Repository layout

```
wren/
├─ apps/
│  └─ web/                    # Vite app: shells, routes, PWA, service worker
├─ packages/
│  ├─ contracts/              # Shared TS types: document schema, kernel API, events (lead-owned)
│  ├─ document/               # Document store, features, params/expressions, undo/redo, serialisation
│  ├─ kernel/                 # C++ façade + build config (libcascade toolchain config), Wasm artefacts
│  ├─ kernel-client/          # Worker entry + Comlink API + regen engine + shape cache
│  ├─ sketch/                 # planegcs wrapper, sketch model, inference, DOF analysis
│  ├─ viewport/               # three.js engine, materials, picking, gestures, camera, overlays
│  ├─ drawing/                # Drawing model, view generation (HLR), dimensioning, PDF/SVG/DXF export
│  ├─ io/                     # Format adapters (TS side), .wrencad packaging, PMI mapping
│  ├─ sync/                   # StorageProvider adapters, sync engine, auth, HistoryStore, diff/merge
│  ├─ ui/                     # Design system: tokens, primitives, icons, motion presets
│  └─ test-fixtures/          # Golden models, STEP samples (incl. NIST PMI cases), expected outputs
├─ docs/ (PLAN.md, DECISIONS.md, DEPENDENCIES.md, FILE_FORMAT.md, ARCHITECTURE.md)
├─ .claude/agents/            # Subagent definitions (Appendix B)
├─ .github/workflows/         # ci.yml, kernel.yml (cached Wasm build); Pages deploy is the last ci.yml job
└─ CLAUDE.md
```

**Ownership:** each package has exactly one owning subagent (§11). The lead owns `contracts/` and integration.

---

## 6. Document model (contract sketch)

Put this in `packages/contracts`. It must stay plain-JSON serialisable, so it can map onto Yjs later.

```ts
export type Id = string; // ULID
export type Expr = string; // e.g. "width/2 + 3mm"

export interface WrenDoc {
  schemaVersion: number;
  units: { length: 'mm' | 'cm' | 'm' | 'in' | 'ft'; angle: 'deg' | 'rad' };
  params: Param[]; // global variables
  parts: Part[];
  assemblies: Assembly[]; // M6
  drawings: Drawing[]; // M4
  meta: { name: string; created: string; modified: string; app: string };
}

export interface Param {
  id: Id;
  name: string;
  expr: Expr;
  description?: string;
}

export interface Part {
  id: Id;
  name: string;
  features: Feature[];
  rollbackIndex: number;
  material?: Material;                   // { libraryId?, name, density: Expr, appearance?, properties? }
  color?: string;
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | FilletFeature
  | ChamferFeature
  | BooleanFeature
  | ShellFeature
  | PatternFeature
  | MirrorFeature
  | HoleFeature
  | PushPullFeature
  | PlaneFeature
  | /* … */ never;

interface FeatureBase {
  id: Id;
  type: string;
  name: string;
  suppressed: boolean;
  annotations?: PmiAnnotation[];
}

export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude';
  profile: EntityRef[]; // sketch regions
  direction: 'normal' | 'reverse' | 'symmetric';
  end:
    | { kind: 'blind'; depth: Expr }
    | { kind: 'upTo'; target: EntityRef }
    | { kind: 'throughAll' };
  op: 'new' | 'add' | 'cut' | 'intersect';
  draft?: Expr;
}

/** Persistent reference to topology. See §7.3. */
export interface EntityRef {
  name: string; // persistent name, e.g. "F3:side(S1:e7)"
  kind: 'face' | 'edge' | 'vertex' | 'region' | 'body';
  fingerprint?: {
    centroid: [number, number, number];
    normal?: [number, number, number];
    area?: number;
    length?: number;
  };
}

/** Model-based definition: becomes STEP AP242 semantic PMI and can be imported into drawings. */
export interface PmiAnnotation {
  id: Id;
  kind: 'linear' | 'diameter' | 'radius' | 'angle' | 'datum' | 'geomTolerance';
  refs: EntityRef[];
  value?: Expr; // usually bound to a feature/sketch dimension
  tolerance?: {
    kind: 'symmetric' | 'bilateral' | 'limits' | 'fit';
    upper?: Expr;
    lower?: Expr;
    fit?: string;
  };
  gdt?: { characteristic: string; zone: Expr; modifiers?: string[]; datums?: string[] };
  placement?: {
    plane: [number, number, number, number, number, number];
    textPos: [number, number, number];
  };
}
```

Undo/redo works on JSON patches (RFC 6902) of `WrenDoc`. Coalesce continuous drags into one entry.

On disk, a `WrenDoc` is split into the canonical project folder (§8A.1): one file per part, drawing and assembly. Serialisation must be deterministic, so the same document always produces byte-identical files. Diffs and merges depend on this.

---

## 7. Kernel façade (C++ → Wasm)

### 7.1 Design

- The boundary is **coarse**. One call executes one whole feature. Don't expose thousands of OCCT classes to JS.
- Inputs and outputs are JSON plus typed arrays. Shapes are referenced by integer handles that live in the worker's cache.
- Every call returns a `Result` holding either the output or a structured error `{ code, message, hint, entityRefs }`. Catch every OCCT exception; it must never crash the worker.

```cpp
// packages/kernel/src/whittle_kernel.h  (illustrative)
struct FeatureResult {        // serialised to JSON + buffers
  int shapeHandle;
  std::string namingMapJson;  // persistent name -> sub-shape index (faces/edges/vertices)
  std::string errorsJson;
};
FeatureResult execFeature(const std::string& featureJson, const std::string& inputsJson);
MeshBuffers   mesh(int shape, double linDefl, double angDefl);    // positions, normals, indices, faceRanges, edgePolylines, ids
std::string   measure(int shape, const std::string& queryJson);   // distance, angle, area, volume, mass props
std::string   exportStep(const std::string& docJson /* shapes+PMI */, const std::string& optsJson); // returns path in MEMFS
int           importFile(const std::string& path, const std::string& optsJson);
std::string   hlrProject(int shape, const std::string& viewJson);  // 2D polylines by class (visible/hidden/smooth/outline)
void          release(int shape);
```

### 7.2 Build

- Use the `@libcascade/toolchain` (opencascade.js v3) Docker images. Start from the image's bundled `full.yml` symbol set, trim it to the symbols the façade needs, and add the façade through `customBindings` (ADR-002).
- Produce: `whittle-kernel.{js,wasm}` (threaded) and `whittle-kernel-st.{js,wasm}` (single-threaded), plus `.d.ts` files. Size targets: under 15 MB brotli for each main kernel. The drawing/HLR kernel can be a separate trimmed build if that keeps the main one smaller.
- CI (`kernel.yml`) builds only when `packages/kernel/**` changes. Cache the artefacts keyed by a hash of the config, the façade sources and the pinned image digest. Publish them as a GitHub Actions artefact and to the Pages build. Never commit `.wasm` files to git.
- OCCT modules needed: the modeling kernel (TKBRep, TKPrim, TKBO, TKFillet, TKOffset, TKFeat), meshing (TKMesh), HLR (TKHLR), data exchange (TKDESTEP/TKXSBase, IGES, STL), and XDE/XCAF (TKXCAF, TKLCAF, TKCAF) for colours, names, assemblies and **GD&T**. Note that OCCT 8 reorganised its source tree (§14 risk), so check the toolkit names against the 8.0 docs.

### 7.3 Persistent naming (the "topological naming problem")

This must be solved deliberately from M1, or downstream features will break when users edit upstream.

1. **Generate names from construction history.** For every OCCT operation, use `BRepBuilderAPI_MakeShape::Generated/Modified/IsDeleted` and `BRepTools_History` (booleans, fillets) to give names to results:
   - Extrude: `F{id}:start`, `F{id}:end`, `F{id}:side({sketchEdgeName})`
   - Boolean/fillet: carry the name forward via _Modified_, and derive new faces via _Generated_, e.g. `F{id}:fillet({edgeName})`
   - Split results get a deterministic, ordered suffix `#k`, sorted by geometric key.
2. **Store a fingerprint** alongside each reference: centroid, normal, area or length.
3. **Resolve** references in this order: exact name → name plus fingerprint disambiguation → fingerprint-only match within tolerance → **unresolved**.
4. **Never silently guess.** An unresolved reference marks the feature yellow ("needs attention"). Then the user re-picks the entity, with the old location ghosted in the viewport.
5. Golden tests: a suite of "edit upstream, check downstream" scenarios, for example changing sketch dimensions so faces split or merge. They must pass before M1 is accepted.

---

## 8. Platform: PWA, hosting, performance plumbing

### 8.1 GitHub Pages (initial)

- Deploy with `actions/deploy-pages` from CI artefacts. Set Vite `base: '/wren-cad/'` for a project site, or `/` with a custom domain.
- Use hash-based routing, or the `404.html` SPA fallback, because Pages has no rewrites.
- The service worker caches the kernel `.wasm` after the first visit. Show the kernel download progress in a subtle status chip.

### 8.2 Cloudflare Pages (in progress; see §13)

- Set real `COOP`/`COEP` headers through a `_headers` file. The service worker's header shim becomes a no-op when `crossOriginIsolated` is already true.
- This unlocks share links, a read-only viewer, comments, and later collaboration, using Workers + R2 + Durable Objects.

### 8.3 Cross-origin isolation (needed for Wasm threads)

- Wasm threads need `SharedArrayBuffer`, which requires COOP/COEP headers. GitHub Pages can't send custom headers, so inject them from a service worker.
- **Important:** only one service worker can control a page. **Do not** ship `coi-serviceworker` alongside the PWA service worker. Instead, put the header injection into our Workbox `injectManifest` service worker. On navigation responses, add `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` (or `require-corp`). Reload once on the very first visit.
- Self-host **all** assets, including fonts and icons. COEP blocks cross-origin resources that aren't opted in.
- If isolation fails (some in-app browsers, private modes), fall back to the single-threaded kernel. Everything still works, just more slowly. Record the mode in an anonymous, local-only diagnostics panel.

### 8.4 Device tiers

At boot, read `navigator.hardwareConcurrency`, `deviceMemory` (where available), screen size, pointer type and the GPU adapter. Assign a tier:

- **Desktop:** full shell, fine meshing, threaded kernel.
- **Tablet:** touch shell, Pencil support, medium meshing, memory-aware cache (LRU on the worker shape cache).
- **Phone:** viewer-first shell. The kernel loads lazily, only when an edit is started.

---

## 8A. Connections, sync & version control

**Goal:** projects live where users already keep their files, and stay up to date across devices. Every project gets git-like history (versions, branches, compare, merge, releases), whether it's stored in a git host or a cloud drive.

**Reuse Mycelium.** The same author's app [Mycelium](https://my-celium.org) (source: `github.com/jackhale98/mycelium-web`) already does this from a static, offline-capable PWA:

- It connects GitHub, GitLab, Bitbucket, Dropbox, OneDrive/SharePoint and WebDAV servers such as Nextcloud.
- It keeps a local copy in the browser.
- It syncs cloud folders a few seconds after each edit.
- It shows conflicts side by side instead of overwriting them.

Port its provider adapters, auth flows and conflict handling into `packages/sync` rather than reinventing them. Note: Mycelium is GPL-3.0, so see the license row in §3.

### 8A.1 Project storage format (text-first, git-friendly)

A project's canonical form is a **folder of deterministic text files**. A `.wrencad` file is just this folder zipped, for sharing and emailing.

```
my-bracket/
├─ wren.project.json          # manifest: name, units, schemaVersion, index of parts/drawings, part number
├─ params.json                   # global parameters
├─ parts/bracket.part.json       # features + sketches, keyed by stable IDs
├─ drawings/bracket.drawing.json
├─ assemblies/…
├─ releases/rev-A/               # frozen exports for a release: bracket.step (AP242+PMI), bracket.pdf
├─ previews/bracket.stl          # optional small mesh so git hosts can render 3D previews/diffs
├─ .wren-history/             # snapshot history (only for non-git storage, §8A.3)
└─ .wren/                     # cache: meshes, BREP, thumbnails; never synced or committed, always regenerable
```

**Diff/merge-friendly rules:**

- Canonical JSON: sorted keys, 2-space indent, LF line endings, a trailing newline.
- Stable ULIDs for every feature, sketch entity and annotation.
- Values stored as expression strings.
- No derived geometry in source files.

A typical part's source is tens of KB, so full snapshots are cheap.

### 8A.2 Connections (storage providers)

The app always edits a local working copy (OPFS/IndexedDB) and syncs in the background. Every provider implements:

```ts
interface StorageProvider {
  kind:
    | 'folder'
    | 'dropbox'
    | 'onedrive'
    | 'gdrive'
    | 'webdav'
    | 'github'
    | 'gitlab'
    | 'bitbucket'
    | 'forgejo';
  list(path: string): Promise<Entry[]>;
  read(path: string): Promise<{ bytes: Uint8Array; rev: string }>;
  write(path: string, bytes: Uint8Array, opts?: { ifRev?: string }): Promise<{ rev: string }>; // optimistic concurrency
  remove(path: string, opts?: { ifRev?: string }): Promise<void>;
  changesSince(cursor?: string): Promise<{ changes: Change[]; cursor: string }>; // delta API or polling
}
```

| Provider                          | Auth                                                                                     | API / library                    | Works on GitHub Pages alone?                                                      | Notes                                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local synced folder               | None (File System Access API)                                                            | Native                           | ✓ (desktop Chromium)                                                              | Point at a Dropbox/OneDrive/iCloud/Nextcloud _desktop-synced_ folder. Zero setup, and it works with any provider                                                    |
| Dropbox                           | OAuth 2 + PKCE                                                                           | Dropbox HTTP API                 | ✓                                                                                 | File `rev` for conflict detection; `list_folder/continue` for deltas                                                                                                |
| OneDrive / SharePoint             | MSAL.js (auth code + PKCE)                                                               | Microsoft Graph                  | ✓                                                                                 | eTags; `delta` endpoint                                                                                                                                             |
| Google Drive                      | Google Identity Services                                                                 | Drive API v3, `drive.file` scope | ✓                                                                                 | P1                                                                                                                                                                  |
| Nextcloud / ownCloud / any WebDAV | Nextcloud Login Flow v2 or app password                                                  | `webdav` npm client              | ⚠ The server must allow CORS for Wren's origin                                 | Options: the Nextcloud `webapppassword` app (adds WebDAV CORS headers and temporary app passwords for web apps), or reverse-proxy headers. ETags + PROPFIND polling |
| GitHub                            | Fine-grained token first; OAuth/GitHub App with a per-repo picker once the Worker exists | isomorphic-git + REST            | ⚠ Git's HTTP endpoints and GitHub's OAuth token exchange don't allow browser CORS | Needs the small proxy + token-exchange Worker (§13)                                                                                                                 |
| GitLab, Forgejo/Gitea, Bitbucket  | OAuth + PKCE where supported, else tokens                                                | isomorphic-git                   | ⚠ Same proxy                                                                      | Self-hosted Forgejo is the fully open-source route                                                                                                                  |

During the M2.5 spike, check each provider's current OAuth and CORS behaviour against Mycelium's working implementation, and record the results in `DECISIONS.md`.

**Git CORS proxy:** the isomorphic-git project runs a free public proxy for cloning and pushing from browsers, which is fine for development. Production self-hosts `@isomorphic-git/cors-proxy` (MIT) as a Cloudflare Worker, restricted to Wren's origin and to git-shaped requests.

**Security:**

- Tokens never leave the device. They're encrypted at rest with a non-extractable WebCrypto key.
- Request minimal scopes.
- Proxy Workers are stateless and never log tokens or content.
- No project data ever touches Wren-run storage.

**Sync behaviour:**

- Every change saves locally at once.
- Cloud drives push a few seconds after edits settle (debounced), and pull through deltas or polling plus on window focus.
- Git connections commit, pull and push when the user chooses, with an optional auto-commit on "Save version".
- An offline queue replays when the device reconnects.
- **Conflicts are never silently overwritten.** They go to the merge UI (§8A.3).

### 8A.3 Version control model

**State of the art:** no mature open-source framework does git-style version control for _parametric_ CAD.

- Teams today use Git + LFS, SVN, or GUIs like Anchorpoint. These treat CAD files as opaque binaries: you can keep snapshots, but you can't merge meaningfully.
- Onshape's branching and merging is proprietary.

Wren can do better because its source format is text-based parametric data (§8A.1).

**`HistoryStore`** has one interface and two backends:

- **GitHistory** (git connections; optional for local projects): isomorphic-git. Versions are commits, branches are git branches, releases are tags. It's fully interoperable with GitHub/GitLab/Forgejo pull requests, reviews and CI.
- **SnapshotHistory** (cloud drives and local-only projects): named versions are stored as compressed full snapshots in `.wren-history/`, which syncs with the project. They form a commit DAG (id, parents, message, author, timestamp, content hash). You get the same features without needing git.

**Features:**

- **Versions:** "Save version…" with a message. Automatic local snapshots during editing are pruned over time.
- **Branches:** "Try an idea" creates a branch. Switching is instant because regeneration comes from the cache.
- **Compare:**
  1. A _feature diff_, e.g. "Fillet 3: radius 2 mm → 3 mm · Added Hole 2 · Sketch 1 width 40 → 45".
  2. A _geometric diff_ in the viewport: both versions overlaid, with added material in green and removed material in red. The kernel computes these as boolean differences A−B and B−A.
  3. Mass-property and bounding-box deltas.
  4. A _drawing diff_: sheets side by side with changed dimensions highlighted.
- **Merge:** a three-way merge on the JSON tree, keyed by stable ID.
  - Edits that don't overlap merge automatically.
  - Edits to the same feature or parameter become conflicts. These are shown side by side, with a 3D preview of each choice.
  - After a merge, the model regenerates, and any failed or unresolved references are flagged "needs attention" (§7.3).
- **Releases:** mark a version as Rev A, Rev B and so on. The release:
  - freezes exports (STEP AP242 with PMI, PDF drawings) into `releases/`;
  - stamps the revision into drawing title blocks;
  - becomes read-only.
- **Real-time co-editing (later, §13):** Automerge 3 or Yjs for live editing on one branch, with named versions still checkpointed into the HistoryStore. Never keep CRDT history and git history as two competing sources of truth for the same data.

---

## 9. UX & visual design

### 9.1 Layout

**Desktop:**

- **Top bar:** document name, undo/redo, the version menu, Export, Share (later).
- **Left panel:** feature tree with a draggable rollback bar, plus a params tab. It's resizable and collapsible.
- **Centre:** the viewport. The view cube sits top-right, with a units/grid chip and the kernel status chip.
- **Right panel:** a **context inspector**, a non-modal panel for the active feature or selection.
- **Floating command bar** (bottom centre), **grouped by category** so it stays the same width as features are added. Each category button opens a flyout with its tools, and shows the last-used tool for one-click repeat. Single-tool groups are direct buttons. Categories (shared with the tablet rail through one definition, `toolGroups`):
  - **Sketch**
  - **Solid:** extrude, revolve, sweep, loft, push/pull, boolean
  - **Modify:** fillet, chamfer, shell, draft, mirror, patterns
  - **Hole**
  - **Reference:** plane, axis, point
  - **Inspect:** measure, section, mass properties
  - **More…** opens the command palette.

  Keyboard shortcuts still launch tools directly.

**Tablet (owner, 2026-11-13, ADR-099): the desktop structure at touch size.** The bottom sheet covered the part while editing, so the tablet now uses the desktop layout with touch sizing (44 px targets) instead of its own:

- Top bar, left panel (feature tree, params), right context inspector and the floating command bar, as on desktop. Each side panel collapses with one tap, and the inspector appears only while something is being edited.
- Portrait (or any width where both docked panels would squeeze the view): a side panel slides over the view, one at a time, and closes with a tap outside, so the model never jumps.
- Kept from the touch work: gestures, Pencil, long-press menus, the radial menu, the context bubble near the selection and the inline numeric keypad.
- Layouts are now two (large screen, phone); the tablet differs from desktop by density and input, not by structure.

**Phone:**

- The viewer comes first.
- A bottom sheet holds parts, parameters, measure, section, explode and export, and (M3.6) the feature tree with a touch-draggable rollback bar and a long-press menu (suppress), as on the tablet.
- Editing is limited to parameters and simple features.

### 9.2 Interaction rules

- **Select first, act second** with context tools. Also support **act first, select second** from the command bar, with a clear prompt chip such as "Select a face or sketch region".
- **Live previews:** while dragging a push/pull arrow, show translucent geometry immediately. Use a cheap path (a transformed profile prism) and commit the exact OCCT result on release.
- **Inline values:** dragging shows a floating value label. Tap it to type an exact value. Expressions and mixed units are always allowed.
- **Hover/press preselection:** highlight what would be picked. On touch, use enlarged pick tolerance. When candidates are ambiguous, show a small "Which one?" chooser listing face, edge and vertex.
- **Errors:** the feature turns red in the tree, with a one-line human explanation and a suggested fix. The last good geometry stays visible as a ghost.
- **Empty states and onboarding:** a 60-second interactive "make a bracket" tutorial, and sample models in the library.

### 9.3 Touch & Pencil gesture map

| Input                          | Action                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 1 finger drag (empty space)    | Orbit                                                                                                                 |
| 2 finger drag / pinch / twist  | Pan / zoom / roll                                                                                                     |
| Double-tap                     | Fit to view (on geometry: zoom to it)                                                                                 |
| Tap                            | Select; tap empty space to deselect                                                                                   |
| Long-press                     | Context menu                                                                                                          |
| 2-finger tap / 3-finger tap    | Undo / Redo                                                                                                           |
| Pencil                         | Always draws or selects. Fingers never draw while a Pencil is in use (palm rejection through `pointerType === 'pen'`) |
| Pencil hover (where supported) | Preselection highlight                                                                                                |

### 9.4 Keyboard (desktop)

`S` Sketch · `E` Extrude · `R` Revolve · `F` Fillet · `C` Chamfer · `M` Measure · `D` Dimension (in sketch) · `L` Line · `A` Arc · `Shift+C` Circle · `Space` Repeat last · `⌘K` Palette · `⌘Z/⇧⌘Z` Undo/Redo · `1–7` Standard views · `0` Iso · `H` Hide · `Esc` Cancel/exit.

### 9.5 Visual language

- **Tokens:** neutral greys (cool, slightly blue), one confident accent colour for selection and actions (e.g. vivid azure), semantic colours for under-constrained (blue), fully constrained (near-black or white), over-constrained or error (red), and warnings (amber).
- **Type:** Inter Variable, self-hosted, with tabular numbers for all values.
- **Radius & depth:** 10–14 px radii, soft shadows, translucent floating panels (backdrop blur on capable devices).
- **Motion:** spring presets (fast 180 ms, standard 260 ms). Animate camera transitions. Honour `prefers-reduced-motion`.
- **Viewport look:**
  - Studio environment lighting (a small prefiltered HDR) and a subtle ground shadow.
  - Crisp anti-aliased feature edges drawn as screen-space fat lines; silhouettes in a darker tone.
  - A fading infinite grid.
  - Optional SSAO on the desktop tier.
  - Selection shown as an accent overlay plus edge glow.
- **Accessibility:** WCAG 2.2 AA contrast for UI chrome, full keyboard navigation of panels, screen-reader labels for tools and the feature tree.

---

## 10. Performance budgets & quality bar (enforced in CI)

| Metric                                                      | Budget               |
| ----------------------------------------------------------- | -------------------- |
| App shell JS (gzip), initial route (backstop; ADR-097)      | ≤ 500 KB             |
| Time to interactive shell (cold, fast 4G, mid-range laptop) | ≤ 1.5 s (the gate)   |
| Kernel ready (cold, first visit) / (warm, cached)           | ≤ 6 s / ≤ 1 s        |
| Open a cached document (render before the kernel is ready)  | ≤ 500 ms             |
| Viewport frame time, 1M triangles, desktop / iPad           | ≤ 8 ms / ≤ 16 ms     |
| Sketch solve during drag (≤ 200 entities)                   | ≤ 4 ms per solve     |
| Regen after editing the last feature of a 50-feature part   | ≤ 300 ms             |
| Push/pull preview feedback                                  | same frame (≤ 16 ms) |
| Memory, iPad tier, typical part                             | ≤ 1 GB peak          |

- Lighthouse PWA and performance checks run in CI. Bundle size is checked with `size-limit`. Frame-time benchmarks run in Playwright against fixture models.
- **Test pyramid:**
  - Unit tests (document, expressions, naming).
  - Kernel golden tests in Node (volumes, areas, face counts, and STEP round-trips).
  - Visual screenshot diffs (WebGL fallback forced in CI for determinism).
  - E2E flows: sketch → extrude → fillet → drawing → STEP export.

---

## 11. Agent organisation & delegation

### 11.1 Roles

| Agent                   | Owns                                                                                                            | Model  | Why this split                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| **lead** (main session) | `contracts/`, integration, `docs/`, milestone planning                                                          | opus   | Defines interfaces, sequences work, resolves conflicts              |
| `kernel-engineer`       | `packages/kernel` (C++ façade, Wasm build, CI build)                                                            | opus   | Deep OCCT/Emscripten expertise; the most failure-prone area         |
| `modeling-engineer`     | `packages/kernel-client` (regen engine, shape cache, persistent naming, feature implementations on the TS side) | opus   | The hardest algorithmic correctness area (§7.3)                     |
| `sketch-engineer`       | `packages/sketch`                                                                                               | opus   | Solver integration, inference, DOF analysis                         |
| `viewport-engineer`     | `packages/viewport`                                                                                             | sonnet | Rendering, picking, gestures, camera                                |
| `ui-engineer`           | `packages/ui`, `apps/web` shells                                                                                | sonnet | Design system and the three adaptive shells                         |
| `document-engineer`     | `packages/document`                                                                                             | sonnet | Store, expressions/units, undo/redo, serialisation                  |
| `drawing-engineer`      | `packages/drawing`                                                                                              | opus   | HLR, view layout, dimensioning, PDF/DXF                             |
| `io-engineer`           | `packages/io` + PMI mapping                                                                                     | opus   | STEP AP242 PMI is subtle and standards-heavy                        |
| `sync-engineer`         | `packages/sync` (providers, auth, sync engine, HistoryStore, diff/merge)                                        | opus   | Data-loss risk; ports Mycelium's adapters                           |
| `platform-engineer`     | PWA/service worker, COI, CI/CD, Pages deploy, perf tooling                                                      | sonnet | Infrastructure                                                      |
| `test-engineer`         | `packages/test-fixtures`, E2E, perf benchmarks                                                                  | sonnet | Writes and maintains tests and fixtures                             |
| `reviewer`              | read-only                                                                                                       | opus   | An independent milestone gate; has not seen the work being produced |
| `docs-writer`           | `docs/` user guide, `FILE_FORMAT.md`                                                                            | haiku  | Cheap, high-volume writing                                          |

### 11.2 Delegation rules

1. **Contracts before code.** Subagents implement against `packages/contracts`. If a contract must change, the subagent proposes the diff to the lead; it does not edit `contracts/` itself.
2. **One package per agent per task.** Parallel agents run in isolated worktrees. The lead merges their work.
3. **Small, verifiable tasks.** Each delegated task states its inputs, outputs, acceptance tests and the files in scope. Example: "Implement `execFeature` for `fillet` with naming via `BRepTools_History`. Tests: `fillet.golden.test.ts` cases 1–12 must pass. Files: `packages/kernel/src/features/fillet.cpp`, `…/fillet.test.ts`."
4. **Every task ships with tests.** No task is complete without passing tests and an updated `CHANGELOG` line.
5. **Spikes are time-boxed.** For risky unknowns (§14), the lead commissions a spike with a written finding in `docs/DECISIONS.md` before production work starts.
6. **Escalate, don't guess.** If an agent finds that this plan is wrong or that an API differs, it stops and reports with evidence (a doc link and a minimal repro).

### 11.3 Parallelism map per milestone

- **M0:** kernel-engineer (build pipeline) ∥ platform-engineer (repo, CI, Pages, PWA, COI) ∥ ui-engineer (tokens + empty shell) ∥ viewport-engineer (render a mesh fixture). Then the lead integrates "box on screen".
- **M1:** kernel-engineer ∥ sketch-engineer ∥ document-engineer ∥ viewport-engineer, then modeling-engineer (after the contracts settle), then io-engineer (basic STEP/STL).
- **M2:** ui-engineer (tablet shell) ∥ viewport-engineer (gestures, Pencil, preview path) ∥ modeling-engineer (push/pull feature). sync-engineer can start the M2.5 provider spike in parallel, because it only depends on the M1 document format.
- **M2.5:** sync-engineer (providers, sync, HistoryStore, merge) ∥ kernel-engineer (geometric diff booleans) ∥ ui-engineer (connections, versions and compare/merge UI) ∥ platform-engineer (proxy + token-exchange Worker).
- **M3:** sketch-engineer (offset, convert entities, trim/extend, sketch fillet/chamfer, mirror) first ∥ kernel-engineer (shell, draft, sweep, loft, pattern/mirror tool shapes, hole, propagate toggle, kernel `import`, IGES) ∥ modeling-engineer (regen for the new types, reference axes/points/planes, linked-entity projection, hole tables) ∥ ui-engineer (inspectors, tools, Reference group, hole wizard). Then integration and the reference parts (§12A).
- **M3.5:** viewport-engineer (pivot-at-cursor orbit, presets, button mapping, `pickRect`, pivot marker) ∥ ui-engineer (radial menu, Which-one chooser, keymap editor and overlay, navigation settings) ∥ sketch-engineer (splines, ellipses, elliptic arcs, tangent/G2, Pencil ovals and splines, conflict sets) ∥ kernel-engineer (exact spline and elliptic edges, golden tests) ∥ modeling-engineer (`AttentionCause`, regen of the new curves). Then integration in apps/web and the E2E acceptance.
- **M4–M6:** as in §12.

---

## 12. Milestones & acceptance criteria

Each milestone ends with a reviewer gate. "Done" means every criterion is demonstrably met, with test evidence.

### M0 — Foundations

- Monorepo, Biome, Vitest and Playwright in place. CI runs on PRs and deploys to GitHub Pages from `main`.
- The kernel builds both the threaded and single-threaded variants. The façade's `execFeature` makes a box. `mesh()` returns buffers.
- PWA installs and works offline. The service worker injects COOP/COEP. `crossOriginIsolated === true` on Pages in Chrome, Firefox and Safari, with a fallback path tested.
- The viewport renders the box with WebGPU, falls back to WebGL2, and orbits on mouse and touch.
- **Accept:** a deployed URL shows a shaded box with edges in under 2 s (warm), works in airplane mode after the first visit, and has a green CI badge.

### M1 — Parametric part modeling (desktop)

- Sketcher: P0 entities, constraints and dimensions; inference; DOF colouring; conflict explanations.
- Features: extrude, revolve, cut, fillet, chamfer, boolean, multi-body; feature tree with rollback, edit, suppress and reorder; params with expressions and units.
- Persistent naming per §7.3, with the golden "edit upstream" suite passing.
- Open file format: `docs/FILE_FORMAT.md` specification plus a published **JSON Schema** (generated from `packages/contracts`, versioned with `schemaVersion`) that validates every project file in CI; the spec is licensed CC-BY-4.0 so anyone can implement readers and writers.
- Materials: assign from the built-in library or custom, density as an expression with units (e.g. `g/cm^3`), shown in the inspector with the part's mass.
- Undo/redo; local library; `.wrencad` save and open; STL (binary/ASCII, per body or merged, quality presets), 3MF, GLB and STEP AP214 export; STEP import.
- E2E: the exported STL of the bracket is watertight (every edge shared by exactly two triangles) and its volume matches the B-rep volume within the chosen deflection.
- **Accept:** a scripted E2E builds a bracket with holes and fillets. Changing three upstream dimensions regenerates it correctly. Exporting STEP and re-importing it gives the same volume within 1e-6 relative. Performance budgets (§10) are met.

### M2 — Touch & tablet excellence

- Tablet shell, gesture map, Pencil drawing with primitive recognition, context bubbles, inline keypad.
- Push/pull direct editing that records `PushPullFeature`, with a same-frame preview.
- Phone viewer shell: measure, section, parameter edit, export.
- **Accept:** on an iPad (Safari 26+, installed PWA), a new user completes the "bracket" tutorial in under 5 minutes without a keyboard. Orbit stays at 60 fps. No browser chrome or page zoom interferes.

### M2.5 — Connections, sync & version control

- Provider adapters (§8A.2): local folder, Dropbox, OneDrive/SharePoint, WebDAV/Nextcloud and GitHub (token) first; then Google Drive, GitLab, Forgejo and Bitbucket. GitHub OAuth arrives once the Worker exists.
- Background sync with deltas, an offline queue and conflict detection.
- HistoryStore (git + snapshots), the versions panel, branches, compare (feature, geometric and drawing diffs), the merge UI, and releases.
- Project folder format per §8A.1, with `.wrencad` zip import/export.
- **Local git repo mode** (ADR-029, desktop Chromium): open a folder that is a git working tree; the project's files on disk are the working copy, and versions, branches and releases are the repo's own commits, branches and tags, interoperable with the user's git tools.
- **Accept:**
  - A project edited on desktop (stored in Dropbox) shows the change on an iPad within 10 s of focusing the app.
  - Concurrent offline edits to _different_ features merge automatically. Edits to the _same_ parameter produce a conflict that the user resolves in the UI, with no data loss.
  - The geometric diff marks the correct added and removed regions on 5 fixture pairs.
  - A GitHub project round-trips commit → push → clone on another device → regenerate, with identical results (volume equal within 1e-9 relative).
  - A fuzz test of 1,000 random concurrent edit pairs never loses an edit.
  - Tokens are not readable in plain text from storage.
  - Local git repo mode: a version saved in Wren is a commit that `git log` shows with a clean `git status`; a commit made with the git CLI appears in Wren after refocusing; switching branches with uncommitted project changes is refused, never overwritten.

### M3 — Advanced part features

- Fillet/chamfer option "propagate along tangent edges" (OCCT propagates by default; make it an explicit toggle, default on). A kernel `import` feature (transform + naming in C++, replacing the TS workarounds from M1). IGES import.
- **Sketch editing (first M3 workstream, user priority):**
  - **Offset entities:** a curve, chain or loop at a distance, on one side or both. Parametric: lines stay parallel, arcs concentric, corners joined. One driving distance (an expression) controls the offset, and the offset follows its source.
  - **Convert entities (project edges):** model edges, or a face's outline, projected into the sketch as linked, fixed curves. They update when the model changes upstream. A lost source edge makes the sketch "needs attention" (ghost + Re-pick), never a silent re-pick of another edge. A linked curve can be unlinked.
  - Trim/extend, sketch fillet/chamfer, sketch mirror.
- Shell, draft, sweep, loft, mirror, patterns, hole wizard with standards tables, cosmetic threads, reference geometry (planes, axes, points), measure, mass properties, section view, sketch on face, versions/snapshots.
- **Accept:** reproduce 10 reference parts (in `test-fixtures/reference-parts/`, with specs) within dimensional tolerance, entirely from the UI, in E2E scripts.
  - The reference parts start the **certification-style suite** (§12A). Each has an original spec drawing, a material, and an expected mass checked in an independent CAD tool (FreeCAD).
  - The E2E builds each part from the spec and checks the mass within 0.1 %. CSWP-style stages then change named dimensions and re-check the mass.

### M3.5 — Navigation, input and sketch curves

Owner-approved 2026-11-09 from the research report `docs/ux-research/reports/CAD UI feedback and lessons.md` (ADR-046). The goal: the tool and the orbit pivot come to the cursor, errors point at their cause, and sketches get free-form curves.

- **Orbit and navigation** (contracts: `NavigationOptions`, `setNavigation`, `pickRect`, the `contextMenu` / `setPivot` gestures):
  - Orbit turns about the surface point under the cursor when the drag starts, falling back to the centre of the visible bodies; never a stale or off-screen point. A pivot marker shows while orbiting. Touch orbit uses the first finger's point.
  - Left drag is never navigation: it picks and box-selects (left → right = window, right → left = crossing). Default preset `rightOrbit`: right drag orbits, middle drag pans, wheel zooms to the cursor, a right click opens the radial menu. Presets named by behaviour: `middleOrbit` (middle-click on geometry sets the pivot), `middlePan`, `rightOrbitRepeat` (quick right click repeats the last command). Turntable (default, +Z up) or trackball; invert zoom; orbit speed. No smoothing while dragging (1 : 1 with the pointer); easing only for programmatic moves.
- **Radial menu:** a right click (mouse), long-press (touch) or held key opens a radial menu of ≤ 8 items chosen by what is selected, at the cursor. It accepts a flick before it draws (direction + distance threshold); the same layout on every surface; a fixed "repeat last" slot (Space repeats too). It never opens under the next click: it appears only on release and ignores clicks that started before it drew.
- **Which one?** Overlapping candidates are listed in a stable order (kind, then depth, then id), highlight on hover, and Tab / Shift+Tab cycles the preselection under a still pointer.
- **Keyboard:** shortcuts bind `KeyboardEvent.code` (layout-independent), a keymap editor flags conflicts with the browser's own shortcuts, and holding Ctrl/Cmd/Alt for 600 ms shows an overlay of the shortcuts available now.
- **Errors at their cause:** `needsAttention`, `error` and `blocked` features name the upstream feature whose change broke them (`AttentionCause`), and selecting the message selects that feature. Sketch conflicts highlight the conflicting set on the canvas and in the list and propose removing the most recently added constraint; no bare constraint numbers anywhere.
- **Owner additions (2026-11-09):**
  - **Sketch dimensions like other CAD sketchers:** a dimension's label is draggable after placement (mouse, touch, Pencil; a drag moves only the label), and it is drawn with extension lines and a dimension line with arrows (a leader for radius/diameter, an arc for angles) that show what it measures.
  - **Feature lineage:** selecting a face, edge or vertex shows "Made by <feature>" (the latest feature that created or modified it, and its sketch) with Edit buttons; selecting a feature in the tree shows its parents (what it references) and children (what references it).
  - **Bug:** a sketch on a part face was invisible after leaving the sketch on desktop Edge (only the centre point showed). Coplanar overlays must stay visible on WebGPU as well as WebGL2.
  - **Bug fixed now:** the tutorial card covered an open tool flyout; flyouts truncated command names ("Extruded …").
  - **Tablet (owner, 2026-11-10):** a visible way to drop the active sketch tool (a Select tool, plus a ✕ on the active tool for touch and pen); a visible "Clear selection" control and tap-on-empty clears the selection; a sketch consumed by a cut-revolve (and every consuming feature) hides once the feature is no longer being edited.
  - **Pencil grab (owner, 2026-11-10):** with no tool selected, press-and-hold (~0.3 s) on a sketch node or curve grabs it: corners and end points move, a circle's centre moves the circle, its edge sets the diameter. Pressing and moving at once draws a freehand stroke that starts snapped to the node. Pencil hover highlights what a hold would grab.
- **Sketch curves:** B-splines by control points and through points (degree 3 default, open or closed), ellipses and elliptic arcs; tangent constraints between any curves (G1 at shared ends), a curvature-continuous (G2) constraint where the solver can express it (otherwise an `unsupported` conflict, never dropped); the Pencil recognises ovals as ellipses and smooth strokes as splines; offset, trim/extend, mirror and convert work on the new curves where OCCT can (otherwise a clear refusal). The kernel builds exact B-spline and elliptic edges for profiles. Conics beyond ellipses are deferred.
- **Accept:**
  - E2E: orbiting from a point on a face keeps that point under the cursor within 2 px; panning then orbiting never pivots in empty space; the pivot marker is visible during the drag. Each preset's mapping is exercised (left box-select window and crossing, right/middle orbit and pan, right click opens the radial menu).
  - E2E: a flick on the radial menu runs its command (inside the flick window; since ADR-076 the menu draws at once); Space repeats; the menu is reachable with touch (long-press) and Pencil.
  - E2E: Tab cycles overlapping candidates; the chooser order is identical across runs.
  - E2E: with a non-QWERTY layout emulated, shortcuts still fire by physical key; the keymap editor flags Ctrl+W / Ctrl+T as browser shortcuts.
  - E2E: shortening an extrude so a fillet loses its edge shows "needs attention" naming the extrude; selecting the message selects the extrude. An over-constrained sketch highlights the set and proposes the last-added constraint.
  - Golden tests: a profile bounded by a spline and an elliptic arc extrudes to the volume of a numerically integrated reference (≤ 1e-6 relative); splines survive save → load → regen byte-identically; Pencil recognition tests for ellipses and splines.
  - E2E: a spline through 5 points, closed with a line, extrudes; moving a through point updates the solid.
  - E2E: a dimension's label drags without changing its value and shows extension and dimension lines; selecting a face shows the feature that made it and Edit opens it; the tree shows a feature's parents and children.
  - Render test on the WebGPU backend (or the closest available) shows a circle sketched on a face after finishing the sketch.
  - All existing suites, the 10 reference parts and `pnpm perf` stay green; orbit start (pick under cursor) ≤ 2 ms on the 1M-triangle probe.

### M3.6 — Review on the phone, sketch visibility

Owner request 2026-11-10. Small; follows the M3.5 gate.

- **Phone feature tree:** the phone sheet gains the same feature tree as the tablet. The rollback bar is draggable by touch (a 44 px target; a real, undoable rollback edit) and a long press on a row opens its menu (suppress / unsuppress, the sketch eye, roll to here). The phone tree is review-only (owner: "just the tree and the drag line"): no delete, edit, rename, reordering or folder actions beyond collapse. Owner decision 2026-11-10: no previous / next stepper and no preview mode (ADR-068 amendment).
- **Show or hide any sketch, including one inside a feature:** a sketch consumed by a feature is hidden by default (as now), and its eye toggle in the tree (nested or flat) overrides that per sketch, persisted in the document; "Show all sketches" / "Hide all sketches" commands. Works on every shell.
- **Feature tree folders** (owner, 2026-11-10): select features → "Add to new folder" (tree context menu or radial menu); rename inline, collapse/expand. A folder holds a **contiguous run** of features (history order matters): dragging a folder moves the run (validated like any reorder), dragging a feature out removes it, a reorder that would split a folder asks first. Folder actions: suppress/unsuppress all, show/hide the sketches inside, roll back to before it. Folders are document data with ids (versioned, merged keyed by id: a rename on one branch and a move on another merge cleanly). Desktop drag-and-drop, tablet long-press-and-drag; the phone tree shows folders (collapse only) and rolls back through them with the rollback bar.
- **Accept:** E2E on a phone drags the rollback bar through the demo bracket's features and the viewport shows each intermediate state, and the phone menu offers no Delete or Edit; E2E creates a folder from three features, renames, collapses, drags it to a new valid position, suppresses it (all three suppressed), and the folder survives save → reload and a merge of a rename against a move; E2E shows a consumed sketch via its eye toggle, the setting survives save → reload, and hiding it again restores the default.

### H1 — Codebase health (between M3.6 and M3.7)

Owner-approved 2026-11-10. A deliberate, behaviour-preserving pass so the code stays modular before M3.7, M4 and M6 add more; guarded by the existing suites (no test expectations change except where a test reached into an internal that moved).

- **Split the three largest files by responsibility**, keeping their public APIs:
  - `packages/kernel-client/src/regen/engine.ts` (~4.7k lines): per-feature-family executors (sketch, solids, copies/patterns, holes/threads, references, imports), reference resolution, caching, cause attribution and the sketch/linked pipeline in their own modules; the engine keeps orchestration only.
  - `packages/viewport/src/viewport.ts` (~3.6k lines): scene/bodies, picking (point and rect), navigation, sketch overlays, highlights/markers/handles/previews, section and compare in their own modules behind the same `ViewportEngine`.
  - `apps/web/src/app/workbench.ts` (~3.3k lines): selection, keyboard/command dispatch, tool and prompt state, regen scheduling, file/library actions and test hooks in their own modules.
- **Guardrails in CI:** a Biome/lint rule (or a small script) warning when a source file passes ~1,500 lines and failing CI past ~2,500 (existing exceptions listed and shrinking); a per-chunk bundle report so every new editor (drawings, configurations, simulation) must lazy-load and the shell keeps its 1.5 s cold start (the 500 kB gzip initial-route cap is a backstop; ADR-097).
- **Long-session soak test:** an E2E that opens the demo bracket, makes 100 edits (parameters, feature edits, undo/redo, sketch edits), closes and reopens it 10 times, and asserts that kernel shape handles return to baseline, JS heap and worker memory stay within a bound, and frame time does not drift. Runs nightly or on demand, not on every push.
- **Kernel memory guard:** report live shape-handle counts and the worker's Wasm heap in diagnostics; the LRU shape cache's limits are checked by a test at a large model size.
- **Test-time hygiene:** identify the slowest 10 E2E specs and cut redundant setup (shared booted documents, fixtures) without losing coverage; keep CI shards under 15 minutes.
- **Perf budgets enforced in CI:** the viewport perf probes (orbit-start pick ≤ 2 ms, full-screen box select ≤ 16 ms, 1M-triangle orbit, compare toggle) run in CI with `WREN_PERF_ASSERT=1` and a CI factor, and are no longer `continue-on-error`. Fix or delete the "Execution context was destroyed" failure noted in ci.yml. Today these numbers are only measured by hand (M3.5 gate B2).
- **Accept:** all suites green with unchanged expectations; no source file over 2,500 lines and the three splits each under ~1,500; the soak test passes with handles back to baseline; bundle report in CI; CI wall-clock not worse.

### Section view fixes (owner, 2026-11-10; right after H1)

- **Easy exit.** While a section is active, a persistent floating chip in the viewport (every shell) shows "Section" with **Exit section**, **Flip** and **Edit**. Closing the section panel no longer leaves an invisible cut active without the chip. Esc also exits when nothing else is active.
- **Rotate the cut plane.** An in-viewport manipulator on the plane has an offset arrow and two rotation arcs about the plane's in-plane axes, with touch-sized targets. The panel takes inline tilt angles (expressions with units) and a numeric offset. A face-based plane can be tilted too. Snapping goes to 15° steps with a modifier or held finger, and to the X/Y/Z axes.
- **Accept:** E2E enters a section, rotates the plane by dragging an arc and by typing an angle (caps stay filled), and exits it from the chip on desktop, tablet and phone. A unit test covers the plane maths.

### M3.7 — Part configurations

Owner request 2026-11-10 (moved up from P2): before drawings and assemblies, so both can be built configuration-aware.

- **Model:** a part has named configurations; each sets parameter values (expressions with units), feature suppression, material and optional custom properties (part number, description), over a default. The active configuration is a document setting; every regen is of one configuration. Stored in the document format with a migration; structural merge (M2.5) merges configurations keyed by id, a conflict per (configuration, parameter).
- **UI:** a configuration switcher in the top bar / tree; a configuration table (parameters × configurations) edited inline with expressions, no modal dialogs; "suppress in this configuration only" vs "all configurations" when suppressing a feature; the Params tab shows which values the active configuration overrides.
- **Use:** export STEP/STL per configuration (or all, one file each); mass properties per configuration; versions/compare work across configurations; drawings (M4) pick a configuration per view; assemblies (M6) pick a configuration per instance.
- **Owner decisions (2026-11-10, from the research report `docs/ux-research/reports/Drawings and configurations UX.md`, List 1):**
  - **Parameter scope (D1):** a configuration's override of a document-level parameter applies only while *that part* regenerates; other parts keep the default value. Parameters stay document-level.
  - **Configurable fields (D2):** parameters, feature suppression, material and properties, plus any feature `Expr` field and listed option fields (hole size/type/fit, extrude end type) addressed as `(featureId, fieldPath)`. Sketch dimension values come later.
  - **New configuration (D3):** a visible "New from: Default / Active" choice, defaulting to Active.
  - **Part number (D4):** the user-set part number when present, else document name + configuration name (e.g. "Bracket-Long"); export file names follow it and collisions warn, never overwrite.
  - **Model and UX rules** (from the report's P0 list): sparse overrides keyed by id over an implicit Default; edit scope decided at the point of edit (an inherited value edits Default, i.e. all configurations, with an undoable "Changed in all N configurations" toast; an overridden value edits only the active configuration; "override in this configuration" is an explicit chip, never a sticky mode); an always-visible active-configuration pill with a tinted edge off Default; override markers with "Reset to default"; inline table; explicit per-configuration suppression and never auto-suppression of new features; needs-attention per configuration; a background rebuild-all check with per-configuration status, cached by resolved-value hash, and no forced rebuild on save; a consumer whose configuration id is missing is "needs attention", never a silent fall-back to Default. Typed inputs, rules and derived configurations are deferred (D5, D6).
- **Accept:** golden tests regenerate each configuration of a reference part and match the expected masses (FreeCAD-checked like §12A); E2E creates two configurations from the UI, switches between them, suppresses a feature in one only, exports both, and save → reload keeps everything; a merge test resolves edits to different configurations without conflict and flags the same cell edited on both sides.

### M3.8 — Sketch input polish

Owner feedback 2026-11-10. Small; right after M3.7, before M4 (drawings dimension sketches and edges, so sketch input should be solid first).

- **Implied constraints on every tool.** Today the inference engine proposes coincident (and horizontal/vertical, on-curve, tangent) snaps, and the line tool commits them; other tools don't consistently. For example, the Point tool ignores a click on an existing point instead of merging, and a circle centre or a spline pole placed on an existing point may not bind.
  - Audit every sketch tool: line, rectangle (each variant), circle, arc, slot, polygon, point, ellipse, elliptic arc, both spline tools, and the Pencil-recognised shapes.
  - Every placed point that lands on a visible point **reuses that point** (or adds `coincident`). Points landing on a curve add point-on-curve, and axis or origin alignment adds horizontal or vertical, exactly as the glyph promised while hovering.
  - What is shown is what is committed. A test checks that the glyphs shown match the constraints written, for every tool.
- **Finish a tool without Esc.**
  - **Mouse:** a right click (press and release, no drag) **finishes the current chain or shape**: it ends a line chain where it is, and commits an open spline with the points placed so far. With nothing in progress it opens the radial menu, as today, and right-drag still navigates. Esc keeps working; Enter and double-click still finish splines.
  - **Touch and Pencil:** a visible **Finish** button beside the sketch toolbar's Done ✕ while a chain or spline is in progress. Double-tap still works.
  - The behaviour is configurable in Settings → Navigation ("Right click finishes the current sketch tool", on by default) and listed in the shortcut overlay.
- **Radial menu customization** (owner, 2026-11-10). The menu already opens at once (ADR-076); users can now choose what's on it.
  - **Per context.** Contexts: empty space, face, edge, vertex, body, feature (tree), sketch idle, sketch with a selection. Each context has up to seven items plus the fixed Repeat slot. Users choose which command sits in which direction, picking only from the command registry.
  - **Stable positions.** An item that doesn't apply to the current selection shows disabled instead of disappearing, so muscle memory and flicks keep working.
  - **Editor.** Settings → Radial menu shows the ring for a chosen context. Drag commands from a searchable list into a slot, or clear a slot. Keyboard alternative: pick a slot, then pick a command. Includes Reset for each context and Reset all.
  - **Persistence.** Stored with the keymap: per device, exported and imported with settings. Schema-versioned, with unknown command ids dropped and reported.
  - **Flick window setting.** 0–400 ms, default 250; 0 turns flicks off. An optional "Draw after a delay" setting for blind-flick purists (default off).
  - **Accept:** unit tests for the layout, persistence and migration of a customised ring; E2E for customising the face context, reloading, then a right-click shows the custom ring and a flick runs the custom item; the editor passes axe, keyboard-only checks and phone width.
- **Show references that changed meaning (from the ADR-078 face-merge review).** The regen reports references resolved through a merge alias (`FeatureStatus.merged`), but the app shows nothing. An exact-name reference can also now cover more geometry: a fillet on `edge(plateBack|plateLeft)` grew from 8 mm to 48 mm with no report.
  - Show a quiet "uses merged face/edge" badge on the feature, with the detail in the inspector.
  - Compare a reference's measure (area or length) with its stored fingerprint, and flag a large growth as "check this reference", with Accept and Re-pick.
  - Never block the regen. Never re-pick silently.
  - Accept: E2E on the bracket: the grown fillet edge is flagged, and Accept clears the flag.
- **Phone overlays stay out of the way** (owner screenshot, 2026-11-11: a section on a face of the demo bracket left the model almost hidden). Fixes:
  - **The selection bubble closes once an action is chosen from it.** It may come back on the next selection, never on its own.
  - **One home for a mode's controls on phone.** While the bottom sheet shows a tool's tab (Section, Measure), the floating tool chip hides, because the tab already offers Exit, Flip and the other controls. With the sheet collapsed, the chip shows.
  - **No two floating overlays intersect.** That covers the bubble, the tool chip, the view cube, the kernel pill and toasts. Collision-aware placement keeps them apart, and the lower-priority one moves or collapses.
  - **The camera frames the model in the unobstructed area** (the viewport minus the sheet, the top bar and floating chrome) when a mode starts and when the sheet changes height.
  - **Value fields never truncate their unit.** For example, the section offset showed "-40.00n" for "-40.00 mm". The field widens, or abbreviates the number before the unit.
  - **Accept:**
    - Phone E2E on the demo bracket: section by face. After the action, no bubble. Overlay bounding boxes never intersect. At least 60 % of the model's projected area is visible above the sheet. The offset field shows its unit.
    - The same E2E for measure.
    - Visual baselines at 390 × 844, light and dark.
- **Two-point splines.** A through-point spline with two points is valid: a straight cubic with free end tangents that can be dragged or constrained later. A control-point spline with two poles is a degree-1 segment, offered as such. Today a two-point spline can't be finished.
- **Accept (sketch items):**
  - Unit tests per tool: glyphs shown equal constraints committed. Dropping a point on an existing point merges it, with no duplicate.
  - E2E (mouse): a right click ends a line chain and a three-point spline. With nothing in progress it opens the radial menu.
  - E2E (touch): Finish ends a chain.
  - A two-point spline finishes and regenerates.
  - No change to right-drag navigation.

### M4 — Drawings

Order decision (owner, 2026-11-10; ADR-081): drawings stay before MBD, but M4 builds the **shared annotation core** that M5 exports. A drawing's dimensions and GD&T are semantic annotations on the 3D model that drawing views display. They are not 2D-only objects, so M5 reuses them instead of rebuilding.

- **Shared annotation core (first, in the M4 contracts step):**
  - **Where annotations live.** A part-level, id-keyed set (`Part.annotations`) replaces the per-feature `FeatureBase.annotations`. No migration: before 1.0, files from an earlier schema are refused with a plain message (owner, 2026-11-11; ADR-090). A dimension placed on a drawing measures the finished part, so no feature owns it.
  - **What an annotation is.** Each one is semantic: its kind (linear, diameter, radius, angle, datum, geometric tolerance, note), its value or measured flag, its tolerance or fit, and its GD&T characteristic, zone, modifiers and datums. It points at model faces, edges and vertices through `EntityRef`s, never at lines in a 2D view.
  - **Driving dimensions.** An annotation can be bound to a driving sketch or feature dimension (`source`) and then shows its live value.
  - **On a drawing.** A view displays an annotation through a per-view placement (text position, leader, witness-line side). That placement, not a copy of the annotation, is what a drawing stores. A dimension drawn on a view creates an annotation, marked as a drawing annotation.
  - **One code path.** Tolerance, fit and GD&T formatting, and the symbol and text layout, are written once and used by drawing views (M4) and later by 3D display and STEP export (M5).
  - **References.** An annotation whose references no longer resolve is **needs attention**, exactly like a feature reference. It is never re-attached to a guessed face.
  - **Configuration overrides.** Overrides on annotations are keyed by annotation id, not by list position (M3.7 gate finding; this closes that item before PMI editing exists).
- Sheets and templates; base, projected, iso, section and detail views with exact HLR; centre marks; dimensions with tolerances; GD&T frames, datums, notes and a **part properties table** (part number, description, material, mass; optionally one row per configuration; balloons and multi-part BOMs come with M6); associativity; PDF, SVG and DXF export. **Not in M4:** weld symbols (later, with assemblies or on request). Owner decisions 2026-11-10; design input: `docs/ux-research/reports/Drawings and configurations UX.md`.
- **Import model annotations** places annotations onto suitable views automatically: driving sketch and feature dimensions (promoted in one tap) and any annotations the part already has. It picks the view where the measured geometry is seen true-length, and it never places a dimension twice.
- **Accept:**
  - A drawing of the bracket with three views, a section and full dimensions exports to a vector PDF that prints at 1:1 scale exactly (measured).
  - The DXF is valid and opens correctly in LibreCAD, checked automatically in CI (golden tests, an ezdxf structure audit, headless LibreCAD conversion). QCAD compatibility is best effort, not an acceptance criterion (owner, 2026-11-10: QCAD's command-line tools are commercial).
  - Editing the model updates the drawing, and dangling dimensions are flagged.
  - Certification-style suite (§12A): for every reference part, the E2E recreates its spec drawing with Wren's drawing tools. The views requested by the spec must be present and every specified dimension must appear with the same value.
    - **Owner decision 2026-11-11: M4 ships at 78 of 94.** The suite passes on all ten parts, with nothing needing attention. The remaining 16 specified dimensions are named gaps in 14 entries (`apps/web/e2e/support/reference-drawing-gaps.ts`). Each part test tries every gap with the drawing tools and fails once one starts working. They move to **M4.1**.
  - **Annotation core:**
    - Every dimension and GD&T frame on the bracket drawing is a part-level annotation with resolved `EntityRef`s (unit test).
    - Deleting or reordering annotations never retargets a configuration override (test).
    - A promoted driving dimension updates on the drawing when its value changes.
    - A document saved before M4 is refused on load with a plain message, never half-read (owner, 2026-11-11: no backward compatibility before 1.0; ADR-090).

### M4.1 — Drawing pick gaps (certification follow-ups)

From the M4 certification suite (owner decision 2026-11-11), in this order:

1. **Construction geometry on views** (GAP-PICK-CONSTRUCTION, 6 dimensions: rp03 flat_h, rp04 boss_up, rp08 cs_x and cs_y, rp09 pcd, rp10 slot_x0). Draw sketch origins, centre lines, centre planes and pitch circles as pickable construction lines, via `annotationAnchors` for `S<id>:p(@origin)`, `S<id>:e(@x)` and `S<id>:e(@y)`.
2. **Section cut-face edges** (GAP-PICK-SECTION, 3: rp05 wall and draft_a, rp08 tap_depth, rp09 hub_h). The drawing kernel names each cut-face edge by the model face it cuts.
3. **Centre-to-centre dimensions** (GAP-TOOL-CENTRES, 1: rp08 tap_dx). The Dimension tool waits for a second pick after a circle.
4. **Niche cases:**
   - GAP-PICK-OUTLINE-SPLINE (rp02 fillet_r): a torus outline that comes back as a spline gets a radius pick.
   - GAP-PICK-TANGENT (rp06 rod_h, rod_tail): tangent edges are drawn thin and are pickable.
   - GAP-PICK-HIDDEN (rp07 inset): hidden lines are pickable.
   - GAP-PICK-EXTREMES (rp09 flange_d): a linear dimension across a circle's extremes.

- **Design:** ADR-095 (contracts 2026-11-12). rp04 `boss_up` and rp10 `slot_x0` are made from model entities the reference parts gain (a reference plane, a construction point), not from a guessed level.
- **Accept:** each closed gap's `test.fixme` becomes a passing assertion. The certification suite reaches 94 of 94.
- **Status 2026-11-12:** all 16 closed; `GAPS` is empty and the suite checks the annotation kind against the spec. Spec corrections recorded in the reference-parts README: rp07 `inset` was a misdiagnosis (its edge is visible), rp08 `tap_depth` is drawn at the hole the stepped cut passes through, rp06 `ch_d` is a linear width seen from above.

### M4.5 — 3D mice and CAD mice

Owner request 2026-11-10, from `docs/ux-research/reports/CAD UI feedback and lessons.md` (items 16 and 22). Placed after drawings and before assemblies, where 6-DoF navigation matters most. About 1–2 weeks.

- **Navigation-input contract** (lead): one device-independent 6-DoF motion event (translation and rotation rates, buttons), consumed by the same navigation code as mouse, touch and Pencil. The puck orbits about the **same cursor pivot** as the mouse (ADR-046/057), zooms toward the surface like the wheel (ADR-069) and never fights an in-flight gesture.
- **Adapters, feature-detected and layered:**
  1. **WebHID** (desktop Chrome/Edge 89+), with HID report parsing in Wren's own GPL code. Vendor and product ids are plain data. Pairing is a one-time permission prompt from Settings. Note that the browser gets no reports while 3DxWare holds the device; the diagnostics panel says so and links the fix.
  2. **Optional 3DconnexionJS adapter**, loaded at runtime from the user's own installed driver and never bundled. P2, and only after the licence is checked against GPL and the self-hosting rule.
  3. **Documented localhost WebSocket protocol** for a spacenavd bridge (Linux). P2.
- **Buttons map in Wren**, not through vendor per-app profiles: fit, standard views, the radial menu and Repeat by default, rebindable in the keymap editor. Sensitivity, per-axis invert and dominant-axis settings live in Settings.
- **2D CAD mice:** any mouse button (including side buttons 3 and 4) can be bound to the radial menu or Repeat. High-resolution and inertial wheels are handled (ADR-069 wheel normalisation).
- **Diagnostics:** which path is live (WebHID, driver, bridge or none), the device name and live axis values. Silent failure is the main complaint about browser CAD and 3D mice.
- **Safari / iPad:** no WebHID, so no 6-DoF path. The UI says so plainly.
- **Accept:**
  - unit tests parse recorded HID reports from at least two device models into motion events;
  - E2E with an injected motion source shows orbit about the cursor pivot, zoom toward the surface and no conflict with mouse drags;
  - button remapping persists;
  - the diagnostics panel shows each state.
  - A manual check with a real device is on the owner's checklist.
- **Names:** "3D mouse" / "6-DoF controller". Vendor product names are used only in compatibility statements.

### M5 — STEP AP242 with model dimensions (MBD/PMI)

M5 builds on M4's annotation core (ADR-081). The annotations, their tolerance and GD&T semantics, their references and their formatting already exist. M5 adds showing them in 3D and exchanging them in STEP.

- **MBD mode (3D display and editing):**
  - Users annotate the 3D model directly on **annotation planes** (by face, view or saved view), with the same tools and the same annotation objects as drawings. An annotation made on a drawing can also be shown in 3D, and the reverse.
  - Saved views ("model views") group annotations, like drawing views do.
  - Text is screen-readable, leaders are drawn in the viewport, and annotations are pickable. They can be filtered by kind or saved view and hidden per view.
  - Driving sketch and feature dimensions can still be promoted in one tap (shared with M4).
- **Export pipeline** (in the kernel façade, through XDE/XCAF):
  1. Build an XCAF document: shapes with names, colours, units and the product structure.
  2. For each annotation, resolve its `EntityRef`s to sub-shape labels. Create semantic entities with `XCAFDoc_DimTolTool` (`AddDimension` / `SetDimension` / `AddGeomTolerance` / `AddDatum`). Fill in the type, value, tolerance or fit, the annotation plane and the points through `XCAFDimTolObjects_*Object`. An annotation that needs attention is not exported, and the export lists it.
  3. Generate **presentation PMI**: tessellated annotation geometry (lines plus stroked text) from M4's layout code, attached with `XCAFDoc_DimTolTool::SetGDTPresentations`. Viewers that only display presentation PMI then show the annotations. Without this step, the export contains only semantic PMI.
  4. Configure the writer for the AP242 schema (check the exact parameter API in the OCCT 8 data-exchange docs) and write with `STEPCAFControl_Writer`.
  5. Optionally write user-defined attributes: model parameters as properties.
- Follow the CAx-IF _Recommended Practices for the Representation and Presentation of PMI (AP242)_, which OCCT's XDE GD&T processing is based on.
- **Import:**
  - Read semantic PMI from STEP into part annotations, with references resolved to the imported body's faces.
  - Read presentation-only PMI as display geometry.
  - Anything OCCT cannot read is reported per annotation, never dropped silently.
- **Validation:**
  - Node round-trip tests with `STEPCAFControl_Reader`: dimension and tolerance counts, types, values and referenced faces all match.
  - Import the NIST MBE PMI test models (`test-fixtures/step/nist/`) and display their PMI. Note that OCCT has known gaps reading some third-party tolerance values; document what fails.
  - Manually validate the exports with the NIST _STEP File Analyzer and Viewer_ and at least one third-party CAD tool. Record the results in `docs/PMI_VALIDATION.md`.
- **Accept:** the bracket exports with ≥ 15 semantic dimensions or tolerances plus presentation, and they are the same annotations its M4 drawing shows. The round-trip is lossless in Wren. The NIST analyzer reports no structural errors in the PMI entities.

### M6 — Assemblies

- Multi-part documents, instances, mates and DOF, exploded views, BOM, assembly drawings, assembly STEP (with PMI per part).
- **Lightweight by default** (owner, 2026-11-10): an assembly opens with every part *lightweight*: drawn from the per-part-version cache (display meshes and edges, face/edge names for picking, mass properties, and the reference frames (planes, axes, points) of the faces mates use), with no B-rep in the kernel. Mates, motion through DOF, explode, assembly mass and centre of mass and review all work lightweight. A part is *resolved* (B-rep loaded) only on demand: editing it, exact measure, interference, in-context references, STEP export; resolved parts are released through the LRU shape cache. Identical instances share one mesh (GPU instancing); small or distant parts use coarser meshes, very large assemblies bounding boxes. Several kernel workers can each hold resolved parts (each its own 4 GB Wasm heap); Memory64 (Chrome/Firefox desktop) is a possible later opt-in. Every assembly operation declares whether it needs resolved parts. Effect: the kernel's 4 GB cap limits only what is resolved at once, not assembly size; the practical limit becomes GPU triangles and tab memory. **Accept (added):** a 500-instance assembly (generated, with repeated fasteners) opens, moves through its DOF and reports mass with no part resolved, and resolving one part for editing keeps the kernel under its memory budget.
- **Assembly tree folders** (owner, 2026-11-10): folders for components and a separate mates area with folders; per-folder hide, suppress and isolate. Display grouping only, distinct from sub-assemblies.
- **Assembly configurations** (owner request 2026-11-10): per configuration, which instances are suppressed, each instance's part configuration, and mate values (distances, angles); BOM and exports per configuration.
- **Accept:** a 25-part assembly reference model can be built, moved through its DOF, exploded, drawn and exported. The certification-style suite gains assembly stages: build from parts plus mates, then check the assembly mass and centre of mass.

### M7 — v1.0 hardening & polish

- Accessibility audit, performance pass, crash/fuzz tests (random feature edits, malformed STEP), docs site, sample gallery, and release automation.
- **Final test: the full certification-style run (§12A).** Every part, modification stage, drawing and assembly in the suite passes in CI. A human run of the real CSWA/CSWP practice exams in Wren, timed against their limits, is recorded in `docs/CERTIFICATION_RUN.md`: what passed, what was slow, what couldn't be built.

### 12A. Certification-style test suite (CSWA/CSWP pattern)

A capability check modelled on the SolidWorks CSWA/CSWP exams, which test exactly what users need: build a part from a drawing, set the material, confirm the mass, apply parametric changes, recreate the drawing, and assemble. It grows with the milestones (M3 parts and mass, M4 drawings, M6 assemblies) and is the final test at M7.

- **Original content only.** The real exam and practice drawings are Dassault Systèmes' copyrighted material and are never committed or used in CI. The suite's parts and drawings are written for Wren in the same style and difficulty. They live in `packages/test-fixtures/reference-parts/`, licensed with the repo.
- **Each case has:** a spec drawing (SVG/PDF, plus the dimensions in JSON); the material and density; the expected mass (and centre of mass), computed independently in FreeCAD with the value and the script recorded; and CSWP-style modification stages (named dimension changes plus the expected new mass).
- **Pass criteria:**
  - mass within 0.1 % (the exams' own tolerance) at every stage;
  - the part built entirely through the UI by a scripted E2E;
  - from M4, the recreated drawing contains the spec's views and dimensions;
  - from M6, the assembly cases match mass and centre of mass.
- **Human run.** The real practice exams are run by a person in Wren, timed, for M7, and the findings are fed back as issues. Nothing from those exams is stored in the repo.

---

### 12B. Simulation track (after v1.0; spike now)

Owner direction 2026-11-10 (ADR-058). Wren is the pre- and post-processor; the user's own installed solvers do the heavy computation on their desktop. Small structural models can also solve in the browser with CalculiX compiled to Wasm (owner, 2026-11-10; ADR-064), so a first study needs nothing installed. Wren meshes in the app. **Meshing and simulation are desktop only**: study setup, meshing, solving and results run in the desktop shell; tablets and phones do not offer them (viewing results there may come later as a nice-to-have).

**Scope: commit to a little, design for a lot.** v1.0 CAD comes first (M3.6–M7). After it, Wren commits to one simulation capability done very well: **structural analysis with CalculiX (S1)**. Breadth of solvers is not the differentiator (FreeCAD's FEM workbench already drives several free solvers); the differentiator is the workflow: loads on persistent names that survive design changes, studies versioned and branched with the design, a clean setup flow and results viewer inside the CAD. Every further solver is a permanent cost (case writers, result readers, install guides for three OSes, solver version drift, CI with the real solver, support), so further physics comes through a **solver-backend extension point** and is built on demand or contributed by solver communities, not committed on the roadmap.

- **Architecture (shared by every backend):**
  - **Built-in mesher:** Gmsh compiled to Wasm against the kernel's OCCT build, in its own lazily loaded worker (never the kernel worker, never the main thread). It meshes the exact BRep handed over by the kernel together with the face names, so mesh physical groups are named after Wren's persistent names. Quadratic tetrahedra for solids, triangles/quads for shells, size controls (global, per face/edge, curvature), quality metrics, preview in the viewport. Fallback if Gmsh resists the port: Netgen (LGPL). Very large meshes: "Mesh on this computer" writes the same Gmsh settings for a local Gmsh.
  - **Solvers run on the user's machine, three ways** (ADR-064):
    1. **In the browser, for small models.** CalculiX compiled to Wasm runs in its own lazily loaded solver worker (never the kernel or mesher worker). The deck writer and result reader are the same ones the native paths use. Nothing to install, and results arrive in seconds, so it is the default path for a first study and for quick checks while designing.
    2. **File handoff.** Wren writes a complete case folder (input deck plus `run.sh` / `run.bat`) into the project folder. The user runs it, and Wren imports the results when they appear (local-folder mode already watches the folder).
    3. **The optional Wren Runner**, a small open-source localhost service paired with a one-time code. It launches only the configured solver executables, streams progress and returns results.

    **Routing:** before each solve Wren estimates the number of unknowns and the solver memory. Under the in-browser limit (measured in S0b, expected roughly 100k unknowns, about 25–40k quadratic tets, in a 4 GB worker) the model solves in the tab. Above it, Wren says plainly "this model is too large to solve in the browser" and offers the local CalculiX via the Runner or file handoff. The user can always choose the local solver. No Wren-hosted compute.
  - **Loads on persistent names:** loads, constraints, contacts and mesh controls reference faces/edges by persistent name; a lost reference makes the study "needs attention", never a silent move.
  - **Studies are document data** (versioned, branched, merged like features); results live in `results/`, excluded from history by default; result files are streamed and parsed in a worker, never loaded whole.
  - **Solver-backend interface (documented, versioned):** a backend declares the study types and physics it supports, the setup fields it needs (materials, loads, boundary conditions, solver settings), a **case writer** (study + named mesh → input files and run script), a **result reader** (output files → Wren's common results format: fields on nodes/cells, steps/modes) and its install check. The study UI, mesher, Runner and results viewer are generic over backends. CalculiX is the first backend and the reference implementation; adding another solver means writing a backend, not changing the app.
- **S0 — spike (now):** Gmsh → Wasm against the kernel's OCCT; mesh the demo bracket in a worker; measure download size, mesh time and memory in desktop browsers; write a CalculiX `.inp`, solve it with a locally installed CalculiX, read the `.frd`, and match an analytic cantilever and the bracket's tip deflection from an independent solve. Report: `docs/spikes/simulation-mesh.md`.
- **S0b — spike: CalculiX in the browser (before S1).** Prior art: freecad-web runs CalculiX 2.22 in the browser (f2c → Emscripten, SPOOLES + ARPACK, single-threaded, Chromium-only because of its Python bridge). For Wren:
  - **Build:** CalculiX 2.23 with SPOOLES + ARPACK to Wasm in the kernel's Docker toolchain. Compare the Fortran routes (f2c, or flang-wasm). Build one single-threaded and one pthreads variant (Wren is already cross-origin isolated).
  - **Correctness:** solve the S0 cantilever and bracket, plus the S1 benchmark decks available by then. Results must match native CalculiX to solver precision on the same deck. Routines that cannot be ported must fail loudly with a clear error, never return a wrong answer.
  - **Limits:** measure solve time and peak memory against unknowns in desktop Chrome, Firefox and Safari, wasm32 (4 GB) and, where available, wasm64. From that, set the routing limit per study type (static, modal, thermal) and whether the iterative solver extends static and thermal studies on bulky parts.
  - **Packaging:** record download size (expected about 5 MB before compression).
  - **Licence work:** publish the build scripts and the CalculiX corresponding source; record CalculiX, SPOOLES and ARPACK in DEPENDENCIES.md.
  - **Report:** `docs/spikes/simulation-ccx-wasm.md`.
  - **Outcome:** if the spike fails (wrong answers, or a limit too small to be useful), S1 ships with local solving only and nothing else in S1 changes.
- **S1 — committed: structural for single parts.** Detailed in the research report `docs/ux-research/reports/Structural FEA best practices.md`; the trust layer is ADR-062. Principle: most wrong FEA results come from boundary conditions, singularities, coarse meshes, units and linear analysis pushed past its limits, not from the solver, so S1 ships guard rails a non-expert cannot miss. Sub-scopes, each with acceptance criteria:
  - **S1a — study model, materials, supports, loads.**
    - Study types: linear static, modal (N modes, with a re-run if the requested frequency limit is not reached) and steady thermal.
    - Studies are document data with a status per node in a study tree.
    - Material library stored in SI with units: E, ν, density, yield, ultimate, ductile/brittle flag, expansion, conductivity, specific heat, cited source. Curated metals and printing plastics; user materials import and export as a file. Decks are always written in mm·N·s·K (t/mm³).
    - Supports: fixed, slider/symmetry, pin (cylindrical), elastic support, enforced displacement.
    - Loads: force as a **total** over the selection (consistent nodal loads, never lumped equally), pressure (element-face surfaces), remote force or moment (coupling to a reference point), bearing (cosine pressure), gravity, rotation. Thermal: temperature, convection, heat flux, heat load, radiation.
    - Values are inline and accept expressions with units.
    - Glyphs on faces, sized in screen space. Every reference is a persistent name; a lost one makes the study "needs attention" with a dashed glyph.
    - **Accept:** each support or load writes the expected ccx keywords (deck golden tests); the consistent loads sum to the applied total; a design edit keeps every load on its face or flags it.
  - **S1b — mesher, quality and pre-run checks.**
    - C3D10 only. Coarse/Medium/Fine slider plus an exact size; minimum size ≈ h/30; curvature sizing.
    - Local refinement on named faces and edges; thin walls detected and refined to at least 2 layers, with a badge.
    - Algorithm fallback ladder; failures reported by persistent face name.
    - Mid-side nodes curved onto the exact geometry, then `HighOrderOptimize=2`.
    - Quality policy: minDetJac ≤ 0 → refine the fillet and re-mesh, else fall back to straight-sided elements with a notice (never sent invalid); minSICN < 0.1 → warn and show where; ≥ 0.1 → OK.
    - No OCC healing by default (it renumbers faces). "Suppress in study" for tiny features, never on loaded faces.
    - Quality report: counts, estimated DOF, minSICN distribution, worst elements in the viewport.
    - Pre-run checks block: missing material or required values; supports that do not stop all 6 rigid-body motions (offer modal instead); disconnected mesh; empty or unresolved sets; invalid elements. They warn: low quality, thin walls, DOF beyond the solver's memory.
    - Deterministic mode (single thread, fixed seed) for CI.
    - **Accept:** mesh volume matches the BRep volume; facet count per named surface; an under-constrained bracket is blocked; a deterministic re-mesh hashes identically.
  - **S1c — CalculiX backend (the first solver backend).**
    - Wren writes the `.inp` itself; Gmsh's export lacks face surfaces and adds stray plane-stress elements.
    - Deck writing: contiguous numbering; the tet10 node-order swap, checked; sanitised ≤ 80-character set names mapped to persistent names; a header with Wren version, units and input hash.
    - Outputs: U, RF, S, E plus ccx's error estimator; reaction totals per support; volume and mass totals; thermal NT, RFL, HFL; modal frequencies, participation and effective mass from `.dat`.
    - Install check: `ccx -v` (minimum 2.20), probing the binary names; thread environment set in the run script.
    - Failure classification: exit code, `*ERROR` lines, NaN residuals, missing `.frd`. Known errors become plain language; `*WARNING` lines are shown.
    - Delivery, in order: in-browser CalculiX for models under the routing limit, then file handoff, then the Runner. Every path shows a live monitor (log, progress, kill) and runs the same pre-run checks and failure classification.
    - In-browser solver: lazily loaded worker; cancel terminates the worker; a solve never blocks modeling; the solver version and "in browser" are recorded with the result.
    - **Accept (in-browser):** in CI, the benchmark suite runs on both the Wasm and the native CalculiX builds and their results match; a model just over the routing limit is routed to local solving with a clear message.
    - **Accept:** a deck for every support and load type solves on ccx 2.20 and 2.23; each failure class is recognised from captured logs.
  - **S1d — results viewer and Results checks.**
    - Plots: displacement (magnitude and components), von Mises, principal stresses and components, strain, factor of safety (yield/von Mises for ductile, ultimate/max principal for brittle), reaction forces, temperature, heat flux; modal frequency table with effective mass and the cumulative fraction.
    - Averaged-at-nodes by default, labelled; unaveraged element values on demand.
    - Deformation: automatic scale with ×N always shown, True scale one click away, undeformed overlay, animation.
    - Legend: banded or continuous; automatic limits clipped at a high percentile while the true maximum stays shown and marked; manual limits flagged.
    - Min/max markers; point and face/edge probes (min, max, average, integral) that persist across re-solves; section plane.
    - Staleness: results are hashed against their inputs and marked "out of date" with the reason.
    - **Results checks** on every result: equilibrium (reactions = loads), mesh mass vs CAD mass, mesh error indicator, singularity markers (re-entrant edges, edges of fixed faces, point or edge loads and supports), large-deflection flag (> ~10% of part size), yield exceedance, modal mass ≥ 90% with 6 rigid-body modes for free-free runs, thermal balance.
    - **Accept:** every check fires on a seeded faulty model and stays green on the benchmarks.
  - **S1e — convergence, compare, report.**
    - "Check convergence" re-meshes at size factors 1, 0.7 and 0.5 and plots probe peak stress, strain energy and displacement against DOF. Converged below a 2% change; a peak that keeps rising is reported as a singularity, never chased.
    - Compare two results side by side or as a difference, across designs, branches or configurations, plus a key-values table across study versions.
    - HTML/PDF report: setup images, mesh quality, Results checks, plots, probes, solver version, units, input hash, disclaimer. CSV and VTU export.
    - Error-driven adaptive refinement comes later.
  - **S1f — benchmark CI (real ccx).**
    - NAFEMS benchmarks: LE1 (92.7 MPa, ≤ 2%), LE10 (−5.38 MPa, ≤ 3%, face idealisation documented), FV32 (six modes, ≤ 1%), FV52 (simply supported, modes 4–10, ≤ 3%). LE11 joins once thermal stress arrives.
    - Analytic cases: cantilever, Kirsch plate with a hole (plus a sharp-notch variant that must be flagged as singular), Lamé cylinder, beam frequencies, 1D conduction with convection.
    - A free-free block giving 6 rigid-body modes, and the persistence test.
- **Effort:** S1 about 12–14 weeks, up from the S0 estimate of 10–12, after the research added the Results checks layer, the convergence check and the benchmark suite. Add 1–2 weeks for the S0b spike and 2–3 weeks inside S1 for the in-browser solver path (the deck writer, reader and checks are shared).
- **Extension track — on demand or community-contributed, not committed.** Each item is a backend (plus any physics-specific UI) on the S1 foundation; built when users ask for it or a contributor offers it:
  - the Runner on all desktop OSes, nonlinear material, bonded and contact assemblies (after M6);
  - CFD via OpenFOAM (one distribution first): Wren prepares the fluid domain, named surface patches and the case; `snappyHexMesh` meshes locally; Wren reads the VTK output (pressure, velocity, streamlines); an optional in-browser lattice-Boltzmann flow preview on WebGPU;
  - Elmer FEM (electromagnetics, Joule heating, acoustics, coupled thermal-electric) and GetDP (low-frequency electromagnetics), specialised solvers preferred over a general PDE builder;
  - coupled physics: one-way load transfer done inside Wren (CFD pressures or temperatures mapped onto the structural mesh), then two-way coupling (fluid-structure interaction, conjugate heat transfer) through preCICE with its OpenFOAM and CalculiX adapters, the Runner launching both solvers;
  - an expert "custom physics" mode: the tagged mesh plus a starter FEniCSx script. A general PDE-builder GUI is not planned (its choices of spaces, stabilisation and solvers decide whether results mean anything, and users able to make them prefer code).

## 13. Hosting roadmap

1. **Now:** GitHub Pages (static, PWA, service-worker COI shim).
2. **Early, alongside GitHub Pages:** one small, stateless **Cloudflare Worker** (free tier) that provides:
   - OAuth token exchange for providers that need a client secret (e.g. GitHub);
   - the git CORS proxy for isomorphic-git (§8A.2).

   This can ship while the app itself is still on GitHub Pages.
3. **In progress:** Cloudflare Pages on wren-cad.app, with real COOP/COEP headers through `_headers`. CI builds the site and publishes it to a `cloudflare-pages` branch that Cloudflare serves without a build step (it cannot build the kernel); see ADR-082 and docs/DEPLOY.md. Still to do: preview deployments per PR (design in docs/DEPLOY.md).
4. **Later (optional and opt-in, keeping the app local-first):**
   - Share links (snapshots in R2) and a read-only viewer route.
   - Comments (Durable Objects).
   - Real-time collaboration via Yjs with a Durable Objects relay. The document model in §6 is designed so this needs no schema rewrite.

---

## 14. Risks & mitigations

| Risk                                                                               | Mitigation                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCCT robustness for fillets, booleans and direct push/pull (weaker than Parasolid) | Validate inputs first (radius bounds, self-intersection checks); try fallbacks (`BRepAlgoAPI` fuzzy value, `ShapeFix`); give clear failure messages; keep the last good geometry; build a fuzz suite |
| Topological naming regressions                                                     | §7.3 algorithm, golden suite, "needs attention" UX instead of silent guesses                                                                                                                         |
| Wasm size and startup                                                              | Trimmed symbol list, split HLR build, streaming compile, service-worker cache, render cached meshes before the kernel is ready                                                                       |
| OCCT 8 restructuring (toolkit and package names moved)                             | M0 spike confirms the module and toolkit list for the 8.0.1 build; ADR records the result                                                                                                            |
| Threads unavailable (no isolation)                                                 | Single-threaded fallback build, tested in CI                                                                                                                                                         |
| iOS memory limits                                                                  | Device tier, LRU shape cache, coarse meshing, lazy kernel on phones                                                                                                                                  |
| PMI interoperability varies by receiving CAD                                       | Follow CAx-IF practices, always include presentation PMI, run the validation matrix in M5                                                                                                            |
| Solver edge cases (planegcs non-driving constraints, B-splines)                    | Compute driven dimensions by measurement; defer splines; keep the solver behind an interface so it can be swapped                                                                                    |
| Scope creep                                                                        | P0/P1/P2 discipline; the lead rejects unscheduled features without an ADR                                                                                                                            |
| Sync data loss or silent overwrites                                                | Optimistic concurrency (`ifRev`), never overwrite on conflict, local history always kept, fuzz-tested merge                                                                                          |
| Provider API, OAuth or CORS changes; Nextcloud CORS setup friction                 | Adapters behind one interface; reuse Mycelium's proven flows; a clear in-app setup guide for Nextcloud admins; the local-synced-folder option as a universal fallback                                |
| Token theft                                                                        | Tokens on the device only, encrypted at rest, minimal scopes, stateless Worker, strict CSP                                                                                                           |
| License conflict when reusing Mycelium code (GPL-3.0)                              | ADR before M2.5: relicense the extracted module (author) or align Wren's license                                                                                                                  |

---

## 15. Kick-off prompt for Claude Code

> Read `docs/PLAN.md` end-to-end. Create `CLAUDE.md` from Appendix A and the subagents from Appendix B. Then start **M0**: write `packages/contracts` (the initial document schema and kernel API types from §6–7) and `docs/DECISIONS.md` (with ADR-001 for the tech stack in §3). Delegate the four M0 workstreams in parallel per §11.3, integrate them, run the reviewer gate, and report the deployed URL with evidence for each M0 acceptance criterion. Don't start M1 until the gate passes.

---

## Appendix A — `CLAUDE.md`

The live copy is the repository's root `CLAUDE.md`. Keep the two in sync.

## Appendix B — Subagent definitions (`.claude/agents/`)

The live copies are in `.claude/agents/*.md` (one per role in §11.1). Each file is Markdown with YAML frontmatter. Model aliases: `opus`, `sonnet`, `haiku`, or `inherit`.

## Appendix C — Reference projects to study (do not copy code without checking licenses)

- **Chili3D** (AGPL-3.0): browser CAD on OCCT Wasm + three.js. A useful reference for UI and tooling scope.
- **CascadeStudio** (MIT) and **replicad**: OCCT-in-browser code-CAD ergonomics.
- **opencascade.js v3 / libcascade** (`taucad/opencascade.js`): the build toolchain, custom builds, and `customBindings`.
- **planegcs** (LGPL-2.0-or-later): the solver API and thesis notes on constraint solving.
- **FreeCAD**: the TNP mitigation approach and PlaneGCS usage patterns.
- **Shapr3D and Onshape**: interaction design benchmarks only.
- **NIST MBE PMI test cases** and the **STEP File Analyzer and Viewer**: PMI validation.
- **Mycelium** (`github.com/jackhale98/mycelium-web`, GPL-3.0, same author): proven static-PWA sync with git hosts, Dropbox, OneDrive/SharePoint and WebDAV/Nextcloud. Port it into `packages/sync`.
- **isomorphic-git** and **@isomorphic-git/cors-proxy** (MIT): git in the browser.
- **Automerge 3** (MIT) and **Ink & Switch's Patchwork** research: history, branching and diff ideas for local-first apps.
