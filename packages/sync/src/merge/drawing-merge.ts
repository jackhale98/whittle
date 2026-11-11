// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The drawing rules of the structural merge (M4 proposal §5, ADR-090 sync amendment).
 *
 * **The dependent-edit rule.** An *owner* is an annotation (owns its placements in the drawings of
 * its part), a view (owns its placements, centre marks, hole tables and the views derived from
 * it) or a sheet (owns its views, tables and notes). When one side (D) deletes an owner the other
 * side (K) keeps, the owner's *closure* is everything K has under it that D no longer has. Then:
 *  - if K changed the owner or added or edited anything in its closure, that is one
 *    `modifiedDeleted` conflict on the owner, listing the closure (`dependents`); the closure
 *    follows the owner's resolution (kept: K's versions come back; deleted: they go), so there
 *    is one decision, not one per placement. An owner inside the closure of another conflicted
 *    owner is decided with it;
 *  - otherwise the closure goes with the owner, quietly in the walk, and the report says so
 *    (`placementRemovedWithAnnotation`, `placementRemovedWithView`).
 * Markup is never part of a closure: it merges as an append-mostly set and only loses its anchor.
 *
 * **Markup.** Adds from both sides are kept (sorted by id). Deleting a markup against resolving it
 * on the other side is a delete (both close it); any other edit against a delete conflicts.
 *
 * **Notes after the merge** (`drawingMergeNotes`): what went with a removed annotation or view,
 * duplicate placements (`normalizeDrawings` keeps the smaller id), datum letters and promoted
 * dimensions both sides added (both kept, flagged), and the normaliser's own repairs.
 */

import type {
  Annotation,
  AnnotationPlacement,
  CenterMark,
  DiffSubject,
  Drawing,
  DrawingMergeNoteKind,
  DrawingTable,
  DrawingView,
  Id,
  JsonPointer,
  Part,
  WrenDoc,
} from '@wren-cad/contracts';
import {
  annotationLabel,
  annotationLabelIn,
  placementLabel,
  sheetLabel,
  viewLabel,
} from './drawing-labels';
import { listText, plural } from './format';
import { subjectAt } from './labels';
import { equal, isObj, type Obj, type Segs, toPointer } from './tree';

export interface DrawingSides {
  base: WrenDoc;
  ours: WrenDoc;
  theirs: WrenDoc;
}

type Side = 'ours' | 'theirs';

/** One item that follows an owner's resolution. */
export interface DependentItem {
  segs: string[];
  /** The keeping side's version (restored when the owner is kept). */
  value: unknown;
  /** Relative to base: K added it, edited it, or still has it unchanged. */
  change: 'added' | 'edited' | 'unchanged';
  /**
   * Follows the owner but never makes it conflict: an annotation's configuration overrides
   * (ADR-074 kind 1, "removed with it, with a note").
   */
  quiet?: true;
}

/** What the dependent-edit rule decides before the walk. */
export interface DependentPlan {
  conflicts: DependentConflict[];
  /** Override groups of annotations deleted without a conflict: removed with them. */
  quiet: string[][];
}

/** An owner one side deleted while the other changed it or what hangs on it. */
export interface DependentConflict {
  segs: string[];
  deletedBy: Side;
  ownerChanged: boolean;
  closure: DependentItem[];
}

/** A dependent as a conflict lists it (plain data: it survives a structured clone). */
export interface ConflictDependent {
  subject: DiffSubject;
  path: JsonPointer;
  value: unknown;
  change: DependentItem['change'];
}

const drawingIn = (d: WrenDoc, id: string): Drawing | undefined =>
  d.drawings.find((x) => x.id === id);
const partIn = (d: WrenDoc, id: string | undefined): Part | undefined =>
  id === undefined ? undefined : d.parts.find((x) => x.id === id);
const findId = <T extends { id: string }>(list: readonly T[] | undefined, id: string) =>
  list?.find((x) => x.id === id);
const hasId = (list: readonly { id: string }[] | undefined, id: string): boolean =>
  list?.some((x) => x.id === id) ?? false;

function changeOf(base: unknown, kept: unknown): DependentItem['change'] {
  if (base === undefined) return 'added';
  return equal(base, kept) ? 'unchanged' : 'edited';
}

/**
 * The closure of the views `start` in K's drawing `dk`: everything under them D's drawing `dd`
 * no longer has. Views D still has (detached children) stop the walk.
 */
function viewClosure(
  start: readonly string[],
  dk: Drawing,
  dd: Drawing | undefined,
  db: Drawing | undefined,
  out: DependentItem[],
  seen: Set<string>,
): void {
  const queue = [...start];
  const did = dk.id;
  const push = (coll: string, item: { id: string }, base: { id: string }[] | undefined) => {
    const key = `${coll}/${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      segs: ['drawings', did, coll, item.id],
      value: item,
      change: changeOf(findId(base, item.id), item),
    });
  };
  const gone = (coll: 'views' | 'placements' | 'centerMarks' | 'tables', id: string) =>
    !hasId(dd?.[coll] as { id: string }[] | undefined, id);
  while (queue.length > 0) {
    const vid = queue.shift() as string;
    for (const p of dk.placements) {
      if (p.viewId === vid && gone('placements', p.id)) push('placements', p, db?.placements);
    }
    for (const m of dk.centerMarks) {
      if (m.viewId === vid && gone('centerMarks', m.id)) push('centerMarks', m, db?.centerMarks);
    }
    for (const t of dk.tables) {
      if (t.kind === 'holeTable' && t.viewId === vid && gone('tables', t.id)) {
        push('tables', t, db?.tables);
      }
    }
    for (const v of dk.views) {
      if (v.kind === 'base' || v.parentId !== vid || !gone('views', v.id)) continue;
      if (seen.has(`views/${v.id}`)) continue;
      push('views', v, db?.views);
      queue.push(v.id);
    }
  }
}

/**
 * Every owner one side deleted while the other changed it or something in its closure, outermost
 * first; owners inside another conflicted owner's closure are left out (they follow it).
 */
export function dependentConflicts(sides: DrawingSides): DependentConflict[] {
  return dependentPlan(sides).conflicts;
}

/** `dependentConflicts`, plus the override groups that go quietly with deleted annotations. */
export function dependentPlan(sides: DrawingSides): DependentPlan {
  const { base } = sides;
  const found: DependentConflict[] = [];
  const quiet: string[][] = [];
  for (const deletedBy of ['ours', 'theirs'] as const) {
    const D = sides[deletedBy];
    const K = sides[deletedBy === 'ours' ? 'theirs' : 'ours'];
    const add = (segs: string[], baseItem: unknown, kept: unknown, closure: DependentItem[]) => {
      const ownerChanged = !equal(baseItem, kept);
      if (ownerChanged || closure.some((x) => x.change !== 'unchanged' && !x.quiet)) {
        found.push({ segs, deletedBy, ownerChanged, closure });
        return true;
      }
      return false;
    };

    // Annotations and their placements.
    for (const pb of base.parts) {
      const pd = partIn(D, pb.id);
      const pk = partIn(K, pb.id);
      if (!pd || !pk) continue;
      for (const a of pb.annotations ?? []) {
        const ka = findId(pk.annotations, a.id);
        if (!ka || hasId(pd.annotations, a.id)) continue;
        const closure: DependentItem[] = [];
        for (const dk of K.drawings) {
          if (dk.subject?.partId !== pb.id) continue;
          const db = drawingIn(base, dk.id);
          const dd = drawingIn(D, dk.id);
          if (db && !dd) continue; // D deleted the whole drawing: decided at the drawing
          for (const p of dk.placements) {
            if (p.annotationId !== a.id || hasId(dd?.placements, p.id)) continue;
            closure.push({
              segs: ['drawings', dk.id, 'placements', p.id],
              value: p,
              change: changeOf(findId(db?.placements, p.id), p),
            });
          }
        }
        // Its overrides in the configurations both sides still have.
        const overrides: DependentItem[] = [];
        for (const ck of pk.configurations ?? []) {
          const group = ck.annotations?.[a.id];
          const cd = findId(pd.configurations, ck.id);
          if (group === undefined || !cd || cd.annotations?.[a.id] !== undefined) continue;
          const cb = findId(pb.configurations, ck.id);
          overrides.push({
            segs: ['parts', pb.id, 'configurations', ck.id, 'annotations', a.id],
            value: group,
            change: changeOf(cb?.annotations?.[a.id], group),
            quiet: true,
          });
        }
        const owner = ['parts', pb.id, 'annotations', a.id];
        if (!add(owner, a, ka, [...closure, ...overrides])) {
          quiet.push(...overrides.map((x) => x.segs));
        }
      }
    }

    // Sheets and views.
    for (const db of base.drawings) {
      const dd = drawingIn(D, db.id);
      const dk = drawingIn(K, db.id);
      if (!dd || !dk) continue;
      for (const s of db.sheets) {
        const ks = findId(dk.sheets, s.id);
        if (!ks || hasId(dd.sheets, s.id)) continue;
        const closure: DependentItem[] = [];
        const seen = new Set<string>();
        const views: string[] = [];
        for (const v of dk.views) {
          if (v.sheetId !== s.id || hasId(dd.views, v.id)) continue;
          seen.add(`views/${v.id}`);
          closure.push({
            segs: ['drawings', db.id, 'views', v.id],
            value: v,
            change: changeOf(findId(db.views, v.id), v),
          });
          views.push(v.id);
        }
        viewClosure(views, dk, dd, db, closure, seen);
        for (const coll of ['tables', 'notes'] as const) {
          for (const x of dk[coll] as { id: string; sheetId: string }[]) {
            if (x.sheetId !== s.id || hasId(dd[coll], x.id) || seen.has(`${coll}/${x.id}`)) {
              continue;
            }
            seen.add(`${coll}/${x.id}`);
            closure.push({
              segs: ['drawings', db.id, coll, x.id],
              value: x,
              change: changeOf(findId(db[coll] as { id: string }[], x.id), x),
            });
          }
        }
        add(['drawings', db.id, 'sheets', s.id], s, ks, closure);
      }
      for (const v of db.views) {
        const kv = findId(dk.views, v.id);
        if (!kv || hasId(dd.views, v.id)) continue;
        const closure: DependentItem[] = [];
        viewClosure([v.id], dk, dd, db, closure, new Set([`views/${v.id}`]));
        add(['drawings', db.id, 'views', v.id], v, kv, closure);
      }
    }
  }
  // Leave out owners decided by an enclosing owner (same deleting side, one-way containment).
  const inClosure = (x: DependentConflict, of: DependentConflict): boolean => {
    const p = toPointer(x.segs);
    return of.closure.some((c) => toPointer(c.segs) === p);
  };
  const conflicts = found.filter(
    (x) =>
      !found.some(
        (y) => y !== x && y.deletedBy === x.deletedBy && inClosure(x, y) && !inClosure(y, x),
      ),
  );
  return { conflicts, quiet };
}

/** The conflict's side text for the keeping side: "kept (edited; 1 placement added)". */
export function keptText(c: DependentConflict): string {
  const parts: string[] = [];
  if (c.ownerChanged) parts.push('edited');
  const loud = c.closure.filter((x) => !x.quiet);
  for (const change of ['added', 'edited'] as const) {
    const n = loud.filter((x) => x.change === change).length;
    if (n > 0) parts.push(`${plural(n, 'dependent')} ${change}`);
  }
  const what = itemsText(loud.filter((x) => x.change !== 'unchanged').map((x) => x.segs));
  return what === '' ? `kept (${parts.join('; ')})` : `kept (${parts.join('; ')}: ${what})`;
}

/** "2 placements, 1 centre mark and 1 view" for closure paths. */
function itemsText(paths: readonly Segs[]): string {
  const NOUN: Record<string, [string, string]> = {
    placements: ['placement', 'placements'],
    centerMarks: ['centre mark', 'centre marks'],
    tables: ['table', 'tables'],
    views: ['view', 'views'],
    notes: ['note', 'notes'],
  };
  const counts = new Map<string, number>();
  for (const s of paths) counts.set(s[2] as string, (counts.get(s[2] as string) ?? 0) + 1);
  const out: string[] = [];
  for (const k of ['placements', 'centerMarks', 'tables', 'views', 'notes']) {
    const n = counts.get(k);
    const noun = NOUN[k] as [string, string];
    if (n) out.push(plural(n, noun[0], noun[1]));
  }
  return listText(out, 5);
}

/** The dependents a conflict lists, with subjects named in the keeping side. */
export function conflictDependents(
  c: DependentConflict,
  docs: readonly WrenDoc[],
): ConflictDependent[] {
  return c.closure.map((x) => ({
    subject: subjectAt(x.segs, docs),
    path: toPointer(x.segs),
    value: structuredClone(x.value),
    change: x.change,
  }));
}

// ---------------------------------------------------------------------------------------------
// Markup: an append-mostly set
// ---------------------------------------------------------------------------------------------

/** `['drawings', did, 'markup', id]`. */
export function isMarkupItemPath(segs: Segs): boolean {
  return segs.length === 4 && segs[0] === 'drawings' && segs[2] === 'markup';
}

/**
 * A markup deleted on one side and only resolved on the other is deleted (`{ value: undefined }`).
 * `null` when the ordinary rules apply.
 */
export function markupDeletedAgainstResolved(
  b: unknown,
  o: unknown,
  t: unknown,
): { value: undefined; theirs: boolean } | null {
  if (!isObj(b) || (o === undefined) === (t === undefined)) return null;
  const kept = (o ?? t) as Obj;
  if (!isObj(kept) || kept.resolved !== true) return null;
  const strip = (m: Obj) => ({ ...m, resolved: undefined });
  return equal(strip(kept), strip(b)) ? { value: undefined, theirs: t === undefined } : null;
}

// ---------------------------------------------------------------------------------------------
// Notes after the merge
// ---------------------------------------------------------------------------------------------

/** What `normalizeDrawings` (packages/document) reports. */
export interface NormalizeNote {
  kind: string;
  drawingId: Id;
  message: string;
}

/** The normaliser's notes the merge passes on (its drops are reported by the merge itself). */
const PASSED_ON = new Set([
  'viewMovedToFirstSheet',
  'itemMovedToFirstSheet',
  'markupAnchorCleared',
]);

export type DrawingNoteKind =
  | DrawingMergeNoteKind
  | 'viewMovedToFirstSheet'
  | 'itemMovedToFirstSheet'
  | 'markupAnchorCleared'
  /** Both sides removed sheets until none was left: the sheets either side kept stay. */
  | 'lastSheetKept';

/** A drawing or annotation line of the merge report. */
export interface DrawingMergeNote {
  kind: DrawingNoteKind;
  partId?: Id;
  drawingId?: Id;
  subject: DiffSubject;
  /** What it is about: the removed or dropped items, or the flagged annotations (sorted). */
  ids: Id[];
  /** `duplicatePlacementDropped`: the placement that stayed. */
  keptId?: Id;
  summary: string;
}

/** Items of collection `coll` that ours or theirs has in drawing `id` (ours' version first). */
function sideItems<T extends { id: string }>(
  sides: DrawingSides,
  id: string,
  coll: 'placements' | 'centerMarks' | 'tables' | 'views',
): Map<string, T> {
  const out = new Map<string, T>();
  for (const s of [sides.ours, sides.theirs]) {
    const d = drawingIn(s, id);
    for (const x of (d?.[coll] ?? []) as unknown as T[]) if (!out.has(x.id)) out.set(x.id, x);
  }
  return out;
}

interface ViewLoss {
  placements: AnnotationPlacement[];
  marks: CenterMark[];
  tables: DrawingTable[];
  views: DrawingView[];
}

/** The merge report's drawing lines for the merged (normalised) `doc`. */
export function drawingMergeNotes(
  doc: WrenDoc,
  sides: DrawingSides,
  normalizeNotes: readonly NormalizeNote[],
): DrawingMergeNote[] {
  const notes: DrawingMergeNote[] = [];
  const docs = [doc, sides.ours, sides.theirs, sides.base];
  for (const drawing of doc.drawings) {
    const did = drawing.id;
    const pid = drawing.subject?.partId;
    const part = partIn(doc, pid);
    const live = {
      annotations: new Set((part?.annotations ?? []).map((a) => a.id)),
      views: new Set(drawing.views.map((v) => v.id)),
      placements: new Set(drawing.placements.map((p) => p.id)),
      marks: new Set(drawing.centerMarks.map((m) => m.id)),
      tables: new Set(drawing.tables.map((t) => t.id)),
    };
    const byAnnotation = new Map<string, AnnotationPlacement[]>();
    const byView = new Map<string, ViewLoss>();
    // A removed view's losses are reported with the outermost removed view above it.
    const sideViews = sideItems<DrawingView>(sides, did, 'views');
    const rootOf = (vid: string): string => {
      const seen = new Set<string>();
      let cur = vid;
      for (;;) {
        seen.add(cur);
        const v = sideViews.get(cur);
        if (!v || v.kind === 'base' || live.views.has(v.parentId) || seen.has(v.parentId)) {
          return cur;
        }
        if (!sideViews.has(v.parentId)) return cur;
        cur = v.parentId;
      }
    };
    const loss = (viewId: string): ViewLoss => {
      const vid = rootOf(viewId);
      let l = byView.get(vid);
      if (!l) {
        l = { placements: [], marks: [], tables: [], views: [] };
        byView.set(vid, l);
      }
      return l;
    };
    const kept = new Map(drawing.placements.map((p) => [`${p.viewId}\u0000${p.annotationId}`, p]));
    const placements = sideItems<AnnotationPlacement>(sides, did, 'placements');
    for (const [id, p] of [...placements].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (live.placements.has(id)) continue;
      if (part && !live.annotations.has(p.annotationId)) {
        byAnnotation.set(p.annotationId, [...(byAnnotation.get(p.annotationId) ?? []), p]);
      } else if (!live.views.has(p.viewId)) {
        loss(p.viewId).placements.push(p);
      } else {
        const other = kept.get(`${p.viewId}\u0000${p.annotationId}`);
        if (!other) continue; // deleted on purpose by a side: the compare shows it
        const label = placementLabel(p, drawing, docs);
        notes.push({
          kind: 'duplicatePlacementDropped',
          drawingId: did,
          ...(pid === undefined ? {} : { partId: pid }),
          subject: { kind: 'placement', id: other.id, drawingId: did, label },
          ids: [id],
          keptId: other.id,
          summary: `Both sides placed ${label}; one placement was kept and the other dropped`,
        });
      }
    }
    for (const [id, m] of sideItems<CenterMark>(sides, did, 'centerMarks')) {
      if (!live.marks.has(id) && !live.views.has(m.viewId)) loss(m.viewId).marks.push(m);
    }
    for (const [id, t] of sideItems<DrawingTable>(sides, did, 'tables')) {
      if (live.tables.has(id) || t.kind !== 'holeTable' || live.views.has(t.viewId)) continue;
      loss(t.viewId).tables.push(t);
    }
    for (const [id, v] of sideItems<DrawingView>(sides, did, 'views')) {
      if (live.views.has(id) || v.kind === 'base' || live.views.has(v.parentId)) continue;
      loss(v.parentId).views.push(v);
    }
    const where = doc.drawings.length > 1 ? ` in ${drawing.name}` : '';

    for (const [aid, list] of [...byAnnotation].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const label = annotationLabelIn(docs.slice(1), pid, aid, 'an annotation');
      const views = [
        ...new Set(list.map((p) => viewName(docs, did, p.viewId) ?? 'a removed view')),
      ];
      const n = list.length;
      notes.push({
        kind: 'placementRemovedWithAnnotation',
        drawingId: did,
        ...(pid === undefined ? {} : { partId: pid }),
        subject: {
          kind: 'annotation',
          id: aid,
          drawingId: did,
          ...(pid === undefined ? {} : { partId: pid }),
          label,
        },
        ids: list.map((p) => p.id),
        summary:
          n === 1
            ? `The placement of ${label} in ${views[0]}${where} was removed with the annotation`
            : `${n} placements of ${label} (${listText(views)})${where} were removed with the annotation`,
      });
    }
    for (const [vid, l] of [...byView].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const label = viewName(docs.slice(1), did, vid) ?? 'a view';
      const parts: string[] = [];
      if (l.placements.length) parts.push(plural(l.placements.length, 'placement'));
      if (l.marks.length) parts.push(plural(l.marks.length, 'centre mark'));
      if (l.tables.length) parts.push(plural(l.tables.length, 'hole table'));
      for (const v of l.views) parts.push(viewName(docs.slice(1), did, v.id) ?? 'a view');
      const n = l.placements.length + l.marks.length + l.tables.length + l.views.length;
      notes.push({
        kind: 'placementRemovedWithView',
        drawingId: did,
        ...(pid === undefined ? {} : { partId: pid }),
        subject: { kind: 'view', id: vid, drawingId: did, label },
        ids: [...l.placements, ...l.marks, ...l.tables, ...l.views].map((x) => x.id).sort(),
        summary: `${capFirst(listText(parts, 5))}${where} ${n === 1 ? 'was' : 'were'} removed with ${label}`,
      });
    }
  }

  // Datum letters and promoted dimensions both sides added: both kept, flagged.
  for (const part of doc.parts) {
    const annotations = part.annotations ?? [];
    const groups = new Map<string, Annotation[]>();
    const promo = new Map<string, Annotation[]>();
    for (const a of annotations) {
      if (a.kind === 'datumFeature' && typeof a.label === 'string' && a.label !== '') {
        groups.set(a.label, [...(groups.get(a.label) ?? []), a]);
      }
      const key = promotionKey(a);
      if (key !== undefined) promo.set(key, [...(promo.get(key) ?? []), a]);
    }
    const preexisting = (ids: readonly string[]) =>
      [sides.base, sides.ours, sides.theirs].some((s) => {
        const p = partIn(s, part.id);
        return ids.every((id) => hasId(p?.annotations, id));
      });
    for (const [label, list] of groups) {
      const ids = list.map((a) => a.id).sort();
      if (list.length < 2 || preexisting(ids)) continue;
      notes.push({
        kind: 'duplicateDatumLabel',
        partId: part.id,
        subject: {
          kind: 'annotation',
          id: ids[0] as string,
          partId: part.id,
          label: `Datum ${label}`,
        },
        ids,
        summary: `${list.length === 2 ? 'Both sides' : `${list.length} edits`} added datum ${label} to ${part.name}; ${list.length === 2 ? 'both are' : 'all are'} kept. Frames refer to datums by id, so nothing changed meaning; rename one`,
      });
    }
    for (const list of promo.values()) {
      const ids = list.map((a) => a.id).sort();
      if (list.length < 2 || preexisting(ids)) continue;
      const first = list.find((a) => a.id === ids[0]) as Annotation;
      const label = annotationLabel(first, part, doc);
      notes.push({
        kind: 'duplicatePromotion',
        partId: part.id,
        subject: { kind: 'annotation', id: ids[0] as string, partId: part.id, label },
        ids,
        summary: `Both sides promoted the same dimension (${label}) in ${part.name}; both are kept. Merge the duplicates to keep one`,
      });
    }
  }

  for (const n of normalizeNotes) {
    if (!PASSED_ON.has(n.kind)) continue;
    const d = drawingIn(doc, n.drawingId);
    notes.push({
      kind: n.kind as DrawingNoteKind,
      drawingId: n.drawingId,
      subject: { kind: 'drawing', id: n.drawingId, label: d?.name ?? n.drawingId },
      ids: [],
      summary: n.message,
    });
  }
  return notes;
}

/**
 * A drawing needs a sheet. When each side removed the sheets the other kept, the merge would have
 * none: the sheets either side still has are kept (base order, then id), with a note.
 */
export function keepLastSheets(doc: WrenDoc, sides: DrawingSides): DrawingMergeNote[] {
  const notes: DrawingMergeNote[] = [];
  for (const d of doc.drawings) {
    if (d.sheets.length > 0) continue;
    const kept = new Map<string, Drawing['sheets'][number]>();
    for (const s of [sides.ours, sides.theirs]) {
      for (const sheet of drawingIn(s, d.id)?.sheets ?? []) {
        if (!kept.has(sheet.id)) kept.set(sheet.id, structuredClone(sheet));
      }
    }
    if (kept.size === 0) continue;
    const order = (drawingIn(sides.base, d.id)?.sheets ?? []).map((x) => x.id);
    const rank = (x: string) => (order.includes(x) ? order.indexOf(x) : order.length);
    d.sheets = [...kept.values()].sort(
      (a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const names = d.sheets.map((x) => sheetLabel(x, d));
    notes.push({
      kind: 'lastSheetKept',
      drawingId: d.id,
      subject: { kind: 'drawing', id: d.id, label: d.name },
      ids: d.sheets.map((x) => x.id),
      summary: `Both sides removed sheets of ${d.name} until none was left; ${listText(names)} ${names.length === 1 ? 'was' : 'were'} kept`,
    });
  }
  return notes;
}

const capFirst = (s: string): string => (s === '' ? s : s[0]?.toUpperCase() + s.slice(1));

function viewName(docs: readonly WrenDoc[], did: string, vid: string): string | undefined {
  for (const d of docs) {
    const dr = drawingIn(d, did);
    const v = findId(dr?.views, vid);
    if (v) return viewLabel(v, dr);
  }
  return undefined;
}

/** Two annotations promoted from the same driving dimension or feature field share this key. */
function promotionKey(a: Annotation): string | undefined {
  const s = (a as { source?: unknown }).source;
  if (!isObj(s)) return undefined;
  if (s.kind === 'sketchDimension') return `${a.kind}|s|${s.featureId}|${s.constraintId}`;
  if (s.kind === 'featureField') return `${a.kind}|f|${s.featureId}|${s.path}`;
  return undefined;
}
