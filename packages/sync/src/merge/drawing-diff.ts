// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Compare lines for part annotations and drawings (M4, PLAN §8A.3 item 4, proposal §5):
 *  - annotations: "Added Dimension Ø6", "Removed Datum B", "Dimension Ø6: nominal 6 → 8",
 *    "Dimension Ø6: tolerance upper 0.1 mm → 0.2 mm", "Datum A: reattached", "Suppressed Note
 *    “BREAK SHARP EDGES”";
 *  - drawings: the drawing's own settings ("Bracket drawing: projection third → first"), sheets
 *    ("Added Sheet 2", "Renamed Sheet 2 → Sheet Details", "Sheet 1: scale 1/2 → 1/1", "Moved Sheet
 *    2 to the front"), views ("Added View Top on Sheet 1", "View Front: moved", "View Front:
 *    moved to Sheet 2", "View Front: scale 1/2 → 1"), placements ("Placed Dimension Ø6 in View
 *    Front", "Dimension Ø6 in View Front: moved"), centre marks, tables, sheet notes and markup
 *    ("Resolved Markup by Ana").
 * Every line's subject carries `drawingId` (and the item's id), so the compare panel can show the
 * changed views and placements on the sheet.
 */

import type {
  Annotation,
  DiffChange,
  DiffSubject,
  Drawing,
  FieldChange,
  Markup,
  NamedDimension,
  Part,
  WrenDoc,
} from '@wren-cad/contracts';
import { collectFields, fieldChangeText, movedIds } from './diff';
import { annotationLabel, placementLabel, sheetLabel, snippet, viewLabel } from './drawing-labels';
import { annotationDims, type Units } from './format';
import { annotationFieldLabel, subjectAt } from './labels';
import { byId, idsOf, type Segs } from './tree';

/** Field lines inside one annotation or drawing item, with drawing-aware words. */
function itemTexts(
  abs: Segs,
  prev: unknown,
  cur: unknown,
  units: Units,
  skip: ReadonlySet<string>,
  words: {
    dims?: Map<string, NamedDimension>;
    sheet?: (id: string) => string;
    view?: (id: string) => string;
  } = {},
): { fields: FieldChange[]; texts: string[] } {
  const fs: FieldChange[] = [];
  collectFields(abs, [], prev, cur, skip, fs);
  const texts: string[] = [];
  const add = (t: string) => {
    if (!texts.includes(t)) texts.push(t);
  };
  for (const fc of fs) {
    fc.label = annotationFieldLabel(fc.path);
    const top = fc.path.split('/')[1] ?? '';
    if (top === 'sheetId' && typeof fc.after === 'string' && words.sheet) {
      add(`moved to ${words.sheet(fc.after)}`);
    } else if (top === 'viewId' && typeof fc.after === 'string' && words.view) {
      add(`moved to ${words.view(fc.after)}`);
    } else if (top === 'layout' || top === 'position' || top === 'anchor' || top === 'origin') {
      add(top === 'anchor' ? 'anchor changed' : 'moved');
    } else if (top === 'refs' || top === 'at') {
      add('reattached');
    } else if (top === 'text' && (typeof fc.before === 'string' || typeof fc.after === 'string')) {
      const b = typeof fc.before === 'string' ? `“${snippet(fc.before)}”` : 'none';
      const a = typeof fc.after === 'string' ? `“${snippet(fc.after)}”` : 'none';
      add(`text ${b} → ${a}`);
    } else {
      add(fieldChangeText(fc, units, words.dims));
    }
  }
  return { fields: fs, texts };
}

/** Compare lines for the annotations of `old` → `part` (the same part in `before` and `after`). */
export function annotationChanges(
  before: WrenDoc,
  after: WrenDoc,
  old: Part,
  part: Part,
): DiffChange[] {
  const out: DiffChange[] = [];
  const units = after.units;
  const segs = ['parts', part.id, 'annotations'];
  const subject = (id: string, gone = false): DiffSubject =>
    subjectAt([...segs, id], gone ? [before, after] : [after, before]);
  const bm = byId(old.annotations ?? []);
  const am = byId(part.annotations ?? []);
  for (const a of part.annotations ?? []) {
    const prev = bm.get(a.id) as Annotation | undefined;
    if (!prev) {
      out.push({
        kind: 'added',
        subject: subject(a.id),
        summary: `Added ${annotationLabel(a, part, after)}`,
      });
      continue;
    }
    const was = annotationLabel(prev, old, before);
    if (prev.kind !== a.kind) {
      out.push({
        kind: 'modified',
        subject: subject(a.id),
        fields: [{ path: '/kind', label: 'kind', before: prev.kind, after: a.kind }],
        summary: `Changed ${was} to ${annotationLabel(a, part, after)}`,
      });
      continue;
    }
    const dims = new Map([...annotationDims(prev), ...annotationDims(a)]);
    const { fields, texts } = itemTexts(
      [...segs, a.id],
      prev,
      a,
      units,
      new Set(['id', 'suppressed']),
      {
        dims,
      },
    );
    const suppression =
      (prev.suppressed === true) === (a.suppressed === true)
        ? null
        : a.suppressed
          ? 'suppressed'
          : 'unsuppressed';
    if (suppression) {
      fields.push({
        path: '/suppressed',
        label: 'suppressed',
        before: prev.suppressed,
        after: a.suppressed,
      });
    }
    if (texts.length === 0 && suppression) {
      out.push({
        kind: 'modified',
        subject: subject(a.id),
        fields,
        summary: `${suppression === 'suppressed' ? 'Suppressed' : 'Unsuppressed'} ${was}`,
      });
    } else if (texts.length > 0) {
      out.push({
        kind: 'modified',
        subject: subject(a.id),
        fields,
        summary: `${was}: ${[...texts, ...(suppression ? [suppression] : [])].join(', ')}`,
      });
    }
  }
  for (const a of old.annotations ?? []) {
    if (am.has(a.id)) continue;
    out.push({
      kind: 'removed',
      subject: subject(a.id, true),
      summary: `Removed ${annotationLabel(a, old, before)}`,
    });
  }
  return out;
}

const CONTENT = new Set([
  'id',
  'name',
  'sheets',
  'views',
  'placements',
  'centerMarks',
  'tables',
  'notes',
  'markup',
]);

type Coll = 'views' | 'placements' | 'centerMarks' | 'tables' | 'notes' | 'markup';

/** Compare lines inside one drawing (`old` in `before` → `d` in `after`; added/removed drawings are one line each elsewhere). */
export function drawingChanges(
  before: WrenDoc,
  after: WrenDoc,
  old: Drawing,
  d: Drawing,
): DiffChange[] {
  const out: DiffChange[] = [];
  const units = after.units;
  const did = d.id;
  const root = ['drawings', did];
  const subject = (segs: Segs, gone = false): DiffSubject =>
    subjectAt([...root, ...segs], gone ? [before, after] : [after, before]);
  const sheetName = (id: string): string => {
    const s = d.sheets.find((x) => x.id === id) ?? old.sheets.find((x) => x.id === id);
    return s ? sheetLabel(s, d) : 'a removed sheet';
  };
  const viewName = (id: string): string => {
    const v = d.views.find((x) => x.id === id);
    if (v) return viewLabel(v, d);
    const w = old.views.find((x) => x.id === id);
    return w ? viewLabel(w, old) : 'a removed view';
  };

  // The drawing's own settings: projection, standard, style, template, configuration, subject.
  {
    const { fields, texts } = itemTexts(root, old, d, units, CONTENT, { sheet: sheetName });
    if (texts.length > 0) {
      out.push({
        kind: 'modified',
        subject: subjectAt(root, [after, before]),
        fields,
        summary: `${d.name}: ${texts.join(', ')}`,
      });
    }
  }

  // Sheets (ordered: numbering).
  const bs = byId(old.sheets);
  const as = byId(d.sheets);
  const moved = movedIds(idsOf(old.sheets), idsOf(d.sheets));
  for (const [i, s] of d.sheets.entries()) {
    const prev = bs.get(s.id) as Drawing['sheets'][number] | undefined;
    const label = sheetLabel(s, d);
    if (!prev) {
      out.push({ kind: 'added', subject: subject(['sheets', s.id]), summary: `Added ${label}` });
      continue;
    }
    const was = sheetLabel(prev, old);
    const { fields, texts } = itemTexts(
      [...root, 'sheets', s.id],
      prev,
      s,
      units,
      new Set(['id', 'name']),
    );
    if (prev.name !== s.name) {
      out.push({
        kind: 'renamed',
        subject: subject(['sheets', s.id]),
        fields: [{ path: '/name', label: 'name', before: prev.name, after: s.name }, ...fields],
        summary: [`Renamed ${was} → ${label}`, ...texts].join(', '),
      });
    } else if (texts.length > 0) {
      out.push({
        kind: 'modified',
        subject: subject(['sheets', s.id]),
        fields,
        summary: `${label}: ${texts.join(', ')}`,
      });
    }
    if (moved.has(s.id)) {
      const after = i > 0 ? d.sheets[i - 1] : undefined;
      out.push({
        kind: 'moved',
        subject: subject(['sheets', s.id]),
        summary: after
          ? `Moved ${label} after ${sheetLabel(after, d)}`
          : `Moved ${label} to the front`,
      });
    }
  }
  for (const s of old.sheets) {
    if (as.has(s.id)) continue;
    out.push({
      kind: 'removed',
      subject: subject(['sheets', s.id], true),
      summary: `Removed ${sheetLabel(s, old)}`,
    });
  }

  // The sets.
  const docs = [after, before];
  const gone = [before, after];
  const labelOf = (coll: Coll, x: unknown, side: 'after' | 'before'): string => {
    const dr = side === 'after' ? d : old;
    switch (coll) {
      case 'placements':
        return placementLabel(
          x as { annotationId: string; viewId: string },
          dr,
          side === 'after' ? docs : gone,
        );
      default:
        return subjectAt([...root, coll, (x as { id: string }).id], side === 'after' ? docs : gone)
          .label;
    }
  };
  const addedText = (coll: Coll, x: unknown): string => {
    const label = labelOf(coll, x, 'after');
    switch (coll) {
      case 'views':
        return `Added ${label} on ${sheetName((x as { sheetId: string }).sheetId)}`;
      case 'placements':
        return `Placed ${label}`;
      default:
        return `Added ${lower(label)}`;
    }
  };
  const removedText = (coll: Coll, x: unknown): string => {
    if (coll === 'placements') {
      const p = x as { annotationId: string; viewId: string };
      const a = placementLabel(p, old, gone);
      return `Removed ${a.replace(/ in (.*)$/, ' from $1')}`;
    }
    return `Removed ${lower(labelOf(coll, x, 'before'))}`;
  };
  for (const coll of ['views', 'placements', 'centerMarks', 'tables', 'notes', 'markup'] as const) {
    const bl = (old[coll] ?? []) as { id: string }[];
    const al = (d[coll] ?? []) as { id: string }[];
    const bm = byId(bl);
    const am = byId(al);
    for (const x of al) {
      const prev = bm.get(x.id);
      const segs = [coll, x.id];
      if (prev === undefined) {
        out.push({ kind: 'added', subject: subject(segs), summary: addedText(coll, x) });
        continue;
      }
      if (coll === 'markup') {
        const [pr, cr] = [(prev as Markup).resolved === true, (x as Markup).resolved === true];
        if (pr !== cr) {
          out.push({
            kind: 'modified',
            subject: subject(segs),
            fields: [{ path: '/resolved', label: 'resolved', before: pr, after: cr }],
            summary: `${cr ? 'Resolved' : 'Reopened'} ${lower(labelOf(coll, x, 'after'))}`,
          });
        }
      }
      const skip = new Set(coll === 'markup' ? ['id', 'resolved'] : ['id']);
      const { fields, texts } = itemTexts([...root, ...segs], prev, x, units, skip, {
        sheet: sheetName,
        view: viewName,
      });
      if (texts.length === 0) continue;
      out.push({
        kind: 'modified',
        subject: subject(segs),
        fields,
        summary: `${labelOf(coll, prev, 'before')}: ${texts.join(', ')}`,
      });
    }
    for (const x of bl) {
      if (am.has(x.id)) continue;
      out.push({
        kind: 'removed',
        subject: subject([coll, x.id], true),
        summary: removedText(coll, x),
      });
    }
  }
  return out;
}

/** "Note “…”" stays capitalised; "Hole table of …" → "hole table of …" after a verb. */
function lower(label: string): string {
  return /^(Centre|Bolt|Hole|Part|Note|Markup)\b/.test(label)
    ? label[0]?.toLowerCase() + label.slice(1)
    : label;
}
