/**
 * Drives the Wren UI from a reference part's spec steps (packages/test-fixtures/reference-parts,
 * README "The feature-list (step) format, for UI scripts"). Everything goes through the UI a person
 * uses: the command bar shortcuts, viewport clicks at the steps' `at` world points, the sketch
 * tools and the Dimension tool with typed expressions, the inspector's inline fields, the
 * reference chips and the Params table. No document is injected; the hooks are only read.
 *
 * Camera framing uses the viewport's `zoomTo` (the same call as double-tap "zoom to it") and the
 * standard-view keys, so the point to click is on screen and not hidden behind other faces.
 *
 * Sketches: every op's geometry is drawn first, uniformly scaled by 4 % about the sketch origin
 * (zero coordinates stay on the axes and snap there; parallelism, alignment and concentricity are
 * kept; the solver then pulls the shape onto the typed dimensions). Then each dimension the spec
 * names is added with the Dimension tool. A dimension the drawn constraints already imply (the
 * line tool infers horizontal / vertical, points snap to the axes) leaves the degrees of freedom
 * unchanged; it is removed again, as a person removes a redundant dimension, and the sketch must
 * end fully defined.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { Feature, SketchEntity, SketchFeature } from '@wren-cad/contracts';
import { app, cameraStill } from '../helpers';

export type V3 = [number, number, number];
type V2 = [number, number];

export interface PickSpec {
  pick: 'face' | 'edge' | 'vertex' | 'region' | 'body' | 'plane' | 'axis' | 'point';
  name?: string;
  sketch?: string;
  curves?: string[];
  inner?: string[][];
  at?: V3;
}

type Op =
  | { op: 'rect'; id: string; x: string; y: string; w: string; h: string }
  | { op: 'circle'; id: string; cx: string; cy: string; d: string }
  | { op: 'point'; id: string; x: string; y: string; dims?: 'xy' | 'x' | 'y' | 'none' }
  | { op: 'line'; id: string; a: string; b: string }
  | { op: 'arc'; id: string; c: string; a: string; b: string; radius?: string }
  | { op: 'polygon'; id: string; pts: [string, string][] }
  | { op: 'convert'; id: string; source: PickSpec; a: V2; b: V2 }
  | { op: 'offsetRect'; id: string; sources: string[]; distance: string; bounds: number[] };

export interface StepSpec {
  tool: string;
  id: string;
  say: string;
  on?: PickSpec;
  ops?: Op[];
  [k: string]: unknown;
}

export interface Expected {
  volume_mm3: number;
  mass_g: number;
}

export interface PartSpec {
  id: string;
  no: number;
  title: string;
  material: { libraryId: string; density_g_cm3: number };
  dimensions: Record<string, { value: number; unit: string }>;
  features: StepSpec[];
  expected: Expected;
  stages: { name: string; set: Record<string, number>; expected: Expected }[];
}

const SPEC_DIR = join(import.meta.dirname, '../../../../packages/test-fixtures/reference-parts');

export function loadSpec(id: string): PartSpec {
  return JSON.parse(readFileSync(join(SPEC_DIR, `${id}.spec.json`), 'utf8')) as PartSpec;
}

/** Drawing scale about the sketch origin (see the file comment). */
const S = 1.04;

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

type W = {
  __wrenViewport: {
    worldToScreen(p: V3): { x: number; y: number; visible: boolean };
    zoomTo(p: V3, r: number, animate?: boolean): void;
    whenPickReady(): Promise<void>;
    pick(
      x: number,
      y: number,
      o: { kinds: string[]; tolerancePx?: number; all?: boolean },
    ): {
      bodyId: string;
      kind: string;
      index: number;
      entity?: string;
      point: V3;
      distancePx: number;
    }[];
  };
};

export class PartDriver {
  readonly a;
  /** Step id → feature id. */
  readonly fid = new Map<string, string>();
  /** Sketch step id → (spec entity id → UI entity id). */
  readonly ents = new Map<string, Map<string, string>>();
  readonly notes: string[] = [];
  private dims: Record<string, number>;
  private canvas: { x: number; y: number; width: number; height: number } | null = null;

  constructor(
    readonly page: Page,
    readonly spec: PartSpec,
  ) {
    this.a = app(page);
    this.dims = Object.fromEntries(Object.entries(spec.dimensions).map(([k, v]) => [k, v.value]));
  }

  log(s: string): void {
    this.notes.push(s);
    console.log(`[${this.spec.id}] ${s}`);
  }

  // ------------------------------------------------------------------ expressions

  /** Value of a spec expression at the baseline (mm, or degrees for `deg`). */
  value(expr: string): number {
    const e = expr.replace(/\bdeg\b/g, '').replace(/\bmm\b/g, '');
    const names = Object.keys(this.dims);
    const f = new Function(...names, `return (${e});`) as (...a: number[]) => number;
    return f(...names.map((n) => this.dims[n] as number));
  }

  /** The expression a person types for an unsigned distance (dimensions are positive). */
  magnitude(expr: string): string {
    const e = expr.trim();
    if (this.value(e) >= 0) return e;
    if (/^-[A-Za-z_][\w]*(\s*\/\s*[\w.]+)?$/.test(e) || /^-\([^()]*\)(\s*\/\s*[\w.]+)?$/.test(e))
      return e.slice(1);
    return `-(${e})`;
  }

  // ------------------------------------------------------------------ page / viewport

  private async box() {
    this.canvas ??= await this.page.getByTestId('viewport-canvas').boundingBox();
    if (!this.canvas) throw new Error('no canvas');
    return this.canvas;
  }

  /** Page point of a world point, and whether it is on the canvas. */
  async screen(p: V3): Promise<{ x: number; y: number; ok: boolean }> {
    const b = await this.box();
    const s = await this.page.evaluate(
      (q) => (window as unknown as W).__wrenViewport.worldToScreen(q),
      p,
    );
    const x = b.x + s.x;
    const y = b.y + s.y;
    const ok = s.visible && s.x > 8 && s.y > 8 && s.x < b.width - 8 && s.y < b.height - 8;
    return { x, y, ok };
  }

  /** Viewport hits at a page point (the viewport's own picking, read only). */
  async hits(pt: { x: number; y: number }, kinds: string[], tolerancePx = 8) {
    const b = await this.box();
    await this.page.evaluate(() => (window as unknown as W).__wrenViewport.whenPickReady());
    return this.page.evaluate(
      ({ x, y, kinds, tolerancePx }) => {
        const v = (window as unknown as W).__wrenViewport;
        const hits = v.pick(x, y, { kinds, tolerancePx, all: true });
        // As the workbench's `pickAt`: stacked regions, the one nearest the camera first.
        const cam = (v as unknown as { getCameraState(): { position: number[] } }).getCameraState()
          .position;
        const d = (h: (typeof hits)[number]) =>
          Math.hypot(...h.point.map((c, k) => c - (cam[k] as number)));
        const regions = hits.filter((h) => h.kind === 'region').sort((p, q) => d(p) - d(q));
        return [...hits.filter((h) => h.kind !== 'region'), ...regions];
      },
      { x: pt.x - b.x, y: pt.y - b.y, kinds, tolerancePx },
    );
  }

  /** The canvas itself is the element under the point (no label, panel or chip on top). */
  async onCanvas(pt: { x: number; y: number }): Promise<boolean> {
    return this.page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.getAttribute('data-testid') === 'viewport-canvas',
      pt,
    );
  }

  async click(pt: { x: number; y: number }, shift = false): Promise<void> {
    if (shift) await this.page.keyboard.down('Shift');
    await this.page.mouse.move(pt.x, pt.y, { steps: 2 });
    await this.page.mouse.down();
    await this.page.mouse.up();
    if (shift) await this.page.keyboard.up('Shift');
  }

  async zoomTo(p: V3, radius: number): Promise<void> {
    await this.page.evaluate(
      ([q, r]) => (window as unknown as W).__wrenViewport.zoomTo(q as V3, r as number, false),
      [p, radius] as const,
    );
    await cameraStill(this.page);
  }

  /** Standard view (PLAN 9.4 keys), with focus out of any field. */
  async view(key: string): Promise<void> {
    await this.page.locator('body').click({ position: { x: 2, y: 2 } });
    await this.page.keyboard.press(key);
    await cameraStill(this.page);
  }

  /** Model size for framing (mm): the part's bounding box diagonal, or 100. */
  async diag(): Promise<number> {
    const r = await this.a.regen();
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (const b of r?.bodies ?? []) {
      lo = lo.map((v, k) => Math.min(v, b.bbox.min[k] as number));
      hi = hi.map((v, k) => Math.max(v, b.bbox.max[k] as number));
    }
    const d = Math.hypot(...hi.map((v, k) => v - (lo[k] as number)));
    return Number.isFinite(d) && d > 0 ? d : 100;
  }

  /**
   * Finds a view where the entity at `at` is what a click there picks (a face in front, an edge
   * or point within reach), and returns the page point to click. `accept` checks the hit.
   */
  async aim(
    at: V3,
    kinds: string[],
    accept: (h: Awaited<ReturnType<PartDriver['hits']>>[number]) => boolean = () => true,
    want?: string,
    views: (string | V3)[] = [...STANDARD_VIEWS, ...TILTED_VIEWS],
  ): Promise<{ x: number; y: number }> {
    const d = await this.diag();
    const seen: string[] = [];
    // Like a person nudging the pointer: the point itself, then a few px around it, until the
    // pick is unambiguous (no "Which one?") and, when the spec names it, is that entity.
    const nudges: [number, number][] = [[0, 0]];
    for (const r of [4, 7, 10])
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [0.7, 0.7],
        [-0.7, 0.7],
        [0.7, -0.7],
        [-0.7, -0.7],
      ] as const)
        nudges.push([dx * r, dy * r]);
    const box = await this.box();
    for (const v of views) {
      // A standard view key, or an orbit to look along a direction (into a bore, under a lip).
      if (typeof v === 'string') await this.view(v);
      else await this.lookFrom(at, v);
      await this.zoomTo(at, d * 0.35);
      const s = await this.screen(at);
      if (!s.ok || !(await this.onCanvas(s))) {
        seen.push(`${v}: off canvas or covered`);
        continue;
      }
      await this.page.evaluate(() => (window as unknown as W).__wrenViewport.whenPickReady());
      for (const [dx, dy] of nudges) {
        const q = { x: s.x + dx, y: s.y + dy };
        // What a click there resolves to, asked of the app itself (pickAt + resolvePick).
        const r = await this.page.evaluate(
          ({ x, y }) =>
            (
              window as unknown as { __wrenApp: { resolveAt(x: number, y: number): Resolved } }
            ).__wrenApp.resolveAt(x, y),
          { x: q.x - box.x, y: q.y - box.y },
        );
        const best = r.best;
        if (!best || !kinds.includes(best.kind) || !accept(best)) {
          if (dx === 0 && dy === 0) seen.push(`${v}: ${best ? `${best.kind} first` : 'no hit'}`);
          continue;
        }
        if (r.ties > 1) continue;
        const near = Math.hypot(...best.point.map((c, k) => c - (at[k] as number)));
        if (near > d * 0.02 + 0.1) continue;
        if (want) {
          const got = await this.page.evaluate(
            ({ b, k, i }) =>
              (
                window as unknown as {
                  __wrenApp: { hitName(b: string, k: string, i: number): string | null };
                }
              ).__wrenApp.hitName(b, k, i),
            { b: best.bodyId, k: best.kind, i: best.index },
          );
          if (got !== want) {
            if (dx === 0 && dy === 0) seen.push(`${v}: ${best.kind} ${got}`);
            continue;
          }
        }
        return q;
      }
    }
    await this.page.screenshot({ path: `test-results/debug-aim-${at.join('_')}.png` });
    throw new Error(`no view shows the ${kinds.join('/')} at ${at.join(', ')}: ${seen.join('; ')}`);
  }

  /** Orbits so the camera looks at `at` from direction `dir` (as a person orbits to see it). */
  async lookFrom(at: V3, dir: V3): Promise<void> {
    const n = Math.hypot(...dir);
    const z = dir.map((c) => c / n) as V3;
    const ref: V3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const xr: V3 = [
      ref[1] * z[2] - ref[2] * z[1],
      ref[2] * z[0] - ref[0] * z[2],
      ref[0] * z[1] - ref[1] * z[0],
    ];
    const xn = Math.hypot(...xr);
    const x = xr.map((c) => c / xn) as V3;
    const y: V3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    await this.page.evaluate(
      (f) =>
        (
          window as unknown as {
            __wrenViewport: { lookAtPlane(f: unknown, animate: boolean): void };
          }
        ).__wrenViewport.lookAtPlane(f, false),
      { origin: at, x, y, z },
    );
    await cameraStill(this.page);
  }

  // ------------------------------------------------------------------ names

  /** The spec's persistent name with step ids and sketch entity ids replaced by the UI's. */
  translate(name: string): string {
    return name
      .replace(/S\{(\w+)\}:(e|p)\(([^)]+)\)/g, (_m, sk: string, t: string, e: string) => {
        const id = this.ents.get(sk)?.get(e) ?? e;
        return `S${this.fid.get(sk) ?? sk}:${t}(${id})`;
      })
      .replace(/\{(\w+)\}/g, (_m, s: string) => this.fid.get(s) ?? s);
  }

  /** A region's name from its sketch and curves (sorted ids, as naming.ts). */
  regionName(p: PickSpec): string {
    const map = this.ents.get(p.sketch ?? '');
    const ids = (p.curves ?? []).map((c) => map?.get(c) ?? c).sort();
    const inner = (p.inner ?? []).map(
      (l) =>
        `|${l
          .map((c) => map?.get(c) ?? c)
          .sort()
          .join(',')}`,
    );
    return `S${this.fid.get(p.sketch ?? '')}:region(${ids.join(',')}${inner.sort().join('')})`;
  }

  async features(): Promise<Feature[]> {
    return (await this.a.doc()).parts[0]?.features ?? [];
  }

  async feature(id: string): Promise<Feature> {
    const f = (await this.features()).find((x) => x.id === id);
    if (!f) throw new Error(`no feature ${id}`);
    return f;
  }

  // ------------------------------------------------------------------ setup

  async params(): Promise<void> {
    const page = this.page;
    await page.getByRole('tab', { name: 'Params' }).click();
    for (const [name, d] of Object.entries(this.spec.dimensions)) {
      await page.getByRole('button', { name: 'Add parameter' }).click();
      const n = page.getByRole('textbox', { name: /^Name of parameter/ }).last();
      await n.fill(name);
      await n.press('Enter');
      const e = page.getByRole('textbox', { name: `Expression for ${name}` });
      await e.fill(d.unit ? `${d.value} ${d.unit}` : `${d.value}`);
      await e.press('Enter');
    }
    await expect(page.getByTestId('param-value')).toHaveCount(
      Object.keys(this.spec.dimensions).length,
    );
    await page.getByRole('tab', { name: 'Features' }).click();
  }

  async material(): Promise<void> {
    const page = this.page;
    const inspector = page.getByTestId('part-inspector');
    const option = inspector.locator(`[data-material="${this.spec.material.libraryId}"]`);
    if (!(await option.isVisible())) {
      await inspector
        .getByRole('button', { name: /material/i })
        .first()
        .click();
    }
    await option.click();
    await expect
      .poll(async () => (await this.a.doc()).parts[0]?.material?.libraryId)
      .toBe(this.spec.material.libraryId);
  }

  /** Mass (g) from the part inspector's mass properties, and the exact volume from the regen. */
  async massReadout(): Promise<{ mass: number; volume: number }> {
    await this.a.idle();
    const page = this.page;
    await page.getByRole('tab', { name: 'Features' }).click();
    if (await page.getByRole('button', { name: 'Done' }).isVisible())
      await page.getByRole('button', { name: 'Done' }).click();
    await page.keyboard.press('Escape');
    const cell = page.getByTestId('mass-readout').locator('[data-prop="mass"]');
    await expect(cell).toBeVisible();
    const text = (await cell.textContent()) ?? '';
    const m = /([\d,.]+)\s*(kg|g)/.exec(text.replace('−', '-'));
    if (!m) throw new Error(`mass readout "${text}"`);
    const mass = Number((m[1] as string).replace(/,/g, '')) * (m[2] === 'kg' ? 1000 : 1);
    const r = await this.a.regen();
    const volume = (r?.bodies ?? []).reduce((s, b) => s + (b.volume ?? 0), 0);
    return { mass, volume };
  }

  // ------------------------------------------------------------------ steps

  async build(only?: (s: StepSpec) => boolean): Promise<void> {
    for (const step of this.spec.features) {
      if (only && !only(step)) continue;
      this.log(`${step.tool} ${step.id}: ${step.say}`);
      const before = new Set((await this.features()).map((f) => f.id));
      await this.step(step);
      await this.a.idle();
      const after = await this.features();
      const made = after.filter((f) => !before.has(f.id));
      expect(made.length, `${step.id} adds one feature`).toBe(1);
      const f = made[0] as Feature;
      this.fid.set(step.id, f.id);
      expect(f.type).toBe(step.tool);
      await this.closeInspector();
      const status = (await this.a.regen())?.features.find((s) => s.id === f.id);
      expect(status?.state, `${step.id}: ${status?.error ?? ''}`).toBe('ok');
    }
  }

  private async closeInspector(): Promise<void> {
    const done = this.page.getByTestId('feature-inspector').getByRole('button', { name: 'Done' });
    if (await done.isVisible()) await done.click();
    await this.a.idle();
  }

  private async step(s: StepSpec): Promise<void> {
    switch (s.tool) {
      case 'sketch':
        return this.sketch(s);
      case 'extrude':
        return this.extrude(s);
      case 'revolve':
        return this.revolve(s);
      case 'fillet':
      case 'chamfer':
        return this.blend(s);
      case 'plane':
        return this.plane(s);
      case 'axis':
        return this.axis(s);
      case 'point':
        return this.point(s);
      case 'sweep':
        return this.sweep(s);
      case 'loft':
        return this.loft(s);
      case 'shell':
        return this.shell(s);
      case 'draft':
        return this.draft(s);
      case 'hole':
        return this.hole(s);
      case 'linearPattern':
      case 'circularPattern':
      case 'mirror':
        return this.copy(s);
      case 'boolean':
        return this.boolean(s);
      case 'pushPull':
        return this.pushPull(s);
      default:
        throw new Error(`no UI path for ${s.tool}`);
    }
  }

  private get inspector() {
    return this.page.getByTestId('feature-inspector');
  }

  /** Types an expression into an inspector field by its label. */
  async field(label: string | RegExp, expr: string): Promise<void> {
    const box = this.inspector.getByRole('textbox', {
      name: label,
      exact: typeof label === 'string',
    });
    await box.fill(expr);
    await box.press('Enter');
    await this.a.idle();
  }

  async radio(group: string, option: string): Promise<void> {
    const g = this.inspector.getByRole('radiogroup', { name: group });
    const r = g.getByRole('radio', { name: option, exact: true });
    if ((await r.getAttribute('aria-checked')) !== 'true') await r.click();
    await this.a.idle();
  }

  async toggle(label: string, on: boolean): Promise<void> {
    const sw = this.inspector.getByRole('switch', { name: label });
    if (((await sw.getAttribute('aria-checked')) === 'true') !== on) await sw.click();
    await this.a.idle();
  }

  /** The feature the inspector is editing. */
  private async editing(): Promise<Feature> {
    const id = (await this.a.ui()).featureId;
    if (!id) throw new Error('no feature in the inspector');
    return this.feature(id);
  }

  /** The inspector field being picked must be `path` (the tool's pick sequence). */
  private async expectPicking(path: string): Promise<void> {
    await expect.poll(async () => (await this.a.ui()).picking?.path).toBe(path);
  }

  /** Starts picking an inspector field by its label (the field's Pick / Add / Change button). */
  private async pickField(label: string, path: string): Promise<void> {
    if ((await this.a.ui()).picking?.path === path) return;
    const list = this.inspector.getByRole('list', { name: label, exact: true });
    await list.getByRole('button').last().click();
    await this.expectPicking(path);
  }

  /** A reference chip (origin plane or axis, a plane / axis / point feature). */
  private async chip(name: string): Promise<void> {
    await this.page.getByTestId('reference-chooser').locator(`[data-ref="${name}"]`).click();
    await this.a.idle();
  }

  private async expectRef(path: string, pick: PickSpec): Promise<void> {
    const f = await this.editing();
    const want = pick.curves ? this.regionName(pick) : this.translate(pick.name ?? '');
    let cur: unknown = f;
    for (const k of path.split('/').slice(1)) cur = (cur as Record<string, unknown>)?.[k];
    const names = (Array.isArray(cur) ? cur : [cur]).map((r) => (r as { name?: string })?.name);
    expect.soft(names, `${f.name} ${path} holds ${want}`).toContain(want);
  }

  /**
   * One pick for the field being picked (or the act-first prompt): a reference chip for origin
   * geometry and reference features, else a viewport click at `at`.
   */
  async pickInto(path: string, p: PickSpec): Promise<void> {
    const name = p.name ? this.translate(p.name) : '';
    if (/^origin:/.test(name) || /^F\w+:(plane|axis|point)$/.test(name)) {
      await this.chip(name);
    } else {
      if (!p.at) throw new Error(`pick ${p.pick} has no 'at'`);
      const pt = await this.aimPick(p);
      await this.click(pt);
      await this.a.idle();
    }
    if (path) await this.expectRef(path, p);
  }

  /**
   * Aims at a pick: model faces and edges by their persistent name, sketch geometry (regions,
   * curves, points) on the step's own sketch.
   */
  aimPick(p: PickSpec): Promise<{ x: number; y: number }> {
    if (!p.at) throw new Error(`pick ${p.pick} has no 'at'`);
    const kinds = KINDS[p.pick] ?? ['face'];
    const name = p.name ? this.translate(p.name) : '';
    const sk = p.sketch ? this.fid.get(p.sketch) : /^S(\w+):/.exec(name)?.[1];
    if (sk) return this.aim(p.at, kinds, (h) => h.bodyId === sk);
    const model = name && /^(F|edge\()/.test(name) ? name : undefined;
    return this.aim(p.at, kinds, () => true, model);
  }

  /** Select first, act second: select the picks (Shift adds), waiting for each reference. */
  async select(picks: PickSpec[]): Promise<void> {
    await this.page.keyboard.press('Escape');
    for (const [i, p] of picks.entries()) {
      if (!p.at) throw new Error('select needs at');
      const pt = await this.aimPick(p);
      await this.click(pt, i > 0);
      await expect.poll(async () => (await this.a.ui()).selection.length).toBe(i + 1);
    }
    await this.a.idle();
  }

  // ------------------------------------------------------------------ features

  private async extrude(s: StepSpec): Promise<void> {
    const profile = s.profile as PickSpec[];
    await this.view('0');
    await this.page.keyboard.press(s.op === 'cut' ? 'Shift+E' : 'e');
    await expect(this.page.getByTestId('prompt')).toBeVisible();
    for (const [i, p] of profile.entries()) await this.pickInto(i === 0 ? '' : '/profile', p);
    await this.expectRef('/profile', profile[0] as PickSpec);
    await this.radio('Direction', cap(s.direction as string));
    const end = s.end as { kind: string; depth?: string };
    await this.radio('End condition', END[end.kind] as string);
    if (end.kind === 'blind') await this.field('Depth', end.depth as string);
    await this.radio('Operation', cap(s.op as string));
  }

  private async revolve(s: StepSpec): Promise<void> {
    const profile = s.profile as PickSpec[];
    await this.view('0');
    await this.page.keyboard.press(s.op === 'cut' ? 'Shift+R' : 'r');
    for (const [i, p] of profile.entries()) await this.pickInto(i === 0 ? '' : '/profile', p);
    const axis = s.axis as PickSpec;
    const f = await this.editing();
    if (f.type === 'revolve' && f.axis.name !== this.translate(axis.name ?? '')) {
      await this.pickField('Axis', '/axis');
      await this.pickInto('/axis', axis);
    }
    await this.expectRef('/axis', axis);
    await this.field('Angle', s.angle as string);
    await this.radio('Operation', cap(s.op as string));
  }

  private async blend(s: StepSpec): Promise<void> {
    await this.select(s.edges as PickSpec[]);
    await this.page.keyboard.press(s.tool === 'fillet' ? 'f' : 'c');
    await expect(this.inspector).toBeVisible();
    for (const p of s.edges as PickSpec[]) await this.expectRef('/edges', p);
    if (s.tool === 'fillet') await this.field('Radius', s.radius as string);
    else await this.field('Distance', (s.mode as { distance: string }).distance);
    await this.toggle('Propagate along tangent edges', s.propagate !== false);
  }

  private async plane(s: StepSpec): Promise<void> {
    const def = s.definition as { kind: string; from: PickSpec; distance: string };
    if (def.kind !== 'offset') throw new Error(`plane ${def.kind} not in the parts`);
    await this.page.keyboard.press('g');
    await this.expectPicking('/definition/from');
    await this.pickInto('/definition/from', def.from);
    await this.field('Distance', def.distance);
  }

  private async axis(s: StepSpec): Promise<void> {
    const def = s.definition as { kind: string; face?: PickSpec; edge?: PickSpec };
    await this.page.keyboard.press('Shift+G');
    await expect(this.inspector).toBeVisible();
    if (def.kind === 'cylinder') {
      await this.inspector.getByRole('combobox', { name: 'Definition' }).selectOption('cylinder');
      await this.a.idle();
      await this.pickField('Cylindrical face', '/definition/face');
      await this.pickInto('/definition/face', def.face as PickSpec);
    } else if (def.kind === 'edge') {
      await this.expectPicking('/definition/edge');
      await this.pickInto('/definition/edge', def.edge as PickSpec);
    } else throw new Error(`axis ${def.kind} not in the parts`);
  }

  private async point(s: StepSpec): Promise<void> {
    const def = s.definition as { kind: string; x: string; y: string; z: string };
    if (def.kind !== 'coordinates') throw new Error(`point ${def.kind} not in the parts`);
    await this.page.keyboard.press('Shift+P');
    await expect(this.inspector).toBeVisible();
    await this.field('X', def.x);
    await this.field('Y', def.y);
    await this.field('Z', def.z);
  }

  private async sweep(s: StepSpec): Promise<void> {
    await this.page.keyboard.press('w');
    await this.expectPicking('/profile');
    for (const p of s.profile as PickSpec[]) await this.pickInto('/profile', p);
    await this.expectPicking('/path');
    for (const p of s.path as PickSpec[]) await this.pickInto('/path', p);
    await this.page.keyboard.press('Enter');
    await this.radio('Profile orientation', s.orientation === 'fixed' ? 'Fixed' : 'Follow path');
    await this.radio('Operation', cap(s.op as string));
  }

  private async loft(s: StepSpec): Promise<void> {
    await this.page.keyboard.press('Shift+W');
    await this.expectPicking('/sections');
    for (const p of s.sections as PickSpec[]) await this.pickInto('/sections', p);
    await this.page.keyboard.press('Enter');
    await this.toggle('Ruled (straight between sections)', s.ruled === true);
    await this.toggle('Closed (join last to first)', s.closed === true);
    await this.radio('Operation', cap(s.op as string));
  }

  private async shell(s: StepSpec): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.page.keyboard.press('t');
    await this.expectPicking('/openFaces');
    for (const p of s.openFaces as PickSpec[]) await this.pickInto('/openFaces', p);
    await this.page.keyboard.press('Enter');
    await this.field('Thickness', s.thickness as string);
    await this.radio('Shell direction', s.direction === 'outward' ? 'Outward' : 'Inward');
  }

  private async draft(s: StepSpec): Promise<void> {
    await this.page.keyboard.press('Shift+T');
    await this.expectPicking('/faces');
    for (const p of s.faces as PickSpec[]) await this.pickInto('/faces', p);
    await this.page.keyboard.press('Enter');
    await this.expectPicking('/neutral');
    await this.pickInto('/neutral', s.neutral as PickSpec);
    await this.field('Angle', s.angle as string);
    await this.toggle('Reverse direction', s.reverse === true);
  }

  private async hole(s: StepSpec): Promise<void> {
    await this.page.keyboard.press('o');
    await this.expectPicking('/face');
    await this.pickInto('/face', s.face as PickSpec);
    await this.expectPicking('/points');
    for (const p of s.points as PickSpec[]) await this.pickInto('/points', p);
    await this.page.keyboard.press('Enter');
    const ins = this.inspector;
    await ins.getByRole('radio', { name: s.standard === 'ANSI' ? 'ANSI (inch)' : /^ISO/ }).click();
    await ins.getByRole('combobox', { name: 'Hole type' }).selectOption(s.kind as string);
    await this.a.idle();
    await ins.getByRole('combobox', { name: 'Size' }).selectOption(s.size as string);
    await this.a.idle();
    if (s.kind !== 'tapped') await this.radio('Clearance fit', cap(s.fit as string));
    const end = s.end as { kind: string; depth?: string };
    await this.radio('End condition', END[end.kind] as string);
    if (end.kind === 'blind') await this.field('Depth', end.depth as string);
    const cb = s.counterbore as { diameter?: string; depth?: string } | undefined;
    if (cb) {
      await this.toggle('Override counterbore', true);
      if (cb.diameter) await this.field('Counterbore diameter', cb.diameter);
      if (cb.depth) await this.field('Counterbore depth', cb.depth);
    }
    const cs = s.countersink as { diameter?: string; angle?: string } | undefined;
    if (cs) {
      await this.toggle('Override countersink', true);
      if (cs.diameter) await this.field('Countersink diameter', cs.diameter);
      if (cs.angle) await this.field('Countersink angle', cs.angle);
    }
    if (s.diameter) {
      await this.toggle('Override diameter', true);
      await this.field(/^(Drill diameter|Diameter)$/, s.diameter as string);
    }
  }

  /** Mirror and patterns: the first source selected in the tree, the tool, then the rest. */
  private async copy(s: StepSpec): Promise<void> {
    const src = (s.source as { kind: string; features: string[] }).features;
    const tree = this.page.getByTestId('feature-tree');
    const nameOf = async (step: string) => (await this.feature(this.fid.get(step) ?? '')).name;
    await tree
      .getByRole('treeitem', { name: new RegExp(`^${esc(await nameOf(src[0] as string))}`) })
      .click();
    await this.page.keyboard.press(
      s.tool === 'mirror' ? 'i' : s.tool === 'linearPattern' ? 'n' : 'Shift+N',
    );
    await expect(this.inspector).toBeVisible();
    for (const step of src.slice(1)) {
      await this.pickField('Features to copy', '/source/features');
      await tree.getByRole('treeitem', { name: new RegExp(`^${esc(await nameOf(step))}`) }).click();
      await this.a.idle();
    }
    const f = await this.editing();
    const got =
      (f.type === 'mirror' || f.type === 'linearPattern' || f.type === 'circularPattern') &&
      f.source.kind === 'features'
        ? f.source.features
        : [];
    expect(got).toEqual(src.map((x) => this.fid.get(x)));
    if (s.tool === 'mirror') {
      await this.pickField('Mirror plane', '/plane');
      await this.pickInto('/plane', s.plane as PickSpec);
      return;
    }
    if (s.tool === 'linearPattern') {
      await this.pickField('Direction', '/direction');
      await this.pickInto('/direction', s.direction as PickSpec);
      await this.toggle('Flip direction', s.reverse === true);
      await this.field('Count', s.count as string);
      await this.field('Spacing', s.spacing as string);
    } else {
      await this.pickField('Axis', '/axis');
      await this.pickInto('/axis', s.axis as PickSpec);
      await this.field('Count', s.count as string);
      await this.field('Angle', s.angle as string);
      await this.toggle('Equal spacing across the angle', s.equalSpacing === true);
    }
    for (const k of (s.skip as number[] | undefined) ?? [])
      await this.inspector.getByRole('button', { name: `Instance ${k + 1}: included` }).click();
    await this.a.idle();
  }

  private async boolean(s: StepSpec): Promise<void> {
    await this.page.keyboard.press('ControlOrMeta+k');
    await this.page.getByRole('dialog').waitFor();
    await this.page.keyboard.type('Boolean');
    await this.page
      .getByRole('option', { name: /^Boolean/ })
      .first()
      .click();
    await expect(this.inspector).toBeVisible();
    await this.radio('Operation', cap(s.op as string));
    const f = await this.editing();
    if (f.type === 'boolean') {
      expect.soft(f.target.name).toBe(this.translate((s.target as PickSpec).name ?? ''));
      expect
        .soft(f.tools.map((t) => t.name))
        .toEqual((s.tools as PickSpec[]).map((t) => this.translate(t.name ?? '')));
    }
    await this.toggle('Keep tool bodies', s.keepTools === true);
  }

  private async pushPull(s: StepSpec): Promise<void> {
    const face = (s.faces as PickSpec[])[0] as PickSpec;
    await this.select([face]);
    await this.page.keyboard.press('p');
    await expect.poll(async () => (await this.a.ui()).pushPull?.faces).toBe(1);
    await this.page.getByTestId('value-chip').getByRole('button').click();
    const input = this.page.getByTestId('value-chip-input').getByRole('textbox');
    await input.fill(s.distance as string);
    await input.press('Enter');
    await this.a.idle();
  }

  // ------------------------------------------------------------------ sketches

  private async sketch(s: StepSpec): Promise<void> {
    const on = s.on as PickSpec;
    const page = this.page;
    const name = on.name ? this.translate(on.name) : '';
    await page.keyboard.press('Escape');
    if (/^origin:/.test(name) || /^F\w+:plane$/.test(name)) {
      await page.keyboard.press('s');
      const chooser = page.getByTestId('plane-chooser');
      const label = ORIGIN_LABEL[name];
      const fid = name.slice(1, -':plane'.length);
      await chooser
        .getByRole('button', {
          name: label ? new RegExp(label) : (await this.feature(fid)).name,
        })
        .click();
    } else {
      await this.select([on]);
      await page.keyboard.press('s');
    }
    await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
    await this.a.idle();
    await cameraStill(page);
    await expect.poll(async () => (await this.a.ui()).sketch?.plane !== null).toBe(true);
    const ui = (await this.a.ui()).sketch;
    const sk = new SketchDriver(this, s.id, ui?.featureId ?? '', s.ops ?? []);
    this.ents.set(s.id, sk.map);
    this.fid.set(s.id, ui?.featureId ?? '');
    await sk.run();
    await page.getByTestId('finish-sketch').click();
    await this.a.idle();
  }
}

const KINDS: Record<string, string[]> = {
  face: ['face'],
  plane: ['face'],
  edge: ['edge', 'sketchCurve'],
  axis: ['edge', 'sketchCurve'],
  vertex: ['sketchPoint', 'vertex'],
  point: ['sketchPoint', 'vertex'],
  region: ['region'],
  body: ['face'],
};

/** The app's answer for a click (`__wrenApp.resolveAt`). */
interface Resolved {
  best: {
    bodyId: string;
    kind: string;
    index: number;
    entity?: string;
    point: V3;
    distancePx: number;
  } | null;
  ties: number;
}

/** View keys (PLAN 9.4): iso, top, front, right, back, left, bottom. */
const STANDARD_VIEWS = ['0', '5', '1', '4', '2', '3', '6'];
/** Directions to look from when no standard view shows it (down into a bore, under a lip). */
const TILTED_VIEWS: V3[] = [];
for (const z of [1, -1])
  for (const [x, y] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ] as const)
    TILTED_VIEWS.push([x * 0.6, y * 0.6, z]);

const END: Record<string, string> = { blind: 'Blind', throughAll: 'Through all', upTo: 'Up to' };
const ORIGIN_LABEL: Record<string, string> = {
  'origin:XY': '^Top',
  'origin:XZ': '^Front',
  'origin:YZ': '^Right',
};
const cap = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// ---------------------------------------------------------------------------------------------
// Sketch ops
// ---------------------------------------------------------------------------------------------

type Ent = SketchEntity;

class SketchDriver {
  /** Spec entity id → UI entity id. */
  readonly map = new Map<string, string>();
  /** Spec point id → (baseline) sketch position. */
  private readonly pos = new Map<string, V2>();
  private plane: { origin: number[]; x: number[]; y: number[] } | null = null;

  constructor(
    private readonly d: PartDriver,
    private readonly stepId: string,
    private readonly featureId: string,
    private readonly ops: Op[],
  ) {}

  private get page() {
    return this.d.page;
  }

  private world(p: V2): V3 {
    const f = this.plane;
    if (!f) throw new Error('no plane');
    return [0, 1, 2].map(
      (k) => (f.origin[k] as number) + p[0] * (f.x[k] as number) + p[1] * (f.y[k] as number),
    ) as V3;
  }

  private screen(p: V2) {
    return this.d.screen(this.world(p));
  }

  async sketchFeature(): Promise<SketchFeature> {
    const f = await this.d.feature(this.featureId);
    if (f.type !== 'sketch') throw new Error('not a sketch');
    return f;
  }

  private async entities(): Promise<Ent[]> {
    return (await this.sketchFeature()).entities;
  }

  private async settled(): Promise<void> {
    await this.d.a.settled();
  }

  /** Clicks a sketch point (sketch mm). */
  private async clickAt(p: V2): Promise<void> {
    const s = await this.screen(p);
    if (!s.ok) throw new Error(`sketch point ${p.join(', ')} is off screen`);
    await this.d.click(s);
  }

  private async tool(name: string): Promise<void> {
    const bar = this.page.getByRole('toolbar', { name: 'Sketch tools' });
    const b = bar.getByRole('button', { name, exact: true });
    if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  }

  private async noTool(): Promise<void> {
    for (let i = 0; i < 3 && (await this.d.a.ui()).sketch?.tool; i++)
      await this.page.keyboard.press('Escape');
    await this.settled();
  }

  /** The op's baseline coordinates of a spec point id (`o` = the sketch origin). */
  private at(id: string): V2 {
    if (id === 'o') return [0, 0];
    const p = this.pos.get(id);
    if (!p) throw new Error(`unknown sketch point ${id}`);
    return p;
  }

  private v(expr: string): number {
    return this.d.value(expr);
  }

  /** Frames the view on everything this sketch will hold (plus the origin). */
  private async frame(): Promise<void> {
    const pts: V2[] = [[0, 0]];
    for (const o of this.ops) {
      if (o.op === 'rect') {
        const x = this.v(o.x);
        const y = this.v(o.y);
        pts.push([x, y], [x + this.v(o.w), y + this.v(o.h)]);
      } else if (o.op === 'circle') {
        const r = this.v(o.d) / 2;
        pts.push([this.v(o.cx) - r, this.v(o.cy) - r], [this.v(o.cx) + r, this.v(o.cy) + r]);
      } else if (o.op === 'point') pts.push([this.v(o.x), this.v(o.y)]);
      else if (o.op === 'polygon') for (const [x, y] of o.pts) pts.push([this.v(x), this.v(y)]);
      else if (o.op === 'convert') pts.push(o.a, o.b);
      else if (o.op === 'offsetRect')
        pts.push([o.bounds[0] ?? 0, o.bounds[1] ?? 0], [o.bounds[2] ?? 0, o.bounds[3] ?? 0]);
    }
    const lo: V2 = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))];
    const hi: V2 = [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    const c: V2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
    const r = Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1]) / 2, 5);
    await this.d.zoomTo(this.world(c), r * 1.5);
  }

  /** mm per CSS px at the sketch origin. */
  private async mmPerPx(): Promise<number> {
    const a = await this.screen([0, 0]);
    const b = await this.screen([10, 0]);
    return 10 / Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-6);
  }

  async run(): Promise<void> {
    const ui = (await this.d.a.ui()).sketch;
    this.plane = ui?.plane ?? null;
    if (!this.plane) throw new Error('sketch plane unknown');
    for (const o of this.ops) if (o.op === 'point') this.pos.set(o.id, [this.v(o.x), this.v(o.y)]);
    await this.frame();
    // 1. Geometry.
    // Consecutive Convert Entities ops are one Convert: pick all their edges, then Convert.
    for (let i = 0; i < this.ops.length; i++) {
      const o = this.ops[i] as Op;
      if (o.op !== 'convert') {
        await this.draw(o);
        continue;
      }
      const group: Extract<Op, { op: 'convert' }>[] = [];
      while (this.ops[i]?.op === 'convert')
        group.push(this.ops[i++] as Extract<Op, { op: 'convert' }>);
      i--;
      await this.convert(group);
    }
    await this.noTool();
    // 2. Dimensions.
    for (const o of this.ops) await this.dimensions(o);
    await this.noTool();
    const solve = await this.d.a.sketch();
    expect(solve?.conflicts ?? [], `${this.stepId}: no conflicts`).toEqual([]);
    expect(solve?.dof, `${this.stepId}: fully defined`).toBe(0);
  }

  // ---------------------------------------------------------------- drawing

  private async newEntities<T>(fn: () => Promise<T>): Promise<Ent[]> {
    const before = new Set((await this.entities()).map((e) => e.id));
    await fn();
    await this.settled();
    return (await this.entities()).filter((e) => !before.has(e.id));
  }

  private scaled(p: V2): V2 {
    return [p[0] * S, p[1] * S];
  }

  private async draw(o: Op): Promise<void> {
    switch (o.op) {
      case 'point': {
        await this.tool('Point');
        const made = await this.newEntities(() => this.clickAt(this.scaled(this.at(o.id))));
        const p = made.find((e) => e.kind === 'point');
        if (!p) throw new Error(`point ${o.id} not placed`);
        this.map.set(o.id, p.id);
        return;
      }
      case 'rect': {
        await this.tool('Rectangle');
        const x = this.v(o.x);
        const y = this.v(o.y);
        const a = this.scaled([x, y]);
        const b = this.scaled([x + this.v(o.w), y + this.v(o.h)]);
        const made = await this.newEntities(async () => {
          await this.clickAt(a);
          await this.clickAt(b);
        });
        const lines = made.filter((e) => e.kind === 'line');
        expect(lines, `rect ${o.id}`).toHaveLength(4);
        const mids = await this.midpoints(lines.map((l) => l.id));
        const by = (f: (m: V2) => number) =>
          [...mids.entries()].sort((p, q) => f(p[1]) - f(q[1]))[0]?.[0] as string;
        this.map.set(
          `${o.id}1`,
          by((m) => m[1]),
        ); // bottom
        this.map.set(
          `${o.id}2`,
          by((m) => -m[0]),
        ); // right
        this.map.set(
          `${o.id}3`,
          by((m) => -m[1]),
        ); // top
        this.map.set(
          `${o.id}4`,
          by((m) => m[0]),
        ); // left
        return;
      }
      case 'circle': {
        await this.tool('Circle');
        const c = this.scaled([this.v(o.cx), this.v(o.cy)]);
        const r = (this.v(o.d) / 2) * S;
        const made = await this.newEntities(async () => {
          await this.clickAt(c);
          await this.clickAt(await this.rimClick(c, r));
        });
        const circle = made.find((e) => e.kind === 'circle');
        if (!circle) throw new Error(`circle ${o.id} not drawn`);
        this.map.set(o.id, circle.id);
        return;
      }
      case 'polygon': {
        await this.tool('Line');
        const pts = o.pts.map(([x, y]) => this.scaled([this.v(x), this.v(y)]));
        for (const [i, p] of pts.entries()) {
          const made = await this.newEntities(() => this.clickAt(p));
          const line = made.find((e) => e.kind === 'line');
          if (i > 0 && line) this.map.set(`${o.id}${i}`, line.id);
        }
        const closing = await this.newEntities(() => this.clickAt(pts[0] as V2));
        const last = closing.find((e) => e.kind === 'line');
        if (last) this.map.set(`${o.id}${pts.length}`, last.id);
        return;
      }
      case 'line': {
        await this.tool('Line');
        const made = await this.newEntities(async () => {
          await this.clickAt(await this.pointPos(o.a));
          await this.clickAt(await this.pointPos(o.b));
        });
        const line = made.find((e) => e.kind === 'line');
        if (!line) throw new Error(`line ${o.id} not drawn`);
        this.map.set(o.id, line.id);
        await this.page.keyboard.press('Escape'); // end the chain
        return;
      }
      case 'arc': {
        const bar = this.page.getByRole('toolbar', { name: 'Sketch tools' });
        await bar.getByRole('button', { name: 'Arc', exact: true }).click({ button: 'right' });
        await this.page.locator('[role^="menuitem"]', { hasText: 'Centre-point arc' }).click();
        const made = await this.newEntities(async () => {
          await this.clickAt(o.c === 'o' ? [0, 0] : await this.pointPos(o.c));
          await this.clickAt(await this.pointPos(o.a));
          await this.clickAt(await this.pointPos(o.b));
        });
        const arc = made.find((e) => e.kind === 'arc');
        if (!arc) throw new Error(`arc ${o.id} not drawn`);
        this.map.set(o.id, arc.id);
        return;
      }
      case 'convert':
        await this.convert([o]);
        return;
      case 'offsetRect':
        await this.offsetRect(o);
        return;
    }
  }

  /** Convert Entities: click each model edge (sketch mode shows the model), then Convert. */
  private async convert(ops: Extract<Op, { op: 'convert' }>[]): Promise<void> {
    await this.editTool('Convert entities');
    for (const [i, o] of ops.entries()) {
      await this.d.click(await this.d.screen(o.source.at as V3));
      await expect.poll(async () => (await this.d.a.ui()).sketch?.edit?.model).toBe(i + 1);
    }
    const made = await this.newEntities(async () => {
      await this.page.getByTestId('convert-panel').getByRole('button', { name: 'Convert' }).click();
      await this.d.a.idle();
    });
    for (const o of ops) {
      const want = this.d.translate(o.source.name ?? '');
      const line = made.find((e) => e.kind === 'line' && e.source?.ref.name === want);
      if (!line) throw new Error(`convert ${o.id}: no line linked to ${want}`);
      this.map.set(o.id, line.id);
    }
    // Edges converted together share their corners: one loop.
    const points = made.filter((e) => e.kind === 'point');
    expect(points.length, 'converted corners are shared').toBeLessThanOrEqual(ops.length + 1);
    await this.noTool();
  }

  private async editTool(label: string): Promise<void> {
    const bar = this.page.getByRole('toolbar', { name: 'Sketch tools' });
    await bar.getByRole('button', { name: 'Edit' }).click();
    await this.page
      .locator('[role^="menuitem"]', { hasText: new RegExp(`^${label}`) })
      .first()
      .click();
    await expect.poll(async () => (await this.d.a.ui()).sketch?.edit?.tool).not.toBeNull();
  }

  /** Offset Entities on four converted lines, inward by the distance (ADR-033 sign). */
  private async offsetRect(o: Extract<Op, { op: 'offsetRect' }>): Promise<void> {
    const sources = o.sources.map((s) => this.map.get(s) as string);
    const inward = async (side: 'Left' | 'Right') => {
      await this.editTool('Offset');
      for (const id of sources) await this.clickEntity(id);
      await expect.poll(async () => (await this.d.a.ui()).sketch?.edit?.picks).toBe(4);
      const panel = this.page.getByTestId('offset-panel');
      const dist = panel.getByRole('textbox', { name: 'Offset distance' });
      await dist.fill(this.d.magnitude(o.distance));
      await dist.press('Enter');
      await panel.getByRole('radio', { name: side }).click();
      const made = await this.newEntities(() =>
        panel.getByRole('button', { name: /Apply/ }).click(),
      );
      return made.filter((e) => e.kind === 'line');
    };
    // Which side is inside depends on the converted lines' direction: try one, check, else undo.
    let lines = await inward('Left');
    const inside = async (ids: string[]) => {
      const mids = await this.midpoints(ids);
      const [x0, y0, x1, y1] = o.bounds as [number, number, number, number];
      return [...mids.values()].every(
        (m) => m[0] > x0 + 1e-6 && m[0] < x1 - 1e-6 && m[1] > y0 + 1e-6 && m[1] < y1 - 1e-6,
      );
    };
    if (lines.length !== 4 || !(await inside(lines.map((l) => l.id)))) {
      const toast = (await this.d.a.ui()).toast;
      this.d.log(
        `offset on the left is not inside (${lines.length} lines; ${toast ?? 'no note'}): the other side`,
      );
      await this.noTool();
      // Undo only an offset that was made (a refused one is no undo step).
      if (lines.length) {
        await this.page.keyboard.press('ControlOrMeta+z');
        await this.settled();
      }
      lines = await inward('Right');
    }
    expect(lines).toHaveLength(4);
    expect(await inside(lines.map((l) => l.id))).toBe(true);
    const f = await this.sketchFeature();
    const off = f.constraints.find((c) => c.kind === 'offset');
    if (off?.kind !== 'offset') throw new Error('no offset dimension');
    for (const [i, s] of o.sources.entries()) {
      const k = off.sources.indexOf(this.map.get(s) as string);
      this.map.set(`${o.id}${i + 1}`, off.targets[k] as string);
    }
    await this.noTool();
  }

  /** A point on the circle to click for its radius that snaps onto nothing. */
  private async rimClick(c: V2, r: number): Promise<V2> {
    for (const deg of [30, 120, 210, 300, 75, 165, 255, 345]) {
      const t = (deg * Math.PI) / 180;
      const p: V2 = [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
      const s = await this.screen(p);
      if (s.ok && (await this.d.hits(s, ['sketchCurve', 'sketchPoint'], 12)).length === 0) return p;
    }
    return [c[0] + r, c[1]];
  }

  /** Current position of a spec point (after solving). */
  private async pointPos(id: string): Promise<V2> {
    if (id === 'o') return [0, 0];
    const e = (await this.entities()).find((x) => x.id === this.map.get(id));
    if (e?.kind !== 'point') throw new Error(`no point ${id}`);
    return [e.x, e.y];
  }

  private async midpoints(ids: string[]): Promise<Map<string, V2>> {
    const ents = await this.entities();
    const pt = (id: string): V2 => {
      const p = ents.find((e) => e.id === id);
      return p?.kind === 'point' ? [p.x, p.y] : [0, 0];
    };
    const out = new Map<string, V2>();
    for (const id of ids) {
      const l = ents.find((e) => e.id === id);
      if (l?.kind !== 'line') continue;
      const a = pt(l.start);
      const b = pt(l.end);
      out.set(id, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    return out;
  }

  // ---------------------------------------------------------------- picking sketch entities

  /** Candidate sketch positions on an entity (current geometry). */
  private async spotsOn(id: string): Promise<V2[]> {
    if (id === '@origin') return [[0, 0]];
    const ents = await this.entities();
    const e = ents.find((x) => x.id === id);
    const pt = (pid: string): V2 => {
      const p = ents.find((x) => x.id === pid);
      return p?.kind === 'point' ? [p.x, p.y] : [0, 0];
    };
    if (!e) throw new Error(`no entity ${id}`);
    if (e.kind === 'point') return [[e.x, e.y]];
    if (e.kind === 'line') {
      const a = pt(e.start);
      const b = pt(e.end);
      return [0.5, 0.35, 0.65, 0.2, 0.8].map((t) => [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
      ]);
    }
    if (e.kind === 'circle') {
      const c = pt(e.center);
      return [45, 135, 225, 315, 0, 90, 180, 270].map((deg) => {
        const t = (deg * Math.PI) / 180;
        return [c[0] + e.radius * Math.cos(t), c[1] + e.radius * Math.sin(t)];
      });
    }
    if (e.kind === 'arc') {
      const c = pt(e.center);
      const s = pt(e.start);
      const en = pt(e.end);
      const r = Math.hypot(s[0] - c[0], s[1] - c[1]);
      const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
      let a1 = Math.atan2(en[1] - c[1], en[0] - c[0]);
      while (a1 <= a0) a1 += 2 * Math.PI;
      return [0.5, 0.3, 0.7].map((f) => {
        const t = a0 + (a1 - a0) * f;
        return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
      });
    }
    throw new Error(`can't pick a ${e.kind}`);
  }

  /** Clicks an entity where the sketch pick resolves to it (no label on top). */
  private async clickEntity(id: string): Promise<void> {
    for (const p of await this.spotsOn(id)) {
      const s = await this.screen(p);
      if (!s.ok || !(await this.d.onCanvas(s))) continue;
      // Ranked as the sketch session ranks a click (sketch-session `pickSketch`, ADR-017): the
      // user's points, then curves, then the origin, then the axes; nearest within a tier.
      const norm = (e: string) => (e.startsWith('@origin') ? '@origin' : e);
      const tier = (h: { kind: string; entity?: string }) => {
        const e = norm(h.entity ?? '');
        return e === '@origin' ? 2 : e.startsWith('@') ? 3 : h.kind === 'sketchPoint' ? 0 : 1;
      };
      const hs = (await this.d.hits(s, ['sketchCurve', 'sketchPoint'], 8))
        .filter((h) => h.bodyId === this.featureId && !h.entity?.startsWith('preview:'))
        .sort((a, b) => tier(a) - tier(b) || a.distancePx - b.distancePx);
      const got = norm(hs[0]?.entity ?? '');
      // A point coincident with the origin (a circle centred on it) is the same pick.
      const atOrigin =
        id === '@origin' &&
        (await this.sketchFeature()).constraints.some(
          (c) =>
            c.kind === 'coincident' &&
            ((c.a === got && c.b === '@origin') || (c.b === got && c.a === '@origin')),
        );
      if (got !== id && !atOrigin) continue;
      await this.d.click(s);
      return;
    }
    throw new Error(`no clear spot on ${id}`);
  }

  /** The first label position that is empty canvas (no entity within reach, no label on top). */
  private async freeSpot(cands: V2[]): Promise<V2> {
    for (const p of cands) {
      const s = await this.screen(p);
      if (!s.ok || !(await this.d.onCanvas(s))) continue;
      if ((await this.d.hits(s, ['sketchCurve', 'sketchPoint'], 16)).length) continue;
      return p;
    }
    await this.page.screenshot({ path: `test-results/debug-${this.stepId}-label.png` });
    throw new Error('no free spot for a dimension label');
  }

  // ---------------------------------------------------------------- dimensions

  /**
   * Dimension tool: pick `picks`, place the label at the first free spot, type `expr`. A
   * dimension the sketch already implies (DOF unchanged) is undone and reported as redundant.
   */
  private async dimension(picks: string[], spots: V2[], expr: string, what: string): Promise<void> {
    const page = this.page;
    await this.tool('Dimension');
    const before = await this.d.a.sketch();
    const count = (await this.sketchFeature()).constraints.length;
    for (const id of picks) await this.clickEntity(id);
    await this.clickAt(await this.freeSpot(spots));
    const editor = page.getByTestId('dimension-editor').getByRole('textbox');
    await expect(editor, `${what}: the label opens for typing`).toBeFocused();
    await this.settled();
    const placed = await this.d.a.sketch();
    const made = (await this.sketchFeature()).constraints.at(-1);
    const suffix = what.split('.').at(-1) ?? '';
    const want: Record<string, string> = {
      x: 'hDistance',
      cx: 'hDistance',
      y: 'vDistance',
      cy: 'vDistance',
      w: 'length',
      h: 'length',
      d: 'diameter',
      r: 'radius',
    };
    expect(made?.kind, `${what}: the dimension the label placement makes`).toBe(want[suffix]);
    if ((placed?.dof ?? 0) >= (before?.dof ?? 0)) {
      this.d.log(
        `  ${what}: already defined by the drawn constraints (${made?.kind}, dof ${before?.dof} → ${placed?.dof}), removed`,
      );
      await editor.press('Escape');
      await this.settled();
      await page.keyboard.press('ControlOrMeta+z');
      await this.settled();
      await expect.poll(async () => (await this.sketchFeature()).constraints.length).toBe(count);
      return;
    }
    await editor.fill(expr);
    await editor.press('Enter');
    await expect(editor).toBeHidden();
    await this.settled();
    const after = await this.d.a.sketch();
    expect(after?.conflicts ?? [], `${what} = ${expr}`).toEqual([]);
    this.d.log(`  ${what} = ${expr}`);
  }

  private async gap(): Promise<number> {
    return (await this.mmPerPx()) * 40;
  }

  /**
   * Label spots for an h (axis 0) or v (axis 1) distance from the origin to `p`: inside the span
   * along `axis`, outside it across (the Dimension tool's placement rule), `r` clear of a circle.
   */
  private async spanSpots(axis: 0 | 1, p: V2, r = 0): Promise<V2[]> {
    const g = await this.gap();
    const o = axis === 0 ? 1 : 0;
    const lo = Math.min(p[o] - r, 0);
    const hi = Math.max(p[o] + r, 0);
    const out: V2[] = [];
    for (const across of [lo - g, hi + g, lo - 2 * g, hi + 2 * g])
      for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
        const s: V2 = [0, 0];
        s[axis] = p[axis] * t;
        s[o] = across;
        out.push(s);
      }
    return out;
  }

  /** Horizontal distance from the origin to a point: label above / below their span. */
  private async hDist(id: string, expr: string, what: string): Promise<void> {
    const spots = await this.spanSpots(0, await this.posOf(id));
    await this.dimension([id, '@origin'], spots, this.d.magnitude(expr), what);
  }

  /** Vertical distance from the origin to a point: label beside their span. */
  private async vDist(id: string, expr: string, what: string): Promise<void> {
    const spots = await this.spanSpots(1, await this.posOf(id));
    await this.dimension([id, '@origin'], spots, this.d.magnitude(expr), what);
  }

  /** Position of a point entity, or a circle / arc centre. */
  private async posOf(id: string): Promise<V2> {
    const ents = await this.entities();
    const e = ents.find((x) => x.id === id);
    const pt = (pid: string): V2 => {
      const p = ents.find((x) => x.id === pid);
      return p?.kind === 'point' ? [p.x, p.y] : [0, 0];
    };
    if (e?.kind === 'point') return [e.x, e.y];
    if (e?.kind === 'circle' || e?.kind === 'arc') return pt(e.center);
    throw new Error(`no position for ${id}`);
  }

  private async lineEnds(id: string): Promise<[V2, V2]> {
    const ents = await this.entities();
    const l = ents.find((x) => x.id === id);
    const pt = (pid: string): V2 => {
      const p = ents.find((x) => x.id === pid);
      return p?.kind === 'point' ? [p.x, p.y] : [0, 0];
    };
    if (l?.kind !== 'line') throw new Error(`no line ${id}`);
    return [pt(l.start), pt(l.end)];
  }

  /** Length of a line: label off its side. */
  private async length(id: string, expr: string, what: string): Promise<void> {
    const [a, b] = await this.lineEnds(id);
    const g = await this.gap();
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const n: V2 = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    const spots: V2[] = [];
    for (const k of [1, -1, 2, -2])
      for (const t of [0.5, 0.3, 0.7, 0.2, 0.8])
        spots.push([
          a[0] + (b[0] - a[0]) * t + n[0] * g * k,
          a[1] + (b[1] - a[1]) * t + n[1] * g * k,
        ]);
    await this.dimension([id], spots, expr, what);
  }

  private async diameter(id: string, expr: string, what: string): Promise<void> {
    const c = await this.posOf(id);
    const e = (await this.entities()).find((x) => x.id === id);
    const r = e?.kind === 'circle' ? e.radius : 1;
    const g = await this.gap();
    const spots = [45, 135, 225, 315].map((deg) => {
      const t = (deg * Math.PI) / 180;
      return [c[0] + (r + g) * Math.cos(t), c[1] + (r + g) * Math.sin(t)] as V2;
    });
    await this.dimension([id], spots, expr, what);
  }

  private async radius(id: string, expr: string, what: string): Promise<void> {
    const [p] = await this.spotsOn(id);
    const c = await this.posOf(id);
    const g = await this.gap();
    const q = p as V2;
    const r = Math.hypot(q[0] - c[0], q[1] - c[1]) || 1;
    const spots = [1, 2].map(
      (k) =>
        [c[0] + ((q[0] - c[0]) * (r + g * k)) / r, c[1] + ((q[1] - c[1]) * (r + g * k)) / r] as V2,
    );
    await this.dimension([id], spots, expr, what);
  }

  private async dimensions(o: Op): Promise<void> {
    const id = (k: string) => this.map.get(k) as string;
    const nonZero = (e: string) => Math.abs(this.v(e)) > 1e-9;
    switch (o.op) {
      case 'point': {
        const dims = o.dims ?? 'xy';
        if ((dims === 'xy' || dims === 'x') && nonZero(o.x))
          await this.hDist(id(o.id), o.x, `${o.id}.x`);
        if ((dims === 'xy' || dims === 'y') && nonZero(o.y))
          await this.vDist(id(o.id), o.y, `${o.id}.y`);
        return;
      }
      case 'rect': {
        await this.length(id(`${o.id}1`), o.w, `${o.id}.w`);
        await this.length(id(`${o.id}2`), o.h, `${o.id}.h`);
        // The lower-left corner: the bottom line's end with the smaller x.
        const [a, b] = await this.lineEnds(id(`${o.id}1`));
        const l = (await this.entities()).find((e) => e.id === id(`${o.id}1`));
        const corner = l?.kind === 'line' ? (a[0] <= b[0] ? l.start : l.end) : '';
        if (nonZero(o.x)) await this.hDist(corner, o.x, `${o.id}.x`);
        if (nonZero(o.y)) await this.vDist(corner, o.y, `${o.id}.y`);
        return;
      }
      case 'circle': {
        await this.diameter(id(o.id), o.d, `${o.id}.d`);
        if (nonZero(o.cx)) await this.hDistCurve(id(o.id), o.cx, `${o.id}.cx`);
        if (nonZero(o.cy)) await this.vDistCurve(id(o.id), o.cy, `${o.id}.cy`);
        return;
      }
      case 'polygon': {
        const ents = await this.entities();
        for (const [i, [x, y]] of o.pts.entries()) {
          // Vertex i is the start of line i+1 (the closing line ends on vertex 0).
          const line = ents.find((e) => e.id === id(`${o.id}${i + 1}`));
          const p = line?.kind === 'line' ? line.start : '';
          if (nonZero(x)) await this.hDist(p, x, `${o.id}p${i + 1}.x`);
          if (nonZero(y)) await this.vDist(p, y, `${o.id}p${i + 1}.y`);
        }
        return;
      }
      case 'arc':
        if (o.radius) await this.radius(id(o.id), o.radius, `${o.id}.r`);
        return;
      default:
        return;
    }
  }

  /** Circle centre from the origin (pick the circle and the origin). */
  private async hDistCurve(id: string, expr: string, what: string): Promise<void> {
    const c = await this.posOf(id);
    const e = (await this.entities()).find((x) => x.id === id);
    const r = e?.kind === 'circle' ? e.radius : 0;
    const spots = [...(await this.spanSpots(0, c, r)), ...(await this.spanSpots(0, c))];
    const centre = e?.kind === 'circle' || e?.kind === 'arc' ? e.center : id;
    await this.dimension([centre, '@origin'], spots, this.d.magnitude(expr), what);
  }

  private async vDistCurve(id: string, expr: string, what: string): Promise<void> {
    const c = await this.posOf(id);
    const e = (await this.entities()).find((x) => x.id === id);
    const r = e?.kind === 'circle' ? e.radius : 0;
    const spots = [...(await this.spanSpots(1, c, r)), ...(await this.spanSpots(1, c))];
    const centre = e?.kind === 'circle' || e?.kind === 'arc' ? e.center : id;
    await this.dimension([centre, '@origin'], spots, this.d.magnitude(expr), what);
  }
}

/** Builds the part, checks the baseline and every CSWP stage; returns the mass errors. */
export async function runPart(page: Page, id: string): Promise<{ stage: string; error: number }[]> {
  const spec = loadSpec(id);
  const d = new PartDriver(page, spec);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await d.params();
  await d.material();
  await d.build();
  const out: { stage: string; error: number }[] = [];
  const check = async (stage: string, e: Expected) => {
    const m = await d.massReadout();
    const err = rel(m.mass, e.mass_g);
    d.log(
      `${stage}: mass ${m.mass} g (spec ${e.mass_g}, ${(err * 100).toFixed(4)} %), volume ${m.volume} mm³ (spec ${e.volume_mm3}, ${(rel(m.volume, e.volume_mm3) * 100).toFixed(5)} %)`,
    );
    out.push({ stage, error: err });
    expect(err, `${stage} mass`).toBeLessThan(1e-3);
    expect(rel(m.volume, e.volume_mm3), `${stage} volume`).toBeLessThan(1e-3);
  };
  await check('baseline', spec.expected);
  // A stage is the baseline with only its own dimensions changed (README): the previous stage's
  // values go back to the baseline first.
  let changed: string[] = [];
  for (const s of spec.stages) {
    await page.getByRole('tab', { name: 'Params' }).click();
    const set: Record<string, number> = {};
    for (const name of changed) set[name] = spec.dimensions[name]?.value as number;
    Object.assign(set, s.set);
    changed = Object.keys(s.set);
    for (const [name, value] of Object.entries(set)) {
      const unit = spec.dimensions[name]?.unit ?? '';
      const box = page.getByRole('textbox', { name: `Expression for ${name}` });
      await box.fill(unit ? `${value} ${unit}` : `${value}`);
      await box.press('Enter');
    }
    await d.a.idle();
    const states = ((await d.a.regen())?.features ?? []).map(
      (f) => `${f.state}${f.error ? `: ${f.error}` : ''}`,
    );
    expect(
      states.filter((x) => x !== 'ok'),
      `${s.name}: every feature regenerates`,
    ).toEqual([]);
    await check(s.name, s.expected);
  }
  return out;
}
