import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sampleFeatures } from '../harness/fixtures';
import {
  AppShell,
  BottomSheet,
  bracketTutorial,
  ContextBubble,
  ExpressionInput,
  FeatureTree,
  MeasurePanel,
  ParamNamesContext,
  PartsPanel,
  SectionPanel,
  type SheetSnap,
  ToolRail,
  TutorialCoach,
  ValueChip,
} from '../src';
import { makeEvaluator, renderUI } from './helpers';

afterEach(() => vi.useRealTimers());

// jsdom has no layout: give every element a size so anchored UI (bubble, chip, keypad) can place.
const sizeProps = ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  for (const k of sizeProps) {
    saved.set(k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k));
    Object.defineProperty(HTMLElement.prototype, k, {
      configurable: true,
      get() {
        return { offsetWidth: 240, offsetHeight: 64, clientWidth: 1000, clientHeight: 800 }[k];
      },
    });
  }
});
afterAll(() => {
  for (const k of sizeProps) {
    const d = saved.get(k);
    if (d) Object.defineProperty(HTMLElement.prototype, k, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});

/* ------------------------------------------------------------------ bottom sheet */

function Sheet({ initial = 'peek' as SheetSnap, spy = vi.fn() }) {
  const [snap, setSnap] = useState<SheetSnap>(initial);
  return (
    <div style={{ height: 800 }}>
      <BottomSheet
        snap={snap}
        onSnapChange={(s) => {
          spy(s);
          setSnap(s);
        }}
        peek={68}
        handleLabel="History"
        testId="sheet"
      >
        <button type="button">Inside</button>
      </BottomSheet>
    </div>
  );
}

describe('BottomSheet', () => {
  it('handle is a button that toggles peek <-> half and reports expanded state', async () => {
    const spy = vi.fn();
    renderUI(<Sheet spy={spy} />);
    const handle = screen.getByRole('button', { name: 'History, expand' });
    expect(handle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('sheet')).toHaveAttribute('data-snap', 'peek');
    await userEvent.click(handle);
    expect(spy).toHaveBeenLastCalledWith('half');
    expect(screen.getByRole('button', { name: 'History, collapse' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'History, collapse' }));
    expect(spy).toHaveBeenLastCalledWith('peek');
  });

  it('arrow keys step the snaps, Home/End jump, Escape collapses', () => {
    const spy = vi.fn();
    renderUI(<Sheet spy={spy} />);
    const handle = () => screen.getByRole('button', { name: /History/ });
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(screen.getByTestId('sheet')).toHaveAttribute('data-snap', 'half');
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(screen.getByTestId('sheet')).toHaveAttribute('data-snap', 'full');
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    expect(screen.getByTestId('sheet')).toHaveAttribute('data-snap', 'half');
    fireEvent.keyDown(handle(), { key: 'End' });
    expect(screen.getByTestId('sheet')).toHaveAttribute('data-snap', 'full');
    fireEvent.keyDown(handle(), { key: 'Escape' });
    expect(screen.getByTestId('sheet')).toHaveAttribute('data-snap', 'peek');
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(spy).toHaveBeenCalledTimes(5); // Home at peek is a no-op
  });

  it('collapsed content is inert; opening makes it reachable; changes are announced', async () => {
    renderUI(<Sheet />);
    const inert = () => screen.getByText('Inside').closest('[inert]');
    expect(inert()).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'History, expand' }));
    expect(inert()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('History sheet half open');
  });

  it('describes how to resize for assistive tech', () => {
    renderUI(<Sheet />);
    const handle = screen.getByRole('button', { name: 'History, expand' });
    expect(handle).toHaveAccessibleDescription(/arrow keys/);
  });
});

/* ------------------------------------------------------------------ context bubble */

describe('ContextBubble', () => {
  const actions = [
    { id: 'a', label: 'Sketch', onSelect: vi.fn() },
    { id: 'b', label: 'Extrude', onSelect: vi.fn() },
    { id: 'c', label: 'Hide', onSelect: vi.fn() },
    { id: 'd', label: 'Delete', tone: 'danger' as const, onSelect: vi.fn() },
    { id: 'e', label: 'Ignored', onSelect: vi.fn() },
  ];
  it('shows at most four actions in a labelled toolbar and runs them', async () => {
    renderUI(<ContextBubble anchor={{ x: 100, y: 100 }} actions={actions} label="Face actions" />);
    const bar = screen.getByRole('toolbar', { name: 'Face actions', hidden: true });
    expect(within(bar).getAllByRole('button', { hidden: true })).toHaveLength(4);
    fireEvent.click(within(bar).getByText('Extrude'));
    expect(actions[1]?.onSelect).toHaveBeenCalled();
  });
  it('is hidden without an anchor', () => {
    renderUI(<ContextBubble anchor={null} actions={actions} />);
    expect(screen.getByTestId('context-bubble')).not.toBeVisible();
  });
  it('Escape inside dismisses', () => {
    const onDismiss = vi.fn();
    renderUI(<ContextBubble anchor={{ x: 1, y: 1 }} actions={actions} onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByText('Sketch'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ tool rail */

describe('ToolRail', () => {
  const enabled = ['sketch', 'extrude', 'fillet', 'measure'] as const;
  it('has four groups; multi-tool groups open a flyout, single-tool groups act directly', async () => {
    const onTool = vi.fn();
    renderUI(<ToolRail enabledTools={enabled} onTool={onTool} />);
    expect(screen.getByRole('button', { name: 'Sketch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Solid tools' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Modify tools' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inspect tools' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sketch' }));
    expect(onTool).toHaveBeenLastCalledWith('sketch');

    const solid = screen.getByRole('button', { name: 'Solid tools' });
    expect(solid).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(solid);
    expect(solid).toHaveAttribute('aria-expanded', 'true');
    const flyout = screen.getByRole('group', { name: 'Solid tools' });
    // not wired -> disabled with a hint and no callback
    await userEvent.click(within(flyout).getByRole('button', { name: /Revolve/ }));
    expect(onTool).not.toHaveBeenLastCalledWith('revolve');
    await userEvent.click(within(flyout).getByRole('button', { name: /Extrude/ }));
    expect(onTool).toHaveBeenLastCalledWith('extrude');
    expect(screen.queryByRole('group', { name: 'Solid tools' })).toBeNull();
  });
  it('Escape closes the flyout and returns focus to its group', async () => {
    renderUI(<ToolRail enabledTools={enabled} />);
    const modify = screen.getByRole('button', { name: 'Modify tools' });
    await userEvent.click(modify);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Modify tools' })).toBeNull();
    expect(modify).toHaveFocus();
  });
  it('the group shows the active tool as pressed', () => {
    renderUI(<ToolRail enabledTools={enabled} activeTool="extrude" />);
    expect(screen.getByRole('button', { name: 'Solid tools' })).toHaveAttribute('data-active');
  });
});

/* ------------------------------------------------------------------ value chip */

describe('ValueChip', () => {
  const evaluate = makeEvaluator([]);
  const ev = (e: string) => evaluate(e, 'length');
  const base = { point: { x: 200, y: 200 }, value: '12mm', display: '12 mm', label: 'Distance' };
  it('while dragging it is a non-interactive label', () => {
    renderUI(<ValueChip {...base} dragging onCommit={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('value-chip')).toHaveClass('pointer-events-none');
    expect(screen.getByText('12 mm')).toBeInTheDocument();
  });
  it('tap to type an exact value with units and expressions, Enter commits', async () => {
    const onCommit = vi.fn();
    renderUI(<ValueChip {...base} dragging={false} evaluate={ev} onCommit={onCommit} />);
    await userEvent.click(screen.getByRole('button', { name: /Distance 12 mm. Tap to type/ }));
    const field = await screen.findByRole('textbox', { name: 'Distance' });
    expect(field).toHaveFocus();
    await userEvent.keyboard('2 * 1in{Enter}');
    expect(onCommit).toHaveBeenCalledWith('2 * 1in');
  });
  it('Escape abandons typing', async () => {
    const onCancel = vi.fn();
    renderUI(
      <ValueChip
        {...base}
        dragging={false}
        evaluate={ev}
        onCommit={() => {}}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Tap to type/ }));
    await screen.findByRole('textbox', { name: 'Distance' });
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

/* ------------------------------------------------------------------ keypad extras */

describe('keypad parameter row', () => {
  it('offers the document parameters as one-tap keys', async () => {
    const evaluate = makeEvaluator([{ name: 'width', expr: '60mm' }]);
    renderUI(
      <ParamNamesContext.Provider value={['width', 'wall']}>
        <ExpressionInput
          label="Depth"
          value="2"
          keypad="always"
          evaluate={(e) => evaluate(e, 'length')}
          onCommit={() => {}}
        />
      </ParamNamesContext.Provider>,
    );
    const input = screen.getByRole('textbox', { name: 'Depth' });
    await userEvent.click(input);
    const pad = await screen.findByRole('group', { name: 'Numeric keypad' });
    const row = within(pad).getByRole('group', { name: 'Parameters' });
    expect(within(row).getAllByRole('button')).toHaveLength(2);
    (input as HTMLInputElement).setSelectionRange(1, 1);
    fireEvent.click(within(row).getByRole('button', { name: 'parameter width' }));
    expect(input).toHaveValue('2 * width');
    // parentheses and operators live on the expression row
    fireEvent.click(within(pad).getByRole('button', { name: 'open parenthesis' }));
    expect(input).toHaveValue('2 * width(');
  });
  it('the OS keyboard toggle can hand back to the keypad', async () => {
    renderUI(<ExpressionInput label="Depth" value="1" keypad="always" onCommit={() => {}} />);
    const input = screen.getByRole('textbox', { name: 'Depth' });
    await userEvent.click(input);
    await screen.findByRole('group', { name: 'Numeric keypad' });
    fireEvent.click(screen.getByRole('button', { name: 'Use the system keyboard' }));
    await waitFor(() => expect(input).toHaveAttribute('inputmode', 'text'));
    fireEvent.click(screen.getByRole('button', { name: 'Use the numeric keypad' }));
    await screen.findByRole('group', { name: 'Numeric keypad' });
    expect(input).toHaveAttribute('inputmode', 'none');
  });
});

/* ------------------------------------------------------------------ tutorial */

describe('TutorialCoach', () => {
  const props = { steps: bracketTutorial, title: 'Make a bracket', onSkip: vi.fn() };
  it('shows the current step with progress, a hint and Skip; never a Next button', async () => {
    const onSkip = vi.fn();
    renderUI(<TutorialCoach {...props} onSkip={onSkip} state={{ index: 2, status: 'running' }} />);
    const card = await screen.findByRole('region', {
      name: 'Make a bracket, step 3 of 8',
      hidden: true,
    });
    expect(
      within(card).getByRole('heading', { name: 'Give it an exact size' }),
    ).toBeInTheDocument();
    expect(within(card).getByRole('progressbar', { name: 'Tutorial progress' })).toHaveAttribute(
      'aria-valuenow',
      '3',
    );
    expect(within(card).queryByRole('button', { name: /next|continue/i })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Skip tutorial' }));
    expect(onSkip).toHaveBeenCalled();
  });
  it('is non-modal: no dialog role, no scrim that intercepts the page', async () => {
    renderUI(<TutorialCoach {...props} state={{ index: 0, status: 'running' }} />);
    await screen.findByTestId('tutorial-card');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('tutorial')).toHaveClass('pointer-events-none');
  });
  it('renders nothing once skipped and a closing card when done', async () => {
    const { rerender } = renderUI(
      <TutorialCoach {...props} state={{ index: 7, status: 'skipped' }} />,
    );
    expect(screen.queryByTestId('tutorial')).toBeNull();
    rerender(<TutorialCoach {...props} state={{ index: 7, status: 'done' }} />);
    expect(await screen.findByText('Your first part is done')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ phone panels */

describe('phone panels', () => {
  it('MeasurePanel shows the latest reading, targets and earlier readings', async () => {
    const onRemove = vi.fn();
    renderUI(
      <MeasurePanel
        measurements={[
          { length: 60 },
          { distance: { value: 42.5, a: [0, 0, 0], b: [30, 25.5, 17] }, angle: Math.PI / 2 },
        ]}
        targets={[
          { id: 't1', label: 'Face · Top' },
          { id: 't2', label: 'Edge 4' },
        ]}
        onRemoveTarget={onRemove}
        units="mm"
      />,
    );
    const latest = screen.getByTestId('measure-reading');
    expect(latest).toHaveAttribute('data-kind', 'distance');
    expect(within(latest).getByText('42.50')).toBeInTheDocument();
    expect(within(latest).getByText('ΔX')).toBeInTheDocument();
    expect(screen.getByTestId('measure-history')).toHaveTextContent('Length60.00 mm');
    expect(within(screen.getByTestId('measure-targets')).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Edge 4' }));
    expect(onRemove).toHaveBeenCalledWith('t2');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Distance 42.50 millimetres, angle 90.00 degrees',
    );
    expect(screen.getByTestId('measure-extra')).toHaveTextContent('Angle90.00 °');
  });
  it('MeasurePanel empty state', () => {
    renderUI(<MeasurePanel measurements={[]} />);
    expect(screen.getByText(/Tap two points/)).toBeInTheDocument();
  });

  it('SectionPanel: toggle, axis, slider, exact value, flip', async () => {
    const calls = {
      on: vi.fn(),
      axis: vi.fn(),
      offset: vi.fn(),
      flip: vi.fn(),
    };
    renderUI(
      <SectionPanel
        enabled
        onEnabledChange={calls.on}
        axis="z"
        onAxisChange={calls.axis}
        offset={12}
        range={{ min: 0, max: 60 }}
        onOffsetChange={calls.offset}
        flipped={false}
        onFlippedChange={calls.flip}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Section view' }));
    expect(calls.on).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('radio', { name: 'Y' }));
    expect(calls.axis).toHaveBeenCalledWith('y');
    const slider = screen.getByRole('slider', { name: 'Section offset' });
    expect(slider).toHaveAttribute('aria-valuetext', '12.00mm');
    fireEvent.change(slider, { target: { value: '30' } });
    expect(calls.offset).toHaveBeenLastCalledWith(30);
    const field = screen.getByRole('textbox', { name: 'Section offset value' });
    await userEvent.click(field);
    await userEvent.keyboard('0.5in{Enter}');
    expect(calls.offset).toHaveBeenLastCalledWith(12.7);
    fireEvent.click(screen.getByRole('switch', { name: 'Flip side' }));
    expect(calls.flip).toHaveBeenCalledWith(true);
  });
  it('SectionPanel face axis shows the picked face', () => {
    renderUI(
      <SectionPanel
        enabled={false}
        onEnabledChange={() => {}}
        axis="face"
        faceLabel="Face · Top"
        onAxisChange={() => {}}
        offset={0}
        range={{ min: 0, max: 10 }}
        onOffsetChange={() => {}}
        flipped={false}
        onFlippedChange={() => {}}
      />,
    );
    expect(screen.getByTestId('section-face')).toHaveTextContent('Face · Top');
  });

  it('PartsPanel selects and toggles visibility', () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    renderUI(
      <PartsPanel
        parts={[
          { id: 'B1', name: 'Bracket', visible: true },
          { id: 'B2', name: 'Plate', visible: false },
        ]}
        selectedId="B1"
        onSelect={onSelect}
        onToggleVisible={onToggle}
      />,
    );
    expect(screen.getByRole('button', { name: 'Bracket' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Plate' }));
    expect(onSelect).toHaveBeenCalledWith('B2');
    fireEvent.click(screen.getByRole('button', { name: 'Show Plate' }));
    expect(onToggle).toHaveBeenCalledWith('B2', true);
  });

  it('PhoneShell wires the Measure and Section tabs to the real panels', async () => {
    const base = {
      documentName: 'Doc',
      kernelStatus: { state: 'idle' } as const,
      viewport: <div />,
    };
    renderUI(
      <AppShell
        tier="phone"
        {...base}
        measure={{ measurements: [{ angle: Math.PI / 2 }] }}
        section={{
          enabled: true,
          onEnabledChange: () => {},
          axis: 'x',
          onAxisChange: () => {},
          offset: 5,
          range: { min: 0, max: 10 },
          onOffsetChange: () => {},
          flipped: false,
          onFlippedChange: () => {},
        }}
      />,
    );
    const tabs = screen.getByRole('group', { name: 'Viewer tools' });
    expect(
      within(tabs)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Parts', 'Params', 'Measure', 'Section', 'Export']);
    fireEvent.click(within(tabs).getByRole('button', { name: 'Measure' }));
    expect(await screen.findByTestId('measure-reading')).toHaveTextContent('90.00');
    expect(screen.getByTestId('tools-sheet')).toHaveAttribute('data-snap', 'half');
    fireEvent.click(within(tabs).getByRole('button', { name: 'Section' }));
    expect(await screen.findByTestId('section-panel')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ long press */

describe('long-press on tree rows', () => {
  it('opens the row menu after 500 ms of touch hold, but not on a tap or a drag', () => {
    vi.useFakeTimers();
    renderUI(
      <FeatureTree
        features={sampleFeatures}
        onRename={() => {}}
        onSuppress={() => {}}
        onDelete={() => {}}
      />,
    );
    const row = screen.getAllByRole('treeitem')[1] as HTMLElement;
    const touch = (type: string, x = 40, y = 40) =>
      fireEvent(
        row,
        Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }), {
          pointerType: 'touch',
          pointerId: 1,
        }),
      );
    // tap
    touch('pointerdown');
    act(() => vi.advanceTimersByTime(200));
    touch('pointerup');
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole('menu')).toBeNull();
    // drag
    touch('pointerdown');
    touch('pointermove', 40, 90);
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole('menu')).toBeNull();
    // hold
    touch('pointerdown');
    act(() => vi.advanceTimersByTime(520));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
