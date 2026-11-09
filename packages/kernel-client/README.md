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

const kernel = createKernelClient({ regen: { maxSpareResults: 32 } }); // tablet tier; default 128
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
entries not used by it (or by the last all-ok regen) beyond `maxSpareResults` (default 128; use ~32
on tablets) are evicted LRU and their handles released. Meshes, fingerprints and mass properties
are cached per handle. Results carry fresh copies of cached meshes, transferred over Comlink.

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
- **Knots** (shared with the kernel and sketch workstreams, ADR-pending "M3.5 regen of the new
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

## Tests

`pnpm --filter @wren-cad/kernel-client test` runs the golden suite in Node against the real kernel
(`packages/kernel/dist`, skipped when missing) and real planegcs: plate, the M1 bracket with three
upstream edits, face split/merge/removal by inserted features (`topology`) and by **dimension
edits** (`naming`: a notch moved off the part merges two top faces and back, a depth going to 0, an
internal slot that grows until it splits the top face, a middle piece that vanishes so `#1` moves),
suppress/rollback/reorder, multi-body scopes, errors and ghosts, revolve/planes/up-to, the
50-feature cache budget (PLAN §10), handle accounting over 100 regens and runtime
`configureRegen`, materials, STEP/STL/BREP round trips, `refFor`, a Comlink round trip with
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

M3.5: `cause.test.ts` (real kernel, one test per cause rule: changed via a chain and by the
producer, carried over and cleared, added, suppressed, deleted, reordered, failed/blocked, an
`error` feature, and "never guesses"); `topology.test.ts` / `naming.test.ts` assert the causes of
their edit-upstream breakages; `curves.test.ts` (de Boor vs Bernstein, Cox–de Boor sums, the
rational quarter circle, periodic seams, chord tolerance, elliptic arcs vs the ellipse
equation); `curves-linked.test.ts` (exact projections, fallback re-projection, pass-through with
the identity solver and planegcs); `curves.golden.test.ts` (spline / elliptic-arc profiles
extruded vs integrated areas; **skipped** until the kernel builds those edges, and meanwhile
checks today's clear `UNSUPPORTED_FEATURE`).

## Kernel gaps and contract notes

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
- **Kernel** (`@wren-cad/kernel` `ProjectedCurve`, proposed): `projectEdges` returns exact
  `ellipse` / `ellipticArc` for elliptic edges parallel to the plane and `bspline` (projected
  poles, same knots/weights) for B-spline edges, as this package's `ProjectedCurve`.
