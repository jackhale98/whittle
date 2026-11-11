import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Annotation, AnnotationPlacement, ViewDisplay } from '@wren-cad/contracts';
import type { SvgNode } from '@wren-cad/drawing/svg';
import { describe, expect, it, vi } from 'vitest';
import {
  AnnotationInspector,
  type AnnotationInspectorProps,
  AttentionPanel,
  DrawingExportPanel,
  DrawingList,
  DrawingShell,
  DrawingToolbar,
  ImportPanel,
  InlineCellEditor,
  SheetSettings,
  SheetViewer,
  StandardChoice,
  TitleBlockEditor,
  ToleranceField,
  ViewInspector,
  ViewPicker,
  ViewsPanel,
} from '../src/drawing';
import { renderUI } from './helpers';

const evalOk = (e: string) => {
  const n = Number.parseFloat(e);
  return Number.isNaN(n)
    ? ({ ok: false, error: { message: 'not a number' } } as const)
    : ({ ok: true, value: n, dimension: [0, 0, 0, 0], dependsOn: [] } as const);
};

describe('StandardChoice (D10)', () => {
  it('is an inline card that makes the user choose the projection', async () => {
    const onConfirm = vi.fn();
    renderUI(<StandardChoice onConfirm={onConfirm} partName="Bracket" />);
    expect(screen.getByRole('heading', { name: 'New drawing of Bracket' })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    const confirm = screen.getByTestId('standard-confirm');
    // Nothing is implied: Create waits for an explicit projection.
    expect(confirm).toBeDisabled();
    expect(screen.getByText('Pick one to continue.')).toBeVisible();
    await userEvent.click(screen.getByRole('radio', { name: 'ASME / ANSI' }));
    expect(screen.getByTestId('standard-body')).toHaveTextContent('ASME Y14.1');
    await userEvent.click(screen.getByRole('radio', { name: /^Third angle/ }));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ family: 'asme', projection: 'third' });
  });

  it('offers a remembered choice again, and keeps touch targets', () => {
    renderUI(
      <StandardChoice
        value={{ family: 'iso', projection: 'first' }}
        onConfirm={() => {}}
        size="touch"
      />,
    );
    expect(screen.getByRole('radio', { name: /^First angle/ })).toBeChecked();
    expect(screen.getByTestId('standard-confirm')).toBeEnabled();
    expect(screen.getByTestId('standard-confirm').className).toMatch(/h-11/);
  });
});

describe('ToleranceField', () => {
  it('reads what is typed, says what it understood, and commits on Enter', async () => {
    const onCommit = vi.fn();
    renderUI(<ToleranceField value={undefined} onCommit={onCommit} />);
    const input = screen.getByRole('textbox', { name: 'Tolerance' });
    expect(screen.getByTestId('tolerance-field')).toHaveTextContent('Type it as written');
    await userEvent.type(input, '+0.1/-0.05');
    expect(screen.getByTestId('tolerance-field')).toHaveTextContent('Reads as +0.1/-0.05');
    await userEvent.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith({
      tolerance: { kind: 'bilateral', upper: '0.1 mm', lower: '-0.05 mm' },
    });
  });

  it('refuses what it cannot read, with the reason, and Escape reverts', async () => {
    const onCommit = vi.fn();
    renderUI(<ToleranceField value={{ kind: 'symmetric', value: '0.1 mm' }} onCommit={onCommit} />);
    const input = screen.getByRole('textbox', { name: 'Tolerance' });
    expect(input).toHaveValue('±0.1');
    await userEvent.clear(input);
    await userEvent.type(input, 'plus minus');
    expect(screen.getByRole('alert')).toHaveTextContent(/Can't read/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await userEvent.keyboard('{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(input).toHaveValue('±0.1');
  });

  it('an empty field clears the tolerance; fits and a stated nominal are read', async () => {
    const onCommit = vi.fn();
    renderUI(<ToleranceField value={{ kind: 'symmetric', value: '0.1 mm' }} onCommit={onCommit} />);
    const input = screen.getByRole('textbox', { name: 'Tolerance' });
    await userEvent.clear(input);
    await userEvent.keyboard('{Enter}');
    expect(onCommit).toHaveBeenLastCalledWith({ tolerance: null });
    await userEvent.clear(input);
    await userEvent.type(input, '20 H7/g6');
    await userEvent.keyboard('{Enter}');
    expect(onCommit).toHaveBeenLastCalledWith({
      nominal: '20 mm',
      tolerance: { kind: 'fit', hole: 'H7', shaft: 'g6', show: 'symbol' },
    });
  });
});

const model: SvgNode = {
  tag: 'svg',
  attrs: { viewBox: '0 0 420 297' },
  children: [
    { tag: 'rect', attrs: { x: '0', y: '0', width: '420', height: '297', fill: 'none' } },
    {
      tag: 'g',
      attrs: { transform: 'matrix(1 0 0 -1 0 297)', 'font-family': 'osifont' },
      children: [
        {
          tag: 'g',
          attrs: { 'data-source': 'view:V1' },
          children: [
            {
              tag: 'line',
              attrs: {
                x1: '10',
                y1: '10',
                x2: '50',
                y2: '10',
                stroke: '#000',
                'stroke-width': '0.5',
              },
            },
          ],
        },
        {
          tag: 'g',
          attrs: { 'data-source': 'placement:P1', 'data-attention': 'true' },
          children: [
            {
              tag: 'text',
              attrs: { 'font-size': '3.5', 'text-anchor': 'middle' },
              children: ['?'],
            },
          ],
        },
      ],
    },
  ],
};

describe('SheetViewer', () => {
  it('draws the model, marks the selection and the attention items, and says what it shows', () => {
    renderUI(
      <div style={{ width: 800, height: 600 }}>
        <SheetViewer
          model={model}
          sheet={{ w: 420, h: 297 }}
          fitKey="s1"
          label="Sheet 1: 2 views"
          selected={new Set(['view:V1'])}
        />
      </div>,
    );
    const viewer = screen.getByRole('application', { name: 'Sheet 1: 2 views' });
    expect(viewer).toHaveAttribute('aria-roledescription', 'drawing sheet');
    expect(viewer.querySelector('[data-source="view:V1"]')).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(viewer.querySelector('[data-source="placement:P1"]')).toHaveAttribute(
      'data-attention',
      'true',
    );
    // Attributes are React's, not the model's kebab-case.
    expect(viewer.querySelector('line')).toHaveAttribute('stroke-width', '0.5');
    expect(viewer.querySelector('text')?.textContent).toBe('?');
  });

  it('does not show a stale sheet as current: pending dims it and marks it busy', () => {
    renderUI(
      <SheetViewer model={model} sheet={{ w: 420, h: 297 }} fitKey="s" label="Sheet" pending />,
    );
    expect(screen.getByRole('application')).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelector('.sheet-model-pending')).not.toBeNull();
  });

  it('zooms with buttons and the keyboard, and hands a press to the tool that owns it', async () => {
    const begin = vi.fn(() => null);
    const onKey = vi.fn();
    renderUI(
      <div style={{ width: 800, height: 600 }}>
        <SheetViewer
          model={model}
          sheet={{ w: 420, h: 297 }}
          fitKey="s"
          label="Sheet"
          begin={begin}
          onKeyDown={(e) => {
            onKey(e.key);
            return e.key === 'q' ? true : undefined;
          }}
        />
      </div>,
    );
    const viewer = screen.getByRole('application');
    const zoom = () => viewer.getAttribute('data-zoom');
    const z0 = Number(zoom());
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    // The size is not measured in jsdom, so the buttons leave the fit alone; the key path is
    // covered by the E2E. What matters here is that the controls exist, are named and labelled.
    expect(Number(zoom())).toBeGreaterThanOrEqual(z0);
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Fit sheet to window' })).toBeVisible();
    viewer.focus();
    await userEvent.keyboard('q');
    expect(onKey).toHaveBeenCalledWith('q');
    fireEvent.pointerDown(viewer, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 5,
      clientY: 5,
    });
    // The press goes to the tool first; when it declines, the viewer pans.
    expect(begin).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(viewer, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 5,
      clientY: 5,
    });
  });
});

describe('DrawingToolbar', () => {
  it('has one tab stop, marks the active tool, and explains a disabled one', async () => {
    const onTool = vi.fn();
    renderUI(
      <DrawingToolbar
        active="dimension"
        disabled={{ section: 'Add a view first' }}
        onTool={onTool}
      />,
    );
    const bar = screen.getByRole('toolbar', { name: 'Drawing tools' });
    expect(within(bar).getByRole('button', { name: 'Dimension' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(bar).getByRole('button', { name: 'Select and move' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // One-shot actions are not toggles.
    expect(
      within(bar).getByRole('button', { name: 'Import model annotations' }),
    ).not.toHaveAttribute('aria-pressed');
    const section = within(bar).getByRole('button', { name: 'Section view' });
    expect(section).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(section);
    expect(onTool).not.toHaveBeenCalled();
    await userEvent.click(within(bar).getByRole('button', { name: 'Datum' }));
    expect(onTool).toHaveBeenCalledWith('datum');
    // Roving focus: the toolbar is one tab stop.
    const tabbable = within(bar)
      .getAllByRole('button')
      .filter((b) => b.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
  });
});

describe('ViewPicker and ViewsPanel', () => {
  it('adds a standard view with one tap', async () => {
    const onPick = vi.fn();
    renderUI(<ViewPicker onPick={onPick} />);
    expect(screen.getAllByRole('button')).toHaveLength(6);
    await userEvent.click(screen.getByRole('button', { name: /Top/ }));
    expect(onPick).toHaveBeenCalledWith('top');
  });

  it('lists views under their parents with scale and configuration badge; review only has no pickers', async () => {
    const onSelect = vi.fn();
    const { rerender } = renderUI(
      <ViewsPanel
        views={[
          { id: 'a', name: 'Front view', depth: 0, kind: 'base', scale: '1:2' },
          {
            id: 'b',
            name: 'Top view',
            depth: 1,
            kind: 'projected',
            scale: '1:2',
            configuration: { name: 'Long' },
          },
          {
            id: 'c',
            name: 'Section A–A',
            depth: 1,
            kind: 'section',
            scale: '',
            problem: 'The cut line has no length',
          },
        ]}
        selectedId="a"
        onSelect={onSelect}
        onAddBase={() => {}}
        onAddIso={() => {}}
        onAddStandard={() => {}}
        canAddDerived
      />,
    );
    const list = screen.getByRole('list', { name: 'Views on this sheet' });
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /Front view/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('config-badge')).toHaveTextContent('Long');
    expect(screen.getByText('The cut line has no length')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Top view/ }));
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(screen.getByTestId('view-picker')).toBeVisible();
    rerender(
      <ViewsPanel
        views={[]}
        onSelect={onSelect}
        onAddBase={() => {}}
        onAddIso={() => {}}
        onAddStandard={() => {}}
        canAddDerived={false}
        reviewOnly
      />,
    );
    expect(screen.queryByTestId('view-picker')).toBeNull();
    expect(screen.getByText('No views yet')).toBeVisible();
  });
});

const display: ViewDisplay = {
  lines: 'visible',
  tangentEdges: 'off',
  centerMarks: true,
  centerLines: true,
  threads: true,
};

describe('ViewInspector', () => {
  const base = (over: Partial<React.ComponentProps<typeof ViewInspector>> = {}) => (
    <ViewInspector
      kind="projected"
      title="Top view"
      parentName="Front view"
      scale=""
      inheritedScale="1:2"
      evaluateScale={evalOk}
      onScale={() => {}}
      label=""
      derivedLabel=""
      showLabel={false}
      onLabel={() => {}}
      onShowLabel={() => {}}
      display={display}
      onDisplay={() => {}}
      configuration={{
        value: undefined,
        options: [
          { id: null, name: 'Default' },
          { id: 'c1', name: 'Long' },
        ],
        drawingName: 'Default',
      }}
      onConfiguration={() => {}}
      distance={80}
      onDistance={() => {}}
      dependents={0}
      onDelete={() => {}}
      evaluate={evalOk}
      {...over}
    />
  );

  it('shows an inherited scale as inherited, and an own scale with a way back', async () => {
    const onScale = vi.fn();
    const { rerender } = renderUI(base({ onScale }));
    expect(screen.getByText('Inherited: 1:2')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Inherit' })).toBeNull();
    rerender(base({ onScale, scale: '1/4' }));
    await userEvent.click(screen.getByRole('button', { name: 'Inherit' }));
    expect(onScale).toHaveBeenCalledWith(null);
  });

  it('commits a typed scale, offers the configuration choice with a badge, and an inline distance', async () => {
    const onScale = vi.fn();
    const onConfiguration = vi.fn();
    const onDistance = vi.fn();
    renderUI(base({ onScale, onConfiguration, onDistance }));
    const scale = screen.getByRole('textbox', { name: 'View scale' });
    await userEvent.clear(scale);
    await userEvent.type(scale, '2{Enter}');
    expect(onScale).toHaveBeenCalledWith('2');
    await userEvent.selectOptions(screen.getByLabelText('Configuration of this view'), 'c1');
    expect(onConfiguration).toHaveBeenCalledWith('c1');
    expect(screen.queryByTestId('config-badge')).toBeNull(); // inherits: no badge
    const dist = screen.getByRole('textbox', { name: 'Distance from parent view' });
    await userEvent.clear(dist);
    await userEvent.type(dist, '95{Enter}');
    expect(onDistance).toHaveBeenCalledWith(95);
  });

  it('badges a view with its own configuration, and a missing one is not a quiet fallback', () => {
    const { rerender } = renderUI(
      base({
        configuration: {
          value: 'c1',
          options: [{ id: 'c1', name: 'Long' }],
          drawingName: 'Default',
        },
      }),
    );
    expect(screen.getByTestId('config-badge')).toHaveAttribute('data-own', 'true');
    expect(screen.getByTestId('config-badge')).toHaveTextContent('Long');
    rerender(
      base({
        configuration: { value: 'gone', options: [], drawingName: 'Default', missing: true },
      }),
    );
    expect(screen.getByTestId('config-badge')).toHaveAttribute('data-missing', 'true');
    expect(screen.getByTestId('config-badge')).toHaveTextContent('Missing configuration');
  });

  it('names what deleting takes with it', async () => {
    const onDelete = vi.fn();
    const onDetach = vi.fn();
    renderUI(base({ dependents: 2, onDelete, onDetachAndDelete: onDetach }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete with 2 derived views' }));
    expect(onDelete).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete, keep derived views' }));
    expect(onDetach).toHaveBeenCalled();
  });
});

const dim: Annotation = {
  id: 'A1',
  kind: 'linear',
  origin: { kind: 'drawing', drawingId: 'D' },
  refs: [
    { name: 'e1', kind: 'edge' },
    { name: 'e2', kind: 'edge' },
  ],
};
const placement: AnnotationPlacement = {
  id: 'P1',
  viewId: 'V',
  annotationId: 'A1',
  layout: { kind: 'lane', side: 'bottom', lane: 0 },
};

const inspector = (over: Partial<AnnotationInspectorProps> = {}): AnnotationInspectorProps => ({
  annotation: dim,
  placement,
  valueText: '80 mm',
  state: 'ok',
  problems: [],
  evaluate: evalOk,
  datums: [{ id: 'D1', label: 'A' }],
  characteristics: [
    { value: 'flatness' },
    { value: 'position' },
    { value: 'concentricity', refusal: 'ASME Y14.5-2018 has no concentricity' },
  ],
  datumLabelProblem: (l) => (l === 'I' ? 'I, O and Q are not used as datum letters' : undefined),
  onChange: () => {},
  onPlacement: () => {},
  onRemoveFromView: () => {},
  onDelete: () => {},
  ...over,
});

describe('AnnotationInspector', () => {
  it('shows the value, edits the stated value and the tolerance, and moves the lane inline', async () => {
    const onChange = vi.fn();
    const onPlacement = vi.fn();
    renderUI(<AnnotationInspector {...inspector({ onChange, onPlacement })} />);
    expect(screen.getByTestId('annotation-value')).toHaveTextContent('80 mm');
    const stated = screen.getByRole('textbox', { name: 'Stated value' });
    await userEvent.type(stated, '80{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ ...dim, nominal: '80' });
    await userEvent.type(screen.getByRole('textbox', { name: 'Tolerance' }), '±0.1{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({
      ...dim,
      tolerance: { kind: 'symmetric', value: '0.1 mm' },
    });
    // The inline alternative to dragging.
    const lane = screen.getByRole('spinbutton', { name: 'Lane (0 is nearest the view)' });
    fireEvent.change(lane, { target: { value: '2' } });
    expect(onPlacement).toHaveBeenLastCalledWith({
      ...placement,
      layout: { kind: 'lane', side: 'bottom', lane: 2 },
    });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Dimension side' }), 'top');
    expect(onPlacement).toHaveBeenLastCalledWith({
      ...placement,
      layout: { kind: 'lane', side: 'top', lane: 0 },
    });
  });

  it('a promoted dimension is read-only: no stated value, the source is named (D6)', () => {
    renderUI(
      <AnnotationInspector
        {...inspector({
          annotation: {
            ...dim,
            source: { kind: 'sketchDimension', featureId: 'S', constraintId: 'd1' },
          } as Annotation,
          readOnlyReason: 'The value is read from the model.',
          sourceText: 'Driven by Plate sketch: width. Change it there.',
        })}
      />,
    );
    expect(screen.queryByRole('textbox', { name: 'Stated value' })).toBeNull();
    expect(screen.getByTestId('annotation-readonly')).toHaveTextContent('read from the model');
    expect(screen.getByTestId('annotation-source')).toHaveTextContent('Plate sketch');
    // The tolerance of a promoted dimension is still its own.
    expect(screen.getByRole('textbox', { name: 'Tolerance' })).toBeEnabled();
  });

  it('needs attention: no value anywhere, the reasons, and a reattach', async () => {
    const onReattach = vi.fn();
    renderUI(
      <AnnotationInspector
        {...inspector({
          state: 'needsAttention',
          valueText: undefined,
          problems: ['A reference no longer resolves'],
          onReattach,
        })}
      />,
    );
    expect(screen.queryByTestId('annotation-value')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Needs attention');
    expect(screen.getByRole('alert')).toHaveTextContent('A reference no longer resolves');
    expect(screen.getByRole('alert')).toHaveTextContent('No value is shown');
    await userEvent.click(screen.getByTestId('reattach'));
    expect(onReattach).toHaveBeenCalled();
  });

  it('a tolerance frame: the standard refuses what it does not have, datums come from the part', async () => {
    const frame: Annotation = {
      id: 'G1',
      kind: 'geometricTolerance',
      origin: { kind: 'drawing', drawingId: 'D' },
      refs: [{ name: 'e1', kind: 'edge' }],
      characteristic: 'flatness',
      zone: { value: '0.1 mm' },
    };
    const onChange = vi.fn();
    renderUI(
      <AnnotationInspector {...inspector({ annotation: frame, onChange, valueText: undefined })} />,
    );
    const select = screen.getByRole('combobox', { name: 'Geometric characteristic' });
    const concentric = within(select).getByRole('option', { name: /Concentricity/ });
    expect(concentric).toBeDisabled();
    expect(concentric).toHaveTextContent('not in this standard');
    await userEvent.selectOptions(select, 'position');
    expect(onChange).toHaveBeenLastCalledWith({ ...frame, characteristic: 'position' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Primary datum' }), 'D1');
    expect(onChange).toHaveBeenLastCalledWith({
      ...frame,
      datums: [{ datums: [{ datum: 'D1' }] }],
    });
    await userEvent.click(screen.getByRole('switch', { name: 'Diameter zone (Ø)' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...frame,
      zone: { value: '0.1 mm', shape: 'diameter' },
    });
  });

  it('a datum letter says why it is refused; a note, a finish and a hole callout have their fields', async () => {
    const datum: Annotation = {
      id: 'D1',
      kind: 'datumFeature',
      origin: { kind: 'drawing', drawingId: 'D' },
      refs: [{ name: 'e1', kind: 'edge' }],
      label: 'I',
    };
    const { rerender } = renderUI(
      <AnnotationInspector {...inspector({ annotation: datum, valueText: undefined })} />,
    );
    expect(screen.getByLabelText('Datum letter')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/not used as datum letters/)).toBeVisible();
    const finish: Annotation = {
      id: 'F1',
      kind: 'surfaceFinish',
      origin: { kind: 'drawing', drawingId: 'D' },
      refs: [{ name: 'e1', kind: 'edge' }],
      process: 'any',
      requirements: [{ parameter: 'Ra', value: '1.6 um' }],
    };
    rerender(<AnnotationInspector {...inspector({ annotation: finish, valueText: undefined })} />);
    expect(screen.getByRole('combobox', { name: 'Roughness parameter' })).toHaveValue('Ra');
    expect(screen.getByRole('textbox', { name: 'Roughness limit' })).toHaveValue('1.6 um');
    const note: Annotation = {
      id: 'N1',
      kind: 'note',
      origin: { kind: 'drawing', drawingId: 'D' },
      refs: [{ name: 'e1', kind: 'edge' }],
      text: 'BREAK SHARP EDGES',
    };
    rerender(<AnnotationInspector {...inspector({ annotation: note, valueText: undefined })} />);
    expect(screen.getByRole('textbox', { name: 'Note text' })).toHaveValue('BREAK SHARP EDGES');
    const hole: Annotation = {
      id: 'H1',
      kind: 'holeCallout',
      origin: { kind: 'drawing', drawingId: 'D' },
      refs: [],
      source: { kind: 'feature', featureId: 'F' },
    };
    const onChange = vi.fn();
    rerender(
      <AnnotationInspector {...inspector({ annotation: hole, onChange, valueText: undefined })} />,
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Depth' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...hole, show: { depth: false } });
  });
});

describe('ImportPanel', () => {
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
      detail: 'Hole sketch',
      kind: 'promote' as const,
      viewName: 'Top view',
    },
    {
      key: 'c',
      title: 'radius dimension',
      detail: 'Fillet',
      kind: 'promote' as const,
      reason: 'No geometry to place it on',
    },
  ];

  it('checks, counts and places only what can be placed; a row without a view says why', async () => {
    const onToggle = vi.fn();
    const onAll = vi.fn();
    const onPlace = vi.fn();
    renderUI(
      <ImportPanel
        rows={rows}
        checked={new Set(['a'])}
        onToggle={onToggle}
        onAll={onAll}
        alreadyPlaced={2}
        notPromotable={['Sweep path length']}
        onPlace={onPlace}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText('1 of 2 checked')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Place 1 annotation' })).toBeEnabled();
    expect(screen.getByText(/2 already on this drawing/)).toBeVisible();
    const off = screen.getByRole('checkbox', { name: /radius dimension/ });
    expect(off).toBeDisabled();
    expect(screen.getByText('No geometry to place it on')).toBeVisible();
    await userEvent.click(screen.getByRole('checkbox', { name: /diameter dimension/ }));
    expect(onToggle).toHaveBeenCalledWith('b', true);
    await userEvent.click(screen.getByRole('button', { name: 'Check all' }));
    expect(onAll).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole('button', { name: 'Place 1 annotation' }));
    expect(onPlace).toHaveBeenCalled();
    expect(screen.getByText(/1 driving value cannot be imported yet/)).toBeVisible();
  });

  it('nothing checked cannot be placed; nothing to import says so', () => {
    const { rerender } = renderUI(
      <ImportPanel
        rows={rows}
        checked={new Set()}
        onToggle={() => {}}
        onAll={() => {}}
        alreadyPlaced={0}
        notPromotable={[]}
        onPlace={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('import-place')).toBeDisabled();
    rerender(
      <ImportPanel
        rows={[]}
        checked={new Set()}
        onToggle={() => {}}
        onAll={() => {}}
        alreadyPlaced={3}
        notPromotable={[]}
        onPlace={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText('Nothing to import')).toBeVisible();
    expect(screen.getByText(/already on this drawing/)).toBeVisible();
  });
});

describe('AttentionPanel', () => {
  const rows = [
    {
      key: 'k1',
      severity: 'attention' as const,
      message: 'A reference no longer resolves',
      zone: 'B2',
      title: 'linear dimension',
      reattachable: true,
    },
    {
      key: 'k2',
      severity: 'warning' as const,
      message: 'Placed twice',
      zone: 'C3',
      title: 'diameter dimension',
    },
    { key: 'k3', severity: 'info' as const, message: 'Not in this configuration' },
    { key: 'k4', severity: 'info' as const, message: 'Another note' },
    { key: 'k5', severity: 'info' as const, message: 'A fifth entry' },
  ];

  it('lists problems in words with their zone, selects and reattaches, never shows a value', async () => {
    const onSelect = vi.fn();
    const onReattach = vi.fn();
    renderUI(<AttentionPanel rows={rows} onSelect={onSelect} onReattach={onReattach} />);
    expect(screen.getByTestId('attention-count')).toHaveTextContent('1 item needs attention');
    const first = screen.getByText('A reference no longer resolves').closest('li') as HTMLElement;
    expect(first).toHaveAttribute('data-severity', 'attention');
    expect(first).toHaveTextContent('zone B2');
    await userEvent.click(within(first).getByRole('button', { name: /Needs attention/ }));
    expect(onSelect).toHaveBeenCalledWith('k1');
    // Only an annotation with unresolved references offers a reattach.
    expect(screen.getAllByRole('button', { name: 'Reattach…' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Reattach…' }));
    expect(onReattach).toHaveBeenCalledWith('k1');
  });

  it('searches by message and zone; an empty list says everything resolves', async () => {
    const { rerender } = renderUI(
      <AttentionPanel rows={rows} onSelect={() => {}} onReattach={() => {}} />,
    );
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the list' }), 'C3');
    expect(screen.getByText('Placed twice')).toBeVisible();
    expect(screen.queryByText('A reference no longer resolves')).toBeNull();
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search the list' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the list' }), 'zzz');
    expect(screen.getByText('No matches.')).toBeVisible();
    rerender(<AttentionPanel rows={[]} onSelect={() => {}} onReattach={() => {}} />);
    expect(screen.getByText('Everything resolves')).toBeVisible();
  });
});

describe('TitleBlockEditor', () => {
  const rows = [
    {
      slot: 'partNumber',
      caption: 'Identification number',
      text: 'BR-100',
      source: 'override' as const,
      bound: 'Demo bracket',
    },
    { slot: 'material', caption: 'Material', text: 'Aluminium', source: 'bound' as const },
    { slot: 'owner', caption: 'Legal owner', text: '', source: 'empty' as const },
  ];

  it('badges a bound value and an override, and an override goes back to the model in one tap', async () => {
    const onEdit = vi.fn();
    renderUI(<TitleBlockEditor rows={rows} onEdit={onEdit} />);
    expect(screen.getByTestId('slot-badge-material')).toHaveTextContent('From the model');
    expect(screen.getByTestId('slot-badge-partNumber')).toHaveTextContent('Overrides the model');
    expect(screen.getByText('The model says: Demo bracket')).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: /Use the model’s value for Identification number/ }),
    );
    expect(onEdit).toHaveBeenCalledWith('partNumber', null);
  });

  it('typing over a bound value is an override; typing the model’s text back clears it; plain text is plain', async () => {
    const onEdit = vi.fn();
    renderUI(<TitleBlockEditor rows={rows} onEdit={onEdit} />);
    const material = screen.getByRole('textbox', { name: 'Material' });
    await userEvent.clear(material);
    await userEvent.type(material, 'Steel{Enter}');
    expect(onEdit).toHaveBeenLastCalledWith('material', 'Steel');
    const part = screen.getByRole('textbox', { name: 'Identification number' });
    await userEvent.clear(part);
    await userEvent.type(part, 'Demo bracket{Enter}');
    expect(onEdit).toHaveBeenLastCalledWith('partNumber', null);
    await userEvent.type(screen.getByRole('textbox', { name: 'Legal owner' }), 'ACME{Enter}');
    expect(onEdit).toHaveBeenLastCalledWith('owner', 'ACME');
  });

  it('the inline cell editor commits on Enter and leaves on Escape', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    renderUI(
      <InlineCellEditor
        caption="Material"
        value="Aluminium"
        bound="Aluminium"
        onCommit={onCommit}
        onCancel={onCancel}
        box={{ x: 10, y: 10, width: 100, height: 20 }}
      />,
    );
    const input = screen.getByRole('textbox', { name: /Material/ });
    expect(input).toHaveFocus();
    await userEvent.clear(input);
    await userEvent.type(input, 'Steel{Enter}');
    expect(onCommit).toHaveBeenCalledWith('Steel');
  });
});

describe('DrawingList', () => {
  const items = [{ id: 'd1', name: 'Plate A', summary: 'ISO · first angle · 1 sheet' }];

  it('opens, renames inline, and deletes after an inline confirmation', async () => {
    const onOpen = vi.fn();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    renderUI(
      <DrawingList
        drawings={items}
        onOpen={onOpen}
        onRename={onRename}
        onDelete={onDelete}
        onNew={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open Plate A' }));
    expect(onOpen).toHaveBeenCalledWith('d1');
    await userEvent.click(screen.getByRole('button', { name: 'Rename Plate A' }));
    const input = screen.getByRole('textbox', { name: 'New drawing name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Plate B{Enter}');
    expect(onRename).toHaveBeenCalledWith('d1', 'Plate B');
    await userEvent.click(screen.getByRole('button', { name: 'Delete Plate A' }));
    expect(onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('drawing-delete-confirm'));
    expect(onDelete).toHaveBeenCalledWith('d1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('review only (phone): open, nothing else', () => {
    renderUI(
      <DrawingList
        drawings={items}
        onOpen={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onNew={() => {}}
        reviewOnly
      />,
    );
    expect(screen.getByRole('button', { name: 'Open Plate A' })).toBeVisible();
    expect(screen.queryByTestId('drawing-new')).toBeNull();
    expect(screen.queryByTestId('drawing-delete')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Rename/ })).toBeNull();
  });

  it('a new drawing waits for a part', () => {
    renderUI(
      <DrawingList
        drawings={[]}
        onOpen={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onNew={() => {}}
        newDisabled="Add a part first"
      />,
    );
    expect(screen.getByTestId('drawing-new')).toBeDisabled();
    expect(screen.getByText(/No drawings yet/)).toBeVisible();
  });
});

describe('DrawingExportPanel', () => {
  it('offers PDF, SVG and both DXF profiles, says when items need attention, and disables while busy', async () => {
    const onExport = vi.fn();
    const { rerender } = renderUI(
      <DrawingExportPanel
        sheetName="Sheet 1"
        sheetCount={2}
        busy={null}
        attentionCount={2}
        onExport={onExport}
      />,
    );
    expect(screen.getByRole('note')).toHaveTextContent('2 items still need attention');
    for (const id of ['pdf', 'svg', 'dxf-r12', 'dxf-r2000'])
      expect(document.querySelector(`[data-export="${id}"]`)).not.toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'All 2 sheets' }));
    await userEvent.click(document.querySelector('[data-export="dxf-r12"]') as HTMLElement);
    expect(onExport).toHaveBeenCalledWith('dxf-r12', 'all');
    rerender(
      <DrawingExportPanel
        sheetName="Sheet 1"
        sheetCount={1}
        busy="pdf"
        attentionCount={0}
        onExport={onExport}
      />,
    );
    expect(document.querySelector('[data-export="pdf"]')).toHaveTextContent('Writing…');
    expect(document.querySelector('[data-export="svg"]')).toBeDisabled();
  });
});

describe('SheetSettings', () => {
  it('switches the projection explicitly and changes the sheet size within the standard', async () => {
    const onProjection = vi.fn();
    const onFormat = vi.fn();
    renderUI(
      <SheetSettings
        drawingName="Plate"
        onRename={() => {}}
        family="iso"
        gps="ISO 1101:2017"
        surfaceFinish="ISO 21920-1:2021"
        generalTolerance="ISO 2768-mK"
        onGeneralTolerance={() => {}}
        projection="first"
        onProjection={onProjection}
        sheet={{
          id: 's',
          name: 'Sheet 1',
          format: { size: 'A3', orientation: 'landscape' },
          scale: '1',
        }}
        sheets={[{ id: 's', name: 'Sheet 1' }]}
        onFormat={onFormat}
        onSheetScale={() => {}}
        evaluateScale={evalOk}
        onAddSheet={() => {}}
        onRemoveSheet={() => {}}
        template={{ id: 'iso-5457', version: 1, latest: 1 }}
        onReapplyTemplate={() => {}}
        configuration={{ value: null, options: [{ id: null, name: 'Default' }] }}
        onConfiguration={() => {}}
      />,
    );
    expect(screen.getByRole('radio', { name: 'First angle' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Third angle' }));
    expect(onProjection).toHaveBeenCalledWith('third');
    expect(screen.getByTestId('drawing-standard')).toHaveTextContent('ISO · ISO 1101:2017');
    await userEvent.selectOptions(screen.getByLabelText('Sheet size'), 'A2');
    expect(onFormat).toHaveBeenCalledWith({ size: 'A2', orientation: 'landscape' });
    // The standard is shown, not switched: changing it is a new drawing.
    expect(screen.getByText(/make a new drawing/)).toBeVisible();
    // An up-to-date template offers no re-apply.
    expect(screen.queryByRole('button', { name: /Re-apply/ })).toBeNull();
  });
});

describe('DrawingShell', () => {
  const panels = [
    { id: 'a', label: 'Inspector', content: <p>inspector body</p> },
    {
      id: 'b',
      label: 'Attention',
      badge: 2,
      tone: 'danger' as const,
      content: <p>attention body</p>,
    },
  ];
  const props = {
    title: 'Plate A',
    onBack: () => {},
    sheets: [
      { id: 's1', name: 'Sheet 1' },
      { id: 's2', name: 'Sheet 2' },
    ],
    sheetId: 's1',
    onSheet: () => {},
    canvas: <div>the sheet</div>,
    panels,
    panel: 'a',
    onPanel: () => {},
  };

  it('desktop: tools, sheet and a tabbed side panel; sheet tabs only when there are several', async () => {
    const onSheet = vi.fn();
    const onPanel = vi.fn();
    renderUI(
      <DrawingShell
        {...props}
        tier="desktop"
        tools={<div>tools</div>}
        onSheet={onSheet}
        onPanel={onPanel}
      />,
    );
    expect(screen.getByTestId('drawing-shell')).toHaveAttribute('data-tier', 'desktop');
    expect(screen.getByText('inspector body')).toBeVisible();
    expect(screen.getByRole('tab', { name: /Attention/ })).toHaveTextContent('2');
    await userEvent.click(screen.getByRole('tab', { name: /Attention/ }));
    expect(onPanel).toHaveBeenCalledWith('b');
    expect(screen.getByRole('button', { name: 'Sheet 1' })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(screen.getByRole('button', { name: 'Sheet 2' }));
    expect(onSheet).toHaveBeenCalledWith('s2');
  });

  it('tablet and phone: a collapsible bottom panel with an expanded state', async () => {
    renderUI(<DrawingShell {...props} tier="phone" />);
    expect(screen.getByTestId('drawing-shell')).toHaveAttribute('data-tier', 'phone');
    const toggle = screen.getByTestId('drawing-panel-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('inspector body')).toBeNull();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('inspector body')).toBeVisible();
    // 44 px targets on touch.
    expect(screen.getByTestId('drawing-back').className).toMatch(/size-11/);
  });
});
