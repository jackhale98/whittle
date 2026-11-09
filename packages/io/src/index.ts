// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Worker-safe entry point: pure TS mesh exporters/importers and STL analysis. No DOM, IndexedDB
 * or OPFS. Browser-only code (library, file pickers, thumbnails) lives in `@wren-cad/io/browser`.
 */
export { DEFAULT_LIMITS, type ImportLimits, IoError, type IoErrorCode } from './errors';
export { detectMeshFormat, importMesh, type MeshFormat, meshExporters } from './exporters';
export { MM_TO_M, toGlb } from './glb';
export { import3mf } from './import3mf';
export { importGlb } from './importGlb';
export { importObj } from './importObj';
export {
  bboxOf,
  checkMesh,
  type MeshReport,
  meshFromSoup,
  type NamedMesh,
  WELD_TOLERANCE,
  type WeldedMesh,
  weldMesh,
} from './mesh';
export { analyzeStl, importStl, meshToStl, parseStl, type StlAnalysis, type StlBody } from './stl';
export { type ThreeMfOptions, to3mf } from './threemf';
