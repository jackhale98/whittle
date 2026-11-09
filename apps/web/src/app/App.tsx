import type { Feature, Id, TouchViewport } from '@wren-cad/contracts';
import { ulid } from '@wren-cad/document';
import {
  AppShell,
  type ExportTarget,
  type MoveResult,
  type MoveStep,
  type PaletteCommand,
  readNestSketches,
  tools as shellTools,
  type ToolId,
  useTheme,
  writeNestSketches,
} from '@wren-cad/ui';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { isFeatureTool } from '../features/factories';
import { reorderFeatures } from '../model/tree-edits';
import { getDiagnostics } from '../platform/diagnostics';
import { getRuntimeState, subscribeRuntimeState } from '../platform/runtime-state';
import { applySwUpdate, checkForSwUpdateNow, onSwUpdateAvailable } from '../platform/sw-register';
import { Inspector, useDoc } from '../ui/Inspector';
import {
  useBracketTutorial,
  useContextBubble,
  useMeasureProps,
  usePartsProps,
  useSectionProps,
  useValueChip,
} from '../ui/touch-props';
import { ViewportOverlays } from '../ui/ViewportOverlays';
import { useObservable } from './observable';
import type { EngineState } from './state';
import { ViewportHost } from './ViewportHost';
import type { Workbench } from './workbench';

// Version menu and sync chip: a small chunk fetched right after first paint (PLAN §10 budget).
const ProjectBar = lazy(() => import('../ui/ProjectBar').then((m) => ({ default: m.ProjectBar })));

function isolationLabel(isolation: ReturnType<typeof getRuntimeState>['isolation']): string {
  if (isolation === 'pending') return 'checking isolation';
  return isolation === 'isolated'
    ? 'threaded kernel available'
    : 'fallback (single-threaded kernel)';
}

/** Export targets the kernel writes (the mesh formats come from the render meshes). */
const EXACT_EXPORTS: ReadonlySet<ExportTarget> = new Set(['step', 'stl']);

/** What the export form says while the kernel boots (a phone starts it on demand). */
function kernelLoadingNote(engine: EngineState): string | undefined {
  if (engine.ready || engine.error) return undefined;
  const s = engine.status;
  if (s.state === 'downloading') {
    const pct = s.total ? Math.min(99, Math.round((s.loaded / s.total) * 100)) : null;
    return pct === null ? 'Loading the geometry kernel…' : `Loading the geometry kernel… ${pct}%`;
  }
  if (s.state === 'compiling' || s.state === 'ready') return 'Starting the geometry kernel…';
  return undefined;
}

/** Every tool of the command bar and rail (M3: all of them work). */
const ENABLED_TOOLS: readonly ToolId[] = shellTools.map((t) => t.id);

export function App({ wb }: { wb: Workbench }) {
  const runtime = useSyncExternalStore(subscribeRuntimeState, getRuntimeState);
  const diagnostics = getDiagnostics();
  const theme = useTheme({});
  const doc = useDoc(wb);
  const ui = useObservable(wb.ui);
  const regen = useObservable(wb.regen);
  const engine = useObservable(wb.engine);
  const part = doc.parts[0];
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => onSwUpdateAvailable(() => setUpdateReady(true)), []);
  const [updateNote, setUpdateNote] = useState<string | null>(null);

  useEffect(() => {
    wb.start();
    return () => wb.dispose();
  }, [wb]);

  // "Show sketches in the history": the flat serial list instead of nested sketches (ADR-015).
  const [nestSketches, setNestSketchesState] = useState(readNestSketches);
  const setNestSketches = useCallback((nest: boolean) => {
    setNestSketchesState(nest);
    writeNestSketches(nest);
  }, []);

  const commands = useMemo<PaletteCommand[]>(
    () => [
      { id: 'welcome', label: 'Welcome / samples', run: () => wb.patchUi({ welcome: true }) },
      {
        id: 'tour',
        label: 'Take the 60-second tour',
        hint: 'Make a bracket',
        run: () => wb.requestTour(),
      },
      {
        id: 'section',
        label: 'Section view',
        hint: 'Slice the model',
        run: () => wb.openSection(),
      },
      { id: 'demo', label: 'Open the demo bracket', hint: 'Sample', run: () => void wb.openDemo() },
      { id: 'new-doc', label: 'New document', run: () => void wb.newDocument() },
      { id: 'library', label: 'Open library', run: () => wb.toggleLibrary(true) },
      {
        id: 'versions',
        label: 'Versions',
        hint: 'Save, branch, compare, release',
        run: () => wb.openProjectPanel('versions'),
      },
      {
        id: 'connections',
        label: 'Connections',
        hint: 'Sync with a cloud drive, folder or git',
        run: () => wb.openProjectPanel('connections'),
      },
      {
        id: 'open-file',
        label: 'Open or import file…',
        hint: '.wrencad, STEP, IGES, BREP, STL, OBJ, 3MF, GLB',
        shortcut: '⌘O',
        run: () => void wb.openFromDisk(),
      },
      {
        id: 'save-file',
        label: 'Save as .wrencad file',
        shortcut: '⌘S',
        run: () => void wb.exportWren(),
      },
      { id: 'box', label: 'Box', hint: 'Primitive', run: () => wb.addPrimitive('box') },
      {
        id: 'cylinder',
        label: 'Cylinder',
        hint: 'Primitive',
        run: () => wb.addPrimitive('cylinder'),
      },
      { id: 'plane', label: 'Plane', hint: 'Offset reference plane', run: () => wb.addPlane() },
      { id: 'boolean', label: 'Boolean', hint: 'Combine bodies', run: () => wb.addBoolean() },
      {
        id: 'flat-history',
        label: nestSketches ? 'Show sketches in the history' : 'Nest sketches under their features',
        hint: nestSketches ? 'Flat list' : 'Tidy list',
        run: () => setNestSketches(!nestSketches),
      },
      { id: 'undo', label: 'Undo', run: () => wb.undo() },
      { id: 'redo', label: 'Redo', run: () => wb.redo() },
      {
        id: 'check-updates',
        label: 'Check for updates',
        run: () => {
          setUpdateNote('Checking for updates…');
          void checkForSwUpdateNow().then((r) => {
            if (r === 'update') {
              setUpdateNote(null);
              setUpdateReady(true);
            } else {
              setUpdateNote(
                r === 'current'
                  ? `You're up to date (${diagnostics.appVersion}).`
                  : "Couldn't check for updates (offline?).",
              );
            }
            window.setTimeout(() => setUpdateNote(null), 4000);
          });
        },
      },
      { id: 'about', label: `About Wren · ${diagnostics.appVersion}`, hint: 'Version' },
    ],
    [diagnostics.appVersion, wb, nestSketches, setNestSketches],
  );

  const beforeViewport = useMemo(() => wb.initialDocumentRead(), [wb]);
  const onViewportReady = useCallback(
    (viewport: TouchViewport, canvas: HTMLCanvasElement) => wb.attachViewport(viewport, canvas),
    [wb],
  );
  const [viewportError, setViewportError] = useState<string | null>(null);
  const onViewportError = useCallback(
    (message: string) => {
      wb.viewportFailed(message);
      setViewportError(message);
    },
    [wb],
  );

  const touch = diagnostics.tier !== 'desktop';
  const density = touch ? 'touch' : 'compact';
  const statuses = useObservable(wb.treeStatuses);
  const canUndo = wb.store.canUndo();
  const canRedo = wb.store.canRedo();
  const activeTool: ToolId | null = ui.sketch
    ? 'sketch'
    : ui.pushPull
      ? 'pushPull'
      : ui.measure?.active
        ? 'measure'
        : ui.section.open
          ? 'section'
          : (ui.prompt?.tool ?? pickingTool(part?.features, ui.picking?.featureId));
  const contextBubble = useContextBubble(wb);
  const valueChip = useValueChip(wb);
  const measure = useMeasureProps(wb);
  const section = useSectionProps(wb);
  const parts = usePartsProps(wb);
  const tutorial = useBracketTutorial(wb);
  // Exact formats need the kernel. A phone starts it lazily: choosing STEP/STL (or pressing
  // Export) boots it, so they are only unavailable when it failed to start.
  const engineFailed = engine.error ? 'The geometry kernel failed to start' : undefined;
  const engineNote = kernelLoadingNote(engine);

  /** A feature and its nested sketches move as one undo step; all or nothing. */
  const reorder = (steps: readonly MoveStep[]): MoveResult => {
    if (!part) return { ok: false, reason: 'No part' };
    const last = steps[steps.length - 1];
    const name = part.features.find((f) => f.id === last?.id)?.name ?? 'feature';
    return reorderFeatures(wb.store, part.id, steps, `Move ${name}`);
  };

  const move = (id: Id, toIndex: number): MoveResult => {
    if (!part) return { ok: false, reason: 'No part' };
    const r = wb.store.apply({ kind: 'moveFeature', partId: part.id, featureId: id, toIndex });
    wb.commit();
    return r.ok ? { ok: true } : { ok: false, reason: r.error };
  };

  return (
    <>
      <AppShell
        tier={diagnostics.tier}
        documentName={doc.meta.name}
        kernelStatus={engine.status}
        diagnostics={{ ...diagnostics, ...runtimeOverrides(runtime) }}
        commands={commands}
        projectBar={
          <Suspense fallback={null}>
            <ProjectBar wb={wb} tier={diagnostics.tier} />
          </Suspense>
        }
        theme={theme.setting}
        onThemeChange={theme.setSetting}
        {...(canUndo ? { onUndo: () => wb.undo() } : {})}
        {...(canRedo ? { onRedo: () => wb.redo() } : {})}
        featureTree={
          part
            ? {
                features: part.features,
                ...(statuses ? { statuses } : {}),
                rollbackIndex: part.rollbackIndex,
                selectedId: ui.featureId ?? ui.sketch?.featureId ?? null,
                onSelect: (id) => wb.selectFeature(id),
                onRename: (id, name) => {
                  const f = part.features.find((x) => x.id === id);
                  if (f)
                    wb.apply(
                      {
                        kind: 'updateFeature',
                        partId: part.id,
                        featureId: id,
                        feature: { ...f, name },
                      },
                      `Rename ${f.name}`,
                    );
                  wb.commit();
                },
                onRollback: (index) => {
                  wb.apply({ kind: 'setRollback', partId: part.id, index }, undefined, 'rollback');
                  wb.commit();
                },
                onMove: move,
                onReorder: reorder,
                nestSketches,
                onNestSketchesChange: setNestSketches,
                onEdit: (id) => wb.editFeature(id),
                onSuppress: (id, suppressed) => {
                  wb.apply({ kind: 'setSuppressed', partId: part.id, featureId: id, suppressed });
                  wb.commit();
                },
                onDelete: (id, alsoIds) => {
                  // One undo step for the feature and the sketches deleted with it.
                  const key = alsoIds?.length ? `delete:${id}` : undefined;
                  const name = part.features.find((f) => f.id === id)?.name;
                  wb.apply(
                    { kind: 'removeFeature', partId: part.id, featureId: id },
                    key && name ? `Delete ${name}` : undefined,
                    key,
                  );
                  for (const sketch of alsoIds ?? []) {
                    wb.apply(
                      { kind: 'removeFeature', partId: part.id, featureId: sketch },
                      undefined,
                      key,
                    );
                  }
                  wb.commit();
                },
                density,
              }
            : undefined
        }
        paramsTable={{
          params: doc.params,
          evaluate: (e) => wb.evaluate(e),
          onAdd: () => {
            const names = new Set(doc.params.map((p) => p.name));
            let n = doc.params.length + 1;
            while (names.has(`param${n}`)) n++;
            wb.apply({ kind: 'addParam', param: { id: ulid(), name: `param${n}`, expr: '10 mm' } });
            wb.commit();
          },
          onUpdate: (paramId, patch) => {
            wb.apply({ kind: 'updateParam', paramId, ...patch });
            wb.commit();
          },
          onRemove: (paramId) => {
            wb.apply({ kind: 'removeParam', paramId });
            wb.commit();
          },
          density,
        }}
        inspector={<Inspector wb={wb} density={density} measure={measure} section={section} />}
        {...(contextBubble ? { contextBubble } : {})}
        {...(valueChip ? { valueChip } : {})}
        sheetSnap={ui.sheetSnap}
        onSheetSnapChange={(snap) => wb.setSheet({ snap })}
        {...(ui.sheetTab ? { sheetTab: ui.sheetTab } : {})}
        onSheetTabChange={(tab) => wb.setSheet({ tab })}
        parts={parts}
        measure={measure}
        section={section}
        tutorial={tutorial}
        enabledTools={ENABLED_TOOLS}
        activeTool={activeTool}
        onTool={(tool) => {
          if (ui.sketch) return;
          if (activeTool === tool && tool !== 'section') wb.cancel();
          else if (tool === 'sketch') wb.sketchTool();
          else void wb.runTool(tool);
        }}
        onExportRequest={(r) => void wb.export(r)}
        exportBodies={(regen?.result.bodies ?? []).map((b, i) => ({
          id: b.id,
          name: `Body ${i + 1}`,
        }))}
        {...(engineFailed ? { exportUnavailable: { step: engineFailed, stl: engineFailed } } : {})}
        {...(engineNote ? { exportNotes: { step: engineNote, stl: engineNote } } : {})}
        onExportTargetChange={(target) => {
          if (EXACT_EXPORTS.has(target)) wb.ensureKernel();
        }}
        exportBusy={ui.exporting}
        viewport={
          <>
            <ViewportHost
              beforeCreate={beforeViewport}
              theme={theme.resolved}
              onReady={onViewportReady}
              onError={onViewportError}
            />
            <ViewportOverlays wb={wb} touch={touch} />
            {viewportError && (
              <div
                role="alert"
                data-testid="viewport-error"
                className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm"
              >
                {viewportError} Your browser may have WebGL disabled.
              </div>
            )}
          </>
        }
      />
      {updateReady && (
        <button
          type="button"
          data-testid="update-available"
          onClick={applySwUpdate}
          className="fixed top-3 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-lg"
        >
          Update available · Reload
        </button>
      )}
      {updateNote && (
        <output
          data-testid="update-note"
          className="fixed top-3 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[var(--color-surface)] px-4 py-2 text-sm shadow-lg"
        >
          {updateNote}
        </output>
      )}
      <p data-testid="status-line" className="sr-only" aria-live="polite">
        crossOriginIsolated: {String(diagnostics.crossOriginIsolated)} · service worker:{' '}
        {runtime.serviceWorker} · {isolationLabel(runtime.isolation)}
      </p>
    </>
  );
}

/** The M3 tool whose feature is collecting its references (shown as the active tool). */
function pickingTool(features: readonly Feature[] | undefined, id: Id | undefined): ToolId | null {
  const f = id ? features?.find((x) => x.id === id) : undefined;
  return f && isFeatureTool(f.type) ? f.type : null;
}

function runtimeOverrides(runtime: ReturnType<typeof getRuntimeState>) {
  return {
    serviceWorker: runtime.serviceWorker,
    kernelVariant: runtime.kernelVariant,
    renderBackend: runtime.renderBackend,
  };
}
