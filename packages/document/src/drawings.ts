// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Drawings (M4, ADR-090): structural validation, the deterministic normaliser that runs on load
 * and after a merge, 0.001 mm rounding of sheet numbers, and `planDuplicateDrawing`.
 *
 * Two layers, as with folders: structure always fails a load (`checkDrawing`); dangling references
 * inside a drawing are repaired by `normalizeDrawings` (a text merge can produce them) or shown as
 * needs attention by the drawing package. They never fail a load.
 */

import type {
  AnnotationPlacement,
  Drawing,
  DrawingView,
  Id,
  Markup,
  Part,
  SheetNote,
  TitleBlockSlot,
  Vec2,
  WrenDoc,
} from '@wren-cad/contracts';
import { GPS_STANDARDS, gpsFamily, REF_POINTS, SURFACE_FINISH_STANDARDS } from './annotations';
import { Checker, isObj, isSortedById, type Obj, sortedById } from './check';

// ---------------------------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------------------------

export const TITLE_BLOCK_SLOTS = [
  'title',
  'partNumber',
  'description',
  'material',
  'mass',
  'configuration',
  'scale',
  'projection',
  'units',
  'standard',
  'generalTolerance',
  'revision',
  'sheet',
  'date',
  'owner',
  'drawnBy',
  'checkedBy',
  'approvedBy',
  'documentType',
  'documentStatus',
  'language',
] as const satisfies readonly TitleBlockSlot[];

export const TEMPLATE_IDS = ['iso-5457', 'asme-y14.1'] as const;

/**
 * The newest layout generator version per template (`TemplateBinding.version` pins one). Old
 * versions stay in code, so a stored version at or below this is valid. Raised by the drawing
 * package when it ships a new layout.
 */
export const LATEST_TEMPLATE_VERSION: Readonly<Record<(typeof TEMPLATE_IDS)[number], number>> = {
  'iso-5457': 1,
  'asme-y14.1': 1,
};

export const LINE_GROUPS = ['iso-0.25', 'iso-0.35', 'iso-0.5', 'iso-0.7', 'asme-0.6'] as const;
export const SHEET_SIZES = [
  'A0',
  'A1',
  'A2',
  'A3',
  'A4',
  'ANSI-A',
  'ANSI-B',
  'ANSI-C',
  'ANSI-D',
  'ANSI-E',
] as const;
const ARROW_KINDS = ['filledClosed', 'open', 'oblique', 'dot'] as const;
const HATCH_PATTERNS = ['iso-general', 'iso-metal-cross', 'solid', 'none'] as const;
const NAMED_VIEWS = ['front', 'back', 'left', 'right', 'top', 'bottom'] as const;
const ISO_CORNERS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const;
const SIDES = ['top', 'bottom', 'left', 'right'] as const;
const VIEW_KINDS = ['base', 'projected', 'iso', 'section', 'detail'] as const;
const PART_COLUMNS = ['partNumber', 'description', 'material', 'mass', 'configuration'] as const;
const PROJECTIONS = ['first', 'third'] as const;

/** Layout kinds each view kind allows. */
export const VIEW_LAYOUTS: Readonly<Record<(typeof VIEW_KINDS)[number], readonly string[]>> = {
  base: ['free'],
  projected: ['aligned', 'free'],
  iso: ['free'],
  section: ['aligned', 'free'],
  detail: ['free'],
};

// ---------------------------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------------------------

export function checkTitleFields(c: Checker, v: unknown, at: string): void {
  if (!c.obj(v, at)) return;
  for (const [k, x] of Object.entries(v)) {
    if (!(TITLE_BLOCK_SLOTS as readonly string[]).includes(k))
      c.err(`${at}.${k} is not a title block slot`);
    else c.str(x, `${at}.${k}`);
  }
}

export function checkStandard(c: Checker, s: unknown, at: string): void {
  if (!c.obj(s, at)) return;
  const fam = c.oneOf(s.family, `${at}.family`, ['iso', 'asme'] as const);
  if (c.oneOf(s.gps, `${at}.gps`, GPS_STANDARDS) && fam && gpsFamily(s.gps) !== s.family) {
    c.err(`${at}.gps ‘${s.gps}’ does not belong to the ${String(s.family).toUpperCase()} family`);
  }
  c.oneOf(s.surfaceFinish, `${at}.surfaceFinish`, SURFACE_FINISH_STANDARDS);
  if (s.generalTolerance !== undefined) c.str(s.generalTolerance, `${at}.generalTolerance`);
}

/** `wren.project.json` → `drawingDefaults`. */
export function checkDrawingDefaults(c: Checker, d: unknown, at: string): void {
  if (!c.obj(d, at)) return;
  checkStandard(c, d.standard, `${at}.standard`);
  c.oneOf(d.projection, `${at}.projection`, PROJECTIONS);
  if (d.fields !== undefined) checkTitleFields(c, d.fields, `${at}.fields`);
}

const positive = { exclusiveMin: 0 } as const;

function checkDisplay(c: Checker, d: unknown, at: string, partial: boolean): void {
  if (!c.obj(d, at)) return;
  const need = (k: string): boolean => {
    if (d[k] !== undefined) return true;
    if (!partial) c.err(`${at}.${k} is required`);
    return false;
  };
  if (need('lines')) c.oneOf(d.lines, `${at}.lines`, ['visible', 'visibleAndHidden'] as const);
  if (need('tangentEdges'))
    c.oneOf(d.tangentEdges, `${at}.tangentEdges`, ['visible', 'thin', 'off'] as const);
  for (const k of ['centerMarks', 'centerLines', 'threads'] as const) {
    if (need(k)) c.bool(d[k], `${at}.${k}`);
  }
}

export function checkStyle(c: Checker, s: unknown, at: string): void {
  if (!c.obj(s, at)) return;
  c.oneOf(s.lineGroup, `${at}.lineGroup`, LINE_GROUPS);
  if (s.lineWidths !== undefined && c.obj(s.lineWidths, `${at}.lineWidths`)) {
    c.num(s.lineWidths.thick, `${at}.lineWidths.thick`, positive);
    c.num(s.lineWidths.thin, `${at}.lineWidths.thin`, positive);
  }
  if (c.obj(s.text, `${at}.text`)) {
    for (const k of ['dimension', 'note', 'viewLabel', 'title'] as const) {
      c.num(s.text[k], `${at}.text.${k}`, positive);
    }
  }
  c.nonEmpty(s.font, `${at}.font`);
  if (c.obj(s.dimension, `${at}.dimension`)) {
    const d = s.dimension;
    for (const k of ['extensionGap', 'extensionOvershoot', 'firstLane', 'laneSpacing'] as const) {
      c.num(d[k], `${at}.dimension.${k}`, positive);
    }
    if (c.obj(d.arrow, `${at}.dimension.arrow`)) {
      c.oneOf(d.arrow.kind, `${at}.dimension.arrow.kind`, ARROW_KINDS);
      c.num(d.arrow.length, `${at}.dimension.arrow.length`, positive);
      c.num(d.arrow.angle, `${at}.dimension.arrow.angle`, positive);
    }
    c.oneOf(d.textOrientation, `${at}.dimension.textOrientation`, [
      'aligned',
      'unidirectional',
    ] as const);
    c.oneOf(d.textPosition, `${at}.dimension.textPosition`, ['above', 'inline'] as const);
  }
  if (c.obj(s.numbers, `${at}.numbers`)) {
    const n = s.numbers;
    c.oneOf(n.decimal, `${at}.numbers.decimal`, ['.', ','] as const);
    c.num(n.lengthPrecision, `${at}.numbers.lengthPrecision`, { int: true, min: 0, max: 6 });
    c.num(n.anglePrecision, `${at}.numbers.anglePrecision`, { int: true, min: 0, max: 6 });
    c.oneOf(n.trailingZeros, `${at}.numbers.trailingZeros`, ['strip', 'keep'] as const);
    c.oneOf(n.angleFormat, `${at}.numbers.angleFormat`, ['decimal', 'dms'] as const);
  }
  if (c.obj(s.hatch, `${at}.hatch`)) {
    c.oneOf(s.hatch.pattern, `${at}.hatch.pattern`, HATCH_PATTERNS);
    c.num(s.hatch.angle, `${at}.hatch.angle`); // an angle: any finite value (0 and −45 are normal)
    c.num(s.hatch.spacing, `${at}.hatch.spacing`, positive);
  }
  checkDisplay(c, s.view, `${at}.view`, false);
}

export function checkAnchored(c: Checker, p: unknown, at: string): void {
  if (!c.obj(p, at)) return;
  if (!c.oneOf(p.kind, `${at}.kind`, ['free', 'ref'] as const)) return;
  if (p.kind === 'free') {
    c.vec2(p.at, `${at}.at`);
    return;
  }
  if (!c.obj(p.ref, `${at}.ref`)) return;
  c.nonEmpty(p.ref.name, `${at}.ref.name`);
  c.oneOf(p.ref.kind, `${at}.ref.kind`, ['face', 'edge', 'vertex', 'region', 'body'] as const);
  if (p.point !== undefined) c.oneOf(p.point, `${at}.point`, REF_POINTS);
  if (p.offset !== undefined) c.vec2(p.offset, `${at}.offset`);
}

export function checkView(c: Checker, v: unknown, at: string): void {
  if (!c.obj(v, at)) return;
  c.id(v.id, `${at}.id`);
  c.nonEmpty(v.sheetId, `${at}.sheetId`);
  if (!c.oneOf(v.kind, `${at}.kind`, VIEW_KINDS)) return;
  if (v.label !== undefined) c.str(v.label, `${at}.label`);
  if (v.showLabel !== undefined) c.bool(v.showLabel, `${at}.showLabel`);
  if (v.scale !== undefined) c.str(v.scale, `${at}.scale`);
  if (v.display !== undefined) checkDisplay(c, v.display, `${at}.display`, true);
  if (v.configurationId !== undefined && v.configurationId !== null) {
    c.str(v.configurationId, `${at}.configurationId`);
  }
  if (c.obj(v.layout, `${at}.layout`)) {
    const allowed = VIEW_LAYOUTS[v.kind];
    if (c.oneOf(v.layout.kind, `${at}.layout.kind`, allowed)) {
      if (v.layout.kind === 'free') c.vec2(v.layout.position, `${at}.layout.position`);
      else c.num(v.layout.distance, `${at}.layout.distance`);
    }
  }
  if (v.kind !== 'base') c.nonEmpty(v.parentId, `${at}.parentId`);
  switch (v.kind) {
    case 'base': {
      const o = v.orientation;
      if (!c.obj(o, `${at}.orientation`)) break;
      if (!c.oneOf(o.kind, `${at}.orientation.kind`, ['named', 'isometric', 'matrix'] as const))
        break;
      if (o.kind === 'named') c.oneOf(o.name, `${at}.orientation.name`, NAMED_VIEWS);
      if (o.kind === 'isometric') c.oneOf(o.corner, `${at}.orientation.corner`, ISO_CORNERS);
      if (o.kind === 'matrix') {
        c.vec3(o.x, `${at}.orientation.x`);
        c.vec3(o.y, `${at}.orientation.y`);
      }
      if (v.rotation !== undefined) c.str(v.rotation, `${at}.rotation`);
      break;
    }
    case 'projected':
      c.oneOf(v.from, `${at}.from`, SIDES);
      break;
    case 'iso':
      c.oneOf(v.corner, `${at}.corner`, ISO_CORNERS);
      break;
    case 'section':
      c.nonEmpty(v.letter, `${at}.letter`);
      if (c.arr(v.cut, `${at}.cut`)) {
        if (v.cut.length < 2) c.err(`${at}.cut needs at least two points`);
        v.cut.forEach((p, i) => {
          checkAnchored(c, p, `${at}.cut[${i}]`);
        });
      }
      c.oneOf(v.look, `${at}.look`, ['left', 'right'] as const);
      if (v.depth !== undefined) c.oneOf(v.depth, `${at}.depth`, ['full', 'slice'] as const);
      if (v.hatch !== undefined && c.obj(v.hatch, `${at}.hatch`)) {
        if (v.hatch.pattern !== undefined)
          c.oneOf(v.hatch.pattern, `${at}.hatch.pattern`, HATCH_PATTERNS);
        if (v.hatch.angle !== undefined) c.num(v.hatch.angle, `${at}.hatch.angle`);
        if (v.hatch.spacing !== undefined) c.num(v.hatch.spacing, `${at}.hatch.spacing`, positive);
      }
      break;
    case 'detail':
      c.nonEmpty(v.letter, `${at}.letter`);
      checkAnchored(c, v.center, `${at}.center`);
      c.num(v.radius, `${at}.radius`, positive);
      if (v.scale === undefined) c.err(`${at}.scale is required for a detail view`);
      break;
  }
}

export function checkPlacement(c: Checker, p: unknown, at: string): void {
  if (!c.obj(p, at)) return;
  c.id(p.id, `${at}.id`);
  c.nonEmpty(p.viewId, `${at}.viewId`);
  c.nonEmpty(p.annotationId, `${at}.annotationId`);
  if (c.obj(p.layout, `${at}.layout`)) {
    const l = p.layout;
    if (
      c.oneOf(l.kind, `${at}.layout.kind`, ['lane', 'offset', 'radial', 'arc', 'leader'] as const)
    ) {
      switch (l.kind) {
        case 'lane':
          c.oneOf(l.side, `${at}.layout.side`, SIDES);
          c.num(l.lane, `${at}.layout.lane`, { int: true, min: 0 });
          break;
        case 'offset':
          c.num(l.distance, `${at}.layout.distance`);
          break;
        case 'radial':
          c.num(l.angle, `${at}.layout.angle`);
          c.num(l.distance, `${at}.layout.distance`);
          break;
        case 'arc':
          c.num(l.radius, `${at}.layout.radius`, positive);
          if (l.opposite !== undefined) c.bool(l.opposite, `${at}.layout.opposite`);
          break;
        case 'leader':
          checkLeader(c, l, `${at}.layout`);
          break;
      }
    }
  }
  if (p.text !== undefined && c.obj(p.text, `${at}.text`) && p.text.shift !== undefined) {
    c.num(p.text.shift, `${at}.text.shift`);
  }
  if (p.witness !== undefined && c.obj(p.witness, `${at}.witness`)) {
    if (p.witness.flip !== undefined) c.bool(p.witness.flip, `${at}.witness.flip`);
    const h = p.witness.hide;
    if (
      h !== undefined &&
      !(Array.isArray(h) && h.length === 2 && h.every((x) => typeof x === 'boolean'))
    ) {
      c.err(`${at}.witness.hide must be two booleans`);
    }
  }
  if (p.arrows !== undefined)
    c.oneOf(p.arrows, `${at}.arrows`, ['auto', 'inside', 'outside'] as const);
}

function checkLeader(c: Checker, l: Obj, at: string): void {
  const a = l.attach;
  if (
    c.obj(a, `${at}.attach`) &&
    c.oneOf(a.kind, `${at}.attach.kind`, ['ref', 'placement', 'dimensionLine'] as const)
  ) {
    if (a.kind === 'ref') {
      c.num(a.index, `${at}.attach.index`, { int: true, min: 0 });
      // Outside [0, 1] = on the edge's extension line (ADR-094), at most ten edge lengths out.
      if (a.t !== undefined) c.num(a.t, `${at}.attach.t`, { min: -10, max: 11 });
    } else {
      c.nonEmpty(a.placementId, `${at}.attach.placementId`);
      if (a.kind === 'dimensionLine') c.num(a.t, `${at}.attach.t`, { min: 0, max: 1 });
    }
  }
  if (l.bends !== undefined && c.arr(l.bends, `${at}.bends`)) {
    l.bends.forEach((b, i) => {
      c.vec2(b, `${at}.bends[${i}]`);
    });
  }
  c.vec2(l.text, `${at}.text`);
  if (l.landing !== undefined)
    c.oneOf(l.landing, `${at}.landing`, ['auto', 'left', 'right'] as const);
}

export function checkTable(c: Checker, t: unknown, at: string): void {
  if (!c.obj(t, at)) return;
  c.id(t.id, `${at}.id`);
  c.nonEmpty(t.sheetId, `${at}.sheetId`);
  c.vec2(t.position, `${at}.position`);
  c.oneOf(t.anchor, `${at}.anchor`, ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const);
  if (!c.oneOf(t.kind, `${at}.kind`, ['partProperties', 'holeTable'] as const)) return;
  if (t.kind === 'partProperties') {
    if (c.arr(t.columns, `${at}.columns`)) {
      t.columns.forEach((k, i) => {
        c.oneOf(k, `${at}.columns[${i}]`, PART_COLUMNS);
      });
    }
    if (
      c.obj(t.rows, `${at}.rows`) &&
      c.oneOf(t.rows.kind, `${at}.rows.kind`, ['drawing', 'configurations'] as const)
    ) {
      if (
        t.rows.kind === 'configurations' &&
        c.arr(t.rows.configurations, `${at}.rows.configurations`)
      ) {
        t.rows.configurations.forEach((k, i) => {
          if (k !== null) c.str(k, `${at}.rows.configurations[${i}]`);
        });
      }
    }
    if (t.massUnit !== undefined) c.oneOf(t.massUnit, `${at}.massUnit`, ['g', 'kg'] as const);
  } else {
    c.nonEmpty(t.viewId, `${at}.viewId`);
    checkAnchored(c, t.origin, `${at}.origin`);
    if (t.holes !== 'all') {
      if (c.arr(t.holes, `${at}.holes`))
        t.holes.forEach((h, i) => {
          c.nonEmpty(h, `${at}.holes[${i}]`);
        });
    }
  }
}

export function checkMarkup(c: Checker, m: unknown, at: string): void {
  if (!c.obj(m, at)) return;
  c.id(m.id, `${at}.id`);
  c.nonEmpty(m.sheetId, `${at}.sheetId`);
  c.str(m.versionId, `${at}.versionId`);
  c.str(m.author, `${at}.author`);
  c.str(m.at, `${at}.at`);
  if (c.arr(m.strokes, `${at}.strokes`)) {
    m.strokes.forEach((s, i) => {
      const sa = `${at}.strokes[${i}]`;
      if (!c.obj(s, sa)) return;
      c.num(s.width, `${sa}.width`, positive);
      if (c.arr(s.points, `${sa}.points`))
        s.points.forEach((p, j) => {
          c.vec2(p, `${sa}.points[${j}]`);
        });
    });
  }
  if (m.text !== undefined) c.str(m.text, `${at}.text`);
  if (m.resolved !== undefined) c.bool(m.resolved, `${at}.resolved`);
  if (m.anchor !== undefined && c.obj(m.anchor, `${at}.anchor`)) {
    if (m.anchor.placementId !== undefined)
      c.nonEmpty(m.anchor.placementId, `${at}.anchor.placementId`);
    if (m.anchor.viewId !== undefined) c.nonEmpty(m.anchor.viewId, `${at}.anchor.viewId`);
  }
}

/** Structural checks of one drawing. Dangling references are not errors (see the module note). */
export function checkDrawing(c: Checker, d: unknown, at: string): void {
  if (!c.obj(d, at)) return;
  c.id(d.id, `${at}.id`);
  c.str(d.name, `${at}.name`);
  if (c.obj(d.subject, `${at}.subject`)) {
    if (d.subject.kind !== 'part') c.err(`${at}.subject.kind must be ‘part’`);
    c.nonEmpty(d.subject.partId, `${at}.subject.partId`);
  }
  if (d.configurationId !== undefined) c.nonEmpty(d.configurationId, `${at}.configurationId`);
  checkStandard(c, d.standard, `${at}.standard`);
  c.oneOf(d.projection, `${at}.projection`, PROJECTIONS);
  if (d.units !== 'mm') c.err(`${at}.units must be ‘mm’`);
  checkStyle(c, d.style, `${at}.style`);
  if (c.obj(d.template, `${at}.template`)) {
    const t = d.template;
    if (c.oneOf(t.id, `${at}.template.id`, TEMPLATE_IDS)) {
      c.num(t.version, `${at}.template.version`, {
        int: true,
        min: 1,
        max: LATEST_TEMPLATE_VERSION[t.id],
      });
    }
    if (t.fields !== undefined) checkTitleFields(c, t.fields, `${at}.template.fields`);
  }
  if (c.arr(d.sheets, `${at}.sheets`)) {
    if (d.sheets.length === 0) c.err(`${at}.sheets needs at least one sheet`);
    d.sheets.forEach((s, i) => {
      checkSheet(c, s, `${at}.sheets[${i}]`);
    });
  }
  const each = (
    key: string,
    check: (c: Checker, v: unknown, at: string) => void,
    optional = false,
  ): void => {
    const list = d[key];
    if (list === undefined && optional) return;
    if (c.arr(list, `${at}.${key}`))
      list.forEach((v, i) => {
        check(c, v, `${at}.${key}[${i}]`);
      });
  };
  each('views', checkView);
  each('placements', checkPlacement);
  each('centerMarks', checkCenterMark);
  each('tables', checkTable);
  each('notes', checkNote);
  each('markup', checkMarkup, true);
}

export function checkSheet(c: Checker, s: unknown, at: string): void {
  if (!c.obj(s, at)) return;
  c.id(s.id, `${at}.id`);
  c.str(s.name, `${at}.name`);
  c.str(s.scale, `${at}.scale`);
  if (c.obj(s.format, `${at}.format`)) {
    const size = s.format.size;
    if (isObj(size)) {
      c.num(size.width, `${at}.format.size.width`, positive);
      c.num(size.height, `${at}.format.size.height`, positive);
    } else c.oneOf(size, `${at}.format.size`, SHEET_SIZES);
    c.oneOf(s.format.orientation, `${at}.format.orientation`, ['landscape', 'portrait'] as const);
  }
  if (s.fields !== undefined) checkTitleFields(c, s.fields, `${at}.fields`);
}

export function checkCenterMark(c: Checker, m: unknown, at: string): void {
  if (!c.obj(m, at)) return;
  c.id(m.id, `${at}.id`);
  c.nonEmpty(m.viewId, `${at}.viewId`);
  c.oneOf(m.kind, `${at}.kind`, ['centerMark', 'centerLine', 'boltCircle'] as const);
  if (c.arr(m.refs, `${at}.refs`)) {
    m.refs.forEach((r, i) => {
      if (!isObj(r) || typeof r.name !== 'string' || r.name === '')
        c.err(`${at}.refs[${i}] must be an entity reference`);
    });
  }
}

export function checkNote(c: Checker, n: unknown, at: string): void {
  if (!c.obj(n, at)) return;
  c.id(n.id, `${at}.id`);
  c.nonEmpty(n.sheetId, `${at}.sheetId`);
  c.vec2(n.position, `${at}.position`);
  c.str(n.text, `${at}.text`);
  if (n.height !== undefined) c.num(n.height, `${at}.height`, positive);
  if (n.width !== undefined) c.num(n.width, `${at}.width`, positive);
}

/** Structural problems of one drawing (empty = fine). */
export function drawingProblems(d: unknown, at = 'drawing'): string[] {
  const c = new Checker();
  checkDrawing(c, d, at);
  return c.errs;
}

// ---------------------------------------------------------------------------------------------
// Rounding (sheet mm to 0.001)
// ---------------------------------------------------------------------------------------------

/** Rounds a sheet quantity to 0.001 mm so diffs stay quiet and merges stay deterministic. */
export const roundSheet = (x: number): number => {
  const r = Math.round(x * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};
const rv = (v: Vec2): Vec2 => [roundSheet(v[0]), roundSheet(v[1])];

function roundDeep<T>(v: T): T {
  if (typeof v === 'number') return roundSheet(v) as T;
  if (Array.isArray(v)) return v.map(roundDeep) as T;
  if (isObj(v))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, roundDeep(x)])) as T;
  return v;
}

/** The view with its sheet quantities rounded (part-mm fields and unit vectors are left alone). */
export function roundView(v: DrawingView): DrawingView {
  const out = { ...v } as DrawingView;
  if (out.layout.kind === 'free') {
    (out as { layout: unknown }).layout = { ...out.layout, position: rv(out.layout.position) };
  } else {
    (out as { layout: unknown }).layout = {
      ...out.layout,
      distance: roundSheet(out.layout.distance),
    };
  }
  return out;
}

export function roundPlacement(p: AnnotationPlacement): AnnotationPlacement {
  const l = p.layout;
  let layout = l;
  switch (l.kind) {
    case 'offset':
      layout = { ...l, distance: roundSheet(l.distance) };
      break;
    case 'radial':
      layout = { ...l, angle: roundSheet(l.angle), distance: roundSheet(l.distance) };
      break;
    case 'arc':
      layout = { ...l, radius: roundSheet(l.radius) };
      break;
    case 'leader':
      layout = {
        ...l,
        text: rv(l.text),
        ...(l.bends ? { bends: l.bends.map(rv) } : {}),
      };
      break;
    case 'lane':
      break;
  }
  const out: AnnotationPlacement = { ...p, layout };
  if (p.text?.shift !== undefined) out.text = { ...p.text, shift: roundSheet(p.text.shift) };
  return out;
}

export function roundTable<T extends { position: Vec2 }>(t: T): T {
  return { ...t, position: rv(t.position) };
}

export function roundNote(n: SheetNote): SheetNote {
  return {
    ...n,
    position: rv(n.position),
    ...(n.height !== undefined ? { height: roundSheet(n.height) } : {}),
    ...(n.width !== undefined ? { width: roundSheet(n.width) } : {}),
  };
}

export function roundMarkup(m: Markup): Markup {
  return {
    ...m,
    strokes: m.strokes.map((s) => ({ points: s.points.map(rv), width: roundSheet(s.width) })),
  };
}

/** The drawing with every sheet-mm quantity rounded to 0.001 mm. Idempotent. */
export function roundDrawing(d: Drawing): Drawing {
  const out: Drawing = {
    ...d,
    style: roundDeep(d.style),
    sheets: d.sheets.map((s) =>
      isObj(s.format.size) ? { ...s, format: { ...s.format, size: roundDeep(s.format.size) } } : s,
    ),
    views: d.views.map(roundView),
    placements: d.placements.map(roundPlacement),
    tables: d.tables.map(roundTable),
    notes: d.notes.map(roundNote),
  };
  if (d.markup) out.markup = d.markup.map(roundMarkup);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------------------------

export interface DrawingNote {
  kind:
    | 'placementDropped'
    | 'duplicatePlacementDropped'
    | 'viewMovedToFirstSheet'
    | 'itemMovedToFirstSheet'
    | 'centerMarkDropped'
    | 'tableDropped'
    | 'markupAnchorCleared';
  drawingId: Id;
  message: string;
}

/**
 * Puts one drawing in canonical form and repairs dangling references, deterministically (the same
 * input always gives the same output, whatever the order of the input collections):
 *
 *  - a placement whose view, or whose annotation in the subject part, is missing is dropped (only
 *    when the subject part exists; otherwise the drawing is left intact);
 *  - two placements with the same (view, annotation): the smaller id stays;
 *  - a view, table, note or markup whose sheet is missing moves to the first sheet, layout kept;
 *  - a centre mark or hole table whose view is missing is dropped;
 *  - a markup anchor to a missing placement or view is cleared (the markup stays);
 *  - a parent that is missing or cyclic is *kept* (needs attention in the drawing package);
 *  - unordered collections are sorted by id; sheet quantities are rounded to 0.001 mm.
 */
export function normalizeDrawing(
  d: Drawing,
  part: Part | undefined,
  notes: DrawingNote[] = [],
): Drawing {
  const note = (kind: DrawingNote['kind'], message: string): void => {
    notes.push({ kind, drawingId: d.id, message });
  };
  const label = `‘${d.name}’`;
  const first = d.sheets[0]?.id;
  const sheetIds = new Set(d.sheets.map((s) => s.id));
  const sheetOf = <T extends { sheetId: Id }>(x: T, kind: DrawingNote['kind'], what: string): T => {
    if (sheetIds.has(x.sheetId) || first === undefined) return x;
    note(kind, `Moved ${what} to the first sheet of ${label} (its sheet was missing)`);
    return { ...x, sheetId: first };
  };

  const views = sortedById(d.views.map((v) => sheetOf(v, 'viewMovedToFirstSheet', 'a view')));
  const viewIds = new Set(views.map((v) => v.id));
  const annotationIds = part ? new Set((part.annotations ?? []).map((a) => a.id)) : undefined;

  let placements = sortedById(d.placements);
  if (annotationIds) {
    placements = placements.filter((p) => {
      if (viewIds.has(p.viewId) && annotationIds.has(p.annotationId)) return true;
      note(
        'placementDropped',
        `Dropped a placement in ${label} (its ${viewIds.has(p.viewId) ? 'annotation' : 'view'} is missing)`,
      );
      return false;
    });
  }
  const seen = new Map<string, Id>();
  placements = placements.filter((p) => {
    const key = `${p.viewId}\u0000${p.annotationId}`;
    if (!seen.has(key)) {
      seen.set(key, p.id);
      return true;
    }
    note(
      'duplicatePlacementDropped',
      `Dropped a duplicate placement in ${label} (kept the earlier id)`,
    );
    return false;
  });
  const placementIds = new Set(placements.map((p) => p.id));

  const centerMarks = sortedById(d.centerMarks).filter((m) => {
    if (viewIds.has(m.viewId)) return true;
    note('centerMarkDropped', `Dropped a centre mark in ${label} (its view is missing)`);
    return false;
  });
  const tables = sortedById(
    d.tables.map((t) => sheetOf(t, 'itemMovedToFirstSheet', 'a table')),
  ).filter((t) => {
    if (t.kind !== 'holeTable' || viewIds.has(t.viewId)) return true;
    note('tableDropped', `Dropped a hole table in ${label} (its view is missing)`);
    return false;
  });
  const notesList = sortedById(d.notes.map((n) => sheetOf(n, 'itemMovedToFirstSheet', 'a note')));

  const out: Drawing = { ...d, views, placements, centerMarks, tables, notes: notesList };
  if (d.markup) {
    out.markup = sortedById(
      d.markup.map((m) => {
        const moved = sheetOf(m, 'itemMovedToFirstSheet', 'a markup');
        const a = moved.anchor;
        if (!a) return moved;
        const keep: NonNullable<Markup['anchor']> = {};
        if (a.placementId !== undefined && placementIds.has(a.placementId))
          keep.placementId = a.placementId;
        if (a.viewId !== undefined && viewIds.has(a.viewId)) keep.viewId = a.viewId;
        if (keep.placementId === a.placementId && keep.viewId === a.viewId) return moved;
        note(
          'markupAnchorCleared',
          `Cleared a markup anchor in ${label} (what it pointed at is gone)`,
        );
        const { anchor: _drop, ...rest } = moved;
        return Object.keys(keep).length > 0 ? { ...rest, anchor: keep } : rest;
      }),
    );
  }
  const rounded = roundDrawing(out);
  return JSON.stringify(rounded) === JSON.stringify(d) ? d : rounded;
}

/**
 * Normalises every drawing of a document (load and after a merge). Returns the same document
 * object when nothing changed. `notes` say what was repaired.
 */
export function normalizeDrawings(doc: WrenDoc): { doc: WrenDoc; notes: DrawingNote[] } {
  const notes: DrawingNote[] = [];
  let changed = false;
  const drawings = doc.drawings.map((d) => {
    const part = doc.parts.find((p) => p.id === d.subject.partId);
    const n = normalizeDrawing(d, part, notes);
    if (n !== d) changed = true;
    return n;
  });
  return { doc: changed ? { ...doc, drawings } : doc, notes };
}

/** Is this drawing's unordered content already in canonical order? (cheap pre-check) */
export function drawingIsSorted(d: Drawing): boolean {
  return (
    isSortedById(d.views) &&
    isSortedById(d.placements) &&
    isSortedById(d.centerMarks) &&
    isSortedById(d.tables) &&
    isSortedById(d.notes) &&
    (d.markup === undefined || isSortedById(d.markup))
  );
}

// ---------------------------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------------------------

/** Every id a drawing owns besides its own: sheets, views, placements, marks, tables, notes. */
export function drawingContentIds(d: Drawing): Id[] {
  return [
    ...d.sheets.map((x) => x.id),
    ...d.views.map((x) => x.id),
    ...d.placements.map((x) => x.id),
    ...d.centerMarks.map((x) => x.id),
    ...d.tables.map((x) => x.id),
    ...d.notes.map((x) => x.id),
  ];
}

/**
 * Builds the `ids` map of `duplicateDrawing`: every sheet, view, placement, centre mark, table
 * and note id of `drawing` to a fresh id from `newId` (use `ulid`). Markup is not copied, so it
 * has no entry. Deterministic for a deterministic `newId`. `taken` ids are never handed out.
 */
export function planDuplicateDrawing(
  drawing: Drawing,
  newId: () => Id,
  taken: ReadonlySet<Id> = new Set(),
): Record<Id, Id> {
  const used = new Set<Id>(taken);
  used.add(drawing.id);
  const ids: Record<Id, Id> = {};
  for (const old of drawingContentIds(drawing)) {
    let fresh = newId();
    while (used.has(fresh)) fresh = newId();
    used.add(fresh);
    ids[old] = fresh;
  }
  return ids;
}

/** The copy of `src` that `duplicateDrawing` stores: ids mapped, references followed, no markup. */
export function remapDrawing(
  src: Drawing,
  ids: Record<Id, Id>,
  newId: Id,
  name: string,
  configurationId: Id | null,
): Drawing {
  const m = (id: Id): Id => ids[id] ?? id;
  const d = structuredClone(src);
  d.id = newId;
  d.name = name;
  if (configurationId === null) delete d.configurationId;
  else d.configurationId = configurationId;
  for (const s of d.sheets) s.id = m(s.id);
  for (const v of d.views) {
    v.id = m(v.id);
    v.sheetId = m(v.sheetId);
    if (v.kind !== 'base') v.parentId = m(v.parentId);
  }
  for (const p of d.placements) {
    p.id = m(p.id);
    p.viewId = m(p.viewId);
    if (p.layout.kind === 'leader' && p.layout.attach.kind !== 'ref') {
      p.layout.attach.placementId = m(p.layout.attach.placementId);
    }
  }
  for (const k of d.centerMarks) {
    k.id = m(k.id);
    k.viewId = m(k.viewId);
  }
  for (const t of d.tables) {
    t.id = m(t.id);
    t.sheetId = m(t.sheetId);
    if (t.kind === 'holeTable') t.viewId = m(t.viewId);
  }
  for (const n of d.notes) {
    n.id = m(n.id);
    n.sheetId = m(n.sheetId);
  }
  delete d.markup;
  const byId = (a: { id: string }, b: { id: string }): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  d.views.sort(byId);
  d.placements.sort(byId);
  d.centerMarks.sort(byId);
  d.tables.sort(byId);
  d.notes.sort(byId);
  return d;
}
