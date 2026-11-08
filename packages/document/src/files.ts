// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shapes of the files in a Whittle project folder (PLAN §8A.1). These types are the source of the
 * generated JSON Schemas in `schema/` — keep them plain JSON, documented, and exported.
 */

import type { Assembly, DocMeta, Drawing, Id, Param, Part, WhittleDoc } from '@whittle/contracts';

/** Index entry in the manifest: the file is keyed by the object's stable `id`, not its name. */
export interface ManifestEntry {
  id: Id;
  /** Display name (informational copy; the file is authoritative). */
  name: string;
  /** Path relative to the project root, e.g. `parts/bracket.part.json`. */
  file: string;
}

/** `whittle.project.json` */
export interface ProjectManifest {
  format: 'whittle-project';
  schemaVersion: number;
  units: { length: 'mm' | 'cm' | 'm' | 'in' | 'ft'; angle: 'deg' | 'rad' };
  meta: DocMeta;
  /** Order here is the order in the document. */
  parts: ManifestEntry[];
  drawings: ManifestEntry[];
  assemblies: ManifestEntry[];
}

/** `params.json` */
export interface ParamsFile {
  params: Param[];
}

/** `parts/<slug>.part.json` */
export type PartFile = Part;
/** The whole in-memory document (what `DocumentStore.load` accepts). */
export type DocumentFile = WhittleDoc;
/** `drawings/<slug>.drawing.json` */
export type DrawingFile = Drawing;
/** `assemblies/<slug>.assembly.json` */
export type AssemblyFile = Assembly;
