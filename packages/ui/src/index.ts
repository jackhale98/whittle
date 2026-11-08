// Import the stylesheet once in the app entry: `import '@whittle/ui/styles.css'`.

export { BirdMark, WhittleLoader } from './brand/Bird';
export { CommandBar, type CommandBarProps } from './components/CommandBar';
export type { PaletteCommand } from './components/CommandPalette';
export {
  Field,
  Section,
  Segmented,
  type SegmentedOption,
  type SegmentedProps,
  Switch,
} from './components/controls';
export {
  ExpressionInput,
  type ExpressionInputProps,
  useCoarsePointer,
} from './components/ExpressionInput';
export {
  type FloatingAnchor,
  FloatingLayer,
  type FloatingLayerProps,
  Menu,
  type MenuItem,
  type MenuProps,
} from './components/floating';
export { ChamferIcon } from './components/icons';
export type { KeypadKey } from './components/Keypad';
export { PromptChip, type PromptChipProps } from './components/PromptChip';
export {
  Button,
  type ButtonProps,
  type ButtonVariant,
  type ControlSize,
  cn,
  IconButton,
  type IconButtonProps,
  Kbd,
  Panel,
  type PanelProps,
  Separator,
  Tooltip,
  type TooltipProps,
  TooltipProvider,
} from './components/primitives';
export {
  describeKernelStatus,
  StatusChip,
  type StatusChipProps,
  type StatusDescription,
  type StatusTone,
} from './components/StatusChip';
export { COMING_SOON, type ToolDef, type ToolId, tools } from './components/tools';
export {
  type CandidateKind,
  type PickCandidate,
  WhichOneChooser,
  type WhichOneChooserProps,
} from './components/WhichOneChooser';
export {
  type ExportFormProps,
  ExportMenu,
  type ExportMenuProps,
  ExportPanel,
} from './export/ExportMenu';
export {
  buildExportRequest,
  EXPORT_TARGETS,
  type ExportBody,
  type ExportRequest,
  type ExportTarget,
  QUALITY_PRESETS,
  type TessellationQuality,
} from './export/types';
export {
  FeatureTree,
  type FeatureTreeItem,
  type FeatureTreeProps,
  type MoveResult,
} from './features/FeatureTree';
export { featureMeta } from './features/featureMeta';
export {
  defaultFormatValue,
  type FormatValue,
  fmtNumber,
  formatDensity,
  isPlainLiteral,
  nudgeExpression,
  prettyUnits,
} from './format';
export { FeatureInspector, type FeatureInspectorProps } from './inspector/FeatureInspector';
export { type MaterialLibraryItem, SWATCHES, toMaterial } from './inspector/materials';
export {
  defaultMassFormat,
  type MassFormat,
  MassReadout,
  type MassSummary,
  PartInspector,
  type PartInspectorProps,
} from './inspector/PartInspector';
export {
  defaultDescribeRef,
  PickField,
  type PickFieldProps,
  withArticle,
} from './inspector/PickField';
export {
  type SelectionAction,
  SelectionInspector,
  type SelectionInspectorProps,
  type SelectionKind,
  type SelectionState,
} from './inspector/SelectionInspector';
export {
  reducedTransition,
  resolveTransition,
  type SpringName,
  springs,
  useReducedMotion,
  useSpring,
} from './motion';
export { ParamsTable, type ParamsTableProps } from './params/ParamsTable';
export { AppShell, type AppShellProps } from './shells/AppShell';
export { DesktopShell } from './shells/DesktopShell';
export { PhoneShell } from './shells/PhoneShell';
export { TabletShell } from './shells/TabletShell';
export type { ShellProps } from './shells/types';
export { ConflictPanel, type ConflictPanelProps } from './sketch/ConflictPanelLazy';
export {
  ConstraintGlyph,
  type ConstraintGlyphProps,
  constraintLabels,
  dimensionKinds,
  type GlyphTone,
  geometricConstraintKinds,
} from './sketch/ConstraintGlyph';
export { DimensionLabel, type DimensionLabelProps } from './sketch/DimensionLabel';
export {
  describeSketchStatus,
  SketchStatusChip,
  type SketchStatusChipProps,
} from './sketch/SketchStatusChip';
export {
  type GeometricConstraintKind,
  SketchToolbar,
  type SketchToolbarProps,
  type SketchToolId,
  sketchTools,
} from './sketch/SketchToolbar';
export {
  applyTheme,
  initTheme,
  readStoredTheme,
  systemTheme,
  type ThemeControl,
  type ThemeSetting,
  useTheme,
} from './theme';
export {
  type ColorTokens,
  colors,
  fontFamily,
  layers,
  radii,
  surfaceAlpha,
  type ThemeName,
  targets,
} from './tokens';
