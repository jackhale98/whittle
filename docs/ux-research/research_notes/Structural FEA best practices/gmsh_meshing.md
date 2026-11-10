# Gmsh meshing for structural and thermal FEA (Wren: Gmsh 4.15 Wasm + OCCT, C3D10 for CalculiX)

Source notes. "Manual" means the Gmsh 4.15.2 reference manual (https://gmsh.info/doc/texinfo/gmsh.html, dated March 24, 2026). Each option is listed with its documented 4.15 default. I downloaded the manual and searched it locally. "Changelog" means https://gmsh.info/CHANGELOG.txt. Points marked **[forum]** come from mailing lists, forums or blogs, not from official documentation.

## Size control (global, curvature, fields, local refinement, thin walls)

### Takeaway
Gmsh computes the local size as the minimum of several sources: bounding-box size, point sizes, curvature size, the background field and per-entity constraints. It then clamps that value to [MeshSizeMin, MeshSizeMax] and multiplies it by MeshSizeFactor. For mechanical parts, the robust pattern is: a global max size, curvature sizing with a hard MeshSizeMin floor, and Distance+Threshold fields (combined with Min) for user refinement on faces and edges. Nothing in Gmsh enforces a number of elements through the wall thickness. Wren has to derive that from geometry. Practice ranges from "1 layer of tet10 can work" (forum) to "at least 3" (trade article).

### Cited findings
**Size pipeline (documented)**
- The size at a point is the minimum of: (1) the model bounding-box size; (2) point sizes if `Mesh.MeshSizeFromPoints` is set; (3) the curvature size if `Mesh.MeshSizeFromCurvature` > 0, where the value is "the number of elements per 2 Pi radians"; (4) the background field; (5) any per-entity constraint. An API size callback (`gmsh/model/mesh/setSizeCallback`) can then modify the result. The value is clamped to [`Mesh.MeshSizeMin`, `Mesh.MeshSizeMax`] (CLI `-clmin`/`-clmax`) and multiplied by `Mesh.MeshSizeFactor` (`-clscale`). — [Manual §1.2.2 "Specifying mesh element sizes"](https://gmsh.info/doc/texinfo/gmsh.html#Specifying-mesh-element-sizes)
- Since 4.9.0 the size callback is no longer folded into the global min. It receives the lc that would otherwise apply and can return any modification. — [Changelog 4.9.0](https://gmsh.info/CHANGELOG.txt)
- Defaults:
  - `Mesh.MeshSizeMin` = 0
  - `Mesh.MeshSizeMax` = 1e+22
  - `Mesh.MeshSizeFactor` = 1
  - `Mesh.MeshSizeFromCurvature` = 0 (off). "Automatically compute mesh element sizes from curvature, using the value as the target number of elements per 2*Pi radians."
  - `Mesh.MeshSizeFromCurvatureIsotropic` = 0 ("Force isotropic curvature estimation")
  - `Mesh.MeshSizeFromPoints` = 1
  - `Mesh.MeshSizeFromParametricPoints` = 0

  — [Manual, Mesh options](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- `Mesh.MeshSizeExtendFromBoundary` (default 1) takes these values: 0 never; 1 surfaces and volumes; 2 surfaces and volumes, but use the smallest surface edge length instead of the longest in 3D Delaunay; -2 surfaces only; -3 volumes only. — [Manual, Mesh options](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options). The extended values and the new "Extend" field arrived in 4.9.3. — [Changelog](https://gmsh.info/CHANGELOG.txt)
- The manual's recommendation: when only parts of the model need a different size (for example "refinement of the mesh along an edge or within a fillet/surface"), set `MeshSizeExtendFromBoundary = 0` "to avoid unintentional refinement in nearby entities". When sizes are fully specified by a field, set `MeshSizeFromPoints = 0; MeshSizeFromCurvature = 0; MeshSizeExtendFromBoundary = 0` "to prevent over-refinement inside an entity due to small mesh sizes on its boundary". — [Manual §1.2.2](https://gmsh.info/doc/texinfo/gmsh.html#Specifying-mesh-element-sizes); same advice in [tutorial t10](https://gmsh.info/doc/texinfo/gmsh.html#t10)
- Per-entity extension switch: `gmsh/model/mesh/setSizeFromBoundary(dim, tag, val)` is "currently only supported for dim == 2". `gmsh/model/mesh/setSize` handles only points (dim 0). — [Manual API](https://gmsh.info/doc/texinfo/gmsh.html#Namespace-gmsh_002fmodel_002fmesh)
- Curve node minimums: `Mesh.MinCircleNodes` = 7, `Mesh.MinCurveNodes` = 3 (curves other than lines, circles and ellipses), `Mesh.MinLineNodes` = 2. These hold regardless of size. — [Manual, Mesh options](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- Tutorial t19 (OCC fillets) enables curvature sizing "with a target of 20 elements per 2*Pi radians" and pairs it with min and max size constraints "to stay within reasonable values". — [Manual t19](https://gmsh.info/doc/texinfo/gmsh.html#t19)
- History: 4.5.0 added "a new separate option to govern curvature adapted meshes (`Mesh.MinimumElementsPerTwoPi` and `-clcurv val`)". The 4.15 manual has no `Mesh.MinimumElementsPerTwoPi`; the elements-per-2π value now lives in `Mesh.MeshSizeFromCurvature` itself. — [Changelog 4.5.0](https://gmsh.info/CHANGELOG.txt), [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)

**Size fields (documented, 4.15)** — [Manual ch. 8 "Gmsh mesh size fields"](https://gmsh.info/doc/texinfo/gmsh.html#Gmsh-mesh-size-fields)

| Field | What it does |
|---|---|
| Distance | Distance to `PointsList`, `CurvesList` and `SurfacesList`. Curves and surfaces are replaced by sample points: `Sampling` = 20 points per dimension. `SurfacesList` supports only OpenCASCADE and discrete surfaces. |
| Threshold | `SizeMin` if the input field ≤ `DistMin`, `SizeMax` if ≥ `DistMax`, interpolated in between. Optional `Sigmoid` (default 0 = linear). `StopAtDistMax` (default 0) imposes nothing beyond `DistMax`. Defaults: DistMin 1, DistMax 10, SizeMin 0.1, SizeMax 1. |
| Box / Ball / Cylinder | `VIn` inside, `VOut` outside. Box and Ball also take `Thickness` > 0 to interpolate in a transition layer. |
| Constant | `VIn` inside the listed entities (optionally including their boundaries and embedded entities), `VOut` outside. Improved in 4.15.0. |
| Restrict | Applies `InField` only on the listed points, curves, surfaces and volumes. `IncludeBoundary` defaults to 1 (since 4.9.1); `IncludeEmbedded` = 1. Improved in 4.15.0. |
| Min / Max / MinAniso | Combine other fields. |
| MathEval | Explicit function of coordinates and other fields. |
| Extend | Extends boundary sizes inward: F = f·SizeBnd + (1−f)·SizeMax for d < DistMax, with f = ((DistMax−d)/DistMax)^Power. |
| Curvature | div(norm(grad(field))). |
| AttractorAnisoCurve | Anisotropic size near curves. |
| PostView | Uses a post-processing view as the size map. `CropNegativeValues` = 1, `UseClosest` = 1. |
| Structured | Size from a file on a regular grid. |

  Field changes from the [Changelog](https://gmsh.info/CHANGELOG.txt): 4.15.0 improved Constant and Restrict; 4.9.1 turned on IncludeBoundary by default in Restrict.
- Tutorial t10 pattern: Distance on point 5 and curve 2, a Threshold on it, other fields, then "use the minimum of all the fields as the background mesh size field". The tutorial also notes that the default Frontal-Delaunay 2D algorithm usually gives the highest quality, while "Delaunay" (`Mesh.Algorithm = 5`) "will handle complex mesh size fields better — in particular size fields with large element size gradients". — [Manual t10](https://gmsh.info/doc/texinfo/gmsh.html#t10)
- 3D support: general size fields and embedded entities are "currently only supported by the Delaunay and HXT algorithms". — [Manual §1.2.1](https://gmsh.info/doc/texinfo/gmsh.html#Choosing-the-right-unstructured-algorithm)

**Through-thickness and feature size (practice)**
- **[trade article]** "To offset element limitations, we would want at least 3 elements through thickness"; practical budgets often force 1–2. — [Digital Engineering 24/7, "Elements of Finite Element Analysis"](https://www.digitalengineering247.com/article/elements-of-finite-element-analysis)
- **[forum]** Mecway users found that a single layer of 10-node tets gave bending results close to quadratic shells. The paper they cite targeted natural frequencies (within 2%), not stress or deflection. — [Mecway forum, "Quad4 vs Quad8 and Quad8 vs Tet10 in Bending"](https://mecway.com/forum/discussion/comment/378)
- **[vendor doc]** For linear 8-node bricks in strong bending, a fracture-mechanics report says more than 8 elements through the thickness are needed. This is not about tet10. — [core.ac.uk report](https://core.ac.uk/download/4823271.pdf)
- **[forum]** PrePoMax users report that "Netgen supports element size grading while Gmsh does not". This refers to PrePoMax's parameter mapping, not to Gmsh fields. — [PrePoMax forum, Gmsh vs Netgen](https://prepomax.discourse.group/t/gmsh-vs-netgen-tetrahedral-mesh/1332)

### Inferences
- Suggested Wren defaults, which need validation on the golden-test parts:
  - `MeshSizeMax` = h_global, from a user "Coarse / Medium / Fine" slider tied to bounding-box diagonal or volume^(1/3).
  - `MeshSizeMin` = about h_global/20 to h_global/50, so tiny fillets cannot explode the element count.
  - `MeshSizeFromCurvature` = 12–20. t19 uses 20. With C3D10's curved edges, 12 is likely enough on gentle curves.
  - `MeshSizeExtendFromBoundary` = 1 (default), switched to 0 when the user adds local refinement fields.
- Thin walls: Wren can estimate wall thickness from the BRep (opposed-face distance via OCCT `BRepExtrema`). It can then add a Distance+Threshold field, or a `Constant` field restricted to those faces, setting size ≤ t/2 for 2+ C3D10 layers. Show a "thin wall: N layers" badge instead of silently refining.
- Local refinement on named faces and edges maps directly onto Distance(SurfacesList/CurvesList) → Threshold → Min. Wren's persistent face names resolve to OCC tags just before meshing. An unresolved name should block that refinement and flag "needs attention", following the project rule against guessing references.
- Use `Sigmoid=1` on Threshold fields to soften gradients; this helps the 3D Delaunay and the high-order optimizer.

### Gaps
- No primary source (NAFEMS or textbook) found that gives a definitive through-thickness count for tet10 in stress analysis. NAFEMS "How to" guides are paywalled and were not accessed.
- I did not find which exact 4.x release dropped `Mesh.MinimumElementsPerTwoPi`.

## 3D and 2D algorithms: robustness and fallbacks

### Takeaway
For CAD solids with size fields, use 3D Delaunay (`Algorithm3D = 1`, the default and documented as most robust) or HXT (10, faster and parallel). Frontal/Netgen (4) and MMG3D (7) do not support general size fields. In 2D, Frontal-Delaunay (6, default) gives the best quality. Gmsh automatically falls back to MeshAdapt when a Delaunay-family 2D algorithm fails. MeshAdapt is the documented most-robust choice for very complex curved surfaces.

### Cited findings
- `Mesh.Algorithm` (2D) values: 1 MeshAdapt, 2 Automatic, 3 Initial mesh only, 5 Delaunay, 6 Frontal-Delaunay, 7 BAMG, 8 Frontal-Delaunay for Quads, 9 Packing of Parallelograms, 11 Quasi-structured Quad. Default 6. — [Manual, Mesh options](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options). The default changed to Frontal-Delaunay in 4.5.0. — [Changelog](https://gmsh.info/CHANGELOG.txt)
- `Mesh.Algorithm3D` values: 1 Delaunay, 3 Initial mesh only, 4 Frontal, 7 MMG3D, 9 R-tree, 10 HXT. Default 1. — [Manual, Mesh options](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- What the manual says about each 2D algorithm:
  - MeshAdapt: local edge swaps, splits and collapses. "For very complex curved surfaces the MeshAdapt algorithm is the most robust."
  - Frontal-Delaunay: "should be tried" when quality matters.
  - Delaunay: fastest for large planar meshes and "usually also handles complex mesh size fields better".
  - "When the Delaunay or Frontal-Delaunay algorithms fail, MeshAdapt is automatically triggered."
  - "Automatic" uses Delaunay on plane surfaces and MeshAdapt elsewhere.

  — [Manual §1.2.1](https://gmsh.info/doc/texinfo/gmsh.html#Choosing-the-right-unstructured-algorithm)
- `Mesh.AlgorithmSwitchOnFailure` = 1: "Currently only for 2D Delaunay-based algorithms, switching to MeshAdapt". — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- `Mesh.MaxRetries` = 10: number of retries on curves and surfaces with a pending mesh. It also caps the recursive subdivisions applied when self-intersecting 1D meshes are detected. — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- What the manual says about each 3D algorithm:
  - Delaunay: an initial mesh of all volumes with no interior points, then surface recovery with H. Si's TetGen/BR, then 3D point insertion.
  - Frontal: J. Schöberl's Netgen algorithm.
  - HXT: "a new efficient and parallel reimplementation of the Delaunay algorithm".
  - MMG3D: experimental and anisotropic.
  - "The Delaunay algorithm is currently the most robust and is the only one that supports the automatic generation of hybrid meshes with pyramids."

  — [Manual §1.2.1](https://gmsh.info/doc/texinfo/gmsh.html#Choosing-the-right-unstructured-algorithm)
- HXT history: size fields and embedded points and surfaces supported in HXT since 4.6.0; embedded curves since 4.8.0. 4.15.1 "improved handling of anisotropic surface meshes in 3D Delaunay". — [Changelog](https://gmsh.info/CHANGELOG.txt)
- HXT papers:
  - Marot, Pellerin & Remacle, "One machine, one minute, three billion tetrahedra": a parallel Delaunay kernel generating "over 55 million tetrahedra per second" (IJNME, DOI 10.1002/nme.5987). — [arXiv 1805.08831](https://arxiv.org/abs/1805.08831)
  - Marot & Remacle, "Quality tetrahedral mesh generation with HXT": adds a fast parallel mesh-improvement stage that reaches high quality compared with open-source alternatives (Gmsh's previous mesher, TetGen). — [arXiv 2008.08508](https://arxiv.org/abs/2008.08508)
- `Mesh.ToleranceInitialDelaunay` = 1e-12 (3D Delaunay initial-mesh tolerance). — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- Gmsh can mesh each 2D surface with a different algorithm. Tutorial t5 example: `MeshAlgorithm Surface {31, 35} = 1;` (MeshAdapt on two surfaces). — [Manual t5](https://gmsh.info/doc/texinfo/gmsh.html#t5)
- **[forum]** In PrePoMax, the Quasi-structured Quad 2D algorithm (11) combined with order 2 can fail because it produces pyramids. — [PrePoMax forum](https://prepomax.discourse.group/t/gmsh-vs-netgen-tetrahedral-mesh/1332)

### Inferences
- Recommended fallback ladder for Wren, run in the worker:
  1. 2D=6 + 3D=1 (or 10 when Wasm threads are available).
  2. On a 2D failure, rely on the automatic switch to MeshAdapt. Optionally retry the failed surfaces with per-surface `MeshAlgorithm = 1`.
  3. On a 3D failure (boundary recovery), retry with 3D=10 or 1, whichever was not tried. Then retry with 2D=5 (better under size gradients). Then retry with a slightly larger `MeshSizeMin`.
  4. Then try compounds or defeaturing on the reported faces.
  5. Report failing entity tags mapped to persistent face names.
- Avoid 3D=4 (Netgen frontal) and 3D=7 (MMG3D) as defaults, because size fields are ignored or unsupported there.

### Gaps
- No quantitative failure-rate comparison of Delaunay vs HXT on CAD corpora found (the HXT paper benchmarks quality and speed, not failure rate on dirty CAD).
- How Gmsh's surface-recovery errors appear through the API, as messages and exception text, was not catalogued from source.

## Second order: ElementOrder, HighOrderOptimize, SecondOrderLinear, and when straight-sided C3D10 is better

### Takeaway
`ElementOrder = 2` puts mid-side nodes on the CAD geometry. On tight fillets, where the element is large compared with the fillet radius, this can produce near-inverted or inverted elements. Gmsh's high-order optimizer (Toulorge et al.) untangles and improves curved elements down to `HighOrderThresholdMin` (default 0.1). The spike's min SICN of 0.068 after optimization is valid (positive) but below the optimizer's own target. Common practice in FreeCAD and PrePoMax when Jacobians stay bad is `SecondOrderLinear = 1`: straight-sided C3D10, at some cost in geometric accuracy on curved boundaries.

### Cited findings
- Defaults:
  - `Mesh.ElementOrder` = 1
  - `Mesh.SecondOrderLinear` = 0: "Should second order nodes … simply be created by linear interpolation?"
  - `Mesh.SecondOrderIncomplete` = 0: "Create incomplete second order elements? (8-node quads, 20-node hexas, etc.)". This does not affect tet10, which has no interior node.

  — [Manual, Mesh options](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- High-order optimizer options (4.15 defaults):
  - `Mesh.HighOrderOptimize` = 0. Values: 0 none, 1 optimization, 2 elastic+optimization, 3 elastic, 4 fast curving.
  - `Mesh.HighOrderThresholdMin` = 0.1, `Mesh.HighOrderThresholdMax` = 2.
  - `Mesh.HighOrderNumLayers` = 6: "number of layers around a problematic element to consider".
  - `Mesh.HighOrderPassMax` = 25: "maximum number of … passes (moving barrier)".
  - `Mesh.HighOrderIterMax` = 100.
  - `Mesh.HighOrderPrimSurfMesh` = 0: "Try to fix flipped surface mesh elements".
  - `Mesh.HighOrderDistCAD` = 0: "Try to optimize distance to CAD".
  - `Mesh.HighOrderFixBoundaryNodes` = 0: 1 fixes all boundary nodes, 2 fixes periodic ones.
  - `Mesh.HighOrderPoissonRatio` = 0.33: the elastic smoother material.
  - `Mesh.HighOrderSkipQualityCheck` = 0.
  - `Mesh.HighOrderFastCurvingNewAlgo` = 0 (experimental).
  - Boundary-layer fast-curving options: `HighOrderCurveOuterBL`, `HighOrderMaxRho` 0.3, `HighOrderMaxAngle` 0.1745, `HighOrderMaxInnerAngle` 0.5236.

  — [Manual, Mesh options](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- API: `gmsh/model/mesh/optimize(method, force, niter, dimTags)` takes these methods: "" (default tet optimizer), "Netgen", "HighOrder" (direct optimizer), "HighOrderElastic", "HighOrderFastCurving", "Laplace2D", "Relocate2D", "Relocate3D", "QuadQuasiStructured", "UntangleMeshGeometry". It can be restricted to `dimTags`. `gmsh/model/mesh/setOrder(order)` changes order after meshing. — [Manual API](https://gmsh.info/doc/texinfo/gmsh.html#Namespace-gmsh_002fmodel_002fmesh)
- Tutorial t5 comment: to "generate a curvilinear mesh and optimize it to produce provably valid curved elements", use `Mesh.ElementOrder = 2; Mesh.HighOrderOptimize = 2;`. It cites Johnen, Remacle & Geuzaine, "Geometric validity of curvilinear finite elements", JCP 233 (2013), and Toulorge et al., "Robust untangling of curvilinear meshes", JCP 254 (2013). — [Manual t5](https://gmsh.info/doc/texinfo/gmsh.html#t5)
- The untangling paper starts from a possibly invalid curvilinear mesh and moves nodes by optimization. It imposes Jacobian positivity through log-barriers and computes provable Jacobian bounds for high-order tets, among other element types. — [Toulorge et al. preprint](https://gmsh.info/doc/preprints/gmsh_untangling_preprint.pdf); [MaRDI record, DOI 10.1016/j.jcp.2013.07.022](https://portal.mardi4nfdi.de/wiki/Publication:348160)
- **[forum, maintainer]** C. Geuzaine (Nov 2020): `-optimize_ho` "applies the default strategy (elastic smoothing followed by brute-force optimization)". Users should "see all the HighOrder options to fine-tune the parameters". "With the API you can also call all the steps individually." The user's negative Jacobians returned after a small geometry change. — [Gmsh list 2020/014024](https://onelab.info/pipermail/gmsh/2020/014024.html); thread [2020/013939](https://onelab.info/pipermail/gmsh/2020/013939.html)
- **[forum]** An older reply suggests `Mesh.SecondOrderLinear = 1` to avoid curving and so sidestep the Jacobian problem. — [Gmsh list 2016/010468](https://onelab.info/pipermail/gmsh/2016/010468.html)
- FreeCAD FEM wiki: High Order Optimize deforms element borders and applies only to 2nd-order meshes. For "nonpositive Jacobian" errors in CalculiX, it suggests either `Second Order Linear = true` with Element Order 2nd, or Element Order 1st. — [FreeCAD wiki FEM_MeshGmshFromShape](https://wiki.freecad.org/FEM_MeshGmshFromShape)
- **[forum]** FreeCAD: running the Netgen optimizer after a 2nd-order mesh converts the tets back to 1st order. Netgen optimization first, then high-order optimization, is faster. Remaining negative-Jacobian elements can usually be removed with "Regularization of high-order elements". — [FreeCAD devtalk, "nonpositive jacobian determinant in element 37091"](https://devtalk.freecad.org/t/calculix-error-in-ec3d-nonpositive-jacobian-determinant-in-element-37091/49299)
- **[forum]** PrePoMax pipeline: Gmsh makes the 1st-order mesh, runs 1st-order optimization, converts to 2nd order, then runs 2nd-order optimization. Netgen 1st-order optimization "works also for 2nd order elements (only the positions of corner nodes…)". "High order elastic" is slower. PrePoMax sets Gmsh `SecondOrderLinear` when "Midside nodes on geometry = No". Users recommend that setting to avoid negative Jacobians. — [PrePoMax forum: Gmsh vs Netgen](https://prepomax.discourse.group/t/gmsh-vs-netgen-tetrahedral-mesh/1332); [PrePoMax forum: nonpositive jacobian](https://prepomax.discourse.group/t/unable-to-run-nonpositive-jacobian-error/1587)
- Changelog: 4.12.0 added a high-order optimization mode for periodic meshes. 4.8.0 "improved performance of high-order meshing of OCC models". 4.8.1 fixed a regression in high-order meshing of surfaces with singular parametrizations. — [Changelog](https://gmsh.info/CHANGELOG.txt)
- **[forum, maintainer]** The optimizer is "still very slow" for high-order elements other than simplices. — [Gmsh list 2020/013798](https://onelab.info/pipermail/gmsh/2020/013798.html)

### Inferences
- Reading the spike: SICN 0.008 → 0.068 means the optimizer improved the elements but did not reach `HighOrderThresholdMin = 0.1`. Things to try, in order:
  1. `HighOrderOptimize = 2` (elastic first) if it was 1.
  2. Raise `HighOrderNumLayers` (6 → 10–12) and `HighOrderPassMax`.
  3. `HighOrderPrimSurfMesh = 1` if any surface triangles flipped.
  4. Refine locally on small-radius fillets: curvature sizing, or Distance→Threshold on the fillet faces with size ≈ r/2 or smaller. Then the curved mid-node offset is a small fraction of the element size. This is the root-cause fix.
  5. Last resort: `SecondOrderLinear = 1`. It is global, with no per-entity variant documented.
- Proposed Wren acceptance policy:
  - Any element with min SICN or minDetJac ≤ 0: auto-retry with step 4. If that still fails, fall back to straight-sided C3D10 and show a "straight-sided on curved faces" notice.
  - Min SICN 0 to 0.1: accept, with a "low-quality elements" warning that highlights their locations.
  - Above 0.1: OK.
- When straight-sided C3D10 is better:
  - Thermal or stiffness-dominated studies where boundary curvature error is small.
  - Very small fillets that are not stress-critical.
  - Whenever curving produces invalid elements.

  Curved is better where stress concentrates on a curved fillet that is itself the subject of the analysis.
- The Netgen optimizer must run before order elevation, never after.

### Gaps
- No quantitative study found on stress error from straight-sided vs curved C3D10 on fillets.
- The exact semantics of `HighOrderThresholdMax` (2) were not documented beyond "maximum threshold". It is plausibly an upper bound on a Jacobian ratio, but this is unconfirmed.

## Quality metrics, Gmsh tools and acceptance thresholds

### Takeaway
Gmsh exposes these per-element qualities through `getElementQualities`:
- minSICN (signed inverse condition number, the default API metric)
- minSIGE
- gamma
- minSJ (sampled minimal scaled Jacobian)
- minDetJac / maxDetJac
- minIsotropy, angleShape
- min and max edge lengths, inner and outer radius, volume

Validity of curved elements needs the *adaptive/sampled* Jacobian measures, not gamma. Common accept and reject thresholds come from vendors and are heuristic. CalculiX itself rejects only non-positive Jacobians.

### Cited findings
- `getElementQualities(elementTags, qualityName="minSICN")` options:
  - "minDetJac"/"maxDetJac": adaptively computed min and max Jacobian determinant
  - "minSJ": sampled minimal scaled Jacobian
  - "minSICN": sampled minimal signed inverse condition number
  - "minSIGE": sampled signed inverse gradient error
  - "gamma": inscribed/circumscribed radius ratio
  - "innerRadius", "outerRadius", "minIsotropy", "angleShape", "minEdge", "maxEdge", "volume"
  - Multi-task chunking is available in C++.

  — [Manual API](https://gmsh.info/doc/texinfo/gmsh.html#Namespace-gmsh_002fmodel_002fmesh). More qualities were added to the API in 4.12.0 — [Changelog](https://gmsh.info/CHANGELOG.txt)
- `Mesh.QualityType` (display filter metric) values: 0 SICN, 1 SIGE, 2 gamma (vol/sum_face/max_edge, the default), 3 Disto (minJ/maxJ). `Mesh.QualityInf` and `QualitySup` filter displayed elements. — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- `Mesh.MinQuality` is read-only, "Minimum mesh quality (ICN) after the generation of the current mesh". New in 4.13.1. — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options), [Changelog 4.13.1](https://gmsh.info/CHANGELOG.txt)
- `Plugin(AnalyseMeshQuality)`:
  - Computes min Jacobian determinant (J), IGE and/or ICN for elements of a given dimension.
  - "J is faster … but gives information only on element validity". IGE "is related to the error on the gradient of the FE solution"; ICN "is related to the condition number of the stiffness matrix".
  - Parameters: JacobianDeterminant, IGEMeasure, ICNMeasure (all default 0); HidingThreshold 99; ThresholdGreater 1; CreateView 0; Recompute; DimensionOfElements (-1 means highest).

  — [Manual ch. 9](https://gmsh.info/doc/texinfo/gmsh.html#Gmsh-plugins)
- Linear optimizers:
  - `Mesh.Optimize` = 1 (on by default) optimizes tets with quality below `Mesh.OptimizeThreshold` = 0.3.
  - `Mesh.OptimizeNetgen` = 0 runs the Netgen optimizer.
  - `Mesh.Smoothing` = 1 step.
  - `Mesh.OptimizePyramids` = 0 (smoother); 1 is the untangler.

  — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- **[vendor heuristic]** SOLIDWORKS Simulation: a good mesh has aspect ratio < 5 for at least 90% of elements, and Jacobian ratio between 1 and 10 for the majority. Another SOLIDWORKS page says a Jacobian ratio below 30 is acceptable. — [SOLIDWORKS 2021 help, Mesh Quality Checks](https://help.solidworks.com/2021/English/SolidWorks/cworks/c_Mesh_Quality_Checks.htm)
- **[vendor]** Abaqus/CAE "Verify Mesh" runs the analysis-input-processor element checks and highlights elements over a user aspect-ratio threshold. — [Abaqus 6.6 docs, Verifying your mesh](https://classes.engineering.wustl.edu/2009/spring/mase5513/abaqus/docs/v6.6/books/usi/pt03ch17s06s01.html)
- **[vendor]** Altair's Abaqus-style tet Jacobian uses Gauss-point determinant ratios; values ≥ 0.7 are "generally acceptable". Definitions differ between tools (5-point vs 11-point rules). — [Altair HyperWorks, Element quality calculations (Abaqus)](https://help.altair.com/hwdesktop/hwx/topics/pre_processing/meshing/element_quality_calculations_abaqus_r.htm)
- CalculiX error format is "*ERROR in e_c3d: nonpositive jacobian determinant in element N". — [FreeCAD devtalk thread title](https://devtalk.freecad.org/t/calculix-error-in-ec3d-nonpositive-jacobian-determinant-in-element-37091/49299)

### Inferences
- Wren quality report: after meshing, call `getElementQualities` with "minSICN" and "minDetJac" on all tet10s. Report the minimum, the 1st percentile, and counts below 0.1 and 0.2. Show the worst N elements in the viewport, mapped to face names.
- Use gamma (or `Mesh.OptimizeThreshold`-style 0.3) for the linear-mesh stage. Use minSICN and minDetJac after order elevation.
- Hard gate: minDetJac > 0, so the mesh is never handed to CalculiX in a state that will crash. Soft gate: minSICN ≥ 0.1 (matching Gmsh's own optimizer target).

### Gaps
- No NAFEMS-sourced numeric acceptance thresholds for SICN or SIGE were found. SOLIDWORKS and Altair thresholds use differently defined metrics and do not translate directly.
- How CalculiX evaluates its Jacobian check for C3D10 (at which points) was not verified from CalculiX source.

## Geometry preparation, healing, defeaturing, compounds, and failure recovery

### Takeaway
Gmsh's OCC healing (`HealShapes` / `occ.healShapes`) wraps OCCT ShapeFix: degenerated edges, small edges, small faces, sewing and making solids. The import flags are off by default. The maintainer's consistent advice is to clean the CAD rather than rely on healing. Two documented tools handle tiny features without editing CAD: compound meshing (`Compound Surface` / `setCompound`), which meshes across small faces, and, since 4.13, `occ.defeature`, which removes faces from a solid. Wren controls the kernel, so it can defeature upstream in OCCT, where persistent naming lives.

### Cited findings
- Import-time healing flags (all default 0): `Geometry.OCCFixDegenerated`, `OCCFixSmallEdges`, `OCCFixSmallFaces`, `OCCSewFaces`, `OCCMakeSolids`. Each applies "when importing STEP, IGES and BRep models with the OpenCASCADE kernel". — [Manual, Geometry options](https://gmsh.info/doc/texinfo/gmsh.html#Geometry-options)
- Other geometry options:
  - `Geometry.Tolerance` = 1e-8; `Geometry.ToleranceBoolean` = 0.
  - `Geometry.OCCAutoFix` = 1: auto-fix orientation of wires, faces, shells and volumes on creation.
  - `Geometry.OCCScaling` = 1.
  - `Geometry.OCCTargetUnit` = "" (set before import; for example "M").
  - `Geometry.OCCImportLabels` = 1.
  - `Geometry.OCCParallel` = 0.
  - `Geometry.OCCBooleanGlue`, `OCCBooleanCheckInverted`, `OCCBooleanNonDestructive`, `OCCBooleanSimplify`: new in 4.13.0.
  - `Geometry.OCCFastUnbind`: 4.12.0, replacing OCCSafeUnbind.

  — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Geometry-options), [Changelog](https://gmsh.info/CHANGELOG.txt)
- `HealShapes;` applies the procedures selected by the five flags (OCC kernel only); added in 4.10.2. API: `occ.healShapes(dimTags=[], tolerance=1e-8, fixDegenerated=True, fixSmallEdges=True, fixSmallFaces=True, sewFaces=True, makeSolids=True)`. All procedures are on by default in the API, unlike the import flags. — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Other-geometry-commands), [API](https://gmsh.info/doc/texinfo/gmsh.html#Namespace-gmsh_002fmodel_002focc)
- `occ.defeature(volumeTags, surfaceTags, removeVolume)` "Defeature the volumes … by removing the surfaces". New in 4.13.0. — [Manual API](https://gmsh.info/doc/texinfo/gmsh.html#Namespace-gmsh_002fmodel_002focc), [Changelog 4.13.0](https://gmsh.info/CHANGELOG.txt)
- `occ.importShapesNativePointer` imports a `TopoDS_Shape*` directly. The manual calls it "unsafe": an invalid pointer is undefined behaviour. This is the path for Wren's in-process OCCT shape. — [Manual API](https://gmsh.info/doc/texinfo/gmsh.html#Namespace-gmsh_002fmodel_002focc)
- Compound meshing (tutorial t12):
  - Steps: (1) mesh each entity; (2) build a discrete entity combining them; (3) compute a discrete parametrization; (4) remesh using it; (5) optionally reclassify onto the original entities.
  - Step 3 requires the combined shape to be "simple enough" to reparametrize.
  - The individual meshes should be finer, controlled by `Mesh.CompoundMeshSizeFactor` (default 0.5).
  - `Mesh.CompoundClassify` = 1 classifies back onto the original surfaces. The value 0 keeps a new discrete surface and is "incompatible with e.g. high-order meshing".
  - The purpose is stated as "useful e.g. for imported CAD models (e.g. STEP) with undesired small features".

  — [Manual t12](https://gmsh.info/doc/texinfo/gmsh.html#t12), [Mesh options](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- API `mesh.setCompound(dim, tags)`. Since 4.5.2 "physical group definitions now follow compound meshing constraints". `Mesh.ReparamMaxTriangles` = 250000 caps the size of a parametrization patch. — [Manual API](https://gmsh.info/doc/texinfo/gmsh.html#Namespace-gmsh_002fmodel_002fmesh), [Changelog](https://gmsh.info/CHANGELOG.txt), [Mesh options](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- **[forum, maintainer]** On strip-like small faces that MeshSizeMin cannot span: "the best way would be to clean up the CAD". Compounds can help; see the `part_compound_curved_mesh.geo` benchmark. The user also reported that OCC repair removed the strips but meshing then errored. — [Gmsh list 2020/013850](https://onelab.info/pipermail/gmsh/2020/013850.html)
- **[forum]** Healing can harm:
  - Disabling small-edge healing fixed an IGES curve that was being closed incorrectly. — [Gmsh list 2008](https://onelab.info/pipermail/gmsh/2008/003456.html)
  - Repair options changed point numbering. — [Gmsh list 2010](https://onelab.info/pipermail/gmsh/2010/006000.html)
  - A tolerance that is too tight with OCCSewFaces caused trouble. — [Gmsh list 2016](https://onelab.info/pipermail/gmsh/2016/010318.html)
  - `healShapes` can fail with "Could not make solid". — [GitLab #2847](https://gitlab.onelab.info/gmsh/gmsh/-/issues/2847)
- `Mesh.AngleToleranceFacetOverlap` = 0.1°: connected facets count as overlapping below this dihedral angle, which is used to detect bad surface meshes. — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- `Mesh.MeshOnlyVisible` (experimental) and `gmsh/model/isEntityOrphan` (4.15.0) can help isolate failing entities. — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options), [Changelog 4.15.0](https://gmsh.info/CHANGELOG.txt)

### Inferences
- Wren builds its BReps natively, so do not enable import healing by default. Healing renumbers and changes topology, which breaks the face-name→tag map. Run `healShapes` only as an explicit recovery step, then re-resolve names by geometric matching and flag anything ambiguous.
- Defeaturing UX:
  - Detect faces whose fillet radius or hole diameter is below a threshold, for example below MeshSizeMin or below 5% of h_global.
  - Offer "suppress in mesh". Implement it by suppressing the CAD feature in Wren's own history (best, since it is persistent), by `occ.defeature`, or by `setCompound` on the small face plus its neighbours. A compound keeps the physical groups.
  - Never suppress automatically on faces that carry loads or boundary conditions.
- Failure detection:
  - Catch exceptions from `generate(3)`.
  - Read the Gmsh logger for entity tags (surface X failed, boundary recovery failed).
  - Check that every volume has elements.
  - Check `Mesh.MinQuality` and minDetJac.
  - Map tags back to face names for "needs attention" UI.

### Gaps
- Exact OCCT 8 ShapeFix behaviour differences vs OCCT 7.8 (the version used in official Gmsh 4.14 builds per the changelog) were not researched.
- I found no Gmsh documentation of logger message formats for failures, which would need source review.

## Physical groups and export (.inp)

### Takeaway
Gmsh's INP writer is minimal. It writes `*NODE`, then `*ELEMENT` blocks per elementary entity (C3D4/C3D10 for tets, CPS3/CPS6 for triangles), `*ELSET` per physical group and, optionally, `*NSET` per physical group. It does not write element-face `*SURFACE` definitions, which pressure or film loads usually need. Use `Mesh.SaveGroupsOfElements = -1000` (3D elements only) and `Mesh.SaveGroupsOfNodes = -100` (node sets for physical surfaces), or write the `.inp` in Wren from the mesh API.

### Cited findings
- Source `src/geo/GModelIO_INP.cpp` (Gmsh master mirror):
  - Writes `*Heading`, then `*NODE` with coordinates scaled by `Mesh.ScalingFactor`, then `******* E L E M E N T S *************`.
  - Each elementary entity with physical groups (or all entities if `saveAll`) gets `*ELEMENT, type=<T>, ELSET=Volume<tag>|Surface<tag>|Line<tag>`.
  - With physical groups: `*ELSET,ELSET=<name>` per physical group of dim 1–3, and `*NSET,NSET=<name>` (dims 0–3) when SaveGroupsOfNodes is set.
  - Names with spaces get underscores. Unnamed groups become `PhysicalSurface<N>` and similar.
  - With no physical groups at all, `saveAll` is forced true.

  — [GModelIO_INP.cpp (GitHub mirror of Gmsh)](https://raw.githubusercontent.com/live-clones/gmsh/master/src/geo/GModelIO_INP.cpp)
- Element names: tet4 → `C3D4`, tet10 → `C3D10`, tri3 → `CPS3`, tri6 → `CPS6`. Tet10 nodes are written with the map {0,1,2,3,4,5,6,7,9,8}: the last two mid-side nodes are swapped relative to Gmsh's ordering. — [MTetrahedron.h](https://raw.githubusercontent.com/live-clones/gmsh/master/src/geo/MTetrahedron.h); [MTriangle.h](https://raw.githubusercontent.com/live-clones/gmsh/master/src/geo/MTriangle.h)
- Options:
  - `Mesh.SaveGroupsOfElements` = 1. With a negative value, digit (dim+1) = 1 saves ELSETs for that dim. For INP, digit = 0 skips writing elements of that dim altogether. Extended in 4.9.3.
  - `Mesh.SaveGroupsOfNodes` = 0. A positive value writes NSETs for all physical groups. With a negative value, digit = 1 writes groups for that dim. For INP only, digit = 2 writes NSETs for every *entity* of that dim. The code comment calls this "dangerous" because nodes may be missing from the file. Extended in 4.9.2.
  - `Mesh.SaveAll` = 0: save all elements even without physical groups. "For some mesh formats, this removes physical groups altogether."
  - `Mesh.SaveElementTagType` = 1.
  - `Mesh.Format` 39 = inp.

  — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options), [Changelog](https://gmsh.info/CHANGELOG.txt), [INP source](https://raw.githubusercontent.com/live-clones/gmsh/master/src/geo/GModelIO_INP.cpp)
- The source comment says the negative-digit scheme exists so that "only 3D elements" can be written "but node sets identified by physical surfaces or curves". — [INP source](https://raw.githubusercontent.com/live-clones/gmsh/master/src/geo/GModelIO_INP.cpp)
- Physical group API additions: `model/getEntitiesForPhysicalName` (4.12.0) and `model/getPhysicalGroupsEntities` (4.14.0). — [Changelog](https://gmsh.info/CHANGELOG.txt)
- `Mesh.SaveWithoutOrphans` (4.11.0) prunes orphan entities in MSH4. `Mesh.Renumber` = 1 renumbers continuously after meshing. — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options), [Changelog](https://gmsh.info/CHANGELOG.txt)

### Inferences
- If physical surfaces are written with the default `SaveGroupsOfElements = 1`, the boundary CPS6 triangles appear as real plane-stress elements in a 3D model. That is wrong for CalculiX. Use `-1000`, or leave boundary triangles out of the export.
- CalculiX pressure (`*DLOAD`), film (`*FILM`) and radiation loads need element faces (element + face id) or `*SURFACE` definitions. Gmsh does not write them. Wren should write the `.inp` itself:
  1. Get nodes and C3D10 connectivity with `getNodes` and `getElementsByType(11)`, applying the {8↔9} swap.
  2. For each named face, get its tri6 elements and match them to the adjacent tet faces to emit `*SURFACE, TYPE=ELEMENT` sets.
  3. Emit NSETs for Dirichlet conditions.

  This also lets Wren keep its persistent face names verbatim, with its own sanitization and length limits, instead of Gmsh's space→underscore rule.
- Golden tests: compare the exported volume (sum of tet10 volumes) with the BRep volume, and check the counts of each named surface's facets.

### Gaps
- CalculiX name-length and character limits for set names were not verified here.
- I did not confirm whether Gmsh's INP writer emits nodes not referenced by saved elements; it depends on `indexMeshVertices` behaviour.

## Mesh convergence and adaptive refinement

### Takeaway
SOLIDWORKS offers h-adaptive refinement (strain-energy-norm target, up to 5 loops) and p-adaptive refinement (order 2→5). Fusion offers AMR with a % results tolerance, a portion of elements to refine and a max refinement count, with "good results generally in < 8 steps". Gmsh has no built-in error estimator. It supports error-driven remeshing through a PostView size field set as the background mesh, so a loop is feasible: solve, estimate error per element, compute target size, remesh, repeat.

### Cited findings
- SOLIDWORKS h-adaptive: refines the mesh without changing element order. The target accuracy acts on the strain-energy norm, "NOT the stress accuracy level". Maximum 5 loops; optional coarsening in low-error regions. p-adaptive: raises element order from 2 up to 5, judged on total strain energy, RMS von Mises stress or RMS displacement; solids only. — [SOLIDWORKS help, p-adaptive](https://help.solidworks.com/2022/english/SolidWorks/cworks/IDC_HELP_PRESTATIC_P_ADAPTIVE.htm); [SOLIDWORKS 2012 Adaptive Methods](https://help.solidworks.com/2012/English/SolidWorks/Cworks/Adaptive_Methods.htm); [GoEngineer blog](https://www.goengineer.com/en-us/blog/solidworks-simulation-solution-adaptive-mesh-refinement); [Hawk Ridge blog](https://www.hawkridgesys.com/blog/simulation-adaptive-meshing/)
- Fusion AMR:
  - Presets: None/Low/Medium/High/Custom.
  - Fields: "Maximum Number of Mesh Refinements" (takes precedence), "Results Convergence Tolerance" (%), "Portion of Elements to Refine" (%).
  - "Good results are generally achieved in < 8 refinement steps."
  - Mesh convergence page: stress change below about 1–2% between iterations counts as converged. Displacements converge before stresses.

  — [Autodesk help, Apply AMR](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/SIM-SETUP-ADAPT-REFINE.htm); [AMR concept](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/SIM-ADAPTIVE-REFINEMENT-CONCEPT.htm); [Mesh convergence](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/SIM-MESH-CONVERGENCE.htm)
- **[course]** Fusion AMR works only with a single load case. — [Autodesk course page](https://autodesk.com/learn/ondemand/course/fusion360-simulation-applications-for-static-stress-analysis-professional/unit/6r7X1AreecoPmYQgHVLRYn)
- **[forum]** Repeated h-adaptive runs keep changing results near singularities, so run hot-spot diagnostics first. — [Reddit r/SolidWorks (via redlib mirror)](https://redlib.hyperreal.coffee/r/SolidWorks/comments/1josowb/mesh_convergence_advice/mkufa7w/?context=3)
- Gmsh PostView sizing: "PostView fields specify an explicit background mesh in the form of a scalar post-processing view … in which the nodal values represent the target sizes. This method is very general but it requires a first (usually rough) mesh and a way to compute the target sizes on this mesh (usually through an error estimation procedure, e.g. in an iterative process of mesh adaptation)." — [Manual §1.2.2](https://gmsh.info/doc/texinfo/gmsh.html#Specifying-mesh-element-sizes)
- Tutorial t7 shows the API pattern: `field.add("PostView")` with ViewTag, then `field.setAsBackgroundMesh`. — [Gmsh t7.py (Debian 4.13.1 source)](https://sources.debian.org/data/main/g/gmsh/4.13.1%2Bds1-6/tutorials/python/t7.py)
- **[forum, maintainer]** For adaptation loops use 2 models: attaching the background data to the mesh of the model being remeshed destroys it. See the `adapt_mesh.py` API demo. — [Gmsh list 2019/013167](https://onelab.info/pipermail/gmsh/2019/013167.html), [2019/013172](https://onelab.info/pipermail/gmsh/2019/013172.html); [adaptive meshing using PView threads](https://onelab.info/pipermail/gmsh/2019/013391.html)
- **[forum]** Mesh-based views are more memory-efficient than list-based views for this purpose. — [Gmsh list 2019/013391](https://onelab.info/pipermail/gmsh/2019/013391.html)
- Alternative: since 4.9.0 the size callback receives the default lc and can return any value, so a size map can be applied without building views. — [Changelog 4.9.0](https://gmsh.info/CHANGELOG.txt)

### Inferences
- Reasonable Wren loop ("Refine where it matters", single load case):
  1. Solve on the initial mesh.
  2. Per element, compute a Zienkiewicz–Zhu-style estimate: the difference between the raw stress and the nodal-averaged (recovered) stress, or the strain-energy-density error.
  3. Compute a new size h_new = h_old·(η_target/η_e)^(1/p), with p = 2 for C3D10, clamped to [h_old/3, 2·h_old] and to MeshSizeMin.
  4. Set it as a mesh-based PostView in a second model, or as a size callback sampling an octree of target sizes, and remesh.
  5. Stop when the change in max von Mises stress at user-tagged probe regions, and in global strain energy, is below 2% (Fusion-like), or after 5 loops (SOLIDWORKS-like).
  6. Exclude singularities: re-entrant corners and point loads or constraints never converge. Detect monotonically growing peaks and report "singularity" instead of refining forever.
- Cheaper first step: a "convergence check" button that remeshes at MeshSizeFactor 0.7 and 0.5 and plots peak stress and strain energy vs DOF. This is fully deterministic and needs no error estimator.
- Note: CalculiX outputs error estimators (ERR/HER for heat) in some versions; I have not verified this here.

### Gaps
- I did not verify which error-estimator outputs CalculiX provides (for example `*EL FILE` ERR); this needs the CalculiX manual.
- No published Gmsh+CalculiX adaptive loop reference implementation was reviewed.

## Performance, determinism and threading

### Takeaway
Gmsh seeds its RNG deterministically (`Mesh.RandomSeed` = 1) and adds tiny random perturbations (`RandomFactor` 1e-9 in 2D, `RandomFactor3D` 1e-12). Past non-determinism came from pointer-ordered STL containers, which were fixed over time. Parallelism is OpenMP-only: coarse-grained across curves and surfaces in 1D/2D, and fine-grained inside a volume in HXT. Multi-threaded runs are a likely source of run-to-run variation.

### Cited findings
- `Mesh.RandomSeed` = 1; `Mesh.RandomFactor` = 1e-9 ("should be increased if RandomFactor × size(triangle)/size(model) approaches machine accuracy"); `Mesh.RandomFactor3D` = 1e-12. — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)
- Threading:
  - `General.NumThreads` = 1: "Maximum number of threads used by Gmsh when compiled with OpenMP support (0: use system default, i.e. OMP_NUM_THREADS)".
  - `Mesh.MaxNumThreads1D`, `2D` and `3D` = 0 (0 means use General.NumThreads).
  - 1D and 2D are parallel across entities. "3D meshing using HXT is parallelized using a fine-grained approach."

  — [Manual §1.2.1 and options](https://gmsh.info/doc/texinfo/gmsh.html#Choosing-the-right-unstructured-algorithm)
- Reproducibility history:
  - 2.8.4 "better reproductibility of 2D meshes"
  - 2.9.0 "improved reproductibility of 2D and 3D meshes"
  - 4.3.0 "fixed regression introduced in 4.1.4 that could lead to non-deterministic 2D meshes"
  - 4.9.5 "better handling of max. thread settings"

  — [Changelog](https://gmsh.info/CHANGELOG.txt)
- **[forum]** 2014 root cause: seeds were fixed, but `std::set` containers ordered by pointer address made output vary between runs. Patches ordering them by tag were merged. — [Gmsh list 2014/009415 thread](https://onelab.info/pipermail/gmsh/2014/009415.html); [2014/009036](https://onelab.info/pipermail/gmsh/2014/009036.html)
- **[forum]** A FreeCAD issue points to `Mesh.RandomSeed` for reproducibility. — [FreeCAD #7818](https://github.com/FreeCAD/FreeCAD/issues/7818)
- `Geometry.OCCParallel` = 0 controls multi-threaded OCC booleans. — [Manual](https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options)

### Inferences
- Likely sources of the spike's ±0.5% variation:
  - multi-threaded meshing, if Wasm threads were on
  - remaining pointer-ordered containers, sensitive to allocation patterns in Wasm
  - nondeterministic input order (OCC tag assignment differing between runs)
  - OCCT triangulation reuse (`Mesh.StlLinearDeflection` / `StlAngularDeflection` defaults 0.001 relative and 0.3 rad; the manual says these are used for OCC STL representations)
- Test plan:
  1. Fix `General.NumThreads = 1`, `RandomSeed = 1`, the same entity order and the same options, then hash the node coordinates over 10 runs.
  2. If the hashes match single-threaded, accept the variation as a threading artefact. Offer "deterministic mode" (1 thread) for golden tests and CI.
- In a browser, OpenMP needs Emscripten pthreads, which in turn need SharedArrayBuffer and cross-origin isolation (Wren already self-hosts assets for this). Without them, Gmsh runs single-threaded.

### Gaps
- No recent (4.11–4.15) source confirming whether HXT output is bitwise-identical across thread counts.
- No Gmsh-on-Wasm performance data found.

## Licence

### Takeaway
Gmsh is GPL-2.0-or-later with a linking exception that permits combination with Netgen, METIS, OpenCASCADE, ParaView and contrib/BoundaryLayers under their own licences. TetGen/BR in Gmsh is relicensed under Gmsh's licence. Netgen is LGPL-2.1 and Mmg is LGPL. Distributing a Wasm bundle containing Gmsh makes the combined web app subject to GPL obligations (source availability). That is compatible with Wren being open source, if Wren's licence is GPL-compatible.

### Cited findings
- LICENSE.txt: "GNU General Public License (GPL), Version 2 or later, with the following exception: … permission to combine Gmsh with code included in the standard release of Netgen (from Joachim Schöberl), METIS …, OpenCASCADE … and ParaView …, as well as contrib/BoundaryLayers under their respective licenses … provided that you include the source code of that other code when and as the GNU GPL requires". Modified versions need not carry the exception. — [Gmsh LICENSE.txt (GitHub mirror)](https://raw.githubusercontent.com/live-clones/gmsh/master/LICENSE.txt)
- CREDITS.txt:
  - "The TetGen/BR code (src/mesh/tetgenBR.{cpp,h}) is copyright (c) 2016 Hang Si, WIAS. It is relicensed under the terms of LICENSE.txt for use in Gmsh thanks to a Software License Agreement".
  - Other bundled code is under permissive licences: AVL tree (UC), picojson (BSD-2), nanoflann (BSD), libOL (MIT), robin_hood (MIT), and others.
  - "Optional codes … in the contrib/ directory … are each covered by their own respective license."
  - HXT/tetMesh is credited to Célestin Marot.

  — [Gmsh CREDITS.txt (GitHub mirror)](https://raw.githubusercontent.com/live-clones/gmsh/master/CREDITS.txt)
- Gmsh uses BLAS/LAPACK (replaced the GSL dependency in 2.3.1). — [Changelog 2.3.1](https://gmsh.info/CHANGELOG.txt)
- Netgen: LGPL-2.1 (package metadata disagrees on -only vs -or-later). — [Ecosyste.ms NGSolve/netgen](https://awesome.ecosyste.ms/projects/github.com%2FNGSolve%2Fnetgen); [NGSolve forum on licence](https://forum.ngsolve.org/t/license/1221)
- Mmg: "GNU Lesser General Public License"; the repository carries COPYING (GPL-3.0) and COPYING.LESSER (LGPL-3.0). — [mmgtools.github.io](https://mmgtools.github.io/)
- The official 4.14 binaries use OCC 7.8 (relevant because Wren links OCCT 8). — [Changelog 4.14.0](https://gmsh.info/CHANGELOG.txt)

### Inferences
- Wren must publish the corresponding source for its Gmsh Wasm build, including any patches and the build scripts. Netgen and Mmg (if enabled) bring LGPL notices. Record all of them in docs/DEPENDENCIES.md.
- If Mmg (3D=7) and Netgen optimizer features are not needed, building without them reduces both licence surface and Wasm size. The Netgen optimizer is useful, though, and the "Frontal" 3D algorithm depends on it.
- Not legal advice. GPL + web distribution (the Wasm is served to browsers) should be reviewed.

### Gaps
- Which BLAS/LAPACK implementation (and licence) Wren's Wasm build links was not determined; it depends on the build.
- The Gmsh GitLab LICENSE/CREDITS pages required sign-in through the proxy, so I read the official GitHub mirror (live-clones/gmsh) instead.
