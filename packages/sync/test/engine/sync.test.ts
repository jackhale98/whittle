// Ported from Mycelium src/lib/sync/engine.test.ts, on Wren projects and the structural merge.
import { MANIFEST_FILE, PARAMS_FILE, toFiles } from '@wren-cad/document';
import { afterEach, describe, expect, it } from 'vitest';
import { fileConflictPath } from '../../src/engine/round';
import { MemoryProvider } from '../../src/providers/memory';
import { Device, LINK, remoteSnapshot } from '../support/device';
import { makeDoc, paramOf, withParam } from '../support/project';

const devices: Device[] = [];
const device = (
  remote: MemoryProvider,
  ...rest: ConstructorParameters<typeof Device> extends [unknown, ...infer R] ? R : never
) => {
  const d = new Device(remote, ...rest);
  devices.push(d);
  return d;
};
afterEach(() => {
  for (const d of devices.splice(0)) d.engine.dispose();
});

const abs = (p: string) => `${LINK.path}/${p}`;

/** A remote holding a project, and two devices that have both synced it. */
async function twoDevices() {
  const remote = new MemoryProvider();
  const doc = makeDoc();
  for (const [p, b] of toFiles(doc)) remote.put(abs(p), b);
  const a = device(remote);
  const b = device(remote);
  await a.sync();
  await b.sync();
  return { remote, a, b, doc };
}

describe('sync engine: pull and push', () => {
  it('downloads a project on first sync, ignoring other folders and the cache', async () => {
    const remote = new MemoryProvider();
    for (const [p, b] of toFiles(makeDoc())) remote.put(abs(p), b);
    remote.put(abs('.wren/meshes/a.bin'), 'cache');
    remote.put(abs('.wren-history/versions/v1.json'), '{}');
    remote.put('/CAD/other/x.json', '{}');
    const d = device(remote);
    const r = await d.sync();
    expect([...d.store.files.keys()].sort()).toEqual([
      '.wren-history/versions/v1.json',
      'params.json',
      'parts/bracket.part.json',
      'parts/lid.part.json',
      'wren.project.json',
    ]);
    expect(r.pulled).toBe(5);
    expect(r.files?.size).toBe(5);
    expect(paramOf(d.doc(), 'width')).toBe('40 mm');
    expect((await d.engine.state()).cursor).not.toBeNull();
  });

  it('uploads local edits and new files against the base revision, then sees nothing new', async () => {
    const { remote, a } = await twoDevices();
    a.saveDoc(withParam(a.doc(), 'width', '45 mm'));
    a.save('imports/x.step', 'STEP');
    const r = await a.sync();
    expect(r.pushed).toBe(2);
    expect(remote.text(abs('imports/x.step'))).toBe('STEP');
    expect(remote.text(abs(PARAMS_FILE))).toContain('45 mm');
    expect((await a.engine.state()).pending).toEqual([]);
    const again = await a.sync();
    expect(again.pulled + again.pushed).toBe(0);
    expect(remote.calls.read).toBe(8); // the two first syncs only; our own uploads aren't re-read
  });

  it('never uploads the .wren/ cache, but syncs .wren-history/', async () => {
    const { remote, a, b } = await twoDevices();
    a.save('.wren/meshes/bracket.bin', 'mesh');
    a.save('.wren/thumb.png', 'png');
    a.save('.wren-history/versions/01J.json', '{"id":"01J"}');
    await a.sync();
    expect([...remote.files.values()].some((f) => f.path.includes('/.wren/'))).toBe(false);
    expect(remote.text(abs('.wren-history/versions/01J.json'))).toBe('{"id":"01J"}');
    expect((await a.engine.state()).pending).toEqual([]);
    await b.sync();
    expect(b.store.text('.wren-history/versions/01J.json')).toBe('{"id":"01J"}');
    expect(b.store.files.has('.wren/thumb.png')).toBe(false);
  });

  it('carries edits from one device to another', async () => {
    const { a, b } = await twoDevices();
    a.saveDoc(withParam(a.doc(), 'height', '25 mm'));
    await a.sync();
    const r = await b.sync();
    expect(r.pulled).toBe(1);
    expect(r.files).toBeDefined();
    expect(paramOf(b.doc(), 'height')).toBe('25 mm');
    expect(b.snapshot()).toEqual(a.snapshot());
  });

  it('deletes locally what was deleted remotely, unless it was edited here', async () => {
    const { remote, a } = await twoDevices();
    a.save('notes/a.txt', 'A');
    a.save('notes/b.txt', 'B');
    await a.sync();
    remote.delete(abs('notes/a.txt'));
    remote.delete(abs('notes/b.txt'));
    a.save('notes/b.txt', 'B edited');
    await a.sync();
    expect(a.store.files.has('notes/a.txt')).toBe(false);
    expect(remote.text(abs('notes/b.txt'))).toBe('B edited');
  });

  it('deletes remotely what was deleted here, against its revision', async () => {
    const { remote, a } = await twoDevices();
    a.save('notes/a.txt', 'A');
    await a.sync();
    a.save('notes/a.txt', null);
    await a.sync();
    expect(remote.text(abs('notes/a.txt'))).toBeUndefined();
    expect((await a.engine.state()).bases['notes/a.txt']).toBeUndefined();
  });

  it('keeps a remote edit over a local delete (nothing is lost)', async () => {
    const { remote, a } = await twoDevices();
    a.save('notes/a.txt', 'A');
    await a.sync();
    remote.put(abs('notes/a.txt'), 'A edited elsewhere');
    a.save('notes/a.txt', null);
    await a.sync();
    expect(a.store.text('notes/a.txt')).toBe('A edited elsewhere');
    expect(remote.text(abs('notes/a.txt'))).toBe('A edited elsewhere');
  });

  it('drops everything under a deleted folder', async () => {
    const { remote, a } = await twoDevices();
    a.save('releases/rev-a/a.step', 'A');
    a.save('releases/rev-a/a.pdf', 'P');
    await a.sync();
    remote.files.delete(abs('releases/rev-a/a.step').toLowerCase());
    remote.files.delete(abs('releases/rev-a/a.pdf').toLowerCase());
    remote.log.push({ kind: 'deleted', path: abs('releases/rev-a') });
    await a.sync();
    expect([...a.store.files.keys()].some((p) => p.startsWith('releases/'))).toBe(false);
  });

  it('keeps the local spelling of a path when the service reports another case', async () => {
    const { remote, a } = await twoDevices();
    a.save('Notes/Inbox.txt', 'In');
    await a.sync();
    const key = abs('notes/inbox.txt').toLowerCase();
    remote.files.set(key, { path: key, rev: 'rx', bytes: new TextEncoder().encode('In 2') });
    remote.log.push({ kind: 'file', path: key, rev: 'rx' });
    await a.sync();
    expect([...a.store.files.keys()].filter((p) => /inbox/i.test(p))).toEqual(['Notes/Inbox.txt']);
    expect(a.store.text('Notes/Inbox.txt')).toBe('In 2');
  });

  it('starts over with a full listing when the cursor has expired', async () => {
    const { remote, a } = await twoDevices();
    a.save('notes/a.txt', 'A');
    await a.sync();
    remote.files.delete(abs('notes/a.txt').toLowerCase()); // gone without a log entry
    remote.put(abs('notes/b.txt'), 'B');
    remote.expireCursors();
    await a.sync();
    expect(a.store.files.has('notes/a.txt')).toBe(false);
    expect(a.store.text('notes/b.txt')).toBe('B');
    // And the new cursor works.
    remote.put(abs('notes/c.txt'), 'C');
    await a.sync();
    expect(a.store.text('notes/c.txt')).toBe('C');
  });

  it('pushes a local project into an empty folder', async () => {
    const remote = new MemoryProvider();
    const d = device(remote);
    d.saveDoc(makeDoc());
    const r = await d.sync();
    expect(r.pushed).toBe(4);
    expect(Object.keys(remoteSnapshot(remote.files)).sort()).toEqual(
      Object.keys(d.snapshot()).sort(),
    );
  });

  it('forgets bases when the project is linked to another folder', async () => {
    const { a } = await twoDevices();
    const s = await a.engine.state();
    await a.store.saveState({ ...s, link: { connectionId: 'conn', path: '/elsewhere' } });
    const fresh = await a.engine.state();
    expect(fresh.bases).toEqual({});
    expect(fresh.cursor).toBeNull();
  });
});

describe('sync engine: two devices, concurrent edits', () => {
  it('merges edits to different files', async () => {
    const { remote, a, b } = await twoDevices();
    a.save('imports/a.step', 'A');
    b.save('imports/b.step', 'B');
    await a.sync();
    await b.sync();
    await a.sync();
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(remoteSnapshot(remote.files)).toEqual(a.snapshot());
  });

  it('merges edits to different parameters in the same file (structural merge)', async () => {
    const { remote, a, b } = await twoDevices();
    a.saveDoc(withParam(a.doc(), 'width', '45 mm', '2026-11-08T11:00:00.000Z'));
    await a.sync();
    b.saveDoc(withParam(b.doc(), 'height', '30 mm', '2026-11-08T12:00:00.000Z'));
    const r = await b.sync();
    expect(r.merge).toBeUndefined();
    expect(r.merged).toContain(PARAMS_FILE);
    expect(b.merger.calls).toBe(1);
    expect(paramOf(b.doc(), 'width')).toBe('45 mm');
    expect(paramOf(b.doc(), 'height')).toBe('30 mm');
    await a.sync();
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(remoteSnapshot(remote.files)).toEqual(a.snapshot());
  });

  it('reports the same parameter edited on both sides as a conflict, and uploads nothing of it', async () => {
    const { remote, a, b } = await twoDevices();
    a.saveDoc(withParam(a.doc(), 'width', '45 mm'));
    await a.sync();
    const before = remoteSnapshot(remote.files);
    b.saveDoc(withParam(b.doc(), 'width', '50 mm'));
    b.saveDoc(withParam(b.doc(), 'height', '22 mm'));
    const r = await b.sync();
    expect(r.merge?.conflicts).toHaveLength(1);
    expect(r.merge?.conflicts[0]).toMatchObject({
      kind: 'bothModified',
      subject: { kind: 'param', label: 'width' },
    });
    expect(b.engine.status()).toMatchObject({ state: 'conflicts' });
    // Nothing uploaded or overwritten while the conflict is open…
    expect(remoteSnapshot(remote.files)).toEqual(before);
    expect(paramOf(b.doc(), 'width')).toBe('50 mm');
    // …and the next (automatic) sync still reports it.
    expect((await b.sync()).merge?.conflicts).toHaveLength(1);
    expect(remoteSnapshot(remote.files)).toEqual(before);

    const id = r.merge!.conflicts[0]!.id;
    const resolved = await b.resolve([{ conflictId: id, take: 'theirs' }]);
    expect(resolved.merge).toBeUndefined();
    expect(b.engine.status()).toMatchObject({ state: 'idle', pending: 0 });
    expect(paramOf(b.doc(), 'width')).toBe('45 mm');
    expect(paramOf(b.doc(), 'height')).toBe('22 mm'); // B's other edit survives
    await a.sync();
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(remoteSnapshot(remote.files)).toEqual(b.snapshot());
  });

  it('accepts a hand-entered value for a conflict', async () => {
    const { a, b } = await twoDevices();
    a.saveDoc(withParam(a.doc(), 'width', '45 mm'));
    await a.sync();
    b.saveDoc(withParam(b.doc(), 'width', '50 mm'));
    const r = await b.sync();
    const c = r.merge!.conflicts[0]!;
    await b.resolve([{ conflictId: c.id, value: { ...(c.ours as object), expr: '47.5 mm' } }]);
    await a.sync();
    expect(paramOf(a.doc(), 'width')).toBe('47.5 mm');
  });

  it('refuses resolutions for conflicts that no longer exist', async () => {
    const { a, b } = await twoDevices();
    a.saveDoc(withParam(a.doc(), 'width', '45 mm'));
    await a.sync();
    b.saveDoc(withParam(b.doc(), 'width', '50 mm'));
    await b.sync();
    const r = await b.engine.resolve([{ conflictId: 'params:nope', take: 'theirs' }]);
    expect(r.ok || r.error.code).toBe('CONFLICT');
  });

  it('treats a non-document file edited on both sides as a whole-file conflict', async () => {
    const { remote, a, b } = await twoDevices();
    a.save('imports/x.step', 'base');
    await a.sync();
    await b.sync();
    a.save('imports/x.step', 'from A');
    await a.sync();
    b.save('imports/x.step', 'from B');
    const r = await b.sync();
    const c = r.merge!.conflicts[0]!;
    expect(c).toMatchObject({
      kind: 'bothModified',
      path: 'imports/x.step',
      subject: { kind: 'doc', label: 'imports/x.step' },
    });
    expect(fileConflictPath(c)).toBe('imports/x.step');
    expect(new TextDecoder().decode(c.theirs as Uint8Array)).toBe('from A');
    expect(remote.text(abs('imports/x.step'))).toBe('from A');
    await b.resolve([{ conflictId: c.id, take: 'ours' }]);
    expect(remote.text(abs('imports/x.step'))).toBe('from B');
    await a.sync();
    expect(a.store.text('imports/x.step')).toBe('from B');
  });

  it('merges a change that lands remotely while uploading (CONFLICT on push → pull and merge)', async () => {
    const { remote, a, b } = await twoDevices();
    a.saveDoc(withParam(a.doc(), 'width', '45 mm'));
    // B's edit to another parameter lands just before A's upload.
    remote.beforeWrite = () => {
      remote.beforeWrite = null;
      const other = withParam(b.doc(), 'height', '33 mm');
      remote.put(abs(PARAMS_FILE), toFiles(other).get(PARAMS_FILE)!);
    };
    const r = await a.sync();
    expect(r.merge).toBeUndefined();
    expect(paramOf(a.doc(), 'width')).toBe('45 mm');
    expect(paramOf(a.doc(), 'height')).toBe('33 mm');
    expect(remote.text(abs(PARAMS_FILE))).toContain('45 mm');
    expect(remote.text(abs(PARAMS_FILE))).toContain('33 mm');
    expect((await a.engine.state()).pending).toEqual([]);
  });

  it('turns a racing create of the same new file into a conflict, not an overwrite', async () => {
    const { remote, a, b } = await twoDevices();
    a.save('notes/new.txt', 'A');
    b.save('notes/new.txt', 'B');
    await a.sync();
    const r = await b.sync();
    expect(r.merge?.conflicts.map((c) => c.kind)).toEqual(['bothModified']);
    expect(remote.text(abs('notes/new.txt'))).toBe('A');
    expect(b.store.text('notes/new.txt')).toBe('B');
  });

  it('never overwrites a save made while a sync was running', async () => {
    const { remote, a, b } = await twoDevices();
    b.saveDoc(withParam(b.doc(), 'height', '31 mm'));
    await b.sync();
    // A saves the very moment its sync is about to apply B's change.
    const write = a.store.writeFiles.bind(a.store);
    let once = true;
    a.store.writeFiles = async (changes, expected) => {
      if (once) {
        once = false;
        a.saveDoc(withParam(a.doc(), 'width', '46 mm'));
      }
      return write(changes, expected);
    };
    await a.sync();
    expect(a.store.refusedWrites).toBe(1);
    expect(paramOf(a.doc(), 'width')).toBe('46 mm');
    expect(paramOf(a.doc(), 'height')).toBe('31 mm');
    await b.sync();
    expect(paramOf(b.doc(), 'width')).toBe('46 mm');
    expect(remoteSnapshot(remote.files)).toEqual(a.snapshot());
  });

  it('waits for a project another device is midway through uploading', async () => {
    const { remote, a, b } = await twoDevices();
    a.saveDoc(withParam(a.doc(), 'width', '41 mm'));
    // Remote: a manifest naming a part file that hasn't arrived yet.
    const next = structuredClone(b.doc());
    next.parts.push({
      id: '01JC0000000000000000000000',
      name: 'Hinge',
      features: [],
      rollbackIndex: 0,
    });
    next.params[0]!.expr = '99 mm';
    const files = toFiles(next);
    remote.put(abs(MANIFEST_FILE), files.get(MANIFEST_FILE)!);
    remote.put(abs(PARAMS_FILE), files.get(PARAMS_FILE)!);
    const r = await a.engine.syncNow();
    expect(r.ok || r.error.code).toBe('REMOTE');
    expect(paramOf(a.doc(), 'width')).toBe('41 mm');
    remote.put(abs('parts/hinge.part.json'), files.get('parts/hinge.part.json')!);
    const again = await a.sync();
    expect(again.merge?.conflicts.length).toBe(1); // width: 41 vs 99, both edited
    expect(a.doc().parts.map((p) => p.name)).toEqual(['Bracket', 'Lid']); // untouched until resolved
  });
});

describe('sync engine: offline queue', () => {
  it('queues edits offline, keeps the queue across a restart, and replays it on reconnect', async () => {
    const { remote, a, b } = await twoDevices();
    remote.online = false;
    a.saveDoc(withParam(a.doc(), 'width', '48 mm'));
    a.save('imports/y.step', 'Y');
    const off = await a.engine.syncNow();
    expect(off.ok || off.error.code).toBe('OFFLINE');
    expect(a.engine.status()).toEqual({ state: 'offline', pending: 2 });
    a.restart();
    await a.engine.idle();
    expect((await a.engine.state()).pending.sort()).toEqual(['imports/y.step', 'params.json']);
    expect(a.engine.status()).toMatchObject({ pending: 2 });
    remote.online = true;
    const r = await a.sync();
    expect(r.pushed).toBe(2);
    await b.sync();
    expect(paramOf(b.doc(), 'width')).toBe('48 mm');
    expect(b.store.text('imports/y.step')).toBe('Y');
  });

  it('finds local edits even if the queue was lost', async () => {
    const { remote, a } = await twoDevices();
    a.store.save('notes/lost.txt', 'not notified');
    await a.sync();
    expect(remote.text(abs('notes/lost.txt'))).toBe('not notified');
  });

  it('keeps going after going offline midway through a push', async () => {
    const { remote, a, b } = await twoDevices();
    a.save('imports/1.step', '1');
    a.save('imports/2.step', '2');
    let writes = 0;
    remote.beforeWrite = () => {
      writes += 1;
      if (writes === 1) remote.online = false; // the second upload finds no network
    };
    const r = await a.engine.syncNow();
    expect(r.ok || r.error.code).toBe('OFFLINE');
    remote.beforeWrite = null;
    remote.online = true;
    await a.sync();
    await b.sync();
    expect(b.store.text('imports/1.step')).toBe('1');
    expect(b.store.text('imports/2.step')).toBe('2');
  });
});
