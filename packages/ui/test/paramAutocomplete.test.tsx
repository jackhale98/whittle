import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ExpressionInput, type ParamLinks, ParamLinksContext } from '../src';
import { registerParamDrop } from '../src/logic/paramDrag';
import { DimensionLabel } from '../src/sketch/DimensionLabel';
import { makeEvaluator, renderUI } from './helpers';

const params = [
  { name: 'width', expr: '80mm' },
  { name: 'wall', expr: '2.5mm' },
  { name: 'hole_d', expr: 'width/10' },
  { name: 'tilt', expr: '15deg' },
];
const evaluate = makeEvaluator(params);
const evalLen = (e: string) => evaluate(e, 'length');
const infos = [
  { name: 'width', value: '80 mm' },
  { name: 'wall', value: '2.5 mm' },
  { name: 'hole_d', value: '8 mm' },
  { name: 'tilt', value: '15°' },
];

function Harness({
  links = { params: infos },
  initial = '10mm',
  onCommit,
  onPreview,
  onCancel,
}: {
  links?: ParamLinks;
  initial?: string;
  onCommit?(e: string): void;
  onPreview?(e: string): void;
  onCancel?(): void;
}) {
  const [v, setV] = useState(initial);
  return (
    <ParamLinksContext.Provider value={links}>
      <ExpressionInput
        label="Depth"
        value={v}
        evaluate={evalLen}
        unitHint="mm"
        onPreview={onPreview}
        onCancel={onCancel}
        onCommit={(e) => {
          setV(e);
          onCommit?.(e);
        }}
      />
    </ParamLinksContext.Provider>
  );
}

/** Renders and waits for the lazily loaded parameter assist (its fx button appears). */
async function renderReady(ui: React.ReactElement) {
  const r = renderUI(ui);
  await screen.findByTestId('param-fx');
  return r;
}

const field = () => screen.getByLabelText('Depth') as HTMLInputElement;
const options = () => screen.queryAllByRole('option');

describe('parameter autocomplete (ARIA combobox)', () => {
  it('offers matching parameters with their values while an identifier is typed', async () => {
    await renderReady(<Harness />);
    await userEvent.click(field());
    await userEvent.keyboard('w');
    const list = await screen.findByRole('listbox', { name: 'Parameters' });
    const names = within(list)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).toEqual(['width80 mm', 'wall2.5 mm']);
    // The field is a combobox while the list is open, wired to the list and the active option.
    const box = screen.getByRole('combobox', { name: 'Depth' });
    expect(box).toHaveAttribute('aria-expanded', 'true');
    expect(box).toHaveAttribute('aria-controls', list.id);
    expect(box).toHaveAttribute('aria-activedescendant', options()[0]?.id ?? '?');
  });

  it('is a plain textbox, with no list, for number entry', async () => {
    await renderReady(<Harness />);
    await userEvent.click(field());
    await userEvent.keyboard('25.4mm');
    expect(options()).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: 'Depth' })).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(field()).toHaveValue('25.4mm');
  });

  it('never offers parameters where a unit is expected', async () => {
    await renderReady(<Harness />);
    await userEvent.click(field());
    await userEvent.keyboard('3 w');
    expect(options()).toHaveLength(0);
  });

  it('arrow keys move, Enter accepts, and the accepted name previews', async () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    await renderReady(<Harness onPreview={onPreview} onCommit={onCommit} />);
    await userEvent.click(field());
    await userEvent.keyboard('w');
    await screen.findByRole('listbox');
    await userEvent.keyboard('{ArrowDown}');
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    expect(field()).toHaveValue('wall');
    expect(onPreview).toHaveBeenLastCalledWith('wall');
    expect(onCommit).not.toHaveBeenCalled(); // accepting is not committing
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith('wall');
  });

  it('ArrowUp wraps to the last option; Tab accepts', async () => {
    await renderReady(<Harness />);
    await userEvent.click(field());
    await userEvent.keyboard('w');
    await screen.findByRole('listbox');
    await userEvent.keyboard('{ArrowUp}');
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.tab();
    expect(field()).toHaveValue('wall');
    expect(field()).toHaveFocus(); // Tab accepted, it did not leave the field
  });

  it('inserts at the caret in the middle of a formula, keeping the rest', async () => {
    await renderReady(<Harness initial="2*  + 5mm" />);
    const el = field();
    await userEvent.click(el);
    el.setSelectionRange(3, 3);
    fireEvent.select(el);
    await userEvent.keyboard('h');
    await screen.findByRole('listbox');
    await userEvent.keyboard('{Enter}');
    expect(field()).toHaveValue('2* hole_d + 5mm');
    await waitFor(() => expect(el.selectionStart).toBe(9));
  });

  it('replaces only the identifier under the caret', async () => {
    await renderReady(<Harness initial="2*wi + 5mm" />);
    const el = field();
    await userEvent.click(el);
    el.setSelectionRange(4, 4);
    fireEvent.select(el);
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}'); // full list
    await screen.findByRole('listbox');
    await userEvent.click(screen.getByRole('option', { name: /^width/ }));
    expect(field()).toHaveValue('2*width + 5mm');
    await waitFor(() => expect(el.selectionStart).toBe(7));
  });

  it('Esc closes the list and keeps the edit; a second Esc reverts it', async () => {
    const onCancel = vi.fn();
    await renderReady(<Harness onCancel={onCancel} />);
    await userEvent.click(field());
    await userEvent.keyboard('wi');
    await screen.findByRole('listbox');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(field()).toHaveValue('wi');
    expect(onCancel).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(field()).toHaveValue('10mm');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Enter on an already complete name commits instead of re-accepting', async () => {
    const onCommit = vi.fn();
    await renderReady(<Harness onCommit={onCommit} />);
    await userEvent.click(field());
    await userEvent.keyboard('wall{Enter}');
    expect(onCommit).toHaveBeenCalledWith('wall');
  });

  it('"=" at the start opens the full list and is dropped', async () => {
    await renderReady(<Harness />);
    await userEvent.click(field());
    await userEvent.keyboard('=');
    await screen.findByRole('listbox');
    expect(options()).toHaveLength(4);
    expect(field()).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(field()).toHaveValue('hole_d');
  });

  it('the fx button and Alt+Down open the full list; the button toggles', async () => {
    await renderReady(<Harness initial="width" />);
    const fx = await screen.findByRole('button', { name: 'Parameters for Depth' });
    await userEvent.click(fx);
    await screen.findByRole('listbox');
    expect(options()).toHaveLength(4);
    expect(fx).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(fx);
    expect(screen.queryByRole('listbox')).toBeNull();
    // Keyboard alternative.
    field().focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
  });

  it('the fx list replaces the selected value, not the caret word', async () => {
    await renderReady(<Harness initial="10mm" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Parameters for Depth' }));
    await userEvent.click(await screen.findByRole('option', { name: /^wall/ }));
    expect(field()).toHaveValue('wall');
  });

  it('without parameters there is no list, no fx and the arrows still nudge', async () => {
    renderUI(<Harness links={{ params: [] }} />);
    expect(screen.queryByRole('button', { name: /Parameters for/ })).toBeNull();
    await userEvent.click(field());
    await userEvent.keyboard('{ArrowUp}');
    expect(field()).toHaveValue('11mm');
  });

  it('arrow keys nudge a number when the list is closed', async () => {
    await renderReady(<Harness />);
    await userEvent.click(field());
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(field()).toHaveValue('12mm');
  });

  it('a field that sets paramLinks="off" is a plain field', async () => {
    renderUI(
      <ParamLinksContext.Provider value={{ params: infos }}>
        <ExpressionInput
          label="Plain"
          value=""
          evaluate={evalLen}
          paramLinks="off"
          onCommit={() => {}}
        />
      </ParamLinksContext.Provider>,
    );
    expect(screen.queryByRole('button', { name: /Parameters for/ })).toBeNull();
    await userEvent.click(screen.getByLabelText('Plain'));
    await userEvent.keyboard('w');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('make parameter from a value', () => {
  async function setup(make: ParamLinks['make'] = () => undefined) {
    const makeDone = vi.fn();
    const onCommit = vi.fn();
    const calls: string[] = [];
    const links: ParamLinks = {
      params: infos,
      make: (name, expr) => {
        calls.push('make');
        return make?.(name, expr);
      },
      makeDone: () => {
        calls.push('done');
        makeDone();
      },
    };
    await renderReady(
      <Harness
        links={links}
        initial="12"
        onCommit={(e) => {
          calls.push(`commit:${e}`);
          onCommit(e);
        }}
      />,
    );
    return { calls, onCommit, makeDone };
  }
  async function openForm() {
    await userEvent.click(await screen.findByRole('button', { name: 'Parameters for Depth' }));
    await userEvent.click(await screen.findByRole('option', { name: /Make parameter from/ }));
    return await screen.findByRole('textbox', { name: 'Name of the new parameter' });
  }

  it('offers the action only for a valid value that is not already a parameter', async () => {
    await renderReady(<Harness links={{ params: infos, make: () => undefined }} initial="width" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Parameters for Depth' }));
    await screen.findByRole('listbox');
    expect(screen.queryByTestId('param-make-option')).toBeNull();
  });

  it('suggests a name, creates the parameter, then commits the name, in that order', async () => {
    const { calls, onCommit, makeDone } = await setup();
    const name = await openForm();
    expect(name).toHaveValue('depth');
    expect(screen.getByText('= 12 mm')).toBeInTheDocument(); // a bare number takes the unit
    await userEvent.clear(name);
    await userEvent.type(name, 'depth_1{Enter}');
    expect(calls).toEqual(['make', 'commit:depth_1', 'done']);
    expect(onCommit).toHaveBeenCalledWith('depth_1');
    expect(makeDone).toHaveBeenCalledTimes(1);
    expect(field()).toHaveValue('depth_1');
    expect(screen.queryByRole('textbox', { name: 'Name of the new parameter' })).toBeNull();
  });

  it('passes the new parameter its expression', async () => {
    const make = vi.fn<NonNullable<ParamLinks['make']>>(() => undefined);
    await setup(make);
    const name = await openForm();
    await userEvent.type(name, 'x{Enter}');
    expect(make).toHaveBeenCalledWith('depthx', '12 mm');
  });

  it('validates the name against existing names, units and reserved words', async () => {
    const { calls } = await setup();
    const name = await openForm();
    for (const [bad, msg] of [
      ['width', /already used/],
      ['mm', /unit/],
      ['sin', /built-in/],
      ['2x', /letters/],
      ['', /name/],
    ] as const) {
      await userEvent.clear(name);
      if (bad) await userEvent.type(name, bad);
      expect(await screen.findByRole('alert')).toHaveTextContent(msg);
      await userEvent.keyboard('{Enter}');
    }
    expect(calls).toEqual([]);
    expect(screen.getByRole('button', { name: 'Make parameter' })).toBeDisabled();
  });

  it("shows the host's refusal and keeps the form open", async () => {
    const { onCommit } = await setup(() => 'Could not add it');
    const name = await openForm();
    await userEvent.type(name, '{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not add it');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Esc cancels back to the field without creating anything', async () => {
    const { calls } = await setup();
    const name = await openForm();
    await userEvent.type(name, '{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Name of the new parameter' })).toBeNull();
    expect(calls).toEqual([]);
    expect(field()).toHaveValue('12');
    expect(field()).toHaveFocus();
  });
});

describe('the link is visible', () => {
  it('a field holding a parameter shows an fx badge and names it for screen readers', async () => {
    await renderReady(<Harness initial="width/2" />);
    expect(await screen.findByTestId('param-link-badge')).toBeInTheDocument();
    expect(field()).toHaveAccessibleDescription('Linked to parameter width');
    expect(screen.getByTestId('expr-readout')).toHaveTextContent('= 40 mm');
  });
  it('a plain number has no badge', async () => {
    await renderReady(<Harness initial="12mm" />);
    expect(screen.queryByTestId('param-link-badge')).toBeNull();
  });
});

/** A real pointer drag through the registry, ending over `over`. */
async function dragOnto(over: Element, name: string, id: number) {
  const { beginParamDrag } = await import('../src/logic/paramDrag');
  document.elementsFromPoint = () => [over];
  act(() => {
    beginParamDrag({ clientX: 0, clientY: 0, pointerId: id }, name);
    window.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: id, clientX: 20, clientY: 0 }),
    );
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: id, clientX: 20, clientY: 0 }));
  });
}

describe('drop a parameter on a field', () => {
  it('registers the field as a target and commits the dropped name', async () => {
    const onCommit = vi.fn();
    await renderReady(<Harness onCommit={onCommit} />);
    expect(field().closest('[data-param-drop]')).toBeTruthy();
    await dragOnto(field(), 'wall', 7);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('wall');
    expect(field()).toHaveValue('wall');
  });

  it('puts a parameter of the wrong dimension in the field with its error instead', async () => {
    const onCommit = vi.fn();
    await renderReady(<Harness onCommit={onCommit} />);
    await dragOnto(field(), 'tilt', 8);
    expect(onCommit).not.toHaveBeenCalled();
    expect(field()).toHaveValue('tilt');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('DimensionLabel: link and drop', () => {
  const dimEval = makeEvaluator(params);
  const ev = (e: string) => dimEval(e, 'length');

  it('shows "name = value" for an exact parameter and the name in the accessible name', () => {
    renderUI(
      <ParamLinksContext.Provider value={{ params: infos }}>
        <DimensionLabel x={50} y={50} kind="diameter" expr="width" driving evaluate={ev} />
      </ParamLinksContext.Provider>,
    );
    const btn = screen.getByRole('button', { name: /Dimension: Ø80, set by parameter width/ });
    expect(btn).toHaveTextContent('width = Ø80');
    expect(btn).toHaveAttribute('data-param', 'width');
  });

  it('shows an fx badge for a formula that uses parameters', () => {
    renderUI(
      <ParamLinksContext.Provider value={{ params: infos }}>
        <DimensionLabel x={50} y={50} kind="length" expr="width/2" driving evaluate={ev} />
      </ParamLinksContext.Provider>,
    );
    const btn = screen.getByRole('button', { name: /set by the parameters width/ });
    expect(within(btn).getByTestId('dimension-param')).toHaveTextContent('fx');
  });

  it('a plain value shows no link', () => {
    renderUI(
      <ParamLinksContext.Provider value={{ params: infos }}>
        <DimensionLabel x={50} y={50} kind="length" expr="30" driving evaluate={ev} />
      </ParamLinksContext.Provider>,
    );
    expect(screen.queryByTestId('dimension-param')).toBeNull();
  });

  it('a dropped parameter sets the dimension; a driven label is not a target', async () => {
    const onDropParam = vi.fn();
    renderUI(
      <DimensionLabel
        x={50}
        y={50}
        kind="length"
        expr="30"
        driving
        evaluate={ev}
        onDropParam={onDropParam}
      />,
    );
    const btn = screen.getByRole('button', { name: /Dimension: 30/ });
    expect(btn).toHaveAttribute('data-param-drop');
    await dragOnto(btn, 'width', 11);
    expect(onDropParam).toHaveBeenCalledWith('width');
    onDropParam.mockClear();
    await dragOnto(btn, 'tilt', 12); // an angle on a length: refused
    expect(onDropParam).not.toHaveBeenCalled();
  });

  it('register/unregister leaves no target behind', () => {
    const el = document.createElement('div');
    const off = registerParamDrop(el, () => {});
    expect(el).toHaveAttribute('data-param-drop');
    off();
    expect(el).not.toHaveAttribute('data-param-drop');
  });
});

describe('dimension editor autocomplete does not end the edit', () => {
  it('Enter that accepts a completion keeps the editor open', async () => {
    const dimEval = makeEvaluator(params);
    const onCommit = vi.fn();
    renderUI(
      <ParamLinksContext.Provider value={{ params: infos }}>
        <DimensionLabel
          x={50}
          y={50}
          kind="length"
          expr="30"
          driving
          autoEdit
          evaluate={(e) => dimEval(e, 'length')}
          onCommit={onCommit}
        />
      </ParamLinksContext.Provider>,
    );
    await screen.findByRole('textbox', { name: 'length dimension' });
    await userEvent.keyboard('wi');
    await screen.findByRole('listbox');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('textbox', { name: 'length dimension' })).toHaveValue('width');
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('width'));
  });
});
