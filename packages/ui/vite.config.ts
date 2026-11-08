import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Config for the visual-regression harness only. The library itself has no build step. */
export default defineConfig({
  root: 'harness',
  plugins: [react(), tailwindcss()],
  server: { port: 4179, strictPort: true, host: '127.0.0.1' },
  preview: { port: 4179, strictPort: true, host: '127.0.0.1' },
  build: { outDir: '../dist-harness', emptyOutDir: true },
});
