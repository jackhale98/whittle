# Reference parts (PLAN section 12 M3 and 12A)

Ten original parts for Wren's certification-style suite. Each is a drawing with named driving
dimensions, a material and a mass to verify, plus CSWP-style stages that change named dimensions.
They are written for Wren. Nothing here is copied or adapted from Dassault's CSWA or CSWP material
or from any other published exam or textbook drawing, and nothing of that kind may be added.

## What is here

| Part | Level | Material | Mass (g) | Features |
| --- | --- | --- | --- | --- |
| `rp01-base-plate` | CSWA-like | Aluminium 6061-T6 | 270.399 | extrude, through-all and blind cuts |
| `rp02-stepped-shaft` | CSWA-like | Structural steel | 444.479 | revolve, fillet, chamfer |
| `rp03-ball-knob` | CSWA-like | Brass C360 | 552.963 | sphere from a revolved semicircle, offset reference plane, cut, chamfer |
| `rp04-clamp-block` | CSWA-like | Aluminium 7075-T6 | 315.090 | fillet and chamfer (propagate on and off), boolean, push/pull |
| `rp05-moulded-housing` | CSWP-like | ABS | 49.023 | draft, shell |
| `rp06-cable-guide` | CSWP-like | Nylon PA12 | 99.183 | sweep, sweep-cut, reference planes |
| `rp07-duct-adapter` | CSWP-like | PETG | 103.827 | loft, convert entities, offset entities, reference plane |
| `rp08-cover-plate` | CSWP-like | Stainless steel 304 | 761.813 | hole wizard (counterbore, countersink, tapped), reference point, linear pattern with a skipped instance |
| `rp09-flanged-hub` | CSWP-like | Cast iron | 1232.987 | revolve, reference axis, circular pattern with two skipped instances |
| `rp10-comb-plate` | CSWP-like | Acetal (POM) | 55.717 | linear pattern with a skipped instance, mirror |

For each part `<id>` the folder holds:

- `<id>.spec.json`: the machine-readable spec (below).
- `<id>.md`: the same for people: dimensions, build intent, the mass derivation, the stages, and the
  independent check.
- `<id>.svg`: the spec drawing (orthographic views, every driving dimension named, with its own
  "Wren reference part" title block).
- `freecad/rpNN.py`: the independent FreeCAD build. `freecad-results.json` records its output.

The source of truth is TypeScript, in `parts/rpNN.ts` (a `PartDef`: dimensions, steps, the analytic
model, stages, the drawing). `lib/spec.ts` generates the three committed files from it. A test fails
when a committed file is stale; `pnpm --filter @wren-cad/test-fixtures generate` rewrites them.

## Tests

| Command | What it checks |
| --- | --- |
| `pnpm --filter @wren-cad/test-fixtures test` | Everything below. |

- `test/reference-parts.test.ts` (no kernel): the committed files are current; every derivation,
  recomputed in code from the spec's own dimensions, matches the stated volume, mass, area and
  bounding box to 1e-9 relative, at the baseline and at every stage; every drawing names every
  driving dimension with its value; every part builds a well-formed `WrenDoc` (all expressions
  evaluate with the right dimension, all references point to origin entities or earlier features);
  FreeCAD's recorded volumes and areas match to 1e-9.
- `test/reference-parts.kernel.test.ts` (real Wasm kernel, through the kernel-client regen engine in
  Node, as the kernel-client goldens do): each part is regenerated at the baseline and at every stage,
  and volume and mass are checked to 0.1 %, with area and bounding box. It needs
  `packages/kernel/dist` (set `WREN_KERNEL_DIST` to use another build). A part that needs a
  feature the engine cannot regenerate yet is skipped with `test.skip` and the reason, driven by the
  `PENDING` table at the top of that file. **After merging an M3 workstream, delete its `PENDING`
  line and run the suite**: the parts that needed it then run for real.

## The spec JSON

```jsonc
{
  "schema": "wren-reference-part/1",
  "id": "rp01-base-plate", "no": 1, "title": "...", "level": "CSWA-like", "summary": "...",
  "units": { "length": "mm", "angle": "deg" },
  "material": { "libraryId": "whittle:aluminium-6061-t6", "name": "...", "density": "2.70 g/cm^3", "density_g_cm3": 2.7 },
  "dimensions": { "length": { "value": 120, "unit": "mm", "description": "..." } },   // name = document parameter
  "tags": ["extrude", "cut"],                // features covered
  "standards": [{ "ref": "ISO 273 ...", "value": "6.6 mm" }],
  "method": "how the expected values were derived, and their accuracy",
  "features": [ /* steps, below */ ],
  "expected": { "volume_mm3": 0, "mass_g": 0, "area_mm2": 0 /* where analytic */, "bbox": { "min": [0,0,0], "max": [0,0,0] } },
  "stages": [ { "name": "Stage 2: length -> 140 mm", "set": { "length": 140 }, "expected": { /* as above */ } } ],
  "drawing": "rp01-base-plate.svg",
  "independent": { "tool": "FreeCAD", "script": "freecad/rp01.py", "results": "freecad-results.json" }
}
```

Mass is `volume x density / 1000` (mm^3, g/cm^3, g). A stage sets named dimensions to new absolute
values; the baseline document with only those parameters changed is the stage's document.

## The feature-list (step) format, for UI scripts

`features` is the ordered build intent. A UI script walks it step by step. A step is a feature of
the document schema (`packages/contracts/src/document.ts`) with three changes: it has a local
`id`, a `say` line (what a person would do; log it), and every `EntityRef` is written as a **pick**.
The builder (`lib/builder.ts`, `buildDoc`) turns the same steps into a `WrenDoc`, so the document
and the UI script cannot drift apart.

```jsonc
{ "tool": "extrude",            // the feature type = the tool to use
  "id": "base",                 // local id; later steps refer to it as {base}
  "say": "Extrude the rectangle by thickness, as a new body.",
  "profile": [ { "pick": "region", "sketch": "base_sk", "curves": ["L1","L2","L3","L4"], "at": [50,30,0] } ],
  "direction": "normal", "end": { "kind": "blind", "depth": "thickness" }, "op": "new" }
```

**Values** are expressions over the dimensions (`"thickness"`, `"-length/2"`, `"base_t + loft_h"`).
Type them into the inline field as written. Counts are bare names (`"tap_n"`), angles are
`"3 deg"` or a dimension in degrees. Before the first step, create one parameter per entry of
`dimensions` (`value` and `unit`).

**Picks** name geometry in two ways at once:

| Field | Use |
| --- | --- |
| `pick` | `face`, `edge`, `vertex`, `region`, `body`, `plane`, `axis`, `point`. |
| `at` | A world point in mm, at the baseline dimensions, on the picked entity: a point on a face, on an edge, inside a region, on the body. **Click there** (the E2E projects it to the screen). |
| `name` | The persistent name (PLAN 7.3) with `{stepId}` for the step that made it, for example `F{base}:end` (the extrude's end face) or `edge(F{base}:end\|F{base}:side(S{base_sk}:e(L1)))`. Use it to assert what was picked (the stored reference after the click must equal the name with `{x}` replaced by that step's feature id), and for named references to earlier features. |
| `sketch`, `curves`, `inner` | For regions, instead of `name`: the sketch step, the outline's curve ids, and inner loops. |
| `origin:XY`, `origin:Z`... | Origin planes and axes: pick them in the tree. They have no `at`. |

**Sketches** (`tool: "sketch"`) have `on` (a pick of a plane or face) and `ops`:

| `op` | Draw |
| --- | --- |
| `rect` | A rectangle, lower-left corner `(x, y)`, size `w` x `h`; lines `id1..id4` = bottom, right, top, left. Dimension `w`, `h`, and `x`, `y` from the origin. |
| `circle` | Centre `(cx, cy)` and diameter `d`; dimension `d` and the centre from the origin. |
| `polygon` | A closed polygon through `pts`; lines `id1..idn`. Dimension every vertex from the origin. |
| `point`, `line`, `arc` | Single entities. `arc` goes counter-clockwise from `a` to `b` around `c`; `radius` is its dimension. `point.dims` says which coordinates to dimension (`xy`, `x`, `y`, `none`). |
| `convert` | Convert Entities on the picked model edge: a linked line `id`. |
| `offsetRect` | Offset Entities on the four converted lines `sources`, by `distance`; lines `id1..id4`. |

Every `x`, `y`, `w`, `h`, `cx`, `cy`, `d`, `radius`, `distance` is a driving dimension typed as the
expression shown. Positions are measured from the sketch origin; the sketch plane's frame follows
the PLAN (XY: x right, y up; XZ: x right, z up; YZ: y right, z up; a planar face or plane feature:
the frame of that plane).

**Tools** map to the UI as follows: `sketch`, `extrude`, `revolve`, `fillet`, `chamfer`, `shell`,
`hole` and `pushPull` are the toolbar tools of the same name. `linearPattern`, `circularPattern` and
`mirror` are the Pattern tool's modes; `plane`, `axis` and `point` come from the Reference group;
`draft`, `sweep`, `loft` and `boolean` (Combine) are Modify and Solid tools. The names are the
document's feature types, so a script can also assert the feature list in the document store after
each step: `features[i].type === steps[i].tool`.

**Copies** (`mirror`, patterns) list the steps they copy in `source.features` (step ids). `skip`
lists suppressed instance indices (0 is the original). **Holes** place their points on a pick of
sketch points (`S{sk}:p(P)`) or a reference point (`F{pt}:point`).

**Checking** after the last step (and after each stage's parameter edits): volume, mass and
bounding box from the mass-properties panel against `expected` (or the stage's), within 0.1 %.
Stage values are in `stages[i].set`; apply them in the parameter table only, then re-check.

## Independent check (FreeCAD)

`freecad/rpNN.py` builds each part with FreeCAD's own modelling calls (primitives, booleans,
fillet and chamfer operators, revolve, loft, pipe shell, thickness, mirror), not with the formulas,
for the baseline and every stage. `freecad/run_all.py` runs all of them:

```sh
micromamba create -p fc -c conda-forge freecad      # or any FreeCAD >= 0.21 with the Part module
fc/bin/python packages/test-fixtures/reference-parts/freecad/run_all.py --write
```

It prints the volume and the relative difference to the analytic value for all 40 cases and writes
`freecad-results.json`. Recorded run (FreeCAD 26.3.0): the worst difference is 2.7e-12. Two
assumptions are worth knowing: the housing's draft direction (walls lean inward going up from the
neutral bottom face) and the hole tables' M6 clearance 6.6 mm and M8 tap drill 6.8 mm (ISO 273 and
ISO 261); both are stated in the specs.

## Adding a part

Write `parts/rpNN.ts`, add it to `parts/index.ts`, write its `freecad/rpNN.py`, run the FreeCAD
build with `--write`, then `pnpm --filter @wren-cad/test-fixtures generate`. The drawing generator
refuses labels that fall off the sheet; the tests refuse a drawing that misses a dimension.
