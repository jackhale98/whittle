/**
 * Lane packing for "Import model annotations" (ADR-091 "Import planner"; M4 gate finding 1).
 *
 * A lane dimension occupies a strip along its lane (the dimension line, its text, flipped arrows
 * and text pushed outside the extension lines) and its two extension lines from the view outline
 * out to the line. Neither may cross another view's outline or label, a cutting plane or detail
 * circle, a table, the title block or another planned dimension, and both stay inside the frame.
 * Outlines are grown by the headroom first (default 10 %), so the same model edit later keeps
 * them clear too (lanes move out with their outline; trap T8 keeps them in place otherwise).
 *
 * Per view, shortest first: the first free lane on the dimension's own side (where its geometry
 * is); else the first free lane on the opposite side of the same axis (the free side); else, when
 * only an aligned neighbour on that axis is in the way, that view's aligned distance is pushed out
 * by what it takes (`moveViews`; one step of the same import) and everything is planned again;
 * else the dimension does not fit and is reported, never drawn over something.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Drawing, DrawingTable, DrawingView, Id, Vec2 } from '@wren-cad/contracts';
import { readableAngle } from '../annotation/dimension-layout';
import { type Box2, dot2, perp2, rotate2 } from '../annotation/geom';
import type { TextBlock } from '../annotation/label-layout';
import type { TableData } from '../sheet/compose';
import { grownView, type Shape, shapeHitsBox, sheetObstacles } from '../sheet/obstacles';
import { alignedDirection } from '../view/frame';
import { type SolvedView, type ViewSolution, viewOutline } from '../view/solve';

export type LaneSide = 'top' | 'bottom' | 'left' | 'right';

export interface LaneRequest {
  key: string;
  viewId: Id;
  /** The side the measured geometry is on (where it is read best). */
  side: LaneSide;
  /** Measured points' extent along the lane, sheet mm. */
  span: [number, number];
  /** The label as it will be laid out (width and box, sheet mm). */
  label: TextBlock;
}

export type LaneResult = { side: LaneSide; lane: number } | { fail: 'layoutDoesNotFit' };

/**
 * A leader or radial text to keep clear of the same things: the first option whose leader line
 * and text box are clear is taken.
 */
export interface LeaderRequest {
  key: string;
  viewId: Id;
  /** Sheet point the leader starts from (radial: the circle's centre), at the view's position. */
  from: Vec2;
  /** Leaders: text offsets from `from`. Radial: leader angles in degrees. */
  options: readonly (Vec2 | number)[];
  /** Radial: the circle's radius on the sheet; the text sits `distance` beyond it. */
  radius?: number;
  distance?: number;
  /** Text block size, sheet mm. */
  width: number;
  height: number;
}

export interface LanePlanInput {
  drawing: Drawing;
  views: ReadonlyMap<Id, ViewSolution>;
  requests: readonly LaneRequest[];
  tables?: (table: DrawingTable) => TableData | undefined;
  /** Outline growth kept free for model edits (fraction, default 0.1). */
  headroom?: number;
  /** Push aligned views apart when a dimension fits nowhere else (default false). */
  moveViews?: boolean;
  leaders?: readonly LeaderRequest[];
}

export interface LanePlan {
  results: Map<string, LaneResult>;
  /** Views whose aligned distance was pushed out, with their new layout. */
  moved: Map<Id, DrawingView>;
  /** Per moved view: the requests laid out in the views the push separated. */
  movedFor: Map<Id, Set<string>>;
  /** Per leader request: the option taken (its index), or null when none is clear. */
  leaders: Map<string, number | null>;
}

const OPPOSITE: Record<LaneSide, LaneSide> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};
const NORMAL: Record<LaneSide, Vec2> = {
  top: [0, 1],
  bottom: [0, -1],
  left: [-1, 0],
  right: [1, 0],
};
/** Clearance between a dimension and anything it must not touch, sheet mm. */
const CLEAR = 1;
/** Line widths and arrowhead flanks. */
const PAD = 0.5;
const MAX_LANES = 48;

/** Along-lane extent and the text's offsets across the line (along its left normal). */
function labelGeometry(
  label: TextBlock,
  span: [number, number],
  u: Vec2,
  drawing: Drawing,
): { extent: [number, number]; across: [number, number] } {
  const style = drawing.style.dimension;
  const h = drawing.style.text.dimension;
  const [s1, s2] = span;
  const len = s2 - s1;
  const W = label.width;
  // As `linearLayout` decides: arrows flip outside, text moves past the second extension line.
  const outside = len < W + 2 * style.arrow.length;
  const stub = style.arrow.length * 1.5;
  let textS = (s1 + s2) / 2;
  if (W + 0.5 * h > len) textS = s2 + (outside ? stub : 0) + 0.5 * h + W / 2;
  const half = W / 2;
  const lineFrom = Math.min(s1, textS - half) - (outside ? stub : 0);
  const lineTo = Math.max(s2, textS + half) + (outside && textS + half <= s2 ? stub : 0);
  // The label's corners as `placeLabel` puts them.
  const aligned = style.textOrientation === 'aligned';
  const ang = ((aligned ? readableAngle(u) : 0) * Math.PI) / 180;
  const { min, max } = label.box;
  const y0 = style.textPosition === 'above' ? 0.4 * h - min[1] : -(min[1] + max[1]) / 2;
  const x0 = -W / 2;
  const n = perp2(u);
  const corners: Vec2[] = [
    [min[0], min[1]],
    [max[0], min[1]],
    [max[0], max[1]],
    [min[0], max[1]],
  ].map((c) => rotate2([(c[0] as number) + x0, (c[1] as number) + y0], ang));
  const al = corners.map((c) => dot2(c, u));
  const ac = corners.map((c) => dot2(c, n));
  return {
    extent: [
      Math.min(lineFrom, textS + Math.min(...al)) - PAD,
      Math.max(lineTo, textS + Math.max(...al)) + PAD,
    ],
    across: [Math.min(...ac), Math.max(...ac)],
  };
}

/** A box from an along-lane range and an outward range measured from the outline edge. */
function sideBox(o: Box2, side: LaneSide, along: [number, number], t: [number, number]): Box2 {
  const [a0, a1] = along;
  const [t0, t1] = t;
  switch (side) {
    case 'top':
      return { min: [a0, o.max[1] + t0], max: [a1, o.max[1] + t1] };
    case 'bottom':
      return { min: [a0, o.min[1] - t1], max: [a1, o.min[1] - t0] };
    case 'right':
      return { min: [o.max[0] + t0, a0], max: [o.max[0] + t1, a1] };
    case 'left':
      return { min: [o.min[0] - t1, a0], max: [o.min[0] - t0, a1] };
  }
}

interface LaneShapes {
  /** The dimension line, its text and arrows along the lane. */
  strip: Box2;
  /** The two extension lines, from the outline out past the line. */
  extensions: [Box2, Box2];
}

function laneShapes(
  o: Box2,
  side: LaneSide,
  lane: number,
  span: [number, number],
  geo: { extent: [number, number]; across: [number, number] },
  drawing: Drawing,
): LaneShapes {
  const d = drawing.style.dimension;
  const off = d.firstLane + lane * d.laneSpacing;
  // `across` runs along the line's left normal n = perp(u), u = +x or +y: n is +y on top and
  // bottom lanes and −x on left and right ones. Outward is +n on top and left, −n otherwise.
  const sign = side === 'top' || side === 'left' ? 1 : -1;
  const t0 = off + Math.min(sign * geo.across[0], sign * geo.across[1]);
  const t1 = off + Math.max(sign * geo.across[0], sign * geo.across[1]);
  const lo = Math.min(off, t0) - PAD;
  const hi = Math.max(off + d.extensionOvershoot, t1) + PAD;
  const ext = (s: number) =>
    sideBox(o, side, [s - PAD, s + PAD], [0, off + d.extensionOvershoot + PAD]);
  return {
    strip: sideBox(o, side, geo.extent, [lo, hi]),
    extensions: [ext(span[0]), ext(span[1])],
  };
}

function shapesOf(l: LaneShapes): Box2[] {
  return [l.strip, ...l.extensions];
}

function nearAlong(s: Shape, n: Vec2): number {
  if (s.kind === 'segment') return Math.min(dot2(s.a, n), dot2(s.b, n));
  const b = s.box;
  return Math.min(
    dot2(b.min, n),
    dot2(b.max, n),
    dot2([b.min[0], b.max[1]], n),
    dot2([b.max[0], b.min[1]], n),
  );
}

function farAlong(b: Box2, n: Vec2): number {
  return Math.max(
    dot2(b.min, n),
    dot2(b.max, n),
    dot2([b.min[0], b.max[1]], n),
    dot2([b.max[0], b.min[1]], n),
  );
}

function inflate(b: Box2, by: number): Box2 {
  return { min: [b.min[0] - by, b.min[1] - by], max: [b.max[0] + by, b.max[1] + by] };
}

function inside(b: Box2, frame: Box2): boolean {
  return (
    b.min[0] >= frame.min[0] &&
    b.min[1] >= frame.min[1] &&
    b.max[0] <= frame.max[0] &&
    b.max[1] <= frame.max[1]
  );
}

/** The aligned direction of a solved view from its parent, or null when it is not aligned. */
function alignedDir(v: SolvedView, drawing: Drawing): Vec2 | null {
  if (v.view.kind === 'base' || v.view.layout.kind !== 'aligned') return null;
  return alignedDirection(v.side ?? [1, 0], drawing.projection);
}

/** Moves a view and every view aligned to it (recursively) by `delta`, sheet mm. */
function shiftViews(views: Map<Id, ViewSolution>, drawing: Drawing, id: Id, delta: Vec2): Set<Id> {
  const moved = new Set<Id>();
  const visit = (vid: Id) => {
    if (moved.has(vid)) return;
    const s = views.get(vid);
    if (!s?.ok) return;
    moved.add(vid);
    views.set(vid, { ...s, position: [s.position[0] + delta[0], s.position[1] + delta[1]] });
    for (const c of drawing.views)
      if (c.kind !== 'base' && c.parentId === vid && c.layout.kind === 'aligned') visit(c.id);
  };
  visit(id);
  return moved;
}

/** True when every moved view (grown) is inside its frame and clear of everything unmoved. */
function movedViewsFit(
  views: ReadonlyMap<Id, ViewSolution>,
  moved: ReadonlySet<Id>,
  drawing: Drawing,
  growth: number,
  tables: LanePlanInput['tables'],
): boolean {
  for (const id of moved) {
    const s = views.get(id);
    if (!s?.ok) continue;
    const ob = sheetObstacles({
      drawing,
      sheetId: s.view.sheetId,
      views,
      growth,
      ...(tables ? { tables } : {}),
    });
    const box = viewOutline(grownView(s, growth));
    if (!inside(box, ob.frame)) return false;
    for (const o of ob.obstacles) {
      if (o.viewId && moved.has(o.viewId)) continue;
      if (shapeHitsBox(o.shape, box)) return false;
    }
  }
  return true;
}

interface Obstacle {
  shape: Shape;
  /** The view it moves with; null for the title block, tables and the frame. */
  viewId: Id | null;
  /** A cutting-plane line, end or arrow (`cuttingPlaneItems`). */
  cut?: boolean;
}

/** How close a segment must be to an extension line's axis to lie on it, sheet mm. */
const ON_AXIS = 0.05;

/**
 * True when the cutting plane does not stop extension line `k` of a lane on `side` at `at` (its
 * position along the lane): the extension line runs along the cutting-plane line (a stepped cut
 * through the measured point: both mark the same location, as a centre line extended as an
 * extension line does, ISO 128-44 and 129-1), or a cutting-plane item only touches it where such
 * a run ends (the arrow at the cut's end). A cutting-plane item that crosses the extension line
 * anywhere else, and any other obstacle, still blocks it.
 */
function alongCut(
  ob: Obstacle,
  obstacles: readonly Obstacle[],
  side: LaneSide,
  at: number,
): boolean {
  if (!ob.cut || ob.shape.kind !== 'segment') return false;
  // Horizontal extension lines (left and right lanes) lie on y = at; vertical ones on x = at.
  const c = side === 'left' || side === 'right' ? 1 : 0;
  const on = (p: Vec2) => Math.abs((p[c] as number) - at) <= ON_AXIS;
  const runs = (o: Obstacle) =>
    o.cut && o.shape.kind === 'segment' && on(o.shape.a) && on(o.shape.b);
  if (runs(ob)) return true;
  return (on(ob.shape.a) || on(ob.shape.b)) && obstacles.some((o) => o !== ob && runs(o));
}

interface Blocked {
  /** Per lane tried: the obstacles in the way and how far out the dimension reaches. */
  options: { obstacles: Obstacle[]; outer: number }[];
}

interface Push {
  viewId: Id;
  delta: number;
  dir: Vec2;
  between: [Id, Id];
}

/** The leader line and text box of one leader option (approximate, conservative). */
function leaderShapes(
  r: LeaderRequest,
  from: Vec2,
  option: Vec2 | number,
  h: number,
): { line: [Vec2, Vec2]; box: Box2 } {
  let end: Vec2;
  let start: Vec2 = from;
  let right: boolean;
  let reach: number;
  if (typeof option === 'number') {
    const a = (option * Math.PI) / 180;
    const u: Vec2 = [Math.cos(a), Math.sin(a)];
    const rr = r.radius ?? 0;
    start = [from[0] + u[0] * rr, from[1] + u[1] * rr];
    end = [from[0] + u[0] * (rr + (r.distance ?? 0)), from[1] + u[1] * (rr + (r.distance ?? 0))];
    right = u[0] >= 0;
    reach = r.width + 0.6 * h;
  } else {
    end = [from[0] + option[0], from[1] + option[1]];
    right = option[0] >= 0;
    reach = Math.min(2 * h, 6) + r.width;
  }
  const x0 = right ? end[0] : end[0] - reach;
  const box: Box2 = {
    min: [x0 - PAD, end[1] - r.height / 2 - PAD],
    max: [x0 + reach + PAD, end[1] + r.height + PAD],
  };
  return { line: [start, end], box };
}

/** Lays the requests out in lanes (see the module comment). Deterministic. */
export function planLanes(input: LanePlanInput): LanePlan {
  const { drawing } = input;
  const growth = input.headroom ?? 0.1;
  const views = new Map(input.views);
  const distance = new Map<Id, number>();
  const pushedPairs = new Map<Id, Set<Id>>();
  /** Views a push would move off the sheet or onto something: never pushed. */
  const stuck = new Set<Id>();
  const byView = new Map<Id, LaneRequest[]>();
  for (const r of input.requests) {
    const l = byView.get(r.viewId) ?? [];
    l.push(r);
    byView.set(r.viewId, l);
  }
  const viewOrder = [...byView.keys()].sort();
  for (const l of byView.values())
    l.sort(
      (a, b) =>
        a.span[1] - a.span[0] - (b.span[1] - b.span[0]) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  const margin = 4 * drawing.style.text.dimension;
  const h = drawing.style.text.dimension;
  const maxPushes = 2 * drawing.views.length + 2;
  let pushes = 0;

  for (;;) {
    const results = new Map<string, LaneResult>();
    /** Planned dimensions' shapes, by view and side. */
    const planned: { viewId: Id; side: LaneSide; boxes: Box2[] }[] = [];
    let push: Push | null = null;
    const grown = (id: Id) => {
      const s = views.get(id);
      return s?.ok ? grownView(s, growth) : undefined;
    };
    const sheetCache = new Map<Id, ReturnType<typeof sheetObstacles>>();
    const sheetOf = (sheetId: Id) => {
      let s = sheetCache.get(sheetId);
      if (!s) {
        s = sheetObstacles({
          drawing,
          sheetId,
          views,
          growth,
          ...(input.tables ? { tables: input.tables } : {}),
        });
        sheetCache.set(sheetId, s);
      }
      return s;
    };
    // Existing lane placements: their whole lane strip over the whole outline (spans unknown).
    for (const pl of drawing.placements) {
      if (pl.layout.kind !== 'lane') continue;
      const g = grown(pl.viewId);
      if (!g) continue;
      const o = viewOutline(g);
      const ax = pl.layout.side === 'top' || pl.layout.side === 'bottom' ? 0 : 1;
      const l = laneShapes(
        o,
        pl.layout.side,
        pl.layout.lane,
        [o.min[ax], o.max[ax]],
        { extent: [o.min[ax], o.max[ax]], across: [-2 * h, 2 * h] },
        drawing,
      );
      planned.push({ viewId: pl.viewId, side: pl.layout.side, boxes: [l.strip] });
    }

    for (const viewId of viewOrder) {
      const sol = views.get(viewId);
      const g = grown(viewId);
      const items = byView.get(viewId) ?? [];
      if (!sol?.ok || !g) {
        for (const it of items) results.set(it.key, { fail: 'layoutDoesNotFit' });
        continue;
      }
      const o = viewOutline(g);
      const sheet = sheetOf(sol.view.sheetId);
      const rows = new Map<LaneSide, { span: [number, number]; extent: [number, number] }[][]>();
      const all: [number, number] = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
      for (const pl of drawing.placements) {
        if (pl.viewId !== viewId || pl.layout.kind !== 'lane') continue;
        const lanes = rows.get(pl.layout.side) ?? [];
        const row = lanes[pl.layout.lane] ?? [];
        row.push({ span: all, extent: all });
        lanes[pl.layout.lane] = row;
        rows.set(pl.layout.side, lanes);
      }

      const obstaclesFor = (side: LaneSide): Obstacle[] => {
        const out: Obstacle[] = [];
        for (const ob of sheet.obstacles) {
          if (ob.kind === 'view' && ob.viewId === viewId) continue; // its own outline
          out.push({
            shape: ob.shape,
            viewId: ob.viewId ?? null,
            ...(ob.kind === 'cutLine' ? { cut: true } : {}),
          });
        }
        for (const p of planned) {
          if (p.viewId === viewId && p.side === side) continue; // the same side: rows decide
          const pv = views.get(p.viewId);
          if (!pv?.ok || pv.view.sheetId !== sol.view.sheetId) continue;
          for (const box of p.boxes) out.push({ shape: { kind: 'box', box }, viewId: p.viewId });
        }
        return out;
      };

      /** The first free lane on a side, or what is in the way on each lane tried. */
      const tryLanes = (
        it: LaneRequest,
        side: LaneSide,
      ): { ok: true; lane: number; shapes: LaneShapes; extent: [number, number] } | Blocked => {
        const u: Vec2 = side === 'top' || side === 'bottom' ? [1, 0] : [0, 1];
        const geo = labelGeometry(it.label, it.span, u, drawing);
        const obs = obstaclesFor(side);
        const lanes = rows.get(side) ?? [];
        const n = NORMAL[side];
        const options: Blocked['options'] = [];
        for (let lane = 0; lane < MAX_LANES; lane++) {
          const used = lanes[lane] ?? [];
          const clash = used.some(
            (r) =>
              (it.span[0] < r.span[1] + margin && r.span[0] < it.span[1] + margin) ||
              (geo.extent[0] < r.extent[1] && r.extent[0] < geo.extent[1]),
          );
          if (clash) continue;
          const shapes = laneShapes(o, side, lane, it.span, geo, drawing);
          const strip = inflate(shapes.strip, CLEAR);
          const exts = shapes.extensions.map((e) => inflate(e, CLEAR));
          const hits: Obstacle[] = [];
          let onward = true;
          for (const ob of obs) {
            if (
              exts.some(
                (e, k) =>
                  shapeHitsBox(ob.shape, e) && !alongCut(ob, obs, side, it.span[k] as number),
              )
            ) {
              hits.push(ob);
              onward = false; // longer extension lines only cross it again
            } else if (shapeHitsBox(ob.shape, strip)) hits.push(ob);
          }
          const framed = inside(strip, sheet.frame) && exts.every((e) => inside(e, sheet.frame));
          if (!framed) {
            hits.push({ shape: { kind: 'box', box: strip }, viewId: null });
            onward = false;
          }
          if (hits.length === 0) return { ok: true, lane, shapes, extent: geo.extent };
          options.push({ obstacles: hits, outer: farAlong(strip, n) });
          if (!onward) break;
        }
        return { options };
      };

      /** The smallest push of one aligned neighbour that clears a lane, if there is one. */
      const pushFor = (side: LaneSide, blocked: Blocked): Push | null => {
        const n = NORMAL[side];
        let best: Push | null = null;
        for (const opt of blocked.options) {
          const owners = new Set(opt.obstacles.map((h2) => h2.viewId));
          if (owners.size !== 1) continue;
          const w = [...owners][0];
          if (w === null || w === undefined || w === viewId) continue;
          const W = views.get(w);
          if (!W?.ok) continue;
          let target: SolvedView | null = null;
          const wd = alignedDir(W, drawing);
          const vd = alignedDir(sol, drawing);
          if (W.view.kind !== 'base' && W.view.parentId === viewId && wd && dot2(wd, n) > 0.99)
            target = W;
          else if (sol.view.kind !== 'base' && sol.view.parentId === w && vd && dot2(vd, n) < -0.99)
            target = sol;
          if (!target || stuck.has(target.view.id)) continue;
          const near = Math.min(...opt.obstacles.map((ob) => nearAlong(ob.shape, n)));
          const delta = opt.outer - near + 1e-3;
          if (!(delta > 0) || !Number.isFinite(delta)) continue;
          if (best && best.delta <= delta) continue;
          best = {
            viewId: target.view.id,
            delta,
            dir: alignedDir(target, drawing) as Vec2,
            between: [viewId, w],
          };
        }
        return best;
      };

      const take = (
        it: LaneRequest,
        side: LaneSide,
        r: { lane: number; shapes: LaneShapes; extent: [number, number] },
      ) => {
        results.set(it.key, { side, lane: r.lane });
        planned.push({ viewId, side, boxes: shapesOf(r.shapes) });
        const lanes = rows.get(side) ?? [];
        const row = lanes[r.lane] ?? [];
        row.push({ span: it.span, extent: r.extent });
        lanes[r.lane] = row;
        rows.set(side, lanes);
      };

      for (const it of items) {
        const first = tryLanes(it, it.side);
        if ('ok' in first) {
          take(it, it.side, first);
          continue;
        }
        const other = OPPOSITE[it.side];
        const second = tryLanes(it, other);
        if ('ok' in second) {
          take(it, other, second);
          continue;
        }
        const p =
          input.moveViews && pushes < maxPushes
            ? (pushFor(it.side, first) ?? pushFor(other, second))
            : null;
        if (p) {
          push = p;
          break;
        }
        results.set(it.key, { fail: 'layoutDoesNotFit' });
      }
      if (push) break;
    }

    if (push) {
      // Applied only if the moved views still fit on their sheet; otherwise that view is never
      // pushed and the dimension falls back to "does not fit".
      pushes++;
      const trial = new Map(views);
      const delta: Vec2 = [push.dir[0] * push.delta, push.dir[1] * push.delta];
      const moved = shiftViews(trial, drawing, push.viewId, delta);
      if (movedViewsFit(trial, moved, drawing, growth, input.tables)) {
        for (const [id, s] of trial) views.set(id, s);
        distance.set(push.viewId, (distance.get(push.viewId) ?? 0) + push.delta);
        const pair = pushedPairs.get(push.viewId) ?? new Set<Id>();
        for (const id of push.between) pair.add(id);
        pushedPairs.set(push.viewId, pair);
      } else stuck.add(push.viewId);
      continue;
    }

    // Leaders and radial texts, in the final positions, clear of everything planned so far.
    const leaders = new Map<string, number | null>();
    for (const r of input.leaders ?? []) {
      const at = views.get(r.viewId);
      const was = input.views.get(r.viewId);
      if (!at?.ok || !was?.ok) {
        leaders.set(r.key, null);
        continue;
      }
      const from: Vec2 = [
        r.from[0] + at.position[0] - was.position[0],
        r.from[1] + at.position[1] - was.position[1],
      ];
      const sheet = sheetOf(at.view.sheetId);
      const obs: { shape: Shape; own: boolean }[] = [];
      for (const ob of sheet.obstacles)
        if (!(ob.kind === 'view' && ob.viewId === r.viewId))
          obs.push({ shape: ob.shape, own: ob.viewId === r.viewId });
      for (const p of planned) {
        const pv = views.get(p.viewId);
        if (pv?.ok && pv.view.sheetId === at.view.sheetId)
          for (const box of p.boxes)
            obs.push({ shape: { kind: 'box', box }, own: p.viewId === r.viewId });
      }
      let chosen: number | null = null;
      for (let i = 0; i < r.options.length && chosen === null; i++) {
        const { line, box } = leaderShapes(r, from, r.options[i] as Vec2 | number, h);
        const test = inflate(box, CLEAR);
        if (!inside(test, sheet.frame)) continue;
        const seg: Shape = { kind: 'segment', a: line[0], b: line[1] };
        // The text clears everything; the leader line everything but its own view's lines.
        const clear = obs.every(
          (ob) =>
            !shapeHitsBox(ob.shape, test) &&
            (ob.own || ob.shape.kind !== 'box' || !shapeHitsBox(seg, ob.shape.box)),
        );
        if (clear) {
          chosen = i;
          planned.push({ viewId: r.viewId, side: 'top', boxes: [box] });
        }
      }
      leaders.set(r.key, chosen);
    }

    const moved = new Map<Id, DrawingView>();
    const movedFor = new Map<Id, Set<string>>();
    const reqView = new Map(input.requests.map((r) => [r.key, r.viewId]));
    for (const [id, dd] of distance) {
      const v = drawing.views.find((x) => x.id === id);
      if (!v || v.kind === 'base' || v.layout.kind !== 'aligned') continue;
      // Rounded up to 0.1 mm: the stored distance stays readable in the inspector.
      const next = Math.ceil((v.layout.distance + dd) * 10) / 10;
      moved.set(id, { ...v, layout: { kind: 'aligned', distance: next } } as DrawingView);
      const pair = pushedPairs.get(id) ?? new Set<Id>();
      const keys = new Set<string>();
      for (const [k, r] of results) {
        const rv = reqView.get(k);
        if (!('fail' in r) && rv && pair.has(rv)) keys.add(k);
      }
      movedFor.set(id, keys);
    }
    return { results, moved, movedFor, leaders };
  }
}
