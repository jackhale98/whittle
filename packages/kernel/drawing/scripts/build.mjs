#!/usr/bin/env node
// Drawing kernel build (ADR-090 amendment): amalgamate → libcascade build (Docker, the same
// digest-pinned images as the main kernel) → assemble → size report. Writes drawing/dist/.
// Usage: node drawing/scripts/build.mjs [--variant single|multi]   (default: every variant)
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const drawing = join(dirname(fileURLToPath(import.meta.url)), '..');
const kernel = join(drawing, '..');
const passthrough = process.argv.slice(2);
const config = ['--config', join(drawing, 'libcascade.config.ts')];

const run = (cmd, args) => {
  const started = Date.now();
  process.stdout.write(`\n$ ${cmd} ${args.join(' ')}\n`);
  const result = spawnSync(cmd, args, { cwd: drawing, stdio: 'inherit', shell: false });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    process.stderr.write(`build:drawing: '${cmd} ${args.join(' ')}' failed after ${seconds}s\n`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`build:drawing: '${cmd} ${args.join(' ')}' took ${seconds}s\n`);
};

const libcascade = join(kernel, 'node_modules', '.bin', 'libcascade');
run(process.execPath, [join(drawing, 'scripts', 'amalgamate.mjs')]);
run(libcascade, ['build', ...config, ...passthrough]);
run(libcascade, ['assemble', ...config]);
run(process.execPath, [join(drawing, 'scripts', 'size-report.mjs')]);
