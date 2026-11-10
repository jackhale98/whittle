# Structural FEA best practices for Wren (S1: CalculiX + built-in Gmsh)

Research report, 2026-11-10. It feeds PLAN §12B (S1) and ADR-062. The cited findings, with a URL for each claim, are in `docs/ux-research/research_notes/Structural FEA best practices/`:

- `calculix.md`: CalculiX 2.21–2.23 manuals, the FreeCAD writer source, distro packaging.
- `gmsh_meshing.md`: the Gmsh 4.15.2 reference manual and changelog, the INP exporter source, the mailing list, the HXT papers.
- `fea_theory_validation.md`: NAFEMS benchmarks as reproduced in free vendor manuals, ESRD, ASME V&V 10, and singularity and convergence guidance.
- `pre_post_ux.md`: the PrePoMax 2.4 manual, FreeCAD FEM, SOLIDWORKS, Fusion, Onshape, Inventor and SimScale.

This report is the synthesis and states Wren's decisions. Where a point is our inference and not a sourced fact, it is labelled as such.

## 1. The short version

Most wrong FEA results in CAD tools do not come from the solver. They come from five things:

1. bad boundary conditions (over-constrained or under-constrained);
2. stress singularities read as real stress;
3. meshes that are too coarse where it matters;
4. unit mistakes;
5. a linear analysis used past its limits: large deflection, yield, contact.

CalculiX is a solid, verified solver. What decides whether Wren's results can be trusted is everything around it. So S1 is built around **guard rails a non-expert cannot miss**:

- **Before the solve:** checks that block a run that cannot succeed or cannot mean anything.
- **After the solve:** a "Results checks" panel on every result (reaction balance, mass check, mesh error estimate, singularity markers, a large-deflection warning, a yield warning).
- **Convergence:** a one-click convergence check.
- **CI benchmarks:** a benchmark suite that runs the real solver.

The setup itself rests on what Wren already does better than every tool surveyed: loads and constraints live on persistent face names. Fusion and FreeCAD users lose loads when the design changes. PrePoMax keeps geometry-based selections through a remesh, but they can land on the wrong face when the geometry itself changes. For Wren, a lost reference makes the study "needs attention", and a load never moves silently to another face.

## 2. Pre-processing

### 2.1 Study types in S1

| Study | CalculiX step | Notes |
|---|---|---|
| Linear static | `*STATIC` | Small deflection and linear-elastic material. Multiple load cases are separate steps, or separate studies in S1. |
| Modal (natural frequencies) | `*FREQUENCY` with N modes | Requires density. ccx returns N modes and does not guarantee a frequency range, so for "all modes below f" Wren checks the highest frequency returned and re-runs with more modes. Free-free runs are allowed, and Wren expects exactly 6 rigid-body modes. |
| Steady thermal | `*HEAT TRANSFER, STEADY STATE` | Temperature, convection (`*FILM`), heat flux (`*DFLUX`), heat load and radiation (`*RADIATE`) on faces. |

Later steps (extension track): prestressed modal and linear buckling (a static step, then `*STEP, PERTURBATION` + `*FREQUENCY`/`*BUCKLE`); thermal stress (switch to C3D10T, with `*INITIAL CONDITIONS` and `ZERO=` always written); nonlinear material; bonded assemblies (`*TIE`).

### 2.2 Materials and units

- **CalculiX has no units.** Wren writes every deck in one consistent system: mm, N, s, K, with stress in MPa and density in t/mm³. The material library stores SI with explicit units and converts when writing the deck. Most user unit mistakes are density (×1e-12 from kg/m³) and film coefficient (×1e-3). Because Wren's own inputs already carry units, users never type a bare number into the deck. The deck header records the unit system as a comment.
- **Library fields:**
  - E and ν (isotropic in S1);
  - density;
  - yield strength and ultimate strength;
  - a ductile/brittle flag, which picks von Mises or maximum principal stress as the default safety-factor criterion;
  - thermal expansion, conductivity and specific heat;
  - a source and notes field.
- **Library contents:** a small curated library of common steels, aluminium, titanium, brass, ABS, PLA, PETG and nylon, each with a cited source. Users can create, import and export their own materials as a shareable file (PrePoMax uses this pattern).
- **Missing values:** a missing value the study needs blocks the run with a plain message, for example "Modal needs density for Aluminium 6061".
- **Plastics:** typical values carry a "typical, check your supplier's datasheet" note, because 3D-printed parts are anisotropic and S1 is isotropic.

### 2.3 Supports and loads (on persistent names)

| Wren tool | Writes | Rules |
|---|---|---|
| **Fixed** (face, edge or vertex) | `*BOUNDARY` on the face's node set, DOF 1–3 | The UI explains that a fixed face is perfectly rigid: it over-stiffens and puts a singularity at its edge (§4.2). |
| **Slider / symmetry** (planar face) | `*BOUNDARY` on the normal DOF | A face not aligned with the global axes needs `*TRANSFORM` on its nodes. Symmetry is offered only on planar faces. |
| **Pin / hinge** (cylindrical face) | `*TRANSFORM, TYPE=C` + `*BOUNDARY` on radial and axial DOFs | Rotation about the axis stays free. |
| **Elastic support** (face) | Springs to ground (`*SPRING` per node, from a stiffness per unit area) | For "the real support is not rigid". |
| **Enforced displacement** | `*BOUNDARY` with a value | |
| **Force** (total N on a face) | Consistent nodal loads: for a uniform traction on 6-node triangles, corners get 0 and each mid-side node A_tri/3 | **Always a total over the selection.** PrePoMax's force is per node, which traps users. Never lump the force equally onto nodes: on C3D10 corner nodes carry no uniform-traction load. The spike's writer already does this. |
| **Pressure** | `*SURFACE, TYPE=ELEMENT` (element + face id S1–S4), then `*DSLOAD`; or `*DLOAD` with `Pk` lines (the FreeCAD path) | Wren computes face ids from the boundary-triangle-to-tet adjacency. Gmsh's INP export writes no surfaces. |
| **Remote force / moment** | A reference node + `*COUPLING` + `*DISTRIBUTING` (or `*KINEMATIC` for a rigid connection), with `*CLOAD` on the reference node | Glyph at the remote point. Avoid `*DISTRIBUTING COUPLING` on large faces (meant for about 50 nodes at most). ccx does not report reactions on kinematic reference nodes, so use `*SECTION PRINT`. |
| **Bearing load** (cylindrical face) | Per-element cosine-distributed pressure over the loaded half (computed by Wren) | ccx has no native bearing keyword. The glyph shows the direction. |
| **Gravity** | `*DLOAD` GRAV on all elements | Requires density. |
| **Rotation (centrifugal)** | `*DLOAD` CENTRIF | Requires density, axis and speed. |
| **Temperature / convection / heat flux / heat load / radiation** | `*BOUNDARY` DOF 11, `*FILM`, `*DFLUX`, `*CFLUX`, `*RADIATE` | Film coefficient in W/(m²·K) at entry, converted when writing. |

Bolt preload, contact and bonded assemblies are out of S1. The ccx keywords exist (`*PRE-TENSION SECTION`, `*CONTACT PAIR`, `*TIE`) and come with assemblies after M6.

**Glyphs:** every support and load is drawn on its faces (arrows, hatching, pins), sized in screen space, with its value. Hovering a glyph highlights its faces. "Needs attention" glyphs draw dashed in the warning colour, where the face used to be.

### 2.4 Mesh: defaults, controls and quality policy

- **Elements: second-order tetrahedra (C3D10) only in S1.** The manual says first-order C3D4 is "too stiff, please use the 10-node tetrahedral element instead". Linear tets lock in bending. C3D10T is used once thermal stress arrives. Shells and beams are deferred: ccx expands them into 3D bricks internally, which brings renumbered output nodes, "knots", lost drilling moments and no `*TIE`, so they need their own careful design.
- **Global size:** a Coarse / Medium / Fine slider maps to `MeshSizeMax` = h from the part's bounding box (with an exact-value override that accepts expressions with units). `MeshSizeMin` ≈ h/30 stops tiny fillets from exploding the element count. Curvature sizing (`MeshSizeFromCurvature`) at about 16 elements per 2π. The exact numbers are inferred and are tuned on the benchmark parts.
- **Local refinement:** on named faces and edges, a Distance → Threshold field (with Sigmoid) is added, and Gmsh's other size sources are turned off as the manual advises. Refinement on an unresolved name blocks and shows "needs attention".
- **Thin walls:** Wren estimates wall thickness from the BRep (opposed-face distance) and keeps size ≤ t/2, so that at least 2 C3D10 layers span the wall. A badge says "thin wall: refined to 2 layers" instead of refining silently. Sources disagree on 1 vs 3 layers; 2 quadratic layers is a common middle position.
- **Algorithms:**
  - 2D: Frontal-Delaunay. Gmsh switches to MeshAdapt automatically when a surface fails.
  - 3D: Delaunay. HXT needs Wasm threads, which the spike runs without.
  - Fallback ladder in the worker:
    1. retry the other 3D algorithm;
    2. retry with 2D Delaunay, which copes better with steep size gradients;
    3. retry with a larger `MeshSizeMin`;
    4. if it still fails, report the failing faces by persistent name.
  - Netgen-frontal and MMG3D are not used, because they ignore size fields.
- **Second order and curving:** the mesh is elevated to order 2 with mid-side nodes on the exact geometry, then `HighOrderOptimize = 2` (elastic plus optimisation). Quality policy, on minSICN and minDetJac from `getElementQualities`:
  - **minDetJac ≤ 0 (invalid):**
    1. refine the offending fillet faces (size ≈ r/2) and re-mesh;
    2. if still invalid, fall back to straight-sided C3D10 (`SecondOrderLinear`) and show a "straight-sided elements on curved faces" notice;
    3. never send an invalid mesh to ccx. FreeCAD's most common ccx failure is "nonpositive jacobian".
  - **0 < minSICN < 0.1:** accept, with a "low-quality elements" warning that can show where they are.
  - **≥ 0.1:** OK. This matches Gmsh's own optimiser target.
  - The spike's bracket (minSICN 0.068 after optimisation) falls in the warning band. Local fillet refinement is the fix at the root.
- **Healing and defeaturing:**
  - **No OCC healing by default.** Wren's BReps are native, and healing renumbers entities, which breaks the face-name map.
  - **Small fillets and holes:** where they fall below MeshSizeMin, Wren offers "Suppress in study". It suppresses the CAD feature in a study-only configuration, so the change persists, is explicit and is versioned.
  - **Faces that carry loads or supports are never suppressed automatically.**
  - Compound meshing of small faces is a later option.
- **Quality report:** element and node counts, an estimated number of solver unknowns (DOF), minSICN with its 1st percentile and the counts below 0.1 and 0.2. A "show worst elements" control highlights them in the viewport.
- **Determinism:** CI and golden tests run single-threaded with a fixed seed and compare a hash of the mesh. The spike's ±0.5% variation is to be confirmed as a threading artefact.

### 2.5 Pre-run checks (block or warn before a run)

Inferred from ccx failure modes and from what FreeCAD and PrePoMax catch. All of these run in the browser before Wren writes the deck.

| Check | Severity |
|---|---|
| Every body has a material, and the material has every value the study needs (density for modal, gravity or rotation) | Block |
| Rigid-body motion: a static study's supports must restrain all 6 rigid-body motions (checked on the support set), and the mesh must be one connected region (a union-find over elements) | Block, offering "run a modal study instead" or "add a support" |
| Every load and support resolves to a non-empty node or face set | Block ("needs attention") |
| Mesh valid (minDetJac > 0) | Block |
| Mesh quality below the target | Warn |
| Thin-wall layers < 2 | Warn |
| Estimated DOF over the backend's limit (SPOOLES needs about 32 GB per 1M equations): for static or thermal studies offer the iterative solver (bulky parts only); for modal, advise a coarser mesh or a PARDISO/PaStiX build | Warn or block |
| Opposing loads: applied loads sum to zero in a fully free direction. This is unusual in a static study but legitimate when supports carry no net load | Info |

## 3. Solving

- **Wren writes the `.inp` itself.** Gmsh's export writes the boundary triangles as CPS6 plane-stress elements (wrong in a 3D model) and writes no element-face surfaces. Writing the deck ourselves also keeps our naming.
- **The writer:**
  - **Numbering and node order:** nodes and elements are numbered contiguously from 1 (ccx's memory scales with the largest id). The Gmsh tet10 node order is converted to ccx's, swapping the last two mid-side nodes; the spike already does this and checks it geometrically.
  - **Set names:** sanitised (ASCII, no commas, `=` or spaces, ≤ 80 characters, unique after upper-casing, with room for ccx's internal suffixes). Each persistent face name maps to a short stable id, with a `**` comment carrying the full name.
  - **Header:** the deck header records Wren's version, the unit system and a hash of the study inputs.
- **Outputs requested:**
  - **Static:**
    - `*NODE FILE` U, RF;
    - `*EL FILE` S, E, keeping ccx's error estimator;
    - `*NODE PRINT, TOTALS=ONLY` RF per support set, for reaction balance (RF on a node set that also carries loads includes those loads, so it is requested only on supports);
    - `*EL PRINT, TOTALS=ONLY` EVOL, EMAS, for the mass check against CAD.
  - **Thermal:** NT, RFL and HFL.
  - **Modal:** U, plus the frequency, participation and effective-mass tables from the `.dat`.
  - ASCII `.frd` first. Binary (`*NODE OUTPUT`) once the reader supports it. FILE and OUTPUT cards are never mixed in one step.
- **Solver:** ccx uses the first solver it was built with. Debian, Ubuntu and Homebrew builds have only SPOOLES. Wren's install check runs `ccx -v` to detect the version (minimum 2.20, the Debian stable floor; S1's keywords did not change from 2.21 to 2.23) and records it in the results. The binary name varies (`ccx`, `ccx_2.23`, `ccx_static.exe`), so Wren probes candidates rather than assuming a name. The run script sets `OMP_NUM_THREADS` and `CCX_NPROC_EQUATION_SOLVER`.
- **Failure classification:** the exit code alone is not reliable, because ccx can print "Job finished" after an `*ERROR`.
  - **Failed:** a non-zero exit (except 201 for a deck-only check), OR a line matching `^\s*\*ERROR`, OR NaN residuals, OR a missing or empty `.frd` for a requested step.
  - **Warnings:** `*WARNING` lines are shown to the user.
  - Known messages map to plain language, for example "nonpositive jacobian" becomes "the mesh has an invalid element near …; Wren will re-mesh with straight-sided elements", and "no material was assigned" becomes "…".
- **Results are tied to inputs:** each result stores a hash of (geometry, study, mesh settings, backend version). Any change marks the result "out of date" with the reason, for example "Fillet3 changed", and offers Re-solve. Fusion users report reaction probes that silently read zero after design changes. Wren dims a stale result and labels it, never mixing it with current geometry.

## 4. Post-processing coverage (S1)

### 4.1 Result views

- **Plots:**
  - Displacement: magnitude and X/Y/Z.
  - Stress: von Mises, maximum and minimum principal, and each component.
  - Strain: equivalent strain and components.
  - Factor of safety: yield ÷ von Mises for ductile materials, ultimate ÷ max principal for brittle ones.
  - Reaction force per support.
  - Thermal: temperature and heat flux.
  - Modal: a frequency table with participation and effective mass per direction, and the cumulative mass fraction.
- **Averaged by default, labelled "averaged at nodes".** ccx extrapolates element stresses to the nodes and averages them across elements, which smears jumps at material interfaces. Unaveraged element stress is available as a toggle, read from integration-point output; it is heavier, so it is fetched on demand. The gap between averaged and unaveraged values is shown as a local error indicator (§4.2).
- **Deformed shape:**
  - The **default is a clearly labelled automatic scale.** Onshape sets the largest displacement to 15% of the bounding-box diagonal, SOLIDWORKS to 10%. Wren shows "×N" next to the legend at all times.
  - **True scale** is one click away.
  - The undeformed outline can be overlaid.
  - Static results can be animated; mode shapes animate, with normalised amplitude labelled as such.
- **Legend:**
  - Continuous or banded (2–24 bands), with automatic or manual limits.
  - Manual limits are marked with an indicator, as Onshape does with an asterisk.
  - Automatic limits clip at a high percentile, as Onshape does at the 95th, so one singular spot does not wash out the plot. The true maximum is still printed on the legend, with a marker in the model.
  - Values above or below the limits show in a distinct colour.
  - Safety factor uses a diverging scale centred on 1, with a default range of 1–3.5 (Onshape's range).
- **Min/max markers:** labelled pins at the global extremes, with a "go to" action.
- **Probes:**
  - Click a point to read its value.
  - Select a face or edge to get min, max, average and integral (PrePoMax's query tool does this).
  - Reaction force and moment on each support face.
  - Probes are named and persist across re-solves, so they update with the design.
- **Section view:** a plane cut through the result with the contour on the cut face. Iso-surfaces come later.
- **Compare:** two results side by side or as a difference (A − B), across designs, branches or configurations. A table of key values per study version (Onshape's history table, SOLIDWORKS' compare plots).
- **Report:** a self-contained HTML/PDF report:
  - geometry image, material, supports and loads with images, mesh statistics and quality;
  - the Results checks panel;
  - plots and probe tables;
  - solver and version, the unit system, and the input hash;
  - a plain disclaimer: results are only as good as the idealisation and must be verified for safety-critical use.

  Exports: CSV for probe and table data, and VTU so results open in ParaView.

### 4.2 The Results checks panel (Wren's trust layer)

Shown on every result, with each check green, amber or red and one sentence of explanation. Inferred from the theory research; these are the checks experts do by hand.

1. **Equilibrium:** the sum of reactions equals the applied loads in each direction (within 0.1%). A large mismatch means a modelling error.
2. **Mass check:** mesh mass vs CAD mass (within about 1%). A gap points to geometry lost in meshing or a wrong density.
3. **Mesh error indicator:** a Zienkiewicz–Zhu-style relative error from averaged vs unaveraged stress. Ansys treats its energy-norm error as relative only, so Wren shows it as a heat map and a global percentage, flagging areas over about 15%. That threshold comes from the literature, not a standard, and is labelled "indicative".
4. **Stress singularities:** Wren marks sharp re-entrant edges (unfilleted inside corners), the edges of fixed faces, and point or edge loads and supports, wherever peak stress sits on or next to one. The marker reads "stress here does not converge with refinement; use a fillet or read the value away from it" (St Venant). This follows ESRD: the error in a singular peak stress is unbounded even when overall error is negligible.
5. **Large deflection:** if the maximum displacement exceeds about 10% of the part's characteristic size (SOLIDWORKS' threshold), the result is flagged as beyond linear static, with a note that a nonlinear study is needed (extension track).
6. **Yield:** if von Mises stress exceeds yield anywhere outside a singularity marker, Wren shows "the linear result above yield is not physical; the part yields here". The safety factor below 1 is drawn on the model.
7. **Modal completeness:** the cumulative effective mass per direction (aim for 90% or more), excluding rigid-body modes in a free-free run. Free-free runs must show exactly 6 rigid-body modes, else Wren warns that part of the model is disconnected or mechanism-like.
8. **Thermal balance:** heat in equals heat out within tolerance.

### 4.3 Convergence check

**"Check convergence"** re-meshes at size factors 1, 0.7 and 0.5 (deterministic, no error estimator needed) and plots each quantity against DOF:
- peak von Mises in user-selected probe regions;
- global strain energy;
- maximum displacement.

A result counts as converged when it changes by less than 2% between the last two meshes (Fusion's guidance is 1–2%). Wren never judges convergence on the raw global maximum. A peak that keeps rising is reported as a singularity and is never chased forever.

Later, an error-driven adaptive loop:
1. h_new = h·(η_target/η_e)^(1/2) per element, clamped to [h/3, 2h];
2. feed the new sizes back to Gmsh as a background PostView mesh;
3. stop at less than 2% change or after 5 loops.

## 5. Verification: the S1 benchmark suite (CI, real ccx)

Reference values are as reproduced in free vendor verification manuals (`fea_theory_validation.md`). The NAFEMS originals (TNSB Rev. 3) are NAFEMS publications.

| Case | Quantity | Reference | Wren tolerance | Notes |
|---|---|---|---|---|
| NAFEMS LE1 elliptic membrane | σyy at D | 92.7 MPa | ≤ 2% on the fine mesh, plus a monotone trend coarse → fine | Modelled as a thin 3D slab in plane stress |
| NAFEMS LE10 thick plate | σyy at D | −5.38 MPa | ≤ 3% | The original line constraint does not fit 3D elasticity. Wren applies the face idealisation and documents it (ESRD: −5.24 MPa with face, −5.379 MPa with line) |
| NAFEMS LE11 thermal-stress cylinder | σ at A | −105 MPa | ≤ 2% | Needs thermal stress (C3D10T), so it joins the suite when that arrives. Sources disagree whether the component is σyy or σzz; resolve that first |
| NAFEMS FV32 tapered membrane | modes 1–6 | 44.623, 130.03, 162.70, 246.05, 379.90, 391.44 Hz | ≤ 1% | Geometry still to be extracted from a free source |
| NAFEMS FV52 simply supported thick plate | modes 4–10 | 45.897, 109.44, 109.44, 167.89, 193.59, 206.19, 206.19 Hz | ≤ 3% | 3 rigid-body modes. The plan had this wrong: FV52 is simply supported. The free plate is FV12 |
| Cantilever (spike) | tip deflection, root stress | Euler–Bernoulli, with a Timoshenko correction | ≤ 1% | Already within 0.23–0.50% in S0 |
| Plate with a hole (Kirsch) | Kt | 3.0 for an infinite plate; Peterson for finite width | ≤ 3% | Also used to test the singularity check: a sharp notch variant must be flagged |
| Thick-walled cylinder (Lamé) | hoop stress at the bore, radial displacement | closed form | ≤ 1% | |
| Beam natural frequencies | modes 1–3 | closed form | ≤ 1% | |
| 1D conduction slab, plus convection | T profile, heat flow | closed form | ≤ 0.5% | Stands in for the NAFEMS thermal benchmarks until a sourced reference is found |
| Free-free block | rigid-body modes | exactly 6 near 0 Hz | | Tests the modal check |
| Under-constrained bracket | pre-run check | blocked | | Tests the 6-DOF check |
| Persistence | loads on faces after an upstream edit | same faces, or "needs attention" | | The Wren-specific acceptance |

Golden pipeline checks in the same suite: exported mesh volume vs BRep volume; facet counts per named surface; consistent-load sum equals the applied force; mesh hash under deterministic mode.

## 6. UX lessons from other tools

What to copy (as generic patterns):
- PrePoMax's **Check Model**, solver **Monitor** with a kill command, and a deformation-scale dropdown (Undeformed / True / Auto with multiples / User).
- Onshape's **live progress with streamed results**, automatic refresh when the model changes, legend percentile clipping and history table of runs.
- SOLIDWORKS' **singularity diagnostics** ("hot spot" refinement to tell concentrations from singularities) and compare-results layout.
- FreeCAD's VTK-based clip, cut and line-plot filters, plus ParaView export.

Traps to avoid:
1. A per-node force, where users expect a total.
2. Loads that break or silently move after design edits.
3. Stale results that still look valid.
4. An exaggerated default deformation shown without its scale factor.
5. A legend washed out by a singular maximum.
6. "Fixed" as the only support (the free SOLIDWORKS wizard allows nothing else).
7. Pay-per-solve credit anxiety; Wren solves locally and free.
8. Modal dialogs for every load; Wren edits values inline with expressions and units.
9. Raw solver errors shown to non-experts.
10. Adaptive refinement hidden and off by default with no explanation; Wren puts a visible Check convergence button on every result.

Trademark note: Wren uses generic terms ("study", "what-if study", "quick check", "results checks"), not SimulationXpress, Design Study and so on.

## 7. Changes to the plan

PLAN §12B S1 is rewritten from this report into sub-scopes, each with acceptance criteria:
- **S1a:** study model, materials, supports, loads, glyphs.
- **S1b:** mesher, with the quality policy and pre-run checks.
- **S1c:** CalculiX backend (deck writer, install check, failure classification, file handoff, then the Runner).
- **S1d:** results viewer and the Results checks panel.
- **S1e:** convergence check, compare and report.
- **S1f:** benchmark CI.

FV52 is corrected (and FV12 added as the free plate). The trust-layer decisions are recorded as ADR-062.

## 8. Open questions and gaps

- **Thermal and remaining benchmark values:**
  - NAFEMS thermal benchmark values (T1/T3) are unsourced, so the closed-form thermal cases stand in.
  - LE11's stress component needs resolving.
  - FV32 geometry is needed.
- **Solver details not found:**
  - Exact ccx wording for singular-matrix and zero-pivot errors, and the meaning of its exit codes.
  - Which solvers the official Windows build and PrePoMax's bundled binary include.
  - The binary `.frd` layout.
- **Mesh guidance:**
  - How many C3D10 layers a thin wall needs (sources range from 1 to 3; Wren uses 2 and validates it on the benchmarks).
  - Whether HXT gives the same mesh across thread counts.
- **Licences and attribution:**
  - Which BLAS/LAPACK the Gmsh Wasm build links, and its licence, still to be recorded in DEPENDENCIES.md along with the Gmsh/Netgen/Mmg notices.
  - Licence review for serving GPL Wasm to browsers (corresponding source must be published).
- **Not researched:** bolted-joint modelling guidance and disclaimer wording from NAFEMS. Both are post-S1 or need a short follow-up before S1 starts.
