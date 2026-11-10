import type { Id } from '@wren-cad/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  applySteps,
  buildRows,
  canFolder,
  effectiveSketchShown,
  folderCommands,
  folderRange,
  membershipAfterMove,
  planBlockMove,
  planFolderMove,
  runWithNested,
  sketchVisibilityCommands,
  TREE_COMMAND_IDS,
  type TreeFolder,
  toggledVisibility,
} from '../src';
import { computeNesting } from '../src/logic/treeNesting';

/* Pure rules of M3.6: folder creation, drops -> membership, folder moves, rows, steps, visibility. */

const region = (s: string) => ({ name: `S${s}:region(e1)`, kind: 'region' as const });
const sk = (id: string) => ({ id, name: `Sketch ${id}`, type: 'sketch' });
const ft = (id: string, ...sketches: string[]) => ({
  id,
  name: id.toUpperCase(),
  type: 'extrude',
  profile: sketches.map(region),
});
// 0 s1, 1 e1 (uses s1), 2 f1, 3 f2, 4 s2, 5 e2 (uses s2), 6 h1
const features = [sk('s1'), ft('e1', 's1'), ft('f1'), ft('f2'), sk('s2'), ft('e2', 's2'), ft('h1')];
const ids = features.map((f) => f.id);
const mounting: TreeFolder = { id: 'm', name: 'Mounting', features: ['f1', 'f2'] };

describe('canFolder', () => {
  it('accepts a contiguous run outside every folder', () => {
    expect(canFolder(features, [], ['f1', 'f2'])).toEqual({ ok: true });
    expect(canFolder(features, [mounting], ['h1'])).toEqual({ ok: true });
  });
  it('refuses an empty selection with a reason', () => {
    expect(canFolder(features, [], [])).toEqual({
      ok: false,
      reason: expect.stringContaining('Select'),
    });
  });
  it('refuses a gap and names what sits in it', () => {
    const r = canFolder(features, [], ['e1', 'f2']);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/consecutive.*F1/);
  });
  it('refuses features already in a folder and names it', () => {
    const r = canFolder(features, [mounting], ['f2', 's2']);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/already in the folder “Mounting”/);
  });
  it('refuses an unknown id', () => {
    expect(canFolder(features, [], ['nope']).ok).toBe(false);
  });
  it('is order independent', () => {
    expect(canFolder(features, [], ['f2', 'f1']).ok).toBe(true);
  });
});

describe('runWithNested', () => {
  it('brings a feature’s nested sketch and sorts by history', () => {
    const nesting = computeNesting(features);
    expect(runWithNested(features, nesting, ['e1'])).toEqual(['s1', 'e1']);
    expect(runWithNested(features, nesting, ['f1', 'e1'])).toEqual(['s1', 'e1', 'f1']);
  });
});

describe('folderRange', () => {
  it('gives the inclusive run, or null when a member is gone', () => {
    expect(folderRange(features, mounting)).toEqual({ start: 2, end: 3 });
    expect(folderRange(features, { features: ['zzz'] })).toBeNull();
  });
});

describe('drop -> membership', () => {
  const reorder = (block: Id[], ref: Id | undefined) =>
    applySteps(ids, planBlockMove(ids, block, ref));

  it('a member dragged out of the run leaves', () => {
    expect(membershipAfterMove(reorder(['f1'], 'e2'), [mounting], ['f1'])).toEqual({
      leaves: 'm',
    });
  });
  it('dropping just before the first or after the last member joins nothing', () => {
    expect(membershipAfterMove(reorder(['h1'], 'f1'), [mounting], ['h1'])).toEqual({});
    expect(membershipAfterMove(reorder(['h1'], 'e2'), [mounting], ['h1'])).toEqual({});
  });
  it('a non-member dropped strictly between two members joins', () => {
    expect(membershipAfterMove(reorder(['h1'], 'f2'), [mounting], ['h1'])).toEqual({ joins: 'm' });
  });
  it('reordering inside the run stays', () => {
    const three: TreeFolder = { id: 't', name: 'T', features: ['f1', 'f2', 's2'] };
    const order = reorder(['f1'], 's2');
    expect(membershipAfterMove(order, [three], ['f1'])).toEqual({});
  });
  it('the only member of a folder leaves when moved', () => {
    const one: TreeFolder = { id: 'o', name: 'One', features: ['h1'] };
    expect(membershipAfterMove(reorder(['h1'], 'e1'), [one], ['h1'])).toEqual({ leaves: 'o' });
  });
  it('a member dropped inside another folder leaves its own and joins that one (gate B1)', () => {
    const one: TreeFolder = { id: 'o', name: 'One', features: ['h1'] };
    expect(membershipAfterMove(reorder(['h1'], 'f2'), [mounting, one], ['h1'])).toEqual({
      leaves: 'o',
      joins: 'm',
    });
  });
  it('a feature block moves with its sketch, sketch first when moving up', () => {
    const steps = planBlockMove(ids, ['s2', 'e2'], 'f1');
    expect(steps.map((s) => s.id)).toEqual(['s2', 'e2']);
    expect(applySteps(ids, steps)).toEqual(['s1', 'e1', 's2', 'e2', 'f1', 'f2', 'h1']);
  });
});

describe('planFolderMove', () => {
  it('toIndex is the first member position with the run taken out', () => {
    expect(planFolderMove(features, [mounting], 'm', 7)).toEqual({ ok: true, toIndex: 5 });
    expect(planFolderMove(features, [mounting], 'm', 6)).toEqual({ ok: true, toIndex: 4 });
    expect(planFolderMove(features, [mounting], 'm', 0)).toEqual({ ok: true, toIndex: 0 });
  });
  it('is a no-op at and inside its own run', () => {
    for (const g of [2, 3, 4]) expect(planFolderMove(features, [mounting], 'm', g).ok).toBe('noop');
  });
  it('refuses a spot inside another folder', () => {
    const other: TreeFolder = { id: 'o', name: 'Other', features: ['s2', 'e2', 'h1'] };
    const r = planFolderMove(features, [mounting, other], 'm', 5);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/inside the folder “Other”/);
  });
});

describe('buildRows', () => {
  const nesting = computeNesting(features);
  const input = {
    features,
    nesting,
    folders: [mounting],
    expanded: new Set<Id>(),
    collapsed: new Set<Id>(),
  };
  it('lists a folder before its members, members one level in', () => {
    const rows = buildRows(input);
    expect(rows.map((r) => `${r.level}:${r.key}`)).toEqual([
      '1:e1',
      '1:folder:m',
      '2:f1',
      '2:f2',
      '1:e2',
      '1:h1',
    ]);
    expect(rows.find((r) => r.key === 'f1')?.folderId).toBe('m');
  });
  it('a collapsed folder hides its members', () => {
    const rows = buildRows({ ...input, collapsed: new Set(['m']) });
    expect(rows.map((r) => r.key)).toEqual(['e1', 'folder:m', 'e2', 'h1']);
  });
  it('a sketch nested under a member sits two levels in', () => {
    const f2: TreeFolder = { id: 'x', name: 'X', features: ['s2', 'e2'] };
    const rows = buildRows({ ...input, folders: [f2], expanded: new Set(['e2']) });
    expect(rows.map((r) => `${r.level}:${r.key}`)).toEqual([
      '1:e1',
      '1:f1',
      '1:f2',
      '1:folder:x',
      '2:e2',
      '3:s2',
      '1:h1',
    ]);
  });
});

describe('sketch visibility rules', () => {
  it('auto follows consumption; explicit settings win', () => {
    expect(effectiveSketchShown(undefined, false)).toBe(true);
    expect(effectiveSketchShown('auto', true)).toBe(false);
    expect(effectiveSketchShown('shown', true)).toBe(true);
    expect(effectiveSketchShown('hidden', false)).toBe(false);
  });
  it('a click writes the opposite, explicitly', () => {
    expect(toggledVisibility(true)).toBe('hidden');
    expect(toggledVisibility(false)).toBe('shown');
  });
});

describe('palette commands', () => {
  it('show / hide / reset call once with every sketch id', () => {
    const on = vi.fn();
    const cmds = sketchVisibilityCommands(features, on);
    expect(cmds.map((c) => c.id)).toEqual([
      TREE_COMMAND_IDS.showAllSketches,
      TREE_COMMAND_IDS.hideAllSketches,
      TREE_COMMAND_IDS.resetSketchVisibility,
    ]);
    expect(cmds.map((c) => c.label)).toEqual([
      'Show all sketches',
      'Hide all sketches',
      'Reset sketch visibility',
    ]);
    cmds[0]?.run?.();
    cmds[1]?.run?.();
    cmds[2]?.run?.();
    expect(on.mock.calls).toEqual([
      [['s1', 's2'], 'shown'],
      [['s1', 's2'], 'hidden'],
      [['s1', 's2'], 'auto'],
    ]);
  });
  it('are disabled with a hint when there are no sketches', () => {
    const cmds = sketchVisibilityCommands([ft('e1')], vi.fn());
    expect(cmds.every((c) => c.disabled && c.hint === 'No sketches')).toBe(true);
  });
  it('the folder command is disabled with the reason when the selection cannot be grouped', () => {
    const [c] = folderCommands(features, [], ['e1', 'f2'], vi.fn());
    expect(c?.disabled).toBe(true);
    expect(c?.hint).toMatch(/consecutive/);
    const ok = vi.fn();
    const [d] = folderCommands(features, [], ['f1', 'f2'], ok);
    expect(d?.disabled).toBe(false);
    d?.run?.();
    expect(ok).toHaveBeenCalledWith(['f1', 'f2']);
  });
});
