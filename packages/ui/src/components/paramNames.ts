import { createContext } from 'react';
import type { ParamInfo } from '../logic/paramLinks';

/**
 * Parameter names offered on the keypad's expression row by every ExpressionInput below it. The
 * shells provide the document's parameters; a single field can override with `paramNames`.
 */
export const ParamNamesContext = createContext<readonly string[]>([]);

/**
 * What every value field knows about the document's parameters (ADR-080): their evaluated values
 * for the autocomplete list and for "width = 80" link display, and how to make a new one from a
 * field's value. Values come from the host's evaluate path, never from the UI.
 */
export interface ParamLinks {
  params: readonly ParamInfo[];
  /**
   * Creates the parameter `name = expr` in the document without ending the undo step: the field
   * then commits the name, and `makeDone` closes the step so both are one undo. Returns the
   * host's error message, or undefined on success. Absent: no "Make parameter" action.
   */
  make?(name: string, expr: string): string | undefined;
  makeDone?(): void;
}

export const ParamLinksContext = createContext<ParamLinks>({ params: [] });
