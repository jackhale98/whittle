/**
 * The sketch overlay: constraint glyphs, inference glyphs and the dimensions. Lazy: sketch mode
 * only, so none of it is on the initial route.
 */

import type { Id, SketchConstraint, SketchFeature, WrenDoc } from '@wren-cad/contracts';
import { constraintLabel, isSketchReference, Namer } from '@wren-cad/sketch';
import { ConstraintGlyph, cn } from '@wren-cad/ui';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { SketchSession } from '../app/sketch-session';
import type { SketchUi } from '../app/state';
import type { Workbench } from '../app/workbench';
import { entityAnchor } from '../sketch/overlay';

const SketchDimensions = lazy(() => import('./SketchDimensions'));

function useCameraTick(session: SketchSession | null): number {
  const [, force] = useState(0);
  useEffect(() => {
    if (!session) return;
    return session.camera.subscribe(() => force((n) => n + 1));
  }, [session]);
  return session ? session.camera.get() : 0;
}

const GLYPH_KINDS = new Set([
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'tangent',
  'equal',
  'midpoint',
  'concentric',
  'symmetric',
  'fix',
]);

/** The entity a constraint's glyph sits on: never the origin or an axis (ADR-017). */
function glyphHost(c: SketchConstraint): Id | null {
  const user = (...ids: Id[]) => ids.find((id) => !isSketchReference(id)) ?? null;
  switch (c.kind) {
    case 'horizontal':
    case 'vertical':
      return c.line;
    case 'midpoint':
      return user(c.point, c.line);
    case 'fix':
      return c.entity;
    case 'symmetric':
      return user(c.about, c.a, c.b);
    default:
      return 'a' in c && typeof c.a === 'string' && typeof c.b === 'string' ? user(c.a, c.b) : null;
  }
}

export default function SketchLayer({
  wb,
  session,
  ui,
  doc,
}: {
  wb: Workbench;
  session: SketchSession;
  ui: SketchUi;
  doc: WrenDoc;
}) {
  useCameraTick(session);
  const v = wb.viewport;
  const f = doc.parts[0]?.features.find((x) => x.id === ui.featureId) as SketchFeature | undefined;
  if (!v || !f || f.type !== 'sketch' || !ui.frame) return null;
  const screen = (p: [number, number]) => {
    const w = session.world(p);
    return w ? v.worldToScreen(w) : null;
  };
  const namer = new Namer(f.entities);
  const driven = ui.solve?.driven ?? {};
  const conflicting = new Set(ui.solve?.conflicts.flatMap((c) => c.constraints) ?? []);

  // Constraint glyphs, stacked per host entity.
  const perHost = new Map<Id, number>();
  const glyphs = f.constraints.flatMap((c) => {
    if (!GLYPH_KINDS.has(c.kind)) return [];
    const host = glyphHost(c);
    const at = host ? entityAnchor(f.entities, host) : null;
    const p = at ? screen(at) : null;
    if (!host || !p?.visible) return [];
    const k = perHost.get(host) ?? 0;
    perHost.set(host, k + 1);
    return [{ c, x: p.x + 10 + k * 22, y: p.y - 22 }];
  });

  const cursor = ui.draw?.cursor ? screen(ui.draw.cursor) : null;

  return (
    <>
      {glyphs.map(({ c, x, y }) => (
        <button
          key={c.id}
          type="button"
          aria-label={constraintLabel(c, namer, driven)}
          aria-pressed={ui.selectedConstraint === c.id}
          onClick={() => session.selectConstraint(ui.selectedConstraint === c.id ? null : c.id)}
          className={cn(
            'pointer-events-auto absolute rounded-[7px] transition-shadow',
            ui.selectedConstraint === c.id && 'shadow-[0_0_0_2px_var(--color-accent)]',
          )}
          style={{ left: x, top: y }}
          data-testid="constraint-glyph"
          data-kind={c.kind}
        >
          <ConstraintGlyph
            kind={c.kind}
            size={20}
            tone={
              conflicting.has(c.id)
                ? 'conflict'
                : ui.selectedConstraint === c.id
                  ? 'selected'
                  : 'placed'
            }
          />
        </button>
      ))}
      <Suspense fallback={null}>
        <SketchDimensions
          wb={wb}
          session={session}
          ui={ui}
          f={f}
          driven={driven}
          conflicting={conflicting}
        />
      </Suspense>
      {cursor?.visible && ui.draw?.glyphs.length ? (
        <div
          className="pointer-events-none absolute flex gap-1"
          style={{ left: cursor.x + 14, top: cursor.y + 12 }}
          data-testid="inference-glyphs"
        >
          {ui.draw.glyphs.map((k) => (
            <ConstraintGlyph key={k} kind={k} size={20} tone="hint" labelled />
          ))}
        </div>
      ) : null}
    </>
  );
}
