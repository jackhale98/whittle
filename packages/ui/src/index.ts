// Import the stylesheet once in the app entry: `import '@whittle/ui/styles.css'`.

export { BirdMark, WhittleLoader } from './brand/Bird';
export { CommandBar, type CommandBarProps } from './components/CommandBar';
export type { PaletteCommand } from './components/CommandPalette';
export {
  type BubbleAction,
  ContextBubble,
  type ContextBubbleProps,
} from './components/ContextBubble';
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
export { PromptChip, type PromptChipProps } from './components/PromptChip';
export { ParamNamesContext } from './components/paramNames';
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
export { ToolRail, type ToolRailProps } from './components/ToolRail';
export {
  COMING_SOON,
  type ToolDef,
  type ToolGroupDef,
  type ToolGroupId,
  type ToolId,
  toolGroups,
  tools,
} from './components/tools';
export { ValueChip, type ValueChipProps } from './components/ValueChip';
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
  type Insets,
  type Point,
  placeBubble,
  placeKeypad,
  type Rect,
  type Side,
} from './logic/bubble';
export type { KeypadKey } from './logic/keypad';
export { applyKeypadKey, type EditResult } from './logic/keypad';
export {
  estimateVelocity,
  type SheetSnap,
  type SnapHeights,
  settleSnap,
  snapHeights,
  stepSnap,
} from './logic/sheet';
export {
  initialTutorial,
  type TutorialAction,
  type TutorialState,
  type TutorialStatus,
  type TutorialStep,
  tutorialProgress,
  tutorialReducer,
} from './logic/tutorial';
export {
  formatLengthMm,
  type Measurement,
  type MeasurementExtra,
  type MeasurementKind,
  type MeasurementReading,
  type MeasureTargetItem,
  type MeasureUnits,
  measurementKind,
  parseLengthMm,
  readMeasurement,
  speakMeasurement,
} from './measure/types';
export {
  reducedTransition,
  resolveTransition,
  type SpringName,
  springs,
  useReducedMotion,
  useSpring,
} from './motion';
export { MeasurePanel, type MeasurePanelProps } from './panels/MeasurePanel';
export { type PartListItem, PartsPanel, type PartsPanelProps } from './panels/PartsPanel';
export { type SectionAxis, SectionPanel, type SectionPanelProps } from './panels/SectionPanel';
export { ParamsTable, type ParamsTableProps } from './params/ParamsTable';
export { AppShell, type AppShellProps } from './shells/AppShell';
export { BottomSheet, type BottomSheetProps } from './shells/BottomSheet';
export { DesktopShell } from './shells/DesktopShell';
export { PhoneShell } from './shells/PhoneShell';
export { TabletShell } from './shells/TabletShell';
export type {
  PhoneSheetTab,
  SheetTabId,
  ShellProps,
  TabletSheetTab,
} from './shells/types';
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
export { BRACKET_TUTORIAL_ID, bracketTutorial } from './tutorial/bracketSteps';
export { TutorialCoach, type TutorialProps } from './tutorial/TutorialLazy';
export { type TutorialController, useTutorial } from './tutorial/useTutorial';
