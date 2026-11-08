import type { KernelStatus, RuntimeDiagnostics } from '@whittle/contracts';
import type { ReactNode } from 'react';
import type { PaletteCommand } from '../components/CommandPalette';
import type { ContextBubbleProps } from '../components/ContextBubble';
import type { ToolId } from '../components/tools';
import type { ValueChipProps } from '../components/ValueChip';
import type { ExportBody, ExportRequest, ExportTarget } from '../export/types';
import type { FeatureTreeProps } from '../features/FeatureTree';
import type { SheetSnap } from '../logic/sheet';
import type { MeasurePanelProps } from '../panels/MeasurePanel';
import type { PartsPanelProps } from '../panels/PartsPanel';
import type { SectionPanelProps } from '../panels/SectionPanel';
import type { ParamsTableProps } from '../params/ParamsTable';
import type { ThemeSetting } from '../theme';
import type { TutorialProps } from '../tutorial/TutorialLazy';

export type TabletSheetTab = 'history' | 'params' | 'inspector';
export type PhoneSheetTab = 'parts' | 'params' | 'measure' | 'section' | 'export';
export type SheetTabId = TabletSheetTab | PhoneSheetTab;

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
  /** Controlled theme. Omit to let the shell manage + persist it (localStorage). */
  theme?: ThemeSetting;
  onThemeChange?(theme: ThemeSetting): void;
  onUndo?(): void;
  onRedo?(): void;
  /** Plain Export button callback. Superseded by `onExportRequest` when that is provided. */
  onExport?(): void;

  /* ---- M1 data-driven panels (all optional; shells fall back to their empty states) ---- */
  /** Feature history for the left panel's Features tab / tablet history sheet. */
  featureTree?: FeatureTreeProps;
  /** Parameters for the left panel's Params tab / tablet + phone sheets. */
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
  exportBusy?: boolean;

  /* ---- M2 touch & tablet ---- */
  /**
   * Context bubble near the selection (3-4 actions). `anchor` is in px relative to the viewport
   * slot; pass `anchor: null` (or omit the prop) to hide it.
   */
  contextBubble?: ContextBubbleProps;
  /** Push/pull value label that follows a screen point; tap to type an exact value. */
  valueChip?: ValueChipProps;
  /** Tablet and phone bottom sheet: controlled snap point (`peek` | `half` | `full`). */
  sheetSnap?: SheetSnap;
  onSheetSnapChange?(snap: SheetSnap): void;
  /**
   * Controlled sheet section: tablet `history` | `params` | `inspector`, phone `parts` | `params` |
   * `measure` | `section` | `export`. Omit to let the shell keep it.
   */
  sheetTab?: SheetTabId;
  onSheetTabChange?(tab: SheetTabId): void;
  /** Phone Parts tab. */
  parts?: PartsPanelProps;
  /** Phone Measure tab. */
  measure?: MeasurePanelProps;
  /** Phone Section tab. */
  section?: SectionPanelProps;
  /** Coach marks for the "make a bracket" tutorial; drive it with `useTutorial`. */
  tutorial?: TutorialProps;
}
