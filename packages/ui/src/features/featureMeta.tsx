import type { FeatureType } from '@whittle/contracts';
import {
  ArrowUpFromLine,
  Box,
  CircleDot,
  Combine,
  Crosshair,
  FileInput,
  FlipHorizontal2,
  Grid2x2,
  Layers,
  MoveDiagonal,
  MoveVertical,
  PenLine,
  Rotate3d,
  RotateCw,
  ScanLine,
  Spline,
  SquareDashed,
  SquareRoundCorner,
  TriangleRight,
  Waves,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { ChamferIcon } from '../components/icons';

export interface FeatureMeta {
  label: string;
  Icon: ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
}

/** Display name and icon per feature type. */
export const featureMeta: Record<FeatureType, FeatureMeta> = {
  primitive: { label: 'Primitive', Icon: Box },
  sketch: { label: 'Sketch', Icon: PenLine },
  extrude: { label: 'Extrude', Icon: ArrowUpFromLine },
  revolve: { label: 'Revolve', Icon: Rotate3d },
  fillet: { label: 'Fillet', Icon: SquareRoundCorner },
  chamfer: { label: 'Chamfer', Icon: ChamferIcon },
  boolean: { label: 'Boolean', Icon: Combine },
  pushPull: { label: 'Push/Pull', Icon: MoveVertical },
  plane: { label: 'Plane', Icon: Layers },
  import: { label: 'Import', Icon: FileInput },
  // M3
  shell: { label: 'Shell', Icon: SquareDashed },
  draft: { label: 'Draft', Icon: TriangleRight },
  sweep: { label: 'Sweep', Icon: Spline },
  loft: { label: 'Loft', Icon: Waves },
  mirror: { label: 'Mirror', Icon: FlipHorizontal2 },
  linearPattern: { label: 'Linear pattern', Icon: Grid2x2 },
  circularPattern: { label: 'Circular pattern', Icon: RotateCw },
  hole: { label: 'Hole', Icon: CircleDot },
  thread: { label: 'Cosmetic thread', Icon: ScanLine },
  axis: { label: 'Axis', Icon: MoveDiagonal },
  point: { label: 'Point', Icon: Crosshair },
};
