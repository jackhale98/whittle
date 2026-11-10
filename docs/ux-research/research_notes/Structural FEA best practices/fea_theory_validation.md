# Structural FEA theory, modelling practice and validation (for Wren S1: CalculiX, second-order tets)

Labelling convention used throughout: **[Theory/Std]** = theory, standards, or a published benchmark/reference value; **[Vendor]** = vendor documentation describing its own product behaviour; **[Practice/Opinion]** = practitioner blogs, forums, consultancies. Benchmark reference values are reported only where a source states them.

## 1. Verification and validation (ASME V&V 10, NAFEMS benchmarks, analytic cases)

### Takeaway
Verification (code: compare with exact/benchmark solutions; calculation: mesh convergence) is what Wren can automate in CI; validation (against physical tests) is out of scope for a CAD tool. The public reference values for LE1, LE10, LE11 and FV32 are reproduced consistently across vendor verification manuals. The prompt's description of FV52 is wrong: it is a simply supported solid plate, not a free one. LE10 and LE11 carry subtleties (a line constraint, a stress component that sources name differently) that must be handled before a CI tolerance is set.

### Cited Findings
**V&V definitions**
- [Theory/Std] The phrase "verification = solving the equations right; validation = solving the right equations" is attributed to Patrick Roache, not to ASME's own wording. Schwer also notes the two terms are often used interchangeably — [Schwer, WIT Press FSI05 paper](https://www.witpress.com/Secure/elibrary/papers/FSI05/FSI05011FU.pdf); [arXiv 2008.05414](https://arxiv.org/pdf/2008.05414)
- [Theory/Std] The ASME V&V committee was chartered "to develop standards for assessing the correctness and credibility of modeling and simulation in computational solid mechanics". Verification establishes that a computational model correctly describes the intended mathematical equations and their solutions — [arXiv 2008.05414](https://arxiv.org/pdf/2008.05414)
- [Theory/Std] ASME V&V 10.1 splits verification into (1) code verification, which compares against analytical solutions (para. 4.1), and (2) calculation verification, which is mesh convergence (para. 4.2). The standard itself is a paid ASME document — [GlobalSpec listing of ASME V&V 10.1](https://standards.globalspec.com/std/1519341/asme-v-v-10-1)
- [Practice] An overview of V&V in CAE — [SimScale blog](https://www.simscale.com/blog/verification-and-validation-cae/)

**NAFEMS benchmark provenance and access**
- [Theory/Std] The linear-elastic and free-vibration benchmarks originate in NAFEMS TNSB Rev. 3, "The Standard NAFEMS Benchmarks" (Oct 1990). FV32 is also cited to Abbassian, Dawswell & Knowles, "Selected Benchmarks for Natural Frequency Analysis" (NAFEMS, Nov 1987). COMSOL cites Davies, Fenner & Lewis, "Background to Benchmarks" (1993) for LE1 — [Abaqus Benchmarks LE1](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-le1.htm); [Abaqus FV32](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-fv32.htm); [HOOPS Solve benchmark report](https://docs.techsoft3d.com/hoops/mesh/_static/benchmark_reports/benchmark_results_2.13.0.pdf); [COMSOL elliptic membrane](https://doc.comsol.com/6.4/doc/com.comsol.help.models.sme.elliptic_membrane/elliptic_membrane.html)
- [Vendor] Problem definitions and reference values are freely reproduced in public verification manuals: ESRD StressCheck benchmark guide (free PDF), Abaqus Benchmarks Manual, Altair OptiStruct verification (OS-V), Ansys VM "Benchmark C" series, DIANA Verify, FeenoX/Fino, OnScale, HOOPS Solve. NAFEMS hosts "code verification" pages for OptiStruct, Nastran and Epilysis — [ESRD guide](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf); [Altair OS-V 0010](https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_le1_r.htm); [Ansys VM C2](https://ansyshelp.ansys.com/public/views/secured/corp/v261/en/ans_vm/Hlp_V_VMC2.html); [DIANA NAFEMS Benchmarks](https://manuals.dianafea.com/d105/Verify/Verifyse5.html); [NAFEMS OptiStruct code verification](https://www.nafems.org/publications/code-verification/optistruct-code-verification/); [NAFEMS resource R0006](https://www.nafems.org/publications/resource_center/r0006/)

**LE1: elliptic membrane (plane stress)**
- [Theory/Std] E = 210 GPa, ν = 0.3. Symmetry on AB and DC; uniform outward pressure of 10 MPa on outer edge BC. Target: tangential edge stress σyy at point D (x=2, y=0) = **92.7 MPa** — [ESRD guide](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf); [Altair OS-V 0010](https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_le1_r.htm)
- [Vendor] COMSOL notes that the 3-digit target is too coarse for convergence studies and uses **92.65817 MPa** as the converged value. ESRD's p-converged results are 92.70–92.75 MPa — [COMSOL](https://doc.comsol.com/6.4/doc/com.comsol.help.models.sme.elliptic_membrane/elliptic_membrane.html); [ESRD guide](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf)
- [Vendor] Mesh sensitivity: Abaqus CPS6 (quadratic triangle) gives 89.10 MPa (−4%) on the coarse mesh and 94.01 MPa (+1%) on the fine mesh. OptiStruct Tria6 fine gives 96.64 MPa (~4% high) — [Abaqus LE1](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-le1.htm); [Altair OS-V 0010](https://2019.help.altair.com/2019/os/topics/solvers/os/nafems_test_problem_le1_r.htm)

**LE10: thick plate under pressure (3D, directly relevant to solid tets)**
- [Theory/Std] Plate bounded by two ellipses: outer semi-axes 3.25 × 2.75 m, inner 2.0 × 1.0 m, thickness 0.6 m. E = 210 GPa, ν = 0.3. Uniform 1 MPa normal pressure on the upper face. Symmetry on DCD'C' (uy=0) and ABA'B' (ux=0); ux=uy=0 on outer face BCB'C'; uz=0 along the **mid-plane line** of BCB'C'. Target: σyy at D (2, 0, 0.6) = **−5.38 MPa** — [ESRD guide](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf); [Seamplex Fino LE10](https://www.seamplex.com/fino/cases/012-nafems-le10)
- [Theory/Std] ESRD: "constraints along a line are incompatible with 3D-elasticity". ESRD therefore fixed uz on the whole face BCB'C' and obtained −5.24/−5.25 MPa (−2.6%/−2.4%). FeenoX/Fino, keeping the line constraint, gets −5.36 MPa (0.37%) with a 6×4×2 hex20 mesh and −5.379 MPa (0.02%) with a refined mesh. The result therefore depends on how the singular line BC is idealised — [ESRD guide](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf); [Seamplex Fino LE10](https://www.seamplex.com/fino/cases/012-nafems-le10)
- [Vendor] OptiStruct hex20 results range from 5.32 (coarse) to 5.58 (fine) MPa — [Altair OS-V 0060](https://2022.help.altair.com/2022.1/hwsolvers/os/topics/solvers/os/nafems_test_problem_le10_r.htm)
- [Practice] CoFEA compares CalculiX, Code_Aster and Elmer on a thick-plate σyy benchmark. This is a ready-made cross-solver reference for CalculiX — [CoFEA thick plate](https://cofea.readthedocs.io/en/latest/benchmarks/001-thick-plate/model.html)

**LE11: solid cylinder/taper/sphere, temperature loading (thermo-mechanical)**
- [Theory/Std] E = 210 GPa, ν = 0.3, α = 2.3e−4 /°C. Imposed temperature T = sqrt(x²+y²) + z with reference temperature 0 °C. Quarter model with uz=0 on z=0, ux=0 on x=0, and uy=0 on y=0 and on face BCDE. Target: direct stress at point A = **−105 MPa** — [ESRD guide](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf); [OnScale LE11](https://onscale.com/help/solve/validation/validation-case-thermomechanical-nafems/)
- [Vendor] Sources name the stress component at A differently. ESRD and OptiStruct say σyy, while DIANA and HOOPS say σzz. Check against the figure before coding the extraction — [ESRD guide](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf); [DIANA Verify](https://manuals.dianafea.com/d105/Verify/Verifyse5.html); [HOOPS report](https://docs.techsoft3d.com/hoops/mesh/_static/benchmark_reports/benchmark_results_3.1.0.pdf)
- [Vendor] ESRD gets −105.2 MPa (+0.19%) with 8 hexes and **−105.5 MPa (+0.48%) with 317 tets** — [ESRD guide](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf)

**Other LE references in the same free guide (useful for shell/axisymmetric later)**
- [Theory/Std] LE2: 60 MPa. LE5: −108 MPa. LE6: 0.802 MPa. LE7: 25.86 MPa. LE8: 94.55 MPa. ESRD's converged 3D/axisymmetric solid results differ from the NAFEMS values by up to <3% (LE8: 91.93 MPa) because "axisymmetric shell theory was used in the original NAFEMS benchmark". Some NAFEMS reference values are therefore model-theory references, not exact 3D elasticity — [ESRD guide](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf)
- [Vendor] ESRD's convergence method: p-extension on a fixed mesh until discretisation error is <1% in the target extraction. Convergence was "evaluated independently of the NAFEMS reference solutions". All results were within 3% of NAFEMS — [ESRD guide](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf)

**FV32: cantilevered tapered membrane (modal)**
- [Theory/Std] NAFEMS reference frequencies for modes 1–6: **44.623, 130.03, 162.70, 246.05, 379.90, 391.44 Hz** — [Abaqus FV32](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-fv32.htm); [DIANA Verify node38](https://manuals.dianafea.com/d100/Verify/node38.html)
- [Vendor] Abaqus CPS6 is within ≤0.02% on all six modes, and CPS4 is within ≤0.46%. Modal frequencies converge much faster than stresses — [Abaqus FV32](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-fv32.htm)

**FV52: correction to the prompt**
- [Theory/Std] FV52 is a *simply supported* solid (thick) square plate, supported on the bottom edges only, which leaves 3 rigid-body modes at 0 Hz. It is not free-free. The free thin square plate is FV12. Reference frequencies for modes 4–10: **45.897, 109.44, 109.44, 167.89, 193.59, 206.19, 206.19 Hz** — [Altair OS-V 0455](https://2022.help.altair.com/2022/hwsolvers/os/topics/solvers/os/simply_supported_soid_square_plate_fv52_r.htm); [Ansys VM C5](https://ansyshelp.ansys.com/public/Views/Secured/corp/v261/en/ans_vm/Hlp_V_VMC5.html)
- [Vendor] Autodesk Fusion publishes this as a verification case (10 m × 10 m × 1 m thick plate): 44.61 Hz vs NAFEMS 45.897 Hz, −2.80%. A shipping CAD-embedded tool thus accepts a few percent error on this case — [Fusion help: modal verification](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/GUID-1ECFF5CF-9936-4E2F-BFEA-FED0D51E8140.htm)

**Analytic cases**
- [Theory/Std] Kirsch (1898): Kt = 3 for an infinite plate in uniaxial tension, with the peak at the hole edge perpendicular to the load. The Peterson finite-width correction gives ~3.04 at a/W = 0.1 — [solver-docs Kirsch verification](https://solver-docs.pages.dev/verification/plate_with_hole). The same project's pages disagree with each other (30.98 MPa ≈ 3.1% vs 31.418 MPa ≈ Kt 3.14), so use the theory from this source, not its numbers — [solver-docs gallery](https://solver-docs.pages.dev/v0.22.1/gallery/verification/example_verify_plate_with_hole)
- [Vendor] FEATool's thin-plate-with-hole tutorial compares FE tangential stress with the Kirsch expression along the symmetry line. The maximum is close to 3·σ∞ — [FEATool](https://featool.com/doc/Structural_Mechanics_00_hole_in_plate1.html)

### Inferences
- A sensible CI suite for S1 is LE10 (3D tets, pressure), LE11 (thermal-stress coupling), FV32 (modal, run as a thin 3D extrusion with in-plane constraint) and FV52 (3D solid modal with rigid modes), plus Kirsch, a cantilever and Lamé closed forms. LE1 can be run as a thin 3D extrusion.
- CI tolerances should be benchmark-specific. Use ~1–2% for FV32/FV52 frequencies with quadratic tets and ~3% for LE10, given the line-BC ambiguity: ESRD's −2.6% vs Fino's 0.02%. Wren must document which BC idealisation it uses (a face constraint is the natural one for CAD faces). LE11 within ~1% is achievable with tets.
- Use the "converged" reference (e.g. COMSOL's 92.658 MPa for LE1) or Wren's own refined-mesh run as a regression golden. Then also check against the NAFEMS value with a wider tolerance.
- Because Wren applies loads/BCs on CAD *faces*, NAFEMS cases that use line or point constraints (LE10 mid-plane line) need split faces or an equivalent face idealisation. That is itself a teaching point about singular BCs.

### Gaps
- NAFEMS paywall status: I did not confirm the price or access of TNSB Rev. 3 or "Background to Benchmarks". NAFEMS publications are generally sold, with member discounts, but this is unverified. The reference *values* above are all from free vendor manuals.
- FV32 geometry and material (taper dimensions, E, ν, ρ) were not retrieved; the Abaqus or DIANA pages above contain them. From memory (unverified): 10 m long, tapering 5 m to 1 m, t = 0.05 m, E = 200 GPa, ν = 0.3, ρ = 8000 kg/m³.
- NAFEMS thermal benchmarks T1 and T3: no reference values found. Only "T1 membrane with hot-spot, thermal stress" appeared in a listing ([NAFEMS Nastran code verification](https://www.nafems.org/publications/code-verification/nastran-code-verification/)). Unverified recollections that need a source: T1 σyy ≈ 50 MPa at point; T3 is 1D transient, ≈ 36.6 °C at 32 s (S1 steady thermal may not need T3); T4 is 2D conduction with convection, ≈ 18.25 °C. Do not use these without a source.
- I did not fetch sources for the closed forms for the Euler-Bernoulli/Timoshenko cantilever (δ = PL³/3EI + shear term), the Lamé thick cylinder, beam/plate natural frequencies (e.g. f₁ = (1.875²/2π)·√(EI/ρAL⁴) for a cantilever) or 1D conduction (q = kΔT/L). Cite a textbook (Timoshenko & Goodier; Roark; Blevins).
- FreeCAD FEM CalculiX and PrePoMax validation examples were not retrieved.

## 2. Stress singularities, St Venant, and convergence studies

### Takeaway
Singularities occur at re-entrant sharp corners, point or line loads, point or edge supports, and fixed-constraint corners. They are a property of the idealised mathematical model, so mesh refinement makes the peak grow without bound. A real stress concentration converges. The reliable diagnostic is to refine and watch a quantity at a fixed location. SOLIDWORKS automates this ("Stress Hot Spot Diagnostics"), Fusion teaches it through convergence plots, and Onshape sidesteps it by not putting the raw maximum on the legend.

### Cited Findings
- [Theory/Std] Singularities are inherent in FEA of idealised geometry and loads: sharp corners, point loads, fixed BCs. Physically, the material yields or cracks first — [Digital Engineering: Stress Concentrations and Singularities](https://www.digitalengineering247.com/article/dealing-stress-concentrations-singularities); [Dlubal FAQ 003336](https://www.dlubal.com/en/support-and-learning/support/faq/003336)
- [Theory/Std] ESRD (Szabó school): at a singularity "the error in the maximum stress is infinitely large even if the root-mean-square error in stress on the entire domain is negligibly small". Corner stresses from discrete models are "purely discretization dependent and therefore completely unreliable" — [ESRD: Why worry about singularities](https://www.esrd.com/why-worry-about-singularities/)
- [Theory/Std] A stress concentration converges to a finite value under refinement; a singularity keeps increasing — [Roland Smith: singularities vs stress concentrations](https://rsmith.home.xs4all.nl/engineering/singularities-versus-stress-concentrations-in-fea.html); [SOLIDWORKS help: Assessing Stress Hot Spots](https://help.solidworks.com/2017/english/solidworks/cworks/r_assessing_stress_hot_spots.htm)
- [Theory/Std, St Venant] The effect of a singularity is local, so stresses at some distance from it can be trusted — [SOLIDWORKS help: Assessing Stress Hot Spots](https://help.solidworks.com/2017/english/solidworks/cworks/r_assessing_stress_hot_spots.htm). [Practice] "Several elements away from the singularity, the stress will not be affected" — [Eng-Tips: re-entrant corners and singularity errors](https://www.eng-tips.com/threads/re-entrant-corners-and-singularity-errors.399496/latest)
- [Vendor] SOLIDWORKS "Stress Hot Spot Diagnostics" (2017+): right-click Results to run it. It has an adjustable sensitivity factor and works only for linear static studies with solid or shell meshes. 2018+ adds singularity detection: the user selects an area such as a sharp edge and sets a number of refinement levels. After refinement, genuine concentrations "filter out" and remaining hot spots indicate singularities. The help notes users may ignore localised singularities that are not near the area of interest — [Javelin: 2018 singularity diagnostic](https://www.javelin-tech.com/blog/2018/01/solidworks-simulation-stress-singularity-diagnostic/); [Javelin: 2017 hot spots](https://www.javelin-tech.com/blog/2016/09/solidworks-simulation-stress-hot-spots/); [Hawk Ridge: hot spot tool](https://hawkridgesys.com/blog/solidworks-simulation-stress-hot-spot-tool); [SOLIDWORKS API RunStressHotSpotDiagnosticsAndDetectSingularities](https://help.solidworks.com/2026/English/api/swsimulationapi/SolidWorks.Interop.cosworks~SolidWorks.Interop.cosworks.ICWResults~RunStressHotSpotDiagnosticsAndDetectSingularities.html); [GrabCAD tutorial](https://workbench.grabcad.com/tutorials/how-to-check-stress-singularity-in-solidworks-2021-or-later)
- [Vendor] SOLIDWORKS blog: a sharp corner introduces a singularity, and adding a fillet usually lets stresses converge — [SOLIDWORKS blog: What is a stress singularity](https://blogs.solidworks.com/products/solidworks/what-is-a-stress-singularity-in-solidworks-simulation)
- [Vendor] Autodesk Fusion: "Singularities are inherent to all FEA software. A sure sign that you have a singularity is that as you refine the mesh, the maximum stress value will continue to rise causing your convergence plot to diverge." They usually occur at sharp re-entrant corners and point loads — [Fusion blog: Quick tip, singularities](https://www.autodesk.com/products/fusion-360/blog/quick-tip-singularities-and-simulation/)
- [Vendor] Fusion mesh convergence guidance: convergence is reached when the change between successive iterations is "less than 1% or 2%", and "it is best not to base convergence on only the maximum stress in the model, regardless of its location". Adaptive refinement defaults to **None (off)**, with Low/Medium/High/Custom presets; "Good results are generally achieved in < 8 refinement steps"; the maximum refinement count takes precedence over the % tolerance — [Fusion: Mesh convergence](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/SIM-MESH-CONVERGENCE.htm); [Fusion: Adaptive mesh refinement](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/SIM-ADAPTIVE-REFINEMENT-CONCEPT.htm); [Fusion: Apply adaptive refinement](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/SIM-SETUP-ADAPT-REFINE.htm)
- [Vendor] Onshape: the highest stress "often... sits near a computational singularity and is not a useful value". The default legend maximum uses the **95th-percentile surface stress per part**, then the highest of those. Onshape also runs up to 5 adaptive passes and shows a green check when converged — [Onshape Simulation help](https://cad.onshape.com/help/Content/simulation.htm)
- [Vendor] Ansys Workbench adaptive convergence: refine on a chosen result until the change is within tolerance, or use the Zienkiewicz-Zhu error norm (stress; heat flux for thermal). It refines by default to a depth of 2 elements around high-error elements — [Ansys help 18.11 Using Adaptive Convergence](https://ansyshelp.ansys.com/public/Views/Secured/corp/v261/en/wb_sim/ds_Convergence.html)
- [Practice] Converge on a quantity at a specific location, not the global max; accept the mesh when the key result changes by only a few percent — [Quadco: FEA best practices](https://www.quadco.engineering/en/know-how/fea-best-practices.htm); [Simutecra: boundary conditions](https://simutecra.com/blogs/how-to-select-boundary-conditions-fea)
- [Practice] Real concentrations can be quoted as a stress concentration factor Kt from the peak — [Digital Engineering](https://www.digitalengineering247.com/article/dealing-stress-concentrations-singularities)
- [Practice] A peak confined to a single element, edge or corner is probably a singularity — [Central Innovation: Singularities, concentrations and hot spots](https://centralinnovation.com/?p=18464); [PADT](https://www.padtinc.com/?p=43835)

### Inferences
- Wren can implement a hot-spot check cheaply. After the solve, find elements whose stress exceeds X×(95th-percentile stress) and that lie on CAD edges with a re-entrant dihedral (no fillet) or on edges/vertices where a constraint or load boundary ends. Mark them as "likely singularity". Optionally auto-refine those regions 1–2 levels and confirm divergence.
- Default legend clipping, like Onshape's 95th percentile, protects non-experts from reading a singular peak as the design stress. Always show the true max separately, labelled.
- A convergence study should be a one-click action: re-solve at h/2 locally and plot the probe value. The UI should require a user-picked probe point, not the global max.

### Gaps
- I did not retrieve Ansys's own help page text on "stress singularities" (Ansys forum threads only). Workbench's "Convergence" object and its plot exist per the help above.
- No quantitative guidance was found for an automatic singularity threshold (e.g. a growth-rate test under refinement). The theory gives the corner-singularity exponent (λ−1, e.g. r^−0.456 for a 270° re-entrant corner, Williams 1952), but this was not sourced here.

## 3. Boundary conditions and loads

### Takeaway
The most common errors are over-constraint and under-constraint. Over-constraint means "Fixed" on faces that really slide, rotate or deform, which stiffens the part and creates fictitious support stresses. Under-constraint means rigid-body modes that make the solver fail or give huge displacements. Tools catch under-constraint at solve time and leave over-constraint to the user. Reaction checks catch both.

### Cited Findings
- [Practice] Over-constraint symptoms: overly stiff response, under-predicted displacement, over-predicted stresses near supports, and large opposing reactions in one direction. Use "Fixed" only where the real interface blocks those DOF — [Quadco](https://www.quadco.engineering/en/know-how/fea-best-practices.htm); [Sherpa Design: FEA boundary conditions](https://sherpa-design.com/articles/fea-boundary-conditions); [The Mechelite](https://www.themechelite.com/fea-boundary-conditions-reliable-mechanical-simulation/)
- [Practice] A point or perfectly fixed support produces a singularity — [Simutecra](https://simutecra.com/blogs/how-to-select-boundary-conditions-fea); [getCADfile setup guide](https://www.getcadfile.com/fea-simulation-setup-loads-fixtures-contacts-mesh-validation/)
- [Practice, Enterfea / Skotny] Check that supports react only in directions they can physically provide. A tensile reaction at a support meant to bear in compression invalidates it; use a contact (compression-only) support instead. If unsure about the supports, run both candidate sets and compare — [Enterfea: BC influence case study](https://enterfea.com/boundary-conditions-influence-on-static-design/); [Enterfea: 5 steps of FEA results verification](https://enterfea.com/5-steps-fea-results-verification/); [Enterfea: different BCs](https://enterfea.com/what-are-different-boundary-conditions-in-fea/)
- [Vendor] Onshape: unless inertial relief is used, at least one instance must be fixed; the solver "does not converge due to unconstrained rigid body motions". Inertial relief is for static only, not modal — [Onshape Simulation help](https://cad.onshape.com/help/Content/simulation.htm); [Onshape blog: structural weakness](https://www.onshape.com/en/blog/how-to-assess-your-models-for-structural-weakness)
- [Vendor] SOLIDWORKS: a large-displacement warning on an apparently restrained model usually means a body is not fully fixed. GoEngineer's diagnostic: remove loads and materials, solve, plot displacement with deformation off, and look for red (moving) bodies. "Soft springs" can stabilise the model as a diagnostic — [GoEngineer: Instability diagnosis](https://www.goengineer.com/blog/solidworks-simulation-instability-diagnosis)
- [Practice, Enterfea] Large reactions in "air hook" soft springs signal an unstable model. In a sound setup they carry nearly zero force — [Enterfea: 5 steps](https://enterfea.com/5-steps-fea-results-verification/)
- [Vendor] Abaqus: "Numerical singularity" warnings and very large displacements indicate unconstrained motion in static analysis — [Abaqus: contact troubleshooting](https://abaqus-docs.mit.edu/2017/English/SIMACAEITNRefMap/simaitn-c-contacttrouble.htm)

### Inferences
- For single-part S1, Wren can detect under-constraint *before* solving. For each rigid-body mode (3 translations, 3 rotations), check whether the union of constrained face DOFs suppresses it. One way is to assemble a 6-column rigid-body basis on the constrained nodes and check its rank. Flag "part can still slide in X / rotate about Z" inline, without a modal dialog.
- Recommended defaults for non-experts: offer "Fixed" but suggest alternatives where they fit. Use "Fixed hinge"/"Bearing support" or "Sliding (normal-only)" on cylindrical bolt holes, and "Symmetry" on planar cut faces. Apply loads as total force distributed over a face rather than as pressure unless the user chooses pressure. Show the total load and the computed reaction side by side after the solve.
- Symmetry BC = zero normal displacement on a planar face. CalculiX can do this with face-normal SPCs on axis-aligned faces or equations otherwise.

### Gaps
- Bolted joints (bolt hole as fixed vs bearing load vs remote load): the one search on this returned only uncitable aggregator snippets. Theory to source later: bearing loads are commonly modelled as a sinusoidal or cosine-distributed pressure over the loaded half of the hole, and remote loads use rigid or distributing couplings (RBE2 vs RBE3; CalculiX *DISTRIBUTING COUPLING vs *RIGID BODY).
- Gravity/centrifugal loads and thermal convection film coefficients/radiation: not researched in this pass because of the tool budget. Typical h values (free air ~5–25 W/m²K, forced air ~25–250) need a heat-transfer textbook citation.
- Antisymmetry conditions were not sourced.

## 4. Results interpretation and sanity checks

### Takeaway
The averaged-vs-unaveraged nodal stress difference is the basis of the standard error estimators: Ansys's energy-norm percent error (SEPC/PRERR) and Zienkiewicz-Zhu. Wren can compute either from CalculiX output and show it. Sanity checks a tool can automate: reaction sum = applied load, model mass vs CAD mass, deformation consistent with supports, and, for modal, rigid-body-mode count and mass participation.

### Cited Findings
- [Theory/Std] Ansys MAPDL energy-norm error: per element, the error energy is the integral of {Δσ}ᵀ[D]⁻¹{Δσ} over the element volume, where {Δσ} = averaged nodal stress − unaveraged nodal stress. The global percent error normalises by (strain energy + error energy). It is "a good overall global estimate of the discretization or mesh accuracy", but its correlation to displacement or stress error is problem-dependent, so treat it as a relative measure. If the error energy is a significant portion of total energy, re-mesh finer — [Ansys VM 1.4 Energy Norm](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_CH2_5.html); [Ansys SEPC](https://ansyshelp.ansys.com/public/Views/Secured/corp/v261/en/mech_addon/ds_customresults_sepc.html)
- [Theory/Std] Zienkiewicz & Zhu, "A simple error estimator and adaptive procedure for practical engineering analysis", IJNME 24:337–357 (1987). Workbench uses a ZZ norm for stress and heat flux in its adaptive convergence, but warns it is based on linear stresses and may be inaccurate with plasticity — [Ansys help 18.11](https://ansyshelp.ansys.com/public/Views/Secured/corp/v261/en/wb_sim/ds_Convergence.html)
- [Vendor] SOLIDWORKS "Discretization Error Estimation" uses the same energy-norm approach and recommends refining where error is high — [SOLIDWORKS help: Discretization error estimation](https://help.solidworks.com/2022/english/SolidWorks/cworks/c_Disrcetizatio_Error_Estimation.htm)
- [Practice] A 2004 ANSYS conference paper suggests an acceptance criterion of energy-norm error <15% for the model, applied to each high-stress region. This is third-party, not official guidance — [Scribd: 2004 Int ANSYS Conf paper](https://www.scribd.com/document/427693225/2004-Int-ANSYS-Conf-54-pdf)
- [Practice, Enterfea] The total reaction in each direction must equal the applied load (static equilibrium). Check reaction directions match support capability — [Enterfea: 5 steps](https://enterfea.com/5-steps-fea-results-verification/)
- [Vendor] Onshape factor of safety = tensile yield / von Mises. The default FoS legend runs from 3.5 (min tick) to 1.0 (max tick). Parts without a tensile yield get no FoS. Default deformation scale = 15% of the assembly bounding-box diagonal. Default units: MPa and mm. The default colour map is Viridis — [Onshape Simulation help](https://cad.onshape.com/help/Content/simulation.htm)
- [Vendor] Onshape ignores overridden mass values in simulation, which is relevant to the mass check — [Onshape Simulation help](https://cad.onshape.com/help/Content/simulation.htm)
- [Theory/Std] Modal mass participation: Eurocode EN 1998-1 requires that included modes total ≥90% of mass and that every mode with >5% effective mass is included. Other practice uses 80–90% or 95% — [SCIA: validation of modal analysis](https://kc.scia.net/Help/sr/dynamic_analysis_troubleshooting/validation_modal_analysis_seismic_specific.htm); [Irvine ModalMass rev K](https://blog.vibrationdata.com/wp-content/uploads/2026/02/ModalMass_revK.pdf); [Dlubal RFEM dynamic analysis](https://dlubal.com/en/downloads-and-information/documents/online-manuals/rfem-6-rstab-9-dynamic-analysis/000349)
- [Vendor] Autodesk: for a model unconstrained in a direction, rigid-body translation modes give 100% participation and all elastic modes 0% in that direction — [Fusion: Mass participation factors](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/SIM-MASS-PART-FACTORS-VIEW-CONCEPT.htm)
- [Theory/Std] FV52's simply supported plate has 3 rigid modes at 0 Hz, which a correct solver must reproduce — [Altair OS-V 0455](https://2022.help.altair.com/2022/hwsolvers/os/topics/solvers/os/simply_supported_soid_square_plate_fv52_r.htm)

### Inferences
- CalculiX writes reactions (RF) and, with *EL PRINT, element energies. Wren can compute (a) ΣRF + ΣF_applied ≈ 0 per axis, flagging any imbalance >0.1% of the applied load, (b) mesh volume × ρ vs CAD mass, flagging >1% (tet geometry error on curved faces), and (c) the ZZ/energy-norm percent per element, shown as an optional "result confidence" overlay.
- For free-free modal runs, Wren should expect 6 near-zero modes, label them "rigid body", exclude them from the frequency list, and warn if there are more than 6. More than 6 means disconnected bodies or mechanisms; fewer means unintended constraint.
- Mode shapes are mass-normalised (arbitrary amplitude). The UI must say displacement magnitudes in mode shapes are not physical.
- Von Mises with FoS on yield suits ductile metals. For brittle materials (cast iron, ceramics, many 3D-print polymers), use max principal vs UTS. The material library should carry a ductile/brittle flag that picks the default criterion.

### Gaps
- Von Mises vs Tresca vs principal criteria (ductile vs brittle) were not sourced. Cite a mechanics-of-materials text (e.g. Shigley).
- Thermal heat-flux balance (Σ input = Σ convective + radiative out) was not sourced.

## 4b. Linearity limits

### Takeaway
SOLIDWORKS is the clearest example of an automatic linearity check. It warns when max displacement exceeds 10% of the model's characteristic length and offers a large-displacement re-solve. Help pages add strain >4% and stresses near yield as triggers for nonlinear analysis. Linear static cannot represent yielding. Yield exceedance should be flagged as "result invalid beyond here", not as a factor of safety below 1.

### Cited Findings
- [Vendor] SOLIDWORKS large-displacement warning: triggered "if the ratio of the maximum displacement over the characteristic length of the model is larger than 10%". Answering Yes re-solves with incremental loading — [Hawk Ridge: Large displacement warning](https://support.hawkridgesys.com/hc/en-us/articles/215861808-Large-Displacement-Warning-for-Static-Studies-in-SOLIDWORKS); [SOLIDWORKS help: Large displacement solution](https://help.solidworks.com/2021/English/SolidWorks/cworks/c_large_displacement_solution.htm)
- [Vendor] SOLIDWORKS help recommends large displacement when contacting-face displacements are noticeable at scale factor 1.0, when the highest strain exceeds 4%, or when von Mises stress is close to yield — [SOLIDWORKS help: Large displacement solution](https://help.solidworks.com/2021/English/SolidWorks/cworks/c_large_displacement_solution.htm)
- [Practice] A linear static study "always lives in the linear range of a stress-strain curve". Past yield, a nonlinear (material) study is needed, and large displacement alone does not fix that — [Hawk Ridge blog: large displacement static studies](https://hawkridgesys.com/blog/large-displacement-static-studies)
- [Vendor] Onshape materials with ν = 0.5 (incompressible) or −1.0 cannot be simulated — [Onshape Simulation help](https://cad.onshape.com/help/Content/simulation.htm)

### Inferences
- Wren S1 checks: (1) max |u| / bounding-box diagonal > 5–10% raises a "large deflection — linear result unreliable" banner. (2) Max von Mises > yield anywhere other than at a flagged singularity raises a "material would yield — linear stresses above yield are not real" banner. (3) Load on faces that would separate (e.g. tensile reaction on a resting face) raises a "contact may be needed". Show the deformed shape at true scale (1:1) on request, so users can see actual deflection.
- Validate ν < 0.5 in the material library, and warn above ~0.49 because standard tets lock as ν→0.5 (see §5).

### Gaps
- I did not retrieve how Fusion or Inventor flag yield exceedance or large deformation.

## 5. Element choice theory

### Takeaway
Linear (4-node) tets are too stiff in bending because of parasitic shear and locking, and they need extremely fine meshes. Quadratic (10-node) tets, CalculiX C3D10, are the accepted general-purpose default and handle bending well even when coarse. Use first-order or hybrid formulations only for large strain or near-incompressible materials, which S1 excludes.

### Cited Findings
- [Theory/Std] Abaqus: first-order tetrahedra "are too stiff in bending, in particular if the element length is of the same order of magnitude as or greater than the wall thickness", because of parasitic shear strain. An "extremely fine mesh may be needed" — [Abaqus: Choosing continuum elements](https://abaqus-docs.mit.edu/2017/English/SIMACAEELMRefMap/simaelm-c-solidcont.htm); [Abaqus GSA: Selecting continuum elements](https://abaqus-docs.mit.edu/2017/English/SIMACAEGSARefMap/simagsa-c-ctmselecting.htm)
- [Theory/Std] Abaqus: second-order elements are "very effective in bending-dominated problems"; C3D10/C3D10M are "suitable for general usage". First-order elements are recommended when large strains or very high strain gradients are expected — [Abaqus: solid continuum elements](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEELMRefMap/simaelm-c-solidcont.htm)
- [Practice] A beam-bending study reports that the quadratic tet reproduces the analytic pure-bending solution even with one element through the depth. This is a single study, not a general rule — [Columbia: performance study of tet and hex elements](https://a.drupalgsb-test.paas.cc.columbia.edu/faculty/research/performance-study-tetrahedral-and-hexahedral-elements-3-d-finite-element)
- [Vendor] ESRD reached LE11 within 0.5% using tets (p-version), so tets are not inherently inaccurate when the order is high enough — [ESRD guide](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf)
- [Vendor] Onshape: geometries with aspect ratio >100:1 are not recommended; thin-walled parts may need too many resources — [Onshape Simulation help](https://cad.onshape.com/help/Content/simulation.htm)

### Inferences
- Wren should never offer C3D4 to non-experts. Hard-default to C3D10 and pre-check thin walls: compute local wall thickness from the B-rep or distance field and ensure the mesh size is ≤ thickness, so there are ≥2 quadratic elements through bending-dominated walls. Warn when that would exceed the element budget.
- Near-incompressible materials (rubbers, ν ≥ ~0.49) need hybrid or mixed formulations. S1 should block or warn on them.

### Gaps
- No source gave a definitive "N quadratic elements through thickness" rule. Practitioner rules of 2–3 are common but unsourced here.
- CalculiX-specific notes (C3D10 vs C3D10T behaviour, *STATIC solver choice) were not retrieved.

## 6. Guided workflows for non-experts (what CAD-embedded tools check)

### Takeaway
CAD-embedded tools rely on a few guards. The main ones are refusing or warning on an unconstrained model, adaptive refinement with a converged/not-converged indicator, singularity tooling or legend clipping, large-displacement detection, and colour-coded connection status. None found here explicitly flags over-constraint.

### Cited Findings
- [Vendor] Onshape (beta; Professional/Enterprise only): adaptive refinement up to 5 passes with a green check (converged) or yellow warning (hover for a suggested fix). Instances that are not connected are shown red, and multiple connection types yellow. Required material properties are validated (density, ν, E, yield), as is ν ≠ 0.5/−1. Unsupported mates are listed. There are hard limits of 100 instances and 10,000 contact pairs. No thermal analysis — [Onshape Simulation help](https://cad.onshape.com/help/Content/simulation.htm)
- [Practice] Onshape forum: failures from mates that never touch ("not touching... unconstrained rigid body motion"); Pin Slot is not supported — [Onshape forum: simulation failing](https://forum.onshape.com/discussion/25837/simulation-failing)
- [Vendor] SOLIDWORKS: Stress Hot Spot Diagnostics, the large-displacement warning (10% of characteristic length), and instability diagnosis with soft springs — sources in §2, §3 and §4b above.
- [Vendor] Fusion: adaptive mesh refinement (off by default), a convergence plot, singularity guidance, a mass participation view, and published NAFEMS verification cases — [Fusion: Adaptive refinement](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/SIM-ADAPTIVE-REFINEMENT-CONCEPT.htm); [Fusion: Mass participation](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/SIM-MASS-PART-FACTORS-VIEW-CONCEPT.htm); [Fusion: modal verification case](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/GUID-1ECFF5CF-9936-4E2F-BFEA-FED0D51E8140.htm)
- [Practice] Fusion forum: a model converged at 3%, but changing only the load direction broke convergence. The suggested fix was to tune "Results Convergence Tolerance", "Portion of Elements to Refine" and the max refinements. Users find convergence controls confusing — [Autodesk forum: Convergence issues](https://forums.autodesk.com/t5/fusion-design-validate-document/convergence-issues-in-simulation/m-p/6992800)
- [Practice] Ansys forum: "Not enough constraints appear to be applied to prevent rigid body motion" is often a warning, not an error, a common source of user confusion — [Ansys forum: pin-pin supports](https://innovationspace.ansys.com/forum/forums/topic/unconstrained-model-and-rigid-body-motion-error-on-pin-pin-supports-of-3d-modeled-beam/)

### Inferences
- Wren can go beyond the incumbents with a pre-solve checklist shown inline in the study panel. It would cover: constraints suppress all 6 rigid-body modes; every load has a non-zero magnitude and a face; materials have the required properties; minimum wall thickness vs mesh size. A post-solve "trust panel" would show the reaction balance, mass check, energy-norm error, large-deflection check, yield check and singularity markers, each green, amber or red.

### Gaps
- SOLIDWORKS SimulationXpress and Autodesk Inventor Stress Analysis wizard steps and warnings were not retrieved.
- Systematic forum mining (Eng-Tips, Reddit r/fea) for top mistakes was not done beyond the threads cited.

## 7. Communicating results responsibly

### Takeaway
Little primary guidance was retrieved on report contents and disclaimers. The concrete evidence is vendor defaults. Onshape labels the max stress as possibly singular, clips the legend to the 95th percentile, gives FoS a fixed 3.5→1.0 legend, uses a perceptually uniform colour map (Viridis), shows explicit units and a deformation scale, and marks the feature beta.

### Cited Findings
- [Vendor] Onshape defaults: Viridis colour scheme; displacement legend from 0 to max; deformation scale 15% of the bounding-box diagonal; units MPa and mm; the max-stress caveat; the feature labelled beta — [Onshape Simulation help](https://cad.onshape.com/help/Content/simulation.htm)
- [Vendor] ESRD's benchmark report is a model of what to include: problem definition, minimum vs dense mesh, convergence evidence graphs, and the % difference from the reference — [ESRD guide](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf)
- [Practice] Errors from misunderstanding the physics are not fixed by mesh refinement — [Machine Design: Easily made errors mar FEA results](https://www.machinedesign.com/archive/easily-made-errors-mar-fea-results)

### Inferences
- A Wren results report or export should include at least: geometry and version hash; material values; loads and constraints with a picture; mesh (element type C3D10, node count, minimum size); a convergence or error indicator; the reaction balance; max values with location and singularity flags; the FoS definition; displacement scale; units on every legend; and a fixed disclaimer that linear-static results assume small deformation, linear elasticity and no contact, and that this is not a substitute for engineering sign-off.

### Gaps
- The NAFEMS "How to Interpret Finite Element Results" and "How to... " series was not retrieved. These are NAFEMS sales publications, probably paywalled but unverified.
- I did not retrieve the disclaimer text of SOLIDWORKS SimulationXpress, Fusion or Onshape.
