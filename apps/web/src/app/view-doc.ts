/**
 * The displayed document: while an inspector pick field takes edges or faces, the model is rolled
 * back to just before that feature (as Onshape does), so picks name the feature's input geometry.
 */

import type { WrenDoc } from '@wren-cad/contracts';
import type { Workbench } from './workbench';

export function viewDoc(wb: Workbench): WrenDoc {
  const doc = wb.store.getDoc();
  const p = wb.ui.get().picking;
  const part = doc.parts[0];
  if (!p || !part) return doc;
  const kinds = wb.pickAccepts()?.kinds ?? [];
  if (!kinds.some((k) => k === 'edge' || k === 'face' || k === 'vertex')) return doc;
  const idx = part.features.findIndex((f) => f.id === p.featureId);
  if (idx < 0 || idx >= part.rollbackIndex) return doc;
  const memo = wb.viewMemo;
  if (memo && memo.doc === doc && memo.index === idx) return memo.out;
  const out = { ...doc, parts: [{ ...part, rollbackIndex: idx }, ...doc.parts.slice(1)] };
  wb.viewMemo = { doc, index: idx, out };
  return out;
}
