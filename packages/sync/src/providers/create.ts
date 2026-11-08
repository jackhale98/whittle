// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/sync/services.ts (`openClient`, `SERVICES`, `serviceLabel`).
/**
 * A `StorageProvider` for a `Connection`, with its credentials from the vault. Git hosts aren't
 * file providers (ADR-020 §1): they use `GitHistory`.
 */

import type {
  Connection,
  CredentialVault,
  StorageProvider,
  StorageResult,
} from '@whittle/contracts';
import { oauthTokenSource, refresherFor } from '../auth/tokens';
import type { OAuthConfig, OAuthService } from '../auth/types';
import { defaultFetch, type Fetcher, fail, ok } from './common';
import { DropboxProvider } from './dropbox';
import { type FolderHandle, FolderProvider } from './folder';
import { GDRIVE_AVAILABLE, GoogleDriveProvider } from './gdrive';
import { OneDriveProvider } from './onedrive';
import { WebDavProvider } from './webdav';

export const SERVICE_NAMES: Record<Connection['kind'], string> = {
  folder: 'Folder',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  gdrive: 'Google Drive',
  webdav: 'WebDAV',
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  forgejo: 'Forgejo',
};

/** The display name, e.g. "OneDrive", "SharePoint · Team site" or the WebDAV host. */
export function serviceLabel(c: Connection): string {
  if (c.kind === 'onedrive' && c.driveName) return c.driveName;
  if (c.kind === 'webdav') {
    try {
      return new URL(c.url).host;
    } catch {
      /* fall through */
    }
  }
  return SERVICE_NAMES[c.kind];
}

export interface ProviderDeps {
  vault: CredentialVault;
  oauth: OAuthConfig;
  /** The Worker's origin, for the WebDAV relay (connections with `relay: true`). */
  workerUrl?: string | undefined;
  /** Loads a folder connection's directory handle (see `loadFolderHandle`). */
  folderHandle?: ((handleKey: string) => Promise<FolderHandle | null>) | undefined;
  fetch?: Fetcher;
}

export async function createProvider(
  connection: Connection,
  deps: ProviderDeps,
): Promise<StorageResult<StorageProvider>> {
  const fetcher = deps.fetch ?? defaultFetch;
  const tokens = (service: OAuthService, name: string) =>
    oauthTokenSource({
      connectionId: connection.id,
      vault: deps.vault,
      refresh: refresherFor(service, deps.oauth, fetcher),
      service: name,
    });
  switch (connection.kind) {
    case 'folder': {
      const handle = await deps.folderHandle?.(connection.handleKey);
      if (!handle) {
        return fail('PERMISSION', `Choose the folder ‘${connection.label}’ again to reconnect it.`);
      }
      return ok(new FolderProvider(handle));
    }
    case 'dropbox':
      return ok(new DropboxProvider(tokens('dropbox', 'Dropbox'), fetcher));
    case 'onedrive':
      return ok(new OneDriveProvider(connection.driveId, tokens('onedrive', 'OneDrive'), fetcher));
    case 'gdrive':
      if (!GDRIVE_AVAILABLE) return ok(new GoogleDriveProvider());
      return ok(new GoogleDriveProvider());
    case 'webdav': {
      const cred = await deps.vault.get(connection.id);
      if (!cred) return fail('AUTH', 'Enter the server password again.');
      const password =
        cred.kind === 'password' ? cred.password : cred.kind === 'token' ? cred.token : '';
      const username =
        cred.kind === 'password'
          ? cred.username
          : cred.kind === 'token'
            ? (cred.username ?? '')
            : '';
      if (connection.relay && !deps.workerUrl) {
        return fail('CORS', 'The WebDAV relay isn’t set up for this site.');
      }
      return ok(
        new WebDavProvider(
          {
            url: connection.url,
            username: username || connection.username,
            password,
            relay: connection.relay ? (deps.workerUrl ?? null) : null,
          },
          fetcher,
        ),
      );
    }
    default:
      return fail('REMOTE', `${SERVICE_NAMES[connection.kind]} projects sync through git history.`);
  }
}
