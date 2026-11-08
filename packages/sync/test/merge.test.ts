// SPDX-License-Identifier: GPL-3.0-or-later
import type { Feature, MergeResult, SketchFeature, WhittleDoc } from '@whittle/contracts';
import { canonicalJson } from '@whittle/document';
import { describe, expect, it } from 'vitest';
import { docMerger, MergeResolutionError } from '../src';
import {
  apply,
  baseDoc,
  CHAMFER,
  EXTRUDE,
  FILLET,
  featureOf,
  fillet,
  id,
  P_DEPTH,
  P_WIDTH,
  PART,
  PLANE,
  problems,
  SKETCH,
  sk,
} from './support/fixtures';

const same = (a: WhittleDoc, b: WhittleDoc) => expect(canonicalJson(a)).toBe(canonicalJson(b));
const valid = (r: MergeResult | WhittleDoc) => {
  const doc = 'doc' in r ? r.doc : r;
  expect(problems(doc)).toEqual([]);
};
const featureIds = (d: WhittleDoc, pid = PART) =>
  (d.parts.find((p) => p.id === pid)?.features ?? []).map((f) => f.id);
const setRadius = (doc: WhittleDoc, radius: string, fid = FILLET) => {
  const f = featureOf(doc, fid) as Feature;
  return apply(doc, {
    kind: 'updateFeature',
    partId: PART,
    featureId: fid,
    feature: { ...f, radius } as Feature,
  });
};

describe('DocMerger: auto-merge', () => {
  it('merges edits to different features and parameters', () => {
    const base = baseDoc();
    const ours = setRadius(base, '3mm');
    const theirs = apply(base, { kind: 'updateParam', paramId: P_WIDTH, expr: '45mm' });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.autoMerged).toBe(1);
    expect((featureOf(r.doc, FILLET) as { radius: string }).radius).toBe('3mm');
    expect(r.doc.params[0]?.expr).toBe('45mm');
    valid(r);
  });

  it('merges different fields of one feature', () => {
    const base = baseDoc();
    const ours = setRadius(base, '3mm');
    const theirs = apply(base, {
      kind: 'setSuppressed',
      partId: PART,
      featureId: FILLET,
      suppressed: true,
    });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(featureOf(r.doc, FILLET)).toMatchObject({ radius: '3mm', suppressed: true });
  });

  it('keeps additions from both sides, each after the feature it followed', () => {
    const base = baseDoc();
    const ours = apply(base, {
      kind: 'addFeature',
      partId: PART,
      feature: fillet(id(90), 'Fillet 6'),
      index: 3,
    });
    const theirs = apply(base, {
      kind: 'addFeature',
      partId: PART,
      feature: fillet(id(91), 'Fillet 7'),
    });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(featureIds(r.doc)).toEqual([SKETCH, EXTRUDE, FILLET, id(90), CHAMFER, PLANE, id(91)]);
    // Both were added before the bar, so both are evaluated.
    expect(r.doc.parts[0]?.rollbackIndex).toBe(7);
    valid(r);
  });

  it('orders concurrent insertions at one place by id, whichever side is ours', () => {
    const base = baseDoc();
    const ours = apply(base, {
      kind: 'addFeature',
      partId: PART,
      feature: fillet(id(92), 'B'),
      index: 2,
    });
    const theirs = apply(base, {
      kind: 'addFeature',
      partId: PART,
      feature: fillet(id(91), 'A'),
      index: 2,
    });
    const r1 = docMerger.merge(base, ours, theirs);
    const r2 = docMerger.merge(base, theirs, ours);
    expect(featureIds(r1.doc)).toEqual([SKETCH, EXTRUDE, id(91), id(92), FILLET, CHAMFER, PLANE]);
    same(r1.doc, r2.doc);
  });

  it('takes a reorder from one side and edits from the other', () => {
    const base = baseDoc();
    const ours = apply(base, { kind: 'moveFeature', partId: PART, featureId: PLANE, toIndex: 0 });
    const theirs = setRadius(
      apply(base, { kind: 'removeFeature', partId: PART, featureId: CHAMFER }),
      '5mm',
    );
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(featureIds(r.doc)).toEqual([PLANE, SKETCH, EXTRUDE, FILLET]);
    expect((featureOf(r.doc, FILLET) as { radius: string }).radius).toBe('5mm');
    valid(r);
  });

  it('meta.modified takes the later time and never conflicts', () => {
    const base = baseDoc();
    const ours = { ...base, meta: { ...base.meta, modified: '2026-03-01T00:00:00.000Z' } };
    const theirs = { ...base, meta: { ...base.meta, modified: '2026-02-01T00:00:00.000Z' } };
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.doc.meta.modified).toBe('2026-03-01T00:00:00.000Z');
    expect(docMerger.merge(base, theirs, ours).doc.meta.modified).toBe('2026-03-01T00:00:00.000Z');
  });

  it('merges sketch geometry by entity id', () => {
    const base = baseDoc();
    const s = featureOf(base, SKETCH) as SketchFeature;
    const ours = apply(base, {
      kind: 'updateFeature',
      partId: PART,
      featureId: SKETCH,
      feature: {
        ...s,
        entities: [...s.entities, { id: sk(11), kind: 'point', construction: true, x: 5, y: 5 }],
      },
    });
    const theirs = apply(base, {
      kind: 'updateFeature',
      partId: PART,
      featureId: SKETCH,
      feature: {
        ...s,
        constraints: s.constraints.map((c) => (c.id === sk(23) ? { ...c, value: '35mm' } : c)),
      } as SketchFeature,
    });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    const m = featureOf(r.doc, SKETCH) as SketchFeature;
    expect(m.entities.map((e) => e.id)).toContain(sk(11));
    expect(m.constraints.find((c) => c.id === sk(23))).toMatchObject({ value: '35mm' });
  });

  it('identical edits on both sides are not conflicts', () => {
    const base = baseDoc();
    const x = setRadius(base, '4mm');
    const r = docMerger.merge(base, x, x);
    expect(r.conflicts).toEqual([]);
    same(r.doc, x);
  });
});

describe('DocMerger: conflicts', () => {
  it('both editing one leaf is bothModified at an id path, keeping ours', () => {
    const base = baseDoc();
    const r = docMerger.merge(base, setRadius(base, '3mm'), setRadius(base, '4mm'));
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0]!;
    expect(c).toMatchObject({
      kind: 'bothModified',
      path: `/parts/${PART}/features/${FILLET}/radius`,
      base: '2mm',
      ours: '3mm',
      theirs: '4mm',
      subject: { kind: 'feature', id: FILLET, partId: PART, label: 'Fillet 3' },
    });
    expect((featureOf(r.doc, FILLET) as { radius: string }).radius).toBe('3mm');
    valid(r);
    const theirs = docMerger.resolve(r, [{ conflictId: c.id, take: 'theirs' }]);
    expect((featureOf(theirs, FILLET) as { radius: string }).radius).toBe('4mm');
    const typed = docMerger.resolve(r, [{ conflictId: c.id, value: '3.5mm' }]);
    expect((featureOf(typed, FILLET) as { radius: string }).radius).toBe('3.5mm');
    const kept = docMerger.resolve(r, []);
    same(kept, r.doc);
  });

  it('labels parameters', () => {
    const base = baseDoc();
    const ours = apply(base, { kind: 'updateParam', paramId: P_WIDTH, expr: '41mm' });
    const theirs = apply(base, { kind: 'updateParam', paramId: P_WIDTH, expr: '42mm' });
    const [c] = docMerger.merge(base, ours, theirs).conflicts;
    expect(c).toMatchObject({
      path: `/params/${P_WIDTH}/expr`,
      subject: { kind: 'param', id: P_WIDTH, label: 'Parameter width' },
    });
  });

  it('labels sketch geometry like the sketcher does', () => {
    const base = baseDoc();
    const edit = (x: number) => {
      const s = featureOf(base, SKETCH) as SketchFeature;
      return apply(base, {
        kind: 'updateFeature',
        partId: PART,
        featureId: SKETCH,
        feature: {
          ...s,
          entities: s.entities.map((e) => (e.id === sk(10) ? { ...e, radius: x } : e)),
          constraints: s.constraints.map((c) => (c.id === sk(23) ? { ...c, value: `${x}mm` } : c)),
        } as SketchFeature,
      });
    };
    const r = docMerger.merge(base, edit(6), edit(7));
    const labels = r.conflicts.map((c) => c.subject.label).sort();
    expect(labels).toEqual(['Circle 1 in Sketch 1', 'Length (Line 2) in Sketch 1']);
    const circle = r.conflicts.find((c) => c.subject.kind === 'sketchEntity');
    expect(circle).toMatchObject({
      path: `/parts/${PART}/features/${SKETCH}/entities/${sk(10)}/radius`,
      subject: { id: sk(10), partId: PART, featureId: SKETCH },
    });
  });

  it('a change against a delete is modifiedDeleted, and resolving restores it in place', () => {
    const base = baseDoc();
    const removed = apply(base, { kind: 'removeFeature', partId: PART, featureId: FILLET });
    const edited = setRadius(base, '3mm');

    const kept = docMerger.merge(base, edited, removed);
    expect(kept.conflicts).toMatchObject([
      {
        kind: 'modifiedDeleted',
        path: `/parts/${PART}/features/${FILLET}`,
        subject: { label: 'Fillet 3' },
      },
    ]);
    expect(kept.conflicts[0]!.theirs).toBeUndefined();
    expect(featureIds(kept.doc)).toContain(FILLET);

    const gone = docMerger.merge(base, removed, edited);
    expect(gone.conflicts[0]).toMatchObject({ kind: 'modifiedDeleted' });
    expect('ours' in gone.conflicts[0]!).toBe(false);
    expect(featureIds(gone.doc)).not.toContain(FILLET);
    valid(gone);
    const restored = docMerger.resolve(gone, [
      { conflictId: gone.conflicts[0]!.id, take: 'theirs' },
    ]);
    expect(featureIds(restored)).toEqual([SKETCH, EXTRUDE, FILLET, CHAMFER, PLANE]);
    expect(restored.parts[0]?.rollbackIndex).toBe(5);
    same(restored, kept.doc);
  });

  it('a delete of an untouched feature merges', () => {
    const base = baseDoc();
    const removed = apply(base, { kind: 'removeFeature', partId: PART, featureId: FILLET });
    const theirs = apply(base, {
      kind: 'setSuppressed',
      partId: PART,
      featureId: CHAMFER,
      suppressed: true,
    });
    const r = docMerger.merge(base, removed, theirs);
    expect(r.conflicts).toEqual([]);
    expect(featureIds(r.doc)).toEqual([SKETCH, EXTRUDE, CHAMFER, PLANE]);
    expect(featureOf(r.doc, CHAMFER)?.suppressed).toBe(true);
    expect(r.doc.parts[0]?.rollbackIndex).toBe(4);
    valid(r);
  });

  it('the same id added differently is bothAdded', () => {
    const base = baseDoc();
    const ours = apply(base, {
      kind: 'addFeature',
      partId: PART,
      feature: fillet(id(95), 'Fillet 6', '1mm'),
    });
    const theirs = apply(base, {
      kind: 'addFeature',
      partId: PART,
      feature: fillet(id(95), 'Fillet 6', '2mm'),
    });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toMatchObject([
      { kind: 'bothAdded', path: `/parts/${PART}/features/${id(95)}` },
    ]);
    expect(r.conflicts[0]!.base).toBeUndefined();
    valid(r);
  });

  it('two different reorders are an order conflict', () => {
    const base = baseDoc();
    const ours = apply(base, { kind: 'moveFeature', partId: PART, featureId: PLANE, toIndex: 0 });
    const theirs = apply(base, {
      kind: 'moveFeature',
      partId: PART,
      featureId: CHAMFER,
      toIndex: 2,
    });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0]!;
    expect(c).toMatchObject({
      kind: 'order',
      path: `/parts/${PART}/features`,
      subject: { kind: 'part', id: PART, label: 'Feature order in Bracket' },
      ours: featureIds(ours),
      theirs: featureIds(theirs),
      base: featureIds(base),
    });
    expect(featureIds(r.doc)).toEqual(featureIds(ours));
    const t = docMerger.resolve(r, [{ conflictId: c.id, take: 'theirs' }]);
    expect(featureIds(t)).toEqual(featureIds(theirs));
    valid(t);
  });

  it('a variant switch against a field edit replaces the object whole (stays schema-valid)', () => {
    const base = baseDoc();
    const ext = featureOf(base, EXTRUDE) as Feature & { end: unknown };
    const ours = apply(base, {
      kind: 'updateFeature',
      partId: PART,
      featureId: EXTRUDE,
      feature: { ...ext, end: { kind: 'blind', depth: '25mm' } } as Feature,
    });
    const theirs = apply(base, {
      kind: 'updateFeature',
      partId: PART,
      featureId: EXTRUDE,
      feature: { ...ext, end: { kind: 'throughAll' } } as Feature,
    });
    for (const [o, t] of [
      [ours, theirs],
      [theirs, ours],
    ] as const) {
      const r = docMerger.merge(base, o, t);
      expect(r.conflicts).toMatchObject([{ path: `/parts/${PART}/features/${EXTRUDE}/end` }]);
      valid(r);
      valid(docMerger.resolve(r, [{ conflictId: r.conflicts[0]!.id, take: 'theirs' }]));
    }
  });

  it('two parameters with one name conflict on the one theirs introduced', () => {
    const base = baseDoc();
    const ours = apply(base, { kind: 'addParam', param: { id: id(80), name: 'gap', expr: '1mm' } });
    const theirs = apply(base, {
      kind: 'addParam',
      param: { id: id(81), name: 'gap', expr: '2mm' },
    });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toMatchObject([{ kind: 'bothAdded', path: `/params/${id(81)}` }]);
    expect(r.doc.params.map((p) => p.id)).not.toContain(id(81));
    valid(r);
    const c = r.conflicts[0]!;
    expect(() => docMerger.resolve(r, [{ conflictId: c.id, take: 'theirs' }])).toThrow(
      MergeResolutionError,
    );
    const renamed = docMerger.resolve(r, [
      { conflictId: c.id, value: { id: id(81), name: 'gap2', expr: '2mm' } },
    ]);
    expect(renamed.params.map((p) => p.name)).toEqual(['width', 'depth', 'height', 'gap', 'gap2']);
  });

  it('a rename that clashes with a new name keeps ours', () => {
    const base = baseDoc();
    const ours = apply(base, { kind: 'addParam', param: { id: id(80), name: 'w', expr: '1mm' } });
    const theirs = apply(base, { kind: 'updateParam', paramId: P_WIDTH, name: 'w' });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts.map((c) => c.path)).toContain(`/params/${P_WIDTH}/name`);
    expect(r.doc.params.find((p) => p.id === P_WIDTH)?.name).toBe('width');
    valid(r);
  });

  it('rollback: both rolling the bar to different places conflicts; theirs maps by feature', () => {
    const base = baseDoc();
    const ours = apply(base, { kind: 'setRollback', partId: PART, index: 2 });
    const theirs = apply(base, { kind: 'setRollback', partId: PART, index: 4 });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toMatchObject([
      { path: `/parts/${PART}/rollbackIndex`, ours: 2, theirs: 4 },
    ]);
    expect(r.doc.parts[0]?.rollbackIndex).toBe(2);
    const t = docMerger.resolve(r, [{ conflictId: r.conflicts[0]!.id, take: 'theirs' }]);
    expect(t.parts[0]?.rollbackIndex).toBe(4);
  });

  it('rollback: a bar moved on one side stays before the same feature when the other adds features', () => {
    const base = baseDoc();
    const ours = apply(base, { kind: 'setRollback', partId: PART, index: 3 }); // before Chamfer 4
    const theirs = apply(base, {
      kind: 'addFeature',
      partId: PART,
      feature: fillet(id(97), 'Fillet 0'),
      index: 0,
    });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    const part = r.doc.parts[0]!;
    expect(part.features[part.rollbackIndex]?.id).toBe(CHAMFER);
    valid(r);
  });

  it('resolve without the merge inputs (a cloned result) patches by path', () => {
    const base = baseDoc();
    const removed = apply(base, { kind: 'removeFeature', partId: PART, featureId: FILLET });
    const r = structuredClone(docMerger.merge(base, removed, setRadius(base, '3mm')));
    const doc = docMerger.resolve(r, [{ conflictId: r.conflicts[0]!.id, take: 'theirs' }]);
    expect(featureIds(doc)).toContain(FILLET);
    expect(doc.parts[0]?.rollbackIndex).toBe(doc.parts[0]?.features.length);
    valid(doc);
    const order = docMerger.merge(
      base,
      apply(base, { kind: 'moveFeature', partId: PART, featureId: PLANE, toIndex: 0 }),
      apply(base, { kind: 'moveFeature', partId: PART, featureId: CHAMFER, toIndex: 2 }),
    );
    const cloned = structuredClone(order);
    const t = docMerger.resolve(cloned, [{ conflictId: cloned.conflicts[0]!.id, take: 'theirs' }]);
    expect(featureIds(t)).toEqual(order.conflicts[0]!.theirs);
  });

  it('rejects unknown conflict ids', () => {
    const base = baseDoc();
    const r = docMerger.merge(base, base, base);
    expect(() => docMerger.resolve(r, [{ conflictId: 'nope', take: 'theirs' }])).toThrow(
      /no conflict/,
    );
  });

  it('a param edit against its deletion is one conflict with a label', () => {
    const base = baseDoc();
    const ours = apply(base, { kind: 'removeParam', paramId: P_DEPTH });
    const theirs = apply(base, { kind: 'updateParam', paramId: P_DEPTH, expr: '22mm' });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toMatchObject([
      {
        kind: 'modifiedDeleted',
        path: `/params/${P_DEPTH}`,
        subject: { label: 'Parameter depth' },
      },
    ]);
  });
});
