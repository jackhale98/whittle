import type { SketchFeature } from '@wren-cad/contracts';
import { describe, expect, it, vi } from 'vitest';
import { SketchEditTools } from './sketch-edit';
import type { SketchEditUi, SketchUi } from './state';
import type { Workbench } from './workbench';

const frame = {
  origin: [0, 0, 0] as [number, number, number],
  x: [1, 0, 0] as [number, number, number],
  y: [0, 1, 0] as [number, number, number],
  z: [0, 0, 1] as [number, number, number],
};

/** Convert Entities asks the kernel for exact projections and links ellipses and splines. */
describe('convert entities: exact linked projection (M3.5, ADR-056)', () => {
  it('maps ellipse, elliptic arc and bspline projections to linked entities of the same kind', async () => {
    const calls: unknown[] = [];
    const ellipse = { kind: 'ellipse', c: [0, 0], majorRadius: 10, minorRadius: 5, rotation: 0 };
    const arc = {
      kind: 'ellipticArc',
      c: [30, 0],
      majorRadius: 10,
      minorRadius: 5,
      rotation: 0,
      start: [40, 0],
      end: [30, 5],
    };
    const spline = {
      kind: 'bspline',
      poles: [
        [0, 20],
        [10, 30],
        [20, 20],
        [30, 30],
      ],
      degree: 3,
      periodic: false,
    };
    const curves = [ellipse, arc, spline];
    const port = {
      projectEdges: vi.fn(async (_s: unknown, edges: number[], plane: unknown) => {
        calls.push(plane);
        return { ok: true as const, value: [{ edge: edges[0], curves: [curves[edges[0] ?? 0]] }] };
      }),
      projectFaceOutline: vi.fn(),
    };
    const refOf = (n: string) => ({ name: n, kind: 'edge' as const });
    let sketch: SketchFeature = {
      id: 'S1',
      kind: 'sketch',
      entities: [],
      constraints: [],
    } as unknown as SketchFeature;
    let edit: SketchEditUi = {
      tool: 'convert',
      picks: [],
      value: '',
      side: 'left',
      both: false,
      corner: 'fillet',
      trim: 'trim',
      phase: 'entities',
      axis: null,
      source: 'edges',
      model: [0, 1, 2].map((i) => ({
        bodyId: 'B1',
        kind: 'edge' as const,
        index: i,
        point: [0, 0, 0] as [number, number, number],
        ref: refOf(`F1:e${i}`),
      })),
      relink: null,
      busy: false,
    };
    const wb = {
      modeling: { port },
      regen: { get: () => ({ result: { bodies: [{ id: 'B1', shape: 7 }] } }) },
      refFor: async () => null,
      toast: vi.fn(),
      evaluate: () => ({ ok: false }),
    } as unknown as Workbench;
    const host = {
      wb,
      feature: () => sketch,
      sketchUi: () => ({ frame, edit }) as unknown as SketchUi,
      setEdit: (e: SketchEditUi | null) => {
        if (e) edit = e;
      },
      commitEdit: async (fn: (c: SketchFeature) => SketchFeature) => {
        const r = fn(sketch) as unknown as { entities: SketchFeature['entities'] };
        sketch = { ...sketch, entities: r.entities } as SketchFeature;
      },
      selected: () => [],
    };
    await new SketchEditTools(host).apply();
    expect(port.projectEdges).toHaveBeenCalledTimes(3);
    const kinds = sketch.entities.map((e) => e.kind);
    expect(kinds).toContain('ellipse');
    expect(kinds).toContain('ellipticArc');
    expect(kinds).toContain('bspline');
    const linked = sketch.entities.filter((e) => e.source);
    expect(linked.length).toBeGreaterThanOrEqual(3);
    expect(linked.some((e) => e.kind === 'bspline' && e.source?.approximate !== true)).toBe(true);
    expect(sketch.entities.some((e) => e.source?.approximate === true)).toBe(false);
  });
});
