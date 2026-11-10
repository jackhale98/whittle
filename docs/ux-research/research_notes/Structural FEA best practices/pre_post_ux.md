# Pre- and post-processing UX of CAD-embedded and CalculiX-based FEA tools

Scope: PrePoMax (deepest coverage, from the 2.4.0 manual of 15 Oct 2025), Onshape Simulation, SOLIDWORKS Simulation and SimulationXpress, Autodesk Fusion Simulation, FreeCAD FEM, Autodesk Inventor Stress Analysis, SimScale, and Ansys Discovery. Research budget was limited (about 18 tool calls). Coverage of Inventor, SimScale, and Reddit or Eng-Tips sentiment is thin, and the Gaps sections say so.

Abbreviation: "PPM manual" means the [PrePoMax 2.4.0 manual](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf). I extracted it with pdftotext and read the relevant sections directly. It is the primary source for every PrePoMax claim below.

Trademark note for Wren naming: SimulationXpress, Design Study, SOLIDWORKS Simulation, Fusion, Onshape, Inventor, SimScale, Ansys Discovery (Explore and Refine are Discovery mode names), and PrePoMax are product or feature names. Wren should use generic terms such as "quick check wizard", "parameter sweep" or "what-if table", "study", "real-time preview", and "refine solve".

---

## Pre-processing (study types, materials, fixtures, loads, picking and glyphs, mesh controls, pre-run checks)

### Takeaway
CAD-embedded tools give non-experts a short list of study types (linear static first, then modal), a material library, and a small set of fixtures and loads. They put the expert detail behind mates, coordinate systems, or an "advanced" layer. PrePoMax exposes almost the whole CalculiX keyword set through a tree and property panels. Its key lesson for Wren is how it stores selections: geometry-based selections survive remeshing and mesh-based ones do not. ID-based and location-based geometry selections can diverge when the geometry changes.

### Cited Findings

**Study and analysis types**
- PrePoMax step types: Static, natural frequency (real and complex), steady-state dynamics, modal dynamics, dynamic (implicit and explicit), linear buckling, heat transfer, uncoupled and coupled temperature-displacement, and slip wear (Archard model). — [PPM manual §2](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- Onshape Simulation offers only linear static and modal (natural frequency) analysis. It has no fluid or thermal analysis, and the help says it is "only available for" Assemblies. — [Onshape Help: Simulation](https://cad.onshape.com/help/Content/simulation.htm)
- Onshape Simulation is available only to Professional and Enterprise customers (blog, 18 Jul 2025, vendor/promotional). — [Onshape blog](https://www.onshape.com/en/blog/onshape-simulation-fundamentally-improving-cad-fea)
- SimulationXpress (SOLIDWORKS' free tool) runs basic linear static analysis on single-body parts. It allows only fixed fixtures, assumes all loads are uniform and constant, and needs the full Simulation product for nonlinear materials. — [SOLIDWORKS help: SimulationXpress User Interface](https://help.solidworks.com/2018/English/SolidWorks/cosmosxpresshelp/c_SimulationXpress_User_Interface.htm); [Overview of SimulationXpress](https://help.solidworks.com/2018/english/solidworks/cosmosxpresshelp/c_overview_of_solidworks_simulationxpress.htm) (2018 help; older than the preferred window, but the workflow has not changed materially)
- The SimulationXpress wizard steps are Fixtures → Loads (force or pressure on faces) → Material → Run → Results → Optimize (vary one dimension against a criterion), plus a Word report. — [SOLIDWORKS help: SimulationXpress UI](https://help.solidworks.com/2018/English/SolidWorks/cosmosxpresshelp/c_SimulationXpress_User_Interface.htm)
- In Fusion, linear static stress solves are covered by the subscription. Other study types cost cloud tokens (about 3 to 6 per solve, per the help table as summarized in search). — [Fusion Help](https://help.autodesk.com/view/fusion360/ENU/?guid=GUID-97268379-A0C4-4426-8929-2FB3F3FB439C) (I could not verify the exact numbers by fetch)

**Materials**
- PrePoMax has a built-in material library stored in `materials.lib`, with categories. You copy materials between the library and the model with arrow buttons, and must press Save explicitly. Users can open several library files (New/Add/Remove) to exchange materials. A checkbox previews a library material's properties. Material models are linear elastic, plastic, thermal, and slip wear, all isotropic with optional temperature dependency. Density is needed only for modal, gravity, or centrifugal analysis. — [PPM manual §5.2](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- Onshape needs density, Poisson's ratio, Young's modulus, and tensile yield strength on every non-fixed instance. Yield is needed for safety factor. Poisson's ratio of −1.0 or 0.5 cannot be simulated, and "some standard library materials do not work". — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- SimulationXpress reuses the part's CAD material if one is assigned and otherwise draws from the shared SOLIDWORKS library. — [SOLIDWORKS help: SimulationXpress UI](https://help.solidworks.com/2018/English/SolidWorks/cosmosxpresshelp/c_SimulationXpress_User_Interface.htm)

**Fixtures / boundary conditions**
- PrePoMax BCs:
  - Fixed: all DOFs.
  - Displacement/Rotation: per DOF U1–U3 and UR1–UR3, each Unconstrained, Fixed, or a Value, in a global or user coordinate system, with an amplitude.
  - Submodel and Temperature.
  - Constraints: point spring, surface spring (elastic support), rigid body, tie, and compression-only.
  - Rigid body constraints are documented as the way to apply moments and remote loads.
  - — [PPM manual §2, §5.7](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- PrePoMax has no dedicated "symmetry", "roller", or "pin" fixture. You express them with per-DOF displacement constraints, possibly in a local coordinate system. — inferred from the BC list in the [PPM manual](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- Onshape needs at least one fixed instance unless Inertial relief is on. Loads cannot act through a fixed instance. Pin, slider, and similar behaviours come from mates rather than standalone fixture tools. Connectivity is inferred from mates and touching faces, and a "Show connections" view colour-codes the connection types. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- Onshape's Inertial relief is a checkbox for unconstrained bodies. The vendor blog says that without full constraint "the simulation will fail". — [Onshape blog: structural weakness](https://www.onshape.com/en/blog/how-to-assess-your-models-for-structural-weakness)
- SOLIDWORKS fixtures apply to faces, edges, and vertices, and a model is fully constrained when all its DOFs are removed. — [SOLIDWORKS blog: Getting Started, fixtures and loads](https://blogs.solidworks.com/products/solidworks/getting-started-with-solidworks-simulation-fixtures-and-loads/)
- SOLIDWORKS users model a ball-and-socket restraint with Remote Load/Mass and rotations set to 0 (vendor reseller tip). — [Hawk Ridge](https://hawkridgesys.com/blog/how-to-apply-a-remote-load-in-solidworks-simulation)

**Loads**
- PrePoMax loads:
  - Concentrated force (components "per node", with the magnitude computed from the components), moment, pressure, hydrostatic pressure, imported pressure, surface traction, normal shell edge load, gravity, centrifugal, and pre-tension (bolt).
  - Thermal: concentrated, surface, and body flux, convective film, and radiation.
  - Every load has Preview and Propagate (to later steps).
  - Gravity can prescribe any translational acceleration.
  - Pre-tension needs a boundary layer created first and must be fixed in the second step.
  - — [PPM manual §2, §5.7](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- PrePoMax's concentrated force is per node, not a total. Users must therefore divide totals themselves or use surface traction or a rigid body with a reference point. This is a classic CalculiX trap. — [PPM manual §5.7 "Concentrated force"](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf) (the trap framing is my inference)
- Onshape loads are Force, Moment, Bearing, Pressure, Acceleration (whole instance only), and Angular velocity (centrifugal, with no actual rotation). Direction comes from a mate connector's Z-axis, which can be reversed. Magnitudes are per axis. "Load regions" localize a load to chosen faces. Each load feature can select only one instance. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- An Onshape user (forum, Jan 2025) found it hard to apply one load across faces of different parts. — [Onshape forum](https://forum.onshape.com/discussion/26671/simulation-of-a-weldment-frame)
- SOLIDWORKS Bearing Load acts on cylindrical faces or circular shell edges with a sinusoidal or parabolic distribution. It needs a coordinate system whose z-axis coincides with the cylinder axis. — [SOLIDWORKS help 2021: Bearing Loads](https://help.solidworks.com/2021/english/SolidWorks/cworks/c_Bearing_Loads.htm); [Bearing Load PropertyManager 2022](https://help.solidworks.com/2022/english/SolidWorks/cworks/IDC_HELP_DIRECTED_BEARING_LOAD.htm)
- A plain force on a hole gives a uniform load, so a bearing load is preferred when hole-region stress matters (reseller blog). — [Javelin](https://www.javelin-tech.com/blog/2019/04/solidworks-simulation-bearing-load/)
- SOLIDWORKS Remote Load/Mass acts on faces relative to a coordinate system. In 2021 it was consolidated into Distributed and Rigid types, and Mass needs a Gravity load in the study. — [SOLIDWORKS help 2024: Fixtures/External Loads toolbar](https://help.solidworks.com/2024/english/SolidWorks/cworks/c_Simulation_Toolbar_-_Fixtures-External_Loads.htm); [GoEngineer](https://www.goengineer.com/blog/using-remote-loads-solidworks-simulation)

**Picking and glyphs**
- PrePoMax offers two selection paradigms:
  - Geometry-based selection "is more limited… but its definition is not lost when the model is remeshed".
  - FE-mesh-based selection "becomes invalid" after remeshing.
  - Geometry selection can be stored "by location" or "by ID". The two are equivalent for plain remesh or regenerate. If geometry changes (Regenerate Using Other Files, Swap Part Geometries), results "may change". ID-based is reliable when topology numbering is unchanged, and location-based "might fail".
  - — [PPM manual §5.1, p.25](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- PrePoMax's symbol settings set separate colours per category (constraint, initial condition, BC, load, defined field), symbol size, node symbol size, and "draw symbol edges". — [PPM manual, Settings → Pre-processing](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- PrePoMax previews applied pressure, imported pressure, and temperature fields as contour plots in the Results tab. — [PPM manual §5.7](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- PrePoMax's Query tool reports IDs, area or length, and min/max/total of the displayed field on a vertex, edge, surface, or part, and adds model annotations. Find highlights entities by ID, which helps when the solver reports bad nodes or elements. — [PPM manual §3, Tools → Query/Find](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- PrePoMax fields accept unitless parameters and equations (prefix `=`, NCalc functions) for materials, sections, loads, and BCs. — [PPM manual §3](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)

**Mesh controls**
- PrePoMax meshing parameters:
  - Absolute or Relative size definition, with max and min element size (or factor).
  - Grading from 0 (uniform) to 1 (aggressive).
  - Elements per edge and elements per curvature.
  - Second order, midside nodes on geometry, and quad-dominated.
  - Gmsh 2D algorithms.
  - — [PPM manual §4 Mesh menu](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- PrePoMax has local Mesh refinement on a surface, edge, or vertex with a size, which "can be previewed before generating the mesh". Preview Edge Mesh draws points where nodes will be generated, so the user can judge size before meshing. — [PPM manual §4](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- PrePoMax element quality query reports a highlight limit and min/max/average/std-dev. — [PPM manual §4](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- Onshape has no user mesh controls on the help page. It uses a "proprietary adaptive-refinement" FE method with up to five adaptive passes per run, and warns against aspect ratios above 100:1 and thin walls. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- Inventor uses h-adaptive convergence settings. "Max h refinements" defaults to 0, and Autodesk advises keeping it below 5 (ideally 3 or 4). The stop criterion is 10% between consecutive refinements. You can choose the result to converge (von Mises or displacement) and include or exclude geometry so singularities don't drive refinement. — [Inventor 2025 help: Convergence Settings](https://help.autodesk.com/cloudhelp/2025/ENU/Inventor-Help/files/GUID-E039A3C5-8266-470C-98E6-78CD3090F36F.htm); [Inventor help: accuracy and convergence](https://help.autodesk.com/view/INVNTOR/2023/ENU/?caas=caas%2Fsfdcarticles%2Fsfdcarticles%2FAccuracy-of-Stress-Analysis-Results-and-Convergence-in-Inventor-Stress-Analysis.html)
- SimScale creates second-order meshes for linear static automatically, and the order can be changed under Element Technology. — [SimScale wheel loader tutorial](https://www.simscale.com/docs/tutorials/tutorial-linear-static-analysis-of-a-wheel-loader-arm/)
- SimScale's mesh quality visualization exists, and its roadmap portal has an item for it. — [SimScale roadmap](https://roadmap.simscale.com/c/46-mesh-quality-visualization)

**Pre-run checks**
- PrePoMax's Analysis → Check Model "performs input check, no calculations are performed". — [PPM manual §5.8](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- Onshape status icons: a gray info icon means ready to run, and a warning icon means an error, with a suggested fix on hover. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- In FreeCAD FEM, a load with no path to a constraint makes CalculiX fail with "negative pivot" errors. The docs recommend confirming the solver runs before debugging. — [FreeCAD docs: FEM CalculiX](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/FEM_CalculiX.md); [FreeCAD FEM Install](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/FEM_Install.md)
- FreeCAD FEM defaults to mm-N-s units, so stresses are in MPa. — [FreeCAD docs: FEM CalculiX](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/FEM_CalculiX.md)

### Inferences
- The "minimum" fixture and load set that covers most single-part cases in CAD tools is: Fixed, per-DOF displacement (gives roller, slider, and symmetry), elastic support, force (total, spread over faces), pressure, moment or torque, bearing, gravity or acceleration, centrifugal, and remote load via a rigid coupling. Bolt preload and thermal can wait.
- Wren should present force as a total distributed over the selection. Where it writes CalculiX `*CLOAD` per node, it must split the total across nodes, or use `*DLOAD` traction or a rigid-body reference node. Users of CalculiX GUIs regularly trip over "per node".
- PrePoMax's two failure modes (mesh selections die on remesh, and location or ID selections drift when geometry changes) are exactly what Wren's persistent naming must solve. Wren should surface "needs attention" rather than quietly re-picking.
- Onshape gets pin and slider behaviour from mates because it is assembly-only. For Wren's single-part S1, explicit fixture types (or DOF presets in local cylindrical coordinates) are needed instead.

### Gaps
- I did not retrieve SOLIDWORKS's full fixture list (roller/slider, hinge, elastic support, symmetry) or its glyph conventions from 2020+ help. The general Fixtures page was not fetched.
- Fusion's load and constraint lists, and any Fusion "pre-check" feature, were not found. Searches for a Fusion pre-check returned nothing.
- I found no source on how Fusion, Inventor, or SimScale draw load and fixture glyphs.
- I did not verify FreeCAD FEM constraint names (Fixed, Displacement, Force, Pressure, Contact, etc.) against current docs.

---

## Running (progress, logs, errors, re-solve after design changes, load survival, staleness)

### Takeaway
Onshape sets the bar: results stream live with a progress bar, refresh on every model change, and there is an asynchronous mode for long runs. PrePoMax gives a raw but complete Monitor (solver output, status, convergence, .dat), Kill, and a history-regeneration mechanism for re-running after changes. Fusion and FreeCAD show the failure modes: results flagged out of date, and loads that lose their references after edits, with the advice to revert to an older version.

### Cited Findings
- PrePoMax's Analysis menu has Run, Check Model, Monitor ("solver output, job status, convergence information and dat file contents"), Results, and Kill. Analysis Edit lets you choose CalculiX or Abaqus and pass extra CalculiX arguments. — [PPM manual §5.8](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- PrePoMax's CalculiX settings: executable path, work directory or ".pmx folder as work directory", default solver, number of processors, and environment variables. — [PPM manual Settings → CalculiX](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- PrePoMax re-runs from recorded command history:
  - It records every command, and an Edit History editor allows delete, reorder, and drag-drop.
  - Regenerate History reruns all commands or only model commands.
  - Regenerate Using Other Files swaps in new geometry.
  - Regenerate With Remeshing keeps mesh-based sets.
  - CLI flags `-r` (regenerate), `--parametersExport`, and `-x` allow batch parameter studies.
  - — [PPM manual §3.1–3.2](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- PrePoMax warns that editing history changes Regenerate behaviour, and that a very long history can slow the app because it is saved after every command. — [PPM manual §3.2](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- Onshape real-time runs stream intermediate iterations to the browser behind a blue progress bar. A green checkmark marks convergence, and results refresh automatically when the CAD changes ("results always reflect the current model state"). — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- Onshape's asynchronous runs store results permanently in a "Results and history" table and lift the live time limit, timing out only after 24 hours. — [Onshape Tech Tip: saving results](https://www.onshape.com/en/resource-center/tech-tips/asynchronous-simulation-saving-results)
- Onshape runs can fail with 100 or more instances, 10,000 or more contact pairs, timeouts, or memory limits. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- Onshape's vendor blog (Jul 2025) claims results are "always-on" and "update as you model", and recompute for new branches or configurations. This is opinion and marketing. — [Onshape blog](https://www.onshape.com/en/blog/onshape-simulation-fundamentally-improving-cad-fea)
- Fusion marks results "Out of date" after geometry edits. In one support case, reaction-force inspection returned zero while the contour still showed results, and Autodesk's workaround was to open the earlier version. — [Autodesk support: reaction forces disappear](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Event-Simulation-Reaction-Forces-disappear.html)
- A Fusion forum responder diagnosed that a study's loads and constraints "likely lost their references" after a design change, and advised reverting via Version History. — [Autodesk forum: Starting over in Simulation](https://forums.autodesk.com/t5/fusion-support-forum/starting-over-in-simulation-environment/td-p/14062725)
- Fusion: a cloud study could not be cancelled once results were received, and showed "Study Results currently solved will be out of date". — [Autodesk support: unable to cancel cloud study](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Unable-to-cancel-Cloud-Study-Simulation-in-Fusion.html)
- FreeCAD's underlying toponaming problem breaks references when upstream features change:
  - "Face3" labels are valid only for a single evaluation, and PR #32814 adds semantic IDs to make face and edge picks sticky.
  - Issue #29154: changing a pad length breaks references downstream.
  - — [FreeCAD PR #32814](https://github.com/FreeCAD/FreeCAD/pull/32814); [Issue #29154](https://github.com/freecad/freecad/issues/29154)
  - I found no FEM-specific issue, so the effect on FEM constraints is an inference.
- FreeCAD FEM writes a CalculiX input file, starts the solver, and reads the `.frd` back. Results types are displacement, stress, strain, plastic strain, and temperature. — [FreeCAD docs: FEM CalculiX](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/FEM_CalculiX.md)
- SimScale's forum advice for a failed run is to put a probe point at the coordinates in the error message, then check BCs (near a boundary) or mesh quality (in the interior), since "even just a few bad quality cells" cause divergence. — [SimScale forum: Simulation Run Failed](https://www.simscale.com/forum/t/simulation-run-failed/97456)

### Inferences
- Wren's Runner and file-handoff path needs PrePoMax-like transparency (live .sta/.cvg/.dat tail, Kill), with Onshape-like framing on top: a progress bar, a converged/failed state, and a hover fix suggestion. CalculiX "negative pivot" and "zero pivot" should be translated into "model can move freely: add a fixture or check which body has none".
- Results should carry a hash of the geometry, mesh, and study inputs. On any mismatch the viewer should show a "stale" banner that keeps the old plot visible but greyed, with "Re-solve". Fusion's "results look valid but probes return zero" behaviour is the trap to avoid: either everything is live, or everything is visibly marked stale.
- Translating CalculiX node or element IDs in errors into a highlighted location on the model (PrePoMax Find, SimScale's probe tip) is cheap and high value.

### Gaps
- I found no first-hand SOLIDWORKS sources on loads or fixtures breaking after rebuilds (the searches returned generic "missing faces" help). No Reddit or Eng-Tips threads were retrieved in budget.
- I did not obtain detail on Fusion's or SOLIDWORKS' progress UI or solver log display.
- Whether Onshape loads survive deletion of the referenced face is not documented in what I read.

---

## Post-processing (contours, averaging, deformation scale, result types, probes, sections, legend, comparison, reports, modal, thermal, export)

### Takeaway
Every tool shows contours, deformed shape with a scale control, animation, and legend min/max. The defaults differ in ways that matter: auto scale of 10% or 15% of the bounding box versus true scale, and statistically clipped legends. PrePoMax has the richest CalculiX post-processing for Wren to mirror: a deformation type dropdown with True scale, Automatic multiples, and User defined; 12 colour maps with discrete bands and manual limits; min/max location markers; section view; edge and surface query; derived fields such as safety factor, envelope, and equations; result mirroring and patterning; CSV history export; and deformed STL or INP export.

### Cited Findings

**Contours and averaging**
- SOLIDWORKS plots node values (averaged) by default. Element values (non-averaged) are under Advanced Options in the Stress Plot dialog. — [SDC Publications sample, Engineering Analysis with SolidWorks Simulation 2010](https://static.sdcpublications.com/pdfsample/978-1-58503-576-2-2.pdf) (an old source, but the behaviour persists in the [2024 Stress Plot PropertyManager](https://help.solidworks.com/2024/english/SolidWorks/cworks/hidd_help_stressplottype.htm), which I did not fetch)
- PrePoMax's Envelope field output creates MAX, MIN, and AVERAGE plots across all frames. I did not find an explicit averaged/unaveraged toggle in the 2.4.0 manual text. — [PPM manual §6.1](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)

**Deformation scale and animation**
- PrePoMax deformation scale Type: Undeformed, True scale, Automatic, Automatic ×0.25, ×0.5, ×2, ×5, and User defined (Factor). It can draw the undeformed model as wireframe or solid. It has first/prev/next/last increment buttons and Animate with an Animation window. — [PPM manual §6.1 Results toolbar](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- SOLIDWORKS deformed shape options are Automatic (largest deformation drawn at 10% of the largest bounding-box dimension), True scale (factor 1.0), and User defined. — [SDC sample (2010)](https://static.sdcpublications.com/pdfsample/978-1-58503-576-2-2.pdf)
- A GoEngineer community answer says the exaggerated automatic scale makes small deflections look large, and advises switching to "True scale" when judging deflection. — [GoEngineer Community](https://community.goengineer.com/forums/topic/8408-what-am-i-doing-wrong-customer-question-from-another-community/)
- Onshape: deformation scale defaults to 15% of the bounding-box diagonal, there is a play/stop animation loop, and hovering shows a numerical stress or displacement readout at the cursor. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- FreeCAD's simple Show Results view has a colour map with a slider to exaggerate deformation. — [FreeCAD docs: FEM CalculiX](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/FEM_CalculiX.md)

**Result types**
- Onshape result types:
  - von Mises: the range starts at 0, with a "statistically chosen useful maximum".
  - Signed von Mises.
  - Max principal stress.
  - Safety factor: yield divided by von Mises, with a default range of 3.5 down to 1.0.
  - Displacement.
  - Stress is in MPa and displacement in mm by default.
  - — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- PrePoMax derived fields:
  - "Limit" creates RATIO (output/limit) and SAFETY FACTOR (limit/output) per part or element set, with a part-limit table.
  - "Equation" builds fields from existing ones.
  - "Coordinate System Transform" transforms results into a user coordinate system.
  - Selected field outputs can be deleted to shrink files.
  - — [PPM manual §6.1](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- PrePoMax field outputs include contact states (e.g., PCON for frequency calculations). Slip wear outputs include wear depths. — [PPM manual §5.7](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)

**Probes**
- PrePoMax Query on a node shows the value of the displayed field. On an edge it shows max, min, and total along the edge plus its length. On a surface it shows max, min, and total plus area. Annotations can show min, max, sum, and average, and are labels on the model saved in .pmx. — [PPM manual §3, Settings → Annotations](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- PrePoMax History Output by Equation and filters (Min/Max/Sum/Average) let you report, for example, the full time history at the node of maximum value. The results can be exported to CSV. — [PPM manual §6.1](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- Inventor: a forum user found that the "maximum value" probe still showed stress on bodies excluded from convergence. A reply said the exclusion only affects refinement. — [Autodesk Inventor forum](https://forums.autodesk.com/t5/inventor-forum/stress-analysis-convergence-settings/td-p/6457547) (older thread; opinion)
- SimScale's static Result Control adds "point data" monitors, which are probe points defined before solving. — [SimScale docs: Result Control](https://www.simscale.com/docs/simulation-setup/result-control/); [SimScale docs: Static Analysis](https://www.simscale.com/docs/analysis-types/static/)

**Sections, iso-surfaces, and clipping**
- PrePoMax Section View cuts by a point plus a normal and also works in post-processing. In the Geometry tab, solids appear hollow when sectioned. — [PPM manual §3.3](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- FreeCAD's VTK pipeline filters are Warp, Scalar Clip, Function Cut, Region Clip, Contours (iso), Glyph, Line Clip (plot along a line), Data at Point, and Calculator. Results export to .vtk for ParaView. — [FreeCAD docs: FEM CalculiX](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/FEM_CalculiX.md); [FEM Workbench docs mirror](https://robertmassaioli.github.io/freecad-docs/fem/)

**Legend**
- PrePoMax legend options:
  - 12 spectra: Cool-warm, Rainbow, Rainbow desaturated, Warm, Cool, Cividis, Viridis, Plasma, Black body, Inferno, Kindlmann, Grayscale.
  - Brightness and reverse.
  - 2–24 discrete colours.
  - Scientific or general number format, with 2–8 significant digits.
  - Min/Max limit Automatic or Manual.
  - "Show min/max value location" (Yes/No).
  - A status block.
  - — [PPM manual Settings → Legend/Post-processing](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- Onshape legend options: editable min and max (an asterisk marks a manual value) with reset; Viridis (default), Blue→Red, Plasma, and Rainbow; "Dim color scale"; and "Show minimum/maximum". — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- PrePoMax "Color Contours off/on" can be set per part. — [PPM manual §6.1](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)

**Comparing designs and studies**
- SOLIDWORKS Design Study (trademark-style feature name):
  - Variables can be CAD dimensions, material properties, or loads.
  - Evaluation mode can run up to 10,000 what-if scenarios, and there is an Optimization mode.
  - Scenarios come from Variable View (all combinations) or Table View (manual).
  - Results View tab plots per-scenario results, with trend and design-history graphs.
  - — [SOLIDWORKS help 2025: Design Studies](https://help.solidworks.com/2025/English/SolidWorks/Sldworks/c_Design_Studies_SOLIDWORKS.htm); [Evaluation Design Study (2021)](https://help.solidworks.com/2021/english/SolidWorks/cworks/c_Design_Scenario_Module.htm); [Viewing the Results tutorial 2025](https://help.solidworks.com/2025/English/simconntutorial/t_viewingresults_paramevaldesignstudytut_cwbasics.htm)
- SOLIDWORKS Compare Results shows up to four plots in split windows, from the same or different studies. — [SOLIDWORKS help 2016: Compare Results](https://help.solidworks.com/2016/English/SolidWorks/cworks/HIDD_SIM_HELP_COMPARE_RESULTS.htm)
- Onshape lets you create multiple simulations, compare them in table columns, set one active, and integrate with versions and branching. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- PrePoMax can open multiple .frd results at once from a dropdown, and "Append Results" adds another .frd. — [PPM manual §6.1](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)

**Reports and export**
- SimulationXpress generates a Word report listing fixtures, loads, and results. — [SOLIDWORKS help: SimulationXpress UI](https://help.solidworks.com/2018/English/SolidWorks/cosmosxpresshelp/c_SimulationXpress_User_Interface.htm)
- The SOLIDWORKS Simulation product matrix lists "customize simulation reports". — [SOLIDWORKS Simulation product matrix PDF](https://www.solidworks.com/sites/default/filesd10/26docs06/SOLIDWORKS%20Simulation%20Desktop%20Product%20Matrix.pdf)
- PrePoMax exports:
  - History outputs to CSV (comma, semicolon, or colon delimiter).
  - Deformed mesh to .inp and deformed visualization to .stl, both respecting the current scale factor.
  - Materials to .inp.
  - Results Transformation (Symmetry mirror, linear or circular Pattern) expands results for visualization.
  - I found no built-in report generator in the 2.4.0 manual.
  - — [PPM manual §3.1, §6.1](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)

**Modal and thermal**
- PrePoMax frequency step settings: number of eigenfrequencies plus lower and upper frequency bounds. Linear buckling takes the number of buckling factors (default 1). Mode shapes are browsed through the increment controls. — [PPM manual §5.7 Step](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- Onshape modal analysis exists (natural frequency). — [Onshape blog: Introducing Modal Analysis](https://www.onshape.com/en/blog/introducing-modal-analysis-onshape-simulation)
- PrePoMax thermal covers heat transfer and coupled or uncoupled temperature-displacement steps, with temperature BCs, flux, film, and radiation loads. — [PPM manual §2](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)

### Inferences
- Wren's default deformation scale should be explicit about being exaggerated: show "×N (auto)" in the legend, and give a one-click "True scale" toggle. Two incumbents default to 10% or 15% of the bounding box, which users misread.
- Onshape's statistically clipped legend max avoids singularity-dominated plots. But it must be signposted (asterisk or "clipped" badge), with the true max still marked, so peak stress is not hidden.
- PrePoMax's Limit-based safety-factor field is a clean way to compute safety factor from material yield on CalculiX output without solver support. The same goes for von Mises and principal stresses, which CalculiX .frd provides.
- The face, edge, and node Query (min/max/total/average plus area or length) maps directly to Wren's "probe on a selected face" requirement.

### Gaps
- I did not fetch SOLIDWORKS help on its factor-of-safety wizard, iso-clipping, section clipping, or probe/list-selected. These are known features, but I have no 2020+ citation in these notes.
- Fusion's and Inventor's results UI (probes, report formats, animation) was not retrieved.
- I found no source confirming whether PrePoMax offers an unaveraged (element) contour mode or iso-surfaces.
- I found no source on VTK/CSV export of full field results from Onshape, Fusion, or SOLIDWORKS.
- SimScale's post-processor (cutting planes, iso-surfaces, report) was not retrieved.

---

## Complaints and praise

### Takeaway
Praise centres on integration and immediacy: Onshape's "always-on" results, Discovery's instant updates and fidelity slider, SOLIDWORKS' what-if studies, and PrePoMax's clear free GUI. Complaints centre on Fusion's cloud-only solving and tokens (cost, speed, opaque balance), references lost after design changes (Fusion, FreeCAD toponaming), CalculiX GUI gaps (PrePoMax is Windows-only, and some features need keyword editing), and misleading auto deformation scale.

### Cited Findings
- **Fusion cloud-only solving:**
  - Autodesk removed local simulation solving in 2022. Earlier local results stay viewable, but new or updated simulations need the cloud. — [Hackaday, Aug 2022](https://hackaday.com/2022/08/12/local-simulation-feature-to-be-removed-from-all-autodesk-fusion-360-versions/); [Autodesk support: local simulation](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/How-to-perform-a-local-simulation-in-Fusion-360.html)
  - Users protested in forum threads titled "Local Solve Taken from us" and "Cloud solving will be the only option". — [Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/local-solve-taken-from-us/td-p/11786105); [Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/fusion-360-cloud-solving-will-be-the-only-option-available-for/td-p/11342929)
- **Fusion speed and credits:**
  - A user reported about 15 s locally versus about 6 min on the cloud for the same linear static model. This is anecdotal, and the thread was 403 to fetch, so it comes from the search snippet.
  - The same thread complains that cloud credits were renamed "Tokens" and the balance was not clearly shown.
  - — [Autodesk forum: "Cloud credits are not integrated well"](https://forums.autodesk.com/t5/fusion-support-forum/bug-cloud-credits-are-not-integrated-well-reconsidering-the/td-p/11843592)
  - Opposite view: one G2 reviewer called running locally "just as easy" as using credits. This single snippet predates the removal. — [G2](https://www.g2.com/compare/fusion-360-vs-simscale)
- **Lost references after edits:** Fusion's loads and constraints lose references after geometry changes, and the advice is to revert to an older version. — [Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/starting-over-in-simulation-environment/td-p/14062725). FreeCAD toponaming breaks face and edge picks. — [FreeCAD PR #32814](https://github.com/FreeCAD/FreeCAD/pull/32814)
- **Misleading deformation scale:** SOLIDWORKS users are told to switch to True scale because the auto scale exaggerates. — [GoEngineer Community](https://community.goengineer.com/forums/topic/8408-what-am-i-doing-wrong-customer-question-from-another-community/)
- **Onshape limits:**
  - Assembly-only.
  - One instance per load feature.
  - Thin walls and sheet metal are impractical, and runs fail beyond 100 instances.
  - — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
  - A user struggled to apply one load across several parts. — [Onshape forum, Jan 2025](https://forum.onshape.com/discussion/26671/simulation-of-a-weldment-frame)
- **Onshape praise:** Simulation results "within minutes", "always-on", and updating as you model. This is the vendor's opinion. — [Onshape blog, Jul 2025](https://www.onshape.com/en/blog/onshape-simulation-fundamentally-improving-cad-fea)
- **Ansys Discovery:**
  - Its pitch is "real-time physics simulation that updates instantly as geometry changes". — [Ansys Discovery](https://ansys.synopsys.com/products/3d-design/ansys-discovery)
  - The fidelity slider moves right for more fidelity, and you can type a percentage after pressing the spacebar. — [Ansys Innovation Space tip (May 2023)](https://innovationspace.ansys.com/knowledge/forums/topic/fidelity-slider-bar/)
  - The real-time Explore mode is separate from the high-fidelity Refine mode. — [Ansys tutorial](https://innovationspace.ansys.com/knowledge/forums/topic/fluid-simulation-in-ansys-discovery-in-depth-tutorial/)
  - An analyst suspects the instant first pass is low-fidelity. This is speculation. — [Lifecycle Insights](https://www.lifecycleinsights.com/assessing-ansys-discovery-live-offering/)
- **PrePoMax praise:** Reviewers call it a "very easy, clear interface" with good documentation (opinion). — [FEA4free](https://fea4free.com/the-best-free-fea-software-packages/). A CalculiX forum user says "freecad fea is nice and so is prepomax". — [CalculiX Discourse](https://calculix.discourse.group/t/best-workflow-for-beginners/2060?page=3)
- **PrePoMax criticisms:**
  - It is Windows-only, so Linux needs Wine.
  - It trails commercial codes in breadth.
  - Some advanced CalculiX features need keyword editing.
  - Users want fatigue.
  - These come from blogs and forum posts of mixed reliability. — [freecfdtutorial blog (2026)](https://freecfdtutorial.blogspot.com/2026/10/prepomax-fea-software-guide.html); [CalculiX Discourse](https://calculix.discourse.group/t/best-workflow-for-beginners/2060?page=3)
- **CalculiX speed versus commercial (user benchmark):** about 2–3× slower for geometric nonlinear, and about on par for linear at 8 CPUs. The same user praised the scripted workflow as "very smooth". — [PrePoMax Discourse benchmark](https://prepomax.discourse.group/t/cpu-benchmark-study-prepomax-vs-commercial-fem-and-prepomax-tutorials/3115)
- **Inventor convergence guidance:** Inventor offers guidance via convergence settings, but defaults to 0 h-refinements. Users must turn convergence on and exclude singularities themselves. — [Inventor help: Convergence Settings](https://help.autodesk.com/cloudhelp/2025/ENU/Inventor-Help/files/GUID-E039A3C5-8266-470C-98E6-78CD3090F36F.htm)

### Inferences
- Wren's local-solve stance (the user's own CalculiX) directly answers the most vocal Fusion complaint. Make "free, local, no tokens, works offline" a headline.
- "Instant results" is the most-praised trait. Wren's file-handoff path cannot be instant, but the localhost Runner could auto-re-solve small linear static models on edit, with a coarse preview mesh and then a refined one, which is a Discovery-like fidelity pattern.

### Gaps
- No Reddit (r/SolidWorks, r/Fusion360, r/onshape, r/FreeCAD, r/fea) or Eng-Tips threads were retrieved within the tool budget. Sentiment here is drawn from vendor forums, blogs, and docs.
- No DEVELOP3D or Engineering.com reviews from 2020 onward were retrieved. One older Engineering.com Discovery Live piece appeared in results but was not read.
- I found no specific evidence on "unclear warnings" or "lack of convergence guidance" complaints, beyond the CalculiX negative-pivot behaviour and Inventor's defaults.

---

## Recommendations: minimum lovable setup and results experience, and traps to avoid

### Takeaway
Ship a narrow, opinionated linear-static (plus optional modal) flow with clear defaults. It should have:
- A study tree with a status per node.
- Materials from a small library with yield strength.
- Fixtures and loads stored on persistent face names and drawn as glyphs.
- One mesh-size slider plus explicit size and local refinement with preview.
- A pre-flight check.
- Transparent local solving.
- A results viewer that is honest about scale, averaging, legend clipping, and staleness.

Copy PrePoMax's breadth only where it costs little in the UI.

### Cited Findings (evidence base for each recommendation)
- **Study tree with readiness states:** Onshape's per-study gray (ready) and warning (error, with a hover fix) icons work well. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm). PrePoMax's tree order is Model, then Steps (BCs, loads, field outputs), then Analysis, then Results. — [PPM manual](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- **Materials:** Require yield strength so a safety factor is possible, and block Poisson's ratio 0.5. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm). Use a shareable library file. — [PPM manual §5.2](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- **Persistent picks:** Mesh-based picks die on remesh, and ID- or location-based picks can drift when geometry changes. — [PPM manual p.25](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf). Lost references are what users hit in Fusion and FreeCAD. — [Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/starting-over-in-simulation-environment/td-p/14062725); [FreeCAD PR #32814](https://github.com/FreeCAD/FreeCAD/pull/32814)
- **Force semantics:** CalculiX GUI concentrated force is per node. — [PPM manual §5.7](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- **Bearing load:** A uniform force on a hole misrepresents bearing contact, so offer a sinusoidal or parabolic bearing load. — [SOLIDWORKS help: Bearing Loads](https://help.solidworks.com/2021/english/SolidWorks/cworks/c_Bearing_Loads.htm); [Javelin](https://www.javelin-tech.com/blog/2019/04/solidworks-simulation-bearing-load/)
- **Mesh preview and refinement:** Use Preview Edge Mesh and local refinement preview. — [PPM manual §4](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf). For convergence guidance, use h-refinement up to 3–4 passes with a 10% stop criterion and singularity exclusion. — [Inventor help](https://help.autodesk.com/cloudhelp/2025/ENU/Inventor-Help/files/GUID-E039A3C5-8266-470C-98E6-78CD3090F36F.htm). Onshape runs up to five adaptive passes automatically. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- **Pre-flight:** Run a Check Model (input check without solving). — [PPM manual §5.8](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf). Detect under-constraint before the solver reports "negative pivot". — [FreeCAD docs](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/FEM_CalculiX.md). Offer inertial relief as the alternative. — [Onshape blog](https://www.onshape.com/en/blog/how-to-assess-your-models-for-structural-weakness)
- **Running:** A Monitor with solver output, status, convergence, .dat, and Kill. — [PPM manual §5.8](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf). A progress bar with streamed iterations and a converged checkmark. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- **Staleness:** Avoid Fusion's half-stale state, where probes read zero while contours still show. — [Autodesk support](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Event-Simulation-Reaction-Forces-disappear.html)
- **Results defaults:**
  - Make the scale type visible and offer True scale. — [PPM manual §6.1](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf); [GoEngineer](https://community.goengineer.com/forums/topic/8408-what-am-i-doing-wrong-customer-question-from-another-community/)
  - Use Viridis by default, editable min/max with a manual-value marker, show min/max, and dim colour scale. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
  - Use discrete bands from 2 to 24. — [PPM manual](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf)
- **Probes:** Show min, max, and total or average on a face or edge, with labels that persist. — [PPM manual §3 Query](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf). Add cursor hover readout. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm)
- **Compare:** Multiple studies in table columns. — [Onshape Help](https://cad.onshape.com/help/Content/simulation.htm). Split-view of up to four plots. — [SOLIDWORKS Compare Results](https://help.solidworks.com/2016/English/SolidWorks/cworks/HIDD_SIM_HELP_COMPARE_RESULTS.htm). Parameter sweeps (later). — [SOLIDWORKS Design Studies](https://help.solidworks.com/2025/English/SolidWorks/Sldworks/c_Design_Studies_SOLIDWORKS.htm)
- **Report:** SimulationXpress's Word report of fixtures, loads, and results is the baseline. — [SOLIDWORKS help](https://help.solidworks.com/2018/English/SolidWorks/cosmosxpresshelp/c_SimulationXpress_User_Interface.htm)
- **Export:** CSV for probes and history, and VTK for ParaView. — [PPM manual §6.1](https://prepomax.fs.um.si/wp-content/uploads/2025/10/PrePoMax-v2.4.0-manual.pdf); [FreeCAD docs](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/FEM_CalculiX.md)

### Inferences (proposed Wren S1 minimum lovable product; my synthesis)

**Setup**
1. Study tree: Study → Material → Fixtures → Loads → Mesh → Solve → Results. Each node shows a status (ok, needs attention, stale). Fixture and load nodes whose persistent face names fail to resolve show "needs attention" and are never auto-repicked, per the CLAUDE.md golden rule.
2. Fixtures: Fixed; Roller/slider (normal fixed); Pin on a cylinder (radial and axial fixed, free rotation, in a local cylindrical coordinate system); Elastic support (surface spring, stiffness per area); Symmetry plane; and Displacement per DOF (advanced).
3. Loads: Force (total, divided automatically, with an option to show it per face); Pressure; Torque or moment (via a rigid coupling to a reference point); Bearing (sinusoidal); Remote force (rigid or distributed coupling); Gravity; and Centrifugal. Defer bolt preload and temperature.
4. Glyphs: category colours (blue fixtures, red or orange loads), arrow count scaled to the face, and a magnitude label inline. Values are edited inline with units and expressions, so there are no modal dialogs.
5. Mesh: a single Coarse↔Fine slider mapped to an explicit max size, which is shown and editable. Add local refinement on faces or edges, an edge-node preview before meshing, a quality summary (min, mean, and worst element), and click-to-highlight the worst element. Second order by default (as SimScale does).
6. Pre-flight before writing .inp:
   - Material assigned, with E, ν < 0.5, and yield.
   - At least one fixture, or inertial relief.
   - A rigid-body-mode check of the free DOFs.
   - Loads with non-zero magnitude.
   - All references resolved.
   - Mesh up to date.
   - Each item links to the tree node.

**Solve**
1. Show a progress bar from .sta and .cvg, a collapsible raw log, and Kill.
2. Map common CalculiX errors (negative or zero pivot, "not converged", element distortion) to plain language with a highlighted location when node or element IDs are given.
3. Give file handoff and the Runner identical result import.
4. Store each result with an input hash. On any change, mark the whole result as stale (banner, desaturated plot, probes disabled or marked) with a one-click Re-solve. The Runner could optionally auto-re-solve linear static.

**Results**
1. Default plot: von Mises with averaged nodal values and an "unaveraged" toggle.
2. Legend: Viridis, min/max markers on the model, editable limits with a "manual" badge, discrete-band option, and auto-clip of singularities with an explicit "clipped" note and the true max still shown.
3. Deformation: auto scale shown as "×N"; True scale, ×0.5, ×2, and custom; undeformed ghost; and animation.
4. Results list: von Mises, principal stresses (1, 2, 3), displacement magnitude and X/Y/Z, safety factor (yield / von Mises, colour range about 1–3.5, as Onshape uses), strain, and reaction forces per fixture (a table, and a sum check against the applied loads).
5. Probes: click for a point value; select a face or edge for min, max, and average, plus area or length. Probes are pinned as labels and exportable to CSV.
6. Section plane with a draggable gizmo.
7. Mode table (frequency per mode, click to animate) if modal ships.
8. Export: VTK (.vtu) and CSV, plus a one-page HTML or PDF report (inputs, mesh stats, max values, images, and assumptions or warnings).
9. Compare: two studies side by side, or as table columns.

**Traps to avoid**
1. Per-node force semantics leaking to users.
2. Silently re-picking faces after edits.
3. Exaggerated deformation without a visible scale factor.
4. Legend clipping that hides peaks.
5. Results that look current but aren't.
6. Probes that disagree with the plot.
7. Solver errors shown as raw CalculiX text only.
8. Defaulting to zero mesh refinement with no convergence hint. At least show a "refine and compare" action reporting the percentage change in max stress and displacement.
9. Cloud or token gating, which is Fusion's most-resented change.
10. Needing every advanced CalculiX knob, which is PrePoMax's density. Put it behind an "advanced" disclosure.

**Generic naming**
Use "parameter sweep" or "what-if table", not "Design Study". Use "quick check", not "SimulationXpress". Use "live preview" or "refine", not Discovery's "Explore" and "Refine". Use "reaction check" or "probe" (generic).

### Gaps
- No usability studies or quantitative user-research data on CAD FEA UX were found. The recommendations are synthesis, not tested evidence.
- I did not confirm whether any incumbent auto-detects under-constraint before solving, beyond Onshape's status icon and requirement text.
