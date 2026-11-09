/**
 * Validates a document against the published JSON Schemas (packages/document/schema, served at
 * `https://jackhale98.github.io/wren-cad/schema/<file>`): the whole document and every project file
 * of its canonical folder. Node-only (tests and E2E).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WrenDoc } from '@wren-cad/contracts';
import { projectCodec } from '@wren-cad/document';
import { Ajv } from 'ajv';

const schemaDir = join(import.meta.dirname, '../../../packages/document/schema');
const load = (name: string): object => JSON.parse(readFileSync(join(schemaDir, name), 'utf8'));

let validators: Record<string, ReturnType<Ajv['compile']>> | null = null;

function compiled() {
  if (validators) return validators;
  const ajv = new Ajv({ allErrors: true, strict: true });
  validators = {
    project: ajv.compile(load('wren-project.schema.json')),
    params: ajv.compile(load('wren-params.schema.json')),
    part: ajv.compile(load('wren-part.schema.json')),
    document: ajv.compile(load('wren-document.schema.json')),
  };
  return validators;
}

/** Schema `$id`s (must point at the published copies). */
export function schemaIds(): string[] {
  return ['wren-project', 'wren-params', 'wren-part', 'wren-document'].map(
    (n) => (load(`${n}.schema.json`) as { $id: string }).$id,
  );
}

/** Validation errors (empty = valid). */
export function schemaErrors(doc: WrenDoc): string[] {
  const v = compiled();
  const out: string[] = [];
  const check = (name: string, fn: ReturnType<Ajv['compile']> | undefined, value: unknown) => {
    if (fn && !fn(value))
      for (const e of fn.errors ?? []) out.push(`${name}${e.instancePath} ${e.message}`);
  };
  check('document', v.document, doc);
  for (const [path, bytes] of projectCodec.toFiles(doc)) {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    const kind =
      path === 'wren.project.json'
        ? 'project'
        : path === 'params.json'
          ? 'params'
          : path.endsWith('.part.json')
            ? 'part'
            : undefined;
    if (kind) check(path, v[kind], value);
  }
  return out;
}
