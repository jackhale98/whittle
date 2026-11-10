// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Compiles the M3.7 configuration commands (ADR-074) into JSON patches. Each command is one undo
 * entry. The UI decides scope (Default vs this configuration); these commands only express it.
 *
 * Validation is all-or-nothing: if any part of a command is invalid, nothing changes.
 */

import type {
  ConfigTarget,
  Command,
  Configuration,
  ConfiguredValue,
  Feature,
  JsonPatchOp,
  Material,
  Part,
  PartProperties,
  WrenDoc,
} from '@wren-cad/contracts';
import type { Compiled } from './commands';
import { configurableFields, isConfiguredValue, pruneConfiguration } from './configurations';
import { scopeOf } from './evaluate';
import { expressionEngine } from './expressions';
import { tryResolveDensity } from './materials';
import { diff } from './patch';

export type ConfigCommand = Extract<
  Command,
  {
    kind:
      | 'addConfiguration'
      | 'renameConfiguration'
      | 'removeConfiguration'
      | 'setActiveConfiguration'
      | 'setConfigurationOverrides'
      | 'setPartProperties';
  }
>;

const err = (error: string): Compiled => ({ ok: false, error });

const COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PROPERTY_KEYS = ['partNumber', 'description'] as const;

type Edit = Extract<Command, { kind: 'setConfigurationOverrides' }>['edits'][number];

export function compileConfigCommand(
  doc: WrenDoc,
  cmd: ConfigCommand,
  idInUse: (id: string) => boolean,
): Compiled {
  const i = doc.parts.findIndex((p) => p.id === cmd.partId);
  if (i < 0) return err(`Part ‘${cmd.partId}’ was not found`);
  const part = doc.parts[i] as Part;
  const base = `/parts/${i}`;
  const configs = part.configurations ?? [];
  const indexOf = (id: string): number => configs.findIndex((c) => c.id === id);

  switch (cmd.kind) {
    case 'addConfiguration': {
      const c = cmd.configuration;
      if (typeof c?.id !== 'string' || c.id === '') return err('A configuration needs an id');
      if (idInUse(c.id)) return err(`The id ‘${c.id}’ is already in use`);
      const name = typeof c.name === 'string' ? c.name.trim() : '';
      if (name === '') return err('A configuration needs a name');
      const known = ['id', 'name', 'params', 'features', 'material', 'color', 'properties'];
      for (const k of Object.keys(c)) {
        if (!known.includes(k)) return err(`‘${k}’ is not a configuration property`);
      }
      const { id: _id, name: _name, ...given } = c;
      const fresh: Configuration = { id: c.id, name };
      if (cmd.from !== undefined && cmd.from !== 'default') {
        const src = configs.find((x) => x.id === cmd.from);
        if (!src) return err(`Configuration ‘${cmd.from}’ was not found`);
        if (Object.keys(given).length > 0) {
          return err('Give either a configuration to copy or overrides, not both');
        }
        const { id: _i, name: _n, ...rest } = structuredClone(src);
        Object.assign(fresh, rest);
      } else {
        const working = new Map([[fresh.id, fresh]]);
        const edits = configurationEdits(c);
        if (typeof edits === 'string') return err(edits);
        const r = applyEdits(doc, part, working, edits);
        if (typeof r === 'string') return err(r);
      }
      const value = pruneConfiguration(fresh);
      return {
        ok: true,
        label: `New configuration ${name}`,
        ops: part.configurations
          ? [{ op: 'add', path: `${base}/configurations/-`, value }]
          : [{ op: 'add', path: `${base}/configurations`, value: [value] }],
      };
    }
    case 'renameConfiguration': {
      const k = indexOf(cmd.configurationId);
      if (k < 0) return err(`Configuration ‘${cmd.configurationId}’ was not found`);
      const name = typeof cmd.name === 'string' ? cmd.name.trim() : '';
      if (name === '') return err('A configuration needs a name');
      const old = configs[k] as Configuration;
      return {
        ok: true,
        label: `Rename configuration ${old.name} to ${name}`,
        ops:
          name === old.name
            ? []
            : [{ op: 'replace', path: `${base}/configurations/${k}/name`, value: name }],
      };
    }
    case 'removeConfiguration': {
      const k = indexOf(cmd.configurationId);
      if (k < 0) return err(`Configuration ‘${cmd.configurationId}’ was not found`);
      const ops: JsonPatchOp[] = [
        configs.length === 1
          ? { op: 'remove', path: `${base}/configurations` }
          : { op: 'remove', path: `${base}/configurations/${k}` },
      ];
      if (part.activeConfigurationId === cmd.configurationId) {
        ops.push({ op: 'remove', path: `${base}/activeConfigurationId` });
      }
      return {
        ok: true,
        label: `Delete configuration ${(configs[k] as Configuration).name}`,
        ops,
      };
    }
    case 'setActiveConfiguration': {
      if (cmd.configurationId === null) {
        return {
          ok: true,
          label: 'Switch to Default',
          ops:
            part.activeConfigurationId === undefined
              ? []
              : [{ op: 'remove', path: `${base}/activeConfigurationId` }],
        };
      }
      const k = indexOf(cmd.configurationId);
      if (k < 0) return err(`Configuration ‘${cmd.configurationId}’ was not found`);
      const label = `Switch to ${(configs[k] as Configuration).name}`;
      if (part.activeConfigurationId === cmd.configurationId) return { ok: true, label, ops: [] };
      return {
        ok: true,
        label,
        ops: [
          {
            op: part.activeConfigurationId === undefined ? 'add' : 'replace',
            path: `${base}/activeConfigurationId`,
            value: cmd.configurationId,
          },
        ],
      };
    }
    case 'setPartProperties': {
      if (!isPlain(cmd.properties)) return err('The properties must be an object');
      const next: PartProperties = {};
      for (const [k, v] of Object.entries(cmd.properties)) {
        if (v === undefined) continue;
        if (!(PROPERTY_KEYS as readonly string[]).includes(k)) {
          return err(`‘${k}’ is not a part property`);
        }
        if (typeof v !== 'string') return err(`The ${propertyLabel(k)} must be text`);
        if (v.trim() !== '') next[k as keyof PartProperties] = v;
      }
      const old = part.properties ?? {};
      const empty = Object.keys(next).length === 0;
      const changedKeys = PROPERTY_KEYS.filter((k) => old[k] !== next[k]);
      const label =
        changedKeys.length === 1
          ? `Set ${propertyLabel(changedKeys[0] as string)}`
          : 'Set part properties';
      let ops: JsonPatchOp[] = [];
      if (changedKeys.length > 0) {
        ops = empty
          ? [{ op: 'remove', path: `${base}/properties` }]
          : [
              {
                op: part.properties === undefined ? 'add' : 'replace',
                path: `${base}/properties`,
                value: next,
              },
            ];
      }
      return { ok: true, label, ops };
    }
    case 'setConfigurationOverrides': {
      if (!Array.isArray(cmd.edits)) return err('The edits must be a list');
      const working = new Map<string, Configuration>();
      for (const e of cmd.edits) {
        if (working.has(e?.configurationId)) continue;
        const c = configs.find((x) => x.id === e?.configurationId);
        if (!c) return err(`Configuration ‘${String(e?.configurationId)}’ was not found`);
        working.set(c.id, structuredClone(c));
      }
      const r = applyEdits(doc, part, working, cmd.edits);
      if (typeof r === 'string') return err(r);
      const ops: JsonPatchOp[] = [];
      configs.forEach((c, k) => {
        const w = working.get(c.id);
        if (!w) return;
        ops.push(...diff(c, pruneConfiguration(w), `${base}/configurations/${k}`));
      });
      return { ok: true, label: labelFor(doc, part, r.changed), ops };
    }
  }
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function propertyLabel(key: string): string {
  return key === 'partNumber' ? 'part number' : key;
}

/** A configuration's own overrides as an edit list (for `addConfiguration` without `from`). */
function configurationEdits(c: Configuration): Edit[] | string {
  const out: Edit[] = [];
  const id = c.id;
  if (c.params !== undefined) {
    if (!isPlain(c.params)) return 'The parameter overrides must be an object';
    for (const [paramId, value] of Object.entries(c.params)) {
      out.push({ configurationId: id, target: { kind: 'param', paramId }, value: value as string });
    }
  }
  if (c.features !== undefined) {
    if (!isPlain(c.features)) return 'The feature overrides must be an object';
    for (const [featureId, ov] of Object.entries(c.features)) {
      if (!isPlain(ov)) return 'A feature override must be an object';
      if (ov.suppressed !== undefined) {
        out.push({
          configurationId: id,
          target: { kind: 'suppressed', featureId },
          value: ov.suppressed as boolean,
        });
      }
      if (ov.fields !== undefined) {
        if (!isPlain(ov.fields)) return 'The field overrides must be an object';
        for (const [path, value] of Object.entries(ov.fields)) {
          out.push({
            configurationId: id,
            target: { kind: 'field', featureId, path },
            value: value as ConfiguredValue,
          });
        }
      }
    }
  }
  if (c.material !== undefined) {
    out.push({ configurationId: id, target: { kind: 'material' }, value: c.material });
  }
  if (c.color !== undefined) {
    out.push({ configurationId: id, target: { kind: 'color' }, value: c.color });
  }
  if (c.properties !== undefined) {
    if (!isPlain(c.properties)) return 'The properties must be an object';
    for (const [key, value] of Object.entries(c.properties)) {
      out.push({
        configurationId: id,
        target: { kind: 'property', key: key as keyof PartProperties },
        value: value as string,
      });
    }
  }
  return out;
}

interface Applied {
  /** The edits that changed something, in order. */
  changed: Edit[];
}

/**
 * Applies edits to the working configurations (mutating them), validating targets and values.
 * Returns an error message or the edits that changed something.
 */
function applyEdits(
  doc: WrenDoc,
  part: Part,
  working: Map<string, Configuration>,
  edits: readonly Edit[],
): Applied | string {
  const changed: Edit[] = [];
  for (const edit of edits) {
    const config = working.get(edit?.configurationId);
    if (!config) return `Configuration ‘${String(edit?.configurationId)}’ was not found`;
    const t = edit.target;
    const before = JSON.stringify(pruneConfiguration(config));
    const bad = applyEdit(doc, part, config, t, edit.value);
    if (bad) return bad;
    if (JSON.stringify(pruneConfiguration(config)) !== before) changed.push(edit);
  }
  // Values are validated after every edit is staged, so an `end.kind` change and the `end.depth`
  // it needs can arrive in one batch in any order.
  for (const edit of edits) {
    if (edit.value === undefined) continue;
    const config = working.get(edit.configurationId) as Configuration;
    const bad = validateValue(doc, part, config, edit.target, edit.value);
    if (bad) return bad;
  }
  return { changed };
}

function featureOf(part: Part, featureId: string): Feature | undefined {
  return part.features.find((f) => f.id === featureId);
}

/** Checks the target exists and stages the edit. Value semantics come later (`validateValue`). */
function applyEdit(
  doc: WrenDoc,
  part: Part,
  config: Configuration,
  target: ConfigTarget,
  value: Edit['value'],
): string | undefined {
  const remove = value === undefined;
  switch (target?.kind) {
    case 'param': {
      if (!doc.params.some((p) => p.id === target.paramId)) {
        return `Parameter ‘${target.paramId}’ was not found`;
      }
      if (remove) {
        if (config.params) delete config.params[target.paramId];
      } else if (typeof value === 'string') {
        config.params = { ...config.params, [target.paramId]: value };
      } else return 'A parameter value must be an expression';
      return;
    }
    case 'suppressed': {
      if (!featureOf(part, target.featureId)) return `Feature ‘${target.featureId}’ was not found`;
      if (remove) {
        const ov = config.features?.[target.featureId];
        if (ov) delete ov.suppressed;
      } else if (typeof value === 'boolean') {
        const features = { ...config.features };
        features[target.featureId] = { ...features[target.featureId], suppressed: value };
        config.features = features;
      } else return 'Suppression must be true or false';
      return;
    }
    case 'field': {
      const f = featureOf(part, target.featureId);
      if (!f) return `Feature ‘${target.featureId}’ was not found`;
      if (typeof target.path !== 'string') return 'A field needs a path';
      if (remove) {
        const fields = config.features?.[target.featureId]?.fields;
        if (fields) delete fields[target.path];
      } else if (isConfiguredValue(value)) {
        const features = { ...config.features };
        const ov = features[target.featureId] ?? {};
        features[target.featureId] = { ...ov, fields: { ...ov.fields, [target.path]: value } };
        config.features = features;
      } else return 'A field value must be text, a number or true/false';
      return;
    }
    case 'material':
      if (remove) delete config.material;
      else if (value === null || isMaterialValue(value)) config.material = value as Material | null;
      else return 'The material must be a material or null';
      return;
    case 'color':
      if (remove) delete config.color;
      else if (typeof value === 'string') config.color = value;
      else return 'The colour must be text';
      return;
    case 'property': {
      if (!(PROPERTY_KEYS as readonly string[]).includes(target.key)) {
        return `‘${String(target.key)}’ is not a part property`;
      }
      if (remove) {
        if (config.properties) delete config.properties[target.key];
      } else if (typeof value === 'string') {
        config.properties = { ...config.properties, [target.key]: value };
      } else return `The ${propertyLabel(target.key)} must be text`;
      return;
    }
    default:
      return 'That is not something a configuration can override';
  }
}

function isMaterialValue(v: unknown): boolean {
  return isPlain(v) && typeof v.name === 'string' && typeof v.density === 'string';
}

function validateValue(
  doc: WrenDoc,
  part: Part,
  config: Configuration,
  target: ConfigTarget,
  value: NonNullable<Edit['value']> | null,
): string | undefined {
  // Scope with this configuration's parameter overrides: an expression is checked as it will be
  // evaluated in that configuration.
  const params = doc.params.map((p) => {
    const o = config.params?.[p.id];
    return o === undefined ? p : { ...p, expr: o };
  });
  const scope = scopeOf({ params, units: doc.units });
  switch (target.kind) {
    case 'param': {
      const name = doc.params.find((p) => p.id === target.paramId)?.name ?? target.paramId;
      const r = expressionEngine.evaluateAny(value as string, scope);
      return r.ok ? undefined : `${name}: ${r.error.message}`;
    }
    case 'field': {
      const base = featureOf(part, target.featureId) as Feature;
      const fields = configurableFields(base);
      // Option overrides of this configuration may make more fields reachable.
      const staged = stageOptions(base, config.features?.[target.featureId]?.fields);
      const field =
        fields.find((f) => f.pointer === target.path) ??
        configurableFields(staged).find((f) => f.pointer === target.path);
      if (!field) return `‘${target.path}’ is not a configurable field of ‘${base.name}’`;
      if (field.kind === 'option') {
        const allowed = field.values;
        return allowed.includes(value as ConfiguredValue)
          ? undefined
          : `${JSON.stringify(value)} is not one of: ${allowed.join(', ')}`;
      }
      if (typeof value !== 'string') return `‘${target.path}’ needs an expression`;
      const r = expressionEngine.evaluate(value, field.expected, scope);
      return r.ok ? undefined : `${base.name} ${target.path}: ${r.error.message}`;
    }
    case 'material': {
      if (value === null) return undefined;
      const r = tryResolveDensity(value as Material, expressionEngine, scope);
      return r.ok ? undefined : r.message;
    }
    case 'color':
      return COLOR.test(value as string)
        ? undefined
        : 'The colour must be a hex colour like #9aa4b2';
    default:
      return undefined;
  }
}

/** The feature with only its option overrides applied (cheap; used to find reachable fields). */
function stageOptions(
  feature: Feature,
  fields: Record<string, ConfiguredValue> | undefined,
): Feature {
  if (!fields) return feature;
  const copy = structuredClone(feature) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(fields)) {
    const segs = path.split('/').slice(1);
    let cur: unknown = copy;
    for (const s of segs.slice(0, -1)) cur = isPlain(cur) ? cur[s] : undefined;
    const last = segs[segs.length - 1];
    if (isPlain(cur) && last !== undefined && last !== '__proto__' && typeof value !== 'object') {
      cur[last] = value;
    }
  }
  return copy as unknown as Feature;
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

function labelFor(doc: WrenDoc, part: Part, changed: Edit[]): string {
  const configName = (id: string): string =>
    part.configurations?.find((c) => c.id === id)?.name ?? id;
  const one = changed[0];
  if (changed.length === 1 && one) {
    const where = ` in ${configName(one.configurationId)}`;
    const reset = one.value === undefined;
    const t = one.target;
    const fname = (id: string): string => featureOf(part, id)?.name ?? id;
    switch (t.kind) {
      case 'param': {
        const n = doc.params.find((p) => p.id === t.paramId)?.name ?? t.paramId;
        return `${reset ? 'Reset' : 'Set'} ${n}${where}`;
      }
      case 'suppressed':
        return reset
          ? `Reset suppression of ${fname(t.featureId)}${where}`
          : `${one.value === true ? 'Suppress' : 'Unsuppress'} ${fname(t.featureId)}${where}`;
      case 'field': {
        const feature = featureOf(part, t.featureId);
        const label = feature
          ? (
              configurableFields(feature).find((f) => f.pointer === t.path) as
                | { label?: string }
                | undefined
            )?.label
          : undefined;
        const what = (label ?? t.path.slice(1).replace(/\//g, ' ')).toLowerCase();
        return `${reset ? 'Reset' : 'Set'} ${fname(t.featureId)} ${what}${where}`;
      }
      case 'material':
        if (reset) return `Reset material${where}`;
        return one.value === null
          ? `Clear material${where}`
          : `Set material ${(one.value as Material).name}${where}`;
      case 'color':
        return `${reset ? 'Reset' : 'Set'} colour${where}`;
      case 'property':
        return `${reset ? 'Reset' : 'Set'} ${propertyLabel(t.key)}${where}`;
    }
  }
  if (changed.length === 0) return 'Set configuration values';
  const configs = new Set(changed.map((e) => e.configurationId));
  const n = changed.length;
  const where =
    configs.size === 1 ? configName([...configs][0] as string) : `${configs.size} configurations`;
  return `Change ${n} ${n === 1 ? 'value' : 'values'} in ${where}`;
}
