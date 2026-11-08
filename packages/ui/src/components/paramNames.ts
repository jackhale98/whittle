import { createContext } from 'react';

/**
 * Parameter names offered on the keypad's expression row by every ExpressionInput below it. The
 * shells provide the document's parameters; a single field can override with `paramNames`.
 */
export const ParamNamesContext = createContext<readonly string[]>([]);
