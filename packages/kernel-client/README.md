# @wren-cad/kernel-client

The kernel worker and its main-thread client (PLAN §4). The worker owns the OCCT Wasm kernel,
every B-rep shape, planegcs (for sketch re-solves) and the **regeneration engine**; the main thread
only ever holds shape ids and transferred render buffers.

| Entry                                         | What                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `@wren-cad/kernel-client`                      | `createKernelClient()` — spawns the worker, `api: Remote<ModelingWorkerApi>` |
| `@wren-cad/kernel-client/worker`               | worker entry (Comlink `expose`)                                          |
| `@wren-cad/kernel-client/kernel-api`           | `createKernelApi()` — low-level façade wrapper (Node tests)              |
| `@wren-cad/kernel-client/regen`                | `RegenEngine`, `resolveRef`, `planeFrame`, `hashKey` (pure parts testable) |
| `src/modeling-api.ts`                         | `createModelingApi()` — kernel + engine = the worker's Comlink surface    |

## Using it from the app

```ts
import { createKernelClient } from '@wren-cad/kernel-client';

const kernel = createKernelClient({ regen: { maxSpareResults: 4 } }); // tablet tier; default: auto (128+)
await kernel.ready();
let doc = bracketDoc;                                 // a WrenDoc from the document store
const partId = doc.parts[0].id;
let r = await kernel.api.regenerate({ doc, partId, quality: 'coarse' });
viewport.setBodies(r.bodies);                         // meshes arrive transferred, not copied
doc = structuredClone(doc);                           // (normally: a store command)
doc.params.find((p) => p.name === 'width')!.expr = '100 mm';
r = await kernel.api.regenerate({ doc, partId, quality: 'coarse' }); // only affected features rerun
if (r.revision >= shownRevision) viewport.setBodies(r.bodies);       // drop stale results
```

`r.features[i]` gives each feature's state (`ok`, `error`, `needsAttention` with `unresolved`,
`suppressed`, `rolledBack`, `blocked`), `cached`, `ms`, `warnings`, `rebound` (below) and, M3.5,
`cause` on the status and on each `unresolved[i]` (the upstream feature that broke it, see
"Error causes"). Shapes in `r.bodies` belong to the
engine: never `release()` them (the worker ignores such calls). `refFor(partId, {bodyId, kind,
index})` turns a pick (mesh face/edge ordinal = TopExp index) into an `EntityRef` with a
fingerprint to store in the document; `exportPart` / `importFile` / `closePart` complete the API.
`kernel.api.configureRegen({ maxSpareResults })` changes the cache budget at runtime (applies from
the next regen; `createKernelClient({ regen })` sends it before `init()`).

**Healing stored refs.** `FeatureStatus.rebound` lists every ref that resolved by fingerprint /
name-family evidence rather than by its exact stored name — `{path, name, fingerprint}` with the
**current** name and fingerprint — whenever the name changed or the stored fingerprint is out of
date. The app should write both back into the document (one undoable "heal" command), which keeps
later resolutions exact and the tolerance windows small. For an unresolved ref, the old location to
ghost is `unresolved[i].ref.fingerprint` (the stored ref, passed through unchanged); when the stored
ref has none, `unresolved[i].lastKnown` is where it resolved in the previous regen of this worker.

**Imports** (`ImportFeature`): pass the file bytes once in `RegenRequest.attachments[source.path]`;
the engine verifies their SHA-256 against `source.sha256` and caches the parsed file per part by
sha, so later regens (and placement edits) need no attachment. Without bytes or cache → `error`
"The imported file is missing from this project" (not cached, so the next request with the bytes
just works).

## Regeneration (`src/regen/engine.ts`)

**Modules (H1).** `engine.ts` keeps orchestration: the public API, the regen walk, one feature
(`runFeature`) and the per-type dispatch (`planFeature`); its public types live in `types.ts` and
are re-exported from `engine.ts` and `regen/index.ts`. The rest, by responsibility:

| Module | Holds |
| --- | --- |
| `core.ts` | `EngineCore`: the kernel, the lazy sketch solver, re-projection and the per-handle caches; the explicit context the executors take |
| `result-cache.ts` | `ResultCache`: per-part, per-slot feature-result entries, LRU eviction, version slots |
| `state.ts` | Internal state: model state, cache entries, walk context, plans |
| `refs.ts` | Reference resolution against the walk state (PLAN §7.3), plane/axis/point refs, body scopes |
| `attribution.ts` | `AttentionCause` attribution and field labels |
| `outputs.ts` | Body and sketch results |
| `helpers.ts` | Errors, cache-key definitions, taint scopes, the open-surface guard |
| `exec-sketch.ts` | Sketches and the linked-entity (projection) pipeline |
| `exec-solids.ts` | Extrude, revolve, primitive, sweep, loft and their tool solids |
| `exec-modify.ts` | Fillet / chamfer, boolean, push/pull, shell, draft |
| `exec-copies.ts` | Mirror and patterns |
| `exec-holes.ts` | Holes and cosmetic threads |
| `exec-datums.ts` | Construction planes, axes and points |
| `exec-import.ts` | STEP/IGES/BREP and mesh imports |

The engine walks `part.features` up to `rollbackIndex` keeping an ordered **body table**
(`B<featureId>` → shape), the solved sketches and the construction planes. For each feature:

1. a feature that references a failed feature (by name tag `F<id>:`, `S<id>:`, `B<id>`) is
   `blocked`;
2. its `Expr`s are evaluated (`evaluateFeatureValues`); errors become `error` with the field
   label (`Depth: Unknown parameter ‘detph’ …`) and the pointer list in `detail`;
3. its references are resolved (below) against the **current** state; unresolved → `needsAttention`
   with `UnresolvedRef{path, ref, reason, candidates}`; references to (or scopes over) a body that
   an earlier failed feature would have changed → `blocked`;
4. the cache key is computed; a hit applies the cached delta (`cached: true`), a miss runs the kernel.

A failing feature is skipped: the state keeps the geometry from before it, so earlier bodies are
always output. In addition `RegenOutput.ghosts` carries the bodies of the last regen in which every
feature was ok (only those whose geometry differs now), for the PLAN §9.2 ghost display.

**Sketches** are re-solved with planegcs (`@wren-cad/sketch/core`) from the stored positions with the
evaluated driving dimensions; a sketch that doesn't solve is an `error` with the solver's conflict
explanation and first suggested fix as `hint`. **Sketch planes**: `origin:XY|XZ|YZ` are fixed frames
(XZ: normal −Y, v up; YZ: normal +X, v up); a plane feature (`F<id>:plane`) uses its frame; a planar
face uses `planeFrame(centroid, normal)`: origin = world origin projected onto the plane, x = Z × n
(normalised) for non-horizontal planes, else world X projected into the plane. It depends only on
the plane, so a sketch neither slides nor spins when upstream edits resize, notch or split its face.
Offset planes from faces use the same frame.

**Bodies.** `new` creates `B<featureId>`. `add | cut | intersect` with the default scope act on every
body the tool touches: the tool is built alone (op `new`) and bounding boxes prefilter the
candidates (through-all cuts skip the prefilter); cut results that leave a body unchanged (same
volume and face/edge counts) are discarded so that body keeps its shape and cache; `add` fuses all
candidates into the oldest one's id; `add` that touches nothing creates a new body (warning).
`{kind:'all'}` and explicit `{kind:'bodies'}` scopes pass exactly those bodies. Fillet/chamfer run
once per body owning the selected edges; `boolean` updates the target and consumes the tools unless
`keepTools`.

**Cache.** Key = hash(feature definition minus name/suppressed/annotations, evaluated values,
resolved refs as (input content key, kind, index), frames, content keys of the scope bodies).
Content keys chain through results, so editing feature k invalidates k and whatever consumes its
output — e.g. a sketch on a face only depends on that face's plane and stays cached when the body
under it changes. Entries own the handles they create and hold deltas only; after each regen, all
entries not used by it (or by the last all-ok regen) beyond `maxSpareResults` are evicted LRU and
their handles released. The default is 128, or three times the latest regen's entries when that is
more (three earlier full states of a large part, so undoing early edits stays a cache hit), until
the Wasm heap passes 1.5 GiB; a configured value (tablet 4, phone 2) is a hard bound (ADR-084).
Meshes, fingerprints, bounds and mass properties are cached per handle. Results carry fresh copies
of cached meshes, transferred over Comlink.

**Mass properties** (ADR-084) are a full volume and area integration (seconds for a few hundred
B-spline faces), so a regen only computes them for its final bodies, and only on request or with a
material (`RegenRequest.massProperties`: omitted = the part has a material, `false` = never). Bounding-box prefilters, the through-all depth of copied
cuts and the "the cut left the body unchanged" check read `bounds` (the façade's same box and
topology counts, nothing integrated); that check integrates only when face and edge counts and the
box all agree. `massProperties(shape)` on a regen-owned handle is served from the same per-handle
cache, serialised with regens, so the app can fetch them after the geometry is on screen.

Viewport meshing (`MESH_QUALITY`, relative to each shape's bbox): coarse 0.4 % / 0.5 rad, fine
0.06 % / 0.25 rad.

**Push/pull** (`PushPullFeature`, M2). The `/faces/i` refs resolve like any face refs: by name,
then by fingerprint, else `needsAttention`. They must all be faces of one solid body, otherwise
the feature is an `error` before the kernel runs. The kernel moves the faces (ADR-013) and returns
the same body id, so features downstream keep resolving:
- moved faces keep their names;
- walls are `F<pp>:side(<edge name>)`;
- walls coplanar with an old face merge into it, under the old face's name;
- a face swallowed by the move disappears. A ref to it becomes `needsAttention`, never a guess.

Kernel failures surface as the feature's `error`:
- `UNSUPPORTED_FEATURE` for curved faces, with the selection number in the message and the face
  in `entityRefs`;
- `OPERATION_FAILED` "… removes the whole body".

The body keeps its pre-feature geometry, and later features on it are `blocked`.

**Measure** (M2). `measure(partId, a, b?)` measures on the latest regen. A `{bodyId, kind, index}`
target resolves like `refFor`: the body by `BodyResult` id, and `index` = the mesh face/edge
ordinal (TopExp index) or the TopExp vertex index. `{point}` targets are world points. Errors:
- `INVALID_INPUT` if the part has not been regenerated, or for a non-finite point;
- `UNRESOLVED_REFERENCE` for an unknown body or an index out of range;
- `INVALID_INPUT` for a mesh reference body.

The kernel computes the values exactly (BRepExtrema/GProp); the `KernelLowLevelApi.measureShapes`
call takes shape handles directly.

**Regen slots** (M2.5, ADR-020 item 8). `RegenRequest.slot` is `'main'` (the default, the live
model) or `version:<id>`. Every `(partId, slot)` pair has its own result cache, latest state,
last-good ghosts, import cache and revision counter. Regenerating a version therefore never
changes main's result, revision, cache hits or shapes. `refFor`, `measure` and `exportPart` always
use `'main'`, so the live selection never points into a version.

- A part keeps at most `maxVersionSlots` version slots (default 2, minimum 1). When there are more,
  the least recently used one is released with all its shapes; `regenerate` and `compare` count as
  use.
- `configureRegen({ maxVersionSlots })` lowers the cap at once. Each slot's cache is bounded by the
  same `maxSpareResults` tier.
- `closePart(partId)` closes every slot; `closePart(partId, slot)` closes only that one.
- A malformed slot rejects `regenerate` with a `TypeError`.

**Compare** (`src/regen/compare.ts`). `compare(partId, a, b, quality)` returns
`Result<CompareOutput>`, which is `GeometricDiff` plus `warnings?`. It composes existing façade
calls only:

1. Each side is the solid bodies of its slot's latest regen. If there are several, they are fused
   with `execFeature({type:'boolean', op:'add'})`.
2. B − A (added) and A − B (removed) are `boolean` cuts.
3. Each non-empty difference is meshed at `quality` (one `MeshBuffers` per difference; it can hold
   several disjoint regions) and measured with `massProperties`.

Details:

- Each side's `mass` is the union's `MassProperties`, using that slot's material density. `bbox`
  is its exact bounding box. A side with no bodies has zero mass and a zero box.
- If both sides have the same body content keys, the geometry is identical, so the result is an
  empty diff and no booleans run.
- A difference with no faces, or with a volume at most 1e-9 of the larger side, is empty: `[]`
  and volume 0, never an error.
- Mesh-only reference bodies and bodies without volume are left out, with a warning.
- Errors are `KernelError`s with user-facing messages and the raw cause in `detail`:
  - `INVALID_INPUT` for a slot that was never regenerated or has been evicted ("Version 3 has not
    been regenerated"), a malformed slot, or a bad quality;
  - `OPERATION_FAILED` for a failed fuse or cut, naming both sides.
- Every temporary shape is released, also on failure. The diff meshes are transferred over
  Comlink, never copied.

## M3 features (ADR-019; details in ADR-036)

What the engine passes per type (FeatureInputs, refs keyed by JSON pointer into the feature):

| Type | Inputs |
| --- | --- |
| `shell` | `target` (the open faces' body, or `body`), `refs['/openFaces/i']`, `values['/thickness']` |
| `draft` | `target`, `refs['/faces/i']`, `frames.neutral` (+ `refs['/neutral']` for faces/plane shapes), `values['/angle']` |
| `sweep` | `refs['/profile/i']`, `refs['/path/i']` chained in order (the feature's `path` is reordered to match), op/scope as extrude |
| `loft` | `refs['/sections/i']` (regions/faces; points only first/last), `refs['/guides/i']`, op/scope as extrude |
| `mirror` / `linearPattern` / `circularPattern` | `shapes['tool:<id>']` + `values['/ops/<id>']` (0 add, 1 cut, 2 intersect) and `target`, or `refs['/source/bodies/i']`; `frames.plane` / `frames.axis` (+ `frames.second`); counts as whole numbers |
| `hole` | `target`, `frames['hole:i']` (origin on the face, z into the material), table values at `/diameter`, `/counterbore/*`, `/countersink/*` |
| `thread` | none (checked: cylindrical face, size in the table) |
| `axis` / `point` | no kernel call: frames in the walk state (`F…:axis`, `F…:point`) |
| `plane` (new kinds) | `{ kind: 'frame' }` with the TypeScript-computed frame; `flip` applied by the engine |

- **Tool shapes** of copied features are built lazily (the feature alone, op `new`; a hole without
  `target`) and cached under a key of their own inputs, so pattern edits reuse them.
- **Reference geometry** comes from fingerprints plus exact `measureShapes` probes (`datums.ts`):
  edge lines, circles, cylinder axes, sphere centres, in canonical senses.
- **Linked sketch entities** (`EntityBase.source`): resolved and projected (`linked.ts`; kernel
  `projectEdges` / `projectFaceOutline` when present), re-projected by `RegenEngineDeps.reprojectLinked`
  (default `reprojectLinkedFallback` until packages/sketch's lands) and grounded before solving. A
  lost source makes the sketch `needsAttention` at `/entities/i/source/ref`, entity names in
  `error.entityRefs`.
- **Pattern instances** `F…:inst<k>(N)` never resolve by fingerprint onto another instance or onto
  the original's copies; a removed instance needs attention.
- **Hole sizes**: `resolveHoleSize` from `@wren-cad/document` (ISO 273 / 262 / 4762 / 10642, ANSI
  inch), explicit values override.

Tests: `m3-engine.test.ts` (fake kernel: inputs per type, tool cache, instance naming, linked
entities), `m3-geometry.test.ts` (probes, frames, chaining, re-projection), `m3-reference.test.ts`
(real kernel now: convert entities follow and get lost, cylinder-axis revolve, three-point / mid /
flipped planes), `m3.golden.test.ts` (real kernel with the M3 façade, skipped by a feature check
until then: pattern of holes, mirrored boss and shell after fillet edit-upstream, sweep and loft).

## Error causes (`src/regen/cause.ts`, M3.5, ADR-046)

`UnresolvedRef.cause` and `FeatureStatus.cause` (`AttentionCause {featureId, kind, detail?}`) name
the upstream feature whose change broke a reference or a feature, so the UI can say "Fillet 2 lost
its edge because Extrude 1 changed (depth 10 mm → 4 mm)" and select Extrude 1. A cause is set only
when the engine can tell; otherwise it is absent (never a guess).

Every regen records a **walk** per slot: for each feature its position, state, canonical
definition and evaluated values, cache key, `deps` (the features whose output it read: name tags
of its references, copied features, and the last writers of the bodies it acts on or whose keys
it hashes), the containers it set (bodies, sketch, plane, datum, with their naming maps) and its
unresolved refs with causes. The previous walk of the same slot is the history. Rules for an
unresolved ref of feature C with stored name N (first match wins):

1. **Structural** — the feature tags recorded in N (`F<id>:`, `S<id>:`, `B<id>`; the outermost
   producer of each top-level component first, then inner tags): a tagged feature that is gone →
   `deleted`; suppressed → `suppressed`; now after C → `reordered`; failed this regen → `failed`.
   N cannot exist unless each of them ran before C. Needs no history.
2. **This regen's change** — only if the same stored ref (same path, same name) resolved in the
   previous regen. The *touchers* of N are the features before C whose result set or removed a
   container holding N's name family, plus the producer (the latest outermost tag). From the
   nearest toucher back:
   - its own definition or values changed, or it is new, unsuppressed or moved above C →
     `changed` with `detail` (the first changed value as "depth 10 mm → 4 mm", sketch dimensions
     by kind, "horizontal distance 30 mm → 200 mm", never a constraint id; else "profile changed",
     "added", "unsuppressed", "moved", …);
   - its cache key changed only through its inputs → the **nearest change in its dependency
     chain**: breadth-first over `deps`, expanding only features whose keys changed; the first
     level with a changed (or removed: deleted / suppressed / moved below C) feature decides. One
     such feature → it; two or more at that distance → no cause;
   - its key is unchanged (identical output) → the next older toucher.
   Fallback: exactly one feature upstream of C changed, was added or was removed since the last
   regen → that one (regeneration is deterministic, so nothing else can have broken N).
3. **Carried over** — a ref already unresolved in the previous regen, with the same stored ref,
   keeps its cause while the cause still holds (the feature still exists upstream of C; or is
   still deleted / suppressed / after C). So the message survives unrelated edits and undo
   stacks; it disappears when the ref resolves again. The contract's "changed this regen" means
   "changed since the ref last resolved".

Feature-level causes: `needsAttention` = the first unresolved ref's cause; `error` = rule 2 with
the feature itself as the toucher (only when it ran ok last regen and its own definition and
values are unchanged — an edit to the feature itself is not an upstream cause), else rule 3;
`blocked` = `{ kind: 'failed' }` on the feature it waits on: for a reference into failed
features the referenced one that failed itself (`error`/`needsAttention`), else the first; for a
tainted body the feature that failed first on that body. A blocked feature's cause may itself be
blocked; follow `cause.featureId` → that feature's `cause` to the root.

Examples (tests): shortening the plate so a 6 mm pocket goes through → the fillet on the pocket
floor and a sketch converted from that edge get `{E1, changed, "depth 10 mm → 4 mm"}` (the pocket
is the producer but unchanged; its input changed); deepening the pocket itself → the pocket;
a chamfer inserted on the edge → `{chamfer, changed, "added"}`; plate thinner **and** pocket moved
in one regen → no cause; a fresh worker opening a broken document → no `changed` cause.

Cost: one canonical-JSON snapshot of each definition per regen (≈ 20 µs per feature on the fake
kernel bench, 60 features ≈ 1.3 ms); causes themselves are computed only for failing features.

## M3.5 sketch curves (`src/regen/curves.ts`, ADR-046)

- **Display sampling** (`sampleEntity`): elliptic arcs are exact points uniform in the
  parametric angle, with the step a circle of the major radius gets at the sketch's chord
  tolerance (an ellipse's sagitta is at most a·Δt²/8), counter-clockwise from `start` to `end`,
  ends snapped to the stored points. B-splines are exact de Boor points (homogeneous when
  `weights` differ): four steps per non-empty knot span (one for degree 1), chords halved while
  the middle or quarter points deviate more than 0.9 × the tolerance (≤ 10 levels, ≤ 4096
  samples); knots are always samples; periodic splines close exactly. An invalid definition shows
  its control polygon (the kernel reports why).
- **Knots** (shared with the kernel and sketch workstreams, ADR-048, "M3.5 regen of the new
  curves"): `knots` are distinct values and `multiplicities` theirs (OCCT); omitted = clamped
  `i/(n−p)` with end multiplicity p+1, or periodic `i/n` all 1, domain [0, 1]; periodic flat
  knots as `BSplCLib::KnotSequence`.
- **Pass-through**: the solver result goes to the kernel `sketch` feature unchanged (planegcs
  passes `ellipticArc` / `bspline` through, poles are ordinary points); linked ones are fixed
  (centre, ends, poles).
- **Linked (convert)**: another sketch's ellipse / elliptic arc on a parallel plane projects to an
  exact `ellipse` / `ellipticArc` curve (rigid map; facing planes reverse the arc); a spline
  projects exactly onto any plane that does not see it edge-on (orthographic projection is
  affine; B-splines, rational too, are affine invariant). Otherwise the kernel's projection is
  used (a `polyline`, `approximate: true`). The engine's fallback re-projects these kinds in
  place (same ids; a spline whose source has another pole count or periodicity is lost, never
  refitted); `ProjectedCurve` here accepts them from the kernel's `projectEdges` too.

## Imports (`src/regen/imports.ts`, `planImport` in the engine)

- **STEP / IGES / BREP** → `kernel.importShapes` (STEP/BREP: one shape per solid; IGES: solids,
  loose faces sewn, closed shells made solids, open shells kept as shell bodies). The raw, unplaced
  and unnamed shapes are cached per part by sha256 (attachments used by the latest regen plus 8
  spare, LRU); `closePart` releases them.
- **Placement and naming** in the kernel's `import` feature (ADR-039 item 11, M3): the engine
  validates the `frame` (mm; default identity; x orthogonalised against z, degenerate frames are an
  `error`) and passes the orthonormal frame with the raw shapes as `shapes["source:<k>"]` (file
  order). The kernel moves them (a shared-geometry location, exact, no re-import) and names every
  face `F<id>:face#k` (k = geometric key: centroid x, then y, then z, rounded 1e-6 mm, per body),
  edges `edge(F<id>:face#i|F<id>:face#j)` and vertices `vertex(…)` from their adjacent faces. The
  kernel's shape records carry these names, so downstream fillets, chamfers and booleans keep
  naming by history (`F<fillet>:fillet(edge(F<id>:face#i|…))`). These are exactly the names of the
  M1 workaround it replaces (a BREP location rewrite plus a no-op intersect with an enclosing box,
  whose `F<id>:face:unnamed` names the engine translated): `import-naming.test.ts` checks every face,
  edge and vertex name and body id against a golden recorded with the M1 engine.
- **Open surfaces** (an IGES surface model that does not close, loose faces): a body with a free
  edge `edge(F<id>:face#k)` (degenerate edges such as sphere poles excepted, by their fingerprint)
  gets an `OPERATION_FAILED` warning on `new` (its "volume" means
  nothing) and is refused as an add/cut/intersect tool (`INVALID_INPUT`), never passed off as a
  solid.
- **Bodies**: one solid → `B<id>`; several → `B<id>#k` ordered by the geometric key of their volume
  centroids. Faces are numbered per body (as the kernel does for every body).
- **Ops** `add | cut | intersect` (B-rep only) use the scope rules of other solid features (bbox
  prefilter for the default scope); the placed, named bodies from the kernel `import` (run as
  `new`) are the tools of a kernel `boolean` per target, so their faces are boolean tool faces
  `F<id>:face(F<id>:face#k)` (naming.ts boolean rule, the same names the kernel `import` op gives).
  `add` merges into the oldest touched body only (warning when it touches more); the kernel's own
  `import` add would fuse every scoped body into one, so the engine keeps the per-target booleans.
- **Mesh formats** (STL/OBJ/3MF/GLB) → `@wren-cad/io` `importMesh`, placed in TS, handed to the kernel
  as STL: one mesh-only body per object (`B<id>` / `B<id>#k`), one face `F<id>:face`, no edges.
  Displayed, exported (STL/STEP of a mesh face), with mesh-based mass properties; never part of an
  implicit scope; explicit scopes, booleans, fillets/chamfers and push/pull on them → `error`
  "A mesh reference body cannot be …". `op` other than `new` for a mesh file → `error`.

## Reference resolution (`src/regen/resolve.ts`, PLAN §7.3)

`diag` is the diagonal of the part's current bounding box (body vertices and face centroids; sketch
geometry when there are no bodies). The **family** of a name is the name with every `#k` removed
(`edge(F:end#0|…)` and `edge(F:end|…)` are one family). Final rule:

0. **Merged name** (ADR-078). Body naming maps list, after their primary names, the names a
   boolean merged away (an alias entry with the same kind and index as the surviving sub-shape);
   aliases are never candidates themselves. The engine collects them per walk
   (`ModelState.merged`, absorbed → survivor), because the kernel lists them only on the merging
   feature's result. A ref whose exact name no body has, but which was merged, resolves to the
   survivor's name (nearest in the merge chain first; the ref's fingerprint is kept for a split
   survivor), `via: 'merged'`. It is reported in `FeatureStatus.merged` (`{path, name, into}`) and
   **not healed**: the stored name stays, so if an edit un-merges the faces the ref is back on its
   own face by exact name. Construction history, not a guess: an unrelated face is never picked.
   The survivor is looked up in its own name family only (never fingerprint-only), and a current
   primary name equal to the ref's always wins over an alias. A name the walk recorded with two
   different survivors (two features derived the same old name for different sub-shapes, e.g. a
   vertex name rebuilt from the same three face names), itself or along its chain, is
   **unresolved** (`ambiguous`, the survivors as candidates). `resolveWithMerges` (refs.ts) is
   this whole order; `merge-sweep.test.ts` checks it against every pre-ADR-078 name of six
   scenarios.
1. **Exact name**, exactly one match → resolved, except for a `#k` (or imported) name whose family
   has several members when the ref has a fingerprint: then disambiguation (2) runs first and a
   clear winner overrides the index. Without a clear winner the exact name stands only if it is
   still plausibly the same entity: within 0.25 × diag, normal agreeing, **and overlapping** the
   old location (centroid distance ≤ reach(ref) + reach(candidate) + 1e-3 × diag, reach = √area for
   faces, length/2 for edges, 0 for vertices). Otherwise unresolved (`ambiguous` with the family) —
   e.g. when the referenced piece vanished and `#k` now names another piece.
2. **Name family** (or duplicate exact names) → **fingerprint disambiguation**: the nearest member
   whose normal agrees (dot ≥ 0.95), within 0.25 × diag, and at most half the distance of **every**
   other member (≥ 1e-3 × diag closer) — members rejected for a flipped normal count as runners-up,
   so a nearer opposite-facing member makes it ambiguous instead of picking the other one.
   **Containment** (ADR-078 review): for names with history, the pick must also contain the ref's
   recorded location. A vertex must be at the same point. For an edge or face, the recorded
   centroid must lie on it, as close as the member's own centroid is (kernel point distance,
   1e-6 × diag), and a face must face the same way. So the nearest winner stands if it contains
   the location, else the one member that does is picked, else the ref is ambiguous. A stored ref
   to an old bottom edge piece is not moved across a notch to the nearer piece. Weak (imported)
   names keep the fingerprint rule. A rebound whose new name fails containment is not reported,
   so `heal.ts` never writes it.
   A lone surviving `X#j` for a ref `X#k` needs strict evidence (3); a lone unsuffixed `X` (pieces
   merged) is accepted.
3. **Fingerprint only**: centroid within 1e-3 × diag (≥ 1e-6 mm), normal dot ≥ 0.9999, area/length
   within 0.1 %; exactly one hit → resolved.
4. Otherwise **unresolved** (`missing`, or `ambiguous` with the candidate names).

**Weak names** — any name containing `F<id>:face` of an import feature of the part: the `#k` is
pure geometric order, no history, so after the file is replaced it is no evidence. With a
fingerprint, the family is always disambiguated with a tighter radius (0.1 × diag), planar/curved
must match and the area/length must agree within 25 % (not for plane-like refs); the exact name
stands only if it is itself the clear nearest normal-compatible member. A lone remaining member
needs strict evidence. Without a fingerprint the exact name stands.

Plane-like references (sketch planes, offset planes, up-to targets) treat coplanar same-normal
candidates as one plane, since any of them gives the same frame.

Search spaces: `S<id>:…` names and `region` refs → that sketch; `F<id>:plane` → that plane; other
face/edge/vertex refs → all current bodies; `body` refs → the body table by id.

## M4 annotations and drawings (`src/regen/annotations.ts`, ADR-090)

- **When.** After the last feature, against the final state of the slot being regenerated, only
  when asked: `request.annotations ?? part.annotations.length > 0` (`false` never). The engine
  takes the configuration-resolved document as it does for features. Annotations never enter a
  feature's definition, values, cache key or walk entry, so adding or editing one regenerates no
  feature.
- **Refs.** Each `refs[i]` resolves with the feature rules through `resolveSub` (exact name, merge
  alias reported as `merged`, name family with containment, fingerprints for weak names), plus
  origin planes, axes and point, `F…:plane` / `:axis` / `:point` and bodies by id. `source`
  (`/source`): the feature must exist and be ok in this walk; `sketchDimension` reads the driving
  value or the solver's driven value (`SketchState.driven`), `featureField` must be one of the
  feature's `exprFields`, `feature` gives a chamfer's distance, a hole's diameter (the thread's
  nominal for tapped holes), a thread's major diameter or a fillet's radius. Radius and diameter
  sources are converted to the annotation's kind. `appliesTo` and datum ids (`{ datum }`) must name
  an annotation of the right kind; `{ label }` is always unresolved (needs a bind, never guessed).
  `hDistance` / `vDistance` sources are signed in the sketch and shown as distances (`|value|`).
- **Sketch refs** (M4 gate, ADR-090 amendment "second gate round, kernel-client resolution").
  `S<id>:p(@origin)`, `S<id>:e(@x)`, `S<id>:e(@y)` and sketch points `S<id>:p(<point>)` (stored
  and construction points) resolve from the sketch's final solved state and frame, not from the
  kernel's vertices (coincident points share one location there, so a construction origin and a
  centre on it were ambiguous). The origin and points are `point` anchors; an axis is a `line`
  through the origin along the frame's x or y, spanning the part (the bodies' bounding boxes and
  the sketch's points projected on it). A sketch that is not in the final state (deleted,
  suppressed, failed, rolled back) leaves the ref unresolved, with its structural cause. Sketch
  curves still resolve through the kernel's names.
- **Construction refs** (M4.1, ADR-095). `origin:O`, `origin:X|Y|Z`, `S<id>:p(@origin)`,
  `S<id>:e(@x|@y)`, `S<id>:p(<point>)` and `F<id>:plane|axis|point` resolve as above. Origin axes
  and axis features are `axis` anchors spanning the part like sketch axes (`partSpan`: the bodies'
  bounding-box corners projected on the line, at least ±1 mm about its origin), no longer
  `extent: [0, 0]`; only their position and direction measure. `F<p>:pitch` is the pitch circle
  of circular pattern `p` (`pitchCircle`): a `circle` about the pattern's axis as it resolves in
  the final state, through the axes of the holes' instances (the source holes' own instances and
  `p`'s copies of them; copies by other patterns or mirrors are on other circles and left out),
  centred on the axis at the original instance's entry level, normal along the axis
  (`canonicalDir`). Diameter and radius measure it; `min` / `max` work on it. A deleted,
  suppressed, failed or rolled-back pattern leaves the ref unresolved with its structural cause
  (so a suppressed one makes the annotation `suppressed`). A feature that is not a circular
  pattern, sources that are not all holes, an instance that is not a round bore parallel to the
  axis, instances at different radii (1e-6 relative) or holes on the axis leave it unresolved
  with an `UNRESOLVED_REFERENCE` `error` saying which: never a guessed circle.
- **Extremes** (M4.1). `at: 'min' | 'max'` on a linear or ordinate dimension with a `direction`
  is the ref's extreme point along it (`extremePoint`): a circle's (an arc's: its circle's) or a
  sphere's tangent point; for a cylinder or cone face the farther of its two rim tangent points,
  the middle of the tangent line when both are as far (a cylinder across its axis); a straight
  edge's farther end (its middle when square to the direction); a point itself. Its anchor is that
  `point`. A plane, an axis without a radius, a torus and other faces or curves have none: the
  annotation needs attention with the reason, anchored by the entity. Without a direction, or on
  another kind, min/max is unmeasurable too (the document rule flags it as well). Anchor queries
  have no direction, so a query at `min`/`max` returns the entity's plain anchor.
- **Draft angles and torus radii** (M4.1). In an angle, a planar face at `axis` is the line along
  its normal (a circle or torus at `axis`: its axis), and such a pair never goes to the kernel's
  `measureShapes` (which would measure the face): refs [drafted face, neutral face] at
  ['self', 'axis'] give the draft (3° on rp05). A torus face (`subShapeGeometry` `torus`; exact
  only, the probes have none) is `RefGeo` `torus`: a radius measures its minor radius (a diameter
  twice that), and its anchor for `radius` / `diameter` (`at: 'self'`, resolutions and anchor
  queries) is the `torus` anchor (`center`, canonical `axis`, `major`, `minor`). Otherwise a torus
  is anchored by its centroid as before (`center`: its centre; `axis`: its axis).
- **Plane-like faces and successors.** A face ref of a `linear`, `ordinate` or `angle` annotation
  (`at: 'self'`) is measured as its plane, so it resolves plane-like: a face split into coplanar
  pieces is one plane (reported as `rebound` to a piece). A face name that no longer exists
  resolves to its recorded successor (`refs.ts` `resolveSuccessor`), reported as `merged`: a
  Boolean's `F<b>:face(N)` (the same face, carried on from a consumed tool body; any annotation
  kind), or, plane-like only, a Shell's `F<s>:rim(N)` (the rim lies in the plane of the opened
  face N). Exactly one successor feature and role must name N. Feature refs keep the plain rules.
- **Count** (`text.count`, dimensions and hole callouts): `count` is the number of instances of
  what `refs[0]` resolved to that exist in the final bodies: names equal once split suffixes are
  dropped, copy wrappers (`inst<k>(…)`, `mirror(…)`, any depth) unwrapped, hole points made generic
  (a hole with N points is N instances) and edge components sorted; split pieces count once. A
  skipped pattern instance is not an instance (rp08: a pattern of 4 with one skipped is `3`). A
  sketch, plane or datum ref is 1; a hole callout without refs counts its `instances`. Set only
  when `ok`, like `value`.
- **States.** `suppressed` when the annotation is, when its source feature is, or when every
  unresolved ref has the structural cause `suppressed` (also a suppressed datum or applied-to
  dimension). Otherwise anything unresolved or a value that cannot be had is `needsAttention`
  with `error` and the first `cause`. Causes use cause.ts with the annotation as a consumer after
  the walk: structural (deleted, suppressed, failed), then this regen's change when the same
  stored ref resolved in the regen right before, then the carried-over cause. Datum letters and
  annotation ids get no cause. `value` = source ?? nominal ?? measured, set **only** when `ok`.
- **Geometry** (`annotation-geometry.ts`). Planar faces: the fingerprint's exact centroid and
  outward normal (the M4 kernel's `planeOf` also reverses left-handed planes, so chamfer faces and
  mirrored copies point outward), outline from `projectFaceOutline`. Cylinders, cones, spheres,
  lines and circles: `subShapeGeometry`, one call per sub-shape and handle (axis, radius, axial
  extent; centre, normal, radius, arc ends; end points), put in canonical form (ends and arc ends
  in `compareKey` order, `canonicalDir` directions, an axis' origin at the foot of the world
  origin). Against a kernel build without that entry (and engine fakes) the same values are probed
  with `measureShapes` (datums.ts), with no cone axes and no arc ends on partial cylinders. Other
  edges: the coarse mesh polyline. All are memoised per handle. `measured` follows the
  conventions in that file's header; for hole callouts it is the bore of the first instance.
  `instances` lists every `F<hole>:hole(<p>):wall` face, with pattern and mirror copies
  unwrapped. Split pieces count once (the largest stands for the instance), the originals first.
- **Anchors by kind.** A radius or diameter of a cylindrical face (`at: 'self'`) is anchored by its
  rim circle, which is what the drawing dimensions: a hole wall's rim at the hole's entry (normal
  out of the hole), any other face's at the far end of its canonical axis. A face that is not a
  full turn (a fillet) gets `start`/`end` from the one exact boundary arc at that end; a rim in
  several pieces stays a full circle. A hole callout without refs gets `anchors: [rim]`: the first
  instance's entry rim (the counterbore's for a counterbored hole, the countersink's outer rim for
  a countersunk one, else the bore's), normal out of the hole. The entry is read from the
  instance's own faces (a blind hole's `:bottom`/`:tip` is at the far end, `:cbore.floor`/`:csink`
  at the entry), else from the hole's placement face, whose outward normal points out of it. A
  thread callout's rim is at the far end of the canonical axis.
- **Anchor queries** (`annotationAnchors(partId, queries, slot = 'main')`, ADR-092 proposal 2):
  `{ ref, at?, annotationKind? }` → `{ anchor | null, unresolved?, merged?, grown?, rebound? }`,
  one per query, against the slot's latest final state (the regen keeps its walk context in
  `PartCache.latest.context`, without attachment bytes). Refs resolve exactly as annotation refs
  (paths `/<i>`); an unresolved ref has no anchor and its structural cause. It reads the slot and
  never writes it (the `lastKnown` and `grown` memories are copies). For the drawing import's
  promoted fillet (`radius`: the rim arc), chamfer (the face's plane) and revolve values (start and
  end faces: the angle between their outward normals is π − θ, so the promotion wants
  `measure: 'supplement'`). Sketch origins and centre lines for the Dimension tool: for each
  sketch to show, query `S<id>:p(@origin)` (`vertex`), `S<id>:e(@x)` and `S<id>:e(@y)` (`edge`):
  a `point` and two `line` anchors on the sketch's final frame.
- **Reuse.** A resolution is reused while the final state's content keys, merge table, feature
  states and keys, parameters and the annotation (plus its datums and applied-to dimension) are
  unchanged. A needs-attention one is reused only from the regen right before, so its cause stays
  correct. Memo entries are per slot and by id; deleted annotations' entries are dropped.
- **Cost** (stress part, 409 faces, 50 annotations: 20 linear, 15 diameters on cylinders, 10 radii
  on circles, 5 notes on lines; Node, single-threaded kernel; `WREN_STRESS=1
  WREN_STRESS_ONLY=last,annotations WREN_STRESS_MASS=deferred pnpm --filter @wren-cad/test-fixtures
  stress`). An unchanged regen costs about the same with annotations as without. Fresh resolutions
  on a new final body (the shape after any edit) take 40 `subShapeGeometry` calls and 16
  measurements (resolution only), against 877 measurements with the probes; 27 outline
  projections either way. Editing the last feature, CPU median, interleaved A/B on a loaded
  4-core machine: with exact geometry 192 to 205 ms with annotations against 186 to 191 ms
  without (about +10 ms); with the probes it was 222 to 240 ms against 169 to 200 ms (about
  +50 ms). Budget 300 ms (PLAN §10).
- **`shapeForDrawing(partId, slot = 'main')`** writes one BREP of the latest regen's non-mesh
  bodies (a compound for several, in body order) through `exportShapes(…, 'brep')`, and transfers
  the fresh bytes. `faceNames` / `edgeNames` are each body's primary names by TopExp index,
  concatenated (the compound's `MapShapes` order: bodies share no sub-shapes, and the BREP keeps
  sub-shape order). Counts come from the cheap `bounds`. `key` = hash of the bodies' (id, content
  key): equal keys mean equal shapes and names, and the key does not move for annotation-only or
  configuration-only edits. `bounds` = union of the bodies' boxes.

## Tests

M4: `annotations.golden.test.ts` (the bracket with linear, diameter on a face and on an edge,
radius, angle, surface finish, datum, a position frame bound to the hole and a stated value; hole
callouts with a pattern of 3 and 4 holes; deleting the chamfer, the fillet, the sketch dimension;
the merged upright back face; an upstream edit that removes a hole wall, with the cause; a
configuration with a different depth; suppression by configuration; the M3.7 finding that reorder
and delete never retarget an override; feature cache keys untouched; no kernel calls on an
unchanged regen; exact geometry: four `subShapeGeometry` calls and no measurement for the
bracket's round refs, the probe fallback giving the same anchors and values, the outward chamfer
normal and outline; hole callout anchors: through holes from the top and from the bottom,
counterbore and countersink rims, a diameter on a blind hole's wall; anchor queries: the fillet's
rim arc and axis, the chamfer plane, a revolve's start and end faces, a merged face, unresolved
refs with their cause, read-only, refusals) and `shape-for-drawing.test.ts` (BREP round trip for one and two bodies: counts,
names and per-index fingerprints; the key; refusals).

M4.1 (ADR-095), on the reference parts in `reference-annotations.golden.test.ts`, each with an
upstream edit: `F<ring>:pitch` on rp09 is Ø90 at the flange top (radius 45, linear across 90) and
follows `pcd` 100 (and `bolt_n` 8); the deleted pattern is needs attention with cause `deleted`,
the suppressed one `suppressed` (and the anchor query says so); `F<hub>:pitch` and
`F<bolt>:pitch` are errors. Origin axes span rp09 (±60, −1..42; 57 after `hub_h` 45), the axis
feature spans the hub, and both measure by position only (axis feature to a bolt hole's axis 45,
50 after `pcd`). rp03: `origin:X` to the flat's rim (with and without a direction), its face, and
`origin:XY` / `origin:O` to the plane feature = 18 (10 after `flat_h`); the ball across = 50 (60).
rp08: `origin:Y` / `origin:X` to the countersink rim centre = 30 / 18 (also after `plate_t` and
`cs_d`), the point feature, sketch points, `@origin` and `@x`; `tap_depth` planes = 12. rp09
`hub_h` planes = 30 (45). rp05: the drafted wall to its shell face, no direction = 3 (4 after
`wall`); draft angles on all four walls = 3° (5° after `draft_a`), 93° between the normals. rp09
rim across = 120 on the face and on the edge, along x and y (130 after `flange_d`), bore to rim at
max/max 44; a plane at min/max, min/max without a direction or on an aligned dimension need
attention with the reason. rp02 fillet: radius 3 (diameter 6), the `torus` anchor (centre z 18,
major 18), the anchor query; 4 after `fillet_r`. In `annotations.golden.test.ts`: a synthetic
ring of four M6 holes at 20 mm is Ø40 at the top face; holes at two radii and a ring of extruded
cuts are errors.

`pnpm --filter @wren-cad/kernel-client test` runs the golden suite in Node against the real kernel
(`packages/kernel/dist`, skipped when missing) and real planegcs: plate, the M1 bracket with three
upstream edits, face split/merge/removal by inserted features (`topology`) and by **dimension
edits** (`naming`: a notch moved off the part merges two top faces and back, a depth going to 0, an
internal slot that grows until it splits the top face, a middle piece that vanishes so `#1` moves),
suppress/rollback/reorder, multi-body scopes, errors and ghosts, revolve/planes/up-to, the
50-feature cache budget (PLAN §10), handle accounting over 100 regens and runtime
`configureRegen`, the LRU bounds at 200 features (`memory.test.ts`: distinct results, a partial
failure, more version slots than the bound, `closePart` back to zero), materials, STEP/STL/BREP round trips, `refFor`, a Comlink round trip with
transfer checks, and `import` (bracket STEP → import → same volume 1e-6, placement, cached/missing/
corrupt attachments, stable names through a fillet over regens and fresh workers, a 1 %-scaled
replacement resolved by fingerprint with `rebound`, an unrelated replacement → needs attention,
multi-solid files, cut/add with the import, mesh reference bodies), and `pushpull` (M2: a pulled
top and a pulled side face re-run under width/depth edits with exact names, a downstream fillet on
a moved face's edge and on a push/pull wall, a pocket pulled flush whose floor ref then needs
attention, curved-face / whole-body / two-body failures, `measure` on the latest regen), and
`compare` (M2.5: the five acceptance fixture pairs in `compare-fixtures.ts` with analytic volumes
to 1e-6 relative, exact region boxes and face counts: box → taller box, plate → plate with a hole,
a moved hole, a fillet radius change, identical versions; plus rewritten-but-identical geometry,
overlapping multi-body sides, an empty side, slot isolation, LRU eviction, `closePart` per slot
and a Comlink transfer check). `compare-unit.test.ts` covers the failure and noise paths with a
fake kernel.
`resolve.test.ts` holds the
adversarial unit cases (near-equidistant, flipped normals, far moves, vanished pieces, weak
names). Timings are printed as `[regen timing]` lines.

ADR-078: `unify.golden.test.ts` (real kernel: the bracket's back and side faces are one face each,
14 faces, volume unchanged; a sketch on the absorbed upright back face resolves to the merged face
as `merged` and returns to its own face when a gap param un-merges it; a fillet on the absorbed
upright back-corner edge name rounds the merged full-height edge; shells of 1, 2 and 5 mm with
analytic void volumes, closed, top open, back open picked as both absorbed faces, the front open
between tangent corner fillets, and the precise "too thick" error), `merged-unit.test.ts` (alias
entries, the walk's merge table, chains).

M3.8 `FeatureStatus.grown` (contract): a ref that resolves by its exact name or a merge alias to a
body face or edge that is a merge survivor in this walk (it absorbed other names) and whose area /
length is more than 1.5× its stored fingerprint's and more than 1 mm² / 1 mm larger is reported as `{ path, name, was, now }` (report only; vertices, sketch
regions and planes never). Only refs with a stored fingerprint are measured, from the per-handle
fingerprints. `unify.golden.test.ts`: the bracket fillet on `edge(plateBack|plateLeft)` picked
before the upright (8 mm) reports 8 → 48 mm after the merge; the same edge picked on the merged
model reports nothing; widening (80 → 130 mm) or deepening (50 → 90 mm) the demo bracket reports
nothing (`apps/web/src/samples/bracket.test.ts`).

M3.5: `cause.test.ts` (real kernel, one test per cause rule: changed via a chain and by the
producer, carried over and cleared, added, suppressed, deleted, reordered, failed/blocked, an
`error` feature, and "never guesses"); `topology.test.ts` / `naming.test.ts` assert the causes of
their edit-upstream breakages; `curves.test.ts` (de Boor vs Bernstein, Cox–de Boor sums, the
rational quarter circle, periodic seams, chord tolerance, elliptic arcs vs the ellipse
equation); `curves-linked.test.ts` (exact projections, fallback re-projection, pass-through with
the identity solver and planegcs); `curves.golden.test.ts` (spline / elliptic-arc profiles
extruded vs integrated areas; **skipped** until the kernel builds those edges, and meanwhile
checks today's clear `UNSUPPORTED_FEATURE`).

## Memory guard (H1)

`RegenEngine.memoryStats()` (`RegenMemoryStats`) is a snapshot of what the engine holds:
per part and slot, the cache entries and the shape handles they own (as `stats(partId, slot)`) and
the cached imports; totals; every owned handle; the per-handle caches (fingerprints, mass
properties, meshes and their bytes, probed geometry); and the configured bounds
(`maxSpareResults`, `maxVersionSlots`, the import spares). Invariants between engine calls:
`ownedHandles` = `handles` + the slots' `importHandles`, every live façade handle beyond the
baseline is owned, and after `closePart` of every part everything is 0.
`createModelingApi(...).memoryStats()` (`KernelMemoryStats`) adds the façade's live handle count
and the Wasm heap size (`wasmHeapBytes()`, bytes of the kernel's linear memory, which grows and
never shrinks). Both are worker-side for now; see the contract proposal below for the Comlink
method.

## Kernel gaps and contract notes

- **Kernel (M4, closed)**: `planeOf` now also reverses left-handed planes, and
  `subShapeGeometry(shape, kind, index)` exists (both in the M4 drawing-kernel build, ADR-090
  amendment). Annotations use both; the mesh-sign workaround (`outwardNormal`) is gone.
- **Contracts (M4, proposed; ADR-090 amendment "exact geometry, callout anchors, anchor
  queries")**: `ModelingApi.annotationAnchors(partId, queries, slot?)` with `AnchorQuery` and
  `AnchorAnswer` (implemented on `ModelingWorkerApi`, types in `src/regen/annotations.ts`), and
  the `AnnotationResolution.anchors` comment: "parallel to `refs`; a hole callout without refs has
  one entry, the first instance's entry rim".
- **Kernel**: the M1 gaps (no transform call, no naming call, no IGES reader) are closed by the M3
  kernel `import` feature and IGES reader; the engine uses both. Mesh imports are still placed in
  TS (`placeMesh`) because OBJ/3MF/GLB are parsed in TS.
- **Contracts** (applied): `FeatureStatus.rebound[]` carries `fingerprint?`, `UnresolvedRef` has
  `lastKnown?`, `ModelingApi` has `configureRegen` and (M2) `measure`, `naming.ts` documents the
  import names and the M2 push/pull seam merge (existing > moved > wall), and `kernel.ts`
  `Measurement` states the angle conventions.
- **Contracts** (proposed, M2.5):
  - `GeometricDiff.warnings?: KernelError[]` for bodies left out of a compare.
  - `configureRegen` options gain `maxVersionSlots?: number`.
  - The `GeometricDiff.added` comment "per body pair" should read "one mesh per non-empty
    difference", because the sides are unioned first.
- **Contracts** (proposed, M3.5):
  - `AttentionCause.kind` `changed`: "its inputs or values changed since the reference last
    resolved, or it was added, unsuppressed or moved above the consumer (`detail` says which)".
  - Optional `AttentionCause.via?: Id` — the producing feature when the cause is further up its
    chain ("the pocket's floor is gone because the plate changed").
  - `SketchBSpline`: state that `knots` are distinct values with `multiplicities` (both or
    neither), the default knot vectors and the periodic flat-knot convention above, domain [0, 1].
- **Contracts** (proposed, ADR-078, merged faces):
  - `naming.ts`: "Booleans merge the same-domain faces they leave side by side (a tool face next
    to any face on one surface, pieces of one face; never two faces that were already on the
    body). The merged face keeps the name of the earliest-created face: a face of the body before
    the operation beats one it created, then the smaller name. Each absorbed face name, and each
    edge and vertex name the merge changed, is listed as an alias: a further `NamingEntry` with the
    same `kind` and `index`, after every primary entry. The first entry per index is the
    sub-shape's name."
  - `FeatureStatus.merged?: { path: string; name: string; into: string }[]`: refs whose stored name
    was merged into another sub-shape and resolved to it by that alias. Not a heal: the stored
    name is kept, so an upstream edit that un-merges the faces brings the ref back to its own face.
- **Contracts** (done, H1): `ModelingApi.memoryStats(): Promise<KernelMemoryStats>` with
  `KernelMemoryStats` and `RegenMemoryStats` / `RegenSlotStats` as defined in
  `src/modeling-api.ts` and `src/regen/types.ts`, so the app's diagnostics panel and the soak test
  can read the worker's live handles, Wasm heap and cache state over Comlink. The worker already
  implements it (`createModelingApi`); once the contract has it, `ModelingWorkerApi` picks it up.
- **Kernel** (`@wren-cad/kernel` `ProjectedCurve`, proposed): `projectEdges` returns exact
  `ellipse` / `ellipticArc` for elliptic edges parallel to the plane and `bspline` (projected
  poles, same knots/weights) for B-spline edges, as this package's `ProjectedCurve`.
