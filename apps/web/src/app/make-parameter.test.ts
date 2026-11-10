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
});

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
