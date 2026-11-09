import type { Feature, WrenDoc } from '@wren-cad/contracts';
import { createDocumentStore, newDoc } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import {
  orphanedAttachments,
  pruneAttachments,
  referencedAttachments,
  savedExtra,
} from './attachments';

const imp = (id: string): Feature => ({
  id,
  name: id,
  type: 'import',
  suppressed: false,
  op: 'new',
  source: { path: `imports/${id}.step`, format: 'step', sha256: 'ab', fileName: `${id}.step` },
});

function doc(features: Feature[]): WrenDoc {
  const d = newDoc({ name: 'T', firstPart: 'P' });
  const part = d.parts[0];
  if (!part) throw new Error('no part');
  return { ...d, parts: [{ ...part, features, rollbackIndex: features.length }] };
}

const bytes = new Uint8Array([1]);

describe('import attachments', () => {
  it('saves only the attachments the document references, and every other extra file', () => {
    const extra = new Map([
      ['imports/A.step', bytes],
      ['imports/B.step', bytes],
      ['releases/rev-A/notes.txt', bytes],
    ]);
    const d = doc([imp('A')]);
    expect([...referencedAttachments(d)]).toEqual(['imports/A.step']);
    expect(orphanedAttachments(extra, d)).toEqual(['imports/B.step']);
    expect([...savedExtra(extra, d).keys()]).toEqual([
      'imports/A.step',
      'releases/rev-A/notes.txt',
    ]);
    const all = doc([imp('A'), imp('B')]);
    expect(savedExtra(extra, all)).toBe(extra); // nothing to drop: the same map
  });

  it('keeps a deleted import’s bytes in memory while undo can bring it back', () => {
    const start = doc([]);
    const store = createDocumentStore(start, { maxHistory: 2 });
    const partId = start.parts[0]?.id ?? '';
    const extra = new Map([['imports/A.step', bytes]]);
    store.apply({ kind: 'addFeature', partId, feature: imp('A') });
    store.commit();
    store.apply({ kind: 'removeFeature', partId, featureId: 'A' });
    store.commit();
    const mentions = (p: readonly string[]) => store.historyMentions(p);
    expect(pruneAttachments(extra, store.getDoc(), mentions)).toEqual([]);
    expect(extra.has('imports/A.step')).toBe(true);
    // Undo restores the feature and its bytes are still there.
    store.undo();
    expect(referencedAttachments(store.getDoc()).has('imports/A.step')).toBe(true);
    store.redo();
    // Two more edits push the import out of the two-entry history: now it is pruned.
    for (const n of ['x', 'y']) {
      store.apply({ kind: 'setDocName', name: n });
      store.commit();
    }
    expect(pruneAttachments(extra, store.getDoc(), mentions)).toEqual(['imports/A.step']);
    expect(extra.size).toBe(0);
  });
});
