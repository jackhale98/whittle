// SPDX-License-Identifier: GPL-3.0-or-later
import type { Author, ProjectFiles, StorageResult } from '@wren-cad/contracts';
import { fromFiles, toFiles } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import {
  createSnapshotHistory,
  DAY_MS,
  decodeName,
  docMerger,
  encodeName,
  HOUR_MS,
  hashProjectFiles,
  MemoryHistoryFiles,
  mergeProjectFiles,
  selectPrunable,
} from '../src';
import { apply, baseDoc, FILLET, featureOf, P_WIDTH, PART } from './support/fixtures';

const ann: Author = { name: 'Ann', email: 'ann@example.com' };
const value = <T>(r: StorageResult<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

function setup(start = Date.parse('2026-05-01T12:00:00Z')) {
  const files = new MemoryHistoryFiles();
  let t = start;
  let n = 0;
  const clock = {
    advance: (ms: number) => {
      t += ms;
    },
  };
  const make = (store = files, device = 'A') =>
    createSnapshotHistory({
      files: store,
      now: () => new Date(t),
      // ULID-like and ordered by creation, distinct per device.
      newId: () => `01J${device}${String(n++).padStart(22, '0')}`,
    });
  return { files, clock, make };
}

const project = (
  edit?: (doc: ReturnType<typeof baseDoc>) => ReturnType<typeof baseDoc>,
): ProjectFiles => {
  const files = toFiles(edit ? edit(baseDoc()) : baseDoc());
  files.set('imports/bolt.step', new Uint8Array([1, 2, 3]));
  files.set('.wren/meshes/index.json', new Uint8Array([9])); // cache: never versioned
  return files;
};
const width = (expr: string) => (d: ReturnType<typeof baseDoc>) =>
  apply(d, { kind: 'updateParam', paramId: P_WIDTH, expr });

describe('SnapshotHistory', () => {
  it('saves, reads back byte for byte and lays out .wren-history/', async () => {
    const { files, make } = setup();
    const h = make();
    const v = value(await h.saveVersion(project(), 'First', { author: ann }));
    expect(v).toMatchObject({ parents: [], message: 'First', author: ann });
    expect(v.hash).toBe(await hashProjectFiles(project()));
    const back = value(await h.read(v.id));
    expect([...back.keys()].sort()).toEqual(
      [...project().keys()].filter((p) => !p.startsWith('.wren/')).sort(),
    );
    for (const [p, b] of back) expect(b).toEqual(project().get(p));
    expect([...files.files.keys()].sort()).toEqual([
      `.wren-history/refs/heads/main/${v.id}`,
      `.wren-history/snapshots/${v.hash}.zip`,
      `.wren-history/versions/${v.id}.json`,
    ]);
    expect(files.files.get(`.wren-history/refs/heads/main/${v.id}`)?.length).toBe(0);
  });

  it('an unchanged project returns the existing head', async () => {
    const { make } = setup();
    const h = make();
    const a = value(await h.saveVersion(project(), 'First', { author: ann }));
    const b = value(await h.saveVersion(project(), 'Again', { author: ann }));
    expect(b.id).toBe(a.id);
    const c = value(await h.saveVersion(project(width('41mm')), 'Wider', { author: ann }));
    expect(c.parents).toEqual([a.id]);
    expect((await h.log()).map((v) => v.message)).toEqual(['Wider', 'First']);
  });

  it('branches: create, switch, log per branch', async () => {
    const { clock, make } = setup();
    const h = make();
    const a = value(await h.saveVersion(project(), 'First', { author: ann }));
    clock.advance(1000);
    expect(value(await h.createBranch('Try a thin wall'))).toEqual({
      name: 'Try a thin wall',
      head: a.id,
      current: false,
    });
    expect((await h.createBranch('Try a thin wall')).ok).toBe(false);
    const files = value(await h.switchBranch('Try a thin wall'));
    expect(fromFiles(files).params[0]?.expr).toBe('40mm');
    const b = value(await h.saveVersion(project(width('30mm')), 'Thin', { author: ann }));
    expect((await h.log()).map((v) => v.id)).toEqual([b.id, a.id]);
    expect((await h.log({ branch: 'main' })).map((v) => v.id)).toEqual([a.id]);
    expect(await h.branches()).toEqual([
      { name: 'Try a thin wall', head: b.id, current: true },
      { name: 'main', head: a.id, current: false },
    ]);
    const main = value(await h.switchBranch('main'));
    expect(fromFiles(main).params[0]?.expr).toBe('40mm');
    expect(await h.mergeBase(a.id, b.id)).toBe(a.id);
  });

  it('two devices adding versions offline merge by union and show a diverged branch', async () => {
    const { files, clock, make } = setup();
    const a = make(files, 'A');
    const v0 = value(await a.saveVersion(project(), 'First', { author: ann }));
    // Device B starts from a synced copy of the project folder.
    const copy = new MemoryHistoryFiles();
    for (const [p, b] of files.files) copy.files.set(p, b);
    const synced = new Map(files.files);
    const b = createSnapshotHistory({
      files: copy,
      state: { branch: 'main', version: v0.id },
      now: () => new Date(Date.parse('2026-05-01T13:00:00Z')),
      newId: () => '01JB0000000000000000000001',
    });
    clock.advance(60_000);
    const va = value(await a.saveVersion(project(width('41mm')), 'A edit', { author: ann }));
    const vb = value(
      await b.saveVersion(project(width('42mm')), 'B edit', { author: { name: 'Bob' } }),
    );
    MemoryHistoryFiles.syncUnion(files, copy, synced);
    expect([...files.files.keys()].sort()).toEqual([...copy.files.keys()].sort());
    // Same branch name, two heads: diverged.
    const branches = await a.branches();
    expect(branches.map((x) => [x.name, x.head])).toEqual([
      ['main', vb.id],
      ['main', va.id],
    ]);
    expect(branches.find((x) => x.head === va.id)?.current).toBe(true);
    expect(await a.mergeBase(va.id, vb.id)).toBe(v0.id);
    // Merge them with DocMerger and record both parents.
    const base = value(await a.read(v0.id));
    const merged = await mergeProjectFiles(
      base,
      value(await a.read(va.id)),
      value(await a.read(vb.id)),
      docMerger,
    );
    expect(merged.merge.conflicts.map((c) => c.path)).toEqual([`/params/${P_WIDTH}/expr`]);
    const m = value(await a.commitMerge(merged.files, 'Merge', [va.id, vb.id], ann));
    expect(m.parents).toEqual([va.id, vb.id]);
    expect((await a.branches()).map((x) => x.head)).toEqual([m.id]);
    // A stale head ref resurrected by a sync is ignored (it's an ancestor of the merge).
    await files.write(`.wren-history/refs/heads/main/${vb.id}`, new Uint8Array(0));
    expect((await a.branches()).map((x) => x.head)).toEqual([m.id]);
    expect((await a.log()).map((v) => v.message)).toEqual(['Merge', 'B edit', 'A edit', 'First']);
  });

  it('releases are read-only and named', async () => {
    const { files, make } = setup();
    const h = make();
    const v = value(await h.saveVersion(project(), 'First', { author: ann }));
    const exports: ProjectFiles = new Map([['bracket.step', new Uint8Array([7, 7])]]);
    const r = value(await h.release(v.id, 'Rev A', exports, ann));
    expect(r).toMatchObject({
      name: 'Rev A',
      versionId: v.id,
      files: ['releases/rev-a/bracket.step'],
    });
    expect(files.files.get('releases/rev-a/bracket.step')).toEqual(new Uint8Array([7, 7]));
    expect(files.files.has(`.wren-history/refs/releases/Rev%20A/${v.id}`)).toBe(true);
    const again = await h.release(v.id, 'Rev A', exports, ann);
    expect(again.ok === false && again.error.code).toBe('CONFLICT');
    expect((await h.releases()).map((x) => x.name)).toEqual(['Rev A']);
    expect((await h.log())[0]?.releases).toEqual(['Rev A']);
    const bad = await h.release(v.id, 'Rev B', new Map([['../x', new Uint8Array()]]), ann);
    expect(bad.ok).toBe(false);
  });

  it('automatic snapshots: hidden by default, deduplicated, pruned by policy, never named or released ones', async () => {
    const { clock, make } = setup(Date.parse('2026-05-01T00:00:00Z'));
    const h = make();
    const named = value(await h.saveVersion(project(), 'Named', { author: ann }));
    const autos: string[] = [];
    // One auto snapshot every 10 minutes for 10 days.
    for (let i = 0; i < 6 * 24 * 10; i++) {
      clock.advance(10 * 60_000);
      const v = value(
        await h.saveVersion(project(width(`${40 + (i % 7) + 1}mm`)), 'auto', {
          author: ann,
          auto: true,
        }),
      );
      autos.push(v.id);
    }
    const dup = value(
      await h.saveVersion(project(width(`${40 + ((6 * 24 * 10 - 1) % 7) + 1}mm`)), 'auto', {
        author: ann,
        auto: true,
      }),
    );
    expect(dup.id).toBe(autos[autos.length - 1]);
    expect((await h.log()).map((v) => v.id)).toEqual([named.id]);
    expect((await h.log({ includeAuto: true })).length).toBe(autos.length + 1);
    const released = autos[10] as string;
    value(await h.release(released, 'Rev A', new Map(), ann));
    const removed = await h.prune();
    const left = await h.log({ includeAuto: true });
    const ids = new Set(left.map((v) => v.id));
    expect(ids.has(named.id)).toBe(true);
    expect(ids.has(released)).toBe(true);
    // Last day: every one (144); days 2–7: one per hour (144 − 1 boundary); older: one per day.
    expect(left.length).toBeGreaterThan(144 + 140);
    expect(left.length).toBeLessThan(144 + 150 + 5);
    expect(removed).toBe(autos.length + 1 - left.length);
    expect((await h.read(autos[0] as string)).ok).toBe(false);
    // Snapshots still used by a kept version stay; the latest auto is readable.
    expect((await h.read(autos[autos.length - 1] as string)).ok).toBe(true);
  }, 60_000);

  it('pruning on one device never loses a named version saved offline with the same content (gate B2)', async () => {
    const { files, clock, make } = setup(Date.parse('2026-05-01T00:00:00Z'));
    const a = make(files, 'A');
    const v0 = value(await a.saveVersion(project(), 'First', { author: ann }));
    // An automatic snapshot of a state both devices will reach again, then one more edit.
    clock.advance(60_000);
    const old = value(
      await a.saveVersion(project(width('43mm')), 'auto', { author: ann, auto: true }),
    );
    clock.advance(60_000);
    value(await a.saveVersion(project(width('44mm')), 'auto', { author: ann, auto: true }));
    // Device B gets a synced copy, then both go offline.
    const copy = new MemoryHistoryFiles();
    for (const [p, b] of files.files) copy.files.set(p, b);
    const synced = new Map(files.files);
    const b = createSnapshotHistory({
      files: copy,
      state: { branch: 'main', version: v0.id },
      now: () => new Date(Date.parse('2026-05-20T00:00:00Z')),
      newId: () => '01JB0000000000000000000009',
    });
    // A, weeks later, prunes the old automatic snapshot.
    clock.advance(20 * 24 * 3_600_000);
    expect(await a.prune()).toBeGreaterThan(0);
    expect((await a.read(old.id)).ok).toBe(false);
    // B names a version whose content equals the pruned snapshot (it already has the zip).
    const named = value(await b.saveVersion(project(width('43mm')), 'Back to 43', { author: ann }));
    expect(named.hash).toBe(old.hash);
    // Sync (deletions win where the other side didn't change the file).
    MemoryHistoryFiles.syncUnion(files, copy, synced);
    for (const h of [a, b]) {
      const r = await h.read(named.id);
      expect(r.ok, 'the named version must still be readable').toBe(true);
    }
  });

  it('selectPrunable keeps the newest per bucket', () => {
    const now = new Date('2026-05-10T12:00:00Z');
    const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
    const v = [
      { id: 'a', at: at(HOUR_MS / 2), auto: true },
      { id: 'b', at: at(2 * DAY_MS + 10 * 60_000), auto: true },
      { id: 'c', at: at(2 * DAY_MS + 20 * 60_000), auto: true },
      { id: 'd', at: at(9 * DAY_MS), auto: true },
      { id: 'e', at: at(9 * DAY_MS + 60_000), auto: true },
      { id: 'n', at: at(9 * DAY_MS + 120_000) },
    ];
    expect(selectPrunable(v, new Set()).sort()).toEqual(['c', 'e']);
    expect(selectPrunable(v, new Set(['e']))).toEqual(['c']);
  });

  it('a conflicting edit on a branch: mergeBase walks the graph', async () => {
    const { clock, make } = setup();
    const h = make();
    const a = value(await h.saveVersion(project(), 'A', { author: ann }));
    value(await h.createBranch('idea'));
    clock.advance(1000);
    const b = value(await h.saveVersion(project(width('50mm')), 'B', { author: ann }));
    value(await h.switchBranch('idea'));
    const radius = (d: ReturnType<typeof baseDoc>) => {
      const f = featureOf(d, FILLET);
      return apply(d, {
        kind: 'updateFeature',
        partId: PART,
        featureId: FILLET,
        feature: { ...f, radius: '9mm' } as never,
      });
    };
    const c = value(await h.saveVersion(project(radius), 'C', { author: ann }));
    expect(await h.mergeBase(b.id, c.id)).toBe(a.id);
    expect(await h.mergeBase(a.id, c.id)).toBe(a.id);
    expect(await h.mergeBase('nope', c.id)).toBeNull();
  });

  it('encodes names into safe, reversible path segments', () => {
    for (const n of ['main', 'Rev A', 'feature/thin*wall', '..', 'Größe 2', '日本']) {
      const e = encodeName(n);
      expect(e).toMatch(/^[A-Za-z0-9_%-]+$/);
      expect(decodeName(e)).toBe(n);
    }
  });
});
