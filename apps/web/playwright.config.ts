import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.WHITTLE_E2E_PORT ?? 4173);
const BASE_PATH = '/whittle/';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  // Production build served like GitHub Pages: base /whittle/, NO COOP/COEP from the server, so
  // isolation can only come from the service worker.
  webServer: {
    command: `node scripts/static-serve.mjs --dir dist --base ${BASE_PATH} --port ${PORT} --fixtures e2e/fixtures`,
    url: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', testMatch: /.*\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', testMatch: /.*\.spec\.ts/, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', testMatch: /.*\.spec\.ts/, use: { ...devices['Desktop Safari'] } },
    {
      name: 'perf',
      testMatch: /.*\.perf\.ts/,
      // Perf numbers are only meaningful serially on an otherwise idle machine.
      fullyParallel: false,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
