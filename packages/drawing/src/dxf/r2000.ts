/**
 * DXF R2000 (AC1015) with handles and owners (owner D4, after the R12 profile): HEADER with
 * `$INSUNITS = 4` (mm), `$MEASUREMENT = 1`, `$LTSCALE = 1`, `$LWDISPLAY = 1` and `$HANDSEED`;
 * the full symbol tables (VPORT, LTYPE with ISO 128 dashes, LAYER with lineweights, STYLE with
 * the drawing font, VIEW, UCS, APPID, DIMSTYLE, BLOCK_RECORD); model and paper space blocks;
 * entities LINE, ARC, CIRCLE, LWPOLYLINE, ELLIPSE, SPLINE (exact, rational when weighted), TEXT
 * and SOLID (arrowheads, datum triangles; dimensions are exploded); OBJECTS with the root
 * dictionary, groups and the Model/Layout1 layouts. Coordinates are sheet mm, y up.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DrawingStyle } from '@wren-cad/contracts';
import type { DisplayItem, DisplayList } from '../annotation/display';
import { normalizeText } from '../annotation/text';
import {
  DxfTags,
  deg,
  dxfText,
  entityLineweight,
  fanTriangles,
  layersFor,
  linetypesFor,
  ROLE_LAYERS,
  textAlign,
} from './common';

export interface DxfR2000Options {
  /** Text style font file (default `osifont.ttf`; CAD falls back to its own font when missing). */
  fontFile?: string;
}

class Handles {
  private next = 1;
  take(): string {
    return (this.next++).toString(16).toUpperCase();
  }
  get seed(): string {
    return this.next.toString(16).toUpperCase();
  }
}

type Style = Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>;

interface Ids {
  vportTable: string;
  ltypeTable: string;
  layerTable: string;
  styleTable: string;
  viewTable: string;
  ucsTable: string;
  appidTable: string;
  dimstyleTable: string;
  blockRecordTable: string;
  modelRecord: string;
  paperRecord: string;
  modelBlock: string;
  modelEnd: string;
  paperBlock: string;
  paperEnd: string;
  rootDict: string;
  groupDict: string;
  layoutDict: string;
  modelLayout: string;
  paperLayout: string;
}

function allocate(h: Handles): Ids {
  const ids = {} as Ids;
  for (const k of [
    'vportTable',
    'ltypeTable',
    'layerTable',
    'styleTable',
    'viewTable',
    'ucsTable',
    'appidTable',
    'dimstyleTable',
    'blockRecordTable',
    'modelRecord',
    'paperRecord',
    'modelBlock',
    'modelEnd',
    'paperBlock',
    'paperEnd',
    'rootDict',
    'groupDict',
    'layoutDict',
    'modelLayout',
    'paperLayout',
  ] as (keyof Ids)[])
    ids[k] = h.take();
  return ids;
}

function table(
  t: DxfTags,
  name: string,
  handle: string,
  count: number,
  body: () => void,
  dimstyle = false,
): void {
  t.push(0, 'TABLE')
    .push(2, name)
    .push(5, handle)
    .push(330, '0')
    .push(100, 'AcDbSymbolTable')
    .push(70, count);
  if (dimstyle) t.push(100, 'AcDbDimStyleTable').push(71, 0);
  body();
  t.push(0, 'ENDTAB');
}

function record(
  t: DxfTags,
  type: string,
  handle: string,
  owner: string,
  subclass: string,
  name: string,
): void {
  t.push(0, type)
    .push(type === 'DIMSTYLE' ? 105 : 5, handle)
    .push(330, owner);
  t.push(100, 'AcDbSymbolTableRecord').push(100, subclass).push(2, name).push(70, 0);
}

function writeHeader(t: DxfTags, list: DisplayList, seed: string): void {
  t.push(0, 'SECTION').push(2, 'HEADER');
  t.push(9, '$ACADVER').push(1, 'AC1015');
  t.push(9, '$DWGCODEPAGE').push(3, 'ANSI_1252');
  t.push(9, '$INSBASE').push(10, 0).push(20, 0).push(30, 0);
  t.push(9, '$EXTMIN').push(10, 0).push(20, 0).push(30, 0);
  t.push(9, '$EXTMAX').push(10, list.width).push(20, list.height).push(30, 0);
  t.push(9, '$LIMMIN').push(10, 0).push(20, 0);
  t.push(9, '$LIMMAX').push(10, list.width).push(20, list.height);
  t.push(9, '$LTSCALE').push(40, 1);
  t.push(9, '$TEXTSTYLE').push(7, 'Standard');
  t.push(9, '$CLAYER').push(8, '0');
  t.push(9, '$CELTYPE').push(6, 'ByLayer');
  t.push(9, '$INSUNITS').push(70, 4);
  t.push(9, '$MEASUREMENT').push(70, 1);
  t.push(9, '$LWDISPLAY').push(290, 1);
  t.push(9, '$HANDSEED').push(5, seed);
  t.push(0, 'ENDSEC');
}

function writeTables(
  t: DxfTags,
  h: Handles,
  ids: Ids,
  list: DisplayList,
  style: Style,
  fontFile: string,
): void {
  t.push(0, 'SECTION').push(2, 'TABLES');
  table(t, 'VPORT', ids.vportTable, 1, () => {
    record(t, 'VPORT', h.take(), ids.vportTable, 'AcDbViewportTableRecord', '*ACTIVE');
    t.push(10, 0).push(20, 0).push(11, 1).push(21, 1);
    t.push(12, list.width / 2)
      .push(22, list.height / 2)
      .push(13, 0)
      .push(23, 0)
      .push(14, 10)
      .push(24, 10);
    t.push(15, 10)
      .push(25, 10)
      .push(16, 0)
      .push(26, 0)
      .push(36, 1)
      .push(17, 0)
      .push(27, 0)
      .push(37, 0);
    t.push(40, list.height * 1.1)
      .push(41, list.width / list.height)
      .push(42, 50)
      .push(43, 0)
      .push(44, 0);
    t.push(50, 0)
      .push(51, 0)
      .push(71, 0)
      .push(72, 100)
      .push(73, 1)
      .push(74, 3)
      .push(75, 0)
      .push(76, 0);
    t.push(77, 0).push(78, 0);
  });
  const lts = linetypesFor(style);
  table(t, 'LTYPE', ids.ltypeTable, lts.length + 3, () => {
    for (const name of ['ByBlock', 'ByLayer', 'Continuous']) {
      record(t, 'LTYPE', h.take(), ids.ltypeTable, 'AcDbLinetypeTableRecord', name);
      t.push(3, name === 'Continuous' ? 'Solid line' : '')
        .push(72, 65)
        .push(73, 0)
        .push(40, 0);
    }
    for (const lt of lts) {
      record(t, 'LTYPE', h.take(), ids.ltypeTable, 'AcDbLinetypeTableRecord', lt.name);
      const total = lt.pattern.reduce((s, x) => s + Math.abs(x), 0);
      t.push(3, lt.description).push(72, 65).push(73, lt.pattern.length).push(40, total);
      for (const e of lt.pattern) t.push(49, e).push(74, 0);
    }
  });
  const layers = layersFor(style);
  table(t, 'LAYER', ids.layerTable, layers.length + 1, () => {
    record(t, 'LAYER', h.take(), ids.layerTable, 'AcDbLayerTableRecord', '0');
    t.push(62, 7).push(6, 'Continuous').push(370, -3);
    for (const l of layers) {
      record(t, 'LAYER', h.take(), ids.layerTable, 'AcDbLayerTableRecord', l.name);
      t.push(62, l.color)
        .push(6, l.linetype === 'CONTINUOUS' ? 'Continuous' : l.linetype)
        .push(370, l.lineweight);
    }
  });
  table(t, 'STYLE', ids.styleTable, 2, () => {
    record(t, 'STYLE', h.take(), ids.styleTable, 'AcDbTextStyleTableRecord', 'Standard');
    t.push(40, 0).push(41, 1).push(50, 0).push(71, 0).push(42, 2.5).push(3, 'txt').push(4, '');
    record(t, 'STYLE', h.take(), ids.styleTable, 'AcDbTextStyleTableRecord', 'OSIFONT');
    t.push(40, 0).push(41, 1).push(50, 0).push(71, 0).push(42, 3.5).push(3, fontFile).push(4, '');
  });
  table(t, 'VIEW', ids.viewTable, 0, () => {});
  table(t, 'UCS', ids.ucsTable, 0, () => {});
  table(t, 'APPID', ids.appidTable, 1, () => {
    record(t, 'APPID', h.take(), ids.appidTable, 'AcDbRegAppTableRecord', 'ACAD');
  });
  table(
    t,
    'DIMSTYLE',
    ids.dimstyleTable,
    1,
    () => {
      record(t, 'DIMSTYLE', h.take(), ids.dimstyleTable, 'AcDbDimStyleTableRecord', 'Standard');
    },
    true,
  );
  table(t, 'BLOCK_RECORD', ids.blockRecordTable, 2, () => {
    record(
      t,
      'BLOCK_RECORD',
      ids.modelRecord,
      ids.blockRecordTable,
      'AcDbBlockTableRecord',
      '*Model_Space',
    );
    t.push(340, ids.modelLayout);
    record(
      t,
      'BLOCK_RECORD',
      ids.paperRecord,
      ids.blockRecordTable,
      'AcDbBlockTableRecord',
      '*Paper_Space',
    );
    t.push(340, ids.paperLayout);
  });
  t.push(0, 'ENDSEC');
}

function writeBlocks(t: DxfTags, ids: Ids): void {
  t.push(0, 'SECTION').push(2, 'BLOCKS');
  const block = (begin: string, end: string, owner: string, name: string, paper: boolean) => {
    t.push(0, 'BLOCK').push(5, begin).push(330, owner).push(100, 'AcDbEntity');
    if (paper) t.push(67, 1);
    t.push(8, '0').push(100, 'AcDbBlockBegin').push(2, name).push(70, 0);
    t.push(10, 0).push(20, 0).push(30, 0).push(3, name).push(1, '');
    t.push(0, 'ENDBLK').push(5, end).push(330, owner).push(100, 'AcDbEntity');
    if (paper) t.push(67, 1);
    t.push(8, '0').push(100, 'AcDbBlockEnd');
  };
  block(ids.modelBlock, ids.modelEnd, ids.modelRecord, '*Model_Space', false);
  block(ids.paperBlock, ids.paperEnd, ids.paperRecord, '*Paper_Space', true);
  t.push(0, 'ENDSEC');
}

function entityHead(
  t: DxfTags,
  type: string,
  h: Handles,
  ids: Ids,
  item: DisplayItem,
  style: Style,
): void {
  t.push(0, type).push(5, h.take()).push(330, ids.modelRecord).push(100, 'AcDbEntity');
  t.push(8, ROLE_LAYERS[item.role]);
  if (item.attention) t.push(62, 1);
  const lw = entityLineweight(item, style);
  if (lw !== undefined) t.push(370, lw);
}

function writeEntity(t: DxfTags, h: Handles, ids: Ids, item: DisplayItem, style: Style): void {
  switch (item.kind) {
    case 'line':
      entityHead(t, 'LINE', h, ids, item, style);
      t.push(100, 'AcDbLine').push(10, item.a[0]).push(20, item.a[1]).push(30, 0);
      t.push(11, item.b[0]).push(21, item.b[1]).push(31, 0);
      return;
    case 'arc': {
      const full = Math.abs(item.end - item.start) >= 2 * Math.PI - 1e-9;
      entityHead(t, full ? 'CIRCLE' : 'ARC', h, ids, item, style);
      t.push(100, 'AcDbCircle')
        .push(10, item.center[0])
        .push(20, item.center[1])
        .push(30, 0)
        .push(40, item.radius);
      if (!full) t.push(100, 'AcDbArc').push(50, deg(item.start)).push(51, deg(item.end));
      return;
    }
    case 'polyline':
      entityHead(t, 'LWPOLYLINE', h, ids, item, style);
      t.push(100, 'AcDbPolyline')
        .push(90, item.points.length)
        .push(70, item.closed ? 1 : 0)
        .push(43, 0);
      for (const p of item.points) t.push(10, p[0]).push(20, p[1]);
      return;
    case 'ellipse': {
      entityHead(t, 'ELLIPSE', h, ids, item, style);
      // Ratio ≤ 1 by definition; the parameters are the same eccentric angles.
      t.push(100, 'AcDbEllipse').push(10, item.center[0]).push(20, item.center[1]).push(30, 0);
      t.push(11, item.major[0]).push(21, item.major[1]).push(31, 0);
      t.push(210, 0).push(220, 0).push(230, 1).push(40, Math.min(1, item.ratio));
      t.push(41, item.start).push(42, item.end);
      return;
    }
    case 'spline': {
      entityHead(t, 'SPLINE', h, ids, item, style);
      const rational = !!item.weights && item.weights.some((w) => w !== 1);
      t.push(100, 'AcDbSpline').push(210, 0).push(220, 0).push(230, 1);
      t.push(70, 8 | (rational ? 4 : 0))
        .push(71, item.degree)
        .push(72, item.knots.length);
      t.push(73, item.poles.length).push(74, 0).push(42, 1e-10).push(43, 1e-10);
      for (const k of item.knots) t.push(40, k);
      if (rational) for (const w of item.weights ?? []) t.push(41, w);
      for (const p of item.poles) t.push(10, p[0]).push(20, p[1]).push(30, 0);
      return;
    }
    case 'fill':
      for (const loop of item.loops) {
        for (const [a, b, c] of fanTriangles(loop)) {
          entityHead(t, 'SOLID', h, ids, item, style);
          t.push(100, 'AcDbTrace');
          t.push(10, (a as [number, number])[0])
            .push(20, (a as [number, number])[1])
            .push(30, 0);
          t.push(11, (b as [number, number])[0])
            .push(21, (b as [number, number])[1])
            .push(31, 0);
          t.push(12, (c as [number, number])[0])
            .push(22, (c as [number, number])[1])
            .push(32, 0);
          t.push(13, (c as [number, number])[0])
            .push(23, (c as [number, number])[1])
            .push(33, 0);
        }
      }
      return;
    case 'text': {
      entityHead(t, 'TEXT', h, ids, item, style);
      const { h: ha, v } = textAlign(item);
      t.push(100, 'AcDbText')
        .push(10, item.at[0])
        .push(20, item.at[1])
        .push(30, 0)
        .push(40, item.height);
      t.push(1, dxfText(normalizeText(item.text)))
        .push(50, item.angle)
        .push(7, 'OSIFONT');
      if (ha || v) t.push(72, ha).push(11, item.at[0]).push(21, item.at[1]).push(31, 0);
      t.push(100, 'AcDbText');
      if (v) t.push(73, v);
      return;
    }
  }
}

function plotSettings(t: DxfTags, list: DisplayList): void {
  t.push(100, 'AcDbPlotSettings').push(1, '').push(2, 'none_device').push(4, '').push(6, '');
  t.push(40, 0).push(41, 0).push(42, 0).push(43, 0).push(44, list.width).push(45, list.height);
  t.push(46, 0)
    .push(47, 0)
    .push(48, 0)
    .push(49, 0)
    .push(140, 0)
    .push(141, 0)
    .push(142, 1)
    .push(143, 1);
  t.push(70, 688).push(72, 1).push(73, 0).push(74, 5).push(7, '').push(75, 16).push(147, 1);
  t.push(148, 0).push(149, 0);
}

function layout(
  t: DxfTags,
  handle: string,
  ids: Ids,
  name: string,
  tab: number,
  block: string,
  list: DisplayList,
): void {
  t.push(0, 'LAYOUT')
    .push(5, handle)
    .push(102, '{ACAD_REACTORS')
    .push(330, ids.layoutDict)
    .push(102, '}');
  t.push(330, ids.layoutDict);
  plotSettings(t, list);
  t.push(100, 'AcDbLayout').push(1, name).push(70, 1).push(71, tab);
  t.push(10, 0).push(20, 0).push(11, list.width).push(21, list.height);
  t.push(12, 0).push(22, 0).push(32, 0);
  t.push(14, 0).push(24, 0).push(34, 0).push(15, list.width).push(25, list.height).push(35, 0);
  t.push(146, 0).push(13, 0).push(23, 0).push(33, 0);
  t.push(16, 1).push(26, 0).push(36, 0).push(17, 0).push(27, 1).push(37, 0).push(76, 0);
  t.push(330, block);
}

function writeObjects(t: DxfTags, ids: Ids, list: DisplayList): void {
  t.push(0, 'SECTION').push(2, 'OBJECTS');
  t.push(0, 'DICTIONARY')
    .push(5, ids.rootDict)
    .push(330, '0')
    .push(100, 'AcDbDictionary')
    .push(281, 1);
  t.push(3, 'ACAD_GROUP').push(350, ids.groupDict).push(3, 'ACAD_LAYOUT').push(350, ids.layoutDict);
  t.push(0, 'DICTIONARY')
    .push(5, ids.groupDict)
    .push(102, '{ACAD_REACTORS')
    .push(330, ids.rootDict)
    .push(102, '}');
  t.push(330, ids.rootDict).push(100, 'AcDbDictionary').push(281, 1);
  t.push(0, 'DICTIONARY')
    .push(5, ids.layoutDict)
    .push(102, '{ACAD_REACTORS')
    .push(330, ids.rootDict)
    .push(102, '}');
  t.push(330, ids.rootDict).push(100, 'AcDbDictionary').push(281, 1);
  t.push(3, 'Layout1').push(350, ids.paperLayout).push(3, 'Model').push(350, ids.modelLayout);
  layout(t, ids.modelLayout, ids, 'Model', 0, ids.modelRecord, list);
  layout(t, ids.paperLayout, ids, 'Layout1', 1, ids.paperRecord, list);
  t.push(0, 'ENDSEC');
}

/** One sheet as DXF R2000. */
export function renderDxfR2000(
  list: DisplayList,
  style: Style,
  options: DxfR2000Options = {},
): string {
  const h = new Handles();
  const ids = allocate(h);
  // Tables and entities take their handles first; the header (with $HANDSEED) is written last
  // and prepended.
  const tablesT = new DxfTags();
  writeTables(tablesT, h, ids, list, style, options.fontFile ?? 'osifont.ttf');
  const rest = new DxfTags();
  rest.push(0, 'SECTION').push(2, 'CLASSES').push(0, 'ENDSEC');
  const restTables = tablesT.toString();
  const blocksT = new DxfTags();
  writeBlocks(blocksT, ids);
  const entitiesT = new DxfTags();
  entitiesT.push(0, 'SECTION').push(2, 'ENTITIES');
  for (const item of list.items) writeEntity(entitiesT, h, ids, item, style);
  entitiesT.push(0, 'ENDSEC');
  const objectsT = new DxfTags();
  writeObjects(objectsT, ids, list);
  objectsT.push(0, 'EOF');
  const headerT = new DxfTags();
  writeHeader(headerT, list, h.seed);
  return (
    headerT.toString() +
    rest.toString() +
    restTables +
    blocksT.toString() +
    entitiesT.toString() +
    objectsT.toString()
  );
}
