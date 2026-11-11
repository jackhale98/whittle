/**
 * Generated template layout (never stored): frame, zones, centring and trim marks, the metric
 * reference graduation and the title block cells, all in sheet mm (origin bottom-left, y up).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { TemplateBinding, TitleBlockSlot, Vec2 } from '@wren-cad/contracts';
import type { DisplayItem } from '../annotation/display';
import type { Box2 } from '../annotation/geom';

/** Zone divisions along one axis: `edges` ascending (sheet mm), `labels[i]` for [edges[i], edges[i+1]]. */
export interface ZoneAxis {
  edges: number[];
  labels: string[];
}

export interface TitleBlockCell {
  slot: TitleBlockSlot;
  /** Cell rectangle, sheet mm. */
  box: Box2;
  /** Field caption drawn small in the cell's top-left corner. */
  caption: string;
  /** Nominal value text height (shrunk to fit when the text is long, never cut). */
  valueHeight: number;
}

export interface TemplateLayout {
  id: TemplateBinding['id'];
  version: number;
  width: number;
  height: number;
  frame: Box2;
  /** Absent for custom sheet sizes (a frame without zones). */
  zones?: { x: ZoneAxis; y: ZoneAxis };
  /** Frame, zone ticks and labels, centring and trim marks, graduation. */
  items: DisplayItem[];
  titleBlock: { box: Box2; cells: TitleBlockCell[] };
  /** The 100 mm metric reference graduation (ISO 5457), for the PDF scale check. */
  graduation?: { start: Vec2; end: Vec2 };
}

/** A versioned template generator (old versions stay in code so drawings never shift). */
export type TemplateGenerator = (sheet: {
  width: number;
  height: number;
  named: boolean;
  sizeKey?: string;
}) => TemplateLayout;
