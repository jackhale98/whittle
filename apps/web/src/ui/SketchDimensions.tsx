/**
 * Sketch dimensions as other CAD sketchers draw them (M3.5, ADR-055): extension lines, a dimension
 * line with arrows (a leader for radius and diameter, an arc for angles), and a label that can be
 * dragged after placement (mouse, touch, Pencil). A drag moves only the label (`label` on the
 * constraint, one undo step "Move dimension"); the value never changes. Lazy: sketch mode only.
 */

import type { DimensionConstraint, Id, SketchFeature, Vec2 } from '@wren-cad/contracts';
import { isDimension } from '@wren-cad/contracts';
import { type DimensionAnnotation as Annotation, dimensionAnnotation } from '@wren-cad/sketch';
import { DimensionAnnotation, type DimensionGeometry, DimensionLabel } from '@wren-cad/ui';
import { useState } from 'react';
import type { SketchSession } from '../app/sketch-session';
import type { SketchUi } from '../app/state';
import type { Workbench } from '../app/workbench';
import { labelAnchor, measure } from '../sketch/dimension';

type P = { x: number; y: number };

/** Projects an annotation (sketch mm) to the screen geometry the SVG draws. */
function toScreen(ann: Annotation, to: (p: Vec2) => P | null): DimensionGeometry | null {
  const pt = (p: Vec2) => to(p);
  const seg = (s: readonly [Vec2, Vec2]) => {
    const a = pt(s[0]);
    const b = pt(s[1]);
    return a && b ? { a, b } : null;
  };
  const lines = ann.lines.map(seg).filter((s): s is { a: P; b: P } => s !== null);
  const extensions = ann.extensions.map(seg).filter((s): s is { a: P; b: P } => s !== null);
  const arrows = ann.arrows.flatMap((a) => {
    const tip = pt(a.tip);
    const tail = pt([a.tip[0] - a.dir[0], a.tip[1] - a.dir[1]]);
    return tip && tail ? [{ tip, dir: { x: tip.x - tail.x, y: tip.y - tail.y } }] : [];
  });
  const geometry: DimensionGeometry = { extensions, arrows };
  const first = lines[0];
  if (ann.kind === 'radial') {
    if (first) {
      geometry.leader = first;
      // The leader runs over the centre point and meets the curve at its arrow tips: its hit area
      // leaves those free so the centre (and the curve) can still be grabbed and dragged.
      const mid = { x: (first.a.x + first.b.x) / 2, y: (first.a.y + first.b.y) / 2 };
      geometry.clear = [first.a, first.b, mid, ...arrows.map((a) => a.tip)];
    }
  } else if (first) geometry.line = first;
  // Further dimension lines (the stubs outside flipped arrows) draw like extension lines.
  geometry.extensions = [...extensions, ...lines.slice(1)];
  const arc = ann.arcs[0];
  if (arc) {
    const at = (t: number): Vec2 => [
      arc.center[0] + arc.radius * Math.cos(t),
      arc.center[1] + arc.radius * Math.sin(t),
    ];
    const c = pt(arc.center);
    const s = pt(at(arc.start));
    const m = pt(at(arc.start + arc.sweep / 2));
    const e = pt(at(arc.start + arc.sweep));
    if (c && s && m && e) {
      const ang = (p: P) => Math.atan2(p.y - c.y, p.x - c.x);
      // Screen y points down: the arc the sketch sweeps counter-clockwise may run either way.
      const clockwise = (s.x - c.x) * (m.y - c.y) - (s.y - c.y) * (m.x - c.x) > 0;
      geometry.arc = {
        center: c,
        radius: (Math.hypot(s.x - c.x, s.y - c.y) + Math.hypot(e.x - c.x, e.y - c.y)) / 2,
        start: clockwise ? ang(s) : ang(e),
        end: clockwise ? ang(e) : ang(s),
      };
    }
  }
  return geometry;
}

function Dimension({
  wb,
  session,
  ui,
  f,
  c,
  driven,
  conflicting,
}: {
  wb: Workbench;
  session: SketchSession;
  ui: SketchUi;
  f: SketchFeature;
  c: DimensionConstraint;
  driven: Record<Id, number>;
  conflicting: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const v = wb.viewport;
  if (!v) return null;
  const to = (p: Vec2): P | null => {
    const w = session.world(p);
    const s = w ? v.worldToScreen(w) : null;
    return s?.visible ? { x: s.x, y: s.y } : null;
  };
  // While dragged the label is where the pointer put it; the stored one otherwise.
  const live = ui.dimDrag?.id === c.id ? ui.dimDrag.at : undefined;
  const at: Vec2 | null = live ?? labelAnchor(f, c);
  const value = measure(f, c);
  const ann =
    value !== null ? dimensionAnnotation(f.entities, c, value, at ? { label: at } : {}) : null;
  const geometry = ann ? toScreen(ann, to) : null;
  const text = ann ? to(ann.text.at) : at ? to(at) : null;
  if (!text) return null;
  const measured = driven[c.id];
  const selected = ui.selectedConstraint === c.id;
  return (
    <>
      {geometry ? (
        <DimensionAnnotation
          geometry={geometry}
          driving={c.driving}
          hovered={hovered}
          selected={selected}
          conflicting={conflicting}
          // A drawing or dimension tool owns the clicks: the strokes only react with no tool.
          {...(ui.tool === null
            ? { onHover: setHovered, onSelect: () => session.selectConstraint(c.id) }
            : {})}
        />
      ) : null}
      <DimensionLabel
        key={`${c.id}:${ui.editDimension === c.id}`}
        x={text.x}
        y={text.y}
        kind={c.kind}
        expr={c.value}
        driving={c.driving}
        {...(measured !== undefined
          ? {
              measured:
                c.kind === 'angle'
                  ? `${((measured * 180) / Math.PI).toFixed(2)}°`
                  : measured.toFixed(2),
            }
          : {})}
        evaluate={(e) => wb.evaluate(e, c.kind === 'angle' ? 'angle' : 'length')}
        autoEdit={ui.editDimension === c.id}
        selected={selected}
        conflicting={conflicting}
        onCommit={(e) => session.updateDimension(c.id, e, 'commit')}
        onCancel={() => session.doneEditingDimension()}
        onSelect={() => session.selectConstraint(c.id)}
        onDelete={() => session.deleteConstraint(c.id)}
        onToggleDriving={() => session.toggleDriving(c.id)}
        {...(c.kind === 'radius' || c.kind === 'diameter'
          ? { onToggleKind: () => session.toggleRadiusDiameter(c.id) }
          : {})}
        onMove={(x, y) => session.moveDimensionLabel(c.id, x, y)}
        onMoveEnd={(x, y) => session.endMoveDimensionLabel(c.id, x, y)}
      />
    </>
  );
}

export default function SketchDimensions({
  wb,
  session,
  ui,
  f,
  driven,
  conflicting,
}: {
  wb: Workbench;
  session: SketchSession;
  ui: SketchUi;
  f: SketchFeature;
  driven: Record<Id, number>;
  conflicting: ReadonlySet<Id>;
}) {
  return (
    <>
      {f.constraints
        .filter((c): c is DimensionConstraint => isDimension(c))
        .map((c) => (
          <Dimension
            key={c.id}
            wb={wb}
            session={session}
            ui={ui}
            f={f}
            c={c}
            driven={driven}
            conflicting={conflicting.has(c.id)}
          />
        ))}
    </>
  );
}
