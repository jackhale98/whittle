import {
  DEFAULT_NAVIGATION,
  type Feature,
  type FeatureStatus,
  type NavigationOptions,
  type SketchConflict,
} from '@wren-cad/contracts';
import { Eraser, Layers, MousePointer2, PenLine, Ruler, Scissors } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import {
  ConflictPanel,
  ConstraintGlyph,
  DEFAULT_COMMANDS,
  DimensionAnnotation,
  DimensionLabel,
  FeatureInspector,
  FeatureLineage,
  FeatureTree,
  type KeymapContext,
  KeymapEditor,
  type KeymapOverrides,
  NavigationSettings,
  type PickCandidate,
  type Platform,
  RadialMenu,
  type RadialMenuProps,
  resolveKeymap,
  SelectionInspector,
  ShortcutOverlay,
  SketchToolbar,
  type SketchToolId,
  useModifierHold,
  WhichOneChooser,
} from '../src';
import { makeEvaluator, sampleParams } from './fixtures';

type Tier = 'desktop' | 'tablet' | 'phone';
const q = () => new URLSearchParams(location.search);
const evaluator = makeEvaluator(sampleParams);

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-2xs font-semibold tracking-wider text-fg-muted uppercase">{title}</h2>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------------- radial menu */

const icon = 'size-4';
const radialItems: RadialMenuProps['items'] = [
  { id: 'extrude', label: 'Extrude', icon: <Layers className={icon} /> },
  { id: 'sketch', label: 'Sketch', icon: <PenLine className={icon} /> },
  { id: 'measure', label: 'Measure', icon: <Ruler className={icon} /> },
  { id: 'hide', label: 'Hide', icon: <Eraser className={icon} /> },
  { id: 'cut', label: 'Cut', icon: <Scissors className={icon} />, disabled: true },
];

function Backdrop({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-gradient-to-b from-viewport-top to-viewport-bottom p-6 text-center text-ui text-fg-muted">
      {children}
    </div>
  );
}

/** Static states for the baselines: the menu is open at once (drawDelay 0). */
function RadialStatic() {
  const state = q().get('state') ?? 'open';
  const w = window.innerWidth;
  const h = window.innerHeight;
  const at = state === 'edge' ? { x: 6, y: 6 } : { x: w / 2, y: h / 2 };
  const common = { items: radialItems, onSelect: () => {}, onCancel: () => {} };
  return (
    <Backdrop>
      <p>Right-click opens the radial menu at the cursor.</p>
      {state === 'touch' ? (
        <RadialMenu {...common} at={at} repeat={{ label: 'Sketch' }} source="touch" />
      ) : state === 'norepeat' ? (
        <RadialMenu {...common} at={at} repeat={null} drawDelay={0} />
      ) : state === 'repeat-disabled' ? (
        <RadialMenu
          {...common}
          at={at}
          repeat={{ label: 'nothing yet', disabled: true }}
          drawDelay={0}
        />
      ) : (
        <RadialMenu {...common} at={at} repeat={{ label: 'Sketch' }} drawDelay={0} />
      )}
    </Backdrop>
  );
}

/** Live surface for the E2E: a right click opens the menu; selections are logged. */
function RadialLive() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [last, setLast] = useState<string | null>(null);
  return (
    <Backdrop>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a stand-in for the canvas, which is pointer-driven */}
      <div
        role="application"
        aria-label="Canvas stand-in"
        data-testid="radial-surface"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onClick={() => setLog((l) => [...l, 'canvas click'])}
        className="flex h-64 w-[min(100vw-32px,520px)] items-center justify-center rounded-panel bg-surface/70 shadow-pop"
      >
        <span className="inline-flex items-center gap-2">
          <MousePointer2 className="size-4" aria-hidden /> Right-click here
        </span>
      </div>
      <p data-testid="radial-last">last command: {last ?? 'none'}</p>
      <ol data-testid="radial-log" className="m-0 list-none p-0 text-xs">
        {log.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log
          <li key={i}>{l}</li>
        ))}
      </ol>
      {menu ? (
        <RadialMenu
          at={menu}
          items={radialItems}
          repeat={last ? { label: last } : null}
          onSelect={(id) => {
            setLog((l) => [...l, `select ${id}`]);
            if (id !== 'repeat') setLast(id);
            setMenu(null);
          }}
          onCancel={() => {
            setLog((l) => [...l, 'cancel']);
            setMenu(null);
          }}
        />
      ) : null}
    </Backdrop>
  );
}

/* ------------------------------------------------------------------------- which one */

const candidates: PickCandidate[] = [
  { id: 'f1', kind: 'face', label: 'Top face', detail: 'Planar · 412 mm²', depth: 40 },
  { id: 'e2', kind: 'edge', label: 'Edge of Extrude 1', detail: '60 mm', depth: 42 },
  { id: 'v1', kind: 'vertex', label: 'Corner', detail: 'Extrude 1', depth: 42 },
  { id: 'e1', kind: 'edge', label: 'Edge of Fillet 1', detail: '12 mm', depth: 38 },
  { id: 'b1', kind: 'body', label: 'Body 1', depth: 90 },
];

function ChooserSection() {
  const [hover, setHover] = useState<string | null>(null);
  const touch = q().get('state') === 'touch';
  const at = useMemo(
    () => ({ x: window.innerWidth / 2 - 128, y: window.innerHeight / 2 - 120 }),
    [],
  );
  return (
    <Backdrop>
      <p data-testid="preselect">preselected: {hover ?? 'none'}</p>
      <WhichOneChooser
        candidates={candidates}
        at={at}
        onPick={() => {}}
        onHover={setHover}
        onDismiss={() => {}}
        size={touch ? 'touch' : 'md'}
      />
    </Backdrop>
  );
}

/* ------------------------------------------------------------------------- keymap */

const editorCommands = DEFAULT_COMMANDS.filter(
  (c) =>
    c.group === 'General' ||
    c.id.startsWith('sketch:s') ||
    c.id === 'tool:extrude' ||
    c.id === 'tool:fillet',
);

function KeymapSection() {
  const [o, setO] = useState<KeymapOverrides>({});
  const platform = (q().get('platform') ?? 'win') as Platform;
  return (
    <div className="w-[min(100vw-24px,560px)] p-4" data-testid="g-m35-keymap">
      <KeymapEditor
        commands={editorCommands}
        overrides={o}
        onChange={setO}
        platform={platform}
        size={window.innerWidth < 600 ? 'touch' : 'md'}
      />
    </div>
  );
}

function OverlaySection() {
  const contexts: KeymapContext[] =
    q().get('state') === 'model' ? ['model', 'global'] : ['sketch', 'global'];
  const forced = q().get('forced') === '1';
  const hold = useModifierHold();
  const resolved = resolveKeymap(DEFAULT_COMMANDS);
  return (
    <Backdrop>
      <p>Hold Ctrl, Cmd or Alt for 600 ms.</p>
      <ShortcutOverlay
        commands={DEFAULT_COMMANDS}
        resolved={resolved}
        contexts={contexts}
        visible={forced || hold.visible}
        held={forced ? 'mod' : hold.held}
        platform="win"
      />
    </Backdrop>
  );
}

/* ------------------------------------------------------------------------- navigation */

function NavSection() {
  const custom = q().get('state') === 'custom';
  const [v, setV] = useState<NavigationOptions>(
    custom
      ? {
          ...DEFAULT_NAVIGATION,
          preset: 'middleOrbit',
          orbit: 'trackball',
          invertZoom: true,
          rotateSpeed: 2,
        }
      : DEFAULT_NAVIGATION,
  );
  return (
    <div
      className="w-card w-[min(100vw-24px,340px)] overflow-hidden rounded-panel"
      data-testid="g-m35-nav"
    >
      <NavigationSettings
        value={v}
        onChange={setV}
        size={window.innerWidth < 600 ? 'touch' : 'md'}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- errors at cause */

const names: Record<string, string> = { X1: 'Extrude 1', F2: 'Fillet 2', S0: 'Sketch 1' };
const feats = [
  { id: 'S0', type: 'sketch', name: 'Sketch 1', suppressed: false },
  { id: 'X1', type: 'extrude', name: 'Extrude 1', suppressed: false },
  { id: 'F2', type: 'fillet', name: 'Fillet 2', suppressed: false },
  { id: 'C3', type: 'chamfer', name: 'Chamfer 3', suppressed: false },
  { id: 'H4', type: 'hole', name: 'Hole 4', suppressed: false },
] as const;
const fillet: Feature = {
  id: 'F2',
  type: 'fillet',
  name: 'Fillet 2',
  suppressed: false,
  edges: [{ name: 'X1:side(S0:e3)', kind: 'edge' }],
  radius: '2mm',
} as Feature;

const causeStatuses: FeatureStatus[] = [
  {
    featureId: 'F2',
    state: 'needsAttention',
    cached: false,
    ms: 2,
    unresolved: [
      {
        path: '/edges/0',
        ref: { name: 'X1:side(S0:e3)', kind: 'edge' },
        reason: 'missing',
        cause: { featureId: 'X1', kind: 'changed', detail: 'depth 10 → 4 mm' },
      },
    ],
  },
  {
    featureId: 'C3',
    state: 'error',
    cached: false,
    ms: 2,
    error: { code: 'INTERNAL', message: 'The chamfer is larger than the edge.' },
    cause: { featureId: 'X1', kind: 'changed' },
  },
  {
    featureId: 'H4',
    state: 'blocked',
    cached: false,
    ms: 0,
    cause: { featureId: 'C3', kind: 'failed' },
  },
];

function ErrorsSection({ tier }: { tier: Tier }) {
  const [selected, setSelected] = useState<string | null>('F2');
  return (
    <div className="flex flex-col gap-4 p-4 md:flex-row" data-testid="g-m35-errors">
      <div className="w-card w-[min(100vw-32px,320px)] overflow-hidden rounded-panel">
        <FeatureTree
          features={feats}
          statuses={causeStatuses}
          selectedId={selected}
          onSelect={setSelected}
          density={tier === 'desktop' ? 'compact' : 'touch'}
        />
      </div>
      <div className="w-card w-[min(100vw-32px,320px)] overflow-hidden rounded-panel">
        <FeatureInspector
          feature={fillet}
          status={causeStatuses[0]}
          evaluate={(e, x) => evaluator(e, x)}
          onChange={() => {}}
          describeFeature={(id) => names[id] ?? id}
          onSelectFeature={setSelected}
          density={tier === 'desktop' ? 'compact' : 'touch'}
        />
      </div>
      <p data-testid="selected-feature" className="text-xs text-fg-muted">
        selected: {selected ?? 'none'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------- sketch */

const conflicts: SketchConflict[] = [
  {
    constraints: ['C3', 'C7'],
    entities: ['L2', 'L1'],
    explanation: 'Line 2 can’t be both horizontal and at 30° to Line 1.',
    fixes: [
      {
        label: 'Remove “Angle 30° (Line 1, Line 2)”',
        action: { kind: 'removeConstraint', constraint: 'C7' },
      },
      {
        label: 'Make it a reference dimension',
        action: { kind: 'makeReference', constraint: 'C7' },
      },
    ],
  },
  {
    kind: 'unsupported',
    constraints: ['C9'],
    entities: ['S1', 'L2'],
    explanation: 'Curvature between Spline 1 and Line 2 cannot be solved yet.',
    fixes: [
      {
        label: 'Remove “Curvature (Spline 1, Line 2)”',
        action: { kind: 'removeConstraint', constraint: 'C9' },
      },
    ],
  },
];
const cNames: Record<string, string> = {
  C3: 'Horizontal on Line 2',
  C7: 'Angle 30° (Line 1, Line 2)',
  C9: 'Curvature (Spline 1, Line 2)',
};
const eNames: Record<string, string> = { L1: 'Line 1', L2: 'Line 2', S1: 'Spline 1' };

function SketchSection({ tier }: { tier: Tier }) {
  const [tool, setTool] = useState<SketchToolId | null>('splineThrough');
  const [highlight, setHighlight] = useState<string>('none');
  return (
    <div className="flex w-[min(100vw-32px,760px)] flex-col gap-5 p-4" data-testid="g-m35-sketch">
      <Block title="Toolbar with a curve tool active (Curves menu)">
        <div className="flex">
          <SketchToolbar
            layout={tier === 'phone' ? 'rail' : 'bar'}
            density={tier === 'desktop' ? 'compact' : 'touch'}
            activeTool={tool}
            onTool={setTool}
            construction={false}
            onToggleConstruction={() => {}}
            onFinish={() => {}}
            shortcuts
          />
        </div>
      </Block>
      <Block title="Tangent (G1) and curvature (G2)">
        <div className="flex flex-wrap items-center gap-4">
          {(['tangent', 'curvature'] as const).flatMap((k) =>
            (['placed', 'hint', 'selected', 'conflict', 'plain'] as const).map((tone) => (
              <ConstraintGlyph key={`${k}-${tone}`} kind={k} tone={tone} size={32} labelled />
            )),
          )}
        </div>
      </Block>
      <Block title="Conflicts">
        <div className="flex">
          <ConflictPanel
            conflicts={conflicts}
            constraintName={(id) => cNames[id]}
            entityName={(id) => eNames[id]}
            onFix={() => {}}
            onHighlight={(ids) => setHighlight(ids ? ids.join(',') : 'none')}
          />
        </div>
        <p data-testid="highlight" className="text-xs text-fg-muted">
          highlighted: {highlight}
        </p>
      </Block>
    </div>
  );
}

/* ------------------------------------------------------------------------- dimensions */

const linear = {
  extensions: [
    { a: { x: 40, y: 150 }, b: { x: 40, y: 60 } },
    { a: { x: 240, y: 150 }, b: { x: 240, y: 60 } },
  ],
  line: { a: { x: 40, y: 70 }, b: { x: 240, y: 70 } },
  arrows: [
    { tip: { x: 40, y: 70 }, dir: { x: -1, y: 0 } },
    { tip: { x: 240, y: 70 }, dir: { x: 1, y: 0 } },
  ],
};

function DimStage({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <figure className="m-0 flex flex-col gap-1" data-testid={testId}>
      <figcaption className="text-2xs text-fg-muted">{title}</figcaption>
      <div className="relative h-44 w-[280px] rounded-panel bg-surface shadow-[inset_0_0_0_1px_var(--color-border)]">
        {children}
      </div>
    </figure>
  );
}

function DimSection() {
  const [pos, setPos] = useState({ x: 140, y: 70 });
  return (
    <div className="flex flex-wrap gap-4 p-4" data-testid="g-m35-dim">
      {(['rest', 'hover', 'selected', 'conflict'] as const).map((st) => (
        <DimStage key={st} title={`Linear, ${st}`}>
          <DimensionAnnotation
            geometry={linear}
            hovered={st === 'hover'}
            selected={st === 'selected'}
            conflicting={st === 'conflict'}
          />
          <DimensionLabel
            x={140}
            y={70}
            kind="length"
            expr="40mm"
            driving
            evaluate={(e) => evaluator(e, 'length')}
          />
        </DimStage>
      ))}
      <DimStage title="Reference (dashed)">
        <DimensionAnnotation geometry={linear} driving={false} />
        <DimensionLabel x={140} y={70} kind="length" expr="40mm" driving={false} measured="40" />
      </DimStage>
      <DimStage title="Radius leader">
        <DimensionAnnotation
          geometry={{
            leader: { a: { x: 140, y: 100 }, b: { x: 210, y: 40 } },
            arrows: [{ tip: { x: 140, y: 100 }, dir: { x: -1, y: 1 } }],
          }}
        />
        <DimensionLabel
          x={225}
          y={32}
          kind="radius"
          expr="12mm"
          driving
          evaluate={(e) => evaluator(e, 'length')}
        />
      </DimStage>
      <DimStage title="Angle arc">
        <DimensionAnnotation
          geometry={{
            extensions: [
              { a: { x: 40, y: 140 }, b: { x: 230, y: 140 } },
              { a: { x: 40, y: 140 }, b: { x: 190, y: 40 } },
            ],
            arc: { center: { x: 40, y: 140 }, radius: 90, start: -0.58, end: 0 },
          }}
        />
        <DimensionLabel
          x={150}
          y={105}
          kind="angle"
          expr="30deg"
          driving
          evaluate={(e) => evaluator(e, 'angle')}
        />
      </DimStage>
      <DimStage title="Draggable label (drag me)" testId="dim-drag-stage">
        <DimensionAnnotation geometry={linear} />
        <DimensionLabel
          x={pos.x}
          y={pos.y}
          kind="length"
          expr="40mm"
          driving
          evaluate={(e) => evaluator(e, 'length')}
          onMove={(x, y) => setPos({ x, y })}
        />
        <p data-testid="dim-pos" className="absolute bottom-1 left-2 text-2xs text-fg-muted">
          {Math.round(pos.x)},{Math.round(pos.y)}
        </p>
      </DimStage>
    </div>
  );
}

/* ------------------------------------------------------------------------- lineage */

function LineageSection({ tier }: { tier: Tier }) {
  const [log, setLog] = useState('none');
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4 p-4 md:flex-row" data-testid="g-m35-lineage">
      <div className="w-card w-[min(100vw-32px,300px)] overflow-hidden rounded-panel">
        <SelectionInspector
          selection={{ kind: 'face', count: 1, label: 'Top face of Extrude 1' }}
          lineage={{
            madeBy: { id: 'X1', name: 'Extrude 1' },
            sketch: { id: 'S0', name: 'Sketch 1' },
          }}
          onEditFeature={(id) => setLog(`edit ${id}`)}
        />
      </div>
      <div className="w-card w-[min(100vw-32px,300px)] overflow-hidden rounded-panel">
        <FeatureTree
          features={feats}
          selectedId="X1"
          nestSketches={false}
          lineage={{ parents: ['S0'], children: ['F2', 'C3'] }}
          density={tier === 'desktop' ? 'compact' : 'touch'}
        />
        <FeatureLineage
          parents={[{ id: 'S0', name: 'Sketch 1' }]}
          dependents={[
            { id: 'F2', name: 'Fillet 2' },
            { id: 'C3', name: 'Chamfer 3' },
          ]}
          onSelect={(id) => setLog(`select ${id}`)}
          onHover={setHover}
        />
      </div>
      <p data-testid="lineage-log" className="text-xs text-fg-muted">
        {log} / hover {hover ?? 'none'}
      </p>
    </div>
  );
}

export function M35Gallery({ section, tier }: { section: string; tier: Tier }) {
  switch (section) {
    case 'm35-radial':
      return <RadialStatic />;
    case 'm35-radial-live':
      return <RadialLive />;
    case 'm35-chooser':
      return <ChooserSection />;
    case 'm35-keymap':
      return <KeymapSection />;
    case 'm35-overlay':
      return <OverlaySection />;
    case 'm35-nav':
      return <NavSection />;
    case 'm35-errors':
      return <ErrorsSection tier={tier} />;
    case 'm35-sketch':
      return <SketchSection tier={tier} />;
    case 'm35-dim':
      return <DimSection />;
    case 'm35-lineage':
      return <LineageSection tier={tier} />;
    default:
      return null;
  }
}
