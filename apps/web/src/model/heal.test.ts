import type { FilletFeature, Part } from '@whittle/contracts';
import { compileCommand, createDocumentStore, newDoc } from '@whittle/document';
import { describe, expect, it } from 'vitest';
import { foldHeals, healFeature, healOps, healsFrom } from './heal';

const fillet = (id: string, names: string[]): FilletFeature => ({
  id,
  type: 'fillet',
  name: id,
  suppressed: false,
  edges: names.map((name) => ({ name, kind: 'edge', fingerprint: { centroid: [0, 0, 0] } })),
  radius: '1 mm',
});

const part: Part = {
  id: 'P',
  name: 'P',
  rollbackIndex: 2,
  features: [fillet('A', ['old0', 'keep']), fillet('B', ['x'])],
};

describe('reference healing', () => {
  const heals = healsFrom([
    {
      featureId: 'A',
      state: 'ok',
      cached: false,
      ms: 1,
      rebound: [
        { path: '/edges/0', name: 'new0', fingerprint: { centroid: [1, 2, 3], length: 4 } },
      ],
    },
    { featureId: 'B', state: 'ok', cached: false, ms: 1 },
  ]);

  it('collects rebound names per feature', () => {
    expect([...heals.keys()]).toEqual(['A']);
  });

  it('heals a feature copy, keeping fingerprints and untouched refs', () => {
    const f = part.features[0] as FilletFeature;
    const h = healFeature(f, heals.get('A') ?? []);
    expect(h.edges.map((e) => e.name)).toEqual(['new0', 'keep']);
    expect(h.edges[0]?.fingerprint).toEqual({ centroid: [1, 2, 3], length: 4 });
    expect(h.edges[1]?.fingerprint).toEqual({ centroid: [0, 0, 0] });
    expect(f.edges[0]?.name).toBe('old0');
    expect(healFeature(h, heals.get('A') ?? [])).toBe(h); // already current
  });

  it('emits replace ops for other features', () => {
    expect(healOps(part, 0, heals)).toEqual([
      { op: 'replace', path: '/parts/0/features/0/edges/0/name', value: 'new0' },
      {
        op: 'add',
        path: '/parts/0/features/0/edges/0/fingerprint',
        value: { centroid: [1, 2, 3], length: 4 },
      },
    ]);
    expect(healOps(part, 0, heals, 'A')).toEqual([]);
  });

  it('folds heals into the next user command: one undo step with the user edit', () => {
    const doc = { ...newDoc({ name: 'd' }), parts: [part] };
    const store = createDocumentStore(doc);
    const edit = foldHeals({ kind: 'setDocName', name: 'renamed' }, part, heals, (c) =>
      compileCommand(store.getDoc(), c),
    );
    expect(edit.command.kind).toBe('patch');
    expect(store.apply(edit.command, { label: edit.label ?? '' }).ok).toBe(true);
    const healed = store.getDoc().parts[0]?.features[0] as FilletFeature;
    expect(healed.edges[0]?.name).toBe('new0');
    expect(healed.edges[0]?.fingerprint?.centroid).toEqual([1, 2, 3]);
    expect(store.getDoc().meta.name).toBe('renamed');
    expect(store.history().past).toHaveLength(1);
    store.undo();
    const undone = store.getDoc().parts[0]?.features[0] as FilletFeature;
    expect(undone.edges[0]?.name).toBe('old0');

    // Editing the healed feature itself heals its payload instead.
    const upd = foldHeals(
      {
        kind: 'updateFeature',
        partId: 'P',
        featureId: 'A',
        feature: part.features[0] as FilletFeature,
      },
      part,
      heals,
      (c) => compileCommand(store.getDoc(), c),
    );
    expect(upd.command.kind).toBe('updateFeature');
    if (upd.command.kind === 'updateFeature')
      expect((upd.command.feature as FilletFeature).edges[0]?.name).toBe('new0');
  });
});
