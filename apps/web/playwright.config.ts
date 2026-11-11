import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.WREN_E2E_PORT ?? 4173);
/** Same base as the build (CI: `/<repository name>/`, ADR-032). */
const BASE_PATH = process.env.WREN_BASE ?? '/wren-cad/';
const PWA_SHELL = /pwa-shell\.spec\.ts/;
/** The M3 reference parts take ~20 min serially: their own project, sharded on CI (ci.yml). */
const REFERENCE = /m3-reference-parts\.spec\.ts/;
/** Long-session soak (PLAN H1): its own project, needs WREN_SOAK=1; nightly / on demand in ci.yml. */
const SOAK = /soak\.spec\.ts/;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // Pixel baselines are recorded outside CI (font and GL rasterisation differ on the runners), as in
  // packages/ui (ADR-086): CI runs every functional assertion of those specs but skips the pixel
  // comparison; locally they compare.
  ignoreSnapshots: Boolean(process.env.CI),
  // One test at a time on CI: the 2-vCPU runners render with SwiftShader (software GL) and run
  // the kernel's Wasm threads; parallel pages starve each other into timeouts.
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  // Production build served like GitHub Pages: base /wren-cad/, NO COOP/COEP from the server, so
  // isolation can only come from the service worker.
  webServer: {
    command: `node scripts/static-serve.mjs --dir dist --base ${BASE_PATH} --port ${PORT} --fixtures e2e/fixtures`,
    url: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts/,
      testIgnore: [PWA_SHELL, REFERENCE, SOAK],
      use: { ...devices['Desktop Chrome'] },
    },
    { name: 'chromium-reference', testMatch: REFERENCE, use: { ...devices['Desktop Chrome'] } },
    // Installed-PWA chrome checks (no page zoom, no scroll) with Chromium touch emulation at iPad
    // Pro 11 size. Gating. The real iPad engine runs as `webkit-ipad` below (non-gating).
    {
      name: 'chromium-touch',
      testMatch: PWA_SHELL,
      use: {
        ...devices['Desktop Chrome'],
        viewport: devices['iPad Pro 11'].viewport,
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'firefox',
      testMatch: /.*\.spec\.ts/,
      testIgnore: [PWA_SHELL, REFERENCE, SOAK],
      use: {
        ...devices['Desktop Firefox'],
        // CI runs Firefox headed under Xvfb (see ci.yml) so it gets Mesa's software GL.
        headless: !process.env.WREN_HEADED,
        // GPU-less CI runners: headless Firefox refuses WebGL unless software GL is allowed
        // ("this.gl is null" in the viewport). Real Firefox with a GPU needs none of this.
        launchOptions: {
          firefoxUserPrefs: {
            'webgl.force-enabled': true,
            'webgl.disabled': false,
            'webgl.enable-webgl2': true,
          },
        },
      },
    },
    {
      name: 'webkit',
      testMatch: /.*\.spec\.ts/,
      testIgnore: [PWA_SHELL, REFERENCE, SOAK],
      use: { ...devices['Desktop Safari'] },
    },
    // WebKit with Playwright's "iPad Pro 11" emulation. Non-gating like the other WebKit job.
    { name: 'webkit-ipad', testMatch: PWA_SHELL, use: { ...devices['iPad Pro 11'] } },
    {
      name: 'soak',
      testMatch: SOAK,
      fullyParallel: false,
      use: { ...devices['Desktop Chrome'] },
    },
    // Report-only stress part (100+ feature enclosure): non-gating, nightly in soak.yml. Its files
    // are `*.stress.ts`, so neither `perf` (gating) nor `chromium` picks them up.
    {
      name: 'stress',
      testMatch: /.*\.stress\.ts/,
      fullyParallel: false,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'perf',
      testMatch: /.*\.perf\.ts/,
      // Perf numbers are only meaningful serially on an otherwise idle machine.
      fullyParallel: false,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
