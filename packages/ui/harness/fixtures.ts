/**
 * Test/harness fixtures: a miniature expression evaluator that follows the `expressions.ts`
 * contract (units, params, cycle + dimension errors with spans) and sample document data.
 * Lives outside `src/` so none of it ships.
 */
import type {
  DimensionVector,
  EvalResult,
  Expr,
  ExprError,
  ExtrudeFeature,
  Feature,
  FeatureStatus,
  FilletFeature,
  NamedDimension,
  Param,
  SketchConflict,
} from '@whittle/contracts';
import { DIMENSIONS } from '@whittle/contracts';
import type { MaterialLibraryItem } from '../src';

type Q = { v: number; d: [number, number, number, number] };
const L: [number, number, number, number] = [1, 0, 0, 0];
const A: [number, number, number, number] = [0, 0, 1, 0];
const M: [number, number, number, number] = [0, 1, 0, 0];
const S: [number, number, number, number] = [0, 0, 0, 0];

const UNITS: Record<string, Q> = {
  mm: { v: 1, d: L },
  cm: { v: 10, d: L },
  m: { v: 1000, d: L },
  in: { v: 25.4, d: L },
  ft: { v: 304.8, d: L },
  deg: { v: Math.PI / 180, d: A },
  rad: { v: 1, d: A },
  g: { v: 1e-3, d: M },
  kg: { v: 1, d: M },
  lb: { v: 0.45359237, d: M },
};

class Fail extends Error {
  constructor(readonly info: ExprError) {
    super(info.message);
  }
}

const dimName = (d: readonly number[]) =>
  d[0] === 1 && d[1] === 0 && d[2] === 0
    ? 'a length'
    : d[2] === 1 && d[0] === 0
      ? 'an angle'
      : d.every((x) => x === 0)
        ? 'a plain number'
        : 'another kind of value';

/** Evaluates `expr` against `params`; `expected` adds default units and a dimension check. */
export function makeEvaluator(params: readonly Pick<Param, 'name' | 'expr'>[]) {
  const table = new Map(params.map((p) => [p.name, p.expr]));

  function run(expr: string, stack: string[], deps: Set<string>): Q {
    const toks: { t: string; k: 'n' | 'i' | 'o'; s: number; e: number }[] = [];
    const re = /\s*(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_°][A-Za-z0-9_°]*|[-+*/^()])/gy;
    let pos = 0;
    while (pos < expr.length) {
      re.lastIndex = pos;
      const mt = re.exec(expr);
      if (!mt) {
        if (!expr.slice(pos).trim()) break;
        const at = pos + (expr.slice(pos).length - expr.slice(pos).trimStart().length);
        throw new Fail({ message: `Unexpected “${expr[at]}”`, span: [at, at + 1] });
      }
      const text = mt[1] ?? '';
      const e = re.lastIndex;
      toks.push({
        t: text,
        k: /^[\d.]/.test(text) ? 'n' : /^[A-Za-z_°]/.test(text) ? 'i' : 'o',
        s: e - text.length,
        e,
      });
      pos = e;
    }
    let i = 0;
    const peek = () => toks[i];
    const end = expr.length;

    function atom(): Q {
      const t = peek();
      if (!t) throw new Fail({ message: 'Expected a value here', span: [end, end] });
      i++;
      if (t.t === '(') {
        const v = sum();
        const c = peek();
        if (c?.t !== ')')
          throw new Fail({ message: 'Missing closing parenthesis', span: [t.s, t.e] });
        i++;
        return v;
      }
      if (t.t === '-') {
        const q = power();
        return { v: -q.v, d: q.d };
      }
      if (t.t === '+') return power();
      if (t.k === 'n') {
        let q: Q = { v: Number.parseFloat(t.t), d: S };
        const slash = peek();
        const den = toks[i + 1];
        const unitTok = toks[i + 2];
        if (slash?.t === '/' && den?.k === 'n' && unitTok?.k === 'i' && UNITS[unitTok.t]) {
          q = { v: q.v / Number.parseFloat(den.t), d: S };
          i += 2;
        }
        const u = peek();
        if (u?.k === 'i' && UNITS[u.t]) {
          const unit = UNITS[u.t] as Q;
          q = { v: q.v * unit.v, d: unit.d };
          i++;
        }
        return q;
      }
      if (t.k === 'i') {
        if (UNITS[t.t]) return UNITS[t.t] as Q;
        if (t.t === 'pi') return { v: Math.PI, d: S };
        const src = table.get(t.t);
        if (src === undefined)
          throw new Fail({ message: `Unknown name “${t.t}”`, span: [t.s, t.e] });
        if (stack.includes(t.t))
          throw new Fail({
            message: `“${t.t}” depends on itself`,
            span: [t.s, t.e],
            cycle: [...stack, t.t],
          });
        deps.add(t.t);
        try {
          return run(src, [...stack, t.t], deps);
        } catch (err) {
          if (err instanceof Fail && stack.length === 0 && !err.info.cycle)
            throw new Fail({ message: `${t.t}: ${err.info.message}`, span: [t.s, t.e] });
          throw err;
        }
      }
      throw new Fail({ message: `Unexpected “${t.t}”`, span: [t.s, t.e] });
    }
    function power(): Q {
      const base = atom();
      if (peek()?.t === '^') {
        i++;
        const ex = atom();
        const n = ex.v;
        return { v: base.v ** n, d: [base.d[0] * n, base.d[1] * n, base.d[2] * n, base.d[3] * n] };
      }
      return base;
    }
    function prod(): Q {
      let l = power();
      for (let t = peek(); t && (t.t === '*' || t.t === '/'); t = peek()) {
        i++;
        const r = power();
        l =
          t.t === '*'
            ? { v: l.v * r.v, d: [l.d[0] + r.d[0], l.d[1] + r.d[1], l.d[2] + r.d[2], l.d[3] + r.d[3]] }
            : { v: l.v / r.v, d: [l.d[0] - r.d[0], l.d[1] - r.d[1], l.d[2] - r.d[2], l.d[3] - r.d[3]] };
      }
      return l;
    }
    function sum(): Q {
      let l = prod();
      for (let t = peek(); t && (t.t === '+' || t.t === '-'); t = peek()) {
        i++;
        const r = prod();
        if (l.d.some((x, k) => x !== r.d[k])) {
          const rt = toks[i - 1];
          throw new Fail({
            message: `Can’t ${t.t === '+' ? 'add' : 'subtract'} ${dimName(r.d)} ${t.t === '+' ? 'to' : 'from'} ${dimName(l.d)}`,
            span: [t.s, rt?.e ?? t.e],
          });
        }
        l = { v: t.t === '+' ? l.v + r.v : l.v - r.v, d: l.d };
      }
      return l;
    }
    const out = sum();
    const rest = peek();
    if (rest) throw new Fail({ message: `Unexpected “${rest.t}”`, span: [rest.s, rest.e] });
    return out;
  }

  return function evaluate(expr: Expr, expected?: NamedDimension): EvalResult {
    try {
      const deps = new Set<string>();
      let q = run(expr, [], deps);
      if (expected && q.d.every((x) => x === 0)) {
        if (expected === 'length') q = { v: q.v, d: L };
        else if (expected === 'angle') q = { v: (q.v * Math.PI) / 180, d: A };
      }
      if (expected) {
        const want: DimensionVector = DIMENSIONS[expected];
        if (want.some((x, k) => x !== q.d[k]))
          throw new Fail({
            message: `Expected ${dimName(want)}, got ${dimName(q.d)}`,
            span: [0, expr.length],
          });
      }
      return { ok: true, value: q.v, dimension: q.d, dependsOn: [...deps] };
    } catch (e) {
      if (e instanceof Fail) return { ok: false, error: e.info };
      throw e;
    }
  };
}

/* ------------------------------------------------------------------------- sample data */

export const sampleParams: Param[] = [
  { id: 'P1', name: 'width', expr: '60mm', description: 'Overall bracket width' },
  { id: 'P2', name: 'height', expr: '40mm' },
  { id: 'P3', name: 'wall', expr: 'width / 12', description: 'Wall thickness' },
  { id: 'P4', name: 'hole_d', expr: '5mm + 1/8in' },
  { id: 'P5', name: 'tilt', expr: '15deg' },
  { id: 'P6', name: 'bad', expr: 'width + * 2' },
];

const ref = (name: string, kind: 'face' | 'edge' | 'region' | 'body') => ({ name, kind });

export const sampleFeatures: Feature[] = [
  {
    id: 'F1',
    type: 'sketch',
    name: 'Base sketch',
    suppressed: false,
    on: ref('origin:XY', 'face'),
    entities: [],
    constraints: [],
  },
  {
    id: 'F2',
    type: 'extrude',
    name: 'Extrude 1',
    suppressed: false,
    profile: [ref('F1:region(0)', 'region')],
    direction: 'normal',
    end: { kind: 'blind', depth: 'height' },
    op: 'new',
  },
  {
    id: 'F3',
    type: 'fillet',
    name: 'Fillet 1',
    suppressed: false,
    edges: [ref('F2:side(e3)', 'edge'), ref('F2:side(e7)', 'edge')],
    radius: '30mm',
  },
  {
    id: 'F4',
    type: 'chamfer',
    name: 'Chamfer 1',
    suppressed: false,
    edges: [ref('F2:top(e1)', 'edge')],
    mode: { kind: 'distance', distance: 'wall / 4' },
  },
  {
    id: 'F5',
    type: 'extrude',
    name: 'Mounting hole',
    suppressed: true,
    profile: [ref('F5s:region(0)', 'region')],
    direction: 'symmetric',
    end: { kind: 'throughAll' },
    op: 'cut',
    scope: { kind: 'all' },
  },
  {
    id: 'F6',
    type: 'revolve',
    name: 'Revolve 1',
    suppressed: false,
    profile: [],
    axis: ref('', 'edge'),
    angle: '360deg',
    direction: 'normal',
    op: 'add',
  },
];

export const sampleStatuses: FeatureStatus[] = [
  { featureId: 'F1', state: 'ok', cached: true, ms: 1 },
  { featureId: 'F2', state: 'ok', cached: true, ms: 12 },
  {
    featureId: 'F3',
    state: 'error',
    cached: false,
    ms: 4,
    error: {
      code: 'INTERNAL',
      message: 'Fillet radius is too large for this edge; max ≈ 2.4 mm.',
      hint: 'Reduce the radius below 2.4 mm.',
    },
  },
  {
    featureId: 'F4',
    state: 'needsAttention',
    cached: false,
    ms: 0,
    unresolved: [{ path: '/edges/0', ref: ref('F2:top(e1)', 'edge'), reason: 'ambiguous' }],
  },
  { featureId: 'F5', state: 'suppressed', cached: true, ms: 0 },
  { featureId: 'F6', state: 'rolledBack', cached: false, ms: 0 },
];

export const sampleLibrary: MaterialLibraryItem[] = [
  {
    libraryId: 'whittle:steel-1018',
    name: 'Steel 1018',
    category: 'Steel',
    density: '7.87 g/cm^3',
    appearance: '#8a94a3',
  },
  {
    libraryId: 'whittle:steel-304',
    name: 'Stainless 304',
    category: 'Steel',
    density: '8.00 g/cm^3',
    appearance: '#b9c0ca',
  },
  {
    libraryId: 'whittle:al-6061',
    name: 'Aluminium 6061-T6',
    category: 'Aluminium',
    density: '2.70 g/cm^3',
    appearance: '#c9ced6',
  },
  {
    libraryId: 'whittle:al-7075',
    name: 'Aluminium 7075-T6',
    category: 'Aluminium',
    density: '2.81 g/cm^3',
    appearance: '#bcc3cf',
  },
  {
    libraryId: 'whittle:brass',
    name: 'Brass C360',
    category: 'Copper alloys',
    density: '8.50 g/cm^3',
    appearance: '#d6b25e',
  },
  {
    libraryId: 'whittle:ti-6al4v',
    name: 'Titanium Ti-6Al-4V',
    category: 'Titanium',
    density: '4.43 g/cm^3',
    appearance: '#9aa0aa',
  },
  {
    libraryId: 'whittle:abs',
    name: 'ABS',
    category: 'Plastic',
    density: '1.04 g/cm^3',
    appearance: '#e8e4da',
  },
  {
    libraryId: 'whittle:pla',
    name: 'PLA',
    category: 'Plastic',
    density: '1.24 g/cm^3',
    appearance: '#6f8fb0',
  },
  {
    libraryId: 'whittle:petg',
    name: 'PETG',
    category: 'Plastic',
    density: '1.27 g/cm^3',
    appearance: '#7ec8c0',
  },
  {
    libraryId: 'whittle:nylon',
    name: 'Nylon 6/6',
    category: 'Plastic',
    density: '1.14 g/cm^3',
    appearance: '#efe9d8',
  },
  {
    libraryId: 'whittle:oak',
    name: 'Oak',
    category: 'Wood',
    density: '0.75 g/cm^3',
    appearance: '#a98258',
  },
];

export const sampleConflicts: SketchConflict[] = [
  {
    constraints: ['C3', 'C7'],
    explanation: 'Line 2 can’t be both horizontal and at 30° to Line 1.',
    fixes: [
      { label: 'Remove “Horizontal 3”', action: { kind: 'removeConstraint', constraint: 'C3' } },
      { label: 'Make “Angle D7” a reference', action: { kind: 'makeReference', constraint: 'C7' } },
    ],
  },
  {
    constraints: ['C9'],
    explanation: 'Dimension D2 (40 mm) disagrees with the other dimensions on this loop.',
    fixes: [
      { label: 'Set D2 to 38.5 mm', action: { kind: 'setValue', constraint: 'C9', value: 38.5 } },
    ],
  },
];

export const extrudeSample = sampleFeatures[1] as ExtrudeFeature;
export const filletSample = sampleFeatures[2] as FilletFeature;
