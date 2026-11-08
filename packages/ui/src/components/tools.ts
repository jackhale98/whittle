import {
  ArrowUpFromLine,
  Box,
  CircleDot,
  Grid3x3,
  Hammer,
  PenLine,
  Rotate3d,
  Ruler,
  ScanSearch,
  SquareDashed,
  SquareRoundCorner,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { ChamferIcon } from './icons';

export type ToolId =
  | 'sketch'
  | 'extrude'
  | 'revolve'
  | 'fillet'
  | 'chamfer'
  | 'shell'
  | 'pattern'
  | 'hole'
  | 'measure';

export interface ToolDef {
  id: ToolId;
  label: string;
  /** Single-key shortcut (PLAN 9.4) where one is defined. */
  shortcut?: string;
  Icon: ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
}

/** Command-bar tools in PLAN 9.1 order. All are placeholders until M1. */
export const tools: readonly ToolDef[] = [
  { id: 'sketch', label: 'Sketch', shortcut: 'S', Icon: PenLine },
  { id: 'extrude', label: 'Extrude', shortcut: 'E', Icon: ArrowUpFromLine },
  { id: 'revolve', label: 'Revolve', shortcut: 'R', Icon: Rotate3d },
  { id: 'fillet', label: 'Fillet', shortcut: 'F', Icon: SquareRoundCorner },
  { id: 'chamfer', label: 'Chamfer', shortcut: 'C', Icon: ChamferIcon },
  { id: 'shell', label: 'Shell', Icon: SquareDashed },
  { id: 'pattern', label: 'Pattern', Icon: Grid3x3 },
  { id: 'hole', label: 'Hole', Icon: CircleDot },
  { id: 'measure', label: 'Measure', shortcut: 'M', Icon: Ruler },
];

export const COMING_SOON = 'Coming in M1';

export type ToolGroupId = 'sketch' | 'solid' | 'modify' | 'inspect';

export interface ToolGroupDef {
  id: ToolGroupId;
  label: string;
  Icon: ToolDef['Icon'];
  tools: readonly ToolId[];
}

/** Tablet rail groups (PLAN 9.1): Sketch / Solid / Modify / Inspect. Every tool is in one group. */
export const toolGroups: readonly ToolGroupDef[] = [
  { id: 'sketch', label: 'Sketch', Icon: PenLine, tools: ['sketch'] },
  { id: 'solid', label: 'Solid', Icon: Box, tools: ['extrude', 'revolve', 'hole'] },
  { id: 'modify', label: 'Modify', Icon: Hammer, tools: ['fillet', 'chamfer', 'shell', 'pattern'] },
  { id: 'inspect', label: 'Inspect', Icon: ScanSearch, tools: ['measure'] },
];
