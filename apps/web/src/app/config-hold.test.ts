import type { PickHit } from '@wren-cad/contracts';
import { describe, expect, it, vi } from 'vitest';
import { refFor } from './pointer';
import type { Workbench } from './workbench';

/** While "Export all" uses the live slot, a pick must not resolve against another configuration. */
describe('refFor during export-all', () => {
  const hit = { bodyId: 'B1', kind: 'face', index: 3, point: [0, 0, 0] } as unknown as PickHit;
  const make = (exportingAll: boolean) => {
    const modelingRefFor = vi.fn(async () => ({ name: 'F', kind: 'face' as const }));
    const wb = {
      part: { id: 'P' },
      modeling: { refFor: modelingRefFor },
      config: { exportingAll },
    } as unknown as Workbench;
    return { wb, modelingRefFor };
  };
  it('is refused while exporting, and never reaches the engine', async () => {
    const { wb, modelingRefFor } = make(true);
    expect(await refFor(wb, hit)).toBeNull();
    expect(modelingRefFor).not.toHaveBeenCalled();
  });
  it('resolves against the live model otherwise', async () => {
    const { wb, modelingRefFor } = make(false);
    expect(await refFor(wb, hit)).not.toBeNull();
    expect(modelingRefFor).toHaveBeenCalled();
  });
});
