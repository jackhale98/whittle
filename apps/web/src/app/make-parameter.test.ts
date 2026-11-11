import type { ExtrudeFeature } from '@wren-cad/contracts';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workbench as WorkbenchClass } from './workbench';

let Workbench: typeof WorkbenchClass;
beforeAll(async () => {
  // The workbench reads a few browser facts when built; a bare window answers them.
  const win = {
    navigator: { hardwareConcurrency: 4, userAgent: 'node', maxTouchPoints: 0 },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    location: { search: '', href: 'http://localhost/' },
  };
  vi.stubGlobal('window', win);
  Workbench = (await import('./workbench')).Workbench;
}, 60_000); // a cold start imports the whole workbench

const extrude = (depth: string): ExtrudeFeature => ({
  id: 'X1',
  type: 'extrude',
  name: 'Extrude 1',
  suppressed: false,
  profile: [{ name: 'SS1:region(e1)', kind: 'region' }],
  direction: 'normal',
  end: { kind: 'blind', depth },
  op: 'new',
});

/** A workbench holding one extrude. Needs no browser: it never renders or starts the kernel. */
function bench() {
  const wb = new Workbench();
  const part = wb.part;
  if (!part) throw new Error('no part');
  wb.apply({ kind: 'addFeature', partId: part.id, feature: extrude('10 mm') });
  wb.commit();
  return { wb, partId: part.id };
}
const depth = (wb: WorkbenchClass) => {
  const f = wb.part?.features[0];
  return f?.type === 'extrude' && f.end.kind === 'blind' ? f.end.depth : undefined;
};

describe('Make parameter (ADR-080)', () => {
  it('creates the parameter and re-points the field in one undo step', () => {
    const { wb, partId } = bench();
    expect(wb.makeParameter('depth', '10 mm')).toBeUndefined();
    // The field now commits the name, as an inspector field does.
    wb.apply(
      { kind: 'updateFeature', partId, featureId: 'X1', feature: extrude('depth') },
      undefined,
      'edit:X1',
    );
    wb.commit(); // a field's own commit must not close the step early
    wb.endMakeParameter();

    expect(wb.doc.params.map((p) => [p.name, p.expr])).toEqual([['depth', '10 mm']]);
    expect(depth(wb)).toBe('depth');
    expect(wb.evaluate('depth', 'length')).toMatchObject({ ok: true, value: 10 });

    wb.undo();
    expect(wb.doc.params).toEqual([]);
    expect(depth(wb)).toBe('10 mm');
    wb.redo();
    expect(wb.doc.params).toHaveLength(1);
    expect(depth(wb)).toBe('depth');
  });

  it('the step is labelled by the action, and later edits are separate steps', () => {
    const { wb, partId } = bench();
    wb.makeParameter('depth', '10 mm');
    wb.apply({ kind: 'updateFeature', partId, featureId: 'X1', feature: extrude('depth') });
    wb.endMakeParameter();
    wb.apply({ kind: 'updateParam', paramId: wb.doc.params[0]?.id ?? '', expr: '12 mm' });
    wb.commit();
    wb.undo(); // only the parameter edit
    expect(wb.doc.params[0]?.expr).toBe('10 mm');
    expect(depth(wb)).toBe('depth');
    wb.undo();
    expect(wb.doc.params).toEqual([]);
  });

  it('refuses a bad or duplicate name without touching the document', () => {
    const { wb } = bench();
    expect(wb.makeParameter('2x', '1 mm')).toMatch(/not a valid/);
    expect(wb.makeParameter('sin', '1 mm')).toMatch(/reserved/);
    expect(wb.makeParameter('ok', '10 mm')).toBeUndefined();
    wb.endMakeParameter();
    expect(wb.makeParameter('ok', '5 mm')).toMatch(/already used/);
    expect(wb.doc.params).toHaveLength(1);
  });
});

describe('a parameter edit with a sketch open (ADR-080)', () => {
  /** A stand-in session: `refit` writes the moved geometry the way the real one does, queued. */
  function withSketch(wb: WorkbenchClass, partId: string, whenRefit: () => void) {
    let pending = 0;
    let queue: Promise<void> = Promise.resolve();
    wb.sketch = {
      get busy() {
        return pending > 0;
      },
      whenSettled: async () => {
        while (pending > 0) await queue;
      },
      refit: () => {
        pending++;
        queue = queue.then(async () => {
          await Promise.resolve();
          whenRefit();
          pending--;
        });
        return queue;
      },
    } as unknown as WorkbenchClass['sketch'];
    return partId;
  }

  it('the refit joins the parameter edit: one undo step, label kept', async () => {
    const { wb, partId } = bench();
    wb.apply({ kind: 'addParam', param: { id: 'P1', name: 'w', expr: '10 mm' } });
    wb.commit();
    const steps = () => wb.store.history().past.length;
    const before = steps();
    withSketch(wb, partId, () =>
      wb.apply({ kind: 'updateFeature', partId, featureId: 'X1', feature: extrude('99 mm') }),
    );
    wb.applyRefit({ kind: 'updateParam', paramId: 'P1', expr: '50 mm' });
    await new Promise((r) => setTimeout(r, 30));
    expect(wb.doc.params[0]?.expr).toBe('50 mm');
    expect(depth(wb)).toBe('99 mm'); // the refit landed
    expect(steps()).toBe(before + 1);
    expect(wb.store.history().past.at(-1)?.label).toMatch(/Edit w/);
    wb.sketch = null;
    wb.undo();
    expect(wb.doc.params[0]?.expr).toBe('10 mm');
    expect(depth(wb)).toBe('10 mm');
  });

  it('without a sketch it is a plain committed edit', () => {
    const { wb } = bench();
    wb.apply({ kind: 'addParam', param: { id: 'P1', name: 'w', expr: '10 mm' } });
    wb.commit();
    const before = wb.store.history().past.length;
    wb.applyRefit({ kind: 'updateParam', paramId: 'P1', expr: '20 mm' });
    expect(wb.store.history().past.length).toBe(before + 1);
    wb.applyRefit({ kind: 'updateParam', paramId: 'P1', expr: '30 mm' });
    expect(wb.store.history().past.length).toBe(before + 2);
  });
});

describe('Make parameter on a sketch dimension (the edit lands through the sketch queue)', () => {
  it('the dimension edit that lands after endMakeParameter still joins the one undo step', async () => {
    const { wb, partId } = bench();
    let pending = 0;
    let queue: Promise<void> = Promise.resolve();
    wb.sketch = {
      get busy() {
        return pending > 0;
      },
      whenSettled: async () => {
        while (pending > 0) await queue;
      },
    } as unknown as WorkbenchClass['sketch'];
    const before = wb.store.history().past.length;
    expect(wb.makeParameter('dia', '30 mm')).toBeUndefined();
    // The field commits the name: the session queues the solve, which writes later (as commitEdit).
    pending++;
    queue = queue.then(async () => {
      await new Promise((r) => setTimeout(r, 10));
      wb.apply({ kind: 'updateFeature', partId, featureId: 'X1', feature: extrude('dia') });
      wb.commit(); // commitEdit commits when it has no key: a no-op while the step is open
      pending--;
    });
    wb.endMakeParameter(); // the field's makeDone, before the solve has landed
    await new Promise((r) => setTimeout(r, 60));
    wb.sketch = null;
    expect(depth(wb)).toBe('dia');
    expect(wb.store.history().past.length).toBe(before + 1);
    wb.undo();
    expect(wb.doc.params).toEqual([]);
    expect(depth(wb)).toBe('10 mm');
  });

  it('refuses a unit as a name', () => {
    const { wb } = bench();
    expect(wb.makeParameter('mm', '1 mm')).toMatch(/unit/);
    expect(wb.makeParameter('in', '1 mm')).toMatch(/unit/);
    expect(wb.doc.params).toEqual([]);
  });
});

describe('two quick parameter edits with a slow solve (ADR-080)', () => {
  it('each edit keeps its own undo step with its own geometry', async () => {
    const { wb, partId } = bench();
    wb.apply({ kind: 'addParam', param: { id: 'P1', name: 'w', expr: '10 mm' } });
    wb.commit();
    // The refit writes geometry that records the parameter value it solved for, slowly.
    wb.sketch = {
      busy: false,
      whenSettled: async () => {},
      refitPending: false,
      refit: async () => {
        const seen = wb.doc.params[0]?.expr ?? '';
        await new Promise((r) => setTimeout(r, 40));
        wb.apply({
          kind: 'updateFeature',
          partId,
          featureId: 'X1',
          feature: extrude(`solved ${seen}`),
        });
      },
    } as unknown as WorkbenchClass['sketch'];
    const before = wb.store.history().past.length;
    wb.applyRefit({ kind: 'updateParam', paramId: 'P1', expr: '20 mm' });
    wb.applyRefit({ kind: 'updateParam', paramId: 'P1', expr: '30 mm' }); // while the first solves
    await new Promise((r) => setTimeout(r, 200));
    expect(wb.store.history().past.length).toBe(before + 2);
    expect(depth(wb)).toBe('solved 30 mm');
    wb.sketch = null;
    wb.undo();
    expect(wb.doc.params[0]?.expr).toBe('20 mm');
    expect(depth(wb)).toBe('solved 20 mm'); // value and geometry go back together
    wb.undo();
    expect(wb.doc.params[0]?.expr).toBe('10 mm');
    expect(depth(wb)).toBe('10 mm');
  });
});
