#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES.txt for the web build (LGPL/MIT/ISC/OFL notice requirements).
// Usage: node scripts/third-party-notices.mjs [outFile]   (default apps/web/dist/THIRD_PARTY_NOTICES.txt)
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.argv[2] ?? 'apps/web/dist/THIRD_PARTY_NOTICES.txt');

// Type-only packages never ship in the bundle.
const TYPE_ONLY = (name) => name.startsWith('@types/') || name === 'csstype';

const tree = JSON.parse(
  execSync('pnpm --filter @whittle/web list --prod --json --depth Infinity', {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const pkgs = new Map();
const walk = (deps) => {
  for (const [name, info] of Object.entries(deps ?? {})) {
    const key = `${name}@${info.version}`;
    if (pkgs.has(key)) continue;
    pkgs.set(key, { name, version: info.version, path: info.path });
    walk(info.dependencies);
  }
};
for (const p of tree) walk(p.dependencies);

function licenseText(dir) {
  if (!dir || !existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(n));
  return f ? readFileSync(join(dir, f), 'utf8').trim() : null;
}

const rule = '='.repeat(78);
const parts = [
  `Whittle — third-party notices
${rule}
Whittle is free software: GPL-3.0-or-later. Source: https://github.com/jackhale98/whittle
This file lists the third-party software included in this build and its licence terms.
`,
  `${rule}
Open CASCADE Technology (OCCT) 8.0.1 — LGPL-2.1-only WITH Open-CASCADE-Exception-1.0
${rule}
The geometry kernel files whittle-kernel*.wasm / whittle-kernel*.js are OCCT compiled to
WebAssembly with the libcascade / opencascade.js v3 toolchain (taucad/opencascade.js), linked with
Whittle's façade. The complete corresponding build scripts and façade sources are in
packages/kernel of the Whittle repository, so you can rebuild and relink the kernel.
OCCT source: https://github.com/Open-Cascade-SAS/OCCT

${readFileSync(join(root, 'licenses/OCCT_LGPL_EXCEPTION.txt'), 'utf8').trim()}

${readFileSync(join(root, 'licenses/LGPL-2.1.txt'), 'utf8').trim()}
`,
];

const sorted = [...pkgs.values()]
  .filter((p) => !p.name.startsWith('@whittle/') && !TYPE_ONLY(p.name))
  .sort((a, b) => a.name.localeCompare(b.name));
let missing = 0;
for (const p of sorted) {
  const meta = JSON.parse(readFileSync(join(p.path, 'package.json'), 'utf8'));
  const lic = typeof meta.license === 'string' ? meta.license : (meta.license?.type ?? 'UNKNOWN');
  const text = licenseText(p.path);
  if (!text) missing++;
  parts.push(`${rule}
${p.name}@${p.version} — ${lic}${meta.homepage ? `\n${meta.homepage}` : ''}
${rule}
${text ?? `(No licence file shipped in the package; licence: ${lic}.)`}
`);
}

writeFileSync(out, `${parts.join('\n')}\n`);
console.log(
  `third-party notices: ${sorted.length} packages + OCCT → ${out}${missing ? ` (${missing} without a licence file)` : ''}`,
);
