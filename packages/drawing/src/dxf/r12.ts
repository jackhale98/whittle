/**
 * DXF R12 (AC1009), the CNC-safe profile (owner D4): a tiny vocabulary every CAM tool, LibreCAD
 * and QCAD reads. HEADER, TABLES (LTYPE, LAYER, STYLE), ENTITIES only; no handles. Entities:
 * LINE, ARC, CIRCLE, POLYLINE (VERTEX/SEQEND) and TEXT. Ellipses and splines are flattened within
 * `tolerance`; fills (arrowheads, datum triangles) become closed polylines. Coordinates are sheet
 * mm, y up.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DrawingStyle } from '@wren-cad/contracts';
import type { DisplayItem, DisplayList } from '../annotation/display';
import { flattenPrimitive } from '../annotation/flatten';
import { normalizeText } from '../annotation/text';
import { DxfTags, deg, dxfText, layersFor, linetypesFor, ROLE_LAYERS, textAlign } from './common';

export interface DxfR12Options {
  /** Chord tolerance for flattened curves, mm (default 0.01). */
  tolerance?: number;
  /** Leave out TEXT (geometry only, for cutting). Default false. */
  geometryOnly?: boolean;
}

function header(t: DxfTags, list: DisplayList): void {
  t.push(0, 'SECTION').push(2, 'HEADER');
  t.push(9, '$ACADVER').push(1, 'AC1009');
  t.push(9, '$INSBASE').push(10, 0).push(20, 0).push(30, 0);
  t.push(9, '$EXTMIN').push(10, 0).push(20, 0).push(30, 0);
  t.push(9, '$EXTMAX').push(10, list.width).push(20, list.height).push(30, 0);
  t.push(9, '$LIMMIN').push(10, 0).push(20, 0);
  t.push(9, '$LIMMAX').push(10, list.width).push(20, list.height);
  t.push(9, '$LTSCALE').push(40, 1);
  t.push(0, 'ENDSEC');
}

function tables(t: DxfTags, style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>): void {
  t.push(0, 'SECTION').push(2, 'TABLES');
  const lts = linetypesFor(style);
  t.push(0, 'TABLE')
    .push(2, 'LTYPE')
    .push(70, lts.length + 1);
  t.push(0, 'LTYPE')
    .push(2, 'CONTINUOUS')
    .push(70, 0)
    .push(3, 'Solid line')
    .push(72, 65)
    .push(73, 0)
    .push(40, 0);
  for (const lt of lts) {
    const total = lt.pattern.reduce((s, x) => s + Math.abs(x), 0);
    t.push(0, 'LTYPE').push(2, lt.name).push(70, 0).push(3, lt.description).push(72, 65);
    t.push(73, lt.pattern.length).push(40, total);
    for (const e of lt.pattern) t.push(49, e);
  }
  t.push(0, 'ENDTAB');
  const layers = layersFor(style);
  t.push(0, 'TABLE')
    .push(2, 'LAYER')
    .push(70, layers.length + 1);
  t.push(0, 'LAYER').push(2, '0').push(70, 0).push(62, 7).push(6, 'CONTINUOUS');
  for (const l of layers)
    t.push(0, 'LAYER').push(2, l.name).push(70, 0).push(62, l.color).push(6, l.linetype);
  t.push(0, 'ENDTAB');
  t.push(0, 'TABLE').push(2, 'STYLE').push(70, 1);
  t.push(0, 'STYLE')
    .push(2, 'STANDARD')
    .push(70, 0)
    .push(40, 0)
    .push(41, 1)
    .push(50, 0)
    .push(71, 0);
  t.push(42, 2.5).push(3, 'txt').push(4, '');
  t.push(0, 'ENDTAB');
  t.push(0, 'ENDSEC');
}

function polyline(
  t: DxfTags,
  layer: string,
  pts: readonly (readonly [number, number])[],
  closed: boolean,
  color?: number,
): void {
  t.push(0, 'POLYLINE').push(8, layer);
  if (color !== undefined) t.push(62, color);
  t.push(66, 1)
    .push(10, 0)
    .push(20, 0)
    .push(30, 0)
    .push(70, closed ? 1 : 0);
  for (const p of pts) {
    t.push(0, 'VERTEX').push(8, layer);
    if (color !== undefined) t.push(62, color);
    t.push(10, p[0]).push(20, p[1]).push(30, 0);
  }
  t.push(0, 'SEQEND').push(8, layer);
}

function entity(t: DxfTags, item: DisplayItem, tol: number, geometryOnly: boolean): void {
  const layer = ROLE_LAYERS[item.role];
  const color = item.attention ? 1 : undefined;
  const common = () => {
    t.push(8, layer);
    if (color !== undefined) t.push(62, color);
  };
  switch (item.kind) {
    case 'line':
      t.push(0, 'LINE');
      common();
      t.push(10, item.a[0])
        .push(20, item.a[1])
        .push(30, 0)
        .push(11, item.b[0])
        .push(21, item.b[1])
        .push(31, 0);
      return;
    case 'arc':
      if (Math.abs(item.end - item.start) >= 2 * Math.PI - 1e-9) {
        t.push(0, 'CIRCLE');
        common();
        t.push(10, item.center[0]).push(20, item.center[1]).push(30, 0).push(40, item.radius);
        return;
      }
      t.push(0, 'ARC');
      common();
      t.push(10, item.center[0]).push(20, item.center[1]).push(30, 0).push(40, item.radius);
      t.push(50, deg(item.start)).push(51, deg(item.end));
      return;
    case 'polyline':
      polyline(t, layer, item.points, !!item.closed, color);
      return;
    case 'ellipse':
    case 'spline':
      for (const pts of flattenPrimitive(item, tol)) polyline(t, layer, pts, false, color);
      return;
    case 'fill':
      for (const loop of item.loops) polyline(t, layer, loop, true, color);
      return;
    case 'text': {
      if (geometryOnly) return;
      const { h, v } = textAlign(item);
      t.push(0, 'TEXT');
      common();
      t.push(10, item.at[0]).push(20, item.at[1]).push(30, 0).push(40, item.height);
      t.push(1, dxfText(normalizeText(item.text)))
        .push(50, item.angle)
        .push(7, 'STANDARD');
      if (h || v) t.push(72, h).push(11, item.at[0]).push(21, item.at[1]).push(31, 0).push(73, v);
      return;
    }
  }
}

/** One sheet as DXF R12. */
export function renderDxfR12(
  list: DisplayList,
  style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>,
  options: DxfR12Options = {},
): string {
  const t = new DxfTags();
  header(t, list);
  tables(t, style);
  t.push(0, 'SECTION').push(2, 'ENTITIES');
  for (const item of list.items)
    entity(t, item, options.tolerance ?? 0.01, options.geometryOnly ?? false);
  t.push(0, 'ENDSEC').push(0, 'EOF');
  return t.toString();
}
