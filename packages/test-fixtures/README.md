# @wren-cad/test-fixtures

Synthetic, structurally correct fixtures for tests. They are hand-built `MeshBuffers` and a
`SketchResult`, so the viewport and the UI can be tested and benchmarked without the kernel.

They are not golden models. The kernel's golden checks use real geometry from the kernel itself
(see [`packages/kernel/test`](../kernel/test)). The M3 reference parts (PLAN §12 and §12A) are in
[`reference-parts/`](reference-parts/README.md): ten original parts with specs, drawings, masses, CSWP stages,
a spec-to-`WrenDoc` builder, real-kernel goldens and independent FreeCAD checks.

## Exports

The entry is `src/index.ts`, which re-exports `src/meshes.ts` and `src/sketch.ts`.

| Export | What it makes |
| --- | --- |
| `boxMesh(dx, dy, dz, options?)` | An axis-aligned box of the given size. The options are `origin` (the minimum corner) and `featureTag` (a prefix for the names). |
| `denseMesh(targetTriangles, radius?)` | A closed, dense mesh of about the requested number of triangles, around a sphere of the given radius (default 50). Used for frame-time and picking benchmarks. |
| `sketchFixture(z?, featureId?)` | A `SketchResult` on a horizontal plane: a rectangle, a circle and a few extra entities, with triangulated regions. |
| `BoxMeshOptions` | The type for `boxMesh`'s options. |

## What the fixtures guarantee

- **`boxMesh`** follows the index-space rules of `MeshBuffers` in
  [`packages/contracts/src/kernel.ts`](../contracts/src/kernel.ts). It has 24 vertices (four per face,
  with flat normals), 12 triangles, six face ranges and twelve edge polylines. Face names are
  `face.<axis>min|max` and edge names are `edge(<roleA>|<roleB>)`, with the roles sorted. Its triangles
  wind outward, so the signed volume is positive and equals the box volume. Tests check each of these.
- **`denseMesh`** is structurally valid, and its volume is close to that of a sphere of the given radius.
- **`sketchFixture`** gives world-space polylines for each entity and triangulated regions. Its
  `featureId` is used as the prefix of the region names (`<featureId>:region.0`, and so on). These
  are fixture names, not the kernel's names. The real grammar is in `naming.ts`.

## Tests and scripts

| Command | What it does |
| --- | --- |
| `pnpm --filter @wren-cad/test-fixtures test` | `vitest run` over `test/meshes.test.ts` (box topology, names, winding, normals, edges, origin and feature tags, dense mesh validity) and the reference-part suites (`test/reference-parts*.test.ts`; see [reference-parts/README.md](reference-parts/README.md)) |
| `pnpm --filter @wren-cad/test-fixtures generate` | Rewrites the committed reference-part specs, Markdown and drawings from their TypeScript definitions |
| `pnpm --filter @wren-cad/test-fixtures typecheck` | `tsc -p .` |

## Stress part (performance)

[`stress-part/`](stress-part/enclosure.ts) is an injection-moulded-style enclosure with 100 features
(drafted shell, screw bosses, ribs, posts, vents, connector cut-outs, mounting ears, counterbored and
tapped holes, patterns and mirrors, dozens of fillet and chamfer edges) driven by 16 named
parameters. It is written in the reference-part step DSL, so every reference is a real persistent
name; the tests assert that every feature ends `ok`. `enclosureDoc()` builds the document;
`apps/web/e2e/fixtures/stress-enclosure.wrencad` is the same document for the browser benchmark
(`UPDATE_STRESS_FIXTURE=1 pnpm --filter @wren-cad/test-fixtures test -- stress-part.fixture`
rewrites it).

| What | How | Gates? |
| --- | --- | --- |
| Fixture is well formed, deterministic, matches the committed `.wrencad` | `pnpm test` (`stress-part.fixture.test.ts`) | yes |
| Goldens on the real kernel: all features ok, analytic volume deltas, regression volume/area/faces | `WREN_STRESS=1` (`stress-part.golden.test.ts`) | nightly |
| Node regen benchmark (cold, edit last / mid / early, suppress, undo, 50-edit memory) | `WREN_STRESS=1` (`stress-part.bench.test.ts`), `pnpm stress` | report-only |
| Browser benchmark (open, regen, edit, orbit, push/pull, memory) | `pnpm --filter @wren-cad/web stress` | report-only |

A cold regen takes minutes on a loaded machine. `WREN_KERNEL_DIST=<dir>` benchmarks another kernel
build (A/B), `WREN_STRESS_RUNS=<n>` sets the runs per scenario, `WREN_STRESS_OUT=<file>` writes JSON.
Compare CPU time, not wall time, when the machine is shared.

## Who uses them

- `packages/viewport`: the unit tests in `test/` (`boxMesh`) and the Vite harness in `harness/`
  (`boxMesh`, `denseMesh`, `sketchFixture`).
- `apps/web` declares the package as a dev dependency.

## Dependencies

- `@wren-cad/contracts` and `@wren-cad/document` (workspace). Neither has third-party runtime dependencies beyond `fflate`.
- The kernel goldens import `kernel-client`'s `createModelingApi` by relative path (it is not in that package's exports) and need `packages/kernel/dist`; without it they skip.

## Related

- [`packages/contracts/src/kernel.ts`](../contracts/src/kernel.ts): `MeshBuffers` and its index rules.
- [`packages/kernel/test`](../kernel/test): the golden tests that use real kernel output.
