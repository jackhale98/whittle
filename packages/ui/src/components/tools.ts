import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Axis3d,
  Box,
  CircleDot,
  Crosshair,
  FlipHorizontal2,
  Grid2x2,
  Grid3x3,
  Hammer,
  Layers,
  MoveDiagonal,
  MoveVertical,
  PenLine,
  Rotate3d,
  RotateCcw,
  RotateCw,
  Ruler,
  ScanLine,
  ScanSearch,
  Scissors,
  Spline,
  SquareDashed,
  SquareRoundCorner,
  TriangleRight,
  Waves,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { ChamferIcon } from './icons';

export type ToolId =
  | 'sketch'
  | 'extrude'
  | 'extrudeCut'
  | 'revolve'
  | 'revolveCut'
  | 'pushPull'
  | 'sweep'
  | 'loft'
  | 'fillet'
  | 'chamfer'
  | 'shell'
  | 'draft'
  | 'hole'
  | 'thread'
  | 'mirror'
  | 'linearPattern'
  | 'circularPattern'
  | 'plane'
  | 'axis'
  | 'point'
  | 'measure'
  | 'section';

export interface ToolDef {
  id: ToolId;
  label: string;
  /** Single-key shortcut (PLAN 9.4) where one is defined. */
  shortcut?: string;
  /** Milestone (PLAN section 12) that ships this tool, shown as the disabled hint. */
  comingIn?: string;
  Icon: ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
}

/**
 * Every tool, in PLAN 9.1 order. Shortcuts (PLAN 9.4) must stay unique and clear of the reserved
 * keys (see `reservedKeys`); `test/commandBar.test.tsx` enforces both.
 */
export const tools: readonly ToolDef[] = [
  { id: 'sketch', label: 'Sketch', shortcut: 'S', Icon: PenLine },
  { id: 'extrude', label: 'Extrude', shortcut: 'E', Icon: ArrowUpFromLine },
  { id: 'extrudeCut', label: 'Extruded cut', shortcut: '⇧E', Icon: ArrowDownToLine },
  { id: 'revolve', label: 'Revolve', shortcut: 'R', Icon: Rotate3d },
  { id: 'revolveCut', label: 'Revolved cut', shortcut: '⇧R', Icon: RotateCcw },
  { id: 'pushPull', label: 'Push/pull', shortcut: 'P', Icon: MoveVertical },
  { id: 'sweep', label: 'Sweep', shortcut: 'W', Icon: Spline },
  { id: 'loft', label: 'Loft', shortcut: '⇧W', Icon: Waves },
  { id: 'fillet', label: 'Fillet', shortcut: 'F', Icon: SquareRoundCorner },
  { id: 'chamfer', label: 'Chamfer', shortcut: 'C', Icon: ChamferIcon },
  { id: 'shell', label: 'Shell', shortcut: 'T', Icon: SquareDashed },
  { id: 'draft', label: 'Draft', shortcut: '⇧T', Icon: TriangleRight },
  { id: 'hole', label: 'Hole', shortcut: 'O', Icon: CircleDot },
  { id: 'thread', label: 'Thread', shortcut: '⇧O', Icon: ScanLine },
  { id: 'mirror', label: 'Mirror', shortcut: 'I', Icon: FlipHorizontal2 },
  { id: 'linearPattern', label: 'Linear pattern', shortcut: 'N', Icon: Grid2x2 },
  { id: 'circularPattern', label: 'Circular pattern', shortcut: '⇧N', Icon: RotateCw },
  { id: 'plane', label: 'Plane', shortcut: 'G', Icon: Layers },
  { id: 'axis', label: 'Axis', shortcut: '⇧G', Icon: MoveDiagonal },
  { id: 'point', label: 'Point', shortcut: '⇧P', Icon: Crosshair },
  { id: 'measure', label: 'Measure', shortcut: 'M', Icon: Ruler },
  { id: 'section', label: 'Section', Icon: Scissors },
];

/** Keys other modes own: Hide (H), sketch L / A / D / X, Space, view digits, Esc. */
export const reservedKeys: readonly string[] = [
  'H',
  'L',
  'A',
  'D',
  'X',
  'Space',
  '⇧C',
  'Esc',
  ...'01234567'.split(''),
];

const toolById = new Map(tools.map((t) => [t.id, t]));

/** Why a tool is disabled: the milestone that ships it, or a plain fallback. */
export function toolHint(id: ToolId): string {
  const t = toolById.get(id);
  return t?.comingIn ? `Coming in ${t.comingIn}` : 'Not available yet';
}

export type ToolGroupId =
  | 'sketch'
  | 'solid'
  | 'modify'
  | 'hole'
  | 'pattern'
  | 'reference'
  | 'inspect';

export interface ToolGroupDef {
  id: ToolGroupId;
  label: string;
  Icon: ToolDef['Icon'];
  tools: readonly ToolId[];
}

/**
 * Tool categories (PLAN 9.1): the single source of truth for which tool lives where. The desktop
 * command bar and the tablet rail both render it. A group with one tool is a direct button; the
 * rest open a flyout. Features: sweep and loft sit with the solids, shell and draft with the
 * modifiers with thread, hole stays a direct button; Pattern and Reference are their own categories (ADR-032).
 * The phone is a viewer (PLAN 9.1) and shows none of these.
 */
export const toolGroups: readonly ToolGroupDef[] = [
  { id: 'sketch', label: 'Sketch', Icon: PenLine, tools: ['sketch'] },
  {
    id: 'solid',
    label: 'Solid',
    Icon: Box,
    tools: ['extrude', 'extrudeCut', 'revolve', 'revolveCut', 'pushPull', 'sweep', 'loft'],
  },
  {
    id: 'modify',
    label: 'Modify',
    Icon: Hammer,
    tools: ['fillet', 'chamfer', 'shell', 'draft', 'thread'],
  },
  { id: 'hole', label: 'Hole', Icon: CircleDot, tools: ['hole'] },
  {
    id: 'pattern',
    label: 'Pattern',
    Icon: Grid3x3,
    tools: ['mirror', 'linearPattern', 'circularPattern'],
  },
  { id: 'reference', label: 'Reference', Icon: Axis3d, tools: ['plane', 'axis', 'point'] },
  { id: 'inspect', label: 'Inspect', Icon: ScanSearch, tools: ['measure', 'section'] },
];

/** The group a tool lives in. */
export function groupOf(id: ToolId): ToolGroupDef | undefined {
  return toolGroups.find((g) => g.tools.includes(id));
}
