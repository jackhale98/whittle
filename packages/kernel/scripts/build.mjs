#!/usr/bin/env node
// Full kernel build: amalgamate → libcascade build (Docker) → assemble → size report.
// Usage: node scripts/build.mjs [--variant single|multi]   (default: every variant)
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const passthrough = process.argv.slice(2);

const run = (cmd, args) => {
  const started = Date.now();
  process.stdout.write(`\n$ ${cmd} ${args.join(' ')}\n`);
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    process.stderr.write(`build: '${cmd} ${args.join(' ')}' failed after ${seconds}s\n`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`build: '${cmd} ${args.join(' ')}' took ${seconds}s\n`);
};

const libcascade = join(root, 'node_modules', '.bin', 'libcascade');
run(process.execPath, [join(root, 'scripts', 'amalgamate.mjs')]);
run(libcascade, ['build', ...passthrough]);
run(libcascade, ['assemble']);
run(process.execPath, [join(root, 'scripts', 'size-report.mjs')]);
