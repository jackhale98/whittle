// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The registry behind the lazily loaded drawing support (ADR-090 amendment). The core document
 * package (store, `validateDoc`, `migrateDoc`) never imports the annotation and drawing validators,
 * the command compilers or the standards rule tables; they register themselves here when the app
 * loads `@wren-cad/document/drawing` (`registerDrawingSupport()`).
 *
 * Until they are registered, anything that needs them fails with a clear message and never
 * misapplies: an annotation or drawing command is refused, and a document that has annotations,
 * drawings or drawing defaults is refused on load.
 */

import type { Annotation, AnnotationCommand, DrawingCommand, WrenDoc } from '@wren-cad/contracts';
import type { Checker } from './check';
import type { Compiled } from './command-support';

export interface DrawingSupport {
  checkAnnotation(c: Checker, a: unknown, at: string): void;
  checkDrawing(c: Checker, d: unknown, at: string): void;
  checkDrawingDefaults(c: Checker, d: unknown, at: string): void;
  annotationProblems(a: Annotation | unknown): string[];
  normalizeDrawings(doc: WrenDoc): { doc: WrenDoc; notes: { message: string }[] };
  compileAnnotationCommand(doc: WrenDoc, cmd: AnnotationCommand, used: Set<string>): Compiled;
  compileDrawingCommand(doc: WrenDoc, cmd: DrawingCommand, used: Set<string>): Compiled;
}

let support: DrawingSupport | undefined;

/** Called by `registerDrawingSupport()` in the lazy chunk. */
export function installDrawingSupport(s: DrawingSupport): void {
  support = s;
}

export const drawingSupport = (): DrawingSupport | undefined => support;

export const isDrawingSupportLoaded = (): boolean => support !== undefined;

export const DRAWING_SUPPORT_MISSING = 'Drawing support has not loaded yet. Try again in a moment.';

/** Does this raw document use anything that needs the drawing support to read? */
export function usesDrawingFeatures(doc: Record<string, unknown>): boolean {
  if (Array.isArray(doc.drawings) && doc.drawings.length > 0) return true;
  if (doc.drawingDefaults !== undefined) return true;
  if (!Array.isArray(doc.parts)) return false;
  return doc.parts.some((p) => {
    if (typeof p !== 'object' || p === null) return false;
    const part = p as Record<string, unknown>;
    if (Array.isArray(part.annotations) && part.annotations.length > 0) return true;
    return (
      Array.isArray(part.configurations) &&
      part.configurations.some(
        (c) =>
          typeof c === 'object' &&
          c !== null &&
          (c as Record<string, unknown>).annotations !== undefined,
      )
    );
  });
}
