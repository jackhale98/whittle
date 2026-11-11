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
  resolutions: { id: string; state: string; value: number | null }[];
}

export interface Edge {
  name: string;
  kind: string;
  at: [number, number];
  a?: [number, number];
  b?: [number, number];
  radius?: number;
}

export interface PlacementInfo {
  id: string;
  annotationId: string;
  viewId: string;
  layout: { kind: string; side?: string; lane?: number; distance?: number };
  text: [number, number] | null;
  attention: boolean;
}

type W = {
  __wrenDrawing: {
    settled(): Promise<void>;
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
  edges: (viewId: string): Promise<Edge[]> =>
    page.evaluate((id) => (window as unknown as W).__wrenDrawing.edges(id), viewId),
  placements: (): Promise<PlacementInfo[]> =>
    page.evaluate(() => (window as unknown as W).__wrenDrawing.placements()),
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
