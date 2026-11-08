// Ported from Mycelium src/lib/dropbox/api.test.ts (`fakeFetch`).
export type Call = { url: string; init: RequestInit };

/** A `fetch` answering from a list of responses, recording each call. */
export function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request ${url}`);
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

export const header = (c: Call, name: string) =>
  (c.init.headers as Record<string, string> | undefined)?.[name];

export const tok = async () => ({ ok: true as const, value: 'tok' });

export const enc = (s: string) => new TextEncoder().encode(s);
export const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** Unwraps a `StorageResult` in tests. */
export function must<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.message}`);
  return r.value;
}
