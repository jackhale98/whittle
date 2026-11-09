// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/sync/workspace.ts (`CloudWorkspace.sync`, scheduling and `#touched`).
/**
 * `SyncEngine` for one project linked to a folder in a file service (PLAN §8A.2 sync behaviour):
 *
 * - every local save is already on disk; `notifyLocalChange` queues the paths (the offline
 *   queue, persisted in `SyncState.pending`) and pushes once edits settle (debounce, 3 s);
 * - pulls happen on a poll (the provider's pace, stretching while quiet), on window focus (plus
 *   one follow-up check shortly after, for a push still settling on the other device) and on
 *   coming back online, which also replays the queue;
 * - rounds run one at a time; a push that hits `CONFLICT` runs another round straight away to
 *   pull and merge it; conflicts wait for `resolve()`, and nothing conflicting is uploaded.
 */

import type {
  DocMerger,
  MergeResolution,
  ProjectFiles,
  ProjectLink,
  StorageError,
  StorageProvider,
  StorageResult,
  SyncEngine,
  SyncOutcome,
  SyncState,
  SyncStatus,
} from '@wren-cad/contracts';
import { toFiles } from '@wren-cad/document';
import { syncable } from '../paths';
import { fail, ok } from '../providers/common';
import { bytesEqual, sha256Hex } from './hash';
import { type ConflictContext, type RemoteFile, type SyncPhase, syncRound } from './round';
import { nextCheckDelay, saveDataOn } from './schedule';
import type { SyncLocalStore } from './store';

/** Window, document and network events the engine listens to. */
export interface SyncEnvironment {
  isOnline(): boolean;
  /** The page is shown (polls pause while hidden). */
  isVisible(): boolean;
  /** Window focus, or the page becoming visible. Returns an unsubscribe function. */
  onFocus(listener: () => void): () => void;
  onOnline(listener: () => void): () => void;
  onOffline(listener: () => void): () => void;
  /** Data Saver (fewer polls). */
  saveData(): boolean;
}

/** The browser's window, document and navigator (no-ops where they don't exist, e.g. workers). */
export function browserEnvironment(): SyncEnvironment {
  const w = globalThis as unknown as Partial<Window> & typeof globalThis;
  const doc = typeof document === 'undefined' ? undefined : document;
  const on = (target: EventTarget | undefined, type: string, fn: () => void) => {
    target?.addEventListener(type, fn);
    return () => target?.removeEventListener(type, fn);
  };
  const target = typeof w.addEventListener === 'function' ? (w as EventTarget) : undefined;
  return {
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    isVisible: () => doc?.visibilityState !== 'hidden',
    onFocus: (fn) => {
      const offFocus = on(target, 'focus', fn);
      const vis = () => {
        if (doc?.visibilityState === 'visible') fn();
      };
      const offVis = on(doc, 'visibilitychange', vis);
      return () => {
        offFocus();
        offVis();
      };
    },
    onOnline: (fn) => on(target, 'online', fn),
    onOffline: (fn) => on(target, 'offline', fn),
    saveData: saveDataOn,
  };
}

export interface SyncEngineOptions {
  provider: StorageProvider;
  link: ProjectLink;
  store: SyncLocalStore;
  merger: DocMerger;
  /** Push this long after the last local change (default 3 s). */
  debounceMs?: number;
  /** Base poll interval (default `provider.pollMs`). */
  pollMs?: number;
  /**
   * Extra checks after the window gains focus, ms after focus (default 3, 6 and 9 s): another
   * device's debounced push (3 s) that lands just after focusing still shows within 10 s
   * (PLAN §12 M2.5). A number means one check; 0 or [] turns them off.
   */
  focusRecheckMs?: number | readonly number[];
  /** Default: the browser's. `null`: no events (tests drive `syncNow` by hand). */
  environment?: SyncEnvironment | null;
  /** Sync once as soon as the engine is created (default true). */
  syncOnStart?: boolean;
  /** Called with the working copy before sync replaces or deletes local files (local history). */
  onBeforeOverwrite?: (files: ProjectFiles) => Promise<void> | void;
  now?: () => number;
  /** Most rounds per `syncNow` (push conflicts and concurrent saves run another; default 4). */
  maxRounds?: number;
}

/** A `SyncEngine` with a few extras for the app and tests. */
export interface ProjectSyncEngine extends SyncEngine {
  /** Resolves when everything queued so far (state load, rounds) has finished. */
  idle(): Promise<void>;
  /** The persisted state (after the engine has loaded it). */
  state(): Promise<SyncState>;
}

const emptyState = (link: ProjectLink): SyncState => ({
  link,
  cursor: null,
  bases: {},
  pending: [],
});

const sameLink = (a: ProjectLink, b: ProjectLink) =>
  a.connectionId === b.connectionId && a.path === b.path;

export function createSyncEngine(options: SyncEngineOptions): ProjectSyncEngine {
  const { provider, store, merger, link } = options;
  const debounceMs = options.debounceMs ?? 3_000;
  const basePoll = options.pollMs ?? provider.pollMs;
  const rechecks = ((): number[] => {
    const v = options.focusRecheckMs ?? [3_000, 6_000, 9_000];
    return (typeof v === 'number' ? [v] : [...v]).filter((ms) => ms > 0).sort((a, b) => a - b);
  })();
  const maxRounds = options.maxRounds ?? 4;
  const now = options.now ?? Date.now;
  const env = options.environment === undefined ? browserEnvironment() : options.environment;

  let status: SyncStatus = { state: 'idle', pending: 0 };
  const listeners = new Set<(s: SyncStatus) => void>();
  let disposed = false;
  let chain: Promise<unknown> = Promise.resolve();
  let queuedSync: Promise<StorageResult<SyncOutcome>> | null = null;
  let conflict: ConflictContext | null = null;
  let pendingCount = 0;
  let lastSyncAt: string | undefined;
  /** Paths saved while a round runs: re-added to the queue after it. */
  let touched = new Set<string>();
  let roundRunning = false;
  let quiet = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe: (() => void)[] = [];

  const setStatus = (s: SyncStatus) => {
    status = s;
    for (const l of [...listeners]) l(s);
  };
  const settledStatus = (): SyncStatus =>
    conflict
      ? { state: 'conflicts', merge: conflict.merge }
      : { state: 'idle', pending: pendingCount, ...(lastSyncAt ? { lastSyncAt } : {}) };

  /** Runs `task` after everything before it (state changes and rounds never interleave). */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task);
    chain = run.catch(() => undefined);
    return run;
  };

  const loadState = async (): Promise<SyncState> => {
    const s = await store.loadState();
    if (!s) return emptyState(link);
    // Linked to another folder since: the old bases mean nothing there.
    if (!sameLink(s.link, link)) return { ...emptyState(link), pending: s.pending };
    return s;
  };

  const addPending = (paths: readonly string[]) =>
    serial(async () => {
      if (!paths.length) return;
      const s = await loadState();
      const next = [...new Set([...s.pending, ...paths])].sort();
      if (next.length !== s.pending.length || !sameLink(s.link, link)) {
        await store.saveState({ ...s, link, pending: next });
      }
      pendingCount = next.length;
      if (status.state === 'idle' || status.state === 'offline') {
        setStatus(
          status.state === 'offline'
            ? { state: 'offline', pending: pendingCount }
            : settledStatus(),
        );
      }
    });

  // ---------------------------------------------------------------- timers

  const clear = (t: ReturnType<typeof setTimeout> | null) => {
    if (t !== null) clearTimeout(t);
  };

  const schedulePoll = () => {
    clear(pollTimer);
    pollTimer = null;
    if (disposed || !env) return;
    const delay = nextCheckDelay({ base: basePoll, quiet, saveData: env.saveData() });
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (env.isVisible()) void syncNow();
      else schedulePoll();
    }, delay);
  };

  const onFocus = () => {
    quiet = 0;
    void syncNow();
    clear(recheckTimer);
    recheckTimer = null;
    const focusedAt = now();
    const next = (i: number) => {
      const at = rechecks[i];
      if (at === undefined) return;
      recheckTimer = setTimeout(
        () => {
          recheckTimer = null;
          void syncNow();
          next(i + 1);
        },
        Math.max(0, at - (now() - focusedAt)),
      );
    };
    next(0);
  };

  // ---------------------------------------------------------------- rounds

  const offline = (error: StorageError) => {
    setStatus({ state: 'offline', pending: pendingCount });
    return fail<SyncOutcome>('OFFLINE', error.message);
  };

  const runRounds = async (): Promise<StorageResult<SyncOutcome>> => {
    if (disposed) return fail('REMOTE', 'Sync has stopped for this project.');
    if (env && !env.isOnline()) {
      pendingCount = (await loadState()).pending.length;
      return offline({ code: 'OFFLINE', message: 'You’re offline. Changes stay queued.' });
    }
    const total: SyncOutcome = { pulled: 0, pushed: 0, merged: [] };
    roundRunning = true;
    touched = new Set();
    try {
      for (let i = 0; i < maxRounds; i += 1) {
        const state = await loadState();
        setStatus({ state: 'syncing', phase: 'listing', ratio: null });
        const r = await syncRound(
          {
            provider,
            store,
            merger,
            now,
            onProgress: (phase: SyncPhase, ratio) => setStatus({ state: 'syncing', phase, ratio }),
            ...(options.onBeforeOverwrite ? { onBeforeOverwrite: options.onBeforeOverwrite } : {}),
          },
          state,
        );
        if (!r.ok) {
          const s = await loadState();
          pendingCount = s.pending.length;
          if (r.error.code === 'OFFLINE') return offline(r.error);
          setStatus({ state: 'error', error: r.error });
          return r;
        }
        if (r.value.kind === 'retry') continue;
        const { outcome, again } = r.value;
        conflict = r.value.conflict;
        pendingCount = r.value.state.pending.length;
        lastSyncAt = r.value.state.lastSyncAt;
        total.pulled += outcome.pulled;
        total.pushed += outcome.pushed;
        total.merged = [...new Set([...total.merged, ...outcome.merged])];
        if (outcome.files) total.files = outcome.files;
        if (outcome.merge) total.merge = outcome.merge;
        else delete total.merge;
        if (!again) break;
      }
      quiet = total.pulled + total.pushed > 0 ? 0 : quiet + 1;
      setStatus(settledStatus());
      return ok(total);
    } finally {
      roundRunning = false;
      const late = [...touched];
      touched = new Set();
      if (late.length) {
        // Saved during the round: keep them queued, and push once they settle.
        void addPending(late);
        scheduleDebounce();
      }
    }
  };

  const syncNow = (): Promise<StorageResult<SyncOutcome>> => {
    // A round already waiting will see everything up to now: share it.
    if (queuedSync) return queuedSync;
    const run = serial(async () => {
      queuedSync = null;
      try {
        return await runRounds();
      } finally {
        schedulePoll();
      }
    });
    queuedSync = run;
    return run;
  };

  const scheduleDebounce = () => {
    if (disposed) return;
    clear(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void syncNow();
    }, debounceMs);
  };

  // ---------------------------------------------------------------- resolve

  const applyResolutions = async (
    ctx: ConflictContext,
    resolutions: readonly MergeResolution[],
  ): Promise<StorageResult<'applied' | 'stale'>> => {
    const ids = new Set(ctx.merge.conflicts.map((c) => c.id));
    for (const r of resolutions) {
      if (!ids.has(r.conflictId)) {
        return fail(
          'CONFLICT',
          'The conflicts changed while you were choosing. Review them again.',
        );
      }
    }
    const byId = new Map(resolutions.map((r) => [r.conflictId, r]));
    const writes = new Map<string, Uint8Array | null>();
    const expected = new Map<string, Uint8Array | null>();
    const adopt = new Map<string, RemoteFile | null>();
    if (ctx.doc) {
      const docIds = new Set(ctx.doc.result.conflicts.map((c) => c.id));
      const doc = merger.resolve(
        ctx.doc.result,
        resolutions.filter((r) => docIds.has(r.conflictId)),
      );
      const out = toFiles(doc);
      for (const p of new Set([...ctx.doc.paths, ...out.keys()])) {
        const ours = ctx.doc.ours.get(p) ?? null;
        expected.set(p, ours);
        const nb = out.get(p) ?? null;
        if (!bytesEqual(ours, nb)) writes.set(p, nb);
      }
      for (const [p, t] of ctx.doc.theirs) adopt.set(p, t);
    }
    for (const fc of ctx.files) {
      const r = byId.get(fc.id);
      let chosen: Uint8Array | null = fc.ours;
      if (r && 'take' in r) {
        chosen =
          r.take === 'theirs' ? (fc.theirs?.bytes ?? null) : r.take === 'base' ? fc.base : fc.ours;
      } else if (r && 'value' in r) {
        const v = r.value;
        chosen =
          v === null || v === undefined
            ? null
            : v instanceof Uint8Array
              ? v
              : new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
      }
      expected.set(fc.path, fc.ours);
      if (!bytesEqual(fc.ours, chosen)) writes.set(fc.path, chosen);
      adopt.set(fc.path, fc.theirs);
    }
    if (!(await store.writeFiles(writes, expected))) return ok('stale');
    // The remote side the user just merged with becomes the base; the push goes against it.
    const s = await loadState();
    const bases = { ...s.bases };
    for (const [p, t] of adopt) {
      if (!t) delete bases[p];
      else {
        const hash = await sha256Hex(t.bytes);
        await store.putBase(hash, t.bytes);
        bases[p] = { rev: t.rev, hash };
      }
    }
    const pending = [...new Set([...s.pending, ...writes.keys(), ...adopt.keys()])]
      .filter(syncable)
      .sort();
    await store.saveState({ ...s, bases, pending });
    return ok('applied');
  };

  const resolve = async (
    resolutions: readonly MergeResolution[],
  ): Promise<StorageResult<SyncOutcome>> => {
    const applied = await serial(async () => {
      const ctx = conflict;
      if (!ctx) return ok('none' as const);
      const r = await applyResolutions(ctx, resolutions);
      if (r.ok) conflict = null;
      return r;
    });
    if (!applied.ok) return applied;
    // Applied (push now), stale (the user saved meanwhile: merge again) or nothing to resolve.
    return syncNow();
  };

  // ---------------------------------------------------------------- wiring

  if (env) {
    unsubscribe.push(env.onFocus(onFocus));
    unsubscribe.push(
      env.onOnline(() => {
        quiet = 0;
        void syncNow();
      }),
    );
    unsubscribe.push(
      env.onOffline(() => {
        if (!roundRunning) setStatus({ state: 'offline', pending: pendingCount });
      }),
    );
  }
  void serial(async () => {
    const s = await loadState();
    pendingCount = s.pending.length;
    lastSyncAt = s.lastSyncAt;
    setStatus(settledStatus());
  });
  if (options.syncOnStart ?? true) void syncNow();
  else schedulePoll();

  return {
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notifyLocalChange(paths) {
      const mine = paths.filter(syncable);
      if (!mine.length || disposed) return;
      if (roundRunning) for (const p of mine) touched.add(p);
      void addPending(mine);
      scheduleDebounce();
    },
    syncNow,
    resolve,
    dispose() {
      disposed = true;
      clear(debounceTimer);
      clear(pollTimer);
      clear(recheckTimer);
      debounceTimer = pollTimer = recheckTimer = null;
      for (const u of unsubscribe.splice(0)) u();
      listeners.clear();
    },
    idle: async () => {
      // Rounds can queue more work (late saves); wait until the chain stops growing.
      let seen: Promise<unknown> | null = null;
      while (seen !== chain) {
        seen = chain;
        await chain;
      }
    },
    state: () => serial(loadState),
  };
}
