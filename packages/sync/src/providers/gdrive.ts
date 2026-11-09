// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Google Drive (Drive API v3, `drive.file` scope): P1, not available yet. This typed stub lets
 * the app list the provider and hide it (`GDRIVE_AVAILABLE`), and answers every call with a
 * plain-language error instead of throwing.
 *
 * Open questions before the real adapter (see docs/DECISIONS.md, ADR-024):
 * - Drive v3 has no `If-Match` precondition on media updates, so optimistic concurrency would be
 *   check-then-write on `version`/`headRevisionId` (a race window the other providers don't have).
 * - Google's browser flow (Identity Services token model) issues no refresh tokens; the code
 *   flow for web clients needs a client secret, so refresh would go through the Worker.
 * - `drive.file` only sees files the app created or the user opened through the Picker, so the
 *   folder picker must be Google's Picker, not `browse()`.
 */

import type {
  RemoteFolder,
  RemoteListing,
  StorageProvider,
  StorageResult,
} from '@wren-cad/contracts';
import { fail } from './common';

export const GDRIVE_AVAILABLE = false;
export const GDRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.file';

const unavailable = <T>(): Promise<StorageResult<T>> =>
  Promise.resolve(
    fail<T>('UNSUPPORTED', 'Google Drive isn’t available in this version of Wren yet.'),
  );

export class GoogleDriveProvider implements StorageProvider {
  readonly kind = 'gdrive' as const;
  readonly caseSensitive = true;
  readonly pollMs = 60_000;
  readonly available = GDRIVE_AVAILABLE;

  list(_start: { path: string } | { cursor: string }): Promise<StorageResult<RemoteListing>> {
    return unavailable();
  }
  read(_path: string): Promise<StorageResult<{ bytes: Uint8Array; rev: string }>> {
    return unavailable();
  }
  write(
    _path: string,
    _bytes: Uint8Array,
    _ifRev: string | null,
  ): Promise<StorageResult<{ rev: string }>> {
    return unavailable();
  }
  remove(_path: string, _ifRev: string | null): Promise<StorageResult<void>> {
    return unavailable();
  }
  browse(_path: string): Promise<StorageResult<RemoteFolder[]>> {
    return unavailable();
  }
}
