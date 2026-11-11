/**
 * `@wren-cad/drawing/annotation`: the shared annotation core (ADR-090 decision 15). Number,
 * tolerance, fit and GD&T formatting, the tolerance field parser, the vector symbol library, text
 * metrics and the dimension/leader layouts. DOM-free and Wasm-free, so drawing views (M4), the 3D
 * annotation display and STEP presentation PMI (M5) all use this one code path, in any worker.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export * from './callouts';
export * from './dimension-layout';
export * from './display';
export * from './flatten';
export * from './gdt';
export * from './geom';
export * from './label-layout';
export * from './numbers';
export * from './strokes';
export * from './symbols';
export * from './text';
export * from './tolerance';
export * from './tolerance-parse';
