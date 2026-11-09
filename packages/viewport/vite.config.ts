import { defineConfig } from 'vite';

/** Standalone dev harness for the viewport (not the app). `pnpm --filter @wren-cad/viewport harness`. */
const port = Number(process.env.VIEWPORT_PORT ?? 5199);

export default defineConfig({
  root: 'harness',
  server: { port, strictPort: true, host: '127.0.0.1' },
  preview: { port, strictPort: true, host: '127.0.0.1' },
  build: { outDir: '../dist/harness', emptyOutDir: true, target: 'es2022' },
});
