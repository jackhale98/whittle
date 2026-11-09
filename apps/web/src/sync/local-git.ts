/**
 * Local git repo mode (ADR-029, ADR-030): a folder on this computer that is a git working tree.
 * Versions are real commits in it, through `openLocalGitRepo` from `@wren-cad/sync` (isomorphic-git
 * over File System Access, scoped to the project folder, read-only states, `.gitignore`).
 */

import type { Author, Credential, StorageResult } from '@wren-cad/contracts';
import {
  browserGitHttp,
  type FolderHandle,
  type GitHost,
  type LocalGitRepo,
  openLocalGitRepo,
} from '@wren-cad/sync';

/** The picked folder is a git working tree: it has `.git` (a folder, or a `gitdir:` file). */
export async function isGitRepo(root: FileSystemDirectoryHandle): Promise<boolean> {
  const dir = await root.getDirectoryHandle('.git').then(
    () => true,
    () => false,
  );
  return (
    dir ||
    root.getFileHandle('.git').then(
      () => true,
      () => false,
    )
  );
}

export interface LocalGitOptions {
  root: FolderHandle;
  /** Project folder relative to the repo root; `''` for the root. */
  projectPath: string;
  author: Author;
  /**
   * The signed-in git connection for a remote's host, if any (push and pull through the proxy);
   * `null`: push and pull stay with the user's own git tools.
   */
  signedIn: (
    host: string,
  ) => { host: GitHost; credentials: () => Promise<Credential | null> } | null;
  corsProxy?: string | null;
}

/**
 * Opens the repo for the project. When its `origin` is an HTTPS remote on a host the user signed
 * in to, it is reopened with network access so Wren can also fetch, pull and push.
 */
export async function openLocalGit(
  o: LocalGitOptions,
): Promise<StorageResult<LocalGitRepo & { remoteSignedIn: boolean }>> {
  const base = { projectPath: o.projectPath, author: o.author };
  const first = await openLocalGitRepo(o.root, base);
  if (!first.ok) return first;
  const origin = (await first.value.history.remotes()).find((r) => r.name === 'origin');
  let host = '';
  try {
    host = origin ? new URL(origin.url).host : '';
  } catch {
    host = ''; // an ssh remote: push with your own git
  }
  const auth = host ? o.signedIn(host) : null;
  if (!auth) return { ok: true, value: { ...first.value, remoteSignedIn: false } };
  const net = await openLocalGitRepo(o.root, {
    ...base,
    http: browserGitHttp,
    host: auth.host,
    credentials: auth.credentials,
    ...(o.corsProxy !== undefined ? { corsProxy: o.corsProxy } : {}),
  });
  return net.ok ? { ok: true, value: { ...net.value, remoteSignedIn: true } } : net;
}
