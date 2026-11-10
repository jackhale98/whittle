import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.VIEWPORT_PORT ?? 5199);
// WREN_VIEWPORT_PREVIEW=1 serves the harness's production build (`vite preview`) instead of the dev
// server. The perf job uses it: the dev server re-optimises dependencies it finds late and reloads
// the page, which surfaces as "Execution context was destroyed" in the middle of a probe.
const PREVIEW = Boolean(process.env.WREN_VIEWPORT_PREVIEW);

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    launchOptions: {
      args: [
        // Deterministic software GL for the WebGL2 path in GPU-less containers.
        '--use-angle=swiftshader',
        '--use-gl=angle',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        // Lets WebGPU run where an adapter exists (headless may still have none -> fallback).
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
      ],
    },
  },
  webServer: {
    command: PREVIEW ? 'pnpm exec vite build && pnpm exec vite preview' : 'pnpm exec vite',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: PREVIEW ? 240_000 : 60_000,
  },
});
