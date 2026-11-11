# Deploying Wren

Two targets are built from `main` by `.github/workflows/ci.yml`, only after every gating job passed:

| Target | Base | How | Isolation headers |
| --- | --- | --- | --- |
| GitHub Pages (`jackhale98.github.io/wren-cad/`) | `/wren-cad/` | `pages` job (`actions/deploy-pages`) | service worker adds them; one reload on the first visit |
| Cloudflare Pages (`https://wren-cad.app/`) | `/` | `cloudflare` job pushes the `cloudflare-pages` branch | real headers from `_headers`; no reload |

## Cloudflare Pages

Cloudflare's build servers cannot build the OCCT kernel (Docker + Emscripten, cached as a CI
artefact in `kernel.yml`). So Cloudflare does **not** build: the `cloudflare` CI job builds the site
for base `/` with the cached kernel, checks it (`apps/web/scripts/cloudflare-dist.mjs`: removes
`404.html`, checks the manifest is rooted at `/`, fails if any file is over 25 MiB, prints the
largest files) and force-pushes the contents of `dist` as the single commit of the orphan branch
`cloudflare-pages` (message `Deploy <source SHA>`). Cloudflare serves that branch as-is. The job
uses `GITHUB_TOKEN` with `contents: write`; there is no Cloudflare API token in GitHub.

### Dashboard settings: a Worker with static assets (Cloudflare's successor to Pages)

Cloudflare now calls the Pages Git flow legacy, so the site is served by an **assets-only Worker**
connected to the repository with Workers Builds. The `cloudflare-pages` branch holds the built site in
`public/` and a generated `wrangler.jsonc` at its root that declares the Worker: name, `assets.directory
= ./public`, `not_found_handling = single-page-application`. There is no Worker script; `_headers` in
`public/` is applied by Cloudflare's asset server.

In **Workers & Pages > (the Worker) > Settings > Build**:

| Setting | Value |
| --- | --- |
| Git repository | `jackhale98/wren-cad` |
| Production branch | `cloudflare-pages` |
| Build command | *(empty)* |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |
| Non-production branch builds | off |

**The Worker's name must match** the `name` in the generated `wrangler.jsonc`, or Workers Builds refuses
to deploy. CI uses the repository variable `CLOUDFLARE_WORKER_NAME` (GitHub > Settings > Secrets and
variables > Actions > Variables), defaulting to `wren-cad`: either name the Worker `wren-cad` or set the
variable to its name.

Then **Settings > Domains & Routes > Add > Custom domain**: `wren-cad.app`. If `wren-cad.app` is a
zone on your Cloudflare account, the DNS record and certificate are created for you. For `www`, add a
Redirect Rule (hostname equals `www.wren-cad.app` -> dynamic `concat("https://wren-cad.app",
http.request.uri.path)`, 301). Do not serve the app on `www` itself: the Worker allow-list, OAuth
redirect URIs and the PWA scope are for the apex only.

Each green deploy from `main` force-pushes the branch; Workers Builds then runs `npx wrangler deploy`,
which uploads only changed assets.

### Why the headers and routing are what they are

- `apps/web/public/_headers` sends COOP `same-origin`, COEP `require-corp`, CORP `same-origin` on
  every path. `require-corp` (not `credentialless`) because it is what the service worker sends and
  Safari has no `credentialless`; a unit test keeps `_headers` and
  `src/platform/isolation-headers.ts` identical.
- `index.html`, `sw.js`, `manifest.webmanifest` and `/` are `no-cache`; `/assets/*` (hashed chunks and
  the kernel `.js`/`.wasm`, whose names carry content hashes) is `public, max-age=31536000, immutable`.
- The app has no path router (hash and query only; OAuth returns to `/?code=...&state=...`), so
  the only fallback needed is "unknown path gives the shell". The Worker's
  `not_found_handling: single-page-application` does that (the job also deletes `404.html`); no
  `_redirects` file is needed.
- The service worker still registers (offline, precache, kernel cache). On an already isolated
  page it does not reload, and responses that already carry the headers pass through unchanged.

### Verify

1. `curl -sI https://wren-cad.app/ | grep -i -E 'cross-origin|cache-control'` shows COOP
   `same-origin`, COEP `require-corp`, CORP `same-origin`, `cache-control: no-cache`.
2. `curl -sI https://wren-cad.app/assets/<whittle-kernel-*.wasm>` (name from the Network tab) shows
   `content-type: application/wasm` and `immutable`.
3. Open the site in a fresh profile: `crossOriginIsolated` is `true` in the console on the first load,
   with no reload, and Settings > Diagnostics (the diagnostics panel) says `threaded kernel available`.
4. `curl -sI https://wren-cad.app/some/path` returns `200`.
5. Locally: `WREN_BASE=/ pnpm build && node apps/web/scripts/cloudflare-dist.mjs apps/web/dist &&
   pnpm --filter @wren-cad/web e2e:cloudflare` serves the build with its `_headers` and runs a
   chromium smoke test.

### Sync Worker

`worker/wrangler.jsonc` allows the origins `https://wren-cad.app` and the GitHub Pages origin
(plus localhost). Deploy it again (`wrangler deploy`) for the change to take effect. If
`ALLOWED_ORIGINS` was set in the Worker's dashboard it overrides the file (`keep_vars`): add the
origin there. GitHub/GitLab/Bitbucket OAuth apps need `https://wren-cad.app/` as an additional
redirect URI, and the repository variables `VITE_*` apply to both builds.

### Preview deploys (not set up)

Cloudflare builds previews for non-production branches of the connected repository. Because it
cannot build the kernel, previews would need CI to push `cloudflare-preview/<pr>` branches from
pull requests (build with `WREN_BASE=/`, same guard). That needs a write token on pull_request runs,
which for forks is unsafe, so it is left out. If wanted: do it only for same-repo PRs, in a
separate `pull_request`-triggered job with `contents: write`, and enable branch previews for
`cloudflare-preview/*` in the Pages project.

### Rollback

Roll back from the Worker's dashboard (Deployments > an earlier version > Rollback). The branch holds
only the latest build, so there is no git history to revert.
