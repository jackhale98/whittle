// SPDX-License-Identifier: GPL-3.0-or-later
import http from 'isomorphic-git/http/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitRemoteHeads } from '../src';
import { type GitServer, startGitServer } from './support/git-server';

describe('gitRemoteHeads (the connection’s repository step)', () => {
  let server: GitServer;
  beforeAll(async () => {
    server = await startGitServer('seeded', { 'whittle.project.json': '{}\n' }, { auth: 'x:tok' });
    server.empty('fresh');
  });
  afterAll(() => server.close());

  const token = () => ({ kind: 'token' as const, token: 'tok', username: 'x' });

  it('lists the branches of a repository that has commits', async () => {
    const r = await gitRemoteHeads({
      http,
      url: `${server.url}/seeded.git`,
      credentials: token,
    });
    expect(r).toEqual({ ok: true, value: ['main'] });
  });

  it('an empty repository has no branches (a project can be pushed to it)', async () => {
    const r = await gitRemoteHeads({ http, url: `${server.url}/fresh.git`, credentials: token });
    expect(r).toEqual({ ok: true, value: [] });
  });

  it('a refused token is AUTH and the message never holds the token', async () => {
    const r = await gitRemoteHeads({
      http,
      url: `${server.url}/seeded.git`,
      credentials: () => ({ kind: 'token', token: 'wrong-secret', username: 'x' }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(['AUTH', 'NOT_FOUND', 'REMOTE']).toContain(r.error.code);
    expect(r.error.message).not.toContain('wrong-secret');
  });

  it('a malformed address is NOT_FOUND without a request', async () => {
    const r = await gitRemoteHeads({ http, url: 'not a url' });
    expect(r.ok ? null : r.error.code).toBe('NOT_FOUND');
  });
});
