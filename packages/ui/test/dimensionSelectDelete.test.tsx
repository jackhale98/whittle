// SPDX-License-Identifier: GPL-3.0-or-later
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { clipSegment, HIT_CLEAR } from '../src/sketch/DimensionAnnotation';
import { DimensionLabel } from '../src/sketch/DimensionLabel';
import { renderUI } from './helpers';

const evaluate = () => ({ ok: true as const, value: 30, dimension: 'length' as const });

/** A host with a selection model, as the sketch layer has. */
function Host({ onDelete }: { onDelete(): void }) {
  const [selected, setSelected] = useState(false);
  return (
    <DimensionLabel
      x={100}
      y={100}
      kind="diameter"
      expr="30"
      driving
      evaluate={evaluate}
      selected={selected}
      onSelect={() => setSelected(true)}
      onDelete={onDelete}
      onToggleDriving={() => {}}
    />
  );
}

describe('DimensionLabel: select, edit, delete (owner bug: Del did nothing)', () => {
  it('a click selects; a click on the selected label edits', async () => {
    renderUI(<Host onDelete={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /Dimension: Ø30/ });
    await userEvent.click(btn);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(btn);
    expect(screen.getByRole('textbox', { name: 'diameter dimension' })).toHaveFocus();
  });

  it('a double-click and Enter edit straight away', async () => {
    const a = renderUI(<Host onDelete={vi.fn()} />);
    await userEvent.dblClick(screen.getByRole('button', { name: /Dimension/ }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    a.unmount();
    renderUI(<Host onDelete={vi.fn()} />);
    screen.getByRole('button', { name: /Dimension/ }).focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('Delete and Backspace on the label delete it', () => {
    const onDelete = vi.fn();
    renderUI(<Host onDelete={onDelete} />);
    const btn = screen.getByRole('button', { name: /Dimension/ });
    fireEvent.keyDown(btn, { key: 'Delete' });
    fireEvent.keyDown(btn, { key: 'Backspace' });
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it('the selected label offers a Delete chip, and so does the editor', async () => {
    const onDelete = vi.fn();
    renderUI(<Host onDelete={onDelete} />);
    const btn = screen.getByRole('button', { name: /Dimension/ });
    await userEvent.click(btn);
    await userEvent.click(screen.getByRole('button', { name: 'Delete dimension' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    await userEvent.click(btn);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete dimension' }));
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it('without a selection model a click still edits at once', async () => {
    renderUI(<DimensionLabel x={0} y={0} kind="length" expr="30" driving evaluate={evaluate} />);
    await userEvent.click(screen.getByRole('button', { name: /Dimension/ }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});

describe('DimensionAnnotation hit area keeps geometry under it grabbable', () => {
  it('a diameter leader leaves its centre and both ends clear', () => {
    const s = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
    const out = clipSegment(s, [s.a, s.b, { x: 50, y: 0 }]);
    expect(out).toHaveLength(2);
    expect(out[0]?.a.x).toBeCloseTo(HIT_CLEAR);
    expect(out[0]?.b.x).toBeCloseTo(50 - HIT_CLEAR);
    expect(out[1]?.a.x).toBeCloseTo(50 + HIT_CLEAR);
    expect(out[1]?.b.x).toBeCloseTo(100 - HIT_CLEAR);
  });

  it('a point off the line by more than the clearance cuts nothing; a short leader can vanish', () => {
    const s = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
    expect(clipSegment(s, [{ x: 50, y: HIT_CLEAR + 1 }])).toEqual([s]);
    expect(clipSegment({ a: { x: 0, y: 0 }, b: { x: 12, y: 0 } }, [{ x: 6, y: 0 }])).toEqual([]);
  });
});
