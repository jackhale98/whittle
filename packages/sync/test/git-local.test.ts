// SPDX-License-Identifier: GPL-3.0-or-later
// Local git repo mode (ADR-029) against repositories made and read by the real `git` CLI, through
// fsaGitFs over a FileSystemDirectoryHandle double backed by a real temp folder.
import fs from 'node:fs';
import { join } from 'node:path';
import type { Author, Feature, ProjectFiles, StorageResult, WhittleDoc } from '@whittle/contracts';
import { fromFiles, toFiles } from '@whittle/document';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { afterAll, describe, expect, it } from 'vitest';
import { type LocalGitRepo, mergeProjectFiles, openLocalGitRepo, sha256Hex } from '../src';
import { type CliRepo, cli, cliAsync, cliRepo, tempDir, writeProject } from './support/cli-git';
import { apply, baseDoc, FILLET, featureOf, P_WIDTH, PART } from './support/fixtures';
import { startGitServer } from './support/git-server';

const ann: Author = { name: 'Ann', email: 'ann@example.com' };
const value = <T>(r: StorageResult<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const errorOf = <T>(r: StorageResult<T>) => {
  if (r.ok) throw new Error('expected a failure');
  return r.error;
};

let clock = Date.parse('2026-07-01T09:00:00Z');
const tick = () => {
  clock += 60_000;
  return new Date(clock);
};

const repos: CliRepo[] = [];
afterAll(() => {
  for (const r of repos) r.cleanup();
});

const BRACKET = 'cad/bracket';
const LID = 'cad/lid';

function project(name = 'Bracket'): ProjectFiles {
  const doc = baseDoc();
  doc.meta.name = name;
  const files = toFiles(doc);
  files.set('imports/bolt.step', new Uint8Array([0, 1, 2, 255, 10, 13]));
  return files;
}
const docOf = (files: ProjectFiles): WhittleDoc => fromFiles(files);
const withRadius = (doc: WhittleDoc, radius: string) => {
  const f = featureOf(doc, FILLET) as Feature;
  return apply(doc, {
    kind: 'updateFeature',
    partId: PART,
    featureId: FILLET,
    feature: { ...f, radius } as Feature,
  });
};
const edit = (files: ProjectFiles, change: (d: WhittleDoc) => WhittleDoc): ProjectFiles => {
  const out = new Map(files);
  for (const [p, b] of toFiles(change(docOf(files)))) out.set(p, b);
  return out;
};
const radiusOf = (files: ProjectFiles) =>
  (featureOf(docOf(files), FILLET) as { radius: string }).radius;
const sameFiles = (a: ProjectFiles, b: ProjectFiles) => {
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [p, bytes] of a)
    expect(Buffer.from(b.get(p) as Uint8Array).equals(Buffer.from(bytes)), p).toBe(true);
};

/** A repo with two projects and an unrelated README, committed by the CLI. */
function twoProjects(): CliRepo {
  const r = cliRepo();
  repos.push(r);
  writeProject(r, BRACKET, project('Bracket'));
  writeProject(r, LID, project('Lid'));
  r.write('README.md', '# Parts\n');
  r.git('add', '.');
  r.git('commit', '-q', '-m', 'seed');
  return r;
}

async function open(r: CliRepo, projectPath = BRACKET, extra = {}): Promise<LocalGitRepo> {
  return value(
    await openLocalGitRepo(r.handle(), { projectPath, author: ann, now: tick, ...extra }),
  );
}

/** What the app does in local mode: saves the project's files into the folder, then commits. */
function saveToDisk(r: CliRepo, folder: string, files: ProjectFiles) {
  writeProject(r, folder, files);
}

const porcelain = (r: CliRepo) => r.git('status', '--porcelain', '--untracked-files=all');

describe('local git repo: interop with the git CLI', { timeout: 30_000 }, () => {
  it('Whittle commits; git log and git status see the commit and a clean tree', async () => {
    const r = twoProjects();
    const repo = await open(r);
    expect(repo.layout).toBe('dotgit');
    const h = repo.history;
    expect(value(await h.workingChanges())).toEqual([]);
    const files = value(await h.read((await h.log())[0]!.id));
    sameFiles(files, project('Bracket'));
    const next = edit(files, (d) => withRadius(d, '3mm'));
    saveToDisk(r, BRACKET, next);
    expect(value(await h.workingChanges())).toEqual([
      {
        path: `parts/${[...next.keys()].find((p) => p.startsWith('parts/'))!.slice(6)}`,
        status: 'modified',
      },
    ]);
    const v = value(await h.saveVersion(next, 'Round more', { author: ann }));
    expect(r.git('log', '-1', '--format=%H %s %an <%ae>')).toBe(
      `${v.id} Round more Ann <ann@example.com>`,
    );
    expect(porcelain(r)).toBe('');
    expect(r.git('fsck', '--no-progress')).toBe('');
    // Only the project's file is in the commit.
    expect(r.git('show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual([
      `${BRACKET}/${[...next.keys()].find((p) => p.startsWith('parts/'))}`,
    ]);
    expect(value(await h.workingChanges())).toEqual([]);
    // git reflog has Whittle's commit.
    expect(r.git('reflog', '-1', '--format=%gs')).toBe('commit: Round more');
  });

  it('a commit leaves everything else in the repository alone: other edits, staged files, the other project', async () => {
    const r = twoProjects();
    const h = (await open(r)).history;
    const files = value(await h.read((await h.log())[0]!.id));
    r.write('README.md', '# Parts, edited\n');
    r.write('notes.txt', 'staged\n');
    r.git('add', 'notes.txt');
    r.write(`${LID}/params.json`, '{"lid": "edited"}\n');
    const next = edit(files, (d) =>
      apply(d, { kind: 'updateParam', paramId: P_WIDTH, expr: '45mm' }),
    );
    saveToDisk(r, BRACKET, next);
    value(await h.saveVersion(next, 'Wider', { author: ann }));
    expect(porcelain(r).split('\n').sort()).toEqual([
      ' M README.md',
      ` M ${LID}/params.json`,
      'A  notes.txt',
    ]);
    expect(r.git('show', '--name-only', '--format=', 'HEAD')).toBe(`${BRACKET}/params.json`);
    expect(r.read('README.md')).toBe('# Parts, edited\n');
    expect(r.read(`${LID}/params.json`)).toBe('{"lid": "edited"}\n');
  });

  it('a commit made with the CLI shows up in log() after refresh(); other projects’ commits don’t', async () => {
    const r = twoProjects();
    const h = (await open(r)).history;
    const before = (await h.log()).map((v) => v.id);
    const files = value(await h.read(before[0]!));
    writeProject(
      r,
      BRACKET,
      edit(files, (d) => withRadius(d, '9mm')),
    );
    r.git('commit', '-q', '-am', 'CLI: radius 9');
    r.write(`${LID}/notes.md`, 'lid only\n');
    r.git('add', '.');
    r.git('commit', '-q', '-m', 'CLI: lid notes');
    h.refresh();
    const log = await h.log();
    expect(log.map((v) => v.message)).toEqual(['CLI: radius 9', 'seed']);
    expect(log[0]!.parents).toEqual([before[0]]);
    expect(radiusOf(value(await h.read(log[0]!.id)))).toBe('9mm');
    // The lid project sees its own history only.
    const lid = (await open(r, LID)).history;
    expect((await lid.log()).map((v) => v.message)).toEqual(['CLI: lid notes', 'seed']);
    const lidFiles = value(await lid.read((await lid.log())[0]!.id));
    expect(new TextDecoder().decode(lidFiles.get('notes.md'))).toBe('lid only\n');
    expect([...lidFiles.keys()].some((p) => p.startsWith('cad/'))).toBe(false);
  });

  it('CLI branches appear in Whittle; switching moves HEAD for git too', async () => {
    const r = twoProjects();
    r.git('branch', 'idea');
    r.git('branch', 'feature/thin-wall');
    const h = (await open(r)).history;
    expect((await h.branches()).map((b) => [b.name, b.current]).sort()).toEqual([
      ['feature/thin-wall', false],
      ['idea', false],
      ['main', true],
    ]);
    const files = value(await h.switchBranch('feature/thin-wall'));
    sameFiles(files, project('Bracket'));
    expect(r.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/thin-wall');
    expect(porcelain(r)).toBe('');
    const next = edit(files, (d) => withRadius(d, '1mm'));
    saveToDisk(r, BRACKET, next);
    const v = value(await h.saveVersion(next, 'Thin', { author: ann }));
    expect(r.git('rev-parse', 'feature/thin-wall')).toBe(v.id);
    expect(r.git('rev-parse', 'main')).not.toBe(v.id);
    sameFiles(value(await h.switchBranch('main')), project('Bracket'));
    expect(r.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(porcelain(r)).toBe('');
    // The checkout put main's part file back on disk.
    const part = [...files.keys()].find((p) => p.startsWith('parts/'))!;
    expect(r.read(`${BRACKET}/${part}`)).toBe(new TextDecoder().decode(files.get(part)));
    expect(radiusOf(value(await h.read(r.git('rev-parse', 'HEAD'))))).toBe('2mm');
    expect(r.git('reflog', '-1', '--format=%gs')).toBe(
      'checkout: moving from feature/thin-wall to main',
    );
  });

  it('Whittle’s release is a real annotated tag in git tag, scoped to the project folder', async () => {
    const r = twoProjects();
    const h = (await open(r)).history;
    const head = (await h.log())[0]!;
    const exportBytes = new TextEncoder().encode('ISO-10303-21;\n');
    const rel = value(
      await h.release(head.id, 'Rev A', new Map([['bracket.step', exportBytes]]), ann),
    );
    expect(rel.files).toEqual(['releases/rev-a/bracket.step']);
    expect(r.git('tag')).toBe('cad/bracket/Rev-A');
    expect(r.git('cat-file', '-t', 'cad/bracket/Rev-A')).toBe('tag');
    expect(r.git('rev-parse', 'cad/bracket/Rev-A^{commit}')).toBe(head.id);
    expect(r.read(`${BRACKET}/releases/rev-a/bracket.step`)).toBe('ISO-10303-21;\n');
    expect(porcelain(r)).toBe('');
    // The other project has no releases; Whittle reads a CLI tag of its own folder.
    const lid = (await open(r, LID)).history;
    expect(await lid.releases()).toEqual([]);
    r.git('tag', '-a', 'cad/lid/Rev-1', '-m', 'Rev 1');
    lid.refresh();
    expect((await lid.releases()).map((x) => x.name)).toEqual(['Rev 1']);
  });

  it('reads packed refs and packfiles after git gc, then keeps committing', async () => {
    const r = twoProjects();
    r.git('branch', 'idea');
    r.git('tag', '-a', 'cad/bracket/Rev-A', '-m', 'Rev A');
    const h = (await open(r)).history;
    const files = value(await h.read((await h.log())[0]!.id));
    for (const radius of ['3mm', '4mm']) {
      const next = edit(files, (d) => withRadius(d, radius));
      saveToDisk(r, BRACKET, next);
      value(await h.saveVersion(next, `r ${radius}`, { author: ann }));
    }
    const before = (await h.log()).map((v) => [v.id, v.hash]);
    r.git('gc', '-q', '--aggressive', '--prune=now');
    expect(r.exists('.git/packed-refs')).toBe(true);
    expect(fs.readdirSync(join(r.path, '.git/objects/pack')).some((n) => n.endsWith('.pack'))).toBe(
      true,
    );
    expect(fs.existsSync(join(r.path, '.git/refs/heads/main'))).toBe(false);
    const loose = fs
      .readdirSync(join(r.path, '.git/objects'))
      .filter((d) => /^[0-9a-f]{2}$/.test(d));
    expect(loose).toEqual([]);
    h.refresh();
    expect((await h.log()).map((v) => [v.id, v.hash])).toEqual(before);
    expect((await h.branches()).map((b) => b.name).sort()).toEqual(['idea', 'main']);
    expect((await h.releases()).map((x) => x.name)).toEqual(['Rev A']);
    expect(radiusOf(value(await h.read(before[0]![0]!)))).toBe('4mm');
    expect(value(await h.workingChanges())).toEqual([]);
    const next = edit(files, (d) => withRadius(d, '5mm'));
    saveToDisk(r, BRACKET, next);
    const v = value(await h.saveVersion(next, 'After gc', { author: ann }));
    expect(r.git('log', '-1', '--format=%H')).toBe(v.id);
    expect(r.git('fsck', '--no-progress')).toBe('');
    expect(porcelain(r)).toBe('');
    // Branch created after packing writes a loose ref git reads.
    value(await h.createBranch('after-gc'));
    expect(r.git('branch', '--list', 'after-gc')).toContain('after-gc');
  });

  it('LFS pointers stay untouched: the checkout’s content counts as unchanged and commits keep the pointer', async () => {
    const r = twoProjects();
    const real = new TextEncoder().encode('ISO-10303-21; a big STEP file\n'.repeat(50));
    const oid = await sha256Hex(real);
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${real.length}\n`;
    r.write('.gitattributes', `${BRACKET}/imports/*.big filter=lfs diff=lfs merge=lfs -text\n`);
    r.write(`${BRACKET}/imports/housing.big`, pointer);
    r.git('add', '.');
    r.git('commit', '-q', '-m', 'LFS pointer');
    // git-lfs smudged the real content into the checkout.
    r.write(`${BRACKET}/imports/housing.big`, real);
    const h = (await open(r)).history;
    expect(value(await h.workingChanges())).toEqual([]);
    const files = value(await h.read((await h.log())[0]!.id));
    expect(new TextDecoder().decode(files.get('imports/housing.big'))).toBe(pointer);
    // The app holds the real content (read from disk) and saves a version.
    const appFiles = edit(new Map([...files, ['imports/housing.big', real]]), (d) =>
      withRadius(d, '3mm'),
    );
    saveToDisk(r, BRACKET, appFiles);
    const v = value(await h.saveVersion(appFiles, 'Radius', { author: ann }));
    expect(r.git('show', `${v.id}:${BRACKET}/imports/housing.big`)).toBe(pointer.trimEnd());
    expect(r.git('show', '--name-only', '--format=', v.id)).not.toContain('housing.big');
    expect(
      Buffer.from(fs.readFileSync(join(r.path, BRACKET, 'imports/housing.big'))).equals(
        Buffer.from(real),
      ),
    ).toBe(true);
    // Changing an LFS file through Whittle is refused, never committed as content.
    const changed = new Map(appFiles);
    changed.set('imports/housing.big', new TextEncoder().encode('different\n'));
    const e = errorOf(await h.saveVersion(changed, 'Bad', { author: ann }));
    expect(e.code).toBe('UNSUPPORTED');
    expect(e.message).toMatch(/Git LFS/);
    expect(r.git('log', '-1', '--format=%H')).toBe(v.id);
  });

  it('statusMatrix and workingChanges don’t rehash unchanged files', async () => {
    const r = twoProjects();
    // Files older than the index, as in any real checkout (no "racy git" re-checks).
    const past = new Date(Date.now() - 60_000);
    for (const p of r.git('ls-files').split('\n')) fs.utimesSync(join(r.path, p), past, past);
    r.git('update-index', '--refresh');
    const handle = r.handle();
    const repo = value(await openLocalGitRepo(handle, { projectPath: BRACKET, now: tick }));
    const workReads = () => handle.io.readPaths.filter((p) => !p.includes('/.git/')).length;
    // Against an index the git CLI wrote: size and mtime decide, nothing is read.
    expect(value(await repo.history.workingChanges())).toEqual([]);
    expect(repo.history.statusCounters.hashed).toBe(0);
    expect(workReads()).toBe(0);
    // isomorphic-git's own statusMatrix: the first run rehashes (the CLI's index has inodes and
    // ctimes File System Access can't see) and refreshes the index; after that it's stats only.
    const at = { fs: repo.fs, dir: '/', gitdir: repo.gitdir };
    const m1 = await git.statusMatrix(at);
    expect(m1.every(([, h, w, s]) => h === 1 && w === 1 && s === 1)).toBe(true);
    const first = workReads();
    expect(first).toBeGreaterThan(0);
    const m2 = await git.statusMatrix(at);
    expect(m2).toEqual(m1);
    expect(workReads()).toBe(first);
    // The CLI is still happy with the refreshed index.
    expect(porcelain(r)).toBe('');
    // A real edit is found.
    r.write(`${BRACKET}/params.json`, '{}\n');
    expect(value(await repo.history.workingChanges())).toEqual([
      { path: 'params.json', status: 'modified' },
    ]);
  });
});

describe('local git repo: safety', { timeout: 30_000 }, () => {
  it('switchBranch refuses while the project has uncommitted changes, and touches nothing', async () => {
    const r = twoProjects();
    r.git('branch', 'idea');
    const h = (await open(r)).history;
    r.write(`${BRACKET}/params.json`, '{"edited": true}\n');
    r.write(`${BRACKET}/notes.md`, 'new file\n');
    const e = errorOf(await h.switchBranch('idea'));
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toMatch(/uncommitted changes.*Save a version first/);
    expect(r.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(r.read(`${BRACKET}/params.json`)).toBe('{"edited": true}\n');
    expect(value(await h.workingChanges())).toEqual([
      { path: 'notes.md', status: 'added' },
      { path: 'params.json', status: 'modified' },
    ]);
  });

  it('a switch that would replace another file’s local edits refuses (never forced); unrelated edits ride along', async () => {
    const r = twoProjects();
    r.git('checkout', '-q', '-b', 'idea');
    r.write(`${LID}/params.json`, '{"on": "idea"}\n');
    r.git('commit', '-q', '-am', 'lid on idea');
    r.git('checkout', '-q', 'main');
    const h = (await open(r)).history;
    // The lid file differs between branches and has local edits: refused.
    r.write(`${LID}/params.json`, '{"local": "edit"}\n');
    const e = errorOf(await h.switchBranch('idea'));
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toContain(`${LID}/params.json`);
    expect(r.read(`${LID}/params.json`)).toBe('{"local": "edit"}\n');
    expect(r.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    // README is the same on both branches: its local edit survives the switch.
    r.git('checkout', '--', `${LID}/params.json`);
    r.write('README.md', '# local edit\n');
    value(await h.switchBranch('idea'));
    expect(r.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('idea');
    expect(r.read('README.md')).toBe('# local edit\n');
    expect(porcelain(r)).toBe(' M README.md');
  });

  it('a commit refuses when a file it replaces was edited on disk since (nothing is overwritten)', async () => {
    const r = twoProjects();
    const h = (await open(r)).history;
    const files = value(await h.read((await h.log())[0]!.id));
    const next = edit(files, (d) => withRadius(d, '3mm'));
    // The app's copy says 3mm, but another program wrote something else to the file.
    const part = [...next.keys()].find((p) => p.startsWith('parts/'))!;
    r.write(`${BRACKET}/${part}`, '{"someone": "else"}\n');
    const e = errorOf(await h.saveVersion(next, 'Mine', { author: ann }));
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toContain(part);
    expect(r.read(`${BRACKET}/${part}`)).toBe('{"someone": "else"}\n');
    expect(r.git('log', '--format=%s')).toBe('seed');
  });

  it('a switch that would create a symlink is refused before anything is written', async () => {
    const r = twoProjects();
    r.git('checkout', '-q', '-b', 'links');
    r.write(`${LID}/params.json`, '{"on": "links"}\n');
    fs.symlinkSync('../README.md', join(r.path, 'cad/readme-link'));
    r.git('add', '.');
    r.git('commit', '-q', '-m', 'a link');
    r.git('checkout', '-q', 'main');
    const lidBefore = r.read(`${LID}/params.json`);
    const h = (await open(r)).history;
    const e = errorOf(await h.switchBranch('links'));
    expect(e.code).toBe('UNSUPPORTED');
    expect(e.message).toContain('cad/readme-link');
    expect(r.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(r.read(`${LID}/params.json`)).toBe(lidBefore);
    expect(porcelain(r)).toBe('');
  });

  it('core.autocrlf checkouts (CRLF on disk) count as unchanged and can be committed over', async () => {
    const r = twoProjects();
    r.git('config', 'core.autocrlf', 'true');
    fs.rmSync(join(r.path, 'cad'), { recursive: true });
    r.git('checkout', '--', '.');
    expect(r.read(`${BRACKET}/params.json`)).toContain('\r\n');
    const h = (await open(r)).history;
    expect(value(await h.workingChanges())).toEqual([]);
    // The app hasn't written the file yet: disk holds the CRLF checkout of the old version.
    const files = value(await h.read((await h.log())[0]!.id));
    const next = edit(files, (d) =>
      apply(d, { kind: 'updateParam', paramId: P_WIDTH, expr: '60mm' }),
    );
    const v = value(await h.saveVersion(next, 'Wider', { author: ann }));
    expect(r.git('log', '-1', '--format=%H')).toBe(v.id);
    expect(r.read(`${BRACKET}/params.json`)).toContain('60mm');
    expect(porcelain(r)).toBe('');
  });

  it('a branch moved by another git while saving is a CONFLICT, not an overwrite', async () => {
    const r = twoProjects();
    const repo = await open(r);
    const h = repo.history;
    const files = value(await h.read((await h.log())[0]!.id));
    const next = edit(files, (d) => withRadius(d, '3mm'));
    saveToDisk(r, BRACKET, next);
    // Another git commits between Whittle reading HEAD and moving the branch.
    const promises = repo.fs.promises as unknown as {
      writeFile: (...a: unknown[]) => Promise<void>;
    };
    const real = promises.writeFile.bind(promises);
    let raced = false;
    promises.writeFile = async (path: unknown, ...rest: unknown[]) => {
      if (!raced && String(path).includes('/objects/') && String(path).length > 0) {
        raced = true;
        r.write('README.md', '# raced\n');
        r.git('commit', '-q', '-am', 'raced');
      }
      return real(path, ...rest);
    };
    const e = errorOf(await h.saveVersion(next, 'Mine', { author: ann }));
    promises.writeFile = real;
    expect(e.code).toBe('CONFLICT');
    expect(r.git('log', '-1', '--format=%s')).toBe('raced');
    expect(r.read('README.md')).toBe('# raced\n');
  });

  it('pull fast-forwards only with a clean project; the CLI sees the result', async () => {
    const server = await startGitServer('unused', { 'x.txt': 'x\n' });
    try {
      server.empty('parts');
      const r = twoProjects();
      r.git('remote', 'add', 'origin', `${server.url}/parts.git`);
      await cliAsync(r.path, 'push', '-q', '-u', 'origin', 'main');
      // Someone else pushes a bracket change and a lid change.
      const other = cliRepo(tempDir(), { init: false });
      repos.push(other);
      await cliAsync(other.path, 'clone', '-q', `${server.url}/parts.git`, '.');
      const theirs = edit(project('Bracket'), (d) => withRadius(d, '7mm'));
      writeProject(other, BRACKET, theirs);
      other.write(`${LID}/notes.md`, 'from the other clone\n');
      other.git('add', '.');
      other.git('commit', '-q', '-m', 'Other: radius 7');
      await cliAsync(other.path, 'push', '-q', 'origin', 'main');
      const repo = await open(r, BRACKET, { http, corsProxy: null });
      const h = repo.history;
      expect(await h.remotes()).toEqual([{ name: 'origin', url: `${server.url}/parts.git` }]);
      r.write(`${BRACKET}/params.json`, '{"dirty": 1}\n');
      const e = errorOf(await h.pull());
      expect(e.code).toBe('CONFLICT');
      expect(r.git('log', '-1', '--format=%s')).toBe('seed');
      expect(r.read(`${BRACKET}/params.json`)).toBe('{"dirty": 1}\n');
      r.git('checkout', '--', `${BRACKET}/params.json`);
      const pulled = value(await h.pull());
      expect(pulled.kind).toBe('fastForward');
      if (pulled.kind === 'fastForward') expect(radiusOf(pulled.files)).toBe('7mm');
      expect(r.git('log', '-1', '--format=%s')).toBe('Other: radius 7');
      expect(r.read(`${LID}/notes.md`)).toBe('from the other clone\n');
      expect(porcelain(r)).toBe('');
    } finally {
      server.close();
    }
  });
});

describe('local git repo: read-only states and layouts', { timeout: 30_000 }, () => {
  it('a merge in progress is read-only until the user finishes it', async () => {
    const r = twoProjects();
    r.git('checkout', '-q', '-b', 'other');
    r.write('README.md', '# other\n');
    r.git('commit', '-q', '-am', 'other');
    r.git('checkout', '-q', 'main');
    r.write('README.md', '# main\n');
    r.git('commit', '-q', '-am', 'main');
    expect(() => r.git('merge', 'other')).toThrow();
    const repo = await open(r);
    expect((await repo.state()).readOnly?.reason).toBe('merge');
    const files = value(await repo.history.read((await repo.history.log())[0]!.id));
    const e = errorOf(
      await repo.history.saveVersion(
        edit(files, (d) => withRadius(d, '3mm')),
        'x',
        { author: ann },
      ),
    );
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toMatch(/merge is in progress/);
    expect(errorOf(await repo.history.switchBranch('other')).message).toMatch(
      /merge is in progress/,
    );
    // Reading still works.
    expect((await repo.history.log()).length).toBeGreaterThan(0);
    r.git('merge', '--abort');
    expect((await repo.state()).readOnly).toBeNull();
    saveToDisk(
      r,
      BRACKET,
      edit(files, (d) => withRadius(d, '3mm')),
    );
    value(
      await repo.history.saveVersion(
        edit(files, (d) => withRadius(d, '3mm')),
        'ok now',
        { author: ann },
      ),
    );
  });

  it('a rebase in progress and a detached HEAD are read-only', async () => {
    const r = twoProjects();
    r.git('checkout', '-q', '-b', 'topic');
    r.write('README.md', '# topic\n');
    r.git('commit', '-q', '-am', 'topic');
    r.git('checkout', '-q', 'main');
    r.write('README.md', '# main\n');
    r.git('commit', '-q', '-am', 'main');
    r.git('checkout', '-q', 'topic');
    expect(() => r.git('rebase', 'main')).toThrow();
    const repo = await open(r);
    expect((await repo.state()).readOnly?.reason).toBe('rebase');
    r.git('rebase', '--abort');
    expect((await repo.state()).readOnly).toBeNull();
    r.git('checkout', '-q', '--detach', 'HEAD~1');
    const s = await repo.state();
    expect(s.readOnly?.reason).toBe('detached');
    expect(s.branch).toBeNull();
    expect(
      errorOf(await repo.history.saveVersion(project(), 'x', { author: ann })).message,
    ).toMatch(/detached/);
  });

  it('a bare repository opens read-only with its history', async () => {
    const src = twoProjects();
    const bare = cliRepo(tempDir(), { init: false });
    repos.push(bare);
    cli(bare.path, 'clone', '-q', '--bare', src.path, '.');
    const repo = value(await openLocalGitRepo(bare.handle(), { projectPath: BRACKET }));
    expect(repo.layout).toBe('bare');
    expect((await repo.state()).readOnly?.reason).toBe('bare');
    expect((await repo.history.log()).map((v) => v.message)).toEqual(['seed']);
    expect(value(await repo.history.workingChanges())).toEqual([]);
    sameFiles(
      value(await repo.history.read((await repo.history.log())[0]!.id)),
      project('Bracket'),
    );
    expect(errorOf(await repo.history.saveVersion(project(), 'x', { author: ann })).code).toBe(
      'CONFLICT',
    );
  });

  it('a folder without a repository is NOT_FOUND', async () => {
    const plain = cliRepo(tempDir(), { init: false });
    repos.push(plain);
    plain.write('a.txt', 'x');
    const e = errorOf(await openLocalGitRepo(plain.handle()));
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toMatch(/isn’t a git repository/);
  });

  it('a .git file pointing inside the picked folder works (separate git dir); outside is UNSUPPORTED', async () => {
    const r = cliRepo(tempDir(), { init: false });
    repos.push(r);
    cli(r.path, 'init', '-q', '-b', 'main', `--separate-git-dir=${join(r.path, '.repo')}`);
    // git writes an absolute path; a relative one keeps working for git and is reachable here.
    r.write('.git', 'gitdir: .repo\n');
    fs.appendFileSync(join(r.path, '.repo/info/exclude'), '/.repo/\n');
    writeProject(r, '', project());
    r.git('add', '.');
    r.git('commit', '-q', '-m', 'seed');
    const repo = value(await openLocalGitRepo(r.handle(), { now: tick }));
    expect(repo.layout).toBe('gitfile');
    const h = repo.history;
    const next = edit(project(), (d) => withRadius(d, '3mm'));
    saveToDisk(r, '', next);
    const v = value(await h.saveVersion(next, 'Via gitfile', { author: ann }));
    expect(r.git('log', '-1', '--format=%H')).toBe(v.id);
    expect(porcelain(r)).toBe('');
    expect(value(await h.workingChanges())).toEqual([]);
    // A linked worktree made by `git worktree add` points outside (absolute path).
    const parent = cliRepo(tempDir(), { init: false });
    repos.push(parent);
    const wt = join(parent.path, 'wt');
    r.git('worktree', 'add', '-q', wt, '-b', 'wt');
    const wtRepo = cliRepo(wt, { init: false });
    const e = errorOf(await openLocalGitRepo(wtRepo.handle()));
    expect(e.code).toBe('UNSUPPORTED');
    expect(e.message).toMatch(/outside/);
  });

  it('a linked worktree whose repository is inside the picked folder works (shared commondir)', async () => {
    const top = tempDir();
    repos.push(cliRepo(top, { init: false }));
    const main = cliRepo(join(top, 'main'));
    writeProject(main, BRACKET, project());
    main.git('add', '.');
    main.git('commit', '-q', '-m', 'seed');
    const wtPath = join(top, 'wt');
    main.git('worktree', 'add', '-q', wtPath, '-b', 'wt');
    // Move the main repository inside the worktree folder and repair the links.
    fs.renameSync(main.path, join(wtPath, '.main'));
    cli(join(wtPath, '.main'), 'worktree', 'repair', wtPath);
    fs.writeFileSync(join(wtPath, '.git'), 'gitdir: .main/.git/worktrees/wt\n');
    fs.appendFileSync(join(wtPath, '.main/.git/info/exclude'), '/.main/\n');
    const wt = cliRepo(wtPath, { init: false });
    repos.push(wt);
    expect(wt.git('status', '--porcelain')).toBe('');
    const repo = value(await openLocalGitRepo(wt.handle(), { projectPath: BRACKET, now: tick }));
    expect(repo.layout).toBe('worktree');
    expect((await repo.state()).branch).toBe('wt');
    const next = edit(project(), (d) => withRadius(d, '6mm'));
    saveToDisk(wt, BRACKET, next);
    const v = value(await repo.history.saveVersion(next, 'In the worktree', { author: ann }));
    expect(wt.git('log', '-1', '--format=%H %s')).toBe(`${v.id} In the worktree`);
    expect(wt.git('status', '--porcelain')).toBe('');
    // The shared repository has the branch; the main checkout's HEAD and index are untouched.
    expect(cli(join(wtPath, '.main'), 'rev-parse', 'wt')).toBe(v.id);
    expect(cli(join(wtPath, '.main'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(cli(join(wtPath, '.main'), 'status', '--porcelain')).toBe('');
  });

  it('ensureCacheIgnored reports and, when asked, adds .whittle/ to the root .gitignore', async () => {
    const r = twoProjects();
    r.write('.gitignore', 'node_modules/');
    r.git('add', '.gitignore');
    r.git('commit', '-q', '-m', 'ignore');
    const repo = await open(r);
    r.write(`${BRACKET}/.whittle/mesh.bin`, 'cache');
    expect(value(await repo.ensureCacheIgnored())).toEqual({ ignored: false, added: false });
    expect(r.read('.gitignore')).toBe('node_modules/');
    expect(value(await repo.ensureCacheIgnored({ add: true }))).toEqual({
      ignored: true,
      added: true,
    });
    expect(r.read('.gitignore')).toMatch(/^node_modules\/\n# .*\n\.whittle\/\n$/);
    expect(r.git('check-ignore', `${BRACKET}/.whittle/mesh.bin`)).toBe(
      `${BRACKET}/.whittle/mesh.bin`,
    );
    expect(value(await repo.ensureCacheIgnored({ add: true }))).toEqual({
      ignored: true,
      added: false,
    });
    // The cache is never a working change, ignored or not.
    expect(value(await repo.history.workingChanges())).toEqual([]);
    expect(porcelain(r)).toBe(' M .gitignore');
  });
});

describe('local git repo: a project in a subfolder', { timeout: 30_000 }, () => {
  it('scopes read, saveVersion and workingChanges to the project; files are project-relative', async () => {
    const r = twoProjects();
    const bracket = (await open(r)).history;
    const lid = (await open(r, LID)).history;
    const b = value(await bracket.read((await bracket.log())[0]!.id));
    sameFiles(b, project('Bracket'));
    sameFiles(value(await lid.read((await lid.log())[0]!.id)), project('Lid'));
    r.write(`${LID}/params.json`, '{}\n');
    r.write('unrelated.txt', 'x\n');
    expect(value(await bracket.workingChanges())).toEqual([]);
    expect(value(await lid.workingChanges())).toEqual([
      { path: 'params.json', status: 'modified' },
    ]);
    // Deleting a file Whittle owns removes it from the commit and the disk; a README the user put
    // in the project folder is carried along.
    r.write(`${BRACKET}/README.md`, 'about the bracket\n');
    r.git('add', '.');
    r.git('commit', '-q', '-m', 'docs');
    r.git('reset', '-q', '--hard');
    bracket.refresh();
    const now = value(await bracket.read((await bracket.log())[0]!.id));
    const without = new Map(
      [...now].filter(([p]) => p !== 'imports/bolt.step' && p !== 'README.md'),
    );
    // Whittle removes the file it no longer has (unchanged on disk), and the folder it leaves empty.
    const v = value(await bracket.saveVersion(without, 'Drop the bolt', { author: ann }));
    const kept = value(await bracket.read(v.id));
    expect(kept.has('imports/bolt.step')).toBe(false);
    expect(new TextDecoder().decode(kept.get('README.md'))).toBe('about the bracket\n');
    expect(r.git('show', '--name-status', '--format=', 'HEAD')).toBe(
      `D\t${BRACKET}/imports/bolt.step`,
    );
    expect(r.exists(`${BRACKET}/imports`)).toBe(false);
    expect(porcelain(r)).toBe('');
  });

  it('diffs and merges are project-scoped; a merge brings the other side’s changes outside the project too', async () => {
    const r = twoProjects();
    const h = (await open(r)).history;
    const base = value(await h.read((await h.log())[0]!.id));
    value(await h.createBranch('idea'));
    value(await h.switchBranch('idea'));
    const theirs = edit(base, (d) => withRadius(d, '4mm'));
    saveToDisk(r, BRACKET, theirs);
    const t = value(await h.saveVersion(theirs, 'Idea: radius', { author: ann }));
    r.write(`${LID}/notes.md`, 'lid note on idea\n');
    r.git('add', '.');
    r.git('commit', '-q', '-m', 'Idea: lid note');
    const ideaHead = r.git('rev-parse', 'HEAD');
    h.refresh();
    value(await h.switchBranch('main'));
    expect(r.exists(`${LID}/notes.md`)).toBe(false);
    const ours = edit(base, (d) =>
      apply(d, { kind: 'updateParam', paramId: P_WIDTH, expr: '50mm' }),
    );
    saveToDisk(r, BRACKET, ours);
    const o = value(await h.saveVersion(ours, 'Main: width', { author: ann }));
    const mb = await h.mergeBase(o.id, ideaHead);
    expect(mb).toBe((await h.log())[1]!.id);
    const merged = await mergeProjectFiles(
      value(await h.read(mb!)),
      value(await h.read(o.id)),
      value(await h.read(ideaHead)),
    );
    expect(merged.merge.conflicts).toEqual([]);
    expect(radiusOf(merged.files)).toBe('4mm');
    saveToDisk(r, BRACKET, merged.files);
    const m = value(await h.commitMerge(merged.files, 'Merge idea', [o.id, ideaHead], ann));
    expect(m.parents).toEqual([o.id, ideaHead]);
    expect(r.git('log', '-1', '--format=%P')).toBe(`${o.id} ${ideaHead}`);
    expect(r.read(`${LID}/notes.md`)).toBe('lid note on idea\n');
    expect(porcelain(r)).toBe('');
    expect(r.git('fsck', '--no-progress')).toBe('');
    expect(t.id).not.toBe(ideaHead);
  });
});
