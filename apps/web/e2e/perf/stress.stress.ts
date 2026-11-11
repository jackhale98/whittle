import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { app, boot, cameraStill, toPage, touchStats } from '../helpers';
import { BUDGETS, PERF_FACTOR } from './budgets';
import { peakMemory } from './memory-probe';

/**
 * Stress part in the browser (report-only; the `stress` Playwright project, nightly in soak.yml):
 * the 100+ feature injection-moulded enclosure (packages/test-fixtures/stress-part, committed as
 * e2e/fixtures/stress-enclosure.wrencad) through the whole path: file open -> worker regen ->
 * tessellation -> transfer -> draw. Measures:
 *  - open the file -> first body on screen; kernel cold regen -> every feature ok;
 *  - Params-tab edit of an early parameter (wall) -> model redrawn (coarse) and settled (fine);
 *  - the same for a rim-fillet radius edit (early) and a late parameter edit (ear thickness);
 *  - main-thread responsiveness DURING the long regen: worst frame gap, longest task, event-loop
 *    lateness, whether a real click is handled, whether any progress/busy indicator is in the DOM;
 *  - frame time while orbiting; push/pull preview latency on a face; peak memory;
 *  - cached open (reload): first frame before the kernel is ready.
 * Nothing here gates a build: it asserts correctness (every feature ok) and prints the numbers.
 * Run: `pnpm --filter @wren-cad/web stress` (after a build). Use `WREN_E2E_PORT` for a private
 * port. Proposed budgets (not in PLAN §10 yet) are in the PR description.
 */

const FIXTURE = fileURLToPath(new URL('../fixtures/stress-enclosure.wrencad', import.meta.url));
const FEATURES = 100;
const ROWS: { metric: string; value: string }[] = [];
const note = (metric: string, value: string) => {
  ROWS.push({ metric, value });
  console.log(`[stress] ${metric}: ${value}`);
};
const ms = (n: number) => `${Math.round(n)} ms`;

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(45 * 60_000);

let page: Page;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { showSaveFilePicker?: unknown; showOpenFilePicker?: unknown };
    w.showSaveFilePicker = undefined;
    w.showOpenFilePicker = undefined;
  });
});

test.afterAll(async () => {
  const load = await import('node:os').then((os) =>
    os
      .loadavg()
      .map((x) => x.toFixed(1))
      .join(' '),
  );
  const table = ROWS.map((r) => `${r.metric.padEnd(62)} ${r.value}`).join('\n');
  console.log(
    `\n[stress] browser report (load average ${load}; PERF_FACTOR ${PERF_FACTOR})\n${table}`,
  );
  const out = process.env.WREN_STRESS_OUT ?? 'test-results/stress-report.json';
  try {
    writeFileSync(out, JSON.stringify({ load, rows: ROWS }, null, 1));
  } catch {
    // test-results may not exist yet; the console table is the report
  }
  await page?.context().close();
});

interface RegenSnap {
  revision: number;
  source: string;
  quality: string;
  ok: number;
  total: number;
  faces: number;
  shown: number;
}

const snap = (p: Page): Promise<RegenSnap | null> =>
  p.evaluate(() => {
    const h = (window as unknown as { __wrenApp: { regen(): unknown; shownBodies(): string[] } })
      .__wrenApp;
    const r = h.regen() as {
      revision: number;
      source: string;
      quality: string;
      features: { state: string }[];
      bodies: { faces: number }[];
    } | null;
    if (!r) return null;
    return {
      revision: r.revision,
      source: r.source,
      quality: r.quality,
      ok: r.features.filter((f) => f.state === 'ok').length,
      total: r.features.length,
      faces: r.bodies.reduce((s, b) => s + b.faces, 0),
      shown: h.shownBodies().length,
    };
  });

/** Poll until `pred` holds on the regen summary; resolves to the elapsed ms since `t0`. */
async function until(
  p: Page,
  t0: number,
  pred: (s: RegenSnap) => boolean,
  timeoutMs = 40 * 60_000,
): Promise<{ ms: number; snap: RegenSnap }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await snap(p);
    if (s && pred(s)) {
      // The result is in the store; the frame that draws it follows.
      await p.evaluate(
        () =>
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );
      return { ms: Date.now() - t0, snap: s };
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for regen (last ${JSON.stringify(s)})`);
    await page.waitForTimeout(50);
  }
}

/** In-page probe: worst rAF gap, longest task, worst timer lateness, frame count. */
async function startProbe(p: Page): Promise<void> {
  await p.evaluate(() => {
    const w = window as unknown as { __probe?: unknown };
    const st = {
      last: performance.now(),
      gaps: [] as number[],
      longest: 0,
      tasks: 0,
      late: 0,
      raf: 0,
      timer: 0,
      stop: false,
      expected: performance.now() + 20,
    };
    const frame = () => {
      const t = performance.now();
      st.gaps.push(t - st.last);
      st.last = t;
      if (!st.stop) st.raf = requestAnimationFrame(frame);
    };
    st.raf = requestAnimationFrame(frame);
    const tick = () => {
      const t = performance.now();
      st.late = Math.max(st.late, t - st.expected);
      st.expected = t + 20;
      if (!st.stop) st.timer = window.setTimeout(tick, 20);
    };
    st.timer = window.setTimeout(tick, 20);
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          st.tasks++;
          st.longest = Math.max(st.longest, e.duration);
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      // longtask unsupported: the gap numbers remain
    }
    w.__probe = st;
  });
}

async function stopProbe(p: Page) {
  return p.evaluate(() => {
    const st = (window as unknown as { __probe: Record<string, unknown> }).__probe as {
      gaps: number[];
      longest: number;
      tasks: number;
      late: number;
      stop: boolean;
    };
    st.stop = true;
    const g = [...st.gaps].sort((a, b) => a - b);
    const q = (x: number) => g[Math.min(g.length - 1, Math.floor(x * g.length))] ?? 0;
    return {
      frames: g.length,
      p50: q(0.5),
      p95: q(0.95),
      max: g.at(-1) ?? 0,
      longTaskMax: st.longest,
      longTasks: st.tasks,
      timerLateMax: st.late,
    };
  });
}

const indicators = (p: Page) =>
  p.evaluate(() => ({
    busy: document.querySelectorAll('[aria-busy="true"], [role="progressbar"], progress').length,
    chips: [
      ...document.querySelectorAll(
        '[data-testid*="status"], [data-testid*="regen"], [data-testid*="busy"]',
      ),
    ]
      .map((e) => (e.textContent ?? '').trim())
      .filter(Boolean)
      .slice(0, 4),
  }));

async function openFixture(): Promise<number> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open or import…' }).click();
  const fc = await chooser;
  const t0 = Date.now();
  await fc.setFiles(FIXTURE);
  return t0;
}

test('open the fixture: first render, cold kernel regen, every feature ok', async () => {
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  // WREN_STRESS_PROFILE=1: a main-thread CPU profile of the open + cold regen (CDP), written to
  // test-results/stress-main.cpuprofile (load it in Chrome DevTools). The worker is not included.
  const cdp = process.env.WREN_STRESS_PROFILE ? await page.context().newCDPSession(page) : null;
  if (cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start');
  }
  const t0 = await openFixture();
  await startProbe(page);
  const shown = await until(page, t0, (s) => s.shown > 0 && s.total === FEATURES);
  const ok = await until(
    page,
    t0,
    (s) => s.total === FEATURES && s.ok === FEATURES && s.source === 'live',
  );
  const probe = await stopProbe(page);
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync('test-results/stress-main.cpuprofile', JSON.stringify(profile));
  }
  note('open file -> first body on screen', ms(shown.ms));
  note('open file -> kernel cold regen, all 100 features ok', ms(ok.ms));
  note(
    'main thread during that cold regen (rAF gap p95/max, long task max)',
    `${probe.p95.toFixed(0)} / ${probe.max.toFixed(0)} ms, ${probe.longTaskMax.toFixed(0)} ms (${probe.longTasks} tasks), timer lateness max ${probe.timerLateMax.toFixed(0)} ms`,
  );
  expect(ok.snap.ok).toBe(FEATURES);
  note('result: faces on the body', String(ok.snap.faces));
  await app(page).idle();
  note('... then the fine mesh settled (idle)', ms(Date.now() - t0));
});

async function paramEdit(name: string, value: string, label: string): Promise<void> {
  const a = app(page);
  await page.getByRole('tab', { name: 'Params' }).click();
  const box = page.getByRole('textbox', { name: `Expression for ${name}` });
  const before = (await snap(page))?.revision ?? 0;
  await box.fill(value);
  await startProbe(page);
  const t0 = Date.now();
  await box.press('Enter');

  // While the worker regenerates: is the UI alive, and is anything telling the user?
  const during: {
    clickMs: number | null;
    roundTripMs: number;
    ind: Awaited<ReturnType<typeof indicators>>;
  } = {
    clickMs: null,
    roundTripMs: 0,
    ind: { busy: 0, chips: [] },
  };
  await page.waitForTimeout(400);
  const rt0 = Date.now();
  await page.evaluate(() => performance.now());
  during.roundTripMs = Date.now() - rt0;
  during.ind = await indicators(page);
  const c0 = Date.now();
  await page
    .getByRole('tab', { name: 'Features' })
    .click({ timeout: 60_000 })
    .catch(() => undefined);
  const selected = await page
    .getByRole('tab', { name: 'Features' })
    .getAttribute('aria-selected')
    .catch(() => null);
  if (selected === 'true') during.clickMs = Date.now() - c0;

  const coarse = await until(page, t0, (s) => s.revision > before && s.total === FEATURES);
  const probe = await stopProbe(page);
  await a.idle();
  const settled = Date.now() - t0;
  note(`${label}: edit -> model redrawn (coarse result drawn)`, ms(coarse.ms));
  note(`${label}: edit -> settled (fine mesh, idle)`, ms(settled));
  note(
    `${label}: UI during the regen`,
    `evaluate round trip ${during.roundTripMs} ms; tab click handled in ${during.clickMs ?? 'n/a'} ms; ` +
      `rAF gap p95/max ${probe.p95.toFixed(0)}/${probe.max.toFixed(0)} ms; long task max ${probe.longTaskMax.toFixed(0)} ms; ` +
      `busy/progress elements ${during.ind.busy}; status text ${JSON.stringify(during.ind.chips)}`,
  );
  expect(coarse.snap.ok, `${label}: features ok after the edit`).toBe(FEATURES);
}

test('Params edit of an early parameter (wall: shell onwards, full downstream regen)', async () => {
  await paramEdit('wall', '2.8 mm', 'wall 2.5 -> 2.8 mm (early)');
});

test('Params edit of a rim fillet radius (early fillet)', async () => {
  await paramEdit('fillet_r', '0.9 mm', 'fillet_r 0.8 -> 0.9 mm (early)');
});

test('Params edit of a late parameter (ear thickness)', async () => {
  await paramEdit('ear_t', '3.4 mm', 'ear_t 3 -> 3.4 mm (late)');
});

test('Params edit of the first sketch dimension (length: everything)', async () => {
  await paramEdit('length', '122 mm', 'length 120 -> 122 mm (first sketch)');
});

test('frame time while orbiting', async () => {
  await cameraStill(page);
  const box = await page.getByTestId('viewport-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await startProbe(page);
  const r0 = await page.evaluate(() =>
    (
      window as unknown as { __wrenViewport: { getRenderCount(): number } }
    ).__wrenViewport.getRenderCount(),
  );
  const t0 = Date.now();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(cx + Math.sin(i / 8) * 220, cy + Math.cos(i / 8) * 90);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  const wall = Date.now() - t0;
  const probe = await stopProbe(page);
  const r1 = await page.evaluate(() =>
    (
      window as unknown as { __wrenViewport: { getRenderCount(): number } }
    ).__wrenViewport.getRenderCount(),
  );
  note(
    'orbit: frame interval p50 / p95 / max (software GL unless a GPU exists)',
    `${probe.p50.toFixed(1)} / ${probe.p95.toFixed(1)} / ${probe.max.toFixed(1)} ms; ${r1 - r0} renders in ${wall} ms`,
  );
  note(
    'orbit budget reference (PLAN §10, 1M triangles)',
    `<= 8 ms desktop, x${PERF_FACTOR} on CI; this part is ~10k triangles`,
  );
});

test('push/pull preview feedback on an ear face', async () => {
  const a = app(page);
  await cameraStill(page);
  // Top face of the +X mounting ear (length/2 + 1.5 mm out, 6 mm off the centre line, 3 mm up).
  const dims = { L: 122, H: 3.4 };
  const c = await toPage(page, [dims.L / 2 + 1.5, 6, dims.H]);
  await page.mouse.click(c.x, c.y);
  await a.idle();
  const sel = (await a.ui()).selection;
  if (!sel.includes('face')) {
    note('push/pull preview', `skipped: the click did not select a face (${JSON.stringify(sel)})`);
    return;
  }
  await page.keyboard.press('p');
  await expect.poll(async () => (await a.ui()).pushPull?.faces, { timeout: 30_000 }).toBe(1);
  const base = await toPage(page, [dims.L / 2 + 1.5, 6, dims.H]);
  const up = await toPage(page, [dims.L / 2 + 1.5, 6, dims.H + 5]);
  const l = Math.hypot(up.x - base.x, up.y - base.y);
  const at = (px: number) => ({
    x: base.x + ((up.x - base.x) / l) * px,
    y: base.y + ((up.y - base.y) / l) * px,
  });
  const before = await touchStats(page);
  await page.mouse.move(at(40).x, at(40).y);
  await page.mouse.down();
  const samples: number[] = [];
  for (let i = 1; i <= 8; i++) {
    const t0 = await page.evaluate(() => performance.now());
    await page.mouse.move(at(40 + i * 12).x, at(40 + i * 12).y);
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    const presented = (await touchStats(page)).lastPreviewPresentedAt;
    samples.push(presented - t0);
  }
  const during = await touchStats(page);
  await page.mouse.up();
  await a.idle();
  const s = [...samples].sort((x, y) => x - y);
  note(
    'push/pull: pointer move -> preview presented (median / max of 8)',
    `${s[3]?.toFixed(1)} / ${s.at(-1)?.toFixed(1)} ms; prism builds ${during.prismBuilds - before.prismBuilds}`,
  );
  note('push/pull budget (PLAN §10)', `same frame, <= 16 ms (x${PERF_FACTOR} on CI)`);
});

test('peak memory with the part loaded and after the edits above', async () => {
  const m = await peakMemory(page);
  const mb = (b: number | null) => (b === null ? 'n/a' : `${(b / 1048576).toFixed(0)} MB`);
  note(
    'memory: userAgentMemory / process-tree PSS / main JS heap',
    `${mb(m.ua)} / ${mb(m.tree)} / ${mb(m.heap)} (budget ${mb(BUDGETS.peakMemoryBytes)}; ${m.note})`,
  );
  expect(Math.max(m.ua ?? 0, m.tree ?? 0, m.heap ?? 0)).toBeGreaterThan(0);
});

test('cached open: reload draws the stored meshes before the kernel is ready', async () => {
  const a = app(page);
  await a.flushSave();
  const cached = await a.cacheSaved();
  note('mesh cache saved with the document', String(cached));
  await page.reload();
  const t0 = Date.now();
  await page.evaluate(() =>
    (
      window as unknown as { __wren: { firstBodyRendered(): Promise<unknown> } }
    ).__wren.firstBodyRendered(),
  );
  const marks = await a.marks();
  note(
    'reload: cached first frame (budget 500 ms) / kernel ready / first live body',
    `${ms(marks.cachedBodyMs ?? Number.NaN)} / ${ms(marks.kernelReadyMs ?? Number.NaN)} / ${ms(marks.firstBodyMs ?? Number.NaN)} (since navigation start)`,
  );
  const live = await until(page, t0, (s) => s.source === 'live' && s.ok === FEATURES);
  note('reload: kernel regen (cold, new worker) -> all features ok', ms(live.ms));
  expect(live.snap.ok).toBe(FEATURES);
});

// Keep the fixture file referenced so a stale path fails loudly instead of at open time.
test('fixture file is present', () => {
  expect(readFileSync(FIXTURE).byteLength).toBeGreaterThan(1000);
});
