// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  Annotation,
  AnnotationPlacement,
  Command,
  Drawing,
  DrawingTable,
  DrawingView,
  Part,
  SheetNote,
  WrenDoc,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  createDocumentStore,
  drawingContentIds,
  normalizeDrawings,
  planDuplicateDrawing,
  remapDrawing,
  resolveViewFrame,
  resolveViewPosition,
  validateDoc,
} from '../src';
import { id, ref, sampleDoc, sampleDrawing, style } from './fixtures';

const D = id(5);
const SHEET1 = id(5050);
const SHEET2 = id(5051);
const FRONT = id(5060);
const TOP = id(5061);
const SECTION = id(5062);
const DETAIL = id(5063);
const ISO = id(5064);

function setup(configure?: (doc: WrenDoc) => void) {
  const doc = sampleDoc();
  configure?.(doc);
  const store = createDocumentStore(doc, { trackModified: false });
  const run = (cmd: Command, options?: { coalesceKey?: string }) => {
    const r = store.apply(cmd, options);
    if (!r.ok) throw new Error(r.error);
    return r.doc;
  };
  const fail = (cmd: Command): string => {
    const r = store.apply(cmd);
    if (r.ok) throw new Error('expected a failure');
    return r.error;
  };
  const drawing = (): Drawing => store.getDoc().drawings.find((d) => d.id === D) as Drawing;
  return { store, run, fail, drawing };
}

let counter = 9000;
const fresh = () => id(++counter);

describe('drawing defaults, add, update, move, remove', () => {
  it('setDrawingDefaults validates the family and is one undo step', () => {
    const { store, run, fail } = setup((d) => delete d.drawingDefaults);
    const defaults = {
      standard: { family: 'asme', gps: 'ASME Y14.5-2018', surfaceFinish: 'ASME Y14.36-2018' },
      projection: 'first',
    } as const;
    run({ kind: 'setDrawingDefaults', defaults });
    expect(store.getDoc().drawingDefaults).toEqual(defaults);
    run({ kind: 'setDrawingDefaults', defaults: { ...defaults, projection: 'third' } });
    expect(store.getDoc().drawingDefaults?.projection).toBe('third');
    expect(
      fail({
        kind: 'setDrawingDefaults',
        defaults: { ...defaults, standard: { ...defaults.standard, gps: 'ISO 1101:2017' } },
      }),
    ).toMatch(/does not belong to the ASME family/);
    store.undo();
    store.undo();
    expect(store.getDoc().drawingDefaults).toBeUndefined();
  });

  it('addDrawing stores a normalised copy and checks ids, part and configuration', () => {
    const { store, run } = setup();
    const d = sampleDrawing();
    const copy: Drawing = {
      ...remapDrawing(d, planDuplicateDrawing(d, fresh), id(9100), 'Second', null),
      markup: undefined,
    };
    delete copy.markup;
    run({ kind: 'addDrawing', drawing: copy });
    expect(store.getDoc().drawings.map((x) => x.id)).toEqual([D, id(9100)]);
    expect(validateDoc(store.getDoc())).toEqual([]);
    const first = remapDrawing(d, planDuplicateDrawing(d, fresh), id(9101), 'First', null);
    run({ kind: 'addDrawing', drawing: first, index: 0 });
    expect(store.getDoc().drawings.map((x) => x.id)).toEqual([id(9101), D, id(9100)]);
  });

  it('addDrawing refuses what would need silent repair', () => {
    const { fail } = setup();
    const d = sampleDrawing();
    expect(fail({ kind: 'addDrawing', drawing: d })).toMatch(/already in use/);
    const ids = planDuplicateDrawing(d, fresh);
    const copy = remapDrawing(d, ids, id(9200), 'C', null);
    expect(
      fail({
        kind: 'addDrawing',
        drawing: { ...copy, subject: { kind: 'part', partId: 'ghost' } },
      }),
    ).toMatch(/Part ‘ghost’/);
    expect(fail({ kind: 'addDrawing', drawing: { ...copy, configurationId: 'ghost' } })).toMatch(
      /Configuration ‘ghost’/,
    );
    expect(fail({ kind: 'addDrawing', drawing: { ...copy, sheets: [] } })).toMatch(
      /at least one sheet/,
    );
    const dangling = {
      ...copy,
      placements: [
        ...copy.placements,
        { ...(copy.placements[0] as AnnotationPlacement), id: fresh(), viewId: 'ghost' },
      ],
    };
    expect(fail({ kind: 'addDrawing', drawing: dangling as Drawing })).toMatch(/view is missing/);
    expect(fail({ kind: 'addDrawing', drawing: copy, index: 7 })).toMatch(/position 7/);
    expect(fail({ kind: 'addDrawing', drawing: { ...copy, units: 'in' } as never })).toMatch(
      /units must be/,
    );
  });

  it('updateDrawing changes fields, clears the configuration with null, and rounds the style', () => {
    const { store, run, fail, drawing } = setup((doc) => {
      (doc.parts[0] as Part).configurations = [{ id: id(700), name: 'Loose' }];
    });
    run({
      kind: 'updateDrawing',
      drawingId: D,
      changes: { name: 'Renamed', configurationId: id(700), projection: 'first' },
    });
    expect(drawing()).toMatchObject({
      name: 'Renamed',
      configurationId: id(700),
      projection: 'first',
    });
    run({
      kind: 'updateDrawing',
      drawingId: D,
      changes: {
        configurationId: null,
        style: { ...style(), dimension: { ...style().dimension, firstLane: 10.00049 } },
      },
    });
    expect(drawing()).not.toHaveProperty('configurationId');
    expect(drawing().style.dimension.firstLane).toBe(10);
    expect(
      fail({ kind: 'updateDrawing', drawingId: D, changes: { configurationId: 'ghost' } }),
    ).toMatch(/Configuration ‘ghost’/);
    expect(fail({ kind: 'updateDrawing', drawingId: D, changes: { name: ' ' } })).toMatch(
      /needs a name/,
    );
    expect(
      fail({
        kind: 'updateDrawing',
        drawingId: D,
        changes: { subject: { kind: 'part', partId: id(4) } },
      }),
    ).toMatch(/Remove the drawing’s annotations/);
    expect(
      fail({
        kind: 'updateDrawing',
        drawingId: D,
        changes: {
          standard: { family: 'iso', gps: 'ASME Y14.5-2018', surfaceFinish: 'ISO 21920-1:2021' },
        },
      }),
    ).toMatch(/family/);
    expect(fail({ kind: 'updateDrawing', drawingId: 'ghost', changes: {} })).toMatch(/not found/);
    expect(store.history().past).toHaveLength(2);
  });

  it('moveDrawing reorders the manifest list', () => {
    const { store, run, fail } = setup();
    const d = sampleDrawing();
    run({
      kind: 'addDrawing',
      drawing: remapDrawing(d, planDuplicateDrawing(d, fresh), id(9300), 'B', null),
    });
    run({ kind: 'moveDrawing', drawingId: id(9300), toIndex: 0 });
    expect(store.getDoc().drawings.map((x) => x.id)).toEqual([id(9300), D]);
    expect(fail({ kind: 'moveDrawing', drawingId: D, toIndex: 5 })).toMatch(/position 5/);
    store.undo();
    expect(store.getDoc().drawings.map((x) => x.id)).toEqual([D, id(9300)]);
  });

  it('removeDrawing removes the annotations it drew that nothing else places (default)', () => {
    const { store, run } = setup();
    const before = store.getDoc();
    const doc = run({ kind: 'removeDrawing', drawingId: D });
    expect(doc.drawings).toEqual([]);
    const ids = (doc.parts[0]?.annotations ?? []).map((a) => a.id);
    expect(ids).not.toContain(id(902)); // origin: this drawing
    expect(ids).toContain(id(900)); // model annotations stay
    // the frame that applied to 902 stays and now needs attention
    const frame = doc.parts[0]?.annotations?.find((a) => a.id === id(905)) as {
      appliesTo?: string;
    };
    expect(frame.appliesTo).toBe(id(902));
    expect(validateDoc(doc)).toEqual([]);
    store.undo();
    expect(store.getDoc()).toEqual(before);
  });

  it('removeDrawing keeps them on request, and when another drawing places them', () => {
    const { store, run } = setup();
    run({ kind: 'removeDrawing', drawingId: D, annotations: 'keep' });
    expect(store.getDoc().parts[0]?.annotations?.some((a) => a.id === id(902))).toBe(true);
    store.undo();
    const d = sampleDrawing();
    const copy = remapDrawing(d, planDuplicateDrawing(d, fresh), id(9400), 'B', null);
    run({ kind: 'addDrawing', drawing: copy });
    run({ kind: 'removeDrawing', drawingId: D });
    expect(store.getDoc().parts[0]?.annotations?.some((a) => a.id === id(902))).toBe(true);
  });
});

describe('duplicateDrawing and planDuplicateDrawing', () => {
  it('plans a fresh id for every sheet, view, placement, mark, table and note (not markup)', () => {
    const d = sampleDrawing();
    const ids = planDuplicateDrawing(d, fresh);
    const old = drawingContentIds(d);
    expect(Object.keys(ids).sort()).toEqual([...old].sort());
    expect(old).not.toContain(id(5084)); // markup
    const values = Object.values(ids);
    expect(new Set(values).size).toBe(values.length);
    expect(values.some((v) => old.includes(v))).toBe(false);
  });

  it('never hands out a taken id', () => {
    const d = sampleDrawing();
    const seq = [id(1), id(7001), id(7001), id(7002)];
    let i = 0;
    const ids = planDuplicateDrawing(
      {
        ...d,
        sheets: [d.sheets[0] as never],
        views: [],
        placements: [],
        centerMarks: [],
        tables: [],
        notes: [],
      },
      () => seq[i++] as string,
      new Set([id(1)]),
    );
    expect(ids).toEqual({ [SHEET1]: id(7001) });
  });

  it('copies with ids mapped and references followed; annotations are shared; markup is not copied', () => {
    const { store, run, fail } = setup((doc) => {
      (doc.parts[0] as Part).configurations = [{ id: id(700), name: 'Loose' }];
    });
    const d = store.getDoc().drawings[0] as Drawing;
    const ids = planDuplicateDrawing(d, fresh);
    const doc = run({
      kind: 'duplicateDrawing',
      drawingId: D,
      newDrawingId: id(9500),
      name: 'Loose copy',
      configurationId: id(700),
      ids,
    });
    expect(doc.drawings.map((x) => x.id)).toEqual([D, id(9500)]); // right after the source
    const copy = doc.drawings[1] as Drawing;
    expect(copy).toMatchObject({ name: 'Loose copy', configurationId: id(700) });
    expect(copy.markup).toBeUndefined();
    expect(copy.placements.map((p) => p.annotationId).sort()).toEqual(
      d.placements.map((p) => p.annotationId).sort(),
    );
    expect(copy.views.find((v) => v.kind === 'projected')).toMatchObject({
      parentId: ids[FRONT],
      sheetId: ids[SHEET1],
    });
    const leader = copy.placements.find(
      (p) => p.layout.kind === 'leader' && p.layout.attach.kind === 'placement',
    );
    const attach = ((leader as AnnotationPlacement).layout as { attach: { placementId: string } })
      .attach;
    expect(attach.placementId).toBe(ids[id(5071)]);
    expect(copy.tables.find((t) => t.kind === 'holeTable')).toMatchObject({ viewId: ids[TOP] });
    expect(validateDoc(doc)).toEqual([]);
    expect(normalizeDrawings(doc).notes).toEqual([]);
    expect(doc.drawings[0]).toEqual(d); // the source is untouched
    expect(store.history().past).toHaveLength(1);
    store.undo();
    expect(store.getDoc().drawings).toHaveLength(1);

    const missing = { ...ids };
    delete missing[FRONT];
    expect(
      fail({
        kind: 'duplicateDrawing',
        drawingId: D,
        newDrawingId: id(9501),
        name: 'x',
        configurationId: null,
        ids: missing,
      }),
    ).toMatch(/No new id was given/);
    expect(
      fail({
        kind: 'duplicateDrawing',
        drawingId: D,
        newDrawingId: id(9501),
        name: 'x',
        configurationId: null,
        ids: { ...ids, [FRONT]: id(3) },
      }),
    ).toMatch(/already in use/);
    expect(
      fail({
        kind: 'duplicateDrawing',
        drawingId: D,
        newDrawingId: id(9501),
        name: 'x',
        configurationId: null,
        ids: { ...ids, [FRONT]: ids[TOP] as string },
      }),
    ).toMatch(/already in use/);
    expect(
      fail({
        kind: 'duplicateDrawing',
        drawingId: D,
        newDrawingId: D,
        name: 'x',
        configurationId: null,
        ids,
      }),
    ).toMatch(/already in use/);
    expect(
      fail({
        kind: 'duplicateDrawing',
        drawingId: D,
        newDrawingId: id(9501),
        name: 'x',
        configurationId: 'ghost',
        ids,
      }),
    ).toMatch(/Configuration/);
  });
});

describe('template and title block', () => {
  it('applyTemplate sets id and version, optionally formats, and keeps everything else', () => {
    const { run, fail, drawing } = setup();
    const before = drawing();
    run({
      kind: 'applyTemplate',
      drawingId: D,
      template: { id: 'asme-y14.1', version: 1 },
      formats: [{ sheetId: SHEET1, format: { size: 'ANSI-B', orientation: 'portrait' } }],
    });
    expect(drawing().template).toEqual({ id: 'asme-y14.1', version: 1, fields: { owner: 'Wren' } });
    expect(drawing().sheets[0]?.format).toEqual({ size: 'ANSI-B', orientation: 'portrait' });
    expect(drawing().views).toEqual(before.views);
    expect(drawing().placements).toEqual(before.placements);
    expect(
      fail({ kind: 'applyTemplate', drawingId: D, template: { id: 'iso-5457', version: 2 } }),
    ).toMatch(/versions 1 to 1/);
    expect(
      fail({ kind: 'applyTemplate', drawingId: D, template: { id: 'nope' as never, version: 1 } }),
    ).toMatch(/not a template/);
    expect(
      fail({
        kind: 'applyTemplate',
        drawingId: D,
        template: { id: 'iso-5457', version: 1 },
        formats: [{ sheetId: 'ghost', format: { size: 'A4', orientation: 'portrait' } }],
      }),
    ).toMatch(/Sheet ‘ghost’/);
  });

  it('setTitleBlockFields sets, clears with null, and removes empty containers', () => {
    const { run, fail, drawing } = setup();
    run({ kind: 'setTitleBlockFields', drawingId: D, fields: { drawnBy: 'AB', owner: null } });
    expect(drawing().template.fields).toEqual({ drawnBy: 'AB' });
    run({
      kind: 'setTitleBlockFields',
      drawingId: D,
      sheetId: SHEET2,
      fields: { title: 'Details' },
    });
    expect(drawing().sheets[1]?.fields).toEqual({ title: 'Details' });
    run({ kind: 'setTitleBlockFields', drawingId: D, sheetId: SHEET2, fields: { title: null } });
    expect(drawing().sheets[1]).not.toHaveProperty('fields');
    run({ kind: 'setTitleBlockFields', drawingId: D, fields: { drawnBy: null } });
    expect(drawing().template).not.toHaveProperty('fields');
    expect(
      fail({ kind: 'setTitleBlockFields', drawingId: D, fields: { bogus: 'x' } as never }),
    ).toMatch(/not a title block slot/);
    expect(
      fail({ kind: 'setTitleBlockFields', drawingId: D, sheetId: 'ghost', fields: {} }),
    ).toMatch(/Sheet/);
  });
});

describe('sheets', () => {
  const sheet = (n: number) => ({
    id: id(n),
    name: `S${n}`,
    format: { size: 'A4' as const, orientation: 'portrait' as const },
    scale: '1',
  });

  it('add, update, move', () => {
    const { run, fail, drawing } = setup();
    run({ kind: 'addSheet', drawingId: D, sheet: sheet(9600), index: 0 });
    expect(drawing().sheets.map((s) => s.id)).toEqual([id(9600), SHEET1, SHEET2]);
    run({ kind: 'moveSheet', drawingId: D, sheetId: id(9600), toIndex: 2 });
    expect(drawing().sheets.map((s) => s.id)).toEqual([SHEET1, SHEET2, id(9600)]);
    run({ kind: 'updateSheet', drawingId: D, sheet: { ...sheet(9600), scale: '1/2' } });
    expect(drawing().sheets[2]?.scale).toBe('1/2');
    expect(fail({ kind: 'addSheet', drawingId: D, sheet: sheet(9600) })).toMatch(/already in use/);
    expect(fail({ kind: 'updateSheet', drawingId: D, sheet: sheet(9999) })).toMatch(/not found/);
    expect(fail({ kind: 'moveSheet', drawingId: D, sheetId: SHEET1, toIndex: 9 })).toMatch(
      /position 9/,
    );
    expect(
      fail({ kind: 'addSheet', drawingId: D, sheet: { ...sheet(9601), scale: 1 as never } }),
    ).toMatch(/scale must be a string/);
  });

  it('removeSheet removes its views, placements, marks, tables, notes and markup in one step', () => {
    const { store, run, fail, drawing } = setup();
    const before = store.getDoc();
    run({ kind: 'removeSheet', drawingId: D, sheetId: SHEET1 });
    const d = drawing();
    expect(d.sheets.map((s) => s.id)).toEqual([SHEET2]);
    expect(d.views.map((v) => v.id)).toEqual([DETAIL, ISO]); // orphans of the removed base stay, flagged
    expect(d.placements).toEqual([]);
    expect(d.centerMarks).toEqual([]);
    expect(d.tables).toEqual([]); // partProperties on the sheet, holeTable on a removed view
    expect(d.notes).toEqual([]);
    expect(d.markup).toBeUndefined();
    expect(validateDoc(store.getDoc())).toEqual([]);
    expect(store.history().past).toHaveLength(1);
    store.undo();
    expect(store.getDoc()).toEqual(before);
    run({ kind: 'removeSheet', drawingId: D, sheetId: SHEET2 });
    expect(fail({ kind: 'removeSheet', drawingId: D, sheetId: SHEET1 })).toMatch(
      /at least one sheet/,
    );
    expect(fail({ kind: 'removeSheet', drawingId: D, sheetId: 'ghost' })).toMatch(/not found/);
  });
});

describe('views', () => {
  const baseView = (n: number, over: Partial<DrawingView> = {}): DrawingView =>
    ({
      id: id(n),
      sheetId: SHEET1,
      kind: 'base',
      orientation: { kind: 'named', name: 'right' },
      layout: { kind: 'free', position: [50, 50] },
      ...over,
    }) as DrawingView;

  it('addView / updateView validate the sheet, parents and loops', () => {
    const { run, fail, drawing } = setup();
    run({ kind: 'addView', drawingId: D, view: baseView(9700) });
    expect(drawing().views.map((v) => v.id)).toEqual(
      [...[FRONT, TOP, SECTION, DETAIL, ISO, id(9700)]].sort(),
    );
    expect(fail({ kind: 'addView', drawingId: D, view: baseView(9700) })).toMatch(/already in use/);
    expect(
      fail({ kind: 'addView', drawingId: D, view: baseView(9701, { sheetId: 'ghost' }) }),
    ).toMatch(/Sheet ‘ghost’/);
    expect(
      fail({
        kind: 'addView',
        drawingId: D,
        view: {
          id: id(9702),
          sheetId: SHEET1,
          kind: 'projected',
          parentId: 'ghost',
          from: 'left',
          layout: { kind: 'free', position: [0, 0] },
        },
      }),
    ).toMatch(/derived from was not found/);
    expect(
      fail({
        kind: 'addView',
        drawingId: D,
        view: baseView(9703, { layout: { kind: 'aligned', distance: 5 } } as never),
      }),
    ).toMatch(/layout.kind must be one of free/);
    // a loop: FRONT (base) made a child of TOP, which is a child of FRONT
    const front = drawing().views.find((v) => v.id === FRONT) as DrawingView;
    void front;
    expect(
      fail({
        kind: 'updateView',
        drawingId: D,
        view: {
          id: TOP,
          sheetId: SHEET1,
          kind: 'projected',
          parentId: TOP,
          from: 'top',
          layout: { kind: 'free', position: [0, 0] },
        },
      }),
    ).toMatch(/itself/);
    expect(
      fail({
        kind: 'updateView',
        drawingId: D,
        view: {
          id: FRONT,
          sheetId: SHEET1,
          kind: 'projected',
          parentId: TOP,
          from: 'top',
          layout: { kind: 'free', position: [0, 0] },
        },
      }),
    ).toMatch(/loop/);
    expect(fail({ kind: 'updateView', drawingId: D, view: baseView(9999) })).toMatch(/not found/);
    expect(
      fail({
        kind: 'addView',
        drawingId: D,
        view: {
          id: id(9704),
          sheetId: SHEET1,
          kind: 'section',
          parentId: FRONT,
          letter: 'C',
          cut: [{ kind: 'free', at: [0, 0] }],
          look: 'left',
          layout: { kind: 'free', position: [0, 0] },
        },
      }),
    ).toMatch(/at least two points/);
    expect(
      fail({
        kind: 'addView',
        drawingId: D,
        view: {
          id: id(9705),
          sheetId: SHEET1,
          kind: 'detail',
          parentId: FRONT,
          letter: 'D',
          center: { kind: 'free', at: [0, 0] },
          radius: 0,
          scale: '2',
          layout: { kind: 'free', position: [0, 0] },
        },
      }),
    ).toMatch(/radius must be greater than 0/);
  });

  it('moving a view to another sheet is one leaf edit; a drag is one undo step', () => {
    const { store, run, drawing } = setup();
    const front = drawing().views.find((v) => v.id === FRONT) as DrawingView;
    run({ kind: 'updateView', drawingId: D, view: { ...front, sheetId: SHEET2 } });
    const patches: unknown[] = [];
    store.subscribe((_d, c) => patches.push(...c.patches));
    run({ kind: 'updateView', drawingId: D, view: { ...front, sheetId: SHEET1 } });
    expect(patches).toEqual([
      { op: 'replace', path: '/drawings/0/views/0/sheetId', value: SHEET1 },
    ]);

    const base = store.history().past.length;
    for (let x = 1; x <= 20; x++) {
      run(
        {
          kind: 'updateView',
          drawingId: D,
          view: { ...front, layout: { kind: 'free', position: [120 + x * 0.12345, 150] } },
        },
        { coalesceKey: `drag:${FRONT}` },
      );
    }
    expect(store.history().past).toHaveLength(base + 1);
    const pos = () => (drawing().views[0]?.layout ?? { position: [] }) as { position: number[] };
    expect(pos().position[0]).toBe(122.469); // rounded to 0.001
    store.undo();
    expect(pos().position).toEqual([120, 150]);
  });

  it('removeViews removes dependents by default, with placements, marks and hole tables', () => {
    const { store, run, drawing } = setup();
    const before = store.getDoc();
    run({ kind: 'removeViews', drawingId: D, viewIds: [FRONT] });
    const d = drawing();
    expect(d.views).toEqual([]); // TOP, SECTION, DETAIL and ISO are all derived from FRONT
    expect(d.placements).toEqual([]);
    expect(d.centerMarks).toEqual([]);
    expect(d.tables.map((t) => t.kind)).toEqual(['partProperties']);
    expect(d.markup?.[0]).not.toHaveProperty('anchor');
    expect(validateDoc(store.getDoc())).toEqual([]);
    expect(store.history().past).toHaveLength(1);
    expect(store.history().past[0]?.label).toBe('Delete 5 views');
    store.undo();
    expect(store.getDoc()).toEqual(before);
  });

  it('removeViews with detach turns projected and iso children into base views, same orientation and position', () => {
    const { run, fail, drawing } = setup((doc) => {
      // keep only a projected and an iso child under FRONT
      const d = doc.drawings[0] as Drawing;
      d.views = d.views.filter((v) => v.id !== SECTION && v.id !== DETAIL);
      d.views = d.views.map((v) =>
        v.id === ISO
          ? ({ ...v, sheetId: SHEET1, scale: '1/4', display: { threads: false } } as DrawingView)
          : v,
      );
      d.placements = d.placements.filter((p) => p.viewId === FRONT || p.viewId === TOP);
    });
    const before = drawing();
    const frontPos = (
      before.views.find((v) => v.id === FRONT) as { layout: { position: number[] } }
    ).layout.position;
    run({ kind: 'removeViews', drawingId: D, viewIds: [FRONT], dependents: 'detach' });
    const d = drawing();
    expect(d.views.map((v) => v.id).sort()).toEqual([TOP, ISO].sort());
    const top = d.views.find((v) => v.id === TOP) as DrawingView;
    // third angle, from the top of the front view: the standard top view, 70 mm above the front
    expect(top).toMatchObject({
      kind: 'base',
      orientation: { kind: 'named', name: 'top' },
      layout: { kind: 'free', position: [frontPos[0], (frontPos[1] as number) + 70] },
    });
    expect(top).not.toHaveProperty('parentId');
    expect(top).not.toHaveProperty('scale'); // it equals the sheet's, so nothing needs baking
    const iso = d.views.find((v) => v.id === ISO) as Extract<DrawingView, { kind: 'base' }>;
    expect(iso.orientation.kind).toBe('matrix');
    expect(iso.scale).toBe('1/4');
    expect(iso.display).toMatchObject({ threads: false, lines: 'visible' });
    // placements of the removed view are gone; the others stay
    expect(d.placements.every((p) => p.viewId === TOP)).toBe(true);
    expect(fail({ kind: 'removeViews', drawingId: D, viewIds: ['ghost'] })).toMatch(/not found/);
  });

  it('detach refuses section and detail children (they need their parent) and names them', () => {
    const { store, fail } = setup();
    const before = store.getDoc();
    expect(
      fail({ kind: 'removeViews', drawingId: D, viewIds: [FRONT], dependents: 'detach' }),
    ).toMatch(/section view A.*needs the view it is made from/);
    expect(store.getDoc()).toBe(before);
  });

  it('detach bakes in an inherited scale and a rotated parent', () => {
    const { run, drawing } = setup((doc) => {
      const d = doc.drawings[0] as Drawing;
      d.views = d.views
        .filter((v) => v.id === FRONT || v.id === TOP)
        .map((v) =>
          v.id === FRONT ? ({ ...v, scale: '1/5', rotation: '90deg' } as DrawingView) : v,
        );
      d.placements = [];
      d.tables = [];
      d.centerMarks = [];
      delete d.markup;
    });
    run({ kind: 'removeViews', drawingId: D, viewIds: [FRONT], dependents: 'detach' });
    const top = drawing().views[0] as Extract<DrawingView, { kind: 'base' }>;
    expect(top.scale).toBe('1/5');
    expect(top.orientation.kind).toBe('matrix');
  });
});

describe('view frames', () => {
  const angle = () => undefined;
  it('derives the standard views from the front view', () => {
    const d = sampleDrawing();
    const frame = (view: string) => {
      const r = resolveViewFrame(d.views, view, angle);
      if (!r.ok) throw new Error(r.reason);
      return r.value;
    };
    expect(frame(FRONT)).toEqual({ x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] });
    expect(frame(TOP)).toEqual({ x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] });
    expect(frame(DETAIL)).toEqual(frame(FRONT));
    const iso = frame(ISO);
    expect(iso.n.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.57735, -0.57735, 0.57735]);
    expect(resolveViewFrame(d.views, SECTION, angle)).toMatchObject({ ok: false });
    expect(resolveViewFrame(d.views, 'ghost', angle)).toMatchObject({ ok: false });
  });

  it('left and right views, and first angle projection', () => {
    const base = sampleDrawing();
    const views = [
      base.views[0] as DrawingView,
      {
        id: id(9800),
        sheetId: SHEET1,
        kind: 'projected',
        parentId: FRONT,
        from: 'left',
        layout: { kind: 'aligned', distance: 60 },
      },
      {
        id: id(9801),
        sheetId: SHEET1,
        kind: 'projected',
        parentId: FRONT,
        from: 'right',
        layout: { kind: 'aligned', distance: 60 },
      },
    ] as DrawingView[];
    const f = (v: string) =>
      (resolveViewFrame(views, v, angle) as { value: { x: number[]; n: number[] } }).value;
    expect(f(id(9800))).toMatchObject({ x: [0, -1, 0], n: [-1, 0, 0] }); // seen from the left
    expect(f(id(9801))).toMatchObject({ x: [0, 1, 0], n: [1, 0, 0] });
    const third = { ...base, views };
    const first = { ...base, views, projection: 'first' as const };
    expect(resolveViewPosition(third, id(9800))).toEqual({ ok: true, value: [60, 150] });
    expect(resolveViewPosition(first, id(9800))).toEqual({ ok: true, value: [180, 150] });
  });
});

describe('placements', () => {
  const place = (n: number, annotationId: string, viewId = FRONT) => ({
    id: id(n),
    viewId,
    annotationId,
    layout: { kind: 'offset' as const, distance: 8 },
  });

  it('placeAnnotations places existing annotations and promoted ones in one step', () => {
    const { store, run, drawing } = setup();
    const promoted: Annotation = {
      id: id(9900),
      kind: 'linear',
      origin: { kind: 'model' },
      refs: [ref('S11:p(a)', 'vertex'), ref('S11:p(b)', 'vertex')],
      direction: [1, 0, 0],
      nominal: '40mm',
    };
    run({
      kind: 'placeAnnotations',
      drawingId: D,
      items: [
        { placement: place(9901, id(907), TOP) },
        { placement: place(9902, id(9900)), annotation: promoted },
      ],
    });
    expect(drawing().placements.map((p) => p.id)).toContain(id(9902));
    expect(store.getDoc().parts[0]?.annotations?.some((a) => a.id === id(9900))).toBe(true);
    expect(store.history().past).toHaveLength(1);
    expect(validateDoc(store.getDoc())).toEqual([]);
    store.undo();
    expect(store.getDoc().parts[0]?.annotations?.some((a) => a.id === id(9900))).toBe(false);
  });

  it('refuses a second placement in the drawing unless allowed; never twice in one view', () => {
    const { run, fail, drawing } = setup();
    // 900 is already placed in FRONT
    expect(
      fail({
        kind: 'placeAnnotations',
        drawingId: D,
        items: [{ placement: place(9910, id(900), TOP) }],
      }),
    ).toMatch(/already placed in this drawing/);
    expect(
      fail({
        kind: 'placeAnnotations',
        drawingId: D,
        allowDuplicate: true,
        items: [{ placement: place(9910, id(900)) }],
      }),
    ).toMatch(/only once in a view/);
    run({
      kind: 'placeAnnotations',
      drawingId: D,
      allowDuplicate: true,
      items: [{ placement: place(9910, id(900), TOP) }],
    });
    expect(drawing().placements.filter((p) => p.annotationId === id(900))).toHaveLength(2);
    expect(
      fail({
        kind: 'placeAnnotations',
        drawingId: D,
        items: [
          { placement: place(9911, id(906), TOP) },
          { placement: place(9912, id(906), FRONT) },
        ],
      }),
    ).toMatch(/already placed in this drawing/);
    expect(
      fail({
        kind: 'placeAnnotations',
        drawingId: D,
        items: [{ placement: place(9913, 'ghost') }],
      }),
    ).toMatch(/Annotation ‘ghost’/);
    expect(
      fail({
        kind: 'placeAnnotations',
        drawingId: D,
        items: [{ placement: place(9914, id(906), 'ghost') }],
      }),
    ).toMatch(/View ‘ghost’/);
    expect(fail({ kind: 'placeAnnotations', drawingId: D, items: [] })).toMatch(/Nothing to place/);
    expect(
      fail({
        kind: 'placeAnnotations',
        drawingId: D,
        items: [
          {
            placement: place(9915, id(906)),
            annotation: {
              id: id(906),
              kind: 'note',
              origin: { kind: 'model' },
              refs: [ref('a')],
              text: 'x',
            },
          },
        ],
      }),
    ).toMatch(/already in use/);
  });

  it('updatePlacements replaces whole placements; a drag is one undo step', () => {
    const { store, run, fail, drawing } = setup();
    const p = drawing().placements.find((x) => x.id === id(5070)) as ReturnType<typeof place>;
    for (let i = 1; i <= 10; i++) {
      run(
        {
          kind: 'updatePlacements',
          drawingId: D,
          placements: [
            {
              ...p,
              layout: { kind: 'lane', side: 'bottom', lane: 0 },
              text: { shift: i * 0.0004 },
            },
          ],
        },
        { coalesceKey: 'drag-text' },
      );
    }
    expect(store.history().past).toHaveLength(1);
    expect(drawing().placements.find((x) => x.id === id(5070))?.text?.shift).toBe(0.004);
    expect(
      fail({ kind: 'updatePlacements', drawingId: D, placements: [place(9999, id(906))] }),
    ).toMatch(/not found/);
    expect(
      fail({
        kind: 'updatePlacements',
        drawingId: D,
        placements: [{ ...p, viewId: TOP, annotationId: id(901) }],
      }),
    ).toMatch(/only once in a view/);
  });

  it('removePlacements hides from views and keeps the annotation', () => {
    const { store, run, drawing } = setup();
    run({ kind: 'removePlacements', drawingId: D, placementIds: [id(5070)] });
    expect(drawing().placements.some((p) => p.id === id(5070))).toBe(false);
    expect(store.getDoc().parts[0]?.annotations?.some((a) => a.id === id(900))).toBe(true);
    expect(drawing().markup?.[0]).not.toHaveProperty('anchor');
    expect(validateDoc(store.getDoc())).toEqual([]);
  });
});

describe('centre marks, tables, notes, markup', () => {
  it('add / update / remove, each one undo step', () => {
    const { store, run, fail, drawing } = setup();
    run({
      kind: 'addCenterMark',
      drawingId: D,
      mark: { id: id(9950), viewId: TOP, kind: 'boltCircle', refs: [ref('S23:e(c)', 'edge')] },
    });
    expect(drawing().centerMarks.map((m) => m.id)).toEqual([id(5080), id(9950)]);
    run({ kind: 'removeCenterMarks', drawingId: D, markIds: [id(9950)] });
    expect(
      fail({
        kind: 'addCenterMark',
        drawingId: D,
        mark: { id: id(9951), viewId: 'ghost', kind: 'centerMark', refs: [] },
      }),
    ).toMatch(/View/);

    const table: DrawingTable = {
      id: id(9952),
      sheetId: SHEET2,
      kind: 'partProperties',
      position: [10.00049, 20],
      anchor: 'topLeft',
      columns: ['mass'],
      rows: { kind: 'configurations', configurations: [null, id(700)] },
    };
    run({ kind: 'addTable', drawingId: D, table });
    expect(drawing().tables.find((t) => t.id === id(9952))?.position).toEqual([10, 20]);
    run({ kind: 'updateTable', drawingId: D, table: { ...table, columns: ['mass', 'material'] } });
    run({ kind: 'removeTable', drawingId: D, tableId: id(9952) });
    expect(
      fail({ kind: 'addTable', drawingId: D, table: { ...table, id: id(9953), sheetId: 'ghost' } }),
    ).toMatch(/Sheet/);
    expect(fail({ kind: 'updateTable', drawingId: D, table: { ...table, id: id(9954) } })).toMatch(
      /not found/,
    );
    expect(
      fail({
        kind: 'addTable',
        drawingId: D,
        table: {
          id: id(9955),
          sheetId: SHEET1,
          kind: 'holeTable',
          position: [0, 0],
          anchor: 'topLeft',
          viewId: 'ghost',
          origin: { kind: 'free', at: [0, 0] },
          holes: 'all',
        },
      }),
    ).toMatch(/View/);

    const note: SheetNote = {
      id: id(9956),
      sheetId: SHEET1,
      position: [5, 5],
      text: 'GENERAL',
      height: 3.5,
    };
    run({ kind: 'addSheetNote', drawingId: D, note });
    run({ kind: 'updateSheetNote', drawingId: D, note: { ...note, text: 'CHANGED' } });
    expect(drawing().notes.find((n) => n.id === id(9956))?.text).toBe('CHANGED');
    run({ kind: 'removeSheetNote', drawingId: D, noteId: id(9956) });
    expect(fail({ kind: 'removeSheetNote', drawingId: D, noteId: id(9956) })).toMatch(/not found/);

    const markup = {
      id: id(9957),
      sheetId: SHEET2,
      versionId: 'v2',
      author: 'me',
      at: '2026-01-01T00:00:00.000Z',
      strokes: [],
    };
    run({ kind: 'addMarkup', drawingId: D, markup });
    run({ kind: 'setMarkupResolved', drawingId: D, markupId: id(9957), resolved: true });
    expect(drawing().markup?.find((m) => m.id === id(9957))?.resolved).toBe(true);
    run({ kind: 'setMarkupResolved', drawingId: D, markupId: id(9957), resolved: false });
    expect(drawing().markup?.find((m) => m.id === id(9957))).not.toHaveProperty('resolved');
    run({ kind: 'removeMarkup', drawingId: D, markupId: id(9957) });
    run({ kind: 'removeMarkup', drawingId: D, markupId: id(5084) });
    expect(drawing()).not.toHaveProperty('markup');
    expect(fail({ kind: 'removeMarkup', drawingId: D, markupId: id(5084) })).toMatch(/not found/);
    expect(validateDoc(store.getDoc())).toEqual([]);
    // 13 commands ran, one undo entry each
    expect(store.history().past.length).toBeGreaterThanOrEqual(13);
  });

  it('every id belongs to one document-wide id space', () => {
    const { fail } = setup();
    // a note id that is a feature id, a placement id, a view id
    for (const taken of [id(12), id(5070), FRONT, id(900), D]) {
      expect(
        fail({
          kind: 'addSheetNote',
          drawingId: D,
          note: { id: taken, sheetId: SHEET1, position: [0, 0], text: 'x' },
        }),
      ).toMatch(/already in use/);
    }
  });
});

describe('normalizeDrawings', () => {
  const normalized = (mutate: (d: Drawing) => void) => {
    const doc = sampleDoc();
    mutate(doc.drawings[0] as Drawing);
    return normalizeDrawings(doc);
  };

  it('leaves a clean document alone (same object, no notes)', () => {
    const doc = sampleDoc();
    const r = normalizeDrawings(doc);
    expect(r.doc).toBe(doc);
    expect(r.notes).toEqual([]);
  });

  it('drops placements whose view or annotation is missing, and duplicates (smaller id stays)', () => {
    const r = normalized((d) => {
      d.placements.push({
        ...(d.placements[0] as AnnotationPlacement),
        id: id(5100),
        viewId: 'ghost',
      });
      d.placements.push({
        ...(d.placements[0] as AnnotationPlacement),
        id: id(5101),
        annotationId: 'ghost',
      });
      d.placements.push({ ...(d.placements[0] as AnnotationPlacement), id: id(5069) }); // duplicate of 5070 in the same view
    });
    const ids = r.doc.drawings[0]?.placements.map((p) => p.id);
    expect(ids).not.toContain(id(5100));
    expect(ids).not.toContain(id(5101));
    expect(ids).toContain(id(5069));
    expect(ids).not.toContain(id(5070));
    // the fixture's markup was anchored to the dropped duplicate, so its anchor is cleared too
    expect(r.notes.map((n) => n.kind).sort()).toEqual([
      'duplicatePlacementDropped',
      'markupAnchorCleared',
      'placementDropped',
      'placementDropped',
    ]);
  });

  it('leaves placements intact when the subject part is missing', () => {
    const r = normalized((d) => {
      d.subject = { kind: 'part', partId: 'ghost' };
    });
    expect(r.doc.drawings[0]?.placements).toHaveLength(6);
    expect(r.notes).toEqual([]);
  });

  it('moves views, tables, notes and markup of a missing sheet to the first sheet; drops orphan marks', () => {
    const r = normalized((d) => {
      (d.views.find((v) => v.id === DETAIL) as DrawingView).sheetId = 'ghost';
      (d.notes[0] as { sheetId: string }).sheetId = 'ghost';
      (d.markup?.[0] as { sheetId: string }).sheetId = 'ghost';
      d.centerMarks.push({ id: id(5200), viewId: 'ghost', kind: 'centerMark', refs: [] });
      d.tables.push({
        id: id(5201),
        sheetId: SHEET1,
        kind: 'holeTable',
        position: [0, 0],
        anchor: 'topLeft',
        viewId: 'ghost',
        origin: { kind: 'free', at: [0, 0] },
        holes: 'all',
      });
    });
    const d = r.doc.drawings[0] as Drawing;
    expect(d.views.find((v) => v.id === DETAIL)?.sheetId).toBe(SHEET1);
    expect(d.notes[0]?.sheetId).toBe(SHEET1);
    expect(d.markup?.[0]?.sheetId).toBe(SHEET1);
    expect(d.centerMarks.map((m) => m.id)).toEqual([id(5080)]);
    expect(d.tables.some((t) => t.id === id(5201))).toBe(false);
    expect(r.notes.map((n) => n.kind).sort()).toEqual([
      'centerMarkDropped',
      'itemMovedToFirstSheet',
      'itemMovedToFirstSheet',
      'tableDropped',
      'viewMovedToFirstSheet',
    ]);
  });

  it('keeps views whose parent is missing or cyclic (needs attention, not rendered), and clears dead markup anchors', () => {
    const r = normalized((d) => {
      (d.views.find((v) => v.id === TOP) as { parentId: string }).parentId = 'ghost';
      (d.markup?.[0] as { anchor: unknown }).anchor = { placementId: 'ghost', viewId: FRONT };
    });
    const d = r.doc.drawings[0] as Drawing;
    expect(d.views.map((v) => v.id)).toContain(TOP);
    expect(d.markup?.[0]?.anchor).toEqual({ viewId: FRONT });
    expect(r.notes.map((n) => n.kind)).toEqual(['markupAnchorCleared']);
  });

  it('is deterministic: sorts unordered collections by id, whatever the input order, and rounds sheet numbers', () => {
    const shuffled = normalized((d) => {
      d.views.reverse();
      d.placements.reverse();
      d.tables.reverse();
      d.sheets = [...d.sheets]; // sheet order is meaningful and untouched
      (d.views[0] as { layout: { position: number[] } }).layout = {
        kind: 'free',
        position: [1.00049, 2],
      } as never;
    });
    const ordered = normalized((d) => {
      (d.views.find((v) => v.id === ISO) as { layout: unknown }).layout = {
        kind: 'free',
        position: [1.00049, 2],
      };
    });
    expect(JSON.stringify(shuffled.doc.drawings)).toBe(JSON.stringify(ordered.doc.drawings));
    const d = shuffled.doc.drawings[0] as Drawing;
    expect(d.views.map((v) => v.id)).toEqual([...d.views.map((v) => v.id)].sort());
    expect(d.sheets.map((s) => s.id)).toEqual([SHEET1, SHEET2]);
    const isoLayout = (d.views.find((v) => v.id === ISO) as DrawingView).layout as {
      position: number[];
    };
    expect(isoLayout.position).toEqual([1, 2]);
    expect(normalizeDrawings(shuffled.doc).doc).toBe(shuffled.doc); // idempotent
  });

  it('runs on load and reports what it repaired once', () => {
    const doc = sampleDoc();
    (doc.drawings[0] as Drawing).placements.push({
      ...(doc.drawings[0]?.placements[0] as AnnotationPlacement),
      id: id(5100),
      viewId: 'ghost',
    });
    const store = createDocumentStore();
    const r = store.load(doc);
    expect(r.ok && (r as { notes?: string[] }).notes).toEqual([
      'Dropped a placement in ‘Bracket drawing’ (its view is missing)',
    ]);
    expect(store.getDoc().drawings[0]?.placements).toHaveLength(6);
    expect((store.load(sampleDoc()) as { notes?: string[] }).notes).toBeUndefined();
  });

  it('sorts a part’s annotations on load', () => {
    const doc = sampleDoc();
    doc.parts[0]?.annotations?.reverse();
    const store = createDocumentStore();
    store.load(doc);
    const ids = store.getDoc().parts[0]?.annotations?.map((a) => a.id) ?? [];
    expect(ids).toEqual([...ids].sort());
  });
});

describe('validateDoc on drawings', () => {
  const errors = (mutate: (d: Record<string, unknown>) => void): string => {
    const d = structuredClone(sampleDrawing()) as unknown as Record<string, unknown>;
    mutate(d);
    const doc = { ...sampleDoc(), drawings: [d] } as unknown as WrenDoc;
    return validateDoc(doc).join('\n');
  };

  it('accepts the fixture and reports structure with paths', () => {
    expect(errors(() => {})).toBe('');
    expect(errors((d) => (d.units = 'in'))).toMatch(/drawings\[0\]\.units must be ‘mm’/);
    expect(errors((d) => (d.projection = 'second'))).toMatch(
      /projection must be one of first, third/,
    );
    expect(
      errors((d) => ((d.standard as Record<string, unknown>).gps = 'ASME Y14.5-2018')),
    ).toMatch(/does not belong to the ISO family/);
    expect(errors((d) => ((d.style as { text: { note: number } }).text.note = 0))).toMatch(
      /style\.text\.note must be greater than 0/,
    );
    expect(
      errors(
        (d) => ((d.style as { numbers: { lengthPrecision: number } }).numbers.lengthPrecision = 9),
      ),
    ).toMatch(/lengthPrecision must be at most 6/);
    expect(errors((d) => ((d.template as { version: number }).version = 2))).toMatch(
      /template\.version must be at most 1/,
    );
    expect(errors((d) => (d.sheets = []))).toMatch(/at least one sheet/);
    expect(
      errors(
        (d) =>
          (((d.views as Record<string, unknown>[])[0] as Record<string, unknown>).kind = 'tilted'),
      ),
    ).toMatch(/views\[0\]\.kind must be one of/);
    expect(
      errors(
        (d) =>
          (((d.views as Record<string, unknown>[])[3] as Record<string, unknown>).scale =
            undefined),
      ),
    ).toMatch(/scale is required for a detail view/);
    expect(
      errors(
        (d) =>
          (((d.views as Record<string, unknown>[])[0] as Record<string, unknown>).layout = {
            kind: 'aligned',
            distance: 1,
          }),
      ),
    ).toMatch(/layout\.kind must be one of free/);
    expect(
      errors(
        (d) =>
          (((d.placements as { layout: unknown }[])[0] as { layout: unknown }).layout = {
            kind: 'wiggle',
          }),
      ),
    ).toMatch(/layout\.kind must be one of lane/);
    expect(
      errors(
        (d) =>
          (((d.tables as Record<string, unknown>[])[0] as Record<string, unknown>).columns = [
            'colour',
          ]),
      ),
    ).toMatch(/columns\[0\] must be one of/);
    expect(errors((d) => (d.placements = 'x'))).toMatch(/placements must be an array/);
  });

  it('shares one id space: a view id equal to a feature id is a duplicate', () => {
    expect(
      errors((d) => (((d.views as { id: string }[])[0] as { id: string }).id = id(12))),
    ).toMatch(/duplicate id/);
  });

  it('does not fail dangling references (missing part, configuration, parent)', () => {
    expect(errors((d) => ((d.subject as { partId: string }).partId = 'ghost'))).toBe('');
    expect(errors((d) => (d.configurationId = 'ghost'))).toBe('');
    expect(
      errors(
        (d) =>
          (((d.views as { parentId: string }[])[1] as { parentId: string }).parentId = 'ghost'),
      ),
    ).toBe('');
  });

  it('checks drawingDefaults', () => {
    const doc = sampleDoc() as unknown as Record<string, unknown>;
    doc.drawingDefaults = {
      standard: { family: 'iso', gps: 'ISO 1101:2017', surfaceFinish: 'x' },
      projection: 'third',
      fields: { nope: 'x' },
    };
    const errs = validateDoc(doc).join('\n');
    expect(errs).toMatch(/drawingDefaults\.standard\.surfaceFinish must be one of/);
    expect(errs).toMatch(/drawingDefaults\.fields\.nope is not a title block slot/);
  });
});
