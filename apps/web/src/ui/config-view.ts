/**
 * The configuration state the chrome renders (M3.7): the pill's list with each configuration's
 * status, the per-configuration masses, and whether the active id is missing (trap T2).
 */

import type { FeatureStatus, Id } from '@wren-cad/contracts';
import {
  type ConfigMassRow,
  type ConfigStatus,
  type ConfigurationSummary,
  defaultMassFormat,
} from '@wren-cad/ui';
import { useSyncExternalStore } from 'react';
import { configStatusOf, isMissingActive, keyOf, type MassSummaryView } from '../app/config-model';
import { useObservable } from '../app/observable';
import type { Workbench } from '../app/workbench';

export interface ConfigurationView {
  activeId: Id | null;
  /** The active id names a configuration the part does not have. */
  missing: boolean;
  activeName: string;
  /** Configurations besides Default. */
  count: number;
  summaries: ConfigurationSummary[];
  defaultStatus: ConfigStatus;
  defaultMessage: string | undefined;
  masses: ConfigMassRow[];
  /** Per configuration (`keyOf`): status, message and mass for the table. */
  byKey: Record<
    string,
    { status: ConfigStatus; message?: string; mass?: MassSummaryView; massPending?: boolean }
  >;
}

export const MISSING_TEXT =
  'This configuration no longer exists, so its values cannot be shown. Default is shown instead until you choose a configuration.';

export const formatMass = (m: MassSummaryView | undefined): string | undefined =>
  m?.mass !== undefined ? defaultMassFormat.mass(m.mass) : undefined;

/** Text of a configuration's mass cell: pending while the live model's is computed (ADR-084). */
export const MASS_PENDING_TEXT = 'Calculating…';
export const massText = (b: { mass?: MassSummaryView; massPending?: boolean } | undefined) =>
  b?.massPending ? MASS_PENDING_TEXT : formatMass(b?.mass);

export function useConfigurationView(wb: Workbench): ConfigurationView {
  const doc = useSyncExternalStore(wb.subscribeDoc, wb.getDoc);
  const regen = useObservable(wb.regen);
  const statuses = useObservable(wb.treeStatuses);
  const builds = useObservable(wb.config.builds.view);
  const part = doc.parts[0];
  const configs = part?.configurations ?? [];
  const activeId = part?.activeConfigurationId ?? null;
  const missing = isMissingActive(part);
  const names = new Map((part?.features ?? []).map((f) => [f.id, f.name]));
  const nameOf = (id: Id) => names.get(id) ?? id;

  const byKey: ConfigurationView['byKey'] = {};
  const live = regen?.source === 'live' ? (statuses as FeatureStatus[] | undefined) : undefined;
  const resolvedIssues = wb.config.resolved().issues;
  const mass = wb.massSummary();
  const massPending = wb.massPending();
  for (const id of [null, ...configs.map((c) => c.id)] as (Id | null)[]) {
    const key = keyOf(id);
    if (id === activeId && !missing) {
      const s = configStatusOf(live, resolvedIssues, nameOf);
      byKey[key] = {
        ...s,
        ...(live && mass ? { mass } : {}),
        ...(live && massPending ? { massPending } : {}),
      };
      continue;
    }
    const e = builds.entries[key];
    const fresh = e && e.hash === wb.config.builds.currentHash(doc, id) ? e : undefined;
    byKey[key] = fresh
      ? {
          status: fresh.status,
          ...(fresh.message ? { message: fresh.message } : {}),
          ...(fresh.mass ? { mass: fresh.mass } : {}),
        }
      : { status: 'unbuilt' };
  }
  const get = (id: Id | null) => byKey[keyOf(id)] as ConfigurationView['byKey'][string];
  const summaries: ConfigurationSummary[] = configs.map((c) => ({
    id: c.id,
    name: c.name,
    status: get(c.id).status,
    ...(get(c.id).message ? { statusMessage: get(c.id).message as string } : {}),
  }));
  if (missing && activeId) {
    summaries.push({
      id: activeId,
      name: 'Missing configuration',
      status: 'attention',
      statusMessage: MISSING_TEXT,
    });
  }
  const def = get(null);
  const row = (id: Id | null, name: string, active: boolean): ConfigMassRow => {
    const b = get(id);
    const m = massText(b);
    return { id, name, active, status: b.status, ...(m ? { mass: m } : {}) };
  };
  const masses: ConfigMassRow[] = [
    row(null, 'Default', activeId === null && !missing),
    ...configs.map((c) => row(c.id, c.name, c.id === activeId)),
  ];
  const active = configs.find((c) => c.id === activeId);
  return {
    activeId,
    missing,
    activeName: missing ? 'Missing configuration' : (active?.name ?? 'Default'),
    count: configs.length,
    summaries,
    defaultStatus: def.status,
    defaultMessage: def.message,
    masses,
    byKey,
  };
}
