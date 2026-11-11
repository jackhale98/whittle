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

### Dashboard settings (Workers & Pages > Create > Pages > Connect to Git)

| Setting | Value |
| --- | --- |
| Repository | `jackhale98/wren-cad` |
| Production branch | `cloudflare-pages` |
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `/` |
| Root directory (advanced) | `/` |
| Environment variables | none |

Then **Custom domains > Set up a custom domain**: `wren-cad.app`. If `wren-cad.app` is a zone on
your Cloudflare account, the DNS record is created for you. For `www`, add `www.wren-cad.app` as a
second custom domain and a Bulk Redirect (or a Redirect Rule: hostname equals `www.wren-cad.app`
-> dynamic `concat("https://wren-cad.app", http.request.uri.path)`, 301). Do not serve the app on
`www` itself: the Worker allow-list, OAuth redirect URIs and the PWA scope are for the apex only.

The first deploy only exists after the first push to `main` finishes CI and creates the branch
(Cloudflare may report an empty branch until then).

### Why the headers and routing are what they are

- `apps/web/public/_headers` sends COOP `same-origin`, COEP `require-corp`, CORP `same-origin` on
  every path. `require-corp` (not `credentialless`) because it is what the service worker sends and
  Safari has no `credentialless`; a unit test keeps `_headers` and
  `src/platform/isolation-headers.ts` identical.
- `index.html`, `sw.js`, `manifest.webmanifest` and `/` are `no-cache`; `/assets/*` (hashed chunks and
  the kernel `.js`/`.wasm`, whose names carry content hashes) is `public, max-age=31536000, immutable`.
- The app has no path router (hash and query only; OAuth returns to `/?code=...&state=...`), so
  the only fallback needed is "unknown path gives the shell". Cloudflare Pages does that
  automatically when `404.html` is absent (SPA mode), which is why the job deletes it; no
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

Redeploy an earlier deployment from the Pages dashboard (Deployments > Rollback). The branch holds
only the latest build, so there is no git history to revert.
