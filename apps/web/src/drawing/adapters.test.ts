import type {
  Annotation,
  AnnotationResolution,
  ShapeForDrawing,
  ViewProjection,
  ViewProjectionRequest,
} from '@wren-cad/contracts';
import { describe, expect, it, vi } from 'vitest';
import { attentionRows, valueText } from './adapters';
import { drawingKernelOver } from './kernel';
import type { Built } from './pipeline';

const dim = (kind: Annotation['kind'], extra: object = {}) =>
  ({ id: 'A', kind, origin: { kind: 'model' }, refs: [], ...extra }) as Annotation;
const res = (over: Partial<AnnotationResolution>): AnnotationResolution => ({
  annotationId: 'A',
  state: 'ok',
  ...over,
});

describe('the value a resolution shows (trap T1)', () => {
  it('formats lengths, diameters, radii and angles', () => {
    expect(valueText(dim('linear'), res({ value: 80 }))).toBe('80 mm');
    expect(valueText(dim('diameter'), res({ value: 6 }))).toBe('Ø6 mm');
    expect(valueText(dim('radius'), res({ value: 2.5 }))).toBe('R2.5 mm');
    expect(valueText(dim('angle'), res({ value: Math.PI / 2 }))).toBe('90°');
    expect(valueText(dim('linear'), res({ value: 12.3456789 }))).toBe('12.346 mm');
  });

  it('is nothing for anything that needs attention or is suppressed, even if a value is present', () => {
    expect(valueText(dim('linear'), res({ state: 'needsAttention', value: 80 }))).toBeUndefined();
    expect(valueText(dim('linear'), res({ state: 'suppressed', value: 80 }))).toBeUndefined();
    expect(valueText(dim('linear'), undefined)).toBeUndefined();
    expect(valueText(dim('linear'), res({}))).toBeUndefined();
    // Frames, datums and notes carry no number.
    expect(valueText(dim('datumFeature'), res({ value: 1 }))).toBeUndefined();
  });
});

describe('needs attention rows', () => {
  it('merge the entries of one annotation into one row, the worst severity first, and flag reattach', () => {
    const b = {
      part: { annotations: [dim('linear')], configurations: [], features: [] },
      drawing: { sheets: [{ id: 'S', name: 'Sheet 1' }], views: [] },
      build: {
        attention: [
          {
            key: 'placement:P:issue:0',
            severity: 'warning',
            subject: { kind: 'annotation', annotationId: 'A', placementId: 'P' },
            sheetId: 'S',
            zone: 'B2',
            message: 'Linear dimension: its geometry could not be found',
          },
          {
            key: 'placement:P:resolution',
            severity: 'attention',
            subject: { kind: 'annotation', annotationId: 'A', placementId: 'P' },
            sheetId: 'S',
            zone: 'B2',
            message: 'Linear dimension: a reference no longer resolves',
            unresolved: [{ path: '/refs/0', reason: 'gone' }],
          },
          {
            key: 'drawing:subject',
            severity: 'info',
            subject: { kind: 'drawing' },
            message: 'Note',
          },
        ],
      },
    } as unknown as Built;
    const rows = attentionRows(b);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      severity: 'attention',
      zone: 'B2',
      reattachable: true,
      title: 'linear dimension',
    });
    expect(rows[0]?.message).toContain('its geometry could not be found');
    expect(rows[0]?.message).toContain('a reference no longer resolves');
    expect(rows[1]).not.toHaveProperty('reattachable');
  });
});

describe('the drawing kernel wrapper', () => {
  const shape: ShapeForDrawing = {
    key: 'k1',
    brep: new Uint8Array(),
    edgeNames: [],
    faceNames: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
  const request = (extra: Partial<ViewProjectionRequest> = {}): ViewProjectionRequest => ({
    shapeKey: 'k1',
    frame: { x: [1, 0, 0], y: [0, 0, 1] },
    quality: 'draft',
    hidden: false,
    smooth: false,
    ...extra,
  });
  const projection: ViewProjection = {
    key: 'p',
    curves: [],
    bounds: { min: [0, 0], max: [1, 1] },
    ms: 1,
  };

  it('loads a shape once and caches projections by request', async () => {
    const api = {
      loadShape: vi.fn(async () => ({ ok: true as const })),
      project: vi.fn(async () => ({ ok: true as const, value: projection })),
    };
    const k = drawingKernelOver(api, { dispose: () => {} });
    await Promise.all([k.project(shape, request()), k.project(shape, request({ hidden: true }))]);
    await k.project(shape, request());
    expect(api.loadShape).toHaveBeenCalledTimes(1);
    expect(api.project).toHaveBeenCalledTimes(2); // the repeated request came from the cache
  });

  it('sends a transferred copy of the BREP and keeps its own, so an evicted shape can load again', async () => {
    const sent: Uint8Array[] = [];
    const api = {
      loadShape: vi.fn(async (s: ShapeForDrawing) => {
        sent.push(s.brep);
        return { ok: true as const };
      }),
      project: vi.fn(async () => ({ ok: true as const, value: projection })),
    };
    const own = { ...shape, brep: new Uint8Array([1, 2, 3, 4]) };
    const k = drawingKernelOver(api, { transfer: true, dispose: () => {} });
    await k.project(own, request());
    expect(sent[0]).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(sent[0]?.buffer).not.toBe(own.brep.buffer);
    expect(own.brep.byteLength).toBe(4);
  });

  it('loads the shape again when the worker has dropped it, and gives up on a refused load', async () => {
    let evicted = true;
    const api = {
      loadShape: vi.fn(async () => ({ ok: true as const })),
      project: vi.fn(async () => {
        if (evicted) {
          evicted = false;
          return {
            ok: false as const,
            error: { code: 'INVALID_HANDLE' as const, message: 'gone' },
          };
        }
        return { ok: true as const, value: projection };
      }),
    };
    const k = drawingKernelOver(api, { dispose: () => {} });
    const r = await k.project(shape, request());
    expect(r.ok).toBe(true);
    expect(api.loadShape).toHaveBeenCalledTimes(2);
    const refused = drawingKernelOver(
      {
        loadShape: async () => ({
          ok: false as const,
          error: { code: 'UNSUPPORTED_FEATURE' as const, message: 'no' },
        }),
        project: vi.fn(),
      },
      { dispose: () => {} },
    );
    expect(await refused.project(shape, request())).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_FEATURE' },
    });
  });
});
