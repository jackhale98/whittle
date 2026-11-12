/**
 * Sheet operations of the drawing route (ADR-094): switch, add, rename, delete, reorder, and move
 * a view (with the views aligned to it) to another sheet. Each edit is one document command, or
 * several under one coalescing key and committed: one undo step either way.
 */

import type { Drawing, DrawingView, Id, Sheet } from '@wren-cad/contracts';
import { viewOutline } from '@wren-cad/drawing';
import type { DrawingController } from './controller';
import { host } from './host';
import { freeSpot, type Rect, usableArea, viewName } from './model';
import type { Built } from './pipeline';

// ---------------------------------------------------------------------------------------------
// The current sheet, remembered per drawing for the session (a reload of the tab keeps it)
// ---------------------------------------------------------------------------------------------

const memory = new Map<Id, Id>();
const KEY = 'wren:drawing-sheet:';

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Remembers the sheet shown for a drawing (app state, and the tab's session storage). */
export function rememberSheet(drawingId: Id, sheetId: Id): void {
  memory.set(drawingId, sheetId);
  try {
    storage()?.setItem(KEY + drawingId, sheetId);
  } catch {
    // Storage full or blocked: the in-memory copy still holds for this session.
  }
}

/** The sheet last shown for the drawing, when it still has it. */
export function recallSheet(d: Pick<Drawing, 'id' | 'sheets'>): Id | null {
  let id: Id | null | undefined = memory.get(d.id);
  if (!id) {
    try {
      id = storage()?.getItem(KEY + d.id);
    } catch {
      id = null;
    }
  }
  return id && d.sheets.some((s) => s.id === id) ? id : null;
}

// ---------------------------------------------------------------------------------------------
// Switching
// ---------------------------------------------------------------------------------------------

export function switchSheet(c: DrawingController, sheetId: Id): void {
  const d = c.drawing();
  if (!d?.sheets.some((s) => s.id === sheetId)) return;
  if (c.ui.get().sheetId !== sheetId)
    c.patch({ sheetId, selected: null, hint: null, editingCell: null });
  rememberSheet(d.id, sheetId);
}

/** The next (+1) or previous (−1) sheet; stays at the ends. */
export function stepSheet(c: DrawingController, delta: 1 | -1): void {
  const d = c.drawing();
  const cur = c.sheet();
  if (!d || !cur) return;
  const i = d.sheets.findIndex((s) => s.id === cur.id);
  const next = d.sheets[Math.max(0, Math.min(d.sheets.length - 1, i + delta))];
  if (next && next.id !== cur.id) switchSheet(c, next.id);
}

// ---------------------------------------------------------------------------------------------
// Add, rename, delete, reorder
// ---------------------------------------------------------------------------------------------

/** `Sheet N` with the first N no sheet of the drawing is called. */
export function nextSheetName(d: Pick<Drawing, 'sheets'>): string {
  const names = new Set(d.sheets.map((s) => s.name.trim().toLowerCase()));
  for (let n = d.sheets.length + 1; ; n++) if (!names.has(`sheet ${n}`)) return `Sheet ${n}`;
}

/**
 * The sheet `addSheet` makes: the drawing's template (it is per drawing) with the first sheet's
 * format and scale, so the title block, frame and size continue the drawing.
 */
export function newSheet(d: Drawing, id: Id): Sheet {
  const first = d.sheets[0];
  return {
    id,
    name: nextSheetName(d),
    format: first ? structuredClone(first.format) : { size: 'A3', orientation: 'landscape' },
    scale: first?.scale ?? '1',
  };
}

/** Adds a sheet after the last one and shows it. One undo step. */
export function addSheet(c: DrawingController): Id | null {
  const d = c.drawing();
  if (!d) return null;
  const sheet = newSheet(d, host.ulid());
  if (!c.apply({ kind: 'addSheet', drawingId: d.id, sheet }, `Add ${sheet.name}`)) return null;
  switchSheet(c, sheet.id);
  return sheet.id;
}

export function renameSheet(c: DrawingController, sheetId: Id, name: string): boolean {
  const d = c.drawing();
  const sheet = d?.sheets.find((s) => s.id === sheetId);
  const next = name.trim();
  if (!d || !sheet || next === '' || next === sheet.name) return false;
  return c.apply(
    { kind: 'updateSheet', drawingId: d.id, sheet: { ...sheet, name: next } },
    `Rename ${sheet.name}`,
  );
}

/**
 * Deletes a sheet with everything on it (`removeSheet` cascades: views, their placements and
 * marks, tables, notes, markup). One undo step; the neighbouring sheet is shown.
 */
export function deleteSheet(c: DrawingController, sheetId: Id): boolean {
  const d = c.drawing();
  if (!d || d.sheets.length < 2) return false;
  const i = d.sheets.findIndex((s) => s.id === sheetId);
  if (i < 0) return false;
  const showing = c.sheet()?.id === sheetId;
  const name = d.sheets[i]?.name ?? 'sheet';
  if (!c.apply({ kind: 'removeSheet', drawingId: d.id, sheetId }, `Delete ${name}`)) return false;
  if (showing) {
    const next = d.sheets[i + 1] ?? d.sheets[i - 1];
    if (next) switchSheet(c, next.id);
  }
  return true;
}

export function moveSheet(c: DrawingController, sheetId: Id, toIndex: number): boolean {
  const d = c.drawing();
  if (!d) return false;
  const from = d.sheets.findIndex((s) => s.id === sheetId);
  if (from < 0 || from === toIndex || toIndex < 0 || toIndex >= d.sheets.length) return false;
  return c.apply({ kind: 'moveSheet', drawingId: d.id, sheetId, toIndex }, 'Reorder sheets');
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n === 1 ? 'a' : n} ${n === 1 ? one : many}`;

/** What deleting a sheet takes with it, in words (`3 views and a table`); empty when nothing. */
export function sheetContents(d: Drawing, sheetId: Id): string {
  const views = d.views.filter((v) => v.sheetId === sheetId).length;
  const tables = d.tables.filter((t) => t.sheetId === sheetId).length;
  const notes = d.notes.filter((n) => n.sheetId === sheetId).length;
  const parts = [
    views ? plural(views, 'view') : '',
    tables ? plural(tables, 'table') : '',
    notes ? plural(notes, 'note') : '',
  ].filter(Boolean);
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

// ---------------------------------------------------------------------------------------------
// Moving a view to another sheet
// ---------------------------------------------------------------------------------------------

/** The views aligned to `id`, transitively (they sit relative to it, so they go where it goes). */
export function alignedDescendants(views: readonly DrawingView[], id: Id): DrawingView[] {
  const out: DrawingView[] = [];
  const walk = (pid: Id) => {
    for (const v of views)
      if ('parentId' in v && v.parentId === pid && v.layout.kind === 'aligned') {
        out.push(v);
        walk(v.id);
      }
  };
  walk(id);
  return out;
}

export type ViewMovePlan =
  | { ok: true; views: DrawingView[]; note?: string }
  | { ok: false; message: string };

/**
 * What moving `viewId` to another sheet moves: the view and the views aligned to it. A view that
 * is itself aligned to its parent cannot move alone (it sits on its parent's projection axis);
 * the message says so and how to move it.
 */
export function planViewMove(d: Drawing, viewId: Id): ViewMovePlan {
  const view = d.views.find((v) => v.id === viewId);
  if (!view) return { ok: false, message: 'That view is not in the drawing.' };
  if ('parentId' in view && view.layout.kind === 'aligned') {
    const parent = d.views.find((v) => v.id === view.parentId);
    return {
      ok: false,
      message: `${viewName(view)} is aligned with ${parent ? viewName(parent) : 'its parent'}, so it stays on its sheet. Move ${parent ? viewName(parent) : 'the parent'} instead (its aligned views go with it), or make this view free first.`,
    };
  }
  const along = alignedDescendants(d.views, viewId);
  return {
    ok: true,
    views: [view, ...along],
    ...(along.length > 0
      ? {
          note: `${along.map(viewName).join(', ')} ${along.length === 1 ? 'is' : 'are'} aligned with it and ${along.length === 1 ? 'goes' : 'go'} along.`,
        }
      : {}),
  };
}

function union(rs: readonly Rect[]): Rect | null {
  if (rs.length === 0) return null;
  return {
    min: [Math.min(...rs.map((r) => r.min[0])), Math.min(...rs.map((r) => r.min[1]))],
    max: [Math.max(...rs.map((r) => r.max[0])), Math.max(...rs.map((r) => r.max[1]))],
  };
}

/**
 * Moves a view, and the views aligned to it, to another sheet: one undo step. The group keeps its
 * position when it fits clear of what is on the target sheet, else it takes the first free spot
 * there. Placements, centre marks and hole tables hang on the views and go with them.
 */
export function moveViewToSheet(c: DrawingController, viewId: Id, sheetId: Id): boolean {
  const b: Built | null = c.built();
  const d = c.drawing();
  const target = d?.sheets.find((s) => s.id === sheetId);
  if (!b || !d || !target) return false;
  const plan = planViewMove(d, viewId);
  if (!plan.ok) {
    c.toast(plan.message, 'error');
    return false;
  }
  const head = plan.views[0] as DrawingView;
  if (head.sheetId === sheetId) return false;
  const ids = new Set(plan.views.map((v) => v.id));
  const outline = (id: Id) => {
    const s = b.build.views.get(id);
    return s?.ok ? viewOutline(s) : null;
  };
  // The build may be a frame behind the document (a drag that was just cancelled): measure the
  // group where the document has its head view.
  const solvedHead = b.build.views.get(head.id);
  const shift: [number, number] =
    head.layout.kind === 'free' && solvedHead?.ok
      ? [
          head.layout.position[0] - solvedHead.position[0],
          head.layout.position[1] - solvedHead.position[1],
        ]
      : [0, 0];
  const moved0 = union(plan.views.map((v) => outline(v.id)).filter((r): r is Rect => r !== null));
  const group: Rect | null = moved0
    ? {
        min: [moved0.min[0] + shift[0], moved0.min[1] + shift[1]],
        max: [moved0.max[0] + shift[0], moved0.max[1] + shift[1]],
      }
    : null;
  let delta: [number, number] = [0, 0];
  if (group && head.layout.kind === 'free') {
    const taken = d.views
      .filter((v) => v.sheetId === sheetId && !ids.has(v.id))
      .map((v) => outline(v.id))
      .filter((r): r is Rect => r !== null);
    const w = group.max[0] - group.min[0];
    const h = group.max[1] - group.min[1];
    const centre: [number, number] = [
      (group.min[0] + group.max[0]) / 2,
      (group.min[1] + group.max[1]) / 2,
    ];
    const at = freeSpot(taken, w, h, usableArea(target.format, d.template), [centre]);
    delta = [at[0] - centre[0], at[1] - centre[1]];
  }
  const key = `sheet-move:${host.ulid()}`;
  const label = `Move ${viewName(head)} to ${target.name}`;
  for (const v of plan.views) {
    const moved = { ...v, sheetId } as DrawingView;
    if (v.id === head.id && moved.layout.kind === 'free' && (delta[0] !== 0 || delta[1] !== 0)) {
      const p = moved.layout.position;
      moved.layout = { kind: 'free', position: [p[0] + delta[0], p[1] + delta[1]] };
    }
    if (!c.apply({ kind: 'updateView', drawingId: d.id, view: moved }, label, key)) {
      c.cancelEdit(key);
      return false;
    }
  }
  c.commit();
  // Follow the view: it is shown, still selected, on the sheet it went to.
  switchSheet(c, sheetId);
  c.select({ kind: 'view', id: head.id });
  c.toast(
    plan.views.length > 1
      ? `Moved ${viewName(head)} and ${plan.views.length - 1} aligned view${plan.views.length > 2 ? 's' : ''} to ${target.name}.`
      : `Moved ${viewName(head)} to ${target.name}.`,
  );
  return true;
}
