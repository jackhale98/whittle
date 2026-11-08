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
