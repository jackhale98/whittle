// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@wren-cad/document/drawing`: the lazily loaded half of the document package (ADR-090
 * amendment). Annotation and drawing validation, the annotation and drawing command compilers,
 * `normalizeDrawings`, the standards rule tables (`annotationIssues`), ISO 286 and the view-frame
 * maths. The app loads it with a dynamic `import()` and calls `registerDrawingSupport()` before it
 * opens a document that has annotations or drawings, and before the first annotation or drawing
 * command. Keeping it out of the store's static imports keeps the initial route small.
 */

import { compileAnnotationCommand } from './annotation-commands';
import { annotationProblems, checkAnnotation } from './annotations';
import { compileDrawingCommand } from './drawing-commands';
import { installDrawingSupport } from './drawing-hooks';
import { checkDrawing, checkDrawingDefaults, normalizeDrawings } from './drawings';

export * from './annotation-rules';
export * from './annotations';
export * from './drawing-commands';
export * from './drawings';
// The hole callout's numbers come from the same table as the hole feature. Re-exported so the
// drawing route reads it from this chunk and the initial route does not carry it for them.
export { resolveHoleSize } from './hole-size';
export * from './iso286';
export * from './view-frames';

/** Registers the annotation and drawing support with the store and `validateDoc`. Idempotent. */
export function registerDrawingSupport(): void {
  installDrawingSupport({
    checkAnnotation,
    checkDrawing,
    checkDrawingDefaults,
    annotationProblems,
    normalizeDrawings,
    compileAnnotationCommand,
    compileDrawingCommand,
  });
}
