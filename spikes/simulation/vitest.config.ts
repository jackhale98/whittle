// Spike S0 runner config (outside the pnpm workspace; not part of `pnpm test`).
// Run from the repo root: node_modules/.bin/vitest run --config spikes/simulation/vitest.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { include: ['export/*.test.ts'], testTimeout: 120_000 },
});
