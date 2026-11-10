/**
 * Connections, sync and versions (M2.5): the lazy sync controller, adopting remote edits and the SyncHost the controller drives.
 */

import type { JsonPatchOp, ProjectFiles, WrenDoc } from '@wren-cad/contracts';
import type { SyncController, SyncHost } from '../sync/controller';
import type { Workbench } from './workbench';

const LINKS_KEY = 'whittle:links';
export const HISTORY_DIR = '.wren-history/';

/** The page is an OAuth callback (`state` plus `code` or `error`). */
export const isOAuthCallback = () => {
  const q = new URLSearchParams(globalThis.location?.search ?? '');
  if (!(q.has('state') && (q.has('code') || q.has('error')))) return false;
  // Only a sign-in this tab started (its PKCE record, packages/sync auth/oauth.ts): a stray or
  // bookmarked `?code=` is left alone and doesn't load the sync chunk.
  try {
    return sessionStorage.getItem('whittle:oauth-pending') !== null;
  } catch {
    return false;
  }
};

/** A library project linked to a connection (sync/store.ts); read without loading the sync chunk. */
export function isLinked(id: string | undefined): boolean {
  if (!id) return false;
  try {
    const links = JSON.parse(localStorage.getItem(LINKS_KEY) ?? '{}') as Record<string, unknown>;
    return !!links[id];
  } catch {
    return false;
  }
}

export function libLocked<T>(wb: Workbench, fn: () => Promise<T>): Promise<T> {
  const run = wb.libChain.then(fn, fn);
  wb.libChain = run.catch(() => undefined);
  return run;
}

export function midEdit(wb: Workbench): boolean {
  const u = wb.ui.get();
  return !!u.sketch || !!u.pushPull?.dragging || wb.downs.size > 0;
}

export function syncController(wb: Workbench): Promise<SyncController> {
  wb.syncLoad ??= import('../sync/controller').then(async (m) => {
    const ctl = m.createSyncController(wb.syncHost());
    wb.syncCtl = ctl;
    const place = isOAuthCallback() ? ctl.restorePlace() : null;
    if (place?.doc && place.doc !== wb.doc.meta.id) await wb.openFromLibrary(place.doc);
    await ctl.openProject(wb.doc.meta.id);
    if (isOAuthCallback()) await ctl.completeSignIn();
    return ctl;
  });
  return wb.syncLoad;
}

export function projectOpened(wb: Workbench): void {
  if (wb.syncCtl) {
    void wb.syncCtl.openProject(wb.doc.meta.id);
    return;
  }
  wb.projectBar.set({ status: { state: 'local' }, branch: null });
  const hasHistory = [...wb.extra.keys()].some((k) => k.startsWith(HISTORY_DIR));
  if (isLinked(wb.doc.meta.id) || hasHistory || isOAuthCallback()) void wb.syncController();
}

export function openProjectPanel(wb: Workbench, tab: 'versions' | 'connections' | null): void {
  if (tab === null) wb.syncCtl?.closeMode();
  wb.patchUi({ project: tab, ...(tab ? { library: false } : {}) });
  if (tab) void wb.flushSave().then(() => wb.syncController());
}

export function adoptRemote(
  wb: Workbench,
  doc: WrenDoc,
  extra: ProjectFiles,
  ops: JsonPatchOp[],
): void {
  wb.extra = new Map(extra);
  if (ops.length) {
    wb.applyingRemote = true;
    try {
      const r = wb.store.apply({ kind: 'patch', ops }, { label: 'Changes from another device' });
      wb.store.commit();
      if (!r.ok) wb.store.load(doc); // never leave the screen behind the library
    } finally {
      wb.applyingRemote = false;
    }
  }
  wb.persistedDoc = wb.doc;
  wb.loop?.request();
}

export function applyProject(
  wb: Workbench,
  extra: ProjectFiles,
  label: string,
  ops: JsonPatchOp[],
): boolean {
  wb.extra = new Map(extra);
  wb.extraDirty = true;
  if (ops.length === 0) {
    void wb.saveToLibrary(wb.doc);
    return true;
  }
  const ok = wb.apply({ kind: 'patch', ops }, label);
  wb.commit();
  return ok;
}

export function syncHost(wb: Workbench): SyncHost {
  return {
    currentId: () => wb.doc.meta.id,
    doc: () => wb.doc,
    extra: () => wb.extra,
    lockLibrary: async (fn) => {
      const lib = await wb.library();
      return lib ? wb.libLocked(() => fn(lib)) : null;
    },
    canAdoptRemote: () => {
      if (wb.midEdit()) {
        wb.syncDeferred = true;
        return false;
      }
      if (wb.autosaver.pending || wb.extraDirty || wb.store.getDoc() !== wb.persistedDoc) {
        // Save what is on screen first; the engine then merges against it.
        void wb.autosaver.flush().then(() => {
          if (wb.store.getDoc() !== wb.persistedDoc || wb.extraDirty)
            return wb.saveToLibrary(wb.doc);
        });
        return false;
      }
      return true;
    },
    adoptRemote: (doc, extra, ops) => wb.adoptRemote(doc, extra, ops),
    applyFiles: (extra, label, ops) => wb.applyProject(extra, label, ops),
    setExtraFiles: (changes) => {
      for (const [p, b] of changes) {
        if (b) wb.extra.set(p, b);
        else wb.extra.delete(p);
      }
      wb.extraDirty = true;
    },
    persist: async () => {
      await wb.autosaver.flush();
      await wb.saveToLibrary(wb.doc);
    },
    flush: () => wb.flushSave(),
    openNewProject: async (doc, extra) => {
      const lib = await wb.library();
      if (!lib) return false;
      await wb.flushSave();
      await wb.libLocked(() => lib.save(doc, { extra }));
      if (!wb.loadDocument({ doc, extra }, true)) return false;
      wb.patchUi({ library: false, welcome: false });
      return true;
    },
    modeling: async () => ((await wb.whenLive()) ? wb.modeling : null),
    viewport: () => wb.viewport,
    attachments: (doc) => Object.fromEntries(wb.attachmentsFor(doc).map((a) => [a.path, a.bytes])),
    evaluate: (e) => wb.evaluate(e),
    toast: (t, tone) => wb.toast(t, tone),
    setBar: (bar) => wb.projectBar.set(bar),
    openPanel: (tab) => wb.patchUi({ project: tab, library: false }),
  };
}
