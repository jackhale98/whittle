/**
 * Needs-attention actions: re-pick, the candidate chooser for ambiguous references and in-flight UI action tracking.
 */

import type { EntityRef, Id } from '@wren-cad/contracts';
import { locateName } from '../model/attention';
import { applyPick } from '../selection/pick';
import type { Workbench } from './workbench';

export function repick(wb: Workbench, featureId: Id, path?: string): void {
  const status = wb.treeStatuses.get()?.find((s) => s.featureId === featureId);
  const u = path ? status?.unresolved?.find((x) => x.path === path) : status?.unresolved?.[0];
  const target = u?.path ?? path;
  if (!target) return;
  wb.patchUi({ featureId, picking: { featureId, path: target }, selection: [], prompt: null });
  wb.refreshSketchVisibility();
  wb.pushHighlights();
  if (u?.reason === 'ambiguous' && u.candidates?.length) {
    const fp = u.ref.fingerprint?.centroid;
    const s = fp && wb.viewport ? wb.viewport.worldToScreen(fp) : null;
    const r = wb.canvas?.getBoundingClientRect();
    wb.patchUi({
      candidates: {
        featureId,
        path: target,
        kind: u.ref.kind,
        names: [...u.candidates],
        x: (r?.left ?? 0) + (s?.visible ? s.x : (r?.width ?? 0) / 2),
        y: (r?.top ?? 0) + (s?.visible ? s.y : (r?.height ?? 0) / 2),
      },
    });
  } else wb.patchUi({ candidates: null });
}

export function track<T>(wb: Workbench, p: Promise<T>): Promise<T> {
  wb.actions.add(p);
  const done = () => wb.actions.delete(p);
  p.then(done, done);
  return p;
}

export function chooseCandidate(wb: Workbench, name: string | null): Promise<void> {
  return wb.track(wb.applyCandidate(name));
}

export async function applyCandidate(wb: Workbench, name: string | null): Promise<void> {
  const c = wb.ui.get().candidates;
  wb.patchUi({ candidates: null });
  if (!c || name === null) return;
  // The picking view (rolled back to the feature's input) holds the candidates.
  await wb.loop?.whenIdle();
  const at = locateName(wb.regen.get()?.result, name, c.kind);
  const part = wb.part;
  const f = part?.features.find((x) => x.id === c.featureId);
  if (!part || !f) return;
  const ref = at ? await wb.modeling?.refFor(part.id, at) : null;
  const next = applyPick(f, c.path, ref ?? { name, kind: c.kind });
  wb.apply({ kind: 'updateFeature', partId: part.id, featureId: f.id, feature: next });
  wb.commit();
  wb.patchUi({ picking: null });
}

export function locate(
  wb: Workbench,
  name: string,
  kind: EntityRef['kind'],
): [number, number, number] | null {
  const result = wb.regen.get()?.result;
  const at = locateName(result, name, kind);
  const mesh = result?.bodies.find((b) => b.id === at?.bodyId)?.mesh;
  if (!at || !mesh) return null;
  const sum: [number, number, number] = [0, 0, 0];
  let n = 0;
  const addPoint = (arr: Float32Array, i: number) => {
    sum[0] += arr[i * 3] as number;
    sum[1] += arr[i * 3 + 1] as number;
    sum[2] += arr[i * 3 + 2] as number;
    n++;
  };
  if (at.kind === 'edge') {
    const first = mesh.edgeRanges[at.index * 2] ?? 0;
    const count = mesh.edgeRanges[at.index * 2 + 1] ?? 0;
    for (let i = first; i < first + count; i++) addPoint(mesh.edgePositions, i);
  } else {
    const first = mesh.faceRanges[at.index * 2] ?? 0;
    const count = mesh.faceRanges[at.index * 2 + 1] ?? 0;
    for (let t = first; t < first + count; t++)
      for (let k = 0; k < 3; k++) addPoint(mesh.positions, mesh.indices[t * 3 + k] as number);
  }
  return n ? [sum[0] / n, sum[1] / n, sum[2] / n] : null;
}

export function previewCandidate(wb: Workbench, name: string | null): void {
  const c = wb.ui.get().candidates;
  const at = c && name ? locateName(wb.regen.get()?.result, name, c.kind) : null;
  wb.patchUi({ hover: at ? { ...at, point: [0, 0, 0], distancePx: 0 } : null });
  wb.pushHighlights();
}
