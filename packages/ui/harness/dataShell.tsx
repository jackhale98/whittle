import type { DeviceTier, Expr, Feature, Id, KernelStatus } from '@wren-cad/contracts';
import { ArrowUpFromLine, EyeOff, PenLine, Trash2 } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import {
  AppShell,
  bracketTutorial,
  ConfigurationPill,
  type ExportRequest,
  FeatureInspector,
  type Measurement,
  type MoveResult,
  PartInspector,
  type SectionAxis,
  SelectionInspector,
  type SheetSnap,
  type ThemeSetting,
  type ToolId,
  useTutorial,
} from '../src';
import { configColumns, configDefault, configRows, configSummaries } from './configFixtures';
import {
  makeEvaluator,
  sampleFeatures,
  sampleLibrary,
  sampleParams,
  sampleStatuses,
} from './fixtures';

const q = new URLSearchParams(location.search);
// M3.7: the table is a lazy chunk in the app too.
const ConfigurationTable = lazy(() => import('../src/config/ConfigurationTable'));
const pt = (key: string): { x: number; y: number } | null => {
  const v = q.get(key);
  if (!v) return null;
  const [x, y] = v.split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: x as number, y: y as number } : null;
};

const sampleMeasurements: Measurement[] = [
  { length: 60 },
  { angle: Math.PI / 2 },
  { distance: { value: 42.5, a: [0, 0, 0], b: [30, 25.5, 17] } },
];

declare global {
  interface Window {
    __harness?: { advance(id?: string): void; state(): unknown };
  }
}

/** The shells wired to sample data, the way apps/web will wire them to the store. */
export function DataShell({
  tier,
  theme,
  status,
  viewport,
  inspector: which,
}: {
  tier: DeviceTier;
  theme: ThemeSetting;
  status: KernelStatus;
  viewport: React.ReactNode;
  inspector: string;
}) {
  const [features, setFeatures] = useState<Feature[]>(sampleFeatures);
  const [params, setParams] = useState(sampleParams);
  const [selected, setSelected] = useState<Id | null>(which === 'part' ? null : 'F2');
  const [rollback, setRollback] = useState(5);
  const [tool, setTool] = useState<ToolId | null>(null);
  const [exported, setExported] = useState<ExportRequest | null>(null);
  const evaluate = useMemo(() => makeEvaluator(params), [params]);
  const feature = features.find((f) => f.id === selected);
  const touch = tier === 'desktop' ? 'compact' : 'touch';
  /** `cfg=default|long|panel`: the configuration pill (and the table panel) in the top bar. */
  const cfgMode = q.get('cfg');

  // M2 touch state, switched on by query params so every state has a stable URL for screenshots.
  const [snap, setSnap] = useState<SheetSnap>((q.get('sheet') as SheetSnap | null) ?? 'peek');
  const [measureUnits, setMeasureUnits] = useState<'mm' | 'in'>('mm');
  const [section, setSection] = useState({
    enabled: true,
    axis: 'x' as SectionAxis,
    offset: 12,
    flipped: false,
  });
  const [targets, setTargets] = useState([
    { id: 't1', label: 'Face · Top', kind: 'face' as const },
    { id: 't2', label: 'Edge 4', kind: 'edge' as const },
  ]);
  const [parts, setParts] = useState([
    { id: 'B1', name: 'Bracket', visible: true, color: '#c9ced6' },
    { id: 'B2', name: 'Mounting plate', visible: false, color: '#d9a066' },
  ]);
  const [chipValue, setChipValue] = useState('12.5mm');
  const [selPart, setSelPart] = useState<string | null>('B1');
  const bubbleAnchor = pt('bubble');
  const tutorial = useTutorial(bracketTutorial);
  window.__harness = { advance: (id) => tutorial.advance(id), state: () => tutorial.state };

  const move = (id: Id, to: number): MoveResult => {
    const from = features.findIndex((f) => f.id === id);
    const f = features[from];
    if (f && (f.type === 'fillet' || f.type === 'chamfer') && to < 2)
      return { ok: false, reason: `${f.name} needs Extrude 1 above it.` };
    const next = [...features];
    const [it] = next.splice(from, 1);
    if (it) next.splice(to, 0, it);
    setFeatures(next);
    return { ok: true };
  };

  const inspector =
    which === 'none' ? undefined : which === 'part' || !feature ? (
      <PartInspector
        part={{
          name: 'Bracket',
          material: {
            libraryId: 'whittle:al-6061',
            name: 'Aluminium 6061-T6',
            density: '2.70 g/cm^3',
            appearance: '#c9ced6',
          },
        }}
        library={sampleLibrary}
        evaluate={(e: Expr) => evaluate(e, 'density')}
        mass={{ volume: 31_250, area: 8_420.5, mass: 0.0843, centroid: [30.125, 20, 6.5] }}
        onSetMaterial={() => {}}
        density={touch}
      />
    ) : which === 'selection' ? (
      <SelectionInspector selection={{ kind: 'none' }} />
    ) : (
      <FeatureInspector
        feature={feature}
        status={sampleStatuses.find((s) => s.featureId === feature.id)}
        evaluate={(e, x) => evaluate(e, x)}
        onChange={(f) => setFeatures((fs) => fs.map((x) => (x.id === f.id ? f : x)))}
        density={touch}
      />
    );

  return (
    <>
      <AppShell
        tier={tier}
        theme={theme}
        documentName="Untitled bracket"
        kernelStatus={status}
        viewport={viewport}
        {...(cfgMode
          ? {
              configurationBar: (
                <ConfigurationPill
                  variant={tier === 'phone' ? 'chip' : 'bar'}
                  size={tier === 'desktop' ? 'md' : 'touch'}
                  configurations={configSummaries}
                  activeId={cfgMode === 'default' ? null : 'c-long'}
                  defaultStatus="ok"
                  onSwitch={() => {}}
                  onCreate={() => {}}
                  onManage={() => {}}
                />
              ),
            }
          : {})}
        {...(cfgMode === 'panel' && tier !== 'phone'
          ? {
              configurationPanel: (
                <section
                  aria-label="Configurations"
                  data-testid="configuration-panel"
                  className="w-card pointer-events-auto flex max-h-full min-h-0 w-full flex-col overflow-hidden rounded-[14px] shadow-float"
                >
                  <h2 className="border-b border-border px-3 py-1.5 text-sm font-semibold">
                    Configurations
                  </h2>
                  <div className="min-h-0 flex-1 overflow-auto">
                    <Suspense fallback={null}>
                      <ConfigurationTable
                        columns={configColumns}
                        rows={configRows}
                        defaultRow={configDefault}
                        activeId="c-long"
                        size={tier === 'desktop' ? 'md' : 'touch'}
                        maxHeight="min(50vh, 28rem)"
                        onEdit={() => {}}
                        onPaste={() => {}}
                      />
                    </Suspense>
                  </div>
                </section>
              ),
            }
          : {})}
        featureTree={{
          features,
          statuses: sampleStatuses,
          rollbackIndex: rollback,
          selectedId: selected,
          onSelect: setSelected,
          onRollback: setRollback,
          onMove: move,
          onRename: (id, name) =>
            setFeatures((fs) => fs.map((f) => (f.id === id ? { ...f, name } : f))),
          onSuppress: (id, suppressed) =>
            setFeatures((fs) => fs.map((f) => (f.id === id ? { ...f, suppressed } : f))),
          onDelete: (id) => setFeatures((fs) => fs.filter((f) => f.id !== id)),
        }}
        paramsTable={{
          params,
          evaluate: (e) => evaluate(e),
          onAdd: () =>
            setParams((p) => [
              ...p,
              { id: `P${p.length + 1}`, name: `param${p.length + 1}`, expr: '10mm' },
            ]),
          onUpdate: (id, patch) =>
            setParams((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p))),
          onRemove: (id) => setParams((ps) => ps.filter((p) => p.id !== id)),
        }}
        inspector={inspector}
        enabledTools={['sketch', 'extrude', 'revolve', 'fillet', 'chamfer']}
        activeTool={tool}
        onTool={setTool}
        onExportRequest={setExported}
        exportBodies={[{ id: 'B1', name: 'Bracket' }]}
        exportUnavailable={{ '3mf': 'Coming soon' }}
        sheetSnap={snap}
        onSheetSnapChange={setSnap}
        contextBubble={
          bubbleAnchor
            ? {
                anchor: bubbleAnchor,
                label: 'Face actions',
                actions: [
                  {
                    id: 'sketch',
                    label: 'Sketch',
                    icon: <PenLine className="size-5" strokeWidth={1.7} />,
                    onSelect: () => setTool('sketch'),
                  },
                  {
                    id: 'extrude',
                    label: 'Extrude',
                    icon: <ArrowUpFromLine className="size-5" strokeWidth={1.7} />,
                    onSelect: () => setTool('extrude'),
                  },
                  {
                    id: 'hide',
                    label: 'Hide',
                    icon: <EyeOff className="size-5" strokeWidth={1.7} />,
                    onSelect: () => {},
                  },
                  {
                    id: 'delete',
                    label: 'Delete',
                    tone: 'danger',
                    icon: <Trash2 className="size-5" strokeWidth={1.7} />,
                    onSelect: () => {},
                  },
                ],
              }
            : undefined
        }
        valueChip={
          pt('chip')
            ? {
                point: pt('chip'),
                value: chipValue,
                display: chipValue.replace(/(\d)mm$/, '$1 mm'),
                label: 'Distance',
                dragging: q.get('chipstate') === 'drag',
                evaluate: (e) => evaluate(e, 'length'),
                unitHint: 'mm',
                onCommit: setChipValue,
              }
            : undefined
        }
        parts={{
          parts,
          selectedId: selPart,
          onSelect: setSelPart,
          onToggleVisible: (id, visible) =>
            setParts((ps) => ps.map((p) => (p.id === id ? { ...p, visible } : p))),
        }}
        measure={{
          measurements: sampleMeasurements,
          targets,
          units: measureUnits,
          onUnitsChange: setMeasureUnits,
          onRemoveTarget: (id) => setTargets((ts) => ts.filter((t) => t.id !== id)),
          onClear: () => setTargets([]),
        }}
        section={{
          ...section,
          onEnabledChange: (enabled) => setSection((s) => ({ ...s, enabled })),
          onAxisChange: (axis) => setSection((s) => ({ ...s, axis })),
          faceLabel: 'Face · Top',
          onPickFace: () => {},
          range: { min: 0, max: 60 },
          onOffsetChange: (offset) => setSection((s) => ({ ...s, offset })),
          onFlippedChange: (flipped) => setSection((s) => ({ ...s, flipped })),
        }}
        tutorial={
          q.get('tutorial')
            ? {
                steps: bracketTutorial,
                state: tutorial.state,
                title: 'Make a bracket',
                onSkip: tutorial.skip,
                onBack: tutorial.back,
              }
            : undefined
        }
        diagnostics={undefined}
        onUndo={() => {}}
        onRedo={() => {}}
      />
      <output hidden data-testid="last-export">
        {exported ? JSON.stringify(exported) : ''}
      </output>
    </>
  );
}
