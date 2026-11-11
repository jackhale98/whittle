/**
 * Recreates a reference part's spec drawing with Wren's drawing tools (PLAN section 12 M4 Accept,
 * 12A): the views, the section cut, the Import panel, and the Dimension tool. The test hooks are
 * only used to set up (load the part's document) and to read state (views, placements,
 * resolutions); every view and dimension is made through the drawing UI.
 *
 * The spec's drawing section (packages/test-fixtures/reference-parts/*.spec.json) is the contract:
 * views with their orientation, parent and side; dimensions with kind, value, view and the
 * geometry they measure (in the view's drawn coordinates; `axes` say what those are in the part).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { Annotation, Drawing, WrenDoc } from '@wren-cad/contracts';
import type {
  DrawingDimSpec,
  DrawingViewSpec,
  PartSpec,
  WorldAxis,
} from '@wren-cad/test-fixtures/reference-parts';
import { app } from '../helpers';
import {
  built,
  type DrawingState,
  drag,
  drawing,
  type Edge,
  panelTab,
  sheetToPage,
} from './drawing-ui';

const SPEC_DIR = join(import.meta.dirname, '../../../../packages/test-fixtures/reference-parts');

export const loadPartSpec = (id: string): PartSpec =>
  JSON.parse(readFileSync(join(SPEC_DIR, `${id}.spec.json`), 'utf8')) as PartSpec;

type V2 = [number, number];
type V3 = [number, number, number];

// ------------------------------------------------------------------------------------------
// Coordinates: spec drawn coordinates -> part -> Wren's view -> sheet
// ------------------------------------------------------------------------------------------

/** What a view's right and up are in the part, for Wren's named views (view/frame.ts). */
const WREN_AXES: Record<string, [WorldAxis, WorldAxis]> = {
  front: ['X', 'Z'],
  back: ['-X', 'Z'],
  right: ['Y', 'Z'],
  left: ['-Y', 'Z'],
  top: ['X', 'Y'],
  bottom: ['X', '-Y'],
};

const axisIndex = (a: WorldAxis) => 'XYZ'.indexOf(a.replace('-', ''));
const axisSign = (a: WorldAxis) => (a.startsWith('-') ? -1 : 1);

/** A point drawn in `view` as a part position, with only the two axes the view shows known. */
function toPart(view: DrawingViewSpec, p: V2): (number | undefined)[] {
  const w: (number | undefined)[] = [undefined, undefined, undefined];
  w[axisIndex(view.axes[0])] = axisSign(view.axes[0]) * p[0];
  w[axisIndex(view.axes[1])] = axisSign(view.axes[1]) * p[1];
  return w;
}

/** Wren's own view coordinates of a part position, for `orientation`. */
function toWren(orientation: string, w: (number | undefined)[]): V2 {
  const axes = WREN_AXES[orientation] as [WorldAxis, WorldAxis];
  const get = (a: WorldAxis) => {
    const v = w[axisIndex(a)];
    if (v === undefined) throw new Error(`${orientation} view needs part axis ${a}, not drawn`);
    return axisSign(a) * v;
  };
  return [get(axes[0]), get(axes[1])];
}

export interface Placed {
  spec: DrawingViewSpec;
  /** The drawing's view id. */
  id: string;
}

/** Sheet position (mm) of a point drawn in the spec's view `v`. */
export function sheetPoint(
  spec: PartSpec,
  v: Placed,
  state: DrawingState,
  p: V2,
): { x: number; y: number } & { at: V2 } {
  const s = state.views.find((x) => x.id === v.id);
  if (!s?.position || !s.scale) throw new Error(`view ${v.spec.id} has no position`);
  const { min, max } = spec.expected.bbox;
  const centre = [0, 1, 2].map((i) => ((min[i] as number) + (max[i] as number)) / 2);
  const o = v.spec.kind === 'section' ? 'front' : v.spec.orientation;
  const c = toWren(o, centre);
  const q = toWren(o, toPart(v.spec, p));
  const at: V2 = [s.position[0] + s.scale * (q[0] - c[0]), s.position[1] + s.scale * (q[1] - c[1])];
  return { x: at[0], y: at[1], at };
}

const click = async (page: Page, p: V2) => {
  const at = await sheetToPage(page, p);
  await page.mouse.click(at.x, at.y);
};

// ------------------------------------------------------------------------------------------
// Views
// ------------------------------------------------------------------------------------------

const part = async (page: Page) => (await app(page).doc()).parts[0] as WrenDoc['parts'][number];
const drawings = async (page: Page): Promise<Drawing[]> => (await app(page).doc()).drawings;
export const annotations = async (page: Page): Promise<Annotation[]> =>
  (await part(page)).annotations ?? [];

const SIDE_DIR: Record<string, string> = {
  above: '0,1',
  below: '0,-1',
  left: '-1,0',
  right: '1,0',
};

async function selectView(page: Page, id: string): Promise<void> {
  await panelTab(page, 'Views').click();
  await page.locator(`[data-view-row="${id}"]`).click();
  await expect.poll(async () => (await drawing(page).state()).selected?.id).toBe(id);
}

async function newViewId(page: Page, before: Set<string>): Promise<string> {
  await expect.poll(async () => (await drawing(page).state()).views.length).toBe(before.size + 1);
  const s = await built(page);
  const v = s.views.find((x) => !before.has(x.id));
  if (!v) throw new Error('no new view');
  return v.id;
}

/**
 * Makes the drawing's views, in spec order (parents first). The drawing starts with the default
 * base view; it is replaced when the spec's base view is another orientation.
 */
export async function addViews(page: Page, spec: PartSpec): Promise<Placed[]> {
  const out: Placed[] = [];
  // Parents first: the spec lists views in the order they are drawn on the sheet.
  const depth = (v: DrawingViewSpec): number =>
    v.parent ? 1 + depth(spec.drawing.views.find((x) => x.id === v.parent) as DrawingViewSpec) : 0;
  const specViews = [...spec.drawing.views].sort((a, b) => depth(a) - depth(b));
  let state = await built(page);
  const first = state.views[0];
  if (!first) throw new Error('no default view');
  const firstDrawn = ((await drawings(page))[0] as Drawing).views[0];
  const firstName =
    firstDrawn?.kind === 'base' && firstDrawn.orientation.kind === 'named'
      ? firstDrawn.orientation.name
      : null;

  for (const v of specViews) {
    const before = new Set((await drawing(page).state()).views.map((x) => x.id));
    if (v.kind === 'base') {
      if (v.orientation === firstName && !out.some((p) => p.id === first.id)) {
        out.push({ spec: v, id: first.id });
        continue;
      }
      await panelTab(page, 'Views').click();
      await page.locator(`[data-view="${v.orientation}"]`).click();
      out.push({ spec: v, id: await newViewId(page, before) });
    } else if (v.kind === 'projected') {
      const parent = out.find((p) => p.spec.id === v.parent);
      if (!parent) throw new Error(`parent of ${v.id}`);
      await selectView(page, parent.id);
      state = await built(page);
      const o = state.views.find((x) => x.id === parent.id)?.outline;
      if (!o) throw new Error('no outline');
      const dir = (SIDE_DIR[v.side as string] as string).split(',').map(Number) as V2;
      const handle = page
        .locator(`[data-testid="view-handle"][data-dir="${SIDE_DIR[v.side as string]}"] circle`)
        .first();
      const hb = await handle.boundingBox();
      if (!hb) throw new Error('no view handle');
      const half: V2 = [(o.max[0] - o.min[0]) / 2, (o.max[1] - o.min[1]) / 2];
      const mid: V2 = [(o.min[0] + o.max[0]) / 2, (o.min[1] + o.max[1]) / 2];
      const to = await sheetToPage(page, [
        mid[0] + dir[0] * (half[0] + 60),
        mid[1] + dir[1] * (half[1] + 60),
      ]);
      await drag(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, to);
      out.push({ spec: v, id: await newViewId(page, before) });
    } else if (v.kind === 'section') {
      const parent = out.find((p) => p.spec.id === v.parent);
      if (!parent || !v.section) throw new Error(`parent of ${v.id}`);
      state = await built(page);
      const o = state.views.find((x) => x.id === parent.id)?.outline;
      if (!o) throw new Error('no outline');
      // The Section tool draws one straight cut line: the first and last point of the spec's cut.
      const cut = v.section.cut;
      const a = sheetPoint(spec, parent, state, cut[0] as V2).at;
      const b = sheetPoint(spec, parent, state, cut.at(-1) as V2).at;
      const inside = (p: V2): V2 => [
        Math.min(Math.max(p[0], o.min[0] + 1), o.max[0] - 1),
        Math.min(Math.max(p[1], o.min[1] + 1), o.max[1] - 1),
      ];
      await page.locator('[data-tool="section"]').click();
      await drag(page, await sheetToPage(page, inside(a)), await sheetToPage(page, inside(b)));
      out.push({ spec: v, id: await newViewId(page, before) });
    } else {
      throw new Error(`the driver has no detail views: ${v.id} (no spec drawing has one yet)`);
    }
  }
  // Drop the default view when the spec does not show it (it never has children then).
  if (!out.some((p) => p.id === first.id)) {
    await selectView(page, first.id);
    await page.getByTestId('delete-view').click();
    await expect.poll(async () => (await drawing(page).state()).views.length).toBe(out.length);
  }
  await built(page);
  return out;
}

// ------------------------------------------------------------------------------------------
// Annotations: import, binding to the spec's dimensions, the Dimension tool
// ------------------------------------------------------------------------------------------

export async function importAll(page: Page): Promise<number> {
  await panelTab(page, 'Import').click();
  await page.getByTestId('import-open').click();
  await page.getByRole('button', { name: 'Check all' }).click();
  const place = page.getByTestId('import-place');
  const n = Number(/(\d+)/.exec(await place.innerText())?.[1] ?? 0);
  if (n > 0) {
    await place.click();
    await expect(page.getByTestId('drawing-toast')).toContainText('Placed');
  } else await page.getByRole('button', { name: 'Cancel' }).click();
  await built(page);
  return n;
}

/** The expression a promoted annotation's value comes from (`hole_x`, `thickness`...). */
export function exprOf(p: WrenDoc['parts'][number], a: Annotation): string | undefined {
  const s = 'source' in a ? a.source : undefined;
  if (!s) return undefined;
  const f = p.features.find((x) => x.id === s.featureId) as unknown as Record<string, unknown>;
  if (!f) return undefined;
  if (s.kind === 'sketchDimension') {
    const k = (f.constraints as { id: string; value?: unknown }[] | undefined)?.find(
      (c) => c.id === s.constraintId,
    );
    return typeof k?.value === 'string' ? k.value : undefined;
  }
  if (s.kind === 'feature') {
    // A chamfer's distance.
    const m = f.mode as { distance?: unknown } | undefined;
    return typeof m?.distance === 'string' ? m.distance : undefined;
  }
  if (s.kind === 'featureField') {
    let v: unknown = f;
    for (const key of s.path.split('/').filter(Boolean)) v = (v as Record<string, unknown>)?.[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

export interface Found {
  spec: DrawingDimSpec;
  /** The annotation that shows it on the right view; absent when nothing does. */
  annotationId?: string;
  how?: 'import' | 'tool';
  /** Why the tool could not make it. */
  note?: string;
}

/** The unsigned name a promoted expression stands for: `hole_x`, not `-hole_x` or `hole_x/2`. */
const isName = (expr: string | undefined, name: string) =>
  expr !== undefined && expr.replace(/\s/g, '').replace(/^[-+]/, '') === name;

/** Annotations placed on `viewId`, by id. */
async function onView(page: Page, viewId: string): Promise<Set<string>> {
  const pl = await drawing(page).placements();
  return new Set(pl.filter((p) => p.viewId === viewId).map((p) => p.annotationId));
}

/** Matches the imported annotations to the spec's dimensions by the expression they come from. */
export async function bindImported(
  page: Page,
  spec: PartSpec,
  views: Placed[],
): Promise<Map<string, string>> {
  const p = await part(page);
  const out = new Map<string, string>();
  for (const d of spec.drawing.dimensions) {
    const v = views.find((x) => x.spec.id === d.view) as Placed;
    const here = await onView(page, v.id);
    const a = (p.annotations ?? []).find((x) => here.has(x.id) && isName(exprOf(p, x), d.name));
    if (a) out.set(d.name, a.id);
  }
  return out;
}

/**
 * The edge the Dimension tool would pick for a drawn point `p` (sheet mm): a straight edge through
 * it that is vertical (`h`: measured along the horizontal) or horizontal (`v`), else a circle
 * whose centre it is (a circle seen face-on; `radius` narrows it to one of concentric circles).
 */
function edgeAt(edges: Edge[], p: V2, axis?: 'h' | 'v', radius?: number): Edge | undefined {
  const TOL = 0.4;
  let line: { e: Edge; d: number } | undefined;
  if (axis !== undefined)
    for (const e of edges) {
      if (e.kind !== 'line' || !e.a || !e.b) continue;
      const [ax, ay] = e.a;
      const [bx, by] = e.b;
      if (axis === 'h' ? Math.abs(ax - bx) > 0.01 : Math.abs(ay - by) > 0.01) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(
        0,
        Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)),
      );
      const d = Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
      if (d < TOL && (!line || d < line.d)) line = { e, d };
    }
  if (line) return line.e;
  let arc: { e: Edge; d: number } | undefined;
  for (const e of edges) {
    if (e.kind !== 'arc' || e.radius === undefined) continue;
    if (radius !== undefined && Math.abs(e.radius - radius) > 0.05) continue;
    // The hook gives a point on the arc and its radius: the centre is that far from it.
    const d = Math.abs(Math.hypot(p[0] - e.at[0], p[1] - e.at[1]) - e.radius);
    if (d < TOL && (!arc || d < arc.d)) arc = { e, d };
  }
  return arc?.e;
}

/** Makes `d` with the Dimension tool on its view. Returns the new annotation's id, or why not. */
export async function dimensionTool(
  page: Page,
  spec: PartSpec,
  v: Placed,
  d: DrawingDimSpec,
): Promise<{ id: string } | { note: string }> {
  if (d.kind !== 'linear' && d.kind !== 'diameter' && d.kind !== 'radius')
    return { note: `the Dimension tool has no ${d.kind} dimension` };

  /** The edges to pick, or why there are none, from the view's current exact output. */
  const find = async (): Promise<{ picks: Edge[]; state: DrawingState } | { note: string }> => {
    const state = await built(page);
    // Draft output is polylines: the exact edges are what the Dimension tool picks.
    if (state.quality !== 'exact' || state.refining) return { note: 'the view is not exact yet' };
    const edges = await drawing(page).edges(v.id);
    const sc = state.views.find((x) => x.id === v.id)?.scale ?? 1;
    const picks: Edge[] = [];
    if (d.kind === 'linear') {
      // The drawn horizontal may be Wren's vertical (a view turned on the sheet): follow the part axis.
      const measured = (d.axis === 'h' ? v.spec.axes[0] : v.spec.axes[1]).replace('-', '');
      const wren = WREN_AXES[v.spec.kind === 'section' ? 'front' : v.spec.orientation] as [
        WorldAxis,
        WorldAxis,
      ];
      const axis = wren[0].replace('-', '') === measured ? 'h' : 'v';
      for (const p of [d.from as V2, d.to as V2]) {
        const e = edgeAt(edges, sheetPoint(spec, v, state, p).at, axis);
        if (!e) return { note: `no edge or circle at ${p.join(', ')} in ${v.spec.caption}` };
        picks.push(e);
      }
    } else {
      const at = d.at as V2;
      const e = edgeAt(edges, sheetPoint(spec, v, state, at).at, undefined, (d.radius ?? 0) * sc);
      if (!e) return { note: `no circle at ${at.join(', ')} in ${v.spec.caption}` };
      picks.push(e);
    }
    return { picks, state };
  };
  // A new annotation rebuilds the view (draft, then exact): look until the exact edges are there.
  await drawing(page).exact();
  let found = await find();
  for (let i = 0; i < 10 && !('picks' in found); i++) {
    await page.waitForTimeout(300);
    found = await find();
  }
  if (!('picks' in found)) return found;
  const picks = found.picks;

  const before = new Set((await annotations(page)).map((a) => a.id));
  // The click can land on a dimension drawn earlier over the same spot: try other spots on the edges.
  const centre = d.kind === 'linear' ? null : sheetPoint(spec, v, found.state, d.at as V2).at;
  const spot = (e: Edge, attempt: number): V2 => {
    if (e.kind === 'line' && e.a && e.b) {
      const t = [0.5, 0.25, 0.75][attempt] as number;
      return [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t];
    }
    if (centre && e.radius !== undefined) {
      const th = Math.atan2(e.at[1] - centre[1], e.at[0] - centre[0]) + (attempt * Math.PI) / 2;
      return [centre[0] + e.radius * Math.cos(th), centre[1] + e.radius * Math.sin(th)];
    }
    return e.at;
  };
  let created = false;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    if ((await drawing(page).state()).tool !== 'dimension')
      await page.locator('[data-tool="dimension"]').click();
    for (const e of picks) await click(page, spot(e, attempt));
    created = await expect
      .poll(async () => (await annotations(page)).length, { timeout: 2500 })
      .toBe(before.size + 1)
      .then(
        () => true,
        () => false,
      );
    if (!created) await page.keyboard.press('Escape');
  }
  if (!created) {
    const toast = await page
      .getByTestId('drawing-toast')
      .innerText({ timeout: 500 })
      .catch(() => '');
    return {
      note: `the Dimension tool made nothing from ${picks.map((e) => e.name).join(' + ')}${toast ? ` (${toast})` : ''}`,
    };
  }
  const made = (await annotations(page)).find((a) => !before.has(a.id));
  await page.keyboard.press('Escape');
  return { id: (made as Annotation).id };
}

/** Wren's number formatting is checked on the sheet's own text: does `texts` show `value`? */
export const showsValue = (texts: string[], value: number): boolean => {
  const s = String(value);
  const re = new RegExp(`(^|[^\\d.])${s.replace('.', '\\.')}([^\\d.]|$)`);
  return texts.some((t) => re.test(t));
};
