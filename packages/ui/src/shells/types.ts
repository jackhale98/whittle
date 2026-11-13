import type { KernelStatus, RuntimeDiagnostics } from '@wren-cad/contracts';
import type { ReactNode } from 'react';
import type { PaletteCommand } from '../components/CommandPalette';
import type { ContextBubbleProps } from '../components/ContextBubble';
import type { ToolId } from '../components/tools';
import type { ValueChipProps } from '../components/ValueChip';
import type {
  ExportBody,
  ExportConfigurations,
  ExportRequest,
  ExportTarget,
} from '../export/types';
import type { FeatureTreeProps } from '../features/FeatureTree';
import type { SheetSnap } from '../logic/sheet';
import type { MeasurePanelProps } from '../panels/MeasurePanel';
import type { PartsPanelProps } from '../panels/PartsPanel';
import type { SectionPanelProps } from '../panels/SectionPanel';
import type { ParamsTableProps } from '../params/ParamsTable';
import type { ThemeSetting } from '../theme';
import type { TutorialProps } from '../tutorial/TutorialLazy';

export type PhoneSheetTab = 'parts' | 'history' | 'params' | 'measure' | 'section' | 'export';
export type SheetTabId = PhoneSheetTab;

/** Live kernel memory (diagnostics only). `-1` = the kernel could not report it. */
export interface KernelMemory {
  /** Live kernel shape handles, the regen cache's included. */
  handles: number;
  /** Wasm linear memory in bytes. */
  heapBytes: number;
  /** Regen cache: entries and the shape handles they own. */
  cacheEntries: number;
  cacheHandles: number;
}

/** Props every shell accepts. The shell never touches Wasm or the kernel: it only renders state. */
export interface ShellProps {
  /** App-level commands appended to the ⌘K palette (e.g. Check for updates, About). */
  commands?: readonly PaletteCommand[];
  documentName: string;
  kernelStatus: KernelStatus;
  /**
   * The viewport (typically a `<canvas>`). It is mounted inside `[data-testid="viewport-slot"]`,
   * a positioned element that fills the available area, so `width: 100%; height: 100%` works.
   */
  viewport: ReactNode;
  diagnostics?: RuntimeDiagnostics;
  /**
   * Live kernel memory for the Runtime panel (shape handles, Wasm heap). Called every
   * `KERNEL_MEMORY_POLL_MS` while the panel is open and nowhere else; `null` = not available.
   */
  kernelMemory?: () => Promise<KernelMemory | null>;
  /** Controlled theme. Omit to let the shell manage + persist it (localStorage). */
  theme?: ThemeSetting;
  onThemeChange?(theme: ThemeSetting): void;
  onUndo?(): void;
  onRedo?(): void;
  /** Plain Export button callback. Superseded by `onExportRequest` when that is provided. */
  onExport?(): void;

  /* ---- M1 data-driven panels (all optional; shells fall back to their empty states) ---- */
  /** Feature history for the left panel's Features tab / phone history sheet. */
  featureTree?: FeatureTreeProps;
  /** Parameters for the left panel's Params tab / phone sheet. */
  paramsTable?: ParamsTableProps;
  /** Right-panel content (typically a `FeatureInspector`, `PartInspector` or `SelectionInspector`). */
  inspector?: ReactNode;
  /** Tools that are wired; others keep the "Coming in M1" disabled state. */
  enabledTools?: readonly ToolId[];
  activeTool?: ToolId | null;
  onTool?(tool: ToolId): void;
  /** Turns the Export button into the export popover and emits the chosen options. */
  onExportRequest?(request: ExportRequest): void;
  exportBodies?: readonly ExportBody[];
  exportUnavailable?: Partial<Record<ExportTarget, string>>;
  /** Status lines for export targets (e.g. "Loading the geometry kernel… 40%"); not disabled. */
  exportNotes?: Partial<Record<ExportTarget, string>>;
  /** The export form's chosen target (on open and on change), so the host can prepare it. */
  onExportTargetChange?(target: ExportTarget): void;
  exportBusy?: boolean;

  /* ---- M2 touch & tablet ---- */
  /**
   * Context bubble near the selection (3-4 actions). `anchor` is in px relative to the viewport
   * slot; pass `anchor: null` (or omit the prop) to hide it.
   */
  contextBubble?: ContextBubbleProps;
  /** Push/pull value label that follows a screen point; tap to type an exact value. */
  valueChip?: ValueChipProps;
  /** Phone bottom sheet: controlled snap point (`peek` | `half` | `full`). */
  sheetSnap?: SheetSnap;
  onSheetSnapChange?(snap: SheetSnap): void;
  /**
   * Controlled phone sheet section: `parts` | `history` | `params` | `measure` | `section` |
   * `export`. Omit to let the shell keep it.
   */
  sheetTab?: SheetTabId;
  onSheetTabChange?(tab: SheetTabId): void;
  /** Phone: the sheet's visible height (px) whenever its snap changes, for framing the model above it. */
  onSheetHeight?(px: number): void;
  /**
   * Desktop shell (desktop and tablet): the right inspector panel's open state, controlled. The app
   * opens it while editing (a new feature, a measurement) and closes it again when that is done.
   * Omit to let the shell keep it (open on desktop, closed on tablet until asked).
   */
  inspectorOpen?: boolean;
  onInspectorOpenChange?(open: boolean): void;
  /**
   * Tablet: px of the view an overlaid side panel covers on each side (0 when docked or closed),
   * reported on every animation frame, so the camera can frame the model in the free area
   * (ADR-086, ADR-099).
   */
  onOverlayInsets?(insets: { left: number; right: number }): void;
  /** Phone Parts tab. */
  parts?: PartsPanelProps;
  /** Phone Measure tab. */
  measure?: MeasurePanelProps;
  /** Phone Section tab. */
  section?: SectionPanelProps;
  /** Coach marks for the "make a bracket" tutorial; drive it with `useTutorial`. */
  tutorial?: TutorialProps;

  /* ---- M2.5 connections, sync and versions ---- */
  /**
   * Version menu and sync status for the top bar, on every tier (typically a branch button and a
   * `SyncStatusChip`). Desktop: takes the place of the version-menu placeholder. Omit to keep it.
   */
  projectBar?: ReactNode;

  /* ---- M3.7 part configurations ---- */
  /** The part's configurations for the export form (active or all, one file each). */
  exportConfigurations?: ExportConfigurations;
  /**
   * The active-configuration pill for the top bar (`ConfigurationPill`; the `chip` variant on the
   * phone). Sits before the project bar. Omit when the part has no configurations.
   */
  configurationBar?: ReactNode;
  /**
   * The configuration table panel, shown over the viewport (desktop and tablet; never a modal).
   * The app lazy-loads the table and renders its own frame; the shell only positions it.
   */
  configurationPanel?: ReactNode;
}
