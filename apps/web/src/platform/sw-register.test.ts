import { describe, expect, it } from 'vitest';
import { shouldReloadForIsolation } from './sw-register';

describe('shouldReloadForIsolation', () => {
  it('reloads once when the worker controls a non-isolated page', () => {
    expect(
      shouldReloadForIsolation({ isolated: false, controlled: true, alreadyReloaded: false }),
    ).toBe(true);
  });

  it('never reloads when already isolated', () => {
    expect(
      shouldReloadForIsolation({ isolated: true, controlled: true, alreadyReloaded: false }),
    ).toBe(false);
  });

  it('never reloads twice (loop guard)', () => {
    expect(
      shouldReloadForIsolation({ isolated: false, controlled: true, alreadyReloaded: true }),
    ).toBe(false);
  });

  it('does not reload when no worker controls the page (reload would change nothing)', () => {
    expect(
      shouldReloadForIsolation({ isolated: false, controlled: false, alreadyReloaded: false }),
    ).toBe(false);
  });
});
