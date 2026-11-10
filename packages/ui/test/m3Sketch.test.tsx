import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeEvaluator, sampleParams } from '../harness/fixtures';
import { m3Features, m3Statuses } from '../harness/m3Fixtures';
import {
  ConvertPanel,
  DimensionLabel,
  FeatureTree,
  LinkedEntityPanel,
  OffsetPanel,
  SketchCornerPanel,
  SketchMirrorPanel,
  SketchToolbar,
  type SketchToolId,
  sketchEditTools,
  sketchTools,
  TrimExtendPanel,
} from '../src';
import { computeNesting } from '../src/logic/treeNesting';
import { renderUI } from './helpers';

const ev = makeEvaluator(sampleParams);
const length = (x: string) => ev(x, 'length');

describe('sketch toolbar: edit tools', () => {
  const setup = (activeTool: SketchToolId | null = null, shortcuts = true) => {
    const onTool = vi.fn();
    renderUI(
      <SketchToolbar
        activeTool={activeTool}
        onTool={onTool}
        construction={false}
        onToggleConstruction={() => {}}
        onFinish={() => {}}
        shortcuts={shortcuts}
      />,
    );
    return onTool;
  };

  it('has an Edit menu listing every edit tool with its shortcut', async () => {
    const onTool = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const menu = within(screen.getByRole('menu', { name: 'Edit tools' }));
    for (const t of sketchEditTools) expect(menu.getByText(t.label)).toBeInTheDocument();
    await userEvent.click(menu.getByRole('menuitemcheckbox', { name: /Convert entities/ }));
    expect(onTool).toHaveBeenCalledWith('convert');
  });

  it('shows the active edit tool on the Edit button and marks it pressed', () => {
    setup('trim');
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('is not pressed for a drawing tool', () => {
    setup('line');
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('runs edit tools from their shortcuts', () => {
    const onTool = setup();
    for (const [key, shift, id] of [
      ['o', false, 'offset'],
      ['v', false, 'convert'],
      ['t', false, 'trim'],
      ['e', false, 'extend'],
      ['f', false, 'sketchFillet'],
      ['F', true, 'sketchChamfer'],
      ['m', false, 'sketchMirror'],
    ] as const) {
      fireEvent.keyDown(window, { key, shiftKey: shift });
      expect(onTool).toHaveBeenLastCalledWith(id, undefined);
    }
  });

  it('keeps the drawing shortcuts', () => {
    const onTool = setup();
    fireEvent.keyDown(window, { key: 'l' });
    expect(onTool).toHaveBeenLastCalledWith('line', 'line');
    fireEvent.keyDown(window, { key: 'C', shiftKey: true });
    expect(onTool).toHaveBeenLastCalledWith('circle', 'center');
    fireEvent.keyDown(window, { key: 'd' });
    expect(onTool).toHaveBeenLastCalledWith('dimension', undefined);
  });

  it('shortcuts are unique across drawing and edit tools', () => {
    const keys = [...sketchTools, ...sketchEditTools].flatMap((t) =>
      t.shortcut ? [t.shortcut] : [],
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain('X'); // construction toggle
  });

  it('follows the app keymap when matchShortcut is given (ADR-049 switch-over)', () => {
    const onTool = vi.fn();
    const onToggle = vi.fn();
    renderUI(
      <SketchToolbar
        activeTool={null}
        onTool={onTool}
        construction={false}
        onToggleConstruction={onToggle}
        onFinish={() => {}}
        matchShortcut={(e) =>
          e.code === 'KeyJ' ? 'circle' : e.code === 'KeyK' ? 'construction' : null
        }
      />,
    );
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL' }); // the built-in table is replaced
    expect(onTool).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'x', code: 'KeyJ' }); // layout-independent: by code
    expect(onTool).toHaveBeenLastCalledWith('circle', 'center');
    fireEvent.keyDown(window, { key: 'q', code: 'KeyK' });
    expect(onToggle).toHaveBeenCalled();
  });

  it('ignores shortcuts while typing', () => {
    const onTool = setup();
    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { key: 'o' });
    expect(onTool).not.toHaveBeenCalled();
    input.remove();
  });
});

describe('offset panel', () => {
  const props = () => ({
    value: '4mm',
    evaluate: length,
    side: 'left' as const,
    both: false,
    count: 3,
    onCommit: vi.fn(),
    onPreview: vi.fn(),
    onSide: vi.fn(),
    onBoth: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
  });

  it('shows the distance chip, side and both toggles and the preview count', async () => {
    const p = props();
    renderUI(<OffsetPanel {...p} />);
    expect(screen.getByRole('textbox', { name: 'Offset distance' })).toHaveValue('4mm');
    expect(screen.getByTestId('offset-preview')).toHaveTextContent(
      'Preview: 3 entities to the left',
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Right' }));
    expect(p.onSide).toHaveBeenCalledWith('right');
    await userEvent.click(screen.getByRole('switch', { name: 'Both sides' }));
    expect(p.onBoth).toHaveBeenCalledWith(true);
  });

  it('commits an expression with units', async () => {
    const p = props();
    renderUI(<OffsetPanel {...p} />);
    const input = screen.getByRole('textbox', { name: 'Offset distance' });
    await userEvent.clear(input);
    await userEvent.type(input, '1/8in{Enter}');
    expect(p.onCommit).toHaveBeenCalledWith('1/8in');
  });

  it('both sides disables the side choice and rewrites the preview', () => {
    renderUI(<OffsetPanel {...props()} both count={1} />);
    expect(screen.getByRole('radiogroup', { name: 'Offset side' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByTestId('offset-preview')).toHaveTextContent('1 entity, both sides');
  });

  it('applies and cancels; apply is disabled with nothing picked or a bad distance', async () => {
    const p = props();
    const { unmount } = renderUI(<OffsetPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /Apply/ }));
    await userEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(p.onApply).toHaveBeenCalledOnce();
    expect(p.onCancel).toHaveBeenCalledOnce();
    unmount();
    renderUI(<OffsetPanel {...props()} count={0} />);
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled();
    expect(screen.getByTestId('offset-preview')).toHaveTextContent('Select a line');
  });

  it('a bad distance blocks apply', () => {
    renderUI(<OffsetPanel {...props()} value="oops" />);
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled();
  });
});

describe('convert entities panel', () => {
  it('switches between edges and a face outline and reports the count', async () => {
    const onSource = vi.fn();
    const onApply = vi.fn();
    renderUI(
      <ConvertPanel
        source="edges"
        count={0}
        onSource={onSource}
        onApply={onApply}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('convert-count')).toHaveTextContent('Select edges');
    expect(screen.getByRole('button', { name: 'Convert' })).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: 'Face outline' }));
    expect(onSource).toHaveBeenCalledWith('face');
  });

  it('prompts for a face in face mode, warns about approximate edges, converts', async () => {
    const onApply = vi.fn();
    const { rerender } = renderUI(
      <ConvertPanel
        source="face"
        count={0}
        onSource={() => {}}
        onApply={onApply}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('convert-count')).toHaveTextContent('Select a face');
    rerender(
      <ConvertPanel
        source="edges"
        count={4}
        approximateCount={2}
        onSource={() => {}}
        onApply={onApply}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('2 will be fitted');
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(onApply).toHaveBeenCalledOnce();
  });
});

describe('linked entity panel', () => {
  it('linked: shows the source and Unlink, no Re-pick', async () => {
    const onUnlink = vi.fn();
    renderUI(
      <LinkedEntityPanel state="linked" sourceLabel="Edge F2:top(e1)" onUnlink={onUnlink} />,
    );
    expect(screen.getByText('Linked to model')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-pick' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(onUnlink).toHaveBeenCalledOnce();
  });

  it('lost: ghost style, an alert that never guesses, Re-pick and Unlink', async () => {
    const onRepick = vi.fn();
    const onUnlink = vi.fn();
    const { container } = renderUI(
      <LinkedEntityPanel
        state="lost"
        sourceLabel="Edge F2:top(e1)"
        onUnlink={onUnlink}
        onRepick={onRepick}
      />,
    );
    expect(container.querySelector('[data-linked-state="lost"]')).not.toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(/will not guess/);
    expect(screen.getByText('Was: Edge F2:top(e1)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Re-pick' }));
    expect(onRepick).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(onUnlink).toHaveBeenCalledOnce();
  });

  it('the three states draw distinctly', () => {
    const { container } = renderUI(
      <div>
        {(['linked', 'approximate', 'lost'] as const).map((s) => (
          <LinkedEntityPanel key={s} state={s} sourceLabel="E" onUnlink={() => {}} />
        ))}
      </div>,
    );
    const dashes = [...container.querySelectorAll('svg[data-linked-state] line')].map((l) =>
      l.getAttribute('stroke-dasharray'),
    );
    expect(new Set(dashes).size).toBe(3);
  });

  it('labels a multi-selection', () => {
    renderUI(
      <LinkedEntityPanel state="approximate" count={3} sourceLabel="E" onUnlink={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Unlink 3' })).toBeInTheDocument();
  });
});

describe('trim / extend, corner and mirror panels', () => {
  it('trim / extend switches mode and shows the matching hint; Esc button is Done', async () => {
    const onMode = vi.fn();
    const onDone = vi.fn();
    const { rerender } = renderUI(<TrimExtendPanel mode="trim" onMode={onMode} onDone={onDone} />);
    expect(screen.getByText(/part of a curve to remove/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Extend' }));
    expect(onMode).toHaveBeenCalledWith('extend');
    rerender(<TrimExtendPanel mode="extend" onMode={onMode} onDone={onDone} />);
    expect(screen.getByText(/to the next boundary/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('corner: radius chip for fillets, distance for chamfers', async () => {
    const onKind = vi.fn();
    const onCommit = vi.fn();
    const { rerender } = renderUI(
      <SketchCornerPanel
        kind="fillet"
        onKind={onKind}
        value="3mm"
        evaluate={length}
        count={2}
        onCommit={onCommit}
        onApply={() => {}}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Corner radius' });
    await userEvent.clear(input);
    await userEvent.type(input, '2mm + 1mm{Enter}');
    expect(onCommit).toHaveBeenCalledWith('2mm + 1mm');
    expect(screen.getByTestId('corner-count')).toHaveTextContent('2 corners selected');
    await userEvent.click(screen.getByRole('radio', { name: 'Chamfer' }));
    expect(onKind).toHaveBeenCalledWith('chamfer');
    rerender(
      <SketchCornerPanel
        kind="chamfer"
        onKind={onKind}
        value="3mm"
        evaluate={length}
        count={0}
        onCommit={onCommit}
        onApply={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Corner distance' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled();
  });

  it('mirror: needs entities and a mirror line before it applies', async () => {
    const onApply = vi.fn();
    const onPhase = vi.fn();
    const { rerender } = renderUI(
      <SketchMirrorPanel
        count={2}
        axisLabel={null}
        phase="entities"
        onPhase={onPhase}
        onApply={onApply}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled();
    expect(screen.getByTestId('mirror-hint')).toHaveTextContent('Select the entities');
    await userEvent.click(screen.getByRole('radio', { name: 'Mirror line' }));
    expect(onPhase).toHaveBeenCalledWith('axis');
    rerender(
      <SketchMirrorPanel
        count={2}
        axisLabel="Construction line 1"
        phase="axis"
        onPhase={onPhase}
        onApply={onApply}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('mirror-hint')).toHaveTextContent('Construction line 1');
    await userEvent.click(screen.getByRole('button', { name: /Apply/ }));
    expect(onApply).toHaveBeenCalledOnce();
  });

  it('touch size gives 44 px controls', () => {
    renderUI(<TrimExtendPanel mode="trim" size="touch" onMode={() => {}} onDone={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Trim' }).className).toMatch(/h-11/);
  });
});

describe('offset dimension label', () => {
  it('has its own accessible name and glyph; reference form is parenthesised', () => {
    const { container, rerender } = renderUI(
      <DimensionLabel x={10} y={10} kind="offset" expr="4mm" driving evaluate={length} />,
    );
    expect(screen.getByRole('button', { name: /Offset dimension: 4/ })).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
    rerender(<DimensionLabel x={10} y={10} kind="offset" expr="" driving={false} measured="4" />);
    expect(screen.getByRole('button', { name: /Reference offset: 4/ })).toHaveTextContent('(4)');
  });

  it('edits inline like any driving dimension', async () => {
    const onCommit = vi.fn();
    renderUI(
      <DimensionLabel
        x={10}
        y={10}
        kind="offset"
        expr="4mm"
        driving
        evaluate={length}
        onCommit={onCommit}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Offset dimension/ }));
    const input = screen.getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, '6mm{Enter}');
    expect(onCommit).toHaveBeenCalledWith('6mm');
  });

  it('plain dimensions keep their name', () => {
    renderUI(<DimensionLabel x={1} y={1} kind="length" expr="5mm" driving evaluate={length} />);
    expect(screen.getByRole('button', { name: /^Dimension: 5/ })).toBeInTheDocument();
  });
});

describe('feature tree with M3 features', () => {
  const nesting = computeNesting(m3Features);

  it('nests the sweep, loft and hole sketches under their features', () => {
    expect(nesting.parentOf.get('M3')).toBe('M5'); // sweep profile
    expect(nesting.parentOf.get('M4')).toBe('M5'); // sweep path
    expect(nesting.parentOf.get('M6')).toBe('M8'); // loft sections
    expect(nesting.parentOf.get('M7')).toBe('M8');
    expect(nesting.parentOf.get('M11')).toBe('M12'); // hole points
    expect(nesting.parentOf.get('M1')).toBe('M2');
  });

  it('shows every M3 feature with its type label and needs-attention / error state', () => {
    renderUI(<FeatureTree features={m3Features} statuses={m3Statuses} nestSketches />);
    const row = (name: string) => screen.getByRole('treeitem', { name: new RegExp(name) });
    expect(row('Shell 1')).toHaveAttribute('data-state', 'needsAttention');
    expect(row('Shell 1').getAttribute('aria-label') ?? row('Shell 1').textContent).toMatch(
      /needs attention/i,
    );
    expect(row('Hole 1')).toHaveAttribute('data-state', 'error');
    for (const n of [
      'Sweep 1',
      'Loft 1',
      'Draft 1',
      'Mirror 1',
      'Linear pattern 1',
      'Circular pattern 1',
      'Axis 1',
      'Point 1',
      'Thread 1',
    ])
      expect(row(n)).toBeInTheDocument();
  });

  it('every feature row carries its icon', () => {
    renderUI(<FeatureTree features={m3Features} statuses={m3Statuses} nestSketches />);
    for (const item of screen.getAllByRole('treeitem')) {
      expect(item.querySelector('svg')).not.toBeNull();
    }
  });

  it('nested sketches are hidden until the parent expands, and the parent says it contains one', () => {
    renderUI(<FeatureTree features={m3Features} statuses={m3Statuses} nestSketches />);
    expect(screen.queryByRole('treeitem', { name: /Rail profile/ })).toBeNull();
    const sweep = screen.getByRole('treeitem', { name: /Sweep 1/ });
    expect(sweep).toHaveAttribute('aria-expanded', 'false');
    expect(sweep.textContent).toMatch(/Sweep/);
  });

  it('selecting a nested sketch opens its feature (hole sketch under the hole)', () => {
    renderUI(
      <FeatureTree features={m3Features} statuses={m3Statuses} nestSketches selectedId="M11" />,
    );
    expect(screen.getByRole('treeitem', { name: /Hole 1/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('treeitem', { name: /Hole points/ })).toHaveAttribute(
      'aria-level',
      '2',
    );
  });
});

describe('sketch toolbar touch density', () => {
  const mount = (density: 'compact' | 'touch', activeTool: SketchToolId | null = null) => {
    const onTool = vi.fn();
    renderUI(
      <SketchToolbar
        density={density}
        activeTool={activeTool}
        onTool={onTool}
        construction={false}
        onToggleConstruction={() => {}}
        onFinish={() => {}}
        shortcuts={false}
      />,
    );
    return onTool;
  };

  it('shows a text label under every tool, including Dimension', () => {
    mount('touch');
    const labels = screen.getAllByTestId('tool-label').map((l) => l.textContent);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Line',
        'Rectangle',
        'Circle',
        'Arc',
        'Slot',
        'Polygon',
        'Point',
        'Dimension',
        'Edit',
      ]),
    );
    expect(screen.getByRole('button', { name: 'Dimension' })).toHaveTextContent('Dimension');
  });

  it('has no labels in compact density', () => {
    mount('compact');
    expect(screen.queryAllByTestId('tool-label')).toHaveLength(0);
  });

  it('tapping the active tool deselects it, with or without variants', async () => {
    const a = mount('touch', 'line');
    await userEvent.click(screen.getAllByRole('button', { name: 'Line' })[0] as HTMLElement);
    expect(a).toHaveBeenCalledWith(null);
  });
});
