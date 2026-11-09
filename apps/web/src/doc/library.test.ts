import { newDoc } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import { copyName, fromWrenBytes, sameProject, toWrenBytes } from './library';

describe('opening files without overwriting the library', () => {
  it('names a copy so it does not collide', () => {
    expect(copyName('Bracket', new Set())).toBe('Bracket');
    expect(copyName('Bracket', new Set(['Bracket']))).toBe('Bracket (copy)');
    expect(copyName('Bracket', new Set(['Bracket', 'Bracket (copy)']))).toBe('Bracket (copy 2)');
  });

  it('same project = same document files and extra files (cache ignored)', () => {
    const doc = { ...newDoc({ name: 'A', firstPart: 'P' }), meta: { ...newDoc().meta, id: 'X' } };
    const extra = new Map([['imports/a.step', new Uint8Array([1, 2, 3])]]);
    const a = fromWrenBytes(toWrenBytes(doc, extra, new Map([['m', new Uint8Array([9])]])));
    expect(a.extra.get('imports/a.step')).toEqual(new Uint8Array([1, 2, 3]));
    expect(a.cache.get('m')).toEqual(new Uint8Array([9]));
    expect(sameProject(a, { doc, extra })).toBe(true);
    // Edited later (modified bumps), or different attachments: different.
    const edited = { ...doc, meta: { ...doc.meta, modified: '2030-01-01T00:00:00.000Z' } };
    expect(sameProject(a, { doc: edited, extra })).toBe(false);
    expect(sameProject(a, { doc, extra: new Map() })).toBe(false);
    expect(
      sameProject(a, { doc, extra: new Map([['imports/a.step', new Uint8Array([1, 2, 4])]]) }),
    ).toBe(false);
  });
});
