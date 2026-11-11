# @wren-cad/drawing

M4 drawings on the shared annotation core (PLAN §2.4 and §12 M4, ADR-090, ADR-091).

The package turns data into sheets. Its input is the drawing (sheets, views, placements), the part's annotations, the regen's `AnnotationResolution`s, the drawing worker's `ViewProjection`s, and the model values it needs. Its output is one display list per sheet in sheet mm, which the SVG, PDF and DXF renderers translate.

The package is DOM-free and Wasm-free. Expressions, the ISO 286 deviations, `annotationIssues` and the title block data are injected. It runs in any worker, and it is tested against mocks of the kernel results.

The app loads it lazily with the drawing route, never on the initial route.

## Entry points

| Entry | What it is |
| --- | --- |
| `@wren-cad/drawing` | See [Root entry](#root-entry). |
| `@wren-cad/drawing/annotation` | The worker-safe core shared with M5. See [Annotation core](#annotation-core). |
| `@wren-cad/drawing/svg` | `svgModel` returns a DOM-free node tree grouped by source (`data-source`) for picking in the editor. `renderSvg` serialises it for export. |
| `@wren-cad/drawing/pdf` | `renderPdf(sheets, { font })`: vector PDF 1.7 at true scale (MediaBox = the sheet, mm → pt once, PrintScaling None), with the font subset-embedded. Also exports the TrueType reader and subsetter. |
| `@wren-cad/drawing/dxf` | `renderDxf(list, style, { profile: 'r12' \| 'r2000' })`. R12 is the CNC-safe profile. R2000 has handles, layers with lineweights, ISO line types and `$INSUNITS = 4`. |
| `@wren-cad/drawing/font` | The self-hosted Osifont: `drawingFontUrl`, `loadDrawingFont`, and the generated metrics. |

### Root entry

- **Templates:** `generateTemplate(format, binding)`, `zoneAt`, title block slot resolution and rendering.
- **Styles:** `stylePreset`, `standardPreset`.
- **Views:** `solveViews` resolves frames, scales, aligned positions, section and detail requests. Also `projectionRequest`.
- **Placement:** `layoutView` and `layoutPlacement` turn placements into display items.
- **Import:** `planImport`, then `importCommand` (or `importCommands` when views were pushed) ("Import model annotations"). `importAnchorQueries` and `anchorLookup` turn one `annotationAnchors` call into the planner's `anchors`. Lanes keep clear of other views, cut lines, tables and the title block (`sheetObstacles`); duplicates are found by `measureKey` (ADR-091 amendment).
- **Needs attention:** `aggregateAttention`, `searchAttention`.
- **Sheets:** `composeSheet`, and `buildDrawing` for everything at once.

### Annotation core

- Number formatting.
- Tolerance and fit text.
- The tolerance field parser: `parseTolerance`.
- GD&T frame layout.
- Datum, surface texture, hole and chamfer callouts.
- The vector symbol library.
- Text metrics.
- Linear, radial, angular and leader layouts.
- The display list types.
- The line role → width and line type mapping.

## Using it

```ts
import { buildDrawing } from '@wren-cad/drawing';
import { renderPdf } from '@wren-cad/drawing/pdf';
import { loadDrawingFont } from '@wren-cad/drawing/font';

const { sheets, attention } = buildDrawing({
  drawing, annotations, configurationIds, bounds, projections,
  evaluate, evaluateAnnotation, resolutions, annotationIssues, titleBlock,
});
const pdf = renderPdf(
  sheets.map((s) => ({ list: s.list, style: drawing.style })),
  { font: await loadDrawingFont() },
);
```

## Commands

- `pnpm --filter @wren-cad/drawing test` runs the unit tests and the PDF and DXF checks.
- `pnpm --filter @wren-cad/drawing size` reports the bundle size per entry, minified and gzip.
- `pnpm --filter @wren-cad/drawing metrics` regenerates `src/font/osifont-metrics.ts` from the TTF.
- `UPDATE_GOLDENS=1 pnpm --filter @wren-cad/drawing test` rewrites the DXF goldens. Review the diff.
- `WREN_DRAWING_PREVIEW=<dir> pnpm --filter @wren-cad/drawing exec vitest run preview` writes the bracket sheet as PDF, SVG and DXF so you can look at it.

## Standards

Templates, line groups, symbol shapes and GD&T presentation are built from public and secondary sources. Their goldens are marked "provisional (secondary sources)" (owner D9). They will be re-verified once ISO 1101, ASME Y14.5, ISO 5457/7200 and ISO 128 are bought.

## Font

Osifont (`assets/fonts/osifont-lgpl3fe.ttf`) is licensed LGPL-3.0 with the GPL font exception. The licence was verified upstream; the notice and checksum are in `assets/fonts/osifont-NOTICE.txt`.
