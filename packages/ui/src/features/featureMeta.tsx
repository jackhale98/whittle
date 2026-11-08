import type { FeatureType } from '@whittle/contracts';
import {
  ArrowUpFromLine,
  Box,
  Combine,
  Layers,
  MoveVertical,
  PenLine,
  Rotate3d,
  Slice,
  SquareRoundCorner,
} from 'lucide-react';
import type { ComponentType } from 'react';

export interface FeatureMeta {
  label: string;
  Icon: ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
}

/** Display name and icon per feature type (M1 set plus pushPull). */
export const featureMeta: Record<FeatureType, FeatureMeta> = {
  primitive: { label: 'Primitive', Icon: Box },
  sketch: { label: 'Sketch', Icon: PenLine },
  extrude: { label: 'Extrude', Icon: ArrowUpFromLine },
  revolve: { label: 'Revolve', Icon: Rotate3d },
  fillet: { label: 'Fillet', Icon: SquareRoundCorner },
  chamfer: { label: 'Chamfer', Icon: Slice },
  boolean: { label: 'Boolean', Icon: Combine },
  pushPull: { label: 'Push/Pull', Icon: MoveVertical },
  plane: { label: 'Plane', Icon: Layers },
};
