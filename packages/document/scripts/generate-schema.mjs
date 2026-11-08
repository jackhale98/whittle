// SPDX-License-Identifier: GPL-3.0-or-later
// Generates JSON Schemas for the project files from the TypeScript types in src/files.ts (which
// re-export the contract types). Output is canonical (sorted keys, 2-space, LF, trailing newline)
// so the committed files only change when the types do.
//
//   pnpm --filter @whittle/document schema           # (re)write schema/*.schema.json
//   node scripts/generate-schema.mjs --check         # exit 1 if the committed files are stale

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** type name in src/files.ts → output file */
export const SCHEMAS = {
  ProjectManifest: 'whittle-project.schema.json',
  ParamsFile: 'whittle-params.schema.json',
  PartFile: 'whittle-part.schema.json',
  DrawingFile: 'whittle-drawing.schema.json',
  AssemblyFile: 'whittle-assembly.schema.json',
  DocumentFile: 'whittle-document.schema.json',
};

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    );
  }
  return v;
}

export function generate() {
  const out = {};
  for (const [type, file] of Object.entries(SCHEMAS)) {
    const schema = createGenerator({
      path: join(root, 'src/files.ts'),
      tsconfig: join(root, 'tsconfig.json'),
      type,
      expose: 'export',
      topRef: false,
      additionalProperties: false,
      jsDoc: 'extended',
      skipTypeCheck: true,
    }).createSchema(type);
    schema.$id = `https://whittle.dev/schema/${file}`;
    schema.title = type;
    out[file] = `${JSON.stringify(sortKeys(schema), null, 2)}\n`;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const out = generate();
  mkdirSync(join(root, 'schema'), { recursive: true });
  let stale = false;
  for (const [file, text] of Object.entries(out)) {
    const path = join(root, 'schema', file);
    if (check) {
      let current = '';
      try {
        current = readFileSync(path, 'utf8');
      } catch {}
      if (current !== text) {
        stale = true;
        console.error(`stale: schema/${file}`);
      }
    } else {
      writeFileSync(path, text);
      console.log(`wrote schema/${file}`);
    }
  }
  if (stale) process.exit(1);
}
