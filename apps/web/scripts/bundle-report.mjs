#!/usr/bin/env node
// Per-chunk bundle report (PLAN H1). Lists every JS file in dist/ with raw and gzip size, marks the
// ones index.html loads eagerly ("initial") and prints the initial-route headroom against the
// 250 kB gzip budget (the gate itself stays `pnpm size`, .size-limit.mjs). Everything else is a lazy
// chunk: if a new editor shows up in the initial list, it stopped lazy-loading.
//
// Usage: node scripts/bundle-report.mjs [--dist dist] [--md report.md] [--json report.json]
//   Markdown also goes to $GITHUB_STEP_SUMMARY when set. Exits 1 if the initial route is over budget.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET_GZIP = 250 * 1000; // size-limit's "kB" is 1000 bytes

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const dist = resolve(opt('--dist', join(here, '..', 'dist')));
const mdOut = opt('--md');
const jsonOut = opt('--json');
const base = process.env.WREN_BASE ?? '/wren-cad/';

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`${dist}/index.html not found: build first.`);
  process.exit(2);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(m?js)$/.test(name)) yield full;
  }
}

// Same definition of "initial route" as .size-limit.mjs.
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const initial = new Set();
for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
  const isScript = /^<script\b/.test(tag) && /\btype="module"/.test(tag);
  const isPreload = /^<link\b/.test(tag) && /\brel="modulepreload"/.test(tag);
  if (!isScript && !isPreload) continue;
  const url = tag.match(/\b(?:src|href)="([^"]+)"/)?.[1];
  if (url?.endsWith('.js')) {
    initial.add(url.startsWith(base) ? url.slice(base.length) : url.replace(/^\//, ''));
  }
}

const chunks = [...walk(dist)].map((file) => {
  const buf = readFileSync(file);
  const path = relative(dist, file).split('\\').join('/');
  return {
    path,
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    kind: initial.has(path) ? 'initial' : /(^|\/)(sw|workbox-)/.test(path) ? 'service worker' : 'lazy',
  };
});
chunks.sort((a, b) => b.gzip - a.gzip);

const kb = (n) => `${(n / 1000).toFixed(1)} kB`;
const sum = (list, key) => list.reduce((s, c) => s + c[key], 0);
const init = chunks.filter((c) => c.kind === 'initial');
const lazy = chunks.filter((c) => c.kind === 'lazy');
const initGzip = sum(init, 'gzip');
const headroom = BUDGET_GZIP - initGzip;

const row = (c) => `| \`${c.path}\` | ${kb(c.raw)} | ${kb(c.gzip)} | ${c.kind} |`;
const md = [
  '## Bundle report',
  '',
  `Initial route: **${kb(initGzip)} gzip** of ${kb(BUDGET_GZIP)} budget, headroom **${kb(headroom)}** (${((headroom / BUDGET_GZIP) * 100).toFixed(1)}%) ${headroom >= 0 ? '' : '(OVER BUDGET)'}`,
  '',
  `${init.length} initial chunk(s), ${lazy.length} lazy chunk(s); total ${kb(sum(chunks, 'raw'))} raw, ${kb(sum(chunks, 'gzip'))} gzip.`,
  '',
  '### Initial-route chunks (loaded by index.html)',
  '',
  '| Chunk | Raw | Gzip | Kind |',
  '| --- | ---: | ---: | --- |',
  ...init.map(row),
  '',
  '### Lazy chunks (a new editor appearing above means it stopped lazy-loading)',
  '',
  '| Chunk | Raw | Gzip | Kind |',
  '| --- | ---: | ---: | --- |',
  ...lazy.map(row),
  ...chunks.filter((c) => c.kind === 'service worker').length
    ? ['', '### Service worker', '', '| Chunk | Raw | Gzip | Kind |', '| --- | ---: | ---: | --- |', ...chunks.filter((c) => c.kind === 'service worker').map(row)]
    : [],
  '',
].join('\n');

console.log(md);
if (mdOut) writeFileSync(mdOut, md);
if (jsonOut) {
  writeFileSync(
    jsonOut,
    `${JSON.stringify({ budgetGzip: BUDGET_GZIP, initialGzip: initGzip, headroomGzip: headroom, chunks }, null, 2)}\n`,
  );
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
if (headroom < 0) {
  console.error(`Initial route is ${kb(-headroom)} over the ${kb(BUDGET_GZIP)} gzip budget.`);
  process.exit(1);
}
