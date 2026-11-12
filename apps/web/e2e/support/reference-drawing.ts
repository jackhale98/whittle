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
  type ImportRow,
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

/** A section's cut point as Wren's view-plane position (part mm in the parent's front view). */
export function viewPlane(view: DrawingViewSpec, p: V2): V2 {
  return toWren('front', toPart(view, p));
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
  // A turned base view (BaseView.rotation, degrees counter-clockwise) turns what it shows about
  // its centre; views projected from it are not turned by the spec (axes already say how).
  const rot = v.spec.kind === 'base' && v.spec.rotation ? (v.spec.rotation * Math.PI) / 180 : 0;
  const dx = q[0] - c[0];
  const dy = q[1] - c[1];
  const rx = dx * Math.cos(rot) - dy * Math.sin(rot);
  const ry = dx * Math.sin(rot) + dy * Math.cos(rot);
  const at: V2 = [s.position[0] + s.scale * rx, s.position[1] + s.scale * ry];
  return { x: at[0], y: at[1], at };
}

type Mod = 'Shift' | 'Alt';

const click = async (page: Page, p: V2, mod?: Mod) => {
  const at = await sheetToPage(page, p);
  if (mod) await page.keyboard.down(mod);
  await page.mouse.click(at.x, at.y);
  if (mod) await page.keyboard.up(mod);
};

/** Zooms the sheet in about a sheet point (wheel), so a pick near other geometry is unambiguous. */
const zoomAt = async (page: Page, p: V2) => {
  const at = await sheetToPage(page, p);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -900);
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

/** Turns a base view in the plane, as the spec says (degrees, counter-clockwise), in the inspector. */
async function rotateView(page: Page, id: string, degrees: number | undefined): Promise<void> {
  if (!degrees) return;
  await selectView(page, id);
  await panelTab(page, 'Inspector').click();
  const f = page.getByLabel('View rotation');
  await f.fill(String(degrees));
  await f.press('Enter');
  await expect
    .poll(async () => {
      const v = ((await drawings(page))[0] as Drawing).views.find((x) => x.id === id);
      return v?.kind === 'base' ? v.rotation : undefined;
    })
    .toBe(String(degrees));
  await built(page);
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
        await rotateView(page, first.id, v.rotation);
        continue;
      }
      await panelTab(page, 'Views').click();
      await page.locator(`[data-view="${v.orientation}"]`).click();
      const id = await newViewId(page, before);
      out.push({ spec: v, id });
      await rotateView(page, id, v.rotation);
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
      // The Section tool draws one straight cut line: the first and last point of the spec's cut
      // (more points are typed in below).
      const cut = v.section.cut;
      const a = sheetPoint(spec, parent, state, cut[0] as V2).at;
      const b = sheetPoint(spec, parent, state, cut.at(-1) as V2).at;
      const inside = (p: V2): V2 => [
        Math.min(Math.max(p[0], o.min[0] + 1), o.max[0] - 1),
        Math.min(Math.max(p[1], o.min[1] + 1), o.max[1] - 1),
      ];
      await page.locator('[data-tool="section"]').click();
      await drag(page, await sheetToPage(page, inside(a)), await sheetToPage(page, inside(b)));
      const id = await newViewId(page, before);
      out.push({ spec: v, id });
      // A stepped (offset) or L-shaped (half) cut: add vertices and type each of the spec's points
      // into the inspector's cut-line fields (view-plane mm).
      if (cut.length > 2) {
        await panelTab(page, 'Inspector').click();
        for (let i = 2; i < cut.length; i++) await page.getByTestId('cut-add').click();
        for (let i = 0; i < cut.length; i++) {
          const q = toWren('front', toPart(v, cut[i] as V2));
          for (const [axis, value] of [
            ['X', q[0]],
            ['Y', q[1]],
          ] as const) {
            const f = page.getByLabel(`Cut vertex ${i + 1} ${axis} (mm)`);
            await f.fill(String(value));
            await f.press('Enter');
          }
        }
        await expect
          .poll(async () => {
            const sec = ((await drawings(page))[0] as Drawing).views.find((x) => x.id === id);
            return sec?.kind === 'section' ? sec.cut.length : 0;
          })
          .toBe(cut.length);
      }
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
  // The views' display settings the spec's dimensions are measured with (tangent edges, hidden lines).
  for (const p of out) await applyDisplay(page, p);
  return out;
}

// ------------------------------------------------------------------------------------------
// Annotations: import, binding to the spec's dimensions, the Dimension tool
// ------------------------------------------------------------------------------------------

/** Runs Import model annotations with every candidate checked; returns what it placed and the plan. */
export async function importAll(page: Page): Promise<{ placed: number; plan: ImportRow[] }> {
  await panelTab(page, 'Import').click();
  await page.getByTestId('import-open').click();
  await page.getByRole('button', { name: 'Check all' }).click();
  await expect.poll(async () => (await drawing(page).importPlan()) !== null).toBe(true);
  const plan = (await drawing(page).importPlan()) ?? [];
  const place = page.getByTestId('import-place');
  const n = Number(/(\d+)/.exec(await place.innerText())?.[1] ?? 0);
  if (n > 0) {
    await place.click();
    await expect(page.getByTestId('drawing-toast')).toContainText('Placed');
  } else await page.getByRole('button', { name: 'Cancel' }).click();
  await built(page);
  return { placed: n, plan };
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
  return (
    edgeNear(edges, p, axis, radius, 0) ??
    // A corner the spec measures to may be chamfered or rounded off: the straight edge (or
    // outline) through it then stops a little short of it.
    (axis !== undefined ? edgeNear(edges, p, axis, undefined, SLACK) : undefined)
  );
}

/** How far short of a measured corner a straight edge may stop (sheet mm). */
const SLACK = 3.5;

function edgeNear(
  edges: Edge[],
  p: V2,
  axis: 'h' | 'v' | undefined,
  radius: number | undefined,
  slack: number,
): Edge | undefined {
  const TOL = 0.4;
  /** Off the line across it, and how far past its ends along it. */
  const offLine = (a: V2, b: V2): { across: number; past: number } => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const s = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l;
    return {
      across: Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l,
      past: Math.max(0, -s, s - l),
    };
  };
  if (slack > 0) {
    let best: { e: Edge; d: number } | undefined;
    for (const e of edges) {
      if (e.kind !== 'line' || !e.a || !e.b) continue;
      if (axis === 'h' ? Math.abs(e.a[0] - e.b[0]) > 0.01 : Math.abs(e.a[1] - e.b[1]) > 0.01)
        continue;
      const o = offLine(e.a, e.b);
      if (o.across < TOL && o.past <= slack && (!best || o.past < best.d)) best = { e, d: o.past };
    }
    return best?.e;
  }
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
  // A side of a curved face seen side-on (an outline, `face` set) through the point: a straight
  // outline along the axis, or a sphere's outline circle the point lies on.
  if (axis !== undefined) {
    let side: { e: Edge; d: number } | undefined;
    for (const e of edges) {
      if (!e.face) continue;
      let d = Number.POSITIVE_INFINITY;
      if (e.kind === 'line' && e.a && e.b) {
        const [ax, ay] = e.a;
        const [bx, by] = e.b;
        if (axis === 'h' ? Math.abs(ax - bx) > 0.01 : Math.abs(ay - by) > 0.01) continue;
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(
          0,
          Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)),
        );
        d = Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
      } else if (
        e.kind === 'arc' &&
        e.radius !== undefined &&
        e.start !== undefined &&
        e.end !== undefined
      ) {
        const mid = (e.start + e.end) / 2;
        const c: V2 = [e.at[0] - e.radius * Math.cos(mid), e.at[1] - e.radius * Math.sin(mid)];
        d = Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1]) - e.radius);
      }
      // An outline (face only) before a seam that also has its edge name: picking it picks the face.
      if (!e.name) d -= TOL;
      if (d < TOL && (!side || d < side.d)) side = { e, d };
    }
    if (side) return side.e;
  }
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

/** Compares persistent names: an edge's two faces are in no fixed order (`edge(a|b)`). */
function normName(n: string): string {
  if (!n.startsWith('edge(') || !n.endsWith(')')) return n;
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of n.slice(5, -1)) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === '|' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return `edge(${parts.sort().join('|')})`;
}

/** The persistent names a hook edge answers to: its edge, its face, its cut face or its construction ref. */
const namesOf = (e: Edge): string[] =>
  [e.name, e.cut, e.face, e.construction]
    .filter((x): x is string => x !== undefined && x !== '')
    .map(normName);

/** The document's name for a spec ref (`{step}` is the step's feature id). */
async function resolveRef(page: Page, spec: PartSpec, name: string): Promise<string> {
  const p = await part(page);
  const ids = new Map(spec.features.map((s, i) => [s.id, p.features[i]?.id as string]));
  return normName(
    name.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, id: string) => {
      const v = ids.get(id);
      if (v === undefined) throw new Error(`spec ref ${name}: no step ${id}`);
      return v;
    }),
  );
}

/** How far sheet point `p` is from an edge (sheet mm). */
function distTo(e: Edge, p: V2): number {
  if (e.kind === 'line' && e.a && e.b) {
    const dx = e.b[0] - e.a[0];
    const dy = e.b[1] - e.a[1];
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / (dx * dx + dy * dy || 1)),
    );
    return Math.hypot(p[0] - (e.a[0] + t * dx), p[1] - (e.a[1] + t * dy));
  }
  return Math.hypot(p[0] - e.at[0], p[1] - e.at[1]);
}

/** The centre of an arc edge (the hook gives a point on it and its sweep). */
function centreOf(e: Edge): V2 | undefined {
  if (e.kind !== 'arc' || e.radius === undefined || e.start === undefined || e.end === undefined)
    return undefined;
  // A construction circle's point is at angle 0; a model arc's is at the middle of its sweep.
  const mid = e.construction ? 0 : (e.start + e.end) / 2;
  return [e.at[0] - e.radius * Math.cos(mid), e.at[1] - e.radius * Math.sin(mid)];
}

/** Is sheet point `p` on arc edge `e` (on its circle, within its sweep)? */
function onArc(e: Edge, p: V2): boolean {
  const c = centreOf(e);
  if (!c || e.radius === undefined || e.start === undefined || e.end === undefined) return false;
  if (Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1]) - e.radius) > 0.05) return false;
  const full = Math.PI * 2;
  const rel = (((Math.atan2(p[1] - c[1], p[0] - c[0]) - e.start) % full) + full) % full;
  return rel <= e.end - e.start + 1e-6;
}

/** One click of a pick sequence. */
interface Step {
  e: Edge;
  mod?: Mod;
  /** Where to click, when not on the edge's own best spot. */
  at?: V2;
}

/** Applies the spec view's display settings (hidden lines, tangent edges) in the inspector. */
export async function applyDisplay(page: Page, v: Placed): Promise<void> {
  const disp = v.spec.display;
  if (!disp) return;
  await selectView(page, v.id);
  await panelTab(page, 'Inspector').click();
  if (disp.hidden) {
    await page
      .getByRole('radiogroup', { name: 'Lines shown' })
      .getByRole('radio', { name: 'With hidden' })
      .click();
  }
  if (disp.tangent) {
    await page
      .getByRole('radiogroup', { name: 'Tangent edges' })
      .getByRole('radio', { name: disp.tangent === 'thin' ? 'Thin' : 'Full' })
      .click();
  }
  await built(page);
  await drawing(page).exact();
  await built(page);
}

/**
 * Makes `d` with the Dimension tool (or the Angle tool) on its view. Returns the new annotation's
 * id, or why not.
 *
 * What to pick comes from the spec: when it has `refs`, each ref is the model entity (an edge, a
 * cut face of a section, a construction line or circle, a point) and is found by its persistent
 * name among the hook's edges; a ref with no edge to click (a face seen edge-on) and a spec
 * without refs use the drawn point (`from`, `to`, `at`) as before. Every pick is a real click.
 */
export async function dimensionTool(
  page: Page,
  spec: PartSpec,
  v: Placed,
  d: DrawingDimSpec,
): Promise<{ id: string } | { note: string }> {
  if (d.kind === 'chamfer') return chamferTool(page, spec, v, d);
  if (d.kind !== 'linear' && d.kind !== 'diameter' && d.kind !== 'radius' && d.kind !== 'angle')
    return { note: `the Dimension tool has no ${d.kind} dimension` };
  const toolName = d.kind === 'angle' ? 'angle' : 'dimension';
  const refNames = d.refs
    ? await Promise.all(d.refs.map((r) => resolveRef(page, spec, r.name)))
    : undefined;

  /** The sheet position of the spec's `from` / `to` / `at`, as the view is now. */
  const pointAt = (state: DrawingState, p: V2 | undefined): V2 | undefined =>
    p ? sheetPoint(spec, v, state, p).at : undefined;

  /** Where each outline pick was found (sheet mm): it is clicked there, on its own side. */
  const at = new Map<Edge, V2>();
  /** The clicks to make, or why there are none, from the view's current exact output. */
  const find = async (): Promise<{ seq: Step[]; state: DrawingState } | { note: string }> => {
    const state = await built(page);
    // Draft output is polylines: the exact edges are what the Dimension tool picks.
    if (state.quality !== 'exact' || state.refining) return { note: 'the view is not exact yet' };
    const all = await drawing(page).edges(v.id, { construction: true });
    // Hidden lines and construction items are only picked by name (a ref); a point never means them.
    const model = all.filter(
      (e) => e.role !== 'hidden' && e.role !== 'construction' && e.construction === undefined,
    );
    const sc = state.views.find((x) => x.id === v.id)?.scale ?? 1;
    at.clear();
    // The drawn horizontal may be Wren's vertical (a view turned on the sheet): follow the part axis.
    const axis = (() => {
      if (!d.axis) return undefined;
      const measured = (d.axis === 'h' ? v.spec.axes[0] : v.spec.axes[1]).replace('-', '');
      const wren = WREN_AXES[v.spec.kind === 'section' ? 'front' : v.spec.orientation] as [
        WorldAxis,
        WorldAxis,
      ];
      // A turned view is drawn as the spec shows it: its h is the sheet's horizontal.
      return v.spec.rotation ? d.axis : wren[0].replace('-', '') === measured ? 'h' : 'v';
    })();

    /** Entity `i` of the dimension: by its ref name, else by the drawn point `q` it is at. */
    const entity = (i: number, q: V2 | undefined): Edge | undefined => {
      const n = refNames?.[i];
      if (n !== undefined) {
        const named = all
          .filter((e) => namesOf(e).includes(n))
          // A cut edge of a section outranks a coincident model edge only by name: all match.
          .sort((x, y) => (q ? distTo(x, q) - distTo(y, q) : 0));
        if (named[0]) return named[0];
      }
      return q ? edgeAt(model, q, axis) : undefined;
    };
    const missing = (i: number, q: V2 | undefined) =>
      `no edge or circle for ${refNames?.[i] ?? ''} at ${q?.map((x) => x.toFixed(1)).join(', ')} in ${v.spec.caption}`;

    const seq: Step[] = [];
    if (d.kind === 'linear' || d.kind === 'angle') {
      const qs = [pointAt(state, d.from), pointAt(state, d.to)];
      const e0 = entity(0, qs[0]);
      const e1 = entity(1, qs[1]);
      if (!e0) return { note: missing(0, qs[0]) };
      if (!e1) return { note: missing(1, qs[1]) };
      if (d.kind === 'angle') {
        seq.push({ e: e0 }, { e: e1, ...(d.refs?.[1]?.fromNormal ? { mod: 'Shift' as Mod } : {}) });
      } else if (e0 === e1 && e0.kind === 'arc' && !e0.name) {
        // A sphere's outline, in pieces (a flat and a stem cut it): across it along the direction,
        // between its extremes: one piece, then Shift on the piece of the same face at the side.
        const c = centreOf(e0);
        const r = e0.radius;
        if (!c || r === undefined) return { note: `no centre for the outline of ${e0.face}` };
        const side: V2 = axis === 'v' ? [c[0], c[1] + r] : [c[0] + r, c[1]];
        const piece = model.find((x) => x !== e0 && x.face === e0.face && onArc(x, side));
        if (piece) seq.push({ e: e0 }, { e: piece, mod: 'Shift', at: side });
        else seq.push({ e: e0 }, { e: e0 });
      } else if (e0 === e1 && e0.kind === 'arc') {
        // A linear dimension across one circle, at its tangent extremes along the dimension's
        // direction: the circle, then the same circle again with Shift, at its side.
        const c = centreOf(e0);
        if (!c || e0.radius === undefined) return { note: `no centre for ${e0.name}` };
        const side: V2 = axis === 'v' ? [c[0], c[1] + e0.radius] : [c[0] + e0.radius, c[1]];
        seq.push({ e: e0 }, { e: e0, mod: 'Shift', at: side });
      } else {
        seq.push({ e: e0 }, { e: e1 });
      }
      for (const s of seq) at.set(s.e, s.at ?? s.e.at);
    } else {
      const c = pointAt(state, d.at);
      const named = refNames?.[0] !== undefined ? entity(0, c) : undefined;
      const e = named ?? (c ? edgeAt(model, c, undefined, (d.radius ?? 0) * sc) : undefined);
      if (e && e.kind === 'arc') {
        // The tool waits after a circle: the same circle again is its diameter (Alt: radius).
        seq.push({ e }, { e, ...(d.kind === 'radius' ? { mod: 'Alt' as Mod } : {}) });
      } else if (e) {
        // A curved outline that is not an arc (a fillet's torus): it waits like a circle; the same
        // outline again gives its radius (a torus is always sized by its radius).
        seq.push({ e }, { e, ...(d.kind === 'radius' ? { mod: 'Alt' as Mod } : {}) });
      } else {
        // A diameter seen side-on (a groove or bore along the view): its two straight sides,
        // `radius` either side of the centre, dimensioned across.
        if (!c) return { note: 'no anchor point' };
        const r = (d.radius ?? 0) * sc;
        const sides: Edge[] = [];
        for (const [dx, dy, ax] of [
          [r, 0, 'h'],
          [-r, 0, 'h'],
          [0, r, 'v'],
          [0, -r, 'v'],
        ] as const) {
          const s2 = edgeAt(model, [c[0] + dx, c[1] + dy], ax);
          if (s2 && !sides.includes(s2)) sides.push(s2);
        }
        const pair =
          sides.length >= 2 &&
          sides
            .flatMap((x, i) => sides.slice(i + 1).map((y) => [x, y] as const))
            .find(([x, y]) => {
              const dist = (q: Edge) =>
                q.a && q.b
                  ? Math.abs(q.a[0] - q.b[0]) < 0.01
                    ? q.a[0] - c[0]
                    : q.a[1] - c[1]
                  : Number.NaN;
              return Math.abs(dist(x) + dist(y)) < 0.4 && Math.abs(Math.abs(dist(x)) - r) < 0.4;
            });
        if (!pair)
          return {
            note: `no circle, nor two sides across, at ${d.at?.join(', ')} in ${v.spec.caption}`,
          };
        seq.push({ e: pair[0] }, { e: pair[1] });
        for (const s of seq) at.set(s.e, s.e.at);
      }
    }
    return { seq, state };
  };
  // A new annotation rebuilds the view (draft, then exact): look until the exact edges are there.
  await drawing(page).exact();
  let found = await find();
  for (let i = 0; i < 10 && !('seq' in found); i++) {
    await page.waitForTimeout(300);
    found = await find();
  }
  if (!('seq' in found)) return found;
  let seq = found.seq;
  // The edges with a spot to find (a click at a given point needs none).
  const picks = [...new Set(seq.filter((s) => !s.at).map((s) => s.e))];

  const before = new Set((await annotations(page)).map((a) => a.id));
  // A click on a dimension drawn earlier picks that dimension (annotations come first): click
  // each edge where it is farthest from every drawn annotation, trying the next best spot after.
  const centre = d.kind === 'linear' || d.kind === 'angle' ? null : pointAt(found.state, d.at);
  const drawn = await drawing(page).extents();
  const clearance = (q: V2): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const x of drawn) {
      for (const [a, b] of x.segments) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.max(
          0,
          Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
        );
        best = Math.min(best, Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy)));
      }
      for (const t of x.texts) {
        const ox = Math.max(t.min[0] - q[0], 0, q[0] - t.max[0]);
        const oy = Math.max(t.min[1] - q[1], 0, q[1] - t.max[1]);
        best = Math.min(best, Math.hypot(ox, oy));
      }
    }
    return best;
  };
  const along = (e: Edge): V2[] => {
    const ts = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88];
    if (e.kind === 'line' && e.a && e.b) {
      const [a, b] = [e.a, e.b];
      return ts.map((t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    if (
      e.kind === 'arc' &&
      e.radius !== undefined &&
      e.start !== undefined &&
      e.end !== undefined
    ) {
      // On the arc's own sweep (a quarter-circle fillet has no points a quarter turn away).
      const r = e.radius;
      const [s0, s1] = [e.start, e.end];
      const c = centreOf(e) as V2;
      const own = !e.name ? at.get(e) : undefined;
      const pts: V2[] = ts.map((t) => {
        const th = s0 + (s1 - s0) * t;
        return [c[0] + r * Math.cos(th), c[1] + r * Math.sin(th)];
      });
      return own ? [own, ...pts] : pts;
    }
    if (centre && e.radius !== undefined) {
      const r = e.radius;
      return [0, 1, 2, 3].map((k) => {
        const th = Math.atan2(e.at[1] - centre[1], e.at[0] - centre[0]) + (k * Math.PI) / 2;
        return [centre[0] + r * Math.cos(th), centre[1] + r * Math.sin(th)];
      });
    }
    return [e.at];
  };
  const keyOf = (e: Edge): string => e.construction ?? (e.name || e.cut || e.face || '');
  const picksIt = async (e: Edge, q: V2, tol: number): Promise<boolean> => {
    const h = (await drawing(page).hit(q, tol)) as {
      pick: { name: string; face?: string } | null;
    };
    if (!h.pick) return false;
    return e.name || e.construction || e.cut ? h.pick.name === keyOf(e) : h.pick.face === e.face;
  };
  const pickTol = () =>
    page.evaluate(() => {
      const g = document.querySelector('[data-testid="drawing-sheet-content"]');
      const m = /scale\(([-\d.e]+)\)/.exec(g?.getAttribute('transform') ?? '');
      // The viewer picks within 6 px (SheetViewer).
      return 6 / Number(m?.[1] ?? 3);
    });
  // The picking tool is on while the candidates are looked at: construction lines show then.
  const ensureTool = async () => {
    if ((await drawing(page).state()).tool !== toolName)
      await page.locator(`[data-tool="${toolName}"]`).click();
  };
  const spots = new Map<Edge, V2[]>();
  const rank = async (zoomed: boolean): Promise<boolean> => {
    spots.clear();
    const tol = await pickTol();
    let all = true;
    for (const e of picks) {
      const ranked = along(e)
        .map((q, i) => ({ q, c: Math.min(clearance(q), 1.5), i }))
        // The spec's own point on an outline circle, and the middle, unless something is drawn
        // there; else the clearest spot.
        .sort((x, y) => y.c - x.c || x.i - y.i)
        .map((x) => x.q);
      const good: V2[] = [];
      for (const q of ranked) if (await picksIt(e, q, tol)) good.push(q);
      if (!good.length) all = false;
      spots.set(e, good.length ? good : ranked);
    }
    return all || zoomed;
  };
  await ensureTool();
  if (!(await rank(false))) {
    // Something else is as near as the target at this scale: zoom in about the picks and look again.
    const mid: V2 = [
      picks.reduce((s, e) => s + e.at[0], 0) / picks.length,
      picks.reduce((s, e) => s + e.at[1], 0) / picks.length,
    ];
    await zoomAt(page, mid);
    await rank(true);
  }
  const spot = (e: Edge, attempt: number): V2 => {
    const l = spots.get(e) as V2[];
    return l[Math.min(attempt, l.length - 1)] as V2;
  };
  // The two sides of one face seen side-on are an outline and the seam on the silhouette. When an
  // annotation is drawn over the whole seam (a click there picks the annotation), the outline is
  // picked twice: two picks of a face's outline are its two sides too.
  const [p0, p1] = picks;
  if (picks.length === 2 && p0 && p1 && p0.face && p0.face === p1.face && (!p0.name || !p1.name)) {
    const outline = (p0.name ? p1 : p0) as Edge;
    const seam = (p0.name ? p0 : p1) as Edge;
    if (!(await picksIt(seam, spot(seam, 0), await pickTol()))) {
      seq = [{ e: outline }, { e: outline }];
      spots.set(outline, spots.get(outline) as V2[]);
    }
  }
  let created = false;
  const toasts: string[] = [];
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    await ensureTool();
    for (const [k, s] of seq.entries()) {
      await click(page, s.at ?? spot(s.e, attempt), s.mod);
      // A pick is handled asynchronously: the next one comes once the tool is waiting for it.
      if (k < seq.length - 1) {
        const waiting = await expect
          .poll(async () => (await drawing(page).state()).hint, { timeout: 2000 })
          .not.toBeNull()
          .then(
            () => true,
            () => false,
          );
        // The pick did not register (the view was rebuilding under the click): start again.
        if (!waiting) break;
      }
    }
    const said = await page
      .getByTestId('drawing-toast')
      .innerText({ timeout: 300 })
      .catch(() => '');
    if (said) toasts.push(said);
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
      note: `the ${toolName} tool made nothing from ${seq.map((s) => s.e.construction || s.e.name || s.e.cut || `outline of ${s.e.face}`).join(' + ')}${toast || toasts.length ? ` (${[...new Set([...toasts, toast].filter(Boolean))].join('; ')})` : ''}`,
    };
  }
  const made = (await annotations(page)).find((a) => !before.has(a.id));
  // A linear dimension across a round part: the tool made its diameter, which is still selected.
  if (d.kind === 'linear' && made?.kind === 'diameter') await formLinearAcross(page, d, made.id);
  await page.keyboard.press('Escape');
  return { id: (made as Annotation).id };
}

/** The inspector's "Dimension form" of the selected diameter: linear across, along the spec's direction. */
async function formLinearAcross(page: Page, d: DrawingDimSpec, id: string): Promise<void> {
  await panelTab(page, 'Inspector').click();
  // The spec's drawn horizontal is the sheet's (a turned view is drawn as the spec shows it).
  const label = d.axis === 'v' ? 'Linear across, vertical' : 'Linear across, horizontal';
  await page
    .getByRole('radiogroup', { name: 'Dimension form' })
    .getByRole('radio', { name: label })
    .click();
  await expect
    .poll(async () => (await annotations(page)).find((x) => x.id === id)?.kind)
    .toBe('linear');
  await built(page);
}

/**
 * A spec dimension that is linear across a round part (a shaft's or a ball's diameter, dimensioned
 * as a distance between its sides) is made as a diameter by the tool or by Import; the inspector's
 * "Dimension form" turns it into a linear dimension across. For an annotation Import made: selects
 * it first (the tool does this itself, while the new dimension is still selected). Does nothing
 * when the annotation is not a diameter.
 */
export async function asLinearAcross(page: Page, d: DrawingDimSpec, id: string): Promise<void> {
  const a = (await annotations(page)).find((x) => x.id === id);
  if (a?.kind !== 'diameter' || d.kind !== 'linear') return;
  const pl = (await drawing(page).placements()).find((p) => p.annotationId === id);
  if (!pl?.box) throw new Error(`${d.name}: no placement to select`);
  await page.keyboard.press('Escape');
  await page.locator('[data-tool="select"]').click();
  // Click the label (its centre, then the text point); the placement is then selected.
  const centre: V2 = [(pl.box.min[0] + pl.box.max[0]) / 2, (pl.box.min[1] + pl.box.max[1]) / 2];
  for (const at of [centre, pl.text ?? centre]) {
    await click(page, at);
    const ok = await expect
      .poll(async () => (await drawing(page).state()).selected?.id, { timeout: 1500 })
      .toBe(pl.id)
      .then(
        () => true,
        () => false,
      );
    if (ok) break;
  }
  await formLinearAcross(page, d, id);
}

/**
 * Makes a chamfer callout with the Chamfer tool: picks an edge of the chamfer feature whose
 * distance is the spec's dimension, near the spec's anchor on the view.
 */
async function chamferTool(
  page: Page,
  spec: PartSpec,
  v: Placed,
  d: DrawingDimSpec,
): Promise<{ id: string } | { note: string }> {
  const p = await part(page);
  const f = p.features.find(
    (x) =>
      x.type === 'chamfer' &&
      'distance' in x.mode &&
      typeof x.mode.distance === 'string' &&
      isName(x.mode.distance, d.name),
  );
  if (!f) return { note: `no chamfer feature with distance ${d.name}` };
  await drawing(page).exact();
  const state = await built(page);
  const sc = state.views.find((x) => x.id === v.id)?.scale ?? 1;
  const at = sheetPoint(spec, v, state, d.at as V2).at;
  const reach = ((d.radius ?? 0) + 1) * sc;
  const near = (await drawing(page).edges(v.id))
    .filter((e) => e.kind === 'line' && e.name.includes(`F${f.id}:chamfer(`))
    .map((e) => ({ e, d: Math.hypot(e.at[0] - at[0], e.at[1] - at[1]) }))
    .filter((x) => x.d <= reach)
    .sort((x, y) => x.d - y.d)[0]?.e;
  if (!near)
    return { note: `no edge of the chamfer near ${(d.at as V2).join(', ')} in ${v.spec.caption}` };
  const before = new Set((await annotations(page)).map((a) => a.id));
  await page.locator('[data-tool="chamfer"]').click();
  await click(page, near.at);
  const created = await expect
    .poll(async () => (await annotations(page)).length, { timeout: 2500 })
    .toBe(before.size + 1)
    .then(
      () => true,
      () => false,
    );
  const toast = created
    ? ''
    : await page
        .getByTestId('drawing-toast')
        .innerText({ timeout: 500 })
        .catch(() => '');
  await page.keyboard.press('Escape');
  if (!created)
    return { note: `the Chamfer tool made nothing from ${near.name}${toast ? ` (${toast})` : ''}` };
  return { id: ((await annotations(page)).find((a) => !before.has(a.id)) as Annotation).id };
}

/** Wren's number formatting is checked on the sheet's own text: does `texts` show `value`? */
export const showsValue = (texts: string[], value: number): boolean => {
  const s = String(value);
  const re = new RegExp(`(^|[^\\d.])${s.replace('.', '\\.')}([^\\d.]|$)`);
  return texts.some((t) => re.test(t));
};
