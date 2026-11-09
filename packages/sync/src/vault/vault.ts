// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `CredentialVault` on IndexedDB (PLAN §8A.2 security, ADR-020 §7).
 *
 * - One AES-GCM 256 key per browser profile, generated with `extractable: false` and stored in
 *   IndexedDB as a `CryptoKey` (structured clone keeps it non-extractable: script can use it but
 *   never read its bytes).
 * - Each credential is canonical JSON encrypted with a fresh 96-bit IV. The connection id is the
 *   additional authenticated data, so a record copied to another id fails to decrypt.
 * - Stored records hold only `{ iv, data }` bytes: no token, password or username is readable
 *   from storage. A record that fails to decrypt (key lost, tampered) reads as signed out.
 *
 * Never synced, never logged; nothing here leaves the device.
 */

import type { Credential, CredentialVault, Id } from '@wren-cad/contracts';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

const KEY_ID = 'aes-gcm-v1';

interface SealedRecord {
  /** Format version. */
  v: 1;
  iv: Uint8Array;
  data: Uint8Array;
}

interface VaultSchema extends DBSchema {
  keys: { key: string; value: CryptoKey };
  credentials: { key: string; value: SealedRecord };
}

export interface CredentialVaultOptions {
  /** IndexedDB database name (default `whittle-vault`). */
  dbName?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function isCredential(v: unknown): v is Credential {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  if (c.kind === 'oauth') return typeof c.accessToken === 'string';
  if (c.kind === 'token') return typeof c.token === 'string';
  if (c.kind === 'password')
    return typeof c.username === 'string' && typeof c.password === 'string';
  return false;
}

export class IdbCredentialVault implements CredentialVault {
  readonly #name: string;
  #db: Promise<IDBPDatabase<VaultSchema>> | null = null;
  #key: Promise<CryptoKey> | null = null;

  constructor(options: CredentialVaultOptions = {}) {
    this.#name = options.dbName ?? 'whittle-vault';
  }

  #open(): Promise<IDBPDatabase<VaultSchema>> {
    this.#db ??= openDB<VaultSchema>(this.#name, 1, {
      upgrade(db) {
        db.createObjectStore('keys');
        db.createObjectStore('credentials');
      },
    });
    return this.#db;
  }

  /** The vault key: loaded, or created once (atomically, so two tabs agree on one key). */
  #cryptoKey(): Promise<CryptoKey> {
    this.#key ??= (async () => {
      const db = await this.#open();
      const existing = await db.get('keys', KEY_ID);
      if (existing) return existing;
      const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      // Re-check inside one transaction: another tab may have created the key meanwhile.
      const tx = db.transaction('keys', 'readwrite');
      const raced = await tx.store.get(KEY_ID);
      if (!raced) await tx.store.put(fresh, KEY_ID);
      await tx.done;
      return raced ?? fresh;
    })();
    this.#key.catch(() => {
      this.#key = null;
    });
    return this.#key;
  }

  async get(connectionId: Id): Promise<Credential | null> {
    const db = await this.#open();
    const rec = await db.get('credentials', connectionId);
    if (!rec) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: rec.iv as Uint8Array<ArrayBuffer>,
          additionalData: enc.encode(connectionId),
        },
        await this.#cryptoKey(),
        rec.data as Uint8Array<ArrayBuffer>,
      );
      const value: unknown = JSON.parse(dec.decode(plain));
      return isCredential(value) ? value : null;
    } catch {
      // Lost key or a tampered record: signed out (the UI offers "Sign in again").
      return null;
    }
  }

  async set(connectionId: Id, credential: Credential): Promise<void> {
    if (!isCredential(credential)) throw new TypeError('Not a credential');
    const key = await this.#cryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: enc.encode(connectionId) },
        key,
        enc.encode(JSON.stringify(credential)),
      ),
    );
    const db = await this.#open();
    await db.put('credentials', { v: 1, iv, data }, connectionId);
  }

  async remove(connectionId: Id): Promise<void> {
    const db = await this.#open();
    await db.delete('credentials', connectionId);
  }

  /** Closes the database (tests; switching profiles). */
  async close(): Promise<void> {
    if (this.#db) (await this.#db).close();
    this.#db = null;
    this.#key = null;
  }
}

export function createCredentialVault(options: CredentialVaultOptions = {}): IdbCredentialVault {
  return new IdbCredentialVault(options);
}

/** A vault in memory only (no persistence): tests, and browsers without IndexedDB. */
export class MemoryCredentialVault implements CredentialVault {
  readonly #items = new Map<Id, string>();
  async get(connectionId: Id): Promise<Credential | null> {
    const raw = this.#items.get(connectionId);
    return raw ? (JSON.parse(raw) as Credential) : null;
  }
  async set(connectionId: Id, credential: Credential): Promise<void> {
    this.#items.set(connectionId, JSON.stringify(credential));
  }
  async remove(connectionId: Id): Promise<void> {
    this.#items.delete(connectionId);
  }
}
