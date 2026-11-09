// SPDX-License-Identifier: GPL-3.0-or-later
// Wren and the git CLI take turns on one repository (seeded random interleavings): Wren
// saves versions and switches branches for one project, the CLI commits to both projects,
// leaves files dirty, makes branches and repacks. After every step both must agree.
import type { Author, Feature, ProjectFiles, StorageResult, WrenDoc } from '@wren-cad/contracts';
import { fromFiles, toFiles } from '@wren-cad/document';
import { afterAll, describe, expect, it } from 'vitest';
import { hashProjectFiles, openLocalGitRepo } from '../src';
import { type CliRepo, cliRepo, writeProject } from './support/cli-git';
import { apply, baseDoc, FILLET, featureOf, P_WIDTH, PART } from './support/fixtures';

const ann: Author = { name: 'Ann', email: 'ann@example.com' };
const BRACKET = 'cad/bracket';
const LID = 'cad/lid';
const repos: CliRepo[] = [];
afterAll(() => {
  for (const r of repos) r.cleanup();
});

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const value = <T>(r: StorageResult<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

const docOf = (files: ProjectFiles): WrenDoc => fromFiles(files);
function edited(files: ProjectFiles, n: number, which: 'radius' | 'width'): ProjectFiles {
  const doc = docOf(files);
  const next =
    which === 'radius'
      ? apply(doc, {
          kind: 'updateFeature',
          partId: PART,
          featureId: FILLET,
          feature: { ...(featureOf(doc, FILLET) as Feature), radius: `${n}mm` } as Feature,
        })
      : apply(doc, { kind: 'updateParam', paramId: P_WIDTH, expr: `${n}mm` });
  const out = new Map(files);
  for (const [p, b] of toFiles(next)) out.set(p, b);
  return out;
}

/** The project's files on disk (what the app's working copy is in local mode). */
function diskProject(r: CliRepo): ProjectFiles {
  const out: ProjectFiles = new Map();
  for (const p of r.git('ls-files', '--', BRACKET).split('\n').filter(Boolean)) {
    if (r.exists(p)) out.set(p.slice(BRACKET.length + 1), new TextEncoder().encode(r.read(p)));
  }
  return out;
}

async function run(seed: number, steps: number) {
  const random = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T;
  const r = cliRepo();
  repos.push(r);
  writeProject(r, BRACKET, toFiles(baseDoc()));
  writeProject(r, LID, toFiles(baseDoc()));
  r.write('README.md', '# start\n');
  r.git('add', '.');
  r.git('commit', '-q', '-m', 'seed');
  let clock = Date.parse('2026-08-01T00:00:00Z');
  const repo = value(
    await openLocalGitRepo(r.handle(), {
      projectPath: BRACKET,
      author: ann,
      now: () => {
        clock += 1000;
        return new Date(clock);
      },
    }),
  );
  const h = repo.history;
  let files = value(await h.read((await h.log())[0]!.id));
  let n = 1;
  const trace: string[] = [];
  for (let i = 0; i < steps; i++) {
    const action = pick([
      'whittle-save',
      'whittle-save',
      'cli-bracket',
      'cli-lid',
      'dirty-readme',
      'branch',
      'switch',
      'gc',
    ] as const);
    trace.push(action);
    const where = `seed ${seed} step ${i} (${trace.join(', ')})`;
    switch (action) {
      case 'whittle-save': {
        files = edited(files, n++, random() < 0.5 ? 'radius' : 'width');
        writeProject(r, BRACKET, files);
        const v = value(await h.saveVersion(files, `W${i}`, { author: ann }));
        expect(r.git('rev-parse', 'HEAD'), where).toBe(v.id);
        expect(value(await h.workingChanges()), where).toEqual([]);
        break;
      }
      case 'cli-bracket': {
        writeProject(r, BRACKET, edited(files, n++, 'width'));
        r.git('commit', '-q', '-m', `C${i}`, '--', BRACKET);
        h.refresh();
        files = value(await h.read((await h.log())[0]!.id));
        break;
      }
      case 'cli-lid': {
        r.write(`${LID}/notes.md`, `lid ${n++}\n`);
        r.git('add', LID);
        r.git('commit', '-q', '-m', `L${i}`, '--', LID);
        break;
      }
      case 'dirty-readme':
        r.write('README.md', `# dirty ${n++}\n`);
        break;
      case 'branch': {
        const made = await h.createBranch(`b${i}`);
        expect(made.ok, where).toBe(true);
        break;
      }
      case 'switch': {
        const names = (await h.branches()).filter((b) => !b.current).map((b) => b.name);
        if (names.length === 0) break;
        const readme = r.read('README.md');
        const target = pick(names);
        const res = await h.switchBranch(target);
        if (res.ok) {
          files = res.value;
          expect(r.git('rev-parse', '--abbrev-ref', 'HEAD'), where).toBe(target);
        } else {
          // Only another file's local edits may stop it, and they are left as they were.
          expect(res.error.code, where).toBe('CONFLICT');
          expect(res.error.message, where).toContain('README.md');
          expect(r.read('README.md'), where).toBe(readme);
        }
        break;
      }
      case 'gc':
        r.git('gc', '-q', '--prune=now');
        h.refresh();
        break;
    }
    // Both sides agree after every step.
    r.git('fsck', '--no-progress', '--no-dangling');
    expect(r.git('status', '--porcelain', '--', BRACKET), where).toBe('');
    expect(value(await h.workingChanges()), where).toEqual([]);
    const head = r.git('rev-parse', 'HEAD');
    const atHead = value(await h.read(head));
    expect(await hashProjectFiles(atHead), where).toBe(await hashProjectFiles(diskProject(r)));
    expect(await hashProjectFiles(atHead), where).toBe(await hashProjectFiles(files));
    // Wren's versions are git's history of the project folder.
    const gitLog = r.git('log', '--format=%H', '--', BRACKET).split('\n');
    expect(
      (await h.log({ limit: 200 })).map((v) => v.id),
      where,
    ).toEqual(gitLog);
    expect(r.git('rev-parse', '--abbrev-ref', 'HEAD'), where).toBe(await h.currentBranch());
  }
}

describe('local git repo: Wren and the git CLI interleaved', { timeout: 120_000 }, () => {
  it.each([1, 2, 3])('seed %i: 30 random steps keep git and Wren in agreement', async (seed) => {
    await run(seed, 30);
  });
});
