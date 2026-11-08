import { describe, expect, it } from 'vitest';
import {
  buildDiagnostics,
  detectTier,
  type EnvSnapshot,
  PHONE_MAX_SHORT_SIDE,
} from './diagnostics';

const desktop: EnvSnapshot = {
  hardwareConcurrency: 12,
  deviceMemory: 8,
  screenWidth: 2560,
  screenHeight: 1440,
  primaryPointer: 'fine',
  crossOriginIsolated: true,
};

describe('detectTier', () => {
  it('desktop: fine pointer, capable hardware', () => {
    expect(detectTier(desktop)).toBe('desktop');
  });

  it('desktop: unknown device memory (Firefox/Safari) is not penalised', () => {
    const { deviceMemory: _ignored, ...rest } = desktop;
    expect(detectTier(rest)).toBe('desktop');
  });

  it('desktop: no pointer information (headless) with good hardware', () => {
    expect(detectTier({ ...desktop, primaryPointer: 'none' })).toBe('desktop');
  });

  it('tablet: touch-primary iPad-sized screen', () => {
    expect(
      detectTier({
        ...desktop,
        primaryPointer: 'coarse',
        screenWidth: 1024,
        screenHeight: 1366,
        hardwareConcurrency: 8,
      }),
    ).toBe('tablet');
  });

  it('phone: touch-primary with short side below the threshold', () => {
    expect(
      detectTier({ ...desktop, primaryPointer: 'coarse', screenWidth: 390, screenHeight: 844 }),
    ).toBe('phone');
  });

  it('phone/tablet boundary uses the shortest side, in either orientation', () => {
    const base = { ...desktop, primaryPointer: 'coarse' as const };
    expect(detectTier({ ...base, screenWidth: 844, screenHeight: PHONE_MAX_SHORT_SIDE - 1 })).toBe(
      'phone',
    );
    expect(detectTier({ ...base, screenWidth: 844, screenHeight: PHONE_MAX_SHORT_SIDE })).toBe(
      'tablet',
    );
  });

  it('tablet tier for weak mouse-and-keyboard machines', () => {
    expect(detectTier({ ...desktop, hardwareConcurrency: 2 })).toBe('tablet');
    expect(detectTier({ ...desktop, deviceMemory: 2 })).toBe('tablet');
    expect(detectTier({ ...desktop, hardwareConcurrency: 4, deviceMemory: 4 })).toBe('desktop');
  });

  it('a fine pointer on a small screen is still desktop (resized window, not a phone)', () => {
    expect(detectTier({ ...desktop, screenWidth: 500, screenHeight: 500 })).toBe('desktop');
  });
});

describe('detectTier: UA / platform / touch points', () => {
  const IPAD_UA =
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const MAC_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
  const IPHONE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const ANDROID_PHONE_UA =
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
  const ANDROID_TABLET_UA =
    'Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

  it('iPad UA is a tablet', () => {
    expect(detectTier({ ...desktop, userAgent: IPAD_UA, primaryPointer: 'coarse' })).toBe('tablet');
  });

  it('iPadOS reporting itself as a Mac with touch is a tablet, even with a trackpad', () => {
    const env = {
      ...desktop,
      userAgent: MAC_UA,
      platform: 'MacIntel',
      maxTouchPoints: 5,
      screenWidth: 834,
      screenHeight: 1194,
    };
    expect(detectTier({ ...env, primaryPointer: 'coarse' })).toBe('tablet');
    expect(detectTier({ ...env, primaryPointer: 'fine' })).toBe('tablet');
    expect(detectTier({ ...env, primaryPointer: 'none' })).toBe('tablet');
  });

  it('a real Mac (no touch points) stays desktop', () => {
    expect(
      detectTier({ ...desktop, userAgent: MAC_UA, platform: 'MacIntel', maxTouchPoints: 0 }),
    ).toBe('desktop');
    expect(detectTier({ ...desktop, userAgent: MAC_UA, platform: 'MacIntel' })).toBe('desktop');
  });

  it('a touch-screen Windows laptop stays desktop', () => {
    expect(
      detectTier({
        ...desktop,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36',
        platform: 'Win32',
        maxTouchPoints: 10,
      }),
    ).toBe('desktop');
  });

  it('iPhone is a phone, in either orientation', () => {
    expect(detectTier({ ...desktop, userAgent: IPHONE_UA, primaryPointer: 'coarse' })).toBe(
      'phone',
    );
    expect(
      detectTier({
        ...desktop,
        userAgent: IPHONE_UA,
        primaryPointer: 'coarse',
        screenWidth: 932,
        screenHeight: 430,
      }),
    ).toBe('phone');
  });

  it('Android: Mobile token is a phone, none is a tablet', () => {
    expect(detectTier({ ...desktop, userAgent: ANDROID_PHONE_UA, primaryPointer: 'coarse' })).toBe(
      'phone',
    );
    expect(detectTier({ ...desktop, userAgent: ANDROID_TABLET_UA, primaryPointer: 'coarse' })).toBe(
      'tablet',
    );
  });

  it('falls back to pointer and screen size when the UA is unrecognised', () => {
    expect(
      detectTier({
        ...desktop,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140',
        primaryPointer: 'coarse',
        screenWidth: 390,
        screenHeight: 844,
      }),
    ).toBe('phone');
  });
});

describe('buildDiagnostics', () => {
  it('assembles RuntimeDiagnostics', () => {
    const result = buildDiagnostics(
      desktop,
      { serviceWorker: 'active', kernelVariant: 'threaded', renderBackend: 'webgpu' },
      '1.2.3+abc1234',
    );
    expect(result).toEqual({
      tier: 'desktop',
      crossOriginIsolated: true,
      kernelVariant: 'threaded',
      renderBackend: 'webgpu',
      hardwareConcurrency: 12,
      deviceMemory: 8,
      primaryPointer: 'fine',
      serviceWorker: 'active',
      appVersion: '1.2.3+abc1234',
    });
  });

  it('omits deviceMemory when the browser does not expose it', () => {
    const { deviceMemory: _ignored, ...rest } = desktop;
    const result = buildDiagnostics(
      { ...rest, crossOriginIsolated: false },
      { serviceWorker: 'none', kernelVariant: null, renderBackend: null },
      '0.0.0+dev',
    );
    expect('deviceMemory' in result).toBe(false);
    expect(result.crossOriginIsolated).toBe(false);
    expect(result.kernelVariant).toBeNull();
  });
});
