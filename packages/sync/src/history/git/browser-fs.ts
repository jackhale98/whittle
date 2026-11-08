// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/git/workspace.ts `fsFor` (same author, GPL-3.0-or-later).
/**
 * The default place a cloned project's repository lives in the browser: LightningFS on
 * IndexedDB, one database per project. `GitHistory` never builds this itself; the app passes it
 * (or another isomorphic-git fs, e.g. a File System Access adapter over a user's checkout).
 */
import LightningFS from '@isomorphic-git/lightning-fs';
import type { PromiseFsClient } from 'isomorphic-git';

export function browserGitFs(projectId: string, options: { wipe?: boolean } = {}): PromiseFsClient {
  return new LightningFS(
    `whittle-repo-${projectId}`,
    options.wipe ? { wipe: true } : undefined,
  ) as unknown as PromiseFsClient;
}
