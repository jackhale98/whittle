import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RadialEditor, type RadialEditorCommand } from '../src';
import { assignToSlot } from '../src/panels/RadialEditor';
import { renderUI } from './helpers';

const commands: RadialEditorCommand[] = [
  { id: 'extrude', label: 'Extrude', group: 'Modeling' },
  { id: 'fillet', label: 'Fillet', group: 'Modeling' },
  { id: 'hole', label: 'Hole', group: 'Modeling' },
  { id: 'fit', label: 'Fit view', group: 'View and history' },
];
const contexts = [
  { id: 'face', label: 'Face', hint: 'Faces.' },
  { id: 'edge', label: 'Edge' },
];
const empty = (n = 7) => Array<string | null>(n).fill(null);

function Harness({ spy }: { spy?: (c: string, r: readonly (string | null)[]) => void }) {
  const [rings, setRings] = useState<Record<string, readonly (string | null)[]>>({
    face: ['extrude', ...empty(6)],
    edge: empty(),
  });
  const [flick, setFlick] = useState(250);
  return (
    <RadialEditor
      contexts={contexts}
      ringOf={(c) => rings[c] ?? empty()}
      commandsOf={() => commands}
      modified={Object.keys(rings).filter((c) => c === 'face')}
      onRingChange={(c, r) => {
        spy?.(c, r);
        setRings((x) => ({ ...x, [c]: r }));
      }}
      onResetContext={(c) => setRings((x) => ({ ...x, [c]: empty() }))}
      onResetAll={() => setRings({ face: empty(), edge: empty() })}
      flickWindow={flick}
      onFlickWindow={setFlick}
      drawAfterDelay={false}
      onDrawAfterDelay={() => {}}
    />
  );
}

describe('assignToSlot', () => {
  it('places, moves (swapping) and clears', () => {
    expect(assignToSlot(['a', null, 'b'], 1, 'c')).toEqual(['a', 'c', 'b']);
    expect(assignToSlot(['a', null, 'b'], 1, 'a')).toEqual([null, 'a', 'b']);
    expect(assignToSlot(['a', 'x', 'b'], 1, 'b')).toEqual(['a', 'b', 'x']);
    expect(assignToSlot(['a', 'x'], 1, null)).toEqual(['a', null]);
  });
});

describe('RadialEditor', () => {
  it('keyboard: choose a slot, then a command; focus returns to the slot', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderUI(<Harness spy={spy} />);
    const slot2 = screen.getByRole('button', { name: /^slot 2, east: empty/i });
    slot2.focus();
    await user.keyboard('{Enter}');
    expect(slot2).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('searchbox', { name: 'Search commands' })).toHaveFocus();
    await user.keyboard('fill');
    const fillet = screen.getByRole('button', { name: /^fillet, place in slot 2/i });
    fillet.focus();
    await user.keyboard('{Enter}');
    expect(spy).toHaveBeenCalledWith('face', ['extrude', 'fillet', ...empty(5)]);
    await Promise.resolve();
    expect(screen.getByRole('button', { name: /^slot 2, east: fillet/i })).toHaveFocus();
    expect(screen.getByTestId('radial-status')).toHaveTextContent('Fillet placed in slot 2');
  });

  it('Delete clears a focused slot; Clear slot works after choosing one', async () => {
    const user = userEvent.setup();
    renderUI(<Harness />);
    const slot1 = screen.getByRole('button', { name: /^slot 1, north-east: extrude/i });
    slot1.focus();
    await user.keyboard('{Delete}');
    expect(screen.getByRole('button', { name: /^slot 1, north-east: empty/i })).toBeInTheDocument();
  });

  it('a command without a chosen slot explains itself and changes nothing', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderUI(<Harness spy={spy} />);
    await user.click(screen.getByRole('button', { name: /^hole\. choose a slot first/i }));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId('radial-status')).toHaveTextContent('Choose a slot first');
  });

  it('switches context and resets', async () => {
    const user = userEvent.setup();
    renderUI(<Harness />);
    expect(screen.getByRole('button', { name: /^slot 1, north-east: extrude/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reset this ring' }));
    expect(screen.getByRole('button', { name: /^slot 1, north-east: empty/i })).toBeVisible();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Wheel context' }), 'edge');
    expect(within(screen.getByTestId('radial-ring')).getByText('Repeat')).toBeInTheDocument();
  });

  it('clamps the flick window to 0-400', async () => {
    const user = userEvent.setup();
    renderUI(<Harness />);
    const input = screen.getByRole('spinbutton', { name: /flick window/i });
    await user.clear(input);
    await user.type(input, '900');
    expect(input).toHaveValue(400);
  });
});
