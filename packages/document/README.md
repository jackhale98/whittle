# @whittle/document

The document model. It owns the expression engine (values with units), the document store
(commands, JSON-patch undo and redo), the canonical project codec (the folder of JSON files and the
`.whittle` zip), the built-in material library, and the generated JSON Schemas.

It is worker-safe: no DOM and no Node-only APIs at runtime. The regeneration engine and the app both
use it.

## Exports

The entry is `src/index.ts`. The main exports are:

| Area | Exports |
| --- | --- |
| Expressions and units | `expressionEngine` (implements `ExpressionEngine`), `evaluateParams`, `evaluateFeatureValues`, `scopeOf`, `FUNCTIONS`, `CONSTANTS`, `UNITS`, `renameInExpr` |
| Store | `createDocumentStore` (`DocumentStoreImpl`), `StoreOptions`, `compileCommand` |
| Patches | `applyPatch`, `diff`, `getAt`, `existsAt`, `parsePointer`, `pointerOf` (RFC 6902 and RFC 6901) |
| Files | `projectCodec`, `canonicalJson`, `packFiles`, `unpackFiles` |
| Materials | `MATERIALS`, `findMaterial`, `materialFromLibrary`, `resolveDensity`, `LIBRARY_PREFIX` |
| Factories | `newDoc`, `newPart`, `ulid` |
| Features | Feature helpers from `features.ts`, and `suggest` for "did you mean" hints |

## Design points

- **Expressions with units** (ADR-006). Values carry a canonical value (mm, rad, kg, s) and a
  dimension vector `[length, mass, angle, time]`. Bare numbers take the document's default unit for
  their dimension. Next to a value with a unit, a bare number takes that unit. A name resolves to a
  parameter before a unit, except straight after a number. Evaluation is a tree walk over the parsed
  AST. There is no `eval` and no `Function`.
- **Undo and redo** are JSON-patch based. The store applies RFC 6902 operations immutably, with
  structural sharing. `packages/document/src/patch.ts` is a small in-house implementation, so the
  store can build inverse patches itself.
- **Coalescing.** Edits with the same `coalesceKey` merge into one history entry while the group is
  open. A group closes at `commit()`, on any other change, or after `coalesceWindowMs` of inactivity
  (default 1000 ms). History holds up to `maxHistory` entries (default 500).
- **Rename refactor.** Renaming a parameter rewrites every reference to it, in parameters and in
  features, as one command and one undo step (ADR-006).
- **Deterministic files.** `canonicalJson` sorts keys, uses two-space indentation and LF endings, and
  omits `undefined` properties. `projectCodec` writes the project folder and zips it with a fixed
  timestamp and sorted entries, so the same document always gives the same bytes. The rules are in
  [`docs/FILE_FORMAT.md`](../../docs/FILE_FORMAT.md).
- **Readers are tolerant.** Readers accept any valid JSON and any key order. They also accept a
  single wrapping folder in a zip. Path traversal and absolute paths in a zip are rejected, and the
  entry and size limits are checked.
- **Materials are inline** (ADR-004). A part stores its `Material` in the document, and `libraryId`
  records where it came from. The library has 16 built-in materials, from structural steel to pine.
- **Schemas.** `scripts/generate-schema.mjs` builds the JSON Schemas (draft-07) from the TypeScript
  types. They are published with the app at `/whittle/schema/`.

## Tests

| Command | What it does |
| --- | --- |
| `pnpm --filter @whittle/document test` | `vitest run`, covering the expression engine, units, store, patches, codec, materials, evaluation and schema validation |
| `pnpm --filter @whittle/document typecheck` | `tsc -p .` |
| `pnpm --filter @whittle/document schema` | Regenerates the JSON Schemas in `schema/` |

A schema test regenerates the schemas in memory and fails if the committed files differ. It also
validates sample documents with `ajv`.

## Dependencies

- `fflate`: the zip codec for `.whittle` files.
- `ajv` and `ts-json-schema-generator` (development only): schema validation and generation.

See [`docs/DEPENDENCIES.md`](../../docs/DEPENDENCIES.md).

## Related

- [`packages/contracts`](../contracts): the types this package implements.
- [`docs/FILE_FORMAT.md`](../../docs/FILE_FORMAT.md): the on-disk format.
- ADR-004 and ADR-006 in [`docs/DECISIONS.md`](../../docs/DECISIONS.md).
