import type { EntityRef, Expr, Feature, FeatureStatus, NamedDimension } from '@whittle/contracts';
import { type ReactNode, useMemo, useState } from 'react';
import {
  CommandBar,
  ConvertPanel,
  DimensionLabel,
  FeatureInspector,
  FeatureTree,
  HoleWizard,
  LinkedEntityPanel,
  OffsetPanel,
  SketchCornerPanel,
  SketchMirrorPanel,
  SketchToolbar,
  type SketchToolId,
  ToolRail,
  TrimExtendPanel,
  tools,
} from '../src';
import { makeEvaluator, sampleParams } from './fixtures';
import { feat, holeTables, m3Features, m3Statuses, r3 } from './m3Fixtures';

type Tier = 'desktop' | 'tablet' | 'phone';
const card = 'w-card w-[296px] overflow-hidden';
const evaluator = makeEvaluator(sampleParams);
const allTools = tools.map((t) => t.id);

const names: Record<string, string> = Object.fromEntries(m3Features.map((f) => [f.id, f.name]));
const status = (id: string): FeatureStatus | undefined =>
  m3Statuses.find((s) => s.featureId === id);

function Inspector({
  feature: initial,
  status: st,
  tier,
  picking: initialPicking = null,
}: {
  feature: Feature;
  status?: FeatureStatus | undefined;
  tier: Tier;
  picking?: string | null;
}) {
  const [feature, setFeature] = useState<Feature>(initial);
  const [picking, setPicking] = useState<string | null>(initialPicking);
  return (
    <FeatureInspector
      feature={feature}
      status={st}
      density={tier === 'desktop' ? 'compact' : 'touch'}
      evaluate={(e: Expr, x: NamedDimension) => evaluator(e, x)}
      onChange={setFeature}
      onPick={setPicking}
      pickingPath={picking}
      describeFeature={(id) => names[id] ?? id}
      holeTables={holeTables}
      onRepick={() => {}}
      onDone={() => {}}
    />
  );
}

function Cards({ tier, items, testId }: { tier: Tier; testId: string; items: ReactNode[] }) {
  const cols = tier === 'desktop' ? 'flex-row flex-wrap' : 'flex-col';
  return (
    <div className={`flex gap-4 p-4 ${cols}`} data-testid={testId}>
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static list
        <div key={`c${i}`} className={card}>
          {it}
        </div>
      ))}
    </div>
  );
}

const loftBad: Feature = {
  ...feat<'loft'>('M8'),
  id: 'L2',
  name: 'Loft 2',
  sections: [r3('SM6:region(e1)', 'region')],
  closed: true,
};

function Features({ tier }: { tier: Tier }) {
  return (
    <Cards
      tier={tier}
      testId="g-m3-features"
      items={[
        <Inspector key="a" tier={tier} feature={feat('M9')} status={status('M9')} />,
        <Inspector key="b" tier={tier} feature={feat('M10')} status={status('M10')} />,
        <Inspector key="c" tier={tier} feature={feat('M5')} status={status('M5')} />,
        <Inspector key="d" tier={tier} feature={feat('M8')} status={status('M8')} />,
        <Inspector key="e" tier={tier} feature={loftBad} />,
        <Inspector
          key="f"
          tier={tier}
          feature={{ ...feat<'shell'>('M9'), id: 'S2', openFaces: [], thickness: '0mm' }}
        />,
      ]}
    />
  );
}

const linearTwo: Feature = {
  ...feat<'linearPattern'>('M14'),
  id: 'P2',
  second: { direction: r3('FM2:edge(e2)', 'edge'), reverse: true, count: '2', spacing: '20mm' },
  skip: [1, 4],
};

function Patterns({ tier }: { tier: Tier }) {
  return (
    <Cards
      tier={tier}
      testId="g-m3-patterns"
      items={[
        <Inspector key="a" tier={tier} feature={feat('M13')} status={status('M13')} />,
        <Inspector key="b" tier={tier} feature={feat('M14')} status={status('M14')} />,
        <Inspector key="c" tier={tier} feature={linearTwo} />,
        <Inspector key="d" tier={tier} feature={feat('M15')} status={status('M15')} />,
        <Inspector key="e" tier={tier} feature={feat('M18')} status={status('M18')} />,
        <Inspector
          key="f"
          tier={tier}
          picking="/source/features"
          feature={{
            ...feat<'mirror'>('M13'),
            id: 'X2',
            source: { kind: 'bodies', bodies: [r3('B1', 'body')], merge: true },
            plane: r3('', 'face'),
          }}
        />,
      ]}
    />
  );
}

const e = (n: string, k: 'face' | 'edge' | 'vertex'): EntityRef => r3(n, k);

function Reference({ tier }: { tier: Tier }) {
  const plane = (id: string, definition: unknown): Feature =>
    ({ id, type: 'plane', name: id, suppressed: false, definition }) as Feature;
  return (
    <Cards
      tier={tier}
      testId="g-m3-reference"
      items={[
        <Inspector
          key="a"
          tier={tier}
          feature={plane('R1', {
            kind: 'threePoints',
            points: [e('P1', 'vertex'), e('P2', 'vertex'), e('', 'vertex')],
          })}
        />,
        <Inspector
          key="b"
          tier={tier}
          feature={
            {
              ...(plane('R2', {
                kind: 'angle',
                from: e('origin:XY', 'face'),
                axis: e('FM2:edge(e1)', 'edge'),
                angle: '30deg',
              }) as Feature),
              flip: true,
            } as Feature
          }
        />,
        <Inspector
          key="c"
          tier={tier}
          feature={plane('R3', {
            kind: 'normalToCurve',
            curve: e('SM4:e1', 'edge'),
            at: { t: '1.5' },
          })}
        />,
        <Inspector
          key="d"
          tier={tier}
          feature={{
            id: 'A2',
            type: 'axis',
            name: 'Axis 2',
            suppressed: false,
            definition: { kind: 'twoPoints', a: e('P1', 'vertex'), b: e('', 'vertex') },
          }}
        />,
        <Inspector key="e" tier={tier} feature={feat('M17')} />,
        <Inspector
          key="f"
          tier={tier}
          feature={{
            id: 'T2',
            type: 'point',
            name: 'Point 2',
            suppressed: false,
            definition: { kind: 'alongEdge', edge: e('FM2:edge(e1)', 'edge'), t: '2' },
          }}
        />,
      ]}
    />
  );
}

function HoleCard({
  tier,
  hole,
  st,
  picking,
}: {
  tier: Tier;
  hole: Feature & { type: 'hole' };
  st?: FeatureStatus | undefined;
  picking?: string | null;
}) {
  const [f, setF] = useState(hole);
  const [pick, setPick] = useState<string | null>(picking ?? null);
  return (
    <HoleWizard
      feature={f}
      tables={[holeTables.ISO, holeTables.ANSI]}
      status={st}
      density={tier === 'desktop' ? 'compact' : 'touch'}
      evaluate={(x: Expr, d: NamedDimension) => evaluator(x, d)}
      onChange={(n) => n.type === 'hole' && setF(n)}
      onPick={setPick}
      pickingPath={pick}
      onDone={() => {}}
    />
  );
}

function HoleSection({ tier }: { tier: Tier }) {
  const base = feat<'hole'>('M12');
  const tapped: Feature & { type: 'hole' } = {
    ...base,
    id: 'H2',
    name: 'Tapped hole',
    kind: 'tapped',
    size: 'M8',
    diameter: '6.9mm',
    end: { kind: 'blind', depth: '16mm' },
    tipAngle: '118deg',
  };
  const csink: Feature & { type: 'hole' } = {
    ...base,
    id: 'H3',
    name: 'Flat-head hole',
    standard: 'ANSI',
    kind: 'countersink',
    size: '1/4',
    fit: 'close',
    end: { kind: 'throughAll' },
  };
  const missing: Feature & { type: 'hole' } = {
    ...base,
    id: 'H4',
    name: 'Hole 4',
    kind: 'simple',
    size: 'M5',
    points: [],
  };
  return (
    <Cards
      tier={tier}
      testId="g-m3-hole"
      items={[
        <HoleCard key="a" tier={tier} hole={base} st={status('M12')} />,
        <HoleCard key="b" tier={tier} hole={tapped} />,
        <HoleCard key="c" tier={tier} hole={csink} />,
        <HoleCard key="d" tier={tier} hole={missing} picking="/points" />,
      ]}
    />
  );
}

function SketchEdit({ tier }: { tier: Tier }) {
  const [tool, setTool] = useState<SketchToolId | null>('offset');
  const touch = tier === 'desktop' ? 'md' : 'touch';
  const ev = useMemo(() => (x: Expr) => evaluator(x, 'length'), []);
  const noop = () => {};
  return (
    <div className="flex w-[min(100vw-32px,760px)] flex-col gap-5 p-4" data-testid="g-m3-sketch">
      <Section title="Toolbar with an edit tool active">
        <div className="flex">
          <SketchToolbar
            layout={tier === 'phone' ? 'rail' : 'bar'}
            density={tier === 'desktop' ? 'compact' : 'touch'}
            activeTool={tool}
            onTool={setTool}
            construction={false}
            onToggleConstruction={noop}
            onFinish={noop}
            shortcuts={false}
          />
        </div>
      </Section>
      <Section title="Offset, convert, trim, corner, mirror">
        <div className="flex flex-wrap items-start gap-4">
          <OffsetPanel
            value="4mm"
            evaluate={ev}
            side="left"
            both={false}
            count={3}
            size={touch}
            onCommit={noop}
            onSide={noop}
            onBoth={noop}
            onApply={noop}
            onCancel={noop}
          />
          <OffsetPanel
            value="oops"
            evaluate={ev}
            side="right"
            both
            count={0}
            size={touch}
            onCommit={noop}
            onSide={noop}
            onBoth={noop}
            onApply={noop}
            onCancel={noop}
          />
          <ConvertPanel
            source="edges"
            count={4}
            approximateCount={1}
            size={touch}
            onSource={noop}
            onApply={noop}
            onCancel={noop}
          />
          <TrimExtendPanel mode="trim" size={touch} onMode={noop} onDone={noop} />
          <SketchCornerPanel
            kind="fillet"
            value="3mm"
            evaluate={ev}
            count={2}
            size={touch}
            onKind={noop}
            onCommit={noop}
            onApply={noop}
            onCancel={noop}
          />
          <SketchMirrorPanel
            count={5}
            axisLabel="Construction line 1"
            phase="axis"
            size={touch}
            onPhase={noop}
            onApply={noop}
            onCancel={noop}
          />
        </div>
      </Section>
      <Section title="Linked geometry: linked, approximate, lost">
        <div className="flex flex-wrap items-start gap-4">
          <LinkedEntityPanel
            state="linked"
            sourceLabel="Edge FM2:top(e1)"
            size={touch}
            onUnlink={noop}
          />
          <LinkedEntityPanel
            state="approximate"
            sourceLabel="Edge FM2:side(e7)"
            count={3}
            size={touch}
            onUnlink={noop}
          />
          <LinkedEntityPanel
            state="lost"
            sourceLabel="Edge FM2:top(e1)"
            size={touch}
            onUnlink={noop}
            onRepick={noop}
          />
        </div>
      </Section>
      <Section title="Offset dimension">
        <div className="relative h-16 rounded-panel bg-gradient-to-b from-viewport-top to-viewport-bottom">
          <DimensionLabel x={90} y={32} kind="offset" expr="4mm" driving evaluate={ev} />
          <DimensionLabel x={230} y={32} kind="offset" expr="" driving={false} measured="4" />
          <DimensionLabel x={370} y={32} kind="offset" expr="4mm" driving evaluate={ev} selected />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-2xs font-semibold tracking-wider text-fg-muted uppercase">{title}</h2>
      {children}
    </section>
  );
}

function TreeSection({ tier }: { tier: Tier }) {
  const density = tier === 'desktop' ? 'compact' : 'touch';
  return (
    <Cards
      tier={tier}
      testId="g-m3-tree"
      items={[
        <FeatureTree
          key="a"
          density={density}
          features={m3Features}
          statuses={m3Statuses}
          selectedId="M9"
          onRollback={() => {}}
          onMove={() => ({ ok: true })}
        />,
        <FeatureTree
          key="b"
          density={density}
          features={m3Features}
          statuses={m3Statuses}
          nestSketches={false}
          onRollback={() => {}}
          onMove={() => ({ ok: true })}
        />,
      ]}
    />
  );
}

function BarSection({ tier }: { tier: Tier }) {
  return (
    <div className="relative h-[560px] w-[min(100vw-16px,720px)] p-4" data-testid="g-m3-bar">
      {tier === 'desktop' ? (
        <div className="absolute bottom-6 left-6">
          <CommandBar enabledTools={allTools} />
        </div>
      ) : (
        <ToolRail
          className="absolute top-4 left-4"
          enabledTools={allTools}
          activeTool={tier === 'tablet' ? 'axis' : null}
        />
      )}
    </div>
  );
}

export function M3Gallery({ section, tier }: { section: string; tier: Tier }) {
  switch (section) {
    case 'm3-features':
      return <Features tier={tier} />;
    case 'm3-patterns':
      return <Patterns tier={tier} />;
    case 'm3-reference':
      return <Reference tier={tier} />;
    case 'm3-hole':
      return <HoleSection tier={tier} />;
    case 'm3-sketch':
      return <SketchEdit tier={tier} />;
    case 'm3-tree':
      return <TreeSection tier={tier} />;
    case 'm3-bar':
      return <BarSection tier={tier} />;
    default:
      return null;
  }
}
