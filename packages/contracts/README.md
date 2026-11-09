# @wren-cad/contracts

The shared types for every Wren package: the document schema, the kernel and modelling APIs,
the sketch solver API, the viewport API, the document store and the file codecs. It has no runtime
code and no dependencies. Every other package imports from here, and nothing here imports from them.

This package is **lead-owned**. Propose changes before you make them (see
[`CONTRIBUTING.md`](../../CONTRIBUTING.md#contracts)).

## Exports

The package entry is `src/index.ts`, which re-exports every module below. Import from
`@wren-cad/contracts`.

| Module | What it defines |
| --- | --- |
| `document.ts` | `WrenDoc`, `Part`, `Param`, `Material`, the `Feature` union (primitive, sketch, extrude, revolve, fillet, chamfer, boolean, pushPull, plane, import), `EntityRef`, `Fingerprint`, `PmiAnnotation`, `SCHEMA_VERSION` |
| `expressions.ts` | `ExpressionEngine`, `EvalScope`, `EvalResult`, `ExprError`, dimension vectors and `NamedDimension` |
| `naming.ts` | Persistent-name types (`PersistentName`, `NamingMap`) and the naming grammar notes (PLAN §7.3) |
| `kernel.ts` | `KernelApi`: the low-level kernel surface (`mesh`, `massProperties`, `execFeature`, and so on), `Result`, `KernelError`, `MeshBuffers`, `KernelStatus` |
| `modeling.ts` | `ModelingApi`: regeneration (`regenerate`), `refFor`, `exportPart`, `closePart`, `configureRegen`; `RegenRequest`, `RegenResult`, `FeatureStatus`, `UnresolvedRef` |
| `sketch.ts` | Sketch entities and constraints, `SketchSolveInput`, `SketchSolveResult`, `DofState`, `SketchConflict`, `SuggestedFix`, `SketchSolverApi` |
| `viewport.ts` | `Viewport`, `InteractiveViewport`, `CreateViewport`, `PickHit`, `PickKind`, `SketchOverlay`, `HighlightItem`, `StandardView` |
| `store.ts` | `DocumentStore`, `Command`, `JsonPatchOp`, `HistoryEntry`, `ApplyResult` |
| `io.ts` | `ProjectCodec`, `ProjectFiles`, `MeshExporters`, `LocalLibrary`, `LibraryEntry` |
| `runtime.ts` | `DeviceTier`, `RuntimeDiagnostics`, `WrenTestHooks` |

## Design points

- **Plain JSON.** Document types have no classes, Maps, Dates or typed arrays, so a document can
  be serialised, diffed and later mapped onto a CRDT (PLAN §6). The one exception is the
  `ProjectFiles` map, which is the in-memory form of the project folder.
- **Stable IDs.** Every addressable object carries a ULID `id`. IDs are the merge keys for files and
  history.
- **Expressions, not numbers.** Numeric inputs are stored as expression strings (`Expr`), never as
  resolved numbers, so units and parameters survive edits (ADR-006).
- **Materials are inline.** `Part.material` is a structured `Material` stored in the document, with
  an optional `libraryId` (ADR-004).
- **No derived geometry.** Meshes and B-reps are caches. They never live in the document (PLAN §8A.1).
- **Millimetres inside.** Stored geometry is in millimetres and radians, whatever the document's
  display units are.
- **Imports are attachments.** An `ImportFeature` names its bytes by path and SHA-256. The bytes live
  in the project folder, not in the JSON (ADR-008 §3).
- **Forward compatibility.** `assemblies` and `drawings` are placeholders until M6 and M4.

## Tests

- `pnpm --filter @wren-cad/contracts test` runs `vitest run` on `test/document.test.ts`.
- `pnpm --filter @wren-cad/contracts typecheck` runs `tsc -p .`.

Almost everything here is a type. The runtime exports are a few constants (`SCHEMA_VERSION`,
`DIMENSIONS`, `INFERENCE_CURSOR` and `INFERENCE_DRAWING`) and the `isDimension` type guard. Most
checking happens in the packages that use the types. The JSON Schemas are generated from these
TypeScript types by `@wren-cad/document` (`pnpm --filter @wren-cad/document schema`). A test fails if
the committed schemas are stale.

## Related

- [`docs/FILE_FORMAT.md`](../../docs/FILE_FORMAT.md): the on-disk form of these types.
- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md): how the contracts divide the work.
- ADR-004 (materials), ADR-006 (expression semantics), ADR-008 (healing and imports):
  [`docs/DECISIONS.md`](../../docs/DECISIONS.md).
