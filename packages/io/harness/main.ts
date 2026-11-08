// SPDX-License-Identifier: GPL-3.0-or-later
import type { WhittleDoc } from '@whittle/contracts';
import { canvasToThumbnail, type LibraryCodec, openLibrary } from '../src/browser';

/** Stand-in for the document package's ProjectCodec: JSON bytes. */
const codec: LibraryCodec = {
  toWhittle: (doc) => new TextEncoder().encode(JSON.stringify(doc)),
  fromWhittle: (bytes) => ({
    doc: JSON.parse(new TextDecoder().decode(bytes)) as WhittleDoc,
    cache: new Map(),
  }),
};

function makeDoc(name: string): WhittleDoc {
  return {
    schemaVersion: 1,
    units: { length: 'mm', angle: 'deg' },
    params: [],
    parts: [],
    assemblies: [],
    drawings: [],
    meta: { name, created: 'c', modified: 'm', app: 'harness' },
  } as WhittleDoc;
}

export async function run(dbName: string) {
  const lib = await openLibrary({ codec, dbName });
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 300;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#c33';
  ctx.fillRect(0, 0, 400, 300);
  const thumb = await canvasToThumbnail(canvas);
  const saved = await lib.save(makeDoc('Harness Part'), undefined, thumb);
  const listed = await lib.list();
  const opened = await lib.open(saved.id);
  const found = await lib.search('harness');
  await lib.remove(saved.id);
  const after = await lib.list();
  lib.close();
  return {
    backend: lib.backend,
    savedId: saved.id,
    listedNames: listed.map((e) => e.name),
    openedName: opened.doc.meta.name,
    foundCount: found.length,
    afterCount: after.length,
    thumbMagic: Array.from(thumb.slice(0, 4)),
    thumbBytes: thumb.byteLength,
  };
}

declare global {
  interface Window {
    __io: { run: typeof run };
  }
}
window.__io = { run };
