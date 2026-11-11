import { useMemo, useState } from 'react';
import {
  DimensionLabel,
  defaultFormatValue,
  ExpressionInput,
  type ParamInfo,
  type ParamLinks,
  ParamLinksContext,
  ParamsTable,
  type ParamUse,
} from '../src';
import { makeEvaluator, sampleParams } from './fixtures';

/* ADR-080: parameters you can find and apply. One page holds a value field, three sketch dimension
   labels and the Params tab; the spec drives it (typing, fx, Make parameter, dragging) and takes a
   baseline of each state. */

type Tier = 'desktop' | 'tablet' | 'phone';
const card = 'w-card w-[320px] overflow-hidden p-3';

const uses: Record<string, ParamUse[]> = {
  P1: [
    { key: 'a', kind: 'feature', label: 'Extrude 1', detail: 'depth', featureId: 'F2' },
    {
      key: 'b',
      kind: 'dimension',
      label: 'Sketch 1',
      detail: 'diameter dimension 1',
      featureId: 'F1',
      constraintId: 'C1',
    },
    { key: 'c', kind: 'param', label: 'wall', paramId: 'P3' },
  ],
  P2: [{ key: 'd', kind: 'feature', label: 'Extrude 1', detail: 'draft', featureId: 'F2' }],
  P3: [],
  P4: [],
  P5: [],
  P6: [],
};

export function ParamsGallery({ tier }: { tier: Tier }) {
  const touch = tier !== 'desktop';
  // `?keypad=never`: a touch device used with the system keyboard (the list, not the keypad, helps).
  const keypad = new URLSearchParams(location.search).get('keypad') === 'never' ? 'never' : 'auto';
  const size = touch ? 'touch' : 'md';
  const [params, setParams] = useState(sampleParams.filter((p) => p.name !== 'bad'));
  const [depth, setDepth] = useState('10 mm');
  const [width, setWidth] = useState('width / 2');
  const evaluate = useMemo(() => makeEvaluator(params), [params]);
  const evalLen = (e: string) => evaluate(e, 'length');
  const infos = useMemo<ParamInfo[]>(
    () =>
      params.map((p) => {
        const r = evaluate(p.expr);
        return {
          name: p.name,
          ...(r.ok ? { value: defaultFormatValue(r.value, r.dimension) } : {}),
          ...(p.description ? { description: p.description } : {}),
        };
      }),
    [params, evaluate],
  );
  const links: ParamLinks = {
    params: infos,
    make: (name, expr) => {
      setParams((ps) => [...ps, { id: `P${ps.length + 10}`, name, expr }]);
      return undefined;
    },
  };
  const [dimExpr, setDimExpr] = useState('30');

  return (
    <ParamLinksContext.Provider value={links}>
      <div className="flex flex-col gap-4 p-4 md:flex-row md:flex-wrap" data-testid="g-params-link">
        <div className="flex flex-col gap-3">
          <div className={`${card} flex flex-col gap-3`} data-testid="params-fields">
            <ExpressionInput
              label="Depth"
              value={depth}
              onCommit={setDepth}
              evaluate={evalLen}
              unitHint="mm"
              keypad={keypad}
              size={size}
            />
            <ExpressionInput
              label="Width (X)"
              value={width}
              onCommit={setWidth}
              evaluate={evalLen}
              unitHint="mm"
              keypad={keypad}
              size={size}
            />
          </div>
          <div
            className={`${card} relative h-[120px] bg-surface-2`}
            data-testid="params-dimensions"
          >
            <DimensionLabel
              x={70}
              y={24}
              kind="diameter"
              expr={dimExpr}
              driving
              evaluate={evalLen}
              onCommit={setDimExpr}
              onDropParam={setDimExpr}
              onSelect={() => {}}
            />
            <DimensionLabel
              x={190}
              y={24}
              kind="length"
              expr="width"
              driving
              evaluate={evalLen}
              onDropParam={() => {}}
              selected
            />
            <DimensionLabel
              x={110}
              y={80}
              kind="length"
              expr="width / 2 + wall"
              driving
              evaluate={evalLen}
              onDropParam={() => {}}
            />
            <DimensionLabel
              x={250}
              y={80}
              kind="radius"
              expr="4"
              driving={false}
              measured="4.00"
              evaluate={evalLen}
            />
          </div>
        </div>
        <div className="w-card w-[320px] overflow-hidden" data-testid="params-table">
          <ParamsTable
            density={touch ? 'touch' : 'compact'}
            params={params}
            evaluate={evaluate}
            usedBy={uses}
            onSelectUse={() => {}}
            onUpdate={(id, patch) =>
              setParams((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))
            }
          />
        </div>
      </div>
    </ParamLinksContext.Provider>
  );
}
