// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium tests/support/git-server.ts (same author, GPL-3.0-or-later).
/**
 * A real smart-HTTP git server for tests: `git http-backend` behind a tiny Node server, with
 * CORS so browsers could talk to it directly. Seeds a bare repository from files.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GitServer {
  url: string;
  root: string;
  git: (repo: string, ...args: string[]) => string;
  /** Add an empty bare repository `name.git` (no commits), pushable. */
  empty: (name: string, branch?: string) => void;
  close: () => void;
}

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', ...args], {
    cwd,
    stdio: 'pipe',
  })
    .toString()
    .trim();

/** Create a bare repo `name.git` seeded with `files`, served over HTTP. */
export async function startGitServer(
  name: string,
  files: ReadonlyMap<string, Uint8Array> | Record<string, string>,
  options: {
    branch?: string;
    /** Require HTTP Basic auth (`user:password`), answering 401 like a private GitHub repo. */
    auth?: string;
  } = {},
): Promise<GitServer> {
  const root = fs.mkdtempSync(join(tmpdir(), 'whittle-srv-'));
  const seed = join(root, 'seed');
  fs.mkdirSync(seed);
  sh(seed, 'init', '-q', '-b', options.branch ?? 'main');
  const entries = files instanceof Map ? [...files] : Object.entries(files);
  for (const [path, content] of entries) {
    fs.mkdirSync(join(seed, path, '..'), { recursive: true });
    fs.writeFileSync(join(seed, path), content);
  }
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-q', '-m', 'seed');
  sh(root, 'clone', '-q', '--bare', seed, `${name}.git`);
  sh(join(root, `${name}.git`), 'config', 'http.receivepack', 'true');

  const server: Server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Git-Protocol, Accept',
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    if (options.auth) {
      const want = `Basic ${Buffer.from(options.auth).toString('base64')}`;
      // Like GitHub behind a CORS proxy: 401, with WWW-Authenticate not exposed to the page.
      if ((req.headers.authorization ?? '') !== want) {
        return void res.writeHead(401).end('Repository not found.');
      }
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: 'tester',
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let done = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (done) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      done = true;
      let status = 200;
      for (const line of head.subarray(0, end).toString().split('\r\n')) {
        const [k, ...v] = line.split(':');
        if ((k as string).toLowerCase() === 'status') status = Number.parseInt(v.join(':'), 10);
        else res.setHeader(k as string, v.join(':').trim());
      }
      res.writeHead(status);
      res.write(head.subarray(end + 4));
    });
    cgi.stdout.on('end', () => res.end());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://localhost:${port}`,
    root,
    git: (repo, ...args) => sh(join(root, repo), ...args),
    empty: (n, branch = 'main') => {
      sh(root, 'init', '-q', '--bare', '-b', branch, `${n}.git`);
      sh(join(root, `${n}.git`), 'config', 'http.receivepack', 'true');
    },
    close: () => {
      server.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
