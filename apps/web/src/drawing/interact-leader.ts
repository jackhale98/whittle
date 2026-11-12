/**
 * Drag handles of a selected leader (ADR-094): its attach point, its bends, and a handle that
 * adds a bend. They use the sheet viewer's drag API like every other drag (one coalescing key,
 * committed on release, Esc or a cancel restores), so a drag is one undo step.
 *
 * Snapping: the attach point stays on the line it is attached to. On a surface's line it slides
 * along the line (snapping to the ends and the middle; the extension waits on the contract, see
 * `storableAttachT`); on a size dimension it takes the nearer end of the dimension line, so it
 * stays in line with it.
 */

import type { AnnotationPlacement, Id, PlacementLayout, Vec2 } from '@wren-cad/contracts';
import {
  dimensionLineEnd,
  lineParameter,
  type PlacedAnnotation,
  storableAttachT,
} from '@wren-cad/drawing';
import type { SheetDrag, SheetPointer } from '@wren-cad/ui/drawing';
import type { DrawingController } from './controller';
import { updatePlacement } from './ops-annot';
import type { Built } from './pipeline';

type Leader = Extract<PlacementLayout, { kind: 'leader' }>;

export type LeaderHandle =
  | { kind: 'attach'; at: Vec2 }
  | { kind: 'bend'; index: number; at: Vec2 }
  /** Drag it to add a bend in the middle of the last leg. */
  | { kind: 'addBend'; at: Vec2 };

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const round3 = (x: number) => Math.round(x * 1000) / 1000;

function placedOf(
  b: Built,
  placementId: Id,
): { pl: AnnotationPlacement; placed: PlacedAnnotation } | null {
  const pl = b.drawing.placements.find((x) => x.id === placementId);
  const placed = b.build.placed.find((x) => x.placementId === placementId);
  return pl && placed?.leader && pl.layout.kind === 'leader' ? { pl, placed } : null;
}

/** The handles of a selected leader placement, sheet mm. */
export function leaderHandlesOf(b: Built, placementId: Id): LeaderHandle[] {
  const p = placedOf(b, placementId);
  const g = p?.placed.leader;
  if (!p || !g || g.attach === 'placement') return [];
  const out: LeaderHandle[] = [];
  if (g.on) out.push({ kind: 'attach', at: g.at });
  g.bends.forEach((at, index) => {
    out.push({ kind: 'bend', index, at });
  });
  const last = g.bends.at(-1) ?? g.at;
  if (len(sub(g.text, last)) > 6)
    out.push({ kind: 'addBend', at: [(last[0] + g.text[0]) / 2, (last[1] + g.text[1]) / 2] });
  return out;
}

/**
 * Snaps `t` on a surface line to its ends and middle within `snap` sheet mm, and keeps it on the
 * line: a stored `t` is in [0, 1] (`storableAttachT`; the extension needs a contract change).
 */
export function snapAlong(t: number, length: number, snap: number): number {
  for (const s of [0, 0.5, 1]) if (Math.abs(t - s) * length <= snap) return s;
  return Math.round(storableAttachT(t) * 1e4) / 1e4;
}

/**
 * The layout after dragging the attach point to `p`. On a surface's line: along it (and its
 * extension). On a dimension line: the nearer end; flipping ends mirrors the text along the line,
 * so the datum keeps pointing out of the dimension. Exported for tests.
 */
export function dragAttach(layout: Leader, on: [Vec2, Vec2], p: Vec2, snap: number): Leader {
  const t = lineParameter(on, p);
  const a = layout.attach;
  if (a.kind === 'ref') {
    const next = snapAlong(t, len(sub(on[1], on[0])), snap);
    return {
      ...layout,
      attach: next === 0.5 ? { kind: 'ref', index: a.index } : { ...a, t: next },
    };
  }
  if (a.kind === 'dimensionLine') {
    const end = dimensionLineEnd(t);
    if (end === dimensionLineEnd(a.t)) return layout;
    const d = sub(on[1], on[0]);
    const l = len(d) || 1;
    const u: Vec2 = [d[0] / l, d[1] / l];
    const k = layout.text[0] * u[0] + layout.text[1] * u[1];
    const text: Vec2 = [
      round3(layout.text[0] - 2 * k * u[0]),
      round3(layout.text[1] - 2 * k * u[1]),
    ];
    const bends = layout.bends?.map((q): Vec2 => {
      const kb = q[0] * u[0] + q[1] * u[1];
      return [round3(q[0] - 2 * kb * u[0]), round3(q[1] - 2 * kb * u[1])];
    });
    return { ...layout, attach: { ...a, t: end }, text, ...(bends ? { bends } : {}) };
  }
  return layout;
}

/** A drag of one of the selected leader's handles under the pointer, or null. */
export function leaderHandleDrag(
  c: DrawingController,
  placementId: Id,
  p: SheetPointer,
): SheetDrag | null {
  const b = c.built();
  if (!b || c.ui.get().tool !== 'select') return null;
  const reach = 9 * p.mm;
  const handle = leaderHandlesOf(b, placementId)
    .map((h) => ({ h, d: len(sub(p.at, h.at)) }))
    .filter((x) => x.d <= reach)
    .sort((x, y) => x.d - y.d)[0]?.h;
  const found = placedOf(b, placementId);
  if (!handle || !found?.placed.leader) return null;
  const g = found.placed.leader;
  const start = found.pl.layout as Leader;
  const key = `drag:leader:${placementId}:${handle.kind}${handle.kind === 'bend' ? handle.index : ''}`;
  const rel = (q: Vec2): Vec2 => [round3(q[0] - g.at[0]), round3(q[1] - g.at[1])];
  let added = false;
  return {
    move(q) {
      const cur = c.drawing()?.placements.find((x) => x.id === placementId);
      if (cur?.layout.kind !== 'leader') return;
      let layout: Leader = start;
      if (handle.kind === 'attach' && g.on) layout = dragAttach(start, g.on, q.at, 6 * q.mm);
      else if (handle.kind === 'bend') {
        const bends = [...(start.bends ?? [])];
        bends[handle.index] = rel(q.at);
        layout = { ...start, bends };
      } else if (handle.kind === 'addBend') {
        added = true;
        layout = { ...start, bends: [...(start.bends ?? []), rel(q.at)] };
      }
      updatePlacement(
        c,
        { ...cur, layout },
        handle.kind === 'addBend' ? 'Bend leader' : 'Move leader',
        key,
      );
    },
    up(_q, moved) {
      if (moved || added) c.commit();
    },
    cancel() {
      c.cancelEdit(key);
    },
  };
}
