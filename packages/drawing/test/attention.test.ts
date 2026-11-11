import type {
  Annotation,
  AnnotationIssue,
  AnnotationResolution,
  Drawing,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  type AttentionInput,
  aggregateAttention,
  searchAttention,
  viewConfiguration,
} from '../src/attention';
import { layoutView, type PlacedAnnotation } from '../src/placement';
import { generateTemplate, type TemplateLayout } from '../src/template';
import { type SolvedView, solveViews } from '../src/view';
import { ANNOTATIONS, drawing, evalLength, evaluate, PART_BOUNDS, resolutions } from './fixtures';

/** Mock of packages/document `annotationIssues` (the document agent writes the real one). */
function mockIssues(map: Record<string, AnnotationIssue[]>) {
  return (a: Annotation) => map[a.id] ?? [];
}

function setup(d: Drawing, res: AnnotationResolution[]) {
  const views = solveViews({ drawing: d, bounds: PART_BOUNDS, evaluate });
  const annotations = new Map(ANNOTATIONS.map((a) => [a.id, a]));
  const rmap = new Map(res.map((r) => [r.annotationId, r]));
  const placed: PlacedAnnotation[] = [];
  for (const v of views.values()) {
    if (!v.ok) continue;
    placed.push(
      ...layoutView(
        d.placements.filter((p) => p.viewId === v.view.id),
        {
          view: v as SolvedView,
          style: d.style,
          standard: d.standard.gps,
          evaluate: (e) => evalLength(e),
          annotations,
          resolutions: rmap,
        },
      ),
    );
  }
  const t = generateTemplate(d.sheets[0]!.format, d.template);
  const templates = new Map<string, TemplateLayout>(t.ok ? [['S1', t.layout]] : []);
  return { views, placed, templates, rmap };
}

describe('needs-attention aggregation', () => {
  const placements: Drawing['placements'] = [
    { id: 'p1', viewId: 'V1', annotationId: 'A1', layout: { kind: 'lane', side: 'top', lane: 0 } },
    {
      id: 'p2',
      viewId: 'V1',
      annotationId: 'A2',
      layout: { kind: 'lane', side: 'right', lane: 0 },
    },
    {
      id: 'p3',
      viewId: 'V2',
      annotationId: 'A3',
      layout: { kind: 'radial', angle: 45, distance: 7 },
    },
    { id: 'p4', viewId: 'V3', annotationId: 'A1', layout: { kind: 'offset', distance: 10 } },
    {
      id: 'p5',
      viewId: 'V2',
      annotationId: 'A5',
      layout: { kind: 'leader', attach: { kind: 'ref', index: 0 }, text: [20, 20] },
    },
  ];

  function run(
    over: Partial<AttentionInput> = {},
    res = resolutions(),
    d = drawing({ placements }),
  ) {
    const s = setup(d, res);
    return aggregateAttention({
      drawing: d,
      annotations: ANNOTATIONS,
      configurationIds: new Set(['C1']),
      views: s.views,
      resolutions: () => s.rmap,
      annotationIssues: mockIssues({}),
      placed: s.placed,
      templates: s.templates,
      ...over,
    });
  }

  it('merges resolutions, semantic issues and placement checks, with zones', () => {
    const res = resolutions().map((r) =>
      r.annotationId === 'A2'
        ? {
            annotationId: 'A2',
            state: 'needsAttention' as const,
            unresolved: [
              {
                path: '/refs/1',
                ref: { name: 'F1:face.zmax', kind: 'face' as const },
                reason: 'missing' as const,
              },
            ],
            cause: { featureId: 'F1', kind: 'changed' as const, detail: 'height 40 → 30 mm' },
            anchors: [null, null],
          }
        : r,
    );
    const entries = run(
      {
        annotationIssues: mockIssues({
          A3: [{ kind: 'valueMismatch', shown: 20, measured: 19.5 }],
          A5: [
            { kind: 'standardMismatch', annotation: 'ASME Y14.5-2018', drawing: 'ISO 1101:2017' },
          ],
        }),
      },
      res,
    );
    const keys = entries.map((e) => e.key);
    // A1 seen end-on in the right view: a placement check.
    const endOn = entries.find((e) => e.key === 'placement:p4:issue:0');
    expect(endOn).toMatchObject({
      severity: 'attention',
      issue: { kind: 'notMeasurableInView', viewId: 'V3' },
    });
    // A2's unresolved ref, with its upstream cause and a grid zone.
    const a2 = entries.find((e) => e.key === 'placement:p2:resolution');
    expect(a2).toMatchObject({ severity: 'attention', cause: { featureId: 'F1' }, sheetId: 'S1' });
    expect(a2?.zone).toMatch(/^[A-F][1-8]$/);
    expect(a2?.message).toBe('Linear dimension: a reference no longer resolves');
    // Semantic issues from the document package.
    expect(entries.find((e) => e.issue?.kind === 'valueMismatch')?.severity).toBe('attention');
    expect(entries.find((e) => e.issue?.kind === 'standardMismatch')?.severity).toBe('warning');
    // A1 is placed twice (front and right views).
    expect(keys).toContain('annotation:A1:placedTwice');
    // Attention first, then warnings.
    const sev = entries.map((e) => e.severity);
    expect(sev.indexOf('warning')).toBeGreaterThan(sev.lastIndexOf('attention'));
  });
  it('lists suppressed annotations quietly as "not in this configuration"', () => {
    const res = resolutions().map((r) =>
      r.annotationId === 'A3' ? { annotationId: 'A3', state: 'suppressed' as const } : r,
    );
    const e = run({}, res).find((x) => x.key === 'placement:p3:suppressed');
    expect(e).toMatchObject({
      severity: 'info',
      message: 'Diameter dimension: not in this configuration',
    });
  });
  it('flags a missing configuration and a missing part, never falling back (T13)', () => {
    const d = drawing({ placements, configurationId: 'GONE' });
    d.views[1]!.configurationId = 'ALSO_GONE';
    d.views[2]!.configurationId = 'C1';
    const entries = run({ annotations: undefined }, resolutions(), d);
    const keys = entries.map((x) => x.key);
    expect(keys).toContain('drawing:subject');
    expect(keys).toContain('drawing:configuration');
    expect(keys).toContain('view:V2:configuration');
    expect(entries.find((x) => x.key === 'view:V3:configurationDiffers')?.severity).toBe('warning');
    expect(viewConfiguration(d, d.views[0]!)).toBe('GONE');
    expect(viewConfiguration(d, { ...d.views[0]!, configurationId: null })).toBeNull();
  });
  it('reports view problems', () => {
    const d = drawing({ placements: [] });
    d.views.push({
      id: 'V9',
      sheetId: 'S1',
      kind: 'projected',
      parentId: 'nope',
      from: 'top',
      layout: { kind: 'aligned', distance: 10 },
    });
    const e = run({}, resolutions(), d).find((x) => x.key === 'view:V9:0');
    expect(e?.message).toBe('The view this one projects from no longer exists');
  });
  it('searches messages and zones', () => {
    const entries = run();
    expect(searchAttention(entries, 'end-on').length).toBe(1);
    expect(searchAttention(entries, '').length).toBe(entries.length);
  });
});
