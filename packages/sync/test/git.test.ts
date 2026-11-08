// SPDX-License-Identifier: GPL-3.0-or-later
// Integration tests against a real git server (`git http-backend` over HTTP), after Mycelium's
// src/lib/git/repo.test.ts. Repositories live in LightningFS on an in-memory IndexedDB.
import 'fake-indexeddb/auto';
import type { Author, Feature, ProjectFiles, StorageResult, WhittleDoc } from '@whittle/contracts';
import { fromFiles, toFiles } from '@whittle/document';
import http from 'isomorphic-git/http/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  basicAuth,
  browserGitFs,
  corsProxyFor,
  createGitHistory,
  DEFAULT_CORS_PROXY,
  type GitHistoryOptions,
  gitError,
  gitRefName,
  resolveProjectFiles,
} from '../src';
import { apply, baseDoc, FILLET, featureOf, P_WIDTH, PART } from './support/fixtures';
import { type GitServer, startGitServer } from './support/git-server';

const ann: Author = { name: 'Ann', email: 'ann@example.com' };
const value = <T>(r: StorageResult<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

let server: GitServer;
let fsN = 0;
let clock = Date.parse('2026-06-01T09:00:00Z');
const tick = () => {
  clock += 60_000;
  return new Date(clock);
};

function seedFiles(): ProjectFiles {
  const files = toFiles(baseDoc());
  files.set('imports/bolt.step', new Uint8Array([0, 1, 2, 255, 10, 13]));
  files.set('README.md', new TextEncoder().encode('# Bracket\r\n'));
  return files;
}

function device(repo = 'bracket', extra: Partial<GitHistoryOptions> = {}) {
  return createGitHistory({
    fs: browserGitFs(`test-${fsN++}`, { wipe: true }),
    http,
    dir: '/repo',
    url: `${server.url}/${repo}.git`,
    author: ann,
    now: tick,
    ...extra,
  });
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
/** The project with the document replaced (other files kept). */
const edit = (files: ProjectFiles, change: (d: WhittleDoc) => WhittleDoc): ProjectFiles => {
  const out = new Map(files);
  for (const [p, b] of toFiles(change(docOf(files)))) out.set(p, b);
  return out;
};
const sameFiles = (a: ProjectFiles, b: ProjectFiles) => {
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [p, bytes] of a)
    expect(Buffer.from(b.get(p) as Uint8Array).equals(Buffer.from(bytes)), p).toBe(true);
};

beforeAll(async () => {
  server = await startGitServer('bracket', seedFiles());
});
afterAll(() => server?.close());

describe('GitHistory', () => {
  let a: ReturnType<typeof device>;
  let b: ReturnType<typeof device>;
  beforeAll(() => {
    a = device();
    b = device();
  });

  it('clones byte for byte', async () => {
    const files = value(await a.clone());
    sameFiles(files, seedFiles());
    expect(await a.currentBranch()).toBe('main');
    const [seed] = await a.log();
    expect(seed).toMatchObject({ message: 'seed', parents: [] });
  });

  it('round trip: commit, push, clone on another device, read: identical project files', async () => {
    const before = value(await a.read((await a.log())[0]!.id));
    const files = edit(before, (d) =>
      apply(d, { kind: 'updateParam', paramId: P_WIDTH, expr: '45mm' }),
    );
    const v = value(await a.saveVersion(files, 'Wider', { author: ann }));
    expect(v).toMatchObject({ message: 'Wider', author: ann });
    // Unchanged content returns the existing head.
    expect(value(await a.saveVersion(files, 'Again', { author: ann })).id).toBe(v.id);
    expect(value(await a.push())).toEqual({ kind: 'pushed' });
    expect(server.git('bracket.git', 'log', '-1', '--format=%s', 'main')).toBe('Wider');
    const cloned = value(await b.clone());
    sameFiles(cloned, files);
    sameFiles(value(await b.read(v.id)), files);
    expect((await b.log())[0]?.hash).toBe(v.hash);
  });

  it('fetch reports behind; pull fast-forwards', async () => {
    const files = value(await a.read((await a.log())[0]!.id));
    value(
      await a.saveVersion(
        edit(files, (d) => withRadius(d, '3mm')),
        'Round more',
        { author: ann },
      ),
    );
    value(await a.push());
    expect(value(await b.fetch())).toEqual({ ahead: 0, behind: 1 });
    const pulled = value(await b.pull());
    expect(pulled.kind).toBe('fastForward');
    if (pulled.kind === 'fastForward')
      expect((featureOf(docOf(pulled.files), FILLET) as { radius: string }).radius).toBe('3mm');
    expect(value(await b.pull())).toEqual({ kind: 'upToDate' });
  });

  it('concurrent edits to different features merge with DocMerger (two parents)', async () => {
    const head = (await a.log())[0]!.id;
    const base = value(await a.read(head));
    value(
      await a.saveVersion(
        edit(base, (d) => apply(d, { kind: 'updateParam', paramId: P_WIDTH, expr: '50mm' })),
        'A: width',
        { author: ann },
      ),
    );
    value(
      await b.saveVersion(
        edit(base, (d) => withRadius(d, '4mm')),
        'B: radius',
        { author: { name: 'Bob' } },
      ),
    );
    value(await b.push());
    // A is behind now: pushing is rejected until it pulls.
    expect(value(await a.push())).toEqual({ kind: 'rejected', reason: 'behind' });
    const pulled = value(await a.pull());
    expect(pulled.kind).toBe('merged');
    if (pulled.kind !== 'merged') return;
    const doc = docOf(pulled.files);
    expect(doc.params[0]?.expr).toBe('50mm');
    expect((featureOf(doc, FILLET) as { radius: string }).radius).toBe('4mm');
    expect(pulled.version.parents).toHaveLength(2);
    // Files Whittle doesn't own and attachments come through untouched.
    expect(pulled.files.get('README.md')).toEqual(seedFiles().get('README.md'));
    expect(pulled.files.get('imports/bolt.step')).toEqual(seedFiles().get('imports/bolt.step'));
    value(await a.push());
    expect(value(await b.pull()).kind).toBe('fastForward');
  });

  it('conflicting edits come back as conflicts; resolving and commitMerge completes the merge', async () => {
    const head = (await a.log())[0]!.id;
    const base = value(await a.read(head));
    value(
      await a.saveVersion(
        edit(base, (d) => withRadius(d, '5mm')),
        'A: 5',
        { author: ann },
      ),
    );
    value(
      await b.saveVersion(
        edit(base, (d) => withRadius(d, '6mm')),
        'B: 6',
        { author: { name: 'Bob' } },
      ),
    );
    value(await b.push());
    const localHead = (await a.log())[0]!.id;
    const pulled = value(await a.pull());
    expect(pulled.kind).toBe('conflicts');
    if (pulled.kind !== 'conflicts') return;
    expect(pulled.merge.conflicts).toMatchObject([
      {
        kind: 'bothModified',
        path: `/parts/${PART}/features/${FILLET}/radius`,
        ours: '5mm',
        theirs: '6mm',
        subject: { label: 'Fillet 3' },
      },
    ]);
    // Nothing was committed.
    expect((await a.log())[0]!.id).toBe(localHead);
    const files = resolveProjectFiles(pulled.merge, [
      { conflictId: pulled.merge.conflicts[0]!.id, take: 'theirs' },
    ]);
    const merged = value(
      await a.commitMerge(files, 'Merge: take 6 mm', [localHead, pulled.theirs], ann),
    );
    expect(merged.parents).toEqual([localHead, pulled.theirs]);
    expect(await a.mergeBase(localHead, pulled.theirs)).toBe(head);
    value(await a.push());
    const ff = value(await b.pull());
    expect(ff.kind).toBe('fastForward');
    if (ff.kind === 'fastForward') sameFiles(ff.files, files);
  });

  it('branches: create, list, switch, commit on a branch and back', async () => {
    const main = value(await a.read((await a.log())[0]!.id));
    const br = value(await a.createBranch('Try a thin wall'));
    expect(br.name).toBe('Try-a-thin-wall');
    expect((await a.createBranch('Try a thin wall')).ok).toBe(false);
    sameFiles(value(await a.switchBranch(br.name)), main);
    const v = value(
      await a.saveVersion(
        edit(main, (d) => withRadius(d, '1mm')),
        'Thin',
        { author: ann },
      ),
    );
    const branches = await a.branches();
    expect(branches.find((x) => x.current)).toMatchObject({ name: br.name, head: v.id });
    expect(branches.find((x) => x.name === 'main')).toMatchObject({ ahead: 0, behind: 0 });
    sameFiles(value(await a.switchBranch('main')), main);
    expect(await a.currentBranch()).toBe('main');
    expect((await a.log({ branch: br.name }))[0]?.id).toBe(v.id);
  });

  it('releases are annotated tags, read-only, and travel with push', async () => {
    const head = (await a.log())[0]!;
    const exports: ProjectFiles = new Map([
      ['bracket.step', new TextEncoder().encode('ISO-10303-21;\n')],
    ]);
    const r = value(await a.release(head.id, 'Rev A', exports, ann));
    expect(r).toMatchObject({
      name: 'Rev A',
      versionId: head.id,
      files: ['releases/rev-a/bracket.step'],
    });
    const again = await a.release(head.id, 'Rev A', exports, ann);
    expect(!again.ok && again.error.code).toBe('CONFLICT');
    expect(server.git('bracket.git', 'tag').split('\n')).not.toContain('Rev-A');
    value(await a.push());
    expect(server.git('bracket.git', 'tag').split('\n')).toContain('Rev-A');
    value(await b.pull());
    expect((await b.releases()).map((x) => [x.name, x.versionId, x.files])).toEqual([
      ['Rev A', head.id, ['releases/rev-a/bracket.step']],
    ]);
    expect((await b.log()).find((v) => v.id === head.id)?.releases).toEqual(['Rev A']);
    // The exports were committed beside the model.
    const latest = value(await b.read((await b.log())[0]!.id));
    expect(latest.has('releases/rev-a/bracket.step')).toBe(true);
  });

  it('automatic snapshots stay local, are hidden by default and pruned by policy', async () => {
    const head = (await a.log())[0]!;
    const files = value(await a.read(head.id));
    const autos = [];
    for (let i = 0; i < 3; i++) {
      autos.push(
        value(
          await a.saveVersion(
            edit(files, (d) => withRadius(d, `${10 + i}mm`)),
            'auto',
            { author: ann, auto: true },
          ),
        ),
      );
    }
    expect(autos.every((v) => v.auto && v.parents[0] === head.id)).toBe(true);
    expect((await a.log())[0]?.id).toBe(head.id);
    expect((await a.log({ includeAuto: true })).filter((v) => v.auto)).toHaveLength(3);
    value(await a.push());
    expect(server.git('bracket.git', 'for-each-ref', '--format=%(refname)')).not.toContain(
      'refs/whittle',
    );
    // A day later, all three fall in one hourly bucket: two are pruned.
    clock += 2 * 24 * 3_600_000;
    expect(await a.prune()).toBe(2);
    expect((await a.log({ includeAuto: true })).filter((v) => v.auto)).toHaveLength(1);
  });
});

describe('GitHistory without a remote (local-only)', () => {
  it('versions, branches, releases and mergeBase work; fetch, pull and push say there is no remote', async () => {
    const h = createGitHistory({
      fs: browserGitFs(`local-${fsN++}`, { wipe: true }),
      http,
      dir: '/proj',
      url: null,
      now: tick,
    });
    const v1 = value(await h.saveVersion(seedFiles(), 'First', { author: ann }));
    sameFiles(value(await h.read(v1.id)), seedFiles());
    value(await h.createBranch('idea'));
    value(await h.switchBranch('idea'));
    const v2 = value(
      await h.saveVersion(
        edit(seedFiles(), (d) => withRadius(d, '7mm')),
        'Idea',
        { author: ann },
      ),
    );
    expect(await h.mergeBase(v1.id, v2.id)).toBe(v1.id);
    expect((await h.branches()).map((x) => x.name).sort()).toEqual(['idea', 'main']);
    value(await h.release(v2.id, 'Rev A', new Map(), ann));
    expect((await h.releases()).map((r) => r.name)).toEqual(['Rev A']);
    for (const r of [await h.fetch(), await h.pull(), await h.push()]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/no remote/);
    }
  });

  it('a commit into an existing checkout leaves files Whittle does not own alone', async () => {
    const fs = browserGitFs(`checkout-${fsN++}`, { wipe: true });
    const h = createGitHistory({ fs, http, dir: '/c', gitdir: '/c/.git', url: null, now: tick });
    value(await h.saveVersion(seedFiles(), 'First', { author: ann }));
    // Someone else edits the README in the working tree (uncommitted).
    await fs.promises.writeFile('/c/README.md', 'local edit\n');
    const project = new Map([...seedFiles()].filter(([p]) => p !== 'README.md'));
    const v = value(
      await h.saveVersion(
        edit(project, (d) => withRadius(d, '8mm')),
        'Radius',
        { author: ann },
      ),
    );
    const files = value(await h.read(v.id));
    expect(files.get('README.md')).toEqual(seedFiles().get('README.md'));
    expect(await fs.promises.readFile('/c/README.md', { encoding: 'utf8' })).toBe('local edit\n');
    h.refresh();
    expect((await h.log()).map((x) => x.message)).toEqual(['Radius', 'First']);
  });
});

describe('GitHistory auth, errors and proxy', () => {
  it('clones a private repository with a token; refuses without one, with a token-free message', async () => {
    const secret = await startGitServer('private', seedFiles(), {
      branch: 'master',
      auth: 'x-access-token:ghp_secret123',
    });
    try {
      const make = (token: string | null) =>
        createGitHistory({
          fs: browserGitFs(`auth-${fsN++}`, { wipe: true }),
          http,
          dir: '/repo',
          url: `${secret.url}/private.git`,
          host: 'github',
          credentials: async () => (token ? { kind: 'token', token } : null),
        });
      const none = await make(null).clone();
      expect(!none.ok && none.error.code).toBe('AUTH');
      const wrong = await make('ghp_wrong999').clone();
      expect(!wrong.ok && wrong.error.code).toBe('AUTH');
      if (!wrong.ok) expect(wrong.error.message).not.toContain('ghp_wrong999');
      const good = make('ghp_secret123');
      sameFiles(value(await good.clone()), seedFiles());
      expect(await good.currentBranch()).toBe('master');
    } finally {
      secret.close();
    }
  });

  it('clones an empty repository, then makes and pushes the first commit', async () => {
    server.empty('blank');
    const h = device('blank');
    expect(value(await h.clone()).size).toBe(0);
    value(await h.saveVersion(seedFiles(), 'First', { author: ann }));
    expect(value(await h.push())).toEqual({ kind: 'pushed' });
    expect(server.git('blank.git', 'log', '-1', '--format=%s', 'main')).toBe('First');
  });

  it('the CORS proxy is configurable, defaults to the public one and is skipped for localhost', () => {
    expect(DEFAULT_CORS_PROXY).toBe('https://cors.isomorphic-git.org');
    expect(corsProxyFor('https://github.com/a/b.git', undefined)).toBe(DEFAULT_CORS_PROXY);
    expect(corsProxyFor('https://github.com/a/b.git', 'https://proxy.whittle.app')).toBe(
      'https://proxy.whittle.app',
    );
    expect(corsProxyFor('https://github.com/a/b.git', null)).toBeUndefined();
    expect(corsProxyFor('http://localhost:8080/a.git', undefined)).toBeUndefined();
  });

  it('maps errors and hosts', () => {
    expect(
      gitError(
        { code: 'HttpError', data: { statusCode: 401 }, message: 'x ghp_tok' },
        'ghp_tok',
        'github.com',
      ).code,
    ).toBe('AUTH');
    expect(gitError({ code: 'HttpError', data: { statusCode: 404 } }, null, 'h').code).toBe(
      'NOT_FOUND',
    );
    expect(gitError(new Error('connect ECONNREFUSED 1.2.3.4'), null, 'h').code).toBe('OFFLINE');
    expect(gitError(new TypeError('Failed to fetch'), null, 'h').code).toBe('CORS');
    expect(gitError(new Error('https://u:ghp_x@host/ failed'), 'ghp_x', 'h').message).not.toContain(
      'ghp_x',
    );
    expect(basicAuth('github', { kind: 'token', token: 't' })).toEqual({
      username: 'x-access-token',
      password: 't',
    });
    expect(
      basicAuth('gitlab', { kind: 'oauth', accessToken: 't', refreshToken: null, expiresAt: null }),
    ).toEqual({ username: 'oauth2', password: 't' });
    expect(
      basicAuth('bitbucket', { kind: 'token', token: 't', username: 'me@x.org' }).username,
    ).toBe('x-bitbucket-api-token-auth');
    expect(gitRefName('Rev A')).toBe('Rev-A');
    expect(gitRefName('..x~y^z:')).toBe('xyz');
    expect(gitRefName('feature/thin wall.lock')).toBe('feature/thin-wall');
  });
});
