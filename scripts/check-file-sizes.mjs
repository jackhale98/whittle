#!/usr/bin/env node
// File-size guardrail (PLAN H1). Covers .ts/.tsx under packages/*/src and apps/*/src.
//  - warn  past WARN_LINES (1,500)
//  - fail  past FAIL_LINES (2,500), except files in scripts/file-size-allowlist.json, which may not
//          grow past their recorded ceiling. Ceilings only go down: a file that shrinks below its
//          ceiling prints a reminder to lower it (a failure with --strict), and one that drops
//          under the fail line should be removed from the list.
// Usage: node scripts/check-file-sizes.mjs [--strict] [--root <dir>] [--allowlist <file>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WARN_LINES = 1500;
const FAIL_LINES = 2500;

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const strict = args.includes('--strict');
const root = resolve(opt('--root', join(here, '..')));
const allowPath = resolve(opt('--allowlist', join(here, 'file-size-allowlist.json')));

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(name)) yield full;
  }
}

function sourceRoots() {
  const out = [];
  for (const group of ['packages', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) {
      const src = join(base, pkg, 'src');
      if (existsSync(src)) out.push(src);
    }
  }
  return out;
}

function countLines(file) {
  const text = readFileSync(file, 'utf8');
  if (text.length === 0) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

const allow = existsSync(allowPath)
  ? (JSON.parse(readFileSync(allowPath, 'utf8')).ceilings ?? {})
  : {};
const errors = [];
const notes = [];
const warnings = [];
const seen = new Set();

for (const src of sourceRoots()) {
  for (const file of walk(src)) {
    const rel = relative(root, file).split('\\').join('/');
    const lines = countLines(file);
    const ceiling = allow[rel];
    if (ceiling !== undefined) {
      seen.add(rel);
      if (lines > ceiling) {
        errors.push(
          `${rel}: ${lines} lines exceeds its allow-list ceiling of ${ceiling} (ceilings only go down; split the file)`,
        );
      } else if (lines <= FAIL_LINES) {
        notes.push(`${rel}: ${lines} lines is under ${FAIL_LINES}; remove it from the allow-list`);
      } else if (lines < ceiling) {
        notes.push(`${rel}: ${lines} lines is below its ceiling of ${ceiling}; lower the ceiling to ${lines}`);
      } else {
        warnings.push(`${rel}: ${lines} lines (allow-listed, ceiling ${ceiling})`);
      }
    } else if (lines > FAIL_LINES) {
      errors.push(`${rel}: ${lines} lines exceeds the ${FAIL_LINES}-line limit (split it by responsibility)`);
    } else if (lines > WARN_LINES) {
      warnings.push(`${rel}: ${lines} lines is past the ${WARN_LINES}-line soft limit`);
    }
  }
}
for (const rel of Object.keys(allow)) {
  if (!seen.has(rel)) notes.push(`${rel}: allow-listed but not found; remove it from the allow-list`);
}

const gh = process.env.GITHUB_ACTIONS === 'true';
for (const w of warnings) console.log(gh ? `::warning::${w}` : `warn  ${w}`);
for (const n of notes) {
  if (strict) errors.push(n);
  else console.log(gh ? `::notice::${n}` : `note  ${n}`);
}
for (const e of errors) console.error(gh ? `::error::${e}` : `FAIL  ${e}`);
console.log(
  `file sizes: ${errors.length} failure(s), ${warnings.length} warning(s), ${notes.length} note(s)`,
);
process.exit(errors.length ? 1 : 0);
