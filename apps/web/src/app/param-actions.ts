/** Params-tab actions that need the workbench (ADR-080). Kept out of workbench.ts on purpose. */

import type { ParamUse } from '@wren-cad/ui';
import type { Workbench } from './workbench';

/**
 * A click on an entry of a parameter's "Used by" list: selects the feature, or for a sketch
 * dimension opens the sketch (if it is not open) and selects the dimension.
 */
export async function selectParamUse(wb: Workbench, use: ParamUse): Promise<void> {
  if (use.configurationId && wb.config.active?.id !== use.configurationId) {
    wb.config.setActive(use.configurationId);
  }
  const id = use.featureId;
  const f = id ? wb.part?.features.find((x) => x.id === id) : undefined;
  if (!id || !f) return;
  if (f.type === 'sketch') {
    if (wb.sketch?.featureId !== id) await wb.enterSketch(id, false);
    if (use.constraintId) wb.sketch?.selectConstraint(use.constraintId);
    return;
  }
  if (wb.sketch) wb.sketch.exit(true); // leave the sketch being edited, then select
  wb.selectFeature(id);
}
