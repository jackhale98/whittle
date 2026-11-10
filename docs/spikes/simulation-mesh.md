# Spike S0 — meshing in the browser with Gmsh, round trip to CalculiX

Date: 2026-11-10 · PLAN §12B, ADR-058 · Code: [`spikes/simulation/`](../../spikes/simulation) (outside
the pnpm workspace; not run by `pnpm test`)

Scope note: the owner narrowed simulation to **desktop browsers** during the spike. Chrome and Edge
come first; Firefox and desktop Safari are covered as notes. iPad viability is out of scope. The
memory figures below are measured against the wasm32 4 GB ceiling, to decide whether memory64 is
needed.

## Headline

**Yes.** Gmsh 4.15.2 builds to WebAssembly against **the kernel's own OCCT 8.0.1 static
libraries**, inside the kernel's digest-pinned libcascade 3.1.0 image. It meshes the demo bracket
in a worker, in both Node and Chromium, with physical groups named after Wren's persistent face
names.

- **Download:** 3.69 MiB brotli. It is a lazily loaded worker, separate from the kernel.
- **Speed:** a 300k-tet quadratic mesh takes **4.5 s** (HXT) to 12 s (Delaunay) in a Chromium
  worker. Wasm runs at the same speed as the native pip-wheel Gmsh, within noise.
- **Memory:** peak Wasm memory is about **160 MB at 300k tets** and **1.0 GB at 2.5M tets**.
  wasm32 therefore holds about 9M quadratic tets, which is beyond what a desktop CalculiX run can
  sensibly solve, so **memory64 is not worth it for S1**.
- **Mesh agreement:** element counts match native Gmsh within 0.5%.
- **Validation:** the CalculiX round trip matches Euler-Bernoulli within 0.23–0.50% at every mesh
  size, and the bracket changes by 0.26% between two mesh sizes.

## Versions

| Component                  | Version / source                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Wren kernel                | OCCT 8.0.1, build `c7fd51b6fc3ed8a8`, `packages/kernel/dist` (single-threaded variant)                              |
| Gmsh (Wasm)                | 4.15.2 source, sha256 `be3f66f2…bdd3e`, fetched by `wasm/fetch-gmsh.sh`                                             |
| Toolchain                  | `ghcr.io/taucad/opencascade.js@sha256:d7bf97ad…900b` (libcascade 3.1.0 single-threaded, Emscripten 6.0.5)          |
| Gmsh (native, reference)   | pip wheel `gmsh==4.15.2`; it bundles **OCC 7.8.1**, not 8.0.1 (this explains part of the native/Wasm count difference) |
| CalculiX                   | `ccx` 2.21 (Ubuntu 24.04 `calculix-ccx` 2.21-1, SPOOLES solver)                                                     |
| Browser                    | Playwright Chromium 153.0.8010.12 headless                                                                          |
| Machine                    | 4 shared cores, every run at `nice -n 19`; build in Docker `--cpus 2`                                               |

## 1. Native pipeline (round trip)

1. **Export** (`export/export.test.ts`). The real regen engine runs on the demo bracket and on a
   250 × 10 × 10 mm cantilever. Each part is written as BRep, STEP and `faces.json`, which holds
   TopExp-ordered faces with persistent name, area, centroid and normal. The material is Wren's
   `whittle:aluminium-6061-t6` entry: E = 68.9 GPa, ν = 0.33, ρ = 2.70 g/cm³. The library already
   has E and ν, so nothing needed adding.
2. **Mesh** (`native/mesh.py`). The BRep is imported through Gmsh's OCC kernel. Each Gmsh surface
   tag is matched to a Wren face by area and centroid; the match must be one-to-one, otherwise the
   script stops. There is one physical surface group per face, named with its persistent name,
   plus a physical volume `solid`. The mesh is second order (`ElementOrder 2`, mid-side nodes on
   the true geometry), with the size set by `MeshSizeMax`, `MeshSizeMin = h/10` and 12 elements
   per 2π of curvature. In practice Gmsh's tag equals TopExp index + 1.
3. **Deck** (`ccx/inp.ts`). The writer produces C3D10 elements with the Gmsh-to-Abaqus node order:
   the last two mid-side nodes swap. The order is checked geometrically, and orientation is
   checked by signed volume (0 flips were needed).
   - Constraints and loads refer to persistent names only; an unknown name throws "needs
     attention".
   - A load is a total force spread uniformly over a face's area. For tri6, the consistent nodal
     forces are 0 at the corners and A/3 at each mid-side node.
4. **Solve and read**. `ccx` runs from `ccx/run.ts`. `ccx/frd.ts` parses the fixed-width ASCII
   `.frd`: node block, DISP and STRESS, with von Mises derived from the stress components.

### (a) Cantilever vs Euler-Bernoulli

Clamped x = 0 face (sketch line L4), P = 10 N in −z on the x = L face (L2). δ_EB = PL³/3EI =
0.90711 mm; Timoshenko (κ = 5/6) 0.90827 mm.

| Mesh (h, mm) | tets   | nodes  | tip δ (mean, tip face) | vs Euler-Bernoulli | vs Timoshenko | top-fibre σxx / analytic | ccx solve |
| ------------ | -----: | -----: | ---------------------: | -----------------: | ------------: | -----------------------: | --------: |
| 10           |    503 |  1,124 |              0.90254 mm |            −0.50 % |       −0.63 % |                   0.9997 |    0.1 s |
| 5            |    974 |  2,259 |              0.90409 mm |            −0.33 % |       −0.46 % |                   0.9999 |    0.3 s |
| 2.5          |  9,018 | 16,448 |              0.90472 mm |            −0.26 % |       −0.39 % |                   1.0000 |    2.3 s |
| 1.25         | 62,598 | 98,901 |              0.90506 mm |            −0.23 % |       −0.35 % |                   1.0000 |     32 s |
| 2.5 (Wasm mesh) | 9,009 | 16,434 |            0.90472 mm |            −0.26 % |       −0.39 % |                   1.0000 |    2.0 s |

- The results converge monotonically from below and are within 2% even at one element per
  section.
- The remaining −0.3% vs Timoshenko comes from the fully clamped face, which suppresses the
  Poisson contraction at the root (a stiffening boundary effect, not a discretisation error).

### (b) Bracket, two mesh sizes

Study: the four bolt bores are fixed (`F…:side(S…:e(H1..H4))`). The load is 200 N in −y on the
upright's top face (`F<upright>:end`).

| Mesh               | tets   | nodes  | tip uy (mean, load face) | max \|u\|  | max von Mises | ccx solve |
| ------------------ | -----: | -----: | -----------------------: | ---------: | ------------: | --------: |
| h = 4, native      | 19,334 | 32,444 |             −0.040587 mm | 0.042151 mm |     29.39 MPa |     7.1 s |
| h = 4, **Wasm**    | 19,234 | 32,300 |             −0.040585 mm | 0.042148 mm |     29.50 MPa |     7.3 s |
| h = 2, native      | 46,718 | 74,771 |             −0.040692 mm | 0.042237 mm |     30.11 MPa |      35 s |

- Displacement changes by 0.26% between h = 4 and h = 2.
- Peak von Mises changes by 2.4%. That is expected: the peak sits at the bore and fillet stress
  raisers and converges more slowly than displacement.
- The Wasm mesh and the native mesh give the same answer to 0.006% in displacement.

## 2. Gmsh to WebAssembly

### Build

`wasm/build.sh single` runs one container of the kernel's pinned image. It uses the image's
`/opencascade.js/build/occt-libraries/libTK*.a` and `occt-includes`, plus the kernel's codegen
flags: `-O3 -fwasm-exceptions -msimd128 -DOCCT_NO_DUMP`.

- **Configure:** `-DDEFAULT=0` plus `MESH OCC(static, no CAF) HXT NETGEN EIGEN ANN BUILD_LIB`.
  There is no FLTK, PETSc, Fortran, OpenMP, MED/CGNS, parser, post-processing or plugins. The
  resulting build options are `ANN Dlopen Eigen Hxt Mesh Netgen OpenCASCADE TetGen/BR`.
- **Toolkits linked:** the 21 OCCT toolkits Gmsh's CMake requires for OCCT ≥ 7.8, passed
  explicitly via `OCC_LIBS`, because the Emscripten toolchain file confines `find_library` to the
  sysroot.
- **Time:** 347 objects compile in about 6 min at `-j2`. Linking `wren_mesh.cpp` plus `libgmsh.a`
  plus OCCT takes 107 s, including emcc's wasm-opt. The build tree is 103 MB.

The OCCT 8 / toolchain changes that were needed are all small. They are applied to the fetched copy
by `build-in-container.sh`, or provided as headers in `wasm/occt8-compat/`.

| Problem                                                                                                 | Cause (OCCT 8.0 `dox/upgrade/upgrade.md`)                                                                    | Fix                                                                       |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `std::optional` / `std::in_place` missing in `NCollection_*.hxx`                                        | OCCT 8 needs C++17; Gmsh pins `set(CMAKE_CXX_STANDARD 14)`                                                   | sed to 17 (cannot be overridden with `-D`)                                |
| `TopTools_DataMapIteratorOf…`, `TopTools_ListIteratorOfListOfShape` headers missing                     | §upgrade_800_collections_typedefs: iterator typedefs now live (deprecated) in the map/list headers           | 3 forwarding headers                                                      |
| `Geom2dLProp_CLProps2d.hxx` missing                                                                     | §upgrade_800_lprop_gprop: `Geom2dLProp` removed, now `GeomLProp_CLProps2d`                                   | alias header                                                              |
| `Handle_HeaderSection_FileName`, `Handle_Standard_Transient`, … unknown; `TopTools_MapOfShape` unknown | §upgrade_800_handle: the `Handle_X` typedefs are gone (`occ::handle<X>`); fewer transitive includes          | `gmsh_occt8_prelude.hxx` (7 typedefs + includes), injected into `GModelIO_OCC.cpp` |
| `tiny_obj_loader.h` not found                                                                           | Gmsh bug: `GModelIO_OBJ.cpp` includes it even with `ENABLE_TINYOBJLOADER=0`                                 | include by relative path                                                  |
| ccx `*ERROR reading *NODE`                                                                              | CalculiX reads ≤ 20 characters per number; full-precision doubles are 22                                     | `toExponential(11)` in the deck writer                                    |

Gmsh uses none of the APIs that OCCT 8 removed outright (`Standard_Failure::Raise/Caught`,
`NCollection_Map::Seek`, `TColGeom*`, `BRepMesh_PluginMacro`). The deprecations (for example
`GetMessageString`) only produce warnings. All of these patches should go upstream to Gmsh.

### Tiny API (`wasm/wren_mesh.cpp`, plain `extern "C"` + `cwrap`-style calls)

| Call                                               | Does                                                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wm_load_brep(path)`                               | Reads BRep bytes from MEMFS and hands the `TopoDS_Shape` to Gmsh by pointer (`importShapesNativePointer`). Each Gmsh face's native `TopoDS_Face` is then looked up in `TopExp::MapShapes(shape, FACE)` (`IsSame`), so TopExp index → tag is **exact, not geometric**. Returns the face count. |
| `wm_name_face(i, name)`                            | Physical surface group named with the persistent name of TopExp face `i`                                                                                                  |
| `wm_set_option(name, v)`, `wm_set_face_size(i, h)` | Global size controls (any Gmsh numeric option); per-face size at the face's points                                                                                         |
| `wm_mesh(order)`                                   | 3D mesh at order 1 or 2; fills nodes (f64 xyz), tet10 (u32) and per-group tri6 (u32) buffers                                                                              |
| `wm_count` / `wm_ptr`                              | Lengths and heap pointers; JS views them as typed arrays (zero copy until transfer)                                                                                        |
| `wm_last_error()`                                  | `{"code","message"}` JSON. Every entry point catches `Standard_Failure` (now a `std::exception`), `bad_alloc`, `std::exception` and `...`. Gmsh runs with `General.AbortOnError = 3`, so it throws rather than calling `exit()`. |

### Sizes (`wasm/size.mjs`)

| Artefact         |       raw |     gzip |   brotli |
| ---------------- | --------: | -------: | -------: |
| `wren-mesh.wasm` | 15.84 MiB | 5.17 MiB | 3.69 MiB |
| `wren-mesh.js`   |    92 KiB |   25 KiB |   23 KiB |

For comparison, the kernel is 4.54 MiB brotli. The mesher carries its own copy of the OCCT code it
needs: topology and geometry, plus the STEP and IGES readers that Gmsh's file I/O pulls in. Trimming
those is S1 work (see Risks).

### Mesh time and memory — demo bracket, quadratic tets, one thread

Peak Wasm memory is the final `WebAssembly.Memory` size; it only grows, so the final size is the
peak. "≤ 64" means it never grew past the initial 64 MB. Native RSS is measured right after
`generate()` (the Python process before meshing is 79.5 MB).

**HXT (`Algorithm3D = 10`)**: recommended.

| Target | h (mm) | native tets | native time | native ΔRSS | Wasm (Node worker) tets | Wasm time | Wasm peak memory | Chromium worker time |
| ------ | -----: | ----------: | ----------: | ----------: | ----------------------: | --------: | ---------------: | -------------------: |
| ~20k   |   4    |      19,171 |      0.40 s |      +18 MB |         19,109 (−0.3 %) |    0.62 s |          ≤ 64 MB |               0.80 s |
| ~100k  |   1.4  |      96,698 |      1.65 s |      +53 MB |         96,423 (−0.3 %) |    1.70 s |          ≤ 64 MB |               2.02 s |
| ~300k  |   0.95 |     284,525 |      5.19 s |     +145 MB |        285,473 (+0.3 %) |    5.18 s |           159 MB |               4.55 s |
| ~850k  |   0.65 |           — |           — |           — |                 850,525 |    16.4 s |           438 MB |                    — |
| ~2.5M  |   0.45 |           — |           — |           — |               2,481,534 |    46.0 s |         1,005 MB |                    — |

**Delaunay (`Algorithm3D = 1`)**: Gmsh's default.

| Target | h (mm) | native tets | native time | native ΔRSS | Wasm (Node worker) tets | Wasm time | Wasm peak memory | Chromium worker time |
| ------ | -----: | ----------: | ----------: | ----------: | ----------------------: | --------: | ---------------: | -------------------: |
| ~20k   |   4    |      19,334 |      0.54 s |      +16 MB |         19,234 (−0.5 %) |    0.72 s |          ≤ 64 MB |               1.04 s |
| ~100k  |   1.4  |     104,896 |      3.64 s |      +75 MB |        104,728 (−0.2 %) |    3.39 s |            80 MB |               4.01 s |
| ~300k  |   0.95 |     316,898 |      15.4 s |     +182 MB |        315,914 (−0.3 %) |    12.5 s |           168 MB |               12.2 s |
| ~950k  |   0.65 |           — |           — |           — |                 953,154 |    48.1 s |           450 MB |                    — |

Further results:

- **Load time.** Compile and instantiate from local disk takes 72–135 ms in a Node worker. In a
  Chromium module worker it takes 135–226 ms, measured from localhost (fetch, compile and
  instantiate, cold, no network). Over a real network the 3.69 MiB brotli download dominates; after
  that the service worker cache applies.
- **Process memory.** Node worker process peak RSS is 236–374 MB up to 300k tets. That covers the
  Node runtime, the compiled code and the JSON export of the mesh.
- **Native vs Wasm meshes.** Element counts are within ±0.5% at every size and for both
  algorithms. The surface meshes differ by 0.3% (6,742 vs 6,722 triangles at h = 4). The native
  wheel uses OCC 7.8.1 and the Wasm build OCCT 8.0.1, so part of the difference is the OCC
  version. Within the Wasm build, Node and Chromium produce identical counts (the build is
  deterministic).
- **Wasm vs native speed.** Wasm is no slower than the native wheel; it was faster at 300k tets
  with Delaunay (12.5 s vs 15.4 s). Plausible reasons are mimalloc and the wheel's generic build
  flags. Do not read this as Wasm being faster in general.
- **Names.** Every run in Node and Chromium round-tripped all 19 persistent names through the
  physical groups. Gmsh's tags equalled TopExp index + 1, and the API no longer relies on that.
- **Netgen frontal 3D.** It is in the same Wasm build (`Algorithm3D = 4`): 32,341 tets at h = 4 in
  1.5 s, 77 MB. No separate Netgen port is needed as a fallback mesher.
- **Element quality.** The linear mesh is clean: min SICN 0.28, no element below 0.1 at h = 4.
  Order-2 min SICN is 0.008 (2 elements), caused by curving mid-side nodes onto the fillets and
  bores. Gmsh's high-order optimiser (`Mesh.HighOrderOptimize = 2`, needs `ENABLE_OPTHOM`) raises
  it to 0.068 natively. S1 should enable OPTHOM and show the quality.

### Threads

Not built. Every parallel code path in Gmsh is OpenMP: 36 source files, and 145 `#pragma omp` in
HXT alone. Gmsh has no `std::thread` or pthreads parallelism, and Emscripten ships no OpenMP
runtime. A `-pthread` build would mesh exactly as fast as the single-threaded one. A threaded
mesher would need an OpenMP runtime ported to Emscripten pthreads (libomp has no supported Wasm
target), which is not feasible in a spike. The gain is also small: native HXT at 300k tets went
from 5.19 s to 4.48 s with 2 threads (−14%), because the 1D/2D and high-order stages are serial.
Benefit: the mesher worker **needs no COOP/COEP**. The Chromium run above was cross-origin
isolated, but nothing in the mesher depends on that.

### Desktop browsers and the 4 GB ceiling

- **Chrome and Edge** (same engine; measured in Chromium 153). Everything above works.
  `MAXIMUM_MEMORY = 4GB` is the wasm32 limit, and measured memory is about 0.4 KB per quadratic
  tet including nodes. The ceiling therefore sits around 9M tets (HXT) or about 8M (Delaunay),
  allowing for growth headroom.
- **Memory64: not worth it for S1.**
  - A 2.5M-tet quadratic mesh (about 10.4M DOF) already needs tens of GB of RAM to solve with
    CalculiX's direct solver on the user's desktop. Meshes beyond about 5M tets belong on the
    "Mesh on this computer" path (PLAN §12B).
  - memory64 costs bounds-check performance and doubles pointer size.
  - It is not available in every desktop browser (Chrome and Firefox ship it; check desktop Safari
    before relying on it).
- **Firefox and desktop Safari: not measured** (no browsers on this machine). The build uses only
  features both support: Wasm SIMD, Wasm exception handling in the toolchain's legacy-EH encoding,
  memory growth to 4 GB, and module workers. It does not use SharedArrayBuffer. Expect them to
  work, but verify in S1 CI before claiming support.

## 3. What failed or was not done

- **Threaded build:** skipped as pointless, since Gmsh parallelism is OpenMP only (see above).
- **Netgen as a separate fallback:** not needed. Gmsh worked, and its contrib Netgen frontal 3D is
  already inside the build.
- **Firefox and Safari:** not measured.
- **Size breakdown:** not attempted. The share of the 3.69 MiB taken by the STEP/IGES readers is
  unmeasured.
- **Build fixes:** the first builds failed on the OCCT 8 API changes listed above. Each fix took
  minutes, and none touched OCCT itself or the kernel.

## 4. Recommendation for S1

1. **Mesher: Gmsh 4.15.x, HXT by default, Delaunay as fallback, Netgen frontal as the third
   option.** Single-threaded, in its own lazily loaded module worker. Build it in the kernel's
   pinned libcascade image against the image's OCCT static libraries, as here: same OCCT version
   and flags as the kernel, no second OCCT build to maintain. Send the 4 compat headers, the
   prelude, the C++17 bump and the OBJ include fix upstream to Gmsh, so the patch set shrinks to
   nothing.
2. **Handover:** the kernel worker exports BRep bytes plus TopExp-ordered persistent face names
   (and edge names, for edge controls). The mesher worker maps them exactly via `IsSame`, as
   `wren_mesh.cpp` does. Results go back as transferred typed arrays: nodes f64, tet10 u32, and
   per-group tri6 u32.
3. **Build hygiene:**
   - Cache `libgmsh.a` in CI the way the kernel caches its build.
   - Link with `-O3` (wasm-opt `-O4` is optional).
   - Add `ENABLE_OPTHOM` for high-order untangling and optimisation.
   - Run a size-report gate like the kernel's, with a budget of about 5 MiB brotli.
4. **Solver handoff:** keep the S0 deck writer's rules:
   - names only, unknown name means "needs attention";
   - consistent tri6 loads;
   - geometric node-order and orientation checks;
   - 20-character number fields.
   For results, the ASCII `.frd` reader is enough. Binary `.frd` (`OUTPUT=BINARY`) and `*EL FILE`
   integration-point output are S1 work.

## 5. Risks

- **Size.** 3.69 MiB brotli on top of the kernel's 4.54 MiB; it loads only when a study opens.
  Likely trims:
  - drop Gmsh's STEP/IGES/XAO readers by patching `GModelIO_OCC`;
  - drop the TKDESTEP/TKDEIGES/TKXSBase/TKHLR toolkits;
  - wasm-opt `-Oz`.
  Sharing one OCCT copy would need either one module, which puts the mesher in the kernel worker
  (PLAN forbids that), or Emscripten dynamic linking with side modules (bigger and slower). Two
  independent modules is the simple choice.
- **Memory.** Not a risk on desktop up to about 8M tets. The worker must handle `bad_alloc`
  (mapped to `OUT_OF_MEMORY`) and a Wasm trap (recreate the module).
- **Robustness.** Gmsh can still abort or trap on pathological geometry. A trap kills the module
  but not the worker; cancellation means terminating the worker. Neither was hit on the bracket.
- **Threads and COOP:** none needed by the mesher (see Threads).
- **OCCT drift.** The patches target OCCT 8.0.1; an OCCT bump in the kernel image needs a Gmsh
  re-check. That is cheap: compile errors appear in `GModelIO_OCC.cpp` and `OCCEdge.cpp` only.
- **Licence.**
  - Gmsh is GPL-2.0-or-later with an exception for Netgen, METIS, OpenCASCADE and ParaView.
    Bundled parts: HXT (UCLouvain, under Gmsh's licence), ANN (LGPL), Eigen (MPL-2.0) and the
    contrib Netgen (LGPL-2.1).
  - TetGen/BR boundary recovery is Hang Si's code, **relicensed to Gmsh's terms** by agreement
    (`CREDITS.txt`), so it is not AGPL TetGen. ADR-058's TetGen exclusion is not triggered.
  - All of this is compatible with Wren's GPL-3.0-or-later. Shipping the binary means GPL
    source-offer obligations for Gmsh plus a DEPENDENCIES.md and third-party-notices entry.
  - CalculiX (GPL-2.0+) is not bundled.

## 6. Rough S1 effort (one agent team)

| Work                                                                                                                   | Estimate      |
| ---------------------------------------------------------------------------------------------------------------------- | ------------- |
| Mesher package: CI build in the kernel image, size gate, OPTHOM, worker plus typed-array API, progress, cancel, error mapping | 1.5–2 weeks   |
| Mesh controls (global, per face/edge, curvature), quality metrics, viewport preview                                    | 2 weeks       |
| Study model in contracts (lead), materials with E/ν/yield/thermal, load and constraint tools on persistent names       | 2 weeks       |
| CalculiX deck writer (static, modal, thermal), case folder with `run.sh`/`run.bat`, result import (frd ASCII and binary) | 1.5–2 weeks   |
| Results viewer (colour maps, deformed shape, mode animation, probes, sections)                                         | 2–3 weeks     |
| NAFEMS LE1/LE10/FV52 and analytic golden tests running `ccx` in CI                                                     | 1 week        |
| **Total**                                                                                                              | **10–12 weeks** (the Runner is S2) |

## 7. Reproduction

Run from the repo root unless noted. Each step needs the previous one's outputs, written to
`spikes/simulation/out/` (gitignored).

```sh
pnpm i                                   # and a built kernel: pnpm kernel:build (or a dist/ from CI)
node_modules/.bin/vitest run --config spikes/simulation/vitest.config.ts   # export → out/{beam,bracket}

# Native tools (Ubuntu 24.04)
apt-get install -y calculix-ccx libglu1-mesa libxcursor1 libxinerama1 libxft2
python3 -m venv /tmp/venv && /tmp/venv/bin/pip install gmsh==4.15.2

cd spikes/simulation
/tmp/venv/bin/python native/mesh.py out/beam native-h2.5 --size 2.5        # [--algo3d 10] [--no-json]
node ccx/run.ts out/beam native-h2.5                                         # deck, ccx, frd → result.json
/tmp/venv/bin/python native/mesh.py out/bracket native-h4 --size 4 && node ccx/run.ts out/bracket native-h4

# Wasm (Docker; the kernel's libcascade image must be pulled)
wasm/build.sh single                     # STAGE=configure|lib|link|all; JOBS=2; GMSH_SRC_DIR to reuse a source copy
node wasm/size.mjs single
node wasm/mesh-node.mjs out/bracket wasm-h4 --size 4 --algo3d 10   # Node worker; stats.json + mesh.json
node ccx/run.ts out/bracket wasm-h4                                 # solve the Wasm mesh
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node wasm/browser/run.mjs bracket 4 single 10   # Chromium worker
```

Sizes used for the tables: h = 4, 1.4 and 0.95 mm (about 20k, 100k and 300k tets), plus 0.65 and
0.45 mm for the memory ceiling.
