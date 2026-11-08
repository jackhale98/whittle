import {
  ArrowUpFromLine,
  Box,
  CircleDot,
  Grid3x3,
  Hammer,
  MoveVertical,
  PenLine,
  Rotate3d,
  Ruler,
  ScanSearch,
  Scissors,
  SquareDashed,
  SquareRoundCorner,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { ChamferIcon } from './icons';

export type ToolId =
  | 'sketch'
  | 'extrude'
  | 'revolve'
  | 'pushPull'
  | 'fillet'
  | 'chamfer'
  | 'shell'
  | 'pattern'
  | 'hole'
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

/** Every tool, in PLAN 9.1 order (plus M2 push/pull, the direct-editing tool). */
export const tools: readonly ToolDef[] = [
  { id: 'sketch', label: 'Sketch', shortcut: 'S', Icon: PenLine },
  { id: 'extrude', label: 'Extrude', shortcut: 'E', Icon: ArrowUpFromLine },
  { id: 'revolve', label: 'Revolve', shortcut: 'R', Icon: Rotate3d },
  { id: 'pushPull', label: 'Push/pull', shortcut: 'P', Icon: MoveVertical },
  { id: 'fillet', label: 'Fillet', shortcut: 'F', Icon: SquareRoundCorner },
  { id: 'chamfer', label: 'Chamfer', shortcut: 'C', Icon: ChamferIcon },
  // PLAN section 12, M3: "Shell, draft, sweep, loft, mirror, patterns, hole wizard ...".
  { id: 'shell', label: 'Shell', comingIn: 'M3', Icon: SquareDashed },
  { id: 'pattern', label: 'Pattern', comingIn: 'M3', Icon: Grid3x3 },
  { id: 'hole', label: 'Hole', comingIn: 'M3', Icon: CircleDot },
  { id: 'measure', label: 'Measure', shortcut: 'M', Icon: Ruler },
  { id: 'section', label: 'Section', Icon: Scissors },
];

const toolById = new Map(tools.map((t) => [t.id, t]));

/** Why a tool is disabled: the milestone that ships it, or a plain fallback. */
export function toolHint(id: ToolId): string {
  const t = toolById.get(id);
  return t?.comingIn ? `Coming in ${t.comingIn}` : 'Not available yet';
}

export type ToolGroupId = 'sketch' | 'solid' | 'modify' | 'hole' | 'inspect';

export interface ToolGroupDef {
  id: ToolGroupId;
  label: string;
  Icon: ToolDef['Icon'];
  tools: readonly ToolId[];
}

/**
 * Tool categories (PLAN 9.1): the single source of truth for which tool lives where. The desktop
 * command bar and the tablet rail both render it. A group with one tool is a direct button; the
 * rest open a flyout. There is no Reference group yet: no plane/axis/point tool exists (M3).
 */
export const toolGroups: readonly ToolGroupDef[] = [
  { id: 'sketch', label: 'Sketch', Icon: PenLine, tools: ['sketch'] },
  { id: 'solid', label: 'Solid', Icon: Box, tools: ['extrude', 'pushPull', 'revolve'] },
  { id: 'modify', label: 'Modify', Icon: Hammer, tools: ['fillet', 'chamfer', 'shell', 'pattern'] },
  { id: 'hole', label: 'Hole', Icon: CircleDot, tools: ['hole'] },
  { id: 'inspect', label: 'Inspect', Icon: ScanSearch, tools: ['measure', 'section'] },
];

/** The group a tool lives in. */
export function groupOf(id: ToolId): ToolGroupDef | undefined {
  return toolGroups.find((g) => g.tools.includes(id));
}
