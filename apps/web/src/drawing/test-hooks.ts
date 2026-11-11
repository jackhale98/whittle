/**
 * E2E hooks of the drawing route (`window.__wrenDrawing`): read-only views of the build and a
 * settle promise. Installed when the route loads, so they cost the initial route nothing. Not an
 * extension API.
 */

import { curveToSheet, viewOutline } from '@wren-cad/drawing';
import type { DrawingController } from './controller';

export interface DrawingHooks {
  settled(): Promise<void>;
  /** Named visible edges of a view on the sheet (sheet mm): where a test can click. */
  edges(viewId: string): {
    name: string;
    kind: string;
    at: [number, number];
    a?: [number, number];
    b?: [number, number];
    radius?: number;
  }[];
  /** Laid-out placements: where their text sits (sheet mm) and what they say. */
  placements(): {
    id: string;
    annotationId: string;
    viewId: string;
    layout: unknown;
    text: [number, number] | null;
    attention: boolean;
  }[];
  state(): {
    phase: string;
    drawingId: string | null;
    sheetId: string | null;
    tool: string;
    selected: unknown;
    pending: boolean;
    error: string | null;
    kernel: string;
    panel: string;
    hint: string | null;
    projection: string | null;
    views: {
      id: string;
      kind: string;
      from?: string;
      layout: string;
      position: [number, number] | null;
      scale: number | null;
      outline: { min: [number, number]; max: [number, number] } | null;
      curves: number;
      problems: string[];
    }[];
    placements: number;
    attention: { key: string; severity: string; message: string }[];
    texts: string[];
    resolutions: { id: string; state: string; value: number | null }[];
  };
}

declare global {
  interface Window {
    __wrenDrawing?: DrawingHooks;
  }
}

export function installDrawingHooks(c: DrawingController): void {
  window.__wrenDrawing = {
    settled: () => c.settled(),
    placements() {
      const b = c.ui.get().built;
      return (b?.drawing.placements ?? []).map((p) => {
        const placed = b?.build.placed.find((x) => x.placementId === p.id);
        const box = placed?.textBox ?? [];
        const n = box.length || 1;
        return {
          id: p.id,
          annotationId: p.annotationId,
          viewId: p.viewId,
          layout: p.layout,
          text: box.length
            ? ([box.reduce((s, v) => s + v[0], 0) / n, box.reduce((s, v) => s + v[1], 0) / n] as [
                number,
                number,
              ])
            : null,
          attention: placed?.attention ?? false,
        };
      });
    },
    edges(viewId) {
      const b = c.ui.get().built;
      const sv = b?.build.views.get(viewId);
      if (!b || !sv?.ok) return [];
      const out: ReturnType<DrawingHooks['edges']> = [];
      for (const k of b.projections.get(viewId)?.curves ?? []) {
        if (k.role !== 'visible' || !k.name) continue;
        const p = curveToSheet(k.curve, sv);
        if (p.kind === 'line')
          out.push({
            name: k.name,
            kind: 'line',
            at: [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2],
            a: p.a,
            b: p.b,
          });
        else if (p.kind === 'arc') {
          const a = (p.start + p.end) / 2;
          out.push({
            name: k.name,
            kind: 'arc',
            at: [p.center[0] + p.radius * Math.cos(a), p.center[1] + p.radius * Math.sin(a)],
            radius: p.radius,
          });
        }
      }
      return out;
    },
    state() {
      const ui = c.ui.get();
      const b = ui.built;
      const sheet = c.sheet();
      const composed = b?.build.sheets.find((s) => s.sheetId === sheet?.id);
      return {
        phase: ui.phase,
        drawingId: ui.drawingId,
        sheetId: ui.sheetId,
        tool: ui.tool,
        selected: ui.selected,
        pending: ui.pending,
        error: ui.error,
        kernel: ui.kernel,
        panel: ui.panel,
        hint: ui.hint?.text ?? null,
        projection: b?.drawing.projection ?? null,
        views: (b?.drawing.views ?? []).map((v) => {
          const s = b?.build.views.get(v.id);
          return {
            id: v.id,
            kind: v.kind,
            ...(v.kind === 'projected' ? { from: v.from } : {}),
            layout: v.layout.kind,
            position: s?.ok ? s.position : null,
            scale: s?.ok ? s.scale : null,
            outline: s?.ok ? viewOutline(s) : null,
            curves: b?.projections.get(v.id)?.curves.length ?? 0,
            problems: s && !s.ok ? s.problems.map((p) => p.kind) : [],
          };
        }),
        placements: b?.drawing.placements.length ?? 0,
        attention: (b?.build.attention ?? []).map((e) => ({
          key: e.key,
          severity: e.severity,
          message: e.message,
        })),
        texts: (composed?.list.items ?? []).flatMap((i) => (i.kind === 'text' ? [i.text] : [])),
        resolutions: [...(b?.main.resolutions.values() ?? [])].map((r) => ({
          id: r.annotationId,
          state: r.state,
          value: r.value ?? null,
        })),
      };
    },
  };
}
