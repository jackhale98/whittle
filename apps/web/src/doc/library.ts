/**
 * Local library + file I/O, loaded lazily (IndexedDB/OPFS, the zip codec and the file pickers are
 * not needed to paint the shell). Wraps `@whittle/io/browser` with the document codec.
 */

import type { LibraryEntry, WhittleDoc } from '@whittle/contracts';
import { projectCodec, ulid } from '@whittle/document';
import {
  canvasToThumbnail,
  type OpenedFile,
  onLaunchFiles,
  openFile,
  openLibrary,
  saveFile,
} from '@whittle/io/browser';

export interface DocLibrary {
  list(query?: string): Promise<LibraryEntry[]>;
  open(id: string): Promise<WhittleDoc>;
  save(doc: WhittleDoc, thumbnail?: Uint8Array): Promise<LibraryEntry>;
  remove(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
}

export async function createDocLibrary(): Promise<DocLibrary> {
  const lib = await openLibrary({ codec: projectCodec });
  return {
    list: (query) => (query?.trim() ? lib.search(query) : lib.list()),
    async open(id) {
      const { doc } = await lib.open(id);
      return { ...doc, meta: { ...doc.meta, id } };
    },
    save: (doc, thumbnail) =>
      lib.save(doc, undefined, thumbnail, doc.meta.id ? { id: doc.meta.id } : {}),
    remove: (id) => lib.remove(id),
    async rename(id, name) {
      const { doc } = await lib.open(id);
      await lib.save({ ...doc, meta: { ...doc.meta, id, name } }, undefined, undefined, { id });
    },
  };
}

/** `.whittle` bytes for a document. */
export const toWhittleBytes = (doc: WhittleDoc): Uint8Array => projectCodec.toWhittle(doc);

/** Reads a `.whittle` file; documents without a library id get one. */
export function fromWhittleBytes(bytes: Uint8Array): WhittleDoc {
  const { doc } = projectCodec.fromWhittle(bytes);
  return doc.meta.id ? doc : { ...doc, meta: { ...doc.meta, id: ulid() } };
}

export { canvasToThumbnail, type OpenedFile, onLaunchFiles, openFile, saveFile };

export const MIME = {
  whittle: 'application/x-whittle',
  step: 'model/step',
  stl: 'model/stl',
  brep: 'application/octet-stream',
  '3mf': 'model/3mf',
  glb: 'model/gltf-binary',
} as const;
