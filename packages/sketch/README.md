# @whittle/sketch

The 2D sketch layer: the constraint solver, the degrees-of-freedom analysis, the conflict explanations,
constraint inference while drawing, the drawing tools and the geometry helpers.

The solver is [planegcs](https://github.com/salusoft89/planegcs) (`@salusoft89/planegcs`, LGPL-2.0-or-later),
which is FreeCAD's PlaneGCS compiled to WebAssembly. Whittle owns the policy around it. planegcs
answers "can these constraints be satisfied?", and Whittle checks the answer itself.

## Entry points

| Entry | Runs on | What it is |
| --- | --- | --- |
| `@whittle/sketch` (`src/index.ts`) | Main thread | `createSketchSolverClient()` (spawns the worker and wraps it with Comlink), inference, the drawing tools, geometry and explanation helpers. Loads no Wasm. |
| `@whittle/sketch/worker` (`src/worker.ts`) | Sketch worker | Loads planegcs (the `.wasm` as a hashed asset via `?url`) and exposes `SketchSolverApi` over Comlink. |
| `@whittle/sketch/core` (`src/core.ts`) | Node, or any worker | `createSketchSolver()`, the solver itself, synchronous once planegcs has loaded. The kernel worker uses it for sketch re-solves. |

Never import `core` on the main thread. Use the client from the package root.

## Exports (from `src/index.ts`)

- **Client:** `createSketchSolverClient`, `SketchSolverClient`, `SketchSolverClientOptions`.
- **Explanations:** `constraintLabel`, `describeFor`, `formatLength`, `formatAngle`, `Namer`.
- **Inference:** `infer`, `bindCandidate`, `ANGLE_TOLERANCE`, `CURSOR_POINT`, `DRAWING_ENTITY`, `DrawingState`,
  `ConstraintDraft`.
- **Drawing tools:** `lineTool`, `polylineTool`, `rectangleCornerTool`, `rectangleCenterTool`,
  `rectangle3PointTool`, `circleCenterTool`, `circle3PointTool`, `arcCenterTool`, `arc3PointTool`,
  `arcTangentTool`, `slotTool`, `polygonTool`, `setConstruction`, `mergeFragment`, `newId`.
- **Geometry:** `sampleSketch`, `sampleEntity`, `sketchBounds`, `closestOnEntity`, `closestOnSegment`,
  `projectOnLine`, `circumcircle`, `indexEntities`, plus the line, arc and circle helpers.

The shared types (`SketchSolveInput`, `SketchSolveResult`, `SketchConflict`, `DofState` and so on)
are in [`packages/contracts/src/sketch.ts`](../contracts/src/sketch.ts).

## How a solve works

1. **Model.** `src/model.ts` turns the sketch into a flat parameter vector in millimetres and one
   residual per constraint row. Reference (driven) dimensions are left out of the solve.
2. **Solve.** planegcs solves the driving constraints. Whittle does not trust the answer on its own.
3. **Verify.** Every residual is recomputed in TypeScript. A sketch is `solved` only if all residuals
   are within tolerance (1e-7 times the sketch's scale for lengths, 1e-7 for angles). planegcs can
   report success on degenerate collapses, and this catches them.
4. **Measure.** Reference dimensions are measured from the solved geometry.
5. **DOF.** `src/analysis.ts` builds the Jacobian by finite differences and takes its rank. The sketch
   has `dof` remaining degrees of freedom. Each entity is `fixed` (no freedom), `partial`, or `free`.
   The app colours entities by these states.
6. **Conflicts.** If the constraints can't all hold, `src/solver.ts` finds a minimal conflicting set
   per connected component, with QuickXplain (Junker, AAAI 2004). The lowest-priority constraint in the
   set is relaxed, and the search repeats (up to eight conflicts). Each conflict has a plain-language
   explanation (`src/explain.ts`) and suggested fixes. A `fix` constraint is treated as ground, and the
   explanation says so when the geometry itself is the problem.

### Dragging

`beginDrag`, `drag` and `endDrag` add temporary constraints that pull the grabbed geometry toward
the cursor, in a separate planegcs system. Each move is a re-solve in place. The drag budget is
≤ 4 ms median for 200 entities (PLAN §10). `test/drag.test.ts` asserts it and allows 12 ms on CI.

### Inference

`src/inference.ts` proposes constraints while you draw: horizontal and vertical snaps, parallel,
perpendicular and tangent within a small angular tolerance (`ANGLE_TOLERANCE`, 3°), and coincidence
with the cursor or an existing point. `bindCandidate` attaches the chosen candidate to the drawing.

## Tests and scripts

| Command | What it does |
| --- | --- |
| `pnpm --filter @whittle/sketch test` | `vitest run` over `test/`: constraints, DOF, conflicts, drag (with the budget), inference, tools, the client and the helpers |
| `pnpm --filter @whittle/sketch typecheck` | `tsc -p .` |

The solver tests use the real planegcs in Node. `test/helpers.ts` builds one shared core for them.

## Design notes

- **Tolerance and coplanarity.** A dimension within 1e-7 times the sketch size counts as satisfied,
  and the solver does not move the geometry for it. Two sketches that are each about 1e-5 mm off can
  therefore leave sliver faces where faces should be coplanar. A "polish" step is proposed for M2
  (ADR-008 §9). It is not built yet.
- **Why Whittle re-verifies.** planegcs is a general-purpose solver. Whittle's checks keep the
  document from getting a "solved" sketch that is in fact a collapsed one, and they feed DOF and the
  explanations.
- **Licence.** planegcs is LGPL-2.0-or-later, which GPL-3.0 can use (ADR-001, ADR-003).

## Related

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md), section 5: the sketch solver in context.
- [`packages/contracts/src/sketch.ts`](../contracts/src/sketch.ts): the sketch model and API types.
- [`packages/ui`](../ui): the sketch toolbar, the status chip and the conflict panel.
