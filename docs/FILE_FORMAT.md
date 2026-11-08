<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Whittle project file format

Version: **schema 1** · Status: M1 · Licence of this specification: **CC-BY-4.0** (the reference
implementation, `packages/document`, is GPL-3.0-or-later).

A Whittle project is a **folder of deterministic text files**. A `.whittle` file is that folder
zipped, for sharing and emailing. The text-first layout exists so that projects diff and merge
well in git and other version-control systems (PLAN §8A.1, §8A.3). The same document always
produces **byte-identical** files.

Machine-readable schemas (JSON Schema draft-07) are generated from the TypeScript types and
shipped in [`packages/document/schema/`](../packages/document/schema) and published with the app at
`https://jackhale98.github.io/whittle/schema/<file>` (each schema's `$id`):

| File | Describes |
|---|---|
| `whittle-project.schema.json` | `whittle.project.json` (manifest) |
| `whittle-params.schema.json` | `params.json` |
| `whittle-part.schema.json` | `parts/*.part.json` |
| `whittle-drawing.schema.json` | `drawings/*.drawing.json` |
| `whittle-assembly.schema.json` | `assemblies/*.assembly.json` |
| `whittle-document.schema.json` | the whole in-memory document (what `DocumentStore.load` accepts) |

The TypeScript source of truth is [`packages/contracts/src/document.ts`](../packages/contracts/src/document.ts),
[`sketch.ts`](../packages/contracts/src/sketch.ts) and
[`packages/document/src/files.ts`](../packages/document/src/files.ts). Regenerate with
`pnpm --filter @whittle/document schema`; a test fails if the committed schemas are stale.

## 1. Folder layout

```
my-bracket/
├─ whittle.project.json          manifest: format, schemaVersion, units, meta, index of parts/drawings/assemblies
├─ params.json                   global parameters
├─ parts/bracket.part.json       one file per part: features, sketches, material (keyed by stable ids)
├─ drawings/sheet-1.drawing.json one file per drawing   (placeholder until M4)
├─ assemblies/asm.assembly.json  one file per assembly  (placeholder until M6)
├─ releases/rev-A/…              frozen exports for a release (STEP/PDF)        — not read by Whittle
├─ previews/bracket.stl          optional small mesh for git-host 3D previews   — not read by Whittle
├─ .whittle-history/             snapshot history for non-git storage (§8A.3)    — not read by the codec
└─ .whittle/                     cache: meshes, BREP, thumbnails                  — regenerable, never synced or committed
```

Only `whittle.project.json`, `params.json` and the files the manifest lists are read when opening a
project. Everything else is ignored (and preserved by tools that copy folders). Derived geometry
(meshes, BREP) never appears in source files.

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

Every `.json` file Whittle writes follows these rules, so equal documents give identical bytes:

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

## 3. The `.whittle` archive

A standard ZIP (PKWARE appnote 6.3.x, DEFLATE), written with `fflate`:

- Paths are the folder-relative POSIX paths above. The cache is stored under `.whittle/`.
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

### 4.1 `whittle.project.json`

```jsonc
{
  "assemblies": [],
  "drawings": [{ "file": "drawings/sheet-1.drawing.json", "id": "01J…", "name": "Sheet 1" }],
  "format": "whittle-project",            // constant
  "meta": {
    "app": "whittle/0.1.0",               // writer
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
  "color": "#9aa4b2",                 // optional; overrides the material's appearance
  "features": [ /* Feature[] in evaluation order */ ],
  "id": "01J…",
  "material": { /* §6, optional */ },
  "name": "Bracket",
  "rollbackIndex": 14                 // features with index >= rollbackIndex are not evaluated
}
```

`rollbackIndex` is an integer in `0 … features.length`; `features.length` means fully rolled
forward.

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

**Sketches.** `entities` are points, lines, circles, arcs (and, P1, ellipses) in the sketch's 2D
frame, numbers in **millimetres/radians** (solver state). Points are entities; lines/arcs/circles
reference points by id. `constraints` are geometric (`coincident`, `horizontal`, `tangent`, …) or
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
`evaluateFeatureValues(feature, doc, engine)` in `@whittle/document` walks exactly this table and
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

`schemaVersion` (manifest and in-memory document) is an integer, currently **1**.

- Readers **must** reject a `schemaVersion` greater than they understand, with a message telling
  the user to update ("This file uses document version N, but this copy of Whittle understands up
  to version M").
- Readers **must** migrate older versions forward in memory, one step at a time
  (`n → n+1`), then validate. A missing `schemaVersion` is treated as 0 (pre-release); the 0→1
  migration only fills missing collections (`params`, `parts`, `assemblies`, `drawings`) with `[]`.
- Writers always write the current version. Files are not downgraded.
- Every bump ships with a migration function in `packages/document/src/migrations.ts` and a test
  with a fixture of the old shape.
- Within a version, readers ignore unknown *files* but treat unknown *properties* in the files
  above as invalid (the schemas set `additionalProperties: false`); additive changes therefore
  bump the version.

## 8. Validation

1. Structural JSON Schema validation with the schemas above (any draft-07 validator, e.g. Ajv).
2. The reference implementation additionally checks: unique ids across the document, unique
   parameter names, `rollbackIndex` in range, known feature types, and that every `Expr` field
   is a string. Semantic problems (an expression that does not evaluate, an unresolved reference)
   are *not* load errors; they surface in the UI as inline errors / "needs attention".
