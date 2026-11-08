// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Expression engine (implements `ExpressionEngine` from @whittle/contracts).
 *
 * Quantities carry a canonical value (mm, rad, kg, s) and a dimension vector. Evaluation is a
 * plain tree walk over the AST from `parser.ts`; there is no `eval` and no `Function`.
 *
 * Bare-number rules:
 *  - The final result of `evaluate(expr, expected, …)` may be unit-less when `expected` is not
 *    `scalar`; it then takes the document's default unit for that dimension.
 *  - Next to a dimensioned operand in `+ -`, `min`, `max`, `atan2`, a unit-less operand likewise
 *    takes the default unit of the other operand's dimension (`width + 5` works).
 *  - Trig functions take an angle; a bare number is in the document's angle unit.
 *    (`pi` is a plain number: write `pi rad` or `180deg` for radians/angles.)
 */

import type {
  EvalResult,
  EvalScope,
  ExprError,
  ExpressionEngine,
  NamedDimension,
} from '@whittle/contracts';
import { ExprSyntaxError, type Node, parse, type Span } from './parser';
import { suggest } from './suggest';
import {
  angleFactor,
  type Dim,
  defaultFactor,
  describeDim,
  dimDiv,
  dimEquals,
  dimIsScalar,
  dimMul,
  dimPow,
  lengthFactor,
  namedDim,
  SCALAR,
  toContractDim,
  UNITS,
} from './units';

export interface Quantity {
  /** Canonical value (mm, rad, kg, s and products thereof). */
  v: number;
  d: Dim;
}

export const CONSTANTS: ReadonlyMap<string, number> = new Map([
  ['pi', Math.PI],
  ['π', Math.PI],
]);

type Fn = { min: number; max: number };
export const FUNCTIONS: ReadonlyMap<string, Fn> = new Map([
  ['sin', { min: 1, max: 1 }],
  ['cos', { min: 1, max: 1 }],
  ['tan', { min: 1, max: 1 }],
  ['asin', { min: 1, max: 1 }],
  ['acos', { min: 1, max: 1 }],
  ['atan', { min: 1, max: 1 }],
  ['atan2', { min: 2, max: 2 }],
  ['sqrt', { min: 1, max: 1 }],
  ['abs', { min: 1, max: 1 }],
  ['min', { min: 1, max: Number.POSITIVE_INFINITY }],
  ['max', { min: 1, max: Number.POSITIVE_INFINITY }],
  ['round', { min: 1, max: 1 }],
  ['floor', { min: 1, max: 1 }],
  ['ceil', { min: 1, max: 1 }],
]);

/** Names a parameter may not take (they would be unreachable or ambiguous). */
export function isReservedName(name: string): boolean {
  return CONSTANTS.has(name) || FUNCTIONS.has(name);
}

const PARAM_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** `undefined` when `name` is a valid parameter name, else a human reason. */
export function validateParamName(name: string): string | undefined {
  if (name.length === 0) return 'A parameter needs a name';
  if (!PARAM_NAME.test(name)) {
    return `‘${name}’ is not a valid parameter name — use letters, digits and underscores, starting with a letter`;
  }
  if (isReservedName(name)) return `‘${name}’ is reserved for a built-in function or constant`;
  return undefined;
}

class EvalFail extends Error {
  constructor(
    message: string,
    readonly span: Span | undefined,
    readonly cycle?: string[],
    /** Name of the parameter whose own expression failed (already wrapped). */
    readonly via?: string,
  ) {
    super(message);
  }
}

interface Ctx {
  scope: EvalScope;
  lenF: number;
  angF: number;
  stack: string[];
  memo: Map<string, { q: Quantity; deps: Set<string> } | EvalFail>;
}

function makeCtx(scope: EvalScope): Ctx {
  return {
    scope,
    lenF: lengthFactor(scope.defaultLengthUnit),
    angF: angleFactor(scope.defaultAngleUnit),
    stack: [],
    memo: new Map(),
  };
}

// Parse cache: expression strings repeat endlessly during regen and drags.
const parseCache = new Map<string, Node | ExprSyntaxError>();
function parseCached(src: string): Node {
  let hit = parseCache.get(src);
  if (hit === undefined) {
    try {
      hit = parse(src);
    } catch (e) {
      if (!(e instanceof ExprSyntaxError)) throw e;
      hit = e;
    }
    if (parseCache.size > 4000) parseCache.clear();
    parseCache.set(src, hit);
  }
  if (hit instanceof ExprSyntaxError) throw new EvalFail(hit.message, hit.span);
  return hit;
}

function hasOwn(o: object, k: string): boolean {
  return Object.hasOwn(o, k);
}

function round(x: number, digits = 12): number {
  return Number(x.toPrecision(digits));
}

function fail(message: string, span: Span | undefined): never {
  throw new EvalFail(message, span);
}

function checkFinite(v: number, span: Span, what: string): number {
  if (!Number.isFinite(v)) fail(`${what} is not a finite number`, span);
  return v;
}

function sameDim(
  a: Quantity,
  b: Quantity,
  ctx: Ctx,
  span: Span,
  verb: string,
): [Quantity, Quantity] {
  if (dimEquals(a.d, b.d)) return [a, b];
  const f = { length: ctx.lenF, angle: ctx.angF };
  if (dimIsScalar(a.d)) {
    const k = defaultFactor(b.d, f);
    if (k !== undefined) return [{ v: a.v * k, d: b.d }, b];
  }
  if (dimIsScalar(b.d)) {
    const k = defaultFactor(a.d, f);
    if (k !== undefined) return [a, { v: b.v * k, d: a.d }];
  }
  return fail(`Can't ${verb} ${describeDim(a.d)} and ${describeDim(b.d)}`, span);
}

function unknownIdent(name: string, span: Span, ctx: Ctx, unitContext: boolean): never {
  const params = Object.keys(ctx.scope.params);
  const pool = unitContext ? [...UNITS.keys(), ...params] : [...params, ...UNITS.keys()];
  const s = suggest(name, [...pool, ...CONSTANTS.keys()]);
  const what = unitContext ? 'unit' : 'parameter';
  const hint = s ? ` — did you mean ‘${s}’?` : '';
  return fail(`Unknown ${what} ‘${name}’${hint}`, span);
}

function evalParam(name: string, refSpan: Span, ctx: Ctx): { q: Quantity; deps: Set<string> } {
  const cached = ctx.memo.get(name);
  if (cached instanceof EvalFail) throw rewrap(cached, name, refSpan);
  if (cached) return cached;
  const at = ctx.stack.indexOf(name);
  if (at >= 0) {
    const cycle = ctx.stack.slice(at);
    throw new EvalFail(`Circular reference: ${[...cycle, name].join(' → ')}`, refSpan, cycle);
  }
  ctx.stack.push(name);
  try {
    const src = ctx.scope.params[name] as string;
    const deps = new Set<string>([name]);
    const q = evalNode(parseCached(src), ctx, deps);
    const out = { q, deps };
    ctx.memo.set(name, out);
    return out;
  } catch (e) {
    if (e instanceof EvalFail) {
      // Memoise failures so diamond-shaped parameter graphs stay linear.
      if (!ctx.memo.has(name)) ctx.memo.set(name, e);
      throw rewrap(e, name, refSpan);
    }
    throw e;
  } finally {
    ctx.stack.pop();
  }
}

/** Re-anchors a parameter's error on the reference site in the expression being evaluated. */
function rewrap(e: EvalFail, name: string, refSpan: Span): EvalFail {
  if (e.cycle) return new EvalFail(e.message, refSpan, e.cycle);
  if (e.via) return new EvalFail(e.message, refSpan, undefined, e.via);
  return new EvalFail(`Parameter ‘${name}’ has an error: ${e.message}`, refSpan, undefined, name);
}

function evalNode(n: Node, ctx: Ctx, deps: Set<string>): Quantity {
  switch (n.t) {
    case 'num':
      return { v: n.v, d: SCALAR };
    case 'id': {
      const k = CONSTANTS.get(n.name);
      if (k !== undefined) return { v: k, d: SCALAR };
      const unit = UNITS.get(n.name);
      const isParam = hasOwn(ctx.scope.params, n.name);
      // `25N` is a unit; a bare `N` (not after a number) prefers a parameter of that name.
      if (unit && (n.afterNumber || !isParam)) return { v: unit.factor, d: unit.dim };
      if (isParam) {
        const r = evalParam(n.name, n.span, ctx);
        for (const x of r.deps) deps.add(x);
        return r.q;
      }
      if (FUNCTIONS.has(n.name)) {
        return fail(`‘${n.name}’ is a function — write ${n.name}(…)`, n.span);
      }
      return unknownIdent(n.name, n.span, ctx, n.afterNumber);
    }
    case 'unary': {
      const x = evalNode(n.x, ctx, deps);
      return n.op === '-' ? { v: -x.v, d: x.d } : x;
    }
    case 'bin': {
      const a = evalNode(n.a, ctx, deps);
      const b = evalNode(n.b, ctx, deps);
      switch (n.op) {
        case '+':
        case '-': {
          const [x, y] = sameDim(a, b, ctx, n.span, n.op === '+' ? 'add' : 'subtract');
          return { v: n.op === '+' ? x.v + y.v : x.v - y.v, d: x.d };
        }
        case '*':
          return { v: checkFinite(a.v * b.v, n.span, 'The product'), d: dimMul(a.d, b.d) };
        case '/':
          if (b.v === 0) return fail('Division by zero', n.b.span);
          return { v: checkFinite(a.v / b.v, n.span, 'The quotient'), d: dimDiv(a.d, b.d) };
        case '^': {
          if (!dimIsScalar(b.d)) {
            return fail(`An exponent must be a plain number, not ${describeDim(b.d)}`, n.b.span);
          }
          const v = a.v ** b.v;
          if (Number.isNaN(v)) return fail('That power is not a real number', n.span);
          return { v: checkFinite(v, n.span, 'The power'), d: dimPow(a.d, b.v) };
        }
      }
      break;
    }
    case 'call':
      return evalCall(n, ctx, deps);
  }
  return fail('Unsupported expression', undefined);
}

function toAngleRad(q: Quantity, ctx: Ctx, span: Span, fn: string): number {
  if (dimEquals(q.d, namedDim('angle'))) return q.v;
  if (dimIsScalar(q.d)) return q.v * ctx.angF;
  return fail(`${fn}() takes an angle, not ${describeDim(q.d)}`, span);
}

function evalCall(n: Extract<Node, { t: 'call' }>, ctx: Ctx, deps: Set<string>): Quantity {
  const spec = FUNCTIONS.get(n.name);
  if (!spec) {
    const s = suggest(n.name, FUNCTIONS.keys());
    const hint = s ? ` — did you mean ‘${s}’?` : '';
    const isParam = hasOwn(ctx.scope.params, n.name);
    return fail(
      `Unknown function ‘${n.name}’${hint}${isParam ? ' (use * to multiply a parameter)' : ''}`,
      n.nameSpan,
    );
  }
  if (n.args.length < spec.min || n.args.length > spec.max) {
    const want =
      spec.min === spec.max
        ? `${spec.min} argument${spec.min === 1 ? '' : 's'}`
        : `at least ${spec.min} argument${spec.min === 1 ? '' : 's'}`;
    return fail(`${n.name}() takes ${want}, got ${n.args.length}`, n.span);
  }
  const args = n.args.map((a) => evalNode(a, ctx, deps));
  const a0 = args[0] as Quantity;
  const arg0Span = (n.args[0] as Node).span;
  const scalar = (v: number): Quantity => ({ v, d: SCALAR });
  const angle = (v: number): Quantity => ({ v, d: namedDim('angle') });
  const requireScalar = (q: Quantity, span: Span): number => {
    if (!dimIsScalar(q.d)) fail(`${n.name}() takes a plain number, not ${describeDim(q.d)}`, span);
    return q.v;
  };
  const domain = (ok: boolean, msg: string): void => {
    if (!ok) fail(msg, arg0Span);
  };

  switch (n.name) {
    case 'sin':
      return scalar(round(Math.sin(toAngleRad(a0, ctx, arg0Span, 'sin'))));
    case 'cos':
      return scalar(round(Math.cos(toAngleRad(a0, ctx, arg0Span, 'cos'))));
    case 'tan': {
      const r = toAngleRad(a0, ctx, arg0Span, 'tan');
      domain(Math.abs(Math.cos(r)) > 1e-12, 'tan() is undefined at this angle');
      return scalar(round(Math.tan(r)));
    }
    case 'asin': {
      const x = requireScalar(a0, arg0Span);
      domain(x >= -1 && x <= 1, 'asin() needs a value between -1 and 1');
      return angle(Math.asin(x));
    }
    case 'acos': {
      const x = requireScalar(a0, arg0Span);
      domain(x >= -1 && x <= 1, 'acos() needs a value between -1 and 1');
      return angle(Math.acos(x));
    }
    case 'atan':
      return angle(Math.atan(requireScalar(a0, arg0Span)));
    case 'atan2': {
      const [y, x] = sameDim(a0, args[1] as Quantity, ctx, n.span, 'compare');
      return angle(Math.atan2(y.v, x.v));
    }
    case 'sqrt': {
      domain(a0.v >= 0, 'sqrt() of a negative number');
      return { v: Math.sqrt(a0.v), d: dimPow(a0.d, 0.5) };
    }
    case 'abs':
      return { v: Math.abs(a0.v), d: a0.d };
    case 'min':
    case 'max': {
      let acc = a0;
      for (const q of args.slice(1)) {
        const [x, y] = sameDim(acc, q, ctx, n.span, 'compare');
        acc = n.name === 'min' ? (y.v < x.v ? y : x) : y.v > x.v ? y : x;
      }
      return acc;
    }
    case 'round':
    case 'floor':
    case 'ceil': {
      // Round in the unit the user thinks in (document default), not in canonical mm/rad.
      const k = defaultFactor(a0.d, { length: ctx.lenF, angle: ctx.angF }) ?? 1;
      const f = n.name === 'round' ? Math.round : n.name === 'floor' ? Math.floor : Math.ceil;
      // Tiny tolerance so 2.9999999999 floors/rounds as the user sees it.
      return { v: f(round(a0.v / k, 10)) * k, d: a0.d };
    }
  }
  return fail(`Unsupported function ${n.name}`, n.nameSpan);
}

// ---------------------------------------------------------------------------------------------
// Public engine
// ---------------------------------------------------------------------------------------------

function toExprError(e: EvalFail): ExprError {
  const err: ExprError = { message: e.message };
  if (e.span) err.span = [e.span[0], e.span[1]];
  if (e.cycle) err.cycle = e.cycle;
  return err;
}

function trimmedSpan(src: string): Span {
  const s = src.length - src.trimStart().length;
  return [s, Math.max(s, src.trimEnd().length)];
}

/** Result of evaluating without an expected dimension. */
export type AnyResult =
  | { ok: true; value: number; dimension: Dim; dependsOn: string[] }
  | { ok: false; error: ExprError };

/** Which dimension strings are acceptable as `format()` units, with their display labels. */
const DEFAULT_FORMAT_UNIT: Record<NamedDimension, string> = {
  scalar: '',
  length: 'mm',
  angle: 'deg',
  area: 'mm^2',
  volume: 'mm^3',
  mass: 'g',
  density: 'g/cm^3',
  pressure: 'MPa',
};

export class ExpressionEngineImpl implements ExpressionEngine {
  /** Evaluates with no dimension expectation (used for parameters, which have no declared dimension). */
  evaluateAny(src: string, scope: EvalScope): AnyResult {
    return this.run(src, makeCtx(scope));
  }

  /** A session that shares parameter results across many evaluations of one scope. */
  bind(scope: EvalScope): {
    evaluate(expr: string, expected: NamedDimension): EvalResult;
    evaluateAny(expr: string): AnyResult;
  } {
    const ctx = makeCtx(scope);
    return {
      evaluate: (expr, expected) => this.finish(this.run(expr, ctx), expected, expr, ctx),
      evaluateAny: (expr) => this.run(expr, ctx),
    };
  }

  evaluate(src: string, expected: NamedDimension, scope: EvalScope): EvalResult {
    const ctx = makeCtx(scope);
    return this.finish(this.run(src, ctx), expected, src, ctx);
  }

  private run(src: string, ctx: Ctx): AnyResult {
    try {
      if (src.trim() === '') fail('Empty expression', [0, 0]);
      const deps = new Set<string>();
      const q = evalNode(parseCached(src), ctx, deps);
      if (!Number.isFinite(q.v)) fail('The result is not a finite number', trimmedSpan(src));
      return { ok: true, value: q.v, dimension: q.d, dependsOn: [...deps].sort() };
    } catch (e) {
      if (e instanceof EvalFail) return { ok: false, error: toExprError(e) };
      throw e;
    }
  }

  private finish(r: AnyResult, expected: NamedDimension, src: string, ctx: Ctx): EvalResult {
    if (!r.ok) return r;
    const want = namedDim(expected);
    if (dimEquals(r.dimension, want)) {
      return {
        ok: true,
        value: r.value,
        dimension: toContractDim(r.dimension),
        dependsOn: r.dependsOn,
      };
    }
    if (dimIsScalar(r.dimension)) {
      const k = defaultFactor(want, { length: ctx.lenF, angle: ctx.angF });
      if (k !== undefined) {
        return {
          ok: true,
          value: r.value * k,
          dimension: toContractDim(want),
          dependsOn: r.dependsOn,
        };
      }
    }
    return {
      ok: false,
      error: {
        message: `Expected ${describeDim(want)}, but this is ${describeDim(r.dimension)}`,
        span: trimmedSpan(src),
      },
    };
  }

  format(value: number, expected: NamedDimension, unit?: string): string {
    const label = (unit ?? DEFAULT_FORMAT_UNIT[expected]).trim();
    let factor = 1;
    if (label !== '') {
      const u = this.unitFactor(label, expected);
      if (u === undefined) return this.format(value, expected);
      factor = u;
    }
    const text = formatNumber(value / factor);
    if (label === '') return text;
    return label === 'deg' || label === '°' ? `${text}°` : `${text} ${label}`;
  }

  /** Factor of a unit expression (`mm`, `g/cm^3`) of the right dimension, else `undefined`. */
  unitFactor(unit: string, expected: NamedDimension): number | undefined {
    const r = this.evaluateAny(unit, {
      params: {},
      defaultLengthUnit: 'mm',
      defaultAngleUnit: 'deg',
    });
    if (!r.ok || !dimEquals(r.dimension, namedDim(expected)) || r.value <= 0) return undefined;
    return r.value;
  }
}

/** Up to 7 significant digits, trailing zeros trimmed, no thousands separators, ASCII minus. */
export function formatNumber(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return '0';
  const r = Number(x.toPrecision(7));
  if (r === 0) return '0';
  const a = Math.abs(r);
  if (a >= 1e-6 && a < 1e21) return String(r);
  return r.toExponential().replace('e+', 'e');
}

export const expressionEngine = new ExpressionEngineImpl();

export { identifierSpans } from './parser';
