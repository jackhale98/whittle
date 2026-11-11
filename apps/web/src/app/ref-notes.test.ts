import type { FeatureStatus } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { refAcks } from './ref-notes';

const status = (now: number): FeatureStatus => ({
  featureId: 'f1',
  state: 'ok',
  cached: false,
  ms: 1,
  grown: [{ path: '/edges/0', name: 'e', was: 8, now }],
  merged: [{ path: '/edges/1', name: 'm', into: 'x' }],
});

describe('accepted reference notes', () => {
  it('Accept hides a note until what it reports changes again', () => {
    const [s] = refAcks.apply('doc1', [status(48)]) ?? [];
    expect(s?.grown).toHaveLength(1);
    refAcks.accept('doc1', 'f1', 'grown', { path: '/edges/0', name: 'e', was: 8, now: 48 });
    const [a] = refAcks.apply('doc1', [status(48)]) ?? [];
    expect(a?.grown).toBeUndefined();
    expect(a?.merged).toHaveLength(1); // the other note is still there
    // The edge grew again: the note comes back.
    const [b] = refAcks.apply('doc1', [status(60)]) ?? [];
    expect(b?.grown).toHaveLength(1);
    // Another document is unaffected.
    const [c] = refAcks.apply('doc2', [status(48)]) ?? [];
    expect(c?.grown).toHaveLength(1);
  });

  it('a stub adds notes like a reported status and can be removed', () => {
    refAcks.stub('f9', { merged: [{ path: '/faces/0', name: 'n', into: 'k' }] });
    const [s] =
      refAcks.apply('doc3', [{ featureId: 'f9', state: 'ok', cached: false, ms: 1 }]) ?? [];
    expect(s?.merged).toHaveLength(1);
    refAcks.stub('f9', null);
    const [t] =
      refAcks.apply('doc3', [{ featureId: 'f9', state: 'ok', cached: false, ms: 1 }]) ?? [];
    expect(t?.merged).toBeUndefined();
  });
});
