/** Pins user-facing wording that a mechanical rename once corrupted ("this" became "wb"). */
import { readFileSync } from 'node:fs';
import { newDoc } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import type { ProjectBundle } from '../doc/library';
import { openProject } from './files';
import type { Workbench } from './workbench';

describe('user-facing strings', () => {
  it('open-as-copy note says "this document"', async () => {
    const base = newDoc('Bracket');
    const doc = { ...base, meta: { ...base.meta, id: 'doc-1' } };
    const toasts: string[] = [];
    const lib = {
      find: async () =>
        ({ doc: { ...doc, meta: { ...doc.meta, name: 'Older' } }, extra: new Map() }) as unknown,
      list: async () => [{ name: 'Bracket' }],
    };
    const wb = {
      flushSave: async () => {},
      library: async () => lib,
      loadDocument: () => true,
      autosaver: { schedule: () => {} },
      doc,
      patchUi: () => {},
      toast: (m: string) => toasts.push(m),
    } as unknown as Workbench;
    await openProject(wb, { doc, extra: new Map() } as unknown as ProjectBundle);
    expect(toasts.join()).toContain('a different version of this document');
  });

  it('prose carries no stray "wb"/"vp" words', () => {
    const src = readFileSync(new URL('./pointer.ts', import.meta.url), 'utf8');
    expect(src).toContain('Only features before this one can be copied.');
    for (const f of ['pointer.ts', 'files.ts', 'regen-view.ts']) {
      const text = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
      expect(text).not.toMatch(/(\/\/|\*|['`"]).*\b(wb|vp) (save|document|one|very|a|the)\b/);
    }
  });
});
