import { describe, expect, it } from 'vitest';
import { spareResultsFor } from '../model/modeling';
import {
  kernelBootFor,
  meshQualityFor,
  policyFor,
  regenBudgetFor,
  shouldBootKernel,
} from './tier-policy';

describe('tier policy (PLAN §8.4)', () => {
  it('regen cache budget shrinks with the tier; desktop keeps the engine default', () => {
    expect(regenBudgetFor('desktop')).toBeUndefined();
    expect(regenBudgetFor('tablet')).toBe(4);
    expect(regenBudgetFor('phone')).toBe(2);
  });

  it('agrees with the model layer helper currently applied at boot', () => {
    for (const tier of ['desktop', 'tablet', 'phone'] as const)
      expect(regenBudgetFor(tier)).toBe(spareResultsFor(tier));
  });

  it('mesh quality: phones coarse, others fine', () => {
    expect(meshQualityFor('desktop')).toBe('fine');
    expect(meshQualityFor('tablet')).toBe('fine');
    expect(meshQualityFor('phone')).toBe('coarse');
  });

  it('only phones boot the kernel on first edit', () => {
    expect(kernelBootFor('desktop')).toBe('eager');
    expect(kernelBootFor('tablet')).toBe('eager');
    expect(kernelBootFor('phone')).toBe('onEdit');
    expect(policyFor('phone').tier).toBe('phone');
  });

  it('shouldBootKernel: phone waits for an edit or for a document that has no cached mesh', () => {
    expect(shouldBootKernel('desktop', { editStarted: false })).toBe(true);
    expect(shouldBootKernel('tablet', { editStarted: false })).toBe(true);
    expect(shouldBootKernel('phone', { editStarted: false })).toBe(false);
    expect(shouldBootKernel('phone', { editStarted: true })).toBe(true);
    expect(shouldBootKernel('phone', { editStarted: false, needsKernelToRender: true })).toBe(true);
  });
});
