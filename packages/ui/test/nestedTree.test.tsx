import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Feature } from '@wren-cad/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  FeatureTree,
  type FeatureTreeProps,
  NEST_SKETCHES_KEY,
  readNestSketches,
  writeNestSketches,
} from '../src';
import { renderUI } from './helpers';

/* ADR-015: sketches used by exactly one feature nest under it in the tree (view only). */

const base = (id: string, name: string) => ({ id, name, suppressed: false });
const region = (s: string) => ({ name: `S${s}:region(e1)`, kind: 'region' as const });
const sk = (id: string, name: string): Feature => ({
  ...base(id, name),
  type: 'sketch',
  on: { name: 'origin:XY', kind: 'face' },
  entities: [],
  constraints: [],
});
const ex = (id: string, name: string, ...sketches: string[]): Feature => ({
  ...base(id, name),
  type: 'extrude',
  profile: sketches.map(region),
  direction: 'normal',
  end: { kind: 'blind', depth: '10 mm' },
  op: 'new',
});

// A -> E (nested), B -> F (nested), C shared by G and H, D unused
const doc: Feature[] = [
  sk('A', 'Sketch 1'),
  ex('E', 'Extrude 1', 'A'),
  sk('B', 'Sketch 2'),
  ex('F', 'Extrude 2', 'B'),
  sk('C', 'Sketch 3'),
  ex('G', 'Extrude 3', 'C'),
  ex('H', 'Extrude 4', 'C'),
  sk('D', 'Sketch 4'),
];

function go(over: Partial<FeatureTreeProps> = {}) {
  const props: FeatureTreeProps = {
    features: doc,
    rollbackIndex: doc.length,
    selectedId: null,
    onSelect: vi.fn(),
    onRollback: vi.fn(),
    onMove: vi.fn(() => ({ ok: true as const })),
    onDelete: vi.fn(),
    ...over,
  };
  renderUI(<FeatureTree {...props} />);
  return props;
}

const item = (name: RegExp | string) => screen.getByRole('treeitem', { name });
const names = () => screen.getAllByRole('treeitem').map((e) => e.getAttribute('data-feature-id'));

describe('nested sketches', () => {
  it('shows nested sketches collapsed, under their feature, as an ARIA tree', async () => {
    go();
    // A and B tuck away; C (shared) and D (unused) stay top-level
    expect(names()).toEqual(['E', 'F', 'C', 'G', 'H', 'D']);
    const e1 = item(/Extrude 1/);
    expect(e1).toHaveAttribute('aria-expanded', 'false');
    expect(e1).toHaveAttribute('aria-level', '1');
    // a feature without nested sketches has no aria-expanded
    expect(item(/Extrude 3/)).not.toHaveAttribute('aria-expanded');
    e1.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(e1).toHaveAttribute('aria-expanded', 'true');
    const nested = item(/^Sketch 1/);
    expect(nested).toHaveAttribute('aria-level', '2');
    expect(nested).toHaveAttribute('aria-posinset', '1');
    expect(nested).toHaveAttribute('aria-setsize', '1');
    // order: the feature, then its sketch
    expect(names().slice(0, 3)).toEqual(['E', 'A', 'F']);
    // Right steps in, Left steps out, Left on a parent collapses
    await userEvent.keyboard('{ArrowRight}');
    expect(nested).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(e1).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(e1).toHaveAttribute('aria-expanded', 'false');
  });

  it('the chevron toggles without selecting', () => {
    const p = go();
    fireEvent.click(within(item(/Extrude 2/)).getByTestId('nest-toggle'));
    expect(item(/Extrude 2/)).toHaveAttribute('aria-expanded', 'true');
    expect(p.onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('treeitem', { name: /^Sketch 2/ })).toBeInTheDocument();
  });

  it('selecting a nested sketch from outside opens its parent', () => {
    go({ selectedId: 'B' });
    expect(item(/Extrude 2/)).toHaveAttribute('aria-expanded', 'true');
    expect(item(/^Sketch 2/)).toHaveAttribute('aria-selected', 'true');
  });

  it('a sketch used by several features stays top-level with a used-by badge', () => {
    go();
    const shared = item(/^Sketch 3/);
    expect(shared).toHaveAttribute('aria-level', '1');
    expect(within(shared).getByTestId('used-by')).toHaveTextContent('used by 2');
    expect(shared).toHaveAccessibleName(/Used by 2 features/);
    // an unused sketch has no badge
    expect(within(item(/^Sketch 4/)).queryByTestId('used-by')).toBeNull();
  });

  it('a new sketch is top-level until a feature consumes it', () => {
    const first = renderUI(<FeatureTree features={doc.slice(0, 1)} />);
    expect(screen.getAllByRole('treeitem')).toHaveLength(1);
    expect(screen.getByRole('treeitem')).not.toHaveAttribute('aria-expanded');
    first.unmount();
    renderUI(<FeatureTree features={doc.slice(0, 2)} />);
    expect(screen.getAllByRole('treeitem')).toHaveLength(1);
    expect(screen.getByRole('treeitem', { name: /Extrude 1/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('a suppressed consumer keeps its sketch nested', () => {
    renderUI(
      <FeatureTree
        features={[sk('A', 'Sketch 1'), { ...ex('E', 'Extrude 1', 'A'), suppressed: true }]}
      />,
    );
    expect(screen.getAllByRole('treeitem')).toHaveLength(1);
  });

  it('the flat view setting restores the serial list, and the menu offers the toggle', async () => {
    const onNestSketchesChange = vi.fn();
    const first = renderUI(
      <FeatureTree features={doc} onNestSketchesChange={onNestSketchesChange} />,
    );
    fireEvent.contextMenu(item(/Extrude 3/));
    const toggle = await screen.findByRole('menuitemcheckbox', {
      name: /Show sketches in the history/,
    });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(onNestSketchesChange).toHaveBeenCalledWith(false);
    first.unmount();

    renderUI(<FeatureTree features={doc} nestSketches={false} onNestSketchesChange={() => {}} />);
    expect(names()).toEqual(doc.map((f) => f.id));
    for (const t of screen.getAllByRole('treeitem')) expect(t).toHaveAttribute('aria-level', '1');
    expect(screen.queryByTestId('used-by')).toBeNull();
    fireEvent.contextMenu(item(/Extrude 3/));
    expect(
      await screen.findByRole('menuitemcheckbox', { name: /Show sketches in the history/ }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  describe('reordering', () => {
    it('moves the feature with its sketch through onReorder, sketch first when moving up', async () => {
      const onReorder = vi.fn(() => ({ ok: true as const }));
      go({ onReorder });
      item(/Extrude 2/).focus();
      await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
      expect(onReorder).toHaveBeenCalledWith([
        { id: 'B', from: 2, toIndex: 0 },
        { id: 'F', from: 3, toIndex: 1 },
      ]);
    });

    it('moves down feature-first', async () => {
      const onReorder = vi.fn(() => ({ ok: true as const }));
      go({ onReorder });
      item(/Extrude 1/).focus();
      await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
      expect(onReorder).toHaveBeenCalledTimes(1);
      const steps = (onReorder.mock.calls[0] as unknown as [{ id: string }[]])[0];
      expect(steps.map((s) => s.id)).toEqual(['E', 'A']);
    });

    it('without onReorder, falls back to onMove one step at a time, in order', async () => {
      const onMove = vi.fn(() => ({ ok: true as const }));
      go({ onMove });
      item(/Extrude 2/).focus();
      await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
      await waitFor(() => expect(onMove).toHaveBeenCalledTimes(2));
      expect(onMove.mock.calls).toEqual([
        ['B', 0],
        ['F', 1],
      ]);
    });

    it('puts earlier steps back when a later one is refused, and says why', async () => {
      const onMove = vi
        .fn()
        .mockReturnValueOnce({ ok: true })
        .mockReturnValueOnce({ ok: false, reason: 'No.' })
        .mockReturnValue({ ok: true });
      go({ onMove });
      item(/Extrude 2/).focus();
      await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
      await waitFor(() => expect(screen.getByTestId('tree-notice')).toHaveTextContent('No.'));
      expect(onMove.mock.calls).toEqual([
        ['B', 0],
        ['F', 1],
        ['B', 2], // the first step undone
      ]);
    });

    it('a flat reorder is still one onMove(id, toIndex)', async () => {
      const onMove = vi.fn(() => ({ ok: true as const }));
      go({ onMove, nestSketches: false });
      item(/Extrude 2/).focus();
      await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
      expect(onMove).toHaveBeenCalledExactlyOnceWith('F', 2);
    });

    it('nested sketches have no reorder of their own', async () => {
      const onMove = vi.fn(() => ({ ok: true as const }));
      go({ onMove, selectedId: 'A' });
      item(/^Sketch 1/).focus();
      await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
      expect(onMove).not.toHaveBeenCalled();
    });
  });

  describe('rollback bar', () => {
    const bar = () => screen.getByRole('separator', { name: 'Rollback bar' });
    it('steps over a nested pair going up', async () => {
      const onRollback = vi.fn();
      go({ onRollback, rollbackIndex: 4 });
      bar().focus();
      await userEvent.keyboard('{ArrowUp}');
      expect(onRollback).toHaveBeenLastCalledWith(2); // not 3: between Sketch 2 and Extrude 2
    });
    it('steps over a nested pair going down', async () => {
      const onRollback = vi.fn();
      go({ onRollback, rollbackIndex: 2 });
      bar().focus();
      await userEvent.keyboard('{ArrowDown}');
      expect(onRollback).toHaveBeenLastCalledWith(4); // not 3
    });
    it('PageUp and Home land on allowed stops', async () => {
      const onRollback = vi.fn();
      go({ onRollback, rollbackIndex: 4 });
      bar().focus();
      await userEvent.keyboard('{PageUp}');
      expect(onRollback).toHaveBeenLastCalledWith(0);
    });
    it('in the flat view every position is allowed', async () => {
      const onRollback = vi.fn();
      go({ onRollback, rollbackIndex: 4, nestSketches: false });
      bar().focus();
      await userEvent.keyboard('{ArrowUp}');
      expect(onRollback).toHaveBeenLastCalledWith(3);
    });
    it('"Roll to here" on a nested sketch rolls to after its feature', async () => {
      const onRollback = vi.fn();
      go({ onRollback, selectedId: 'B' });
      fireEvent.contextMenu(item(/^Sketch 2/));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Roll to here' }));
      expect(onRollback).toHaveBeenCalledWith(4);
    });
  });

  describe('deleting a feature with a nested sketch', () => {
    it('asks inline (no dialog) and "Delete sketch too" removes both', async () => {
      const onDelete = vi.fn();
      go({ onDelete });
      item(/Extrude 1/).focus();
      await userEvent.keyboard('{Delete}');
      expect(onDelete).not.toHaveBeenCalled();
      const prompt = screen.getByTestId('delete-prompt');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(within(prompt).getByRole('button', { name: 'Delete sketch too' })).toHaveFocus();
      await userEvent.click(within(prompt).getByRole('button', { name: 'Delete sketch too' }));
      expect(onDelete).toHaveBeenCalledExactlyOnceWith('E', ['A']);
      expect(screen.queryByTestId('delete-prompt')).toBeNull();
    });
    it('"Keep sketch" deletes only the feature', async () => {
      const onDelete = vi.fn();
      go({ onDelete });
      fireEvent.contextMenu(item(/Extrude 1/));
      fireEvent.click(await screen.findByRole('menuitem', { name: /^Delete/ }));
      await userEvent.click(await screen.findByRole('button', { name: 'Keep sketch' }));
      expect(onDelete).toHaveBeenCalledExactlyOnceWith('E');
    });
    it('Escape and Cancel delete nothing', async () => {
      const onDelete = vi.fn();
      go({ onDelete });
      item(/Extrude 1/).focus();
      await userEvent.keyboard('{Delete}{Escape}');
      expect(screen.queryByTestId('delete-prompt')).toBeNull();
      await waitFor(() => expect(item(/Extrude 1/)).toHaveFocus());
      await userEvent.keyboard('{Delete}');
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onDelete).not.toHaveBeenCalled();
    });
    it('does not ask for a feature without nested sketches', async () => {
      const onDelete = vi.fn();
      go({ onDelete });
      item(/Extrude 3/).focus();
      await userEvent.keyboard('{Delete}');
      expect(onDelete).toHaveBeenCalledExactlyOnceWith('G');
    });
    it('does not ask in the flat view', async () => {
      const onDelete = vi.fn();
      go({ onDelete, nestSketches: false });
      item(/Extrude 1/).focus();
      await userEvent.keyboard('{Delete}');
      expect(onDelete).toHaveBeenCalledExactlyOnceWith('E');
    });
  });
});

describe('nest-sketches setting storage', () => {
  it('defaults to nested, persists flat, and survives blocked storage', () => {
    localStorage.clear();
    expect(readNestSketches()).toBe(true);
    writeNestSketches(false);
    expect(localStorage.getItem(NEST_SKETCHES_KEY)).toBe('flat');
    expect(readNestSketches()).toBe(false);
    writeNestSketches(true);
    expect(readNestSketches()).toBe(true);
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      expect(readNestSketches()).toBe(true);
      expect(() => writeNestSketches(false)).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
