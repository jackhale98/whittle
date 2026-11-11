/**
 * File, library and export actions: project files, saving, thumbnails, open/new/import and export.
 */

import type { Id, ProjectFiles, Vec3, WrenDoc } from '@wren-cad/contracts';
import { ulid } from '@wren-cad/document';
import type { ExportRequest } from '@wren-cad/ui';
import type { OpenedFile, ProjectBundle } from '../doc/library';
import { pruneAttachments as pruneAttachmentFiles, savedExtra } from '../model/attachments';
import { IMPORT_EXTENSIONS, importFeature, importFormat } from '../model/import';
import type { Attachment } from '../model/modeling';
import { exportAll, exportBase, refuseIssues, refuseMissing } from './config-export';
import { initialSection } from './state';
import type { Workbench } from './workbench';
import { fileBase, freshDocument, THUMB_EVERY_MS, writeLastDoc } from './workbench-util';

export function setProjectFiles(
  wb: Workbench,
  bundle: { extra?: ProjectFiles; cache?: ProjectFiles },
  inLibrary: boolean,
): void {
  wb.extra = new Map(bundle.extra ?? []);
  wb.cache = new Map(bundle.cache ?? []);
  wb.cacheKey = null;
  wb.savedCacheKey = null;
  wb.inLibrary = inLibrary;
  wb.heals = new Map();
  wb.fitPending = true;
  wb.fitOnFirstGeometry = true;
}

export function attachmentsFor(wb: Workbench, doc: WrenDoc): Attachment[] {
  const out: Attachment[] = [];
  for (const f of doc.parts[0]?.features ?? []) {
    if (f.type !== 'import') continue;
    const bytes = wb.extra.get(f.source.path);
    if (bytes) out.push({ path: f.source.path, sha256: f.source.sha256, bytes });
  }
  return out;
}

export async function saveToLibrary(wb: Workbench, doc: WrenDoc): Promise<void> {
  const lib = await wb.library();
  if (!lib) return;
  // A save can run after another document was loaded (it was scheduled or queued before the
  // switch): it must write *its* document's files, never the newly open one's.
  const current = doc.meta.id === wb.doc.meta.id;
  const files = current
    ? { extra: wb.extra, cache: wb.cache, key: wb.cacheKey }
    : wb.retired.get(doc.meta.id ?? '');
  if (!files) return; // nothing known about that document's files: never guess them
  const thumbnail = current ? await wb.thumbnail() : undefined;
  // Orphaned import attachments are never written; in memory they live on while the history
  // could bring their feature back (model/attachments.ts, ADR-016).
  if (current) wb.pruneAttachments();
  const extra = savedExtra(files.extra, doc);
  const wasDirty = current && wb.extraDirty;
  await wb.libLocked(() =>
    lib.save(doc, {
      ...(thumbnail ? { thumbnail } : {}),
      extra,
      cache: files.cache,
    }),
  );
  if (doc.meta.id) wb.syncCtl?.onSaved(doc.meta.id, doc, extra);
  if (current && doc.meta.id === wb.doc.meta.id) {
    if (wasDirty) wb.extraDirty = false;
    wb.persistedDoc = doc;
    const first = !wb.inLibrary;
    wb.inLibrary = true;
    if (first) void wb.syncCtl?.openProject(doc.meta.id);
    wb.savedCacheKey = files.key;
    writeLastDoc(doc.meta.id);
    // Finer meshes that arrived while this save ran (e.g. the first save of a new document,
    // when updateMeshCache could not schedule one yet) still need to reach the library.
    if (wb.cacheKey !== files.key && !wb.autosaver.pending) wb.scheduleCacheSave();
  }
  if (wb.ui.get().library) void wb.refreshLibrary();
}

export function flushSave(wb: Workbench): Promise<void> {
  wb.thumbWanted = true;
  return wb.autosaver.flush().finally(() => {
    wb.thumbWanted = false;
  });
}

export async function thumbnail(wb: Workbench): Promise<Uint8Array | undefined> {
  const canvas = wb.canvas;
  const v = wb.viewport;
  if (!canvas || !v || wb.shownBodies.size === 0 || wb.ui.get().sketch) return undefined;
  const now = performance.now();
  const id = wb.doc.meta.id ?? '';
  const first = !wb.thumbDocs.has(id);
  if (!first && !wb.thumbWanted && now - wb.lastThumbAt < THUMB_EVERY_MS) return undefined;
  wb.lastThumbAt = now;
  wb.thumbDocs.add(id);
  try {
    const { canvasToThumbnail } = await import('../doc/library');
    // Read pixels in the same task as a fresh frame (the drawing buffer is not preserved).
    await v.nextFrame();
    return await canvasToThumbnail(canvas, { width: 256, height: 192 });
  } catch {
    return undefined;
  }
}

export async function refreshLibrary(wb: Workbench, query = ''): Promise<void> {
  const lib = await wb.library();
  wb.libraryEntries.set(lib ? await lib.list(query) : []);
}

export function toggleLibrary(wb: Workbench, open = !wb.ui.get().library): void {
  wb.patchUi({ library: open });
  if (open) void wb.flushSave().then(() => wb.refreshLibrary());
}

export function loadDocument(
  wb: Workbench,
  bundle: { doc: WrenDoc; extra?: ProjectFiles; cache?: ProjectFiles },
  inLibrary: boolean,
): boolean {
  wb.sketch?.exit(false);
  wb.patchUi({
    selection: [],
    featureId: null,
    picking: null,
    prompt: null,
    hover: null,
    chooser: null,
    candidates: null,
  });
  const old = wb.part?.id;
  // Edits made while a switch was in flight are still pending for the outgoing document: save
  // them with that document's own files (snapshotted here), then let the new one load.
  const outgoing = wb.doc.meta.id;
  if (outgoing && wb.autosaver.pending) {
    wb.retired.set(outgoing, { extra: wb.extra, cache: wb.cache, key: wb.cacheKey });
    const flushed = wb.autosaver.flush();
    void flushed.finally(() => {
      if (outgoing !== wb.doc.meta.id) wb.retired.delete(outgoing);
    });
  }
  const r = wb.store.load(bundle.doc);
  if (!r.ok) {
    wb.toast(r.error, 'error');
    return false;
  }
  clearTimeout(wb.cacheTimer);
  wb.setProjectFiles(bundle, inLibrary);
  writeLastDoc(bundle.doc.meta.id);
  if (old && old !== wb.part?.id) {
    wb.loop?.forget(old);
    void wb.modeling?.closePart(old);
  }
  wb.showCached(wb.doc);
  wb.kernelIfNothingCached();
  wb.pushPull.cancel();
  wb.measure.stop();
  wb.setSection(initialSection);
  wb.persistedDoc = inLibrary ? wb.doc : null;
  wb.extraDirty = false;
  wb.syncDeferred = false;
  wb.projectOpened();
  return true;
}

export function requestTour(wb: Workbench): void {
  wb.tourRequests.set((n) => n + 1);
}

export function partVisible(wb: Workbench, id: Id): boolean {
  return !wb.hiddenParts.has(id);
}

export function setPartVisible(wb: Workbench, id: Id, visible: boolean): void {
  if (visible) wb.hiddenParts.delete(id);
  else wb.hiddenParts.add(id);
  wb.syncViewport();
  wb.ui.set((u) => ({ ...u })); // re-render the parts list
}

export function focusPart(wb: Workbench, id: Id): void {
  const view = wb.regen.get();
  if (!view || view.result.partId !== id) return;
  const b = wb.bounds();
  if (!b) return;
  const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const r = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
  wb.viewport?.zoomTo(c, Math.max(r, 1), true);
}

export async function newDocument(wb: Workbench): Promise<void> {
  await wb.flushSave();
  wb.loadDocument({ doc: freshDocument() }, false);
  wb.patchUi({ library: false, welcome: false });
}

export async function openDemo(wb: Workbench): Promise<void> {
  await wb.flushSave();
  const { demoBracket } = await import('../samples/bracket');
  const doc = demoBracket();
  wb.loadDocument({ doc }, false);
  wb.autosaver.schedule(doc);
  wb.patchUi({ library: false, welcome: false });
}

export async function openFromLibrary(wb: Workbench, id: string): Promise<void> {
  await wb.flushSave();
  const lib = await wb.library();
  if (!lib) return;
  try {
    wb.loadDocument(await lib.open(id), true);
    wb.patchUi({ library: false });
  } catch (e) {
    wb.toast(e instanceof Error ? e.message : 'Could not open that document', 'error');
  }
}

export async function renameInLibrary(wb: Workbench, id: string, name: string): Promise<void> {
  if (id === wb.doc.meta.id) {
    wb.renameDocument(name);
    await wb.flushSave();
  } else {
    const lib = await wb.library();
    await lib?.rename(id, name);
  }
  await wb.refreshLibrary();
}

export async function deleteFromLibrary(wb: Workbench, id: string): Promise<void> {
  const lib = await wb.library();
  if (!lib) return;
  if (id === wb.doc.meta.id) {
    wb.autosaver.cancel();
    await lib.remove(id);
    wb.loadDocument({ doc: freshDocument() }, false);
    wb.patchUi({ library: true });
  } else await lib.remove(id);
  await wb.refreshLibrary();
}

export async function openFromDisk(
  wb: Workbench,
  into: 'current' | 'new' = 'current',
): Promise<void> {
  const { openFile } = await import('../doc/library');
  // `.whittle`: files saved before the rename (ADR-032) still open.
  const f = await openFile(['.wrencad', '.whittle', ...IMPORT_EXTENSIONS]);
  if (f) await wb.openBytes(f.name, f.bytes, into);
}

export async function openBytes(
  wb: Workbench,
  name: string,
  bytes: Uint8Array,
  into: 'current' | 'new' = 'current',
): Promise<void> {
  if (/\.(wrencad|whittle)$/i.test(name)) {
    try {
      const { fromWrenBytes } = await import('../doc/library');
      await wb.openProject(fromWrenBytes(bytes));
    } catch (e) {
      wb.toast(e instanceof Error ? e.message : 'That file could not be read', 'error');
    }
    return;
  }
  await wb.importFiles([{ name, bytes }], into);
}

export async function openProject(wb: Workbench, bundle: ProjectBundle): Promise<void> {
  await wb.flushSave();
  const lib = await wb.library();
  let { doc } = bundle;
  let note: string | null = null;
  let inLibrary = false;
  if (lib && doc.meta.id) {
    const { sameProject, copyName } = await import('../doc/library');
    // A lookup that fails is not "absent": treat it like a different version (open as a copy)
    // rather than letting autosave overwrite whatever is stored under that id.
    const existing = await lib.find(doc.meta.id).catch(() => 'unknown' as const);
    if (existing && existing !== 'unknown' && sameProject(existing, bundle)) inLibrary = true;
    else if (existing) {
      const names = new Set((await lib.list()).map((e) => e.name));
      const name = copyName(doc.meta.name, names);
      doc = { ...doc, meta: { ...doc.meta, id: ulid(), name } };
      note = `Opened as “${name}”: your library already has a different version of this document, and it is unchanged.`;
    }
  }
  if (!wb.loadDocument({ ...bundle, doc }, inLibrary)) return;
  wb.autosaver.schedule(wb.doc); // opened from disk: keep a copy in the library
  wb.patchUi({ library: false, welcome: false });
  if (note) wb.toast(note, 'info');
}

export async function importFiles(
  wb: Workbench,
  files: readonly OpenedFile[],
  into: 'current' | 'new',
): Promise<void> {
  const usable = files.filter((f) => importFormat(f.name));
  if (usable.length === 0) {
    const names = files.map((f) => f.name).join(', ');
    wb.toast(
      `Wren can open .wrencad projects and import STEP, IGES, BREP, STL, OBJ, 3MF and GLB files${names ? ` (not ${names})` : ''}.`,
      'info',
    );
    return;
  }
  if (into === 'new' || !wb.part) {
    await wb.flushSave();
    const doc = freshDocument();
    const stem = (usable[0]?.name ?? 'Import').replace(/\.[^.]+$/, '');
    wb.loadDocument({ doc: { ...doc, meta: { ...doc.meta, name: stem } } }, false);
  }
  if (wb.ui.get().sketch) wb.sketch?.exit(true);
  for (const f of usable) {
    const part = wb.part;
    if (!part) return;
    const made = await importFeature(part, f.name, f.bytes);
    if (!made) continue;
    wb.extra.set(made.path, f.bytes);
    if (
      !wb.apply({ kind: 'addFeature', partId: part.id, feature: made.feature }, `Import ${f.name}`)
    )
      wb.extra.delete(made.path);
    wb.commit();
  }
  wb.fitPending = true;
  wb.fitOnFirstGeometry = true;
  wb.patchUi({ library: false, welcome: false, selection: [], featureId: null });
}

export function pruneAttachments(wb: Workbench): void {
  pruneAttachmentFiles(wb.extra, wb.doc, (paths) => wb.store.historyMentions(paths));
}

export async function exportWren(wb: Workbench): Promise<void> {
  const { toWrenBytes, saveFile, MIME } = await import('../doc/library');
  wb.pruneAttachments();
  await saveFile(
    toWrenBytes(wb.doc, savedExtra(wb.extra, wb.doc), wb.cache),
    `${fileBase(wb.doc.meta.name)}.wrencad`,
    MIME.wrencad,
  );
}

export async function exportDoc(wb: Workbench, request: ExportRequest): Promise<void> {
  const part = wb.part;
  const view = wb.regen.get();
  if (!part) return;
  wb.patchUi({ exporting: true });
  try {
    const lib = await import('../doc/library');
    if (request.target === 'wren') return await wb.exportWren();
    // M3.7: files are named by part number; a missing configuration is never exported as Default.
    if (refuseMissing(wb) || (request.configurations !== 'all' && refuseIssues(wb))) return;
    if (request.configurations === 'all') return await exportAll(wb, request);
    const base = exportBase(wb);
    if (request.target === '3mf' || request.target === 'glb') {
      const bodies = (view?.result.bodies ?? []).filter(
        (b) => !request.options.bodies || request.options.bodies.includes(b.id),
      );
      if (bodies.length === 0) return wb.toast('There is nothing to export yet.', 'info');
      const { meshExporters } = await import('@wren-cad/io');
      const color = wb.bodyColor();
      const items = bodies.map((b, i) => ({
        name: `Body ${i + 1}`,
        mesh: b.mesh,
        ...(color ? { color } : {}),
      }));
      const bytes =
        request.target === '3mf'
          ? meshExporters.to3mf(items, 'millimeter')
          : meshExporters.toGlb(items);
      await lib.saveFile(bytes, `${base}.${request.target}`, lib.MIME[request.target]);
      wb.exports.set((n) => n + 1);
      return;
    }
    // Exact formats need the kernel (phones boot it now).
    const live = view?.source === 'live' || (await wb.whenLive());
    const modeling = wb.modeling;
    if (!modeling || !live) return wb.toast('The geometry kernel is still loading.', 'info');
    const r = await modeling.exportPart(part.id, request.target, request.options);
    if (!r.ok) return wb.toast(r.error.message, 'error');
    const ext = request.target === 'step' ? 'step' : request.target;
    await lib.saveFile(r.bytes, `${base}.${ext}`, lib.MIME[request.target]);
    wb.exports.set((n) => n + 1);
  } finally {
    wb.patchUi({ exporting: false });
  }
}
