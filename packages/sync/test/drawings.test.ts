// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M4 drawing merge (proposal §5, ADR-090): one test per row of the mergeability table, then
 * markup, the dependent-edit rule's resolutions (re-run and by path), labels and the drawing
 * compare.
 */

import type { Annotation, Configuration, MergeResult, WrenDoc } from '@wren-cad/contracts';
import { canonicalJson } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import {
  conflictSummary,
  type DrawingMergeNote,
  docDiffer,
  docMerger,
  mergeNotes,
  type StructuralMergeConflict,
  subjectAt,
} from '../src';
import {
  A_DATUM,
  A_DIA,
  A_LIN,
  A_NOTE,
  annotationOf,
  DRAWING,
  drawingDoc,
  drawingOf,
  editAnnotation,
  editPlacement,
  editView,
  HOLES,
  MARK,
  MARKUP,
  markup,
  NOTE,
  P_DATUM,
  P_DIA,
  P_LIN,
  place,
  placementOf,
  run,
  S1,
  S2,
  S3,
  sheet,
  V_FRONT,
  V_SECTION,
  V_TOP,
  viewOf,
} from './support/drawings';
import { EXTRUDE, id, PART, problems, ref, SKETCH, sk } from './support/fixtures';

const LONG = id(80);

const merge = (b: WrenDoc, o: WrenDoc, t: WrenDoc) => docMerger.merge(b, o, t);
/** Both orders of the two sides. */
const both = (b: WrenDoc, x: WrenDoc, y: WrenDoc): MergeResult[] => [
  merge(b, x, y),
  merge(b, y, x),
];

const drawingNotes = (r: MergeResult) =>
  mergeNotes(r).filter((n): n is DrawingMergeNote => 'ids' in n);
const noteKinds = (r: MergeResult) => mergeNotes(r).map((n) => n.kind);
const conflictsOf = (r: MergeResult) =>
  r.conflicts.map((c) => [c.kind, c.path, c.subject.kind, c.subject.label]);

function valid(doc: WrenDoc): void {
  expect(problems(doc)).toEqual([]);
}

const removeAnnotation = (doc: WrenDoc, ...annotationIds: string[]) =>
  run(doc, { kind: 'removeAnnotation', partId: PART, annotationIds });

const tolerance = (upper: string) => ({
  tolerance: { kind: 'bilateral', upper, lower: '-0.1mm' },
});

describe('the §5 table', () => {
  it('different annotations, or different fields of one annotation: clean', () => {
    const b = drawingDoc();
    for (const [o, t] of [
      [
        editAnnotation(b, A_DIA, tolerance('0.2mm')),
        editAnnotation(b, A_LIN, { text: { suffix: 'TYP' } }),
      ],
      [
        editAnnotation(b, A_DIA, tolerance('0.2mm')),
        editAnnotation(b, A_DIA, { text: { prefix: '4×' } }),
      ],
    ] as const) {
      for (const r of both(b, o, t)) {
        expect(r.conflicts).toEqual([]);
        const dia = annotationOf(r.doc, A_DIA) as Annotation & Record<string, unknown>;
        expect(dia.tolerance).toEqual({ kind: 'bilateral', upper: '0.2mm', lower: '-0.1mm' });
        valid(r.doc);
      }
    }
    const r = merge(
      b,
      editAnnotation(b, A_DIA, tolerance('0.2mm')),
      editAnnotation(b, A_DIA, { text: { prefix: '4×' } }),
    );
    expect((annotationOf(r.doc, A_DIA) as { text?: unknown }).text).toEqual({ prefix: '4×' });
  });

  it('the same annotation field on both sides: bothModified', () => {
    const b = drawingDoc();
    const r = merge(
      b,
      editAnnotation(b, A_DIA, tolerance('0.2mm')),
      editAnnotation(b, A_DIA, tolerance('0.3mm')),
    );
    expect(conflictsOf(r)).toEqual([
      [
        'bothModified',
        `/parts/${PART}/annotations/${A_DIA}/tolerance/upper`,
        'annotation',
        'Dimension Ø6',
      ],
    ]);
    expect(conflictSummary(r.conflicts[0] as StructuralMergeConflict)).toBe(
      'Dimension Ø6 tolerance upper: 0.2 mm vs 0.3 mm',
    );
    const c = r.conflicts[0];
    const doc = docMerger.resolve(r, [{ conflictId: c?.id ?? '', take: 'theirs' }]);
    expect((annotationOf(doc, A_DIA) as { tolerance?: { upper?: string } }).tolerance?.upper).toBe(
      '0.3mm',
    );
  });

  it('one side moves a view, the other switches projection: clean (relative layout)', () => {
    const b = drawingDoc();
    const o = editView(b, V_FRONT, { layout: { kind: 'free', position: [140, 150] } });
    const t = run(b, {
      kind: 'updateDrawing',
      drawingId: DRAWING,
      changes: { projection: 'third' },
    });
    for (const r of both(b, o, t)) {
      expect(r.conflicts).toEqual([]);
      expect(drawingOf(r.doc).projection).toBe('third');
      expect(viewOf(r.doc, V_FRONT)).toMatchObject({ layout: { position: [140, 150] } });
      // The aligned child keeps its relative layout: nothing to edit.
      expect(viewOf(r.doc, V_TOP)).toEqual(viewOf(b, V_TOP));
      valid(r.doc);
    }
  });

  it('one side moves a view to sheet 2, the other edits its scale: clean', () => {
    const b = drawingDoc();
    const o = editView(b, V_SECTION, { sheetId: S1 });
    const t = editView(b, V_SECTION, { scale: '1' });
    for (const r of both(b, o, t)) {
      expect(r.conflicts).toEqual([]);
      expect(viewOf(r.doc, V_SECTION)).toMatchObject({ sheetId: S1, scale: '1' });
    }
    const back = merge(
      b,
      editView(b, V_FRONT, { sheetId: S2 }),
      editView(b, V_FRONT, { scale: '1' }),
    );
    expect(back.conflicts).toEqual([]);
    expect(viewOf(back.doc, V_FRONT)).toMatchObject({ sheetId: S2, scale: '1' });
  });

  it('one side deletes annotation X, the other leaves its placements: removed, with a note', () => {
    const b = drawingDoc();
    const o = removeAnnotation(b, A_DIA);
    // Theirs edits something else in the same placement list and the same part.
    const t = editAnnotation(editPlacement(b, P_LIN, { arrows: 'inside' }), A_LIN, {
      text: { suffix: 'TYP' },
    });
    for (const r of both(b, o, t)) {
      expect(r.conflicts).toEqual([]);
      expect(annotationOf(r.doc, A_DIA)).toBeUndefined();
      expect(placementOf(r.doc, P_DIA)).toBeUndefined();
      expect(placementOf(r.doc, P_LIN)?.arrows).toBe('inside');
      const notes = drawingNotes(r);
      expect(notes.map((n) => [n.kind, n.ids, n.subject.kind, n.subject.id])).toEqual([
        ['placementRemovedWithAnnotation', [P_DIA], 'annotation', A_DIA],
      ]);
      expect(notes[0]?.summary).toBe(
        'The placement of Dimension Ø6 in View Front was removed with the annotation',
      );
      valid(r.doc);
    }
  });

  it('one side deletes X, the other adds a placement of X: modifiedDeleted on X with its dependents', () => {
    const b = drawingDoc();
    const o = removeAnnotation(b, A_DIA);
    const added = id(300);
    const t = place(b, added, V_TOP, A_DIA);
    const r = merge(b, o, t);
    expect(conflictsOf(r)).toEqual([
      ['modifiedDeleted', `/parts/${PART}/annotations/${A_DIA}`, 'annotation', 'Dimension Ø6'],
    ]);
    const c = r.conflicts[0] as StructuralMergeConflict;
    expect(c.dependents?.map((d) => [d.subject.kind, d.subject.label, d.change])).toEqual([
      ['placement', 'Dimension Ø6 in View Front', 'unchanged'],
      ['placement', 'Dimension Ø6 in View Top', 'added'],
    ]);
    expect(c.text).toEqual({
      ours: 'deleted',
      theirs: 'kept (1 dependent added: 1 placement)',
    });
    expect(conflictSummary(c)).toBe(
      'Dimension Ø6: deleted vs kept (1 dependent added: 1 placement)',
    );
    // Ours (the delete) stands until resolved; the new placement went with it, said so.
    expect(annotationOf(r.doc, A_DIA)).toBeUndefined();
    expect(placementOf(r.doc, added)).toBeUndefined();
    expect(drawingNotes(r).map((n) => [n.kind, n.ids])).toEqual([
      ['placementRemovedWithAnnotation', [P_DIA, added]],
    ]);
    valid(r.doc);
    // Taking theirs keeps X with every placement, including the unchanged one ours removed.
    const kept = docMerger.resolve(r, [{ conflictId: c.id, take: 'theirs' }]);
    expect(annotationOf(kept, A_DIA)).toEqual(annotationOf(b, A_DIA));
    expect(placementOf(kept, P_DIA)).toEqual(placementOf(b, P_DIA));
    expect(placementOf(kept, added)?.viewId).toBe(V_TOP);
    valid(kept);
    // The swapped merge holds theirs-as-ours: kept until resolved.
    const swapped = merge(b, t, o);
    expect(swapped.conflicts.map((x) => x.id)).toEqual([c.id]);
    expect(placementOf(swapped.doc, added)).toBeDefined();
    expect(canonicalJson(swapped.doc)).toBe(canonicalJson(kept));
  });

  it('one side deletes X, the other edits a placement of X or X itself: modifiedDeleted on X', () => {
    const b = drawingDoc();
    const o = removeAnnotation(b, A_DIA);
    const edited = editPlacement(b, P_DIA, { layout: { kind: 'radial', angle: 90, distance: 6 } });
    const r = merge(b, o, edited);
    expect(conflictsOf(r)).toEqual([
      ['modifiedDeleted', `/parts/${PART}/annotations/${A_DIA}`, 'annotation', 'Dimension Ø6'],
    ]);
    // One decision: the placement's own delete-against-edit is decided with X.
    expect((r.conflicts[0] as StructuralMergeConflict).dependents?.map((d) => d.change)).toEqual([
      'edited',
    ]);
    const kept = docMerger.resolve(r, [{ conflictId: r.conflicts[0]?.id ?? '', take: 'theirs' }]);
    expect(placementOf(kept, P_DIA)?.layout).toEqual({ kind: 'radial', angle: 90, distance: 6 });

    const x = merge(b, o, editAnnotation(b, A_DIA, { nominal: '8mm' }));
    expect(conflictsOf(x)).toEqual([
      ['modifiedDeleted', `/parts/${PART}/annotations/${A_DIA}`, 'annotation', 'Dimension Ø8'],
    ]);
    expect((x.conflicts[0] as StructuralMergeConflict).text?.theirs).toBe('kept (edited)');
    const y = docMerger.resolve(x, [{ conflictId: x.conflicts[0]?.id ?? '', take: 'theirs' }]);
    expect(annotationOf(y, A_DIA)).toMatchObject({ nominal: '8mm' });
    expect(placementOf(y, P_DIA)).toEqual(placementOf(b, P_DIA));
  });

  it('one side deletes a view, the other adds or edits placements, marks or children in it', () => {
    const b = drawingDoc();
    const o = run(b, { kind: 'removeViews', drawingId: DRAWING, viewIds: [V_FRONT] });
    expect(drawingOf(o).views).toEqual([]);
    const viewConflict = `/drawings/${DRAWING}/views/${V_FRONT}`;
    const cases: [string, WrenDoc][] = [
      ['placement added', place(b, id(301), V_FRONT, A_NOTE)],
      ['placement edited', editPlacement(b, P_LIN, { arrows: 'outside' })],
      [
        'mark added',
        run(b, {
          kind: 'addCenterMark',
          drawingId: DRAWING,
          mark: { id: id(302), viewId: V_FRONT, kind: 'centerLine', refs: [ref('a'), ref('b')] },
        }),
      ],
      ['child edited', editView(b, V_TOP, { layout: { kind: 'aligned', distance: 90 } })],
      ['placement in a child added', place(b, id(303), V_TOP, A_NOTE)],
    ];
    for (const [what, t] of cases) {
      const r = merge(b, o, t);
      expect(conflictsOf(r), what).toEqual([
        ['modifiedDeleted', viewConflict, 'view', 'View Front'],
      ]);
      valid(r.doc);
      // Deleted (ours) until resolved: everything under it went too, and the report says so.
      expect(drawingOf(r.doc).views, what).toEqual([]);
      expect(noteKinds(r), what).toEqual(['placementRemovedWithView']);
      const kept = docMerger.resolve(r, [{ conflictId: r.conflicts[0]?.id ?? '', take: 'theirs' }]);
      expect(drawingOf(kept), what).toEqual(drawingOf(t));
    }
    const r = merge(b, o, cases[3]?.[1] as WrenDoc);
    expect(
      (r.conflicts[0] as StructuralMergeConflict).dependents?.map((d) => [
        d.subject.label,
        d.change,
      ]),
    ).toEqual([
      ['Dimension Ø6 in View Front', 'unchanged'],
      ['Dimension depth in View Front', 'unchanged'],
      ['Centre mark in View Front', 'unchanged'],
      ['Hole table of View Front', 'unchanged'],
      ['View Top', 'edited'],
      ['Section A–A', 'unchanged'],
      ['Datum A in View Top', 'unchanged'],
    ]);
    // Unchanged dependents go with the view, with one note.
    const quiet = merge(
      b,
      o,
      run(b, { kind: 'updateDrawing', drawingId: DRAWING, changes: { name: 'B' } }),
    );
    expect(quiet.conflicts).toEqual([]);
    expect(drawingNotes(quiet).map((n) => [n.kind, n.summary])).toEqual([
      [
        'placementRemovedWithView',
        '3 placements, 1 centre mark, 1 hole table, View Top and Section A–A were removed with View Front',
      ],
    ]);
    expect(drawingNotes(quiet)[0]?.ids).toEqual(
      [P_DIA, P_LIN, P_DATUM, MARK, HOLES, V_TOP, V_SECTION].sort(),
    );
  });

  it('overrides of a deleted annotation are removed with it, with a note', () => {
    const configured = (doc: WrenDoc, config: Configuration): WrenDoc => {
      const next = structuredClone(doc);
      const part = next.parts.find((p) => p.id === PART);
      if (part) part.configurations = [config];
      return next;
    };
    const b = configured(drawingDoc(), {
      id: LONG,
      name: 'Long',
      annotations: { [A_DIA]: { suppressed: true } },
    });
    valid(b);
    const o = removeAnnotation(b, A_DIA);
    expect(o.parts[0]?.configurations?.[0]).toEqual({ id: LONG, name: 'Long' });
    // Theirs leaves the override, or edits it: either way it goes with the annotation.
    const edited = configured(b, {
      id: LONG,
      name: 'Long',
      annotations: { [A_DIA]: { suppressed: false, fields: { '/nominal': '7mm' } } },
    });
    for (const t of [b, edited]) {
      for (const r of both(b, o, t)) {
        expect(r.conflicts).toEqual([]);
        expect(r.doc.parts[0]?.configurations?.[0]).toEqual({ id: LONG, name: 'Long' });
        const n = mergeNotes(r).find((x) => x.kind === 'overrideRemovedWithAnnotation');
        expect(n?.summary).toBe(
          t === b
            ? 'The override of Dimension Ø6 in Long was removed with the annotation'
            : 'Overrides of Dimension Ø6 in Long were removed with the annotation',
        );
        valid(r.doc);
      }
    }
    // A dangling override from an older writer is dropped the same way.
    const dangling = configured(o, {
      id: LONG,
      name: 'Long',
      annotations: { [A_DIA]: { suppressed: true } },
    });
    const r = merge(
      b,
      o,
      run(dangling, { kind: 'updateDrawing', drawingId: DRAWING, changes: { name: 'B' } }),
    );
    expect(r.conflicts).toEqual([]);
    expect(r.doc.parts[0]?.configurations?.[0]).toEqual({ id: LONG, name: 'Long' });
    // Kept by a conflict on the annotation: its overrides come back with it.
    const k = merge(b, o, editAnnotation(b, A_DIA, { nominal: '8mm' }));
    const kept = docMerger.resolve(k, [{ conflictId: k.conflicts[0]?.id ?? '', take: 'theirs' }]);
    expect(kept.parts[0]?.configurations?.[0]?.annotations).toEqual({
      [A_DIA]: { suppressed: true },
    });
  });

  it('both sides place the same annotation in the same view: the smaller id stays, noted', () => {
    const b = drawingDoc();
    const o = place(b, id(311), V_TOP, A_NOTE);
    const t = place(b, id(310), V_TOP, A_NOTE);
    for (const r of both(b, o, t)) {
      expect(r.conflicts).toEqual([]);
      const ps = drawingOf(r.doc).placements.filter((p) => p.annotationId === A_NOTE);
      expect(ps.map((p) => p.id)).toEqual([id(310)]);
      const notes = drawingNotes(r);
      expect(notes.map((n) => [n.kind, n.ids, n.keptId])).toEqual([
        ['duplicatePlacementDropped', [id(311)], id(310)],
      ]);
      expect(notes[0]?.summary).toBe(
        'Both sides placed Note “BREAK SHARP EDGES” in View Top; one placement was kept and the other dropped',
      );
      valid(r.doc);
    }
  });

  it('both sides add a datum B: both kept, flagged', () => {
    const b = drawingDoc();
    const datum = (aid: string): Annotation => ({
      id: aid,
      kind: 'datumFeature',
      origin: { kind: 'model' },
      refs: [ref(`F${EXTRUDE}:end`)],
      label: 'B',
    });
    const add = (aid: string) =>
      run(b, { kind: 'addAnnotation', partId: PART, annotation: datum(aid) });
    for (const r of both(b, add(id(121)), add(id(120)))) {
      expect(r.conflicts).toEqual([]);
      expect(annotationOf(r.doc, id(120))).toBeDefined();
      expect(annotationOf(r.doc, id(121))).toBeDefined();
      const notes = drawingNotes(r);
      expect(notes.map((n) => [n.kind, n.ids, n.subject.label])).toEqual([
        ['duplicateDatumLabel', [id(120), id(121)], 'Datum B'],
      ]);
      expect(notes[0]?.summary).toMatch(/^Both sides added datum B to Bracket; both are kept/);
      valid(r.doc);
    }
    // A datum letter that was already shared before the merge is not news.
    const already = add(id(120));
    const twice = run(already, {
      kind: 'updateDrawing',
      drawingId: DRAWING,
      changes: { name: 'B' },
    });
    expect(noteKinds(merge(already, twice, already))).toEqual([]);
  });

  it('both sides promote the same driving dimension: both kept, flagged', () => {
    const b = drawingDoc();
    const promoted = (aid: string): Annotation => ({
      id: aid,
      kind: 'linear',
      origin: { kind: 'model' },
      refs: [ref(`S${SKETCH}:e(${sk(6)})`, 'edge')],
      direction: [0, 1, 0],
      source: { kind: 'sketchDimension', featureId: SKETCH, constraintId: sk(23) },
    });
    const o = place(b, id(321), V_FRONT, id(131), promoted(id(131)));
    const t = place(b, id(320), V_FRONT, id(130), promoted(id(130)));
    for (const r of both(b, o, t)) {
      expect(r.conflicts).toEqual([]);
      expect(drawingOf(r.doc).placements.map((p) => p.id)).toContain(id(320));
      expect(drawingOf(r.doc).placements.map((p) => p.id)).toContain(id(321));
      const notes = drawingNotes(r);
      expect(notes.map((n) => [n.kind, n.ids, n.subject.label])).toEqual([
        ['duplicatePromotion', [id(130), id(131)], 'Dimension 30'],
      ]);
      expect(notes[0]?.summary).toBe(
        'Both sides promoted the same dimension (Dimension 30) in Bracket; both are kept. Merge the duplicates to keep one',
      );
      valid(r.doc);
    }
  });

  it('both sides reorder sheets differently: an order conflict', () => {
    const b = run(drawingDoc(), {
      kind: 'addSheet',
      drawingId: DRAWING,
      sheet: sheet(S3, 'Sheet 3'),
    });
    const o = run(b, { kind: 'moveSheet', drawingId: DRAWING, sheetId: S3, toIndex: 0 });
    const t = run(b, { kind: 'moveSheet', drawingId: DRAWING, sheetId: S1, toIndex: 2 });
    const r = merge(b, o, t);
    expect(conflictsOf(r)).toEqual([
      ['order', `/drawings/${DRAWING}/sheets`, 'drawing', 'Sheet order in Bracket drawing'],
    ]);
    expect(drawingOf(r.doc).sheets.map((s) => s.id)).toEqual([S3, S1, S2]);
    const doc = docMerger.resolve(r, [{ conflictId: r.conflicts[0]?.id ?? '', take: 'theirs' }]);
    expect(drawingOf(doc).sheets.map((s) => s.id)).toEqual([S2, S3, S1]);
    // One reorder against an add is clean.
    const added = run(b, {
      kind: 'addSheet',
      drawingId: DRAWING,
      sheet: sheet(id(213), 'Sheet 4'),
    });
    expect(merge(b, o, added).conflicts).toEqual([]);
  });
});

describe('sets and markup', () => {
  it('concurrent adds never conflict on order and are written sorted by id', () => {
    const b = drawingDoc();
    const o = place(b, id(341), V_TOP, A_NOTE);
    const t = place(b, id(340), V_TOP, A_LIN);
    for (const r of both(b, o, t)) {
      expect(r.conflicts).toEqual([]);
      const ids = drawingOf(r.doc).placements.map((p) => p.id);
      expect(ids).toEqual([...ids].sort());
      expect(ids).toEqual(expect.arrayContaining([id(340), id(341)]));
    }
    expect(canonicalJson(merge(b, o, t).doc)).toBe(canonicalJson(merge(b, t, o).doc));
  });

  it('markup is append-mostly: adds union, a delete beats a resolve, a reopen conflicts', () => {
    const b = drawingDoc();
    const addBy = (doc: WrenDoc, mid: string, who: string) =>
      run(doc, { kind: 'addMarkup', drawingId: DRAWING, markup: markup(mid, who, 'check') });
    const r = merge(b, addBy(b, id(281), 'Ben'), addBy(b, id(280), 'Cy'));
    expect(r.conflicts).toEqual([]);
    expect(drawingOf(r.doc).markup?.map((m) => m.id)).toEqual([MARKUP, id(280), id(281)]);

    const removed = run(b, { kind: 'removeMarkup', drawingId: DRAWING, markupId: MARKUP });
    const resolved = run(b, {
      kind: 'setMarkupResolved',
      drawingId: DRAWING,
      markupId: MARKUP,
      resolved: true,
    });
    for (const x of both(b, removed, resolved)) {
      expect(x.conflicts).toEqual([]);
      expect(drawingOf(x.doc).markup ?? []).toEqual([]);
    }
    const reopened = run(resolved, {
      kind: 'setMarkupResolved',
      drawingId: DRAWING,
      markupId: MARKUP,
      resolved: false,
    });
    const gone = run(resolved, { kind: 'removeMarkup', drawingId: DRAWING, markupId: MARKUP });
    const y = merge(resolved, gone, reopened);
    expect(y.conflicts.map((c) => [c.kind, c.subject.kind, c.subject.label])).toEqual([
      ['modifiedDeleted', 'markup', 'Markup by Ana'],
    ]);
  });

  it('each side removing the sheet the other kept leaves both sheets, with a note', () => {
    const b = drawingDoc();
    const o = run(b, { kind: 'removeSheet', drawingId: DRAWING, sheetId: S1 });
    const t = run(b, { kind: 'removeSheet', drawingId: DRAWING, sheetId: S2 });
    for (const r of both(b, o, t)) {
      expect(r.conflicts).toEqual([]);
      expect(drawingOf(r.doc).sheets.map((s) => s.id)).toEqual([S1, S2]);
      expect(mergeNotes(r).find((n) => n.kind === 'lastSheetKept')?.summary).toBe(
        'Both sides removed sheets of Bracket drawing until none was left; Sheet 1 and Sheet 2 were kept',
      );
      valid(r.doc);
    }
  });

  it('a markup anchored to a placement that went loses only its anchor', () => {
    const b = run(drawingDoc(), {
      kind: 'addMarkup',
      drawingId: DRAWING,
      markup: { ...markup(id(282), 'Ben'), anchor: { placementId: P_DIA } },
    });
    const o = removeAnnotation(b, A_DIA);
    const t = run(b, { kind: 'updateDrawing', drawingId: DRAWING, changes: { name: 'B' } });
    const r = merge(b, o, t);
    expect(r.conflicts).toEqual([]);
    expect(drawingOf(r.doc).markup?.find((m) => m.id === id(282))?.anchor).toBeUndefined();
  });
});

describe('resolving across a worker boundary', () => {
  it('a structured-cloned result restores or removes the dependents by path', () => {
    const b = drawingDoc();
    const o = removeAnnotation(b, A_DIA);
    const t = place(b, id(300), V_TOP, A_DIA);
    const r = structuredClone(merge(b, o, t));
    const kept = docMerger.resolve(r, [{ conflictId: r.conflicts[0]?.id ?? '', take: 'theirs' }]);
    expect(placementOf(kept, P_DIA)).toEqual(placementOf(b, P_DIA));
    expect(placementOf(kept, id(300))?.viewId).toBe(V_TOP);
    expect(kept.parts[0]?.annotations?.map((a) => a.id)).toEqual([A_DIA, A_LIN, A_DATUM, A_NOTE]);
    valid(kept);

    const s = structuredClone(merge(b, t, o));
    const gone = docMerger.resolve(s, [{ conflictId: s.conflicts[0]?.id ?? '', take: 'theirs' }]);
    expect(annotationOf(gone, A_DIA)).toBeUndefined();
    expect(placementOf(gone, P_DIA)).toBeUndefined();
    expect(placementOf(gone, id(300))).toBeUndefined();
    valid(gone);
  });

  it('a view kept by path brings its subtree back', () => {
    const b = drawingDoc();
    const o = run(b, { kind: 'removeViews', drawingId: DRAWING, viewIds: [V_FRONT] });
    const t = place(b, id(301), V_FRONT, A_NOTE);
    const r = structuredClone(merge(b, o, t));
    const kept = docMerger.resolve(r, [{ conflictId: r.conflicts[0]?.id ?? '', take: 'theirs' }]);
    expect(drawingOf(kept)).toEqual(drawingOf(t));
  });
});

describe('labels and the drawing compare', () => {
  it('names every new subject kind', () => {
    const d = drawingDoc();
    const at = (...segs: string[]) => subjectAt(segs, [d]);
    expect(at('parts', PART, 'annotations', A_DIA)).toEqual({
      kind: 'annotation',
      id: A_DIA,
      partId: PART,
      label: 'Dimension Ø6',
    });
    expect(at('parts', PART, 'annotations', A_LIN).label).toBe('Dimension depth');
    expect(at('parts', PART, 'annotations', A_DATUM).label).toBe('Datum A');
    expect(at('parts', PART, 'annotations', A_NOTE).label).toBe('Note “BREAK SHARP EDGES”');
    expect(at('drawings', DRAWING, 'sheets', S2)).toEqual({
      kind: 'sheet',
      id: S2,
      drawingId: DRAWING,
      label: 'Sheet 2',
    });
    expect(at('drawings', DRAWING, 'views', V_FRONT).label).toBe('View Front');
    expect(at('drawings', DRAWING, 'views', V_TOP).label).toBe('View Top');
    expect(at('drawings', DRAWING, 'views', V_SECTION).label).toBe('Section A–A');
    expect(at('drawings', DRAWING, 'placements', P_DIA)).toEqual({
      kind: 'placement',
      id: P_DIA,
      drawingId: DRAWING,
      label: 'Dimension Ø6 in View Front',
    });
    expect(at('drawings', DRAWING, 'centerMarks', MARK)).toEqual({
      kind: 'view',
      id: V_FRONT,
      drawingId: DRAWING,
      label: 'Centre mark in View Front',
    });
    expect(at('drawings', DRAWING, 'tables', HOLES)).toMatchObject({
      kind: 'drawingTable',
      label: 'Hole table of View Front',
    });
    expect(at('drawings', DRAWING, 'notes', NOTE)).toMatchObject({
      kind: 'sheetNote',
      label: 'Note “ALL DIMENSIONS IN MM”',
    });
    expect(at('drawings', DRAWING, 'markup', MARKUP)).toMatchObject({
      kind: 'markup',
      label: 'Markup by Ana',
    });
    // Two drawings: labels name the drawing.
    const two = structuredClone(d);
    two.drawings.push({
      ...structuredClone(two.drawings[0] as (typeof two.drawings)[0]),
      id: id(201),
      name: 'Copy',
    });
    expect(subjectAt(['drawings', DRAWING, 'views', V_FRONT], [two]).label).toBe(
      'View Front in Bracket drawing',
    );
  });

  it('a conflict inside a view reads with the view and the field', () => {
    const b = drawingDoc();
    const r = merge(b, editView(b, V_FRONT, { scale: '1' }), editView(b, V_FRONT, { scale: '2' }));
    expect(conflictSummary(r.conflicts[0] as StructuralMergeConflict)).toBe(
      'View Front scale: 1 vs 2',
    );
  });

  it('lists added, removed and changed annotations, views, placements, tables, notes and markup', () => {
    const b = run(drawingDoc(), {
      kind: 'addSheet',
      drawingId: DRAWING,
      sheet: sheet(S3, 'Details'),
    });
    let a = editAnnotation(b, A_DIA, { nominal: '8mm' });
    a = editAnnotation(a, A_DATUM, { refs: [ref(`F${EXTRUDE}:end`)] });
    a = removeAnnotation(a, A_NOTE);
    a = place(a, id(350), V_TOP, A_LIN);
    a = editPlacement(a, P_DIA, { layout: { kind: 'radial', angle: 90, distance: 6 } });
    a = editView(a, V_SECTION, { sheetId: S1 });
    a = editView(a, V_FRONT, { scale: '1' });
    a = run(
      a,
      { kind: 'updateDrawing', drawingId: DRAWING, changes: { projection: 'third' } },
      { kind: 'moveSheet', drawingId: DRAWING, sheetId: S3, toIndex: 0 },
      {
        kind: 'updateSheetNote',
        drawingId: DRAWING,
        note: { id: NOTE, sheetId: S1, position: [15, 40], text: 'DIMENSIONS IN MM' },
      },
      { kind: 'removeTable', drawingId: DRAWING, tableId: HOLES },
      { kind: 'setMarkupResolved', drawingId: DRAWING, markupId: MARKUP, resolved: true },
    );
    const lines = docDiffer.diff(b, a).map((c) => c.summary);
    expect(lines).toEqual(
      expect.arrayContaining([
        'Dimension Ø6: nominal 6 mm → 8 mm',
        'Datum A: reattached',
        'Removed Note “BREAK SHARP EDGES”',
        'Bracket drawing: projection first → third',
        'Moved Sheet Details to the front',
        'View Front: scale set to 1',
        'Section A–A: moved to Sheet 1',
        'Placed Dimension depth in View Top',
        'Dimension Ø6 in View Front: moved',
        'Note “ALL DIMENSIONS IN MM”: text “ALL DIMENSIONS IN MM” → “DIMENSIONS IN MM”',
        'Removed hole table of View Front',
        'Resolved markup by Ana',
      ]),
    );
    const placed = docDiffer.diff(b, a).find((c) => c.summary.startsWith('Placed'));
    expect(placed?.subject).toEqual({
      kind: 'placement',
      id: id(350),
      drawingId: DRAWING,
      label: 'Dimension depth in View Top',
    });
    // Removing the note's placement shows on the drawing too.
    expect(docDiffer.diff(b, removeAnnotation(b, A_DIA)).map((c) => c.summary)).toEqual([
      'Removed Dimension Ø6',
      'Removed Dimension Ø6 from View Front',
    ]);
  });
});
