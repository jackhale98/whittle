// SPDX-License-Identifier: GPL-3.0-or-later
// Local git repo mode on the in-memory FakeDir: repository discovery, states, scoping helpers.
import type { StorageResult } from '@whittle/contracts';
import git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import {
  fsaGitFs,
  lfsPointer,
  matchesLfs,
  normalizeProjectPath,
  openLocalGitRepo,
  ProjectScope,
  sha256Hex,
  sharedGitPath,
} from '../src';
import { FakeDir } from './support/fake-dir';

const value = <T>(r: StorageResult<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const errorOf = <T>(r: StorageResult<T>) => {
  if (r.ok) throw new Error('expected a failure');
  return r.error;
};
const author = { name: 'T', email: 't@example.com', timestamp: 1_700_000_000, timezoneOffset: 0 };

/** A repository made by isomorphic-git in `root` (at `gitdir`), with one commit. */
async function seed(root: FakeDir, gitdir = '/.git') {
  const fs = fsaGitFs(root);
  const at = { fs, dir: '/', gitdir };
  await git.init({ ...at, defaultBranch: 'main' });
  await root.put('proj/params.json', '{}\n');
  await root.put('README.md', '# r\n');
  await git.add({ ...at, filepath: '.' });
  return git.commit({ ...at, message: 'seed', author });
}

describe('openLocalGitRepo: finding the repository', () => {
  it('opens .git/ in the picked folder', async () => {
    const root = new FakeDir();
    await seed(root);
    const repo = value(await openLocalGitRepo(root, { projectPath: '/proj/' }));
    expect(repo).toMatchObject({
      layout: 'dotgit',
      gitdir: '/.git',
      dir: '/',
      projectPath: 'proj',
    });
    expect(await repo.state()).toMatchObject({ branch: 'main', readOnly: null });
    expect([...value(await repo.history.read((await repo.history.log())[0]!.id)).keys()]).toEqual([
      'params.json',
    ]);
  });

  it('a .git file inside the folder works; one pointing outside (relative or absolute) is UNSUPPORTED', async () => {
    const root = new FakeDir();
    await seed(root, '/.store/repo');
    await root.put('.git', 'gitdir: .store/repo\n');
    expect(value(await openLocalGitRepo(root)).layout).toBe('gitfile');
    await root.put('.git', 'gitdir: ../elsewhere/.git/modules/proj\n');
    const up = errorOf(await openLocalGitRepo(root));
    expect(up.code).toBe('UNSUPPORTED');
    expect(up.message).toMatch(/outside ‘root’/);
    await root.put('.git', 'gitdir: /home/ann/repo/.git/worktrees/root\n');
    expect(errorOf(await openLocalGitRepo(root)).code).toBe('UNSUPPORTED');
    await root.put('.git', 'gitdir: C:\\Users\\ann\\repo\\.git\n');
    expect(errorOf(await openLocalGitRepo(root)).code).toBe('UNSUPPORTED');
    await root.put('.git', 'nonsense\n');
    expect(errorOf(await openLocalGitRepo(root)).code).toBe('UNSUPPORTED');
    await root.put('.git', 'gitdir: .missing\n');
    expect(errorOf(await openLocalGitRepo(root)).code).toBe('NOT_FOUND');
  });

  it('a worktree whose commondir is outside the folder is UNSUPPORTED', async () => {
    const root = new FakeDir();
    await seed(root, '/.store/repo');
    await root.put('.store/repo/commondir', '../../../main/.git\n');
    await root.put('.git', 'gitdir: .store/repo\n');
    const e = errorOf(await openLocalGitRepo(root));
    expect(e.code).toBe('UNSUPPORTED');
    expect(e.message).toMatch(/worktree/);
  });

  it('no repository, a refused permission, a bad project path', async () => {
    const root = new FakeDir();
    await root.put('a.txt', 'x');
    expect(errorOf(await openLocalGitRepo(root)).code).toBe('NOT_FOUND');
    await seed(root);
    root.permission = 'denied';
    expect(errorOf(await openLocalGitRepo(root)).code).toBe('PERMISSION');
    root.permission = 'granted';
    expect(errorOf(await openLocalGitRepo(root, { projectPath: '../up' })).code).toBe('NOT_FOUND');
    expect(errorOf(await openLocalGitRepo(root, { projectPath: 'a/.git/x' })).code).toBe(
      'NOT_FOUND',
    );
  });

  it('SHA-256 repositories are UNSUPPORTED', async () => {
    const root = new FakeDir();
    await seed(root);
    const fs = fsaGitFs(root);
    await git.setConfig({ fs, dir: '/', path: 'extensions.objectformat', value: 'sha256' });
    const e = errorOf(await openLocalGitRepo(root));
    expect(e.code).toBe('UNSUPPORTED');
    expect(e.message).toMatch(/sha256/);
  });
});

describe('openLocalGitRepo: read-only states', () => {
  it('index.lock (another git running) and an index format other than 2 refuse writes', async () => {
    const root = new FakeDir();
    await seed(root);
    const repo = value(await openLocalGitRepo(root, { projectPath: 'proj' }));
    const files = new Map([['params.json', new TextEncoder().encode('{"a":1}\n')]]);
    await root.put('.git/index.lock', '');
    expect((await repo.state()).readOnly?.reason).toBe('busy');
    const busy = errorOf(await repo.history.saveVersion(files, 'x', { author }));
    expect(busy).toMatchObject({ code: 'READ_ONLY' });
    expect(busy.message).toMatch(/index\.lock/);
    await (await root.getDirectoryHandle('.git')).removeEntry('index.lock');
    const index = (await root.getDirectoryHandle('.git')).children.get('index') as {
      bytes: Uint8Array;
    };
    const v3 = index.bytes.slice();
    new DataView(v3.buffer).setUint32(4, 3);
    const v2 = index.bytes;
    index.bytes = v3;
    expect((await repo.state()).readOnly?.reason).toBe('indexFormat');
    index.bytes = v2;
    expect((await repo.state()).readOnly).toBeNull();
    await root.put('proj/params.json', '{"a":1}\n');
    value(await repo.history.saveVersion(files, 'ok', { author }));
  });

  it('cherry-pick, revert and bisect in progress are read-only', async () => {
    const root = new FakeDir();
    await seed(root);
    const repo = value(await openLocalGitRepo(root));
    for (const [file, reason] of [
      ['CHERRY_PICK_HEAD', 'cherryPick'],
      ['REVERT_HEAD', 'revert'],
      ['BISECT_LOG', 'bisect'],
      ['MERGE_HEAD', 'merge'],
    ] as const) {
      await root.put(`.git/${file}`, 'x');
      const s = await repo.state();
      expect(s.readOnly?.reason).toBe(reason);
      expect(s.readOnly?.message.length).toBeGreaterThan(20);
      await (await root.getDirectoryHandle('.git')).removeEntry(file);
    }
    await root.put('.git/rebase-apply/next', '1');
    expect((await repo.state()).readOnly?.reason).toBe('rebase');
  });

  it('local repo mode never runs git init: a vanished .git is NOT_FOUND', async () => {
    const root = new FakeDir();
    await seed(root);
    const repo = value(await openLocalGitRepo(root));
    await root.removeEntry('.git', { recursive: true });
    const e = errorOf(await repo.history.saveVersion(new Map(), 'x', { author }));
    expect(e.code).toBe('NOT_FOUND');
    expect(root.children.has('.git')).toBe(false);
  });
});

describe('helpers', () => {
  it('sharedGitPath follows git’s common_list', () => {
    for (const p of [
      'objects/ab/cd',
      'refs/heads/main',
      'packed-refs',
      'config',
      'logs/refs/heads/x',
      'info/exclude',
      'hooks/pre-commit',
    ])
      expect(sharedGitPath(p), p).toBe(true);
    for (const p of [
      'HEAD',
      'index',
      'MERGE_HEAD',
      'logs/HEAD',
      'refs/bisect/bad',
      'refs/worktree/x',
      'info/sparse-checkout',
      'rebase-merge/done',
      'ORIG_HEAD',
    ])
      expect(sharedGitPath(p), p).toBe(false);
  });

  it('lfsPointer reads git-lfs v1 pointers and nothing else', async () => {
    const content = new TextEncoder().encode('real content\n');
    const oid = await sha256Hex(content);
    const ptr = new TextEncoder().encode(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`,
    );
    expect(lfsPointer(ptr)).toEqual({ oid, size: content.length });
    expect(lfsPointer(content)).toBeNull();
    expect(lfsPointer(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(await matchesLfs(ptr, content)).toBe(true);
    expect(await matchesLfs(ptr, ptr)).toBe(true);
    expect(await matchesLfs(ptr, new TextEncoder().encode('real content!\n'))).toBe(false);
    expect(await matchesLfs(content, content)).toBe(false);
  });

  it('ProjectScope maps repository and project paths', () => {
    expect(normalizeProjectPath('/CAD/bracket/')).toBe('CAD/bracket');
    expect(normalizeProjectPath('')).toBe('');
    expect(normalizeProjectPath('./a//b')).toBe('a/b');
    expect(() => normalizeProjectPath('a/../..')).toThrow();
    const s = new ProjectScope('cad/bracket');
    expect(s.toRepo('params.json')).toBe('cad/bracket/params.json');
    expect(s.toProject('cad/bracket/parts/a.json')).toBe('parts/a.json');
    expect(s.toProject('cad/bracketeer/x')).toBeNull();
    expect(s.toProject('cad/bracket')).toBeNull();
    expect(['.', 'cad', 'cad/bracket', 'cad/bracket/x'].every((p) => s.worthWalking(p))).toBe(true);
    expect(['cad/lid', 'README.md', 'cad/bracketeer'].some((p) => s.worthWalking(p))).toBe(false);
    expect(s.tagPrefix).toBe('cad/bracket/');
    expect(new ProjectScope('My Parts/bracket').tagPrefix).toBe('My-Parts/bracket/');
    const whole = new ProjectScope();
    expect(whole.whole && whole.toProject('a/b') === 'a/b' && whole.tagPrefix === '').toBe(true);
  });
});
