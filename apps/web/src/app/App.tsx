import type { Id, TouchViewport } from '@whittle/contracts';
import { ulid } from '@whittle/document';
import {
  AppShell,
  type ExportTarget,
  type MoveResult,
  type PaletteCommand,
  type ToolId,
  useTheme,
} from '@whittle/ui';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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

const ENABLED_TOOLS: readonly ToolId[] = [
  'sketch',
  'extrude',
  'pushPull',
  'revolve',
  'fillet',
  'chamfer',
  'measure',
  'section',
];

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
        id: 'open-file',
        label: 'Open or import file…',
        hint: '.whittle, STEP, BREP, STL, OBJ, 3MF, GLB',
        shortcut: '⌘O',
        run: () => void wb.openFromDisk(),
      },
      {
        id: 'save-file',
        label: 'Save as .whittle file',
        shortcut: '⌘S',
        run: () => void wb.exportWhittle(),
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
      { id: 'about', label: `About Whittle · ${diagnostics.appVersion}`, hint: 'Version' },
    ],
    [diagnostics.appVersion, wb],
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
          : (ui.prompt?.tool ?? null);
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
                onEdit: (id) => wb.editFeature(id),
                onSuppress: (id, suppressed) => {
                  wb.apply({ kind: 'setSuppressed', partId: part.id, featureId: id, suppressed });
                  wb.commit();
                },
                onDelete: (id) => {
                  wb.apply({ kind: 'removeFeature', partId: part.id, featureId: id });
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

function runtimeOverrides(runtime: ReturnType<typeof getRuntimeState>) {
  return {
    serviceWorker: runtime.serviceWorker,
    kernelVariant: runtime.kernelVariant,
    renderBackend: runtime.renderBackend,
  };
}
