// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { id, sampleDoc } from './fixtures';

/** A fresh copy of the package, as the app has it before it loads the drawing chunk. */
async function freshPackage() {
  vi.resetModules();
  const core = await import('../src');
  const drawing = await import('../src/drawing');
  return { core, drawing };
}

describe('lazy drawing support (ADR-090 amendment)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is not registered until registerDrawingSupport() runs', async () => {
    const { core, drawing } = await freshPackage();
    expect(core.isDrawingSupportLoaded()).toBe(false);
    drawing.registerDrawingSupport();
    expect(core.isDrawingSupportLoaded()).toBe(true);
  });

  it('refuses annotation and drawing commands with a clear error, and changes nothing', async () => {
    const { core } = await freshPackage();
    const store = core.createDocumentStore(core.newDoc());
    const before = store.getDoc();
    const note = {
      id: id(1),
      kind: 'note' as const,
      origin: { kind: 'model' as const },
      refs: [],
      text: 'x',
    };
    for (const cmd of [
      { kind: 'addAnnotation' as const, partId: id(3), annotation: note },
      { kind: 'removeDrawing' as const, drawingId: id(5) },
      { kind: 'setDrawingDefaults' as const, defaults: sampleDoc().drawingDefaults as never },
    ]) {
      const r = store.apply(cmd);
      expect(r).toEqual({ ok: false, error: core.DRAWING_SUPPORT_MISSING });
    }
    expect(store.getDoc()).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it('refuses to open a document with annotations or drawings, but opens a plain one', async () => {
    const { core } = await freshPackage();
    const store = core.createDocumentStore();
    const plain = core.newDoc({ name: 'Plain' });
    expect(store.load(plain).ok).toBe(true);
    const full = store.load(sampleDoc());
    expect(full).toEqual({ ok: false, error: core.DRAWING_SUPPORT_MISSING });
    expect(store.getDoc().meta.name).toBe('Plain');
    expect(core.validateDoc(sampleDoc())).toContain(core.DRAWING_SUPPORT_MISSING);
  });

  it('works once registered: same load, same commands', async () => {
    const { core, drawing } = await freshPackage();
    drawing.registerDrawingSupport();
    const store = core.createDocumentStore();
    expect(store.load(sampleDoc()).ok).toBe(true);
    const r = store.apply({ kind: 'removeAnnotation', partId: id(3), annotationIds: [id(906)] });
    expect(r.ok).toBe(true);
    expect(core.validateDoc(store.getDoc())).toEqual([]);
  });

  it('the core entry does not export the drawing modules', async () => {
    const { core } = await freshPackage();
    for (const name of [
      'annotationIssues',
      'fitDeviations',
      'normalizeDrawings',
      'resolveViewFrame',
    ]) {
      expect(name in core).toBe(false);
    }
    expect('annotationExprFields' in core).toBe(true);
  });
});
