import type {
  Expr,
  Feature,
  FeatureStatus,
  Id,
  Material,
  NamedDimension,
  Param,
} from '@wren-cad/contracts';
import { domAnimation, LazyMotion } from 'motion/react';
import { type ReactNode, useMemo, useState } from 'react';
import {
  ConflictPanel,
  ConstraintGlyph,
  constraintLabels,
  DimensionLabel,
  dimensionKinds,
  ExportMenu,
  type ExportRequest,
  ExpressionInput,
  FeatureInspector,
  FeatureTree,
  geometricConstraintKinds,
  type MoveResult,
  ParamNamesContext,
  ParamsTable,
  PartInspector,
  PromptChip,
  SelectionInspector,
  SketchStatusChip,
  SketchToolbar,
  type SketchToolId,
  type ThemeSetting,
  TooltipProvider,
  useTheme,
  WhichOneChooser,
} from '../src';
import {
  extrudeSample,
  filletSample,
  makeEvaluator,
  nestedFeatures,
  sampleConflicts,
  sampleFeatures,
  sampleLibrary,
  sampleParams,
  sampleStatuses,
} from './fixtures';
import { M3Gallery } from './m3Gallery';
import { M35Gallery } from './m35Gallery';
import { M36Gallery } from './m36Gallery';
import { M37Gallery } from './m37Gallery';
import { ParamsGallery } from './paramsGallery';
import { SectionGallery } from './sectionGallery';
import { SyncGallery } from './syncGallery';

type Tier = 'desktop' | 'tablet' | 'phone';

const card = 'w-card w-[296px] overflow-hidden';

/* ------------------------------------------------------------------------- stateful bits */

export function useSampleDoc() {
  const [params, setParams] = useState<Param[]>(sampleParams);
  const evaluate = useMemo(() => makeEvaluator(params), [params]);
  return { params, setParams, evaluate };
}

export function StatefulTree({ density }: { density?: 'compact' | 'touch' }) {
  const [features, setFeatures] = useState(sampleFeatures);
  const [rollback, setRollback] = useState(5);
  const [selected, setSelected] = useState<Id | null>('F2');
  const move = (id: Id, to: number): MoveResult => {
    const from = features.findIndex((f) => f.id === id);
    const f = features[from];
    // A fillet / chamfer cannot move above the solid it rounds.
    if (f && (f.type === 'fillet' || f.type === 'chamfer') && to < 2)
      return {
        ok: false,
        reason: `${f.name} needs Extrude 1 above it, so it can’t move up there.`,
      };
    const next = [...features];
    const [item] = next.splice(from, 1);
    if (item) next.splice(to, 0, item);
    setFeatures(next);
    return { ok: true };
  };
  return (
    <FeatureTree
      density={density}
      features={features}
      statuses={sampleStatuses}
      rollbackIndex={rollback}
      selectedId={selected}
      onSelect={setSelected}
      onRollback={setRollback}
      onMove={move}
      onRename={(id, name) =>
        setFeatures((fs) => fs.map((f) => (f.id === id ? { ...f, name } : f)))
      }
      onSuppress={(id, suppressed) =>
        setFeatures((fs) => fs.map((f) => (f.id === id ? { ...f, suppressed } : f)))
      }
      onDelete={(id) => setFeatures((fs) => fs.filter((f) => f.id !== id))}
      onEdit={setSelected}
    />
  );
}

export function StatefulParams({ density }: { density?: 'compact' | 'touch' }) {
  const { params, setParams, evaluate } = useSampleDoc();
  return (
    <ParamsTable
      density={density}
      params={params}
      evaluate={(e: Expr) => evaluate(e)}
      usage={{ P1: 2 }}
      onAdd={() =>
        setParams((p) => [
          ...p,
          { id: `P${p.length + 1}`, name: `param${p.length + 1}`, expr: '10mm' },
        ])
      }
      onUpdate={(id, patch) =>
        setParams((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))
      }
      onRemove={(id) => setParams((ps) => ps.filter((p) => p.id !== id))}
      onMove={(id, to) => {
        setParams((ps) => {
          const from = ps.findIndex((p) => p.id === id);
          const next = [...ps];
          const [it] = next.splice(from, 1);
          if (it) next.splice(to, 0, it);
          return next;
        });
        return { ok: true };
      }}
    />
  );
}

function StatefulInspector({
  feature: initial,
  status,
  tier,
}: {
  feature: Feature;
  status?: FeatureStatus;
  tier: Tier;
}) {
  const [feature, setFeature] = useState<Feature>(initial);
  const { evaluate } = useSampleDoc();
  const [picking, setPicking] = useState<string | null>(null);
  return (
    <FeatureInspector
      feature={feature}
      status={status}
      density={tier === 'desktop' ? 'compact' : 'touch'}
      evaluate={(e: Expr, x: NamedDimension) => evaluate(e, x)}
      onChange={setFeature}
      onPick={setPicking}
      pickingPath={picking}
      onEditSketch={() => {}}
      onDone={() => {}}
    />
  );
}

function StatefulPart({ tier, material }: { tier: Tier; material?: Material }) {
  const [mat, setMat] = useState<Material | undefined>(material);
  const { evaluate } = useSampleDoc();
  return (
    <PartInspector
      part={{ name: 'Bracket', material: mat }}
      library={sampleLibrary}
      density={tier === 'desktop' ? 'compact' : 'touch'}
      evaluate={(e) => evaluate(e, 'density')}
      mass={{
        volume: 31_250,
        area: 8_420.5,
        mass: mat ? 0.0843 : undefined,
        centroid: [30.125, 20, 6.5],
      }}
      onSetMaterial={(m) => setMat(m ?? undefined)}
    />
  );
}

/* ------------------------------------------------------------------------- sections */

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-2xs font-semibold tracking-wider text-fg-muted uppercase">{title}</h2>
      {children}
    </section>
  );
}

function ExprSection() {
  const { evaluate } = useSampleDoc();
  const ev = (x: NamedDimension) => (e: Expr) => evaluate(e, x);
  return (
    <div className="flex w-[296px] flex-col gap-4 p-4" data-testid="g-expr">
      <Row title="Plain value">
        <ExpressionInput
          label="Depth"
          value="25mm"
          evaluate={ev('length')}
          unitHint="mm"
          onCommit={() => {}}
        />
      </Row>
      <Row title="Expression, evaluated">
        <ExpressionInput
          label="Wall"
          value="width / 12 + 1/8in"
          evaluate={ev('length')}
          onCommit={() => {}}
        />
      </Row>
      <Row title="Error with span">
        <ExpressionInput
          label="Bad"
          value="width + * 2"
          evaluate={ev('length')}
          onCommit={() => {}}
        />
      </Row>
      <Row title="Dimension mismatch">
        <ExpressionInput
          label="Mismatch"
          value="10mm + 30deg"
          evaluate={ev('length')}
          onCommit={() => {}}
        />
      </Row>
      <Row title="Touch size">
        <ExpressionInput
          label="Angle"
          value="15deg"
          evaluate={ev('angle')}
          unitHint="°"
          size="touch"
          onCommit={() => {}}
        />
      </Row>
      <Row title="Disabled">
        <ExpressionInput
          label="Locked"
          value="12mm"
          disabled
          evaluate={ev('length')}
          unitHint="mm"
          onCommit={() => {}}
        />
      </Row>
    </div>
  );
}

/** Two fields, one at the top and one at the bottom, to see the keypad flip above / below. */
function KeypadSection() {
  const { evaluate } = useSampleDoc();
  const ev = (x: NamedDimension) => (e: Expr) => evaluate(e, x);
  return (
    <ParamNamesContext.Provider value={['width', 'height', 'wall', 'hole_d', 'tilt']}>
      <div
        className="flex min-h-dvh w-[min(100vw-16px,360px)] flex-col justify-between gap-4 p-4"
        data-testid="g-keypad"
      >
        <ExpressionInput
          label="Top field"
          value="25mm"
          evaluate={ev('length')}
          size="touch"
          keypad="always"
          unitHint="mm"
          onCommit={() => {}}
        />
        <ExpressionInput
          label="Bottom field"
          value="width / 2"
          evaluate={ev('length')}
          size="touch"
          keypad="always"
          onCommit={() => {}}
        />
      </div>
    </ParamNamesContext.Provider>
  );
}

function SketchSection({ tier }: { tier: Tier }) {
  const { evaluate } = useSampleDoc();
  const [tool, setTool] = useState<SketchToolId | null>('line');
  const [construction, setConstruction] = useState(false);
  return (
    <div className="flex w-[min(100vw-32px,760px)] flex-col gap-5 p-4" data-testid="g-sketch">
      <Row title="Toolbar">
        <div className="flex">
          <SketchToolbar
            layout={tier === 'phone' ? 'rail' : 'bar'}
            density={tier === 'desktop' ? 'compact' : 'touch'}
            activeTool={tool}
            onTool={(t) => setTool(t)}
            construction={construction}
            onToggleConstruction={() => setConstruction((c) => !c)}
            onConstraint={() => {}}
            enabledConstraints={['coincident', 'horizontal', 'parallel', 'equal']}
            onFinish={() => {}}
          />
        </div>
      </Row>
      <Row title="Status">
        <div className="flex flex-wrap gap-2">
          <SketchStatusChip status="solved" dof={0} />
          <SketchStatusChip status="solved" dof={2} />
          <SketchStatusChip status="solved" dof={1} redundant={1} />
          <SketchStatusChip status="conflicting" dof={0} />
          <SketchStatusChip status="failed" dof={0} />
        </div>
      </Row>
      <Row title="Prompt chip">
        <div className="flex">
          <PromptChip onCancel={() => {}}>Select a face or sketch region</PromptChip>
        </div>
      </Row>
      <Row title="Constraint glyphs: placed / hint / conflict">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-x-3 gap-y-2">
          {[...geometricConstraintKinds, ...dimensionKinds].map((k) => (
            <div key={k} className="flex items-center gap-1.5" data-glyph={k}>
              <ConstraintGlyph
                kind={k}
                size={26}
                tone={k === 'tangent' ? 'conflict' : k === 'equal' ? 'hint' : 'placed'}
              />
              <span className="truncate text-2xs text-fg-muted">{constraintLabels[k]}</span>
            </div>
          ))}
        </div>
      </Row>
      <Row title="Dimension labels">
        <div className="bg-viewport-top relative h-24 rounded-panel bg-gradient-to-b from-viewport-top to-viewport-bottom">
          <DimensionLabel
            x={90}
            y={24}
            kind="length"
            expr="width"
            driving
            evaluate={(e) => evaluate(e, 'length')}
          />
          <DimensionLabel
            x={210}
            y={24}
            kind="diameter"
            expr="hole_d"
            driving
            evaluate={(e) => evaluate(e, 'length')}
          />
          <DimensionLabel
            x={330}
            y={24}
            kind="radius"
            expr="8mm"
            driving
            evaluate={(e) => evaluate(e, 'length')}
            selected
          />
          <DimensionLabel x={90} y={64} kind="distance" expr="" driving={false} measured="42.5" />
          <DimensionLabel
            x={210}
            y={64}
            kind="angle"
            expr="tilt"
            driving
            evaluate={(e) => evaluate(e, 'angle')}
            conflicting
          />
          <DimensionLabel
            x={330}
            y={64}
            kind="length"
            expr="12mm"
            driving
            evaluate={(e) => evaluate(e, 'length')}
          />
        </div>
      </Row>
      <Row title="Conflicts">
        <div className="flex">
          <ConflictPanel
            conflicts={sampleConflicts}
            constraintName={(id) => `Constraint ${id}`}
            onFix={() => {}}
            onDismiss={() => {}}
          />
        </div>
      </Row>
    </div>
  );
}

function InspectorSection({ tier }: { tier: Tier }) {
  const cols = tier === 'desktop' ? 'flex-row flex-wrap' : 'flex-col';
  return (
    <div className={`flex gap-4 p-4 ${cols}`} data-testid="g-inspectors">
      <div className={card}>
        <StatefulInspector tier={tier} feature={extrudeSample} />
      </div>
      <div className={card}>
        <StatefulInspector tier={tier} feature={filletSample} status={sampleStatuses[2]} />
      </div>
      <div className={card}>
        <StatefulInspector
          tier={tier}
          feature={sampleFeatures[3] as Feature}
          status={sampleStatuses[3]}
        />
      </div>
      <div className={card}>
        <StatefulPart
          tier={tier}
          material={{
            libraryId: 'whittle:al-6061',
            name: 'Aluminium 6061-T6',
            density: '2.70 g/cm^3',
            appearance: '#c9ced6',
          }}
        />
      </div>
      <div className={card}>
        <StatefulPart tier={tier} />
      </div>
      <div className={`${card} flex flex-col`}>
        <SelectionInspector selection={{ kind: 'none' }} />
      </div>
      <div className={card}>
        <SelectionInspector
          selection={{
            kind: 'face',
            count: 1,
            label: 'Planar face · F2:top',
            details: [
              ['Area', '1,800 mm²'],
              ['Normal', '+Z'],
            ],
          }}
          actions={[
            { id: 'sketch', label: 'Sketch on face', shortcut: 'S' },
            { id: 'extrude', label: 'Extrude', shortcut: 'E' },
          ]}
        />
      </div>
    </div>
  );
}

function PopoverSection() {
  const [last, setLast] = useState<ExportRequest | null>(null);
  return (
    <div
      className="flex min-h-[560px] w-[min(100vw-32px,720px)] flex-col gap-6 p-4"
      data-testid="g-popovers"
    >
      <Row title="Export menu trigger">
        <div className="flex items-center gap-3">
          <ExportMenu
            onExport={setLast}
            bodies={[
              { id: 'B1', name: 'Bracket' },
              { id: 'B2', name: 'Mounting plate' },
            ]}
            unavailable={{ '3mf': 'Coming soon' }}
          />
          <output data-testid="last-export" className="tnum text-2xs text-fg-muted">
            {last ? JSON.stringify(last) : 'nothing exported'}
          </output>
        </div>
      </Row>
    </div>
  );
}

export function Gallery({
  section,
  tier,
  theme,
}: {
  section: string;
  tier: Tier;
  theme: ThemeSetting;
}) {
  useTheme({ value: theme });
  const body = (() => {
    switch (section) {
      case 'tree':
        return (
          <div className="flex flex-col gap-4 p-4 md:flex-row" data-testid="g-tree">
            <div className={card}>
              <StatefulTree density={tier === 'desktop' ? 'compact' : 'touch'} />
            </div>
            <div className={card}>
              <FeatureTree features={[]} />
            </div>
          </div>
        );
      case 'nested':
        return (
          <div className="flex flex-col gap-4 p-4 md:flex-row" data-testid="g-nested">
            <div className={card}>
              <FeatureTree
                density={tier === 'desktop' ? 'compact' : 'touch'}
                features={nestedFeatures}
                onRollback={() => {}}
                onMove={() => ({ ok: true })}
                onDelete={() => {}}
              />
            </div>
            <div className={card}>
              {/* Selecting a nested sketch opens its feature */}
              <FeatureTree
                density={tier === 'desktop' ? 'compact' : 'touch'}
                features={nestedFeatures}
                selectedId="N3"
                onRollback={() => {}}
                onMove={() => ({ ok: true })}
              />
            </div>
            <div className={card}>
              <FeatureTree
                density={tier === 'desktop' ? 'compact' : 'touch'}
                features={nestedFeatures}
                nestSketches={false}
                onRollback={() => {}}
                onMove={() => ({ ok: true })}
              />
            </div>
          </div>
        );
      case 'params':
        return (
          <div className="flex flex-col gap-4 p-4 md:flex-row" data-testid="g-params">
            <div className={card}>
              <StatefulParams density={tier === 'desktop' ? 'compact' : 'touch'} />
            </div>
            <div className={card}>
              <ParamsTable
                params={[]}
                evaluate={() => ({ ok: false, error: { message: '' } })}
                onAdd={() => {}}
              />
            </div>
          </div>
        );
      case 'expr':
        return <ExprSection />;
      case 'keypad':
        return <KeypadSection />;
      case 'inspectors':
        return <InspectorSection tier={tier} />;
      case 'sketch':
        return <SketchSection tier={tier} />;
      case 'popovers':
        return <PopoverSection />;
      case 'chooser':
        return (
          <div className="min-h-[420px] p-4" data-testid="g-chooser">
            <WhichOneChooser
              at={{ x: 40, y: 40 }}
              onPick={() => {}}
              onDismiss={() => {}}
              size={tier === 'desktop' ? 'md' : 'touch'}
              candidates={[
                { id: '1', kind: 'face', label: 'Top face', detail: 'Planar · 1,800 mm²' },
                { id: '2', kind: 'edge', label: 'Edge of Extrude 1', detail: 'Line · 60 mm' },
                { id: '3', kind: 'vertex', label: 'Corner vertex', detail: '(60, 30, 40)' },
                { id: '4', kind: 'body', label: 'Bracket', detail: '31.25 cm³' },
              ]}
            />
          </div>
        );
      case 'm3-features':
      case 'm3-patterns':
      case 'm3-reference':
      case 'm3-hole':
      case 'm3-sketch':
      case 'm3-tree':
      case 'm3-bar':
        return <M3Gallery section={section} tier={tier} />;
      case 'params-link':
        return <ParamsGallery tier={tier} />;
      case 'section-chip':
      case 'section-panel':
        return <SectionGallery section={section} tier={tier} />;
      case 'm36-folders':
      case 'm36-eye':
      case 'm36-phone':
      case 'm36-live':
        return <M36Gallery section={section} tier={tier} />;
      case 'm37-pill':
      case 'm37-markers':
      case 'm37-table':
      case 'm37-table-transposed':
      case 'm37-table-collapsed':
      case 'm37-review':
      case 'm37-live':
      case 'm37-wiring':
        return <M37Gallery section={section} tier={tier} />;
      case 'm35-radial':
      case 'm35-radial-live':
      case 'm35-chooser':
      case 'm35-keymap':
      case 'm35-overlay':
      case 'm35-nav':
      case 'm35-errors':
      case 'm35-sketch':
      case 'm35-dim':
      case 'm35-lineage':
        return <M35Gallery section={section} tier={tier} />;
      case 'sync':
      case 'connections':
      case 'versions':
      case 'compare':
      case 'merge':
        return <SyncGallery section={section} tier={tier} />;
      default:
        return <p className="p-4">Unknown section {section}</p>;
    }
  })();
  return (
    <LazyMotion features={domAnimation}>
      <TooltipProvider>
        <div data-testid="gallery" data-section={section} className="min-h-dvh bg-bg text-fg">
          {body}
        </div>
      </TooltipProvider>
    </LazyMotion>
  );
}
