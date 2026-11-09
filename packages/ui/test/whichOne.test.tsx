import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  compareCandidates,
  cyclePreselection,
  type PickCandidate,
  sortCandidates,
  WhichOneChooser,
} from '../src';
import { renderUI } from './helpers';

const c = (id: string, kind: PickCandidate['kind'], depth?: number): PickCandidate => ({
  id,
  kind,
  label: id,
  ...(depth === undefined ? {} : { depth }),
});

describe('stable order', () => {
  it('sorts by kind priority, then depth, then id', () => {
    const list = [
      c('b2', 'body', 1),
      c('f-far', 'face', 9),
      c('f-near-b', 'face', 2),
      c('f-near-a', 'face', 2),
      c('e1', 'edge', 5),
      c('v1', 'vertex', 7),
      c('f-unknown', 'face'),
    ];
    expect(sortCandidates(list).map((x) => x.id)).toEqual([
      'v1',
      'e1',
      'f-near-a',
      'f-near-b',
      'f-far',
      'f-unknown',
      'b2',
    ]);
  });

  it('is identical for every input permutation, on every run', () => {
    const list = [
      c('x', 'edge', 1),
      c('y', 'edge', 1),
      c('a', 'face', 3),
      c('z', 'vertex'),
      c('B', 'edge', 1),
      c('b', 'edge', 1),
    ];
    const want = sortCandidates(list).map((x) => x.id);
    for (let seed = 1; seed <= 25; seed++) {
      // A deterministic shuffle (LCG) so the test itself is reproducible.
      let s = seed;
      const next = () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return (s % 3) - 1;
      };
      const shuffled = [...list].sort(next);
      expect(sortCandidates(shuffled).map((x) => x.id)).toEqual(want);
    }
    // Code-unit order: upper case before lower case, whatever the locale.
    expect(want.indexOf('B')).toBeLessThan(want.indexOf('b'));
  });

  it('does not mutate its input and treats equal items as equal', () => {
    const list = [c('b', 'face'), c('a', 'face')];
    sortCandidates(list);
    expect(list.map((x) => x.id)).toEqual(['b', 'a']);
    expect(compareCandidates(c('a', 'edge', 1), c('a', 'edge', 1))).toBe(0);
  });
});

describe('cyclePreselection', () => {
  const ids = ['a', 'b', 'c'];
  it('Tab goes forward and wraps, Shift+Tab backward and wraps', () => {
    expect(cyclePreselection(ids, 'a', 1)).toBe('b');
    expect(cyclePreselection(ids, 'c', 1)).toBe('a');
    expect(cyclePreselection(ids, 'a', -1)).toBe('c');
    expect(cyclePreselection(ids, 'c', -1)).toBe('b');
  });
  it('starts at the first (Tab) or last (Shift+Tab) with nothing preselected', () => {
    expect(cyclePreselection(ids, null, 1)).toBe('a');
    expect(cyclePreselection(ids, undefined, -1)).toBe('c');
    expect(cyclePreselection(ids, 'gone', 1)).toBe('a');
  });
  it('is null for an empty list and stays on a single candidate', () => {
    expect(cyclePreselection([], 'a', 1)).toBeNull();
    expect(cyclePreselection(['only'], 'only', 1)).toBe('only');
    expect(cyclePreselection(['only'], 'only', -1)).toBe('only');
  });
});

function setup() {
  const onPick = vi.fn();
  const onHover = vi.fn();
  const onDismiss = vi.fn();
  renderUI(
    <WhichOneChooser
      at={{ x: 100, y: 100 }}
      onPick={onPick}
      onHover={onHover}
      onDismiss={onDismiss}
      candidates={[
        c('f1', 'face', 3),
        c('e1', 'edge', 4),
        c('e2', 'edge', 2),
        c('v1', 'vertex', 5),
      ]}
    />,
  );
  return { onPick, onHover, onDismiss };
}

describe('WhichOneChooser', () => {
  it('lists candidates in the stable order and preselects the first', async () => {
    const { onHover } = setup();
    const opts = await screen.findAllByRole('option');
    expect(opts.map((o) => o.getAttribute('data-id'))).toEqual(['v1', 'e2', 'e1', 'f1']);
    expect(opts[0]).toHaveAttribute('aria-selected', 'true');
    expect(onHover).toHaveBeenLastCalledWith('v1');
  });

  it('hovering a row preselects it; leaving clears', async () => {
    const { onHover } = setup();
    const opts = await screen.findAllByRole('option');
    fireEvent.mouseEnter(opts[2] as HTMLElement);
    expect(onHover).toHaveBeenLastCalledWith('e1');
    expect(opts[2]).toHaveAttribute('aria-selected', 'true');
    fireEvent.mouseLeave(opts[2] as HTMLElement);
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('Tab and Shift+Tab cycle the preselection and report it, without leaving the list', async () => {
    const { onHover } = setup();
    const opts = await screen.findAllByRole('option');
    await userEvent.tab();
    expect(opts[1]).toHaveFocus();
    expect(onHover).toHaveBeenLastCalledWith('e2');
    await userEvent.tab();
    await userEvent.tab();
    expect(opts[3]).toHaveFocus();
    await userEvent.tab(); // wraps
    expect(opts[0]).toHaveFocus();
    expect(onHover).toHaveBeenLastCalledWith('v1');
    await userEvent.tab({ shift: true });
    expect(opts[3]).toHaveFocus();
    expect(onHover).toHaveBeenLastCalledWith('f1');
    expect(screen.getByRole('listbox').contains(document.activeElement)).toBe(true);
  });

  it('Tab cycles even when focus is elsewhere (a still pointer over the canvas)', async () => {
    const { onHover } = setup();
    const opts = await screen.findAllByRole('option');
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Tab', code: 'Tab' });
    expect(onHover).toHaveBeenLastCalledWith('e2');
    expect(opts[1]).toHaveFocus();
  });

  it('Enter picks the preselected row, Esc dismisses and clears the preselection', async () => {
    const { onPick, onHover, onDismiss } = setup();
    await screen.findAllByRole('option');
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith('e2');
    await userEvent.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalled();
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('only one option is a tab stop (roving)', async () => {
    setup();
    const opts = await screen.findAllByRole('option');
    expect(opts.filter((o) => o.getAttribute('tabindex') === '0')).toHaveLength(1);
  });
});
