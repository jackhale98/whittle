/// Real repositories made and inspected with the `git` CLI, in temp folders, with a
/// `NodeDirHandle` over each so Wren reaches them the way it reaches a picked folder.

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NodeDirHandle } from './node-dir';

export interface CliRepo {
  /** The working tree on disk. */
  path: string;
  /** Runs `git` in the working tree (fixed identity and dates, no global config). */
  git: (...args: string[]) => string;
  write: (path: string, content: string | Uint8Array) => void;
  read: (path: string) => string;
  exists: (path: string) => boolean;
  handle: () => NodeDirHandle;
  cleanup: () => void;
}

const ENV = {
  GIT_AUTHOR_NAME: 'Cli',
  GIT_AUTHOR_EMAIL: 'cli@example.com',
  GIT_COMMITTER_NAME: 'Cli',
  GIT_COMMITTER_EMAIL: 'cli@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

export function cli(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, ...ENV },
  })
    .toString()
    .trimEnd();
}

/**
 * `git` without blocking the event loop: needed for anything talking to the in-process HTTP
 * test server (`execFileSync` would deadlock against it).
 */
export function cliAsync(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...ENV }, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }));
        else resolve(String(stdout).trimEnd());
      },
    );
  });
}

export function tempDir(prefix = 'wren-cli-'): string {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

/** A folder at `path` (made if missing) as a CliRepo; `init` runs `git init -b main` there. */
export function cliRepo(path = tempDir(), options: { init?: boolean } = {}): CliRepo {
  fs.mkdirSync(path, { recursive: true });
  if (options.init !== false) cli(path, 'init', '-q', '-b', 'main');
  return {
    path,
    git: (...args) => cli(path, ...args),
    write: (p, content) => {
      fs.mkdirSync(dirname(join(path, p)), { recursive: true });
      fs.writeFileSync(join(path, p), content);
    },
    read: (p) => fs.readFileSync(join(path, p), 'utf8'),
    exists: (p) => fs.existsSync(join(path, p)),
    handle: () => new NodeDirHandle(path),
    cleanup: () => fs.rmSync(path, { recursive: true, force: true }),
  };
}

/** Writes every file of a project (project-relative paths) under `folder` in the repo. */
export function writeProject(
  repo: CliRepo,
  folder: string,
  files: ReadonlyMap<string, Uint8Array>,
): void {
  for (const [p, bytes] of files) repo.write(folder ? `${folder}/${p}` : p, bytes);
}
