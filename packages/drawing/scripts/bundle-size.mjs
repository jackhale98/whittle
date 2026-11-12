#!/usr/bin/env node
// Bundle size of each @wren-cad/drawing entry (minified ES module, gzip), in memory: nothing is
// written to disk. `@wren-cad/contracts` is type-only; fflate is bundled where used (PDF).
// Usage: pnpm --filter @wren-cad/drawing size
// SPDX-License-Identifier: GPL-3.0-or-later

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entries = {
  '@wren-cad/drawing/annotation': 'src/annotation/index.ts',
  '@wren-cad/drawing (root)': 'src/index.ts',
  '@wren-cad/drawing/svg': 'src/svg/index.ts',
  '@wren-cad/drawing/pdf': 'src/pdf/index.ts',
  '@wren-cad/drawing/dxf': 'src/dxf/index.ts',
  '@wren-cad/drawing/zip': 'src/zip/index.ts',
};

const rows = [];
for (const [name, entry] of Object.entries(entries)) {
  const out = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      lib: { entry: join(root, entry), formats: ['es'], fileName: 'out' },
    },
  });
  const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
  const code = outputs
    .filter((c) => c.type === 'chunk')
    .map((c) => c.code)
    .join('\n');
  rows.push([name, code.length, gzipSync(code, { level: 9 }).length]);
}
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
for (const [name, raw, gz] of rows)
  console.log(`${name.padEnd(32)} ${kb(raw).padStart(9)} min  ${kb(gz).padStart(9)} gzip`);
console.log(
  'Font asset (lazy: the drawing route and PDF export): osifont-lgpl3fe.ttf 123.6 KB raw, 76.6 KB gzip',
);
