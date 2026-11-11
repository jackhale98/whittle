// SPDX-License-Identifier: GPL-3.0-or-later
import type { Command, Feature, JsonPatchOp, Part, WrenDoc } from '@wren-cad/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore, newDoc, newPart, type StoreOptions, validateDoc } from '../src';
import { box, extrude, fillet, id, sampleDoc, sketch } from './fixtures';

function setup(opts: StoreOptions = {}) {
  let t = 1_000_000;
  const clock = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const doc = newDoc({ now: '2026-01-01T00:00:00.000Z' });
  const part: Part = { id: id(1), name: 'P', features: [], rollbackIndex: 0 };
  doc.parts = [part];
  const store = createDocumentStore(doc, { clock, ...opts });
  return { store, advance };
}

const must = (r: { ok: boolean; error?: string }) => {
  if (!r.ok) throw new Error(r.error);
};
const pid = id(1);
const part = (store: ReturnType<typeof setup>['store']) => store.getDoc().parts[0] as Part;
const names = (store: ReturnType<typeof setup>['store']) => part(store).features.map((f) => f.name);

const add = (store: ReturnType<typeof setup>['store'], f: Feature, index?: number) =>
  store.apply(
    index === undefined
      ? { kind: 'addFeature', partId: pid, feature: f }
      : { kind: 'addFeature', partId: pid, feature: f, index },
  );

describe('apply / undo / redo', () => {
  it('applies commands immutably and notifies subscribers', () => {
    const { store } = setup();
    const before = store.getDoc();
    const listener = vi.fn();
    store.subscribe(listener);
    must(add(store, box(10)));
    expect(store.getDoc()).not.toBe(before);
    expect(before.parts[0]?.features).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(1);
    const [doc, change] = listener.mock.calls[0] as [WrenDoc, { patches: JsonPatchOp[] }];
    expect(doc).toBe(store.getDoc());
    expect(change.patches.length).toBeGreaterThan(0);
  });

  it('undo restores the exact previous document; redo reapplies', () => {
    const { store } = setup();
    const d0 = store.getDoc();
    must(add(store, box(10)));
    const d1 = store.getDoc();
    must(add(store, box(11)));
    must(store.apply({ kind: 'renamePart', partId: pid, name: 'Renamed' }));
    const d3 = store.getDoc();
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);
    expect(store.undo()).toBe(true);
    expect(part(store).name).toBe('P');
    expect(store.undo()).toBe(true);
    expect(store.getDoc()).toEqual(d1);
    expect(store.undo()).toBe(true);
    expect(store.getDoc()).toEqual(d0);
    expect(store.undo()).toBe(false);
    expect(store.canRedo()).toBe(true);
    expect(store.redo() && store.redo() && store.redo()).toBe(true);
    expect(store.getDoc()).toEqual(d3);
    expect(store.redo()).toBe(false);
  });

  it('a new edit clears the redo stack', () => {
    const { store } = setup();
    must(add(store, box(10)));
    store.undo();
    expect(store.canRedo()).toBe(true);
    must(add(store, box(11)));
    expect(store.canRedo()).toBe(false);
  });

  it('notifies on undo and redo with the patches that were applied', () => {
    const { store } = setup();
    must(add(store, box(10)));
    const seen: JsonPatchOp[][] = [];
    store.subscribe((_d, c) => seen.push(c.patches));
    store.undo();
    store.redo();
    expect(seen).toHaveLength(2);
    expect(seen[0]?.some((o) => o.op === 'remove')).toBe(true);
    expect(seen[1]?.some((o) => o.op === 'add')).toBe(true);
  });

  it('unsubscribe stops notifications; a throwing subscriber does not break the store', async () => {
    const { store } = setup();
    const l = vi.fn();
    const off = store.subscribe(l);
    off();
    must(add(store, box(10)));
    expect(l).not.toHaveBeenCalled();
    const unhandled = vi.fn();
    process.once('uncaughtException', unhandled);
    store.subscribe(() => {
      throw new Error('boom');
    });
    expect(add(store, box(11)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(unhandled).toHaveBeenCalled();
  });

  it('failed commands change nothing and give a human error', () => {
    const { store } = setup();
    const before = store.getDoc();
    const r = store.apply({ kind: 'renamePart', partId: 'nope', name: 'x' });
    expect(r).toEqual({ ok: false, error: 'Part ‘nope’ was not found' });
    expect(store.getDoc()).toBe(before);
    expect(store.canUndo()).toBe(false);
    const bad = store.apply({ kind: 'patch', ops: [{ op: 'remove', path: '/parts/9' }] });
    expect(bad.ok).toBe(false);
    expect(store.getDoc()).toBe(before);
  });

  it('no-op commands do not create history entries', () => {
    const { store } = setup();
    must(store.apply({ kind: 'setRollback', partId: pid, index: 0 }));
    must(store.apply({ kind: 'setMaterial', partId: pid, material: null }));
    expect(store.canUndo()).toBe(false);
  });

  it('keeps meta.modified current and restores it on undo', () => {
    const { store, advance } = setup();
    advance(5000);
    must(add(store, box(10)));
    expect(store.getDoc().meta.modified).toBe(new Date(1_005_000).toISOString());
    store.undo();
    expect(store.getDoc().meta.modified).toBe('2026-01-01T00:00:00.000Z');
    const off = setup({ trackModified: false });
    must(add(off.store, box(10)));
    expect(off.store.getDoc().meta.modified).toBe('2026-01-01T00:00:00.000Z');
  });

  it('bounds history depth', () => {
    const { store } = setup({ maxHistory: 3 });
    for (let i = 0; i < 6; i++) must(add(store, box(10 + i)));
    expect(store.history().past).toHaveLength(3);
  });

  it('history() labels, oldest first; future lists the next redo first', () => {
    const { store } = setup();
    must(add(store, box(10)));
    must(store.apply({ kind: 'renamePart', partId: pid, name: 'Housing' }));
    must(store.apply({ kind: 'setDocName', name: 'Doc' }, { label: 'Name it' }));
    expect(store.history().past.map((h) => h.label)).toEqual(['Add Box 10', 'Rename P', 'Name it']);
    store.undo();
    store.undo();
    const h = store.history();
    expect(h.past.map((e) => e.label)).toEqual(['Add Box 10']);
    expect(h.future.map((e) => e.label)).toEqual(['Rename P', 'Name it']);
    expect(h.past[0]?.at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe('coalescing', () => {
  const edit = (store: ReturnType<typeof setup>['store'], mm: number, key = 'drag') =>
    store.apply(
      {
        kind: 'updateFeature',
        partId: pid,
        featureId: id(10),
        feature: box(10, { dx: `${mm}mm` }),
      },
      { coalesceKey: key, label: 'Edit Box 10 width' },
    );

  it('merges same-key edits into one undo step until commit()', () => {
    const { store, advance } = setup();
    must(add(store, box(10)));
    for (let i = 1; i <= 20; i++) {
      advance(16);
      must(edit(store, 40 + i));
    }
    expect(store.history().past).toHaveLength(2);
    expect((part(store).features[0] as Feature & { dx: string }).dx).toBe('60mm');
    // The merged entry carries a compact patch, not 20.
    store.undo();
    expect((part(store).features[0] as Feature & { dx: string }).dx).toBe('40mm');
    expect(store.history().past).toHaveLength(1);
    store.redo();
    expect((part(store).features[0] as Feature & { dx: string }).dx).toBe('60mm');
  });

  it('commit() ends the group', () => {
    const { store } = setup();
    must(add(store, box(10)));
    must(edit(store, 41));
    must(edit(store, 42));
    store.commit();
    must(edit(store, 43));
    expect(store.history().past).toHaveLength(3);
    store.undo();
    expect((part(store).features[0] as Feature & { dx: string }).dx).toBe('42mm');
  });

  it('cancelGroup() reverts an open group and leaves nothing on either stack', () => {
    const { store } = setup();
    must(add(store, box(10)));
    must(store.apply({ kind: 'renamePart', partId: pid, name: 'before' }));
    store.undo(); // a redo entry exists before the drag starts
    must(edit(store, 41));
    must(edit(store, 42));
    expect(store.history().past).toHaveLength(2);
    expect(store.history().future).toHaveLength(0);
    expect(store.cancelGroup('drag')).toBe(true);
    const h = store.history();
    expect(h.past).toHaveLength(1);
    expect((part(store).features[0] as Feature & { dx: string }).dx).not.toBe('42mm');
    // The redo stack the drag cleared is back: the cancel is as if the drag never began.
    expect(h.future.map((e) => e.label)).toEqual(['Rename P']);
  });

  it('cancelGroup() does nothing for a closed group or another key', () => {
    const { store } = setup();
    must(add(store, box(10)));
    must(edit(store, 41));
    expect(store.cancelGroup('other')).toBe(false);
    store.commit();
    expect(store.cancelGroup('drag')).toBe(false);
    expect(store.history().past).toHaveLength(2);
    expect((part(store).features[0] as Feature & { dx: string }).dx).toBe('41mm');
  });

  it('a different key, an uncoalesced edit, or the idle window starts a new entry', () => {
    const { store, advance } = setup({ coalesceWindowMs: 500 });
    must(add(store, box(10)));
    must(edit(store, 41));
    must(edit(store, 42, 'other'));
    expect(store.history().past).toHaveLength(3);
    must(store.apply({ kind: 'renamePart', partId: pid, name: 'x' }));
    must(edit(store, 43, 'other'));
    expect(store.history().past).toHaveLength(5);
    advance(501);
    must(edit(store, 44, 'other'));
    expect(store.history().past).toHaveLength(6);
  });

  it('undo closes the group; the next same-key edit is a fresh step', () => {
    const { store } = setup();
    must(add(store, box(10)));
    must(edit(store, 41));
    store.undo();
    must(edit(store, 42));
    expect(store.history().past).toHaveLength(2);
  });

  it('merging non-replace edits keeps correct inverses', () => {
    const { store } = setup();
    const d0 = store.getDoc();
    must(store.apply({ kind: 'addFeature', partId: pid, feature: box(10) }, { coalesceKey: 'k' }));
    must(store.apply({ kind: 'addFeature', partId: pid, feature: box(11) }, { coalesceKey: 'k' }));
    expect(store.history().past).toHaveLength(1);
    store.undo();
    expect(store.getDoc()).toEqual(d0);
    store.redo();
    expect(names(store)).toEqual(['Box 10', 'Box 11']);
  });
});

describe('rollback bar', () => {
  function withFeatures(n: number, bar: number) {
    const s = setup();
    for (let i = 0; i < n; i++) must(add(s.store, box(10 + i)));
    must(s.store.apply({ kind: 'setRollback', partId: pid, index: bar }));
    return s;
  }

  it('appending while fully rolled forward keeps the bar at the end', () => {
    const { store } = setup();
    must(add(store, box(10)));
    must(add(store, box(11)));
    expect(part(store).rollbackIndex).toBe(2);
  });

  it('adding without an index while rolled back inserts at the bar and advances it', () => {
    const { store } = withFeatures(4, 2);
    must(add(store, box(99)));
    expect(names(store)).toEqual(['Box 10', 'Box 11', 'Box 99', 'Box 12', 'Box 13']);
    expect(part(store).rollbackIndex).toBe(3);
  });

  it('explicit indexes before/at the bar advance it; after the bar they do not', () => {
    const a = withFeatures(4, 2);
    must(add(a.store, box(99), 0));
    expect(part(a.store).rollbackIndex).toBe(3);
    const b = withFeatures(4, 2);
    must(add(b.store, box(99), 2));
    expect(part(b.store).rollbackIndex).toBe(3);
    const c = withFeatures(4, 2);
    must(add(c.store, box(99), 3));
    expect(part(c.store).rollbackIndex).toBe(2);
    expect(names(c.store)).toEqual(['Box 10', 'Box 11', 'Box 12', 'Box 99', 'Box 13']);
  });

  it('rejects out-of-range indexes and duplicate ids', () => {
    const { store } = withFeatures(2, 2);
    expect(add(store, box(99), 5).ok).toBe(false);
    expect(add(store, box(99), -1).ok).toBe(false);
    const dup = add(store, box(10));
    expect(dup).toEqual({ ok: false, error: `The id ‘${id(10)}’ is already in use` });
  });

  it('removing a feature before the bar moves it back; after the bar leaves it', () => {
    const a = withFeatures(4, 3);
    must(a.store.apply({ kind: 'removeFeature', partId: pid, featureId: id(10) }));
    expect(part(a.store).rollbackIndex).toBe(2);
    const b = withFeatures(4, 2);
    must(b.store.apply({ kind: 'removeFeature', partId: pid, featureId: id(13) }));
    expect(part(b.store).rollbackIndex).toBe(2);
    const c = withFeatures(4, 4);
    must(c.store.apply({ kind: 'removeFeature', partId: pid, featureId: id(13) }));
    expect(part(c.store).rollbackIndex).toBe(3);
  });

  it('setRollback validates its range', () => {
    const { store } = withFeatures(3, 3);
    expect(store.apply({ kind: 'setRollback', partId: pid, index: 4 }).ok).toBe(false);
    expect(store.apply({ kind: 'setRollback', partId: pid, index: -1 }).ok).toBe(false);
    must(store.apply({ kind: 'setRollback', partId: pid, index: 0 }));
    expect(part(store).rollbackIndex).toBe(0);
  });

  it('moveFeature keeps other features’ evaluated state', () => {
    // [A B C | D E] bar=3. Move C to the end: bar becomes 2 ([A B | D E C]).
    const a = withFeatures(5, 3);
    must(a.store.apply({ kind: 'moveFeature', partId: pid, featureId: id(12), toIndex: 4 }));
    expect(names(a.store)).toEqual(['Box 10', 'Box 11', 'Box 13', 'Box 14', 'Box 12']);
    expect(part(a.store).rollbackIndex).toBe(2);
    // Move E to the front: it lands before the bar, which advances: [E A B C | D].
    const b = withFeatures(5, 3);
    must(b.store.apply({ kind: 'moveFeature', partId: pid, featureId: id(14), toIndex: 0 }));
    expect(names(b.store)).toEqual(['Box 14', 'Box 10', 'Box 11', 'Box 12', 'Box 13']);
    expect(part(b.store).rollbackIndex).toBe(4);
    // Moves within the active region or within the rolled-back region leave the bar alone.
    const c = withFeatures(5, 3);
    must(c.store.apply({ kind: 'moveFeature', partId: pid, featureId: id(10), toIndex: 2 }));
    expect(part(c.store).rollbackIndex).toBe(3);
    must(c.store.apply({ kind: 'moveFeature', partId: pid, featureId: id(13), toIndex: 4 }));
    expect(part(c.store).rollbackIndex).toBe(3);
  });

  it('every bar invariant holds under random edits, and undo/redo returns to each state', () => {
    // Deterministic pseudo-random walk (LCG) so failures reproduce.
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % n;
    };
    const { store } = setup();
    const snapshots: WrenDoc[] = [store.getDoc()];
    let next = 100;
    for (let step = 0; step < 150; step++) {
      const p = part(store);
      const n = p.features.length;
      const choice = rnd(5);
      let cmd: Command;
      if (choice === 0 || n === 0) {
        cmd = { kind: 'addFeature', partId: pid, feature: box(next++), index: rnd(n + 1) };
      } else if (choice === 1) {
        cmd = { kind: 'removeFeature', partId: pid, featureId: (p.features[rnd(n)] as Feature).id };
      } else if (choice === 2) {
        cmd = {
          kind: 'moveFeature',
          partId: pid,
          featureId: (p.features[rnd(n)] as Feature).id,
          toIndex: rnd(n),
        };
      } else if (choice === 3) {
        cmd = { kind: 'setRollback', partId: pid, index: rnd(n + 1) };
      } else {
        cmd = { kind: 'addFeature', partId: pid, feature: box(next++) };
      }
      const r = store.apply(cmd);
      expect(r.ok, JSON.stringify(cmd)).toBe(true);
      const q = part(store);
      expect(q.rollbackIndex).toBeGreaterThanOrEqual(0);
      expect(q.rollbackIndex).toBeLessThanOrEqual(q.features.length);
      expect(validateDoc(store.getDoc())).toEqual([]);
      if (store.getDoc() !== snapshots[snapshots.length - 1]) snapshots.push(store.getDoc());
    }
    for (let i = snapshots.length - 2; i >= 0; i--) {
      if (!store.canUndo()) break;
      store.undo();
      expect(store.getDoc()).toEqual(snapshots[i]);
    }
  });
});

describe('feature commands', () => {
  it('updateFeature compiles to a minimal patch', () => {
    const { store } = setup();
    must(add(store, box(10)));
    const seen: JsonPatchOp[][] = [];
    store.subscribe((_d, c) => seen.push(c.patches));
    must(
      store.apply({
        kind: 'updateFeature',
        partId: pid,
        featureId: id(10),
        feature: box(10, { dx: '41mm', name: 'Box A' }),
      }),
    );
    const ops = (seen[0] as JsonPatchOp[]).filter(
      (o) => 'path' in o && o.path !== '/meta/modified',
    );
    expect(ops).toEqual([
      { op: 'replace', path: '/parts/0/features/0/name', value: 'Box A' },
      { op: 'replace', path: '/parts/0/features/0/dx', value: '41mm' },
    ]);
    expect(
      store.apply({ kind: 'updateFeature', partId: pid, featureId: id(10), feature: box(11) }).ok,
    ).toBe(false);
    expect(
      store.apply({ kind: 'updateFeature', partId: pid, featureId: 'zz', feature: box(10) }).ok,
    ).toBe(false);
  });

  it('does not alias caller-supplied objects', () => {
    const { store } = setup();
    const f = box(10);
    must(add(store, f));
    (f as { dx: string }).dx = 'MUTATED';
    expect((part(store).features[0] as Feature & { dx: string }).dx).toBe('40mm');
  });

  it('setSuppressed and setMaterial', () => {
    const { store } = setup();
    must(add(store, box(10)));
    must(store.apply({ kind: 'setSuppressed', partId: pid, featureId: id(10), suppressed: true }));
    expect(part(store).features[0]?.suppressed).toBe(true);
    expect(store.history().past.at(-1)?.label).toBe('Suppress Box 10');
    must(
      store.apply({
        kind: 'setMaterial',
        partId: pid,
        material: { name: 'Gold', density: '19.3 g/cm^3' },
      }),
    );
    expect(part(store).material?.name).toBe('Gold');
    must(
      store.apply({
        kind: 'setMaterial',
        partId: pid,
        material: { name: 'Lead', density: '11.34 g/cm^3' },
      }),
    );
    expect(part(store).material?.name).toBe('Lead');
    must(store.apply({ kind: 'setMaterial', partId: pid, material: null }));
    expect(part(store).material).toBeUndefined();
    store.undo();
    expect(part(store).material?.name).toBe('Lead');
  });

  it('addPart / renamePart / removeFeature errors', () => {
    const { store } = setup();
    must(store.apply({ kind: 'addPart', part: newPart('Second', id(2)) }));
    expect(store.getDoc().parts).toHaveLength(2);
    expect(store.apply({ kind: 'addPart', part: newPart('Dup', id(2)) }).ok).toBe(false);
    expect(
      store.apply({ kind: 'addPart', part: { ...newPart('Bad', id(3)), rollbackIndex: 4 } }).ok,
    ).toBe(false);
    expect(store.apply({ kind: 'removeFeature', partId: pid, featureId: 'x' }).ok).toBe(false);
  });
});

describe('moveFeature dependency checks', () => {
  function chain() {
    const { store } = setup();
    must(add(store, sketch(11)));
    must(add(store, extrude(12, 11)));
    must(add(store, fillet(13, 12)));
    must(add(store, box(14)));
    return store;
  }

  it('refuses to move a feature above something it references', () => {
    const store = chain();
    const r = store.apply({ kind: 'moveFeature', partId: pid, featureId: id(12), toIndex: 0 });
    expect(r).toEqual({
      ok: false,
      error: 'Can’t move ‘Extrude 12’ above ‘Sketch 11’ — it uses geometry from ‘Sketch 11’.',
    });
    expect(names(store)).toEqual(['Sketch 11', 'Extrude 12', 'Fillet 13', 'Box 14']);
  });

  it('refuses to move a feature below something that references it', () => {
    const store = chain();
    const r = store.apply({ kind: 'moveFeature', partId: pid, featureId: id(12), toIndex: 3 });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(
      /below ‘Fillet 13’.*uses geometry from ‘Extrude 12’/,
    );
  });

  it('allows moves that respect dependencies', () => {
    const store = chain();
    must(store.apply({ kind: 'moveFeature', partId: pid, featureId: id(14), toIndex: 0 }));
    expect(names(store)).toEqual(['Box 14', 'Sketch 11', 'Extrude 12', 'Fillet 13']);
    must(store.apply({ kind: 'moveFeature', partId: pid, featureId: id(14), toIndex: 1 }));
    expect(names(store)).toEqual(['Sketch 11', 'Box 14', 'Extrude 12', 'Fillet 13']);
    expect(
      store.apply({ kind: 'moveFeature', partId: pid, featureId: id(12), toIndex: 9 }).ok,
    ).toBe(false);
    store.undo();
    store.undo();
    expect(names(store)).toEqual(['Sketch 11', 'Extrude 12', 'Fillet 13', 'Box 14']);
  });

  it('understands body references (B<id>) but not look-alike ids', () => {
    const { store } = setup();
    must(add(store, box(11)));
    must(add(store, box(12)));
    must(
      add(store, {
        ...fillet(13, 11),
        edges: [{ name: `B${id(11)}`, kind: 'body' }],
      }),
    );
    const r = store.apply({ kind: 'moveFeature', partId: pid, featureId: id(13), toIndex: 0 });
    expect(r.ok).toBe(false);
    // A name that merely has this id as a prefix of a longer token is not a reference.
    const { store: s2 } = setup();
    must(add(s2, box(11)));
    must(add(s2, { ...fillet(13, 11), edges: [{ name: `B${id(11)}9`, kind: 'body' }] }));
    must(s2.apply({ kind: 'moveFeature', partId: pid, featureId: id(13), toIndex: 0 }));
  });
});

describe('parameters', () => {
  it('adds, updates and removes with validation', () => {
    const { store } = setup();
    must(store.apply({ kind: 'addParam', param: { id: id(50), name: 'width', expr: '40mm' } }));
    expect(
      store.apply({ kind: 'addParam', param: { id: id(51), name: 'width', expr: '1' } }),
    ).toEqual({
      ok: false,
      error: 'A parameter named ‘width’ already exists',
    });
    expect(
      store.apply({ kind: 'addParam', param: { id: id(51), name: 'sin', expr: '1' } }).ok,
    ).toBe(false);
    expect(store.apply({ kind: 'addParam', param: { id: id(51), name: '9x', expr: '1' } }).ok).toBe(
      false,
    );
    must(store.apply({ kind: 'updateParam', paramId: id(50), expr: '50mm', description: 'W' }));
    expect(store.getDoc().params[0]).toMatchObject({ expr: '50mm', description: 'W' });
    must(store.apply({ kind: 'updateParam', paramId: id(50), description: '' }));
    expect(store.getDoc().params[0]?.description).toBeUndefined();
    must(store.apply({ kind: 'removeParam', paramId: id(50) }));
    expect(store.getDoc().params).toHaveLength(0);
    expect(store.apply({ kind: 'removeParam', paramId: id(50) }).ok).toBe(false);
  });

  it('renaming a parameter rewrites references everywhere', () => {
    const { store } = setup();
    must(store.apply({ kind: 'addParam', param: { id: id(50), name: 'width', expr: '40mm' } }));
    must(
      store.apply({
        kind: 'addParam',
        param: { id: id(51), name: 'half', expr: 'width / 2 + widthx' },
      }),
    );
    must(add(store, sketch(11)));
    must(add(store, extrude(12, 11, { end: { kind: 'blind', depth: 'width*2' } })));
    must(store.apply({ kind: 'updateParam', paramId: id(50), name: 'w' }));
    const d = store.getDoc();
    expect(d.params[1]?.expr).toBe('w / 2 + widthx');
    const sk = part(store).features[0] as Feature & { constraints: { value?: string }[] };
    expect(sk.constraints[1]?.value).toBe('w');
    const ex = part(store).features[1] as Feature & { end: { depth: string } };
    expect(ex.end.depth).toBe('w*2');
    // It is a single undo step.
    store.undo();
    expect(store.getDoc().params[1]?.expr).toBe('width / 2 + widthx');
    expect(store.getDoc().params[0]?.name).toBe('width');
  });

  it('refuses renames that collide', () => {
    const { store } = setup();
    must(store.apply({ kind: 'addParam', param: { id: id(50), name: 'a', expr: '1' } }));
    must(store.apply({ kind: 'addParam', param: { id: id(51), name: 'b', expr: '1' } }));
    expect(store.apply({ kind: 'updateParam', paramId: id(50), name: 'b' }).ok).toBe(false);
    expect(store.apply({ kind: 'updateParam', paramId: id(50), name: 'cos' }).ok).toBe(false);
  });
});

describe('load', () => {
  it('replaces the document, clears history and notifies', () => {
    const { store } = setup();
    must(add(store, box(10)));
    const listener = vi.fn();
    store.subscribe(listener);
    const doc = sampleDoc();
    must(store.load(doc));
    expect(store.getDoc()).toEqual(doc);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid documents without touching the current one', () => {
    const { store } = setup();
    const before = store.getDoc();
    const r = store.load({ schemaVersion: 4, units: { length: 'parsec', angle: 'deg' } });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/Invalid document/);
    expect(store.load('nope').ok).toBe(false);
    expect(store.getDoc()).toBe(before);
  });

  it('does not alias the loaded object', () => {
    const { store } = setup();
    const doc = sampleDoc();
    must(store.load(doc));
    doc.meta.name = 'MUTATED';
    expect(store.getDoc().meta.name).toBe('Bracket');
  });
});

describe('historyMentions', () => {
  it('finds strings an undo or redo could bring back, until the history drops them', () => {
    const { store } = setup({ maxHistory: 2 });
    // Any stored string works the same way; an import's attachment path is the use case.
    const imp = box(10, { dx: 'imports/a.step' });
    must(add(store, imp));
    expect(store.historyMentions(['imports/a.step', 'imports/b.step'])).toEqual(
      new Set(['imports/a.step']),
    );
    must(store.apply({ kind: 'removeFeature', partId: pid, featureId: imp.id }));
    store.undo();
    expect(store.historyMentions(['imports/a.step']).size).toBe(1); // a redo removes it again
    store.redo();
    must(add(store, box(11)));
    must(add(store, box(12)));
    // The add and the remove fell off the two-entry history: nothing can restore it now.
    expect(store.historyMentions(['imports/a.step']).size).toBe(0);
    expect(store.historyMentions([]).size).toBe(0);
  });
});
