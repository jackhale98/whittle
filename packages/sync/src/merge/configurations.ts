// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Part configurations in the structural merge and the compare (M3.7, ADR-074).
 *
 * A configuration is an id-keyed record of sparse overrides over the part's implicit Default.
 * Every override is a **cell**, addressed by id (never by name):
 *  - `(configuration, param paramId)`: `configurations/<cid>/params/<paramId>`;
 *  - `(configuration, feature featureId, suppressed)`: `.../features/<fid>/suppressed`;
 *  - `(configuration, feature featureId, field pointer)`: `.../features/<fid>/fields/<pointer>`;
 *  - `(configuration, material | color | property key)`: `.../material`, `.../color`,
 *    `.../properties/<key>`.
 *
 * The merge (`merge.ts`) walks configurations like any other id-keyed collection, with three
 * configuration rules from here:
 *  - **Records where absent = empty** (`isConfigRecordPath`): a configuration's `params`,
 *    `features`, one feature's override, its `fields` and `properties`, and `Part.properties`.
 *    Two sides adding different cells to a record nobody had merge cell by cell, and a record
 *    left empty by the merge is dropped (sparse, as the commands keep it).
 *  - **Cells are leaves** (`isConfigCellPath`): a material override is one value. Both sides
 *    setting a cell differently is `bothModified` even when base had no override (it inherited);
 *    one side setting a cell the other reset (removed the override) is `modifiedDeleted`.
 *  - **`activeConfigurationId` is a plain field** whose absence means Default: two different
 *    choices are `bothModified`, never `modifiedDeleted`.
 *
 * After the walk, `reconcileConfigurations` makes the merged document coherent and says what it
 * did in the merge report: overrides of a feature or parameter the merge deleted are dropped
 * (mirroring the document commands), an active configuration that no longer exists falls back to
 * Default, and configurations that ended up sharing a name are flagged (both ids are kept).
 */

import type { Configuration, DiffSubject, Id, Material, Part, WrenDoc } from '@wren-cad/contracts';
import { featureDims, formatValue, type Units } from './format';
import { equal, fromPointer, isObj, type Obj, type Segs } from './tree';

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

const RECORD_KEYS = new Set(['params', 'features', 'properties']);

/** Whether `segs` is inside a configuration: `['parts', pid, 'configurations', cid, ...]`. */
export function isConfigurationPath(segs: Segs): boolean {
  return segs.length >= 4 && segs[0] === 'parts' && segs[2] === 'configurations';
}

/** `['parts', pid, 'activeConfigurationId']`. */
export function isActiveConfigurationPath(segs: Segs): boolean {
  return segs.length === 3 && segs[0] === 'parts' && segs[2] === 'activeConfigurationId';
}

/** `['parts', pid, 'properties', ...]`: the Default's part properties. */
export function isPartPropertiesPath(segs: Segs): boolean {
  return segs.length >= 3 && segs[0] === 'parts' && segs[2] === 'properties';
}

/** Whether merge, labels or the compare treat `segs` with the configuration rules. */
export function isConfigurationValuePath(segs: Segs): boolean {
  return (
    (segs.length >= 3 && segs[0] === 'parts' && segs[2] === 'configurations') ||
    isActiveConfigurationPath(segs) ||
    isPartPropertiesPath(segs)
  );
}

/** A record whose absence means "empty" (so cells added on two sides merge one by one). */
export function isConfigRecordPath(segs: Segs): boolean {
  if (segs.length === 3) return isPartPropertiesPath(segs);
  if (!isConfigurationPath(segs)) return false;
  const key = segs[4];
  if (segs.length === 5) return RECORD_KEYS.has(key as string);
  if (key !== 'features') return false;
  return segs.length === 6 || (segs.length === 7 && segs[6] === 'fields');
}

/** An override cell (or a Default part property): always one leaf value. */
export function isConfigCellPath(segs: Segs): boolean {
  if (segs.length === 4 && isPartPropertiesPath(segs)) return true;
  if (!isConfigurationPath(segs)) return false;
  const key = segs[4];
  switch (segs.length) {
    case 5:
      return key === 'material' || key === 'color';
    case 6:
      return key === 'params' || key === 'properties';
    case 7:
      return key === 'features' && segs[6] === 'suppressed';
    case 8:
      return key === 'features' && segs[6] === 'fields';
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------------

/** One override of a configuration; `rel` is its path inside the configuration. */
export interface Cell {
  rel: string[];
  value: unknown;
}

/** Every override cell of a configuration, in a stable order. */
export function cellsOf(config: Configuration | undefined): Cell[] {
  const out: Cell[] = [];
  if (config === undefined) return out;
  for (const [pid, v] of sorted(config.params)) out.push({ rel: ['params', pid], value: v });
  for (const [fid, o] of sorted(config.features)) {
    if (!isObj(o)) continue;
    if (o.suppressed !== undefined) {
      out.push({ rel: ['features', fid, 'suppressed'], value: o.suppressed });
    }
    for (const [ptr, v] of sorted(o.fields as Obj | undefined)) {
      out.push({ rel: ['features', fid, 'fields', ptr], value: v });
    }
  }
  if (config.material !== undefined) out.push({ rel: ['material'], value: config.material });
  if (config.color !== undefined) out.push({ rel: ['color'], value: config.color });
  for (const [k, v] of sorted(config.properties as Obj | undefined)) {
    out.push({ rel: ['properties', k], value: v });
  }
  return out;
}

function sorted(record: object | undefined): [string, unknown][] {
  if (!isObj(record)) return [];
  return Object.entries(record)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The value at a JSON pointer inside a feature, or `undefined`. */
export function atPointer(root: unknown, pointer: string): unknown {
  let segs: string[];
  try {
    segs = fromPointer(pointer);
  } catch {
    return undefined;
  }
  let node = root;
  for (const s of segs) {
    if (isObj(node)) node = node[s];
    else if (Array.isArray(node) && /^\d+$/.test(s)) node = node[Number(s)];
    else return undefined;
  }
  return node;
}

/**
 * The Default's value of the cell at `rel` (inside a configuration of `part`), i.e. what the
 * configuration inherits when it doesn't override it. `known: false` when the target is gone.
 */
export function cellDefault(
  doc: WrenDoc | undefined,
  part: Part | undefined,
  rel: Segs,
): { known: boolean; value: unknown } {
  const none = { known: false, value: undefined };
  if (doc === undefined || part === undefined) return none;
  const [key, a, b, c] = rel;
  switch (key) {
    case 'params': {
      const p = doc.params.find((x) => x.id === a);
      return p ? { known: true, value: p.expr } : none;
    }
    case 'features': {
      const f = part.features.find((x) => x.id === a);
      if (!f) return none;
      if (b === 'suppressed') return { known: true, value: f.suppressed === true };
      const v = c === undefined ? undefined : atPointer(f, c);
      return v === undefined ? none : { known: true, value: v };
    }
    case 'material':
      return { known: true, value: part.material ?? null };
    case 'color':
      return part.color === undefined ? none : { known: true, value: part.color };
    case 'properties': {
      const v = a === undefined ? undefined : (part.properties as Obj | undefined)?.[a];
      return v === undefined ? none : { known: true, value: v };
    }
    default:
      return none;
  }
}

/** Short text for one cell value: "45 mm", "on", "Steel", "no material". */
export function cellText(
  rel: Segs,
  value: unknown,
  units?: Units,
  part?: Part,
  doc?: WrenDoc,
): string {
  const [key, a, , c] = rel;
  if (key === 'material') {
    if (value === null || value === undefined) return 'no material';
    return isObj(value) ? String((value as unknown as Material).name ?? 'material') : 'changed';
  }
  if (key === 'features' && c !== undefined) {
    const f = part?.features.find((x) => x.id === a);
    const dim = f ? featureDims(f).get(c) : undefined;
    return formatValue(value, units ?? doc?.units, dim) ?? 'changed';
  }
  return formatValue(value, units ?? doc?.units) ?? 'changed';
}

/** "default (40 mm)", or "default" when the target's Default value is unknown. */
export function defaultText(rel: Segs, doc: WrenDoc | undefined, part: Part | undefined): string {
  const d = cellDefault(doc, part, rel);
  return d.known ? `default (${cellText(rel, d.value, doc?.units, part, doc)})` : 'default';
}

const partIn = (doc: WrenDoc | undefined, pid: string): Part | undefined =>
  doc?.parts.find((p) => p.id === pid);

function configIn(doc: WrenDoc | undefined, pid: string, cid: string): Configuration | undefined {
  return partIn(doc, pid)?.configurations?.find((c) => c.id === cid);
}

/** A configuration's name in the first version that has it ("Default" for none). */
export function configurationName(
  docs: readonly (WrenDoc | undefined)[],
  pid: string,
  cid: string | undefined,
): string {
  if (cid === undefined) return 'Default';
  for (const d of docs) {
    const c = configIn(d, pid, cid);
    if (c) return c.name;
  }
  return cid;
}

/**
 * Text for one side of a conflict on a configuration value, read in the version that has it
 * (`docs`: ours, theirs, base). `undefined` for paths these rules don't cover.
 */
export function configurationValueText(
  segs: Segs,
  value: unknown,
  docs: readonly (WrenDoc | undefined)[],
): string | undefined {
  const pid = segs[1] as string;
  if (isActiveConfigurationPath(segs)) {
    return configurationName(docs, pid, typeof value === 'string' ? value : undefined);
  }
  const first = docs.find((d) => partIn(d, pid) !== undefined);
  const part = partIn(first, pid);
  if (isPartPropertiesPath(segs)) {
    if (segs.length !== 4) return undefined;
    return value === undefined ? 'none' : (formatValue(value) ?? 'changed');
  }
  if (segs.length === 3) {
    // Configuration order: the names, in that order.
    if (!Array.isArray(value)) return undefined;
    return value.map((cid) => configurationName(docs, pid, cid as string)).join(', ');
  }
  if (segs.length === 4) {
    if (!isObj(value)) return 'deleted';
    const c = value as unknown as Configuration;
    const n = cellsOf(c).length;
    return `${c.name} (${n === 1 ? '1 override' : `${n} overrides`})`;
  }
  if (segs.length === 5 && segs[4] === 'name') return typeof value === 'string' ? value : 'none';
  if (!isConfigCellPath(segs)) return value === undefined ? 'none' : undefined;
  const rel = segs.slice(4);
  if (value === undefined) {
    // The configuration's target in the version that still has it, for the Default value.
    const doc = docs.find((d) => cellDefault(d, partIn(d, pid), rel).known) ?? first;
    return defaultText(rel, doc, partIn(doc, pid));
  }
  return cellText(rel, value, first?.units, part, first);
}

// ---------------------------------------------------------------------------------------------
// Reconciling a merged document
// ---------------------------------------------------------------------------------------------

export type ConfigurationNoteKind =
  /** Overrides of a feature or parameter the merge deleted were dropped with it. */
  | 'configurationOverridesRemoved'
  /** Two or more configurations of a part share a name after the merge (both ids are kept). */
  | 'configurationDuplicateName'
  /** The merged active configuration no longer exists: the part is on Default again. */
  | 'activeConfigurationFallback';

export interface ConfigurationNote {
  kind: ConfigurationNoteKind;
  partId: Id;
  /** The configuration(s) it is about. */
  configurationIds: Id[];
  /** For `configurationOverridesRemoved`: the deleted feature or parameter. */
  targetId?: Id;
  /** The overrides that were dropped (cells relative to the configuration). */
  removed?: Cell[];
  subject: DiffSubject;
  summary: string;
}

/** The inputs of a merge, for names and to tell a side's own state from what the merge made. */
export interface ReconcileSides {
  base: WrenDoc;
  ours: WrenDoc;
  theirs: WrenDoc;
}

type Group = 'features' | 'params';

function groupOf(doc: WrenDoc | undefined, pid: string, cid: string, g: Group, target: string) {
  const c = configIn(doc, pid, cid);
  return (c?.[g] as Obj | undefined)?.[target];
}

const countCells = (g: Group, v: unknown): number => {
  if (g === 'params') return 1;
  if (!isObj(v)) return 0;
  const fields = isObj(v.fields) ? Object.keys(v.fields).length : 0;
  return (v.suppressed === undefined ? 0 : 1) + fields;
};

/**
 * Makes the merged `doc` coherent (mutating it) and returns the merge-report notes:
 *  1. An override group (one configuration's overrides of one feature, or of one parameter)
 *     whose target the merge deleted is dropped. "The merge deleted it" means: the target is
 *     gone from the merged document, some version had it, and the merged group is not just the
 *     group of a side that itself lacks the target (that side's own state, left alone).
 *  2. An active configuration that no longer exists (but did in some version) falls back to
 *     Default.
 *  3. Configurations that share a name although neither side had that duplicate are flagged.
 */
export function reconcileConfigurations(doc: WrenDoc, sides: ReconcileSides): ConfigurationNote[] {
  const notes: ConfigurationNote[] = [];
  const { base, ours, theirs } = sides;
  const all = [ours, theirs, base];
  const liveParams = new Set(doc.params.map((p) => p.id));
  const known = (pid: string, g: Group, target: string): boolean =>
    all.some((d) =>
      g === 'params'
        ? d.params.some((p) => p.id === target)
        : (partIn(d, pid)?.features.some((f) => f.id === target) ?? false),
    );
  const has = (d: WrenDoc, pid: string, g: Group, target: string): boolean =>
    g === 'params'
      ? d.params.some((p) => p.id === target)
      : (partIn(d, pid)?.features.some((f) => f.id === target) ?? false);
  const targetName = (pid: string, g: Group, target: string): string => {
    for (const d of [doc, ...all]) {
      const x =
        g === 'params'
          ? d.params.find((p) => p.id === target)
          : partIn(d, pid)?.features.find((f) => f.id === target);
      if (x) return x.name;
    }
    return target;
  };

  for (const part of doc.parts) {
    const pid = part.id;
    const live = new Set(part.features.map((f) => f.id));
    for (const config of part.configurations ?? []) {
      for (const g of ['features', 'params'] as const) {
        const record = config[g] as Obj | undefined;
        if (!isObj(record)) continue;
        for (const target of Object.keys(record).sort()) {
          const alive = g === 'params' ? liveParams.has(target) : live.has(target);
          if (alive || !known(pid, g, target)) continue;
          const merged = record[target];
          const own = [ours, theirs].some(
            (s) => !has(s, pid, g, target) && equal(groupOf(s, pid, config.id, g, target), merged),
          );
          if (own) continue;
          delete record[target];
          const n = countCells(g, merged);
          const name = targetName(pid, g, target);
          const what = g === 'params' ? 'parameter' : 'feature';
          const removed = cellsOf({ id: config.id, name: config.name, [g]: { [target]: merged } });
          notes.push({
            kind: 'configurationOverridesRemoved',
            partId: pid,
            configurationIds: [config.id],
            targetId: target,
            removed,
            subject: { kind: 'part', id: pid, label: `Configuration ${config.name}` },
            summary:
              n === 1
                ? `The override of ${name} in ${config.name} was removed with the ${what}`
                : `Overrides of ${name} in ${config.name} were removed with the ${what}`,
          });
        }
        if (Object.keys(record).length === 0) delete config[g];
      }
    }

    // 2. The active configuration.
    const active = part.activeConfigurationId;
    const ids = new Set((part.configurations ?? []).map((c) => c.id));
    if (active !== undefined && !ids.has(active)) {
      const existed = all.some((d) => configIn(d, pid, active) !== undefined);
      if (existed) {
        delete part.activeConfigurationId;
        const name = configurationName(all, pid, active);
        notes.push({
          kind: 'activeConfigurationFallback',
          partId: pid,
          configurationIds: [active],
          subject: { kind: 'part', id: pid, label: 'Active configuration' },
          summary: `The active configuration ${name} of ${part.name} was deleted, so ${part.name} is on Default now`,
        });
      }
    }

    // 3. Duplicate names the merge made.
    const byName = new Map<string, Configuration[]>();
    for (const c of part.configurations ?? []) {
      byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
    }
    for (const [name, group] of byName) {
      if (group.length < 2) continue;
      const before = all.some(
        (d) => (partIn(d, pid)?.configurations ?? []).filter((c) => c.name === name).length > 1,
      );
      if (before) continue;
      const added = group.every((c) => configIn(base, pid, c.id) === undefined);
      const n = group.length;
      const kept = n === 2 ? 'both are kept' : 'all are kept';
      notes.push({
        kind: 'configurationDuplicateName',
        partId: pid,
        configurationIds: group.map((c) => c.id).sort(),
        subject: { kind: 'part', id: pid, label: `Configuration ${name}` },
        summary: added
          ? `Both sides added a configuration named ${name} to ${part.name}; ${kept}. Rename one to tell them apart`
          : `${n} configurations of ${part.name} are named ${name} after the merge; ${kept}. Rename one to tell them apart`,
      });
    }
  }
  return notes;
}

/**
 * The same rules for a result patched by path (`resolve` without the merge inputs): drops an
 * override group whose target is gone when the resolution removed the target or wrote the group,
 * falls back from an active configuration the resolution removed, and drops override records the
 * resolution left empty. `before` is the merged document the resolutions were applied to.
 */
export function reconcileResolved(doc: WrenDoc, before: WrenDoc): void {
  const liveParams = new Set(doc.params.map((p) => p.id));
  const hadParams = new Set(before.params.map((p) => p.id));
  for (const part of doc.parts) {
    const prev = partIn(before, part.id);
    const live = new Set(part.features.map((f) => f.id));
    const had = new Set(prev?.features.map((f) => f.id) ?? []);
    for (const config of part.configurations ?? []) {
      const old = prev?.configurations?.find((c) => c.id === config.id);
      if (equal(old, config)) continue;
      for (const g of ['features', 'params'] as const) {
        const record = config[g] as Obj | undefined;
        if (!isObj(record)) continue;
        for (const target of Object.keys(record)) {
          const alive = g === 'params' ? liveParams.has(target) : live.has(target);
          if (alive) continue;
          const removed = g === 'params' ? hadParams.has(target) : had.has(target);
          const wrote = !equal((old?.[g] as Obj | undefined)?.[target], record[target]);
          if (removed || wrote) delete record[target];
        }
      }
      tidyConfiguration(config);
    }
    const active = part.activeConfigurationId;
    if (active !== undefined && !(part.configurations ?? []).some((c) => c.id === active)) {
      const was = prev?.configurations?.some((c) => c.id === active) ?? false;
      if (was || prev?.activeConfigurationId !== active) delete part.activeConfigurationId;
    }
    if (isObj(part.properties) && Object.keys(part.properties).length === 0) {
      if (!isObj(prev?.properties)) delete part.properties;
    }
  }
}

/** Removes empty override records (`params: {}`, a feature override with nothing in it). */
export function tidyConfiguration(config: Configuration): void {
  const c = config as unknown as Obj;
  const features = c.features;
  if (isObj(features)) {
    for (const [fid, o] of Object.entries(features)) {
      if (!isObj(o)) continue;
      if (isObj(o.fields) && Object.keys(o.fields).length === 0) delete o.fields;
      if (Object.keys(o).every((k) => o[k] === undefined)) delete features[fid];
    }
  }
  for (const k of ['params', 'features', 'properties']) {
    const r = c[k];
    if (isObj(r) && Object.keys(r).every((x) => r[x] === undefined)) delete c[k];
  }
}
