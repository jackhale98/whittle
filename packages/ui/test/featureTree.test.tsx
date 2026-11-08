import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { sampleFeatures, sampleStatuses } from '../harness/fixtures';
import { FeatureTree, type FeatureTreeProps } from '../src';
import { renderUI } from './helpers';

function setup(over: Partial<FeatureTreeProps> = {}) {
  const props: FeatureTreeProps = {
    features: sampleFeatures,
    statuses: sampleStatuses,
    rollbackIndex: 5,
    selectedId: 'F2',
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onRollback: vi.fn(),
    onMove: vi.fn(() => ({ ok: true as const })),
    onEdit: vi.fn(),
    onSuppress: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
  renderUI(<FeatureTree {...props} />);
  return props;
}

const item = (name: RegExp | string) => screen.getByRole('treeitem', { name });

describe('FeatureTree semantics', () => {
  it('is a tree of treeitems with position, selection and status text', () => {
    setup();
    expect(screen.getByRole('tree', { name: 'Features' })).toBeInTheDocument();
    const items = screen.getAllByRole('treeitem');
    expect(items).toHaveLength(6);
    expect(items[1]).toHaveAttribute('aria-selected', 'true');
    expect(items[2]).toHaveAttribute('aria-posinset', '3');
    expect(items[2]).toHaveAttribute('aria-setsize', '6');
    expect(items[2]).toHaveAccessibleName(/Fillet 1.*too large.*error/s);
    expect(items[3]).toHaveAccessibleName(/Chamfer 1.*needs attention/s);
    expect(items[4]).toHaveAccessibleName(/Mounting hole.*suppressed/s);
    expect(items[5]).toHaveAccessibleName(/Revolve 1.*rolled back/s);
  });

  it('shows one-line failure messages and attention state', () => {
    setup();
    const msgs = screen.getAllByTestId('feature-message').map((n) => n.textContent);
    expect(msgs).toEqual([
      'Fillet radius is too large for this edge; max ≈ 2.4 mm.',
      'A reference needs re-picking.',
    ]);
    expect(item(/Fillet 1/)).toHaveAttribute('data-state', 'error');
    expect(item(/Chamfer 1/)).toHaveAttribute('data-state', 'needsAttention');
  });

  it('has an empty state', () => {
    renderUI(<FeatureTree features={[]} />);
    expect(screen.getByText('No features yet')).toBeInTheDocument();
  });
});

describe('FeatureTree keyboard', () => {
  it('uses a roving tabindex and arrow/Home/End navigation', async () => {
    setup();
    const items = screen.getAllByRole('treeitem');
    expect(items.map((i) => i.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1]); // selected row is the tab stop
    items[1]?.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(items[2]).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(items[5]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(items[5]).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(items[0]).toHaveFocus();
  });

  it('Space selects, Delete deletes', async () => {
    const p = setup();
    item(/Chamfer 1/).focus();
    await userEvent.keyboard(' ');
    expect(p.onSelect).toHaveBeenCalledWith('F4');
    await userEvent.keyboard('{Delete}');
    expect(p.onDelete).toHaveBeenCalledWith('F4');
  });

  it('Enter / F2 starts an inline rename; Enter commits, Esc cancels', async () => {
    const p = setup();
    item(/Base sketch/).focus();
    await userEvent.keyboard('{Enter}');
    const field = screen.getByRole('textbox', { name: 'Rename Base sketch' });
    expect(field).toHaveFocus();
    await userEvent.keyboard('{Control>}a{/Control}Profile{Enter}');
    expect(p.onRename).toHaveBeenCalledWith('F1', 'Profile');
    expect(screen.queryByRole('textbox')).toBeNull();
    await waitFor(() => expect(item(/Base sketch/)).toHaveFocus());

    await userEvent.keyboard('{F2}');
    await userEvent.keyboard('{Control>}a{/Control}Nope{Escape}');
    expect(p.onRename).toHaveBeenCalledTimes(1);
  });

  it('double-click renames', async () => {
    const p = setup();
    await userEvent.dblClick(screen.getByText('Extrude 1'));
    await userEvent.keyboard('{Control>}a{/Control}Boss{Enter}');
    expect(p.onRename).toHaveBeenCalledWith('F2', 'Boss');
  });

  it('opens the context menu with Shift+F10 and runs actions', async () => {
    const p = setup();
    item(/Extrude 1/).focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    const menu = await screen.findByRole('menu', { name: 'Actions for Extrude 1' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent?.replace(/(F2|Del)$/, '')),
    ).toEqual(['Edit', 'Rename', 'Suppress', 'Roll to here', 'Delete']);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}'); // Suppress (first item is focused on open)
    expect(p.onSuppress).toHaveBeenCalledWith('F2', true);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('offers Unsuppress for suppressed features and Roll to here sets the rollback index', async () => {
    const p = setup();
    fireEvent.contextMenu(item(/Mounting hole/));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unsuppress' }));
    expect(p.onSuppress).toHaveBeenCalledWith('F5', false);
    fireEvent.contextMenu(item(/Chamfer 1/));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Roll to here' }));
    expect(p.onRollback).toHaveBeenCalledWith(4);
  });

  it('Esc closes the menu and returns focus to the row', async () => {
    setup();
    item(/Extrude 1/).focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    await screen.findByRole('menu');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(item(/Extrude 1/)).toHaveFocus();
  });
});

describe('rollback bar', () => {
  it('is a focusable splitter with value text', () => {
    setup({ rollbackIndex: 3 });
    const bar = screen.getByRole('separator', { name: 'Rollback bar' });
    expect(bar).toHaveAttribute('aria-valuenow', '3');
    expect(bar).toHaveAttribute('aria-valuemax', '6');
    expect(bar).toHaveAttribute('aria-valuetext', 'Rolled back after Fillet 1');
    expect(bar.tabIndex).toBe(0);
  });

  it('moves with the arrow keys, Home and End, clamped to range', async () => {
    const p = setup({ rollbackIndex: 3 });
    const bar = screen.getByRole('separator', { name: 'Rollback bar' });
    bar.focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(p.onRollback).toHaveBeenLastCalledWith(2);
    await userEvent.keyboard('{ArrowDown}');
    expect(p.onRollback).toHaveBeenLastCalledWith(4);
    await userEvent.keyboard('{Home}');
    expect(p.onRollback).toHaveBeenLastCalledWith(0);
    await userEvent.keyboard('{End}');
    expect(p.onRollback).toHaveBeenLastCalledWith(6);
  });

  it('does not call back when already at the limit', async () => {
    const p = setup({ rollbackIndex: 6 });
    screen.getByRole('separator', { name: 'Rollback bar' }).focus();
    await userEvent.keyboard('{ArrowDown}{End}');
    expect(p.onRollback).not.toHaveBeenCalled();
    expect(screen.getByRole('separator', { name: 'Rollback bar' })).toHaveAttribute(
      'aria-valuetext',
      'All features active',
    );
  });
});

describe('reorder', () => {
  it('Alt+Arrow requests a move to the neighbouring index', async () => {
    const p = setup();
    item(/Chamfer 1/).focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(p.onMove).toHaveBeenCalledWith('F4', 4);
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(p.onMove).toHaveBeenLastCalledWith('F4', 2);
  });

  it('ignores moves past either end', async () => {
    const p = setup();
    item(/Base sketch/).focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(p.onMove).not.toHaveBeenCalled();
  });

  it('a rejected move shakes the row and explains why, politely', async () => {
    const onMove = vi.fn(async () => ({
      ok: false as const,
      reason: 'Fillet 1 needs Extrude 1 above it.',
    }));
    setup({ onMove });
    item(/Fillet 1/).focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    const notice = screen.getByTestId('tree-notice');
    await waitFor(() => expect(notice).toHaveTextContent('Fillet 1 needs Extrude 1 above it.'));
    expect(notice).toHaveAttribute('aria-live', 'polite');
    expect(notice).not.toHaveClass('sr-only');
  });

  it('an accepted move clears an earlier notice', async () => {
    const results = [{ ok: false as const, reason: 'Nope.' }, { ok: true as const }];
    const onMove = vi.fn(() => Promise.resolve(results.shift()));
    setup({ onMove: onMove as FeatureTreeProps['onMove'] });
    item(/Chamfer 1/).focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(screen.getByTestId('tree-notice')).toHaveTextContent('Nope.'));
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(screen.getByTestId('tree-notice')).toHaveTextContent(''));
  });
});
