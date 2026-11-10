// Import the stylesheet once in the app entry: `import '@wren-cad/ui/styles.css'`.

export { BirdMark, WrenLoader } from './brand/Bird';
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
  RADIAL_REPEAT_ID,
  type RadialItem,
  RadialMenu,
  type RadialMenuProps,
} from './components/RadialMenu';
export {
  describeKernelStatus,
  StatusChip,
  type StatusChipProps,
  type StatusDescription,
  type StatusTone,
} from './components/StatusChip';
export { ToolRail, type ToolRailProps } from './components/ToolRail';
export {
  groupOf,
  type ToolDef,
  type ToolGroupDef,
  type ToolGroupId,
  type ToolId,
  toolGroups,
  toolHint,
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
  NEST_SKETCHES_KEY,
  readNestSketches,
  writeNestSketches,
} from './features/FeatureTree';
export { FolderRow, type FolderRowProps } from './features/FolderRow';
export { featureMeta } from './features/featureMeta';
export {
  FeatureStepper,
  type FeatureStepperProps,
  PhoneFeatureTree,
  type PhoneFeatureTreeProps,
  type PhoneTreeData,
} from './features/PhoneFeatureTree';
export { SketchEye, type SketchEyeProps } from './features/SketchEye';
export {
  folderCommands,
  sketchVisibilityCommands,
  TREE_COMMAND_IDS,
} from './features/treeCommands';
export {
  defaultFormatValue,
  type FormatValue,
  fmtNumber,
  formatDensity,
  isPlainLiteral,
  nudgeExpression,
  prettyUnits,
} from './format';
export { DEFAULT_COMMANDS } from './input/defaultKeymap';
export { KeymapEditor, type KeymapEditorProps } from './input/KeymapEditor';
export {
  type Binding,
  type BindingConflicts,
  BROWSER_RESERVED,
  bindingParts,
  codeLabel,
  detectPlatform,
  eventBindingId,
  eventToBinding,
  type FormatOptions,
  findConflicts,
  findReserved,
  formatBindingId,
  formatBindingLabel,
  isTypingTarget,
  type KeymapCommand,
  type KeymapContext,
  type KeymapOverrides,
  keyLabel,
  type LayoutMap,
  matchCommand,
  normalizeBindingId,
  type Platform,
  parseBinding,
  type ReservedSeverity,
  type ReservedShortcut,
  type ResolvedKeymap,
  readLayoutMap,
  reservedFor,
  resolveKeymap,
} from './input/keymap';
export {
  type HeldModifier,
  type ModifierHoldOptions,
  ShortcutOverlay,
  type ShortcutOverlayProps,
  useModifierHold,
} from './input/ShortcutOverlay';
export {
  type AttentionInput,
  type AttentionSentence,
  attentionSentence,
  attentionSentences,
} from './inspector/attentionMessage';
export { CauseSentence, type CauseSentenceProps } from './inspector/CauseSentence';
export {
  FeatureInspector,
  type FeatureInspectorProps,
  HoleWizard,
} from './inspector/FeatureInspector';
export { FeatureLineage, type FeatureLineageProps } from './inspector/FeatureLineage';
export {
  type ResolvedDim,
  resolveHole,
  rowOf,
  tableDiameter,
} from './inspector/holeResolve';
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
  type LineageRef,
  type SelectionAction,
  SelectionInspector,
  type SelectionInspectorProps,
  type SelectionKind,
  type SelectionLineage,
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
export {
  compareCandidates,
  cyclePreselection,
  KIND_PRIORITY,
  type Orderable,
  sortCandidates,
} from './logic/chooser';
export type { KeypadKey } from './logic/keypad';
export { applyKeypadKey, type EditResult } from './logic/keypad';
export {
  NAVIGATION_KEY,
  readNavigation,
  sanitizeNavigation,
  writeNavigation,
} from './logic/navigationStorage';
export {
  clampCenter,
  layoutSlots,
  RADIAL_SLOTS,
  type RadialSlot,
  slotDirection,
  slotFromDigitCode,
  slotFromVector,
  stepSlot,
} from './logic/radial';
export {
  estimateVelocity,
  type SheetSnap,
  type SnapHeights,
  settleSnap,
  snapHeights,
  stepSnap,
} from './logic/sheet';
export {
  type BlockStep,
  type CanFolder,
  canFolder,
  effectiveSketchShown,
  type FolderMovePlan,
  folderAtGap,
  folderOf,
  folderRange,
  type Membership,
  membershipAfterMove,
  planBlockMove,
  planFolderMove,
  runWithNested,
  type SketchVisibilityMode,
  type TreeFolder,
  toggledVisibility,
} from './logic/treeFolders';
export {
  allowedRollbacks,
  computeNesting,
  type MoveStep,
  planUnitMove,
  type TreeNesting,
} from './logic/treeNesting';
export { buildRows, type TreeRow } from './logic/treeRows';
export { buildSteps, type Step, stepAt, stepLabel } from './logic/treeSteps';
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
export {
  NAVIGATION_PRESETS,
  NavigationSettings,
  type NavigationSettingsProps,
} from './panels/NavigationSettings';
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
export {
  DimensionAnnotation,
  type DimensionAnnotationProps,
  type DimensionGeometry,
} from './sketch/DimensionAnnotation';
export { DimensionLabel, type DimensionLabelProps } from './sketch/DimensionLabel';
export {
  ConvertPanel,
  type ConvertPanelProps,
  LinkedEntityPanel,
  type LinkedEntityPanelProps,
  type LinkedState,
  LinkedSwatch,
  linkedEntityStyle,
  OffsetPanel,
  type OffsetPanelProps,
  SketchCornerPanel,
  type SketchCornerPanelProps,
  type SketchEditToolId,
  SketchMirrorPanel,
  type SketchMirrorPanelProps,
  TrimExtendPanel,
  type TrimExtendPanelProps,
} from './sketch/EditChrome';
export {
  describeSketchStatus,
  SketchStatusChip,
  type SketchStatusChipProps,
} from './sketch/SketchStatusChip';
export {
  type GeometricConstraintKind,
  type SketchCurveToolId,
  type SketchDrawToolId,
  SketchToolbar,
  type SketchToolbarProps,
  type SketchToolId,
  sketchCurveTools,
  sketchEditTools,
  sketchTools,
  type ToolSpec as SketchToolSpec,
} from './sketch/SketchToolbar';
export {
  type CompareOverlay,
  ComparePanel,
  type ComparePanelProps,
  inferFeatureType,
} from './sync/ComparePanel';
export {
  type ConnectionHealth,
  type ConnectionItem,
  ConnectionsPanel,
  type ConnectionsPanelProps,
  type FolderBrowse,
  type ProviderOption,
  providerMeta,
  type TokenForm,
  type WebDavForm,
} from './sync/ConnectionsPanel';
export {
  defaultDescribeValue,
  defaultIsExpression,
  type MergeChoice,
  MergePanel,
  type MergePanelProps,
} from './sync/MergePanel';
export {
  describeSyncStatus,
  type SyncAction,
  type SyncDescription,
  SyncStatusChip,
  type SyncStatusChipProps,
  type SyncTone,
} from './sync/SyncStatusChip';
export { plural, relativeTime, relativeTimeShort, type SyncDensity } from './sync/shared';
export {
  type DivergedNotice,
  suggestReleaseName,
  VersionsPanel,
  type VersionsPanelProps,
} from './sync/VersionsPanel';
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
