# @whittle/ui

The Whittle design system and the three app shells: design tokens, Radix-based primitives, motion
presets, the feature tree, the parameter table, the inspectors, the sketch toolbar and status chips,
and the export menu. Everything here is presentational. It knows the document's types, but it does
not call the kernel, the engine or the viewport.

## Use it

Import the stylesheet once, in the app's entry point, then render a shell:

```tsx
import '@whittle/ui/styles.css';
import { AppShell, initTheme } from '@whittle/ui';

initTheme(); // before first paint

export function App({ tier, viewport }: { tier: 'desktop' | 'tablet' | 'phone'; viewport: ReactNode }) {
  return (
    <AppShell
      tier={tier}
      documentName="Bracket"
      kernelStatus={{ state: 'idle' }} /* or downloading, compiling, ready, error */
      viewport={viewport}
      /* featureTree, paramsTable, inspector, commands, exports … */
    />
  );
}
```

`AppShell` takes a `tier` (`'desktop' | 'tablet' | 'phone'`) and renders `DesktopShell`,
`TabletShell` or `PhoneShell`. The shell props (`ShellProps`) carry the feature tree, the parameter
table, the inspector, the export options and the command list. The snippet above omits most of them.
The app's `apps/web/src/app/App.tsx` is the full example.

## Exports

The entry is `src/index.ts`. The main groups are:

| Group | Exports |
| --- | --- |
| Shells | `AppShell`, `DesktopShell`, `TabletShell`, `PhoneShell`, `ShellProps` |
| Feature tree and params | `FeatureTree`, `featureMeta`, `ParamsTable` |
| Inspectors | `FeatureInspector`, `PartInspector`, `MassReadout`, `SelectionInspector`, `PickField`, `MaterialLibraryItem`, `SWATCHES` |
| Sketch | `SketchToolbar`, `sketchTools`, `SketchStatusChip`, `describeSketchStatus`, `DimensionLabel`, `ConstraintGlyph`, `ConflictPanel` (lazy), `constraintLabels` |
| Commands and chooser | `CommandBar`, `PaletteCommand`, `WhichOneChooser`, `PromptChip`, `tools`, `COMING_SOON`, `ToolId` |
| Inputs | `ExpressionInput` (with an on-screen keypad on touch), `Field`, `Section`, `Segmented`, `Switch`, `useCoarsePointer` |
| Export | `ExportMenu`, `ExportPanel`, `EXPORT_TARGETS`, `QUALITY_PRESETS`, `buildExportRequest` |
| Status | `StatusChip`, `describeKernelStatus` |
| Formatting | `fmtNumber`, `prettyUnits`, `formatDensity`, `nudgeExpression`, `defaultFormatValue` |
| Tokens and theme | `colors`, `fontFamily`, `layers`, `radii`, `surfaceAlpha`, `targets`; `initTheme`, `useTheme`, `applyTheme` |
| Motion | `springs`, `useSpring`, `reducedTransition`, `resolveTransition`, `useReducedMotion` |
| Brand | `BirdMark`, `WhittleLoader` |
| Primitives | `Button`, `IconButton`, `Tooltip`, `Panel`, `Separator`, `Kbd`, `Menu`, `FloatingLayer`, `cn` |

## Design points

- **Tokens, not literal colours.** Colours, radii, z-layers and font stacks come from `src/tokens.ts`
  and the Tailwind theme. The viewport reads the same tokens (for background, edges and DOF colours),
  so the two stay in step. Light and dark themes both meet WCAG AA contrast (CHANGELOG, M0).
- **Motion presets only** (CLAUDE.md). Use `springs` and `useSpring`, not ad-hoc durations.
  `reducedTransition` replaces them when the user prefers reduced motion.
- **Radix for behaviour.** Dialogs, tabs, toolbars, tooltips and separators come from Radix primitives,
  with the focus and keyboard behaviour that Radix provides (ADR-001).
- **No modal dialogs for modelling.** Values are typed inline. `ExpressionInput` accepts expressions with
  units, and shows an on-screen keypad on coarse-pointer devices. The command palette is a dialog, but
  it is for commands and navigation, not for entering model values.
- **Adaptive shells.** Desktop has a resizable feature panel and an inspector. Tablet has a full-screen
  viewport, a tool rail and a bottom sheet. Phone is a viewer with a bottom sheet of tools. The tier
  comes from `diagnostics.tier` in the app.
- **Honest status.** `StatusChip` and `describeKernelStatus` say what the kernel is doing (downloading,
  compiling, ready, or an error). The sketch chip says "N degrees of freedom", "Fully constrained",
  "Over-constrained" or "Solver failed".
- **Disabled tools say so.** Tools that are not wired up stay in the command bar, disabled, with a
  tooltip built from `COMING_SOON`. The app passes the enabled list in as `enabledTools`.
- **Hints in place.** The welcome card, the empty states and the prompt chips explain the next step.
  They do not block the view.

## Tests and scripts

| Command | What it does |
| --- | --- |
| `pnpm --filter @whittle/ui test` | `vitest run` over `test/`: the params inspector, expression input and other components, with Testing Library and jsdom |
| `pnpm --filter @whittle/ui typecheck` | `tsc -p .` |
| `pnpm --filter @whittle/ui harness` | The Vite harness for the design system (`vite.config.ts`) |
| `pnpm --filter @whittle/ui e2e` | Playwright: `e2e/components.spec.ts` and `e2e/interactions.spec.ts`, with axe accessibility checks (`@axe-core/playwright`) and screenshots |
| `pnpm --filter @whittle/ui e2e:update` | Re-records the screenshot baselines. The current baselines were recorded in the dev container (ADR-005 §6). |

CI runs the UI suite with `--ignore-snapshots` until CI-generated baselines are committed (ADR-005 §6).
The functional and accessibility checks still run in CI.

## Dependencies

- Radix primitives: `@radix-ui/react-dialog`, `-tabs`, `-toolbar`, `-tooltip`, `-separator`.
- `motion` (spring presets), `lucide-react` (icons), `@fontsource-variable/inter` (the self-hosted Inter font).
- Peers: `react` and `react-dom` 19.3.1. Tailwind CSS 4 builds the stylesheet.

See [`docs/DEPENDENCIES.md`](../../docs/DEPENDENCIES.md).

## Related

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md): where the UI sits.
- [`apps/web`](../../apps/web): the app that wires the shells to the workbench.
- ADR-001 (the UI stack), ADR-004 (the material picker), ADR-006 (expression input): [`docs/DECISIONS.md`](../../docs/DECISIONS.md).
