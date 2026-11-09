import 'fake-indexeddb/auto';
import type { Credential } from '@wren-cad/contracts';
import { openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';
import { IdbCredentialVault } from '../../src/vault/vault';

let n = 0;
const fresh = () => `vault-test-${++n}`;
const vaults: IdbCredentialVault[] = [];
const make = (dbName: string) => {
  const v = new IdbCredentialVault({ dbName });
  vaults.push(v);
  return v;
};
afterEach(async () => {
  for (const v of vaults.splice(0)) await v.close();
});

const TOKEN = 'sl.SECRET-access-token-1234567890';
const REFRESH = 'REFRESH-secret-abcdef';
const PASSWORD = 'pässwörd-hunter2';

/** Every byte stored in the database, as text in several encodings, for a plaintext search. */
async function rawDump(dbName: string): Promise<string[]> {
  const db = await openDB(dbName);
  const out: string[] = [];
  for (const store of ['keys', 'credentials']) {
    for (const v of await db.getAll(store)) {
      const parts: string[] = [];
      const walk = (x: unknown) => {
        if (x instanceof Uint8Array) {
          parts.push(new TextDecoder('utf-8', { fatal: false }).decode(x));
          parts.push(new TextDecoder('utf-16le', { fatal: false }).decode(x));
          parts.push(Buffer.from(x).toString('latin1'));
          parts.push(Buffer.from(x).toString('base64'));
        } else if (x && typeof x === 'object' && !(x instanceof CryptoKey)) {
          for (const y of Object.values(x)) walk(y);
        } else if (typeof x === 'string' || typeof x === 'number') parts.push(String(x));
      };
      walk(v);
      out.push(parts.join('\n'));
      if (!(v instanceof CryptoKey)) out.push(JSON.stringify(v));
    }
    for (const k of await db.getAllKeys(store)) out.push(String(k));
  }
  db.close();
  return out;
}

describe('IdbCredentialVault', () => {
  it('round-trips every kind of credential', async () => {
    const v = make(fresh());
    const creds: Record<string, Credential> = {
      a: { kind: 'oauth', accessToken: TOKEN, refreshToken: REFRESH, expiresAt: 123 },
      b: { kind: 'token', token: TOKEN, username: 'ann' },
      c: { kind: 'password', username: 'ann', password: PASSWORD },
    };
    for (const [id, c] of Object.entries(creds)) await v.set(id, c);
    for (const [id, c] of Object.entries(creds)) expect(await v.get(id)).toEqual(c);
    await v.remove('a');
    expect(await v.get('a')).toBeNull();
    expect(await v.get('never')).toBeNull();
  });

  it('stores no plaintext token, refresh token, password or username (M2.5 acceptance)', async () => {
    const name = fresh();
    const v = make(name);
    await v.set('dbx', { kind: 'oauth', accessToken: TOKEN, refreshToken: REFRESH, expiresAt: 1 });
    await v.set('dav', { kind: 'password', username: 'ann-the-user', password: PASSWORD });
    const dump = (await rawDump(name)).join('\n');
    expect(dump.length).toBeGreaterThan(0);
    for (const secret of [TOKEN, REFRESH, PASSWORD, 'ann-the-user', 'accessToken', 'oauth']) {
      expect(dump).not.toContain(secret);
      expect(dump).not.toContain(Buffer.from(secret).toString('base64'));
    }
  });

  it('keeps the key non-extractable', async () => {
    const name = fresh();
    const v = make(name);
    await v.set('x', { kind: 'token', token: TOKEN });
    const db = await openDB(name);
    const [key] = (await db.getAll('keys')) as CryptoKey[];
    db.close();
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key!.extractable).toBe(false);
    expect(key!.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    await expect(crypto.subtle.exportKey('raw', key!)).rejects.toThrow();
  });

  it('uses a fresh IV per write, and binds each record to its connection id', async () => {
    const name = fresh();
    const v = make(name);
    const cred: Credential = { kind: 'token', token: TOKEN };
    await v.set('one', cred);
    await v.set('two', cred);
    const db = await openDB(name);
    const one = await db.get('credentials', 'one');
    const two = await db.get('credentials', 'two');
    expect(Buffer.from(one.iv).equals(Buffer.from(two.iv))).toBe(false);
    // A record copied under another id doesn't decrypt.
    await db.put('credentials', one, 'three');
    db.close();
    expect(await v.get('three')).toBeNull();
  });

  it('reads as signed out when the key is gone or the record tampered with', async () => {
    const name = fresh();
    const v = make(name);
    await v.set('x', { kind: 'token', token: TOKEN });
    const db = await openDB(name);
    const rec = await db.get('credentials', 'x');
    rec.data[0] ^= 0xff;
    await db.put('credentials', rec, 'x');
    db.close();
    expect(await v.get('x')).toBeNull();
  });

  it('shares one key between two vault instances (two tabs) on the same database', async () => {
    const name = fresh();
    const [a, b] = [make(name), make(name)];
    await Promise.all([
      a.set('p', { kind: 'token', token: 'A' }),
      b.set('q', { kind: 'token', token: 'B' }),
    ]);
    expect(await a.get('q')).toEqual({ kind: 'token', token: 'B' });
    expect(await b.get('p')).toEqual({ kind: 'token', token: 'A' });
  });
});
