import { defineConfig } from 'vite';

/** Tiny harness for the browser-only library path. `pnpm --filter @whittle/io harness`. */
export default defineConfig({
  root: 'harness',
  server: { port: 5198, strictPort: true, host: '127.0.0.1' },
  build: { outDir: '../dist/harness', emptyOutDir: true, target: 'es2022' },
});
