// SPDX-License-Identifier: GPL-3.0-or-later
import type { Annotation, Command, WrenDoc } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  configurationIssues,
  createDocumentStore,
  evaluateAnnotationValues,
  resolveConfiguration,
  validateDoc,
} from '../src';
import { id, ref, sampleDoc } from './fixtures';

const PART = id(3);
const CFG = id(700);

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
  return { store, run, fail };
}

const part = (doc: WrenDoc) => doc.parts.find((p) => p.id === PART) as WrenDoc['parts'][number];
const annotation = (doc: WrenDoc, n: number) =>
  part(doc).annotations?.find((a) => a.id === id(n)) as Annotation;

const note = (n: number): Annotation => ({
  id: id(n),
  kind: 'note',
  origin: { kind: 'model' },
  refs: [ref('F1:a')],
  text: 'N',
});

describe('addAnnotation', () => {
  it('inserts in id order, as one undo step, and undo restores the document exactly', () => {
    const { store, run } = setup();
    const before = store.getDoc();
    const doc = run({ kind: 'addAnnotation', partId: PART, annotation: note(9005) });
    expect(part(doc).annotations?.map((a) => a.id)).toEqual(
      [...(part(before).annotations ?? []).map((a) => a.id), id(9005)].sort(),
    );
    run({ kind: 'addAnnotation', partId: PART, annotation: note(7) });
    expect(part(store.getDoc()).annotations?.[0]?.id).toBe(id(7));
    expect(validateDoc(store.getDoc())).toEqual([]);
    expect(store.history().past.map((h) => h.label)).toEqual(['Add note', 'Add note']);
    store.undo();
    store.undo();
    expect(store.getDoc()).toEqual(before);
    expect(store.canUndo()).toBe(false);
  });

  it('creates the set on a part without annotations (and undo removes it again)', () => {
    const { store, run } = setup();
    const other = id(4);
    run({ kind: 'addAnnotation', partId: other, annotation: note(9005) });
    expect(store.getDoc().parts[1]?.annotations).toHaveLength(1);
    store.undo();
    expect(store.getDoc().parts[1]).not.toHaveProperty('annotations');
  });

  it('with `place` adds the annotation and its placement in one step', () => {
    const { store, run } = setup();
    const a: Annotation = {
      id: id(910),
      kind: 'diameter',
      origin: { kind: 'drawing', drawingId: id(5) },
      refs: [ref('S23:e(c)', 'edge')],
    };
    run({
      kind: 'addAnnotation',
      partId: PART,
      annotation: a,
      place: {
        drawingId: id(5),
        placement: {
          id: id(5100),
          viewId: id(5060),
          annotationId: id(910),
          layout: { kind: 'radial', angle: 30.00049, distance: 5 },
        },
      },
    });
    const d = store.getDoc();
    expect(annotation(d, 910)).toEqual(a);
    const placed = d.drawings[0]?.placements.find((p) => p.id === id(5100));
    expect(placed?.layout).toEqual({ kind: 'radial', angle: 30, distance: 5 }); // 0.001 mm rounding
    expect(store.history().past).toHaveLength(1);
    store.undo();
    expect(annotation(store.getDoc(), 910)).toBeUndefined();
    expect(store.getDoc().drawings[0]?.placements.some((p) => p.id === id(5100))).toBe(false);
  });

  it('refuses what is wrong, naming it', () => {
    const { fail } = setup();
    expect(fail({ kind: 'addAnnotation', partId: 'nope', annotation: note(9005) })).toMatch(/Part/);
    expect(fail({ kind: 'addAnnotation', partId: PART, annotation: note(900) })).toMatch(
      /already in use/,
    );
    expect(
      fail({
        kind: 'addAnnotation',
        partId: PART,
        annotation: { ...note(9005), text: 5 } as never,
      }),
    ).toMatch(/Invalid annotation: .*text must be a string/);
    expect(
      fail({
        kind: 'addAnnotation',
        partId: PART,
        annotation: { ...note(9005), origin: { kind: 'drawing', drawingId: 'ghost' } },
      }),
    ).toMatch(/Drawing ‘ghost’/);
    const badPlace = {
      drawingId: id(5),
      placement: {
        id: id(5100),
        viewId: 'ghost',
        annotationId: id(9005),
        layout: { kind: 'offset', distance: 1 },
      },
    } as const;
    expect(
      fail({ kind: 'addAnnotation', partId: PART, annotation: note(9005), place: badPlace }),
    ).toMatch(/View ‘ghost’/);
    const wrongOne = {
      ...badPlace,
      placement: { ...badPlace.placement, viewId: id(5060), annotationId: id(906) },
    };
    expect(
      fail({ kind: 'addAnnotation', partId: PART, annotation: note(9005), place: wrongOne }),
    ).toMatch(/of the new annotation/);
  });
});

describe('updateAnnotation and reattachAnnotation', () => {
  it('replaces the annotation as a small patch and refuses to change the id', () => {
    const { store, run, fail } = setup();
    const a = annotation(store.getDoc(), 902);
    run({
      kind: 'updateAnnotation',
      partId: PART,
      annotationId: id(902),
      annotation: { ...a, nominal: '12mm' } as Annotation,
    });
    expect((annotation(store.getDoc(), 902) as { nominal: string }).nominal).toBe('12mm');
    expect(
      fail({
        kind: 'updateAnnotation',
        partId: PART,
        annotationId: id(902),
        annotation: { ...a, id: id(1) } as Annotation,
      }),
    ).toMatch(/id cannot be changed/);
    expect(
      fail({ kind: 'updateAnnotation', partId: PART, annotationId: 'x', annotation: a }),
    ).toMatch(/not found/);
  });

  it('reattach replaces refs (and at) for any kind, checking arity', () => {
    const { store, run, fail } = setup();
    run({
      kind: 'reattachAnnotation',
      partId: PART,
      annotationId: id(900),
      refs: [ref('F9:a'), ref('F9:b')],
      at: ['center', 'center'],
    });
    const a = annotation(store.getDoc(), 900);
    expect(a.refs.map((r) => r.name)).toEqual(['F9:a', 'F9:b']);
    expect(a.at).toEqual(['center', 'center']);
    // `at` that is not given is kept, cut to the new length
    run({
      kind: 'reattachAnnotation',
      partId: PART,
      annotationId: id(902),
      refs: [ref('F9:c', 'edge')],
    });
    expect(annotation(store.getDoc(), 902).at).toEqual(['self']);
    expect(
      fail({ kind: 'reattachAnnotation', partId: PART, annotationId: id(900), refs: [ref('x')] }),
    ).toMatch(/needs 2 references/);
    expect(
      fail({
        kind: 'reattachAnnotation',
        partId: PART,
        annotationId: id(900),
        refs: [ref('x'), ref('y')],
        at: ['a' as never],
      }),
    ).toMatch(/not a point/);
    expect(
      fail({
        kind: 'reattachAnnotation',
        partId: PART,
        annotationId: id(900),
        refs: [{ name: '' } as never, ref('y')],
      }),
    ).toMatch(/entity reference/);
  });
});

describe('removeAnnotation', () => {
  const withOverrides = (doc: WrenDoc) => {
    part(doc).configurations = [
      {
        id: CFG,
        name: 'Loose',
        annotations: {
          [id(902)]: { fields: { '/nominal': '11mm', '/tolerance/hole': 'H8' } },
          [id(901)]: { suppressed: true },
        },
      },
    ];
  };

  it('removes placements, overrides and bound frames’ datum links in one undo step', () => {
    const { store, run } = setup(withOverrides);
    const before = store.getDoc();
    // 903 is datum A: frame 905 binds to it; 902 has a placement, an override, and 905 applies to it
    const doc = run({ kind: 'removeAnnotation', partId: PART, annotationIds: [id(903), id(902)] });
    expect(part(doc).annotations?.some((a) => a.id === id(902) || a.id === id(903))).toBe(false);
    expect(doc.drawings[0]?.placements.map((p) => p.annotationId)).not.toContain(id(902));
    expect(doc.drawings[0]?.placements.map((p) => p.annotationId)).not.toContain(id(903));
    const frame = annotation(doc, 905) as Extract<Annotation, { kind: 'geometricTolerance' }>;
    // datum A keeps its letter, unbound; datum B stays bound; appliesTo stays (needs attention)
    expect(frame.datums?.[0]?.datums).toEqual([{ label: 'A' }]);
    expect(frame.datums?.[1]?.datums).toEqual([{ datum: id(904) }]);
    expect(frame.appliesTo).toBe(id(902));
    expect(part(doc).configurations?.[0]?.annotations).toEqual({ [id(901)]: { suppressed: true } });
    // markup anchored to a removed placement is kept, anchor cleared if its placement went
    expect(validateDoc(doc)).toEqual([]);
    expect(store.history().past).toHaveLength(1);
    expect(store.history().past[0]?.label).toBe('Delete 2 annotations');
    store.undo();
    expect(store.getDoc()).toEqual(before);
    store.redo();
    expect(store.getDoc()).toEqual(doc);
  });

  it('removing the last annotations drops the key; markup anchors follow removed placements', () => {
    const { store, run } = setup();
    const all = (part(store.getDoc()).annotations ?? []).map((a) => a.id);
    const doc = run({ kind: 'removeAnnotation', partId: PART, annotationIds: all });
    expect(part(doc)).not.toHaveProperty('annotations');
    expect(doc.drawings[0]?.placements).toEqual([]);
    // the fixture's markup was anchored to placement 5070 (of annotation 900)
    expect(doc.drawings[0]?.markup?.[0]).not.toHaveProperty('anchor');
    store.undo();
    expect(part(store.getDoc()).annotations).toHaveLength(9);
  });

  it('is all-or-nothing', () => {
    const { store, fail } = setup();
    const before = store.getDoc();
    expect(
      fail({ kind: 'removeAnnotation', partId: PART, annotationIds: [id(900), 'ghost'] }),
    ).toMatch(/ghost/);
    expect(fail({ kind: 'removeAnnotation', partId: PART, annotationIds: [] })).toMatch(
      /at least one/,
    );
    expect(store.getDoc()).toBe(before);
  });
});

describe('configuration overrides of annotations', () => {
  const withCfg = (doc: WrenDoc) => {
    part(doc).configurations = [{ id: CFG, name: 'Loose' }];
  };

  it('setConfigurationOverrides accepts annotationField and annotationSuppressed targets', () => {
    const { store, run, fail } = setup(withCfg);
    run({
      kind: 'setConfigurationOverrides',
      partId: PART,
      edits: [
        {
          configurationId: CFG,
          target: { kind: 'annotationField', annotationId: id(902), path: '/nominal' },
          value: '12mm',
        },
        {
          configurationId: CFG,
          target: { kind: 'annotationField', annotationId: id(902), path: '/tolerance/hole' },
          value: 'H8',
        },
        {
          configurationId: CFG,
          target: { kind: 'annotationSuppressed', annotationId: id(901) },
          value: true,
        },
      ],
    });
    expect(part(store.getDoc()).configurations?.[0]?.annotations).toEqual({
      [id(902)]: { fields: { '/nominal': '12mm', '/tolerance/hole': 'H8' } },
      [id(901)]: { suppressed: true },
    });
    expect(store.history().past).toHaveLength(1);
    // reset removes the key and prunes empty containers
    run({
      kind: 'setConfigurationOverrides',
      partId: PART,
      edits: [
        {
          configurationId: CFG,
          target: { kind: 'annotationField', annotationId: id(902), path: '/nominal' },
          value: undefined,
        },
        {
          configurationId: CFG,
          target: { kind: 'annotationField', annotationId: id(902), path: '/tolerance/hole' },
          value: undefined,
        },
        {
          configurationId: CFG,
          target: { kind: 'annotationSuppressed', annotationId: id(901) },
          value: undefined,
        },
      ],
    });
    expect(part(store.getDoc()).configurations?.[0]).toEqual({ id: CFG, name: 'Loose' });
    const bad = (path: string, value: string | boolean) =>
      fail({
        kind: 'setConfigurationOverrides',
        partId: PART,
        edits: [
          {
            configurationId: CFG,
            target: { kind: 'annotationField', annotationId: id(902), path },
            value,
          },
        ],
      });
    expect(bad('/nominal', '5deg')).toMatch(/nominal/);
    expect(bad('/nominal', '(')).toMatch(/nominal/);
    expect(bad('/text/prefix', 'x')).toMatch(/not a configurable field/);
    expect(bad('/tolerance/hole', 'h8')).toMatch(/ISO 286 hole class/);
    expect(bad('/tolerance/shaft', 'g6')).toMatch(/not a field of this annotation/);
    expect(bad('/nominal', true)).toMatch(/needs an expression/);
    expect(
      fail({
        kind: 'setConfigurationOverrides',
        partId: PART,
        edits: [
          {
            configurationId: CFG,
            target: { kind: 'annotationSuppressed', annotationId: 'ghost' },
            value: true,
          },
        ],
      }),
    ).toMatch(/Annotation ‘ghost’ was not found/);
    expect(
      fail({
        kind: 'setConfigurationOverrides',
        partId: PART,
        edits: [
          {
            configurationId: CFG,
            target: { kind: 'annotationSuppressed', annotationId: id(901) },
            value: 'x' as never,
          },
        ],
      }),
    ).toMatch(/true or false/);
  });

  it('labels single edits by annotation', () => {
    const { store, run } = setup(withCfg);
    run({
      kind: 'setConfigurationOverrides',
      partId: PART,
      edits: [
        {
          configurationId: CFG,
          target: { kind: 'annotationSuppressed', annotationId: id(901) },
          value: true,
        },
      ],
    });
    expect(store.history().past[0]?.label).toBe('Suppress angle dimension in Loose');
  });

  it('resolveConfiguration applies annotation overrides and evaluates in that configuration', () => {
    const { store, run } = setup(withCfg);
    run({
      kind: 'setConfigurationOverrides',
      partId: PART,
      edits: [
        {
          configurationId: CFG,
          target: { kind: 'annotationField', annotationId: id(902), path: '/nominal' },
          value: 'width / 4',
        },
        {
          configurationId: CFG,
          target: { kind: 'annotationField', annotationId: id(902), path: '/tolerance/hole' },
          value: 'H8',
        },
        {
          configurationId: CFG,
          target: { kind: 'annotationSuppressed', annotationId: id(901) },
          value: true,
        },
      ],
    });
    const doc = store.getDoc();
    const r = resolveConfiguration(doc, PART, CFG);
    expect(r.issues).toEqual([]);
    const a = annotation(r.doc, 902) as Extract<Annotation, { kind: 'diameter' }>;
    expect(a.nominal).toBe('width / 4');
    expect(a.tolerance).toMatchObject({ kind: 'fit', hole: 'H8' });
    expect(annotation(r.doc, 901).suppressed).toBe(true);
    expect(evaluateAnnotationValues(a, r.doc).values['/nominal']).toBe(10);
    // Default is untouched, and unchanged annotations are shared
    expect((annotation(doc, 902) as { nominal: string }).nominal).toBe('10mm');
    expect(annotation(r.doc, 900)).toBe(annotation(doc, 900));
    expect(resolveConfiguration(doc, PART, null).doc).toBe(doc);
  });

  it('reports stale and unusable overrides, never dropping them', () => {
    const { store } = setup((doc) => {
      part(doc).configurations = [
        {
          id: CFG,
          name: 'Stale',
          annotations: {
            ghost: { suppressed: true, fields: { '/nominal': '1mm' } },
            [id(902)]: {
              fields: {
                '/nope': '1',
                '/tolerance/shaft': 'g6',
                '/tolerance/hole': 'x1',
                bad: '1',
                '/nominal': 5 as never,
              },
            },
            [id(903)]: { suppressed: 'yes' as never },
          },
        },
      ];
    });
    const r = resolveConfiguration(store.getDoc(), PART, CFG);
    const reasons = r.issues.map((i) => `${i.target.kind}: ${i.reason}`).join('\n');
    expect(reasons).toMatch(/annotationSuppressed: Annotation ‘ghost’ no longer exists/);
    expect(reasons).toMatch(/annotationField: Annotation ‘ghost’ no longer exists/);
    expect(reasons).toMatch(/‘\/nope’ is not a configurable field/);
    expect(reasons).toMatch(/‘\/tolerance\/shaft’ no longer exists/);
    expect(reasons).toMatch(/is not an ISO 286 hole class/);
    expect(reasons).toMatch(/‘bad’ is not a valid field path/);
    expect(reasons).toMatch(/must be an expression/);
    expect(reasons).toMatch(/Suppression must be true or false/);
    expect(configurationIssues(store.getDoc(), PART).length).toBe(r.issues.length);
  });

  it('a configuration copy keeps annotation overrides', () => {
    const { store, run } = setup(withCfg);
    run({
      kind: 'setConfigurationOverrides',
      partId: PART,
      edits: [
        {
          configurationId: CFG,
          target: { kind: 'annotationSuppressed', annotationId: id(901) },
          value: true,
        },
      ],
    });
    run({
      kind: 'addConfiguration',
      partId: PART,
      from: CFG,
      configuration: { id: id(701), name: 'Copy' },
    });
    expect(part(store.getDoc()).configurations?.[1]?.annotations).toEqual({
      [id(901)]: { suppressed: true },
    });
  });
});

describe('parameter renames reach annotations', () => {
  it('rewrites annotation fields and their configuration overrides in one step', () => {
    const { store, run } = setup((doc) => {
      part(doc).annotations = (part(doc).annotations ?? []).map((a) =>
        a.id === id(902) ? ({ ...a, nominal: 'width / 4' } as Annotation) : a,
      );
      part(doc).configurations = [
        { id: CFG, name: 'L', annotations: { [id(902)]: { fields: { '/nominal': 'width / 2' } } } },
      ];
    });
    run({ kind: 'updateParam', paramId: id(1), name: 'span' });
    const doc = store.getDoc();
    expect((annotation(doc, 902) as { nominal: string }).nominal).toBe('span / 4');
    expect(part(doc).configurations?.[0]?.annotations?.[id(902)]?.fields?.['/nominal']).toBe(
      'span / 2',
    );
    expect(store.history().past).toHaveLength(1);
    store.undo();
    expect((annotation(store.getDoc(), 902) as { nominal: string }).nominal).toBe('width / 4');
  });
});

describe('raw patches', () => {
  it('prune the overrides of annotations a patch deletes', () => {
    const { store, run } = setup((doc) => {
      part(doc).configurations = [
        { id: CFG, name: 'L', annotations: { [id(906)]: { suppressed: true } } },
      ];
    });
    const idx = (part(store.getDoc()).annotations ?? []).findIndex((a) => a.id === id(906));
    run({ kind: 'patch', ops: [{ op: 'remove', path: `/parts/0/annotations/${idx}` }] });
    expect(part(store.getDoc()).configurations?.[0]).toEqual({ id: CFG, name: 'L' });
  });
});

describe('addPart', () => {
  it('validates and sorts the annotations it brings', () => {
    const { store, run, fail } = setup();
    const p = {
      id: id(800),
      name: 'P',
      features: [],
      rollbackIndex: 0,
      annotations: [note(902 + 100), note(850)],
    };
    run({ kind: 'addPart', part: p });
    expect(store.getDoc().parts[2]?.annotations?.map((a) => a.id)).toEqual([id(850), id(1002)]);
    expect(
      fail({ kind: 'addPart', part: { ...p, id: id(801), annotations: [note(900)] } }),
    ).toMatch(/already in use/);
    expect(
      fail({
        kind: 'addPart',
        part: { ...p, id: id(802), annotations: [{ ...note(860), text: 1 } as never] },
      }),
    ).toMatch(/Invalid annotation/);
  });
});
