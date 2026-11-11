import type { ConfigTarget, ConfiguredValue, Id, Material } from '@wren-cad/contracts';

/* Pure types and helpers for the M3.7 configuration UI. Import-light: no React, no components. */

/** Per-configuration build status (rebuild-all check). */
export type ConfigStatus = 'ok' | 'failed' | 'attention' | 'unbuilt';

export const CONFIG_STATUS_LABEL: Record<ConfigStatus, string> = {
  ok: 'OK',
  failed: 'Failed',
  attention: 'Needs attention',
  unbuilt: 'Not yet built',
};

/** The implicit Default is shown under this name. */
export const DEFAULT_CONFIGURATION_NAME = 'Default';

/** A configuration as the pill lists it (Default is implicit and passed separately). */
export interface ConfigurationSummary {
  id: Id;
  name: string;
  status: ConfigStatus;
  /** Why it failed / needs attention: shown as a tooltip and read out. */
  statusMessage?: string;
}

/** A cell value: an expression or option, a boolean, a material (`null` = no material) or absent. */
export type CellValue = ConfiguredValue | Material | null | undefined;

export type ConfigColumnKind = 'expr' | 'option' | 'bool' | 'material' | 'text';

export interface ConfigOption {
  value: string;
  label?: string;
}

/** One column (a configurable field). The app decides what is configurable; the table does not. */
export interface ConfigColumn {
  target: ConfigTarget;
  label: string;
  /** Unit appended to plain numbers on display, e.g. `mm`. */
  unit?: string;
  kind: ConfigColumnKind;
  /** The choices of an `option` column. */
  options?: readonly ConfigOption[];
}

export type ConfigGroupId = 'parameters' | 'suppression' | 'material' | 'properties';

export const CONFIG_GROUPS: readonly { id: ConfigGroupId; label: string }[] = [
  { id: 'parameters', label: 'Parameters' },
  { id: 'suppression', label: 'Suppression' },
  { id: 'material', label: 'Material' },
  { id: 'properties', label: 'Properties' },
];

export function groupOf(target: ConfigTarget): ConfigGroupId {
  switch (target.kind) {
    case 'param':
    case 'field':
      return 'parameters';
    case 'suppressed':
      return 'suppression';
    case 'material':
    case 'color':
      return 'material';
    case 'property':
      return 'properties';
    case 'annotationField':
      return 'parameters';
    case 'annotationSuppressed':
      return 'suppression';
  }
}

/** A stable string key for a target: the key of `defaults` / `overrides` maps. */
export function configTargetKey(t: ConfigTarget): string {
  switch (t.kind) {
    case 'param':
      return `param:${t.paramId}`;
    case 'field':
      return `field:${t.featureId}:${t.path}`;
    case 'suppressed':
      return `suppressed:${t.featureId}`;
    case 'material':
      return 'material';
    case 'color':
      return 'color';
    case 'property':
      return `property:${t.key}`;
    case 'annotationField':
      return `annotationField:${t.annotationId}:${t.path}`;
    case 'annotationSuppressed':
      return `annotationSuppressed:${t.annotationId}`;
  }
}

/** True for materials or scalars that mean the same thing. Strings compare trimmed. */
export function sameCellValue(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'object' || typeof b === 'object') {
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    return a.libraryId !== undefined
      ? a.libraryId === b.libraryId
      : a.name === b.name && a.density === b.density;
  }
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return false;
}

const PLAIN_NUMBER = /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/;

/** Display text of a cell value. */
export function cellText(value: CellValue, column: ConfigColumn): string {
  if (value === undefined) return '';
  if (value === null) return column.kind === 'material' ? 'None' : '';
  if (typeof value === 'boolean') return value ? 'Suppressed' : 'Active';
  if (typeof value === 'object') return value.name;
  if (typeof value === 'number') return column.unit ? `${value} ${column.unit}` : String(value);
  if (column.kind === 'option') {
    return column.options?.find((o) => o.value === value)?.label ?? value;
  }
  if (column.kind === 'expr' && column.unit && PLAIN_NUMBER.test(value)) {
    return `${value.trim()} ${column.unit}`;
  }
  return value;
}

/** Whether the active configuration is the implicit Default. */
export const isDefaultConfiguration = (activeId: Id | null | undefined): boolean =>
  activeId == null;

/* ---------------------------------------------------------------- edit scope (trap T1) */

/** Where one edit lands. `all` edits Default (every configuration that inherits). */
export type EditScope = 'all' | 'configuration';

/**
 * Fusion's rule, decided at the point of edit: an overridden value edits only the active
 * configuration; an explicit "This configuration only" chip does too; everything else edits Default
 * (all inheriting configurations). Default active: always `all`. Nothing here is remembered.
 */
export function resolveEditScope(input: {
  activeIsDefault: boolean;
  overridden: boolean;
  chip: boolean;
}): EditScope {
  if (input.activeIsDefault) return 'all';
  return input.overridden || input.chip ? 'configuration' : 'all';
}
