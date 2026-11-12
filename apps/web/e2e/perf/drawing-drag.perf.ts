import { devices, expect, type Page, test } from '@playwright/test';
import { app } from '../helpers';
import {
  built,
  drawing,
  newDrawing,
  openDemo,
  panelTab,
  sheetToPage,
  viewOf,
} from '../support/drawing-ui';
import { PERF_FACTOR } from './budgets';

/**
 * Drag frame time on the sheet (ADR-094): the bracket drawing with standard views, imported
 * dimensions and a section, then a real pointer drag of a view, a dimension line, a dimension's
 * text, a cut-line vertex and a detail circle's radius handle.
 *
 * Frame time is the main-thread time one drag frame costs: the growth of Chrome's cumulative
 * `TaskDuration` (every task on the main thread: script, style, layout, paint recording) between
 * two paced pointer moves, read through CDP `Performance.getMetrics`. Compositing and raster run
 * off the main thread and are not in it. Budgets (ADR-094): <= 16 ms p95 on desktop, <= 33 ms on
 * the tablet tier (touch, 1180 x 820, CPU throttled 2x), times `PERF_FACTOR` (ADR-010).
 *
 * Also reported: how many store writes (history entries) the drag made before release, and how many
 * times the sheet was rebuilt during the drag. Both must be zero (a drag writes on release only).
 */

const DESKTOP_MS = 16;
const TABLET_MS = 33;
const STEPS = 70;

interface Sample {
  frames: number[];
  rebuilds: number;
  writesBeforeRelease: number;
  commitMs: number;
}

const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0;
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

async function prepare(page: Page): Promise<void> {
  await openDemo(page);
  await newDrawing(page);
  await openTab(page, 'Views');
  await page.getByTestId('add-standard-views').click();
  await expect.poll(async () => (await drawing(page).state()).views.length).toBe(3);
  await built(page);
  await openTab(page, 'Import');
  await page.getByTestId('import-open').click();
  await page.getByRole('button', { name: 'Check all' }).click();
  await page.getByTestId('import-place').click();
  await expect(page.getByTestId('drawing-toast')).toContainText('Placed');
  await built(page);
  await closePanels(page);
  // A section across the front view (a hatched second view with a cut line on its parent).
  const front = viewOf(await drawing(page).state(), 'base');
  if (!front?.outline) throw new Error('no front view');
  const [x0, y0] = front.outline.min;
  const [x1, y1] = front.outline.max;
  await page.locator('[data-tool="section"]').click();
  const a = await sheetToPage(page, [x0 + 1, (y0 + y1) / 2]);
  const b = await sheetToPage(page, [x1 - 1, (y0 + y1) / 2]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, a.y);
  await page.mouse.move(b.x, b.y);
  await page.mouse.up();
  await expect
    .poll(async () => (await drawing(page).state()).views.some((v) => v.kind === 'section'))
    .toBe(true);
  await built(page);
  // A detail of the top view.
  const top = viewOf(await drawing(page).state(), 'projected', 'top');
  if (!top?.outline) throw new Error('no top view');
  await page.locator('[data-tool="detail"]').click();
  const dc: [number, number] = [
    top.outline.min[0] + 14,
    (top.outline.min[1] + top.outline.max[1]) / 2,
  ];
  const d0 = await sheetToPage(page, dc);
  const d1 = await sheetToPage(page, [dc[0] + 8, dc[1]]);
  await page.mouse.move(d0.x, d0.y);
  await page.mouse.down();
  await page.mouse.move((d0.x + d1.x) / 2, d0.y);
  await page.mouse.move(d1.x, d1.y);
  await page.mouse.up();
  await expect
    .poll(async () => (await drawing(page).state()).views.some((v) => v.kind === 'detail'))
    .toBe(true);
  await quiet(page);
  await page.locator('[data-tool="select"]').click();
}

/** Opens a panel tab (on the tablet the panels are under a handle that must be open first). */
async function openTab(page: Page, name: string): Promise<void> {
  const toggle = page.getByTestId('drawing-panel-toggle');
  if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) !== 'true')
    await toggle.click();
  await panelTab(page, name).click();
}

/** Closes the tablet's bottom panels (the sheet gets the room back). */
async function closePanels(page: Page): Promise<void> {
  const toggle = page.getByTestId('drawing-panel-toggle');
  if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) === 'true')
    await toggle.click();
}

/** Settled on the exact edges: nothing else lands while a drag is measured. */
async function quiet(page: Page): Promise<void> {
  await built(page);
  await drawing(page).exact();
  await expect.poll(async () => (await drawing(page).state()).refining).toBe(false);
}

/** Two animation frames: the work a pointer move scheduled has been done and painted. */
const settleFrame = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

async function measure(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  touchMode: boolean,
): Promise<Sample> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const busy = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return (metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0) * 1000;
  };
  const before = (await app(page).history()).past.length;
  const builds0 = (await drawing(page).state()).builds;
  const frames: number[] = [];
  const touchSend = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
    });
  if (touchMode) await touchSend('touchStart', from.x, from.y);
  else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
  }
  await settleFrame(page);
  for (let i = 1; i <= STEPS; i++) {
    const x = from.x + ((to.x - from.x) * i) / STEPS;
    const y = from.y + ((to.y - from.y) * i) / STEPS;
    const t0 = await busy();
    if (touchMode) await touchSend('touchMove', x, y);
    else await page.mouse.move(x, y);
    await settleFrame(page);
    frames.push((await busy()) - t0);
  }
  const writes = (await app(page).history()).past.length - before;
  const rebuilds = (await drawing(page).state()).builds - builds0;
  const c0 = Date.now();
  if (touchMode) await touchSend('touchEnd', to.x, to.y);
  else await page.mouse.up();
  await built(page);
  const commitMs = Date.now() - c0;
  await quiet(page);
  await cdp.detach();
  return { frames, rebuilds, writesBeforeRelease: writes, commitMs };
}

async function scenarios(page: Page, touchMode: boolean, budget: number): Promise<void> {
  const s0 = await drawing(page).state();
  const front = viewOf(s0, 'base');
  if (!front) throw new Error('no front view');
  const results: Record<string, Sample> = {};
  const run = async (name: string, from: { x: number; y: number }, dx: number, dy: number) => {
    const r = await measure(page, from, { x: from.x + dx, y: from.y + dy }, touchMode);
    results[name] = r;
    const line = `${name}: p50=${median(r.frames).toFixed(1)} p95=${p95(r.frames).toFixed(1)} max=${Math.max(...r.frames).toFixed(1)} ms; writesBeforeRelease=${r.writesBeforeRelease} rebuildsDuringDrag=${r.rebuilds} commit+rebuild=${r.commitMs} ms`;
    console.log(`[perf] drag frame (${touchMode ? 'tablet' : 'desktop'}) ${line}`);
    test.info().annotations.push({ type: 'perf', description: line });
  };

  const edgeOf = async (id: string) => {
    const e = (await drawing(page).edges(id)).find((x) => x.kind === 'line' || x.kind === 'arc');
    if (!e) throw new Error('no edge');
    return sheetToPage(page, e.at);
  };
  const centreOf = async (selector: string) => {
    const b = await page.locator(selector).first().boundingBox();
    if (!b) throw new Error(`no ${selector}`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  // A view (the front view: its lines, its dimensions and everything aligned to it move).
  await run('move view', await edgeOf(front.id), 30, 22);
  // A dimension: grab its line and drag its lane.
  const ps = (await drawing(page).placements()).filter((p) => p.text && p.layout.kind === 'lane');
  const pl = ps[0];
  if (!pl?.text || !pl.line) throw new Error('no dimension');
  const away = pl.layout.side === 'bottom' || pl.layout.side === 'right' ? 90 : -90;
  const horizontal = pl.layout.side === 'left' || pl.layout.side === 'right';
  const u: [number, number] = (() => {
    const l = Math.hypot(pl.line[1][0] - pl.line[0][0], pl.line[1][1] - pl.line[0][1]) || 1;
    return [(pl.line[1][0] - pl.line[0][0]) / l, (pl.line[1][1] - pl.line[0][1]) / l];
  })();
  const onLine = await sheetToPage(page, [pl.line[0][0] + u[0] * 2, pl.line[0][1] + u[1] * 2]);
  await run('move dimension line', onLine, horizontal ? away : 0, horizontal ? 0 : away);
  // Its text, along the line and across it.
  await run('move dimension text', await sheetToPage(page, pl.text), u[0] * 60, -u[1] * 60 + 6);
  const select = async (id: string) => {
    await openTab(page, 'Views');
    await page.locator(`[data-view-row="${id}"]`).click();
    await expect.poll(async () => (await drawing(page).state()).selected?.id).toBe(id);
    await closePanels(page);
  };
  // A section's cut-line vertex (select the section, grab a vertex).
  const section = viewOf(await drawing(page).state(), 'section');
  if (section) {
    await select(section.id);
    await page.locator('[data-testid="cut-handle"]').first().waitFor();
    await run('move cut vertex', await centreOf('[data-testid="cut-handle"]'), 20, 30);
  }
  // A detail circle's radius handle, and the detail view redrawing live under it.
  const detail = viewOf(await drawing(page).state(), 'detail');
  if (detail) {
    await select(detail.id);
    await page.locator('[data-testid="detail-handle"]').first().waitFor();
    await run(
      'resize detail circle',
      await centreOf('[data-testid="detail-handle"][data-kind="radius"] circle'),
      40,
      0,
    );
  }

  const worst = Math.max(...Object.values(results).map((r) => p95(r.frames)));
  for (const [name, r] of Object.entries(results)) {
    expect(r.writesBeforeRelease, `${name}: store writes before release`).toBe(0);
    expect(p95(r.frames), `${name}: p95 drag frame`).toBeLessThan(budget * PERF_FACTOR);
  }
  console.log(`[perf] worst p95 = ${worst.toFixed(1)} ms, budget ${budget} ms x${PERF_FACTOR}`);
}

test.describe('drag frame time', () => {
  test.slow();

  test('desktop: <= 16 ms p95', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await prepare(page);
    await scenarios(page, false, DESKTOP_MS);
  });
});

test.describe('drag frame time (tablet)', () => {
  test.slow();
  test.use({
    viewport: { width: 1180, height: 820 },
    userAgent: devices['iPad Pro 11'].userAgent,
    isMobile: true,
    hasTouch: true,
  });

  test('tablet: <= 33 ms p95, 2x CPU throttle', async ({ page }) => {
    await prepare(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 });
    await scenarios(page, true, TABLET_MS);
  });
});
