/**
 * The stress part (see `enclosure.ts`): document builder and id helpers. Deterministic: the same
 * dimensions give byte-identical documents, so the committed `.wrencad` can be checked against it.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature, Id, WrenDoc } from '@wren-cad/contracts';
import { materialFromLibrary, newDoc } from '@wren-cad/document';
import { buildFeatures, paramExpr, stepFid } from '../reference-parts/lib/builder';
import {
  baselineEnclosureDims,
  ENCLOSURE_DIMS,
  ENCLOSURE_NO,
  type EnclosureDims,
  enclosureSteps,
} from './enclosure';

export {
  baselineEnclosureDims,
  ENCLOSURE_DIMS,
  ENCLOSURE_NO,
  type EnclosureDims,
  enclosureSteps,
} from './enclosure';

export const ENCLOSURE_PART_ID: Id = stepFid(ENCLOSURE_NO, 998);
const NOW = '2026-11-10T00:00:00.000Z';

/** Step id (for example `boss`) to feature id. */
export function enclosureFeatureIds(): Record<string, Id> {
  return Object.fromEntries(
    enclosureSteps(baselineEnclosureDims()).map((s, i) => [s.id, stepFid(ENCLOSURE_NO, i)]),
  );
}

/** Step ids in document order. */
export function enclosureStepIds(): string[] {
  return enclosureSteps(baselineEnclosureDims()).map((s) => s.id);
}

export function enclosureFeatures(): Feature[] {
  const dims = baselineEnclosureDims();
  return buildFeatures(
    ENCLOSURE_NO,
    enclosureSteps(dims),
    dims as unknown as Record<string, number>,
  );
}

/** The enclosure document. `fillets: false` leaves out the dozens of blend features (A/B and bisection). */
export function enclosureDoc(opts: { dims?: Partial<EnclosureDims>; name?: string } = {}): WrenDoc {
  const doc = newDoc({ name: opts.name ?? 'Stress enclosure', now: NOW });
  doc.params = Object.entries(ENCLOSURE_DIMS).map(([name, d], i) => ({
    id: stepFid(ENCLOSURE_NO, 900 + i),
    name,
    expr: paramExpr(opts.dims?.[name as keyof EnclosureDims] ?? d.value, d.unit),
    description: d.description,
  }));
  const material = materialFromLibrary('whittle:abs');
  if (material === undefined) throw new Error('unknown material whittle:abs');
  const features = enclosureFeatures();
  doc.parts = [
    {
      id: ENCLOSURE_PART_ID,
      name: 'Enclosure',
      features,
      rollbackIndex: features.length,
      material,
    },
  ];
  return doc;
}
