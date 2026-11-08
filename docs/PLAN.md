# Whittle — Design & Build Plan

> **Whittle** is a free, open-source, browser-native parametric CAD app. It installs as a PWA, works offline, and runs the geometry kernel entirely on the user's device. Desktop gets the full feature set. Tablets get a Shapr3D-class touch and Pencil experience. Phones get excellent viewing and light editing.
>
> This document is the single source of truth for building Whittle with Claude Code and subagents. Read it fully before writing code. When this plan and reality disagree (an API has changed, say), verify against official docs, update this plan in the same PR, and note the change in `docs/DECISIONS.md`.

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

**Goal:** Whittle should feel faster and friendlier than Onshape, while being free and open, and still produce manufacturable, standards-compliant output (STEP AP242 with dimensions and tolerances, and fully dimensioned drawings).

**Principles, in priority order:**

1. **Instant.** Every interaction gives feedback within one frame. Geometry never blocks the UI. Show a cheap preview while the user drags, and compute the exact result when they release.
2. **Obvious.** No modal dialogs for modeling. Tools appear in context next to the selection. Every value is editable inline and accepts expressions with units (`25mm + 1/8in`, `width/2`).
3. **Forgiving.** Unlimited undo and redo. Non-destructive history. Failures are explained in human terms ("Fillet radius is too large for this edge; max ≈ 2.4 mm") and never corrupt the model.
4. **Precise.** Real B-rep solids (OpenCascade), exact dimensions and units, and output that other CAD systems accept.
5. **Yours.** Local-first. No account is required. Files are open and documented (`.whittle`). It works offline.
6. **Beautiful.** It has a calm, modern visual language and polished motion. The viewport looks like a product render, not a debug view.

**Non-goals for v1:** real-time multi-user collaboration (prepare for it, don't build it), CAM, FEA, rendering beyond the high-quality viewport, sheet-metal, and surfacing beyond loft/sweep/fill.

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
| Configurations (parameter tables), derived parts                                                                                                         | P2                        |

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
| `.whittle` (native, open, zip + JSON)                                            | ✓                     | ✓                          | P0                       |

### 2.6 Platform & UX

| Feature                                                                                                                                                                                  | Pri                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Installable PWA, offline, file handling ("Open with Whittle" for .whittle/.step on desktop)                                                                                              | P0                         |
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
| File packaging  | Canonical form is a **folder of deterministic text files** (§8A.1); `.whittle` is that folder zipped with `fflate` for sharing                                                                                                                                                                | Text-first source makes git-style diff and merge possible.                                                                                                                                                                                                                                                                             |
| Cloud sync      | One `StorageProvider` interface. Adapters ported from the **Mycelium** app (Dropbox, OneDrive/SharePoint, WebDAV/Nextcloud, GitHub/GitLab/Bitbucket), plus Google Drive and local folders (§8A.2)                                                                                             | The adapters already work in a static PWA.                                                                                                                                                                                                                                                                                             |
| Version control | `HistoryStore` with two backends: **isomorphic-git** (git hosts) and **snapshot DAG** (cloud drives/local). Feature-level three-way merge; kernel-computed geometric diff (§8A.3)                                                                                                             | No mature open-source "git for CAD" exists; our text format makes one feasible.                                                                                                                                                                                                                                                        |
| Drawings        | **SVG DOM** editor (crisp, printable), HLR from OCCT (`HLRBRep_PolyAlgo` for fast drafts, `HLRBRep_Algo` for exact final output) in a separate worker; PDF via **jsPDF + svg2pdf.js**; DXF via a DXF writer library (evaluate `@tarikjabiri/dxf`, otherwise write a minimal R12/R2000 writer) |                                                                                                                                                                                                                                                                                                                                        |
| PWA             | **vite-plugin-pwa** (Workbox) in `injectManifest` mode with a **custom service worker**                                                                                                                                                                                                       | The service worker also injects COOP/COEP headers (§8.3).                                                                                                                                                                                                                                                                              |
| Tests           | Vitest (unit, with Wasm in Node), Playwright (E2E plus screenshot diffs), C++ tests for the façade                                                                                                                                                                                            |                                                                                                                                                                                                                                                                                                                                        |
| Lint/format     | Biome                                                                                                                                                                                                                                                                                         | It's fast, and there's one tool.                                                                                                                                                                                                                                                                                                       |
| Package manager | pnpm workspaces                                                                                                                                                                                                                                                                               |                                                                                                                                                                                                                                                                                                                                        |
| License | **GPL-3.0-or-later** for Whittle's code (ADR-003), matching Mycelium so its sync layer can be ported directly. The kernel ships as a separate `.wasm` (OCCT, LGPL-2.1 with exception — GPL-compatible) with public, reproducible build scripts, which satisfies OCCT's LGPL relinking expectation | Alternatives considered: Apache-2.0 (needed a Mycelium relicense) and AGPL-3.0 (also covers SaaS forks). |

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
- **Two meshing levels:** coarse while dragging or orbiting (fast), fine on idle (quality). Meshes are cached in the `.whittle` file so a document opens and renders _before_ the kernel has loaded.
- **Kernel boot is non-blocking:** the app shell becomes interactive first, and the kernel streams and compiles in the background (`WebAssembly.instantiateStreaming`). The service worker caches it after the first load.
- **Two kernel builds:** a threaded build (needs cross-origin isolation, §8.3) and a single-threaded fallback. Pick one at runtime with `crossOriginIsolated`.

---

## 5. Repository layout

```
whittle/
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
│  ├─ io/                     # Format adapters (TS side), .whittle packaging, PMI mapping
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

export interface WhittleDoc {
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

Undo/redo works on JSON patches (RFC 6902) of `WhittleDoc`. Coalesce continuous drags into one entry.

On disk, a `WhittleDoc` is split into the canonical project folder (§8A.1): one file per part, drawing and assembly. Serialisation must be deterministic, so the same document always produces byte-identical files. Diffs and merges depend on this.

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

- Deploy with `actions/deploy-pages` from CI artefacts. Set Vite `base: '/whittle/'` for a project site, or `/` with a custom domain.
- Use hash-based routing, or the `404.html` SPA fallback, because Pages has no rewrites.
- The service worker caches the kernel `.wasm` after the first visit. Show the kernel download progress in a subtle status chip.

### 8.2 Cloudflare Pages (later; see §13)

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

A project's canonical form is a **folder of deterministic text files**. A `.whittle` file is just this folder zipped, for sharing and emailing.

```
my-bracket/
├─ whittle.project.json          # manifest: name, units, schemaVersion, index of parts/drawings, part number
├─ params.json                   # global parameters
├─ parts/bracket.part.json       # features + sketches, keyed by stable IDs
├─ drawings/bracket.drawing.json
├─ assemblies/…
├─ releases/rev-A/               # frozen exports for a release: bracket.step (AP242+PMI), bracket.pdf
├─ previews/bracket.stl          # optional small mesh so git hosts can render 3D previews/diffs
├─ .whittle-history/             # snapshot history (only for non-git storage, §8A.3)
└─ .whittle/                     # cache: meshes, BREP, thumbnails; never synced or committed, always regenerable
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
| Nextcloud / ownCloud / any WebDAV | Nextcloud Login Flow v2 or app password                                                  | `webdav` npm client              | ⚠ The server must allow CORS for Whittle's origin                                 | Options: the Nextcloud `webapppassword` app (adds WebDAV CORS headers and temporary app passwords for web apps), or reverse-proxy headers. ETags + PROPFIND polling |
| GitHub                            | Fine-grained token first; OAuth/GitHub App with a per-repo picker once the Worker exists | isomorphic-git + REST            | ⚠ Git's HTTP endpoints and GitHub's OAuth token exchange don't allow browser CORS | Needs the small proxy + token-exchange Worker (§13)                                                                                                                 |
| GitLab, Forgejo/Gitea, Bitbucket  | OAuth + PKCE where supported, else tokens                                                | isomorphic-git                   | ⚠ Same proxy                                                                      | Self-hosted Forgejo is the fully open-source route                                                                                                                  |

During the M2.5 spike, check each provider's current OAuth and CORS behaviour against Mycelium's working implementation, and record the results in `DECISIONS.md`.

**Git CORS proxy:** the isomorphic-git project runs a free public proxy for cloning and pushing from browsers, which is fine for development. Production self-hosts `@isomorphic-git/cors-proxy` (MIT) as a Cloudflare Worker, restricted to Whittle's origin and to git-shaped requests.

**Security:**

- Tokens never leave the device. They're encrypted at rest with a non-extractable WebCrypto key.
- Request minimal scopes.
- Proxy Workers are stateless and never log tokens or content.
- No project data ever touches Whittle-run storage.

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

Whittle can do better because its source format is text-based parametric data (§8A.1).

**`HistoryStore`** has one interface and two backends:

- **GitHistory** (git connections; optional for local projects): isomorphic-git. Versions are commits, branches are git branches, releases are tags. It's fully interoperable with GitHub/GitLab/Forgejo pull requests, reviews and CI.
- **SnapshotHistory** (cloud drives and local-only projects): named versions are stored as compressed full snapshots in `.whittle-history/`, which syncs with the project. They form a commit DAG (id, parents, message, author, timestamp, content hash). You get the same features without needing git.

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

**Tablet (Shapr3D-class):**

- Full-bleed viewport.
- A slim left rail with tool groups.
- A context bubble near the selection showing 3–4 actions.
- A bottom sheet for the feature history.
- An inline numeric keypad that appears whenever a value is being edited.

**Phone:**

- The viewer comes first.
- A bottom sheet holds parts, parameters, measure, section, explode and export.
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
| App shell JS (gzip), initial route                          | ≤ 250 KB             |
| Time to interactive shell (cold, fast 4G, mid-range laptop) | ≤ 1.5 s              |
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
- **M3** (before M2.5, ADR-019): sketch-engineer (offset, convert entities, trim/extend, sketch fillet/chamfer, mirror) first ∥ kernel-engineer (shell, draft, sweep, loft, pattern/mirror tool shapes, hole, propagate toggle, kernel `import`, IGES) ∥ modeling-engineer (regen for the new types, reference axes/points/planes, linked-entity projection, hole tables) ∥ ui-engineer (inspectors, tools, Reference group, hole wizard). Then integration and the reference parts (§12A).
- **M4–M6:** as in §12.

---

## 12. Milestones & acceptance criteria

Each milestone ends with a reviewer gate. "Done" means every criterion is demonstrably met, with test evidence.

**Build order:** M0 → M1 → M2 → **M3 → M2.5** → M4 → M5 → M6 → M7. M3 runs before M2.5 at the user's request (2026-11-08, ADR-019). M3's "versions/snapshots" item therefore covers local, in-browser snapshots only; branches, compare and merge stay in M2.5.

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
- Undo/redo; local library; `.whittle` save and open; STL (binary/ASCII, per body or merged, quality presets), 3MF, GLB and STEP AP214 export; STEP import.
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
- Project folder format per §8A.1, with `.whittle` zip import/export.
- **Accept:**
  - A project edited on desktop (stored in Dropbox) shows the change on an iPad within 10 s of focusing the app.
  - Concurrent offline edits to _different_ features merge automatically. Edits to the _same_ parameter produce a conflict that the user resolves in the UI, with no data loss.
  - The geometric diff marks the correct added and removed regions on 5 fixture pairs.
  - A GitHub project round-trips commit → push → clone on another device → regenerate, with identical results (volume equal within 1e-9 relative).
  - A fuzz test of 1,000 random concurrent edit pairs never loses an edit.
  - Tokens are not readable in plain text from storage.

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

### M4 — Drawings

- Sheets and templates; base, projected, iso, section and detail views with exact HLR; centre marks; dimensions with tolerances; GD&T frames, datums, notes and a BOM placeholder; associativity; PDF, SVG and DXF export.
- "Import model annotations" places the PMI dimensions (from M5 data structures; start with feature dimensions) onto suitable views automatically.
- **Accept:**
  - A drawing of the bracket with three views, a section and full dimensions exports to a vector PDF that prints at 1:1 scale exactly (measured).
  - The DXF opens correctly in LibreCAD and QCAD.
  - Editing the model updates the drawing, and dangling dimensions are flagged.
  - Certification-style suite (§12A): for every reference part, the E2E recreates its spec drawing with Whittle's drawing tools. The views requested by the spec must be present and every specified dimension must appear with the same value.

### M5 — STEP AP242 with model dimensions (MBD/PMI)

- **MBD mode:** users annotate the 3D model with dimensions, tolerances, datums and geometric tolerances. Driving sketch and feature dimensions can be promoted to PMI in one tap.
- **Export pipeline** (in the kernel façade, through XDE/XCAF):
  1. Build an XCAF document: shapes with names, colours, units and the product structure.
  2. For each `PmiAnnotation`, resolve its `EntityRef`s to sub-shape labels. Create semantic entities with `XCAFDoc_DimTolTool` (`AddDimension` / `SetDimension` / `AddGeomTolerance` / `AddDatum`). Fill in the type, value, tolerance or fit, the annotation plane and the points through `XCAFDimTolObjects_*Object`.
  3. Generate **presentation PMI**: tessellated annotation geometry (lines plus stroked text), attached with `XCAFDoc_DimTolTool::SetGDTPresentations`. Viewers that only display presentation PMI then show the annotations. Without this step, the export contains only semantic PMI.
  4. Configure the writer for the AP242 schema (check the exact parameter API in the OCCT 8 data-exchange docs) and write with `STEPCAFControl_Writer`.
  5. Optionally write user-defined attributes: model parameters as properties.
- Follow the CAx-IF _Recommended Practices for the Representation and Presentation of PMI (AP242)_, which OCCT's XDE GD&T processing is based on.
- **Validation:**
  - Node round-trip tests with `STEPCAFControl_Reader`: dimension and tolerance counts, types, values and referenced faces all match.
  - Import the NIST MBE PMI test models (`test-fixtures/step/nist/`) and display their PMI. Note that OCCT has known gaps reading some third-party tolerance values; document what fails.
  - Manually validate the exports with the NIST _STEP File Analyzer and Viewer_ and at least one third-party CAD tool. Record the results in `docs/PMI_VALIDATION.md`.
- **Accept:** the bracket exports with ≥ 15 semantic dimensions or tolerances plus presentation. The round-trip is lossless in Whittle. The NIST analyzer reports no structural errors in the PMI entities.

### M6 — Assemblies

- Multi-part documents, instances, mates and DOF, exploded views, BOM, assembly drawings, assembly STEP (with PMI per part).
- **Accept:** a 25-part assembly reference model can be built, moved through its DOF, exploded, drawn and exported. The certification-style suite gains assembly stages: build from parts plus mates, then check the assembly mass and centre of mass.

### M7 — v1.0 hardening & polish

- Accessibility audit, performance pass, crash/fuzz tests (random feature edits, malformed STEP), docs site, sample gallery, and release automation.
- **Final test: the full certification-style run (§12A).** Every part, modification stage, drawing and assembly in the suite passes in CI. A human run of the real CSWA/CSWP practice exams in Whittle, timed against their limits, is recorded in `docs/CERTIFICATION_RUN.md`: what passed, what was slow, what couldn't be built.

### 12A. Certification-style test suite (CSWA/CSWP pattern)

A capability check modelled on the SolidWorks CSWA/CSWP exams, which test exactly what users need: build a part from a drawing, set the material, confirm the mass, apply parametric changes, recreate the drawing, and assemble. It grows with the milestones (M3 parts and mass, M4 drawings, M6 assemblies) and is the final test at M7.

- **Original content only.** The real exam and practice drawings are Dassault Systèmes' copyrighted material and are never committed or used in CI. The suite's parts and drawings are written for Whittle in the same style and difficulty. They live in `packages/test-fixtures/certification/`, licensed with the repo.
- **Each case has:** a spec drawing (SVG/PDF, plus the dimensions in JSON); the material and density; the expected mass (and centre of mass), computed independently in FreeCAD with the value and the script recorded; and CSWP-style modification stages (named dimension changes plus the expected new mass).
- **Pass criteria:**
  - mass within 0.1 % (the exams' own tolerance) at every stage;
  - the part built entirely through the UI by a scripted E2E;
  - from M4, the recreated drawing contains the spec's views and dimensions;
  - from M6, the assembly cases match mass and centre of mass.
- **Human run.** The real practice exams are run by a person in Whittle, timed, for M7, and the findings are fed back as issues. Nothing from those exams is stored in the repo.

---

## 13. Hosting roadmap

1. **Now:** GitHub Pages (static, PWA, service-worker COI shim).
2. **Early, alongside GitHub Pages:** one small, stateless **Cloudflare Worker** (free tier) that provides:
   - OAuth token exchange for providers that need a client secret (e.g. GitHub);
   - the git CORS proxy for isomorphic-git (§8A.2).

   This can ship while the app itself is still on GitHub Pages.
3. **Next:** Cloudflare Pages, with real COOP/COEP headers through `_headers`, preview deployments per PR, and a custom domain.
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
| License conflict when reusing Mycelium code (GPL-3.0)                              | ADR before M2.5: relicense the extracted module (author) or align Whittle's license                                                                                                                  |

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
