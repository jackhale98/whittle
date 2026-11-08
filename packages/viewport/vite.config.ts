import { defineConfig } from 'vite';

/** Standalone dev harness for the viewport (not the app). `pnpm --filter @whittle/viewport harness`. */
export default defineConfig({
  root: 'harness',
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5199, strictPort: true, host: '127.0.0.1' },
  build: { outDir: '../dist/harness', emptyOutDir: true, target: 'es2022' },
});
