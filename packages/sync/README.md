# @wren-cad/sync

Connections, background sync and version control (PLAN §8A, M2.5). Contracts live in
`packages/contracts/src/sync.ts`; decisions in docs/DECISIONS.md ADR-020.

- `providers/`: `StorageProvider` adapters (folder, Dropbox, OneDrive/SharePoint, Google Drive,
  WebDAV), ported from Mycelium, plus the `CredentialVault`.
- `engine/`: `SyncEngine` (pull, structural three-way merge, push against the base revision).
- `merge/`: `DocMerger` and `DocDiffer`. Part configurations (M3.7, ADR-074) merge cell by cell
  (`configurations.ts`): one cell per (configuration, parameter / feature suppression / feature
  field / material / colour / property); the merge report notes pruned overrides, an active
  configuration that fell back to Default and duplicate names. Compare lines are in
  `configuration-diff.ts`.
- `history/`: `SnapshotHistory` (`.wren-history/`) and `GitHistory` (isomorphic-git).
  Local git repo mode (ADR-029): `fsaGitFs(handle)` is isomorphic-git's `fs` over a picked
  folder, and `openLocalGitRepo(handle, { projectPath })` returns the repo's `GitHistory` scoped
  to the project folder, with `state()` (read-only reasons) and `ensureCacheIgnored()`.
  `test/git-local*.test.ts` run it against the real `git` CLI through `test/support/node-dir.ts`
  (a `FileSystemDirectoryHandle` over a temp folder).
