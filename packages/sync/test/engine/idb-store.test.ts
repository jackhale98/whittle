import 'fake-indexeddb/auto';
import { toFiles } from '@whittle/document';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyncEngine } from '../../src/engine/engine';
import { closeSyncDatabases, createIdbSyncStore } from '../../src/engine/idb-store';
import { MemorySyncStore } from '../../src/engine/store';
import { MemoryProvider } from '../../src/providers/memory';
import { LINK } from '../support/device';
import { FakeMerger } from '../support/fake-merger';
import { must } from '../support/fetch';
import { makeDoc } from '../support/project';

afterEach(async () => {
  await closeSyncDatabases();
});

describe('IndexedDB sync store', () => {
  it('keeps state and bases per project, and survives a restart', async () => {
    const remote = new MemoryProvider();
    for (const [p, b] of toFiles(makeDoc())) remote.put(`${LINK.path}/${p}`, b);
    const working = new MemorySyncStore();
    const store = createIdbSyncStore('proj-1', working, { dbName: 'sync-test-1' });
    const engine = createSyncEngine({
      provider: remote,
      link: LINK,
      store,
      merger: new FakeMerger(),
      environment: null,
      syncOnStart: false,
    });
    must(await engine.syncNow());
    engine.dispose();
    await closeSyncDatabases();

    const again = createIdbSyncStore('proj-1', working, { dbName: 'sync-test-1' });
    const state = await again.loadState();
    expect(Object.keys(state!.bases).sort()).toEqual([...working.files.keys()].sort());
    const params = state!.bases['params.json']!;
    expect(await again.getBase(params.hash)).toEqual(working.files.get('params.json'));
    const other = createIdbSyncStore('proj-2', working, { dbName: 'sync-test-1' });
    expect(await other.loadState()).toBeNull();
    expect(await other.getBase(params.hash)).toBeNull();
  });

  it('prunes bases no longer referenced, for this project only', async () => {
    const a = createIdbSyncStore('a', new MemorySyncStore(), { dbName: 'sync-test-2' });
    const b = createIdbSyncStore('b', new MemorySyncStore(), { dbName: 'sync-test-2' });
    const bytes = new Uint8Array([1]);
    await a.putBase('h1', bytes);
    await a.putBase('h2', bytes);
    await b.putBase('h1', bytes);
    await a.pruneBases!(new Set(['h2']));
    expect(await a.getBase('h1')).toBeNull();
    expect(await a.getBase('h2')).toEqual(bytes);
    expect(await b.getBase('h1')).toEqual(bytes);
  });
});
