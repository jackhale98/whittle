import { describe, expect, it } from 'vitest';
import { isOAuthCallbackSearch, shouldReloadForIsolation } from './sw-register';

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

describe('OAuth redirect back', () => {
  it('recognises authorization responses', () => {
    expect(isOAuthCallbackSearch('?code=abc&state=xyz')).toBe(true);
    expect(isOAuthCallbackSearch('?error=access_denied&state=xyz')).toBe(true);
    expect(isOAuthCallbackSearch('?code=abc')).toBe(false);
    expect(isOAuthCallbackSearch('')).toBe(false);
  });

  it('does not reload a page that carries a one-time code', () => {
    expect(
      shouldReloadForIsolation({
        isolated: false,
        controlled: true,
        alreadyReloaded: false,
        oauthCallback: true,
      }),
    ).toBe(false);
  });
});
