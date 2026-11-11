#!/usr/bin/env node
// Prepares and guards the site that is force-pushed to the `cloudflare-pages` branch (ADR-082).
//
//   node scripts/cloudflare-dist.mjs [dist] [--max-mib 25]
//
// 1. Removes `404.html`. GitHub Pages needs it as the SPA fallback; on Cloudflare Pages its mere
//    presence switches off SPA mode (unknown paths would answer 404 with that page), so without it
//    Cloudflare serves `index.html` with status 200 for every unknown path.
// 2. Checks the root-base invariants (`_headers` shipped, manifest start_url/scope/id `/`).
// 3. Fails if any file exceeds Cloudflare Pages' 25 MiB per-file limit; prints the largest files.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const MIB = 1024 * 1024;

/** Every file under `dir` with its size in bytes, largest first. */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push({ path: relative(dir, p), bytes: statSync(p).size });
    }
  };
  walk(dir);
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** @returns {string[]} problems; empty when the dist is publishable. */
export function checkDist(dir, maxMib = 25) {
  const problems = [];
  for (const f of listFiles(dir)) {
    if (f.bytes > maxMib * MIB)
      problems.push(
        `${f.path} is ${(f.bytes / MIB).toFixed(2)} MiB, over the ${maxMib} MiB Cloudflare Pages per-file limit`,
      );
  }
  if (!existsSync(join(dir, '_headers'))) problems.push('_headers is missing from the build');
  if (!existsSync(join(dir, 'index.html'))) problems.push('index.html is missing from the build');
  const manifest = join(dir, 'manifest.webmanifest');
  if (existsSync(manifest)) {
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const key of ['start_url', 'scope', 'id'])
      if (m[key] !== '/')
        problems.push(`manifest ${key} is ${JSON.stringify(m[key])}, expected "/"`);
  } else problems.push('manifest.webmanifest is missing from the build');
  return problems;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'max-mib': { type: 'string', default: '25' } },
  });
  const dir = resolve(positionals[0] ?? 'dist');
  const max = Number(values['max-mib']);
  rmSync(join(dir, '404.html'), { force: true });
  console.log('Largest files:');
  for (const f of listFiles(dir).slice(0, 8))
    console.log(`  ${(f.bytes / MIB).toFixed(2).padStart(8)} MiB  ${f.path}`);
  const problems = checkDist(dir, max);
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  console.log(`Cloudflare dist OK (${dir}; every file <= ${max} MiB).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
