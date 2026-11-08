// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/sync/remote.ts (errors become `StorageResult` values).
/**
 * What every provider shares: building `StorageResult`s, mapping HTTP and network failures to
 * `StorageErrorCode`s, and a small concurrency pool. Messages are for people and never contain a
 * token (callers pass only the service name, the path and the server's own summary).
 */

import type { StorageError, StorageErrorCode, StorageResult } from '@whittle/contracts';

export const ok = <T>(value: T): StorageResult<T> => ({ ok: true, value });

export function fail<T = never>(
  code: StorageErrorCode,
  message: string,
  extra: Omit<StorageError, 'code' | 'message'> = {},
): StorageResult<T> {
  return { ok: false, error: { code, message, ...extra } };
}

/** Re-types a failure so it can be returned from a function with another value type. */
export const forward = <T>(r: { ok: false; error: StorageError }): StorageResult<T> => ({
  ok: false,
  error: r.error,
});

/** A valid access token (refreshed first if needed); `force` asks for a fresh one (after a 401). */
export type TokenGetter = (force?: boolean) => Promise<StorageResult<string>>;

export type Fetcher = typeof fetch;

export const defaultFetch: Fetcher = (...a) => fetch(...a);

/** A stalled request mustn't hold up sync (and the edits queued behind it) forever. */
export function timeoutSignal(ms = 60_000): { signal?: AbortSignal } {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? { signal: AbortSignal.timeout(ms) }
    : {};
}

/**
 * `fetch` rejected: no network, a timeout, or (for servers that don't send CORS headers) the
 * browser refused the response. Browsers report all three the same way, so `corsLikely` is
 * set by providers whose servers often lack CORS (WebDAV without the relay).
 */
export function networkFailure<T = never>(
  service: string,
  e: unknown,
  corsLikely = false,
): StorageResult<T> {
  const name = (e as { name?: string } | null)?.name;
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return fail('OFFLINE', `${service} didn't answer in time. Changes stay queued.`);
  }
  if (corsLikely && online) {
    return fail(
      'CORS',
      `${service} refused the request from this site. Turn on the relay, or allow this site on the server (CORS).`,
    );
  }
  return fail('OFFLINE', `Can't reach ${service}. Changes stay queued.`);
}

/** Calls `fetch`, turning a rejection into an `OFFLINE`/`CORS` result. */
export async function request(
  fetcher: Fetcher,
  service: string,
  url: string,
  init: RequestInit,
  corsLikely = false,
): Promise<StorageResult<Response>> {
  try {
    return ok(await fetcher(url, { ...timeoutSignal(), ...init }));
  } catch (e) {
    return networkFailure(service, e, corsLikely);
  }
}

export function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('Retry-After');
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Maps a failed HTTP status to an error code (conflicts and not-found are handled by callers). */
export function httpFailure<T = never>(
  service: string,
  res: Response,
  summary: string,
  path?: string,
): StorageResult<T> {
  const status = res.status;
  const detail = summary ? `: ${summary}` : ` (HTTP ${status})`;
  const extra = { status, ...(path !== undefined ? { path } : {}) };
  if (status === 401) return fail('AUTH', `${service} signed you out. Sign in again.`, extra);
  if (status === 429 || status === 503) {
    const after = retryAfterMs(res);
    return fail('RATE_LIMITED', `${service} asked to slow down. Sync will retry.`, {
      ...extra,
      ...(after !== undefined ? { retryAfterMs: after } : {}),
    });
  }
  if (status === 507) return fail('QUOTA', `${service} is out of space.`, extra);
  if (status === 403) return fail('PERMISSION', `${service} refused access${detail}`, extra);
  if (status === 404)
    return fail('NOT_FOUND', `${service}: ${path ?? 'the file'} isn't there.`, extra);
  if (status === 409 || status === 412) {
    return fail('CONFLICT', `${service}: ${path ?? 'the file'} changed elsewhere.`, extra);
  }
  return fail('REMOTE', `${service}${detail}`, extra);
}

/** Runs `task` over `items`, a few at a time. Stops starting new tasks after a failure. */
export async function pool<T>(
  items: readonly T[],
  size: number,
  task: (item: T) => Promise<StorageResult<unknown>>,
): Promise<StorageResult<void>> {
  let next = 0;
  let failure: StorageResult<void> | null = null;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (!failure && next < items.length) {
        const r = await task(items[next++] as T);
        if (!r.ok) failure ??= forward(r);
      }
    }),
  );
  return failure ?? ok(undefined);
}

/** Bytes as a `fetch` body (TS lib types disagree about `Uint8Array<ArrayBufferLike>`). */
export const body = (bytes: Uint8Array): BodyInit => bytes as unknown as BodyInit;

/** `/a/b/c.json` → `c.json`. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Joins service paths: `('/CAD', 'x.json')` → `/CAD/x.json`; `('', 'x')` → `/x`. */
export function joinPath(dir: string, name: string): string {
  const d = dir.replace(/\/+$/, '');
  return `${d}/${name}`;
}

/** Folders a provider never descends into: the local cache and git internals. */
export const SKIP_FOLDERS: ReadonlySet<string> = new Set(['.whittle', '.git']);
