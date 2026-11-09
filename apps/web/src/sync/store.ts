/**
 * Device-local records for connections and sync (PLAN §8A.2). None of it is secret: credentials
 * live only in the encrypted `CredentialVault`, and a `Connection` holds no tokens (contract).
 *
 * - `whittle:connections`: the configured connections.
 * - `whittle:links`: library project id → `ProjectLink` (which connection and folder or
 *   repository it syncs with). For git hosts `path` is the HTTPS clone URL; for a local git repo
 *   it is the project folder relative to the repo root (`''`: the root, ADR-029).
 * - `whittle:history-state:<id>`: the branch and version this device's working copy is on.
 *
 * localStorage, not IndexedDB: tiny JSON, read synchronously at boot to decide whether the sync
 * chunk is needed at all for the document being opened.
 */

import type { Connection, Id, ProjectLink } from '@wren-cad/contracts';

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const CONNECTIONS = 'whittle:connections';
const LINKS = 'whittle:links';
const HISTORY_STATE = 'whittle:history-state:';

function storage(kv?: KeyValue): KeyValue | null {
  if (kv) return kv;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read<T>(key: string, fallback: T, kv?: KeyValue): T {
  try {
    const raw = storage(kv)?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown, kv?: KeyValue): void {
  try {
    storage(kv)?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: connections last for this session only.
  }
}

export function loadConnections(kv?: KeyValue): Connection[] {
  const list = read<unknown>(CONNECTIONS, [], kv);
  return Array.isArray(list) ? (list as Connection[]) : [];
}

export function saveConnection(c: Connection, kv?: KeyValue): Connection[] {
  const list = loadConnections(kv).filter((x) => x.id !== c.id);
  list.push(c);
  write(CONNECTIONS, list, kv);
  return list;
}

/** Removes a connection and every project link through it (the files stay where they are). */
export function removeConnection(id: Id, kv?: KeyValue): Connection[] {
  const list = loadConnections(kv).filter((x) => x.id !== id);
  write(CONNECTIONS, list, kv);
  const links = loadLinks(kv);
  for (const [p, l] of Object.entries(links)) if (l.connectionId === id) delete links[p];
  write(LINKS, links, kv);
  return list;
}

export function loadLinks(kv?: KeyValue): Record<string, ProjectLink> {
  const v = read<unknown>(LINKS, {}, kv);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, ProjectLink>) : {};
}

export function linkOf(projectId: string | undefined, kv?: KeyValue): ProjectLink | null {
  if (!projectId) return null;
  const l = loadLinks(kv)[projectId];
  return l && typeof l.connectionId === 'string' && typeof l.path === 'string' ? l : null;
}

export function setLink(projectId: string, link: ProjectLink | null, kv?: KeyValue): void {
  const links = loadLinks(kv);
  if (link) links[projectId] = link;
  else delete links[projectId];
  write(LINKS, links, kv);
}

export interface HistoryState {
  branch: string;
  version: string | null;
}

export function loadHistoryState(projectId: string, kv?: KeyValue): HistoryState | undefined {
  const s = read<HistoryState | null>(HISTORY_STATE + projectId, null, kv);
  return s && typeof s.branch === 'string' ? s : undefined;
}

export function saveHistoryState(projectId: string, s: HistoryState, kv?: KeyValue): void {
  write(HISTORY_STATE + projectId, s, kv);
}

/** Library ids of the projects linked through each connection (the panel's "2 projects"). */
export function projectsPer(kv?: KeyValue): Map<Id, number> {
  const out = new Map<Id, number>();
  for (const l of Object.values(loadLinks(kv)))
    out.set(l.connectionId, (out.get(l.connectionId) ?? 0) + 1);
  return out;
}

/** HTTPS clone URL from the token form's repository field (`owner/name` or a full URL). */
export function cloneUrl(host: string, repo: string): string | null {
  const r = repo.trim();
  if (/^https?:\/\//i.test(r)) {
    try {
      const u = new URL(r);
      if (u.username || u.password) return null; // never keep credentials in a URL
      const path = u.pathname.replace(/\/+$/, '');
      if (!/^\/[^/]+/.test(path)) return null;
      return `${u.origin}${path.endsWith('.git') ? path : `${path}.git`}`;
    } catch {
      return null;
    }
  }
  const m = /^([\w.-]+)\/([\w.-]+?)(\.git)?$/.exec(r);
  if (!m || !host.trim()) return null;
  const h = host
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h) ? 'http' : 'https';
  return `${scheme}://${h}/${m[1]}/${m[2]}.git`;
}
