// SPDX-License-Identifier: GPL-3.0-or-later
import type { Command, FeatureFolder, Part, SketchFeature, WrenDoc } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  compileCommand,
  createDocumentStore,
  fromFiles,
  migrateDoc,
  newDoc,
  normalizeFolders,
  toFiles,
  validateDoc,
} from '../src';
import { box, extrude, fillet, id, sketch } from './fixtures';

const pid = id(1000);
const F = (n: number, name: string, ...members: number[]): FeatureFolder => ({
  id: id(900 + n),
  name,
  features: members.map(id),
});

/** A part of `n` independent boxes (ids 1..n), bar at the end. */
function partOf(n: number, folders?: FeatureFolder[]): Part {
  const p: Part = {
    id: pid,
    name: 'P',
    features: Array.from({ length: n }, (_, k) => box(k + 1)),
    rollbackIndex: n,
  };
  if (folders) p.folders = folders;
  return p;
}

function storeOf(part: Part) {
  const doc = newDoc({ now: '2026-01-01T00:00:00.000Z' });
  doc.parts = [part];
  return createDocumentStore(doc, { clock: () => 1 });
}

const part = (s: ReturnType<typeof storeOf>): Part => s.getDoc().parts[0] as Part;
const ok = (r: { ok: boolean; error?: string }) => expect(r.ok, r.error).toBe(true);
const members = (s: ReturnType<typeof storeOf>) =>
  Object.fromEntries((part(s).folders ?? []).map((f) => [f.name, f.features.map(numOf)]));
const numOf = (i: string) => Number(i.slice(3));
const fail = (s: ReturnType<typeof storeOf>, c: Command, msg: RegExp) => {
  const before = s.getDoc();
  const r = s.apply(c);
  expect(r.ok).toBe(false);
  expect(!r.ok && r.error).toMatch(msg);
  expect(s.getDoc()).toBe(before);
  expect(s.canUndo()).toBe(false);
};
const label = (s: ReturnType<typeof storeOf>) => s.history().past.at(-1)?.label;

/** Applies, checks the label and the document, then undo/redo round-trips. */
function roundTrip(s: ReturnType<typeof storeOf>, c: Command, expected: string) {
  const before = s.getDoc();
  ok(s.apply(c));
  expect(label(s)).toBe(expected);
  expect(validateDoc(s.getDoc())).toEqual([]);
  const after = s.getDoc();
  expect(s.undo()).toBe(true);
  expect(s.getDoc()).toEqual(before);
  expect(s.redo()).toBe(true);
  expect(s.getDoc()).toEqual(after);
}

describe('addFolder', () => {
  it('adds a folder, stores members in history order, one undo entry', () => {
    const s = storeOf(partOf(5));
    roundTrip(
      s,
      { kind: 'addFolder', partId: pid, folder: F(1, 'Mounting', 4, 2, 3) },
      'New folder Mounting',
    );
    expect(members(s)).toEqual({ Mounting: [2, 3, 4] });
    expect(s.history().past).toHaveLength(1);
  });

  it('appends a second folder next to the first', () => {
    const s = storeOf(partOf(6, [F(1, 'A', 1, 2)]));
    roundTrip(s, { kind: 'addFolder', partId: pid, folder: F(2, 'B', 4, 5) }, 'New folder B');
    expect(members(s)).toEqual({ A: [1, 2], B: [4, 5] });
  });

  it('fails without changing anything', () => {
    const s = storeOf(partOf(6, [F(1, 'A', 1, 2)]));
    const add = (folder: FeatureFolder, partId = pid): Command => ({
      kind: 'addFolder',
      partId,
      folder,
    });
    fail(s, add(F(2, 'B')), /at least one feature/);
    fail(s, add(F(2, 'B', 3, 99)), /not found/);
    fail(s, add(F(2, 'B', 3, 5)), /follow one another/);
    fail(s, add(F(2, 'B', 2, 3)), /already in the folder ‘A’/);
    fail(s, add(F(2, 'B', 3, 3)), /only be listed once/);
    fail(s, add({ ...F(1, 'B', 3, 4) }), /already in use/);
    fail(s, add(F(2, '  ', 3, 4)), /needs a name/);
    fail(s, { kind: 'renameFolder', partId: pid, folderId: id(901), name: '' }, /needs a name/);
    fail(s, add({ ...F(2, 'B', 3, 4), id: id(5) }), /already in use/);
    fail(s, add(F(2, 'B', 3, 4), id(7777)), /Part .* was not found/);
  });
});

describe('renameFolder / removeFolder', () => {
  it('renames; renaming to the same name is a no-op', () => {
    const s = storeOf(partOf(4, [F(1, 'A', 1, 2)]));
    const rename = (name: string): Command => ({
      kind: 'renameFolder',
      partId: pid,
      folderId: id(901),
      name,
    });
    roundTrip(s, rename('Bracket'), 'Rename folder A to Bracket');
    expect(s.apply(rename('A')).ok).toBe(true);
    const c = compileCommand(s.getDoc(), rename('A'));
    expect(c.ok && c.ops).toEqual([]);
    fail(
      storeOf(partOf(4)),
      { kind: 'renameFolder', partId: pid, folderId: id(5), name: 'x' },
      /Folder .* was not found/,
    );
  });

  it('removes (ungroups); the last folder takes the key with it', () => {
    const s = storeOf(partOf(5, [F(1, 'A', 1, 2), F(2, 'B', 4, 5)]));
    roundTrip(s, { kind: 'removeFolder', partId: pid, folderId: id(901) }, 'Remove folder A');
    expect(members(s)).toEqual({ B: [4, 5] });
    expect(part(s).features).toHaveLength(5);
    ok(s.apply({ kind: 'removeFolder', partId: pid, folderId: id(902) }));
    expect('folders' in part(s)).toBe(false);
    fail(
      storeOf(partOf(2)),
      { kind: 'removeFolder', partId: pid, folderId: id(1) },
      /Folder .* was not found/,
    );
  });
});

describe('moveFolder', () => {
  const mv = (folderId: string, toIndex: number): Command => ({
    kind: 'moveFolder',
    partId: pid,
    folderId,
    toIndex,
  });
  const order = (s: ReturnType<typeof storeOf>) => part(s).features.map((f) => numOf(f.id));

  it('moves the whole run; toIndex counts with the run taken out', () => {
    const s = storeOf(partOf(6, [F(1, 'A', 2, 3)]));
    roundTrip(s, mv(id(901), 3), 'Move folder A');
    expect(order(s)).toEqual([1, 4, 5, 2, 3, 6]);
    expect(members(s)).toEqual({ A: [2, 3] });
    ok(s.apply(mv(id(901), 0)));
    expect(order(s)).toEqual([2, 3, 1, 4, 5, 6]);
    ok(s.apply(mv(id(901), 4)));
    expect(order(s)).toEqual([1, 4, 5, 6, 2, 3]);
  });

  it('moving to where it already is changes nothing', () => {
    const s = storeOf(partOf(5, [F(1, 'A', 2, 3)]));
    const c = compileCommand(s.getDoc(), mv(id(901), 1));
    expect(c.ok && c.ops).toEqual([]);
  });

  it('refuses to land inside another folder, but may land beside it', () => {
    const s = storeOf(partOf(7, [F(1, 'A', 1, 2), F(2, 'B', 4, 5, 6)]));
    // others (without A): 3,4,5,6,7. Index 2 is between 4 and 5 -> inside B.
    fail(s, mv(id(901), 2), /into the folder ‘B’/);
    ok(s.apply(mv(id(901), 1))); // between 3 and 4: just before B
    expect(order(s)).toEqual([3, 1, 2, 4, 5, 6, 7]);
    ok(s.apply(mv(id(901), 4))); // after B's last member
    expect(order(s)).toEqual([3, 4, 5, 6, 1, 2, 7]);
  });

  it('keeps other features’ evaluated state when the run crosses the rollback bar', () => {
    const p = partOf(6, [F(1, 'A', 1, 2)]);
    p.rollbackIndex = 4; // 1..4 evaluated
    const s = storeOf(p);
    ok(s.apply(mv(id(901), 3))); // order 3,4,5,1,2,6: others active = 3,4 (2)
    expect(part(s).rollbackIndex).toBe(2);
    ok(s.apply(mv(id(901), 0)));
    expect(part(s).rollbackIndex).toBe(4);
  });

  it('refuses reorders that break feature references, like moveFeature', () => {
    const doc = newDoc();
    const p: Part = {
      id: pid,
      name: 'P',
      features: [sketch(1), extrude(2, 1), box(3), fillet(4, 2)],
      rollbackIndex: 4,
      folders: [F(1, 'Body', 2, 3)],
    };
    doc.parts = [p];
    const s = createDocumentStore(doc);
    fail(s, mv(id(901), 0), /Can’t move ‘Body’ above ‘Sketch 1’/);
    fail(s, mv(id(901), 2), /below ‘Fillet 4’/);
  });

  it('lands exactly where asked from every start to every target', () => {
    for (const run of [[1], [2, 3], [1, 2, 3], [4, 5, 6], [3, 4, 5]]) {
      const n = 6;
      const rest = Array.from({ length: n }, (_, k) => k + 1).filter((x) => !run.includes(x));
      for (let to = 0; to <= rest.length; to++) {
        const s = storeOf(partOf(n, [F(1, 'A', ...run)]));
        const r = s.apply(mv(id(901), to));
        expect(r.ok).toBe(true);
        expect(order(s)).toEqual([...rest.slice(0, to), ...run, ...rest.slice(to)]);
        expect(members(s)).toEqual({ A: run });
      }
    }
  });

  it('rejects bad indices and unknown folders', () => {
    const s = storeOf(partOf(4, [F(1, 'A', 1, 2)]));
    fail(s, mv(id(901), 3), /position 3/);
    fail(s, mv(id(901), -1), /position -1/);
    fail(s, mv(id(901), 0.5), /position 0.5/);
    fail(s, mv(id(5), 0), /Folder .* was not found/);
  });
});

describe('setSuppressedMany', () => {
  const sup = (
    featureIds: string[],
    suppressed = true,
  ): Extract<Command, { kind: 'setSuppressedMany' }> => ({
    kind: 'setSuppressedMany',
    partId: pid,
    featureIds,
    suppressed,
  });
  it('suppresses several features in one undo entry', () => {
    const s = storeOf(partOf(6));
    roundTrip(s, sup([1, 2, 3, 4].map(id)), 'Suppress 4 features');
    expect(part(s).features.filter((f) => f.suppressed)).toHaveLength(4);
    expect(s.history().past).toHaveLength(1);
    roundTrip(s, sup([1, 2, 3, 4].map(id), false), 'Unsuppress 4 features');
  });
  it('ignores unknown ids and already-correct features; names a single feature', () => {
    const s = storeOf(partOf(4));
    ok(s.apply(sup([id(2)])));
    ok(s.apply(sup([id(2), id(3), id(99)])));
    expect(label(s)).toBe('Suppress Box 3');
    expect(part(s).features.map((f) => f.suppressed)).toEqual([false, true, true, false]);
    const c = compileCommand(s.getDoc(), sup([id(99)]));
    expect(c.ok && c.ops).toEqual([]);
  });
  it('fails for an unknown part', () => {
    fail(storeOf(partOf(2)), { ...sup([id(1)]), partId: id(5) }, /Part .* was not found/);
  });
});

describe('setSketchVisibility', () => {
  const vis = (
    featureIds: string[],
    visibility: SketchFeature['visibility'],
  ): Extract<Command, { kind: 'setSketchVisibility' }> => ({
    kind: 'setSketchVisibility',
    partId: pid,
    featureIds,
    visibility: visibility ?? 'auto',
  });
  const mk = () => {
    const p = partOf(0);
    p.features = [sketch(1), sketch(2), box(3), sketch(4)];
    p.rollbackIndex = 4;
    return storeOf(p);
  };
  const v = (s: ReturnType<typeof storeOf>) =>
    part(s).features.map((f) => (f as SketchFeature).visibility);

  it('shows, hides and resets, one entry each', () => {
    const s = mk();
    roundTrip(s, vis([1, 2, 4].map(id), 'shown'), 'Show 3 sketches');
    expect(v(s)).toEqual(['shown', 'shown', undefined, 'shown']);
    roundTrip(s, vis([1, 2].map(id), 'hidden'), 'Hide 2 sketches');
    expect(v(s)).toEqual(['hidden', 'hidden', undefined, 'shown']);
    roundTrip(s, vis([1, 2, 4].map(id), 'auto'), 'Reset visibility of 3 sketches');
    expect(v(s)).toEqual([undefined, undefined, undefined, undefined]);
    expect(Object.hasOwn(part(s).features[0] as object, 'visibility')).toBe(false);
  });
  it('ignores non-sketch and unknown ids; single sketches are named', () => {
    const s = mk();
    ok(s.apply(vis([id(3), id(99), id(2)], 'hidden')));
    expect(label(s)).toBe('Hide Sketch 2');
    expect(v(s)).toEqual([undefined, 'hidden', undefined, undefined]);
    const c = compileCommand(s.getDoc(), vis([id(3)], 'shown'));
    expect(c.ok && c.ops).toEqual([]);
    // absent equals auto: resetting an untouched sketch is a no-op
    const r = compileCommand(s.getDoc(), vis([id(1)], 'auto'));
    expect(r.ok && r.ops).toEqual([]);
  });
  it('fails for an unknown part or visibility', () => {
    const s = mk();
    fail(s, { ...vis([id(1)], 'shown'), partId: id(5) }, /Part .* was not found/);
    fail(s, { ...vis([id(1)], 'shown'), visibility: 'x' as never }, /not a sketch visibility/);
  });
});

describe('folders follow the existing commands', () => {
  const add = (n: number, index?: number): Command =>
    index === undefined
      ? { kind: 'addFeature', partId: pid, feature: box(n) }
      : { kind: 'addFeature', partId: pid, feature: box(n), index };
  const move = (n: number, toIndex: number): Command => ({
    kind: 'moveFeature',
    partId: pid,
    featureId: id(n),
    toIndex,
  });

  it('removeFeature drops the member; an emptied folder disappears', () => {
    const s = storeOf(partOf(5, [F(1, 'A', 2, 3), F(2, 'B', 5)]));
    roundTrip(s, { kind: 'removeFeature', partId: pid, featureId: id(2) }, 'Delete Box 2');
    expect(members(s)).toEqual({ A: [3], B: [5] });
    roundTrip(s, { kind: 'removeFeature', partId: pid, featureId: id(5) }, 'Delete Box 5');
    expect(members(s)).toEqual({ A: [3] });
    ok(s.apply({ kind: 'removeFeature', partId: pid, featureId: id(3) }));
    expect('folders' in part(s)).toBe(false);
    expect(validateDoc(s.getDoc())).toEqual([]);
  });

  it('removing a middle member keeps the rest contiguous', () => {
    const s = storeOf(partOf(5, [F(1, 'A', 1, 2, 3)]));
    ok(s.apply({ kind: 'removeFeature', partId: pid, featureId: id(2) }));
    expect(members(s)).toEqual({ A: [1, 3] });
    expect(validateDoc(s.getDoc())).toEqual([]);
  });

  it('the only member of a one-feature folder moved into another run joins it; its folder goes', () => {
    // Found by the sync fuzz: it used to stay in both folders.
    const s = storeOf(partOf(6, [F(1, 'A', 2, 3, 4), F(2, 'B', 6)]));
    ok(s.apply(move(6, 2))); // 1,2,6,3,4,5 : strictly inside A
    expect(members(s)).toEqual({ A: [2, 6, 3, 4] });
    expect(validateDoc(s.getDoc())).toEqual([]);
  });

  it('moving a one-feature folder’s only member elsewhere takes it out; the folder goes (gate B1)', () => {
    const s = storeOf(partOf(6, [F(1, 'A', 2, 3), F(2, 'B', 6)]));
    ok(s.apply(move(6, 0)));
    expect(members(s)).toEqual({ A: [2, 3] });
    expect(validateDoc(s.getDoc())).toEqual([]);
  });

  it('a folder whose members leave one by one goes when the last one leaves (gate B1)', () => {
    // "Add to new folder" on one Extrude groups its nested sketch too; dragging both out (the tree
    // moves a feature with its nested sketch) must not leave a folder behind.
    const s = storeOf(partOf(5, [F(1, 'A', 2, 3)]));
    ok(s.apply(move(2, 4))); // 1,3,4,5,2
    expect(members(s)).toEqual({ A: [3] });
    ok(s.apply(move(3, 4))); // 1,4,5,2,3
    expect(members(s)).toEqual({});
  });

  it('moveFeature of a member out of its run takes it out', () => {
    const s = storeOf(partOf(6, [F(1, 'A', 2, 3, 4)]));
    roundTrip(s, move(3, 5), 'Move Box 3');
    expect(members(s)).toEqual({ A: [2, 4] });
    expect(part(s).features.map((f) => numOf(f.id))).toEqual([1, 2, 4, 5, 6, 3]);
  });

  it('moving an edge member to the far side of the folder takes it out', () => {
    const s = storeOf(partOf(6, [F(1, 'A', 2, 3, 4)]));
    ok(s.apply(move(2, 4))); // 1,3,4,2,5,6 : 2 is now after the last member
    expect(members(s)).toEqual({ A: [3, 4] });
  });

  it('moveFeature within the run keeps the member, in history order', () => {
    const s = storeOf(partOf(5, [F(1, 'A', 1, 2, 3)]));
    ok(s.apply(move(1, 1))); // 2,1,3,4,5
    expect(members(s)).toEqual({ A: [2, 1, 3] });
  });

  it('moveFeature of a non-member strictly inside a run adds it', () => {
    const s = storeOf(partOf(6, [F(1, 'A', 2, 3, 4)]));
    roundTrip(s, move(6, 2), 'Move Box 6'); // 1,2,6,3,4,5
    expect(members(s)).toEqual({ A: [2, 6, 3, 4] });
  });

  it('landing just before the first or after the last member does not add it', () => {
    const s = storeOf(partOf(6, [F(1, 'A', 2, 3, 4)]));
    ok(s.apply(move(6, 1))); // 1,6,2,3,4,5: directly before the first member
    expect(members(s)).toEqual({ A: [2, 3, 4] });
    ok(s.apply(move(1, 4))); // 6,2,3,4,1,5: directly after the last member
    expect(members(s)).toEqual({ A: [2, 3, 4] });
  });

  it('a member dragged from one folder into another changes folder', () => {
    const s = storeOf(partOf(7, [F(1, 'A', 1, 2, 3), F(2, 'B', 5, 6, 7)]));
    ok(s.apply(move(2, 4))); // 1,3,4,5,2,6,7 : 2 between 5 and 6
    expect(members(s)).toEqual({ A: [1, 3], B: [5, 2, 6, 7] });
    expect(validateDoc(s.getDoc())).toEqual([]);
  });

  it('a folder’s only member moved away empties it, and it goes; moveFolder moves it', () => {
    const s = storeOf(partOf(4, [F(1, 'Solo', 2)]));
    ok(s.apply(move(2, 3)));
    expect(members(s)).toEqual({});
    const t = storeOf(partOf(4, [F(1, 'Solo', 2)]));
    ok(t.apply({ kind: 'moveFolder', partId: pid, folderId: id(901), toIndex: 3 }));
    expect(members(t)).toEqual({ Solo: [2] });
  });

  it('addFeature inside a run joins; at the edges it does not', () => {
    const s = storeOf(partOf(4, [F(1, 'A', 2, 3)]));
    roundTrip(s, add(10, 2), 'Add Box 10'); // 1,2,10,3,4
    expect(members(s)).toEqual({ A: [2, 10, 3] });
    ok(s.apply(add(11, 1)));
    ok(s.apply(add(12, 5))); // 1,11,2,10,3,12,4 : after last member
    expect(members(s)).toEqual({ A: [2, 10, 3] });
    expect(validateDoc(s.getDoc())).toEqual([]);
  });

  it('addFeature at the rollback bar inside a run joins it too', () => {
    const p = partOf(4, [F(1, 'A', 2, 3)]);
    p.rollbackIndex = 2; // bar between 2 and 3
    const s = storeOf(p);
    ok(s.apply(add(10)));
    expect(members(s)).toEqual({ A: [2, 10, 3] });
    expect(part(s).rollbackIndex).toBe(3);
  });

  it('a raw patch that deletes or reorders features is normalised in the same entry', () => {
    const s = storeOf(partOf(6, [F(1, 'A', 2, 3, 4)]));
    const before = s.getDoc();
    ok(s.apply({ kind: 'patch', ops: [{ op: 'remove', path: '/parts/0/features/2' }] }));
    expect(members(s)).toEqual({ A: [2, 4] });
    expect(s.history().past).toHaveLength(1);
    expect(s.undo()).toBe(true);
    expect(s.getDoc()).toEqual(before);
    // a raw move that breaks the run: gap 3 holds no other folder, so the run is extended
    ok(
      s.apply({
        kind: 'patch',
        ops: [{ op: 'move', from: '/parts/0/features/2', path: '/parts/0/features/5' }],
      }),
    );
    expect(members(s)).toEqual({ A: [2, 4, 5, 6, 3] });
    expect(validateDoc(s.getDoc())).toEqual([]);
  });

  it('addPart with broken folders is repaired; duplicate folder ids are refused', () => {
    const s = storeOf(partOf(2));
    const bad = { ...partOf(4, [F(1, 'A', 1, 3)]), id: id(2000) };
    ok(s.apply({ kind: 'addPart', part: bad }));
    expect((s.getDoc().parts[1] as Part).folders?.[0]?.features).toEqual([1, 2, 3].map(id));
    const dup = { ...partOf(0, [F(1, 'X', 1)]), id: id(2001) };
    expect(s.apply({ kind: 'addPart', part: dup }).ok).toBe(false);
  });

  it('keeps the coalescing and undo machinery intact for folder drags', () => {
    const s = storeOf(partOf(6, [F(1, 'A', 2, 3)]));
    for (const to of [1, 2, 3, 4]) {
      ok(
        s.apply(
          { kind: 'moveFolder', partId: pid, folderId: id(901), toIndex: to },
          { coalesceKey: 'drag' },
        ),
      );
    }
    expect(s.history().past).toHaveLength(1);
    expect(s.undo()).toBe(true);
    expect(part(s).features.map((f) => numOf(f.id))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('normalizeFolders', () => {
  const run = (n: number, folders: FeatureFolder[], mutate?: (p: Part) => void) => {
    const p = partOf(n, folders);
    mutate?.(p);
    const r = normalizeFolders(p);
    return {
      r,
      members: Object.fromEntries(
        (r.part.folders ?? []).map((f) => [f.name, f.features.map(numOf)]),
      ),
      kinds: r.changes.map((c) => [c.folderName, c.kind, c.featureIds.map(numOf)]),
    };
  };

  it('returns the same part and no changes when sound', () => {
    const p = partOf(5, [F(1, 'A', 1, 2), F(2, 'B', 4, 5)]);
    const r = normalizeFolders(p);
    expect(r.part).toBe(p);
    expect(r.changes).toEqual([]);
    expect(normalizeFolders(partOf(3)).part.folders).toBeUndefined();
  });

  it('sorts members into history order without reporting it', () => {
    const t = run(5, [F(1, 'A', 3, 1, 2)]);
    expect(t.members).toEqual({ A: [1, 2, 3] });
    expect(t.kinds).toEqual([]);
  });

  it('extends over a gap when it overlaps no other folder', () => {
    const t = run(6, [F(1, 'A', 2, 5)]);
    expect(t.members).toEqual({ A: [2, 3, 4, 5] });
    expect(t.kinds).toEqual([['A', 'extended', [3, 4]]]);
  });

  it('keeps the longest run when the gap holds another folder', () => {
    const t = run(8, [F(1, 'A', 1, 2, 3, 6), F(2, 'B', 4, 5)]);
    expect(t.members).toEqual({ A: [1, 2, 3], B: [4, 5] });
    expect(t.kinds).toEqual([['A', 'trimmed', [6]]]);
  });

  it('breaks a tie towards the earliest run', () => {
    const t = run(8, [F(1, 'A', 1, 2, 5, 6), F(2, 'B', 3, 4)]);
    expect(t.members).toEqual({ A: [1, 2], B: [3, 4] });
    expect(t.kinds).toEqual([['A', 'trimmed', [5, 6]]]);
  });

  it('drops deleted members and removes empty folders', () => {
    const t = run(4, [F(1, 'A', 1, 99), F(2, 'Gone', 98, 97)]);
    expect(t.members).toEqual({ A: [1] });
    expect(t.kinds).toEqual([
      ['A', 'missing', [99]],
      ['Gone', 'missing', [98, 97]],
      ['Gone', 'removed', []],
    ]);
    const all = normalizeFolders(partOf(2, [F(1, 'G', 98)]));
    expect(all.part.folders).toBeUndefined();
    expect('folders' in all.part).toBe(false);
  });

  it('a feature held by two folders stays with the lower folder id', () => {
    const t = run(5, [F(2, 'B', 2, 3), F(1, 'A', 3, 4)]);
    expect(t.members).toEqual({ A: [3, 4], B: [2] });
    expect(t.kinds).toEqual([['B', 'shared', [3]]]);
  });

  it('is deterministic regardless of folder array order, and idempotent', () => {
    const a = F(1, 'A', 1, 3);
    const b = F(2, 'B', 2, 4);
    const x = run(5, [a, b]);
    const y = run(5, [b, a]);
    expect(x.members).toEqual(y.members);
    expect(x.members).toEqual({ A: [1], B: [2, 3, 4] });
    const again = normalizeFolders(x.r.part);
    expect(again.changes).toEqual([]);
    expect(again.part).toBe(x.r.part);
  });

  it('the result always validates', () => {
    const t = run(9, [F(1, 'A', 1, 4, 9), F(2, 'B', 2, 3), F(3, 'C', 5, 7, 99)]);
    const doc = newDoc();
    doc.parts = [t.r.part];
    expect(validateDoc(doc)).toEqual([]);
  });
});

describe('validation', () => {
  const docOf = (p: Part): WrenDoc => {
    const d = newDoc();
    d.parts = [p];
    return d;
  };
  it('accepts sound folders and visibility values', () => {
    const p = partOf(4, [F(1, 'A', 1, 2)]);
    p.features[0] = sketch(1, { visibility: 'hidden' });
    expect(validateDoc(docOf(p))).toEqual([]);
  });
  it('reports membership problems (strict; loading repairs them first)', () => {
    const errs = (folders: FeatureFolder[]) => validateDoc(docOf(partOf(5, folders))).join('|');
    expect(errs([F(1, 'A', 1, 99)])).toMatch(/not in the part/);
    expect(errs([F(1, 'A', 1, 3)])).toMatch(/not a contiguous run/);
    expect(errs([F(1, 'A', 2, 1)])).toMatch(/not in history order/);
    expect(errs([F(1, 'A', 1, 2), F(2, 'B', 2, 3)])).toMatch(/also in/);
    expect(errs([F(1, 'A', 1, 1)])).toMatch(/twice/);
    expect(errs([F(1, 'A')])).toMatch(/no features/);
  });
  it('folder ids are unique across the document', () => {
    expect(validateDoc(docOf(partOf(4, [F(1, 'A', 1), { ...F(1, 'B', 3) }]))).join()).toMatch(
      /duplicate id/,
    );
    expect(validateDoc(docOf(partOf(4, [{ ...F(1, 'A', 1), id: id(2) }]))).join()).toMatch(
      /duplicate id/,
    );
  });
  it('checks name, features and visibility types', () => {
    const bad = (mutate: (p: Part) => void) => {
      const p = partOf(4, [F(1, 'A', 1, 2)]);
      mutate(p);
      return validateDoc(docOf(p)).join('|');
    };
    expect(bad((p) => (((p.folders as FeatureFolder[])[0] as { name: unknown }).name = 3))).toMatch(
      /name must be a string/,
    );
    expect(
      bad((p) => (((p.folders as FeatureFolder[])[0] as { features: unknown }).features = 'x')),
    ).toMatch(/array of feature ids/);
    expect(bad((p) => ((p as { folders: unknown }).folders = {}))).toMatch(
      /folders must be an array/,
    );
    expect(
      bad((p) => {
        p.features[0] = sketch(1, { visibility: 'sometimes' as never });
      }),
    ).toMatch(/visibility must be one of auto, shown, hidden/);
    expect(
      bad((p) => {
        (p.features[1] as { visibility?: string }).visibility = 'shown';
      }),
    ).toMatch(/only valid on sketches/);
  });
});

describe('persistence', () => {
  const docWith = (): WrenDoc => {
    const d = newDoc({ name: 'Folders', now: '2026-01-01T00:00:00.000Z' });
    const p = partOf(0);
    p.features = [
      sketch(1, { visibility: 'shown' }),
      sketch(2, { visibility: 'hidden' }),
      box(3),
      box(4),
    ];
    p.rollbackIndex = 4;
    p.folders = [F(1, 'Mounting', 1, 2), F(2, 'Body', 3, 4)];
    d.parts = [p];
    return d;
  };

  it('round-trips folders and visibility through the codec, byte-identically', () => {
    const d = docWith();
    expect(validateDoc(d)).toEqual([]);
    const files = toFiles(d);
    const back = fromFiles(files);
    expect(back).toEqual(d);
    const again = toFiles(back);
    expect([...again.keys()]).toEqual([...files.keys()]);
    for (const [k, v] of files) expect(again.get(k)).toEqual(v);
    const text = new TextDecoder().decode([...files].find(([k]) => k.startsWith('parts/'))?.[1]);
    // canonical key order: folders sit between `features` and `id`; folder keys sorted
    expect(text.indexOf('"features": [')).toBeLessThan(text.indexOf('"folders": ['));
    expect(text.indexOf('"folders": [')).toBeLessThan(text.indexOf('"rollbackIndex"'));
    expect(text).toMatch(
      /"features": \[\n {8}"01J0+1",\n {8}"01J0+2"\n {6}\],\n {6}"id": "[^"]+",\n {6}"name": "Mounting"/,
    );
    expect(text).toContain('"visibility": "shown"');
  });

  it('writes no folders key when there are none', () => {
    const d = docWith();
    delete (d.parts[0] as Part).folders;
    const text = new TextDecoder().decode(
      [...toFiles(d)].find(([k]) => k.startsWith('parts/'))?.[1],
    );
    expect(text).not.toContain('folders');
  });

  it('repairs a folder a text merge left broken instead of failing the load', () => {
    const d = docWith();
    (d.parts[0] as Part).folders = [F(1, 'Mounting', 1, 99), F(2, 'Body', 3, 4)];
    const back = fromFiles(toFiles(d));
    expect((back.parts[0] as Part).folders?.[0]?.features).toEqual([id(1)]);
    // structurally malformed folders still fail
    const worse = docWith();
    (
      ((worse.parts[0] as Part).folders as unknown as { name: unknown }[])[0] as { name: unknown }
    ).name = 5;
    expect(() => fromFiles(toFiles(worse))).toThrow(/name must be a string/);
  });
});

describe('v1 → v2 migration', () => {
  it('loads a v1 fixture (curves, no folders) unchanged apart from the version', () => {
    const d = docWith1();
    const v1 = { ...structuredClone(d), schemaVersion: 1 };
    const r = migrateDoc(v1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toEqual([2, 3]);
    expect(r.doc).toEqual({ ...d, schemaVersion: 3 });
    expect((r.doc.parts[0] as Part).folders).toBeUndefined();
    // and the result can use the new fields straight away
    const store = createDocumentStore(r.doc);
    ok(
      store.apply({
        kind: 'addFolder',
        partId: pid,
        folder: F(1, 'New', 1, 2),
      }),
    );
  });
});

function docWith1(): WrenDoc {
  const d = newDoc({ name: 'v1', now: '2026-01-01T00:00:00.000Z' });
  d.parts = [partOf(0)];
  (d.parts[0] as Part).features = [sketch(1), box(2), box(3)];
  (d.parts[0] as Part).rollbackIndex = 3;
  return d;
}
