import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';
import { preloadShell } from '../src/shells/AppShell';

// The touch shells are lazy chunks in the app; tests render them synchronously.
beforeAll(async () => {
  await Promise.all([preloadShell('tablet'), preloadShell('phone')]);
});

afterEach(() => cleanup());

// jsdom lacks these browser APIs which Radix / Motion probe.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
Element.prototype.scrollIntoView ??= () => {};
