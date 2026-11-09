/// Project fixtures: a small document as canonical files, and edits to it.

import type { Param, ProjectFiles, WrenDoc } from '@wren-cad/contracts';
import { fromFiles, newDoc, newPart, toFiles, ulid } from '@wren-cad/document';

export const NOW = '2026-11-08T10:00:00.000Z';

export function makeDoc(params: Record<string, string> = { width: '40 mm', height: '20 mm' }) {
  const doc = newDoc({ name: 'Bracket', now: NOW });
  doc.params = Object.entries(params).map(([name, expr]) => ({ id: ulid(), name, expr }));
  doc.parts = [newPart('Bracket'), newPart('Lid')];
  return doc;
}

export const filesOf = (doc: WrenDoc): ProjectFiles => toFiles(doc);
export const docOf = (files: ProjectFiles): WrenDoc => fromFiles(files);

/** Sets parameter `name` to `expr` (adds it if missing) and bumps `meta.modified`. */
export function withParam(doc: WrenDoc, name: string, expr: string, at = NOW): WrenDoc {
  const next = structuredClone(doc);
  const p = next.params.find((x: Param) => x.name === name);
  if (p) p.expr = expr;
  else next.params.push({ id: ulid(), name, expr });
  next.meta.modified = at;
  return next;
}

export const paramOf = (doc: WrenDoc, name: string) =>
  doc.params.find((p) => p.name === name)?.expr;
