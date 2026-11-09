// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @wren-cad/document — the Wren document model. Worker-safe: no DOM, no Node-only APIs.
 *
 *  - Expressions & units:  `expressionEngine`, `evaluateFeatureValues`, `evaluateParams`, `scopeOf`
 *  - Store:                `createDocumentStore` (undo/redo, coalescing, migrations)
 *  - Files:                `projectCodec`, `canonicalJson`, `packFiles` / `unpackFiles`
 *  - Materials:            `MATERIALS`, `resolveDensity`
 *  - Factories:            `newDoc`, `newPart`, `ulid`
 *  - Hole tables (M3):     `ISO_HOLES`, `ANSI_HOLES`, `holeRow`, `resolveHoleSize`
 */

export * from './codec';
export * from './commands';
export * from './evaluate';
export * from './expressions';
export * from './factory';
export * from './features';
export * from './files';
export * from './hole-tables';
export * from './materials';
export * from './migrations';
export * from './parser';
export * from './patch';
export * from './store';
export * from './suggest';
export * from './units';
