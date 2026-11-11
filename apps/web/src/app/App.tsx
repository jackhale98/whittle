import type { Feature, Id, TouchViewport } from '@wren-cad/contracts';
import { exportFileNames, ulid } from '@wren-cad/document';
import {
  AppShell,
  type ExportTarget,
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
import { getDiagnostics } from '../platform/diagnostics';
import { getRuntimeState, subscribeRuntimeState } from '../platform/runtime-state';
import { applySwUpdate, checkForSwUpdateNow, onSwUpdateAvailable } from '../platform/sw-register';
import { Inspector, useDoc } from '../ui/Inspector';
import { useStatuses } from '../ui/ref-status';
import {
  useBracketTutorial,
  useContextBubble,
  useMeasureProps,
  usePartsProps,
  useSectionProps,
  useValueChip,
} from '../ui/touch-props';
import { useTreeProps } from '../ui/tree-props';
import { ViewportOverlays } from '../ui/ViewportOverlays';
import { onSheetHeight, reframeSoon, syncFrameInsets } from './framing';
import { installKernelMemoryHook, readKernelMemory } from './kernel-memory';
import { useObservable } from './observable';
import type { EngineState } from './state';
import { ViewportHost } from './ViewportHost';
import type { Workbench } from './workbench';

// Version menu and sync chip: a small chunk fetched right after first paint (PLAN §10 budget).
const ProjectBar = lazy(() => import('../ui/ProjectBar').then((m) => ({ default: m.ProjectBar })));
// M3.7: the configuration pill is its own chunk, the table panel another (opened on demand).
// Configuration notices (export busy, missing configuration, inherited-edit) are rarely on screen.
const ConfigNotices = lazy(() =>
  import('../ui/ConfigNotices').then((m) => ({ default: m.ConfigNotices })),
);
const ConfigurationBar = lazy(() => import('../ui/ConfigurationBar'));
const ConfigurationPanel = lazy(() => import('../ui/ConfigurationPanel'));
// M4: the drawing route is a lazy chunk, fetched when the first drawing opens (or on idle after it was used).
const DrawingRoute = lazy(() => import('../drawing/DrawingRoute'));

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

/** "Default, Long and Thick". */
const joinNames = (names: string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** Every tool of the command bar and rail (M3: all of them work). */
const ENABLED_TOOLS: readonly ToolId[] = shellTools.map((t) => t.id);

export function App({ wb }: { wb: Workbench }) {
  const runtime = useSyncExternalStore(subscribeRuntimeState, getRuntimeState);
  const diagnostics = getDiagnostics();
  const theme = useTheme({});
  const doc = useDoc(wb);
  // "Used by" is computed in a lazy chunk: it is only shown on the Params tab.
  const [usage, setUsage] = useState<typeof import('./param-usage').paramUsage | null>(null);
  useEffect(() => {
    void import('./param-usage').then((m) => setUsage(() => m.paramUsage));
  }, []);
  const usedBy = useMemo(() => usage?.(doc), [usage, doc]);
  const ui = useObservable(wb.ui);
  const regen = useObservable(wb.regen);
  const engine = useObservable(wb.engine);
  const part = doc.parts[0];
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => onSwUpdateAvailable(() => setUpdateReady(true)), []);
  useEffect(() => installKernelMemoryHook(wb), [wb]);
  const kernelMemory = useCallback(() => readKernelMemory(wb), [wb]);
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

  const originPlanes = useObservable(wb.originPlanes);
  const commands = useMemo<PaletteCommand[]>(
    () => [
      {
        id: 'settings',
        label: 'Settings',
        hint: 'Mouse buttons, orbit, keyboard shortcuts',
        run: () => wb.openSettings('navigation'),
      },
      {
        id: 'keyboard',
        label: 'Keyboard shortcuts',
        hint: 'Edit the keymap',
        run: () => wb.openSettings('keyboard'),
      },
      {
        id: 'radial-settings',
        label: 'Radial menu settings',
        hint: 'Choose what the right-click wheel offers',
        run: () => wb.openSettings('radial'),
      },
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
      {
        id: 'new-drawing',
        label: 'New drawing',
        hint: 'Put this part on a sheet',
        run: () => wb.openDrawing(null),
      },
      {
        id: 'origin-planes',
        label: originPlanes ? 'Hide origin planes' : 'Show origin planes',
        run: () => wb.setOriginPlanes(!originPlanes),
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
    [diagnostics.appVersion, wb, nestSketches, setNestSketches, originPlanes],
  );

  const beforeViewport = useMemo(() => wb.initialDocumentRead(), [wb]);
  const onViewportReady = useCallback(
    (viewport: TouchViewport, canvas: HTMLCanvasElement) => {
      wb.attachViewport(viewport, canvas);
      syncFrameInsets(wb);
    },
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
  const statuses = useStatuses(wb, doc.meta.id ?? '');
  const tree = useTreeProps(wb, {
    density,
    nestSketches,
    setNestSketches,
    statuses,
    actions: diagnostics.tier === 'phone' ? 'review' : 'full',
  });
  const allCommands = useMemo(() => [...commands, ...tree.commands], [commands, tree.commands]);
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
  // A mode starting (section, measure) frames the model in the area the sheet leaves free.
  const modeOn = ui.section.enabled || ui.measure?.active === true;
  useEffect(() => {
    if (modeOn) reframeSoon(wb);
  }, [modeOn, wb]);
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
  const configState = useObservable(wb.config.state);
  const configs = part?.configurations ?? [];
  const exportConfigurations = useMemo(() => {
    if (!part || configs.length === 0) return undefined;
    const ids = [null, ...configs.map((c) => c.id)];
    const { collisions } = exportFileNames(doc, part.id, ids);
    const nameOf = (id: string | null) =>
      id === null ? 'Default' : (configs.find((c) => c.id === id)?.name ?? id);
    return {
      activeName: wb.config.activeName,
      count: ids.length,
      warnings: collisions.map(
        (c) =>
          `${joinNames(c.configurationIds.map(nameOf))} would both be written to ${c.fileName}. Give them different part numbers.`,
      ),
    };
  }, [doc, part, configs, wb]);
  const activeConfig = wb.config.active;
  // Popups (the parameter list, the Make parameter form) re-place themselves when the camera moves.
  useEffect(
    () => wb.cameraTick.subscribe(() => window.dispatchEvent(new Event('wren:reposition'))),
    [wb],
  );
  // A new token whenever an evaluated value can change: the shell re-evaluates parameters on it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the token is the dependency
  const paramsVersion = useMemo(() => ({}), [doc, configState]);

  return (
    <>
      {/* The model stays mounted under the drawing route (the regen keeps running); it is inert and hidden from it. */}
      <div className="contents" inert={ui.drawing !== null}>
        <AppShell
          tier={diagnostics.tier}
          documentName={doc.meta.name}
          kernelStatus={engine.status}
          diagnostics={{ ...diagnostics, ...runtimeOverrides(runtime) }}
          kernelMemory={kernelMemory}
          commands={allCommands}
          projectBar={
            <Suspense fallback={null}>
              <ProjectBar wb={wb} tier={diagnostics.tier} />
            </Suspense>
          }
          configurationBar={
            <Suspense fallback={null}>
              <ConfigurationBar wb={wb} tier={diagnostics.tier} />
            </Suspense>
          }
          {...(configState.panel && diagnostics.tier !== 'phone'
            ? {
                configurationPanel: (
                  <Suspense fallback={null}>
                    <ConfigurationPanel wb={wb} touch={touch} />
                  </Suspense>
                ),
              }
            : {})}
          {...(exportConfigurations ? { exportConfigurations } : {})}
          theme={theme.setting}
          onThemeChange={theme.setSetting}
          {...(canUndo ? { onUndo: () => wb.undo() } : {})}
          {...(canRedo ? { onRedo: () => wb.redo() } : {})}
          {...(tree.featureTree ? { featureTree: tree.featureTree } : {})}
          paramsTable={{
            params: doc.params,
            ...(configs.length > 0
              ? {
                  configuration: {
                    activeId: activeConfig?.id ?? null,
                    activeName: wb.config.activeName,
                    overrides: activeConfig?.params ?? {},
                    onReset: (id: string) =>
                      wb.config.resetOverride({ kind: 'param', paramId: id }),
                  },
                }
              : {}),
            evaluate: (e) => wb.evaluate(e),
            version: paramsVersion,
            onAdd: () => {
              const names = new Set(doc.params.map((p) => p.name));
              let n = doc.params.length + 1;
              while (names.has(`param${n}`)) n++;
              wb.apply({
                kind: 'addParam',
                param: { id: ulid(), name: `param${n}`, expr: '10 mm' },
              });
              wb.commit();
            },
            onUpdate: (paramId, patch, scope) => wb.config.updateParam(paramId, patch, scope),
            onRemove: (paramId) => {
              wb.apply({ kind: 'removeParam', paramId });
              wb.commit();
            },
            usedBy,
            onSelectUse: (use) =>
              void import('./param-actions').then((m) => m.selectParamUse(wb, use)),
            onMake: (name, expr) => wb.makeParameter(name, expr),
            onMakeDone: () => wb.endMakeParameter(),
            density,
          }}
          inspector={<Inspector wb={wb} density={density} measure={measure} section={section} />}
          {...(contextBubble ? { contextBubble } : {})}
          {...(valueChip ? { valueChip } : {})}
          sheetSnap={ui.sheetSnap}
          onSheetHeight={(px) => onSheetHeight(wb, px)}
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
          {...(engineFailed
            ? { exportUnavailable: { step: engineFailed, stl: engineFailed } }
            : {})}
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
              <Suspense fallback={null}>
                <ConfigNotices wb={wb} touch={touch} />
              </Suspense>
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
      </div>
      {ui.drawing !== null && (
        <section
          className="fixed inset-0 z-[var(--z-drawing,35)] bg-bg"
          data-testid="drawing-route"
          aria-label="Drawing"
        >
          <Suspense
            fallback={
              <p className="p-6 text-sm text-fg-muted" role="status">
                Loading the drawing tools…
              </p>
            }
          >
            <DrawingRoute
              wb={wb}
              id={ui.drawing.id}
              tier={diagnostics.tier}
              onClose={() => wb.closeDrawing()}
            />
          </Suspense>
        </section>
      )}
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
