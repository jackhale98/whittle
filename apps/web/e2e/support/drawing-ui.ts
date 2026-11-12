/**
 * Helpers for the drawing route (M4): the route's test hooks, sheet-to-page coordinates, and the
 * first steps every drawing test shares (open the demo bracket, make a drawing).
 */

import { expect, type Page } from '@playwright/test';
import { app, boot, palette } from '../helpers';

export interface DrawingState {
  phase: string;
  drawingId: string | null;
  sheetId: string | null;
  tool: string;
  selected: { kind: string; id?: string; slot?: string } | null;
  pending: boolean;
  error: string | null;
  /** `draft` (shown first), `exact` (idle, and always for export) or `none` (not built). */
  quality: string;
  refining: boolean;
  projectionProblems: string[];
  /** Hatch lines on the composed sheet. */
  hatchLines: number;
  projection: string | null;
  panel: string;
  hint: string | null;
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
    measured: number | null;
    count: number | null;
  }[];
}

export interface Edge {
  /** The model edge's name; empty for an outline, which has `face` instead. */
  name: string;
  /** The face an outline (or a seam on a silhouette) outlines. */
  face?: string;
  kind: string;
  at: [number, number];
  a?: [number, number];
  b?: [number, number];
  radius?: number;
  /** Arcs: start and end angle on the sheet (radians, counter-clockwise). */
  start?: number;
  end?: number;
}

/** The kernel's own output for a view (part mm), not the sheet's. */
export interface Projection {
  quality: string;
  curves: {
    role: string;
    edge: string;
    name?: string;
    face?: string;
    kind: string;
    radius?: number;
    center?: [number, number];
    sweep?: number;
    a?: [number, number];
    b?: [number, number];
  }[];
  sectionFaces: { face: string; loops: number }[];
  ms: number;
}

export interface PlacementInfo {
  id: string;
  annotationId: string;
  viewId: string;
  layout: {
    kind: string;
    side?: string;
    lane?: number;
    distance?: number;
    /** Leaders: the text offset, the attach and the bends. */
    text?: [number, number];
    attach?: { kind: string; index?: number; t?: number; placementId?: string };
    bends?: [number, number][];
  };
  text: [number, number] | null;
  /** The label's bounds on the sheet. */
  box: { min: [number, number]; max: [number, number] } | null;
  attention: boolean;
  /** Leader layouts as drawn: attach point, the line it is held on, bends, text point. */
  leader: {
    attach: string;
    at: [number, number];
    on: [[number, number], [number, number]] | null;
    bends: [number, number][];
    text: [number, number];
  } | null;
  /** A dimension's line between its arrow tips. */
  line: [[number, number], [number, number]] | null;
  /** The kinds of display items drawn (a datum triangle or an arrowhead is a `fill`). */
  items: string[];
}

/** A placed annotation's real extent from the display list (sheet mm). */
export interface Extent {
  placementId: string;
  annotationId: string;
  viewId: string;
  text: string;
  texts: { min: [number, number]; max: [number, number] }[];
  segments: [[number, number], [number, number]][];
  bounds: { min: [number, number]; max: [number, number] } | null;
}

/** One candidate of the open import plan. */
export interface ImportRow {
  key: string;
  kind: string;
  annotationKind: string;
  checked: boolean;
  viewId: string | null;
  reason: string | null;
  duplicateOf: string | null;
  count: boolean;
}

type W = {
  __wrenDrawing: {
    extents(): Extent[];
    hit(at: [number, number], tol: number): { source: unknown; pick: unknown };
    importPlan(): ImportRow[] | null;
    settled(): Promise<void>;
    exact(): Promise<void>;
    failKernel(): void;
    projection(viewId: string): Projection | null;
    state(): DrawingState;
    edges(viewId: string): Edge[];
    placements(): PlacementInfo[];
  };
};

export const drawing = (page: Page) => ({
  state: (): Promise<DrawingState> =>
    page.evaluate(() => (window as unknown as W).__wrenDrawing.state()),
  settled: (): Promise<void> =>
    page.evaluate(() => (window as unknown as W).__wrenDrawing.settled()),
  failKernel: (): Promise<void> =>
    page.evaluate(() => (window as unknown as W).__wrenDrawing.failKernel()),
  /** Waits until the shown edges are the exact ones. */
  exact: (): Promise<void> => page.evaluate(() => (window as unknown as W).__wrenDrawing.exact()),
  projection: (viewId: string): Promise<Projection | null> =>
    page.evaluate((id) => (window as unknown as W).__wrenDrawing.projection(id), viewId),
  edges: (viewId: string): Promise<Edge[]> =>
    page.evaluate((id) => (window as unknown as W).__wrenDrawing.edges(id), viewId),
  placements: (): Promise<PlacementInfo[]> =>
    page.evaluate(() => (window as unknown as W).__wrenDrawing.placements()),
  hit: (at: [number, number], tol = 1): Promise<{ source: unknown; pick: unknown }> =>
    page.evaluate(
      ([p, t]) => (window as unknown as W).__wrenDrawing.hit(p as [number, number], t as number),
      [at, tol] as const,
    ),
  extents: (): Promise<Extent[]> =>
    page.evaluate(() => (window as unknown as W).__wrenDrawing.extents()),
  importPlan: (): Promise<ImportRow[] | null> =>
    page.evaluate(() => (window as unknown as W).__wrenDrawing.importPlan()),
});

/** Waits until the route's build is current (no pending regen, nothing queued). */
export async function built(page: Page): Promise<DrawingState> {
  await drawing(page).settled();
  await expect.poll(async () => (await drawing(page).state()).pending).toBe(false);
  await drawing(page).settled();
  return drawing(page).state();
}

export async function openDemo(page: Page): Promise<void> {
  await boot(page);
  await page.getByTestId('open-demo').click();
  await expect.poll(async () => (await app(page).doc()).parts[0]?.features.length ?? 0).toBe(9);
  await app(page).idle();
}

/**
 * Opens the drawing route for a new drawing. The first one asks for the standard and projection
 * (D10); `choice` answers it.
 */
export async function newDrawing(
  page: Page,
  choice: { family?: 'ISO' | 'ASME / ANSI'; projection: 'First angle' | 'Third angle' } = {
    projection: 'First angle',
  },
): Promise<DrawingState> {
  await palette(page, 'New drawing');
  const card = page.getByTestId('standard-choice');
  const sheet = page.getByTestId('sheet-viewer');
  await expect(card.or(sheet)).toBeVisible();
  if (await card.isVisible()) {
    if (choice.family) await card.getByRole('radio', { name: choice.family }).click();
    await card
      .getByRole('radio', { name: new RegExp(`^${choice.projection}`) })
      .check({ force: true });
    await page.getByTestId('standard-confirm').click();
  }
  await expect(sheet).toBeVisible();
  return built(page);
}

/** Page coordinates of a point on the sheet (mm, y up), through the viewer's own transform. */
export async function sheetToPage(
  page: Page,
  p: [number, number],
): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y]) => {
    const g = document.querySelector('[data-testid="drawing-sheet-content"]');
    const svg = document.querySelector('[data-testid="sheet-svg"]');
    const paper = g?.querySelector('rect');
    if (!g || !svg || !paper) throw new Error('no sheet');
    const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(
      g.getAttribute('transform') ?? '',
    );
    if (!m) throw new Error('no transform');
    const [tx, ty, k] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const H = Number(paper.getAttribute('height'));
    const r = svg.getBoundingClientRect();
    return { x: r.left + tx + (x as number) * k, y: r.top + ty + (H - (y as number)) * k };
  }, p);
}

/** A mouse drag between two points, in steps (the viewer's pointer-captured drag). */
export async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 10,
  button: 'left' | 'middle' = 'left',
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  for (let i = 1; i <= steps; i++)
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  await page.mouse.up({ button });
}

export const panelTab = (page: Page, name: string) => page.getByRole('tab', { name });

/** The first view of a kind. */
export const viewOf = (s: DrawingState, kind: string, from?: string) =>
  s.views.find((v) => v.kind === kind && (from === undefined || v.from === from));

/** Two straight edges of a view that meet at a corner and are not parallel (sheet mm). */
export async function cornerEdges(page: Page, viewId: string) {
  const lines = (await drawing(page).edges(viewId)).filter((e) => e.kind === 'line' && e.a && e.b);
  type P = [number, number];
  const near = (p: P, q: P) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01;
  for (const e of lines)
    for (const f of lines) {
      if (e === f || !e.a || !e.b || !f.a || !f.b) continue;
      const shared = [e.a, e.b].some((p) => [f.a as P, f.b as P].some((q) => near(p, q)));
      const d1: P = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
      const d2: P = [f.b[0] - f.a[0], f.b[1] - f.a[1]];
      const l1 = Math.hypot(...d1);
      const l2 = Math.hypot(...d2);
      const cross = Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) / (l1 * l2);
      if (shared && cross > 0.9 && l1 > 20 && l2 > 20) return [e, f] as const;
    }
  throw new Error('no two edges meet at a corner');
}
