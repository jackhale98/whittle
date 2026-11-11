/**
 * `@wren-cad/drawing`: M4 drawings on the shared annotation core (ADR-090, ADR-091). DOM-free and
 * Wasm-free: kernel results (`ViewProjection`, `AnnotationResolution`) come in as data from the
 * drawing worker and the regen. Lazy with the drawing route: nothing here is on the app's initial
 * route.
 *
 * Subpaths: `/annotation` (worker-safe core, shared with M5), `/svg`, `/pdf`, `/dxf`, `/font`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export * from './attention';
export * from './import';
export * from './placement';
export * from './sheet';
export * from './style';
export * from './template';
export * from './view';
