import { expect, type Page } from '@playwright/test';
import type { Measurement, WrenDoc, WrenTestHooks } from '@wren-cad/contracts';

/** App-level E2E hooks (`window.__wrenApp`, see src/app/workbench.ts `testHooks`). */
export interface AppHooks {
  doc(): WrenDoc;
  regen(): {
    revision: number;
    source: 'live' | 'cache';
    quality: 'coarse' | 'fine';
    bodies: { id: string; volume: number | null; bbox: { min: number[]; max: number[] } }[];
    features: {
      id: string;
      state: string;
      unresolved?: { path: string; reason: string; candidates?: string[] }[];
      rebound?: { path: string; name: string }[];
      error?: string;
    }[];
    sketches: { id: string; regions: string[] }[];
  } | null;
  idle(): Promise<void>;
  flushSave(): Promise<void>;
  sketch(): {
    status: string;
    dof: number;
    busy: boolean;
    redundant?: string[];
    conflicts?: unknown[];
  } | null;
  sketchSettled(): Promise<void>;
  marks(): Record<string, number>;
  ui(): {
    featureId: string | null;
    picking: { featureId: string; path: string } | null;
    candidates: string[] | null;
    toast: string | null;
    sketch: {
      featureId: string;
      /** The sketch plane frame (null until known). */
      plane: { origin: number[]; x: number[]; y: number[]; z: number[] } | null;
      edit: { tool: string; picks: number; model: number; busy: boolean } | null;
      tool: string | null;
      dimPicks: string[];
      editDimension: string | null;
      selected: string[];
      highlight: readonly string[] | null;
      highlightEntities: readonly string[] | null;
      stroke: { shape: string | null; points: number } | null;
      lastStroke: { shape: string; confidence: number } | null;
    } | null;
    selection: string[];
    /** `bodyId|kind|index|entity` per selected item. */
    selectionKeys: string[];
    hover: string | null;
    choices: number;
    prompt: string | null;
    pushPull: { faces: number; distance: number; expr: string; dragging: boolean } | null;
    measure: {
      active: boolean;
      picks: string[];
      results: Measurement[];
      busy: boolean;
      error: string | null;
    } | null;
    section: { enabled: boolean; axis: string; offset: number; flipped: boolean; picking: boolean };
    bubble: boolean;
    chooser: string[] | null;
    /** M3.5: the radial menu request, the box-select band, the settings tab, Tab's order. */
    radial: { source: string; held: boolean; x: number; y: number } | null;
    box: { mode: 'window' | 'crossing' } | null;
    settings: string | null;
    hoverKey: string | null;
    tabOrder: string[];
    lastTool: string | null;
    sheet: { snap: string; tab: string | null };
    kernel: { started: boolean; ready: boolean };
    camera: { moving: boolean; rest: number };
  };
  /** Undo (`past`, oldest first) and redo (`future`) steps with their labels. */
  history(): { past: { label: string }[]; future: { label: string }[] };
  /** Applies a command as one undo step (not through the UI path). */
  apply(command: unknown, label?: string): boolean;
  load(doc: WrenDoc): void;
  projectFiles(): {
    extra: string[];
    cache: string[];
    cacheKey: string | null;
    savedCacheKey: string | null;
  };
  sentAttachments(): string[];
  attentionMarkers(): string[];
  pendingHeals(): Record<string, { path: string; name: string }[]>;
  library(): Promise<{ id: string; name: string }[]>;
  /** Extra file paths stored with a library entry. */
  libraryFiles(id: string): Promise<string[]>;
  cacheSaved(): Promise<boolean>;
}

type W = { __wren: WrenTestHooks; __wrenApp: AppHooks };

/** Opens the app (real regen engine unless `query` says `engine=fake`) and waits for the first regen to render. */
export async function boot(page: Page, query = ''): Promise<void> {
  await page.goto(`./?${query}`);
  // The first visit reloads once for isolation: wait for the isolated document's own hooks.
  await page.waitForFunction(
    () => window.crossOriginIsolated === true && !!(window as unknown as Partial<W>).__wren,
  );
  await page.evaluate(() => (window as unknown as W).__wren.firstBodyRendered());
}

export const app = (page: Page) => ({
  doc: () => page.evaluate(() => (window as unknown as W).__wrenApp.doc()),
  regen: () => page.evaluate(() => (window as unknown as W).__wrenApp.regen()),
  idle: () => page.evaluate(() => (window as unknown as W).__wrenApp.idle()),
  flushSave: () => page.evaluate(() => (window as unknown as W).__wrenApp.flushSave()),
  sketch: () => page.evaluate(() => (window as unknown as W).__wrenApp.sketch()),
  settled: () => page.evaluate(() => (window as unknown as W).__wrenApp.sketchSettled()),
  ui: () => page.evaluate(() => (window as unknown as W).__wrenApp.ui()),
  marks: () => page.evaluate(() => (window as unknown as W).__wrenApp.marks()),
  history: () => page.evaluate(() => (window as unknown as W).__wrenApp.history()),
  apply: (command: unknown, label?: string) =>
    page.evaluate(
      ([c, l]) => (window as unknown as W).__wrenApp.apply(c, l as string | undefined),
      [command, label] as const,
    ),
  load: (doc: WrenDoc) => page.evaluate((d) => (window as unknown as W).__wrenApp.load(d), doc),
  projectFiles: () => page.evaluate(() => (window as unknown as W).__wrenApp.projectFiles()),
  sentAttachments: () => page.evaluate(() => (window as unknown as W).__wrenApp.sentAttachments()),
  attentionMarkers: () =>
    page.evaluate(() => (window as unknown as W).__wrenApp.attentionMarkers()),
  pendingHeals: () => page.evaluate(() => (window as unknown as W).__wrenApp.pendingHeals()),
  library: () => page.evaluate(() => (window as unknown as W).__wrenApp.library()),
  cacheSaved: () => page.evaluate(() => (window as unknown as W).__wrenApp.cacheSaved()),
  libraryFiles: (id: string) =>
    page.evaluate((x) => (window as unknown as W).__wrenApp.libraryFiles(x), id),
});

/** The viewport's test surface (`window.__wrenViewport`, packages/viewport ViewportEngine). */
export interface ViewportProbe {
  getCameraState(): { position: number[]; target: number[]; distance: number };
  isCameraMoving(): boolean;
  getTouchStats(): {
    prismBuilds: number;
    lastPreviewPresentedAt: number;
    sectionActive: boolean;
    handleHover: string | null;
  };
  getRenderCount(): number;
  getHandleScreenLength(id: string): number | null;
  worldToScreen(p: [number, number, number]): { x: number; y: number; visible: boolean };
}

type V = { __wrenViewport: ViewportProbe };

export const touchStats = (page: Page) =>
  page.evaluate(() => (window as unknown as V).__wrenViewport.getTouchStats());
export const cameraState = (page: Page) =>
  page.evaluate(() => (window as unknown as V).__wrenViewport.getCameraState());

/** Raw touch input through CDP (Playwright's touchscreen only taps with one finger). */
export async function touch(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  type TouchType = 'touchStart' | 'touchEnd' | 'touchMove';
  const send = (type: TouchType, pts: Array<{ x: number; y: number }>, timestamp?: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })),
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
  return {
    /**
     * A double-tap with event times 40 / 120 / 160 ms after the first touch. The gesture
     * recognizer reads event timestamps, so a renderer busy with the first tap (software GL on
     * CI) doesn't turn it into two single taps.
     */
    doubleTap: async (p: { x: number; y: number }) => {
      const t0 = Date.now() / 1000;
      await send('touchStart', [p], t0);
      await send('touchEnd', [], t0 + 0.04);
      await send('touchStart', [p], t0 + 0.12);
      await send('touchEnd', [], t0 + 0.16);
    },
    down: (pts: Array<{ x: number; y: number }>) => send('touchStart', pts),
    move: (pts: Array<{ x: number; y: number }>) => send('touchMove', pts),
    up: () => send('touchEnd', []),
    /** A tap with `pts.length` fingers (lifted 50 ms later in event time). */
    tap: async (pts: Array<{ x: number; y: number }>) => {
      const t0 = Date.now() / 1000;
      await send('touchStart', pts, t0);
      await send('touchEnd', [], t0 + 0.05);
    },
    /** A one-finger drag in `steps` moves. */
    drag: async (from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) => {
      await send('touchStart', [from]);
      for (let k = 1; k <= steps; k++)
        await send('touchMove', [
          { x: from.x + ((to.x - from.x) * k) / steps, y: from.y + ((to.y - from.y) * k) / steps },
        ]);
      await send('touchEnd', []);
    },
    /** Apple Pencil: pen pointer events (CDP mouse events with pointerType `pen`). */
    pen: {
      hover: (p: { x: number; y: number }) =>
        cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, pointerType: 'pen' }),
      down: (p: { x: number; y: number }) =>
        cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...p,
          button: 'left',
          buttons: 1,
          clickCount: 1,
          pointerType: 'pen',
          force: 0.5,
        }),
      move: (p: { x: number; y: number }) =>
        cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          ...p,
          button: 'left',
          buttons: 1,
          pointerType: 'pen',
          force: 0.5,
        }),
      up: (p: { x: number; y: number }) =>
        cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...p,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          pointerType: 'pen',
        }),
    },
  };
}

/** Page point of the middle of the bounding box's top face (+Z) of the first body. */
export async function topCenter(page: Page): Promise<{ x: number; y: number }> {
  const b = (await app(page).regen())?.bodies[0]?.bbox;
  if (!b) throw new Error('no body');
  return toPage(page, [
    ((b.min[0] ?? 0) + (b.max[0] ?? 0)) / 2,
    ((b.min[1] ?? 0) + (b.max[1] ?? 0)) / 2,
    b.max[2] ?? 0,
  ]);
}

/**
 * The category each flyout tool lives in (packages/ui `toolGroups`). Sketch and Hole are direct
 * buttons. The desktop command bar and the tablet rail share this layout.
 */
const TOOL_GROUP: Record<string, string> = {
  extrude: 'solid',
  extrudeCut: 'solid',
  revolve: 'solid',
  revolveCut: 'solid',
  pushPull: 'solid',
  sweep: 'solid',
  loft: 'solid',
  fillet: 'modify',
  chamfer: 'modify',
  shell: 'modify',
  draft: 'modify',
  thread: 'modify',
  mirror: 'pattern',
  linearPattern: 'pattern',
  circularPattern: 'pattern',
  plane: 'reference',
  axis: 'reference',
  point: 'reference',
  measure: 'inspect',
  section: 'inspect',
};

/** A tool's button (`[data-tool]`), whether it is a direct button or inside an open flyout. */
export const toolButton = (page: Page, id: string) => page.locator(`[data-tool="${id}"]`);

/** A category button of the command bar / rail (`solid`, `modify`, `inspect`, ...). */
export const toolGroup = (page: Page, group: string) =>
  page.locator(`[data-tool-group="${group}"]`);

/**
 * Picks a tool from the command bar (desktop) or rail (tablet): opens its category first when the
 * tool lives in a flyout, then presses the tool. `how` is `tap` for touch projects.
 */
export async function tool(page: Page, id: string, how: 'click' | 'tap' = 'click'): Promise<void> {
  const group = TOOL_GROUP[id];
  if (group) {
    const g = toolGroup(page, group);
    if ((await g.getAttribute('aria-expanded')) !== 'true') await g[how]();
    await expect(page.getByTestId('tool-flyout')).toBeVisible();
  }
  await toolButton(page, id)[how]();
}

/** Runs a ⌘K palette command by its label. */
export async function palette(page: Page, label: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await page.keyboard.type(label);
  await page
    .getByRole('option', { name: new RegExp(`^${label}`) })
    .first()
    .click();
  await dialog.waitFor({ state: 'hidden' });
}

/** Adds a 40 × 30 × 20 box through the palette and waits for it to render. */
export async function addBox(page: Page): Promise<void> {
  await palette(page, 'Box');
  await app(page).idle();
}

/** Page coordinates of a world point (mm). */
export async function toPage(
  page: Page,
  p: [number, number, number],
): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('viewport-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const s = await page.evaluate(
    (q) =>
      (
        window as unknown as {
          __wrenViewport: {
            worldToScreen(p: [number, number, number]): { x: number; y: number };
          };
        }
      ).__wrenViewport.worldToScreen(q),
    p,
  );
  return { x: box.x + s.x, y: box.y + s.y };
}

/** Waits until the camera stops moving (animated transitions). */
export async function cameraStill(page: Page): Promise<void> {
  // At rest = camera-controls reports no transition/damping/pointer AND the pose is unchanged
  // across two samples (a pose comparison alone passes mid-animation when no frame ran between
  // samples on a busy runner).
  let last = '';
  for (let i = 0; i < 100; i++) {
    const s = await page.evaluate(() => {
      const v = (
        window as unknown as {
          __wrenViewport: { getCameraState(): unknown; isCameraMoving(): boolean };
        }
      ).__wrenViewport;
      return v.isCameraMoving() ? null : JSON.stringify(v.getCameraState());
    });
    if (s !== null && s === last) return;
    last = s ?? '';
    await page.waitForTimeout(100);
  }
  throw new Error('camera never came to rest');
}

/** Starts a sketch on a standard plane and waits until the view has turned to it. */
export async function sketchOn(page: Page, plane: 'Top' | 'Front' | 'Right'): Promise<void> {
  await page
    .getByTestId('plane-chooser')
    .getByRole('button', { name: new RegExp(plane) })
    .click();
  // The toolbar appears in the same step that starts the camera's turn to the plane.
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
  await cameraStill(page);
}

/** Clicks a point on the sketch plane z = 0. */
export async function clickAt(page: Page, x: number, y: number, z = 0): Promise<void> {
  const p = await toPage(page, [x, y, z]);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
}
