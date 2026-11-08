/**
 * What each device tier means for the app (PLAN §8.4, §10 memory budget). Pure data + functions so
 * the app consults one place: regen cache size, mesh quality, and when the kernel boots.
 */

import type { DeviceTier, MeshQuality } from '@whittle/contracts';

/** When the kernel worker should be started. */
export type KernelBoot = 'eager' | 'onEdit';

export interface TierPolicy {
  tier: DeviceTier;
  /**
   * `configureRegen({ maxSpareResults })` / `createKernelClient({ regen: { maxSpareResults } })`.
   * `undefined` = keep the regen engine's default (128).
   */
  regenMaxSpareResults: number | undefined;
  /** Mesh quality the document settles at. Phones stay coarse (viewer-first, memory). */
  meshQuality: MeshQuality;
  /**
   * `eager`: boot the kernel while the shell paints. `onEdit`: phones are viewer-first; the
   * cached meshes render without a kernel and the Wasm (several MB) loads when an edit starts.
   */
  kernelBoot: KernelBoot;
}

const POLICIES: Record<DeviceTier, TierPolicy> = {
  desktop: {
    tier: 'desktop',
    regenMaxSpareResults: undefined,
    meshQuality: 'fine',
    kernelBoot: 'eager',
  },
  tablet: { tier: 'tablet', regenMaxSpareResults: 4, meshQuality: 'fine', kernelBoot: 'eager' },
  phone: { tier: 'phone', regenMaxSpareResults: 2, meshQuality: 'coarse', kernelBoot: 'onEdit' },
};

export function policyFor(tier: DeviceTier): TierPolicy {
  return POLICIES[tier];
}

export function regenBudgetFor(tier: DeviceTier): number | undefined {
  return POLICIES[tier].regenMaxSpareResults;
}

export function meshQualityFor(tier: DeviceTier): MeshQuality {
  return POLICIES[tier].meshQuality;
}

/** "Phone loads the kernel lazily": consult before `bootKernel()`. */
export function kernelBootFor(tier: DeviceTier): KernelBoot {
  return POLICIES[tier].kernelBoot;
}

/**
 * Whether to start the kernel now. `editStarted` is true once the user begins an edit (or opens
 * something that has no cached mesh and so cannot render without the kernel).
 */
export function shouldBootKernel(
  tier: DeviceTier,
  state: { editStarted: boolean; needsKernelToRender?: boolean },
): boolean {
  if (kernelBootFor(tier) === 'eager') return true;
  return state.editStarted || state.needsKernelToRender === true;
}
