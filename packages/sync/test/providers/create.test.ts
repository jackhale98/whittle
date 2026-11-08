import type { Connection } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import { createProvider, serviceLabel } from '../../src/providers/create';
import { GoogleDriveProvider } from '../../src/providers/gdrive';
import { WebDavProvider } from '../../src/providers/webdav';
import { MemoryCredentialVault } from '../../src/vault/vault';
import { FakeDir } from '../support/fake-dir';
import { fakeFetch, header, json, must } from '../support/fetch';

const oauth = { dropboxAppKey: 'dbx', onedriveClientId: 'ms', redirectUri: 'https://app.test/cb/' };

describe('createProvider', () => {
  it('signs Dropbox requests with the vault’s token, refreshing it when due', async () => {
    const vault = new MemoryCredentialVault();
    await vault.set('c1', { kind: 'oauth', accessToken: 'old', refreshToken: 'r', expiresAt: 0 });
    const { calls, fetcher } = fakeFetch([
      json({ access_token: 'new', expires_in: 3600 }),
      json({ entries: [], cursor: 'c', has_more: false }),
    ]);
    const p = must(
      await createProvider(
        { id: 'c1', kind: 'dropbox', label: 'Dropbox' },
        { vault, oauth, fetch: fetcher },
      ),
    );
    must(await p.list({ path: '/P' }));
    expect(calls[0]!.url).toBe('https://api.dropboxapi.com/oauth2/token');
    expect(header(calls[1]!, 'Authorization')).toBe('Bearer new');
    expect(await vault.get('c1')).toMatchObject({ accessToken: 'new', refreshToken: 'r' });
  });

  it('builds WebDAV with the vault’s password, through the relay only when asked and set up', async () => {
    const vault = new MemoryCredentialVault();
    await vault.set('w', { kind: 'password', username: 'ann', password: 'pw' });
    const c: Connection = {
      id: 'w',
      kind: 'webdav',
      label: 'Cloud',
      url: 'https://cloud.test/remote.php/dav/files/ann/',
      username: 'ann',
      relay: true,
    };
    const missing = await createProvider(c, { vault, oauth });
    expect(missing.ok || missing.error.code).toBe('CORS');
    const p = must(await createProvider(c, { vault, oauth, workerUrl: 'https://w.test' }));
    expect(p).toBeInstanceOf(WebDavProvider);
    expect((p as WebDavProvider).url('/P/a.json')).toBe(
      'https://w.test/dav/cloud.test/remote.php/dav/files/ann/P/a.json',
    );
    expect(serviceLabel(c)).toBe('cloud.test');
    const none = await createProvider({ ...c, id: 'nobody' }, { vault, oauth });
    expect(none.ok || none.error.code).toBe('AUTH');
  });

  it('opens folders from their stored handle, and asks again when it is gone', async () => {
    const vault = new MemoryCredentialVault();
    const c: Connection = { id: 'f', kind: 'folder', label: 'CAD', handleKey: 'k' };
    const dir = new FakeDir();
    must(
      await createProvider(c, {
        vault,
        oauth,
        folderHandle: async (k) => (k === 'k' ? dir : null),
      }),
    );
    const gone = await createProvider(
      { ...c, handleKey: 'x' },
      { vault, oauth, folderHandle: async () => null },
    );
    expect(gone.ok || gone.error.code).toBe('PERMISSION');
  });

  it('sends git hosts to GitHistory, and Google Drive to its typed stub', async () => {
    const vault = new MemoryCredentialVault();
    const git = await createProvider(
      { id: 'g', kind: 'github', label: 'GitHub', host: 'github.com' },
      { vault, oauth },
    );
    expect(git.ok).toBe(false);
    const gd = must(
      await createProvider({ id: 'd', kind: 'gdrive', label: 'Drive' }, { vault, oauth }),
    );
    expect(gd).toBeInstanceOf(GoogleDriveProvider);
    const r = await gd.list({ path: '/P' });
    expect(r.ok || r.error.message).toMatch(/Google Drive isn’t available/);
    expect(
      serviceLabel({
        id: 'o',
        kind: 'onedrive',
        label: 'x',
        driveId: 'd',
        driveName: 'SharePoint · Team',
      }),
    ).toBe('SharePoint · Team');
  });
});
