import type {
  Annotation,
  Command,
  Drawing,
  DrawingView,
  PlacementLayout,
} from '@wren-cad/contracts';
import { solveViews } from '@wren-cad/drawing';
import type { SheetPointer } from '@wren-cad/ui/drawing';
import { describe, expect, it } from 'vitest';
import type { DrawingController } from './controller';
import { dragAttach, leaderHandleDrag, snapAlong } from './interact-leader';
import { notASize } from './ops-gdt';
import {
  addSheet,
  alignedDescendants,
  deleteSheet,
  moveSheet,
  moveViewToSheet,
  newSheet,
  nextSheetName,
  planViewMove,
  recallSheet,
  rememberSheet,
  renameSheet,
  sheetContents,
  stepSheet,
} from './ops-sheets';
import type { Built } from './pipeline';
import { type DrawingUiState, initialDrawingUi } from './state';

const format = { size: 'A3' as const, orientation: 'landscape' as const };

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
      { id: 'S1', name: 'Sheet 1', format, scale: '1/2' },
      { id: 'S2', name: 'Details', format, scale: '1' },
    ],
    views,
    placements: [],
    centerMarks: [],
    tables: [
      { id: 'T', kind: 'partProperties', sheetId: 'S1' } as unknown as Drawing['tables'][number],
    ],
    notes: [],
  };
}

const VIEWS: DrawingView[] = [
  {
    id: 'F',
    sheetId: 'S1',
    kind: 'base',
    orientation: { kind: 'named', name: 'front' },
    layout: { kind: 'free', position: [120, 180] },
  },
  {
    id: 'T1',
    sheetId: 'S1',
    kind: 'projected',
    parentId: 'F',
    from: 'top',
    layout: { kind: 'aligned', distance: 80 },
  },
  {
    id: 'R',
    sheetId: 'S1',
    kind: 'projected',
    parentId: 'T1',
    from: 'right',
    layout: { kind: 'aligned', distance: 90 },
  },
  {
    id: 'I',
    sheetId: 'S1',
    kind: 'iso',
    parentId: 'F',
    corner: 'topRight',
    layout: { kind: 'free', position: [330, 200] },
  },
];

/** A controller over an in-memory drawing that records the commands it is asked to apply. */
function fake(d: Drawing) {
  let ui: DrawingUiState = { ...initialDrawingUi, drawingId: d.id, sheetId: 'S1' };
  const applied: { command: Command; label: string; key?: string }[] = [];
  let commits = 0;
  const views = solveViews({
    drawing: d,
    bounds: { min: [0, 0, 0], max: [80, 50, 40] },
    evaluate: (e) => (e === '1/2' ? 0.5 : 1),
  });
  const built = { drawing: d, build: { views, placed: [], sheets: [] } } as unknown as Built;
  const c = {
    ui: { get: () => ui, set: (f: (s: DrawingUiState) => DrawingUiState) => (ui = f(ui)) },
    patch: (p: Partial<DrawingUiState>) => {
      ui = { ...ui, ...p };
    },
    drawing: () => d,
    sheet: () => d.sheets.find((s) => s.id === ui.sheetId),
    built: () => built,
    apply: (command: Command, label: string, key?: string) => {
      applied.push({ command, label, ...(key ? { key } : {}) });
      return true;
    },
    commit: () => {
      commits++;
    },
    cancelEdit: () => true,
    select: (selected: DrawingUiState['selected']) => {
      ui = { ...ui, selected };
    },
    toast: () => {},
  } as unknown as DrawingController;
  return { c, applied, ui: () => ui, commits: () => commits };
}

describe('sheets (ADR-094)', () => {
  it('adds a sheet with the drawing’s format and scale, named after the next free number', () => {
    const d = drawingWith(VIEWS);
    expect(nextSheetName(d)).toBe('Sheet 3');
    expect(
      nextSheetName({ sheets: [...d.sheets, { id: 'x', name: 'Sheet 3', format, scale: '1' }] }),
    ).toBe('Sheet 4');
    expect(newSheet(d, 'N')).toEqual({ id: 'N', name: 'Sheet 3', format, scale: '1/2' });
    const f = fake(d);
    const id = addSheet(f.c);
    expect(f.applied).toHaveLength(1);
    expect(f.applied[0]?.command).toMatchObject({
      kind: 'addSheet',
      drawingId: 'D',
      sheet: { id, name: 'Sheet 3' },
    });
    expect(f.applied[0]?.key).toBeUndefined();
  });

  it('renames, reorders and deletes in one command each; delete shows the neighbour', () => {
    const f = fake(drawingWith(VIEWS));
    expect(renameSheet(f.c, 'S2', '  Sections ')).toBe(true);
    expect(f.applied.at(-1)?.command).toMatchObject({
      kind: 'updateSheet',
      sheet: { id: 'S2', name: 'Sections' },
    });
    expect(renameSheet(f.c, 'S2', '   ')).toBe(false);
    expect(moveSheet(f.c, 'S2', 0)).toBe(true);
    expect(f.applied.at(-1)?.command).toEqual({
      kind: 'moveSheet',
      drawingId: 'D',
      sheetId: 'S2',
      toIndex: 0,
    });
    expect(moveSheet(f.c, 'S2', 5)).toBe(false);
    expect(deleteSheet(f.c, 'S1')).toBe(true);
    expect(f.applied.at(-1)?.command).toEqual({
      kind: 'removeSheet',
      drawingId: 'D',
      sheetId: 'S1',
    });
    expect(f.ui().sheetId).toBe('S2');
  });

  it('says what deleting a sheet takes with it', () => {
    const d = drawingWith(VIEWS);
    expect(sheetContents(d, 'S1')).toBe('4 views and a table');
    expect(sheetContents(d, 'S2')).toBe('');
  });

  it('steps through the sheets and remembers the one shown', () => {
    const f = fake(drawingWith(VIEWS));
    stepSheet(f.c, 1);
    expect(f.ui().sheetId).toBe('S2');
    stepSheet(f.c, 1);
    expect(f.ui().sheetId).toBe('S2');
    stepSheet(f.c, -1);
    expect(f.ui().sheetId).toBe('S1');
    rememberSheet('D', 'S2');
    expect(recallSheet(drawingWith(VIEWS))).toBe('S2');
    expect(recallSheet({ id: 'D', sheets: [] })).toBeNull();
  });

  it('a view moves with the views aligned to it; an aligned view cannot move alone', () => {
    const d = drawingWith(VIEWS);
    expect(alignedDescendants(d.views, 'F').map((v) => v.id)).toEqual(['T1', 'R']);
    const plan = planViewMove(d, 'F');
    expect(plan.ok && plan.views.map((v) => v.id)).toEqual(['F', 'T1', 'R']);
    expect(plan.ok && plan.note).toMatch(/aligned with it and go along/);
    const child = planViewMove(d, 'T1');
    expect(child.ok).toBe(false);
    expect(!child.ok && child.message).toMatch(/aligned with Front view/);
    // A free child (the iso view) moves on its own.
    const iso = planViewMove(d, 'I');
    expect(iso.ok && iso.views.map((v) => v.id)).toEqual(['I']);
  });

  it('moving a view to another sheet is one undo step: one key, then one commit', () => {
    const f = fake(drawingWith(VIEWS));
    expect(moveViewToSheet(f.c, 'F', 'S2')).toBe(true);
    expect(f.applied.map((a) => (a.command as { view: DrawingView }).view.id)).toEqual([
      'F',
      'T1',
      'R',
    ]);
    expect(f.applied.every((a) => (a.command as { view: DrawingView }).view.sheetId === 'S2')).toBe(
      true,
    );
    expect(new Set(f.applied.map((a) => a.key)).size).toBe(1);
    expect(f.applied[0]?.label).toBe('Move Front view to Details');
    expect(f.commits()).toBe(1);
    // The route follows the view to its sheet, still selected.
    expect(f.ui().sheetId).toBe('S2');
    expect(f.ui().selected).toEqual({ kind: 'view', id: 'F' });
    // Refused: an aligned view by itself.
    const g = fake(drawingWith(VIEWS));
    expect(moveViewToSheet(g.c, 'T1', 'S2')).toBe(false);
    expect(g.applied).toHaveLength(0);
  });
});

describe('leader drags (ADR-094)', () => {
  const surface: Extract<PlacementLayout, { kind: 'leader' }> = {
    kind: 'leader',
    attach: { kind: 'ref', index: 0, t: 0.3 },
    text: [0, -10],
  };
  const line: [[number, number], [number, number]] = [
    [0, 0],
    [100, 0],
  ];

  it('the triangle stays on its line: along it and onto its extension, snapping to the ends and middle', () => {
    expect(dragAttach(surface, line, [70, 25], 2).attach).toEqual({
      kind: 'ref',
      index: 0,
      t: 0.7,
    });
    // Past either end it sits on the line's extension (ADR-094), never off the line.
    expect(dragAttach(surface, line, [120, -3], 2).attach).toEqual({
      kind: 'ref',
      index: 0,
      t: 1.2,
    });
    expect(dragAttach(surface, line, [-20, 0], 2).attach).toEqual({
      kind: 'ref',
      index: 0,
      t: -0.2,
    });
    // Bounded by what the document stores (ten edge lengths out).
    expect(dragAttach(surface, line, [5000, 0], 2).attach).toEqual({
      kind: 'ref',
      index: 0,
      t: 11,
    });
    expect(dragAttach(surface, line, [99, 5], 2).attach).toEqual({ kind: 'ref', index: 0, t: 1 });
    expect(dragAttach(surface, line, [51, 0], 2).attach).toEqual({ kind: 'ref', index: 0 });
    expect(snapAlong(0.05, 100, 2)).toBe(0.05);
    expect(snapAlong(0.01, 100, 2)).toBe(0);
    // The text keeps its offset from the triangle.
    expect(dragAttach(surface, line, [70, 25], 2).text).toEqual([0, -10]);
  });

  it('on a dimension line it takes the nearer end and keeps pointing out of the dimension', () => {
    const fos: Extract<PlacementLayout, { kind: 'leader' }> = {
      kind: 'leader',
      attach: { kind: 'dimensionLine', placementId: 'w', t: 1 },
      text: [8, 1],
    };
    expect(dragAttach(fos, line, [60, 0], 2)).toEqual(fos);
    const flipped = dragAttach(fos, line, [20, 3], 2);
    expect(flipped.attach).toEqual({ kind: 'dimensionLine', placementId: 'w', t: 0 });
    expect(flipped.text).toEqual([-8, 1]);
  });
});

describe('features of size', () => {
  const dim = (over: Partial<Annotation>): Annotation =>
    ({
      id: 'A',
      kind: 'linear',
      origin: { kind: 'model' },
      refs: [
        { name: 'a', kind: 'face' },
        { name: 'b', kind: 'face' },
      ],
      ...over,
    }) as Annotation;
  it('a diameter or a width between two faces is a size; centre distances and angles are not', () => {
    expect(
      notASize(dim({ kind: 'diameter', refs: [{ name: 'c', kind: 'face' }] })),
    ).toBeUndefined();
    expect(notASize(dim({ at: ['self', 'self'] }))).toBeUndefined();
    expect(notASize(dim({ at: ['center', 'center'] }))).toMatch(/between centres/);
    expect(notASize(dim({ kind: 'angle' }))).toMatch(/feature of size/);
  });
});

describe('leader handle drags are previews (ADR-094)', () => {
  /** A build with one surface datum on V (its line from (0, 0) to (100, 0)), and a recorder. */
  function harness() {
    const log: string[] = [];
    const pl = {
      id: 'L',
      viewId: 'V',
      annotationId: 'A',
      layout: { kind: 'leader', attach: { kind: 'ref', index: 0, t: 0.3 }, text: [0, -10] },
    } as Drawing['placements'][number];
    const leaderAt = (t: number) => ({
      attach: 'ref' as const,
      at: [100 * t, 0] as [number, number],
      on: [
        [0, 0],
        [100, 0],
      ] as [[number, number], [number, number]],
      bends: [] as [number, number][],
      text: [100 * t, -10] as [number, number],
    });
    const d = { ...drawingWith(VIEWS), placements: [pl] } as Drawing;
    const built = {
      drawing: d,
      build: {
        placed: [
          {
            placementId: 'L',
            annotationId: 'A',
            viewId: 'V',
            items: [],
            textBox: [],
            leader: leaderAt(0.3),
            attention: false,
            suppressed: false,
            issues: [],
          },
        ],
        relayout: (next: Drawing['placements'][number]) => {
          log.push('relayout');
          const t =
            next.layout.kind === 'leader' && next.layout.attach.kind === 'ref'
              ? (next.layout.attach.t ?? 0.5)
              : 0.5;
          return {
            placementId: 'L',
            annotationId: 'A',
            viewId: 'V',
            items: [],
            textBox: [],
            leader: leaderAt(t),
            attention: false,
            suppressed: false,
            issues: [],
          };
        },
      },
    } as unknown as Built;
    const c = {
      built: () => built,
      drawing: () => d,
      ui: { get: () => ({ ...initialDrawingUi, tool: 'select' }) },
      hold: () => log.push('hold'),
      resume: () => log.push('resume'),
      transient: (spec: unknown) => {
        log.push(`transient ${JSON.stringify(spec)}`);
        return { update: () => log.push('update'), end: (how: string) => log.push(`end ${how}`) };
      },
      apply: (cmd: Command, label: string) => {
        log.push(`apply ${label} ${JSON.stringify((cmd as { placements?: unknown }).placements)}`);
        return true;
      },
      commit: () => log.push('commit'),
    } as unknown as DrawingController;
    return { c, log };
  }
  const ptr = (x: number, y: number) =>
    ({
      at: [x, y],
      px: { x, y },
      pointerType: 'mouse',
      button: 0,
      shift: false,
      alt: false,
      ctrl: false,
      tol: 1,
      mm: 0.1,
    }) as SheetPointer;

  it('stores nothing while the triangle slides; one edit on release; the handles and followers hidden', () => {
    const { c, log } = harness();
    const drag = leaderHandleDrag(c, 'L', ptr(30, 0));
    if (!drag) throw new Error('no handle');
    drag.move?.(ptr(60, 4));
    drag.move?.(ptr(120, 2));
    expect(log.some((x) => x.startsWith('apply'))).toBe(false);
    expect(log).toContain('transient {"hide":["placement:L","overlay:leader:L"]}');
    expect(log[0]).toBe('hold');
    drag.up?.(ptr(120, 2), true);
    const applies = log.filter((x) => x.startsWith('apply'));
    expect(applies).toHaveLength(1);
    expect(applies[0]).toContain('Move leader');
    expect(applies[0]).toContain('"t":1.2');
    expect(log.slice(-3)).toEqual(['commit', 'end hold', 'resume']);
  });

  it('Escape leaves nothing behind', () => {
    const { c, log } = harness();
    const drag = leaderHandleDrag(c, 'L', ptr(30, 0));
    drag?.move?.(ptr(70, 0));
    drag?.cancel?.();
    expect(log.some((x) => x.startsWith('apply') || x === 'commit')).toBe(false);
    expect(log.slice(-2)).toEqual(['end cancel', 'resume']);
  });
});
