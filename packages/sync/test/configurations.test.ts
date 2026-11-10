// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M3.7 (ADR-074, research report List 1 item 9): part configurations in the structural merge,
 * its notes and conflict labels, and the version compare. Every override is a cell keyed by
 * configuration id and target id; edits to different cells merge, the same cell edited on both
 * sides conflicts.
 */

import type { MergeResult, WrenDoc } from '@wren-cad/contracts';
import { canonicalJson } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import {
  type ConfigurationNote,
  conflictField,
  conflictSummary,
  conflictValueText,
  docDiffer,
  docMerger,
  mergeNotes,
} from '../src';
import {
  addConfig,
  BRASS,
  configOf,
  configsOf,
  configured,
  danglingOverrides,
  editPart,
  LONG,
  P_SPARE,
  partOf,
  removeConfig,
  removeFeature,
  removeParam,
  rename,
  SHORT,
  STEEL,
  setActive,
  setField,
  setMaterial,
  setParam,
  setSuppressed,
} from './support/configurations';
import {
  apply,
  baseDoc,
  CHAMFER,
  FILLET,
  fillet,
  id,
  P_DEPTH,
  P_WIDTH,
  PART,
  PIN,
  problems,
} from './support/fixtures';

const WIDE_O = id(90);
const WIDE_T = id(91);
const ptr = (...segs: string[]) => `/parts/${PART}/configurations/${segs.join('/')}`;
const notes = (r: MergeResult) => mergeNotes(r).map((n) => n.summary);
const configNotes = (r: MergeResult) =>
  mergeNotes(r).filter((n): n is ConfigurationNote => n.kind !== 'folderMembership');
const valid = (r: MergeResult | WrenDoc) => {
  const doc = 'doc' in r ? r.doc : r;
  expect(problems(doc)).toEqual([]);
  expect(danglingOverrides(doc)).toEqual([]);
};
const both = (base: WrenDoc, o: WrenDoc, t: WrenDoc) => [
  docMerger.merge(base, o, t),
  docMerger.merge(base, t, o),
];
const summaries = (before: WrenDoc, after: WrenDoc) =>
  docDiffer.diff(before, after).map((c) => c.summary);
/** The base with only Bracket (the compare names the part only in multi-part documents). */
const single = (doc: WrenDoc): WrenDoc => ({
  ...doc,
  parts: doc.parts.filter((p) => p.id !== PIN),
});

describe('DocMerger: configurations, clean merges', () => {
  it('edits to different cells in different configurations merge without conflict (PLAN M3.7)', () => {
    const base = configured(baseDoc());
    const ours = setParam(base, LONG, P_WIDTH, '45mm');
    const theirs = setField(
      setParam(base, SHORT, P_DEPTH, '30mm'),
      SHORT,
      FILLET,
      '/radius',
      '1mm',
    );
    for (const r of both(base, ours, theirs)) {
      expect(r.conflicts).toEqual([]);
      expect(configOf(r.doc, LONG)?.params).toEqual({ [P_WIDTH]: '45mm' });
      expect(configOf(r.doc, SHORT)).toEqual({
        id: SHORT,
        name: 'Short',
        params: { [P_DEPTH]: '30mm' },
        features: { [FILLET]: { suppressed: true, fields: { '/radius': '1mm' } } },
      });
      expect(notes(r)).toEqual([]);
      valid(r);
    }
    expect(docMerger.merge(base, ours, theirs).autoMerged).toBeGreaterThan(0);
  });

  it('different cells of one configuration merge, including cells new on both sides', () => {
    const base = configured(baseDoc());
    // Ours: Long's width and Fillet 3 suppressed; theirs: Long's material and Fillet 3's radius.
    const ours = setSuppressed(setParam(base, LONG, P_WIDTH, '45mm'), LONG, FILLET, true);
    const theirs = setField(setMaterial(base, LONG, STEEL), LONG, FILLET, '/radius', '3mm');
    for (const r of both(base, ours, theirs)) {
      expect(r.conflicts).toEqual([]);
      expect(configOf(r.doc, LONG)).toEqual({
        id: LONG,
        name: 'Long',
        params: { [P_WIDTH]: '45mm' },
        features: { [FILLET]: { suppressed: true, fields: { '/radius': '3mm' } } },
        material: STEEL,
      });
      valid(r);
    }
  });

  it('a rename on one side merges with a cell edit on the other (List 1 item 9)', () => {
    const base = configured(baseDoc());
    const ours = rename(base, LONG, 'Long arm');
    const theirs = setParam(base, LONG, P_WIDTH, '45mm');
    for (const r of both(base, ours, theirs)) {
      expect(r.conflicts).toEqual([]);
      expect(configOf(r.doc, LONG)).toEqual({
        id: LONG,
        name: 'Long arm',
        params: { [P_WIDTH]: '45mm' },
      });
      valid(r);
    }
  });

  it('a reset on one side merges with a different cell edit on the other', () => {
    const base = configured(baseDoc());
    const ours = setParam(base, LONG, P_WIDTH, undefined); // Long's last param override goes
    const theirs = setParam(base, LONG, P_DEPTH, '25mm');
    expect(configOf(ours, LONG)?.params).toBeUndefined();
    for (const r of both(base, ours, theirs)) {
      expect(r.conflicts).toEqual([]);
      expect(configOf(r.doc, LONG)?.params).toEqual({ [P_DEPTH]: '25mm' });
      valid(r);
    }
  });

  it('a record emptied by the merge is dropped (overrides stay sparse)', () => {
    const base = setParam(configured(baseDoc()), LONG, P_DEPTH, '25mm');
    const ours = setParam(base, LONG, P_WIDTH, undefined);
    const theirs = setParam(base, LONG, P_DEPTH, undefined);
    for (const r of both(base, ours, theirs)) {
      expect(r.conflicts).toEqual([]);
      expect(configOf(r.doc, LONG)).toEqual({ id: LONG, name: 'Long' });
    }
  });

  it('configurations added on both sides are both kept; deleting an untouched one is clean', () => {
    const base = configured(baseDoc());
    const ours = removeConfig(addConfig(base, { id: WIDE_O, name: 'Wide' }), SHORT);
    const theirs = addConfig(base, { id: WIDE_T, name: 'Narrow', params: { [P_WIDTH]: '30mm' } });
    for (const r of both(base, ours, theirs)) {
      expect(r.conflicts).toEqual([]);
      expect(configsOf(r.doc).map((c) => c.name)).toEqual(['Long', 'Wide', 'Narrow']);
      expect(notes(r)).toEqual([]);
      valid(r);
    }
  });

  it('Part.properties and a configuration’s properties merge field by field', () => {
    const base = configured(baseDoc());
    const ours = editPart(base, (p) => {
      p.properties = { partNumber: 'BR-100' };
      (p.configurations?.[0] ?? { properties: {} }).properties = { partNumber: 'BR-100-L' };
    });
    const theirs = editPart(base, (p) => {
      p.properties = { description: 'Mounting bracket' };
      (p.configurations?.[0] ?? { properties: {} }).properties = { description: 'Long arm' };
    });
    for (const r of both(base, ours, theirs)) {
      expect(r.conflicts).toEqual([]);
      expect(partOf(r.doc).properties).toEqual({
        partNumber: 'BR-100',
        description: 'Mounting bracket',
      });
      expect(configOf(r.doc, LONG)?.properties).toEqual({
        partNumber: 'BR-100-L',
        description: 'Long arm',
      });
      valid(r);
    }
  });

  it('identities: merge(b, x, x) = x, merge(b, b, x) = merge(b, x, b) = x', () => {
    const base = configured(baseDoc());
    const x = setActive(rename(setMaterial(base, SHORT, null), LONG, 'L'), SHORT);
    for (const r of [
      docMerger.merge(base, x, x),
      docMerger.merge(base, base, x),
      docMerger.merge(base, x, base),
    ]) {
      expect(canonicalJson(r.doc)).toBe(canonicalJson(x));
      expect(r.conflicts).toEqual([]);
    }
  });
});

describe('DocMerger: configuration conflicts', () => {
  it('the same cell edited on both sides conflicts and names the configuration (PLAN M3.7)', () => {
    const base = configured(baseDoc());
    const ours = setParam(base, LONG, P_WIDTH, '45mm');
    const theirs = setParam(base, LONG, P_WIDTH, '55mm');
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0];
    expect(c).toMatchObject({
      kind: 'bothModified',
      path: ptr(LONG, 'params', P_WIDTH),
      subject: { kind: 'param', id: P_WIDTH, partId: PART, label: 'Long: width' },
      base: '50mm',
      ours: '45mm',
      theirs: '55mm',
    });
    if (!c) return;
    expect(conflictSummary(c)).toBe('Long: width 45 mm vs 55 mm');
    expect(conflictField(c)).toBe('');
    expect(conflictValueText(c.base, c)).toBe('50 mm');
    // The merged document holds ours until resolved.
    expect(configOf(r.doc, LONG)?.params).toEqual({ [P_WIDTH]: '45mm' });

    const width = (d: WrenDoc) => configOf(d, LONG)?.params?.[P_WIDTH];
    for (const result of [r, structuredClone(r)]) {
      const take = (t: 'ours' | 'theirs' | 'base') =>
        docMerger.resolve(result, [{ conflictId: c.id, take: t }]);
      expect(width(take('ours'))).toBe('45mm');
      expect(width(take('theirs'))).toBe('55mm');
      expect(width(take('base'))).toBe('50mm');
      expect(width(docMerger.resolve(result, [{ conflictId: c.id, value: '60mm' }]))).toBe('60mm');
      valid(take('theirs'));
    }
  });

  it('a cell both sides newly set is bothModified, against the inherited Default', () => {
    const base = configured(baseDoc());
    const ours = setSuppressed(base, LONG, FILLET, true);
    const theirs = setSuppressed(base, LONG, FILLET, false);
    const [r, s] = both(base, ours, theirs);
    expect(r?.conflicts).toHaveLength(1);
    const c = r?.conflicts[0];
    expect(c).toMatchObject({
      kind: 'bothModified',
      path: ptr(LONG, 'features', FILLET, 'suppressed'),
      subject: {
        kind: 'feature',
        id: FILLET,
        partId: PART,
        featureType: 'fillet',
        label: 'Long: Fillet 3 suppression',
      },
    });
    expect(c && conflictSummary(c)).toBe('Long: Fillet 3 suppression on vs off');
    expect(c && conflictValueText(undefined, c)).toBe('default (off)');
    expect(s?.conflicts.map((x) => x.id)).toEqual(r?.conflicts.map((x) => x.id));
    if (!r || !c) return;
    for (const take of ['ours', 'theirs'] as const) {
      const doc = docMerger.resolve(r, [{ conflictId: c.id, take }]);
      expect(configOf(doc, LONG)?.features?.[FILLET]?.suppressed).toBe(take === 'ours');
    }
  });

  it('setting a cell against resetting it on the other side is a conflict', () => {
    const base = configured(baseDoc());
    const set = setParam(base, LONG, P_WIDTH, '45mm');
    const reset = setParam(base, LONG, P_WIDTH, undefined);
    const r = docMerger.merge(base, set, reset);
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0];
    expect(c).toMatchObject({ kind: 'modifiedDeleted', path: ptr(LONG, 'params', P_WIDTH) });
    if (!c) return;
    expect(conflictSummary(c)).toBe('Long: width 45 mm vs default (40 mm)');
    for (const result of [r, structuredClone(r)]) {
      const theirs = docMerger.resolve(result, [{ conflictId: c.id, take: 'theirs' }]);
      expect(configOf(theirs, LONG)).toEqual({ id: LONG, name: 'Long' }); // no empty `params`
      const ours = docMerger.resolve(result, [{ conflictId: c.id, take: 'ours' }]);
      expect(configOf(ours, LONG)?.params).toEqual({ [P_WIDTH]: '45mm' });
    }
    // Reset as ours: taking theirs (by path too) brings the record back.
    const s = docMerger.merge(base, reset, set);
    const sc = s.conflicts[0];
    expect(sc && conflictSummary(sc)).toBe('Long: width default (40 mm) vs 45 mm');
    for (const result of [s, structuredClone(s)]) {
      const doc = docMerger.resolve(result, [{ conflictId: sc?.id ?? '', take: 'theirs' }]);
      expect(configOf(doc, LONG)?.params).toEqual({ [P_WIDTH]: '45mm' });
      valid(doc);
    }
  });

  it('material, colour, field and property cells conflict with readable values', () => {
    const base = configured(baseDoc());
    const ours = editPart(
      setField(setMaterial(base, LONG, STEEL), LONG, CHAMFER, '/mode/distance', '2mm'),
      (p) => {
        const c = p.configurations?.[0];
        if (c) {
          c.color = '#ff0000';
          c.properties = { partNumber: 'BR-L1' };
        }
      },
    );
    const theirs = editPart(
      setField(setMaterial(base, LONG, BRASS), LONG, CHAMFER, '/mode/distance', '3mm'),
      (p) => {
        const c = p.configurations?.[0];
        if (c) {
          c.color = '#00ff00';
          c.properties = { partNumber: 'BR-L2' };
        }
      },
    );
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts.map((c) => [c.kind, c.subject.label, conflictSummary(c)])).toEqual([
      ['bothModified', 'Long: colour', 'Long: colour #ff0000 vs #00ff00'],
      ['bothModified', 'Long: Chamfer 4 distance', 'Long: Chamfer 4 distance 2 mm vs 3 mm'],
      ['bothModified', 'Long: material', 'Long: material Steel vs Brass'],
      ['bothModified', 'Long: part number', 'Long: part number BR-L1 vs BR-L2'],
    ]);
    const all = docMerger.resolve(
      r,
      r.conflicts.map((c) => ({ conflictId: c.id, take: 'theirs' as const })),
    );
    expect(configOf(all, LONG)?.material).toEqual(BRASS);
    valid(all);
  });

  it('a configuration deleted on one side and edited on the other is modifiedDeleted (List 1 item 9)', () => {
    const base = configured(baseDoc());
    const ours = removeConfig(base, LONG);
    const theirs = setParam(base, LONG, P_WIDTH, '45mm');
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0];
    expect(c).toMatchObject({
      kind: 'modifiedDeleted',
      path: ptr(LONG),
      subject: { kind: 'part', id: PART, label: 'Configuration Long' },
    });
    if (!c) return;
    expect(conflictSummary(c)).toBe('Configuration Long: deleted vs Long (1 override)');
    expect(configOf(r.doc, LONG)).toBeUndefined();
    for (const result of [r, structuredClone(r)]) {
      const doc = docMerger.resolve(result, [{ conflictId: c.id, take: 'theirs' }]);
      expect(configOf(doc, LONG)?.params).toEqual({ [P_WIDTH]: '45mm' });
      // Re-run: back in its place. By path (no merge inputs): appended, like any restored item.
      const order = result === r ? [LONG, SHORT] : [SHORT, LONG];
      expect(configsOf(doc).map((x) => x.id)).toEqual(order);
      valid(doc);
    }
    // A rename against a delete conflicts the same way.
    const renamed = docMerger.merge(base, ours, rename(base, LONG, 'Long arm'));
    expect(renamed.conflicts.map((x) => [x.kind, x.path])).toEqual([
      ['modifiedDeleted', ptr(LONG)],
    ]);
  });

  it('a configuration’s name both sides changed conflicts as its name', () => {
    const base = configured(baseDoc());
    const r = docMerger.merge(base, rename(base, LONG, 'Long arm'), rename(base, LONG, 'Extended'));
    const c = r.conflicts[0];
    expect(r.conflicts).toHaveLength(1);
    expect(c).toMatchObject({ kind: 'bothModified', path: ptr(LONG, 'name') });
    expect(c && conflictField(c)).toBe('name');
    expect(c && conflictSummary(c)).toBe('Configuration Long arm name: Long arm vs Extended');
  });

  it('activeConfigurationId merges as a plain field: two choices conflict', () => {
    const base = configured(baseDoc());
    const r = docMerger.merge(base, setActive(base, LONG), setActive(base, SHORT));
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0];
    expect(c).toMatchObject({
      kind: 'bothModified',
      path: `/parts/${PART}/activeConfigurationId`,
      subject: { kind: 'part', id: PART, label: 'Active configuration' },
    });
    expect(c && conflictSummary(c)).toBe('Active configuration: Long vs Short');
    // Default (absent) is a choice like any other, not a deletion.
    const d = docMerger.merge(setActive(base, LONG), setActive(base, SHORT), base);
    expect(d.conflicts.map((x) => [x.kind, conflictSummary(x)])).toEqual([
      ['bothModified', 'Active configuration: Short vs Default'],
    ]);
    const dc = d.conflicts[0];
    for (const result of [d, structuredClone(d)]) {
      const doc = docMerger.resolve(result, [{ conflictId: dc?.id ?? '', take: 'theirs' }]);
      expect(partOf(doc).activeConfigurationId).toBeUndefined();
    }
    // One side switching merges cleanly.
    const one = docMerger.merge(base, setActive(base, SHORT), setParam(base, LONG, P_WIDTH, '1mm'));
    expect(one.conflicts).toEqual([]);
    expect(partOf(one.doc).activeConfigurationId).toBe(SHORT);
  });

  it('the Default’s part number both sides set conflicts by field', () => {
    const base = configured(baseDoc());
    const pn = (v: string) =>
      editPart(base, (p) => {
        p.properties = { partNumber: v };
      });
    const r = docMerger.merge(base, pn('BR-1'), pn('BR-2'));
    expect(r.conflicts.map((c) => [c.kind, c.subject.label, conflictSummary(c)])).toEqual([
      ['bothModified', 'Bracket part number', 'Bracket part number: BR-1 vs BR-2'],
    ]);
  });
});

describe('DocMerger: configuration notes', () => {
  it('two sides adding the same name keep both ids and flag the duplicate (List 1 item 9)', () => {
    const base = configured(baseDoc());
    const ours = addConfig(base, { id: WIDE_O, name: 'Wide', params: { [P_WIDTH]: '60mm' } });
    const theirs = addConfig(base, { id: WIDE_T, name: 'Wide', params: { [P_WIDTH]: '70mm' } });
    const [r, s] = both(base, ours, theirs);
    if (!r || !s) return;
    expect(r.conflicts).toEqual([]);
    expect(configsOf(r.doc).map((c) => [c.id, c.name])).toEqual([
      [LONG, 'Long'],
      [SHORT, 'Short'],
      [WIDE_O, 'Wide'],
      [WIDE_T, 'Wide'],
    ]);
    expect(canonicalJson(r.doc)).toBe(canonicalJson(s.doc));
    expect(configNotes(r)).toEqual([
      {
        kind: 'configurationDuplicateName',
        partId: PART,
        configurationIds: [WIDE_O, WIDE_T],
        subject: { kind: 'part', id: PART, label: 'Configuration Wide' },
        summary:
          'Both sides added a configuration named Wide to Bracket; both are kept. Rename one to tell them apart',
      },
    ]);
    expect(notes(s)).toEqual(notes(r));
    valid(r);
  });

  it('a rename that collides with a name the other side added is flagged too', () => {
    const base = configured(baseDoc());
    const r = docMerger.merge(
      base,
      rename(base, SHORT, 'Mid'),
      addConfig(base, { id: WIDE_T, name: 'Mid' }),
    );
    expect(r.conflicts).toEqual([]);
    expect(notes(r)).toEqual([
      '2 configurations of Bracket are named Mid after the merge; both are kept. Rename one to tell them apart',
    ]);
  });

  it('an active configuration that no longer exists falls back to Default, with a note', () => {
    const base = configured(baseDoc());
    const ours = removeConfig(base, SHORT);
    const theirs = setActive(base, SHORT);
    for (const r of both(base, ours, theirs)) {
      expect(r.conflicts).toEqual([]);
      expect(configOf(r.doc, SHORT)).toBeUndefined();
      expect(partOf(r.doc).activeConfigurationId).toBeUndefined();
      expect(configNotes(r)).toEqual([
        {
          kind: 'activeConfigurationFallback',
          partId: PART,
          configurationIds: [SHORT],
          subject: { kind: 'part', id: PART, label: 'Active configuration' },
          summary:
            'The active configuration Short of Bracket was deleted, so Bracket is on Default now',
        },
      ]);
      valid(r);
    }
  });

  it('a resolution that brings the active configuration back keeps it active', () => {
    const base = configured(baseDoc());
    const ours = removeConfig(base, SHORT);
    const theirs = setActive(setParam(base, SHORT, P_WIDTH, '35mm'), SHORT);
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts.map((c) => [c.kind, c.path])).toEqual([['modifiedDeleted', ptr(SHORT)]]);
    expect(partOf(r.doc).activeConfigurationId).toBeUndefined();
    expect(configNotes(r).map((n) => n.kind)).toEqual(['activeConfigurationFallback']);
    const c = r.conflicts[0];
    const doc = docMerger.resolve(r, [{ conflictId: c?.id ?? '', take: 'theirs' }]);
    expect(partOf(doc).activeConfigurationId).toBe(SHORT);
    // By path, the merged document already fell back; the restored configuration comes back.
    const byPath = docMerger.resolve(structuredClone(r), [
      { conflictId: c?.id ?? '', take: 'theirs' },
    ]);
    expect(configOf(byPath, SHORT)?.params).toEqual({ [P_WIDTH]: '35mm' });
    valid(byPath);
  });

  it('deleting a feature drops the overrides of it the other side made, with a note per group', () => {
    const base = configured(baseDoc());
    // Ours deletes Fillet 3 (and, like the command, Short's override of it).
    const ours = removeFeature(base, FILLET);
    expect(configOf(ours, SHORT)).toEqual({ id: SHORT, name: 'Short' });
    // Theirs overrides Fillet 3 in Long (two cells) and edits Short's override (one new cell).
    const theirs = setField(
      setField(setSuppressed(base, LONG, FILLET, true), LONG, FILLET, '/radius', '3mm'),
      SHORT,
      FILLET,
      '/radius',
      '1mm',
    );
    for (const r of both(base, ours, theirs)) {
      expect(r.conflicts).toEqual([]);
      expect(partOf(r.doc).features.some((f) => f.id === FILLET)).toBe(false);
      expect(configOf(r.doc, LONG)).toEqual({
        id: LONG,
        name: 'Long',
        params: { [P_WIDTH]: '50mm' },
      });
      expect(configOf(r.doc, SHORT)).toEqual({ id: SHORT, name: 'Short' });
      expect(
        configNotes(r).map((n) => [n.kind, n.configurationIds, n.targetId, n.summary]),
      ).toEqual([
        [
          'configurationOverridesRemoved',
          [LONG],
          FILLET,
          'Overrides of Fillet 3 in Long were removed with the feature',
        ],
        [
          'configurationOverridesRemoved',
          [SHORT],
          FILLET,
          'The override of Fillet 3 in Short was removed with the feature',
        ],
      ]);
      expect(configNotes(r)[0]?.removed?.map((x) => x.rel)).toEqual([
        ['features', FILLET, 'suppressed'],
        ['features', FILLET, 'fields', '/radius'],
      ]);
      valid(r);
    }
  });

  it('deleting a parameter drops its overrides, with a note', () => {
    const base = setParam(configured(baseDoc()), SHORT, P_SPARE, '8mm');
    const ours = removeParam(base, P_SPARE);
    const theirs = setParam(base, LONG, P_SPARE, '6mm');
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(configOf(r.doc, LONG)?.params).toEqual({ [P_WIDTH]: '50mm' });
    expect(configOf(r.doc, SHORT)?.params).toBeUndefined();
    expect(notes(r)).toEqual(['The override of spare in Long was removed with the parameter']);
    valid(r);
  });

  it('a feature deleted against edited conflicts; taking the edit keeps its overrides', () => {
    const base = configured(baseDoc());
    const ours = removeFeature(base, FILLET);
    const theirs = setSuppressed(
      apply(base, {
        kind: 'updateFeature',
        partId: PART,
        featureId: FILLET,
        feature: fillet(FILLET, 'Fillet 3', '4mm'),
      }),
      LONG,
      FILLET,
      true,
    );
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts.map((c) => [c.kind, c.subject.label])).toEqual([
      ['modifiedDeleted', 'Fillet 3'],
    ]);
    expect(notes(r)).toEqual(['The override of Fillet 3 in Long was removed with the feature']);
    const c = r.conflicts[0];
    const doc = docMerger.resolve(r, [{ conflictId: c?.id ?? '', take: 'theirs' }]);
    expect(configOf(doc, LONG)?.features).toEqual({ [FILLET]: { suppressed: true } });
    expect(configOf(doc, SHORT)?.features).toBeUndefined(); // ours' own prune stands
    valid(doc);
  });

  it('a side’s own dangling override is its state, not the merge’s to drop', () => {
    const base = configured(baseDoc());
    // Deleted without pruning (an older writer; today's removeFeature prunes): Short keeps a
    // "needs attention" override. Built by hand so the merge, not the command, is under test.
    const ours = structuredClone(base);
    const part = ours.parts.find((p) => p.id === PART);
    if (part) part.features = part.features.filter((f) => f.id !== FILLET);
    expect(configOf(ours, SHORT)?.features?.[FILLET]).toEqual({ suppressed: true });
    for (const r of [docMerger.merge(base, ours, base), docMerger.merge(base, ours, ours)]) {
      expect(canonicalJson(r.doc)).toBe(canonicalJson(ours));
      expect(notes(r)).toEqual([]);
    }
  });
});

describe('DocDiffer: configurations', () => {
  it('reads configuration changes in plain language', () => {
    const before = configured(baseDoc());
    let after = rename(before, LONG, 'Long arm');
    after = setParam(after, LONG, P_WIDTH, '45mm'); // 50 → 45
    after = setParam(after, LONG, P_DEPTH, '30mm'); // inherited 20 → 30
    after = setSuppressed(after, LONG, FILLET, true);
    after = setField(after, LONG, FILLET, '/radius', '3mm');
    after = setMaterial(after, LONG, STEEL);
    after = setSuppressed(after, SHORT, FILLET, undefined);
    after = addConfig(after, { id: WIDE_O, name: 'Wide' });
    expect(summaries(before, after)).toEqual([
      'Renamed configuration Long → Long arm',
      'Long arm: width 50 mm → 45 mm',
      'Long arm: depth 20 mm → 30 mm',
      'Long arm: Fillet 3 suppressed',
      'Long arm: Fillet 3 radius 2 mm → 3 mm',
      'Long arm: material Aluminium 6061-T6 → Steel',
      'Short: Fillet 3 suppression reset to default (not suppressed)',
      'Added configuration Wide',
    ]);
    const cells = docDiffer.diff(before, after).filter((c) => c.kind === 'modified');
    expect(cells[0]).toMatchObject({
      subject: { kind: 'param', id: P_WIDTH, partId: PART, label: 'Long arm: width' },
      fields: [{ path: `/params/${P_WIDTH}`, label: 'width', before: '50mm', after: '45mm' }],
    });
    expect(cells[2]?.subject).toMatchObject({ kind: 'feature', id: FILLET, featureType: 'fillet' });
  });

  it('removed and moved configurations, resets, the active configuration and part properties', () => {
    const before = single(setMaterial(configured(baseDoc()), SHORT, BRASS));
    let after = setParam(before, LONG, P_WIDTH, undefined);
    after = setMaterial(after, SHORT, null);
    after = editPart(after, (p) => {
      p.configurations = [...(p.configurations ?? [])].reverse();
      p.properties = { partNumber: 'BR-100' };
      p.activeConfigurationId = LONG;
    });
    expect(summaries(before, after)).toEqual([
      'Bracket: part number set to BR-100',
      'Short: material Brass → no material',
      'Moved configuration Short to the top',
      'Long: width reset to default (40 mm)',
      'Active configuration: Default → Long',
    ]);
    expect(summaries(after, removeConfig(after, SHORT))).toEqual(['Removed configuration Short']);
    // Removing the active one makes Default active.
    expect(summaries(after, removeConfig(after, LONG))).toEqual([
      'Removed configuration Long',
      'Active configuration: Long → Default',
    ]);
  });

  it('names the part in a multi-part document’s active-configuration line', () => {
    const before = configured(baseDoc());
    expect(summaries(before, setActive(before, LONG))).toEqual([
      'Bracket: active configuration Default → Long',
    ]);
    expect(summaries(configured(baseDoc()), configured(baseDoc()))).toEqual([]);
    expect(summaries(baseDoc(), configured(baseDoc()))).toEqual([
      'Added parameter spare = 5 mm',
      'Added configuration Long',
      'Added configuration Short',
    ]);
  });
});
