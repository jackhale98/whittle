# @whittle/sync

Connections, background sync and version control (PLAN §8A, M2.5). Contracts live in
`packages/contracts/src/sync.ts`; decisions in docs/DECISIONS.md ADR-020.

- `providers/`: `StorageProvider` adapters (folder, Dropbox, OneDrive/SharePoint, Google Drive,
  WebDAV), ported from Mycelium, plus the `CredentialVault`.
- `engine/`: `SyncEngine` (pull, structural three-way merge, push against the base revision).
- `merge/`: `DocMerger` and `DocDiffer`.
- `history/`: `SnapshotHistory` (`.whittle-history/`) and `GitHistory` (isomorphic-git).
