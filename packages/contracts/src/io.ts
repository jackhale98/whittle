/**
 * Project packaging & local library (PLAN §8A.1, §2.5, §2.6). Lead-owned contract, implemented
 * by packages/io (packaging, mesh formats) and packages/document (canonical JSON).
 */

import type { Id, WhittleDoc } from './document';
import type { MeshBuffers } from './kernel';

/** A project as its canonical folder: relative POSIX path → file bytes. */
export type ProjectFiles = Map<string, Uint8Array>;

export interface ProjectCodec {
  /** Deterministic: the same document always yields byte-identical files (sorted keys, LF, trailing newline). */
  toFiles(doc: WhittleDoc): ProjectFiles;
  fromFiles(files: ProjectFiles): WhittleDoc;
  /** `.whittle` = the folder zipped (fflate). Cache (`.whittle/`) entries are optional. */
  toWhittle(doc: WhittleDoc, cache?: ProjectFiles): Uint8Array;
  fromWhittle(bytes: Uint8Array): { doc: WhittleDoc; cache: ProjectFiles };
}

/** Mesh exports computed in TS from regen meshes (no kernel needed). */
export interface MeshExporters {
  to3mf(
    bodies: { name: string; mesh: MeshBuffers; color?: string }[],
    unit: 'millimeter',
  ): Uint8Array;
  toGlb(bodies: { name: string; mesh: MeshBuffers; color?: string }[]): Uint8Array;
}

export interface LibraryEntry {
  id: Id;
  name: string;
  modified: string;
  /** PNG data for the library grid, small. */
  thumbnail?: Uint8Array;
  sizeBytes: number;
}

/** Local document library (IndexedDB metadata + OPFS blobs). */
export interface LocalLibrary {
  list(): Promise<LibraryEntry[]>;
  open(id: Id): Promise<{ doc: WhittleDoc; cache: ProjectFiles }>;
  save(doc: WhittleDoc, cache?: ProjectFiles, thumbnail?: Uint8Array): Promise<LibraryEntry>;
  remove(id: Id): Promise<void>;
  search(query: string): Promise<LibraryEntry[]>;
}
