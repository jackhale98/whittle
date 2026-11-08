import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.WHITTLE_UI_E2E_PORT ?? 4179);

/**
 * Visual regression + a11y smoke for the three shells. Uses the pre-installed Chromium
 * (PLAYWRIGHT_BROWSERS_PATH); never run `playwright install`. Screenshots are taken at
 * deviceScaleFactor 2 with reduced motion so they are deterministic and legible.
 */
export default defineConfig({
  testDir: 'e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  fullyParallel: true,
  reporter: [['list']],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    reducedMotion: 'reduce',
    deviceScaleFactor: 2,
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      },
    },
    {
      name: 'tablet',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1180, height: 820 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'phone',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: `npx vite --config vite.config.ts --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
