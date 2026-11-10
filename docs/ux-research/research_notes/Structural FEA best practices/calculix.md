# CalculiX (ccx 2.21–2.23) for automatic deck writing and result reading

Scope and method notes (for the report writer):
- **The current release is ccx 2.23** (manual dated 19 Oct 2025). As of 2026-11-10 dhondt.de still says "Version 2.23 of CalculiX is available!", and `ccx_2.24.pdf` returns 404 — [dhondt.de](https://www.dhondt.de/). ccx 2.22's manual PDF is dated 5 Aug 2024 — [ccx_2.22.pdf](https://www.dhondt.de/ccx_2.22.pdf).
- I downloaded the 2.21, 2.22 and 2.23 manuals, converted them to text, and read or grepped them directly. Citations of the form "Manual 2.23 §x" refer to [ccx_2.23.pdf](https://www.dhondt.de/ccx_2.23.pdf). Unless a version is stated, the claim holds for the 2.23 text. I diffed the keyword lists of the 2.21, 2.22 and 2.23 manuals (see Q9).
- Each finding is tagged **[Manual]** (documented behaviour), **[Forum]** (user experience), **[Source]** (read from front-end or package source) or **[Packaging]**.

---

## 1. Element types (C3D4 / C3D10 / C3D10T / hexes; locking; shells and beams)

### Takeaway
CalculiX's own manual strongly recommends quadratic elements. For automatic tet meshing that means C3D10. Avoid C3D4 for structures. Use C3D10T only when there are thermal strains with steep initial-temperature gradients, since it removes checkerboard stresses. Shells (S6/S8R) and beams (B32R) are not true 2D/1D elements: ccx expands them into 3D wedges and bricks. This has consequences for output node numbering, for *TIE, for knots and induced nonlinearity, and for drilling DOFs.

### Cited Findings
- **[Manual 2.23 §6.2]** "quadratic elements are the most stable and robust elements in CalculiX. If you are not a finite element specialist the use of quadratic elements is strongly suggested." The recommended list is C3D20R (hex), C3D10 (tet), CAX8R, CPS8R, CPE8R, S8R (shell) and B32R (beam). "Other elements frequently exhibit unsatisfactory behavior… e.g. the C3D8 element in bending" — [ccx_2.23.pdf §6.2](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §4, Golden rule 3]** "USE QUADRATIC ELEMENTS (C3D10, C3D15, C3D20(R), S8, CPE8, CPS8, CAX8, B32), except for explicit dynamic calculations." Linear elements show "shear locking and volumetric locking". Other vendors modify the shape functions of linear elements in unpublished ways, but "CalculiX uses the standard shape functions for linear elements too, the results must be considered with care" — [ccx_2.23.pdf §4](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.2.6] C3D4:** has 1 integration point and is "not suited for structural calculations unless a lot of them are used (the element is too stiff). Please use the 10-node tetrahedral element instead." — [ccx_2.23.pdf §6.2.6](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.2.7] C3D10:** has 4 integration points and "behaves very well and is a good general purpose element, although the C3D20R element yields still better results for the same number of degrees of freedom… especially attractive because of the existence of fully automatic tetrahedral meshers." — [ccx_2.23.pdf §6.2.7](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.2.8] C3D10T:** "identical to the C3D10 element except for the treatment of thermal strains." In C3D10 the initial temperatures and the displacements are both interpolated quadratically, so the thermal strain is quadratic while the total strain is linear. The mechanical strain is therefore "neither purely linear nor purely quadratic", which "may lead to a checkerboard pattern in the stresses… especially in the presence of high initial temperature gradients." C3D10T interpolates the initial temperatures linearly. Linear temperature interpolation "is standard for the C3D20 and C3D20R element"; for C3D10 it is not the default "to keep the compatibility with ABAQUS." C3D10T is also present in the 2.21 manual (§6.2.8) — [ccx_2.23.pdf §6.2.8](https://www.dhondt.de/ccx_2.23.pdf), [ccx_2.21.pdf](https://www.dhondt.de/ccx_2.21.pdf)
- **[Manual 2.23 §6.2.5] C3D20R:** has 2x2x2 integration points and is "an excellent general purpose element (if you are… allowed to take only one element type with you, that's the one to take). It also performs well for isochoric material behavior and in bending and rarely exhibits hourglassing." Caveats:
  - The integration points sit about ¼ element size from the boundary and are extrapolated trilinearly, so surface stress peaks can be missed on coarse meshes.
  - "All quadratic elements cause problems in node-to-face contact" because the equivalent nodal forces at the vertex nodes are zero or have the opposite sign. This "seems to be solved if face-to-face penalty or mortar contact is used."
  - [ccx_2.23.pdf §6.2.5](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.2.2] C3D8R:** has 1 integration point and shows no locking, but it is "not stiff enough in bending" and needs small elements to capture stress concentrations — [ccx_2.23.pdf §6.2.2](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.2.3] C3D8I:** bubble (incompatible) modes remove shear locking and "much reduce" volumetric locking. It "should be used in all instances in which linear elements are subject to bending", but it "is not very good when subjected to torsion." B31 beams are expanded into C3D8I, so this weakness carries over to B31 — [ccx_2.23.pdf §6.2.3](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual / new features 2.23]** 2.23 lists a "Correction to the C3D8I element" — [dhondt.de/new_calc.htm](https://dhondt.de/new_calc.htm). **[Forum]** A thread titled "C3D8I fails patch test" discusses 2.22 used "+ patch from github (for C3D8I)" (March 2025) — [calculix.discourse.group](https://calculix.discourse.group/t/c3d8i-fails-patch-test/2332?page=2)
- **[Forum] Near-incompressibility:** users report that CalculiX has no hybrid (u-p) elements. A truly incompressible hyperelastic model therefore needs a slight compressibility. If zero compressibility coefficients are entered, ccx uses a default equivalent to ν = 0.475. Users suggest reduced-integration elements (C3D8R, C3D20R) when volumetric locking is suspected — [Incompressible material models](https://calculix.discourse.group/t/incompressible-material-models/1509), [volume locking thread](https://calculix.discourse.group/t/is-this-a-volume-self-locking-issue-please-if-so-how-can-i-solve-it/1908)
- **[Manual 2.23 §6.2.14] Shell expansion:** "quadratic shell elements are automatically expanded into 20-node brick elements". An S8 becomes a C3D20 and an S8R becomes a C3D20R; each shell node generates 3 new nodes. A 6-node shell expands into a 15-node wedge (Fig. 67) — [ccx_2.23.pdf §6.2.14](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.2.14] Knots:**
  - **Normals:** if no *NORMAL is given, normals are computed from the geometry. Normals within 20° of each other (0.5° for user-defined ones) are averaged. Where a node ends up with more than one normal, it is expanded several times and joined by a **knot**, "a rigid body which is allowed to expand uniformly" with 7 DOFs.
  - **Triggers:** knots are generated when normals differ (including neighbouring elements with an inverted normal), when element types are mixed (e.g. shells and beams), when thicknesses or offsets differ, or when a rotation or moment is applied in dynamics.
  - **Consequence:** the manual says "Care should be taken that the elements in plates and similar structures are oriented in a consistent way to avoid the generation of knots and the induced nonlinearity."
  - [ccx_2.23.pdf §6.2.14](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.2.14] Shell rotations and moments:** in static analysis (since 2.8), rotations and moments are handled by automatically generated mean-rotation MPCs. Drilling moments are not possible this way, and since 2.15 they are "automatically removed and a warning is issued". A drilling rotation must not be constrained unless all rotations in the node are zero — [ccx_2.23.pdf §6.2.14](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.2.14] Composite shells:** the COMPOSITE option exists only for S8R and S6. RF cannot be requested in the .frd, and *NODAL THICKNESS is not allowed — [ccx_2.23.pdf §6.2.14](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §4 rule 4; *NODE FILE] Shell and beam output:** use OUTPUT=3D (the default for beams and shells) to see the expanded elements. "The node numbers are new and do not relate to the node numbers in the input deck." OUTPUT=2D averages through the thickness and "removes the bending stresses in beams and shells". OUTPUT only takes effect if it is set in the first step, and OUTPUT=3D deactivates NSET — [ccx_2.23.pdf §7.97](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *EL FILE]** SNEG/SMID/SPOS (shell surface stresses) are only available for *user* shell elements. They "cannot be used [for] shell elements the label of which starts with S, since these are expanded into volumetric elements." — [ccx_2.23.pdf §7.52](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *TIE]** *TIE "can only be used with 3-dimensional elements (no plane stress, plane strain, axisymmetric, beam or shell elements)." — [ccx_2.23.pdf §7.133](https://www.dhondt.de/ccx_2.23.pdf)
- **[Forum] 2.23 regression:** FEAnalyst on the PrePoMax forum: "CalculiX 2.23 doesn't allow using rigid body constraints with 2D elements even in nonlinear analyses" and "The next version shouldn't have this limitation anymore." — [prepomax.discourse.group](https://prepomax.discourse.group/t/calculix-2-23-has-released/3626)
- **[Manual 2.23 §6.2.6–6.2.7]** CalculiX C3D10 node numbering follows Figure 63 of the manual (Abaqus convention) — [ccx_2.23.pdf](https://www.dhondt.de/ccx_2.23.pdf). The Gmsh manual's Tetrahedron10 diagram numbers edge nodes as 4:(0-1), 5:(1-2), 6:(0-2), 7:(0-3), 8:(2-3), 9:(1-3) — [Gmsh reference manual, node ordering](https://gmsh.info/doc/texinfo/gmsh.html#Node-ordering)

### Inferences
- For S1 (single-part linear static, modal and steady thermal on Gmsh tets), C3D10 is the right default. Offer C3D10T, or switch to it automatically, once thermal-stress (temperature-mapped) static analysis arrives. The switch is a one-word change in `*ELEMENT,TYPE=`.
- **Node ordering pitfall (inference, verify in the golden test):** Abaqus/ccx C3D10 numbers its edge nodes 1-2, 2-3, 3-1, 1-4, 2-4, 3-4. Compared with Gmsh's raw ordering above, the last two mid-edge nodes are swapped: Gmsh 8 = edge 2-3 (0-based), which is ccx node 10 = edge 3-4 (1-based). Gmsh's own `.inp` export reorders them. A hand-written writer from raw Gmsh connectivity must swap them too, or it produces distorted elements and "nonpositive jacobian" errors. The spike's 0.3% result suggests this is already handled. Lock it in with a test.
- Shells later: Wren's face-named sets on shells will not map 1:1 to .frd node numbers when OUTPUT=3D. The reader must handle expanded-node results, or use OUTPUT=2D for membrane-only views. *TIE cannot bond shells to solids, so shell-to-solid needs MPCs or *COUPLING/*RIGID BODY. Consistent shell normal orientation from the mesher avoids knots, which add nonlinearity.

### Gaps
- No manual text quantifies C3D10 volumetric locking as ν → 0.5. The forum gives only qualitative advice.
- I could not find whether B32/B32R expands to C3D20/C3D20R. The beam figure section was not extracted, though by analogy with shells it likely does.
- The version that introduced C3D10T is not established. It predates 2.21.

---

## 2. Analysis steps (*STATIC, *FREQUENCY, *BUCKLE, *HEAT TRANSFER, coupled, *DYNAMIC, NLGEOM, perturbation, amplitudes)

### Takeaway
A linear *STATIC step needs no data line. *FREQUENCY needs the number of modes, uses a consistent (non-lumped) mass, mass-normalizes the modes, and writes participation factors and effective modal masses to .dat automatically. *BUCKLE takes the load to scale and must not contain prescribed displacements or temperature loads. Steady thermal is `*HEAT TRANSFER,STEADY STATE`. PERTURBATION on *STEP is how a preload enters *FREQUENCY or *BUCKLE. NLGEOM persists into later steps once it is set.

### Cited Findings
- **[Manual 2.23 *STATIC]**
  - Loads of the last *STATIC step accumulate, with redefined loads replaced.
  - Parameters: SOLVER, DIRECT, EXPLICIT, TIME RESET, TOTAL TIME AT START.
  - "In a purely linear calculation the step size is always 1., no iterations are performed and, consequently, no second line underneath *STATIC is needed."
  - The second line holds the initial increment, step period, minimum increment (default min(initial, 1e-6·period)) and maximum increment.
  - Loads are ramped linearly by default.
  - *CREEP is switched off in *STATIC; use *VISCO instead.
  - [ccx_2.23.pdf §7.123](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *FREQUENCY]**
  - The data line holds the number of eigenfrequencies, the lower and upper bounds (in cycles/time), and a minimum explicit time step. "Only as many frequencies are calculated as requested in the first field… there is no guarantee that all eigenfrequencies within the requested range were calculated."
  - Parameters: SOLVER, STORAGE, GLOBAL, CYCMPC, ALPHA.
  - STORAGE=YES writes eigenvalues, modes, K and M to the binary `jobname.eig` for later *MODAL DYNAMIC, *STEADY STATE DYNAMICS or *SENSITIVITY. The default is NO.
  - SOLVER=MATRIXSTORAGE writes `.sti`, `.mas` and `.dof` and then stops.
  - ARPACK is the eigen-solver. "At the start of a frequency calculation all single point constraint boundary conditions… are set to zero."
  - A direct solver must be present: "If none is installed, no eigenvalue analysis can be performed."
  - [ccx_2.23.pdf §7.63](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.9.2]**
  - Mass: "the mass matrix is not lumped." ccx finds the largest eigenvalues of the inverse problem using SPOOLES (or another direct solver), which cuts run time "by about a factor of 100".
  - Steps: without PERTURBATION, "any steps preceding the frequency step do not have any influence."
  - Normalisation: modes are mass-normalized (generalized mass = 1).
  - Imaginary frequencies can appear when a preloaded stiffness is not positive definite.
  - Frictional contact can make K nonsymmetric and give complex eigenvalues.
  - [ccx_2.23.pdf §6.9.2](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.9.4 & *BUCKLE]**
  - The lowest eigenvalue is the buckling factor and is always written to .dat. "The load specified in a *BUCKLE step should not contain prescribed displacements."
  - All previous loads are removed and the buckle load is reset afterwards. A preload comes in only through PERTURBATION, taken from the last non-perturbative static step.
  - Temperature loading "is not allowed in a linear buckling step."
  - Only the stress stiffness is included, not the large-deformation stiffness.
  - Data line: number of buckling factors (usually 1), accuracy (default 0.01), Lanczos vectors per iteration (default 4×#eigenvalues), maximum iterations (default 1000).
  - ccx performs the static solve for the stress stiffness automatically.
  - [ccx_2.23.pdf §6.9.4, §7.5](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *HEAT TRANSFER]**
  - "A heat transfer analysis is always nonlinear since the material properties depend on the solution."
  - STEADY STATE gives a steady solution with loads ramped. Without it the analysis is transient, needs *SPECIFIC HEAT, and applies loads at full strength.
  - Other parameters: DIRECT, FREQUENCY, MODAL DYNAMIC, STORAGE, DELTMX (transient only), TIME RESET, TOTAL TIME AT START.
  - Second line: initial increment, period, minimum increment (default min(initial, 1e-5·period)), maximum increment.
  - SOLVER=MATRIXSTORAGE writes `.con` and `.sph`.
  - [ccx_2.23.pdf §7.73](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *STATIC / TIME RESET]** Thermomechanics can be split into heat-transfer steps followed by static steps, using TIME RESET. This "can be faster than using the *COUPLED TEMPERATURE-DISPLACEMENT option, which forces the same amount of iterations for the thermal as for the mechanical calculations" and faster than *UNCOUPLED TEMPERATURE-DISPLACEMENT, which forces the same number of increments — [ccx_2.23.pdf §7.123](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *STEP]**
  - **PERTURBATION:** allowed for *FREQUENCY, *BUCKLE, *GREEN, *MODAL DYNAMIC, *STEADY STATE DYNAMICS, *COMPLEX FREQUENCY and *STATIC. For *STATIC it only makes sense for submodel frequency runs; otherwise use NLGEOM. In *FREQUENCY and *BUCKLE "the last *STATIC step is taken as reference state," including large-deformation and stress stiffness and temperature-dependent material properties. "At the end of the step the perturbation load is reset to zero."
  - **NLGEOM:** "Once the NLGEOM parameter has been selected, it remains active in all subsequent static calculations." Turn it off with NLGEOM=NO. Look for the message "Nonlinear geometric effects are taken into account".
  - **INC:** maximum increments (default 100).
  - **AMPLITUDE=RAMP|STEP** overrides the procedure default (static = RAMP). Amplitudes on individual load cards take precedence.
  - [ccx_2.23.pdf §7.125](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.9.1]** Internally ccx works with 2nd Piola–Kirchhoff stress in the Lagrangian frame. For NLGEOM output it is converted to Cauchy stress — [ccx_2.23.pdf §6.9.1](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §4, rule 2]** "If you are dealing with a nonlinear problem, RUN A LINEARIZED VERSION FIRST… If the linear version doesn't run, the nonlinear problem won't run either." — [ccx_2.23.pdf §4](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §4, rule 6]** Explicit dynamics: use linear elements, node-to-face contact, and mass scaling, which is activated by giving a minimum time increment (the third entry under *DYNAMIC) — [ccx_2.23.pdf §4](https://www.dhondt.de/ccx_2.23.pdf)

### Inferences
- **Minimal S1 step templates (inferred from the manual):**
  - `*STEP` / `*STATIC` / loads / outputs / `*END STEP`
  - `*STEP` / `*FREQUENCY` / `N` (e.g. 10–20, with an optional upper bound) / outputs / `*END STEP`
  - `*STEP` / `*HEAT TRANSFER,STEADY STATE` / `1.,1.` / thermal BCs / outputs / `*END STEP`
- Because the frequency range is not guaranteed, Wren should request N modes. If the user asks for "all modes below f_max", check that the highest returned frequency exceeds f_max, and if not, rerun with more modes.
- Prestressed modal (later scope) = static step + `*STEP,PERTURBATION` + `*FREQUENCY`. Buckling = optional static preload + `*STEP,PERTURBATION` + `*BUCKLE`, with loads restated in the buckle step and no enforced displacements.

### Gaps
- I did not extract the *DYNAMIC and *COUPLED TEMPERATURE-DISPLACEMENT keyword details (parameters ALPHA, EXPLICIT, etc.); see Manual 2.23 §7.46 and §7.26.

---

## 3. Loads and boundary conditions

### Takeaway
Face loads on C3D10 are native. *DLOAD takes `elem,Px,value` (or an element set with Px). *DSLOAD and the thermal cards (*FILM, *DFLUX, *RADIATE) accept a face-based *SURFACE name, which removes the need for per-element face labels. Tet faces are S1–S4 / P1–P4 with fixed node triples. Never lump a face force equally to C3D10 nodes: consistent loads put 0 on corner nodes and 1/3 on mid-side nodes. For "remote" loads use the surface-based `*COUPLING` + `*DISTRIBUTING` or `*KINEMATIC`. `*DISTRIBUTING COUPLING` builds one long MPC and is recommended for at most about 50 nodes.

### Cited Findings
- **[Manual 2.23 *SURFACE / *DLOAD] Tet face numbering:** Face 1: 1-2-3; Face 2: 1-4-2; Face 3: 2-4-3; Face 4: 3-4-1.
  - **Hex:** 1: 1-2-3-4; 2: 5-8-7-6; 3: 1-5-6-2; 4: 2-6-7-3; 5: 3-7-8-4; 6: 4-8-5-1.
  - **Wedge:** 1: 1-2-3; 2: 4-5-6; 3: 1-2-5-4; 4: 2-3-6-5; 5: 3-1-4-6.
  - **Labels:** *SURFACE uses `Sx` and *DLOAD uses `Px`. Shell faces are NEG/1 and POS/2 plus edges 3–6.
  - [ccx_2.23.pdf §7.129, §7.44](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *DLOAD]**
  - The data line is "Element number or element set label, Distributed load type label, magnitude". A positive magnitude is pressure (compression) and a negative one is tension.
  - Nonuniform pressure uses `PxNUy` plus a dload.f user subroutine. Labels can be up to 20 characters.
  - Shells take no face number; pressure acts along the shell normal. Shell edge load is EDNORx.
  - **GRAV:** `Eall,GRAV,9810.,0.,0.,-1.` (magnitude + unit vector). Several gravity loads are allowed if their directions differ.
  - **CENTRIF:** `Eall,CENTRIF,ω²,x,y,z,ax,ay,az` (ω² then a point and the axis direction). Only one per set.
  - **OP:** OP=MOD (default) keeps earlier face loads and replaces a load on the same face. OP=NEW removes all of them, and only the first *DLOAD in a step counts.
  - An element set used on *DLOAD must not mix element families (solid / shell / beam / plane).
  - [ccx_2.23.pdf §7.44](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *DSLOAD]** Besides submodel section stresses, *DSLOAD supports "the application of a pressure on a facial surface". Its load label is `P` and it takes an optional AMPLITUDE. The same OP rules as *DLOAD apply — [ccx_2.23.pdf §7.45](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *FILM / *DFLUX / *RADIATE]** In each of these cards, "the element set label underneath may be replaced by a surface name. In that case the 'x' in the flux type label is left out." — [ccx_2.23.pdf §7.59, §7.40, §7.108](https://www.dhondt.de/ccx_2.23.pdf)
  - **Labels:** *FILM uses Fx with sink temperature and h (FxNUy needs film.f; FxFC is forced convection). *DFLUX uses Sx for surface flux and BF for body flux (BFNUy is nonuniform). *RADIATE uses Rx with sink temperature and emissivity; RxCR is cavity radiation and requires *PHYSICAL CONSTANTS.
- **[Forum] Surface names on *RADIATE:** omitting the face number with a surface name failed for one user, who called it a bug — [calculix.discourse.group](https://calculix.discourse.group/t/how-to-use-surface-set-in-radiate-boundary-condition/1753). Other users note that `P6` means face 6 and that *DLOAD needs an element set, not a node set — [Pressure distributed load](https://calculix.discourse.group/t/pressure-distributed-load/1400). Shear tractions (Abaqus TRSHR) are not supported by *DLOAD; use nodal forces or a user subroutine — [forum](https://calculix.discourse.group/t/is-there-something-in-calculix-similiar-with-load-type-label-for-surface-based-loads-trshr-in-abaqus/1130)
- **[Manual 2.23 §6.11.2] Consistent loads on quadratic faces:** "Notice that the force is zero (C3D10) or has the opposite sign (C3D20(R)) for quadratic elements." For a unit pressure on a C3D10 face, the vertices get 0 and each mid-side node gets 1/3 (Fig. 160). For a C3D20 face, vertices get −1/12 and mid-sides 1/3 (Fig. 159). Under NLGEOM, pressure follows the deformed face, so "if not [intended], the pressure can be replaced by nodal forces." — [ccx_2.23.pdf §6.11.2](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *BOUNDARY]**
  - **DOFs:** 1–3 are translations, 4–6 are rotations (beam and shell nodes only), and 11 is temperature.
  - **Local axes:** DOFs refer to local axes if a *TRANSFORM is applied to the node. Symmetry and enforced displacement are SPCs on 1–3 (in a local system where needed).
  - **Where it goes:** *BOUNDARY can be used in the model definition or in a step.
  - [ccx_2.23.pdf §7.4](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *COUPLING]**
  - REF NODE, SURFACE (which must be face-based) and CONSTRAINT NAME are mandatory, and ORIENTATION is optional.
  - *COUPLING must be followed by *KINEMATIC or *DISTRIBUTING.
  - The reference node location sets the centre of rigid motion (kinematic) or the point of load application (distributing). It "should not be one of the nodes of the surface."
  - Distributing couplings allow only rectangular local systems. It is not recommended to apply other loads to nodes of a distributing surface.
  - [ccx_2.23.pdf §7.27](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *DISTRIBUTING]**
  - Weights come from the tributary area of each surface node. Forces are always distributed; DOFs 4–6 add moment distribution.
  - A force or moment *CLOAD on the reference node is replaced by equivalent nodal forces. OP=NEW is de facto active for the first such *CLOAD in a step.
  - "No kinematic relations are created between the reference node and the coupling surface", so displacement BCs on the reference node have no effect.
  - [ccx_2.23.pdf §7.41](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *KINEMATIC]**
  - Each surface node follows the rigid motion about the reference node in the selected DOFs. The reference node can take *BOUNDARY or *CLOAD.
  - "The corresponding selection of RF on the *NODE PRINT card does not work for the reference node. Instead, the user should use *SECTION PRINT."
  - [ccx_2.23.pdf §7.80](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *DISTRIBUTING COUPLING]**
  - Needs ELSET with exactly one DCOUP3D element; its node is the reference node and must not belong to any other element. Weighted nodes are listed under the card.
  - It produces one MPC per direction containing all nodes, which gives "a large, fully populated submatrix… it is recommended not to include more than maybe 50 nodes."
  - Misusing dependent nodes gives `*ERROR in cascade: zero coefficient on the dependent side of an equation`.
  - [ccx_2.23.pdf §7.42](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *RIGID BODY]**
  - Takes NSET or ELSET, plus optional REF NODE (default: the origin) and ROT NODE. The ROT NODE's translational DOFs are the rotations.
  - If REF NODE belongs to the rigid body, RF output on it is wrong.
  - [ccx_2.23.pdf §7.113](https://www.dhondt.de/ccx_2.23.pdf)
- **[Source/FreeCAD issue]** If all rigid-body nodes lie on a straight line, the rotation about that line is undefined and an error occurs; constrain that rotation — [FreeCAD issue #14130](https://fr.github.com/FreeCAD/FreeCAD/issues/14130)
- **[Manual 2.23 *PRE-TENSION SECTION] Bolt pretension:**
  - Takes NODE (required) plus SURFACE (face-based bolt cross-section, for solids) or ELEMENT (one B31 beam). The reference node's DOF 1 takes a force (*CLOAD) or a differential displacement (*BOUNDARY). An optional normal can be given.
  - Internally the surface nodes are duplicated and an MPC is created, so a visible gap appears in the results.
  - Rules: the surface must not contain edges or vertices of elements that have no face on it (otherwise "unrealistic stress concentrations"), and it must not be adjacent to quadratic elements whose faces are in a contact surface.
  - [ccx_2.23.pdf §7.107](https://www.dhondt.de/ccx_2.23.pdf)
- **[Source] FreeCAD's ccx writer:**
  - Pressure is written as one `*DLOAD` line per element, `{elem},P{faceNo},{p}`; shells get `{elem},P,{-p}`.
  - Forces are written as per-node `*CLOAD` lines that FreeCAD distributes itself.
  - Both pressure and force cards can carry `AMPLITUDE=`.
  - [write_constraint_pressure.py](https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/Fem/femsolver/calculix/write_constraint_pressure.py), [write_constraint_force.py](https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/Fem/femsolver/calculix/write_constraint_force.py)

### Inferences
- **Recommended Wren mapping (inferred):**
  - **Pressure:** for each CAD face, write `*SURFACE,NAME=<FACE>,TYPE=ELEMENT` with `eid,Sk` lines, then `*DSLOAD` / `<FACE>,P,<p>`. Alternatively write `*DLOAD` with `eid,Pk,p` lines, as FreeCAD does; this is the most battle-tested path. Either way Wren must compute the face index k from the Gmsh boundary-triangle → tet mapping and the ccx table above.
  - **Thermal BCs:** film, flux and radiation can reference the same surface names directly.
  - **Face force (total N over a face):** either compute consistent nodal forces (0 on corners, ⅓·F·A_tri/A_face per mid-side node, summed), or use `*COUPLING,REF NODE=…,SURFACE=…` + `*DISTRIBUTING` with a *CLOAD on the reference node. The latter also gives a natural "remote force/moment" UX. Avoid `*DISTRIBUTING COUPLING` on big faces because of the ~50-node advice.
  - **Bearing loads:** no native bearing-load keyword exists. Approximate with a nonuniform pressure (`PxNUy` + dload.f is unavailable to an app without compiling). Practical options are per-element `Pk` lines with element-wise magnitudes (cosine distribution), or nodal *CLOAD.
  - **Fixed and symmetry supports:** `*BOUNDARY` on face node sets, e.g. `<FACE>N,1,3` for fixed or `<FACE>N,2,2` for symmetry normal to y. A symmetry plane not aligned with the global axes needs `*TRANSFORM` on those nodes.

### Gaps
- The 2.23 *DLOAD text documents only element numbers and element sets, not surface names (unlike FILM, DFLUX and RADIATE). Use *DSLOAD for surface-name pressure. No source definitively confirms that *DLOAD accepts surface names.
- No CalculiX keyword for bearing loads or remote displacement beyond *COUPLING/*KINEMATIC was found.

---

## 4. Materials and units

### Takeaway
ccx is unitless. The recommended mechanical/thermal system is {mm, N, s, K}: E in MPa, ρ in t/mm³ (steel 7.8e-9), cp in mm²/(s²·K) (steel 446e6), k in N/(s·K) (steel 50), h in N/(mm·s·K) (1 W/m²K = 1e-3). *EXPANSION's reference temperature is `ZERO=` (default 0), which together with initial temperatures defines thermal strain.

### Cited Findings
- **[Manual 2.23 §3 Units]**
  - "Finite element programs do not know any units… the user must make sure that the numbers he provides have consistent units." Four base units can be chosen for thermomechanics.
  - In {mm, N, s, K}, mass is N·s²/mm (= tonne). Steel has E = 210000, ν = 0.3, ρ = 7.8×10⁻⁹, cp = 446×10⁶ mm²/s²K and λ = 50 N/sK.
  - Table 1 conversions to {mm, N, s, K}: 1 W/m²K = 10⁻³ N/(mm·s·K) for the film coefficient; 1 N·s/m² = 10⁻⁶ N·s/mm² for dynamic viscosity.
  - Water ρ = 10⁻⁹ N·s²/mm⁴; air λ = 0.0257 N/sK.
  - Force, mass, length and time cannot all be chosen independently.
  - [ccx_2.23.pdf §3](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *ELASTIC]**
  - TYPE=ISO (default; E, ν, T per line, repeated for temperature dependence).
  - TYPE=ORTHO (D1111, D1122, D2222, D1133, D2233, D3333, D1212, D1313 / D2323, T).
  - TYPE=ENGINEERING CONSTANTS (E1, E2, E3, ν12, ν13, ν23, G12, G13, G23, T).
  - TYPE=ANISO.
  - Orthotropic and anisotropic materials need *ORIENTATION for their local axes.
  - [ccx_2.23.pdf §7.47](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *EXPANSION]**
  - Thermal strain: ε_th = α(T)(T−T_ref) − α(T₀)(T₀−T_ref).
  - Parameters: TYPE = ISO / ORTHO / ANISO. "The parameter ZERO is used to determine the reference temperature, default is 0." Example: `*EXPANSION,ZERO=273.`
  - [ccx_2.23.pdf §7.57](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.9.8]**
  - Heat transfer needs *CONDUCTIVITY, plus *SPECIFIC HEAT for transient analysis and *DENSITY.
  - Radiation needs *PHYSICAL CONSTANTS (absolute zero and Stefan–Boltzmann constant in the user's units).
  - Temperature BCs are *BOUNDARY DOF 11.
  - [ccx_2.23.pdf §6.9.8](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.13]** At integration points, the von Mises stress and PEEQ lie on the *PLASTIC curve. Extrapolated nodal values do not have to — [ccx_2.23.pdf §6.13](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §7]** "A material name can be at most 80 characters long". Material cards must follow a *MATERIAL card, and sections (*SOLID SECTION, ELSET=…, MATERIAL=…) assign them — [ccx_2.23.pdf §7](https://www.dhondt.de/ccx_2.23.pdf)
- **[Forum]** One PrePoMax nonpositive-Jacobian case was fixed by switching from SI(m) to SI(mm), suspected to be "a limitation… because of the very low numbers when using the SI(m) system" — [PrePoMax forum](https://prepomax.discourse.group/t/nonpositive-jacobian-error-when-reducing-model-size/3225)

### Inferences
- Wren should write everything in {mm, N, s, K} (density in t/mm³), converting from its expression-with-units inputs. Its material library should store SI and convert at write time. The h conversion (×1e-3) and the density conversion (×1e-12 from kg/m³) are the most common user mistakes.
- For thermal-stress steps later, always write `ZERO=` and `*INITIAL CONDITIONS,TYPE=TEMPERATURE` explicitly. Do not rely on 0 K defaults.
- **Missing density:** a frequency analysis without *DENSITY, or GRAV without density, will fail or be meaningless. A deck preflight should check this (see Q8).

### Gaps
- I did not extract the *PLASTIC syntax (σ_y, ε_p, T table; isotropic or kinematic hardening). See Manual 2.23 §7.106.

---

## 5. Contact and tie (later scope)

### Takeaway
For bonded assemblies, *TIE between face-based surfaces is robust and linear (MPCs, solid elements only). Its default tolerance is 2.5% of element size, and unmatched slave nodes are written to a .nam file that the app can parse. For real contact with C3D10, use `TYPE=SURFACE TO SURFACE` (face-to-face penalty) or `MORTAR` (static only). Avoid node-to-surface with quadratic elements. All contact pairs in a deck must be the same type.

### Cited Findings
- **[Manual 2.23 *TIE]**
  - Requires NAME. Optional: POSITION TOLERANCE, ADJUST, CYCLIC SYMMETRY, MULTISTAGE. Solid (3D) elements only.
  - "The user can freely decide which surface is taken as slave and which as master."
  - The slave can be node- or face-based; the master must be face-based.
  - Default tolerance: "2.5% of the typical element size." The projection must also lie within the master face.
  - "Nodes which are not connected are stored in file jobname_WarnNodeMissMasterIntersect.nam."
  - Connected slave nodes are moved onto the master surface unless ADJUST=NO.
  - "Nodes belonging to the dependent surface cannot be used as dependent nodes in other SPC's or MPC's."
  - [ccx_2.23.pdf §7.133](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *CONTACT PAIR]**
  - Requires INTERACTION and TYPE. TYPE is NODE TO SURFACE, SURFACE TO SURFACE, MORTAR or MASSLESS.
  - With quadratic elements or face-to-face contact, the slave must be face-based.
  - "All must be of the same type. It is not allowed to mix…" contact types in one deck.
  - SMALL SLIDING applies to node-to-surface only. Face-to-face and mortar contact are small sliding by default.
  - [ccx_2.23.pdf §7.22](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §4 rule 5]** With quadratic elements use face-to-face penalty or mortar, which "will converge much better than the node-to-face method… the mortar method in CalculiX can only be used for static calculations." — [ccx_2.23.pdf §4](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §4] Debug aids for contact:**
  - The `.sta` file has iterations per increment.
  - The `.cvg` file has the number of contact elements, the residual and the largest change per iteration.
  - `LAST ITERATIONS` on *NODE FILE writes `ResultsForLastIterations.frd`.
  - `CONTACT ELEMENTS` writes `jobname.cel`.
  - [ccx_2.23.pdf §4](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 / new_calc 2.23]** `*CYCLIC SYMMETRY MODEL,CONTACT` is new in 2.23 — [new_calc.htm](https://dhondt.de/new_calc.htm)
- **[Forum]** Disconnected (un-tied) parts produce near-0 Hz modes that "fly away". Unlike Abaqus, ccx does not warn about "x unconnected regions" — [calculix.discourse.group](https://calculix.discourse.group/t/programmatic-way-to-check-if-fea-results-were-empty-bad/1824)

### Inferences
- **Bonded assemblies:** use *TIE with the finer-meshed side as slave (standard practice; the manual leaves the choice free). After the solve, parse `*_WarnNodeMissMasterIntersect.nam`. If it is non-empty, flag the contact pair as "needs attention" rather than silently accepting a partial bond. This matches Wren's "never silently guess" rule.
- A pre-solve "connectivity" check (union-find over elements plus tie pairs) is worth doing in-app, since ccx itself will not warn.

### Gaps
- I did not extract the details of *SURFACE INTERACTION / *SURFACE BEHAVIOR (penalty stiffness defaults, pressure-overclosure) or *FRICTION parameters. Forum convergence tips for penalty stiffness were not gathered.

---

## 6. Solvers, memory, threads and distribution builds

### Takeaway
ccx picks the first installed solver from the list SGI → PaStiX → PARDISO → SPOOLES → TAUCS. For *STATIC and *HEAT TRANSFER it falls back to the built-in iterative solver; for eigenproblems there is no fallback. Debian, Ubuntu and the Homebrew tap ship SPOOLES (multithreaded) + ARPACK only. SPOOLES is in-core and limited to about 1M equations per 32 GB. That puts a 1M-C3D10 mesh (≈4M DOF) out of reach without PARDISO or PaStiX builds, or the iterative solvers (static and thermal only).

### Cited Findings
- **[Manual 2.23 *STATIC]**
  - "Default is the first solver which has been installed of the following list: SGI, PaStiX, PARDISO, SPOOLES and TAUCS. If none is installed, the default is the iterative solver."
  - "SPOOLES is very fast, but has no out-of-core capability… With 32GB of RAM you can solve up to 1,000,000 equations."
  - "PARDISO is the Intel proprietary solver and is about a factor of two faster than SPOOLES."
  - PaStiX "is really fast and can use the GPU… acceleration of a factor between 3 and 8 compared to PARDISO. We modified PaStiX for this, therefore you have to download PaStiX from our website."
  - **Iterative solvers:** ITERATIVE SCALING uses a diagonal preconditioner and the least memory. ITERATIVE CHOLESKY uses incomplete Cholesky and needs extra memory about equal to the matrix nonzeros. On a hemisphere they were "nine times faster… and three times faster… than with SPOOLES", but "for two-dimensional structures such as plates or shells, the performance might break down drastically."
  - The same text appears for 2.21 and 2.22.
  - [ccx_2.23.pdf §7.123](https://www.dhondt.de/ccx_2.23.pdf), [ccx_2.21.pdf](https://www.dhondt.de/ccx_2.21.pdf)
- **[Manual 2.23 *FREQUENCY/*BUCKLE]** The solver choices are direct only (plus MATRIXSTORAGE): "If none is installed, no eigenvalue analysis can be performed." — [ccx_2.23.pdf §7.63, §7.5](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §4 rule 7]** "The memory needed to run a problem depends on the largest node and element numbers (the computational time, though, does not). So if you notice large gaps in the numbering, get rid of them." Iterative scaling needs less memory than iterative Cholesky, which needs less than SPOOLES or PARDISO — [ccx_2.23.pdf §4](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §2] Threads:**
  - **Stiffness assembly:** `OMP_NUM_THREADS` or `CCX_NPROC_STIFFNESS`; the latter takes precedence.
  - **SPOOLES solve:** multithreaded only if ccx was built with `USE_MT`. Uses `OMP_NUM_THREADS` or `CCX_NPROC_EQUATION_SOLVER` (precedence).
  - **PARDISO:** `OMP_NUM_THREADS`.
  - **Stress/material tangent:** `CCX_NPROC_RESULTS`.
  - **View factors:** `CCX_NPROC_VIEWFACTOR`.
  - **Maximum cores:** detected via `sysconf(_SC_NPROCESSORS_CONF)` and overridable with `NUMBER_OF_CPUS` (useful if sysconf segfaults).
  - **ARPACK/SLATEC:** OpenMP only pays off for big systems, "1,000,000 degrees of freedom for mechanical frequency calculations."
  - **Defaults:** all counts default to 1.
  - [ccx_2.23.pdf §2](https://www.dhondt.de/ccx_2.23.pdf)
- **[Packaging] Debian `calculix-ccx`:**
  - Versions: 2.23-1 in forky/sid, 2.20-1 in bookworm, 2.17-3 in bullseye — [sources.debian.org](https://sources.debian.org/api/src/calculix-ccx/)
  - Build deps are only `libarpack2-dev, libspooles-dev, liblapack-dev`, and the CFLAGS are `-DSPOOLES -DARPACK -DMATRIXSTORAGE -DUSE_MT=1` — no PARDISO or PaStiX — [debian/rules](https://sources.debian.org/data/main/c/calculix-ccx/2.23-1/debian/rules), [debian/control](https://sources.debian.org/data/main/c/calculix-ccx/2.23-1/debian/control)
  - Ubuntu (Launchpad) publishes 2.21-1build1 for resolute and 2.23-1 for tenacious — [Launchpad API](https://api.launchpad.net/1.0/ubuntu/+archive/primary?ws.op=getPublishedSources&source_name=calculix-ccx&exact_match=true)
- **[Packaging] Homebrew:** homebrew-core has no ccx formula (`formulae.brew.sh/api/formula/calculix-ccx.json` returns 404). The common tap `costerwi/homebrew-calculix` builds ccx 2.23 against bundled SPOOLES 2.2 (serial + MT) and ARPACK with `-DSPOOLES -DARPACK -DMATRIXSTORAGE -DUSE_MT=1`. It installs the binary as `ccx_2.23` — [README](https://github.com/costerwi/homebrew-calculix), [calculix-ccx.rb](https://raw.githubusercontent.com/costerwi/homebrew-calculix/master/calculix-ccx.rb)
- **[Forum] Large models:**
  - Users report SPOOLES limiting models to "a few million equations" and failing even with 32 GB on a model PARDISO solved. PaStiX "seems to have greater memory requirements than Pardiso", and an I8 (64-bit int) PaStiX build was needed "for much beyond 500,000 nodes." — [PrePoMax forum](https://prepomax.discourse.group/t/does-the-calculix-solver-have-a-limit-on-the-number-of-nodes/301), [Problem with Large Model Solution](https://calculix.discourse.group/t/problem-with-large-model-solution/748), [Pardiso ILP64 thread](https://calculix.discourse.group/t/calculix-build-with-pardiso-ilp64-for-large-models/3815)
  - One user saw peak SPOOLES memory during "Determining matrix structure", before the solve — [forum](https://calculix.discourse.group/t/ccx-memory-usage-during-determining-matrix-structure/895)
- **[Forum] Windows 2.23 build:** one user found the Windows 2.23 build "twice slower than ccx2.22PaStiX", and another found no slowdown when building both themselves. This is unresolved — [PrePoMax forum](https://prepomax.discourse.group/t/calculix-2-23-has-been-released/3048). Another thread reports that `Calculix_2.23_4win.zip` needs a password — [calculix.discourse.group](https://calculix.discourse.group/t/calculix-2-23-4win-zip-need-a-password/2898)
- **[Source] FreeCAD:**
  - Sets `OMP_NUM_THREADS` (user preference or `cpu_count`) before launching.
  - Its newer task code also sets `PASTIX_MIXED_PRECISION` = 0/1 from a solver property.
  - [ccxtools.py](https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/Fem/femtools/ccxtools.py), [calculixtools.py](https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/Fem/femsolver/calculix/calculixtools.py)

### Inferences
- **Size estimate (inference):** a C3D10 mesh has roughly 1.3–1.5 nodes per element, so 100k tets ≈ 140k nodes ≈ 0.4M DOF. That is comfortable for SPOOLES (~13 GB by the manual's 32 GB/1M-eq rule; real use is often lower for 3D tets, but unverified). 1M tets ≈ 4M DOF is beyond SPOOLES on typical desktops.
- **Large-mesh UX:** Wren should estimate DOF before a run. For static or thermal runs, offer `SOLVER=ITERATIVE CHOLESKY` (bulky 3D parts only, not thin-walled). For modal runs, warn that a PARDISO or PaStiX build is required, or that the mesh must be coarsened.
- Always renumber nodes and elements contiguously from 1, since memory scales with the largest ID.
- Set `OMP_NUM_THREADS` (and `CCX_NPROC_EQUATION_SOLVER`) when launching. Distro builds are compiled with USE_MT, so SPOOLES threading works there.

### Gaps
- I found no authoritative statement of which solvers the official dhondt.de Windows binary, or PrePoMax's bundled `ccx_static.exe`, includes. Forum mentions of "ccx2.22PaStiX" imply that PaStiX Windows builds exist. Verify before promising Windows performance.
- No measured SPOOLES/PARDISO/PaStiX RAM or time figures for 100k–1M C3D10 were found, only the manual's 32 GB/1M-equation rule and forum anecdotes.

---

## 7. Output (.frd / .dat), extrapolation, frequency output

### Takeaway
Use `*NODE FILE` (U, RF, NT) and `*EL FILE` (S, E, HFL, PEEQ) for ASCII .frd, or the `*NODE OUTPUT` / `*ELEMENT OUTPUT` twins for the more compact mixed binary/ASCII .frd. Element values in the .frd are integration-point values extrapolated to nodes and averaged across elements, which smears interface jumps. Use `*NODE PRINT,NSET=…,TOTALS=ONLY` with RF for reaction sums per face, and `*EL PRINT,ELSET=…,TOTALS=ONLY` with EVOL/EMAS/ELSE for volume, mass (with centre of gravity and inertia) and strain energy. Frequency runs write participation factors and effective modal masses to .dat automatically.

### Cited Findings
- **[Manual 2.23 §6.13]**
  - *NODE FILE and *EL FILE write ASCII .frd; *NODE OUTPUT and *ELEMENT OUTPUT write a binary .frd; *NODE PRINT and *EL PRINT write the ASCII .dat. "Binary .frd files are much shorter and can be faster read."
  - Element variables "are stored at the integration points in the .dat file and at the nodes in the .frd file… The values at the nodes are extrapolated values and consequently less accurate."
  - "PRINT requests HAVE TO be accompanied by a set name."
  - [ccx_2.23.pdf §6.13](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *NODE OUTPUT / *ELEMENT OUTPUT]** These produce a .frd that is "a mixture of binary and ASCII". If FILE and OUTPUT cards are mixed in one step, "the last such card will determine whether the .frd file is completely in ASCII or a mixture." — [ccx_2.23.pdf §7.98, §7.51](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *NODE FILE]**
  - **Variables:** U (DISP), RF (FORC), NT (NDTEMP), RFL, V and others.
  - **What RF contains:** RF "are the sum of the reaction forces, concentrated loads (*CLOAD) and distributed loads (*DLOAD) in the node". It equals the reaction only where no loads act.
  - **Selection persistence:** "The first occurrence of an *NODE FILE keyword card within a step wipes out all previous nodal variable selections… If no *NODE FILE card is used within a step the selections of the previous step apply. If there is no previous step, no nodal variables will be stored."
  - **Unattached nodes:** only nodes belonging to elements are stored. Rigid-body or reference nodes need *NODE PRINT.
  - **Parameters:** FREQUENCY, FREQUENCYF, GLOBAL, OUTPUT (2D/3D), OUTPUT ALL, TIME POINTS, NSET, LAST ITERATIONS, CONTACT ELEMENTS.
  - **FREQUENCY=N** is shared by all output cards ("the last value applies to all") and persists across steps.
  - [ccx_2.23.pdf §7.97](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *EL FILE]**
  - Writes element variables "averaged at the nodal points" to the .frd: S (Cauchy, STRESS), E (total strain, TOSTRAIN), ME (mechanical strain), THE (thermal strain), PEEQ (PE), HFL (FLUX), ENER, SDV, ZZS (Zienkiewicz–Zhu improved stress) and ERR/HER (error estimators).
  - "Selection of S automatically triggers output of the error estimator ERR, unless NOE is selected after S." ZZS and ERR are mutually exclusive.
  - "Due to the averaging process jumps at material interfaces are smeared out unless you model the materials on both sides of the interface independently and connect the coinciding nodes with MPC's."
  - ENER must be requested in the first step for nonlinear runs.
  - [ccx_2.23.pdf §7.52](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *EL PRINT]**
  - Integration-point variables include S, E, ME, PEEQ, HFL, ENER, SDV and COORD.
  - Whole-element variables: ELSE (internal energy), ELKE (kinetic energy), EVOL (volume), EMAS (mass; with TOTALS=YES or ONLY the centre of gravity and mass moments of inertia are also computed), CENT and EBHE.
  - TOTALS=YES|ONLY|NO applies to whole-element variables.
  - [ccx_2.23.pdf §7.53](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *NODE PRINT]** "TOTALS only applies to external forces. If TOTALS=YES the sum… is printed in addition… If TOTALS=ONLY is selected the sum is printed but the individual nodal contributions are not." The sum is always in the global system — [ccx_2.23.pdf §7.99](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.9.2] Frequency output:** ccx writes "the total effective mass and total effective modal mass for all rigid body modes" to .dat. Participation factors are Pᵢ = {Uᵢ}ᵀ[M]{R} for the 3 translations and 3 rotations, and the effective modal mass is Pᵢ². "By comparing the total effective modal mass with the total effective mass one gains an impression whether enough modes were calculated." Eigenfrequencies are always written to .dat — [ccx_2.23.pdf §6.9.2, §7.63](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.2.5]** For C3D20R, extrapolation from the reduced integration points to the nodes is trilinear, so surface stress concentrations can be under-captured on coarse meshes — [ccx_2.23.pdf §6.2.5](https://www.dhondt.de/ccx_2.23.pdf)
- **[Source] FreeCAD default output:**
  - `*NODE FILE` with `U` (adding `NT` for thermomechanical runs).
  - `*EL FILE` with `S, E` (adding `HFL` for thermal, `PEEQ` if there is a nonlinear material).
  - `*NODE PRINT, NSET=<fixed>, TOTALS=ONLY` / `RF` for each fixed constraint; `U` plus RF on the RefNode/RotNode for rigid bodies; `CF, CFN, CFS` for contact.
  - Its newer reader maps the .frd variable `STR(%)` to "Error".
  - [write_step_output.py](https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/Fem/femsolver/calculix/write_step_output.py), [calculixtools.py](https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/Fem/femsolver/calculix/calculixtools.py)

### Inferences
- **Recommended S1 output block (inferred):**
  - *Static:* `*NODE FILE` / `U,RF` · `*EL FILE` / `S,E` (or `S,NOE` to skip the error estimator; keeping ERR gives a free mesh-quality indicator) · `*NODE PRINT,NSET=<eachSupportFace>N,TOTALS=ONLY` / `RF` · `*EL PRINT,ELSET=EALL,TOTALS=ONLY` / `EVOL,EMAS` (sanity mass check against CAD).
  - *Thermal:* `*NODE FILE` / `NT,RFL` · `*EL FILE` / `HFL`.
  - *Modal:* `*NODE FILE` / `U`, then read the frequencies and participation/effective-mass tables from .dat.
- **Binary vs ASCII:** prefer `*NODE OUTPUT` / `*ELEMENT OUTPUT` (binary .frd) once Wren's parser supports the binary blocks; they are smaller and faster. ASCII is simpler to parse first, and ccx2paraview and FreeCAD read both formats (not verified here). Never mix FILE and OUTPUT cards in one step.
- **Stress views:** because .frd nodal stresses are averaged across all elements at a node, Wren should either show them as "averaged nodal" or compute unaveraged per-element values from `*EL PRINT` integration-point S (heavy for large meshes). Model material interfaces as separate parts if jumps matter.
- **RF caveat:** RF on a node set that also carries loads includes those loads. Request RF only on support sets.

### Gaps
- I did not verify the exact .frd binary block layout (record format flags) or .dat table headers for participation factors here. They would need the ccx source (`frd.c`) or the cgx manual.
- The ccx2paraview and pygccx projects were not reviewed (tool budget).

---

## 8. Errors, pitfalls, preflight and failure detection

### Takeaway
ccx prints `*ERROR in <routine>: …` and `*WARNING …` to stdout. The exit code is not a reliable success signal on its own, and "Job finished" can appear after errors or NaN residuals. Robust detection combines the exit code, stdout scanning for `*ERROR` and `nan`, the presence and size of .frd/.dat, and sanity checks (non-zero displacement field, effective-mass ratios). Most failures in auto-generated decks come from mesh validity (nonpositive Jacobian), missing material or section assignment, unconstrained rigid-body modes, MPC conflicts, and set/name problems.

### Cited Findings
- **[Source] FreeCAD's failure handling:**
  - A run counts as failed if `ret_code` is non-zero **or** stderr is non-empty. Exit code **201** with *NO ANALYSIS ("check" mode) is treated as success ("workaround for wrong exit code for *NOANALYSIS").
  - On failure it scans stdout for `" *ERROR in calinput: no material was assigned"` and `"*ERROR in e_c3d: nonpositive jacobian"` and highlights the offending elements and nodes.
  - It runs `ccx -i <basename>` with the cwd set to the deck folder, because "ccx may crash if directory has no write permission" and "there is also a limit of the length of file names."
  - [ccxtools.py](https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/Fem/femtools/ccxtools.py)
- **[Forum] Nonpositive Jacobian:**
  - "*ERROR in e_c3d: nonpositive jacobian determinant in element N" is common.
  - A user reading e_c3d reports a threshold of 1e-20.
  - FreeCAD users report the Gmsh option "Second Order Linear" (straight mid-edge nodes) avoids it.
  - A PrePoMax case was fixed by switching from m to mm units.
  - [calculix.discourse.group](https://calculix.discourse.group/t/help-error-in-e-c3d-nonpositive-jacobian/1320), [FreeCAD forum](https://devtalk.freecad.org/t/calculix-error-in-ec3d-nonpositive-jacobian-determinant-in-element-37091/49299), [PrePoMax forum](https://prepomax.discourse.group/t/nonpositive-jacobian-error-when-reducing-model-size/3225), [forum: detect bad elements](https://calculix.discourse.group/t/detect-bad-finite-elements-4-node-tetrahedral/1700)
- **[Manual 2.23 *DISTRIBUTING COUPLING]** MPC dependency conflicts give `*ERROR in cascade: zero coefficient on the dependent side of an equation / dependent node: N` — [ccx_2.23.pdf §7.42](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §6.2.14]** Thin-shell normals: "for significantly distorted elements it may not be possible to determine the normal; this particularly applies to elements in which the middle nodes are way off the middle position." — [ccx_2.23.pdf §6.2.14](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §7] Name and label rules:**
  - "The input deck is case insensitive: internally, all alphanumeric characters are changed into upper case."
  - "The maximum length for user-defined names, e.g. for materials or sets, is 80 characters."
  - Node and element sets may share a name. Internally ccx appends 'N' and 'E', so messages show names "written in upper case and to have a 'N' or 'E' appended."
  - Distributed-load labels can be up to 20 characters.
  - Data are comma-separated, and "a line can only contain as many data as dictated by the keyword definition."
  - Model-definition cards must come before the first *STEP.
  - [ccx_2.23.pdf §7 intro](https://www.dhondt.de/ccx_2.23.pdf), [§7.44](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *CONTACT PAIR]** Mixing contact types in one deck is not allowed. **[*TIE]** forbids shells and beams. **[*BUCKLE]** forbids prescribed displacements and temperature loads. Mortar is static only — [ccx_2.23.pdf §7.22, §7.133, §7.5, §4](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 §4] Troubleshooting order:** screen output → `.sta` → `.cvg` → `LAST ITERATIONS` (ResultsForLastIterations.frd) → `CONTACT ELEMENTS` (.cel). For segfaults, set `CCX_LOG_ALLOC=1` to log allocations — [ccx_2.23.pdf §4](https://www.dhondt.de/ccx_2.23.pdf)
- **[Manual 2.23 *NO ANALYSIS]** *NO ANALYSIS checks the deck without solving ("the Jacobian determinant is checked") — [ccx_2.23.pdf §7.94](https://www.dhondt.de/ccx_2.23.pdf)
- **[Forum] Detecting bad results:**
  - A Mecway log shows ccx printing "Job finished" despite an `*ERROR in e_c3d` — [mecway.com](https://mecway.com/forum/discussion/comment/1604/)
  - A CalculiX forum thread shows `error nan` in iterations followed by normal completion, with zero stresses from disconnected parts.
  - rsmith posted a cgx script that checks the von Mises range in the .frd and prints "ERROR: stresses too low/high".
  - Calc_em suggests a modal run to spot disconnected parts (near-0 Hz modes).
  - [calculix.discourse.group](https://calculix.discourse.group/t/programmatic-way-to-check-if-fea-results-were-empty-bad/1824)
- **[Forum]** A community tool for diagnosing ccx errors was announced in 2025 — [calculix.discourse.group](https://calculix.discourse.group/t/can-t-make-sense-of-calculix-errors-i-built-an-open-source-tool-to-help-diagnose-them/3854). Not reviewed.

### Inferences
- **Wren preflight (inferred; most of it can run in-browser before handing the deck to ccx):**
  1. Check Jacobians on Gmsh second-order tets, using Gmsh's own quality metrics; optionally straighten curved mid-nodes.
  2. Check C3D10 node order after the Gmsh → ccx reorder.
  3. Check that every element has a section and material; this catches FreeCAD's most common error.
  4. Check density exists for modal and gravity runs.
  5. Check rigid-body restraint. Union-find connectivity (including ties) should find one component, and supports should restrain 6 DOFs. If not, block the run, or offer a modal run instead.
  6. Sanitize set names: ≤ 80 characters, ASCII, no commas, `=` or spaces; unique after uppercasing; leave room for the internal N/E suffix. Map persistent CAD face names to short stable IDs plus a `**` comment that carries the full name.
  7. Number nodes and elements contiguously.
  8. Check that load and BC sets are non-empty.
  9. Optionally run `*NO ANALYSIS` as a ccx-side deck check.
- **Post-run classification (inferred):**
  - **Failed:** exit ≠ 0 (except 201 on a *NO ANALYSIS check) OR any line matching `^\s*\*ERROR` OR "nan" in the residuals OR .frd missing or empty for the requested step.
  - **Warnings:** any `*WARNING` lines (e.g. removed drilling moments), surfaced to the user.
  - **Needs attention:** a non-empty `*_WarnNodeMissMasterIntersect.nam` (ties).

### Gaps
- I did not find the exact wording of the SPOOLES, PARDISO and PaStiX singular-matrix or zero-pivot messages, nor how ccx reports an unconstrained model in a linear static run. These need a test (deliberately unconstrained cube) to capture the strings.
- The ccx exit-code convention (which errors return which non-zero code) is undocumented in the manual. Only FreeCAD's 201 special case was found.
- PrePoMax's and the CalculiX Launcher's detection logic were not inspected (PrePoMax is C#; not fetched).

---

## 9. Versions (2.19–2.23) and version detection

### Takeaway
For a static/modal/thermal deck writer, the keyword surface is stable from 2.21 to 2.23. 2.22 added no keywords (it was a bug-fix release). 2.23 added `*DAMAGE INITIATION` and `*USE REFINED MESH`, fixed C3D8I, and introduced a rigid-body-with-2D-elements regression. Distros lag: Debian bookworm ships 2.20 and Ubuntu resolute 2.21. Detect the version with `ccx -v` and a `(\d+)\.(\d+)` regex.

### Cited Findings
- **[Manual diff]** Diffing the keyword section headings of the 2.21, 2.22 and 2.23 manuals shows no change from 2.21 to 2.22. From 2.22 to 2.23 two keywords were added: `*DAMAGE INITIATION` and `*USE REFINED MESH`. The text on default solver order is identical across all three — [ccx_2.21.pdf](https://www.dhondt.de/ccx_2.21.pdf), [ccx_2.22.pdf](https://www.dhondt.de/ccx_2.22.pdf), [ccx_2.23.pdf](https://www.dhondt.de/ccx_2.23.pdf)
- **[dhondt.de] New in 2.23:**
  - Submodels for heat transfer.
  - `*DAMAGE INITIATION`.
  - C3D8I correction.
  - `*REFINE MESH,SMOOTHING ONLY` keeps numbering.
  - Composite shells in *HEAT TRANSFER.
  - Linear temperature distribution on *TEMPERATURE / *BOUNDARY.
  - `*CYCLIC SYMMETRY MODEL,CONTACT`.
  - Axisymmetric → 3D submodel.
  - The first term of *EQUATION can be a node set.
  - [dhondt.de/new_calc.htm](https://dhondt.de/new_calc.htm)
- **[Forum] Release dates:** 2.22 on 5 Aug 2024 and 2.23 on 19 Oct 2025. Releases are now about one per year ("used to be 2 releases a year, but now it's just one"). The 2.24 log mentions acceleration output and moving CFD parallelism from pthread to OpenMP — [PrePoMax forum](https://prepomax.discourse.group/t/calculix-2-23-has-released/3626). 2.22 was described as mostly bug fixes — [PrePoMax forum](https://prepomax.discourse.group/t/calculix-2-23-has-been-released/3048)
- **[Forum] 2.23 regressions:** rigid body cannot be used with 2D (shell) elements, and there are disputed Windows performance reports — [PrePoMax forum](https://prepomax.discourse.group/t/calculix-2-23-has-released/3626), [PrePoMax forum](https://prepomax.discourse.group/t/calculix-2-23-has-been-released/3048)
- **[Source] Version detection in FreeCAD:**
  - Runs `ccx -v` and parses stdout with `re.search(r"(\d+).(\d+)")`.
  - Validates the binary by running `ccx` with no arguments and checking a signature string in stdout.
  - [ccxtools.py](https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/Fem/femtools/ccxtools.py)
  - Its newer code also runs `ccx -v` via QProcess — [calculixtools.py](https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/Fem/femsolver/calculix/calculixtools.py)
- **[Packaging] Installed versions by channel:** Debian bookworm 2.20, forky/sid 2.23, bullseye 2.17 — [sources.debian.org](https://sources.debian.org/api/src/calculix-ccx/). Ubuntu resolute 2.21, tenacious 2.23 — [Launchpad](https://api.launchpad.net/1.0/ubuntu/+archive/primary?ws.op=getPublishedSources&source_name=calculix-ccx&exact_match=true). Homebrew tap 2.23, installed as `ccx_2.23` — [costerwi/homebrew-calculix](https://github.com/costerwi/homebrew-calculix)
- **[Manual 2.23 §6.2.14]** Older behaviour changes relevant to a writer: since 2.8, static shell moments use mean-rotation MPCs instead of knots; since 2.15, drilling moments are dropped with a warning instead of an error — [ccx_2.23.pdf §6.2.14](https://www.dhondt.de/ccx_2.23.pdf)

### Inferences
- Target ccx ≥ 2.20 (the Debian stable floor) with the S1 keyword subset (*STATIC, *FREQUENCY, *HEAT TRANSFER, *DLOAD/*DSLOAD, *FILM, *DFLUX, *RADIATE, *BOUNDARY, *CLOAD, *COUPLING/*DISTRIBUTING, *NODE/EL FILE/PRINT). Nothing in it changed in 2.21–2.23. Store the detected version in result metadata, and warn on 2.23 if shells and rigid bodies are combined.
- The binary name varies (`ccx`, `ccx_2.23`, `ccx_static.exe` in PrePoMax), so locate it by probing `-v`, not by name.

### Gaps
- No primary changelog for 2.19 → 2.20 → 2.21 was retrieved; new_calc.htm now only shows 2.23. The 2.19/2.20 manuals were not diffed.
- The exact `ccx -v` output string was not captured; FreeCAD's regex implies it contains "2.xx".

---

## 10. Licences

### Takeaway
CalculiX is GPL. SPOOLES is public domain. PaStiX is CeCILL-C, an LGPL-like, GPL-compatible copyleft licence. PARDISO, in the form the manual uses (Intel MKL), is proprietary. Wren invokes the user's locally installed ccx as a separate process and does not link it, so these licences mainly matter if Wren ever bundles ccx binaries.

### Cited Findings
- **CalculiX:** dhondt.de describes CalculiX as "A Free Software Three-Dimensional Structural Finite Element Program", links the GPL text, and credits Ashcraft, Grimes, Pierce and Wah for SPOOLES and Tobias Opel for the PaStiX interface — [dhondt.de](https://dhondt.de/). Gentoo lists the licence as GPL-2 — [Gentoo listing (secondary)](https://arran4.github.io/gentoo-packages/repos/gentoo/categories/sci-libs/packages/pastix)
- **SPOOLES:** licensed public-domain, from netlib, per a secondary source (Gentoo) — [Gentoo sci-libs listing](https://arran4.github.io/gentoo-packages/repos/waebbl/categories/sci-libs)
- **PaStiX:** "distributed under the CeCILL-C license", © Bordeaux I University and INRIA — [PaStiX mirror](https://github.com/OpenCMISS-Dependencies/pastix), [openSUSE spec](https://build.opensuse.org/projects/home:redwil:15.4/packages/pastix/files/pastix.spec?expand=0), [CeCILL-C text](https://licenses.nuget.org/CECILL-C)
- **PARDISO:** the manual says "PARDISO is the Intel proprietary solver" and "PARDISO is proprietary" — [ccx_2.23.pdf §2, §7.123](https://www.dhondt.de/ccx_2.23.pdf)
- **FreeCAD:** its ccx tooling is LGPL-2.1+ (headers in calculixtools.py) or GPL-2+ (ccxtools.py). It shells out to ccx as a separate process — [ccxtools.py](https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/Fem/femtools/ccxtools.py)

### Inferences
- Running ccx as an external process via a local helper is "mere aggregation" under GPL norms. Wren's own licence is unaffected (inference, not legal advice).
- If Wren ever distributes a ccx binary, note that PARDISO builds add Intel MKL terms. SPOOLES-only builds (Debian-style) are the cleanest to redistribute.

### Gaps
- I did not confirm whether CalculiX is "GPL-2.0-only" or "GPL-2.0-or-later" from the source headers. The task states GPL-2.0-or-later; check the `ccx_2.23.c` header or the Debian copyright file.
- ARPACK's licence (BSD-3 in arpack-ng) was not sourced here. SPOOLES public-domain status is confirmed only via a secondary source (Gentoo), not netlib directly.
