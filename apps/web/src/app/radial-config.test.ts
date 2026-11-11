import { layoutSlots, type RadialItem } from '@wren-cad/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { modelRadialIds, sketchRadialIds } from './radial';
import {
  applies,
  contextOf,
  customRing,
  DEFAULT_RADIAL_CONFIG,
  defaultRing,
  loadRadialConfig,
  parseRadialConfig,
  RADIAL_CONTEXTS,
  RADIAL_KEY,
  registryIds,
  resetRadialCache,
  resetRing,
  ringToItems,
  saveRadialConfig,
  serializeRadialConfig,
  setRing,
} from './radial-config';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const item = (id: string): RadialItem => ({ id, label: id });
const face = { kind: 'face' as const, planar: true };

describe('radial defaults', () => {
  it("every default ring is today's contents, in order, and uses registry commands", () => {
    const ids = (c: Parameters<typeof defaultRing>[0]) =>
      defaultRing(c).filter((x): x is string => x !== null);
    expect(ids('empty')).toEqual(modelRadialIds([]));
    expect(ids('face')).toEqual(modelRadialIds([face]));
    expect(ids('edge')).toEqual(modelRadialIds([{ kind: 'edge' }]));
    expect(ids('vertex')).toEqual(modelRadialIds([{ kind: 'vertex' }]));
    expect(ids('feature')).toEqual(modelRadialIds([], { folderable: true }));
    expect(ids('sketchIdle')).toEqual(sketchRadialIds());
    for (const c of RADIAL_CONTEXTS) {
      const reg = new Set(registryIds(c.sketch));
      for (const id of ids(c.id)) expect(reg.has(id), `${c.id}:${id}`).toBe(true);
    }
  });

  it('picks the context from the selection', () => {
    expect(contextOf([], { sketch: false })).toBe('empty');
    expect(contextOf([], { sketch: false, treePicked: 2 })).toBe('feature');
    expect(contextOf([face, face], { sketch: false })).toBe('face');
    expect(contextOf([{ kind: 'edge' }], { sketch: false })).toBe('edge');
    expect(contextOf([{ kind: 'vertex' }], { sketch: false })).toBe('vertex');
    expect(contextOf([{ kind: 'edge' }, face], { sketch: false })).toBe('body');
    expect(contextOf([{ kind: 'region' }], { sketch: false })).toBeNull();
    expect(contextOf([], { sketch: true })).toBe('sketchIdle');
    expect(contextOf([], { sketch: true, sketchSelected: true })).toBe('sketchSel');
  });

  it('an untouched config leaves every context on the legacy rings', () => {
    for (const c of RADIAL_CONTEXTS) expect(customRing(DEFAULT_RADIAL_CONFIG, c.id)).toBeNull();
  });
});

describe('custom ring layout', () => {
  const st = { sel: [{ kind: 'edge' as const }], folderable: false, sketch: false };

  it('keeps fixed positions and disables what does not apply', () => {
    const ring = ['fillet', null, 'pushPull', 'chamfer', null, null, 'measure'];
    const items = ringToItems(ring, st, item);
    const { placed } = layoutSlots(items, ['n']);
    expect(placed.ne?.id).toBe('fillet');
    expect(placed.e).toBeUndefined(); // an empty slot stays empty, nothing shifts
    expect(placed.se?.id).toBe('pushPull');
    expect(placed.se?.disabled).toBe(true); // not applicable to an edge: dimmed, not removed
    expect(placed.s?.id).toBe('chamfer');
    expect(placed.s?.disabled).toBe(false);
    expect(placed.nw?.id).toBe('measure');
  });

  it('disables by selection', () => {
    const planar = { sel: [face], folderable: false, sketch: false };
    expect(applies('hole', planar)).toBe(true);
    expect(applies('thread', planar)).toBe(false);
    expect(applies('fillet', planar)).toBe(false);
    expect(applies('extrude', planar)).toBe(false);
    expect(applies('sketch', { ...planar, sel: [] })).toBe(true);
    expect(applies('folder:add', planar)).toBe(false);
    expect(applies('undo', planar)).toBe(true);
    expect(applies('sketch:line', { sel: [], folderable: false, sketch: true })).toBe(true);
  });

  it('a ring equal to the default is not stored; reset removes it', () => {
    const same = setRing(DEFAULT_RADIAL_CONFIG, 'face', defaultRing('face'));
    expect(same.rings).toEqual({});
    const custom = setRing(DEFAULT_RADIAL_CONFIG, 'face', [
      'hole',
      ...defaultRing('face').slice(1),
    ]);
    expect(custom.rings.face?.[0]).toBe('hole');
    expect(resetRing(custom, 'face').rings).toEqual({});
  });

  it('the tree context falls back to a custom Empty space ring', () => {
    const cfg = setRing(DEFAULT_RADIAL_CONFIG, 'empty', ['fit', ...Array(6).fill(null)]);
    expect(customRing(cfg, 'feature')?.[0]).toBe('fit');
  });
});

describe('persistence and migration', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRadialCache();
  });

  it('round-trips a customised config and stores nothing for defaults', () => {
    const cfg = {
      ...setRing(DEFAULT_RADIAL_CONFIG, 'face', ['hole', null, null, null, null, null, 'measure']),
      flickWindow: 120,
      drawAfterDelay: true,
    };
    saveRadialConfig(cfg);
    resetRadialCache();
    const back = loadRadialConfig();
    expect(back.config).toEqual(cfg);
    expect(back.dropped).toEqual([]);
    expect(JSON.parse(localStorage.getItem(RADIAL_KEY) ?? '{}').version).toBe(1);
    saveRadialConfig(DEFAULT_RADIAL_CONFIG);
    expect(localStorage.getItem(RADIAL_KEY)).toBeNull();
    expect(parseRadialConfig(JSON.parse(serializeRadialConfig(cfg))).config).toEqual(cfg);
  });

  it('drops and reports unknown command ids, duplicates and model ids in a sketch ring', () => {
    const r = parseRadialConfig({
      version: 1,
      rings: {
        face: ['hole', 'nope', 'hole', 'oldTool', 'measure', null, null, 'extra'],
        sketchIdle: ['sketch:line', 'extrude'],
        __proto__: ['x'],
        bogus: ['hole'],
      },
    });
    expect(r.dropped).toEqual(['nope', 'oldTool', 'extrude']);
    expect(r.config.rings.face).toEqual(['hole', null, null, null, 'measure', null, null]);
    expect(r.config.rings.sketchIdle).toEqual(['sketch:line', null, null, null, null, null, null]);
    expect(Object.keys(r.config.rings).sort()).toEqual(['face', 'sketchIdle']);
  });

  it('migrates v0 (plain id lists) and clamps the flick window', () => {
    const r = parseRadialConfig({
      rings: { edge: ['chamfer', 'gone', 'fillet'] },
      flickWindow: 9000,
    });
    expect(r.config.rings.edge).toEqual(['chamfer', 'fillet', null, null, null, null, null]);
    expect(r.dropped).toEqual(['gone']);
    expect(r.config.flickWindow).toBe(400);
    expect(parseRadialConfig({ flickWindow: -5 }).config.flickWindow).toBe(0);
    expect(parseRadialConfig({ flickWindow: 'x' }).config.flickWindow).toBe(250);
  });

  it('ignores data from a newer version and survives garbage', () => {
    expect(parseRadialConfig({ version: 9, rings: { face: ['hole'] } }).newer).toBe(true);
    expect(parseRadialConfig(null).config).toEqual(DEFAULT_RADIAL_CONFIG);
    expect(parseRadialConfig([1, 2]).config).toEqual(DEFAULT_RADIAL_CONFIG);
    localStorage.setItem(RADIAL_KEY, '{not json');
    resetRadialCache();
    expect(loadRadialConfig().config).toEqual(DEFAULT_RADIAL_CONFIG);
  });
});
