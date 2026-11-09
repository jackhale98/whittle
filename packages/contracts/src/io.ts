/**
 * Project packaging & local library (PLAN §8A.1, §2.5, §2.6). Lead-owned contract, implemented
 * by packages/io (packaging, mesh formats) and packages/document (canonical JSON).
 */

import type { Id, WrenDoc } from './document';
import type { MeshBuffers } from './kernel';

/**
 * Attachments: binary project files referenced by features (e.g. `imports/<featureId>.step`).
 * `ProjectCodec.toWren/fromWren` carry them in `extra`; libraries must persist `extra` and
 * the `.wren/` cache with the document (opening and re-saving never drops files).
 */

/** A project as its canonical folder: relative POSIX path → file bytes. */
export type ProjectFiles = Map<string, Uint8Array>;

export interface ProjectCodec {
  /** Deterministic: the same document always yields byte-identical files (sorted keys, LF, trailing newline). */
  toFiles(doc: WrenDoc): ProjectFiles;
  fromFiles(files: ProjectFiles): WrenDoc;
  /** `.wrencad` = the folder zipped (fflate). Cache (`.wren/`) entries are optional. */
  toWren(doc: WrenDoc, cache?: ProjectFiles, extra?: ProjectFiles): Uint8Array;
  /** `extra` holds project files outside the document model (previews/, releases/), kept on round trips. */
  fromWren(bytes: Uint8Array): { doc: WrenDoc; cache: ProjectFiles; extra?: ProjectFiles };
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
  open(id: Id): Promise<{ doc: WrenDoc; cache: ProjectFiles; extra: ProjectFiles }>;
  save(
    doc: WrenDoc,
    cache?: ProjectFiles,
    thumbnail?: Uint8Array,
    options?: { id?: Id; extra?: ProjectFiles },
  ): Promise<LibraryEntry>;
  remove(id: Id): Promise<void>;
  search(query: string): Promise<LibraryEntry[]>;
}
