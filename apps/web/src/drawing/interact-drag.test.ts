/**
 * What a drag moves and what it grabs (ADR-094): the views that follow a moved view, the grips of a
 * selected detail circle, and a drag's life cycle (nothing stored and nothing rebuilt until release;
 * one commit; a cancel leaves nothing).
 */

import type { Drawing, DrawingView } from '@wren-cad/contracts';
import { solveViews } from '@wren-cad/drawing';
import type { SheetPointer, SheetTransient } from '@wren-cad/ui/drawing';
import { describe, expect, it, vi } from 'vitest';
import type { DrawingController } from './controller';
import { dependentsOf, detailGripsOf, gripReach, previewDrag } from './interact';
import type { Built } from './pipeline';

const ev = (e: string) =>
  e === '1' ? 1 : Number(e.split('/')[1]) ? 1 / Number(e.split('/')[1]) : 1;

function drawingWith(views: DrawingView[]): Drawing {
  return {
    id: 'D',
    name: 'd',
    subject: { kind: 'part', partId: 'P' },
    standard: { family: 'iso', gps: 'ISO 1101:2017', surfaceFinish: 'ISO 21920-1:2021' },
    projection: 'first',
    units: 'mm',
    style: {} as Drawing['style'],
    template: { id: 'iso-5457', version: 1 },
    sheets: [
      { id: 'S', name: 'Sheet 1', format: { size: 'A3', orientation: 'landscape' }, scale: '1' },
    ],
    views,
    placements: [],
    centerMarks: [],
    tables: [],
    notes: [],
  } as unknown as Drawing;
}

const base = (id: string, at: [number, number]): DrawingView =>
  ({
    id,
    sheetId: 'S',
    kind: 'base',
    orientation: { kind: 'named', name: 'front' },
    layout: { kind: 'free', position: at },
  }) as DrawingView;

describe('which views move with a dragged view', () => {
  it('its aligned descendants, transitively; free views and the rest stay', () => {
    const views = [
      base('A', [100, 100]),
      {
        id: 'B',
        sheetId: 'S',
        kind: 'projected',
        parentId: 'A',
        from: 'top',
        layout: { kind: 'aligned', distance: 60 },
      },
      {
        id: 'C',
        sheetId: 'S',
        kind: 'projected',
        parentId: 'B',
        from: 'left',
        layout: { kind: 'aligned', distance: 60 },
      },
      {
        id: 'D',
        sheetId: 'S',
        kind: 'projected',
        parentId: 'A',
        from: 'left',
        layout: { kind: 'free', position: [300, 100] },
      },
      base('E', [50, 50]),
    ] as DrawingView[];
    const b = { drawing: drawingWith(views) } as unknown as Built;
    expect(dependentsOf(b, 'A').sort()).toEqual(['B', 'C']);
    expect(dependentsOf(b, 'B')).toEqual(['C']);
    expect(dependentsOf(b, 'C')).toEqual([]);
    expect(dependentsOf(b, 'E')).toEqual([]);
  });
});

describe('the grips of a selected detail circle', () => {
  const views = [
    base('P', [100, 100]),
    {
      id: 'DT',
      sheetId: 'S',
      kind: 'detail',
      parentId: 'P',
      letter: 'B',
      center: { kind: 'free', at: [10, 5] },
      radius: 8,
      scale: '2',
      layout: { kind: 'free', position: [300, 100] },
    },
  ] as DrawingView[];
  const built = (over: Partial<DrawingView> = {}) => {
    const d = drawingWith(
      views.map((v) => (v.id === 'DT' ? ({ ...v, ...over } as DrawingView) : v)),
    );
    const solved = solveViews({
      drawing: d,
      bounds: { min: [0, 0, 0], max: [80, 50, 48] },
      evaluate: (e) => ev(e),
    });
    return { drawing: d, build: { views: solved } } as unknown as Built;
  };

  it('a radius handle on the circle and a centre handle at its centre, on the parent view', () => {
    const b = built();
    const g = detailGripsOf(b, 'DT');
    expect(g.map((x) => x.kind)).toEqual(['radius', 'center']);
    const [r, c] = g as [(typeof g)[number], (typeof g)[number]];
    // The circle's radius on the sheet is its radius times the parent's scale (1).
    expect(r.at[0] - c.at[0]).toBeCloseTo(8, 6);
    expect(r.at[1]).toBeCloseTo(c.at[1], 6);
  });

  it('a centre that follows a model entity is not dragged: only the radius handle is offered', () => {
    const b = built({
      center: { kind: 'ref', ref: { name: 'e', kind: 'edge' }, offset: [0, 0] },
    } as never);
    // The unresolved reference needs attention: no solved circle, so no grips at all.
    expect(detailGripsOf(b, 'DT').filter((x) => x.kind === 'center')).toEqual([]);
  });

  it('only a detail has them', () => {
    expect(detailGripsOf(built(), 'P')).toEqual([]);
  });

  it('are 44 px targets for a finger or pen, 26 px for a mouse', () => {
    expect(gripReach({ pointerType: 'mouse', mm: 0.5 })).toBe(6.5);
    expect(gripReach({ pointerType: 'touch', mm: 0.5 })).toBe(11);
    expect(gripReach({ pointerType: 'pen', mm: 1 })).toBe(22);
  });
});

describe('a drag is a preview with one commit', () => {
  /** A controller double that records what a drag does to the document and to the sheet. */
  function harness() {
    const log: string[] = [];
    const session: SheetTransient = {
      update: (f) => log.push(`update ${f.dx},${f.dy}`),
      end: (how) => log.push(`end ${how}`),
    };
    const c = {
      hold: () => log.push('hold'),
      resume: () => log.push('resume'),
      transient: (spec: unknown) => {
        log.push(`transient ${JSON.stringify(spec)}`);
        return session;
      },
      commit: () => log.push('commit'),
    } as unknown as DrawingController;
    return { c, log };
  }
  const ptr = (x: number, y: number): SheetPointer => ({
    at: [x, y],
    px: { x, y },
    pointerType: 'mouse',
    button: 0,
    shift: false,
    alt: false,
    ctrl: false,
    tol: 3,
    mm: 1,
  });
  const frame = (commit: () => void) => (p: SheetPointer) => ({
    frame: { dx: p.at[0], dy: p.at[1] },
    commit,
  });

  it('holds the build, previews every move, commits once on release', () => {
    const { c, log } = harness();
    const edit = vi.fn(() => log.push('edit'));
    const drag = previewDrag(c, { move: { hosts: ['V'] } }, frame(edit));
    expect(log).toEqual(['hold']);
    drag.move?.(ptr(1, 2));
    drag.move?.(ptr(3, 4));
    // Nothing is stored while the pointer moves.
    expect(edit).not.toHaveBeenCalled();
    drag.up?.(ptr(5, 6), true);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      'hold',
      'transient {"move":{"hosts":["V"]}}',
      'update 1,2',
      'update 3,4',
      'update 5,6',
      'edit',
      'commit',
      'end hold',
      'resume',
    ]);
  });

  it('Escape or a cancel leaves nothing: no edit, no commit, the preview gone, the build released', () => {
    const { c, log } = harness();
    const edit = vi.fn();
    const drag = previewDrag(c, {}, frame(edit));
    drag.move?.(ptr(1, 2));
    drag.cancel?.();
    expect(edit).not.toHaveBeenCalled();
    expect(log).not.toContain('commit');
    expect(log.slice(-2)).toEqual(['end cancel', 'resume']);
  });

  it('a press that never moved edits nothing and starts no preview', () => {
    const { c, log } = harness();
    const edit = vi.fn();
    const drag = previewDrag(c, {}, frame(edit));
    drag.up?.(ptr(1, 2), false);
    expect(edit).not.toHaveBeenCalled();
    expect(log).toEqual(['hold', 'resume']);
  });

  it('a release that would change nothing commits nothing', () => {
    const { c, log } = harness();
    const drag = previewDrag(c, {}, () => ({ frame: {}, commit: null }));
    drag.move?.(ptr(1, 2));
    drag.up?.(ptr(1, 2), true);
    expect(log).not.toContain('commit');
    expect(log.slice(-2)).toEqual(['end cancel', 'resume']);
  });
});
