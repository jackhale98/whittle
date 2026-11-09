/// A device for engine tests: a local working copy, a sync engine on a shared fake remote and the
/// fake merger. Saving notifies the engine as the app would.

import type {
  MergeResolution,
  ProjectFiles,
  StorageProvider,
  SyncOutcome,
  WrenDoc,
} from '@wren-cad/contracts';
import { fromFiles, toFiles } from '@wren-cad/document';
import {
  createSyncEngine,
  type ProjectSyncEngine,
  type SyncEngineOptions,
  type SyncEnvironment,
} from '../../src/engine/engine';
import { MemorySyncStore } from '../../src/engine/store';
import { syncable } from '../../src/paths';
import { FakeMerger } from './fake-merger';
import { must } from './fetch';

export const LINK = { connectionId: 'conn', path: '/CAD/bracket' };

export class Device {
  readonly merger = new FakeMerger();
  engine: ProjectSyncEngine;

  constructor(
    readonly remote: StorageProvider,
    readonly store = new MemorySyncStore(),
    readonly options: Partial<SyncEngineOptions> = {},
  ) {
    this.engine = this.#make();
  }

  #make(): ProjectSyncEngine {
    return createSyncEngine({
      provider: this.remote,
      link: LINK,
      store: this.store,
      merger: this.merger,
      environment: null,
      syncOnStart: false,
      // Tests drive syncs by hand unless they ask for timers.
      debounceMs: 3_600_000,
      ...this.options,
    });
  }

  /** The app closes and opens again (same storage, new engine). */
  restart(): void {
    this.engine.dispose();
    this.engine = this.#make();
  }

  save(path: string, content: Uint8Array | string | null): void {
    this.store.save(path, content);
    this.engine.notifyLocalChange([path]);
  }

  /** Saves a whole document as the app does (writes changed files, removes dropped ones). */
  saveDoc(doc: WrenDoc): void {
    const next = toFiles(doc);
    const changed: string[] = [];
    for (const [p, b] of next) {
      const old = this.store.files.get(p);
      if (!old || Buffer.compare(Buffer.from(old), Buffer.from(b)) !== 0) {
        this.store.files.set(p, b);
        changed.push(p);
      }
    }
    for (const p of this.docFiles().keys()) {
      if (!next.has(p)) {
        this.store.files.delete(p);
        changed.push(p);
      }
    }
    this.engine.notifyLocalChange(changed);
  }

  docFiles(): ProjectFiles {
    const out: ProjectFiles = new Map();
    for (const [p, b] of this.store.files)
      if (/\.json$/.test(p) && !p.startsWith('.')) out.set(p, b);
    return out;
  }

  doc(): WrenDoc {
    return fromFiles(this.store.files);
  }

  /** The syncable files as text, for comparing devices. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, b] of [...this.store.files].sort(([a], [c]) => (a < c ? -1 : 1)))
      if (syncable(p)) out[p] = Buffer.from(b).toString('base64');
    return out;
  }

  async sync(): Promise<SyncOutcome> {
    return must(await this.engine.syncNow());
  }

  async resolve(resolutions: MergeResolution[]): Promise<SyncOutcome> {
    return must(await this.engine.resolve(resolutions));
  }
}

/** The project files in the fake remote under `LINK.path`, as base64 by relative path. */
export function remoteSnapshot(files: Map<string, { path: string; bytes: Uint8Array }>) {
  const out: Record<string, string> = {};
  const prefix = `${LINK.path.toLowerCase()}/`;
  const entries = [...files.values()]
    .filter((f) => f.path.toLowerCase().startsWith(prefix))
    .map((f) => [f.path.slice(prefix.length), Buffer.from(f.bytes).toString('base64')] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [p, b] of entries) if (syncable(p)) out[p] = b;
  return out;
}

/** Window/network events under the test's control. */
export function fakeEnvironment() {
  const focus = new Set<() => void>();
  const online = new Set<() => void>();
  const offline = new Set<() => void>();
  const state = { online: true, visible: true };
  const sub = (set: Set<() => void>) => (fn: () => void) => {
    set.add(fn);
    return () => set.delete(fn);
  };
  const env: SyncEnvironment = {
    isOnline: () => state.online,
    isVisible: () => state.visible,
    onFocus: sub(focus),
    onOnline: sub(online),
    onOffline: sub(offline),
    saveData: () => false,
  };
  return {
    env,
    state,
    focus: () => {
      for (const f of focus) f();
    },
    goOnline: () => {
      state.online = true;
      for (const f of online) f();
    },
    goOffline: () => {
      state.online = false;
      for (const f of offline) f();
    },
  };
}
