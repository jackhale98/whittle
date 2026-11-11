import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke test of the Cloudflare Pages build (ADR-082): `WREN_BASE=/ pnpm build`, then
 * `node scripts/cloudflare-dist.mjs dist`, served at the root with the build's `_headers` applied
 * (static-serve --cloudflare). Run: `pnpm --filter @wren-cad/web e2e:cloudflare`.
 */
const PORT = Number(process.env.WREN_E2E_PORT ?? 4173);

export default defineConfig({
  testDir: './e2e-cloudflare',
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}/`, trace: 'off', video: 'off', screenshot: 'off' },
  webServer: {
    command: `node scripts/static-serve.mjs --dir dist --cloudflare --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
