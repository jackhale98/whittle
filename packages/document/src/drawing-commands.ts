// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Compiles the M4 drawing commands (ADR-090). Each command is one undo step and is
 * all-or-nothing: if anything is invalid, nothing changes. Unordered collections stay sorted by id
 * and sheet quantities are rounded to 0.001 mm on the way in (`roundSheet`). Only `sheets` and the
 * document's `drawings` list have a meaningful order.
 *
 * Cascades (each in the same step): removing a view removes its placements, centre marks and hole
 * tables; removing a sheet removes its views, tables, notes and markup; removing an annotation
 * removes its placements (see `annotation-commands.ts`). Dependent views are removed or detached
 * as the command says. Nothing is rebound silently.
 */

import type {
  AnnotationPlacement,
  BaseView,
  Drawing,
  DrawingCommand,
  DrawingView,
  Id,
  JsonPatchOp,
  Part,
  Sheet,
  ViewDisplay,
  WrenDoc,
} from '@wren-cad/contracts';
import { annotationRemovalOps } from './annotation-commands';
import { annotationProblems, describeAnnotation } from './annotations';
import { Checker } from './check';
import {
  type Compiled,
  drawingIndex,
  err,
  firstProblem,
  newIdChecker,
  partIndex,
  plural,
  SortedSet,
  subjectPart,
} from './command-support';
import {
  checkCenterMark,
  checkDrawing,
  checkDrawingDefaults,
  checkMarkup,
  checkNote,
  checkPlacement,
  checkSheet,
  checkTable,
  checkView,
  type DrawingNote,
  drawingContentIds,
  LATEST_TEMPLATE_VERSION,
  normalizeDrawing,
  remapDrawing,
  roundDrawing,
  roundMarkup,
  roundNote,
  roundPlacement,
  roundTable,
  roundView,
  TEMPLATE_IDS,
  TITLE_BLOCK_SLOTS,
} from './drawings';
import { scopeOf } from './evaluate';
import { expressionEngine } from './expressions';
import { markupAnchorOps } from './markup-anchors';
import { diff } from './patch';
import { namedViewOf, type Resolved, resolveViewFrame, resolveViewPosition } from './view-frames';

type Cmd<K extends DrawingCommand['kind']> = Extract<DrawingCommand, { kind: K }>;

interface Ctx {
  doc: WrenDoc;
  di: number;
  d: Drawing;
  base: string;
  used: Set<string>;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function compileDrawingCommand(
  doc: WrenDoc,
  cmd: DrawingCommand,
  used: Set<string>,
): Compiled {
  switch (cmd.kind) {
    case 'setDrawingDefaults':
      return compileDefaults(doc, cmd);
    case 'addDrawing':
      return compileAddDrawing(doc, cmd, used);
    default:
      break;
  }
  const di = drawingIndex(doc, cmd.drawingId);
  const d = doc.drawings[di];
  if (!d) return err(`Drawing ‘${cmd.drawingId}’ was not found`);
  const ctx: Ctx = { doc, di, d, base: `/drawings/${di}`, used };
  switch (cmd.kind) {
    case 'updateDrawing':
      return compileUpdateDrawing(ctx, cmd);
    case 'removeDrawing':
      return compileRemoveDrawing(ctx, cmd);
    case 'moveDrawing': {
      const n = doc.drawings.length;
      if (!Number.isInteger(cmd.toIndex) || cmd.toIndex < 0 || cmd.toIndex >= n) {
        return err(`Cannot move to position ${cmd.toIndex} (there are ${n} drawings)`);
      }
      return {
        ok: true,
        label: `Move ${d.name}`,
        ops:
          cmd.toIndex === di
            ? []
            : [{ op: 'move', from: `/drawings/${di}`, path: `/drawings/${cmd.toIndex}` }],
      };
    }
    case 'duplicateDrawing':
      return compileDuplicate(ctx, cmd);
    case 'applyTemplate':
      return compileApplyTemplate(ctx, cmd);
    case 'setTitleBlockFields':
      return compileTitleFields(ctx, cmd);
    case 'addSheet':
    case 'updateSheet':
    case 'removeSheet':
    case 'moveSheet':
      return compileSheet(ctx, cmd);
    case 'addView':
    case 'updateView':
    case 'removeViews':
      return compileView(ctx, cmd);
    case 'placeAnnotations':
    case 'updatePlacements':
    case 'removePlacements':
      return compilePlacements(ctx, cmd);
    case 'addCenterMark':
    case 'removeCenterMarks':
      return compileCenterMarks(ctx, cmd);
    case 'addTable':
    case 'updateTable':
    case 'removeTable':
      return compileTables(ctx, cmd);
    case 'addSheetNote':
    case 'updateSheetNote':
    case 'removeSheetNote':
      return compileNotes(ctx, cmd);
    case 'addMarkup':
    case 'setMarkupResolved':
    case 'removeMarkup':
      return compileMarkup(ctx, cmd);
  }
}

// ---------------------------------------------------------------------------------------------
// Defaults, add, update, remove, duplicate
// ---------------------------------------------------------------------------------------------

function compileDefaults(doc: WrenDoc, cmd: Cmd<'setDrawingDefaults'>): Compiled {
  const c = new Checker();
  checkDrawingDefaults(c, cmd.defaults, 'defaults');
  const bad = firstProblem(c, 'Invalid drawing defaults');
  if (bad) return bad;
  const value = structuredClone(cmd.defaults);
  const ops: JsonPatchOp[] =
    doc.drawingDefaults === undefined
      ? [{ op: 'add', path: '/drawingDefaults', value }]
      : diff(doc.drawingDefaults, value, '/drawingDefaults');
  return { ok: true, label: 'Set drawing defaults', ops };
}

function configurationExists(part: Part | undefined, id: Id): boolean {
  return part?.configurations?.some((c) => c.id === id) ?? false;
}

function compileAddDrawing(doc: WrenDoc, cmd: Cmd<'addDrawing'>, used: Set<string>): Compiled {
  const drawing = structuredClone(cmd.drawing);
  const c = newIdChecker(new Set(used));
  checkDrawing(c, drawing, 'drawing');
  const bad = firstProblem(c, 'Invalid drawing');
  if (bad) return bad;
  const part = subjectPart(doc, drawing);
  if (!part) return err(`Part ‘${drawing.subject.partId}’ was not found`);
  if (
    drawing.configurationId !== undefined &&
    !configurationExists(part, drawing.configurationId)
  ) {
    return err(`Configuration ‘${drawing.configurationId}’ was not found`);
  }
  const n = doc.drawings.length;
  const index = cmd.index ?? n;
  if (!Number.isInteger(index) || index < 0 || index > n) {
    return err(`Cannot insert a drawing at position ${index} (there are ${n})`);
  }
  const notes: DrawingNote[] = [];
  const clean = normalizeDrawing(drawing, part, notes);
  if (notes.length > 0) return err(`Invalid drawing: ${(notes[0] as DrawingNote).message}`);
  return {
    ok: true,
    label: `Add drawing ${drawing.name}`,
    ops: [{ op: 'add', path: index === n ? '/drawings/-' : `/drawings/${index}`, value: clean }],
  };
}

function compileUpdateDrawing(ctx: Ctx, cmd: Cmd<'updateDrawing'>): Compiled {
  const { doc, d } = ctx;
  const ch = cmd.changes;
  const next: Drawing = { ...d };
  if (ch.name !== undefined) {
    if (typeof ch.name !== 'string' || ch.name.trim() === '') return err('A drawing needs a name');
    next.name = ch.name;
  }
  if (ch.subject !== undefined) {
    if (ch.subject.kind !== 'part' || !doc.parts.some((p) => p.id === ch.subject?.partId)) {
      return err(`Part ‘${String(ch.subject.partId)}’ was not found`);
    }
    if (ch.subject.partId !== d.subject.partId && d.placements.length > 0) {
      return err('Remove the drawing’s annotations before showing a different part');
    }
    next.subject = ch.subject;
  }
  if (ch.configurationId !== undefined) {
    if (ch.configurationId === null) delete next.configurationId;
    else next.configurationId = ch.configurationId;
  }
  if (ch.standard !== undefined) next.standard = ch.standard;
  if (ch.projection !== undefined) next.projection = ch.projection;
  if (ch.style !== undefined) next.style = ch.style;
  const c = new Checker();
  checkDrawing(c, next, 'drawing');
  const bad = firstProblem(c, 'Invalid drawing');
  if (bad) return bad;
  const part = subjectPart(doc, next);
  if (next.configurationId !== undefined && next.configurationId !== d.configurationId) {
    if (!configurationExists(part, next.configurationId)) {
      return err(`Configuration ‘${next.configurationId}’ was not found`);
    }
  }
  return {
    ok: true,
    label: `Edit drawing ${d.name}`,
    ops: diff(d, roundDrawing(next), ctx.base),
  };
}

function compileRemoveDrawing(ctx: Ctx, cmd: Cmd<'removeDrawing'>): Compiled {
  const { doc, d, di } = ctx;
  const ops: JsonPatchOp[] = [];
  if ((cmd.annotations ?? 'removeOwn') === 'removeOwn') {
    const placedElsewhere = new Set<Id>();
    for (const other of doc.drawings) {
      if (other.id !== d.id) for (const p of other.placements) placedElsewhere.add(p.annotationId);
    }
    doc.parts.forEach((part, pi) => {
      const own = new Set(
        (part.annotations ?? [])
          .filter(
            (a) =>
              a.origin.kind === 'drawing' &&
              a.origin.drawingId === d.id &&
              !placedElsewhere.has(a.id),
          )
          .map((a) => a.id),
      );
      if (own.size > 0) ops.push(...annotationRemovalOps(doc, pi, own, d.id));
    });
  }
  ops.push({ op: 'remove', path: `/drawings/${di}` });
  return { ok: true, label: `Delete drawing ${d.name}`, ops };
}

function compileDuplicate(ctx: Ctx, cmd: Cmd<'duplicateDrawing'>): Compiled {
  const { doc, d, di, used } = ctx;
  if (typeof cmd.name !== 'string' || cmd.name.trim() === '') return err('A drawing needs a name');
  if (
    typeof cmd.newDrawingId !== 'string' ||
    cmd.newDrawingId === '' ||
    used.has(cmd.newDrawingId)
  ) {
    return err(`The id ‘${String(cmd.newDrawingId)}’ is already in use`);
  }
  const fresh = new Set<string>([cmd.newDrawingId]);
  for (const old of drawingContentIds(d)) {
    const to = cmd.ids?.[old];
    if (typeof to !== 'string' || to === '') return err(`No new id was given for ‘${old}’`);
    if (used.has(to) || fresh.has(to)) return err(`The id ‘${to}’ is already in use`);
    fresh.add(to);
  }
  if (
    cmd.configurationId !== null &&
    !configurationExists(subjectPart(doc, d), cmd.configurationId)
  ) {
    return err(`Configuration ‘${cmd.configurationId}’ was not found`);
  }
  const copy = remapDrawing(d, cmd.ids, cmd.newDrawingId, cmd.name, cmd.configurationId);
  return {
    ok: true,
    label: `Duplicate drawing ${d.name}`,
    ops: [{ op: 'add', path: `/drawings/${di + 1}`, value: copy }],
  };
}

// ---------------------------------------------------------------------------------------------
// Template and title block
// ---------------------------------------------------------------------------------------------

function compileApplyTemplate(ctx: Ctx, cmd: Cmd<'applyTemplate'>): Compiled {
  const { d, base } = ctx;
  const t = cmd.template;
  if (!(TEMPLATE_IDS as readonly unknown[]).includes(t?.id)) {
    return err(`‘${String(t?.id)}’ is not a template`);
  }
  const latest = LATEST_TEMPLATE_VERSION[t.id];
  if (!Number.isInteger(t.version) || t.version < 1 || t.version > latest) {
    return err(`Template ${t.id} has versions 1 to ${latest}`);
  }
  const next: Drawing = { ...d, template: { ...d.template, id: t.id, version: t.version } };
  if (cmd.formats?.length) {
    const sheets = d.sheets.slice();
    for (const f of cmd.formats) {
      const k = sheets.findIndex((s) => s.id === f.sheetId);
      if (k < 0) return err(`Sheet ‘${f.sheetId}’ was not found`);
      sheets[k] = { ...(sheets[k] as Sheet), format: f.format };
    }
    next.sheets = sheets;
  }
  const c = new Checker();
  checkDrawing(c, next, 'drawing');
  const bad = firstProblem(c, 'Invalid template');
  if (bad) return bad;
  return {
    ok: true,
    label: `Apply template ${t.id}`,
    ops: diff(d, roundDrawing(next), base),
  };
}

function compileTitleFields(ctx: Ctx, cmd: Cmd<'setTitleBlockFields'>): Compiled {
  const { d, base } = ctx;
  const sheetIndex =
    cmd.sheetId === undefined ? -1 : d.sheets.findIndex((s) => s.id === cmd.sheetId);
  if (cmd.sheetId !== undefined && sheetIndex < 0)
    return err(`Sheet ‘${cmd.sheetId}’ was not found`);
  const holder = sheetIndex >= 0 ? (d.sheets[sheetIndex] as Sheet) : d.template;
  const path = sheetIndex >= 0 ? `${base}/sheets/${sheetIndex}/fields` : `${base}/template/fields`;
  const next: Record<string, string> = { ...holder.fields };
  for (const [slot, value] of Object.entries(cmd.fields ?? {})) {
    if (!(TITLE_BLOCK_SLOTS as readonly string[]).includes(slot)) {
      return err(`‘${slot}’ is not a title block slot`);
    }
    if (value === null) delete next[slot];
    else if (typeof value === 'string') next[slot] = value;
    else return err(`The text of ‘${slot}’ must be text`);
  }
  const label = sheetIndex >= 0 ? 'Edit sheet title block' : 'Edit title block';
  const had = holder.fields !== undefined;
  const empty = Object.keys(next).length === 0;
  let ops: JsonPatchOp[];
  if (empty) ops = had ? [{ op: 'remove', path }] : [];
  else if (!had) ops = [{ op: 'add', path, value: next }];
  else ops = diff(holder.fields, next, path);
  return { ok: true, label, ops };
}

// ---------------------------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------------------------

function compileSheet(
  ctx: Ctx,
  cmd: Cmd<'addSheet' | 'updateSheet' | 'removeSheet' | 'moveSheet'>,
): Compiled {
  const { d, base, used } = ctx;
  const n = d.sheets.length;
  switch (cmd.kind) {
    case 'addSheet': {
      const sheet = structuredClone(cmd.sheet);
      const c = newIdChecker(new Set(used));
      checkSheet(c, sheet, 'sheet');
      const bad = firstProblem(c, 'Invalid sheet');
      if (bad) return bad;
      const at = cmd.index ?? n;
      if (!Number.isInteger(at) || at < 0 || at > n)
        return err(`Cannot insert a sheet at position ${at}`);
      return {
        ok: true,
        label: `Add ${sheet.name}`,
        ops: [
          {
            op: 'add',
            path: `${base}/sheets/${at === n ? '-' : at}`,
            value: roundDrawingSheet(sheet),
          },
        ],
      };
    }
    case 'updateSheet': {
      const k = d.sheets.findIndex((s) => s.id === cmd.sheet.id);
      if (k < 0) return err(`Sheet ‘${cmd.sheet.id}’ was not found`);
      const c = new Checker();
      checkSheet(c, cmd.sheet, 'sheet');
      const bad = firstProblem(c, 'Invalid sheet');
      if (bad) return bad;
      return {
        ok: true,
        label: `Edit ${cmd.sheet.name}`,
        ops: diff(d.sheets[k], roundDrawingSheet(cmd.sheet), `${base}/sheets/${k}`),
      };
    }
    case 'moveSheet': {
      const k = d.sheets.findIndex((s) => s.id === cmd.sheetId);
      if (k < 0) return err(`Sheet ‘${cmd.sheetId}’ was not found`);
      if (!Number.isInteger(cmd.toIndex) || cmd.toIndex < 0 || cmd.toIndex >= n) {
        return err(`Cannot move to position ${cmd.toIndex} (there are ${n} sheets)`);
      }
      return {
        ok: true,
        label: `Move ${(d.sheets[k] as Sheet).name}`,
        ops:
          k === cmd.toIndex
            ? []
            : [{ op: 'move', from: `${base}/sheets/${k}`, path: `${base}/sheets/${cmd.toIndex}` }],
      };
    }
    case 'removeSheet': {
      const k = d.sheets.findIndex((s) => s.id === cmd.sheetId);
      if (k < 0) return err(`Sheet ‘${cmd.sheetId}’ was not found`);
      if (n === 1) return err('A drawing needs at least one sheet');
      const sheetIds = new Set([cmd.sheetId]);
      const ops: JsonPatchOp[] = [];
      const viewIds = new Set(d.views.filter((v) => sheetIds.has(v.sheetId)).map((v) => v.id));
      const placementIds = new Set(
        d.placements.filter((p) => viewIds.has(p.viewId)).map((p) => p.id),
      );
      ops.push(...markupAnchorOps(d, base, { placementIds, viewIds }, sheetIds));
      const sets = viewSets(ctx, ops);
      cascadeViews(ctx, viewIds, sets);
      for (const t of d.tables) if (sheetIds.has(t.sheetId)) sets.tables.remove(t.id);
      const notes = new SortedSet(`${base}/notes`, d.notes, ops, false);
      for (const x of d.notes) if (sheetIds.has(x.sheetId)) notes.remove(x.id);
      const markup = new SortedSet(`${base}/markup`, d.markup, ops, true);
      for (const x of d.markup ?? []) if (sheetIds.has(x.sheetId)) markup.remove(x.id);
      ops.push({ op: 'remove', path: `${base}/sheets/${k}` });
      return { ok: true, label: `Delete ${(d.sheets[k] as Sheet).name}`, ops };
    }
  }
}

function roundDrawingSheet(s: Sheet): Sheet {
  const size = s.format.size;
  return typeof size === 'object'
    ? {
        ...s,
        format: { ...s.format, size: { width: round3(size.width), height: round3(size.height) } },
      }
    : s;
}
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

/** The id-keyed collections a view removal touches (one tracker each, so indexes stay right). */
function viewSets(ctx: Ctx, ops: JsonPatchOp[]) {
  const { d, base } = ctx;
  return {
    placements: new SortedSet(`${base}/placements`, d.placements, ops, false),
    marks: new SortedSet(`${base}/centerMarks`, d.centerMarks, ops, false),
    tables: new SortedSet(`${base}/tables`, d.tables, ops, false),
    views: new SortedSet(`${base}/views`, d.views, ops, false),
  };
}

/** Removes the views `ids` and everything in the drawing that hangs on them. */
function cascadeViews(ctx: Ctx, ids: ReadonlySet<Id>, sets: ReturnType<typeof viewSets>): void {
  const { d } = ctx;
  for (const p of d.placements) if (ids.has(p.viewId)) sets.placements.remove(p.id);
  for (const m of d.centerMarks) if (ids.has(m.viewId)) sets.marks.remove(m.id);
  for (const t of d.tables)
    if (t.kind === 'holeTable' && ids.has(t.viewId)) sets.tables.remove(t.id);
  for (const v of d.views) if (ids.has(v.id)) sets.views.remove(v.id);
}

/** Is the parent chain of `view` (in `views` with `view` put in) complete and loop-free? */
function parentProblem(views: readonly DrawingView[], view: DrawingView): string | undefined {
  if (view.kind === 'base') return undefined;
  const by = new Map(views.map((v) => [v.id, v]));
  by.set(view.id, view);
  let cur: DrawingView | undefined = view;
  for (let depth = 0; cur && cur.kind !== 'base'; depth++) {
    if (cur.parentId === view.id) {
      return depth === 0
        ? 'A view cannot be derived from itself'
        : 'The views are derived from each other in a loop';
    }
    cur = by.get(cur.parentId);
    if (!cur) return 'The view this one is derived from was not found';
    if (depth > views.length) return 'The views are derived from each other in a loop';
  }
  return undefined;
}

function angleOf(doc: WrenDoc): (expr: string) => number | undefined {
  const scope = scopeOf(doc);
  return (expr) => {
    const r = expressionEngine.evaluate(expr, 'angle', scope);
    return r.ok ? r.value : undefined;
  };
}

const viewName = (v: DrawingView): string =>
  v.label ?? ('letter' in v ? `${v.kind} view ${v.letter}` : `${v.kind} view`);

/** Turns a projected or iso view into a base view with the same orientation, position, scale and display. */
function detachedView(doc: WrenDoc, d: Drawing, child: DrawingView): Resolved<BaseView> {
  if (child.kind !== 'projected' && child.kind !== 'iso') {
    return {
      ok: false,
      reason: `‘${viewName(child)}’ needs the view it is made from (a ${child.kind} view cannot become a base view); remove it too`,
    };
  }
  const frame = resolveViewFrame(d.views, child.id, angleOf(doc));
  if (!frame.ok)
    return { ok: false, reason: `‘${viewName(child)}’ cannot be detached: ${frame.reason}` };
  const pos = resolveViewPosition(d, child.id);
  if (!pos.ok)
    return { ok: false, reason: `‘${viewName(child)}’ cannot be detached: ${pos.reason}` };
  const by = new Map(d.views.map((v) => [v.id, v]));
  const sheetScale = (v: DrawingView): string | undefined =>
    d.sheets.find((s) => s.id === v.sheetId)?.scale;
  const scaleOf = (v: DrawingView, depth = 0): string | undefined => {
    if (v.scale !== undefined) return v.scale;
    if (v.kind === 'base' || v.kind === 'iso' || depth > d.views.length) return sheetScale(v);
    const p = by.get(v.parentId);
    return p ? scaleOf(p, depth + 1) : sheetScale(v);
  };
  const displayOf = (v: DrawingView, depth = 0): ViewDisplay => {
    if (v.kind === 'base' || depth > d.views.length) return { ...d.style.view, ...v.display };
    const p = by.get(v.parentId);
    return { ...(p ? displayOf(p, depth + 1) : d.style.view), ...v.display };
  };
  const f = frame.value;
  const name = namedViewOf(f);
  const base: BaseView = {
    id: child.id,
    sheetId: child.sheetId,
    kind: 'base',
    orientation: name
      ? { kind: 'named', name: name as Extract<BaseView['orientation'], { kind: 'named' }>['name'] }
      : { kind: 'matrix', x: f.x, y: f.y },
    layout: { kind: 'free', position: [round3(pos.value[0]), round3(pos.value[1])] },
  };
  if (child.label !== undefined) base.label = child.label;
  if (child.showLabel !== undefined) base.showLabel = child.showLabel;
  if (child.configurationId !== undefined) base.configurationId = child.configurationId;
  const scale = scaleOf(child);
  if (scale !== undefined && scale !== sheetScale(child)) base.scale = scale;
  const display = displayOf(child);
  if (!sameJson(display, d.style.view)) base.display = display;
  return { ok: true, value: base };
}

function compileView(ctx: Ctx, cmd: Cmd<'addView' | 'updateView' | 'removeViews'>): Compiled {
  const { doc, d, base, used } = ctx;
  if (cmd.kind === 'removeViews') {
    const ids = new Set(cmd.viewIds);
    if (ids.size === 0) return err('Choose at least one view to remove');
    for (const id of ids)
      if (!d.views.some((v) => v.id === id)) return err(`View ‘${id}’ was not found`);
    const gone = new Set(ids);
    const ops: JsonPatchOp[] = [];
    const detach = (cmd.dependents ?? 'remove') === 'detach';
    const detached: BaseView[] = [];
    if (detach) {
      for (const v of d.views) {
        if (v.kind === 'base' || !ids.has(v.parentId) || ids.has(v.id)) continue;
        const r = detachedView(doc, d, v);
        if (!r.ok) return err(r.reason);
        detached.push(r.value);
      }
    } else {
      for (let grew = true; grew; ) {
        grew = false;
        for (const v of d.views) {
          if (v.kind !== 'base' && gone.has(v.parentId) && !gone.has(v.id)) {
            gone.add(v.id);
            grew = true;
          }
        }
      }
    }
    const placementIds = new Set(d.placements.filter((p) => gone.has(p.viewId)).map((p) => p.id));
    ops.push(...markupAnchorOps(d, base, { placementIds, viewIds: gone }));
    const sets = viewSets(ctx, ops);
    for (const v of detached) sets.views.replace(v);
    cascadeViews(ctx, gone, sets);
    const first = d.views.find((v) => ids.has(v.id)) as DrawingView;
    const total = gone.size;
    return {
      ok: true,
      label: total === 1 ? `Delete ${viewName(first)}` : `Delete ${plural(total, 'view', 'views')}`,
      ops,
    };
  }
  const view = roundView(structuredClone(cmd.view));
  const c = cmd.kind === 'addView' ? newIdChecker(new Set(used)) : new Checker();
  checkView(c, view, 'view');
  const bad = firstProblem(c, 'Invalid view');
  if (bad) return bad;
  if (!d.sheets.some((s) => s.id === view.sheetId))
    return err(`Sheet ‘${view.sheetId}’ was not found`);
  const others = d.views.filter((v) => v.id !== view.id);
  const loop = parentProblem(others, view);
  if (loop) return err(loop);
  if (cmd.kind === 'addView') {
    const ops: JsonPatchOp[] = [];
    new SortedSet(`${base}/views`, d.views, ops, false).add(view);
    return { ok: true, label: `Add ${viewName(view)}`, ops };
  }
  const k = d.views.findIndex((v) => v.id === view.id);
  if (k < 0) return err(`View ‘${view.id}’ was not found`);
  return {
    ok: true,
    label: `Edit ${viewName(view)}`,
    ops: diff(d.views[k], view, `${base}/views/${k}`),
  };
}

// ---------------------------------------------------------------------------------------------
// Placements
// ---------------------------------------------------------------------------------------------

function compilePlacements(
  ctx: Ctx,
  cmd: Cmd<'placeAnnotations' | 'updatePlacements' | 'removePlacements'>,
): Compiled {
  const { doc, d, base, used } = ctx;
  const part = subjectPart(doc, d);
  const ops: JsonPatchOp[] = [];
  if (cmd.kind === 'removePlacements') {
    const ids = new Set(cmd.placementIds);
    if (ids.size === 0) return err('Choose at least one placement to remove');
    for (const id of ids)
      if (!d.placements.some((p) => p.id === id)) return err(`Placement ‘${id}’ was not found`);
    ops.push(...markupAnchorOps(d, base, { placementIds: ids }));
    const set = new SortedSet(`${base}/placements`, d.placements, ops, false);
    for (const id of ids) set.remove(id);
    return {
      ok: true,
      label:
        ids.size === 1
          ? 'Hide annotation from view'
          : `Hide ${plural(ids.size, 'annotation', 'annotations')} from view`,
      ops,
    };
  }
  if (!part) return err(`The drawing’s part ‘${d.subject.partId}’ was not found`);
  const pi = partIndex(doc, part.id);
  const viewOk = (id: Id): boolean => d.views.some((v) => v.id === id);
  if (cmd.kind === 'updatePlacements') {
    if (!Array.isArray(cmd.placements) || cmd.placements.length === 0)
      return err('Nothing to update');
    const c = new Checker();
    const next = new Map(d.placements.map((p) => [p.id, p]));
    const replaced: AnnotationPlacement[] = [];
    for (const raw of cmd.placements) {
      if (!next.has(raw?.id)) return err(`Placement ‘${String(raw?.id)}’ was not found`);
      const p = roundPlacement(structuredClone(raw));
      checkPlacement(c, p, 'placement');
      const bad = firstProblem(c, 'Invalid placement');
      if (bad) return bad;
      if (!viewOk(p.viewId)) return err(`View ‘${p.viewId}’ was not found`);
      if (!part.annotations?.some((a) => a.id === p.annotationId)) {
        return err(`Annotation ‘${p.annotationId}’ was not found`);
      }
      next.set(p.id, p);
      replaced.push(p);
    }
    const seen = new Set<string>();
    for (const p of next.values()) {
      const key = `${p.viewId}\u0000${p.annotationId}`;
      if (seen.has(key)) return err('An annotation can be placed only once in a view');
      seen.add(key);
    }
    const set = new SortedSet(`${base}/placements`, d.placements, ops, false);
    for (const p of replaced) set.replace(p);
    return {
      ok: true,
      label:
        replaced.length === 1
          ? 'Move annotation'
          : `Move ${plural(replaced.length, 'annotation', 'annotations')}`,
      ops,
    };
  }
  // placeAnnotations
  if (!Array.isArray(cmd.items) || cmd.items.length === 0) return err('Nothing to place');
  const c = newIdChecker(new Set(used));
  const annotations = new SortedSet(`/parts/${pi}/annotations`, part.annotations, ops, true);
  const placements = new SortedSet(`${base}/placements`, d.placements, ops, false);
  const placed = new Set(d.placements.map((p) => p.annotationId));
  const inView = new Set(d.placements.map((p) => `${p.viewId}\u0000${p.annotationId}`));
  const batchPlaced = new Set<string>();
  let created = 0;
  for (const item of cmd.items) {
    const p = roundPlacement(structuredClone(item.placement));
    checkPlacement(c, p, 'placement');
    if (item.annotation) {
      const a = structuredClone(item.annotation);
      const bad = annotationProblems(a);
      if (bad.length > 0) return err(`Invalid annotation: ${bad[0]}`);
      c.id(a.id, 'annotation.id');
      annotations.add(a);
      created++;
    } else if (!annotations.has(p.annotationId)) {
      return err(`Annotation ‘${p.annotationId}’ was not found`);
    }
    if (item.annotation && item.annotation.id !== p.annotationId) {
      return err('The placement must be of the annotation it comes with');
    }
    const bad = firstProblem(c, 'Invalid placement');
    if (bad) return bad;
    if (!viewOk(p.viewId)) return err(`View ‘${p.viewId}’ was not found`);
    const key = `${p.viewId}\u0000${p.annotationId}`;
    if (inView.has(key) || batchPlaced.has(key)) {
      return err('An annotation can be placed only once in a view');
    }
    if ((placed.has(p.annotationId) || batchPlaced.has(p.annotationId)) && !cmd.allowDuplicate) {
      const a = annotations.get(p.annotationId);
      return err(
        `The ${a ? describeAnnotation(a) : 'annotation'} is already placed in this drawing`,
      );
    }
    batchPlaced.add(key);
    batchPlaced.add(p.annotationId);
    placements.add(p);
  }
  const n = cmd.items.length;
  return {
    ok: true,
    label:
      created > 0 && created === n
        ? `Add ${plural(n, 'dimension', 'dimensions')}`
        : `Place ${plural(n, 'annotation', 'annotations')}`,
    ops,
  };
}

// ---------------------------------------------------------------------------------------------
// Centre marks, tables, notes, markup
// ---------------------------------------------------------------------------------------------

function compileCenterMarks(ctx: Ctx, cmd: Cmd<'addCenterMark' | 'removeCenterMarks'>): Compiled {
  const { d, base, used } = ctx;
  const ops: JsonPatchOp[] = [];
  const set = new SortedSet(`${base}/centerMarks`, d.centerMarks, ops, false);
  if (cmd.kind === 'addCenterMark') {
    const mark = structuredClone(cmd.mark);
    const c = newIdChecker(new Set(used));
    checkCenterMark(c, mark, 'mark');
    const bad = firstProblem(c, 'Invalid centre mark');
    if (bad) return bad;
    if (!d.views.some((v) => v.id === mark.viewId))
      return err(`View ‘${mark.viewId}’ was not found`);
    set.add(mark);
    return { ok: true, label: 'Add centre mark', ops };
  }
  const ids = new Set(cmd.markIds);
  for (const id of ids) if (!set.has(id)) return err(`Centre mark ‘${id}’ was not found`);
  for (const id of ids) set.remove(id);
  return { ok: true, label: 'Delete centre mark', ops };
}

function compileTables(ctx: Ctx, cmd: Cmd<'addTable' | 'updateTable' | 'removeTable'>): Compiled {
  const { d, base, used } = ctx;
  const ops: JsonPatchOp[] = [];
  const set = new SortedSet(`${base}/tables`, d.tables, ops, false);
  if (cmd.kind === 'removeTable') {
    if (!set.has(cmd.tableId)) return err(`Table ‘${cmd.tableId}’ was not found`);
    set.remove(cmd.tableId);
    return { ok: true, label: 'Delete table', ops };
  }
  const table = roundTable(structuredClone(cmd.table));
  const c = cmd.kind === 'addTable' ? newIdChecker(new Set(used)) : new Checker();
  checkTable(c, table, 'table');
  const bad = firstProblem(c, 'Invalid table');
  if (bad) return bad;
  if (!d.sheets.some((s) => s.id === table.sheetId))
    return err(`Sheet ‘${table.sheetId}’ was not found`);
  if (table.kind === 'holeTable' && !d.views.some((v) => v.id === table.viewId)) {
    return err(`View ‘${table.viewId}’ was not found`);
  }
  const label = table.kind === 'holeTable' ? 'hole table' : 'part properties table';
  if (cmd.kind === 'addTable') {
    set.add(table);
    return { ok: true, label: `Add ${label}`, ops };
  }
  if (!set.has(table.id)) return err(`Table ‘${table.id}’ was not found`);
  set.replace(table);
  return { ok: true, label: `Edit ${label}`, ops };
}

function compileNotes(
  ctx: Ctx,
  cmd: Cmd<'addSheetNote' | 'updateSheetNote' | 'removeSheetNote'>,
): Compiled {
  const { d, base, used } = ctx;
  const ops: JsonPatchOp[] = [];
  const set = new SortedSet(`${base}/notes`, d.notes, ops, false);
  if (cmd.kind === 'removeSheetNote') {
    if (!set.has(cmd.noteId)) return err(`Note ‘${cmd.noteId}’ was not found`);
    set.remove(cmd.noteId);
    return { ok: true, label: 'Delete note', ops };
  }
  const note = roundNote(structuredClone(cmd.note));
  const c = cmd.kind === 'addSheetNote' ? newIdChecker(new Set(used)) : new Checker();
  checkNote(c, note, 'note');
  const bad = firstProblem(c, 'Invalid note');
  if (bad) return bad;
  if (!d.sheets.some((s) => s.id === note.sheetId))
    return err(`Sheet ‘${note.sheetId}’ was not found`);
  if (cmd.kind === 'addSheetNote') {
    set.add(note);
    return { ok: true, label: 'Add note', ops };
  }
  if (!set.has(note.id)) return err(`Note ‘${note.id}’ was not found`);
  set.replace(note);
  return { ok: true, label: 'Edit note', ops };
}

function compileMarkup(
  ctx: Ctx,
  cmd: Cmd<'addMarkup' | 'setMarkupResolved' | 'removeMarkup'>,
): Compiled {
  const { d, base, used } = ctx;
  const ops: JsonPatchOp[] = [];
  const set = new SortedSet(`${base}/markup`, d.markup, ops, true);
  if (cmd.kind === 'addMarkup') {
    const m = roundMarkup(structuredClone(cmd.markup));
    const c = newIdChecker(new Set(used));
    checkMarkup(c, m, 'markup');
    const bad = firstProblem(c, 'Invalid markup');
    if (bad) return bad;
    if (!d.sheets.some((s) => s.id === m.sheetId)) return err(`Sheet ‘${m.sheetId}’ was not found`);
    set.add(m);
    return { ok: true, label: 'Add markup', ops };
  }
  const id = cmd.markupId;
  const k = (d.markup ?? []).findIndex((m) => m.id === id);
  if (k < 0) return err(`Markup ‘${id}’ was not found`);
  if (cmd.kind === 'removeMarkup') {
    set.remove(id);
    return { ok: true, label: 'Delete markup', ops };
  }
  const cur = (d.markup ?? [])[k]?.resolved ?? false;
  const path = `${base}/markup/${k}/resolved`;
  if (cmd.resolved === cur) return { ok: true, label: 'Resolve markup', ops: [] };
  const op: JsonPatchOp = cmd.resolved
    ? { op: d.markup?.[k]?.resolved === undefined ? 'add' : 'replace', path, value: true }
    : { op: 'remove', path };
  return { ok: true, label: cmd.resolved ? 'Resolve markup' : 'Reopen markup', ops: [op] };
}
