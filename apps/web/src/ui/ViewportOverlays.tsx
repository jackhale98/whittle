/**
 * HTML overlays over the 3D view: act-first prompt chip and plane chooser, the "Which one?"
 * chooser, the inline extrude depth, and in sketch mode the sketch toolbar, status chip, conflict
 * panel, constraint glyphs, inference glyphs and dimension labels (positioned with
 * `worldToScreen`). Non-modal throughout (PLAN §1, §9.2).
 */

import type {
  DimensionConstraint,
  ExtrudeFeature,
  Id,
  PickHit,
  SketchConstraint,
  SketchFeature,
  Vec3,
  WhittleDoc,
} from '@whittle/contracts';
import { isDimension } from '@whittle/contracts';
import { constraintLabel, Namer } from '@whittle/sketch';
import {
  ConflictPanel,
  ConstraintGlyph,
  cn,
  DimensionLabel,
  ExpressionInput,
  type PickCandidate,
  PromptChip,
  SketchStatusChip,
  SketchToolbar,
  WhichOneChooser,
} from '@whittle/ui';
import { Library } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useObservable } from '../app/observable';
import type { SketchSession } from '../app/sketch-session';
import type { SketchUi } from '../app/state';
import type { Workbench } from '../app/workbench';
import { ORIGIN_FRAMES, type OriginPlane } from '../model/frames';
import { acceptsFor } from '../selection/pick';
import { labelAnchor } from '../sketch/dimension';
import { entityAnchor } from '../sketch/overlay';
import { describeRef, useDoc } from './Inspector';

const LibraryPanel = lazy(() => import('./LibraryPanel'));
const Welcome = lazy(() => import('./Welcome'));

function useCameraTick(session: SketchSession | null): number {
  const [, force] = useState(0);
  useEffect(() => {
    if (!session) return;
    return session.camera.subscribe(() => force((n) => n + 1));
  }, [session]);
  return session ? session.camera.get() : 0;
}

const PLANES: { id: OriginPlane; label: string; hint: string }[] = [
  { id: 'origin:XY', label: 'Top', hint: 'XY' },
  { id: 'origin:XZ', label: 'Front', hint: 'XZ' },
  { id: 'origin:YZ', label: 'Right', hint: 'YZ' },
];

function PlaneChooser({ wb, doc }: { wb: Workbench; doc: WhittleDoc }) {
  const planes = doc.parts[0]?.features.filter((f) => f.type === 'plane') ?? [];
  return (
    <fieldset
      className="w-panel pointer-events-auto m-0 mt-2 flex items-center gap-1 rounded-[14px] border-0 p-1"
      data-testid="plane-chooser"
      aria-label="Sketch plane"
    >
      {PLANES.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => void wb.startSketch({ name: p.id, kind: 'face' })}
          className="flex h-9 items-center gap-2 rounded-[10px] px-3 text-ui font-medium text-fg hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <PlaneIcon id={p.id} />
          {p.label}
          <span className="tnum text-2xs text-fg-muted">{p.hint}</span>
        </button>
      ))}
      {planes.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => void wb.startSketch({ name: `F${p.id}:plane`, kind: 'face' })}
          className="flex h-9 items-center rounded-[10px] px-3 text-ui font-medium text-fg hover:bg-surface-2"
        >
          {p.name}
        </button>
      ))}
    </fieldset>
  );
}

function PlaneIcon({ id }: { id: OriginPlane }) {
  const f = ORIGIN_FRAMES[id];
  const tilt =
    f.z[2] === 1
      ? 'skewX(-30deg) scaleY(0.6)'
      : f.z[0] === 1
        ? 'skewY(-25deg) scaleX(0.6)'
        : 'none';
  return (
    <span aria-hidden className="flex size-4 items-center justify-center">
      <span
        className="block size-3 rounded-[2px] border border-accent bg-accent-soft"
        style={{ transform: tilt }}
      />
    </span>
  );
}

function candidateFor(doc: WhittleDoc, h: PickHit, i: number): PickCandidate {
  const kind =
    h.kind === 'sketchPoint'
      ? 'vertex'
      : h.kind === 'sketchCurve'
        ? 'edge'
        : h.kind === 'region' || h.kind === 'handle'
          ? 'face'
          : h.kind;
  const owner = doc.parts[0]?.features.findLast((f) => h.bodyId.includes(f.id));
  const noun = { face: 'Face', edge: 'Edge', vertex: 'Vertex', body: 'Body' }[kind];
  return {
    id: String(i),
    kind,
    label: `${noun}${owner ? ` of ${owner.name}` : ''}`,
    detail: `${h.distancePx.toFixed(1)} px away`,
  };
}

/** A candidate of an ambiguous reference: "Edge of Plate" + where it is (they share a name family). */
function candidateForName(wb: Workbench, doc: WhittleDoc, name: string): PickCandidate {
  const kind = wb.ui.get().candidates?.kind ?? 'edge';
  const label = describeRef(doc, { name, kind });
  const at = wb.locate(name, kind);
  const fmt = (v: number) => (Math.round(v * 10) / 10).toString();
  return {
    id: name,
    kind: kind === 'face' ? 'face' : kind === 'vertex' ? 'vertex' : 'edge',
    label,
    ...(at ? { detail: `at ${at.map(fmt).join(', ')} mm` } : {}),
  };
}

/** Inline depth for the extrude being edited, floating next to its profile. */
function ExtrudeDepth({ wb, f }: { wb: Workbench; f: ExtrudeFeature }) {
  const regen = useObservable(wb.regen);
  const v = wb.viewport;
  if (!v || f.end.kind !== 'blind' || !regen) return null;
  const end = f.end;
  const regions = regen.result.sketches.flatMap((s) =>
    s.regions.filter((r) => f.profile.some((p) => p.name === r.name)).map((r) => ({ r, s })),
  );
  const first = regions[0];
  if (!first) return null;
  const { min, max } = first.r.mesh.bbox;
  const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const p = v.worldToScreen(c);
  if (!p.visible) return null;
  return (
    <div
      className="w-panel pointer-events-auto absolute flex items-center gap-2 rounded-[12px] py-1 pr-1 pl-2.5"
      style={{ left: p.x + 24, top: p.y - 18 }}
      data-testid="extrude-depth"
    >
      <span className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">Depth</span>
      <div className="w-32">
        <ExpressionInput
          label="Extrude depth"
          value={end.depth}
          evaluate={(e) => wb.evaluate(e, 'length')}
          unitHint="mm"
          onPreview={(depth) =>
            wb.updateFeature({ ...f, end: { kind: 'blind', depth } }, 'preview')
          }
          onCommit={(depth) => wb.updateFeature({ ...f, end: { kind: 'blind', depth } }, 'commit')}
          testId="extrude-depth-input"
        />
      </div>
    </div>
  );
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

function glyphHost(c: SketchConstraint): Id | null {
  switch (c.kind) {
    case 'horizontal':
    case 'vertical':
      return c.line;
    case 'midpoint':
      return c.point;
    case 'fix':
      return c.entity;
    case 'symmetric':
      return c.about;
    default:
      return 'a' in c && typeof c.a === 'string' ? c.a : null;
  }
}

function SketchLayer({
  wb,
  session,
  ui,
  doc,
}: {
  wb: Workbench;
  session: SketchSession;
  ui: SketchUi;
  doc: WhittleDoc;
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

  const dims = f.constraints.filter((c): c is DimensionConstraint => isDimension(c));
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
      {dims.map((c) => {
        const at = labelAnchor(f, c);
        const p = at ? screen(at) : null;
        if (!p?.visible) return null;
        const measured = driven[c.id];
        return (
          <DimensionLabel
            key={`${c.id}:${ui.editDimension === c.id}`}
            x={p.x}
            y={p.y}
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
            selected={ui.selectedConstraint === c.id}
            conflicting={conflicting.has(c.id)}
            onCommit={(e) => session.updateDimension(c.id, e, 'commit')}
            onCancel={() => session.doneEditingDimension()}
            onSelect={() => session.selectConstraint(c.id)}
            onToggleDriving={() => session.toggleDriving(c.id)}
            {...(c.kind === 'radius' || c.kind === 'diameter'
              ? { onToggleKind: () => session.toggleRadiusDiameter(c.id) }
              : {})}
          />
        );
      })}
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

export function ViewportOverlays({ wb, touch }: { wb: Workbench; touch: boolean }) {
  const ui = useObservable(wb.ui);
  const doc = useDoc(wb);
  const part = doc.parts[0];
  const session = wb.sketch;
  const sk = ui.sketch;

  const editing = ui.featureId ? part?.features.find((f) => f.id === ui.featureId) : undefined;
  const picking = ui.picking ? acceptsFor(ui.picking.path) : null;
  const promptText = ui.prompt?.text ?? (picking ? `Select ${picking.noun}` : null);
  const pickedCount =
    ui.picking && editing
      ? (() => {
          const v = ui.picking.path
            .split('/')
            .slice(1)
            .reduce<unknown>(
              (o, k) =>
                o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined,
              editing,
            );
          return Array.isArray(v) ? v.length : 0;
        })()
      : 0;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[1] select-none"
      data-testid="viewport-overlays"
    >
      {sk && session ? (
        <div className="absolute bottom-[92px] left-1/2 -translate-x-1/2">
          <SketchToolbar
            activeTool={sk.tool}
            variants={sk.variants}
            onTool={(tool, variant) => {
              if (tool === null && session.escapeTool()) return;
              session.setTool(tool, variant);
            }}
            construction={sk.construction}
            onToggleConstruction={() => session.toggleConstruction()}
            onConstraint={(k) => session.constrain(k)}
            enabledConstraints={session.enabledConstraints()}
            onFinish={() => session.finish()}
            onEscape={() => session.finish()}
          />
        </div>
      ) : null}
      {/* Above the command bar, where the tool was chosen: act-first prompt + plane chooser. */}
      {!sk && promptText ? (
        <div className="absolute bottom-[92px] left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
          {ui.prompt?.tool === 'sketch' ? <PlaneChooser wb={wb} doc={doc} /> : null}
          <PromptChip {...(pickedCount ? { count: pickedCount } : {})} onCancel={() => wb.cancel()}>
            {promptText}
          </PromptChip>
        </div>
      ) : null}

      {sk && session ? (
        <>
          <SketchLayer wb={wb} session={session} ui={sk} doc={doc} />
          <div className="absolute top-14 left-3">
            {sk.solve ? (
              <SketchStatusChip
                status={sk.solve.status}
                dof={sk.solve.dof}
                redundant={sk.solve.redundant.length}
                className="pointer-events-auto"
                {...(sk.solve.conflicts.length && sk.conflictsDismissed
                  ? {
                      onClick: () =>
                        wb.ui.set((u) =>
                          u.sketch
                            ? { ...u, sketch: { ...u.sketch, conflictsDismissed: false } }
                            : u,
                        ),
                    }
                  : {})}
              />
            ) : null}
          </div>
          {sk.solve?.conflicts.length && !sk.conflictsDismissed ? (
            <div className="absolute top-20 right-3 z-[3]">
              <ConflictPanel
                conflicts={sk.solve.conflicts}
                constraintName={(id) => {
                  const f = part?.features.find((x) => x.id === sk.featureId);
                  const c =
                    f?.type === 'sketch' ? f.constraints.find((x) => x.id === id) : undefined;
                  return c && f?.type === 'sketch'
                    ? constraintLabel(c, new Namer(f.entities), sk.solve?.driven ?? {})
                    : id;
                }}
                onFix={(fix) => session.applyFix(fix)}
                onHighlight={(ids) => {
                  wb.ui.set((u) =>
                    u.sketch ? { ...u, sketch: { ...u.sketch, highlightConstraints: ids } } : u,
                  );
                  session.pushHighlights();
                }}
                onDismiss={() =>
                  wb.ui.set((u) =>
                    u.sketch ? { ...u, sketch: { ...u.sketch, conflictsDismissed: true } } : u,
                  )
                }
              />
            </div>
          ) : null}
        </>
      ) : null}

      {!sk && editing?.type === 'extrude' ? <ExtrudeDepth wb={wb} f={editing} /> : null}

      {ui.chooser ? (
        <WhichOneChooser
          candidates={ui.chooser.hits.map((h, i) => candidateFor(doc, h, i))}
          at={{ x: ui.chooser.x, y: ui.chooser.y }}
          size={touch ? 'touch' : 'md'}
          onPick={(id) =>
            void wb.choose(ui.chooser?.hits[Number(id)] ?? null, ui.chooser?.additive)
          }
          onDismiss={() => wb.patchUi({ chooser: null })}
        />
      ) : null}

      {ui.candidates ? (
        <WhichOneChooser
          candidates={ui.candidates.names.map((name) => candidateForName(wb, doc, name))}
          at={{ x: ui.candidates.x, y: ui.candidates.y }}
          size={touch ? 'touch' : 'md'}
          onPick={(name) => void wb.chooseCandidate(name)}
          onHover={(name) => wb.previewCandidate(name)}
          onDismiss={() => void wb.chooseCandidate(null)}
        />
      ) : null}

      {/* Hidden while the library is open: the panel has its own close button and would cover it. */}
      {!sk && !ui.library ? (
        <div className="absolute top-14 left-3">
          <button
            type="button"
            onClick={() => wb.toggleLibrary()}
            aria-pressed={ui.library}
            data-testid="library-button"
            className="w-panel pointer-events-auto inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-ui font-medium text-fg hover:text-accent-text"
          >
            <Library className="size-3.5" aria-hidden />
            Library
          </button>
        </div>
      ) : null}

      {ui.library ? (
        <Suspense fallback={null}>
          <LibraryPanel wb={wb} />
        </Suspense>
      ) : ui.welcome && !sk ? (
        <Suspense fallback={null}>
          <Welcome wb={wb} />
        </Suspense>
      ) : null}

      {ui.toast ? (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2">
          <output
            key={ui.toast.id}
            data-testid="toast"
            data-tone={ui.toast.tone}
            className={cn(
              'w-panel block max-w-[min(560px,calc(100vw-32px))] rounded-[14px] px-4 py-2 text-center text-ui font-medium',
              ui.toast.tone === 'error' ? 'text-danger-text' : 'text-fg',
            )}
          >
            {ui.toast.text}
          </output>
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {editing ? `Editing ${editing.name}` : ''}
        {sk ? ' Sketch mode' : ''}
      </span>
    </div>
  );
}
