/**
 * What the drawing chunk takes from the app's core modules, in one place. Imported directly: the
 * bundler already shares these modules with the initial route.
 *
 * What must NOT be imported statically from the lazy chunk is `@wren-cad/document/drawing` (read
 * it with `drawingDocument()` from `doc/drawing-support`): a static import made the bundler split
 * a dozen shared modules out of the initial chunk and the initial route grew by 9 kB (ADR-092).
 */

import type { EvalResult, Expr, WrenDoc } from '@wren-cad/contracts';
import {
  describeAnnotation,
  expressionEngine,
  partNumberFor,
  resolveConfiguration,
  scopeOf,
  ulid,
} from '@wren-cad/document';
import { activeIdOf, keyOf, slotOf, summarizeMass, valueKey } from '../app/config-model';

export const host = {
  ulid,
  evaluate: (expr: Expr, expected: 'scalar' | 'length' | 'angle', doc: WrenDoc): EvalResult =>
    expressionEngine.evaluate(expr, expected, scopeOf(doc)),
  scopeOf,
  partNumberFor,
  describeAnnotation,
  resolveConfiguration,
  activeIdOf,
  keyOf,
  slotOf,
  summarizeMass,
  valueKey,
};
