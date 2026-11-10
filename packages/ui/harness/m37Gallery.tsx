import type { Expr } from '@wren-cad/contracts';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import {
  ChangedInAllNotice,
  ExportPanel,
  FeatureInspector,
  ParamsTable,
  PartInspector,
  type ConfigGroupId,
  type ConfigTableRow,
  ConfigurationPill,
  configTargetKey,
  FeatureTree,
  type FeatureTreeItem,
  OverrideMarker,
  ScopeChip,
  useOneShotScope,
} from '../src';
import {
  configColumns,
  configDefault,
  configMaterials,
  configRows,
  configSummaries,
} from './configFixtures';
import { extrudeSample, makeEvaluator, sampleLibrary, sampleParams } from './fixtures';

/* M3.7 visual states: the pill, override markers, the scope chip and notice, the tree's suppress
   scope and the configuration table. Open popovers and editing are driven by e2e/m37.spec.ts. */

type Tier = 'desktop' | 'tablet' | 'phone';

// The table is a lazy chunk in the app; the gallery loads it the same way.
const ConfigurationTable = lazy(() => import('../src/config/ConfigurationTable'));

const evaluate = makeEvaluator([]);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-44 text-xs text-fg-muted">{label}</span>
      {children}
    </div>
  );
}

function Pills({ tier }: { tier: Tier }) {
  const size = tier === 'desktop' ? 'md' : 'touch';
  const noop = () => {};
  const base = { configurations: configSummaries, onSwitch: noop, size } as const;
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="g-m37-pill">
      <Row label="Default (bar)">
        <ConfigurationPill {...base} activeId={null} defaultStatus="ok" />
      </Row>
      <Row label="Off Default (bar)">
        <ConfigurationPill {...base} activeId="c-long" defaultStatus="ok" />
      </Row>
      <Row label="Needs attention">
        <ConfigurationPill {...base} activeId="c-steel" />
      </Row>
      <Row label="Failed">
        <ConfigurationPill {...base} activeId="c-tall" />
      </Row>
      <Row label="Phone chip, Default">
        <ConfigurationPill {...base} variant="chip" activeId={null} />
      </Row>
      <Row label="Phone chip, off Default">
        <ConfigurationPill {...base} variant="chip" activeId="c-long" />
      </Row>
      <Row label="Long name">
        <ConfigurationPill
          {...base}
          configurations={[
            { id: 'x', name: 'Extra long configuration name for the wide bracket', status: 'ok' },
          ]}
          activeId="x"
        />
      </Row>
      <div className="flex items-center gap-2 rounded-panel bg-surface p-2 shadow-pop">
        <span className="text-ui font-medium">Untitled bracket</span>
        <ConfigurationPill {...base} activeId="c-long" onCreate={noop} onManage={noop} />
      </div>
    </div>
  );
}

const feats: FeatureTreeItem[] = [
  { id: 's1', name: 'Sketch 1', type: 'sketch', suppressed: false },
  { id: 'e1', name: 'Extrude 1', type: 'extrude', suppressed: false },
  { id: 'f1', name: 'Fillet 1', type: 'fillet', suppressed: true },
  { id: 'h1', name: 'Hole 1', type: 'hole', suppressed: false },
];

function Markers({ tier }: { tier: Tier }) {
  const size = tier === 'desktop' ? 'md' : 'touch';
  const [scope, setScope] = useState<'all' | 'configuration'>('configuration');
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="g-m37-markers">
      <Row label="Override marker">
        <span className="text-ui">Width</span>
        <OverrideMarker
          overridden
          configurationName="Long"
          fieldLabel="Width"
          onReset={() => {}}
          size={size}
        />
      </Row>
      <Row label="Marker, badge only">
        <OverrideMarker overridden configurationName="Long" />
      </Row>
      <Row label="Scope chip, off">
        <ScopeChip
          configurationName="Long"
          activeIsDefault={false}
          scope="all"
          onScopeChange={() => {}}
          size={size}
        />
      </Row>
      <Row label="Scope chip, on">
        <ScopeChip
          configurationName="Long"
          activeIsDefault={false}
          scope={scope}
          onScopeChange={setScope}
          size={size}
        />
      </Row>
      <ChangedInAllNotice
        count={4}
        onUndo={() => {}}
        onDismiss={() => {}}
        autoDismissMs={0}
        size={size}
        className="w-[360px] max-w-full"
      />
      <div className="w-[296px] overflow-hidden rounded-panel bg-surface shadow-pop">
        <FeatureTree
          density={size === 'md' ? 'compact' : 'touch'}
          features={feats}
          onSelect={() => {}}
          onSuppress={() => {}}
          configuration={{
            activeName: 'Long',
            isDefault: false,
            count: 4,
            overriddenSuppression: ['f1'],
            onSuppress: () => {},
            onResetSuppression: () => {},
          }}
        />
      </div>
    </div>
  );
}

function Table({
  tier,
  transposed,
  collapsed,
  rows,
}: {
  tier: Tier;
  transposed?: boolean;
  collapsed?: ConfigGroupId[];
  rows?: ConfigTableRow[];
}) {
  return (
    <div className="max-w-full p-4">
      <Suspense fallback={<p>Loading…</p>}>
        <ConfigurationTable
          columns={configColumns}
          rows={rows ?? configRows}
          defaultRow={configDefault}
          activeId="c-long"
          size={tier === 'desktop' ? 'md' : 'touch'}
          transposed={!!transposed}
          {...(collapsed ? { collapsedGroups: collapsed, onCollapsedGroupsChange: () => {} } : {})}
          materials={configMaterials}
          evaluate={evaluate}
          onEdit={() => {}}
          onPaste={() => {}}
          onJumpToField={() => {}}
          onActivate={() => {}}
          onRename={() => {}}
          onRemove={() => {}}
        />
      </Suspense>
    </div>
  );
}

/** A live table + pill for interaction tests: the host owns the state, like the app. */
function Live({ tier }: { tier: Tier }) {
  const [rows, setRows] = useState<ConfigTableRow[]>(configRows);
  const [active, setActive] = useState<string | null>('c-long');
  const [def, setDef] = useState(configDefault.values);
  const [log, setLog] = useState<string[]>([]);
  const one = useOneShotScope(active === null, active);
  const size = tier === 'desktop' ? 'md' : 'touch';
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="g-m37-live">
      <div className="flex items-center gap-3">
        <ConfigurationPill
          size={size}
          configurations={rows.map((r) => ({ id: r.id, name: r.name, status: r.status }))}
          activeId={active}
          onSwitch={setActive}
          onCreate={({ name, from }) => {
            const id = `n-${name}`;
            const src =
              from === 'active' ? (rows.find((r) => r.id === active)?.overrides ?? {}) : {};
            setRows((rs) => [...rs, { id, name, status: 'unbuilt', overrides: { ...src } }]);
            setLog((l) => [...l, `created ${name} from ${from}`]);
          }}
          onManage={() => setLog((l) => [...l, 'manage'])}
        />
        <ScopeChip
          configurationName={rows.find((r) => r.id === active)?.name ?? 'Default'}
          activeIsDefault={active === null}
          scope={one.scope}
          onScopeChange={one.setScope}
          size={size}
        />
      </div>
      <Suspense fallback={<p>Loading…</p>}>
        <ConfigurationTable
          columns={configColumns}
          rows={rows}
          defaultRow={{ ...configDefault, values: def }}
          activeId={active}
          size={size}
          materials={configMaterials}
          evaluate={evaluate}
          onActivate={setActive}
          onJumpToField={(f, p) => setLog((l) => [...l, `jump ${f}${p}`])}
          onEdit={(edits) => {
            for (const e of edits) {
              const k = configTargetKey(e.target);
              if (e.configurationId === null) {
                setDef((d) => ({ ...d, [k]: e.value as never }));
              } else
                setRows((rs) =>
                  rs.map((r) => {
                    if (r.id !== e.configurationId) return r;
                    const { [k]: _gone, ...rest } = r.overrides;
                    return {
                      ...r,
                      overrides: e.value === undefined ? rest : { ...rest, [k]: e.value },
                    };
                  }),
                );
            }
          }}
          onPaste={(plan) => {
            setLog((l) => [...l, `paste ${plan.create.length}/${plan.edits.length}`]);
            setRows((rs) => {
              let next = [...rs];
              for (const n of plan.create)
                next.push({ id: `n-${n}`, name: n, status: 'unbuilt', overrides: {} });
              for (const e of plan.edits) {
                const id =
                  e.row.kind === 'new'
                    ? `n-${e.row.name}`
                    : e.row.kind === 'existing'
                      ? e.row.id
                      : null;
                if (!id) continue;
                const k = configTargetKey(e.target);
                next = next.map((r) => {
                  if (r.id !== id) return r;
                  const { [k]: _gone, ...rest } = r.overrides;
                  return {
                    ...r,
                    overrides: e.value === undefined ? rest : { ...rest, [k]: e.value },
                  };
                });
              }
              return next;
            });
          }}
        />
      </Suspense>
      <p data-testid="log" className="text-2xs text-fg-muted">
        {log.join(' | ')}
      </p>
    </div>
  );
}

function Review() {
  return (
    <div className="flex w-[296px] flex-col gap-4 p-4" data-testid="g-m37-review">
      <div className="overflow-auto rounded-panel bg-surface shadow-pop">
        <FeatureTree
          density="touch"
          actions="review"
          features={feats}
          onSelect={() => {}}
          onSuppress={() => {}}
          configuration={{
            activeName: 'Long',
            isDefault: false,
            count: 4,
            overriddenSuppression: ['f1'],
            onSuppress: () => {},
          }}
        />
      </div>
    </div>
  );
}

/** The inspector, Params tab, part inspector and export form with a configuration active (app wiring). */
function Wiring({ tier }: { tier: Tier }) {
  const density = tier === 'desktop' ? 'compact' : 'touch';
  const size = tier === 'desktop' ? 'md' : 'touch';
  const ev = (e: Expr) => makeEvaluator(sampleParams)(e);
  return (
    <div className="flex flex-col gap-6 p-4" data-testid="g-m37-wiring">
      <section className="w-[296px] max-w-full overflow-hidden rounded-panel bg-surface shadow-pop">
        <FeatureInspector
          feature={extrudeSample}
          density={density}
          evaluate={(e, x) => makeEvaluator(sampleParams)(e, x)}
          onChange={() => {}}
          configuration={{
            activeName: 'Long',
            overridden: (p) => p === '/end/depth',
            reset: () => {},
          }}
        />
      </section>
      <section className="w-[296px] max-w-full overflow-hidden rounded-panel bg-surface shadow-pop">
        <ParamsTable
          density={density}
          params={sampleParams.slice(0, 3)}
          evaluate={ev}
          configuration={{
            activeId: 'c-long',
            activeName: 'Long',
            overrides: { P1: '80mm' },
            onReset: () => {},
          }}
          onUpdate={() => {}}
        />
      </section>
      <section className="w-[296px] max-w-full overflow-hidden rounded-panel bg-surface shadow-pop">
        <PartInspector
          part={{ name: 'Bracket', material: sampleLibrary[0] ? { name: 'Steel', density: '7.85 g/cm^3' } : undefined }}
          library={sampleLibrary}
          density={density}
          evaluate={(e) => makeEvaluator([])(e, 'density')}
          mass={{ volume: 31_250, area: 8_420.5, mass: 0.245, centroid: [30, 20, 6.5] }}
          onSetMaterial={() => {}}
          configuration={{
            activeName: 'Long',
            materialOverridden: true,
            onResetMaterial: () => {},
            masses: [
              { id: null, name: 'Default', active: false, status: 'ok', mass: '0.2 kg' },
              { id: 'c-long', name: 'Long', active: true, status: 'ok', mass: '0.245 kg' },
              { id: 'c-steel', name: 'Steel', active: false, status: 'unbuilt' },
            ],
            properties: {
              partNumber: '',
              description: 'Long bracket',
              generatedPartNumber: 'Bracket-Long',
              overridden: { description: true },
              onChange: () => {},
              onReset: () => {},
            },
          }}
        />
      </section>
      <section className="w-[320px] max-w-full rounded-panel bg-surface p-3 shadow-pop">
        <ExportPanel
          size={size}
          onExport={() => {}}
          configurations={{
            activeName: 'Long',
            count: 3,
            warnings: ['Default and Steel would both be written to PL-100. Give them different part numbers.'],
          }}
        />
      </section>
    </div>
  );
}

export function M37Gallery({ section, tier }: { section: string; tier: Tier }) {
  switch (section) {
    case 'm37-pill':
      return <Pills tier={tier} />;
    case 'm37-markers':
      return <Markers tier={tier} />;
    case 'm37-table':
      return (
        <div data-testid="g-m37-table">
          <Table tier={tier} />
        </div>
      );
    case 'm37-table-transposed':
      return (
        <div data-testid="g-m37-table-transposed">
          <Table tier={tier} transposed />
        </div>
      );
    case 'm37-table-collapsed':
      return (
        <div data-testid="g-m37-table-collapsed">
          <Table tier={tier} collapsed={['parameters', 'properties']} />
        </div>
      );
    case 'm37-review':
      return <Review />;
    case 'm37-live':
      return <Live tier={tier} />;
    case 'm37-wiring':
      return <Wiring tier={tier} />;
    default:
      return null;
  }
}
