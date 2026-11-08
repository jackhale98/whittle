import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ExpressionInput, nudgeExpression } from '../src';
import { splitSpan } from '../src/format';
import { makeEvaluator, renderUI } from './helpers';

const evaluate = makeEvaluator([
  { name: 'width', expr: '60mm' },
  { name: 'cyc', expr: 'cyc + 1mm' },
]);
const evalLen = (e: string) => evaluate(e, 'length');

function Harness(
  props: Partial<React.ComponentProps<typeof ExpressionInput>> & { initial?: string },
) {
  const [v, setV] = useState(props.initial ?? '10mm');
  return (
    <ExpressionInput
      label="Depth"
      value={v}
      evaluate={evalLen}
      unitHint="mm"
      {...props}
      onCommit={(e) => {
        setV(e);
        props.onCommit?.(e);
      }}
    />
  );
}

describe('ExpressionInput', () => {
  it('Enter commits a valid edit, Esc reverts', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    renderUI(<Harness onCommit={onCommit} onCancel={onCancel} />);
    const input = screen.getByRole('textbox', { name: 'Depth' });
    await userEvent.click(input);
    await userEvent.keyboard('{Control>}a{/Control}25mm + 1/8in{Enter}');
    expect(onCommit).toHaveBeenCalledWith('25mm + 1/8in');
    expect(input).toHaveValue('25mm + 1/8in');

    await userEvent.keyboard('{Control>}a{/Control}999{Escape}');
    expect(input).toHaveValue('25mm + 1/8in');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('shows the evaluated value for expressions but not for plain literals', () => {
    const { rerender } = renderUI(<Harness initial="width / 2" />);
    expect(screen.getByTestId('expr-readout')).toHaveTextContent('= 30 mm');
    rerender(<Harness initial="12mm" />);
    expect(screen.queryByTestId('expr-readout')).toBeNull();
  });

  it('flags errors with an underlined span and message, and refuses to commit them', async () => {
    const onCommit = vi.fn();
    renderUI(<Harness onCommit={onCommit} />);
    const input = screen.getByRole('textbox', { name: 'Depth' });
    await userEvent.click(input);
    await userEvent.keyboard('{Control>}a{/Control}width + * 2{Enter}');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Unexpected “*”');
    expect(document.querySelector('.decoration-wavy')?.textContent).toBe('*');
    expect(onCommit).not.toHaveBeenCalled();
    // blur keeps the invalid draft visible rather than discarding it
    await userEvent.tab();
    expect(input).toHaveValue('width + * 2');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('blur commits a valid changed value', async () => {
    const onCommit = vi.fn();
    renderUI(<Harness onCommit={onCommit} />);
    await userEvent.click(screen.getByRole('textbox', { name: 'Depth' }));
    await userEvent.keyboard('{Control>}a{/Control}7mm');
    await userEvent.tab();
    expect(onCommit).toHaveBeenCalledWith('7mm');
  });

  it('nudges with arrows: Shift x10, Alt x0.1, keeping the unit', async () => {
    const onPreview = vi.fn();
    renderUI(<Harness onPreview={onPreview} />);
    const input = screen.getByRole('textbox', { name: 'Depth' });
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowUp}');
    expect(input).toHaveValue('11mm');
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    expect(input).toHaveValue('21mm');
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(input).toHaveValue('20.9mm');
    await userEvent.keyboard('{ArrowDown}');
    expect(input).toHaveValue('19.9mm');
    expect(onPreview).toHaveBeenLastCalledWith('19.9mm');
  });

  it('nudge helper preserves spacing and appends to expressions when a unit is known', () => {
    expect(nudgeExpression('2.5 in', 1)).toBe('3.5 in');
    expect(nudgeExpression('-1deg', 1)).toBe('0deg');
    expect(nudgeExpression('width/2', 1, 'mm')).toBe('width/2 + 1mm');
    expect(nudgeExpression('width/2', -0.1, 'mm')).toBe('width/2 - 0.1mm');
    expect(nudgeExpression('width/2', 1)).toBeNull();
  });

  it('splitSpan clamps spans and keeps zero-width spans visible', () => {
    expect(splitSpan('abcdef', { message: '', span: [2, 4] })).toEqual(['ab', 'cd', 'ef']);
    expect(splitSpan('abc', { message: '', span: [3, 3] })).toEqual(['ab', 'c', '']);
    expect(splitSpan('abc', { message: '', span: [1, 99] })).toEqual(['a', 'bc', '']);
    expect(splitSpan('abc')).toEqual(['abc', '', '']);
  });

  it('opens an inline keypad that types into the field and never leaves the field', async () => {
    const onCommit = vi.fn();
    renderUI(<Harness keypad="always" onCommit={onCommit} initial="1mm" />);
    const input = screen.getByRole('textbox', { name: 'Depth' });
    await userEvent.click(input);
    const pad = await screen.findByRole('group', { name: 'Numeric keypad' });
    expect(input).toHaveAttribute('inputmode', 'none');
    const key = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
    // selection is replaced by the first key
    key('2');
    key('5');
    key('decimal point');
    key('5');
    key('mm (millimetres)');
    expect(input).toHaveValue('25.5mm');
    key('plus');
    key('1');
    key('in (inches)');
    expect(input).toHaveValue('25.5mm + 1in');
    key('Backspace');
    key('Backspace');
    expect(input).toHaveValue('25.5mm + 1');
    key('mm (millimetres)');
    expect(input).toHaveFocus();
    key('Enter');
    expect(onCommit).toHaveBeenCalledWith('25.5mm + 1mm');
    await waitFor(() => expect(pad).not.toBeInTheDocument());
  });

  it('keypad can hand over to the system keyboard', async () => {
    renderUI(<Harness keypad="always" />);
    const input = screen.getByRole('textbox', { name: 'Depth' });
    await userEvent.click(input);
    await screen.findByRole('group', { name: 'Numeric keypad' });
    fireEvent.click(screen.getByRole('button', { name: 'Use the system keyboard' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Numeric keypad' })).toBeNull());
    expect(input).toHaveAttribute('inputmode', 'text');
  });

  it('never opens the keypad when set to never', async () => {
    renderUI(<Harness keypad="never" />);
    await userEvent.click(screen.getByRole('textbox', { name: 'Depth' }));
    expect(screen.queryByRole('group', { name: 'Numeric keypad' })).toBeNull();
  });

  it('allowEmpty lets an optional value be cleared', async () => {
    const onCommit = vi.fn();
    renderUI(<Harness allowEmpty initial="5deg" onCommit={onCommit} />);
    const input = screen.getByRole('textbox', { name: 'Depth' });
    await userEvent.click(input);
    await userEvent.keyboard('{Backspace}{Enter}');
    expect(onCommit).toHaveBeenCalledWith('');
  });
});
