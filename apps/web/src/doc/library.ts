/**
 * Local library + file I/O, loaded lazily (IndexedDB/OPFS, the zip codec and the file pickers are
 * not needed to paint the shell). Wraps `@wren-cad/io/browser` with the document codec.
 *
 * A project travels as three parts (contracts io.ts): the document, its `extra` project files
 * (attachments such as `imports/<featureId>.step`, `previews/`, `releases/`) and the regenerable
 * `.wren/` cache (meshes for instant open). Opening and re-saving never drops any of them.
 */

import type { LibraryEntry, ProjectFiles, WrenDoc } from '@wren-cad/contracts';
import { projectCodec, ulid } from '@wren-cad/document';
import {
  canvasToThumbnail,
  type OpenedFile,
  onLaunchFiles,
  openFile,
  openLibrary,
  saveFile,
} from '@wren-cad/io/browser';

export interface ProjectBundle {
  doc: WrenDoc;
  /** `.wren/` cache files (paths relative to `.wren/`, e.g. `meshes/index.json`). */
  cache: ProjectFiles;
  /** Project files outside the document model (attachments, previews/, releases/). */
  extra: ProjectFiles;
}

export interface SaveOptions {
  thumbnail?: Uint8Array;
  cache?: ProjectFiles;
  extra?: ProjectFiles;
}

export interface DocLibrary {
  list(query?: string): Promise<LibraryEntry[]>;
  open(id: string): Promise<ProjectBundle>;
  /** The entry with this id, or null (no error) when the library has none. */
  find(id: string): Promise<ProjectBundle | null>;
  save(doc: WrenDoc, options?: SaveOptions): Promise<LibraryEntry>;
  remove(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
}

export async function createDocLibrary(): Promise<DocLibrary> {
  const lib = await openLibrary({ codec: projectCodec });
  const open = async (id: string): Promise<ProjectBundle> => {
    const r = await lib.open(id);
    return { doc: { ...r.doc, meta: { ...r.doc.meta, id } }, cache: r.cache, extra: r.extra };
  };
  return {
    list: (query) => (query?.trim() ? lib.search(query) : lib.list()),
    open,
    async find(id) {
      const known = (await lib.list()).some((e) => e.id === id);
      return known ? open(id) : null;
    },
    save: (doc, o = {}) =>
      lib.save(doc, o.cache, o.thumbnail, {
        ...(doc.meta.id ? { id: doc.meta.id } : {}),
        ...(o.extra ? { extra: o.extra } : {}),
      }),
    remove: (id) => lib.remove(id),
    async rename(id, name) {
      // Keep the cache and the extra files: a rename must not drop attachments.
      const r = await open(id);
      await lib.save({ ...r.doc, meta: { ...r.doc.meta, id, name } }, r.cache, undefined, {
        id,
        extra: r.extra,
      });
    },
  };
}

/** `.wrencad` bytes for a project (document + extra files + cache). */
export const toWrenBytes = (
  doc: WrenDoc,
  extra?: ProjectFiles,
  cache?: ProjectFiles,
): Uint8Array => projectCodec.toWren(doc, cache, extra);

/** Reads a `.wrencad` file; documents without a library id get one. */
export function fromWrenBytes(bytes: Uint8Array): ProjectBundle {
  const r = projectCodec.fromWren(bytes);
  const doc = r.doc.meta.id ? r.doc : { ...r.doc, meta: { ...r.doc.meta, id: ulid() } };
  return { doc, cache: r.cache, extra: r.extra ?? new Map() };
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
};

function sameFiles(a: ProjectFiles, b: ProjectFiles): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || !sameBytes(v, w)) return false;
  }
  return true;
}

/**
 * Same project content: identical canonical document files (meta included, so a later edit —
 * which bumps `meta.modified` — counts as different) and identical extra files. The cache is
 * regenerable and ignored.
 */
export function sameProject(
  a: Pick<ProjectBundle, 'doc' | 'extra'>,
  b: Pick<ProjectBundle, 'doc' | 'extra'>,
): boolean {
  return (
    sameFiles(projectCodec.toFiles(a.doc), projectCodec.toFiles(b.doc)) &&
    sameFiles(a.extra, b.extra)
  );
}

/** "Bracket" → "Bracket (copy)", "Bracket (copy 2)", … — the first name not in `taken`. */
export function copyName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const base = `${name} (copy)`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const next = `${name} (copy ${n})`;
    if (!taken.has(next)) return next;
  }
}

export { canvasToThumbnail, type OpenedFile, onLaunchFiles, openFile, saveFile };

export const MIME = {
  wren: 'application/x-wren',
  step: 'model/step',
  stl: 'model/stl',
  brep: 'application/octet-stream',
  '3mf': 'model/3mf',
  glb: 'model/gltf-binary',
} as const;
