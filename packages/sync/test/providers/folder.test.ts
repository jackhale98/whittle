import { describe, expect, it } from 'vitest';
import { FolderProvider, folderPermission } from '../../src/providers/folder';
import { FakeDir } from '../support/fake-dir';
import { dec, enc, must } from '../support/fetch';

describe('Folder provider (File System Access API)', () => {
  it('reads what a desktop sync client wrote, with an mtime:size revision', async () => {
    const d = new FakeDir();
    await d.put('/CAD/P/params.json', '{"params":[]}\n');
    const r = must(await new FolderProvider(d).read('/CAD/P/params.json'));
    expect(dec(r.bytes)).toBe('{"params":[]}\n');
    expect(r.rev).toMatch(/^\d+:14$/);
  });

  it('sees a file replaced by another program as a conflict', async () => {
    const d = new FakeDir();
    const p = new FolderProvider(d);
    const { rev } = must(await p.write('/P/a.json', enc('mine'), null));
    await d.put('/P/a.json', 'desktop');
    const r = await p.write('/P/a.json', enc('mine again'), rev);
    expect(r.ok || r.error.code).toBe('CONFLICT');
    expect(await d.text('/P/a.json')).toBe('desktop');
  });

  it('asks for permission again on a click, and reports it until granted', async () => {
    const d = new FakeDir('Bracket');
    d.permission = 'prompt';
    const p = new FolderProvider(d);
    const r = await p.list({ path: '/P' });
    expect(r.ok || r.error).toMatchObject({ code: 'PERMISSION' });
    must(await folderPermission(d, true));
    d.permission = 'denied';
    const denied = await folderPermission(d, true);
    expect(denied.ok || denied.error.code).toBe('PERMISSION');
  });

  it('maps a missing folder to NOT_FOUND and an unreadable cursor to CURSOR_EXPIRED', async () => {
    const p = new FolderProvider(new FakeDir());
    const r = await p.list({ path: '/nope' });
    expect(r.ok || r.error.code).toBe('NOT_FOUND');
    const c = await p.list({ cursor: '???' });
    expect(c.ok || c.error.code).toBe('CURSOR_EXPIRED');
  });
});
