#!/usr/bin/env node
// Prints raw / gzip / brotli sizes of every kernel artefact in dist/ and writes
// dist/size-report.json. Fails (exit 1) when a main kernel exceeds the PLAN §7.2 budget of
// 15 MB brotli. SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const BUDGET_BROTLI_BYTES = 15 * 1024 * 1024;

if (!existsSync(dist)) {
  process.stderr.write('size-report: dist/ is missing; run `pnpm build` first.\n');
  process.exit(1);
}

const files = readdirSync(dist)
  .filter((f) => /^whittle-kernel(-st)?\.(js|wasm)$/.test(f))
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

const overBudget = rows.filter((r) => r.file.endsWith('.wasm') && r.brotli > BUDGET_BROTLI_BYTES);
const report = {
  generatedAt: new Date().toISOString(),
  budgetBrotliBytes: BUDGET_BROTLI_BYTES,
  withinBudget: overBudget.length === 0,
  files: rows,
};
writeFileSync(join(dist, 'size-report.json'), `${JSON.stringify(report, null, 2)}\n`);

const pad = (s, n) => String(s).padEnd(n);
process.stdout.write(`${pad('artefact', 24)}${pad('raw', 12)}${pad('gzip -9', 12)}brotli -q11\n`);
for (const r of rows) {
  process.stdout.write(
    `${pad(r.file, 24)}${pad(mb(r.raw), 12)}${pad(mb(r.gzip), 12)}${mb(r.brotli)}\n`,
  );
}
process.stdout.write(`budget: ≤ ${mb(BUDGET_BROTLI_BYTES)} brotli per kernel .wasm — `);
process.stdout.write(
  overBudget.length === 0 ? 'OK\n' : `EXCEEDED by ${overBudget.map((r) => r.file).join(', ')}\n`,
);
process.exit(overBudget.length === 0 ? 0 : 1);
