<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Wren project file format

Version: **schema 4** · Status: M1 · Licence of this specification: **CC-BY-4.0** (the reference
implementation, `packages/document`, is GPL-3.0-or-later).

A Wren project is a **folder of deterministic text files**. A `.wrencad` file is that folder
zipped, for sharing and emailing. The text-first layout exists so that projects diff and merge
well in git and other version-control systems (PLAN §8A.1, §8A.3). The same document always
produces **byte-identical** files.

Machine-readable schemas (JSON Schema draft-07) are generated from the TypeScript types and
shipped in [`packages/document/schema/`](../packages/document/schema) and published with the app at
`https://jackhale98.github.io/wren-cad/schema/<file>` (each schema's `$id`):

| File | Describes |
|---|---|
| `wren-project.schema.json` | `wren.project.json` (manifest) |
| `wren-params.schema.json` | `params.json` |
| `wren-part.schema.json` | `parts/*.part.json` |
| `wren-drawing.schema.json` | `drawings/*.drawing.json` |
| `wren-assembly.schema.json` | `assemblies/*.assembly.json` |
| `wren-document.schema.json` | the whole in-memory document (what `DocumentStore.load` accepts) |

The TypeScript source of truth is [`packages/contracts/src/document.ts`](../packages/contracts/src/document.ts),
[`sketch.ts`](../packages/contracts/src/sketch.ts) and
[`packages/document/src/files.ts`](../packages/document/src/files.ts). Regenerate with
`pnpm --filter @wren-cad/document schema`; a test fails if the committed schemas are stale.

## 1. Folder layout

```
my-bracket/
├─ wren.project.json          manifest: format, schemaVersion, units, meta, index of parts/drawings/assemblies
├─ params.json                   global parameters
├─ parts/bracket.part.json       one file per part: features, sketches, material (keyed by stable ids)
├─ drawings/sheet-1.drawing.json one file per drawing   (placeholder until M4)
├─ assemblies/asm.assembly.json  one file per assembly  (placeholder until M6)
├─ imports/<featureId>.step      attachments: the bytes of import features (STEP, IGES, BREP, STL, OBJ, 3MF, GLB)
├─ releases/rev-A/…              frozen exports for a release (STEP/PDF)        — not read by Wren
├─ previews/bracket.stl          optional small mesh for git-host 3D previews   — not read by Wren
├─ .wren-history/             snapshot history for non-git storage (§8A.3)    — not read by the codec
└─ .wren/                     cache: meshes, BREP, thumbnails                  — regenerable, never synced or committed
```

Only `wren.project.json`, `params.json` and the files the manifest lists are read when opening a
project. Everything else is ignored (and preserved by tools that copy folders). Derived geometry
(meshes, BREP) never appears in source files.

**Attachments.** An import feature (`type: "import"`) names its file in `source.path`
(`imports/<featureId>.<format>`), with the lowercase hex `sha256` of the bytes and the original
`fileName`. The bytes are a project file, never inline JSON. Wren keeps every non-model file
(`imports/`, `previews/`, `releases/`, …) when it opens and saves a project.

**Mesh cache.** Wren writes the latest fine meshes to `.wren/meshes/` so a project renders
before the kernel has loaded: `index.json` (`{ version: 1, key, bodies: [{ id, file }], sketches }`)
and one `<bodyId>.bin` per body — `"WMB1"`, a little-endian `u32` header length, a JSON header
(`faceNames`, `edgeNames`, `bbox`, `arrays: [{ key, type: "f32" | "u32", length }]`) padded to 4
bytes, then the arrays. `key` is a hash of the canonical `schemaVersion`, `units`, `params` and
`parts`: a cache whose key does not match the document is stale and ignored. Readers may ignore
the cache entirely.

### Slugs

File names are `<slug>.<kind>.json`, where the slug is derived from the object's name and is
**not** the identity: the manifest maps each stable `id` to its file, and each file carries its
own `id` (they must agree).

- Slug: Unicode NFKD, diacritics removed, lower-case, runs of anything outside `a-z0-9` become one
  `-`, trimmed, at most 64 characters. If nothing is left the fallback is `part`, `drawing` or
  `assembly`.
- Uniqueness: within each folder, names that collapse to the same slug are ordered by ascending
  `id` (ULIDs sort by creation time); the first keeps the slug, the next get `-2`, `-3`, …. The
  result does not depend on array order, and adding a same-named object never renames an
  existing file.
- Renaming an object renames its file (version control sees a rename). The `id` never changes.

## 2. Canonical JSON

Every `.json` file Wren writes follows these rules, so equal documents give identical bytes:

1. UTF-8, no BOM.
2. Object keys sorted by UTF-16 code unit order (`Array.prototype.sort()` default), at every depth.
3. Two-space indentation; one array element or property per line; empty arrays and objects are
   written `[]` and `{}`.
4. LF line endings; exactly one trailing newline.
5. Arrays keep their order — order is meaningful (feature order, parameter order, manifest order).
6. Numbers use the shortest round-trip form (ECMAScript `JSON.stringify`); `-0` is written `0`;
   `NaN`/`Infinity` are not representable and are rejected.
7. Properties whose value is `undefined` are omitted. Absent and `undefined` mean the same; `null`
   is only used where the schema says so.
8. Strings use JSON escaping as produced by `JSON.stringify` (non-ASCII is written literally).

Readers must accept any valid JSON for these files (including other key orders and indentation);
only writers are required to be canonical.

## 3. The `.wrencad` archive

A standard ZIP (PKWARE appnote 6.3.x, DEFLATE), written with `fflate`:

- Paths are the folder-relative POSIX paths above. The cache is stored under `.wren/`.
- **Deterministic**: entries sorted by path; every entry has the fixed timestamp 1980-01-01
  00:00:00 (DOS epoch); DEFLATE level 6; no per-entry comments or platform metadata.
  The same document and cache give the same archive bytes, whatever the clock or time zone.
- On reading, a single wrapping directory (as produced by zipping the folder with an ordinary
  tool) is tolerated and stripped. Entries with absolute paths, backslashes or `..` segments are
  rejected. Readers should cap entry count and total size (the reference reader: 20 000 entries,
  512 MiB).

## 4. Files

All identifiers (`id`) are **ULIDs**: 26 characters of Crockford base32
(`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), time-ordered, globally unique. Every part, feature, sketch
entity, constraint, parameter and annotation carries one; they are the merge keys. Ids are never
reused.

### 4.1 `wren.project.json`

```jsonc
{
  "assemblies": [],
  "drawings": [{ "file": "drawings/sheet-1.drawing.json", "id": "01J…", "name": "Sheet 1" }],
  "format": "wren-project",            // constant
  "meta": {
    "app": "wren/0.1.0",               // writer
    "created": "2026-01-02T03:04:05.000Z",
    "modified": "2026-01-02T03:04:05.000Z",
    "name": "Bracket",
    "partNumber": "BR-001"                // optional
  },
  "parts": [{ "file": "parts/bracket.part.json", "id": "01J…", "name": "Bracket" }],
  "schemaVersion": 1,
  "units": { "angle": "deg", "length": "mm" }
}
```

- `parts`, `drawings`, `assemblies`: document order. `name` is an informational copy; the file
  is authoritative.
- `units` are the **display / unit-less input** defaults (see §5). They do not change the unit of
  stored geometry numbers, which are always millimetres and radians.

### 4.2 `params.json`

```json
{
  "params": [
    { "description": "Overall width", "expr": "40mm", "id": "01J…", "name": "width" },
    { "expr": "width / 2 + 0.25in", "id": "01J…", "name": "depth" }
  ]
}
```

Parameter `name`s are unique within the document, match `[letter_][letter digit _]*`, and may not
be a built-in function or constant name (`sin`, `pi`, …). `expr` is an expression (§5) that may
reference other parameters. Parameters are global; feature-local scopes are a later addition.

### 4.3 `parts/<slug>.part.json`

```jsonc
{
  "activeConfigurationId": "01J…",    // optional (v3); absent = Default
  "color": "#9aa4b2",                 // optional; overrides the material's appearance
  "configurations": [                 // optional (v3); absent = only Default, never written empty
    {
      "features": { "01J…": { "fields": { "/end/depth": "60mm" }, "suppressed": true } },
      "id": "01J…",
      "material": null,               // null = no material; absent = inherited
      "name": "Long",
      "params": { "01J…": "80mm" },   // paramId -> Expr
      "properties": { "partNumber": "BR-100-L" }
    }
  ],
  "features": [ /* Feature[] in evaluation order */ ],
  "folders": [                        // optional (v2); absent = none, never written empty
    { "features": ["01J…", "01J…"], "id": "01J…", "name": "Mounting" }
  ],
  "id": "01J…",
  "material": { /* §6, optional */ },
  "name": "Bracket",
  "properties": { "description": "Bracket", "partNumber": "BR-100" },   // optional (v3)
  "rollbackIndex": 14                 // features with index >= rollbackIndex are not evaluated
}
```

`rollbackIndex` is an integer in `0 … features.length`; `features.length` means fully rolled
forward.

**Folders** (v2, ADR-066) group features in the tree. `features` lists the member ids and **must be
a contiguous run of the part's `features` in history order**. Folders never overlap or nest, have
a non-empty `name` string and an `id` that is unique across the whole document like every other
id. The order of the `folders` array carries no meaning (a folder sits where its first member
sits); writers keep the order they were created in. Collapsed/expanded is per-user UI state and is
not stored.

**Configurations** (v3, ADR-074) are named variants of one part. The part as stored is the
implicit **Default**; a configuration stores **only what differs** from it, keyed by id, so
renames never break anything and a text merge sees one line per override.

| Key | Meaning |
|---|---|
| `id`, `name` | Unique id (shared id space with every other id in the document); display name. Names should be unique, but duplicates are allowed and flagged by the UI. |
| `params` | `paramId → Expr`. Replaces `Param.expr` **only while this part regenerates**; other parts keep the parameter's own value. |
| `features` | `featureId → { suppressed?, fields? }`. `suppressed` replaces `Feature.suppressed`. `fields` maps a JSON pointer inside the feature (RFC 6901, e.g. `/end/depth`, `/size`) to a value. |
| `material` | Replaces the part's material; `null` = no material; absent = inherited. |
| `color` | Replaces the part's colour. |
| `properties` | Overrides of `partNumber` / `description`. |

`fields` accepts (a) any `Expr` field of the feature (§5.4; the value is an expression string)
except sketch dimensions (not yet) and driven dimensions, and (b) these option fields, whose
value must be one of the listed strings or booleans:

| Feature | Pointer: allowed values |
|---|---|
| `primitive` | `/op`: `new add cut intersect` |
| `extrude` | `/end/kind`: `blind throughAll`; `/direction`: `normal reverse symmetric`; `/op`: `new add cut intersect` |
| `revolve` | `/direction`; `/op` (as above) |
| `boolean` | `/op`: `add cut intersect`; `/keepTools`: `true false` |
| `fillet`, `chamfer` | `/propagate`: `true false` |
| `hole` | `/size`: a key of the hole's standard table; `/kind`: `simple counterbore countersink tapped`; `/fit`: `close normal loose`; `/end/kind`: `blind throughAll` |
| `thread` | `/size`: a key of the standard's table |

`upTo` is not offered because it needs a topological reference. Changing `end.kind` to `blind`
needs the same configuration to set `/end/depth` (otherwise the configuration reports a missing
value). The reference implementation exposes these tables as `CONFIGURABLE_OPTIONS` and
`configurableFields(feature)`.

`activeConfigurationId` names the configuration every regen of the live model uses (absent =
Default); it must exist. `Part.properties` holds Default's part number and description. A
part number resolves to the user-set one (the configuration's, else Default's), else
`<document name>-<configuration name>`; Default with none set resolves to the document name.
Exports are named after it; colliding names are reported, never overwritten.

Writers keep the file **canonical**: an override reset to Default removes its key, and empty
`params`, `features`, `fields` and `properties` objects (and an empty `configurations` array or a
dangling `activeConfigurationId`) are removed rather than written. Deleting a feature or a
parameter removes its overrides from every configuration in the same edit. Keys are sorted like
every object (§2), including the pointer keys of `fields`; the order of the `configurations`
array is preserved.

**Features** all have `id`, `type`, `name`, `suppressed` and optional `annotations` (PMI). Fields
holding user numbers are **expression strings**; the table in §5.4 gives each one's dimension.

| `type` | Fields (besides the common ones) |
|---|---|
| `primitive` | `op`, optional `scope`, optional `frame`; and by `shape`: `box` → `dx dy dz`; `cylinder` → `radius height`; `sphere` → `radius` |
| `sketch` | `on` (EntityRef: plane/face), `entities[]`, `constraints[]` |
| `extrude` | `profile[]` (EntityRef regions), `direction`, `end` (`blind {depth}` / `upTo {target}` / `throughAll`), `op`, optional `scope`, optional `draft` |
| `revolve` | `profile[]`, `axis`, `angle`, `direction`, `op`, optional `scope` |
| `fillet` | `edges[]`, `radius` |
| `chamfer` | `edges[]`, `mode` (`distance {distance}` / `distanceAngle {distance, angle}`) |
| `boolean` | `op` (`add`/`cut`/`intersect`), `target`, `tools[]`, `keepTools` |
| `pushPull` | `faces[]`, `distance` |
| `plane` | `definition` (`offset {from, distance}` / `frame {frame}`) |

`op` ∈ `new | add | cut | intersect`; `direction` ∈ `normal | reverse | symmetric`;
`scope` is `{kind:"all"}` or `{kind:"bodies", bodies:[EntityRef…]}`.
`Frame` = `{origin:[x,y,z], z:[…], x:[…]}` in millimetres, right-handed (Y = Z × X).

**Sketches.** `entities` are points, lines, circles, arcs, ellipses and (M3.5, written under v1 and
covered by the v2 bump) **elliptic arcs** and **B-splines** in the sketch's 2D frame, numbers in
**millimetres/radians** (solver state). Points are entities; lines/arcs/circles reference points
by id.
- `ellipticArc`: `center`, `start`, `end` (point ids), `majorRadius`, `minorRadius`, `rotation`
  (major axis direction, radians); counter-clockwise from `start` to `end`.
- `bspline`: `poles` (point ids), `degree`, `periodic`, and optional `weights`, `knots` with
  `multiplicities` (both or neither; omitted means the default clamped or periodic knots) and
  `through` (point ids of the through points of a spline drawn through points). See the doc
  comment on `SketchBSpline` and ADR-048/056 for the knot conventions.

A sketch may carry `visibility` (v2): `"auto"` (the default when absent: shown until a feature
uses it, then hidden), `"shown"` or `"hidden"`. The writer omits it for `"auto"`. Only sketches
have it. `constraints` are geometric (`coincident`, `horizontal`, `tangent`, …) or
dimensional. A dimension has `value` (an expression), `driving` (true = constrains the solver;
false = reference dimension whose value is measured after solving) and an optional `label`
position. See [`sketch.ts`](../packages/contracts/src/sketch.ts) for every kind.

**EntityRef** = `{name, kind, fingerprint?}` — a persistent topological reference. `name` follows
the naming grammar in [`naming.ts`](../packages/contracts/src/naming.ts) (e.g. `F01J…:side(S01H…:e7)`,
`origin:XY`, `B01J…`); `fingerprint` (centroid/normal/area/length) is the fallback used to re-find
an entity when its name no longer resolves. A reference that cannot be resolved unambiguously is
reported as *needs attention*, never silently guessed.

**Annotations** (`PmiAnnotation`: `id`, `kind`, `refs`, optional `value`, `tolerance`, `gdt`,
`placement`) are model-based-definition data; their `Expr` fields follow §5.4 too.

### 4.4 `drawings/*.drawing.json`, `assemblies/*.assembly.json`

Currently only `{ "id", "name" }`. They are placeholders so M1 documents are forward-compatible
with M4 (drawings) and M6 (assemblies).

## 5. Units and expressions

### 5.1 Canonical units

Stored geometry numbers (sketch coordinates, frames) and all *resolved* values handed to the
kernel are in **millimetres**, **radians**, **kilograms** (and seconds, for pressure units).
Density is therefore kg/mm³. `units.length` and `units.angle` only decide how bare numbers are
read and how values are displayed.

### 5.2 Grammar

```
additive   := term (('+' | '-') term)*
term       := unary (('*' | '/' | implicit) unary)*     implicit = juxtaposition: 25mm, 2 width, 3(a+b)
unary      := ('-' | '+') unary | power
power      := primary ('^' unary)?                       right-associative; -2^2 = -4
primary    := number | name | name '(' [additive (',' additive)*] ')' | '(' additive ')'
number     := digits ['.' digits] [('e'|'E') ['+'|'-'] digits]  |  '.' digits [exponent]
```

`× ÷ · −` are accepted as `* / * -`. `^` binds tighter than implicit multiplication, so
`5mm^2` is 5 mm² and `(5mm)^2` is 25 mm². There is no `eval`: expressions are tokenised and parsed
by a hand-written Pratt parser and evaluated by a tree walk.

**Units** (suffix a number or any value; `"` = in and `'` = ft are accepted as suffixes):

| Dimension | Units |
|---|---|
| length | `um` `mm` `cm` `m` `in` `ft` |
| angle | `deg` (`°`) `rad` |
| mass | `g` `kg` `lb` |
| time | `s` |
| force / pressure | `N` · `Pa` `kPa` `MPa` `GPa` |

Compound units are plain arithmetic: `g/cm^3`, `kg/m^3`, `lb/in^3`, `mm^2`.
**Functions**: `sin cos tan asin acos atan atan2 sqrt abs min max round floor ceil`.
**Constants**: `pi` (`π`) — a plain number (3.14159…).

### 5.3 Evaluation rules

- Every value is a number with a dimension vector `[length, mass, angle, time]`. `+`/`-` require
  equal dimensions: `10mm + 30deg` is an error ("Can't add a length and an angle") with the
  character span of the offending sub-expression.
- **Bare numbers** take the document default unit of the expected dimension: length → `units.length`
  (also for area/volume as its square/cube), angle → `units.angle`, mass → g, density → g/cm³,
  pressure → MPa. Next to a dimensioned operand in `+ -`, `min`, `max`, `atan2`, a bare number
  likewise takes that dimension's default unit (`width + 5`).
- Trigonometric functions take an angle; a bare number is in `units.angle`. `pi` is a plain
  number, so write `sin(pi/2 rad)` (not `sin(pi/2)` in a degree document). Inverse functions
  return angles.
- `round`/`floor`/`ceil` of a dimensioned value act in the document default unit for that
  dimension; `sqrt` halves the dimension exponents; `^` needs a plain-number exponent.
- A name resolves to a parameter first, except directly after a number (`25N` is newtons even if a
  parameter `N` exists). Parameters may reference each other; **cycles are errors** reported with
  the cycle (`Circular reference: a → b → a`). An error inside a referenced parameter is reported
  at the reference (`Parameter ‘b’ has an error: …`).
- Unknown names produce a suggestion by edit distance: `Unknown parameter ‘widht’ — did you mean ‘width’?`.

### 5.4 Expected dimension of every `Expr` field

| Feature | Field (JSON pointer in the feature) | Dimension |
|---|---|---|
| primitive box | `/dx` `/dy` `/dz` | length |
| primitive cylinder | `/radius` `/height` | length |
| primitive sphere | `/radius` | length |
| sketch | `/constraints/N/value` for `distance` `hDistance` `vDistance` `length` `radius` `diameter` | length |
| sketch | `/constraints/N/value` for `angle` | angle |
| extrude | `/end/depth` (blind) | length |
| extrude | `/draft` | angle |
| revolve | `/angle` | angle |
| fillet | `/radius` | length |
| chamfer | `/mode/distance` | length |
| chamfer | `/mode/angle` (distanceAngle) | angle |
| pushPull | `/distance` | length |
| plane (offset) | `/definition/distance` | length |
| any feature, annotation | `/annotations/N/value`, `/tolerance/upper`, `/tolerance/lower` | angle for `angle` annotations, else length |
| any feature, annotation | `/annotations/N/gdt/zone` | length |
| part material | `density` | density |
| material properties | `youngsModulus`, `yieldStrength` | pressure; `poissonsRatio` plain number |

Driven (reference) sketch dimensions (`driving: false`) are not evaluated: the solver measures them.
`evaluateFeatureValues(feature, doc, engine)` in `@wren-cad/document` walks exactly this table and
returns `{ values, errors }` keyed by JSON pointer, in millimetres / radians.

## 6. Materials

`Part.material` is a self-contained structure (ADR-004):

```json
{
  "appearance": "#c6cbd1",
  "density": "2.70 g/cm^3",
  "libraryId": "whittle:aluminium-6061-t6",
  "name": "Aluminium 6061-T6",
  "properties": { "poissonsRatio": "0.33", "yieldStrength": "276 MPa", "youngsModulus": "68.9 GPa" }
}
```

- `density` is an expression of dimension density, resolved to kg/mm³ (`2.70 g/cm^3` → `2.7e-6`).
- `libraryId` records the origin (`whittle:<slug>` for the built-in library, which ships 16
  materials: structural steel, stainless 304, aluminium 6061-T6 / 7075-T6, brass C360, copper,
  Ti-6Al-4V, cast iron, ABS, PLA, PETG, nylon PA12, polycarbonate, acetal/POM, oak, pine). The
  material is copied inline so documents survive library changes; the UI can offer "reset to
  library values". Property figures are typical handbook values, for estimates only.
- `appearance` is a CSS hex colour used when the part has no explicit `color`.

## 7. Versioning and migrations

`schemaVersion` (manifest and in-memory document) is an integer, currently **4**.

- Readers **must** reject a `schemaVersion` greater than they understand, with a message telling
  the user to update ("This file uses document version N, but this copy of Wren understands up
  to version M").
- **Before 1.0, schema bumps do not migrate.** Nobody has files to carry over, so a file whose
  `schemaVersion` is below the current one (or missing) is refused with "This file was made by an
  earlier preview of Wren and can't be opened". Nothing is converted. The migration registry in
  `packages/document/src/migrations.ts` exists but has no steps.
- From 1.0 on, readers **must** migrate older versions forward in memory, one step at a time
  (`n → n+1`), then validate. Every such bump ships with a migration function and a test with a
  fixture of the old shape.
- Writers always write the current version. Files are not downgraded.
- **Version history.**
  - **v1 to v3 (pre-release):** baseline, folders and sketch visibility (M3.6), configurations
    (M3.7). Not readable any more (see above).
  - **v4 (M4):** annotations move from features to the part (`Part.annotations`, §4.3), drawings
    become real (§4.4), `Configuration.annotations` overrides are keyed by annotation id, and the
    manifest gains `drawingDefaults` (§4.1). `Feature.annotations` and `PmiAnnotation` are gone.
- Within a version, readers ignore unknown *files* but treat unknown *properties* in the files
  above as invalid (the schemas set `additionalProperties: false`); additive changes therefore
  bump the version.

## 8. Validation

1. Structural JSON Schema validation with the schemas above (any draft-07 validator, e.g. Ajv).
2. The reference implementation additionally checks: unique ids across the document, unique
   parameter names, `rollbackIndex` in range, known feature types, that every `Expr` field
   is a string, that `visibility` is `auto`, `shown` or `hidden`, and that folder `name`s are
   strings with unique ids.
3. Folder membership has two layers. *Structure* (types, ids) always fails a load. *Semantics*
   (members exist, each run is contiguous, folders do not overlap, members in history order)
   are checked by `validateDoc`, but loading a project first repairs them with `normalizeFolders`
   (ADR-066) instead of failing: a text merge by git can leave a broken run, and the repair is
   deterministic: members sorted into history order; missing ids and empty folders dropped; a
   feature in two folders stays with the lower folder id; a broken run is extended over its gap
   if no other folder's member is in it, otherwise the longest contiguous run is kept (earliest
   on a tie).
4. Configurations: `validateDoc` checks types, unique ids (shared id space), that
   `activeConfigurationId` is one of the part's configurations, that `params` values and `fields`
   values are strings (`fields` also numbers and booleans), that `fields` keys are JSON pointers,
   `suppressed` is a boolean and `material` is `null` or a material. An override whose feature,
   parameter or field no longer exists is **not** a load error: resolution reports it and the
   configuration shows "needs attention"; the override is never dropped silently.
5. Semantic problems (an expression that does not evaluate, an unresolved reference) are *not*
   load errors; they surface in the UI as inline errors / "needs attention".

## 9. Version history (`.wren-history/`)

Projects stored on cloud drives or only on the device keep their history in `.wren-history/`
beside the model (PLAN §8A.3, ADR-020). It syncs with the project like any other file. Git
projects use git itself instead (§9.6). The reference implementation is `SnapshotHistory` in
`packages/sync`.

### 9.1 Layout

```
.wren-history/
├─ versions/<versionId>.json            one file per version: metadata (immutable)
├─ snapshots/<sha256>.zip               the project files of a version (content-addressed, immutable)
└─ refs/
   ├─ heads/<branch>/<versionId>        one empty file per branch head
   └─ releases/<release>/<versionId>    one file per release: its metadata (immutable)
```

- **Append-only.** Every file is created once and never edited, and is named by what it holds.
  Two devices adding versions offline therefore merge by **union**, with no conflicts. The only
  removals are a head ref replaced by a newer version of the same branch, and pruning (§9.5).
- `<versionId>` is a ULID. `<branch>` and `<release>` are the names people typed, encoded as one
  path segment: `A–Z a–z 0–9 _ -` are kept and every other UTF-8 byte is written `%XX` (uppercase
  hex). For example, `Rev A` becomes `Rev%20A`. The encoding is safe on every file service and
  reversible.
- `.wren-history/` is never part of a version: it is excluded from snapshots and from hashes,
  and so is the `.wren/` cache.

### 9.2 `versions/<id>.json`

Canonical JSON (§2):

```jsonc
{
  "at": "2026-05-01T12:00:00.000Z",      // ISO-8601, when it was saved
  "author": { "email": "ann@example.com", "name": "Ann" },
  "auto": true,                          // optional: an automatic snapshot (§9.4)
  "branch": "main",                      // the branch it was saved on
  "format": "wren-version",
  "hash": "9f2c…",                       // §9.3; also names its snapshot
  "id": "01J…",
  "message": "Thinner wall",
  "parents": ["01J…"]                    // [] for the first version, two for a merge
}
```

The versions form a commit graph: each one has its parents, message, author, time and content
hash.

### 9.3 Content hash and snapshots

`hash` is the lowercase hex SHA-256 over the version's files, in ascending UTF-16 path order.
`.wren/` and `.wren-history/` are excluded. Each file contributes the following bytes:

```
utf8(path) 0x00 utf8(decimal byte length) 0x00 bytes
```

The hash doesn't depend on compression, so identical content gives an identical hash on every
device, in both history backends, and across library versions. `snapshots/<hash>.zip` holds the
files as a deterministic `.wrencad` archive (§3, without the cache). Readers recompute the hash
after unpacking and reject a snapshot that doesn't match. Saving content whose hash equals the
current head's returns that head; no new version is written.

### 9.4 Branches, heads and automatic snapshots

- A branch is the set of `refs/heads/<branch>/*` files whose versions exist. A head that is an
  ancestor of another head of the same branch is stale (a sync brought back an old ref) and is
  ignored.
- A branch with **two or more heads** is *diverged*. This happens when two devices saved offline.
  `branches()` lists the branch once per head. A merge version with both heads as parents joins
  them.
- Which branch and version a device is on is local state, not stored here.
- **Automatic snapshots** (`auto: true`) have the branch head as their parent but never become
  heads, and nothing has them as a parent. They are listed per branch by their `branch` field.

### 9.5 Pruning

Only automatic snapshots are ever removed, according to `PrunePolicy`:

- keep all of them for `keepAllForMs` (default 1 day);
- then keep the newest one per hour until `hourlyForMs` (default 7 days);
- then keep the newest one per day.

Buckets are per branch. Named versions are never pruned, and neither is anything a release
refers to. Pruning deletes only the version file; snapshots are content-addressed and shared, and
are never deleted (another device may have saved a version with the same content while offline,
relying on the snapshot already being there). A pruned version reads as "not found".

### 9.6 Releases

`refs/releases/<release>/<versionId>` holds canonical JSON:

```json
{ "at": "…", "author": { "name": "Ann" }, "files": ["releases/rev-a/bracket.step"], "format": "wren-release", "name": "Rev A", "versionId": "01J…" }
```

- The frozen exports are written once under `releases/<slug>/` in the project (slug as in §1).
- A release can't be changed or reused: releasing a name that exists, or into a folder that
  already holds files, is refused.
- If two devices release the same name offline, the earliest `at` stands. Ties go to the smaller
  version id.

**Git projects.** Versions are commits, branches are git branches and releases are annotated
tags:

- The tag name is the release name made ref-safe (`Rev A` → `Rev-A`).
- The tag message starts with the release name, and has one `Wren-Release-File: <path>`
  trailer per frozen export. The exports are committed to the branch.
- Automatic snapshots are commits under the local ref `refs/wren/auto/<oid>`. They are never
  pushed; pruning deletes the refs.
- Wren only writes the paths it owns: the model files, `imports/`, `previews/` and
  `releases/`. Every other file in the repository is carried through unchanged.
