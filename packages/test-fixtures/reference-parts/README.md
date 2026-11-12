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
  "drawing": { "file": "rp01-base-plate.svg", "projection": "third", "views": [ /* below */ ], "dimensions": [ /* below */ ] },
  "independent": { "tool": "FreeCAD", "script": "freecad/rp01.py", "results": "freecad-results.json" }
}
```

Mass is `volume x density / 1000` (mm^3, g/cm^3, g). A stage sets named dimensions to new absolute
values; the baseline document with only those parameters changed is the stage's document.

## The drawing section (M4)

`drawing` says what the spec drawing shows, so the M4 E2E (`apps/web/e2e/m4-reference-drawings.spec.ts`)
can recreate it with the drawing tools and compare. It is generated from the same `draw` function as the
SVG (so the two cannot drift), typed in `lib/types.ts` (`DrawingSpec`) and validated by
`lib/validate.ts` in `test/reference-drawing-spec.test.ts`, which also checks every dimension against
the SVG's own `data-dim` / `data-value`.

- `views[]`: `id`, `caption`, `kind` (`base`, `projected`, `section`, `detail`), `orientation` (the
  standard view), `parent`, `side` (third angle: where it sits relative to its parent), `rotation`,
  `axes` (what the drawn x and y are in the part) and, for sections, `section.cut` (two or more points
  in the parent view's drawn coordinates; more than two is a stepped section) and `look`.
- `dimensions[]`: `name` (the driving dimension), `kind` (`linear`, `diameter`, `radius`, `chamfer`,
  `angle`, `count`), `value` (as printed, so a position left of the origin is negative; Wren's
  dimensions are unsigned), `unit`, optional `tolerance` (`{ plus, minus }`; none yet), the `view`, and
  the geometry it measures in the view's drawn coordinates (`axis`, `from`, `to` for a linear one; `at`
  and `radius` for the others).
  M4.1 adds, on a dimension: `refs[]` (`name` with `{stepId}` placeholders, `kind`, `at`, and for an
  angle's second ref `fromNormal`), the model entities it measures where the points alone cannot say
  (construction geometry, extremes, section faces, draft angles); an absent `axis` on a linear
  dimension means no direction (the natural separation, `wall`); and for an angle `from` / `to`, a
  point on each face. `kind` says what annotation the suite requires (`linear` is a linear, aligned or
  ordinate dimension, so a Ø120 does not satisfy `flange_d`). A view may carry
  `display: { hidden?, tangent? }` (`thin` or `visible`), the view-inspector settings the drawing is
  measured with. `reference-spec-refs.golden.test.ts` in kernel-client resolves every `refs` list on
  the real kernel to the printed value.

The E2E builds each part with `buildDoc` and the `load` hook (a UI build takes minutes: that is
`m3-reference-parts.spec.ts`), then makes the views, the section cut, runs Import model annotations and
adds what is missing with the Dimension tool. What it cannot make is listed in
`apps/web/e2e/support/reference-drawing-gaps.ts` as product gaps.

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
Type them into the inline field as written. Counts are expressions too (`"tap_n + 1"`: the
pattern's positions, the skipped ones included, when the named count is the instances that exist), angles are
`"3 deg"` or a dimension in degrees. Before the first step, create one parameter per entry of
`dimensions` (`value` and `unit`).

**Picks** name geometry in two ways at once:

| Field | Use |
| --- | --- |
| `pick` | `face`, `edge`, `vertex`, `region`, `body`, `plane`, `axis`, `point`. |
| `at` | A world point in mm, at the baseline dimensions, on the picked entity: a point on a face, on an edge, inside a region, on the body. **Click there** (the E2E projects it to the screen). |
| `name` | The persistent name (PLAN 7.3) with `{stepId}` for the step that made it, for example `F{base}:end` (the extrude's end face) or `edge(F{base}:end\|F{base}:side(S{base_sk}:e(L1)))`. Use it to assert what was picked (the stored reference after the click must equal the name with `{x}` replaced by that step's feature id), and for named references to earlier features. |
| `sketch`, `curves`, `inner` | For regions, instead of `name`: the sketch step, the outline's curve ids, and inner loops. |
| `origin:XY`, `origin:Z`... | Origin planes and axes: pick them from the reference chips beside the prompt (plane, axis and point features too; sketch planes from the plane chooser). They have no `at`. |

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

## Spec corrections (M4 gate, round 3)

Recorded per the lead's decisions (DECISIONS.md, ADR-090 amendment "lead decisions on counts and
rp04"). Every correction keeps the geometry: the analytic volumes, the masses and the recorded
FreeCAD results are unchanged at the baseline and at every stage (`reference-parts.test.ts` checks
them against `freecad-results.json` to 1e-9; `reference-parts.kernel.test.ts` regenerates all 40
cases on the real kernel to 0.1 %). The FreeCAD scripts were changed to read the corrected
parameters; FreeCAD itself was not re-run (it is not installed in this environment), so the
recorded results stand on the scripts building the same solids from the corrected values.

**Counts are instance counts.** The spec SVGs of rp08, rp09 and rp10 draw the skipped pattern
positions as hidden (dashed) outlines and the holes that exist as visible circles: 3 tapped holes
(positions 0, 2, 3 of 4), 6 bolt holes (8 positions, 2 and 5 dashed) and 5 slots (6 positions, 3
dashed). They show fewer holes than the pattern setting, so the spec value is corrected to the
visible count, and the pattern's count becomes that plus the skipped positions:

| Part | Dimension | Was (pattern setting) | Now (visible count) | Pattern count | Stage that set it |
| --- | --- | --- | --- | --- | --- |
| rp08 | `tap_n` | 4 | 3 | `tap_n + 1`, skip 1 | Stage 4: `tap_n` 5 → 4 (five positions) |
| rp09 | `bolt_n` | 8 | 6 | `bolt_n + 2`, skip 2 and 5 | Stage 2: `bolt_n` 10 → 8 (ten positions) |
| rp10 | `slot_n` | 6 | 5 | `slot_n + 1`, skip 3 | Stage 2: `slot_n` 7 → 6 (seven positions) |

A drawing's `N×` is the number of instances in the model (the kernel's `AnnotationResolution.count`),
so the recreated drawings now read 3×, 6× and 5×, as the spec drawings show.

**rp04 `boss_h`.** The spec named `boss_h` the boss "as first extruded" (20) and dimensioned it from
the plate top to a line 20 mm up, with `boss_up` (6) above it. Evidence for which side was wrong:

- the spec drawing's own front view draws the boss as one rectangle from the plate top to
  `T + 26` (no edge at 20 mm);
- the FreeCAD reference builds one cylinder of height `boss_h + boss_up` = 26 (bounding box top at
  z = 42 = 16 + 26), and its volume is the recorded mass;
- the builder extrudes 20 and pulls the top face up 6: 26, the same solid.

So the builder is right and the spec value is wrong: the finished part has no face 20 mm above the
plate. `boss_h` is now the boss height as built, 26; the builder extrudes `boss_h - boss_up` and
pulls up `boss_up`; stage 3 (which pulled 10 instead of 6 with the first extrusion unchanged) is now
`boss_h` 30 with `boss_up` 10, the same solid as before. The drawing dimensions `boss_h` from the
plate top to the boss top (inside its chamfer). `boss_up` stays on the drawing as the push/pull
distance; the level it starts from is history, which the drawing suite lists as a construction
gap.

**Dimension anchors.** Two spec dimensions pointed at geometry that is not there:

- rp08 `tap_dx` was drawn from the first tapped hole to position 1, the skipped one. It is now
  drawn between two holes that exist (positions 2 and 3), its dimension line where it was.
- rp10 `slot_x0` (the first slot centre's x, −45) was drawn from the plate's left end, a 15 mm
  span; it is now drawn from the centre line. `slot_pitch` is drawn between like edges of the
  first two slots (their left walls) instead of their centre planes, which no view draws.

## Spec changes (M4.1, ADR-095 item 8)

The geometry, volumes and stages are unchanged; the specs gained the entities the 16 drawing gaps
need, and some drawings were corrected.

- **rp04 `boss_up`** is measured from a reference plane `boss_lvl` (step 11, offset
  `plate_t + boss_h - boss_up` above the Top plane, 36 mm at baseline) to the boss top, `refs`
  `F{boss_lvl}:plane` and `F{join}:face(F{boss}:end)`. The plane follows the parameters. The front
  view draws it edge-on as a centre line. The plane is the last step so that no step id moves.
- **rp10 `slot_x0`** is measured from `origin:Y` to a construction centre point `SC` in `slot_sk`,
  at (`slot_x0`, 0): dimensioned `slot_x0` from the sketch origin, and level with it
  (`horizontalPoints`; the new `align` option of the `point` sketch op). The top view draws the
  centre line and the slot's centre mark.
- **rp06**: the right view has `display.tangent = thin` and draws the two tangent circles of the
  rod's bend (edge-on) thin, where `rod_h` and `rod_tail` end.
- **rp05 `draft_a`** is refs [drafted wall `F{base}:side(S{base_sk}:e(L2))`, neutral face
  `F{base}:start`] at `['self', 'axis']` with `fromNormal` on the second, 3 deg. **`wall`** has no
  direction (`axis` absent): measured normal to the drafted walls, 3 mm (horizontally the same wall
  reads 3 / cos 3 deg = 3.004).
- **rp09 `flange_d`** is a linear dimension across the rim, refs [rim, rim] at `['min', 'max']`,
  direction x, 120 (it was recorded at (-60, -60), which is not on the part). `pcd` is
  `F{ring}:pitch`; `hub_h` the flange top and hub top faces.
- **rp02 `fillet_r`, rp03 `flat_h`, rp08 `cs_x`, `cs_y`, `tap_depth`** have their refs (the
  fillet's torus face; `origin:X` to the flat's rim; `origin:Y` / `origin:X` to the countersink
  rim's centre; the plate top to the tapped hole's floor). rp08 `cs_y` is now drawn from the hole
  centre rather than from the plate edge, and rp03 and rp08 draw their centre lines.
- **rp07 `inset`: misdiagnosed as a hidden edge.** The M4 gate listed it as GAP-PICK-HIDDEN: "the
  loft's base outline is hidden under the loft". It is not. The loft narrows going up (50 x 30 at
  z = 10 to 30 x 14 at z = 50), so its sides face up and its base outline, where they meet the plate's
  top face, is visible from +Z. The spec SVG drew it dashed, and the spec point was the plate edge's
  midpoint at the wrong place, (-40, 30) to (-25, 30): 15 mm past the end of the inset edge, which
  runs from (-25, -15) to (-25, 15). The SVG now draws the outline solid and the dimension runs from
  (-40, 0) to (-25, 0), on the two edges. Nothing needs a hidden-line pick for it.
- **Phase 2 (certification driver) corrections.** rp08 `tap_depth` is drawn at the second tapped
  hole (x = `tap_x0` + 2 `tap_dx`): the stepped cut passes through the tapped row only from x = 0 on,
  so the first hole (at `tap_x0`) is not in the section. rp06 `ch_d` is a linear width across the
  groove's walls in the top view (its path's last leg), not a Ø leader: the groove's circular
  section is not seen from above, and a diameter cannot be picked there. The suite's new kind
  check (a `linear` spec dimension must be a linear, aligned or ordinate annotation) is why.
- **Not given refs** (their entity names are not yet pinned by a golden): rp06 `rod_h`, `rod_tail`
  (tangent edges), rp08 `tap_dx` (hole centres), rp07 `inset`.

## Adding a part

Write `parts/rpNN.ts`, add it to `parts/index.ts`, write its `freecad/rpNN.py`, run the FreeCAD
build with `--write`, then `pnpm --filter @wren-cad/test-fixtures generate`. The drawing generator
refuses labels that fall off the sheet; the tests refuse a drawing that misses a dimension.
