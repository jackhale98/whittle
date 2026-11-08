import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.VIEWPORT_PORT ?? 5199);

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
    command: 'pnpm exec vite',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
