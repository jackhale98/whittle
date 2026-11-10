import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ParamsTable, type ParamUse } from '../src';
import { makeEvaluator, renderUI } from './helpers';

const params = [
  { id: 'P1', name: 'width', expr: '80mm' },
  { id: 'P2', name: 'wall', expr: '2.5mm' },
  { id: 'P3', name: 'unused', expr: '1mm' },
];
const evaluate = makeEvaluator(params);
const uses: Record<string, ParamUse[]> = {
  P1: [
    { key: 'a', kind: 'feature', label: 'Extrude 1', detail: 'depth', featureId: 'F1' },
    {
      key: 'b',
      kind: 'dimension',
      label: 'Sketch 1',
      detail: 'diameter dimension 1',
      featureId: 'F0',
      constraintId: 'C1',
    },
    { key: 'c', kind: 'param', label: 'wall', paramId: 'P2' },
  ],
  P2: [],
  P3: [],
};

function renderTable(extra: Partial<React.ComponentProps<typeof ParamsTable>> = {}) {
  return renderUI(<ParamsTable params={params} evaluate={evaluate} usedBy={uses} {...extra} />);
}
const row = (name: string) => screen.getByRole('listitem', { name: `Parameter ${name}` });

describe('ParamsTable: used by', () => {
  it('shows the count, collapsed, and a muted note when nothing uses a parameter', () => {
    renderTable();
    const btn = within(row('width')).getByRole('button', { name: 'Used by 3' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(within(row('unused')).getByRole('button', { name: 'Not used yet' })).toBeDisabled();
  });

  it('expands to the list of features, dimensions and parameters', async () => {
    renderTable();
    const btn = within(row('width')).getByRole('button', { name: 'Used by 3' });
    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    const list = within(row('width')).getByRole('list', { name: 'Used by, width' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Extrude 1depth', 'Sketch 1diameter dimension 1', 'wall']);
    expect(btn).toHaveAttribute('aria-controls', list.id);
    await userEvent.click(btn);
    expect(within(row('width')).queryByRole('list', { name: 'Used by, width' })).toBeNull();
  });

  it('choosing an entry reports it (a feature, a dimension); a parameter focuses its row', async () => {
    const onSelectUse = vi.fn();
    renderTable({ onSelectUse });
    await userEvent.click(within(row('width')).getByRole('button', { name: 'Used by 3' }));
    await userEvent.click(screen.getByRole('button', { name: /Extrude 1/ }));
    expect(onSelectUse).toHaveBeenLastCalledWith(expect.objectContaining({ featureId: 'F1' }));
    await userEvent.click(screen.getByRole('button', { name: /Sketch 1/ }));
    expect(onSelectUse).toHaveBeenLastCalledWith(
      expect.objectContaining({ featureId: 'F0', constraintId: 'C1' }),
    );
    onSelectUse.mockClear();
    await userEvent.click(within(row('width')).getByRole('button', { name: 'wall' }));
    expect(onSelectUse).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Name of parameter wall')).toHaveFocus();
  });

  it('the delete warning counts the uses', async () => {
    renderTable({ onRemove: vi.fn() });
    await userEvent.click(screen.getByRole('button', { name: 'Delete width' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Used by 3 expressions');
  });

  it('without usedBy the table is as before', () => {
    renderUI(<ParamsTable params={params} evaluate={evaluate} />);
    expect(screen.queryByRole('button', { name: /Used by|Not used/ })).toBeNull();
  });
});

describe('ParamsTable: drag a parameter to use it', () => {
  it('the handle has an accessible name and description, and a click explains the keyboard way', async () => {
    renderTable();
    const handle = within(row('width')).getByRole('button', { name: 'Use width' });
    expect(handle).toHaveAccessibleDescription(/Drag onto a dimension/);
    await userEvent.click(handle);
    expect(screen.getByTestId('param-hint')).toHaveTextContent(/Alt\+Down/);
  });

  it('dragging the handle shows a chip and drops on a target under the pointer', async () => {
    const { registerParamDrop } = await import('../src/logic/paramDrag');
    renderTable();
    const target = document.createElement('div');
    document.body.append(target);
    const drop = vi.fn();
    registerParamDrop(target, drop);
    document.elementsFromPoint = () => [target];
    const handle = within(row('wall')).getByRole('button', { name: 'Use wall' });

    const init = (x: number) => ({ pointerId: 3, clientX: x, clientY: 10, bubbles: true });
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { ...init(0), button: 0 }));
      window.dispatchEvent(new PointerEvent('pointermove', init(40)));
    });
    expect(screen.getByTestId('param-drag-ghost')).toHaveTextContent('wall');
    expect(screen.getByTestId('param-drag-ghost')).toHaveAttribute('data-over');
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', init(40)));
    });
    expect(drop).toHaveBeenCalledWith('wall');
    expect(screen.queryByTestId('param-drag-ghost')).toBeNull();
    target.remove();
  });

  it('the Params tab own expression fields are not drop targets (no cycles by accident)', () => {
    renderTable();
    expect(screen.getByLabelText('Expression for width').closest('[data-param-drop]')).toBeNull();
  });
});
