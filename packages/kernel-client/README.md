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

const kernel = createKernelClient();                  // spawns the worker, loads Wasm in background
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
`suppressed`, `rolledBack`, `blocked`), `cached` and `ms`. Shapes in `r.bodies` belong to the
engine: never `release()` them (the worker ignores such calls). `refFor(partId, {bodyId, kind,
index})` turns a pick (mesh face/edge ordinal = TopExp index) into an `EntityRef` with a
fingerprint to store in the document; `exportPart` / `importFile` / `closePart` complete the API.

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

## Reference resolution (`src/regen/resolve.ts`, PLAN §7.3)

1. **Exact name**, exactly one match → resolved. A `#k` split name is re-checked against its
   fingerprint when its family has several members; only a clear winner overrides the index.
2. **Name family** (the name with every `#k` removed, so `edge(F:end#0|…)` and `edge(F:end|…)` are
   one family) or duplicate exact names → **fingerprint disambiguation**: nearest centroid among
   members whose normal agrees (dot ≥ 0.95), accepted only within 0.25 × diag and when the winner is
   at most half the runner-up's distance (and ≥ 1e-3 × diag closer). A lone surviving `X#j` for a
   ref `X#k` needs strict evidence; a lone unsuffixed `X` (pieces merged) is accepted.
3. **Fingerprint only**: centroid within 1e-3 × diag (≥ 1e-6 mm), normal dot ≥ 0.9999, area/length
   within 0.1 %; exactly one hit → resolved.
4. Otherwise **unresolved** (`missing`, or `ambiguous` with the candidate names).

`diag` is the diagonal of the part's current bounding box (body vertices and face centroids; sketch
geometry when there are no bodies). Plane-like references (sketch planes, offset planes, up-to
targets) treat coplanar same-normal candidates as one plane, since any of them gives the same frame.

Search spaces: `S<id>:…` names and `region` refs → that sketch; `F<id>:plane` → that plane; other
face/edge/vertex refs → all current bodies; `body` refs → the body table by id.

## Tests

`pnpm --filter @whittle/kernel-client test` runs the golden suite in Node against the real kernel
(`packages/kernel/dist`, skipped when missing) and real planegcs: plate, the M1 bracket with three
upstream edits, face split/merge/removal, suppress/rollback/reorder, multi-body scopes, errors and
ghosts, revolve/planes/up-to, the 50-feature cache budget (PLAN §10), handle accounting over 100
regens, materials, STEP/STL/BREP round trips, `refFor`, and a Comlink round trip with transfer
checks. Timings are printed as `[regen timing]` lines.
