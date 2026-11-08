# @whittle/kernel-client

The kernel worker and its main-thread client (PLAN §4). The worker owns the OCCT Wasm kernel,
every B-rep shape, planegcs (for sketch re-solves) and the **regeneration engine**; the main thread
only ever holds shape ids and transferred render buffers.

| Entry                                         | What                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `@whittle/kernel-client`                      | `createKernelClient()` — spawns the worker, `api: Remote<ModelingWorkerApi>` |
| `@whittle/kernel-client/worker`               | worker entry (Comlink `expose`)                                          |
| `@whittle/kernel-client/kernel-api`           | `createKernelApi()` — low-level façade wrapper (Node tests)              |
| `@whittle/kernel-client/regen`                | `RegenEngine`, `resolveRef`, `planeFrame`, `hashKey` (pure parts testable) |
| `src/modeling-api.ts`                         | `createModelingApi()` — kernel + engine = the worker's Comlink surface    |

## Using it from the app

```ts
import { createKernelClient } from '@whittle/kernel-client';

const kernel = createKernelClient({ regen: { maxSpareResults: 32 } }); // tablet tier; default 128
await kernel.ready();
let doc = bracketDoc;                                 // a WhittleDoc from the document store
const partId = doc.parts[0].id;
let r = await kernel.api.regenerate({ doc, partId, quality: 'coarse' });
viewport.setBodies(r.bodies);                         // meshes arrive transferred, not copied
doc = structuredClone(doc);                           // (normally: a store command)
doc.params.find((p) => p.name === 'width')!.expr = '100 mm';
r = await kernel.api.regenerate({ doc, partId, quality: 'coarse' }); // only affected features rerun
if (r.revision >= shownRevision) viewport.setBodies(r.bodies);       // drop stale results
```

`r.features[i]` gives each feature's state (`ok`, `error`, `needsAttention` with `unresolved`,
`suppressed`, `rolledBack`, `blocked`), `cached`, `ms`, `warnings` and `rebound` (below). Shapes in `r.bodies` belong to the
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

**Sketches** are re-solved with planegcs (`@whittle/sketch/core`) from the stored positions with the
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

## Imports (`src/regen/imports.ts`, `planImport` in the engine)

- **STEP / BREP** → `kernel.importShapes` (one shape per solid). IGES → `UNSUPPORTED_FEATURE`
  ("export it as STEP"): the kernel has no IGES reader. The raw shapes are cached per part by
  sha256 (attachments used by the latest regen plus 8 spare, LRU); `closePart` releases them.
- **Placement** (`frame`, mm; default identity): the frame becomes a rigid 3×4 matrix (x is
  orthogonalised against z; degenerate frames are an `error`). The kernel has no transform call, so
  the shapes are written as BREP, the matrix is appended to the file's `Locations` table and the root
  shape pointed at it (`placeBrep`), and the text is read back — exact, no re-meshing.
- **Naming**: the kernel names topology only during operations, so the engine runs a no-op
  `intersect` of the solids with an enclosing box under the feature tag `<id>:face`. Every imported
  face then gets the kernel's history-less fallback `F<id>:face:unnamed#k` (k = geometric key:
  centroid x, then y, then z, rounded 1e-6 mm) and edges/vertices are derived from adjacent faces by
  the kernel; the engine translates `:face:unnamed` → `:face` in **every** kernel name it receives
  (`translateName`, stateless). Result: `F<id>:face#k`, `edge(F<id>:face#i|F<id>:face#j)`,
  `vertex(…)` — and because the kernel's shape records carry these names, downstream fillets,
  chamfers and booleans keep naming by history (`F<fillet>:fillet(edge(F<id>:face#i|…))`). The no-op
  is verified (same volume, face and edge counts); otherwise the solid is used as read, faces named
  `F<id>:face#k` by the engine, edges/vertices unnamed, with a warning.
- **Bodies**: one solid → `B<id>`; several → `B<id>#k` ordered by the geometric key of their volume
  centroids. Faces are numbered per body (as the kernel does for every body).
- **Ops** `add | cut | intersect` (B-rep only) use the scope rules of other solid features (bbox
  prefilter for the default scope); the kernel `boolean` with the imported solids as tools, so their
  faces are boolean tool faces `F<id>:face(F<id>:face#k)` (naming.ts boolean rule). `add` merges into
  the oldest touched body only (warning when it touches more).
- **Mesh formats** (STL/OBJ/3MF/GLB) → `@whittle/io` `importMesh`, placed in TS, handed to the kernel
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

`pnpm --filter @whittle/kernel-client test` runs the golden suite in Node against the real kernel
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
multi-solid files, cut/add with the import, mesh reference bodies). `resolve.test.ts` holds the
adversarial unit cases (near-equidistant, flipped normals, far moves, vanished pieces, weak
names). Timings are printed as `[regen timing]` lines.

## Kernel gaps and contract proposals (open)

- **Kernel**: no façade call to transform a shape (worked around by BREP location rewriting) and
  none to name a shape's topology (worked around by the no-op intersect + `translateName`). A
  kernel `import` feature — `execFeature({type:'import', …}, {shapes:{source}, frames:{placement}})`
  naming faces `F<id>:face#k` via `finalizeNamed` and applying the op via `applyBodyOp` (so tool
  faces keep `F<id>:face#k` instead of the nested boolean form) — would replace both. No IGES
  reader.
- **Contracts** (`modeling.ts`): `FeatureStatus.rebound[]` gains `fingerprint?: Fingerprint`;
  `UnresolvedRef` gains `lastKnown?: Fingerprint`; `ModelingApi` gains
  `configureRegen(options: { maxSpareResults?: number }): Promise<void>` (all already emitted by
  this package's `RegenFeatureStatus` / `ModelingWorkerApi`). `naming.ts`: document the import
  names above (per-body `F<id>:face#k`, `B<id>#k`, `F<id>:face(F<id>:face#k)` for import booleans,
  single-face mesh bodies).
