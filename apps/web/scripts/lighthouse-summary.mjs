// Prints a Markdown table of the Lighthouse CI results in .lighthouseci (median of the runs per
// category) for the GitHub step summary. Usage (from apps/web): node scripts/lighthouse-summary.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve('.lighthouseci');
const runs = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => /^lhr-.*\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')))
  : [];

if (runs.length === 0) {
  console.log('### Lighthouse\n\nNo reports were produced.');
  process.exit(0);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rows = Object.keys(runs[0].categories).map(
  (id) =>
    `| ${runs[0].categories[id].title} | ${Math.round(median(runs.map((r) => r.categories[id].score ?? 0)) * 100)} |`,
);
const metric = (id) => Math.round(median(runs.map((r) => r.audits[id].numericValue)));
console.log(`### Lighthouse (median of ${runs.length}, non-gating)\n`);
console.log('| Category | Score |\n| --- | --- |');
console.log(rows.join('\n'));
console.log(
  `\nFCP ${metric('first-contentful-paint')} ms, LCP ${metric('largest-contentful-paint')} ms, TBT ${metric('total-blocking-time')} ms (mobile emulation, 4x CPU slowdown).`,
);
