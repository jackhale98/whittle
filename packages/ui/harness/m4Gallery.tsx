import type {
  Annotation,
  AnnotationPlacement,
  AnnotationResolution,
  Drawing,
  EvalResult,
  ViewDisplay,
  ViewProjection,
} from '@wren-cad/contracts';
import { buildDrawing } from '@wren-cad/drawing';
import { type SvgNode, svgItems, svgModel } from '@wren-cad/drawing/svg';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { solveViews } from '../../drawing/src';
import {
  ANNOTATIONS,
  boxProjection,
  evalLength,
  evaluate,
  drawing as fixtureDrawing,
  PART_BOUNDS,
  resolutions,
} from '../../drawing/test/fixtures';
import {
  AnnotationInspector,
  type AnnotationInspectorProps,
  AttentionPanel,
  DrawingExportPanel,
  DrawingList,
  DrawingShell,
  DrawingToolbar,
  type DrawingToolId,
  ImportPanel,
  InlineCellEditor,
  SheetSettings,
  SheetViewer,
  type SheetViewerApi,
  StandardChoice,
  TitleBlockEditor,
  ToleranceField,
  ViewInspector,
  type ViewInspectorProps,
  ViewPicker,
  ViewsPanel,
} from '../src/drawing';

/**
 * M4 gallery: every state of every drawing component, rendered from the same data the app uses
 * (the sample sheet is composed by the drawing package from a mocked part, not drawn by hand).
 * `?section=m4-<name>&state=<state>`.
 */

const q = () => new URLSearchParams(window.location.search);
const state = () => q().get('state') ?? 'default';
const touch = () => window.innerWidth < 900;
const size = () => (touch() ? 'touch' : 'md');

const evalOk = (e: string): EvalResult => {
  const n = Number.parseFloat(e);
  return Number.isNaN(n)
    ? { ok: false, error: { message: 'Not a number' } }
    : { ok: true, value: n, dimension: [0, 0, 0, 0], dependsOn: [] };
};

const display: ViewDisplay = {
  lines: 'visible',
  tangentEdges: 'off',
  centerMarks: true,
  centerLines: true,
  threads: true,
};

/** The bracket sheet, composed by the drawing package from mocked kernel results. */
function sampleSheet(opts: { attention?: boolean; pending?: boolean } = {}) {
  const d: Drawing = fixtureDrawing({
    placements: [
      {
        id: 'p1',
        viewId: 'V1',
        annotationId: 'A1',
        layout: { kind: 'lane', side: 'bottom', lane: 0 },
      },
      {
        id: 'p2',
        viewId: 'V1',
        annotationId: 'A2',
        layout: { kind: 'lane', side: 'left', lane: 0 },
      },
      {
        id: 'p3',
        viewId: 'V2',
        annotationId: 'A3',
        layout: { kind: 'radial', angle: 45, distance: 7 },
      },
      {
        id: 'p4',
        viewId: 'V1',
        annotationId: 'A4',
        layout: { kind: 'leader', attach: { kind: 'ref', index: 0, t: 0.8 }, text: [0, -12] },
      },
    ],
    notes: [
      {
        id: 'n1',
        sheetId: 'S1',
        position: [30, 60],
        text: 'MATERIAL {material}\nBREAK ALL SHARP EDGES',
      },
    ],
  });
  const views = solveViews({ drawing: d, bounds: PART_BOUNDS, evaluate });
  const projections = new Map<string, ViewProjection>();
  for (const [id, v] of views) if (v.ok) projections.set(id, boxProjection(v));
  const res = new Map<string, AnnotationResolution>(resolutions().map((r) => [r.annotationId, r]));
  if (opts.attention) {
    // The bore's reference is gone: its diameter shows as needs attention, with no value.
    const { value: _v, anchors: _a, ...rest } = res.get('A3') as AnnotationResolution;
    res.set('A3', {
      ...rest,
      state: 'needsAttention',
      unresolved: [{ path: '/refs/0', ref: { name: 'F2:bore', kind: 'face' }, reason: 'missing' }],
      cause: { kind: 'deleted', featureId: 'F2' },
    } as unknown as AnnotationResolution);
  }
  const built = buildDrawing({
    drawing: d,
    annotations: ANNOTATIONS as Annotation[],
    configurationIds: new Set(),
    bounds: PART_BOUNDS,
    evaluate,
    evaluateAnnotation: (e) => evalLength(e),
    projections,
    resolutions: () => res,
    annotationIssues: () => [],
    titleBlock: (s, index, count) => ({
      title: 'Bracket',
      partNumber: 'BRK-001',
      material: 'AlMg3',
      mass: 152.4,
      scale: evaluate(s.scale, 'ratio') ?? 1,
      projection: d.projection,
      units: 'mm',
      standard: d.standard,
      sheet: { index, count },
      date: '2026-11-11',
    }),
    fitDeviations: (c) => (c === 'H7' ? { upper: 0.021, lower: 0 } : undefined),
  });
  const list = (built.sheets[0] as (typeof built.sheets)[number]).list;
  return {
    model: svgModel(list, d.style, { paper: 'none' }),
    w: list.width,
    h: list.height,
    attention: built.attention,
    style: d.style,
    /** One placement laid out again, as a drag preview does (ADR-094). */
    relayout: built.relayout,
    placed: built.placed,
  };
}

const dim: Annotation = {
  id: 'A1',
  kind: 'linear',
  origin: { kind: 'drawing', drawingId: 'D1' },
  refs: [
    { name: 'e1', kind: 'edge' },
    { name: 'e2', kind: 'edge' },
  ],
};
const placement: AnnotationPlacement = {
  id: 'P1',
  viewId: 'V1',
  annotationId: 'A1',
  layout: { kind: 'lane', side: 'bottom', lane: 0 },
};
const inspectorProps = (
  over: Partial<AnnotationInspectorProps> = {},
): AnnotationInspectorProps => ({
  annotation: dim,
  placement,
  valueText: '100 mm',
  state: 'ok',
  problems: [],
  evaluate: evalOk,
  datums: [{ id: 'D1', label: 'A' }],
  characteristics: [
    { value: 'flatness' },
    { value: 'perpendicularity' },
    { value: 'position' },
    { value: 'concentricity', refusal: 'ASME Y14.5-2018 has no concentricity' },
  ],
  datumLabelProblem: (l) => (l === 'I' ? 'I, O and Q are not used as datum letters' : undefined),
  onChange: () => {},
  onPlacement: () => {},
  onRemoveFromView: () => {},
  onDelete: () => {},
  size: size(),
  ...over,
});

const panelCard = 'w-[22rem] max-w-full overflow-hidden rounded-panel bg-surface shadow-pop';

function Frame({ id, children, wide }: { id: string; children: ReactNode; wide?: boolean }) {
  return (
    <div
      data-testid={id}
      className={wide ? 'w-full max-w-5xl p-3' : `${panelCard} m-3`}
      style={wide ? undefined : { width: touch() ? 'min(22rem, calc(100vw - 24px))' : undefined }}
    >
      {children}
    </div>
  );
}

function Choice() {
  const s = state();
  return (
    <div className="p-3" data-testid="g-m4-choice">
      <StandardChoice
        size={size()}
        partName="Bracket"
        {...(s === 'chosen'
          ? { value: { family: 'iso' as const, projection: 'first' as const } }
          : {})}
        {...(s === 'asme'
          ? { value: { family: 'asme' as const, projection: 'third' as const } }
          : {})}
        onConfirm={() => {}}
      />
    </div>
  );
}

/** The drag preview states of the viewer (ADR-094): what the sheet shows while something is dragged. */
function useDragPreview(
  ref: React.RefObject<SheetViewerApi | null>,
  s: string,
  sheet: ReturnType<typeof sampleSheet>,
) {
  useEffect(() => {
    const v = ref.current;
    if (!v || !s.startsWith('drag-')) return;
    const accent = 'var(--color-accent)';
    if (s === 'drag-view') {
      // A view, with its dimensions and selection, translated as one under the pointer.
      v.transient({ move: { hosts: ['V1'] } }).update({ dx: 24, dy: -10 });
      return;
    }
    if (s === 'drag-dimension') {
      // A dimension's text dragged below its line, snapping to "below" with its hint.
      const p = sheet.placed.find((x) => x.placementId === 'p1');
      const next = sheet.relayout({
        id: 'p1',
        viewId: 'V1',
        annotationId: 'A1',
        layout: { kind: 'lane', side: 'bottom', lane: 0 },
        text: { shift: 14, side: 'below' },
      });
      const line = p?.line;
      if (!next || !line) return;
      const mm = 0.4;
      const dash = (o: number, on: boolean): SvgNode => ({
        tag: 'line',
        attrs: {
          x1: String(line[0][0] - 6),
          y1: String(line[0][1] + o),
          x2: String(line[1][0] + 6),
          y2: String(line[1][1] + o),
          stroke: accent,
          'stroke-width': String((on ? 2 : 1) * mm),
          'stroke-opacity': on ? '1' : '0.45',
          ...(on ? {} : { 'stroke-dasharray': `${4 * mm} ${4 * mm}` }),
        },
      });
      v.transient({ hide: ['placement:p1'] }).update({
        nodes: [
          {
            tag: 'g',
            attrs: { 'data-selected': 'true' },
            children: svgItems(next.items, sheet.style),
          },
        ],
        overlay: [
          dash(3.2, false),
          dash(0, false),
          dash(-3.2, true),
          {
            tag: 'text',
            attrs: {
              transform: `translate(${line[0][0] + 30} ${line[0][1] - 14}) scale(1 -1)`,
              'font-size': String(12 * mm),
              fill: accent,
              stroke: 'none',
            },
            children: ['Below the line'],
          },
        ],
      });
      return;
    }
    // drag-detail: a detail circle resized, with its two grips.
    const c: [number, number] = [150, 150];
    const ring = (at: [number, number], r: number, fill: string): SvgNode => ({
      tag: 'circle',
      attrs: {
        cx: String(at[0]),
        cy: String(at[1]),
        r: String(r),
        fill,
        stroke: accent,
        'stroke-width': '0.5',
      },
    });
    v.transient({ hide: [] }).update({
      nodes: [{ tag: 'g', attrs: { 'data-selected': 'true' }, children: [ring(c, 22, 'none')] }],
      overlay: [
        ring([c[0] + 22, c[1]], 3.6, 'var(--color-surface)'),
        ring(c, 3.6, 'var(--color-surface)'),
      ],
    });
  }, [ref, s, sheet]);
}

function Viewer() {
  const s = state();
  const sheet = useMemo(() => sampleSheet({ attention: s === 'attention' }), [s]);
  const ref = useRef<SheetViewerApi>(null);
  useDragPreview(ref, s, sheet);
  return (
    <div className="h-[520px] w-full max-w-4xl p-3" data-testid="g-m4-viewer">
      <SheetViewer
        ref={ref}
        model={sheet.model}
        sheet={{ w: sheet.w, h: sheet.h }}
        fitKey={`g-${s}`}
        label="Sheet 1 of Bracket drawing: 5 views, 4 annotations"
        selected={
          s === 'selected' || s === 'drag-view' ? new Set(['view:V1', 'placement:p1']) : new Set()
        }
        hover={s === 'hover' ? 'view:V2' : null}
        pending={s === 'pending'}
      />
    </div>
  );
}

function Toolbar() {
  const s = state();
  const [active, setActive] = useState<DrawingToolId>(s === 'dimension' ? 'dimension' : 'select');
  const orientation = s === 'horizontal' || touch() ? 'horizontal' : 'vertical';
  return (
    <div className="p-3" data-testid="g-m4-toolbar">
      <div className="inline-block rounded-panel bg-surface shadow-pop">
        <DrawingToolbar
          active={active}
          onTool={setActive}
          orientation={orientation}
          size={size()}
          {...(s === 'disabled'
            ? {
                disabled: {
                  section: 'Add a view first',
                  detail: 'Add a view first',
                  dimension: 'Add a view first',
                },
              }
            : {})}
        />
      </div>
    </div>
  );
}

function Views() {
  const s = state();
  const rows =
    s === 'empty'
      ? []
      : [
          { id: 'a', name: 'Front view', depth: 0, kind: 'base' as const, scale: '1:2' },
          { id: 'b', name: 'Top view', depth: 1, kind: 'projected' as const, scale: '1:2' },
          {
            id: 'c',
            name: 'Right view',
            depth: 1,
            kind: 'projected' as const,
            scale: '1:2',
            configuration: { name: 'Long' },
          },
          { id: 'd', name: 'Section A–A', depth: 1, kind: 'section' as const, scale: '1:2' },
          ...(s === 'problem'
            ? [
                {
                  id: 'e',
                  name: 'Detail B',
                  depth: 1,
                  kind: 'detail' as const,
                  scale: '',
                  problem: 'The detail circle is outside its view',
                },
              ]
            : [
                {
                  id: 'e',
                  name: 'Isometric view',
                  depth: 1,
                  kind: 'iso' as const,
                  scale: '1:2',
                  configuration: { name: 'Missing configuration', missing: true },
                },
              ]),
        ];
  return (
    <Frame id="g-m4-views">
      <ViewsPanel
        views={rows}
        selectedId={s === 'selected' ? 'b' : null}
        onSelect={() => {}}
        onAddBase={() => {}}
        onAddIso={() => {}}
        onAddStandard={() => {}}
        canAddDerived={s !== 'empty'}
        reviewOnly={s === 'review'}
        size={size()}
      />
    </Frame>
  );
}

function ViewInsp() {
  const s = state();
  const base: ViewInspectorProps = {
    kind: 'projected',
    title: 'Top view',
    parentName: 'Front view',
    scale: '',
    inheritedScale: '1:2',
    evaluateScale: evalOk,
    onScale: () => {},
    label: '',
    derivedLabel: '',
    showLabel: false,
    onLabel: () => {},
    onShowLabel: () => {},
    display,
    onDisplay: () => {},
    configuration: {
      value: undefined,
      options: [
        { id: null, name: 'Default' },
        { id: 'c1', name: 'Long' },
      ],
      drawingName: 'Default',
    },
    onConfiguration: () => {},
    distance: 90,
    onDistance: () => {},
    dependents: 0,
    onDelete: () => {},
    evaluate: evalOk,
    size: size(),
  };
  const over: Partial<ViewInspectorProps> =
    s === 'own-scale'
      ? { scale: '1/4' }
      : s === 'section'
        ? {
            kind: 'section',
            title: 'Section A–A',
            label: '',
            derivedLabel: 'A–A',
            showLabel: true,
            section: {
              letter: 'A',
              look: 'right',
              depth: 'full',
              aligned: false,
              onLetter: () => {},
              onFlip: () => {},
              onDepth: () => {},
            },
            position: { x: 330, y: 200 },
            onPosition: () => {},
          }
        : s === 'detail' || s === 'detail-center'
          ? {
              kind: 'detail',
              title: 'Detail B',
              derivedLabel: 'B (2:1)',
              showLabel: true,
              scale: '2',
              detail: {
                letter: 'B',
                radius: 8,
                onRadius: () => {},
                onLetter: () => {},
                ...(s === 'detail-center'
                  ? { center: { x: 42.5, y: 18 }, onCenter: () => {} }
                  : {}),
              },
              position: { x: 330, y: 125 },
              onPosition: () => {},
            }
          : s === 'config'
            ? {
                configuration: {
                  value: 'c1',
                  options: [
                    { id: null, name: 'Default' },
                    { id: 'c1', name: 'Long' },
                  ],
                  drawingName: 'Default',
                },
              }
            : s === 'missing'
              ? {
                  configuration: {
                    value: 'gone',
                    options: [{ id: null, name: 'Default' }],
                    drawingName: 'Default',
                    missing: true,
                  },
                }
              : s === 'dependents'
                ? { dependents: 2, onDetachAndDelete: () => {} }
                : {};
  const { distance, onDistance, ...rest } = base;
  const props = {
    ...rest,
    ...(over.position ? {} : { distance, onDistance }),
    ...over,
  } as ViewInspectorProps;
  return (
    <Frame id="g-m4-view-inspector">
      <ViewInspector {...props} />
    </Frame>
  );
}

function AnnotationInsp() {
  const s = state();
  const frame: Annotation = {
    id: 'G1',
    kind: 'geometricTolerance',
    origin: { kind: 'drawing', drawingId: 'D1' },
    refs: [{ name: 'e1', kind: 'edge' }],
    characteristic: 'perpendicularity',
    zone: { value: '0.05 mm', shape: 'diameter' },
    datums: [{ datums: [{ datum: 'D1' }] }],
  };
  const datum: Annotation = {
    id: 'D1',
    kind: 'datumFeature',
    origin: { kind: 'drawing', drawingId: 'D1' },
    refs: [{ name: 'e1', kind: 'edge' }],
    label: s === 'datum-bad' ? 'I' : 'A',
  };
  const finish: Annotation = {
    id: 'F1',
    kind: 'surfaceFinish',
    origin: { kind: 'drawing', drawingId: 'D1' },
    refs: [{ name: 'e1', kind: 'edge' }],
    process: 'removalRequired',
    requirements: [{ parameter: 'Ra', value: '1.6 um' }],
    method: 'ground',
  };
  const note: Annotation = {
    id: 'N1',
    kind: 'note',
    origin: { kind: 'drawing', drawingId: 'D1' },
    refs: [{ name: 'e1', kind: 'edge' }],
    text: 'BREAK ALL SHARP EDGES',
  };
  const hole: Annotation = {
    id: 'H1',
    kind: 'holeCallout',
    origin: { kind: 'model' },
    refs: [],
    source: { kind: 'feature', featureId: 'F' },
  };
  const props: Partial<AnnotationInspectorProps> =
    s === 'readonly'
      ? {
          annotation: {
            ...dim,
            origin: { kind: 'model' },
            source: { kind: 'sketchDimension', featureId: 'S', constraintId: 'd1' },
          } as Annotation,
          sourceText:
            'Driven by Plate sketch: width. Change it there: a dimension on a drawing never drives the model.',
          readOnlyReason: 'The value is read from the model.',
        }
      : s === 'attention'
        ? {
            state: 'needsAttention',
            valueText: undefined,
            problems: ['A reference no longer resolves: Hole sketch was deleted'],
            onReattach: () => {},
          }
        : s === 'tolerance'
          ? {
              annotation: {
                ...dim,
                tolerance: { kind: 'bilateral', upper: '0.1 mm', lower: '-0.05 mm' },
                text: { prefix: '2×' },
              } as Annotation,
            }
          : s === 'frame'
            ? { annotation: frame, valueText: undefined }
            : s === 'datum' || s === 'datum-bad'
              ? { annotation: datum, valueText: undefined }
              : s === 'finish'
                ? { annotation: finish, valueText: undefined }
                : s === 'note'
                  ? { annotation: note, valueText: undefined }
                  : s === 'hole'
                    ? {
                        annotation: hole,
                        valueText: undefined,
                        sourceText: 'Driven by Holes: M6 clearance.',
                      }
                    : s === 'suppressed'
                      ? { state: 'suppressed', valueText: undefined }
                      : s === 'text-moved'
                        ? { placement: { ...placement, text: { shift: 6, side: 'below' } } }
                        : s === 'radial'
                          ? {
                              annotation: { ...dim, kind: 'diameter' } as Annotation,
                              placement: {
                                ...placement,
                                layout: { kind: 'radial', angle: 45, distance: 6 },
                              },
                            }
                          : {};
  return (
    <Frame id="g-m4-annotation">
      <AnnotationInspector {...inspectorProps(props)} />
    </Frame>
  );
}

function Tolerance() {
  const s = state();
  return (
    <Frame id="g-m4-tolerance">
      <div className="p-4">
        <ToleranceField
          size={size()}
          value={
            s === 'stored'
              ? { kind: 'symmetric', value: '0.1 mm' }
              : s === 'fit'
                ? { kind: 'fit', hole: 'H7', shaft: 'g6', show: 'symbol' }
                : undefined
          }
          onCommit={() => {}}
        />
      </div>
    </Frame>
  );
}

function TolerancePreview() {
  // States with typed drafts: the field is controlled by user input, so the gallery types for it.
  return <Tolerance />;
}

function Import() {
  const s = state();
  const [on, setOn] = useState<ReadonlySet<string>>(
    s === 'none' ? new Set() : new Set(['a', 'b', 'c']),
  );
  const rows = [
    {
      key: 'a',
      title: 'linear dimension',
      detail: 'Plate: end depth',
      kind: 'promote' as const,
      viewName: 'Front view',
    },
    {
      key: 'b',
      title: 'diameter dimension',
      detail: 'Hole sketch: diameter',
      kind: 'promote' as const,
      viewName: 'Top view',
    },
    {
      key: 'c',
      title: 'datum A',
      detail: 'Annotation of the part',
      kind: 'existing' as const,
      viewName: 'Front view',
    },
    {
      key: 'd',
      title: 'radius dimension',
      detail: 'Corner fillets',
      kind: 'promote' as const,
      reason: 'No geometry to place it on',
    },
  ];
  return (
    <Frame id="g-m4-import">
      <ImportPanel
        size={size()}
        rows={s === 'empty' ? [] : rows}
        checked={on}
        onToggle={(k, v) =>
          setOn((p) => {
            const n = new Set(p);
            if (v) n.add(k);
            else n.delete(k);
            return n;
          })
        }
        onAll={() => {}}
        alreadyPlaced={s === 'empty' ? 4 : 2}
        notPromotable={s === 'default' ? ['Sweep path length: not a dimension of the part'] : []}
        onPlace={() => {}}
        onCancel={() => {}}
      />
    </Frame>
  );
}

function Attention() {
  const s = state();
  const rows = [
    {
      key: 'k1',
      severity: 'attention' as const,
      title: 'diameter dimension',
      message: 'A reference no longer resolves: Hole sketch was deleted. No value is shown.',
      zone: 'C4',
      reattachable: true,
    },
    {
      key: 'k2',
      severity: 'attention' as const,
      title: 'Detail B',
      message: 'The detail circle is outside its view',
      zone: 'B6',
    },
    {
      key: 'k3',
      severity: 'warning' as const,
      title: 'linear dimension',
      message: 'Placed twice in this drawing',
      zone: 'C3',
    },
    {
      key: 'k4',
      severity: 'info' as const,
      title: 'linear dimension',
      message: 'Not in this configuration',
    },
    { key: 'k5', severity: 'info' as const, title: 'datum A', message: 'Placed on the front view' },
  ];
  return (
    <Frame id="g-m4-attention">
      <AttentionPanel
        size={size()}
        rows={s === 'empty' ? [] : rows}
        selectedKey={s === 'selected' ? 'k1' : null}
        onSelect={() => {}}
        onReattach={() => {}}
      />
    </Frame>
  );
}

function Title() {
  const s = state();
  const rows = [
    {
      slot: 'partNumber',
      caption: 'Identification number',
      text: s === 'override' ? 'BR-100' : 'Bracket',
      source: s === 'override' ? ('override' as const) : ('bound' as const),
      ...(s === 'override' ? { bound: 'Bracket' } : {}),
    },
    { slot: 'material', caption: 'Material', text: 'AlMg3', source: 'bound' as const },
    { slot: 'mass', caption: 'Mass', text: '152.4 g', source: 'bound' as const },
    {
      slot: 'owner',
      caption: 'Legal owner',
      text: s === 'empty' ? '' : 'ACME Ltd',
      source: s === 'empty' ? ('empty' as const) : ('text' as const),
    },
    {
      slot: 'partNumber2',
      caption: 'Technical reference',
      text: 'a very long part number that goes on',
      source: 'bound' as const,
      warnings:
        s === 'warning' ? ['ISO 7200: the identification number is longer than 16 characters'] : [],
    },
  ];
  return (
    <Frame id="g-m4-title">
      {s === 'inline' ? (
        <div className="relative h-56">
          <InlineCellEditor
            caption="Identification number"
            value="Bracket"
            bound="Bracket"
            onCommit={() => {}}
            onCancel={() => {}}
            box={{ x: 16, y: 16, width: 200, height: 24 }}
          />
        </div>
      ) : (
        <TitleBlockEditor
          rows={rows}
          size={size()}
          {...(s === 'unused' ? { unused: [{ slot: 'language', text: 'en' }] } : {})}
          onEdit={() => {}}
        />
      )}
    </Frame>
  );
}

function List() {
  const s = state();
  const items =
    s === 'empty'
      ? []
      : [
          { id: 'd1', name: 'Bracket drawing', summary: 'ISO · first angle · 1 sheet' },
          {
            id: 'd2',
            name: 'Bracket, long variant',
            summary: 'ASME · third angle · 2 sheets',
            attention: s === 'attention' ? 3 : 0,
          },
        ];
  return (
    <Frame id="g-m4-list">
      <div className="p-4">
        <DrawingList
          drawings={items}
          size={size()}
          reviewOnly={s === 'review'}
          {...(s === 'disabled' ? { newDisabled: 'Add a part first' } : {})}
          onOpen={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
          onNew={() => {}}
        />
      </div>
    </Frame>
  );
}

function Export() {
  const s = state();
  return (
    <Frame id="g-m4-export">
      <DrawingExportPanel
        size={size()}
        sheetName="Sheet 1"
        sheetCount={s === 'sheets' ? 3 : 1}
        busy={s === 'busy' ? 'pdf' : null}
        attentionCount={s === 'attention' ? 2 : 0}
        {...(s === 'unavailable'
          ? { unavailable: 'The model is updating. Export is available in a moment.' }
          : {})}
        onExport={() => {}}
      />
    </Frame>
  );
}

function Settings() {
  const s = state();
  return (
    <Frame id="g-m4-settings">
      <SheetSettings
        size={size()}
        drawingName="Bracket drawing"
        onRename={() => {}}
        family={s === 'asme' ? 'asme' : 'iso'}
        gps={s === 'asme' ? 'ASME Y14.5-2018' : 'ISO 1101:2017'}
        surfaceFinish={s === 'asme' ? 'ASME Y14.36-2018' : 'ISO 21920-1:2021'}
        generalTolerance={s === 'asme' ? '' : 'ISO 2768-mK'}
        onGeneralTolerance={() => {}}
        projection={s === 'third' ? 'third' : 'first'}
        onProjection={() => {}}
        sheet={{
          id: 's',
          name: 'Sheet 1',
          format: { size: s === 'asme' ? 'ANSI-B' : 'A3', orientation: 'landscape' },
          scale: '1/2',
        }}
        sheets={
          s === 'sheets'
            ? [
                { id: 's', name: 'Sheet 1' },
                { id: 't', name: 'Sheet 2' },
              ]
            : [{ id: 's', name: 'Sheet 1' }]
        }
        onFormat={() => {}}
        onSheetScale={() => {}}
        evaluateScale={evalOk}
        onAddSheet={() => {}}
        onRemoveSheet={() => {}}
        template={{ id: 'iso-5457', version: 1, latest: s === 'outdated' ? 2 : 1 }}
        onReapplyTemplate={() => {}}
        configuration={
          s === 'missing'
            ? { value: 'gone', options: [{ id: null, name: 'Default' }], missing: true }
            : {
                value: s === 'config' ? 'c1' : null,
                options: [
                  { id: null, name: 'Default' },
                  { id: 'c1', name: 'Long' },
                ],
              }
        }
        onConfiguration={() => {}}
      />
    </Frame>
  );
}

function Shell() {
  const s = state();
  const tier = (q().get('shell') ?? 'desktop') as 'desktop' | 'tablet' | 'phone';
  const sheet = useMemo(() => sampleSheet({ attention: s === 'attention' }), [s]);
  const [panel, setPanel] = useState(s === 'attention' ? 'attention' : 'views');
  return (
    <div className="h-dvh w-full" data-testid="g-m4-shell">
      <DrawingShell
        tier={tier}
        title="Bracket drawing"
        onBack={() => {}}
        sheets={
          s === 'sheets'
            ? [
                { id: 's1', name: 'Sheet 1' },
                { id: 's2', name: 'Sheet 2' },
              ]
            : [{ id: 's1', name: 'Sheet 1' }]
        }
        sheetId="s1"
        onSheet={() => {}}
        {...(tier === 'phone' ? {} : { onUndo: () => {}, onRedo: () => {} })}
        actions={
          <span className="rounded-full bg-warning-soft px-2 py-0.5 text-2xs font-medium text-warning-text">
            Approximate edges
          </span>
        }
        {...(tier === 'phone'
          ? {}
          : {
              tools: (
                <DrawingToolbar
                  active="select"
                  onTool={() => {}}
                  orientation={tier === 'desktop' ? 'vertical' : 'horizontal'}
                  size={tier === 'desktop' ? 'md' : 'touch'}
                />
              ),
            })}
        canvas={
          <SheetViewer
            model={sheet.model}
            sheet={{ w: sheet.w, h: sheet.h }}
            fitKey={`shell-${tier}`}
            label="Sheet 1 of Bracket drawing"
          />
        }
        panels={[
          ...(tier === 'phone'
            ? []
            : [
                {
                  id: 'inspector',
                  label: 'Inspector',
                  content: (
                    <p className="px-4 text-xs text-fg-muted">
                      Select a view or an annotation to edit it.
                    </p>
                  ),
                },
              ]),
          {
            id: 'views',
            label: 'Views',
            content: (
              <ViewsPanel
                views={[
                  { id: 'a', name: 'Front view', depth: 0, kind: 'base', scale: '1:2' },
                  { id: 'b', name: 'Top view', depth: 1, kind: 'projected', scale: '1:2' },
                ]}
                onSelect={() => {}}
                onAddBase={() => {}}
                onAddIso={() => {}}
                onAddStandard={() => {}}
                canAddDerived
                reviewOnly={tier === 'phone'}
                size={tier === 'desktop' ? 'md' : 'touch'}
              />
            ),
          },
          {
            id: 'attention',
            label: 'Attention',
            badge: sheet.attention.length,
            tone: 'danger',
            content: (
              <AttentionPanel
                rows={sheet.attention.map((e) => ({
                  key: e.key,
                  severity: e.severity,
                  message: e.message,
                  ...(e.zone ? { zone: e.zone } : {}),
                }))}
                onSelect={() => {}}
                onReattach={() => {}}
                size={tier === 'desktop' ? 'md' : 'touch'}
              />
            ),
          },
        ]}
        panel={panel}
        onPanel={setPanel}
      />
    </div>
  );
}

export function M4Gallery({ section }: { section: string }) {
  switch (section) {
    case 'm4-choice':
      return <Choice />;
    case 'm4-viewer':
      return <Viewer />;
    case 'm4-toolbar':
      return <Toolbar />;
    case 'm4-picker':
      return (
        <Frame id="g-m4-picker">
          <div className="p-4">
            <ViewPicker
              onPick={() => {}}
              size={size()}
              {...(state() === 'disabled' ? { disabledReason: 'Nothing to draw yet' } : {})}
            />
          </div>
        </Frame>
      );
    case 'm4-views':
      return <Views />;
    case 'm4-view-inspector':
      return <ViewInsp />;
    case 'm4-annotation':
      return <AnnotationInsp />;
    case 'm4-tolerance':
      return <TolerancePreview />;
    case 'm4-import':
      return <Import />;
    case 'm4-attention':
      return <Attention />;
    case 'm4-title':
      return <Title />;
    case 'm4-list':
      return <List />;
    case 'm4-export':
      return <Export />;
    case 'm4-settings':
      return <Settings />;
    case 'm4-shell':
      return <Shell />;
    default:
      return null;
  }
}
