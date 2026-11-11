// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @wren-cad/document — the Wren document model. Worker-safe: no DOM, no Node-only APIs.
 *
 *  - Expressions & units:  `expressionEngine`, `evaluateFeatureValues`, `evaluateParams`, `scopeOf`
 *  - Store:                `createDocumentStore` (undo/redo, coalescing, migrations)
 *  - Files:                `projectCodec`, `canonicalJson`, `packFiles` / `unpackFiles`
 *  - Materials:            `MATERIALS`, `resolveDensity`
 *  - Factories:            `newDoc`, `newPart`, `ulid`
 *  - Configurations (M3.7): `resolveConfiguration`, `CONFIGURABLE_OPTIONS`, `partNumberFor`, `exportFileNames`
 *  - Hole tables (M3):     `ISO_HOLES`, `ANSI_HOLES`, `holeRow`, `resolveHoleSize`
 */

export * from './annotation-rules';
export * from './annotations';
export * from './archive';
export * from './codec';
export * from './commands';
export * from './configurations';
export * from './drawings';
export * from './evaluate';
export * from './expressions';
export * from './factory';
export * from './features';
export * from './files';
export * from './folders';
export * from './hole-tables';
export * from './iso286';
export * from './materials';
export * from './migrations';
export * from './parser';
export * from './patch';
export * from './store';
export * from './suggest';
export * from './units';
export * from './view-frames';
