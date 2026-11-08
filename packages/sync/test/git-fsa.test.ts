// SPDX-License-Identifier: GPL-3.0-or-later
// fsaGitFs: isomorphic-git's fs over File System Access, on the in-memory FakeDir.
import git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { FsaStats, fsaGitFs, resolveSegments } from '../src/history/git/fsa-fs';
import { FakeDir, type FakeFile } from './support/fake-dir';

const enc = (s: string) => new TextEncoder().encode(s);
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return (e as { code?: string }).code ?? `no code: ${String(e)}`;
  }
};

describe('fsaGitFs', () => {
  it('reads and writes files, with an encoding option, creating parent folders', async () => {
    const root = new FakeDir();
    const { promises: fs } = fsaGitFs(root);
    await fs.writeFile('/a/b/c.txt', 'héllo\n');
    expect(await root.text('a/b/c.txt')).toBe('héllo\n');
    expect(await fs.readFile('/a/b/c.txt', { encoding: 'utf8' })).toBe('héllo\n');
    expect(await fs.readFile('/a/b/c.txt', 'utf8')).toBe('héllo\n');
    const bytes = (await fs.readFile('/a/b/c.txt')) as Uint8Array;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes]).toEqual([...enc('héllo\n')]);
    await fs.writeFile('a/b/c.txt', new Uint8Array([1, 2, 3]));
    expect([...((await fs.readFile('/a/b/c.txt')) as Uint8Array)]).toEqual([1, 2, 3]);
    // `.` segments and doubled slashes are harmless; `/` is the picked folder.
    expect(await fs.readFile('//a/./b//c.txt', 'utf8')).toBe('\u0001\u0002\u0003');
    expect((await fs.readdir('/')).sort()).toEqual(['a']);
  });

  it('throws Node-style errors isomorphic-git branches on', async () => {
    const root = new FakeDir();
    const { promises: fs } = fsaGitFs(root);
    await root.put('dir/file.txt', 'x');
    expect(await codeOf(fs.readFile('/missing'))).toBe('ENOENT');
    expect(await codeOf(fs.readFile('/dir/missing/deeper'))).toBe('ENOENT');
    expect(await codeOf(fs.readFile('/dir/file.txt/below'))).toBe('ENOTDIR');
    expect(await codeOf(fs.readFile('/dir'))).toBe('EISDIR');
    expect(await codeOf(fs.stat('/nope'))).toBe('ENOENT');
    expect(await codeOf(fs.lstat('/dir/file.txt/x'))).toBe('ENOTDIR');
    expect(await codeOf(fs.readdir('/dir/file.txt'))).toBe('ENOTDIR');
    expect(await codeOf(fs.readdir('/nope'))).toBe('ENOENT');
    expect(await codeOf(fs.mkdir('/dir'))).toBe('EEXIST');
    expect(await codeOf(fs.mkdir('/dir/file.txt'))).toBe('EEXIST');
    expect(await codeOf(fs.mkdir('/x/y'))).toBe('ENOENT');
    expect(await codeOf(fs.mkdir('/x/y', { recursive: true }))).toBe('resolved');
    expect(await codeOf(fs.mkdir('/x/y', { recursive: true }))).toBe('resolved');
    expect(await codeOf(fs.rmdir('/dir'))).toBe('ENOTEMPTY');
    expect(await codeOf(fs.rmdir('/dir/file.txt'))).toBe('ENOTDIR');
    expect(await codeOf(fs.unlink('/dir'))).toBe('EISDIR');
    expect(await codeOf(fs.unlink('/nope'))).toBe('ENOENT');
    expect(await codeOf(fs.writeFile('/dir', 'x'))).toBe('EISDIR');
    expect(await codeOf(fs.unlink('/dir/file.txt'))).toBe('resolved');
    expect(await codeOf(fs.rmdir('/dir'))).toBe('resolved');
    expect(root.children.has('dir')).toBe(false);
    await root.put('deep/a/b.txt', 'b');
    expect(await codeOf(fs.rm('/deep'))).toBe('EISDIR');
    expect(await codeOf(fs.rm('/deep', { recursive: true }))).toBe('resolved');
    expect(await codeOf(fs.rm('/deep', { force: true }))).toBe('resolved');
    expect(await codeOf(fs.rm('/deep'))).toBe('ENOENT');
  });

  it('has no symlinks: readlink and symlink reject cleanly', async () => {
    const root = new FakeDir();
    const { promises: fs } = fsaGitFs(root);
    await root.put('f', 'x');
    expect(await codeOf(fs.readlink('/missing'))).toBe('ENOENT');
    expect(await codeOf(fs.readlink('/f'))).toBe('ENOTSUP');
    expect(await codeOf(fs.symlink('f', '/link'))).toBe('ENOTSUP');
    expect(root.children.has('link')).toBe(false);
  });

  it('stats carry type, mode, size and the file’s lastModified; stable while unchanged', async () => {
    const root = new FakeDir();
    const { promises: fs } = fsaGitFs(root);
    await fs.writeFile('/f.json', '{}\n');
    const file = root.children.get('f.json') as FakeFile;
    const s = await fs.stat('/f.json');
    expect(s).toBeInstanceOf(FsaStats);
    expect(s).toMatchObject({
      type: 'file',
      mode: 0o100644,
      size: 3,
      ino: 0,
      uid: 0,
      gid: 0,
      dev: 0,
    });
    expect(s.mtimeMs).toBe(file.lastModified);
    expect(s.ctimeMs).toBe(file.lastModified);
    expect(s.isFile() && !s.isDirectory() && !s.isSymbolicLink()).toBe(true);
    expect(await fs.stat('/f.json')).toEqual(s);
    expect(await fs.lstat('/f.json')).toEqual(s);
    const d = await fs.stat('/');
    expect(d.isDirectory() && d.mode === 0o040000).toBe(true);
    await fs.writeFile('/f.json', '{"a":1}\n');
    expect((await fs.stat('/f.json')).mtimeMs).toBeGreaterThan(s.mtimeMs);
  });

  it('never reaches outside the picked folder', async () => {
    const outer = new FakeDir('outer');
    const root = await outer.getDirectoryHandle('picked', { create: true });
    await outer.put('secret.txt', 'outside');
    const { promises: fs } = fsaGitFs(root);
    expect(resolveSegments('/a/../..')).toBeNull();
    expect(resolveSegments('/a/b/../c')).toEqual(['a', 'c']);
    expect(await codeOf(fs.readFile('/../secret.txt'))).toBe('ENOENT');
    expect(await codeOf(fs.stat('../secret.txt'))).toBe('ENOENT');
    expect(await codeOf(fs.writeFile('/../evil.txt', 'x'))).toBe('EPERM');
    expect(await codeOf(fs.writeFile('/a/../../evil.txt', 'x'))).toBe('EPERM');
    expect(await codeOf(fs.mkdir('/../evil'))).toBe('EPERM');
    expect(await codeOf(fs.unlink('/../secret.txt'))).toBe('ENOENT');
    expect(await codeOf(fs.rmdir('/'))).toBe('EPERM');
    expect([...outer.children.keys()].sort()).toEqual(['picked', 'secret.txt']);
    expect(await outer.text('secret.txt')).toBe('outside');
  });

  it('writes are atomic per file: a failed write leaves the old content', async () => {
    const root = new FakeDir();
    const { promises: fs } = fsaGitFs(root);
    await fs.writeFile('/f', 'old');
    const file = root.children.get('f') as FakeFile;
    const real = file.createWritable.bind(file);
    let aborted = false;
    file.createWritable = async () => {
      const w = await real();
      return {
        write: async () => {
          throw Object.assign(new Error('disk full'), { name: 'QuotaExceededError' });
        },
        close: w.close,
        abort: async () => {
          aborted = true;
        },
      };
    };
    expect(await codeOf(fs.writeFile('/f', 'new'))).toBe('ENOSPC');
    expect(aborted).toBe(true);
    expect(await root.text('f')).toBe('old');
  });

  it('runs isomorphic-git: init, add, commit, log, statusMatrix and checkout', async () => {
    const root = new FakeDir();
    const fs = fsaGitFs(root);
    const at = { fs, dir: '/', gitdir: '/.git' };
    await git.init({ ...at, defaultBranch: 'main' });
    await fs.promises.writeFile('/a.txt', 'one\n');
    await fs.promises.writeFile('/sub/b.txt', 'two\n');
    await git.add({ ...at, filepath: '.' });
    const author = {
      name: 'T',
      email: 't@example.com',
      timestamp: 1_700_000_000,
      timezoneOffset: 0,
    };
    const c1 = await git.commit({ ...at, message: 'one', author });
    expect((await git.log(at)).map((c) => c.oid)).toEqual([c1]);
    expect(await git.statusMatrix(at)).toEqual([
      ['a.txt', 1, 1, 1],
      ['sub/b.txt', 1, 1, 1],
    ]);
    await git.branch({ ...at, ref: 'idea', checkout: true });
    await fs.promises.writeFile('/a.txt', 'changed\n');
    await git.add({ ...at, filepath: 'a.txt' });
    await git.remove({ ...at, filepath: 'sub/b.txt' });
    await fs.promises.unlink('/sub/b.txt');
    await git.commit({ ...at, message: 'two', author });
    await git.checkout({ ...at, ref: 'main' });
    expect(await root.text('a.txt')).toBe('one\n');
    expect(await root.text('sub/b.txt')).toBe('two\n');
    await git.checkout({ ...at, ref: 'idea' });
    expect(await root.text('sub/b.txt')).toBeUndefined();
    expect(await git.statusMatrix(at)).toEqual([['a.txt', 1, 1, 1]]);
  });
});
