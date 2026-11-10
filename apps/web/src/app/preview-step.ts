/**
 * The displayed document and the phone's step-through preview (ADR-068): rollback for picking, preview, keep and step timings.
 */

import type { WrenDoc } from '@wren-cad/contracts';
import type { RegenView } from './state';
import type { Workbench } from './workbench';

export function viewDoc(wb: Workbench): WrenDoc {
  const doc = wb.store.getDoc();
  const p = wb.ui.get().picking;
  const part = doc.parts[0];
  const pv = wb.preview.get();
  if (pv !== null && part) {
    // Phone step-through (M3.6): a copy of the document at another rollback position. The
    // document itself is untouched; the copy is memoised so the regen loop sees a stable value.
    const idx = Math.max(0, Math.min(part.features.length, pv));
    if (idx === part.rollbackIndex) return doc;
    const memo = wb.previewMemo;
    if (memo && memo.doc === doc && memo.index === idx) return memo.out;
    const out = { ...doc, parts: [{ ...part, rollbackIndex: idx }, ...doc.parts.slice(1)] };
    wb.previewMemo = { doc, index: idx, out };
    return out;
  }
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

export function previewRollback(wb: Workbench, index: number): void {
  const part = wb.part;
  if (!part) return;
  const idx = Math.max(0, Math.min(part.features.length, Math.round(index)));
  if (wb.preview.get() === idx) return;
  wb.ensureKernel(); // a phone viewer boots the kernel on the first step
  wb.previewSteps.push({ index: idx, t0: performance.now() });
  wb.preview.set(idx);
  wb.refreshSketchVisibility();
  wb.loop?.request();
}

export function endPreview(wb: Workbench): void {
  if (wb.preview.get() === null) return;
  wb.preview.set(null);
  wb.previewMemo = null;
  wb.refreshSketchVisibility();
  wb.loop?.request();
}

export function keepPreview(wb: Workbench): void {
  const part = wb.part;
  const idx = wb.preview.get();
  if (!part || idx === null) return;
  wb.preview.set(null);
  wb.previewMemo = null;
  if (idx !== part.rollbackIndex) {
    wb.apply({ kind: 'setRollback', partId: part.id, index: idx }, undefined, 'rollback');
    wb.commit();
  } else {
    wb.loop?.request();
  }
}

export function recordPreviewStep(wb: Workbench, outcome: RegenView): void {
  if (wb.preview.get() === null || outcome.doc !== wb.viewDoc()) return;
  const idx = outcome.doc.parts[0]?.rollbackIndex;
  const at = wb.previewSteps.findIndex((x) => x.index === idx);
  if (at < 0) return;
  const [step] = wb.previewSteps.splice(at, 1);
  if (!step) return;
  const cached = outcome.result.features.every(
    (f) => f.cached || f.state === 'rolledBack' || f.state === 'suppressed',
  );
  void (wb.viewport?.nextFrame() ?? Promise.resolve()).then(() => {
    wb.previewTimings.push({
      index: step.index,
      ms: Math.round(performance.now() - step.t0),
      cached,
    });
  });
}
