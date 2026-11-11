# M4 contracts proposal: drawings on the shared annotation core

Status: **proposal, not applied.** `packages/contracts` is lead-owned. The exact types are in
[`M4-contracts.ts`](./M4-contracts.ts). That file compiles on its own against the current contracts
(`tsc --noEmit` with `tsconfig.base.json` plus `noUnusedLocals`) and passes Biome. Its section
headings (§A–§F) name the contracts file each part goes into. A `4` suffix (`Part4`, `Command4`)
marks the v4 shape of an existing type; on apply it replaces the type of the same name.

Inputs: PLAN §2.4, §6, §8A.1, §8A.3, M3.7, M4 and M5; ADR-055, 074, 077, 078, 079 and 081; the
research report `docs/ux-research/reports/Drawings and configurations UX.md` (List 2: features
1–18, traps T1–T13, decisions D1–D10); and the current `document.ts`, `sketch.ts`, `modeling.ts`,
`store.ts` and `sync.ts`, with their implementations in packages/document (`migrations.ts`,
`features.ts`) and packages/sync (`merge/tree.ts`).

---

## 1. Summary

- **Annotations are part data.** `Part.annotations` is an id-keyed set of semantic annotations
  (§A). It replaces `FeatureBase.annotations`. A dimension drawn on a view creates a part
  annotation with `origin: { kind: 'drawing', drawingId }`. M5 displays and exports the same
  objects.
- **A drawing stores intent only.** It holds sheets, views, per-view **placements** of
  annotations (relative to the geometry, in sheet mm), tables, sheet notes, centre marks and
  markup. HLR output, values, frames, title blocks and table rows are always derived.
- **Trust rules built into the types:**
  - The value a resolver returns is absent whenever an annotation needs attention, so no stale
    number can be drawn (T1).
  - Every annotation kind keeps its geometry in one `refs: EntityRef[]` list, so one reattach
    path serves all kinds (T2).
  - Projection is an explicit drawing field (T4).
  - Styles are in sheet mm (T8).
  - A configuration id that no longer exists is flagged, never treated as Default (T13).
- **Mergeable layout.** Collections are flat and id-keyed. Only `sheets` has a meaningful order;
  every other collection is kept sorted by id. Projected views are stored relative to their
  parent, so switching first/third angle needs no edits.
- **Schema v3 → v4.** The migration moves feature annotations into the part set with their ids
  unchanged. It re-keys configuration overrides from `/annotations/<index>/…` to the annotation
  id, which closes the M3.7 gate finding. It mints no ids, so base, ours and theirs migrate to the
  same thing.

---

## 2. Shared annotation core (§A, §B)

### 2.1 Where annotations live

`Part.annotations?: Annotation[]`. Absent means none. The array's order carries no meaning: the
store, the merger and the loader keep it sorted by id. This is the precedent `Part.folders` set.

Why part-level and not per feature (ADR-081): a drawing dimension measures the finished part, and
no feature owns it. There are two side benefits:

- `refsOf(feature)` stops counting annotation refs, which today add false dependency edges
  (packages/document `features.ts` line ~338).
- The regen engine's `/annotations/` filters in `engine.ts` and `attribution.ts` can go.

### 2.2 Kinds and refs per kind

| kind | refs (positional) | `at` usually | value |
|---|---|---|---|
| `linear` | [a, b] | `self`, `center`, `axis` | projected on `direction`. With no direction: the natural separation of parallel planes or lines |
| `aligned` | [a, b] points | `center`, `start`/`end` | true distance |
| `ordinate` | [origin, target] | any | coordinate along `direction` |
| `radius` / `diameter` | [circular edge or round face] | `self` | radius / diameter. Spherical faces show SR / SØ |
| `angle` | [a, b] lines, planes or axes | `self`, `axis` | between them, or the `supplement` |
| `chamfer` | [chamfer face] | `self` | distance × angle or two distances |
| `datumFeature` | [face / edge / axis] | `self`, `axis` | — (`label`) |
| `geometricTolerance` | [toleranced feature], or [] with `appliesTo` | `self`, `axis` | — (`zone`) |
| `note` | ≥ 1 leader targets | any | — (`text`) |
| `surfaceFinish` | [face] | `self` | — (`requirements`) |
| `holeCallout` | hole faces picked for leaders (may be []) | `self` | from the `HoleFeature` / `ThreadFeature` |

`at` (a `RefPoint[]` parallel to `refs`) says which point of an entity is measured: the centre of
a circle, the axis of a cylinder, the start, end or middle of an edge. It is a separate array so
that each `EntityRef` stays exactly `{ name, kind, fingerprint }`. The merger merges a ref whole
only when it has exactly those keys (`isEntityRef` in `merge/tree.ts`). It also keeps
`UnresolvedRef.path` the same as for features (`/refs/1`).

**Direction** is a unit `Vec3` in part coordinates. The drawing tool sets it from the view's
horizontal or vertical. Promotion sets it from the sketch's u/v for `hDistance`/`vDistance`.
Direction is semantic, not layout: M5 needs it for the AP242 dimension orientation, and a
point-to-point distance has a different value per direction. An open question asks whether to
also allow a direction given by an `EntityRef` (Q5).

### 2.3 Values: source, nominal or measured

A dimension shows exactly one of three values:

1. **`source`**: live from model data (owner D6, recommended: read-only in drawings). It can be:
   - `sketchDimension { featureId, constraintId }`;
   - `featureField { featureId, path }`, where `path` must be one of the feature's `exprFields`;
   - `feature { featureId }`, the whole feature, for chamfer, hole and thread callouts.

   The value is the source evaluated in the *view's configuration*. In a drawing the field is
   read-only and shows an "Edit in part" affordance. That routes through the ordinary feature
   and sketch commands, so the M3.7 edit-scope rules (ADR-074) apply unchanged.
2. **`nominal`**: a stated `Expr`. Used for M5 imports and for migrated v3 `value`s.
3. **Neither: measured** from the resolved refs. This is the default for the drawing tool.

`source` and `nominal` are mutually exclusive (validation). When a sourced or stated value
differs from the measured geometry by more than 1e-6 relative, the drawing shows the
`valueMismatch` flag. The value is never shown as if it were fine.

Promoted sketch dimensions use the sketch entities' own names as refs (`S…:e(<id>)`,
`S…:p(<id>)`). Those resolve as long as the entity exists, and need no guess at which model edge
coincides. If the sketch line is not on the final body, the witness lines go to where the sketch
says, which is correct.

Promoted feature dimensions get refs from fixed rules:

| Feature field | Annotation and refs |
|---|---|
| Extrude `/end/depth` | `linear` between `F:start` and `F:end`, along the extrude direction |
| Fillet `/radius` | `radius` on the first `F:fillet(…)` face |
| Chamfer | `chamfer` on the chamfer face, `source: feature` |
| Hole | `holeCallout` |
| Revolve `/angle` | `angle` between the caps |

Everything else is not promotable in M4: shell thickness, pattern spacing, draft angle. The import
panel says so and offers the dimension tool instead.

### 2.4 Tolerances

`Tolerance` is a union:

- `symmetric { value }`
- `bilateral { upper, lower }`
- `limits { upper, lower }`
- `basic`
- `reference`
- `fit { hole?, shaft?, show }`

Deviations are signed `Expr`s relative to the nominal, so a configuration that changes the nominal
keeps its tolerance. `limits` stores deviations as well and is only *displayed* as limits. This
matches how the major CAD tools store limits.

Inline field grammar (the parser lives in packages/drawing and is shared with M5; one unit test
per form):

```
10 ±0.1        → symmetric          10 +0.1/-0.05 → bilateral
10.1/9.95      → limits (stored as deviations from the nominal at entry)
[10]           → basic              (10)          → reference
Ø20 H7  | Ø20 g6 | Ø20 H7/g6 → fit; "H7 (+0.021/0)" → show symbolAndDeviations
```

ISO 286 fit classes are validated by pattern: one or two letters, then the IT grade, `01` or 1–18.
The deviations come from an ISO 286-2 table that packages/document holds, like `hole-tables.ts`.
Its licensing is part of D9.

### 2.5 GD&T and standards

- **Frame.** A `geometricTolerance` has:
  - `characteristic`, from 15 values including ISO-only `concentricity`, `coaxiality` and
    `symmetry`;
  - `zone`: value, Ø / SØ shape, material condition, modifiers, projected height, unequal
    offset, per-unit refinement;
  - up to three `DatumCompartment`s, each holding one or more `DatumRef`s (a common datum
    `A–B`);
  - `allAround`;
  - `appliesTo`: the size dimension whose feature of size it controls, such as a position frame
    under `Ø6`.
- **Datum references are ids, not letters.** `{ datum: <datumFeature id> }` survives a rename and
  stays unambiguous after a merge that brings two datum `B`s. `{ label }` is the unbound form:
  STEP import (M5), or a migrated v3 frame whose letter no datum defines. It shows as needs
  attention ("Datum B is not defined") with a Bind action.
- **Standard per annotation.** `standard?: GpsStandard` (`ISO 1101:2017`, `ASME Y14.5-2018`,
  `ASME Y14.5-2009`). Surface finish has its own `SurfaceFinishStandard`, defaulting to ISO
  21920-1:2021, with ISO 1302 as legacy and ASME Y14.36. Authoring tools stamp the drawing's
  standard. Absent means "not stated", and the annotation is checked against each displaying
  drawing.
- **Validation refuses; it never converts.** Refusals come with an explanation. For example,
  `illegalForStandard`: "ASME Y14.5-2018 has no concentricity; use position or profile". A frame
  stamped ISO shown on an ASME drawing is a `standardMismatch` warning.
- **Pure rule tables.** The rules live in packages/document as data, so M5 export reuses them.

### 2.6 Notes, surface finish, hole callouts

- **`note`** is a leader note on geometry. Free text on a sheet is a `SheetNote` (§3.8). Free
  notes are not part data: "BREAK ALL SHARP EDGES" belongs to the drawing.
- **`surfaceFinish`** (ISO 21920-1) has:
  - a process: any, removal required or removal prohibited;
  - all-around;
  - requirements: parameter (`Ra`, `Rz`…), upper or lower limit, a value as a length `Expr` that
    the field writes in µm, an acceptance rule, and a filter;
  - a method, a lay and an allowance.
- **`holeCallout`** has `source: { kind: 'feature' }` pointing at a hole or thread feature. There
  is one callout per feature per part (`duplicateCallout` is checked), placed in any number of
  views. A precision or tolerance edit therefore reaches every placement and the hole table
  (feature 12). The instance count includes pattern copies, from the regen
  (`AnnotationResolution.instances`).

### 2.7 References and "needs attention"

The regen engine resolves annotation refs **after the last feature**. It uses exactly the feature
rules (ADR-078): exact name, then merge alias (`merged`), then name family with containment, then
fingerprint for weak names.

The result is `RegenResult.annotations: AnnotationResolution[]`, one per annotation, in the
configuration of the slot:

- `state` is `ok`, `needsAttention` or `suppressed`;
- `unresolved` uses paths inside the annotation: `/refs/1`, `/source`, `/appliesTo`,
  `/datums/0/datums/0`;
- `cause`, `merged`, `grown` and `rebound` work as for features;
- `value` holds the value to display and is **absent whenever the state is not `ok`**;
- `measured` holds the cross-check value;
- `anchors` holds the 3D geometry for projection;
- `instances` lists hole instances.

`RegenRequest.annotations?: boolean` turns this on only while a drawing (or, in M5, the 3D display)
is open, so modelling regens pay nothing.

Rules:

- **Never re-guess.** An unresolved ref is drawn in the "needs attention" colour *and* pattern,
  with `?` in place of the number. It appears in the searchable panel, with its grid zone ("C4")
  and the upstream feature (`cause`).
- **Reattach** is `reattachAnnotation { refs, at }`. It works the same for every kind, including
  imported, ordinate and chain dimensions (T2). The suggested candidate is highlighted, and the
  user confirms it.
- **Healing.** Like features, `rebound` lets the app heal stored refs. `merged` refs are never
  healed (ADR-078).
- **Suppressed is not an error.** An annotation counts as `suppressed` when, in the view's
  configuration:
  - it is itself suppressed; or
  - its source feature is suppressed; or
  - every one of its refs comes from a suppressed feature (cause kind `suppressed`).

  It is hidden on the sheet and listed quietly as "not in this configuration". This is not a
  guess: the cause is known exactly.

### 2.8 Configuration overrides keyed by annotation id

`Configuration.annotations?: Record<annotationId, AnnotationOverride>`, where
`AnnotationOverride = { suppressed?, fields?: Record<pointer inside the annotation, value> }`.
This mirrors `features: Record<featureId, FeatureOverride>`.

- **Configurable fields:** every annotation `Expr` field, plus option fields in
  `ANNOTATION_CONFIGURABLE_OPTIONS` (`/tolerance/hole`, `/tolerance/shaft`).
- **New `ConfigTarget` variants:** `annotationField { annotationId, path }` and
  `annotationSuppressed { annotationId }`.
- **Deleting or reordering annotations can no longer retarget an override.** Order carries no
  meaning, and the key is the id. Removing an annotation removes its overrides in the same undo
  step (ADR-074 kind 1).

---

## 3. Drawings (§C)

### 3.1 The drawing

```
Drawing { id, name, subject: { kind: 'part', partId }, configurationId?, standard, projection,
          units: 'mm', style, template, sheets[], views[], placements[], centerMarks[], tables[],
          notes[], markup? }
```

- **`subject`**: one part in M4. M6 adds `{ kind: 'assembly' }`. A missing part means the whole
  drawing needs attention, and it is kept intact.
- **`configurationId`** (feature 11, T13):
  - Absent means Default, the same convention as `Part.activeConfigurationId`.
  - Views, tables and the title block inherit it.
  - A view can override it with `configurationId?: Id | null`, using the `Configuration.material`
    pattern: absent inherits, `null` is Default explicitly, an id is that configuration. The
    override is badged.
  - A view whose configuration differs from the drawing's is listed as a possible mismatch, not
    as an error.
  - `removeConfiguration` does **not** rewrite drawings. Every consumer of the deleted id is
    flagged (feature 11's E2E: "deleting B flags every view").
- **`standard`**: `{ family: 'iso' | 'asme', gps, surfaceFinish, generalTolerance? }`.
  `generalTolerance` is a string such as `ISO 2768-mK`. The family must match `gps`.
- **`projection: 'first' | 'third'`** is explicit (T4, D10). New drawings take
  `WrenDoc.drawingDefaults`, which is set by the explicit choice at the first drawing and stored
  in `wren.project.json`. Until that choice, the "new drawing" flow shows an inline chooser on the
  empty canvas, with no modal. The command runs only once the user has chosen.
- **`units: 'mm'`** is fixed in M4. Widening it to `'mm' | 'in'` later is additive.

**Coordinates:**

- **Sheet:** mm, origin at the bottom-left, y up. This matches PDF and the views' own y-up maths.
  SVG flips once, in the root group.
- **View plane:** part mm, origin at the projected part origin, y up.

### 3.2 Style in sheet mm (features 2 and 7, T8)

`DrawingStyle` holds every visual quantity in sheet mm:

- the line group: ISO `iso-0.25`, `iso-0.35`, `iso-0.5`, `iso-0.7` (thick/thin 2:1), or
  `asme-0.6` (0.6/0.3), with optional custom widths;
- ISO 3098 text heights for dimensions, notes, view labels and the title;
- the font id;
- dimension geometry:
  - ADR-055 defaults: 1 mm gap and 1.5 mm overshoot;
  - arrow kind, length and angle;
  - snap lanes: `firstLane`, 10 mm from the view outline, and `laneSpacing`, 7 mm;
  - ISO "aligned, above the line" or ASME "unidirectional, in a break of the line";
- number format: decimal mark, precision, trailing zeros, decimal or DMS angles;
- hatch;
- view display defaults.

The full style is **stored**, copied from the standard's preset at creation. An app update then
never changes a drawing that is already made, and a released PDF re-exports byte for byte.
"Reset to preset" is an ordinary `updateDrawing`. Sheet-space numbers are plain numbers, not
`Expr`s: they are layout, never parameter-driven or configured. The store rounds them to 0.001 mm
so diffs stay quiet.

One renderer maps line roles (visible = thick; hidden, centre, dimension and hatch = thin;
cutting-plane ends = thick) to widths for SVG, PDF and DXF. The PDF check is
0.35 mm = 0.992 pt.

### 3.3 Templates and title block (feature 3, T3)

`TemplateBinding { id: 'iso-5457' | 'asme-y14.1', version, fields? }` and `SheetFormat { size,
orientation }`.

**Generated, not stored.** `(format, template id, version) →` frame, centring marks, the 50 mm grid
(letters without I and O), trim marks and the title-block anchor. The ISO 5457 golden values:
margins 20/10 mm, an A3 grid of 8 × 6. Custom sizes get a frame without zones. ANSI A–E use the
ASME Y14.1 sheet. Nothing is in the document, so "re-apply template" is just
`applyTemplate { id, version }`. Views, placements, tables and notes are untouched. Text for slots
the new template lacks is kept and listed as unused, never dropped.

**`version` pins the layout generator.** Old generator versions stay in code (they are small), so
an existing drawing never shifts when the app updates. Re-applying moves to the latest version.

**Slots** (`TitleBlockSlot`):

- **Bound slots** resolve at render: title, part number, description, material, mass,
  configuration, scale, projection, units, standard, general tolerance, revision, sheet `n/m`,
  date.
  - Part number uses the M3.7 D4 fallback.
  - Mass comes from that configuration's background build (ADR-079).
- **Revision** comes from releases (PLAN §8A.3, `Release`). A release export stamps the release
  name. Otherwise the slot shows the latest release marked as having later changes (Q3).
- **Unbound slots** (owner, the ISO 7200 legal owner; drawn, checked and approved by; document
  type and status; language) take text. The text cascades: sheet `fields` → drawing
  `template.fields` → project `drawingDefaults.fields`.
- **Text over a bound slot** overrides the binding and is badged on hover, so the binding stays
  visible.
- Values are edited inline on the sheet with `setTitleBlockFields`. There is no "edit sheet
  format" mode (T3).
- An ISO 7200 identification number longer than 16 characters warns.

### 3.4 Sheets

`Sheet { id, name, format, scale: Expr, fields? }`. `sheets` is the only ordered collection: its
order is the sheet numbering. `scale` is a unitless ratio expression. The inline field accepts
`1:2` and writes `1/2`. A drawing always has at least one sheet; `removeSheet` of the last one is
refused.

### 3.5 Views (feature 5, T5)

Views are a flat `Drawing.views`, each with a `sheetId`. Moving a view to another sheet is one leaf
edit, not a delete plus an add. The union:

| kind | defined by | layout |
|---|---|---|
| `base` | `orientation`: a viewport `StandardView` name, `isometric { corner }` or `matrix { x, y }`; `rotation?: Expr` | `free { position }` |
| `projected` | `parentId`, `from: 'top' \| 'bottom' \| 'left' \| 'right'` (the side of the parent the viewer looks from) | `aligned { distance }` or `free` |
| `iso` | `parentId`, `corner` (re-derived when the parent rotates) | `free` |
| `section` | `parentId`, `letter`, `cut: AnchoredPoint[]` (≥ 2; 2 = full, more = offset or stepped, an L = half), `look: 'left' \| 'right'`, `depth?: 'full' \| 'slice'`, `hatch?` | `aligned` or `free` |
| `detail` | `parentId`, `letter`, `center: AnchoredPoint`, `radius` (part mm), `scale` (required) | `free` |

Common fields:

- `scale?: Expr`. Absent: base and iso views use the sheet's scale; projected and section views
  their parent's.
- `display?: Partial<ViewDisplay>`: `lines` (visible / visible and hidden), `tangentEdges` (visible
  / thin / off), automatic `centerMarks` and `centerLines`, `threads`. Absent fields inherit from
  the parent, or from `style.view` for base views.
- `configurationId?`, `label?`, `showLabel?`.

Decisions behind the shape:

- **Projected views are relative.** An aligned child stores only `distance` along the projection
  axis, centre to centre in sheet mm. Its side is derived from the drawing's projection. Switching
  first/third angle moves every aligned view and mirrors the symbol with **zero view edits**
  (feature 4's test). Moving a parent drags its aligned children. "Break alignment" turns the
  layout into `free` at the current position; "Restore" turns it back.
- **The rotation lives in the parent only.** Children store "seen from the parent's top", so
  rotating a parent that has children re-derives them (T5).
- **The cut line is editable and associative.** Points are `AnchoredPoint`s in the parent's
  projection plane, in part mm. A point is `free { at }` or `ref { ref, point?, offset? }`: "through
  the hole axis, 40 mm left". A section through a hole therefore follows the hole. An unresolved
  ref is needs attention, never moved to a guess. Editing a point is `updateView`, so the view is
  never recreated.
- **The view centre is the projected 3D bounding box.** `position` places the centre of the
  projected 8 corners of the part's AABB (ADR-084 cheap bounds). Draft and exact HLR therefore
  give the same layout, and nothing jumps when the exact result arrives. The box is less tight
  for iso views; that is acceptable.
- **Detail radius is in part mm**, so changing the parent's scale keeps the same region.
- **No HLR output is stored.** It is derived and cached in `.wren/` (§4).

### 3.6 Placements as intent (feature 2, T8)

`AnnotationPlacement { id, viewId, annotationId, layout, text?: { shift }, witness?: { flip, hide },
arrows? }`, in a flat `Drawing.placements`. A placement is how one view shows one annotation; the
drawing never copies the annotation. `layout`:

| layout | used by | meaning (sheet mm) |
|---|---|---|
| `lane { side, lane }` | linear and ordinate along a view axis | snap lane n outside the view outline: `firstLane + n · laneSpacing` |
| `offset { distance }` | linear, aligned, ordinate, chamfer (linear form) | signed distance of the dimension line from the measured geometry |
| `radial { angle, distance }` | radius, diameter | leader angle (degrees, sheet), text distance beyond the curve (negative = inside) |
| `arc { radius, opposite? }` | angle | arc radius from the vertex; `opposite` uses the vertical sector (same value, ADR-055) |
| `leader { attach, bends?, text, landing? }` | note, frame, datum, surface finish, callouts | `attach`: on `refs[i]` at `t`, below another placement's text, or on its dimension line; `bends` and `text` are offsets from the attach point |

After a 10 % model resize, every placement keeps its lane or offset. A view at 1:20 has the same
1.5 mm overshoot as one at 1:1. Feature 2's golden test checks both.

Other rules:

- Text sits auto-centred, shifted by `text.shift` along the line. ADR-055's rule holds: text
  beyond the extension lines pulls the dimension line out.
- Breaks at crossings are derived.
- **Uniqueness.** At most one placement per (view, annotation): validation repairs duplicates on
  load. Within a drawing, import never places an annotation twice; a second placement made by
  hand is listed as `placedTwice`.
- **A layout that doesn't fit is flagged.** A placement whose layout doesn't fit the annotation
  (it was edited from linear to radius), or whose geometry is seen end-on in the view
  (`notMeasurableInView`), is flagged. It is never re-laid out silently.

### 3.7 Tables (D3)

- **`partProperties`**:
  - columns: part number, description, material, mass, configuration;
  - rows: `{ kind: 'drawing' }`, or `{ kind: 'configurations', configurations: (Id | null)[] }`,
    one row per configuration for tabulated drawings;
  - values come from the resolved configuration;
  - mass needs that configuration's background build, and shows "building…" until it has one.
- **`holeTable`** (on demand):
  - `viewId`, `origin: AnchoredPoint`, `holes: 'all' | featureIds`;
  - rows are derived per instance: tag, X, Y, size from the callout;
  - tags (A1, A2…) come in a deterministic order (feature id, then instance order) and are drawn
    at each hole.
- **BOM:** M6.

### 3.8 Sheet notes, centre marks, markup (D8)

- **`SheetNote`** is free text on a sheet, with `{slot}` tokens.
- **`CenterMark`** is a manual centre mark, centre line or bolt circle with refs. Automatic ones
  come from `ViewDisplay`.
- **`Markup`** is review markup (D8, recommended below): strokes in sheet mm, pinned to
  `versionId`, with author, time, optional text, an anchor to a placement or view, and
  `resolved`. It is never exported or released.

---

## 4. Derived data and the workers (§E)

Nothing in this section is stored. Caches go to `.wren/` (PLAN §8A.1), keyed by value.

1. **Annotation resolution** (kernel-client, in the kernel worker, §2.7).
2. **Shape hand-off.** HLR runs in a separate worker with a trimmed HLR build (PLAN §3). A new call,
   `ModelingApi.shapeForDrawing(partId, slot)`, returns a `ShapeForDrawing`:
   - `key`: ADR-079 value key;
   - `brep`: bytes, transferred;
   - `edgeNames` and `faceNames` in `TopExp::MapShapes` order;
   - `bounds`.

   The drawing worker loads it once per key (`loadShape`, `hasShape`), so its curves carry
   persistent names, and a pick on a drawing becomes an `EntityRef` without a round trip. The
   slot is the view configuration's (`main` when it is the active one, otherwise `config:<id>`,
   ADR-079).
3. **Projection.** `DrawingKernelApi.project(ViewProjectionRequest)` returns `ViewProjection`:
   - curves: role visible or hidden; class sharp, smooth, outline or sewn; the edge name; an
     exact `Curve2` (line, arc, ellipse, B-spline) or a polyline;
   - section faces: their loops, for hatching in the worker (T12);
   - bounds.

   `quality: 'draft'` is `HLRBRep_PolyAlgo`, shown first. `'exact'` is `HLRBRep_Algo`, used for
   export and once idle. Exact curves matter for DXF: R2000 keeps splines, and the R12 profile
   flattens them within tolerance.
4. **Semantic checks** (packages/document, pure): `annotationIssues(doc, partId, annotation,
   standard)` returns `AnnotationIssue[]`. The drawing package merges these with the resolutions
   and placement checks into the needs-attention panel.
5. **Layout and formatting: one code path.** Tolerance, fit and GD&T formatting, the symbol
   library, and text and leader layout live in packages/drawing under a DOM-free, worker-safe
   subpath (`@wren-cad/drawing/annotation`). M5's 3D display and its presentation PMI
   tessellation import that subpath without loading the drawing UI.

---

## 5. Mergeability (sync `DocMerger`)

**Collections** (`merge/tree.ts` `COLLECTIONS`):

```
remove  ['parts','*','features','*','annotations']
add     ['parts','*','annotations']                       unordered (sorted by id)
        ['drawings','*','sheets']                         ordered (sheet numbering)
        ['drawings','*','views'] ['drawings','*','placements'] ['drawings','*','centerMarks']
        ['drawings','*','tables'] ['drawings','*','notes'] ['drawings','*','markup']   unordered
```

**Unordered collections never produce `order` conflicts.** The merger writes them sorted by id,
the same treatment as folders. All other existing rules hold:

- leaf-level merge of fields;
- a change of discriminant (`kind`) replaces the object whole: a tolerance kind, a layout kind, a
  view kind;
- `EntityRef`s, `refs`, `at`, `cut` and `datums` arrays merge as whole leaves. Two sides editing
  the same section line conflict, which is right.

| Situation | Result |
|---|---|
| Different annotations, or different fields of one annotation | clean |
| Same annotation field (e.g. `/tolerance/upper`) on both sides | `bothModified` conflict |
| One side moves a view, the other switches projection | clean (relative layout) |
| One side moves a view to sheet 2, the other edits its scale | clean (`sheetId` is one leaf) |
| One side deletes annotation X; the other side's placements of X are unchanged | removed with X, note `placementRemovedWithAnnotation` |
| One side deletes X; the other adds or edits a placement of X, or edits X | `modifiedDeleted` conflict on X, listing the dependents |
| One side deletes a view; the other adds or edits placements, marks or children in it | `modifiedDeleted` conflict on the view |
| Overrides of a deleted annotation | removed with it, note `overrideRemovedWithAnnotation` (ADR-074 kind 1) |
| Both sides place the same annotation in the same view (two ids) | keep the smaller id, note `duplicatePlacementDropped` |
| Both sides add a datum `B` | both kept, `duplicateDatumLabel` flagged (frames bind by id, so nothing becomes ambiguous) |
| Both sides promote the same driving dimension | both kept, flagged `duplicatePromotion`; the panel offers "Merge duplicates" (one step: placements moved to one, the other removed) |
| Both sides reorder sheets differently | `order` conflict |

**The dependent-edit rule.** A deletion against new or changed dependents conflicts. Unchanged
dependents go with the deleted item, with a note. This generalises ADR-074's "delete against edit
conflicts". After every merge, `normalizeDrawings` (packages/document, deterministic) restores the
invariants in §7 and returns the notes. `DiffSubject` gains `annotation`, `sheet`, `view`,
`placement`, `drawingTable`, `sheetNote` and `markup` (§F), with `drawingId`. The drawing diff
(PLAN §8A.3, item 4) highlights changed annotation values and placements.

**Determinism:**

- canonical JSON (sorted keys) plus id-sorted collections;
- sheet numbers rounded to 0.001 mm;
- no derived data;
- the migration mints no ids.

The same document therefore always writes the same bytes, and pre-v4 bases merge cleanly
against v4 sides once all three are migrated.

---

## 6. Commands (§D; each one undo step)

**Annotations:**

- `addAnnotation { partId, annotation, place? }`: a dimension drawn on a view, created together
  with its placement.
- `updateAnnotation`: whole replacement.
- `removeAnnotation { annotationIds }`. It also removes:
  - placements in every drawing;
  - configuration overrides;
  - nothing else silently: frames bound to a removed datum keep its letter as `{ label }`, and an
    `appliesTo` that pointed at a removed dimension stays. Both show as needs attention.
- `reattachAnnotation { refs, at? }`.
- Overrides use `setConfigurationOverrides` with the new `annotationField` and
  `annotationSuppressed` targets.

**Drawings:**

- `setDrawingDefaults` (D10).
- `addDrawing`, `updateDrawing { changes }`, `moveDrawing`.
- `removeDrawing { annotations: 'removeOwn' | 'keep' }`. The default `removeOwn` also removes
  annotations whose origin is this drawing and that no other drawing places.
- `duplicateDrawing { newDrawingId, name, configurationId, ids }`: "duplicate for configuration".
  `ids` maps every sheet, view, placement, mark, table and note id to a fresh ULID; the store fails
  if one is missing or taken. Annotations are shared, not copied. Markup is not copied. A helper,
  `planDuplicateDrawing`, builds the map.
- `applyTemplate { template, formats? }`: re-apply or switch.
- `setTitleBlockFields { sheetId?, fields }`.

**Sheets and views:**

- `addSheet`, `updateSheet`, `removeSheet` (removes its contents), `moveSheet`.
- `addView`, `updateView`: whole replacement. Drags share a `coalesceKey`. It covers moving,
  scaling, display, cut-line edits and re-orienting.
- `removeViews { dependents: 'remove' | 'detach' }`. `detach` turns children into base views with
  the same resolved orientation and position. There is no confirmation dialog; a toast with Undo
  names the dependent views.

**Placements and the rest:**

- `placeAnnotations { items, allowDuplicate? }`: import model annotations as one batch. Items
  either place existing annotations or create promoted ones in the same step.
- `updatePlacements`, `removePlacements`: hide from views; the annotation stays.
- `addCenterMark`, `removeCenterMarks`.
- `addTable`, `updateTable`, `removeTable`.
- `addSheetNote`, `updateSheetNote`, `removeSheetNote`.
- `addMarkup`, `setMarkupResolved`, `removeMarkup`.

**Delete on the sheet.** For a drawing-origin annotation placed nowhere else, Delete is
`removeAnnotation`. For a model annotation, Delete is `removePlacements`: it is hidden from the
view and stays in the part. The UI decides; the commands are explicit.

**Import model annotations** (feature 13, T6, T7) is deterministic and previewed:

1. **Candidates per view:**
   - existing part annotations not yet placed in this drawing (checked by default);
   - driving sketch and feature dimensions that can be promoted (§2.3; tolerance-bearing ones
     checked, the rest unchecked).
2. **View choice.** Each candidate goes to the view where it is seen true length:
   - linear: |direction · view normal| < 1e-6;
   - diameter and callouts: the circle seen face-on.

   Ties are broken by visible (not hidden) refs, then the longer projected length, then base
   before projected, then view id.
3. **Never twice per drawing.**
4. **Lanes.** Shortest nearest the outline, per side; text overlaps resolved by moving outward.
5. **Commit:** one `placeAnnotations`.

---

## 7. Migration v3 → v4 (packages/document `migrations.ts`)

`SCHEMA_VERSION` 3 → 4. This is not additive: annotations move and override keys change. A v3
reader opening a v4 file says "update Wren".

```ts
{ from: 3, to: 4,
  description: 'M4: feature annotations move to Part.annotations (ids kept); their configuration '
             + 'overrides are re-keyed by annotation id; empty drawing placeholders are removed.',
  migrate(doc) {
    for (const part of doc.parts) {
      const byFeature = new Map<Id, Id[]>();           // featureId → annotation ids by old index
      const moved: Annotation[] = [];
      for (const f of part.features) {
        const anns = f.annotations ?? [];
        byFeature.set(f.id, anns.map(a => a.id));
        for (const a of anns) moved.push(convertPmi(a));  // throws on an unknown characteristic
        delete f.annotations;
      }
      bindDatumLabels(moved);   // { label } → { datum: id } when exactly one datumFeature has it
      if (moved.length) part.annotations = sortById(moved);

      for (const c of part.configurations ?? []) {
        for (const [fid, ov] of Object.entries(c.features ?? {})) {
          for (const [ptr, v] of Object.entries(ov.fields ?? {})) {
            const m = /^\/annotations\/(\d+)(\/.*)$/.exec(ptr);
            if (!m) continue;
            const annId = byFeature.get(fid)?.[Number(m[1])];
            const ann = annId && moved.find(a => a.id === annId);
            const to = ann && mapPointer(ann, m[2]);  // see table below
            if (!to) continue;        // kept where it is: resolveConfiguration reports it
                                      // (ADR-074 kind 2: target exists, path no longer fits)
            ((c.annotations ??= {})[annId] ??= {}).fields ??= {};
            c.annotations[annId].fields[to] = v;
            delete ov.fields[ptr];
          }
          pruneEmpty(ov, c.features, fid);
        }
      }
    }
    // v3 drawings are placeholders { id, name }. No Wren build ever wrote one (factory.ts writes
    // `drawings: []`); there is no part, standard or projection to recover, and inventing them
    // would be a guess. They are removed and reported (MigrateResult.notes, below).
    notes.push(...doc.drawings.filter(isPlaceholder).map(d => `Removed empty drawing ‘${d.name}’`));
    doc.drawings = doc.drawings.filter(d => !isPlaceholder(d));
    return doc;
  } }
```

`convertPmi(a)` maps the v3 `PmiAnnotation` with nothing lost:

| v3 | v4 |
|---|---|
| `id`, `refs` | same (ids preserved) |
| `kind: linear / diameter / radius / angle` | same kind; `value` → `nominal`; no `direction` (linear without one = natural separation) |
| `kind: datum` | `datumFeature`; `label` = `value` if it is 1–3 capital letters, else `''` (flagged "datum letter missing") |
| `kind: geomTolerance` | `geometricTolerance`. `gdt.characteristic` is mapped case-insensitively by name or symbol (⌖ → position …); an unknown value fails the migration with the annotation named (never a guess). `gdt.zone` → `zone.value`; `gdt.modifiers` mapped (`M`/`Ⓜ` → `material: 'mmc'` …, unknown → fail); `gdt.datums` letters → one compartment each, `{ label }`, then bound by `bindDatumLabels` |
| `tolerance` | `symmetric { value: upper ?? lower }`; `bilateral` / `limits { upper ?? '0 mm', lower ?? '0 mm' }`; `fit { fit }` split on `/` into `hole` / `shaft`, `show: 'symbol'` (unparseable → fail) |
| `placement` | `modelPlacement` verbatim (M5 reserve) |
| — | `origin: { kind: 'model' }`; `standard` absent ("not stated") |

`mapPointer` for overrides:

| v3 override path | v4 path |
|---|---|
| `/value` | `/nominal` |
| `/tolerance/upper` | `/tolerance/value` (symmetric) or `/tolerance/upper` |
| `/tolerance/lower` | `/tolerance/lower` |
| `/gdt/zone` | `/zone/value` |
| anything else | not mapped: kept and reported |

Other changes that ship with the migration:

- `MigrateResult` (a packages/document type, not a contract) gains `notes?: string[]`.
  `DocumentStore.load` passes them on, and the app shows them once.
- `exprFields(feature)` no longer includes annotations. A new `annotationExprFields(annotation)`
  gives the expected dimensions:
  - `/nominal` and `/tolerance/*` (angle for `angle`, length otherwise);
  - `/zone/value`, `/zone/projected`, `/zone/unequal`, `/zone/perUnit/*`;
  - `/requirements/<i>/value` and `/allowance`.
- `refsOf(feature)` drops annotation refs.
- kernel-client `helpers.ts`, `cause.ts`, `engine.ts` and `attribution.ts` drop their
  annotation filters.
- `apps/web` `param-usage.ts` lists annotation `Expr`s under the part, not the feature.
- Fixtures: a v3 file with feature annotations, overrides on `/annotations/1/tolerance/upper`, a
  datum and a frame bound by letter, an unknown characteristic (expected to fail), and a
  placeholder drawing. The tests assert ids are preserved, overrides re-keyed, nothing dropped
  without a note, and that migrating twice gives the same bytes. That last test covers the merge
  determinism.

---

## 8. Validation changes (packages/document `validateDoc`, JSON Schema, FILE_FORMAT §8)

There are two layers, as with folders:

- **Structure** always fails a load.
- **Dangling references** inside a drawing are repaired on load by `normalizeDrawings` (a git text
  merge can produce them), or reported as needs attention. They never fail a load.

```
ids: one document-wide id space now also covers annotations, drawings, sheets, views, placements,
     centre marks, tables, notes, markup.

part.annotations?: array of objects
  kind ∈ ANNOTATION_KINDS; origin ∈ {model | drawing{drawingId:string} | import{file:string}}
  refs: EntityRef[] (shape as features'); at?: RefPoint[] with at.length ≤ refs.length
  every annotationExprFields pointer holds a string
  dimensions: not (source && nominal); direction: finite Vec3 of length 1 ± 1e-9 (linear: optional,
    ordinate: required); source ∈ {sketchDimension | featureField (path is a JSON pointer) | feature}
  tolerance: kind ∈ {symmetric, bilateral, limits, basic, reference, fit}; fit has hole or shaft,
    matching /^[A-Z]{1,2}(01|[1-9]|1[0-8])$/ and its lower-case form; show ∈ the three
  geometricTolerance: characteristic ∈ 15; datums.length ≤ 3; each compartment ≥ 1 DatumRef;
    zone.value string; modifiers ⊆ ZoneModifier; standard ∈ GpsStandard if present
  datumFeature: label string; surfaceFinish: process ∈ 3, requirements array
  holeCallout: source.kind === 'feature'
  -- semantic (issues, not errors): arity per §2.2, label pattern and uniqueness, one callout per
     feature, illegal-for-standard, source exists, appliesTo exists and is a dimension.

configurations[].annotations?: plain object; keys non-empty; values like FeatureOverride
  (suppressed?: boolean; fields?: pointer → string | finite number | boolean)
  -- stale keys (annotation deleted) are not errors: resolveConfiguration reports them (ADR-074).

drawingDefaults?: { standard: DrawingStandard; projection ∈ {first, third}; fields?: slot → string }

drawings[]:
  subject.kind === 'part', subject.partId string (missing part = needs attention, not an error)
  configurationId?: string (missing configuration = needs attention, not an error)
  standard.family ∈ {iso, asme}; gps ∈ GpsStandard and of the same family; surfaceFinish ∈ 3
  projection ∈ {first, third}; units === 'mm'
  style: every number finite and > 0 (precisions: integers 0–6); lineGroup ∈ LineGroupId
  template.id ∈ {iso-5457, asme-y14.1}; template.version positive integer ≤ the app's latest
  sheets: ≥ 1; format.size named or {width, height} > 0; orientation ∈ 2; scale string
  views[]: kind ∈ 5; sheetId string; kind-specific fields; layout kind allowed for the view kind;
    section.cut.length ≥ 2; detail.scale present, radius > 0; configurationId string | null
  placements[], centerMarks[], tables[], notes[], markup[]: shapes per §C
  -- normalizeDrawings (load and after merge; deterministic, reports notes):
     · placement whose view or annotation (in the subject part) is missing → dropped
       (only when the subject part exists; otherwise the drawing is left intact)
     · two placements with the same (viewId, annotationId) → keep the smaller id
     · view whose sheet is missing → moved to the first sheet, layout kept, noted
     · parent missing or a parent cycle → kept, needs attention, not rendered
     · centre marks / hole tables whose view is missing → dropped
     · unordered collections sorted by id
```

FILE_FORMAT changes:

- §4.3 part file: `annotations`.
- §4.4: the drawing file is the `Drawing` JSON.
- §4.1 manifest: `drawingDefaults`.
- §7: v4 history.
- §8: the rules above.
- `wren-drawing.schema.json` becomes real.

Markup stays inside the drawing file in M4 (Q4).

---

## 9. Decisions (for one ADR when the lead applies this)

1. Annotations are part-level, id-keyed and sorted by id. Provenance is `origin`. Drawings store
   placements, never copies.
2. All of an annotation's geometry is in `refs: EntityRef[]`, with a parallel `at: RefPoint[]`.
   One resolution and one reattach path for every kind.
3. A dimension's value is `source`, else `nominal`, else measured. The resolver never returns a
   value for an annotation that needs attention.
4. Datum references are ids, with an unbound `{ label }` form.
5. A standard is stamped per GD&T annotation and surface finish. Validation refuses illegal
   symbols with an explanation and never converts.
6. Configuration overrides of annotations are keyed by annotation id.
7. Suppression in a configuration, whether of the annotation itself or of its source or ref
   features, is shown as "not in this configuration", not as needs attention.
8. Drawing collections are flat with `sheetId` / `viewId`. Only sheets are ordered.
9. Projected and section views are stored relative to their parent (`aligned { distance }`), and
   the side derives from the projection.
10. The view centre is the projected 3D bounding box of the part.
11. Sheet mm everywhere, origin bottom-left and y up, plain numbers rounded to 0.001 mm. The style
    is stored in full, and the template version is pinned.
12. A missing configuration id is needs attention. `removeConfiguration` leaves consumers flagged.
13. The v3 → v4 migration mints no ids. It removes empty drawing placeholders with a note.
14. HLR runs in a drawing worker with names handed over (`ShapeForDrawing`). Draft output comes
    first, exact output follows.
15. Formatting and layout are one worker-safe module, `@wren-cad/drawing/annotation`, shared
    with M5.

---

## 10. Recommended owner decisions (to confirm)

- **D4, DXF writer: in-house, behind one `DxfWriter` interface, no new runtime dependency.**
  - The R12 CNC-safe profile has a tiny vocabulary: LINE, ARC, CIRCLE, POLYLINE, TEXT.
  - The R2000 profile adds:
    - handles;
    - the LAYER, LTYPE and STYLE tables, with ISO 128 dash lengths and `$LTSCALE = 1`;
    - lineweights;
    - `$INSUNITS = 4`;
    - LWPOLYLINE, ELLIPSE, SPLINE, exploded dimensions as LINE + SOLID arrowheads + TEXT, and
      HATCH.

  That is a few hundred lines with the four-layer CI the report proposes: goldens, an ezdxf audit,
  LibreCAD `dxf2pdf` and a manual QCAD check. `@tarikjabiri/dxf` (MIT) shows version
  disagreement between npm and jsDelivr and a last update in 2023. Revisit it only if the R2000
  audit work runs long. Build R12 first, then R2000.
- **D5, drawing font: Osifont, pinned and self-hosted, subset-embedded in the PDF**, if its
  licence checks out. FreeCAD ships it as `osifont-lgpl3fe.ttf`, which suggests LGPL-3 with a font
  exception. **Unverified**: confirm upstream before shipping, and record it in DEPENDENCIES with
  licence and size.
  - It is ISO 3098 lookalike lettering.
  - Ø, ± and ° come from the font.
  - ⌴, ⌵, ↧ and every GD&T symbol are drawn as **vector glyphs** from the shared symbol library,
    whatever the font has. DXF needs them exploded anyway, and M5's presentation PMI reuses
    them.
  - Fallback if the licence fails: Noto Sans (OFL-1.1) with the same vector symbols.
- **D7, PDF/A and per-role PDF layers: deferred.** M4 writes vector PDF 1.7:
  - the MediaBox equals the sheet;
  - mm → pt converted once (× 72/25.4);
  - embedded font subset;
  - `/ViewerPreferences << /PrintScaling /None /Enforce [/PrintScaling] >>` via a pdf-lib pass;
  - a 100 mm scale bar and the scale in the margin.

  Layers conflict with PDF/A-1, and neither jsPDF nor pdf-lib documents OCG or PDF/A support.
  Revisit for M7.
- **D8, markup: local-first `Drawing.markup` in the project**, pinned to a version, anchored to a
  placement or view where possible. Never exported or released. It merges as an append-mostly set.
  Comments and sharing stay P2 (Cloudflare). Q4 asks whether to write it to its own file.
- **D9, standards:** before freezing template, style and GD&T goldens, buy or borrow, in priority
  order:
  1. ISO 1101:2017 and ASME Y14.5-2018 (GD&T legality, modifiers);
  2. ISO 286-1/-2 (fit tables; licensing for transcription; the IT grades come from 286-1
     formulas, which avoids copying tables);
  3. ISO 129-1 (dimension presentation);
  4. ISO 5457 and ISO 7200 (frame, title block);
  5. ISO 128-2/-3 and ISO 3098 (lines, lettering);
  6. ISO 21920-1 (surface texture);
  7. ASME Y14.1, Y14.2, Y14.3 and Y14.36.

  Until then goldens are marked "provisional (secondary sources)".
- **D6 (recommended, recorded here):** drawing dimensions are read-only in M4. **D10:** an
  explicit choice at the first drawing, remembered in `drawingDefaults`.

---

## 11. Open questions for the lead

- **Q1 Composite and stacked frames.** Stacked frames are simply two annotations. Composite
  position or profile frames (ASME) need lower rows: `segments?: { zone, datums }[]`. Proposed
  for M4 P2: reject composites with a clear message until then.
- **Q2 Placeholder drawings.** Removing them with a note (§7) assumes no file in the wild has one.
  The alternative is optional `subject`, `standard` and `projection` with an inline setup state.
  That costs a guard in every consumer.
- **Q3 Revision on unreleased output.** Options: "Rev A + changes", "DRAFT" in `documentStatus`,
  or blank. Recommended: the last release name with a `*` and "Not released" in
  `documentStatus`.
- **Q4 Markup file.** Inside `drawings/<slug>.drawing.json` (simplest), or
  `drawings/<slug>.markup.json`, so review noise stays out of drawing diffs (recommended once
  markup ships).
- **Q5 Direction by reference.** Should `direction` also accept an `EntityRef` (an edge or axis),
  so it follows a re-oriented sketch plane? M4 uses `Vec3`; the change would be additive later.
- **Q6 Projection payload.** `Curve2` uses plain arrays (exact curves for DXF). If large parts
  break the budget, add a packed `Float64Array` form for polylines.
- **Q7 Custom title-block templates** (project files under `templates/`): P2. Is that acceptable
  for M4 given feature 3's "editable title-block templates" (PLAN §2.4)? Inline slot text covers
  the edits users report needing.

---

## 12. Work split once applied (parallel)

| Agent | Work | Depends on |
|---|---|---|
| lead | Apply §A–§F, `SCHEMA_VERSION = 4`, the ADR, FILE_FORMAT and JSON Schema | — |
| document | Migration and fixtures; `validateDoc` and `normalizeDrawings`; all §D commands; `annotationExprFields`; annotation overrides in `resolveConfiguration` and `CONFIGURABLE_OPTIONS`; `annotationIssues` rule tables (GD&T legality, ISO 286 data); `planDuplicateDrawing` | contracts |
| kernel / kernel-client | Annotation resolution after the walk (`RegenRequest.annotations`, anchors, measured values, hole instances); `shapeForDrawing`; drawing worker build with `loadShape` and `project` (PolyAlgo, Algo, section, clip, hatch loops) | contracts |
| sync | `COLLECTIONS`, the dependent-edit rule, notes, diff labels and the drawing diff | contracts, document (`normalizeDrawings`) |
| drawing | `@wren-cad/drawing/annotation` (format, tolerance parser, layout, symbols); templates generator; view frame derivation; placement layout; import planner; renderers (SVG editor model, PDF, DXF R12 then R2000); needs-attention aggregation | contracts (mocks for kernel results) |
| ui | Drawing route (lazy), view picker and drag-out projections, inline tolerance field, title-block inline edit, needs-attention panel, touch flows | drawing |

The tests map one-to-one to PLAN M4 "Accept" and the report's List 2 criteria:

- **Annotation core:** unit tests for resolved refs, for the M3.7 finding ("delete or reorder
  never retargets an override"), for a promoted dimension updating, and for the v3 migration.
- **Golden:** lanes and offsets are kept after a 10 % resize.
- **Projection:** switching it mirrors aligned views with no edits.
- **Merge:** a test of the table in §5.
- **Exports:** the PDF MediaBox, 283.46 pt per 100 mm, and line widths; DXF goldens.
