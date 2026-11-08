# @whittle/io

Mesh formats, the local library and the browser file helpers. The package has two entry points, one
that can run in a worker and one for the browser:

- `@whittle/io` (`src/index.ts`) is worker-safe. It is pure TypeScript with no DOM, IndexedDB or OPFS.
  It holds the mesh exporters and importers and the STL analysis.
- `@whittle/io/browser` (`src/browser.ts`) is for the main thread. It holds the local library,
  the file pickers and the launch-file hook, and thumbnails.

Native CAD formats (STEP, BREP) are not in this package. The kernel reads and writes them (see
[`packages/kernel`](../kernel)).

## Exports

**`@whittle/io`**

| Export | What it does |
| --- | --- |
| `meshExporters` | `to3mf(items, unit)` and `toGlb(items)`, as used by the app's export menu |
| `importMesh`, `detectMeshFormat` | Reads STL, OBJ, 3MF or GLB bytes. The format is detected from the content first (ZIP for 3MF, the glTF magic for GLB, STL size and header, OBJ text), then from the file extension |
| `importStl`, `parseStl`, `meshToStl` | Binary and ASCII STL, in both directions |
| `analyzeStl` | Reports on an STL file: triangle count, bounds, and whether it is watertight |
| `import3mf`, `to3mf` | 3MF read and write (ZIP and XML, via `fflate`) |
| `importObj`, `importGlb`, `toGlb` | OBJ and GLB read; GLB write (metres, as glTF expects) |
| `weldMesh`, `checkMesh`, `meshFromSoup`, `bboxOf` | Welding, mesh checks (edge sharing and watertightness), and bounds |
| `IoError`, `DEFAULT_LIMITS`, `ImportLimits` | Typed errors and the import limits |

**`@whittle/io/browser`**

| Export | What it does |
| --- | --- |
| `openLibrary`, `IdbLibrary` | The local library: metadata in IndexedDB, blobs in OPFS (or IndexedDB where OPFS is missing) |
| `createOpfsStore`, `isQuotaError`, `LibraryError` | Blob storage and error helpers |
| `openFile`, `saveFile` | File pickers. Uses File System Access when available and falls back to a download |
| `onLaunchFiles` | Receives files the operating system hands to the app |
| `canvasToThumbnail` | A PNG thumbnail from a canvas, for library cards |

## Design points

- **Limits before work.** Every importer checks the input against `ImportLimits` before it parses:
  256 MiB and 5 million triangles by default. Oversized input fails with an `IoError` whose code is
  `too-large`.
- **Mesh checks.** STL export is watertight by construction, because the kernel tessellates
  shared edges consistently. `checkMesh` and `analyzeStl` let tests verify that (every edge shared by
  exactly two triangles).
- **Mesh import is a reference body.** The app brings STL, OBJ, 3MF and GLB in as mesh-only
  reference bodies in the kernel. They are displayed and exported but do not take part in booleans
  (ADR-008 §3, `packages/kernel-client/src/regen/imports.ts`).
- **Library storage.** Metadata lives in IndexedDB. Blobs (project files, thumbnails) live in OPFS
  when it works, with an IndexedDB blob fallback. A quota error is reported as `LibraryError` with code
  `quota`, so the app can tell the user what happened.
- **Saves never guess names.** `saveFile` shows the native save dialog when File System Access is
  available, so the user chooses the name and location.

## Tests and scripts

| Command | What it does |
| --- | --- |
| `pnpm --filter @whittle/io test` | `vitest run`: `test/export.test.ts`, `test/import.test.ts` and `test/library.test.ts` (the library runs against `fake-indexeddb`) |
| `pnpm --filter @whittle/io typecheck` | `tsc -p .` |
| `pnpm --filter @whittle/io harness` | Vite harness for manual checks |
| `pnpm --filter @whittle/io e2e` | Playwright: `e2e/library.spec.ts` checks the library in a real browser |

The exporters' output (including the watertight check) is covered by `test/export.test.ts`.

## Dependencies

- `fflate`: ZIP for 3MF and `.whittle` files.
- `idb`: a small IndexedDB wrapper for the library.
- `fake-indexeddb` and `vite` (development only).

See [`docs/DEPENDENCIES.md`](../../docs/DEPENDENCIES.md).

## Related

- [`packages/contracts`](../contracts/src/io.ts): `ProjectCodec`, `LocalLibrary` and `MeshExporters`.
- [`docs/FILE_FORMAT.md`](../../docs/FILE_FORMAT.md): what the library stores and what a `.whittle` contains.
