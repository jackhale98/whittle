// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Part configurations (M3.7, ADR-074): which fields can be configured, resolving a configuration
 * into the effective document for regen, pruning overrides whose target was deleted, and part
 * numbers / export file names.
 *
 * Resolution is pure and deterministic. It never throws on a stale override: every override that
 * cannot be applied is reported as a `ConfigurationIssue` (regen turns those into "needs
 * attention" for that configuration), and nothing is dropped silently.
 */

import type {
  Annotation,
  AnnotationOverride,
  ConfigTarget,
  Configuration,
  ConfiguredValue,
  Feature,
  FeatureOverride,
  FeatureType,
  Id,
  JsonPatchOp,
  Material,
  NamedDimension,
  Part,
  PartProperties,
  WrenDoc,
} from '@wren-cad/contracts';
import {
  ANNOTATION_CONFIGURABLE_OPTIONS,
  annotationExprFields,
  annotationOptionAt,
} from './annotation-fields';
import { exprFields } from './features';
import { HOLE_TABLES } from './hole-tables';
import { applyPatch, diff, existsAt, getAt, parsePointer } from './patch';

// ---------------------------------------------------------------------------------------------
// Configurable fields (owner D2)
// ---------------------------------------------------------------------------------------------

/** A configurable option (enum / boolean) field of a feature type. */
export interface ConfigurableOption {
  /** JSON pointer inside the feature. */
  pointer: string;
  /** Short UI label. */
  label: string;
  /** The allowed values, or a function of the feature when they depend on it (hole sizes). */
  values: readonly ConfiguredValue[] | ((feature: Feature) => readonly ConfiguredValue[]);
}

/** A field a configuration may override. */
export type ConfigurableField =
  | { kind: 'expr'; pointer: string; expected: NamedDimension }
  | { kind: 'option'; pointer: string; label: string; values: readonly ConfiguredValue[] };

const OPS = ['new', 'add', 'cut', 'intersect'] as const;
const DIRECTIONS = ['normal', 'reverse', 'symmetric'] as const;
/** `upTo` needs a topological target, so it is not a configurable end kind. */
const END_KINDS = ['blind', 'throughAll'] as const;
const BOOLS = [true, false] as const;

const holeSizes = (f: Feature): readonly ConfiguredValue[] =>
  f.type === 'hole' || f.type === 'thread'
    ? (HOLE_TABLES[f.standard]?.rows.map((r) => r.size) ?? [])
    : [];

/**
 * The option fields a configuration may override, by feature type (D2). Every `Expr` field of a
 * feature (see `exprFields`) is configurable in addition, except sketch dimensions (later).
 *
 * A hole's "threaded" is its `kind: 'tapped'`; there is no separate flag. `standard` is not
 * configurable (it would change the meaning of `size`). Values that need a topological reference
 * (`upTo`) are not offered.
 */
export const CONFIGURABLE_OPTIONS: Readonly<
  Partial<Record<FeatureType, readonly ConfigurableOption[]>>
> = {
  primitive: [{ pointer: '/op', label: 'Operation', values: OPS }],
  extrude: [
    { pointer: '/end/kind', label: 'End type', values: END_KINDS },
    { pointer: '/direction', label: 'Direction', values: DIRECTIONS },
    { pointer: '/op', label: 'Operation', values: OPS },
  ],
  revolve: [
    { pointer: '/direction', label: 'Direction', values: DIRECTIONS },
    { pointer: '/op', label: 'Operation', values: OPS },
  ],
  boolean: [
    { pointer: '/op', label: 'Operation', values: ['add', 'cut', 'intersect'] },
    { pointer: '/keepTools', label: 'Keep tools', values: BOOLS },
  ],
  fillet: [{ pointer: '/propagate', label: 'Propagate', values: BOOLS }],
  chamfer: [{ pointer: '/propagate', label: 'Propagate', values: BOOLS }],
  hole: [
    { pointer: '/size', label: 'Size', values: holeSizes },
    {
      pointer: '/kind',
      label: 'Type',
      values: ['simple', 'counterbore', 'countersink', 'tapped'],
    },
    { pointer: '/fit', label: 'Fit', values: ['close', 'normal', 'loose'] },
    { pointer: '/end/kind', label: 'End type', values: END_KINDS },
  ],
  thread: [{ pointer: '/size', label: 'Size', values: holeSizes }],
};

/** The allowed values of an option for this feature. */
export function optionValues(
  option: ConfigurableOption,
  feature: Feature,
): readonly ConfiguredValue[] {
  return typeof option.values === 'function' ? option.values(feature) : option.values;
}

function optionAt(feature: Feature, pointer: string): ConfigurableOption | undefined {
  return CONFIGURABLE_OPTIONS[feature.type]?.find((o) => o.pointer === pointer);
}

/**
 * Every field of `feature` a configuration may override: its `Expr` fields (not sketch dimensions,
 * not driven dimensions) and the option fields present on it. For the UI.
 */
export function configurableFields(feature: Feature): ConfigurableField[] {
  const out: ConfigurableField[] = [];
  if (feature.type !== 'sketch') {
    for (const f of exprFields(feature)) {
      if (f.driven) continue;
      out.push({ kind: 'expr', pointer: f.pointer, expected: f.expected });
    }
  }
  for (const o of CONFIGURABLE_OPTIONS[feature.type] ?? []) {
    if (existsAt(feature, o.pointer)) {
      out.push({
        kind: 'option',
        pointer: o.pointer,
        label: o.label,
        values: optionValues(o, feature),
      });
    }
  }
  return out;
}

/**
 * Every field of an annotation a configuration may override: its `Expr` fields and the option
 * fields present on it (`ANNOTATION_CONFIGURABLE_OPTIONS`). For the UI.
 */
export function configurableAnnotationFields(annotation: Annotation): ConfigurableField[] {
  const out: ConfigurableField[] = annotationExprFields(annotation).map((f) => ({
    kind: 'expr' as const,
    pointer: f.pointer,
    expected: f.expected,
  }));
  for (const o of ANNOTATION_CONFIGURABLE_OPTIONS) {
    if (existsAt(annotation, o.pointer)) {
      out.push({ kind: 'option', pointer: o.pointer, label: o.label, values: [] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------

export type ConfigurationIssueTarget =
  | ConfigTarget
  /** The configuration itself (missing, or its name). */
  | { kind: 'configuration' }
  | { kind: 'name' };

/** An override that no longer applies, or another problem with a configuration. */
export interface ConfigurationIssue {
  configurationId: Id;
  target: ConfigurationIssueTarget;
  reason: string;
}

export interface ResolvedConfiguration {
  /**
   * The effective document for regenerating the part: Default with the configuration applied.
   * Its `params` carry the overrides, so use it only for this part (owner D1). Unchanged parts,
   * parameters and features are shared with the input; `configurations` and
   * `activeConfigurationId` are kept as stored.
   */
  doc: WrenDoc;
  issues: ConfigurationIssue[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const byKey = (a: [string, unknown], b: [string, unknown]): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

function entriesOf(v: unknown): [string, unknown][] {
  return isRecord(v) ? Object.entries(v).sort(byKey) : [];
}

const isMaterial = (v: unknown): v is Material =>
  isRecord(v) && typeof v.name === 'string' && typeof v.density === 'string';

export const isConfiguredValue = (v: unknown): v is ConfiguredValue =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/** Which configuration `configurationId` means: `undefined` = the part's active one, `null` = Default. */
function wantedId(part: Part, configurationId: Id | null | undefined): Id | null {
  return configurationId === undefined ? (part.activeConfigurationId ?? null) : configurationId;
}

/**
 * Applies the field overrides of one feature. Option fields go first so that an `end.kind` change
 * makes the `end.depth` of the same configuration reachable. Returns the new feature and issues.
 */
function applyFeatureFields(
  feature: Feature,
  configurationId: Id,
  fields: Record<string, unknown>,
  issues: ConfigurationIssue[],
): Feature {
  const issue = (path: string, reason: string): void => {
    issues.push({
      configurationId,
      target: { kind: 'field', featureId: feature.id, path },
      reason,
    });
  };
  const entries = Object.entries(fields).sort(byKey);
  let cur: Feature = feature;
  const set = (path: string, value: ConfiguredValue): boolean => {
    try {
      const op: JsonPatchOp = existsAt(cur, path)
        ? { op: 'replace', path, value }
        : { op: 'add', path, value };
      cur = applyPatch(cur, [op]).doc;
      return true;
    } catch {
      return false;
    }
  };
  const valid = (path: string): boolean => {
    try {
      parsePointer(path);
      return path.startsWith('/');
    } catch {
      return false;
    }
  };
  const deferred: [string, unknown][] = [];
  for (const [path, value] of entries) {
    if (!valid(path)) {
      issue(path, `‘${path}’ is not a valid field path`);
      continue;
    }
    const option = optionAt(cur, path);
    if (option === undefined) {
      deferred.push([path, value]);
      continue;
    }
    if (!existsAt(cur, path)) {
      issue(path, `‘${path}’ no longer exists on ‘${feature.name}’`);
    } else if (!isConfiguredValue(value) || !optionValues(option, feature).includes(value)) {
      issue(path, `${JSON.stringify(value)} is not an allowed ${option.label.toLowerCase()} here`);
    } else {
      set(path, value);
    }
  }
  // Expression fields. A pointer is accepted if it is configurable on the Default feature or on
  // the feature with this configuration's option overrides applied.
  const configurable = new Set([
    ...configurableFields(feature).map((f) => f.pointer),
    ...configurableFields(cur).map((f) => f.pointer),
  ]);
  for (const [path, value] of deferred) {
    if (!configurable.has(path)) {
      issue(path, `‘${path}’ is not a configurable field of ‘${feature.name}’ (any more)`);
    } else if (typeof value !== 'string') {
      issue(path, `The value of ‘${path}’ must be an expression`);
    } else if (!set(path, value)) {
      issue(path, `‘${path}’ cannot be set on ‘${feature.name}’`);
    }
  }
  // An option change can leave a required expression without a value (`end.kind` → blind).
  for (const f of exprFields(cur)) {
    if (f.driven) continue;
    let ok = false;
    try {
      ok = typeof getAt(cur, f.pointer) === 'string';
    } catch {
      ok = false;
    }
    if (!ok) issue(f.pointer, `‘${f.pointer}’ needs a value in this configuration`);
  }
  return cur;
}

/** Applies the field overrides of one annotation (options first, then expression fields). */
function applyAnnotationFields(
  annotation: Annotation,
  configurationId: Id,
  fields: Record<string, unknown>,
  issues: ConfigurationIssue[],
): Annotation {
  const issue = (path: string, reason: string): void => {
    issues.push({
      configurationId,
      target: { kind: 'annotationField', annotationId: annotation.id, path },
      reason,
    });
  };
  let cur: Annotation = annotation;
  const set = (path: string, value: ConfiguredValue): boolean => {
    try {
      const op: JsonPatchOp = existsAt(cur, path)
        ? { op: 'replace', path, value }
        : { op: 'add', path, value };
      cur = applyPatch(cur, [op]).doc;
      return true;
    } catch {
      return false;
    }
  };
  const deferred: [string, unknown][] = [];
  for (const [path, value] of Object.entries(fields).sort(byKey)) {
    try {
      parsePointer(path);
      if (!path.startsWith('/')) throw new Error('pointer');
    } catch {
      issue(path, `‘${path}’ is not a valid field path`);
      continue;
    }
    const option = annotationOptionAt(path);
    if (!option) {
      deferred.push([path, value]);
    } else if (!existsAt(cur, path)) {
      issue(path, `‘${path}’ no longer exists on this annotation`);
    } else if (!isConfiguredValue(value) || !option.accepts(value)) {
      issue(path, `${JSON.stringify(value)} is not ${option.expects}`);
    } else {
      set(path, value);
    }
  }
  const configurable = new Set([
    ...annotationExprFields(annotation).map((f) => f.pointer),
    ...annotationExprFields(cur).map((f) => f.pointer),
  ]);
  for (const [path, value] of deferred) {
    if (!configurable.has(path)) {
      issue(path, `‘${path}’ is not a configurable field of this annotation (any more)`);
    } else if (typeof value !== 'string') {
      issue(path, `The value of ‘${path}’ must be an expression`);
    } else if (!set(path, value)) {
      issue(path, `‘${path}’ cannot be set on this annotation`);
    }
  }
  for (const f of annotationExprFields(cur)) {
    let ok = false;
    try {
      ok = typeof getAt(cur, f.pointer) === 'string';
    } catch {
      ok = false;
    }
    if (!ok) issue(f.pointer, `‘${f.pointer}’ needs a value in this configuration`);
  }
  return cur;
}

/**
 * The effective document for regenerating `partId` in a configuration: Default with the
 * configuration's overrides applied (params, feature suppression and fields, material, colour,
 * properties).
 *
 * `configurationId`: omitted = the part's active configuration; `null` = Default. A missing
 * configuration is reported (never a silent fall-back) and the document comes back as Default.
 */
export function resolveConfiguration(
  doc: WrenDoc,
  partId: Id,
  configurationId?: Id | null,
): ResolvedConfiguration {
  const pi = doc.parts.findIndex((p) => p.id === partId);
  if (pi < 0) {
    return {
      doc,
      issues: [
        {
          configurationId: configurationId ?? '',
          target: { kind: 'configuration' },
          reason: `Part ‘${partId}’ was not found`,
        },
      ],
    };
  }
  const part = doc.parts[pi] as Part;
  const id = wantedId(part, configurationId);
  if (id === null) return { doc, issues: [] };
  const config = part.configurations?.find((c) => c.id === id);
  if (!config) {
    return {
      doc,
      issues: [
        {
          configurationId: id,
          target: { kind: 'configuration' },
          reason: `Configuration ‘${id}’ does not exist`,
        },
      ],
    };
  }
  const issues: ConfigurationIssue[] = [];

  // Parameters.
  let params = doc.params;
  for (const [paramId, expr] of entriesOf(config.params)) {
    const k = params.findIndex((p) => p.id === paramId);
    if (k < 0) {
      issues.push({
        configurationId: id,
        target: { kind: 'param', paramId },
        reason: `Parameter ‘${paramId}’ no longer exists`,
      });
    } else if (typeof expr !== 'string') {
      issues.push({
        configurationId: id,
        target: { kind: 'param', paramId },
        reason: 'A parameter value must be an expression',
      });
    } else {
      if (params === doc.params) params = params.slice();
      params[k] = { ...(params[k] as WrenDoc['params'][0]), expr };
    }
  }

  // Features.
  let features = part.features;
  for (const [featureId, raw] of entriesOf(config.features)) {
    const k = features.findIndex((f) => f.id === featureId);
    const ov = (isRecord(raw) ? raw : {}) as FeatureOverride;
    const hasSuppressed = ov.suppressed !== undefined;
    const fields = isRecord(ov.fields) ? ov.fields : undefined;
    if (k < 0) {
      const reason = `Feature ‘${featureId}’ no longer exists`;
      if (hasSuppressed) {
        issues.push({ configurationId: id, target: { kind: 'suppressed', featureId }, reason });
      }
      for (const [path] of entriesOf(fields)) {
        issues.push({
          configurationId: id,
          target: { kind: 'field', featureId, path },
          reason,
        });
      }
      continue;
    }
    let f = features[k] as Feature;
    if (hasSuppressed) {
      if (typeof ov.suppressed !== 'boolean') {
        issues.push({
          configurationId: id,
          target: { kind: 'suppressed', featureId },
          reason: 'Suppression must be true or false',
        });
      } else if (ov.suppressed !== f.suppressed) {
        f = { ...f, suppressed: ov.suppressed };
      }
    }
    if (fields) f = applyFeatureFields(f, id, fields, issues);
    if (f !== features[k]) {
      if (features === part.features) features = features.slice();
      features[k] = f;
    }
  }

  // Annotations (M4): overrides are keyed by annotation id.
  let annotations = part.annotations;
  for (const [annotationId, raw] of entriesOf(config.annotations)) {
    const k = annotations?.findIndex((a) => a.id === annotationId) ?? -1;
    const ov = (isRecord(raw) ? raw : {}) as AnnotationOverride;
    const hasSuppressed = ov.suppressed !== undefined;
    const fields = isRecord(ov.fields) ? ov.fields : undefined;
    if (k < 0 || !annotations) {
      const reason = `Annotation ‘${annotationId}’ no longer exists`;
      if (hasSuppressed) {
        issues.push({
          configurationId: id,
          target: { kind: 'annotationSuppressed', annotationId },
          reason,
        });
      }
      for (const [path] of entriesOf(fields)) {
        issues.push({
          configurationId: id,
          target: { kind: 'annotationField', annotationId, path },
          reason,
        });
      }
      continue;
    }
    let a = annotations[k] as Annotation;
    if (hasSuppressed) {
      if (typeof ov.suppressed !== 'boolean') {
        issues.push({
          configurationId: id,
          target: { kind: 'annotationSuppressed', annotationId },
          reason: 'Suppression must be true or false',
        });
      } else if (ov.suppressed !== (a.suppressed ?? false)) {
        a = { ...a, suppressed: ov.suppressed };
      }
    }
    if (fields) a = applyAnnotationFields(a, id, fields, issues);
    if (a !== annotations[k]) {
      if (annotations === part.annotations) annotations = annotations.slice();
      annotations[k] = a;
    }
  }

  // Material, colour, properties.
  let next: Part = part;
  const patchPart = (changes: Partial<Part>): void => {
    next = { ...next, ...changes };
  };
  if (features !== part.features) patchPart({ features });
  if (annotations !== part.annotations) patchPart({ annotations });
  if (config.material !== undefined) {
    if (config.material === null) {
      const { material: _m, ...rest } = next;
      next = rest as Part;
    } else if (isMaterial(config.material)) {
      patchPart({ material: config.material });
    } else {
      issues.push({
        configurationId: id,
        target: { kind: 'material' },
        reason: 'The material override is malformed',
      });
    }
  }
  if (config.color !== undefined) {
    if (typeof config.color === 'string') patchPart({ color: config.color });
    else {
      issues.push({
        configurationId: id,
        target: { kind: 'color' },
        reason: 'The colour override must be a string',
      });
    }
  }
  if (config.properties !== undefined) {
    const props: PartProperties = { ...part.properties };
    for (const [key, value] of entriesOf(config.properties)) {
      if ((key === 'partNumber' || key === 'description') && typeof value === 'string') {
        props[key] = value;
      } else {
        issues.push({
          configurationId: id,
          target: { kind: 'property', key: key as keyof PartProperties },
          reason: `The property ‘${key}’ is not a text property`,
        });
      }
    }
    patchPart({ properties: props });
  }

  if (next === part && params === doc.params) return { doc, issues };
  const parts = doc.parts.slice();
  parts[pi] = next;
  return { doc: { ...doc, params, parts }, issues };
}

/** Name-based problems of a part's configurations (duplicate names are allowed, but reported). */
export function duplicateConfigurationNames(part: Part): ConfigurationIssue[] {
  const byName = new Map<string, Configuration[]>();
  for (const c of part.configurations ?? []) {
    const key = c.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), c]);
  }
  const out: ConfigurationIssue[] = [];
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const c of group) {
      out.push({
        configurationId: c.id,
        target: { kind: 'name' },
        reason: `Another configuration is also named ‘${c.name}’`,
      });
    }
  }
  return out;
}

/** Every problem of every configuration of a part: stale overrides plus duplicate names. */
export function configurationIssues(doc: WrenDoc, partId: Id): ConfigurationIssue[] {
  const part = doc.parts.find((p) => p.id === partId);
  if (!part) return [];
  const out: ConfigurationIssue[] = [];
  for (const c of part.configurations ?? []) {
    out.push(...resolveConfiguration(doc, partId, c.id).issues);
  }
  return [...out, ...duplicateConfigurationNames(part)];
}

// ---------------------------------------------------------------------------------------------
// Pruning (deleted features and parameters)
// ---------------------------------------------------------------------------------------------

/** What deleting something takes out of the configurations. */
export interface PruneSet {
  featureIds?: ReadonlySet<Id>;
  paramIds?: ReadonlySet<Id>;
  annotationIds?: ReadonlySet<Id>;
}

/** Removes empty containers so the stored form is canonical. Returns the input when unchanged. */
export function pruneConfiguration(config: Configuration, gone: PruneSet = {}): Configuration {
  const out: Configuration = { ...config };
  if (out.params) {
    const kept = Object.entries(out.params).filter(([k]) => !gone.paramIds?.has(k));
    if (kept.length === 0) delete out.params;
    else if (kept.length !== Object.keys(out.params).length) out.params = Object.fromEntries(kept);
  }
  if (out.features) {
    const features: Record<Id, FeatureOverride> = {};
    for (const [fid, ov] of Object.entries(out.features)) {
      if (gone.featureIds?.has(fid)) continue;
      const o: FeatureOverride = { ...ov };
      if (o.fields && Object.keys(o.fields).length === 0) delete o.fields;
      if (Object.keys(o).length > 0) features[fid] = o;
    }
    if (Object.keys(features).length === 0) delete out.features;
    else out.features = features;
  }
  if (out.annotations) {
    const kept: Record<Id, AnnotationOverride> = {};
    for (const [aid, ov] of Object.entries(out.annotations)) {
      if (gone.annotationIds?.has(aid)) continue;
      const o: AnnotationOverride = { ...ov };
      if (o.fields && Object.keys(o.fields).length === 0) delete o.fields;
      if (Object.keys(o).length > 0) kept[aid] = o;
    }
    if (Object.keys(kept).length === 0) delete out.annotations;
    else out.annotations = kept;
  }
  if (out.properties && Object.keys(out.properties).length === 0) delete out.properties;
  return JSON.stringify(out) === JSON.stringify(config) ? config : out;
}

/**
 * Patch ops that drop the overrides of deleted features and parameters from every configuration
 * of `part` (at `/parts/<partIndex>`), so the delete and the pruning are one undo entry.
 */
export function configurationPruneOps(
  part: Part,
  partIndex: number,
  gone: PruneSet,
): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  (part.configurations ?? []).forEach((c, k) => {
    const pruned = pruneConfiguration(c, gone);
    if (pruned !== c) ops.push(...diff(c, pruned, `/parts/${partIndex}/configurations/${k}`));
  });
  return ops;
}

// ---------------------------------------------------------------------------------------------
// Part numbers and export file names (owner D4)
// ---------------------------------------------------------------------------------------------

/**
 * The part number: the user-set one, else "<document name>-<configuration name>". Default (no
 * configuration) falls back to the document name alone. A configuration inherits Default's
 * user-set number unless it sets its own; setting it to "" clears the inherited one so the
 * generated name applies. `configurationId`: omitted = active, `null` = Default.
 */
export function partNumberFor(doc: WrenDoc, partId: Id, configurationId?: Id | null): string {
  const part = doc.parts.find((p) => p.id === partId);
  const docName = doc.meta.name;
  if (!part) return docName;
  const id = wantedId(part, configurationId);
  const clean = (s: string | undefined): string | undefined =>
    s !== undefined && s.trim() !== '' ? s.trim() : undefined;
  if (id === null) return clean(part.properties?.partNumber) ?? docName;
  const config = part.configurations?.find((c) => c.id === id);
  const own = config?.properties?.partNumber;
  const set = own !== undefined ? clean(own) : clean(part.properties?.partNumber);
  return set ?? `${docName}-${config?.name ?? id}`;
}

export interface ExportFileName {
  /** `null` = Default. */
  configurationId: Id | null;
  partNumber: string;
  /** The part number made safe for a file name, plus the extension if one was given. */
  fileName: string;
}

export interface ExportFileNames {
  files: ExportFileName[];
  /** Groups of configurations that would write the same file (case-insensitive). Never renamed. */
  collisions: { fileName: string; configurationIds: (Id | null)[] }[];
}

/** Makes a part number safe as a file name (no path separators or reserved characters). */
export function safeFileName(name: string): string {
  const s = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  return s === '' ? 'part' : s;
}

/**
 * File names for exporting several configurations of a part. Names follow the part number;
 * collisions are reported, never renamed or overwritten silently (the caller must ask).
 */
export function exportFileNames(
  doc: WrenDoc,
  partId: Id,
  ids: readonly (Id | null)[],
  extension = '',
): ExportFileNames {
  const files = ids.map((configurationId): ExportFileName => {
    const partNumber = partNumberFor(doc, partId, configurationId);
    return { configurationId, partNumber, fileName: safeFileName(partNumber) + extension };
  });
  const groups = new Map<string, ExportFileName[]>();
  for (const f of files) {
    const key = f.fileName.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const collisions = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      fileName: (g[0] as ExportFileName).fileName,
      configurationIds: g.map((f) => f.configurationId),
    }));
  return { files, collisions };
}
