/// An in-memory `FileSystemDirectoryHandle` for the folder provider's tests.

import type { FolderFileHandle, FolderHandle } from '../../src/providers/folder';

const err = (name: string) => Object.assign(new Error(name), { name });

let clock = 1_700_000_000_000;
/** mtimes advance on every write, like a real disk (ms resolution). */
const tick = () => ++clock;

export class FakeFile implements FolderFileHandle {
  readonly kind = 'file' as const;
  bytes: Uint8Array = new Uint8Array();
  lastModified = tick();
  constructor(readonly name: string) {}
  async getFile() {
    const bytes = this.bytes;
    return {
      lastModified: this.lastModified,
      size: bytes.length,
      arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    };
  }
  async createWritable() {
    let next: Uint8Array = new Uint8Array();
    return {
      write: async (data: Uint8Array) => {
        next = data.slice();
      },
      close: async () => {
        this.bytes = next;
        this.lastModified = tick();
      },
      abort: async () => undefined,
    };
  }
}

export class FakeDir implements FolderHandle {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeDir | FakeFile>();
  permission: PermissionState = 'granted';
  constructor(readonly name = 'root') {}

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
    const c = this.children.get(name);
    if (c instanceof FakeDir) return c;
    if (c) throw err('TypeMismatchError');
    if (!options.create) throw err('NotFoundError');
    const d = new FakeDir(name);
    this.children.set(name, d);
    return d;
  }
  async getFileHandle(name: string, options: { create?: boolean } = {}) {
    const c = this.children.get(name);
    if (c instanceof FakeFile) return c;
    if (c) throw err('TypeMismatchError');
    if (!options.create) throw err('NotFoundError');
    const f = new FakeFile(name);
    this.children.set(name, f);
    return f;
  }
  /** Like Chromium: a non-empty folder needs `recursive`. */
  async removeEntry(name: string, options: { recursive?: boolean } = {}) {
    const c = this.children.get(name);
    if (!c) throw err('NotFoundError');
    if (c instanceof FakeDir && c.children.size > 0 && !options.recursive)
      throw err('InvalidModificationError');
    this.children.delete(name);
  }
  async *values() {
    for (const c of [...this.children.values()]) yield c;
  }
  async queryPermission() {
    return this.permission;
  }
  async requestPermission() {
    if (this.permission === 'prompt') this.permission = 'granted';
    return this.permission;
  }

  /** Writes a file directly (another program, or a desktop sync client). */
  async put(path: string, content: string | Uint8Array) {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop()!;
    let d: FakeDir = this;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
    const f = await d.getFileHandle(name, { create: true });
    f.bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    f.lastModified = tick();
  }

  async text(path: string): Promise<string | undefined> {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop()!;
    let d: FakeDir = this;
    try {
      for (const p of parts) d = await d.getDirectoryHandle(p);
      return new TextDecoder().decode((await d.getFileHandle(name)).bytes);
    } catch {
      return undefined;
    }
  }
}
