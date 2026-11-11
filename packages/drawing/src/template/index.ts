/**
 * Template generator: `(SheetFormat, TemplateBinding) → frame, zones, centring marks, title block
 * slots` (ADR-090 §3.3). Generated, never stored. `version` pins the generator so an existing
 * drawing never moves when the app updates; old versions stay in this registry.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SheetFormat, TemplateBinding, Vec2 } from '@wren-cad/contracts';
import { asmeY141v1 } from './asme-y14-1';
import { iso5457v1 } from './iso5457';
import { isAnsiSize, isIsoSize, sheetDimensions } from './sizes';
import type { TemplateGenerator, TemplateLayout } from './types';

export * from './asme-y14-1';
export * from './iso5457';
export * from './sizes';
export * from './title-block';
export * from './types';

const GENERATORS: Readonly<Record<TemplateBinding['id'], readonly TemplateGenerator[]>> = {
  'iso-5457': [iso5457v1],
  'asme-y14.1': [asmeY141v1],
};

/** The newest generator version per template ("re-apply template" moves a drawing to it). */
export const LATEST_TEMPLATE_VERSION: Readonly<Record<TemplateBinding['id'], number>> = {
  'iso-5457': GENERATORS['iso-5457'].length,
  'asme-y14.1': GENERATORS['asme-y14.1'].length,
};

export type TemplateResult = { ok: true; layout: TemplateLayout } | { ok: false; message: string };

export function generateTemplate(
  format: SheetFormat,
  binding: Pick<TemplateBinding, 'id' | 'version'>,
): TemplateResult {
  const versions = GENERATORS[binding.id];
  if (!versions) return { ok: false, message: `Unknown template “${binding.id}”` };
  const gen = versions[binding.version - 1];
  if (!Number.isInteger(binding.version) || !gen)
    return {
      ok: false,
      message: `Template ${binding.id} version ${binding.version} is newer than this app (latest ${versions.length}): update Wren`,
    };
  const { width, height } = sheetDimensions(format);
  if (!(width > 0 && height > 0)) return { ok: false, message: 'The sheet size must be positive' };
  const named = binding.id === 'iso-5457' ? isIsoSize(format.size) : isAnsiSize(format.size);
  const sizeKey = typeof format.size === 'string' ? format.size : undefined;
  return { ok: true, layout: gen({ width, height, named, ...(sizeKey ? { sizeKey } : {}) }) };
}

/** Grid zone of a sheet point (`C4`: letter then number), or null outside the zones. */
export function zoneAt(layout: TemplateLayout, p: Vec2): string | null {
  if (!layout.zones) return null;
  const find = (edges: number[], v: number) => {
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i] ?? 0;
      const hi = edges[i + 1] ?? 0;
      if (v >= lo && v <= hi) return i;
    }
    return -1;
  };
  const ix = find(layout.zones.x.edges, p[0]);
  const iy = find(layout.zones.y.edges, p[1]);
  if (ix < 0 || iy < 0) return null;
  return `${layout.zones.y.labels[iy]}${layout.zones.x.labels[ix]}`;
}
