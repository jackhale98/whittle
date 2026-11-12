// PLAN §10 backstop: initial-route JS <= 500 kB gzip (ADR-097; the gate users feel is the shell
// TTI probe, e2e/perf/shell.perf.ts). "Initial route" = exactly the scripts that
// dist/index.html loads eagerly (<script src> + <link rel="modulepreload">). Lazy chunks, the
// service worker, the kernel glue and every .wasm are excluded by construction.
// Run `pnpm --filter @wren-cad/web build` first.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(root, 'dist/index.html');

if (!existsSync(indexPath)) {
  throw new Error('dist/index.html not found: run `pnpm --filter @wren-cad/web build` first.');
}

const html = readFileSync(indexPath, 'utf8');
const base = process.env.WREN_BASE ?? '/wren-cad/';
const urls = new Set();
for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
  const isScript = /^<script\b/.test(tag) && /\btype="module"/.test(tag);
  const isPreload = /^<link\b/.test(tag) && /\brel="modulepreload"/.test(tag);
  if (!isScript && !isPreload) continue;
  const url = tag.match(/\b(?:src|href)="([^"]+)"/)?.[1];
  if (url?.endsWith('.js')) urls.add(url);
}

const files = [...urls].map((url) => {
  const relative = url.startsWith(base) ? url.slice(base.length) : url.replace(/^\//, '');
  return resolve(root, 'dist', relative);
});

if (files.length === 0) throw new Error('No initial-route scripts found in dist/index.html');

export default [
  {
    name: 'initial route JS (gzip)',
    path: files,
    limit: '500 kB',
    gzip: true,
  },
];
