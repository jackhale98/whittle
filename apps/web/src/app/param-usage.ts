/**
 * "Used by" for the Params tab (ADR-080): which features, sketch dimensions and other parameters
 * refer to each parameter. A pure function of the document, so it is cheap to test.
 *
 * Direct references only: a feature that uses `a`, where `a = b * 2`, is listed under `a`; `a` is
 * listed under `b`. An expression field counts once per parameter however often the name occurs.
 * A reference (driven) dimension holds a measured value, not an expression, so it never counts.
 */

import type { Id, SketchFeature, WrenDoc } from '@wren-cad/contracts';
import { exprFields, getAt } from '@wren-cad/document';
import { type ParamUse, paramRefs } from '@wren-cad/ui';

/** Pointer segments that only wrap the interesting one (`/end/depth` reads as "depth"). */
const WRAPPERS = new Set(['end', 'mode', 'definition', 'constraints', 'annotations', 'at']);

/** "/second/spacing" -> "second spacing", "/draft" -> "draft", "/tipAngle" -> "tip angle". */
export function fieldLabel(pointer: string): string {
  const segs = pointer.split('/').filter((s) => s !== '' && !/^\d+$/.test(s));
  const useful = segs.filter((s) => !WRAPPERS.has(s));
  const keep = (useful.length > 0 ? useful : segs).slice(-2);
  return keep.map((s) => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()).join(' ');
}

function dimensionDetail(f: SketchFeature, constraintId: Id): string {
  const c = f.constraints.find((k) => k.id === constraintId);
  const n = f.constraints.filter((k) => 'value' in k).findIndex((k) => k.id === constraintId);
  const kind =
    c?.kind === 'hDistance' ? 'horizontal' : c?.kind === 'vDistance' ? 'vertical' : c?.kind;
  return `${kind ?? 'dimension'} dimension${n >= 0 ? ` ${n + 1}` : ''}`;
}

/** Every use of every parameter, keyed by parameter id (parameters never used map to []). */
export function paramUsage(doc: Pick<WrenDoc, 'params' | 'parts'>): Record<Id, ParamUse[]> {
  const names = doc.params.map((p) => p.name);
  const byName = new Map(doc.params.map((p) => [p.name, p.id]));
  const out: Record<Id, ParamUse[]> = {};
  for (const p of doc.params) out[p.id] = [];
  const add = (name: string, use: ParamUse) => {
    const id = byName.get(name);
    if (id) out[id]?.push(use);
  };

  for (const p of doc.params) {
    for (const name of paramRefs(p.expr, names)) {
      if (name === p.name) continue; // a self-reference is an error, not a use
      add(name, { key: `param:${p.id}`, kind: 'param', label: p.name, paramId: p.id });
    }
  }

  for (const part of doc.parts) {
    for (const f of part.features) {
      for (const field of exprFields(f)) {
        if (field.driven) continue;
        const raw = getAt(f as never, field.pointer);
        if (typeof raw !== 'string') continue;
        for (const name of paramRefs(raw, names)) {
          const dim = field.constraintId !== undefined && f.type === 'sketch';
          add(name, {
            key: `${f.id}:${field.pointer}`,
            kind: dim ? 'dimension' : 'feature',
            label: f.name,
            detail:
              dim && f.type === 'sketch'
                ? dimensionDetail(f, field.constraintId as Id)
                : fieldLabel(field.pointer),
            featureId: f.id,
            ...(field.constraintId !== undefined ? { constraintId: field.constraintId } : {}),
          });
        }
      }
    }
  }
  return out;
}
