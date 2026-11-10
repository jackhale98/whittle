import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AppShell,
  FeatureStepper,
  FeatureTree,
  type FeatureTreeItem,
  type FeatureTreeProps,
  PhoneFeatureTree,
  type TreeFolder,
} from '../src';
import { renderUI } from './helpers';

/* M3.6: folders, sketch eye, drag outcomes and the phone step-through in the tree component. */

const region = (s: string) => ({ name: `S${s}:region(e1)`, kind: 'region' as const });
type Item = FeatureTreeItem & { profile?: unknown };
const sk = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  name: `Sketch ${id.slice(1)}`,
  type: 'sketch',
  suppressed: false,
  ...over,
});
const fe = (id: string, name: string, type: Item['type'], ...sketches: string[]): Item => ({
  id,
  name,
  type,
  suppressed: false,
  ...(sketches.length ? { profile: sketches.map(region) } : {}),
});
// 0 s1, 1 e1 (uses s1), 2 f1, 3 f2, 4 s2, 5 e2 (uses s2), 6 h1, 7 s3 (unused)
const features: Item[] = [
  sk('s1'),
  fe('e1', 'Extrude 1', 'extrude', 's1'),
  fe('f1', 'Fillet 1', 'fillet'),
  fe('f2', 'Fillet 2', 'fillet'),
  sk('s2'),
  fe('e2', 'Extrude 2', 'extrude', 's2'),
  fe('h1', 'Hole 1', 'hole'),
  sk('s3'),
];
const mounting: TreeFolder = { id: 'm', name: 'Mounting', features: ['f1', 'f2'] };

function setup(over: Partial<FeatureTreeProps> = {}) {
  const props: FeatureTreeProps = {
    features,
    folders: [mounting],
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onRollback: vi.fn(),
    onMove: vi.fn(() => ({ ok: true as const })),
    onSuppress: vi.fn(),
    onDelete: vi.fn(),
    onAddFolder: vi.fn(),
    onRenameFolder: vi.fn(),
    onRemoveFolder: vi.fn(),
    onMoveFolder: vi.fn(() => ({ ok: true as const })),
    onSuppressMany: vi.fn(),
    onSketchVisibility: vi.fn(),
    onUndo: vi.fn(),
    ...over,
  };
  const view = renderUI(<FeatureTree {...props} />);
  return { props, ...view };
}
const folderRow = (name = 'Mounting') =>
  screen.getByRole('treeitem', { name: new RegExp(`^${name}`) });
const row = (name: RegExp | string) => screen.getByRole('treeitem', { name });

function RollbackHost({ on }: { on(ids: readonly string[]): void }) {
  const [r, setR] = useState(8);
  return (
    <>
      <button type="button" onClick={() => setR(3)}>
        roll
      </button>
      <FeatureTree
        features={features}
        folders={[mounting]}
        collapsedFolders={['m']}
        rollbackIndex={r}
        onCollapsedFoldersChange={on}
        onRollback={() => {}}
      />
    </>
  );
}

function NewFolderHost() {
  const [folders, setFolders] = useState<TreeFolder[]>([]);
  return (
    <FeatureTree
      features={features}
      folders={folders}
      onAddFolder={(ids) => setFolders([{ id: 'new', name: 'Folder 1', features: [...ids] }])}
      selectedId="f1"
      onSelect={() => {}}
    />
  );
}

describe('folder rows', () => {
  it('renders the folder before its members, one level in', () => {
    setup();
    const items = screen.getAllByRole('treeitem');
    const names = items.map(
      (i) => i.getAttribute('data-folder-id') ?? i.getAttribute('data-feature-id'),
    );
    expect(names).toEqual(['e1', 'm', 'f1', 'f2', 'e2', 'h1', 's3']);
    expect(items[1]).toHaveAttribute('aria-level', '1');
    expect(items[1]).toHaveAttribute('aria-expanded', 'true');
    expect(items[2]).toHaveAttribute('aria-level', '2');
    expect(items[1]).toHaveAccessibleName(/Mounting.*Folder with 2 features/s);
  });

  it('collapses and expands, showing the count only while collapsed', async () => {
    setup();
    expect(screen.queryByTestId('folder-count')).toBeNull();
    await userEvent.click(within(folderRow()).getByTestId('folder-toggle'));
    expect(folderRow()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('treeitem', { name: /Fillet 1/ })).toBeNull();
    expect(screen.getByTestId('folder-count')).toHaveTextContent('2');
    await userEvent.click(within(folderRow()).getByTestId('folder-toggle'));
    expect(screen.getByRole('treeitem', { name: /Fillet 1/ })).toBeInTheDocument();
  });

  it('collapse state is controlled by props and reported, never stored by the tree', async () => {
    const on = vi.fn();
    setup({ collapsedFolders: ['m'], onCollapsedFoldersChange: on });
    expect(folderRow()).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(within(folderRow()).getByTestId('folder-toggle'));
    expect(on).toHaveBeenCalledWith([]);
    expect(folderRow()).toHaveAttribute('aria-expanded', 'false');
  });

  it('keyboard: Left collapses, Right expands, Space toggles', async () => {
    setup();
    folderRow().focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(folderRow()).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard('{ArrowRight}');
    expect(folderRow()).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard(' ');
    expect(folderRow()).toHaveAttribute('aria-expanded', 'false');
  });

  it('a rollback position inside a folder opens it', () => {
    const on = vi.fn();
    renderUI(<RollbackHost on={on} />);
    expect(on).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('roll'));
    expect(on).toHaveBeenCalledWith([]);
  });

  it('the rollback bar skips the inside of a collapsed folder', async () => {
    const { props } = setup({ collapsedFolders: ['m'], rollbackIndex: 2 });
    screen.getByTestId('rollback-bar').focus();
    await userEvent.keyboard('{ArrowDown}');
    // inside the folder would be 3; the next stop after the folder is 4
    expect(props.onRollback).toHaveBeenCalledWith(4);
  });
});

describe('rename', () => {
  it('double-click renames; Enter commits', async () => {
    const { props } = setup();
    await userEvent.dblClick(within(folderRow()).getByText('Mounting'));
    const input = screen.getByRole('textbox', { name: 'Rename folder Mounting' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Brackets{Enter}');
    expect(props.onRenameFolder).toHaveBeenCalledWith('m', 'Brackets');
  });
  it('F2 opens it; Escape cancels', async () => {
    const { props } = setup();
    folderRow().focus();
    await userEvent.keyboard('{F2}');
    await userEvent.type(screen.getByRole('textbox'), 'x{Escape}');
    expect(props.onRenameFolder).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('a new folder opens its name for editing once it arrives', async () => {
    renderUI(<NewFolderHost />);
    row(/Fillet 1/).focus();
    await userEvent.keyboard('{ContextMenu}');
    await userEvent.click(await screen.findByRole('menuitem', { name: /Add to new folder/ }));
    expect(
      await screen.findByRole('textbox', { name: 'Rename folder Folder 1' }),
    ).toBeInTheDocument();
  });
});

describe('creating a folder', () => {
  async function openMenu(name: RegExp) {
    row(name).focus();
    await userEvent.keyboard('{ContextMenu}');
    return screen.findByRole('menu');
  }

  it('with a contiguous selection "Add to new folder" is enabled and passes the run', async () => {
    const { props } = setup({ folders: [] });
    await userEvent.click(row(/Fillet 1/));
    fireEvent.click(row(/Fillet 2/), { ctrlKey: true });
    await openMenu(/Fillet 2/);
    const item = screen.getByRole('menuitem', { name: /Add to new folder/ });
    expect(item).not.toHaveAttribute('aria-disabled');
    await userEvent.click(item);
    expect(props.onAddFolder).toHaveBeenCalledWith(['f1', 'f2']);
  });

  it('a selected feature brings its nested sketch', async () => {
    const { props } = setup({ folders: [] });
    await openMenu(/Extrude 1/);
    await userEvent.click(screen.getByRole('menuitem', { name: /Add to new folder/ }));
    expect(props.onAddFolder).toHaveBeenCalledWith(['s1', 'e1']);
  });

  it('is disabled with the reason when the selection is not contiguous', async () => {
    const { props } = setup({ folders: [] });
    await userEvent.click(row(/Extrude 1/));
    fireEvent.click(row(/Fillet 2/), { ctrlKey: true });
    await openMenu(/Fillet 2/);
    const item = screen.getByRole('menuitem', { name: /Add to new folder/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent(/consecutive/);
    await userEvent.click(item);
    expect(props.onAddFolder).not.toHaveBeenCalled();
  });

  it('is disabled when a selected feature is already in a folder', async () => {
    setup();
    await openMenu(/Fillet 1/);
    const item = screen.getByRole('menuitem', { name: /Add to new folder/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent(/already in the folder “Mounting”/);
  });

  it('Shift-click selects a range and announces multiselect', async () => {
    setup({ folders: [] });
    await userEvent.click(row(/Extrude 2/));
    fireEvent.click(row(/Hole 1/), { shiftKey: true });
    expect(screen.getByRole('tree')).toHaveAttribute('aria-multiselectable', 'true');
    expect(row(/Extrude 2/)).toHaveAttribute('aria-selected', 'true');
    expect(row(/Hole 1/)).toHaveAttribute('aria-selected', 'true');
  });
});

describe('folder menu', () => {
  async function open() {
    folderRow().focus();
    await userEvent.keyboard('{ContextMenu}');
    return screen.findByRole('menu', { name: 'Actions for folder Mounting' });
  }
  it('lists the folder actions with full labels', async () => {
    setup();
    const menu = await open();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['RenameF2', 'Ungroup', 'Suppress all', 'Roll back to before folder']);
  });
  it('Ungroup, Suppress all and Roll back call the app', async () => {
    const { props } = setup();
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Ungroup' }));
    expect(props.onRemoveFolder).toHaveBeenCalledWith('m');
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Suppress all' }));
    expect(props.onSuppressMany).toHaveBeenCalledWith(['f1', 'f2'], true);
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Roll back to before folder' }));
    expect(props.onRollback).toHaveBeenCalledWith(2);
  });
  it('offers Unsuppress all when every member is suppressed', async () => {
    const all = features.map((f) =>
      f.id === 'f1' || f.id === 'f2' ? { ...f, suppressed: true } : f,
    );
    const { props } = setup({ features: all });
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Unsuppress all' }));
    expect(props.onSuppressMany).toHaveBeenCalledWith(['f1', 'f2'], false);
  });
  it('Show sketches / Hide sketches only when the folder holds sketches', async () => {
    const withSketch: TreeFolder = { id: 'm', name: 'Mounting', features: ['s2', 'e2'] };
    const { props } = setup({ folders: [withSketch] });
    await open();
    // s2 is consumed by e2: auto-hidden, so the action shows it
    await userEvent.click(screen.getByRole('menuitem', { name: 'Show sketches' }));
    expect(props.onSketchVisibility).toHaveBeenCalledWith(['s2'], 'shown');
  });
});

describe('sketch eye', () => {
  it('names the action, writes an explicit value and marks automatic sketches', async () => {
    const { props } = setup();
    const s3 = row(/Sketch 3/);
    const eye = within(s3).getByRole('button', { name: 'Hide Sketch 3' });
    expect(eye).toHaveAttribute('data-visibility', 'auto');
    expect(within(eye).getByTestId('auto-marker')).toBeInTheDocument();
    await userEvent.click(eye);
    expect(props.onSketchVisibility).toHaveBeenCalledWith(['s3'], 'hidden');
  });

  it('a consumed sketch is hidden by default and its eye shows it', async () => {
    const { props } = setup();
    await userEvent.click(within(row(/Extrude 2/)).getByTestId('nest-toggle'));
    const eye = within(row(/Sketch 2/)).getByRole('button', { name: 'Show Sketch 2' });
    await userEvent.click(eye);
    expect(props.onSketchVisibility).toHaveBeenCalledWith(['s2'], 'shown');
  });

  it('an explicit setting has no auto marker and resets from the menu', async () => {
    const items = features.map((f) =>
      f.id === 's3' ? { ...f, visibility: 'hidden' as const } : f,
    );
    const { props } = setup({ features: items });
    const eye = within(row(/Sketch 3/)).getByRole('button', { name: 'Show Sketch 3' });
    expect(eye).toHaveAttribute('data-visibility', 'hidden');
    expect(within(eye).queryByTestId('auto-marker')).toBeNull();
    row(/Sketch 3/).focus();
    await userEvent.keyboard('{ContextMenu}');
    await userEvent.click(await screen.findByRole('menuitem', { name: /Reset to automatic/ }));
    expect(props.onSketchVisibility).toHaveBeenCalledWith(['s3'], 'auto');
  });

  it('honours a resolved `shown` from the app', () => {
    const items = features.map((f) => (f.id === 's3' ? { ...f, shown: false } : f));
    setup({ features: items });
    expect(
      within(row(/Sketch 3/)).getByRole('button', { name: 'Show Sketch 3' }),
    ).toBeInTheDocument();
  });

  it('has a 44 px target on touch density', () => {
    setup({ density: 'touch' });
    expect(within(row(/Sketch 3/)).getByTestId('sketch-eye').className).toMatch(/size-11/);
  });

  it('draws no eye without a handler', () => {
    setup({ onSketchVisibility: undefined });
    expect(screen.queryByTestId('sketch-eye')).toBeNull();
  });

  it('the row description says what the viewport shows', () => {
    setup();
    expect(row(/Sketch 3/)).toHaveAccessibleName(/Shown in the viewport \(automatic\)/);
  });
});

/* ------------------------------------------------------------------ drag */

describe('drag and drop', () => {
  beforeAll(() => {
    // jsdom has no layout: rows are 32 px high, stacked in DOM order.
    const order = (el: HTMLElement) => {
      const parent = el.parentElement;
      return parent ? Array.from(parent.children).indexOf(el) : 0;
    };
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('role') === 'treeitem' ? order(this) * 32 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 32,
    });
    Element.prototype.setPointerCapture = () => {};
  });
  afterEach(() => vi.restoreAllMocks());

  function drag(el: HTMLElement, toY: number) {
    const grip = el.querySelector('[data-grip]') as HTMLElement;
    fireEvent.pointerDown(grip, { clientY: 10, button: 0, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientY: toY, pointerId: 1 });
    return {
      drop: () => fireEvent.pointerUp(grip, { clientY: toY, pointerId: 1 }),
    };
  }
  // rows (folder open): e1 0, folder 32, f1 64, f2 96, e2 128, h1 160, s3 192; bottom 224
  const Y = { beforeF2: 96, beforeE2: 128, beforeH1: 160, end: 224 };

  it('dragging a member out shows the out indicator and asks before moving', async () => {
    const { props } = setup();
    const d = drag(row(/Fillet 1/), Y.beforeE2);
    const ind = screen.getByTestId('drop-indicator');
    expect(ind).toHaveAttribute('data-kind', 'out');
    expect(ind).toHaveTextContent('Out of Mounting');
    d.drop();
    const prompt = await screen.findByRole('group', { name: 'Take Fillet 1 out of Mounting?' });
    expect(props.onMove).not.toHaveBeenCalled();
    await userEvent.click(within(prompt).getByRole('button', { name: 'Take it out' }));
    expect(props.onMove).toHaveBeenCalledWith('f1', 3);
    const line = await screen.findByTestId('undo-line');
    expect(line).toHaveTextContent('Took Fillet 1 out of Mounting.');
    await userEvent.click(within(line).getByRole('button', { name: 'Undo' }));
    expect(props.onUndo).toHaveBeenCalled();
  });

  it('"Keep it in" and Escape change nothing', async () => {
    const { props } = setup();
    drag(row(/Fillet 1/), Y.beforeE2).drop();
    await userEvent.click(await screen.findByRole('button', { name: 'Keep it in' }));
    expect(screen.queryByTestId('leave-prompt')).toBeNull();
    await new Promise((r) => requestAnimationFrame(() => r(0)));
    drag(row(/Fillet 1/), Y.beforeE2).drop();
    await screen.findByTestId('leave-prompt');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('leave-prompt')).toBeNull();
    expect(props.onMove).not.toHaveBeenCalled();
  });

  it('dropping strictly between two members adds the feature (indicator marks "Into")', async () => {
    const { props } = setup();
    const d = drag(row(/Hole 1/), Y.beforeF2);
    const ind = screen.getByTestId('drop-indicator');
    expect(ind).toHaveAttribute('data-kind', 'into');
    expect(ind).toHaveTextContent('Into Mounting');
    expect(folderRow()).toHaveAttribute('data-drop-target', 'true');
    d.drop();
    await waitFor(() => expect(props.onMove).toHaveBeenCalledWith('h1', 3));
    expect(await screen.findByTestId('undo-line')).toHaveTextContent('Added Hole 1 to Mounting.');
  });

  it('dropping next to the folder is an ordinary move, with no prompt', async () => {
    const { props } = setup();
    drag(row(/Hole 1/), Y.beforeE2).drop();
    await waitFor(() => expect(props.onMove).toHaveBeenCalledWith('h1', 4));
    expect(screen.queryByTestId('leave-prompt')).toBeNull();
  });

  it('dragging the folder moves the run: onMoveFolder(id, toIndex)', async () => {
    const { props } = setup();
    drag(folderRow(), Y.end).drop();
    await waitFor(() => expect(props.onMoveFolder).toHaveBeenCalledWith('m', 6));
    expect(props.onMove).not.toHaveBeenCalled();
  });

  it('a refused move shakes and explains', async () => {
    const { props } = setup({
      onMoveFolder: vi.fn(() => ({ ok: false as const, reason: 'Fillet 2 needs Extrude 2.' })),
    });
    drag(folderRow(), Y.end).drop();
    await waitFor(() => expect(props.onMoveFolder).toHaveBeenCalled());
    expect(await screen.findByTestId('tree-notice')).toHaveTextContent('Fillet 2 needs Extrude 2.');
  });

  it('a short wiggle is not a drag', () => {
    const { props } = setup();
    drag(row(/Hole 1/), 12).drop();
    expect(props.onMove).not.toHaveBeenCalled();
  });

  it('Alt+Arrow moves a member out through the same prompt', async () => {
    const { props } = setup();
    row(/Fillet 2/).focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await screen.findByRole('group', { name: 'Take Fillet 2 out of Mounting?' });
    await userEvent.click(screen.getByRole('button', { name: 'Take it out' }));
    // the first place below that changes anything: past Extrude 2, before Hole 1
    expect(props.onMove).toHaveBeenCalledWith('f2', 5);
  });

  it('Alt+Arrow on a folder moves the whole run', async () => {
    const { props } = setup();
    folderRow().focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    // next place below: before Hole 1 (past Extrude 2 and its sketch)
    expect(props.onMoveFolder).toHaveBeenCalledWith('m', 4);
  });
});

/* ------------------------------------------------------------------ phone */

describe('phone shell Features tab', () => {
  it('opens the tree with the stepper and restores the model when the tab is left', async () => {
    const onExit = vi.fn();
    renderUI(
      <AppShell
        tier="phone"
        documentName="Bracket"
        kernelStatus={{ state: 'idle' }}
        viewport={<div />}
        phoneFeatureTree={{
          tree: { features, folders: [mounting] },
          previewIndex: 4,
          onPreview: () => {},
          onKeep: () => {},
          onExit,
        }}
      />,
    );
    const tabs = screen.getByRole('group', { name: 'Viewer tools' });
    fireEvent.click(within(tabs).getByRole('button', { name: 'Features' }));
    expect(await screen.findByRole('slider', { name: 'Feature position' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /^Mounting/ })).toBeInTheDocument();
    fireEvent.click(within(tabs).getByRole('button', { name: 'Params' }));
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('slider')).toBeNull();
  });
});

describe('phone step-through', () => {
  const tree = { features, folders: [mounting] };
  function phone(over: Partial<React.ComponentProps<typeof PhoneFeatureTree>> = {}) {
    const props = {
      tree,
      previewIndex: null,
      onPreview: vi.fn(),
      onKeep: vi.fn(),
      onExit: vi.fn(),
      ...over,
    };
    const view = renderUI(<PhoneFeatureTree {...props} />);
    return { props, ...view };
  }

  it('shows the folder and labels the step', () => {
    phone({ previewIndex: 4 });
    expect(screen.getByRole('treeitem', { name: /^Mounting/ })).toBeInTheDocument();
    // steps: E1 F1 F2 E2 H1 S3; position 4 = after Fillet 2 -> step 3
    expect(screen.getByTestId('step-label')).toHaveTextContent('3 of 6 · Fillet 2');
  });

  it('Previous and Next preview the neighbouring rollback positions', async () => {
    const { props } = phone({ previewIndex: 4 });
    await userEvent.click(screen.getByRole('button', { name: 'Previous feature' }));
    expect(props.onPreview).toHaveBeenLastCalledWith(3);
    await userEvent.click(screen.getByRole('button', { name: 'Next feature' }));
    expect(props.onPreview).toHaveBeenLastCalledWith(6);
  });

  it('the scrubber is a slider over the steps with a spoken label', () => {
    const { props } = phone({ previewIndex: 4 });
    const slider = screen.getByRole('slider', { name: 'Feature position' });
    expect(slider).toHaveAttribute('max', '5');
    expect(slider).toHaveValue('2');
    expect(slider).toHaveAttribute('aria-valuetext', '3 of 6 · Fillet 2');
    fireEvent.change(slider, { target: { value: '0' } });
    expect(props.onPreview).toHaveBeenLastCalledWith(2);
  });

  it('Previous / Next stop at the ends', () => {
    phone({ previewIndex: null });
    expect(screen.getByRole('button', { name: 'Next feature' })).toBeDisabled();
    expect(screen.getByTestId('step-label')).toHaveTextContent('6 of 6 · Sketch 3');
  });

  it('a collapsed folder is one step; opening it steps inside', async () => {
    const { rerender, props } = phone({
      previewIndex: 2,
      tree: { ...tree, collapsedFolders: ['m'] },
    });
    expect(screen.getByTestId('step-label')).toHaveTextContent('1 of 5 · Extrude 1');
    await userEvent.click(screen.getByRole('button', { name: 'Next feature' }));
    expect(props.onPreview).toHaveBeenLastCalledWith(4);
    expect(screen.getByRole('slider')).toHaveAttribute('max', '4');
    rerender(<PhoneFeatureTree {...props} tree={{ ...tree, collapsedFolders: [] }} />);
    expect(screen.getByRole('slider')).toHaveAttribute('max', '5');
  });

  it('Keep and Exit appear only while previewing', async () => {
    const { props, unmount } = phone({ previewIndex: 4 });
    await userEvent.click(screen.getByRole('button', { name: 'Keep this rollback' }));
    expect(props.onKeep).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Back to full model' }));
    expect(props.onExit).toHaveBeenCalledTimes(1);
    unmount();
    phone({ previewIndex: null });
    expect(screen.queryByRole('button', { name: 'Keep this rollback' })).toBeNull();
  });

  it('leaving the tab mid-preview restores the model', async () => {
    const { props, unmount } = phone({ previewIndex: 4 });
    expect(props.onExit).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(props.onExit).toHaveBeenCalledTimes(1));
  });

  it('does not call exit on unmount when not previewing', async () => {
    const { props, unmount } = phone({ previewIndex: null });
    unmount();
    await new Promise((r) => setTimeout(r, 10));
    expect(props.onExit).not.toHaveBeenCalled();
  });

  it('is read-only: no grips with a move handler, no reorder, the eye still works', async () => {
    const onSketchVisibility = vi.fn();
    phone({ tree: { ...tree, onSketchVisibility } });
    expect(
      screen.getAllByTestId('feature-tree')[0]?.querySelector('[data-grip].cursor-grab'),
    ).toBeNull();
    const eye = within(screen.getByRole('treeitem', { name: /Sketch 3/ })).getByTestId(
      'sketch-eye',
    );
    expect(eye.className).toMatch(/size-11/);
    await userEvent.click(eye);
    expect(onSketchVisibility).toHaveBeenCalledWith(['s3'], 'hidden');
  });

  it('stepper buttons are at least 44 px', () => {
    renderUI(
      <FeatureStepper
        steps={[{ index: 1, label: 'A' }]}
        at={0}
        previewing
        onStep={() => {}}
        onKeep={() => {}}
        onExit={() => {}}
      />,
    );
    for (const name of [
      'Previous feature',
      'Next feature',
      'Keep this rollback',
      'Back to full model',
    ]) {
      expect(screen.getByRole('button', { name }).className).toMatch(/h-11/);
    }
  });
});
