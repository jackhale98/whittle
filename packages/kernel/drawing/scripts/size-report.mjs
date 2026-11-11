#!/usr/bin/env node
// Raw / gzip / brotli sizes of the drawing kernel artefacts in drawing/dist/, written to
// drawing/dist/size-report.json, next to the main kernel's for comparison (ADR-090 amendment).
//
// Budget: 4 MiB brotli per drawing .wasm. That is the decision's own gate: the trimmed build
// exists because it is much smaller than reusing the main kernel (4.56 MiB brotli at the time of
// the decision); above 4 MiB the separate build no longer pays for its second download and CI
// time, and the decision must be revisited. Exit 1 when exceeded.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const drawing = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(drawing, 'dist');
const mainReport = join(drawing, '..', 'dist', 'size-report.json');
const BUDGET_BROTLI_BYTES = 4 * 1024 * 1024;

if (!existsSync(dist)) {
  process.stderr.write('size-report: drawing/dist/ is missing; run `pnpm build:drawing` first.\n');
  process.exit(1);
}

const files = readdirSync(dist)
  .filter((f) => /^wren-drawing(-st)?\.(js|wasm)$/.test(f))
  .sort();

const mb = (n) => `${(n / (1024 * 1024)).toFixed(2)} MB`;
const rows = files.map((file) => {
  const bytes = readFileSync(join(dist, file));
  const gzip = gzipSync(bytes, { level: 9 }).length;
  const brotli = brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  }).length;
  return { file, raw: statSync(join(dist, file)).size, gzip, brotli };
});

let main = null;
if (existsSync(mainReport)) {
  const r = JSON.parse(readFileSync(mainReport, 'utf8'));
  main = Object.fromEntries(r.files.map((f) => [f.file, f.brotli]));
}
const overBudget = rows.filter((r) => r.file.endsWith('.wasm') && r.brotli > BUDGET_BROTLI_BYTES);
const report = {
  generatedAt: new Date().toISOString(),
  budgetBrotliBytes: BUDGET_BROTLI_BYTES,
  withinBudget: overBudget.length === 0,
  files: rows,
  mainKernelBrotli: main,
};
writeFileSync(join(dist, 'size-report.json'), `${JSON.stringify(report, null, 2)}\n`);

const pad = (s, n) => String(s).padEnd(n);
process.stdout.write(`${pad('artefact', 24)}${pad('raw', 12)}${pad('gzip -9', 12)}brotli -q11\n`);
for (const r of rows) {
  process.stdout.write(
    `${pad(r.file, 24)}${pad(mb(r.raw), 12)}${pad(mb(r.gzip), 12)}${mb(r.brotli)}\n`,
  );
}
if (main !== null) {
  const pairs = [
    ['wren-drawing-st.wasm', 'whittle-kernel-st.wasm'],
    ['wren-drawing.wasm', 'whittle-kernel.wasm'],
  ];
  for (const [d, m] of pairs) {
    const dr = rows.find((r) => r.file === d);
    if (dr !== undefined && main[m] !== undefined) {
      const pct = ((100 * dr.brotli) / main[m]).toFixed(1);
      process.stdout.write(`${d}: ${mb(dr.brotli)} brotli = ${pct} % of ${m} (${mb(main[m])})\n`);
    }
  }
}
process.stdout.write(`budget: ≤ ${mb(BUDGET_BROTLI_BYTES)} brotli per drawing .wasm — `);
process.stdout.write(
  overBudget.length === 0 ? 'OK\n' : `EXCEEDED by ${overBudget.map((r) => r.file).join(', ')}\n`,
);
process.exit(overBudget.length === 0 ? 0 : 1);
