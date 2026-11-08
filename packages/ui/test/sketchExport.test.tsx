import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SketchConstraintKind } from '@whittle/contracts';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { sampleConflicts, sampleParams } from '../harness/fixtures';
import {
  buildExportRequest,
  ConflictPanel,
  ConstraintGlyph,
  constraintLabels,
  DimensionLabel,
  dimensionKinds,
  ExportMenu,
  geometricConstraintKinds,
  QUALITY_PRESETS,
  SketchStatusChip,
  SketchToolbar,
  type SketchToolId,
} from '../src';
import { describeSketchStatus } from '../src/sketch/SketchStatusChip';
import { makeEvaluator, renderUI } from './helpers';

describe('ConstraintGlyph', () => {
  it('has a distinct glyph for every constraint kind in sketch.ts', () => {
    const all: SketchConstraintKind[] = [
      'coincident',
      'pointOn',
      'horizontal',
      'vertical',
      'horizontalPoints',
      'verticalPoints',
      'parallel',
      'perpendicular',
      'tangent',
      'equal',
      'midpoint',
      'concentric',
      'symmetric',
      'fix',
      'distance',
      'hDistance',
      'vDistance',
      'length',
      'radius',
      'diameter',
      'angle',
    ];
    expect([...geometricConstraintKinds, ...dimensionKinds].sort()).toEqual([...all].sort());
    const svgs = new Set<string>();
    for (const k of all) {
      const { container, unmount } = renderUI(<ConstraintGlyph kind={k} labelled />);
      expect(screen.getByRole('img', { name: constraintLabels[k] })).toBeInTheDocument();
      svgs.add(container.querySelector('svg')?.innerHTML ?? '');
      unmount();
    }
    expect(svgs.size).toBe(all.length);
  });

  it('is decorative unless labelled', () => {
    const { container } = renderUI(<ConstraintGlyph kind="tangent" tone="hint" />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('SketchStatusChip', () => {
  it('describes DOF, full and over-constrained states', () => {
    expect(describeSketchStatus('solved', 0).label).toBe('Fully constrained');
    expect(describeSketchStatus('solved', 1).label).toBe('1 degree of freedom');
    expect(describeSketchStatus('solved', 2).label).toBe('2 degrees of freedom');
    expect(describeSketchStatus('conflicting', 0).label).toBe('Over-constrained');
    renderUI(<SketchStatusChip status="solved" dof={2} redundant={1} />);
    expect(screen.getByRole('status')).toHaveTextContent('2 degrees of freedom · 1 redundant');
  });

  it('is a button that opens conflicts when over-constrained', async () => {
    const onClick = vi.fn();
    renderUI(<SketchStatusChip status="conflicting" dof={0} onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: 'Over-constrained' }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe('ConflictPanel', () => {
  it('lists explanations and calls onFix with the fix and conflict index', async () => {
    const onFix = vi.fn();
    const onHighlight = vi.fn();
    renderUI(<ConflictPanel conflicts={sampleConflicts} onFix={onFix} onHighlight={onHighlight} />);
    const panel = await screen.findByRole('region', { name: 'Sketch conflicts' });
    expect(within(panel).getByText(/can’t be both horizontal/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Remove “Horizontal 3”' }));
    expect(onFix).toHaveBeenCalledWith(sampleConflicts[0]?.fixes[0], 0);
    await userEvent.click(within(panel).getByRole('button', { name: 'Set D2 to 38.5 mm' }));
    expect(onFix).toHaveBeenLastCalledWith(sampleConflicts[1]?.fixes[0], 1);
    fireEvent.mouseEnter(panel.querySelectorAll('li')[1] as HTMLElement);
    expect(onHighlight).toHaveBeenLastCalledWith(['C9']);
  });

  it('renders nothing without conflicts', () => {
    const { container } = renderUI(<ConflictPanel conflicts={[]} onFix={() => {}} />);
    expect(container.textContent).toBe('');
  });
});

describe('DimensionLabel', () => {
  const evaluate = makeEvaluator(sampleParams);

  it('driving dimensions show the value and edit inline', async () => {
    const onCommit = vi.fn();
    renderUI(
      <DimensionLabel
        x={10}
        y={10}
        kind="length"
        expr="width"
        driving
        evaluate={(e) => evaluate(e, 'length')}
        onCommit={onCommit}
      />,
    );
    const btn = screen.getByRole('button', { name: /Dimension: 60/ });
    expect(btn).toHaveTextContent('60');
    await userEvent.click(btn);
    const input = screen.getByRole('textbox', { name: 'length dimension' });
    expect(input).toHaveFocus();
    await userEvent.keyboard('{Control>}a{/Control}42mm{Enter}');
    expect(onCommit).toHaveBeenCalledWith('42mm');
    expect(screen.getByRole('button', { name: /Dimension/ })).toBeInTheDocument();
  });

  it('driven dimensions are parenthesised and not editable', async () => {
    renderUI(
      <DimensionLabel x={0} y={0} kind="distance" expr="" driving={false} measured="42.5" />,
    );
    const btn = screen.getByRole('button', { name: /Reference dimension: 42.5/ });
    expect(btn).toHaveTextContent('(42.5)');
    await userEvent.click(btn);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('diameter and radius carry their prefix; autoEdit opens the editor; Esc closes it', async () => {
    renderUI(
      <DimensionLabel
        x={0}
        y={0}
        kind="diameter"
        expr="8mm"
        driving
        autoEdit
        evaluate={(e) => evaluate(e, 'length')}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'diameter dimension' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: /Dimension: Ø8/ })).toHaveTextContent('Ø8');
  });
});

function Host(
  props: Partial<React.ComponentProps<typeof SketchToolbar>> & {
    spy?: (...args: unknown[]) => void;
  },
) {
  const [tool, setTool] = useState<SketchToolId | null>(null);
  return (
    <SketchToolbar
      activeTool={tool}
      onTool={(t, v) => {
        setTool(t);
        props.spy?.(t, v);
      }}
      construction={false}
      onToggleConstruction={() => props.spy?.('construction')}
      onFinish={() => props.spy?.('finish')}
      onEscape={() => props.spy?.('escape')}
      {...props}
    />
  );
}

describe('SketchToolbar', () => {
  it('shortcuts: L, A, Shift+C, D, X and Esc', async () => {
    const spy = vi.fn();
    renderUI(<Host spy={spy} />);
    await userEvent.keyboard('l');
    expect(spy).toHaveBeenLastCalledWith('line', 'line');
    await userEvent.keyboard('a');
    expect(spy).toHaveBeenLastCalledWith('arc', 'threePoint');
    await userEvent.keyboard('{Shift>}c{/Shift}');
    expect(spy).toHaveBeenLastCalledWith('circle', 'center');
    await userEvent.keyboard('d');
    expect(spy).toHaveBeenLastCalledWith('dimension', undefined);
    await userEvent.keyboard('x');
    expect(spy).toHaveBeenLastCalledWith('construction');
    await userEvent.keyboard('{Escape}');
    expect(spy).toHaveBeenLastCalledWith(null, undefined);
    await userEvent.keyboard('{Escape}');
    expect(spy).toHaveBeenLastCalledWith('escape');
  });

  it('pressing the shortcut again cycles the tool variant', async () => {
    const spy = vi.fn();
    renderUI(<Host spy={spy} />);
    await userEvent.keyboard('aa');
    expect(spy).toHaveBeenLastCalledWith('arc', 'tangent');
    await userEvent.keyboard('a');
    expect(spy).toHaveBeenLastCalledWith('arc', 'center');
    await userEvent.keyboard('a');
    expect(spy).toHaveBeenLastCalledWith('arc', 'threePoint');
  });

  it('ignores shortcuts while typing and with modifiers', async () => {
    const spy = vi.fn();
    renderUI(
      <>
        <input aria-label="field" />
        <Host spy={spy} />
      </>,
    );
    await userEvent.click(screen.getByLabelText('field'));
    await userEvent.keyboard('lad');
    expect(spy).not.toHaveBeenCalled();
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard('{Control>}l{/Control}');
    expect(spy).not.toHaveBeenCalled();
  });

  it('can disable shortcuts', async () => {
    const spy = vi.fn();
    renderUI(<Host spy={spy} shortcuts={false} />);
    await userEvent.keyboard('l');
    expect(spy).not.toHaveBeenCalled();
  });

  it('variant menu picks a variant and remembers it', async () => {
    const spy = vi.fn();
    renderUI(<Host spy={spy} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Rectangle' }));
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Centre rectangle' }));
    expect(spy).toHaveBeenLastCalledWith('rectangle', 'center');
    await userEvent.click(screen.getByRole('button', { name: 'Circle' }));
    await userEvent.click(screen.getByRole('button', { name: 'Rectangle' }));
    expect(spy).toHaveBeenLastCalledWith('rectangle', 'center');
  });

  it('constraints menu disables inapplicable constraints and applies the rest', async () => {
    const onConstraint = vi.fn();
    renderUI(<Host onConstraint={onConstraint} enabledConstraints={['horizontal', 'equal']} />);
    await userEvent.click(screen.getByRole('button', { name: 'Constraints' }));
    const menu = await screen.findByRole('menu', { name: 'Constraints' });
    expect(within(menu).getByRole('menuitem', { name: 'Tangent' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Tangent' }));
    expect(onConstraint).not.toHaveBeenCalled();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Horizontal' }));
    expect(onConstraint).toHaveBeenCalledWith('horizontal');
  });

  it('toggles construction and finishes the sketch', async () => {
    const spy = vi.fn();
    renderUI(<Host spy={spy} construction />);
    expect(screen.getByRole('button', { name: 'Construction' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Finish sketch' }));
    expect(spy).toHaveBeenCalledWith('finish');
  });
});

describe('export', () => {
  it('buildExportRequest maps choices to contract ExportOptions', () => {
    expect(
      buildExportRequest({
        target: 'step',
        stlBinary: true,
        stlPerBody: false,
        quality: 'standard',
      }),
    ).toEqual({
      target: 'step',
      options: { stepSchema: 'AP214' },
    });
    expect(
      buildExportRequest({ target: 'stl', stlBinary: false, stlPerBody: true, quality: 'fine' }),
    ).toEqual({
      target: 'stl',
      quality: 'fine',
      options: {
        stlBinary: false,
        stlPerBody: true,
        linearDeflection: 0.005,
        angularDeflection: 0.1,
      },
    });
    expect(
      buildExportRequest({
        target: 'glb',
        stlBinary: true,
        stlPerBody: false,
        quality: 'coarse',
        bodies: ['a'],
        allBodies: 2,
      }),
    ).toEqual({
      target: 'glb',
      quality: 'coarse',
      options: { bodies: ['a'], linearDeflection: 0.1, angularDeflection: 0.5 },
    });
    expect(
      buildExportRequest({
        target: 'whittle',
        stlBinary: true,
        stlPerBody: false,
        quality: 'fine',
      }),
    ).toEqual({ target: 'whittle', options: {} });
    expect(QUALITY_PRESETS.standard.linearDeflection).toBe(0.02);
  });

  async function open(props: Partial<React.ComponentProps<typeof ExportMenu>> = {}) {
    const onExport = vi.fn();
    renderUI(<ExportMenu onExport={onExport} {...props} />);
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    const pop = await screen.findByRole('dialog', { name: 'Export' });
    await screen.findByTestId('export-form');
    return { onExport, pop };
  }

  it('is a non-modal popover: opens on click, Esc closes and returns focus', async () => {
    const { pop } = await open();
    expect(pop).toBeInTheDocument();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Export' })).toHaveFocus();
  });

  it('STEP exports AP214', async () => {
    const { onExport } = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Export STEP' }));
    expect(onExport).toHaveBeenCalledWith({ target: 'step', options: { stepSchema: 'AP214' } });
    await waitFor(() => expect(screen.queryByTestId('export-form')).toBeNull());
  });

  it('STL: binary/ASCII, merged/per-body and quality presets', async () => {
    const { onExport } = await open({
      bodies: [
        { id: 'B1', name: 'Bracket' },
        { id: 'B2', name: 'Plate' },
      ],
    });
    await userEvent.click(screen.getByRole('radio', { name: /STL/ }));
    await userEvent.click(screen.getByRole('radio', { name: 'ASCII' }));
    await userEvent.click(screen.getByRole('radio', { name: 'File per body' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Fine' }));
    expect(screen.getByText(/Chord deviation 0.005 mm/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Export STL' }));
    expect(onExport).toHaveBeenCalledWith({
      target: 'stl',
      quality: 'fine',
      options: {
        stlBinary: false,
        stlPerBody: true,
        linearDeflection: 0.005,
        angularDeflection: 0.1,
      },
    });
  });

  it('body picker limits bodies and requires at least one', async () => {
    const { onExport } = await open({
      bodies: [
        { id: 'B1', name: 'Bracket' },
        { id: 'B2', name: 'Plate' },
      ],
    });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Plate' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export STEP' }));
    expect(onExport).toHaveBeenCalledWith({
      target: 'step',
      options: { bodies: ['B1'], stepSchema: 'AP214' },
    });
  });

  it('3MF / GLB offer quality, .whittle offers nothing; unavailable targets are disabled', async () => {
    await open({ unavailable: { '3mf': 'Coming soon' } });
    expect(screen.getByRole('radio', { name: /3MF/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: /GLB/ }));
    expect(screen.getByRole('radiogroup', { name: 'Tessellation quality' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /Whittle project/ }));
    expect(screen.queryByRole('radiogroup', { name: 'Tessellation quality' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Export Whittle project' })).toBeInTheDocument();
  });

  it('reports the chosen target, shows notes without disabling, never checks a disabled one', async () => {
    const onTargetChange = vi.fn();
    await open({
      onTargetChange,
      notes: { step: 'Loading the geometry kernel… 40%' },
    });
    // STEP is the default: reported on open, with its note, and still enabled.
    expect(onTargetChange).toHaveBeenLastCalledWith('step');
    expect(screen.getByRole('radio', { name: /^STEP/ })).toBeEnabled();
    expect(screen.getByTestId('export-note-step')).toHaveTextContent('Loading the geometry');
    await userEvent.click(screen.getByRole('radio', { name: /^3MF/ }));
    expect(onTargetChange).toHaveBeenLastCalledWith('3mf');
    await userEvent.click(screen.getByRole('radio', { name: /^STL/ }));
    expect(onTargetChange).toHaveBeenLastCalledWith('stl');
    expect(screen.getByRole('radio', { name: /^STL/ })).toBeChecked();
  });

  it('a default target that is unavailable falls back to the first available one', async () => {
    await open({ unavailable: { step: 'Failed', stl: 'Failed' } });
    expect(screen.getByRole('radio', { name: /^STEP/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /^STEP/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /^3MF/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Export 3MF' })).toBeEnabled();
  });
});
