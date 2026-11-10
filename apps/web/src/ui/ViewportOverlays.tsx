/**
 * HTML overlays over the 3D view: act-first prompt chip and plane chooser, the "Which one?"
 * chooser, the inline extrude depth, and in sketch mode the sketch toolbar, status chip, conflict
 * panel, constraint glyphs, inference glyphs and dimension labels (positioned with
 * `worldToScreen`). Non-modal throughout (PLAN §1, §9.2).
 */

import type { EntityRef, ExtrudeFeature, PickHit, Vec3, WrenDoc } from '@wren-cad/contracts';
import { constraintLabel, Namer } from '@wren-cad/sketch';
import {
  ConflictPanel,
  cn,
  ExpressionInput,
  type PickCandidate,
  PromptChip,
  SketchStatusChip,
  WhichOneChooser,
  WrenLoader,
} from '@wren-cad/ui';
import { Library } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useObservable } from '../app/observable';
import type { SketchSession } from '../app/sketch-session';
import type { SketchUi, UiState } from '../app/state';
import type { Workbench } from '../app/workbench';
import { ORIGIN_FRAMES, type OriginPlane } from '../model/frames';
import { measureLabel } from '../model/measure';
import { describeRef, useDoc } from './Inspector';

const LibraryPanel = lazy(() => import('./LibraryPanel'));
// Sketch Edit-menu panels: only in sketch mode, so not on the initial route.
const SketchEditPanels = lazy(() =>
  import('./SketchEditPanels').then((m) => ({ default: m.SketchEditPanels })),
);
// Versions, connections, compare and merge (with @wren-cad/sync): fetched when first opened.
const ProjectPanel = lazy(() => import('../sync/ProjectPanel'));

/*
 * Placement against the shells' floating chrome: tablet and phone stages expose `--chrome-top` /
 * `--chrome-left` (top bar, tool rail) and `--chrome-bottom` (the sheet's visible height); the
 * desktop stage has none, so the fallbacks keep the desktop layout (above the command bar).
 */
const TOP_LEFT = { top: 'var(--chrome-top, 3.5rem)', left: 'var(--chrome-left, 0.75rem)' };
const ABOVE_BOTTOM = { bottom: 'calc(var(--chrome-bottom, 80px) + 12px)' };
const TOAST_BOTTOM = { bottom: 'calc(var(--chrome-bottom, 68px) + 12px)' };
const Welcome = lazy(() => import('./Welcome'));
// M3.5: the radial menu, the settings panel and the shortcut overlay load on first use.
const RadialLayer = lazy(() => import('./RadialLayer'));
const SettingsPanel = lazy(() => import('./SettingsPanel'));
const SketchLayer = lazy(() => import('./SketchLayer'));
const SketchToolbarPane = lazy(() => import('./SketchToolbarPane'));
const ShortcutOverlayLayer = lazy(() => import('./ShortcutOverlayLayer'));

const PLANES: { id: OriginPlane; label: string; hint: string }[] = [
  { id: 'origin:XY', label: 'Top', hint: 'XY' },
  { id: 'origin:XZ', label: 'Front', hint: 'XZ' },
  { id: 'origin:YZ', label: 'Right', hint: 'YZ' },
];

function PlaneChooser({ wb, doc }: { wb: Workbench; doc: WrenDoc }) {
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

/**
 * Reference geometry for the field being picked that has no shape in the view: the origin planes
 * and axes and earlier plane / axis / point features (PLAN 9.2). A chip press is the pick.
 */
function ReferenceChooser({
  choices,
  touch,
  onPick,
}: {
  choices: { label: string; ref: EntityRef }[];
  touch: boolean;
  onPick(ref: EntityRef): void;
}) {
  return (
    <fieldset
      className="w-panel pointer-events-auto m-0 flex max-w-[min(720px,calc(100vw-32px))] flex-wrap items-center justify-center gap-1 rounded-[14px] border-0 p-1"
      data-testid="reference-chooser"
      aria-label="Reference geometry"
    >
      {choices.map((c) => (
        <button
          key={c.ref.name}
          type="button"
          data-ref={c.ref.name}
          onClick={() => onPick(c.ref)}
          className={cn(
            'flex items-center rounded-[10px] px-3 text-ui font-medium text-fg hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent',
            touch ? 'h-11' : 'h-9',
          )}
        >
          {c.label}
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

function candidateFor(doc: WrenDoc, h: PickHit, i: number): PickCandidate {
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
    ...(h.depth !== undefined ? { depth: h.depth } : {}),
    label: `${noun}${owner ? ` of ${owner.name}` : ''}`,
    detail: `${h.distancePx.toFixed(1)} px away`,
  };
}

/** A candidate of an ambiguous reference: "Edge of Plate" + where it is (they share a name family). */
function candidateForName(wb: Workbench, doc: WrenDoc, name: string): PickCandidate {
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

/**
 * The whittling loader in the middle of the view while the kernel streams in and the document has
 * geometry that isn't on screen yet (no cached meshes). Gone with the first body.
 */
function KernelLoading({ wb, hasGeometry }: { wb: Workbench; hasGeometry: boolean }) {
  const engine = useObservable(wb.engine);
  const regen = useObservable(wb.regen);
  const s = engine.status;
  // Only while actually waiting: a phone that has not started the kernel is not waiting for it.
  if (
    engine.ready ||
    engine.error ||
    s.state === 'idle' ||
    !hasGeometry ||
    (regen?.result.bodies.length ?? 0) > 0
  )
    return null;
  const pct = s.state === 'downloading' && s.total ? Math.round((100 * s.loaded) / s.total) : null;
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-3"
      role="status"
      aria-live="polite"
      data-testid="kernel-loading"
    >
      <WrenLoader className="size-24" label="Loading the modeling kernel" />
      <p className="tnum text-ui text-fg-muted">
        {s.state === 'compiling'
          ? 'Preparing the modeling kernel…'
          : `Loading the modeling kernel${pct !== null ? ` · ${pct}%` : '…'}`}
      </p>
    </div>
  );
}

/** The measure result's label in the view, following the camera every frame. */
function MeasureLabel({ wb }: { wb: Workbench }) {
  const ui = useObservable(wb.ui);
  useObservable(wb.cameraTick);
  const m = ui.measure;
  const label = m ? measureLabel(m.picks, m.current) : null;
  const p = label ? wb.project(label.at) : null;
  if (!label || !p) return null;
  return (
    <output
      data-testid="measure-label"
      className="w-panel tnum pointer-events-none absolute -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-full px-3 py-1 text-ui font-semibold whitespace-nowrap text-accent-text"
      style={{ left: p.x, top: p.y }}
    >
      {label.text}
    </output>
  );
}

const SHAPE_NAMES: Record<string, string> = {
  line: 'Line',
  polyline: 'Polyline',
  rectangle: 'Rectangle',
  circle: 'Circle',
  arc: 'Arc',
  scribble: 'Erase',
};

/** Live Pencil feedback: what the stroke is recognised as, next to the pen. */
function StrokeChip({ wb, session, ui }: { wb: Workbench; session: SketchSession; ui: SketchUi }) {
  const st = ui.stroke;
  const last = st?.points[st.points.length - 1];
  const w = last ? session.world(last) : null;
  const p = w ? wb.project(w) : null;
  if (!st || !p) return null;
  return (
    <output
      data-testid="stroke-shape"
      data-shape={st.shape ?? ''}
      className="w-panel pointer-events-none absolute rounded-full px-2.5 py-0.5 text-2xs font-semibold text-fg"
      style={{ left: p.x + 16, top: p.y - 30 }}
    >
      {st.shape ? (SHAPE_NAMES[st.shape] ?? st.shape) : 'Drawing…'}
    </output>
  );
}

/** The rubber band of a box selection: solid for window (L to R), dashed for crossing (R to L). */
function BoxBand({ box }: { box: NonNullable<UiState['box']> }) {
  return (
    <div
      data-testid="box-select"
      data-mode={box.mode}
      aria-hidden
      className={cn(
        'pointer-events-none absolute border border-accent bg-accent-soft',
        box.mode === 'crossing' && 'border-dashed',
      )}
      style={{
        left: Math.min(box.x0, box.x1),
        top: Math.min(box.y0, box.y1),
        width: Math.abs(box.x1 - box.x0),
        height: Math.abs(box.y1 - box.y0),
      }}
    />
  );
}

export function ViewportOverlays({ wb, touch }: { wb: Workbench; touch: boolean }) {
  const ui = useObservable(wb.ui);
  const doc = useDoc(wb);
  const part = doc.parts[0];
  const session = wb.sketch;
  const sk = ui.sketch;

  const editing = ui.featureId ? part?.features.find((f) => f.id === ui.featureId) : undefined;
  const verb = touch ? 'Tap' : 'Click';
  const promptText = ui.section.picking
    ? `${verb} a flat face for the section plane`
    : ui.pushPull
      ? `Drag the arrow, or ${verb.toLowerCase()} the value to type it`
      : ui.measure?.active && !ui.measure.picks.length
        ? `${verb} faces, edges or points to measure`
        : (ui.prompt?.text ?? (ui.picking ? wb.pickPrompt() : null));
  const refChoices = ui.picking ? wb.referenceChoices() : [];
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
        <div className="absolute left-1/2 -translate-x-1/2" style={ABOVE_BOTTOM}>
          <Suspense fallback={null}>
            <SketchToolbarPane wb={wb} session={session} sk={sk} touch={touch} />
          </Suspense>
        </div>
      ) : null}
      {/* Above the command bar, where the tool was chosen: act-first prompt + plane chooser. */}
      {!sk && promptText ? (
        <div
          className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-2"
          style={ABOVE_BOTTOM}
          data-testid="prompt"
        >
          {ui.prompt?.tool === 'sketch' ? <PlaneChooser wb={wb} doc={doc} /> : null}
          {refChoices.length ? (
            <ReferenceChooser choices={refChoices} touch={touch} onPick={(r) => wb.pickRef(r)} />
          ) : null}
          <PromptChip
            {...(pickedCount ? { count: pickedCount } : {})}
            size={touch ? 'touch' : 'md'}
            onCancel={() => wb.cancel()}
          >
            {promptText}
          </PromptChip>
        </div>
      ) : null}

      {sk && session ? (
        <>
          <Suspense fallback={null}>
            <SketchLayer wb={wb} session={session} ui={sk} doc={doc} />
          </Suspense>
          <div
            className="pointer-events-auto absolute left-1/2 -translate-x-1/2"
            style={{ top: 'var(--chrome-top, 3.5rem)' }}
          >
            <Suspense fallback={null}>
              <SketchEditPanels wb={wb} session={session} ui={sk} doc={doc} touch={touch} />
            </Suspense>
          </div>
          <StrokeChip wb={wb} session={session} ui={sk} />
          <div className="absolute" style={TOP_LEFT}>
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
                entityName={(id) => {
                  const f = part?.features.find((x) => x.id === sk.featureId);
                  return f?.type === 'sketch' ? new Namer(f.entities).entity(id) : undefined;
                }}
                onHighlight={(ids) => {
                  wb.ui.set((u) =>
                    u.sketch ? { ...u, sketch: { ...u.sketch, highlightConstraints: ids } } : u,
                  );
                  session.pushHighlights();
                }}
                onHighlightEntities={(ids) => {
                  wb.ui.set((u) =>
                    u.sketch ? { ...u, sketch: { ...u.sketch, highlightEntities: ids } } : u,
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
      {!sk && ui.measure ? <MeasureLabel wb={wb} /> : null}

      {ui.chooser ? (
        <WhichOneChooser
          candidates={ui.chooser.hits.map((h, i) => candidateFor(doc, h, i))}
          at={{ x: ui.chooser.x, y: ui.chooser.y }}
          size={touch ? 'touch' : 'md'}
          onHover={(id) => wb.previewChooser(id === null ? null : Number(id))}
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
        <div className="absolute" style={TOP_LEFT}>
          <button
            type="button"
            onClick={() => wb.toggleLibrary()}
            aria-pressed={ui.library}
            data-testid="library-button"
            className={cn(
              'w-panel pointer-events-auto inline-flex items-center gap-2 rounded-full px-3.5 text-ui font-medium text-fg hover:text-accent-text',
              touch ? 'h-11 px-4' : 'h-9',
            )}
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
      ) : (
        <KernelLoading wb={wb} hasGeometry={(part?.features.length ?? 0) > 0} />
      )}

      {ui.project && !sk ? (
        <Suspense fallback={null}>
          <ProjectPanel wb={wb} />
        </Suspense>
      ) : null}

      {ui.box ? <BoxBand box={ui.box} /> : null}
      {ui.settings ? (
        <Suspense fallback={null}>
          <SettingsPanel wb={wb} touch={touch} />
        </Suspense>
      ) : null}
      {ui.radial ? (
        <Suspense fallback={null}>
          <RadialLayer wb={wb} />
        </Suspense>
      ) : null}
      {ui.ready ? (
        <Suspense fallback={null}>
          <ShortcutOverlayLayer wb={wb} />
        </Suspense>
      ) : null}

      {ui.toast ? (
        <div className="absolute left-1/2 -translate-x-1/2" style={TOAST_BOTTOM}>
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
