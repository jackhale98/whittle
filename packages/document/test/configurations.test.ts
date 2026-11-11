// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  Command,
  Configuration,
  ExtrudeFeature,
  HoleFeature,
  Part,
  WrenDoc,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  CONFIGURABLE_OPTIONS,
  compileCommand,
  configurableFields,
  configurationIssues,
  createDocumentStore,
  exportFileNames,
  fromFiles,
  migrateDoc,
  newDoc,
  partNumberFor,
  projectCodec,
  resolveConfiguration,
  toFiles,
  validateDoc,
} from '../src';
import { box, extrude, id, ref, req, sampleDoc, sketch } from './fixtures';

const PART = id(3);
const WIDTH = id(1);
const DEPTH = id(2);
const LONG = id(500);
const SHORT = id(501);
const HOLE = id(60);
const BOX = id(13);
const EXTRUDE = id(12);

function hole(): HoleFeature {
  return {
    id: HOLE,
    type: 'hole',
    name: 'Hole 1',
    suppressed: false,
    points: [ref('S1:p(1)', 'vertex')],
    face: ref('F1:top'),
    standard: 'ISO',
    kind: 'simple',
    size: 'M6',
    fit: 'normal',
    end: { kind: 'blind', depth: '10mm' },
  };
}

/** The sample document plus a hole and an extrude/box set the tests configure. */
function doc0(): WrenDoc {
  const d = sampleDoc();
  const part = req(d.parts[0]);
  part.features.push(hole());
  part.rollbackIndex = part.features.length;
  return d;
}

const cfg = (n: number, name: string, over: Partial<Configuration> = {}): Configuration => ({
  id: id(n),
  name,
  ...over,
});

function withConfigs(configs: Configuration[], active?: string): WrenDoc {
  const d = doc0();
  const p = req(d.parts[0]);
  p.configurations = configs;
  if (active) p.activeConfigurationId = active;
  return d;
}

const part = (d: WrenDoc): Part => req(d.parts.find((p) => p.id === PART));
const configs = (d: WrenDoc): Configuration[] => part(d).configurations ?? [];

function storeOf(d: WrenDoc) {
  return createDocumentStore(d, { clock: () => 1 });
}

function fails(d: WrenDoc, cmd: Command): string {
  const r = compileCommand(d, cmd);
  if (r.ok) throw new Error('expected failure');
  return r.error;
}

/** Applies a command through a store and checks that undo/redo restore exactly. */
function roundTrip(d: WrenDoc, cmd: Command): { after: WrenDoc; label: string } {
  const store = storeOf(structuredClone(d));
  const before = store.getDoc();
  const r = store.apply(cmd);
  if (!r.ok) throw new Error(r.error);
  const after = store.getDoc();
  expect(store.history().past).toHaveLength(1);
  const label = req(store.history().past[0]).label;
  expect(store.undo()).toBe(true);
  expect(store.getDoc()).toEqual(before);
  expect(store.redo()).toBe(true);
  expect(store.getDoc()).toEqual(after);
  return { after, label };
}

const edit = (
  configurationId: string,
  target: Extract<Command, { kind: 'setConfigurationOverrides' }>['edits'][number]['target'],
  value?: Extract<Command, { kind: 'setConfigurationOverrides' }>['edits'][number]['value'],
) => ({ configurationId, target, ...(value === undefined ? {} : { value }) });

const setOv = (edits: ReturnType<typeof edit>[]): Command => ({
  kind: 'setConfigurationOverrides',
  partId: PART,
  edits,
});

// ---------------------------------------------------------------------------------------------

describe('configurable fields', () => {
  it('lists Expr fields automatically and the option fields of the feature type', () => {
    const f = configurableFields(hole());
    const ptrs = f.map((x) => `${x.kind}:${x.pointer}`);
    expect(ptrs).toContain('expr:/end/depth');
    expect(ptrs).toContain('option:/size');
    expect(ptrs).toContain('option:/kind');
    expect(ptrs).toContain('option:/fit');
    expect(ptrs).toContain('option:/end/kind');
    const size = f.find((x) => x.pointer === '/size');
    expect(size?.kind === 'option' && size.values).toContain('M8');
  });

  it('offers no sketch dimensions yet, and no upTo end kind', () => {
    expect(configurableFields(sketch(11))).toEqual([]);
    const end = CONFIGURABLE_OPTIONS.extrude?.find((o) => o.pointer === '/end/kind');
    expect(end?.values).toEqual(['blind', 'throughAll']);
  });

  it('hole sizes follow the hole standard', () => {
    const h: HoleFeature = { ...hole(), standard: 'ANSI', size: '#10' };
    const size = configurableFields(h).find((x) => x.pointer === '/size');
    expect(size?.kind === 'option' && size.values).toContain('#10');
    expect(size?.kind === 'option' && size.values).not.toContain('M6');
  });
});

describe('resolveConfiguration', () => {
  it('Default (null) and absent active configuration return the same document', () => {
    const d = withConfigs([cfg(500, 'Long')]);
    expect(resolveConfiguration(d, PART).doc).toBe(d);
    expect(resolveConfiguration(d, PART, null)).toEqual({ doc: d, issues: [] });
  });

  it('defaults to the part’s active configuration', () => {
    const d = withConfigs([cfg(500, 'Long', { params: { [WIDTH]: '80mm' } })], LONG);
    expect(resolveConfiguration(d, PART).doc.params[0]?.expr).toBe('80mm');
    expect(resolveConfiguration(d, PART, null).doc.params[0]?.expr).toBe('40mm');
  });

  it('applies parameter overrides, sharing everything else', () => {
    const d = withConfigs([cfg(500, 'Long', { params: { [WIDTH]: '80mm' } })]);
    const r = resolveConfiguration(d, PART, LONG);
    expect(r.issues).toEqual([]);
    expect(r.doc.params[0]).toEqual({ ...req(d.params[0]), expr: '80mm' });
    expect(r.doc.params[1]).toBe(d.params[1]);
    expect(r.doc.parts[0]).toBe(d.parts[0]); // nothing else changed
    expect(r.doc.parts[1]).toBe(d.parts[1]);
    expect(d.params[0]?.expr).toBe('40mm'); // input untouched
  });

  it('applies suppression and shares untouched features', () => {
    const d = withConfigs([cfg(500, 'Long', { features: { [BOX]: { suppressed: true } } })]);
    const r = resolveConfiguration(d, PART, LONG);
    const p = part(r.doc);
    expect(p.features.find((f) => f.id === BOX)?.suppressed).toBe(true);
    expect(p.features[0]).toBe(part(d).features[0]);
    expect(part(d).features.find((f) => f.id === BOX)?.suppressed).toBe(false);
  });

  it('can unsuppress a feature that is suppressed in Default', () => {
    const d = withConfigs([cfg(500, 'Long', { features: { [BOX]: { suppressed: false } } })]);
    req(part(d).features.find((f) => f.id === BOX)).suppressed = true;
    const r = resolveConfiguration(d, PART, LONG);
    expect(part(r.doc).features.find((f) => f.id === BOX)?.suppressed).toBe(false);
  });

  it('writes expression and option field overrides at their JSON pointers', () => {
    const d = withConfigs([
      cfg(500, 'Long', {
        features: {
          [BOX]: { fields: { '/dx': '100mm' } },
          [HOLE]: { fields: { '/size': 'M8', '/kind': 'tapped', '/fit': 'loose' } },
          [EXTRUDE]: { fields: { '/direction': 'symmetric' } },
        },
      }),
    ]);
    const r = resolveConfiguration(d, PART, LONG);
    expect(r.issues).toEqual([]);
    const fs = part(r.doc).features;
    expect(fs.find((f) => f.id === BOX)).toMatchObject({ dx: '100mm', dy: '30mm' });
    expect(fs.find((f) => f.id === HOLE)).toMatchObject({
      size: 'M8',
      kind: 'tapped',
      fit: 'loose',
    });
    expect((fs.find((f) => f.id === EXTRUDE) as ExtrudeFeature).direction).toBe('symmetric');
  });

  it('extrude end.kind and end.depth can be changed together', () => {
    const d = withConfigs([
      cfg(500, 'Through', { features: { [EXTRUDE]: { fields: { '/end/kind': 'throughAll' } } } }),
    ]);
    const e = part(resolveConfiguration(d, PART, LONG).doc).features.find(
      (f) => f.id === EXTRUDE,
    ) as ExtrudeFeature;
    expect(e.end.kind).toBe('throughAll');

    // Default is throughAll; the configuration makes it blind with a depth.
    const d2 = withConfigs([
      cfg(500, 'Blind', {
        features: { [EXTRUDE]: { fields: { '/end/kind': 'blind', '/end/depth': '7mm' } } },
      }),
    ]);
    (part(d2).features.find((f) => f.id === EXTRUDE) as ExtrudeFeature).end = {
      kind: 'throughAll',
    };
    const r = resolveConfiguration(d2, PART, LONG);
    expect(r.issues).toEqual([]);
    const e2 = part(r.doc).features.find((f) => f.id === EXTRUDE) as ExtrudeFeature;
    expect(e2.end).toEqual({ kind: 'blind', depth: '7mm' });
  });

  it('reports a kind change that leaves a required expression without a value', () => {
    const d = withConfigs([
      cfg(500, 'Blind', { features: { [EXTRUDE]: { fields: { '/end/kind': 'blind' } } } }),
    ]);
    (part(d).features.find((f) => f.id === EXTRUDE) as ExtrudeFeature).end = {
      kind: 'throughAll',
    };
    const r = resolveConfiguration(d, PART, LONG);
    expect(r.issues).toEqual([
      expect.objectContaining({
        configurationId: LONG,
        target: { kind: 'field', featureId: EXTRUDE, path: '/end/depth' },
      }),
    ]);
  });

  it('applies material (including null), colour and properties', () => {
    const steel = { name: 'Steel', density: '7.85 g/cm^3' };
    const d = withConfigs([
      cfg(500, 'Steel', {
        material: steel,
        color: '#112233',
        properties: { partNumber: 'BR-2', description: 'Long bracket' },
      }),
      cfg(501, 'Bare', { material: null }),
    ]);
    part(d).properties = { partNumber: 'BR-1', description: 'Bracket' };
    const a = part(resolveConfiguration(d, PART, LONG).doc);
    expect(a.material).toEqual(steel);
    expect(a.color).toBe('#112233');
    expect(a.properties).toEqual({ partNumber: 'BR-2', description: 'Long bracket' });
    const b = part(resolveConfiguration(d, PART, SHORT).doc);
    expect('material' in b).toBe(false);
    expect(b.color).toBe('#9aa4b2');
    expect(part(d).material).toBeDefined();
  });

  it('properties merge over Default’s', () => {
    const d = withConfigs([cfg(500, 'Long', { properties: { description: 'Long' } })]);
    part(d).properties = { partNumber: 'BR-1', description: 'Bracket' };
    expect(part(resolveConfiguration(d, PART, LONG).doc).properties).toEqual({
      partNumber: 'BR-1',
      description: 'Long',
    });
  });

  it('is deterministic and pure', () => {
    const d = withConfigs([
      cfg(500, 'Long', {
        params: { [WIDTH]: '80mm' },
        features: { [BOX]: { suppressed: true, fields: { '/dz': '1mm', '/dx': '2mm' } } },
      }),
    ]);
    const snapshot = structuredClone(d);
    const a = resolveConfiguration(d, PART, LONG);
    const b = resolveConfiguration(d, PART, LONG);
    expect(a).toEqual(b);
    expect(d).toEqual(snapshot);
  });

  describe('stale overrides become issues, never silently dropped or thrown', () => {
    it('unknown parameter, feature and field', () => {
      const gone = id(999);
      const d = withConfigs([
        cfg(500, 'Long', {
          params: { [gone]: '1mm', [WIDTH]: '80mm' },
          features: {
            [gone]: { suppressed: true, fields: { '/dx': '1' } },
            [BOX]: { fields: { '/nope': '1mm', '/dx': '2mm' } },
          },
        }),
      ]);
      const r = resolveConfiguration(d, PART, LONG);
      const targets = r.issues.map((i) => JSON.stringify(i.target)).sort();
      expect(targets).toEqual(
        [
          { kind: 'param', paramId: gone },
          { kind: 'suppressed', featureId: gone },
          { kind: 'field', featureId: gone, path: '/dx' },
          { kind: 'field', featureId: BOX, path: '/nope' },
        ]
          .map((t) => JSON.stringify(t))
          .sort(),
      );
      expect(r.issues.every((i) => i.configurationId === LONG && i.reason !== '')).toBe(true);
      // The valid overrides still apply.
      expect(r.doc.params[0]?.expr).toBe('80mm');
      expect(part(r.doc).features.find((f) => f.id === BOX)).toMatchObject({ dx: '2mm' });
    });

    it('invalid pointers, non-configurable fields and prototype keys', () => {
      const d = withConfigs([
        cfg(500, 'Long', {
          features: {
            [BOX]: {
              fields: {
                dx: '1mm',
                '/id': 'evil',
                '/name': 'x',
                '/__proto__/polluted': 'yes',
                '': 'x',
              },
            },
          },
        }),
      ]);
      const r = resolveConfiguration(d, PART, LONG);
      expect(r.issues).toHaveLength(5);
      expect(part(r.doc).features.find((f) => f.id === BOX)?.id).toBe(BOX);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('wrong value types and values outside an option’s allowed set', () => {
      const d = withConfigs([
        cfg(500, 'Long', {
          features: {
            [HOLE]: { fields: { '/size': 'M99', '/fit': 3 as never, '/kind': 'tapped' } },
            [BOX]: { fields: { '/dx': 5 as never }, suppressed: 'yes' as never },
          },
        }),
      ]);
      const r = resolveConfiguration(d, PART, LONG);
      expect(r.issues.map((i) => i.target)).toEqual(
        expect.arrayContaining([
          { kind: 'field', featureId: HOLE, path: '/size' },
          { kind: 'field', featureId: HOLE, path: '/fit' },
          { kind: 'field', featureId: BOX, path: '/dx' },
          { kind: 'suppressed', featureId: BOX },
        ]),
      );
      expect(r.issues).toHaveLength(4);
      const h = part(r.doc).features.find((f) => f.id === HOLE) as HoleFeature;
      expect(h).toMatchObject({ size: 'M6', fit: 'normal', kind: 'tapped' });
    });

    it('a missing configuration is an issue, not a fall-back', () => {
      const d = withConfigs([cfg(500, 'Long')]);
      const r = resolveConfiguration(d, PART, id(777));
      expect(r.issues).toEqual([
        expect.objectContaining({ configurationId: id(777), target: { kind: 'configuration' } }),
      ]);
      const stale = withConfigs([cfg(500, 'Long')]);
      part(stale).activeConfigurationId = id(778);
      expect(resolveConfiguration(stale, PART).issues).toHaveLength(1);
      expect(resolveConfiguration(d, id(9999), LONG).issues).toHaveLength(1);
    });

    it('configurationIssues covers every configuration and reports duplicate names', () => {
      const d = withConfigs([
        cfg(500, 'Long', { params: { [id(999)]: '1' } }),
        cfg(501, 'long'),
        cfg(502, 'Other', { features: { [id(998)]: { suppressed: true } } }),
      ]);
      const issues = configurationIssues(d, PART);
      expect(issues.filter((i) => i.target.kind === 'name').map((i) => i.configurationId)).toEqual([
        LONG,
        SHORT,
      ]);
      expect(issues.filter((i) => i.target.kind !== 'name')).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('addConfiguration', () => {
  it('adds the first configuration (creating the array) with one undo step and a label', () => {
    const d = doc0();
    const { after, label } = roundTrip(d, {
      kind: 'addConfiguration',
      partId: PART,
      configuration: { id: LONG, name: 'Long' },
    });
    expect(label).toBe('New configuration Long');
    expect(configs(after)).toEqual([{ id: LONG, name: 'Long' }]);
    expect(part(after).activeConfigurationId).toBeUndefined();
  });

  it('appends further configurations and does not activate them', () => {
    const d = withConfigs([cfg(500, 'Long')], LONG);
    const { after } = roundTrip(d, {
      kind: 'addConfiguration',
      partId: PART,
      configuration: { id: SHORT, name: ' Short ' },
    });
    expect(configs(after).map((c) => c.name)).toEqual(['Long', 'Short']);
    expect(part(after).activeConfigurationId).toBe(LONG);
  });

  it('accepts valid supplied overrides and rejects invalid ones', () => {
    const d = doc0();
    const ok = roundTrip(d, {
      kind: 'addConfiguration',
      partId: PART,
      configuration: {
        id: LONG,
        name: 'Long',
        params: { [WIDTH]: '80mm' },
        features: { [BOX]: { suppressed: true, fields: { '/dx': '2in' } } },
      },
    });
    expect(configs(ok.after)[0]?.params).toEqual({ [WIDTH]: '80mm' });
    expect(
      fails(d, {
        kind: 'addConfiguration',
        partId: PART,
        configuration: { id: LONG, name: 'Long', params: { [id(999)]: '1' } },
      }),
    ).toMatch(/not found/);
  });

  it('from another configuration copies its overrides (D3), deeply', () => {
    const src = cfg(500, 'Long', {
      params: { [WIDTH]: '80mm' },
      features: { [BOX]: { suppressed: true, fields: { '/dx': '2in' } } },
      material: null,
      color: '#ffffff',
      properties: { partNumber: 'X' },
    });
    const d = withConfigs([src]);
    const { after } = roundTrip(d, {
      kind: 'addConfiguration',
      partId: PART,
      configuration: { id: SHORT, name: 'Copy' },
      from: LONG,
    });
    const copy = req(configs(after)[1]);
    expect(copy).toEqual({ ...src, id: SHORT, name: 'Copy' });
    expect(copy.features).not.toBe(configs(after)[0]?.features);
  });

  it('from Default starts empty', () => {
    const d = withConfigs([cfg(500, 'Long', { params: { [WIDTH]: '80mm' } })]);
    const { after } = roundTrip(d, {
      kind: 'addConfiguration',
      partId: PART,
      configuration: { id: SHORT, name: 'Fresh' },
      from: 'default',
    });
    expect(configs(after)[1]).toEqual({ id: SHORT, name: 'Fresh' });
  });

  it('fails: duplicate id, empty name, unknown source, copy plus overrides, unknown key', () => {
    const d = withConfigs([cfg(500, 'Long')]);
    const add = (c: Partial<Configuration> & Record<string, unknown>, from?: string): Command => ({
      kind: 'addConfiguration',
      partId: PART,
      configuration: { id: SHORT, name: 'S', ...c } as Configuration,
      ...(from ? { from } : {}),
    });
    expect(fails(d, add({ id: LONG }))).toMatch(/already in use/);
    expect(fails(d, add({ id: BOX }))).toMatch(/already in use/);
    expect(fails(d, add({ name: '   ' }))).toMatch(/needs a name/);
    expect(fails(d, add({}, id(321)))).toMatch(/not found/);
    expect(fails(d, add({ color: '#fff' }, LONG))).toMatch(/not both/);
    expect(fails(d, add({ bogus: 1 }))).toMatch(/not a configuration property/);
    expect(fails(d, { ...add({}), partId: id(444) } as Command)).toMatch(/Part/);
  });

  it('allows a duplicate name (reported separately)', () => {
    const d = withConfigs([cfg(500, 'Long')]);
    const { after } = roundTrip(d, {
      kind: 'addConfiguration',
      partId: PART,
      configuration: { id: SHORT, name: 'Long' },
    });
    expect(configs(after)).toHaveLength(2);
    expect(configurationIssues(after, PART).filter((i) => i.target.kind === 'name')).toHaveLength(
      2,
    );
  });
});

describe('renameConfiguration / setActiveConfiguration / removeConfiguration', () => {
  it('renames with a label; same name is a no-op; fails on empty or unknown', () => {
    const d = withConfigs([cfg(500, 'Long')]);
    const { after, label } = roundTrip(d, {
      kind: 'renameConfiguration',
      partId: PART,
      configurationId: LONG,
      name: 'Longer',
    });
    expect(label).toBe('Rename configuration Long to Longer');
    expect(configs(after)[0]?.name).toBe('Longer');
    const same = compileCommand(d, {
      kind: 'renameConfiguration',
      partId: PART,
      configurationId: LONG,
      name: 'Long',
    });
    expect(same.ok && same.ops).toEqual([]);
    expect(
      fails(d, { kind: 'renameConfiguration', partId: PART, configurationId: LONG, name: ' ' }),
    ).toMatch(/needs a name/);
    expect(
      fails(d, { kind: 'renameConfiguration', partId: PART, configurationId: id(1), name: 'x' }),
    ).toMatch(/not found/);
  });

  it('switches the active configuration and back to Default', () => {
    const d = withConfigs([cfg(500, 'Long'), cfg(501, 'Short')]);
    const a = roundTrip(d, {
      kind: 'setActiveConfiguration',
      partId: PART,
      configurationId: LONG,
    });
    expect(a.label).toBe('Switch to Long');
    expect(part(a.after).activeConfigurationId).toBe(LONG);
    const b = roundTrip(a.after, {
      kind: 'setActiveConfiguration',
      partId: PART,
      configurationId: SHORT,
    });
    expect(part(b.after).activeConfigurationId).toBe(SHORT);
    const c = roundTrip(b.after, {
      kind: 'setActiveConfiguration',
      partId: PART,
      configurationId: null,
    });
    expect(c.label).toBe('Switch to Default');
    expect('activeConfigurationId' in part(c.after)).toBe(false);
    expect(
      fails(d, { kind: 'setActiveConfiguration', partId: PART, configurationId: id(1) }),
    ).toMatch(/not found/);
    const noop = compileCommand(d, {
      kind: 'setActiveConfiguration',
      partId: PART,
      configurationId: null,
    });
    expect(noop.ok && noop.ops).toEqual([]);
  });

  it('removes a configuration; removing the active one resets to Default', () => {
    const d = withConfigs([cfg(500, 'Long'), cfg(501, 'Short')], LONG);
    const keep = roundTrip(d, {
      kind: 'removeConfiguration',
      partId: PART,
      configurationId: SHORT,
    });
    expect(keep.label).toBe('Delete configuration Short');
    expect(part(keep.after).activeConfigurationId).toBe(LONG);
    const act = roundTrip(d, { kind: 'removeConfiguration', partId: PART, configurationId: LONG });
    expect('activeConfigurationId' in part(act.after)).toBe(false);
    expect(configs(act.after).map((c) => c.id)).toEqual([SHORT]);
  });

  it('removing the last configuration removes the key (canonical)', () => {
    const d = withConfigs([cfg(500, 'Long')], LONG);
    const { after } = roundTrip(d, {
      kind: 'removeConfiguration',
      partId: PART,
      configurationId: LONG,
    });
    expect('configurations' in part(after)).toBe(false);
    expect('activeConfigurationId' in part(after)).toBe(false);
    expect(fails(d, { kind: 'removeConfiguration', partId: PART, configurationId: id(1) })).toMatch(
      /not found/,
    );
  });
});

describe('setConfigurationOverrides', () => {
  it('sets a parameter override: label “Set Width in Long”', () => {
    const d = doc0();
    req(d.params[0]).name = 'Width';
    part(d).configurations = [cfg(500, 'Long')];
    const { after, label } = roundTrip(
      d,
      setOv([edit(LONG, { kind: 'param', paramId: WIDTH }, '80mm')]),
    );
    expect(label).toBe('Set Width in Long');
    expect(configs(after)[0]?.params).toEqual({ [WIDTH]: '80mm' });
  });

  it('reset removes the key and prunes empty objects (canonical file)', () => {
    const d = withConfigs([
      cfg(500, 'Long', {
        params: { [WIDTH]: '80mm' },
        features: { [BOX]: { suppressed: true, fields: { '/dx': '1mm' } } },
        properties: { partNumber: 'A' },
      }),
    ]);
    let cur = d;
    const steps: [ReturnType<typeof edit>, string][] = [
      [edit(LONG, { kind: 'param', paramId: WIDTH }), 'Reset width in Long'],
      [edit(LONG, { kind: 'field', featureId: BOX, path: '/dx' }), 'Reset Box 13 dx in Long'],
      [edit(LONG, { kind: 'suppressed', featureId: BOX }), 'Reset suppression of Box 13 in Long'],
      [edit(LONG, { kind: 'property', key: 'partNumber' }), 'Reset part number in Long'],
    ];
    for (const [e, expected] of steps) {
      const r = roundTrip(cur, setOv([e]));
      expect(r.label).toBe(expected);
      cur = r.after;
    }
    expect(configs(cur)).toEqual([{ id: LONG, name: 'Long' }]); // every empty object pruned
    expect(JSON.stringify(configs(cur))).not.toMatch(/params|features|fields|properties/);
  });

  it('resetting something that is not overridden is a no-op', () => {
    const d = withConfigs([cfg(500, 'Long')]);
    const r = compileCommand(d, setOv([edit(LONG, { kind: 'param', paramId: WIDTH })]));
    expect(r.ok && r.ops).toEqual([]);
  });

  it('sets suppression, field, option, material, colour and property overrides', () => {
    const d = withConfigs([cfg(500, 'Long')]);
    const cases: [ReturnType<typeof edit>, string][] = [
      [edit(LONG, { kind: 'suppressed', featureId: BOX }, true), 'Suppress Box 13 in Long'],
      [edit(LONG, { kind: 'suppressed', featureId: BOX }, false), 'Unsuppress Box 13 in Long'],
      [edit(LONG, { kind: 'field', featureId: BOX, path: '/dx' }, '2in'), 'Set Box 13 dx in Long'],
      [
        edit(LONG, { kind: 'field', featureId: HOLE, path: '/size' }, 'M8'),
        'Set Hole 1 size in Long',
      ],
      [
        edit(LONG, { kind: 'material' }, { name: 'Steel', density: '7.85 g/cm^3' }),
        'Set material Steel in Long',
      ],
      [edit(LONG, { kind: 'material' }, null), 'Clear material in Long'],
      [edit(LONG, { kind: 'color' }, '#abc'), 'Set colour in Long'],
      [edit(LONG, { kind: 'property', key: 'description' }, 'Long one'), 'Set description in Long'],
    ];
    for (const [e, expected] of cases) {
      const r = roundTrip(d, setOv([e]));
      expect(r.label).toBe(expected);
      const out = resolveConfiguration(r.after, PART, LONG);
      expect(out.issues).toEqual([]);
    }
  });

  it('a batch is one undo entry with a summary label', () => {
    const d = withConfigs([cfg(500, 'Long'), cfg(501, 'Short')]);
    const edits = [
      edit(LONG, { kind: 'param', paramId: WIDTH }, '80mm'),
      edit(LONG, { kind: 'param', paramId: DEPTH }, '10mm'),
      edit(SHORT, { kind: 'param', paramId: WIDTH }, '20mm'),
    ];
    const { after, label } = roundTrip(d, setOv(edits));
    expect(label).toBe('Change 3 values in 2 configurations');
    expect(configs(after)[0]?.params).toEqual({ [WIDTH]: '80mm', [DEPTH]: '10mm' });
    expect(configs(after)[1]?.params).toEqual({ [WIDTH]: '20mm' });
    const one = roundTrip(d, setOv(edits.slice(0, 2)));
    expect(one.label).toBe('Change 2 values in Long');
  });

  it('a batch is atomic: one bad edit changes nothing', () => {
    const d = withConfigs([cfg(500, 'Long')]);
    const store = storeOf(d);
    const r = store.apply(
      setOv([
        edit(LONG, { kind: 'param', paramId: WIDTH }, '80mm'),
        edit(LONG, { kind: 'param', paramId: id(999) }, '1mm'),
      ]),
    );
    expect(r.ok).toBe(false);
    expect(store.getDoc()).toBe(d);
    expect(store.canUndo()).toBe(false);
  });

  it('an end.kind change and the end.depth it needs can arrive in any order', () => {
    const d = withConfigs([cfg(500, 'Long')]);
    (part(d).features.find((f) => f.id === EXTRUDE) as ExtrudeFeature).end = { kind: 'throughAll' };
    const e1 = edit(LONG, { kind: 'field', featureId: EXTRUDE, path: '/end/depth' }, '9mm');
    const e2 = edit(LONG, { kind: 'field', featureId: EXTRUDE, path: '/end/kind' }, 'blind');
    expect(fails(d, setOv([e1]))).toMatch(/not a configurable field/);
    const a = roundTrip(d, setOv([e1, e2])).after;
    const b = roundTrip(d, setOv([e2, e1])).after;
    expect(a).toEqual(b);
    expect(resolveConfiguration(a, PART, LONG).issues).toEqual([]);
  });

  describe('validation', () => {
    const d = withConfigs([cfg(500, 'Long')]);
    const bad = (e: ReturnType<typeof edit>) => fails(d, setOv([e]));

    it('unknown configuration, parameter and feature', () => {
      expect(bad(edit(id(1), { kind: 'color' }, '#fff'))).toMatch(/Configuration .* not found/);
      expect(bad(edit(LONG, { kind: 'param', paramId: id(999) }, '1'))).toMatch(/Parameter/);
      expect(bad(edit(LONG, { kind: 'suppressed', featureId: id(999) }, true))).toMatch(/Feature/);
      expect(bad(edit(LONG, { kind: 'field', featureId: id(999), path: '/dx' }, '1'))).toMatch(
        /Feature/,
      );
      expect(fails(d, { ...setOv([]), partId: id(444) } as Command)).toMatch(/Part/);
      expect(bad({ configurationId: LONG, target: { kind: 'bogus' } as never })).toMatch(
        /can override/,
      );
    });

    it('expressions must parse with units and match the field’s dimension', () => {
      expect(bad(edit(LONG, { kind: 'param', paramId: WIDTH }, '2 +'))).toMatch(/width/);
      expect(bad(edit(LONG, { kind: 'param', paramId: WIDTH }, '2 * nope'))).toMatch(/width/);
      expect(bad(edit(LONG, { kind: 'param', paramId: WIDTH }, 5 as never))).toMatch(/expression/);
      expect(bad(edit(LONG, { kind: 'field', featureId: BOX, path: '/dx' }, '5 deg'))).toMatch(
        /Expected a length/,
      );
      expect(bad(edit(LONG, { kind: 'field', featureId: BOX, path: '/dx' }, '1 furlong'))).toMatch(
        /dx/,
      );
      // Parameters may be used, including ones overridden in the same configuration.
      expect(
        compileCommand(
          d,
          setOv([edit(LONG, { kind: 'field', featureId: BOX, path: '/dx' }, 'width * 2')]),
        ).ok,
      ).toBe(true);
    });

    it('a parameter override that makes a cycle is rejected', () => {
      expect(bad(edit(LONG, { kind: 'param', paramId: WIDTH }, 'depth'))).toMatch(/width/);
    });

    it('option values must be in the allowed set and of the right type', () => {
      const f = (path: string, v: never) =>
        bad(edit(LONG, { kind: 'field', featureId: HOLE, path }, v));
      expect(f('/size', 'M99' as never)).toMatch(/not one of/);
      expect(f('/kind', 'drilled' as never)).toMatch(/not one of/);
      expect(f('/fit', true as never)).toMatch(/not one of/);
      expect(f('/end/kind', 'upTo' as never)).toMatch(/not one of/);
      expect(bad(edit(LONG, { kind: 'field', featureId: BOX, path: '/dx' }, true))).toMatch(
        /expression/,
      );
    });

    it('non-configurable paths are rejected', () => {
      for (const path of [
        '/id',
        '/name',
        '/suppressed',
        '/points',
        '/nope',
        'dx',
        '/__proto__/x',
      ]) {
        expect(bad(edit(LONG, { kind: 'field', featureId: HOLE, path }, 'x'))).toMatch(
          /configurable/,
        );
      }
      expect(
        bad(edit(LONG, { kind: 'field', featureId: id(11), path: '/constraints/1/value' }, '1mm')),
      ).toMatch(/configurable/);
    });

    it('never pollutes Object.prototype through a hostile path', () => {
      for (const path of ['/__proto__/polluted', '/end/__proto__/polluted']) {
        expect(
          fails(d, setOv([edit(LONG, { kind: 'field', featureId: HOLE, path }, 'x')])),
        ).toBeTruthy();
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('suppression, colour, property and material types', () => {
      expect(bad(edit(LONG, { kind: 'suppressed', featureId: BOX }, 'yes' as never))).toMatch(
        /true or false/,
      );
      expect(bad(edit(LONG, { kind: 'color' }, 'red'))).toMatch(/hex colour/);
      expect(bad(edit(LONG, { kind: 'color' }, 4 as never))).toMatch(/text/);
      expect(bad(edit(LONG, { kind: 'property', key: 'partNumber' }, 4 as never))).toMatch(/text/);
      expect(bad(edit(LONG, { kind: 'property', key: 'bogus' as never }, 'x'))).toMatch(
        /not a part/,
      );
      expect(bad(edit(LONG, { kind: 'material' }, 'steel' as never))).toMatch(/material/);
      expect(bad(edit(LONG, { kind: 'material' }, { name: 'X', density: 'lots' }))).toBeTruthy();
    });
  });
});

describe('setPartProperties', () => {
  it('sets, changes and clears Default properties with clear labels', () => {
    const d = doc0();
    const a = roundTrip(d, {
      kind: 'setPartProperties',
      partId: PART,
      properties: { partNumber: 'BR-1' },
    });
    expect(a.label).toBe('Set part number');
    expect(part(a.after).properties).toEqual({ partNumber: 'BR-1' });
    const b = roundTrip(a.after, {
      kind: 'setPartProperties',
      partId: PART,
      properties: { partNumber: 'BR-1', description: 'A bracket' },
    });
    expect(b.label).toBe('Set description');
    const c = roundTrip(b.after, {
      kind: 'setPartProperties',
      partId: PART,
      properties: { partNumber: 'BR-2', description: 'Other' },
    });
    expect(c.label).toBe('Set part properties');
    const e = roundTrip(c.after, {
      kind: 'setPartProperties',
      partId: PART,
      properties: { partNumber: ' ', description: '' },
    });
    expect('properties' in part(e.after)).toBe(false);
  });

  it('fails on non-text values, unknown keys and unknown parts', () => {
    const d = doc0();
    expect(
      fails(d, { kind: 'setPartProperties', partId: PART, properties: { partNumber: 5 as never } }),
    ).toMatch(/text/);
    expect(
      fails(d, { kind: 'setPartProperties', partId: PART, properties: { x: 'a' } as never }),
    ).toMatch(/not a part property/);
    expect(fails(d, { kind: 'setPartProperties', partId: id(1), properties: {} })).toMatch(/Part/);
  });
});

describe('configurations stay consistent with other edits', () => {
  const full = () =>
    withConfigs([
      cfg(500, 'Long', {
        params: { [WIDTH]: '80mm', [DEPTH]: '10mm' },
        features: {
          [BOX]: { suppressed: true, fields: { '/dx': '1mm' } },
          [HOLE]: { fields: { '/size': 'M8' } },
        },
      }),
      cfg(501, 'Short', { features: { [BOX]: { suppressed: true } } }),
      cfg(502, 'Plain'),
    ]);

  it('deleting a feature drops its overrides in every configuration (one undo entry)', () => {
    const { after } = roundTrip(full(), { kind: 'removeFeature', partId: PART, featureId: BOX });
    expect(configs(after)[0]?.features).toEqual({ [HOLE]: { fields: { '/size': 'M8' } } });
    expect('features' in req(configs(after)[1])).toBe(false);
    expect(configurationIssues(after, PART)).toEqual([]);
  });

  it('deleting a parameter drops its param overrides in every configuration', () => {
    const { after } = roundTrip(full(), { kind: 'removeParam', paramId: WIDTH });
    expect(configs(after)[0]?.params).toEqual({ [DEPTH]: '10mm' });
    const { after: again } = roundTrip(after, { kind: 'removeParam', paramId: DEPTH });
    expect('params' in req(configs(again)[0])).toBe(false);
  });

  it('deleting a parameter also prunes other parts’ configurations', () => {
    const d = full();
    req(d.parts[1]).configurations = [cfg(510, 'Other', { params: { [WIDTH]: '1mm' } })];
    const { after } = roundTrip(d, { kind: 'removeParam', paramId: WIDTH });
    expect(req(after.parts[1]).configurations).toEqual([{ id: id(510), name: 'Other' }]);
  });

  it('a raw patch that deletes a feature or parameter prunes too; other patches do not', () => {
    const d = full();
    const fi = part(d).features.findIndex((f) => f.id === BOX);
    const del = roundTrip(d, {
      kind: 'patch',
      ops: [
        { op: 'remove', path: `/parts/0/features/${fi}` },
        { op: 'replace', path: `/parts/0/rollbackIndex`, value: part(d).rollbackIndex - 1 },
        { op: 'remove', path: '/params/0' },
      ],
    }).after;
    expect(configs(del)[0]).toEqual({
      id: LONG,
      name: 'Long',
      params: { [DEPTH]: '10mm' },
      features: { [HOLE]: { fields: { '/size': 'M8' } } },
    });
    const edit1 = roundTrip(d, {
      kind: 'patch',
      ops: [{ op: 'replace', path: '/params/0/expr', value: '1mm' }],
    }).after;
    expect(configs(edit1)).toEqual(configs(d));
  });

  it('feature reorder needs nothing', () => {
    const d = full();
    const { after } = roundTrip(d, {
      kind: 'moveFeature',
      partId: PART,
      featureId: BOX,
      toIndex: 0,
    });
    expect(configs(after)).toEqual(configs(d));
  });

  it('renaming a parameter updates expressions in overrides', () => {
    const d = full();
    const f = part(d).configurations as Configuration[];
    req(f[0]).params = { [WIDTH]: 'depth * 2' };
    req(req(f[0]).features)[BOX] = { fields: { '/dx': 'depth + 1mm', '/name': 'depth' } };
    const { after } = roundTrip(d, { kind: 'updateParam', paramId: DEPTH, name: 'thick' });
    expect(configs(after)[0]?.params?.[WIDTH]).toBe('thick * 2');
    expect(configs(after)[0]?.features?.[BOX]?.fields).toEqual({
      '/dx': 'thick + 1mm',
      '/name': 'depth', // not an Expr field: left alone
    });
  });

  it('addPart checks configuration ids and the active configuration', () => {
    const d = doc0();
    const p: Part = {
      id: id(70),
      name: 'P2',
      features: [],
      rollbackIndex: 0,
      configurations: [cfg(500, 'Dup')],
    };
    expect(fails(withConfigs([cfg(500, 'x')]), { kind: 'addPart', part: p })).toMatch(/in use/);
    expect(fails(d, { kind: 'addPart', part: { ...p, activeConfigurationId: id(1) } })).toMatch(
      /active/,
    );
    expect(compileCommand(d, { kind: 'addPart', part: p }).ok).toBe(true);
  });
});

describe('part numbers and export file names (D4)', () => {
  const d = withConfigs([
    cfg(500, 'Long'),
    cfg(501, 'Short', { properties: { partNumber: 'BR-7' } }),
  ]);

  it('falls back to "<document name>-<configuration name>"', () => {
    expect(partNumberFor(d, PART, LONG)).toBe('Bracket-Long');
  });

  it('prefers a user-set number', () => {
    expect(partNumberFor(d, PART, SHORT)).toBe('BR-7');
  });

  it('Default is the document name or its user-set number; absent id means active', () => {
    expect(partNumberFor(d, PART, null)).toBe('Bracket');
    part(d).properties = { partNumber: 'BR-1' };
    expect(partNumberFor(d, PART, null)).toBe('BR-1');
    part(d).activeConfigurationId = SHORT;
    expect(partNumberFor(d, PART)).toBe('BR-7');
    delete part(d).activeConfigurationId;
    expect(partNumberFor(d, PART)).toBe('BR-1');
  });

  it('a configuration inherits Default’s number; an empty override clears it', () => {
    const e = withConfigs([
      cfg(500, 'Long'),
      cfg(501, 'Short', { properties: { partNumber: '' } }),
    ]);
    part(e).properties = { partNumber: 'BR-1' };
    expect(partNumberFor(e, PART, LONG)).toBe('BR-1');
    expect(partNumberFor(e, PART, SHORT)).toBe('Bracket-Short');
  });

  it('blank numbers count as unset; unknown configurations name themselves', () => {
    const e = withConfigs([cfg(500, 'Long', { properties: { partNumber: '  ' } })]);
    expect(partNumberFor(e, PART, LONG)).toBe('Bracket-Long');
    expect(partNumberFor(e, PART, id(9))).toBe(`Bracket-${id(9)}`);
    expect(partNumberFor(e, id(8), LONG)).toBe('Bracket');
  });

  it('exportFileNames lists names and reports collisions without renaming', () => {
    const e = withConfigs([
      cfg(500, 'Long'),
      cfg(501, 'long'),
      cfg(502, 'A/B:C'),
      cfg(503, 'Other', { properties: { partNumber: 'bracket-long' } }),
    ]);
    const r = exportFileNames(e, PART, [LONG, id(501), id(502), id(503), null], '.step');
    expect(r.files.map((f) => f.fileName)).toEqual([
      'Bracket-Long.step',
      'Bracket-long.step',
      'Bracket-A_B_C.step',
      'bracket-long.step',
      'Bracket.step',
    ]);
    expect(r.collisions).toEqual([
      { fileName: 'Bracket-Long.step', configurationIds: [LONG, id(501), id(503)] },
    ]);
    const clean = exportFileNames(e, PART, [LONG, id(502)]);
    expect(clean.collisions).toEqual([]);
    expect(clean.files[0]?.fileName).toBe('Bracket-Long');
  });

  it('file names are never empty or dotted-off', () => {
    const e = newDoc({ name: '...' });
    e.parts = [{ id: PART, name: 'P', features: [box(1)], rollbackIndex: 1 }];
    expect(exportFileNames(e, PART, [null]).files[0]?.fileName).toBe('part');
  });
});

describe('validateDoc, load and codec', () => {
  const full = (): WrenDoc => {
    const d = withConfigs(
      [
        cfg(500, 'Long', {
          params: { [WIDTH]: '80mm' },
          features: { [BOX]: { suppressed: true, fields: { '/dx': '1mm', '/dz': '2mm' } } },
          material: { name: 'Steel', density: '7.85 g/cm^3' },
          color: '#fff',
          properties: { partNumber: 'BR-2' },
        }),
        cfg(501, 'Short', { material: null }),
      ],
      LONG,
    );
    part(d).properties = { partNumber: 'BR-1', description: 'Bracket' };
    return d;
  };

  it('accepts a well-formed document, including stale overrides', () => {
    expect(validateDoc(full())).toEqual([]);
    const d = full();
    req(configs(d)[0]).params = { [id(999)]: '1mm' };
    expect(validateDoc(d)).toEqual([]);
  });

  it('rejects malformed configurations', () => {
    const problems = (mutate: (c: Configuration[], p: Part) => void): string[] => {
      const d = full();
      mutate(configs(d), part(d));
      return validateDoc(d);
    };
    expect(problems((c) => (c[1] = { ...req(c[1]), id: LONG }))).toEqual([
      expect.stringMatching(/duplicate id/),
    ]);
    expect(problems((c) => ((req(c[0]) as { name: unknown }).name = 3))).toEqual([
      expect.stringMatching(/name must be a string/),
    ]);
    expect(problems((_, p) => (p.activeConfigurationId = id(1)))).toEqual([
      expect.stringMatching(/activeConfigurationId/),
    ]);
    expect(problems((c) => ((req(c[0]).params as Record<string, unknown>)[WIDTH] = 5))).toEqual([
      expect.stringMatching(/must be a string/),
    ]);
    expect(problems((c) => ((req(c[0]).features as Record<string, unknown>)[BOX] = 'x'))).toEqual([
      expect.stringMatching(/must be an object/),
    ]);
    expect(
      problems((c) => ((req(req(c[0]).features)[BOX] as { suppressed: unknown }).suppressed = 'y')),
    ).toEqual([expect.stringMatching(/suppressed must be a boolean/)]);
    expect(
      problems((c) => {
        req(req(req(c[0]).features)[BOX]?.fields)['dx'] = '1';
      }),
    ).toEqual([expect.stringMatching(/JSON pointer/)]);
    expect(
      problems((c) => {
        req(req(req(c[0]).features)[BOX]?.fields)['/dx'] = {} as never;
      }),
    ).toEqual([expect.stringMatching(/string, number or boolean/)]);
    expect(problems((c) => ((req(c[0]).material as { density: unknown }).density = 1))).toEqual([
      expect.stringMatching(/density must be a string/),
    ]);
    expect(problems((c) => ((req(c[0]) as { color: unknown }).color = 1))).toEqual([
      expect.stringMatching(/color/),
    ]);
    expect(problems((c) => ((req(c[0]).properties as Record<string, unknown>).x = 'a'))).toEqual([
      expect.stringMatching(/not a part property/),
    ]);
    expect(problems((_, p) => ((p as { properties: unknown }).properties = []))).toEqual([
      expect.stringMatching(/properties must be an object/),
    ]);
    expect(
      problems((_, p) => ((p as { configurations: unknown }).configurations = {})).join('\n'),
    ).toMatch(/configurations must be an array/);
  });

  it('a configuration id may not collide with any other id', () => {
    const d = full();
    req(configs(d)[0]).id = BOX;
    expect(validateDoc(d).some((e) => /duplicate id/.test(e))).toBe(true);
  });

  it('round-trips byte-identically through the codec', () => {
    const d = full();
    const a = toFiles(d);
    const back = fromFiles(a);
    expect(back).toEqual(d);
    const b = toFiles(back);
    expect([...b.keys()]).toEqual([...a.keys()]);
    for (const [k, v] of a) expect(Buffer.from(req(b.get(k))).equals(Buffer.from(v))).toBe(true);
    const wren = projectCodec.toWren(d);
    const again = projectCodec.toWren(projectCodec.fromWren(wren).doc);
    expect(Buffer.from(again).equals(Buffer.from(wren))).toBe(true);
  });

  it('writes configurations in canonical (sorted) key order', () => {
    const files = toFiles(full());
    const file = [...files.keys()].find((k) => k.startsWith('parts/bracket')) as string;
    const text = Buffer.from(req(files.get(file))).toString();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const sorted = (o: object) => Object.keys(o).sort();
    expect(Object.keys(parsed)).toEqual(sorted(parsed));
    const c0 = (parsed.configurations as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(Object.keys(c0)).toEqual(sorted(c0));
    const fields = (c0.features as Record<string, { fields: object }>)[BOX]?.fields as object;
    expect(Object.keys(fields)).toEqual(['/dx', '/dz']);
    expect(text.indexOf('"/dx"')).toBeLessThan(text.indexOf('"/dz"'));
    // Re-serialising a document built with reversed key order gives the same bytes.
    const reversed = JSON.parse(
      JSON.stringify(full(), (_k, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    ) as WrenDoc;
    expect(Buffer.from(req(toFiles(reversed).get(file))).toString()).toBe(text);
  });

  it('survives load through the store and a shuffled-key file', () => {
    const d = full();
    const store = createDocumentStore();
    expect(store.load(JSON.parse(JSON.stringify(d))).ok).toBe(true);
    expect(store.getDoc()).toEqual(d);
  });

  it('migrates a v2 fixture to v3 unchanged and then accepts configuration edits', () => {
    const v2 = { ...sampleDoc(), schemaVersion: 2 } as unknown as Record<string, unknown>;
    const r = migrateDoc(v2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toEqual([3]);
    expect(r.doc).toEqual({ ...sampleDoc(), schemaVersion: 3 });
    const store = createDocumentStore();
    store.load(v2);
    expect(store.getDoc().schemaVersion).toBe(3);
    const a = store.apply({
      kind: 'addConfiguration',
      partId: PART,
      configuration: { id: LONG, name: 'Long' },
    });
    expect(a.ok).toBe(true);
    expect(validateDoc(store.getDoc())).toEqual([]);
  });

  it('migrating a document that already has configurations keeps them', () => {
    const r = migrateDoc({ ...full(), schemaVersion: 2 });
    expect(r.ok && r.doc).toEqual({ ...full(), schemaVersion: 3 });
  });

  it('unused extrude helper stays referenced (fixture sanity)', () => {
    expect(extrude(1, 2).type).toBe('extrude');
  });
});
