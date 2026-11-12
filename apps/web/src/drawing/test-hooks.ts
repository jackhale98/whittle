/**
 * E2E hooks of the drawing route (`window.__wrenDrawing`): read-only views of the build and a
 * settle promise. Installed when the route loads, so they cost the initial route nothing. Not an
 * extension API.
 */

import { curveToSheet, primitiveBox, textBox, viewOutline } from '@wren-cad/drawing';
import type { DrawingController } from './controller';
import { viewHit } from './interact';
import { pickEdge } from './ops-annot';

export interface DrawingHooks {
  settled(): Promise<void>;
  /** Replaces the drawing kernel with one that fails to load, as a failed Wasm fetch would. */
  failKernel(): void;
  /** Waits until the shown edges are the exact ones (what an export waits for). */
  exact(): Promise<void>;
  /** The kernel's output for a view, part mm (not sheet mm). */
  projection(viewId: string): {
    quality: string;
    curves: {
      role: string;
      edge: string;
      name?: string;
      /** The outlined face (`ProjectedCurve.face`). */
      face?: string;
      kind: string;
      radius?: number;
      center?: [number, number];
      sweep?: number;
      a?: [number, number];
      b?: [number, number];
    }[];
    sectionFaces: { face: string; loops: number }[];
    /** The kernel's own wall time for this projection. */
    ms: number;
  } | null;
  /**
   * Named visible edges of a view on the sheet (sheet mm): where a test can click. Outlines
   * without an edge name are listed by the face they outline (`name` empty, `face` set).
   */
  edges(viewId: string): {
    name: string;
    face?: string;
    kind: string;
    at: [number, number];
    a?: [number, number];
    b?: [number, number];
    radius?: number;
    /** Arcs: start and end angle on the sheet (radians, counter-clockwise). */
    start?: number;
    end?: number;
  }[];
  /** Laid-out placements: where their text sits (sheet mm) and what they say. */
  placements(): {
    id: string;
    annotationId: string;
    viewId: string;
    layout: unknown;
    text: [number, number] | null;
    box: { min: [number, number]; max: [number, number] } | null;
    attention: boolean;
    /** Leader layouts as drawn (sheet mm): attach point, the line it is held on, bends, text. */
    leader: {
      attach: string;
      at: [number, number];
      on: [[number, number], [number, number]] | null;
      bends: [number, number][];
      text: [number, number];
    } | null;
    /** A dimension's line between its arrow tips. */
    line: [[number, number], [number, number]] | null;
    /** The kinds of display items it drew (a datum triangle is a `fill`). */
    items: string[];
  }[];
  /**
   * Every laid-out placement's real extent, from the display list items it drew (sheet mm): the
   * text boxes (as the renderers measure them), every straight segment (dimension, extension and
   * leader lines) and the bounds of everything. What overlap checks measure, not an estimate.
   */
  extents(): {
    placementId: string;
    annotationId: string;
    viewId: string;
    /** The label as drawn, text items joined by a space. */
    text: string;
    texts: { min: [number, number]; max: [number, number] }[];
    segments: [[number, number], [number, number]][];
    bounds: { min: [number, number]; max: [number, number] } | null;
  }[];
  /**
   * What a picking tool's click at sheet point `at` (mm) picks with tolerance `tol` (mm): the view
   * item's source, and the edge pick made of it (null when it makes none).
   */
  hit(
    at: [number, number],
    tol: number,
  ): { source: unknown; pick: { name: string; ref: string; shape: string; face?: string } | null };
  /** The open import plan (Import panel), one row per candidate; null when the panel is closed. */
  importPlan():
    | {
        key: string;
        kind: string;
        annotationKind: string;
        checked: boolean;
        viewId: string | null;
        reason: string | null;
        duplicateOf: string | null;
        count: boolean;
      }[]
    | null;
  state(): {
    phase: string;
    drawingId: string | null;
    sheetId: string | null;
    tool: string;
    selected: unknown;
    pending: boolean;
    error: string | null;
    quality: string;
    refining: boolean;
    projectionProblems: string[];
    hatchLines: number;
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
    resolutions: {
      id: string;
      state: string;
      value: number | null;
      /** Measured from the geometry (absent when it cannot be). */
      measured: number | null;
      count: number | null;
    }[];
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
    exact: () => c.ensureExact(),
    failKernel() {
      c.kernel.dispose();
      c.kernel = {
        project: async () => ({
          ok: false,
          error: { code: 'INTERNAL', message: 'Failed to load the threaded drawing kernel.' },
        }),
        dispose: () => {},
      };
      c.schedule(0);
    },
    projection(viewId) {
      const b = c.ui.get().built;
      const p = b?.projections.get(viewId);
      if (!b || !p) return null;
      return {
        quality: b.quality,
        ms: p.ms,
        curves: p.curves.map((k) => ({
          role: k.role,
          edge: k.edge,
          ...(k.name ? { name: k.name } : {}),
          ...(k.face ? { face: k.face } : {}),
          kind: k.curve.kind,
          ...(k.curve.kind === 'line'
            ? { a: k.curve.a as [number, number], b: k.curve.b as [number, number] }
            : {}),
          ...(k.curve.kind === 'arc'
            ? {
                radius: k.curve.radius,
                center: k.curve.center as [number, number],
                sweep: k.curve.end - k.curve.start,
              }
            : {}),
        })),
        sectionFaces: (p.sectionFaces ?? []).map((f) => ({ face: f.face, loops: f.loops.length })),
      };
    },
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
          box: box.length
            ? {
                min: [Math.min(...box.map((v) => v[0])), Math.min(...box.map((v) => v[1]))],
                max: [Math.max(...box.map((v) => v[0])), Math.max(...box.map((v) => v[1]))],
              }
            : null,
          attention: placed?.attention ?? false,
          leader: placed?.leader
            ? {
                attach: placed.leader.attach,
                at: placed.leader.at,
                on: placed.leader.on ?? null,
                bends: placed.leader.bends,
                text: placed.leader.text,
              }
            : null,
          line: placed?.line ?? null,
          items: (placed?.items ?? []).map((i) => i.kind),
        };
      });
    },
    extents() {
      const b = c.ui.get().built;
      return (b?.build.placed ?? []).map((p) => {
        const texts: { min: [number, number]; max: [number, number] }[] = [];
        const segments: [[number, number], [number, number]][] = [];
        const words: string[] = [];
        let lo: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
        let hi: [number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
        for (const it of p.items) {
          const box = primitiveBox(it);
          if (box) {
            lo = [Math.min(lo[0], box.min[0]), Math.min(lo[1], box.min[1])];
            hi = [Math.max(hi[0], box.max[0]), Math.max(hi[1], box.max[1])];
          }
          if (it.kind === 'text') {
            const t = textBox(it);
            texts.push({ min: [t.min[0], t.min[1]], max: [t.max[0], t.max[1]] });
            words.push(it.text);
          } else if (it.kind === 'line')
            segments.push([
              [it.a[0], it.a[1]],
              [it.b[0], it.b[1]],
            ]);
          else if (it.kind === 'polyline')
            for (let i = 0; i + 1 < it.points.length; i++) {
              const a = it.points[i] as [number, number];
              const q = it.points[i + 1] as [number, number];
              segments.push([
                [a[0], a[1]],
                [q[0], q[1]],
              ]);
            }
        }
        return {
          placementId: p.placementId,
          annotationId: p.annotationId,
          viewId: p.viewId,
          text: words.join(' '),
          texts,
          segments,
          bounds: Number.isFinite(lo[0]) ? { min: lo, max: hi } : null,
        };
      });
    },
    hit(at, tol) {
      const h = viewHit(c, { at, tol });
      const s = h?.source;
      let pick: ReturnType<DrawingHooks['hit']>['pick'] = null;
      if (s?.kind === 'view' && (s.edge || s.face)) {
        const e = s.edge
          ? pickEdge(c, s.viewId, s.edge, at)
          : pickEdge(c, s.viewId, s.face as string, at, 'face');
        if (e)
          pick = {
            name: e.name,
            ref: e.ref ?? 'edge',
            shape: e.shape,
            ...(e.face ? { face: e.face } : {}),
          };
      }
      return { source: s ?? null, pick };
    },
    importPlan() {
      const plan = c.ui.get().importPlan;
      if (!plan) return null;
      return plan.candidates.map((x) => {
        const text: unknown = 'text' in x.annotation ? x.annotation.text : undefined;
        return {
          key: x.key,
          kind: x.kind,
          annotationKind: x.annotation.kind,
          checked: x.checked,
          viewId: x.viewId ?? null,
          reason: x.reason ?? null,
          duplicateOf: x.duplicateOf ?? null,
          count:
            typeof text === 'object' &&
            text !== null &&
            (text as { count?: boolean }).count === true,
        };
      });
    },
    edges(viewId) {
      const b = c.ui.get().built;
      const sv = b?.build.views.get(viewId);
      if (!b || !sv?.ok) return [];
      const out: ReturnType<DrawingHooks['edges']> = [];
      for (const k of b.projections.get(viewId)?.curves ?? []) {
        if (k.role !== 'visible' || (!k.name && !k.face)) continue;
        const p = curveToSheet(k.curve, sv);
        const named = { name: k.name ?? '', ...(k.face ? { face: k.face } : {}) };
        if (p.kind === 'line')
          out.push({
            ...named,
            kind: 'line',
            at: [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2],
            a: p.a,
            b: p.b,
          });
        else if (p.kind === 'arc') {
          const a = (p.start + p.end) / 2;
          out.push({
            ...named,
            kind: 'arc',
            at: [p.center[0] + p.radius * Math.cos(a), p.center[1] + p.radius * Math.sin(a)],
            radius: p.radius,
            start: p.start,
            end: p.end,
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
        quality: b?.quality ?? 'none',
        refining: ui.refining,
        projectionProblems: (b?.problems ?? []).map((p) => p.message),
        hatchLines: (composed?.list.items ?? []).filter((i) => i.role === 'hatch').length,
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
          measured: r.measured ?? null,
          count: r.count ?? null,
        })),
      };
    },
  };
}
