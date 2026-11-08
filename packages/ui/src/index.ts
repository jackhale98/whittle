// Import the stylesheet once in the app entry: `import '@whittle/ui/styles.css'`.

export { CommandBar, type CommandBarProps } from './components/CommandBar';
export type { PaletteCommand } from './components/CommandPalette';
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
  reducedTransition,
  resolveTransition,
  type SpringName,
  springs,
  useReducedMotion,
  useSpring,
} from './motion';
export { AppShell, type AppShellProps } from './shells/AppShell';
export { DesktopShell } from './shells/DesktopShell';
export { PhoneShell } from './shells/PhoneShell';
export { TabletShell } from './shells/TabletShell';
export type { ShellProps } from './shells/types';
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
