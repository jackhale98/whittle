/// A `FileSystemDirectoryHandle` (the subset Wren uses) over a real directory, for running
/// isomorphic-git through `fsaGitFs` against repositories made and read by the real `git` CLI.
/// Errors are DOMException-style names, like Chromium's: NotFoundError, TypeMismatchError,
/// InvalidModificationError (removing a non-empty folder without `recursive`). Writes go to a
/// swap file that is renamed into place on close, as Chromium does.

import fs from 'node:fs';
import { join } from 'node:path';
import type { FolderFileHandle, FolderHandle } from '../../src/providers/folder';

const domError = (name: string, message = name) => Object.assign(new Error(message), { name });

function checkName(name: string): void {
  if (name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw Object.assign(new TypeError(`Name is not allowed: ${name}`), { name: 'TypeError' });
  }
}

function statOrNull(path: string): fs.Stats | null {
  try {
    return fs.statSync(path);
  } catch {
    return null;
  }
}

/** Counts calls, so tests can see how much work a status check did. */
export interface IoCounters {
  reads: number;
  /** Every path read, in order. */
  readPaths: string[];
  writes: number;
}

export class NodeFileHandle implements FolderFileHandle {
  readonly kind = 'file' as const;
  constructor(
    readonly name: string,
    readonly path: string,
    private readonly io: IoCounters,
  ) {}

  async getFile() {
    const st = statOrNull(this.path);
    if (!st?.isFile()) throw domError('NotFoundError');
    const path = this.path;
    const io = this.io;
    return {
      lastModified: Math.floor(st.mtimeMs),
      size: st.size,
      arrayBuffer: async () => {
        io.reads++;
        io.readPaths.push(path);
        const b = fs.readFileSync(path);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    };
  }

  async createWritable() {
    const swap = `${this.path}.crswap`;
    const chunks: Uint8Array[] = [];
    const io = this.io;
    const path = this.path;
    return {
      write: async (data: Uint8Array) => {
        chunks.push(data.slice());
      },
      close: async () => {
        fs.writeFileSync(swap, Buffer.concat(chunks));
        fs.renameSync(swap, path);
        io.writes++;
      },
      abort: async () => {
        fs.rmSync(swap, { force: true });
      },
    };
  }
}

export class NodeDirHandle implements FolderHandle {
  readonly kind = 'directory' as const;
  readonly io: IoCounters;
  constructor(
    readonly path: string,
    readonly name = path.split('/').pop() || 'root',
    io?: IoCounters,
  ) {
    this.io = io ?? { reads: 0, writes: 0, readPaths: [] };
  }

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
    checkName(name);
    const p = join(this.path, name);
    const st = statOrNull(p);
    if (st?.isDirectory()) return new NodeDirHandle(p, name, this.io);
    if (st) throw domError('TypeMismatchError');
    if (!options.create) throw domError('NotFoundError');
    fs.mkdirSync(p);
    return new NodeDirHandle(p, name, this.io);
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}) {
    checkName(name);
    const p = join(this.path, name);
    const st = statOrNull(p);
    if (st?.isFile()) return new NodeFileHandle(name, p, this.io);
    if (st) throw domError('TypeMismatchError');
    if (!options.create) throw domError('NotFoundError');
    fs.writeFileSync(p, new Uint8Array());
    return new NodeFileHandle(name, p, this.io);
  }

  async removeEntry(name: string, options: { recursive?: boolean } = {}) {
    checkName(name);
    const p = join(this.path, name);
    const st = statOrNull(p);
    if (!st) throw domError('NotFoundError');
    if (st.isDirectory()) {
      if (!options.recursive && fs.readdirSync(p).length > 0)
        throw domError('InvalidModificationError');
      fs.rmSync(p, { recursive: true });
    } else fs.unlinkSync(p);
  }

  async *values(): AsyncIterable<NodeDirHandle | NodeFileHandle> {
    for (const e of fs.readdirSync(this.path, { withFileTypes: true })) {
      // Chromium hides its own swap files.
      if (e.name.endsWith('.crswap')) continue;
      const p = join(this.path, e.name);
      if (e.isDirectory()) yield new NodeDirHandle(p, e.name, this.io);
      else yield new NodeFileHandle(e.name, p, this.io);
    }
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }
  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }
}
