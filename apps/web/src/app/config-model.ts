/**
 * Pure logic of the M3.7 configuration UI (ADR-074): the table model, edit scope at the point of
 * edit, statuses of configurations, and the plans the workbench turns into commands. No React, no
 * workbench: unit-tested in `config-model.test.ts`.
 */

import type {
  BodyResult,
  ConfigTarget,
  Configuration,
  ConfiguredValue,
  Feature,
  FeatureStatus,
  Id,
  Material,
  Part,
  PartProperties,
  WrenDoc,
} from '@wren-cad/contracts';
import {
  type ConfigurableField,
  type ConfigurationIssue,
  configurableFields,
  getAt,
  jsonEqual,
  parsePointer,
  partNumberFor,
} from '@wren-cad/document';
import {
  type CellValue,
  type ConfigColumn,
  type ConfigStatus,
  type ConfigTableDefault,
  type ConfigTableRow,
  configTargetKey,
} from '@wren-cad/ui';
import { docKey } from '../doc/mesh-cache';

/** Key of Default in maps of builds; every other configuration is keyed by its id. */
export const DEFAULT_KEY = 'default';
export const keyOf = (id: Id | null): string => id ?? DEFAULT_KEY;

/** The regen slot of a background build of a configuration (`null` = Default). */
export const slotOf = (id: Id | null): `config:${string}` => `config:${keyOf(id)}`;

export const activeIdOf = (part: Part | null | undefined): Id | null =>
  part?.activeConfigurationId ?? null;

/** The active id names a configuration the part does not have (trap T2: never a silent Default). */
export const isMissingActive = (part: Part | null | undefined): boolean => {
  const id = activeIdOf(part);
  return id !== null && !(part?.configurations ?? []).some((c) => c.id === id);
};

/**
 * What a regen reads, without the configuration data itself: two configurations that resolve to
 * the same values have the same key, whatever the other configurations override.
 */
export function valueKey(resolved: WrenDoc): string {
  const part = resolved.parts[0];
  if (!part) return docKey(resolved);
  const {
    configurations: _c,
    activeConfigurationId: _a,
    properties: _p,
    folders: _f,
    color: _col,
    ...rest
  } = part;
  return docKey({ ...resolved, parts: [rest as Part] });
}

/* --------------------------------------------------------------------------- mass */

export interface MassSummaryView {
  volume: number;
  area: number;
  mass?: number;
  centroid: [number, number, number];
}

/** Volume, area, mass and centroid of a result's bodies together. */
export function summarizeMass(
  bodies: readonly Pick<BodyResult, 'massProperties'>[],
): MassSummaryView | undefined {
  const props = bodies.flatMap((b) => (b.massProperties ? [b.massProperties] : []));
  if (props.length === 0) return undefined;
  let volume = 0;
  let area = 0;
  let mass = 0;
  let hasMass = false;
  const c: [number, number, number] = [0, 0, 0];
  for (const p of props) {
    volume += p.volume;
    area += p.area;
    if (p.mass !== undefined) {
      mass += p.mass;
      hasMass = true;
    }
    for (let k = 0; k < 3; k++) c[k] = (c[k] as number) + (p.centroid[k] as number) * p.volume;
  }
  const centroid: [number, number, number] =
    volume > 0 ? [c[0] / volume, c[1] / volume, c[2] / volume] : [0, 0, 0];
  return { volume, area, centroid, ...(hasMass ? { mass } : {}) };
}

/* ------------------------------------------------------------------------ statuses */

const featureOfIssue = (i: ConfigurationIssue): Id | null =>
  i.target.kind === 'field' || i.target.kind === 'suppressed' ? i.target.featureId : null;

/**
 * The regen statuses with the configuration's issues merged in: a feature whose override no longer
 * applies is "needs attention" for this configuration, with the cause as its message. A feature
 * that failed in the kernel keeps its error.
 */
export function mergeIssueStatuses(
  statuses: readonly FeatureStatus[],
  issues: readonly ConfigurationIssue[],
  configurationName: string,
): FeatureStatus[] {
  const byFeature = new Map<Id, string[]>();
  for (const i of issues) {
    const f = featureOfIssue(i);
    if (f) byFeature.set(f, [...(byFeature.get(f) ?? []), i.reason]);
  }
  if (byFeature.size === 0) return statuses as FeatureStatus[];
  return statuses.map((s) => {
    const reasons = byFeature.get(s.featureId);
    if (!reasons || s.state === 'error' || s.state === 'rolledBack') return s;
    return {
      ...s,
      state: 'needsAttention',
      error: {
        code: 'INVALID_INPUT',
        message: `In ${configurationName}: ${reasons.join('; ')}.`,
        hint: `Fix or reset the override in ${configurationName}.`,
      },
    };
  });
}

/** Issues that cannot be shown on a feature (parameters, material, properties, the name). */
export function partLevelIssues(issues: readonly ConfigurationIssue[]): ConfigurationIssue[] {
  return issues.filter((i) => featureOfIssue(i) === null);
}

/** One status word for a configuration from the statuses of its regen and its issues. */
export function configStatusOf(
  statuses: readonly FeatureStatus[] | undefined,
  issues: readonly ConfigurationIssue[],
  nameOf: (id: Id) => string,
): { status: ConfigStatus; message?: string } {
  if (!statuses) return { status: 'unbuilt' };
  for (const s of statuses) {
    if (s.state === 'error') {
      return {
        status: 'failed',
        message: `${nameOf(s.featureId)}: ${s.error?.message ?? 'failed to rebuild'}`,
      };
    }
  }
  const issue = issues[0];
  if (issue) return { status: 'attention', message: issue.reason };
  for (const s of statuses) {
    if (s.state === 'needsAttention') {
      return { status: 'attention', message: `${nameOf(s.featureId)} needs attention` };
    }
    if (s.state === 'blocked') {
      return {
        status: 'attention',
        message: `${nameOf(s.featureId)} is waiting on a failed feature`,
      };
    }
  }
  return { status: 'ok' };
}

/* -------------------------------------------------------------------- override reads */

/** Whether `config` overrides `target`, and the value it sets. */
export function overrideIn(
  config: Configuration | undefined,
  target: ConfigTarget,
): { has: boolean; value?: ConfiguredValue | Material | null } {
  if (!config) return { has: false };
  switch (target.kind) {
    case 'param': {
      const v = config.params?.[target.paramId];
      return v === undefined ? { has: false } : { has: true, value: v };
    }
    case 'field': {
      const v = config.features?.[target.featureId]?.fields?.[target.path];
      return v === undefined ? { has: false } : { has: true, value: v };
    }
    case 'suppressed': {
      const v = config.features?.[target.featureId]?.suppressed;
      return v === undefined ? { has: false } : { has: true, value: v };
    }
    case 'material':
      return config.material === undefined ? { has: false } : { has: true, value: config.material };
    case 'color':
      return config.color === undefined ? { has: false } : { has: true, value: config.color };
    case 'property': {
      const v = config.properties?.[target.key];
      return v === undefined ? { has: false } : { has: true, value: v };
    }
  }
}

/** How many configurations, Default included, see Default's value of `target` ("Changed in all N"). */
export function inheritCount(part: Part, target: ConfigTarget): number {
  return 1 + (part.configurations ?? []).filter((c) => !overrideIn(c, target).has).length;
}

/* ----------------------------------------------------------------- scoped feature edit */

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const esc = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** Pointers where `a` and `b` differ (leaves; a whole array or object when its shape differs). */
export function changedPointers(a: unknown, b: unknown, at = ''): string[] {
  if (jsonEqual(a, b)) return [];
  if (isRec(a) && isRec(b)) {
    const out: string[] = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      out.push(...changedPointers(a[k], b[k], `${at}/${esc(k)}`));
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((x, i) => changedPointers(x, b[i], `${at}/${i}`));
  }
  return [at];
}

function readAt(v: unknown, pointer: string): { has: boolean; value?: unknown } {
  try {
    return { has: true, value: getAt(v, pointer) };
  } catch {
    return { has: false };
  }
}

/** Sets (or, with `has: false`, deletes) the value at a pointer of a cloned structure. */
function writeAt(root: unknown, pointer: string, has: boolean, value: unknown): void {
  const segs = parsePointer(pointer);
  let cur = root as Record<string, unknown>;
  for (const seg of segs.slice(0, -1)) {
    const next = cur[seg];
    if (typeof next !== 'object' || next === null) return;
    cur = next as Record<string, unknown>;
  }
  const last = segs[segs.length - 1];
  if (last === undefined) return;
  if (has) cur[last] = structuredClone(value);
  else if (Array.isArray(cur)) cur.splice(Number(last), 1);
  else delete cur[last];
}

export interface FeatureEditPlan {
  /** Default's feature after the edit, or `null` when Default does not change. */
  defaultFeature: Feature | null;
  /** Override writes for the active configuration; `value` absent clears the override. */
  overrides: { path: string; value?: ConfiguredValue }[];
  /** The Default change reaches configurations that inherit: what the notice counts (first). */
  inherited: ConfigTarget | null;
}

const isConfigured = (v: unknown): v is ConfiguredValue =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/**
 * Where one edit of a feature lands (trap T1: decided now, nothing remembered). `effective` is the
 * feature as the active configuration shows it (what the inspector edited), `next` its new
 * version. A changed field the active configuration overrides, or any configurable field while
 * the one-shot chip is on, becomes an override; everything else edits Default.
 */
export function planFeatureEdit(
  raw: Feature,
  effective: Feature,
  next: Feature,
  config: Configuration | undefined,
  chip: boolean,
): FeatureEditPlan {
  const changed = changedPointers(effective, next);
  if (changed.length === 0) return { defaultFeature: null, overrides: [], inherited: null };
  if (!config) {
    return {
      defaultFeature: jsonEqual(next, raw) ? null : next,
      overrides: [],
      inherited: null,
    };
  }
  const configurable = new Set(
    [...configurableFields(effective), ...configurableFields(next)].map((f) => f.pointer),
  );
  const owned = new Set(Object.keys(config.features?.[raw.id]?.fields ?? {}));
  const overrides: FeatureEditPlan['overrides'] = [];
  const toDefault: string[] = [];
  const implied: string[] = [];
  for (const p of changed) {
    const to = readAt(next, p);
    const routed =
      configurable.has(p) && (owned.has(p) || chip) && (!to.has || isConfigured(to.value));
    if (!routed) {
      toDefault.push(p);
    } else if (!to.has) {
      implied.push(p); // dropped by an option change in this configuration: resolution re-derives it
    } else {
      const base = readAt(raw, p);
      const same = base.has && jsonEqual(base.value, to.value);
      overrides.push(same ? { path: p } : { path: p, value: to.value as ConfiguredValue });
    }
  }
  // Removals follow their option into the configuration only when something was routed there.
  const removals = overrides.length > 0 ? [] : implied;
  const copy = structuredClone(raw) as unknown;
  for (const p of [...toDefault, ...removals]) {
    const to = readAt(next, p);
    writeAt(copy, p, to.has, to.value);
  }
  const defaultFeature = jsonEqual(copy, raw) ? null : (copy as Feature);
  const first = toDefault.find((p) => configurable.has(p));
  return {
    defaultFeature,
    overrides,
    inherited: first ? { kind: 'field', featureId: raw.id, path: first } : null,
  };
}

/* ------------------------------------------------------------------------- the table */

const humanPointer = (pointer: string): string =>
  pointer
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/([a-z])([A-Z])/g, '$1 $2'))
    .join(' ')
    .toLowerCase();

const stringOption = (v: ConfiguredValue): string => String(v);

export interface TableModel {
  columns: ConfigColumn[];
  defaultRow: ConfigTableDefault;
  /** Rows without status or mass (the workbench adds them). */
  rows: ConfigTableRow[];
  /** Per column key: the typed value of each option string (booleans, numbers). */
  optionValues: Map<string, Map<string, ConfiguredValue>>;
}

const cellOf = (
  target: ConfigTarget,
  v: unknown,
  optionKey?: Map<string, ConfiguredValue>,
): CellValue => {
  if (v === undefined) return undefined;
  if (target.kind === 'field' && optionKey && isConfigured(v)) return stringOption(v);
  return v as CellValue;
};

/**
 * The table's columns, Default's values and the configurations' overrides from the document:
 * parameters, every feature's configurable fields, suppression per feature, material, colour,
 * part number and description. The table computes nothing; this is where the app decides.
 */
export function buildTableModel(doc: WrenDoc, part: Part, lengthUnit: string): TableModel {
  const columns: ConfigColumn[] = [];
  const optionValues = new Map<string, Map<string, ConfiguredValue>>();
  const defaults: Record<string, CellValue> = {};
  const placeholders: Record<string, string> = {};

  for (const p of doc.params) {
    const target: ConfigTarget = { kind: 'param', paramId: p.id };
    columns.push({ target, label: p.name, kind: 'expr' });
    defaults[configTargetKey(target)] = p.expr;
  }
  for (const f of part.features) {
    let fields: ConfigurableField[] = [];
    try {
      fields = configurableFields(f);
    } catch {
      fields = [];
    }
    for (const field of fields) {
      const target: ConfigTarget = { kind: 'field', featureId: f.id, path: field.pointer };
      const key = configTargetKey(target);
      const raw = readAt(f, field.pointer);
      if (field.kind === 'expr') {
        columns.push({
          target,
          label: `${f.name} ${humanPointer(field.pointer)}`,
          kind: 'expr',
          ...(field.expected === 'length' ? { unit: lengthUnit } : {}),
        });
        if (raw.has) defaults[key] = raw.value as CellValue;
      } else {
        const typed = new Map(field.values.map((v) => [stringOption(v), v] as const));
        optionValues.set(key, typed);
        columns.push({
          target,
          label: `${f.name} ${field.label.toLowerCase()}`,
          kind: 'option',
          options: field.values.map((v) => ({ value: stringOption(v) })),
        });
        if (raw.has && isConfigured(raw.value)) defaults[key] = stringOption(raw.value);
      }
    }
  }
  for (const f of part.features) {
    const target: ConfigTarget = { kind: 'suppressed', featureId: f.id };
    columns.push({ target, label: f.name, kind: 'bool' });
    defaults[configTargetKey(target)] = f.suppressed === true;
  }
  const material: ConfigTarget = { kind: 'material' };
  columns.push({ target: material, label: 'Material', kind: 'material' });
  defaults[configTargetKey(material)] = part.material ?? null;
  const color: ConfigTarget = { kind: 'color' };
  columns.push({ target: color, label: 'Colour', kind: 'text' });
  defaults[configTargetKey(color)] = part.color ?? '';
  for (const key of ['partNumber', 'description'] as const) {
    const target: ConfigTarget = { kind: 'property', key };
    columns.push({
      target,
      label: key === 'partNumber' ? 'Part number' : 'Description',
      kind: 'text',
    });
    defaults[configTargetKey(target)] = part.properties?.[key] ?? '';
  }
  placeholders[configTargetKey({ kind: 'property', key: 'partNumber' })] = partNumberFor(
    doc,
    part.id,
    null,
  );

  const rows: ConfigTableRow[] = (part.configurations ?? []).map((c) => {
    const overrides: Record<string, CellValue> = {};
    const ph: Record<string, string> = {};
    for (const col of columns) {
      const o = overrideIn(c, col.target);
      const key = configTargetKey(col.target);
      if (o.has) overrides[key] = cellOf(col.target, o.value, optionValues.get(key));
    }
    ph[configTargetKey({ kind: 'property', key: 'partNumber' })] = partNumberFor(
      doc,
      part.id,
      c.id,
    );
    return { id: c.id, name: c.name, status: 'unbuilt', overrides, placeholders: ph };
  });

  return {
    columns,
    defaultRow: { values: defaults, placeholders },
    rows,
    optionValues,
  };
}

/** The typed value behind a table cell's option string. */
export function typedOption(
  model: Pick<TableModel, 'optionValues'>,
  target: ConfigTarget,
  value: unknown,
): ConfiguredValue | undefined {
  if (target.kind !== 'field') return isConfigured(value) ? value : undefined;
  const typed = model.optionValues.get(configTargetKey(target));
  if (typed && typeof value === 'string') return typed.get(value);
  return isConfigured(value) ? value : undefined;
}

/** Builds a configuration from paste edits: a new row starts with exactly the pasted overrides. */
export function configurationFromEdits(
  id: Id,
  name: string,
  edits: readonly { target: ConfigTarget; value?: ConfiguredValue | Material | null }[],
): Configuration {
  const c: Configuration = { id, name };
  for (const e of edits) {
    if (e.value === undefined) continue;
    const t = e.target;
    switch (t.kind) {
      case 'param':
        c.params = { ...c.params, [t.paramId]: String(e.value) };
        break;
      case 'field': {
        const cur = c.features?.[t.featureId] ?? {};
        c.features = {
          ...c.features,
          [t.featureId]: {
            ...cur,
            fields: { ...cur.fields, [t.path]: e.value as ConfiguredValue },
          },
        };
        break;
      }
      case 'suppressed': {
        const cur = c.features?.[t.featureId] ?? {};
        c.features = { ...c.features, [t.featureId]: { ...cur, suppressed: e.value === true } };
        break;
      }
      case 'material':
        c.material = e.value === null ? null : (e.value as Material);
        break;
      case 'color':
        c.color = String(e.value);
        break;
      case 'property':
        c.properties = { ...c.properties, [t.key]: String(e.value) } as PartProperties;
        break;
    }
  }
  return c;
}
