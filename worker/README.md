# Whittle sync worker

A Cloudflare Worker that lets the Whittle web app talk to git hosts and WebDAV servers, and sign in
to git providers. Ported from Mycelium's sync worker (GPL-3.0-or-later); reminders and push are
removed. Stateless, logging disabled, no storage.

- **Git proxy:** `/<host>/<owner>/<repo>.git/...`. Only the three git smart-HTTP endpoints, only
  `github.com`, `gitlab.com`, `bitbucket.org` and hosts in `EXTRA_GIT_HOSTS`, only for origins in
  `ALLOWED_ORIGINS`. Cookies and other headers are dropped.
- **OAuth token exchange:** `POST /oauth/<github|gitlab|bitbucket>/token` and `/refresh`. Adds the
  client secret (Worker secret), returns the provider's response unchanged, never stores or logs it.
- **WebDAV relay:** `/dav/<host>/<path>`. `PROPFIND GET PUT DELETE MKCOL` only; HTTPS host names
  only (no IPs, `localhost`, `.local`, `.internal`, `.lan`, `.home.arpa`); credentials required;
  bodies over 20 MB refused; redirects never followed; `DAV_HOSTS` optionally restricts hosts.

Setup (deploy, variables, secrets): [docs/SYNC_SETUP.md](../docs/SYNC_SETUP.md).

```sh
pnpm --filter @whittle/sync-worker test        # vitest
pnpm --filter @whittle/sync-worker typecheck
pnpm --filter @whittle/sync-worker deploy      # npx wrangler@4.151.3 deploy
```
