/**
 * `@wren-cad/ui/drawing`: the drawing route's components (M4). A separate entry so the initial
 * route never loads them: the app imports this inside the lazy drawing chunk. Presentational, like
 * the rest of the package: the app wires them to the document, the regen and the drawing kernel.
 */

export {
  AnnotationInspector,
  type AnnotationInspectorProps,
  CHARACTERISTIC_LABELS,
  type CharacteristicChoice,
  type LeaderInfo,
} from './AnnotationInspector';
export { AttentionPanel, type AttentionPanelProps, type AttentionRow } from './AttentionPanel';
export { DrawingList, type DrawingListItem, type DrawingListProps } from './DrawingList';
export { type DrawingPanelDef, DrawingShell, type DrawingShellProps } from './DrawingShell';
export {
  DrawingToolbar,
  type DrawingToolbarProps,
  type DrawingToolId,
  drawingTools,
} from './DrawingToolbar';
export {
  type DrawingExportFormat,
  DrawingExportPanel,
  type DrawingExportPanelProps,
} from './ExportPanel';
export { type HitRegion, type HitResult, hitTest, itemDistance, sourceKey } from './hit';
export { ImportPanel, type ImportPanelProps, type ImportRow } from './ImportPanel';
export { SHEET_SIZE_LABELS, SheetSettings, type SheetSettingsProps } from './SheetSettings';
export { type SheetTab, SheetTabs, type SheetTabsProps } from './SheetTabs';
export { SheetValueField, type SheetValueFieldProps } from './SheetValueField';
export {
  type SheetDrag,
  type SheetPointer,
  SheetViewer,
  type SheetViewerApi,
  type SheetViewerProps,
} from './SheetViewer';
export {
  StandardChoice,
  type StandardChoiceProps,
  type StandardChoiceValue,
  type StandardFamily,
} from './StandardChoice';
export {
  PROPERTY_COLUMN_LABELS,
  TableInspector,
  type TableInspectorProps,
} from './TableInspector';
export {
  InlineCellEditor,
  type InlineCellEditorProps,
  TitleBlockEditor,
  type TitleBlockEditorProps,
  type TitleBlockRow,
} from './TitleBlockEditor';
export { ToleranceField, type ToleranceFieldProps, toleranceText } from './ToleranceField';
export {
  ConfigBadge,
  type ConfigChoice,
  ViewInspector,
  type ViewInspectorProps,
} from './ViewInspector';
export { type BaseViewName, ViewGlyph, ViewPicker, type ViewPickerProps } from './ViewPicker';
export { type ViewRow, ViewsPanel, type ViewsPanelProps } from './ViewsPanel';
export * from './viewerMath';
