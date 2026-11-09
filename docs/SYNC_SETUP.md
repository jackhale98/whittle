# Setting up sync (owner guide)

Adapted from Mycelium's `setup-git-providers.md` and `setup-cloud-storage.md`. Wren never holds
user data or secrets on your side: the Worker swaps one-time sign-in codes for tokens and passes them
straight back, and it relays git and WebDAV traffic that browsers cannot send directly.

Everything here is optional. A provider with no configuration is shown as unavailable in the app, and
the CI build stays green without any of it.

## Where each value goes

| Value                                                    | Public?                    | Goes in                                                    |
| -------------------------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| Worker URL                                               | yes                        | repository variable `VITE_SYNC_WORKER_URL`                 |
| Git CORS proxy URL (only if not the Worker)              | yes                        | repository variable `VITE_GIT_CORS_PROXY`                  |
| Dropbox App key                                          | yes                        | repository variable `VITE_DROPBOX_APP_KEY`                 |
| Microsoft Application (client) ID                        | yes                        | repository variable `VITE_ONEDRIVE_CLIENT_ID`              |
| Google OAuth client ID                                   | yes                        | repository variable `VITE_GDRIVE_CLIENT_ID`                |
| GitHub / GitLab / Bitbucket client ID or key             | yes                        | repository variables `VITE_GITHUB_CLIENT_ID`, `VITE_GITLAB_CLIENT_ID`, `VITE_BITBUCKET_CLIENT_ID` |
| The same client ID again, for the Worker                 | no (kept with the secret)  | Worker secrets `GITHUB_CLIENT_ID`, `GITLAB_CLIENT_ID`, `BITBUCKET_CLIENT_ID` |
| GitHub / Bitbucket (and confidential GitLab) client secret | **secret**               | Worker secrets `GITHUB_CLIENT_SECRET`, `BITBUCKET_CLIENT_SECRET`, `GITLAB_CLIENT_SECRET` |
| Google client ID and secret (Drive token exchange)       | id: no · secret: **secret** | Worker var `GOOGLE_CLIENT_ID`, Worker secret `GOOGLE_CLIENT_SECRET` |
| Allowed origins, extra git hosts, WebDAV allow-list      | no                         | Worker variables `ALLOWED_ORIGINS`, `EXTRA_GIT_HOSTS`, `DAV_HOSTS` |

Repository variables: GitHub repository **Settings -> Secrets and variables -> Actions -> Variables
tab** (not the Secrets tab). They are public client ids baked into the site bundle; CI reads them as
`vars.*` (`.github/workflows/ci.yml`). After changing one, re-run the CI workflow on `main` so the
Pages site rebuilds. Client secrets never go in a repository variable or secret for the site; only in
the Worker.

## Redirect URIs to register

Every OAuth provider below needs these two redirect URIs (note the trailing slash):

- `https://jackhale98.github.io/wren-cad/`
- `http://localhost:5173/` (development; also `http://localhost:4173/` if you test the built site)

Wren redirects the whole page to the provider and back to its own base URL. The service worker
serves the app shell for that URL and keeps the `?code=...&state=...` query, so no special callback
route is needed.

## 1. Deploy the Worker

Source: `worker/`. Free Cloudflare plan is plenty (100,000 requests a day).

### Cloudflare dashboard (no terminal)

1. Create a free Cloudflare account.
2. **Workers & Pages -> Create application -> Import a repository**, pick the Wren repository.
3. Project name `wren-sync`, root directory `worker`, deploy command
   `npx wrangler@4.151.3 deploy`.
4. Deploy. Note the URL, for example `https://wren-sync.<you>.workers.dev`.

### Wrangler (terminal)

```sh
cd worker
npx wrangler@4.151.3 login
npx wrangler@4.151.3 deploy
```

### Configure it

`worker/wrangler.jsonc` ships with `ALLOWED_ORIGINS` set to the Pages origin plus localhost
(`https://jackhale98.github.io,http://localhost:5173,http://localhost:4173`). Origins are exact
matches, scheme and port included. To change them, edit the file or set the variable in
**Worker -> Settings -> Variables** (`keep_vars` keeps dashboard values across deploys).

Optional variables:

- `EXTRA_GIT_HOSTS`: comma-separated self-hosted Forgejo/Gitea/GitLab hosts, for example
  `forgejo.example.com`. github.com, gitlab.com and bitbucket.org are always allowed.
- `DAV_HOSTS`: comma-separated WebDAV host names the relay serves (for example
  `cloud.example.org`). **Required for the relay:** with it unset the relay is off. Setting
  `DAV_OPEN_RELAY=true` instead relays to any public HTTPS host, which is not recommended.

Secrets (Worker -> Settings -> Variables and Secrets -> Add -> Secret, or
`npx wrangler secret put NAME`) are added in the provider sections below.

Then add the repository variable `VITE_SYNC_WORKER_URL` = the Worker URL (no trailing slash). The app
also uses it as the git CORS proxy unless `VITE_GIT_CORS_PROXY` is set.

### Check it

```sh
curl -i -H 'Origin: https://jackhale98.github.io' \
  'https://wren-sync.<you>.workers.dev/github.com/jackhale98/wren-cad.git/info/refs?service=git-upload-pack'
```

Expect `200` with `Access-Control-Allow-Origin: https://jackhale98.github.io`. Without the `Origin`
header, or with another origin, expect `403`.

What the Worker does and refuses: only the three git smart-HTTP endpoints, only allow-listed hosts,
only allow-listed origins; OAuth token exchange for GitHub, GitLab and Bitbucket; a WebDAV relay for
HTTPS host names only (no IPs, `localhost`, `.local`, `.internal`, `.lan`), only requests carrying
credentials, bodies up to 20 MB, redirects never followed. Logging is off and nothing is stored.

Until the Worker exists, development uses the public `https://cors.isomorphic-git.org` proxy. That
proxy sees git credentials in transit; do not use it with real tokens in production.

## 2. Dropbox

1. [Dropbox App Console](https://www.dropbox.com/developers/apps) -> **Create app** -> *Scoped
   access* -> access type **App folder** (safer; the type cannot be changed later) or **Full
   Dropbox**. Name it `Wren`.
2. **Settings -> OAuth 2 -> Redirect URIs:** add the two URIs above. Leave *Allow public clients
   (Implicit Grant & PKCE)* on **Allow**.
3. **Permissions:** `account_info.read`, `files.metadata.read`, `files.content.read`,
   `files.content.write`. Submit before anyone signs in.
4. Copy the **App key** into the repository variable `VITE_DROPBOX_APP_KEY`. The App secret is not
   used; do not store it anywhere.

New apps start in development status with a 50-user limit; apply for production in the console when
you need more.

## 3. OneDrive and SharePoint (Microsoft Entra)

1. [Microsoft Entra admin center](https://entra.microsoft.com) -> **Identity -> Applications -> App
   registrations -> New registration**. A free personal Microsoft account works.
2. Name `Wren`; supported account types: *any organizational directory and personal Microsoft
   accounts*.
3. **Redirect URI:** platform **Single-page application (SPA)** (not "Web"), and enter
   `https://jackhale98.github.io/wren-cad/`. After registering, open **Authentication** and add
   `http://localhost:5173/` under the same SPA platform.
4. **API permissions -> Microsoft Graph -> Delegated:** `User.Read`, `Files.ReadWrite.All`,
   `Sites.Read.All` (SharePoint only), `offline_access`. None need admin consent, but some
   organisations restrict third-party apps.
5. Optional but recommended: **Branding & properties** -> verified publisher, so work accounts do
   not see "unverified".
6. Copy the **Application (client) ID** into `VITE_ONEDRIVE_CLIENT_ID`. Do not create a client
   secret.

## 4. Google Drive

1. [Google Cloud Console](https://console.cloud.google.com) -> create a project -> **APIs &
   Services -> Library** -> enable **Google Drive API**.
2. **OAuth consent screen** (Google Auth platform): External; add the scope
   `https://www.googleapis.com/auth/drive.file` (per-file access; not a sensitive scope, so no
   verification review). Publish the app (status *In production*), otherwise only listed test users
   can sign in and tokens expire after 7 days.
3. **Credentials -> Create credentials -> OAuth client ID -> Web application.**
   - Authorized JavaScript origins: `https://jackhale98.github.io`, `http://localhost:5173`.
   - Authorized redirect URIs: the two redirect URIs above.
4. Copy the **Client ID** into `VITE_GDRIVE_CLIENT_ID` (repository variable) and into the Worker
   as `GOOGLE_CLIENT_ID`; put the **Client secret** in the Worker secret `GOOGLE_CLIENT_SECRET`.
   Google's web-application clients need the secret for the code exchange, so Drive sign-in goes
   through the Worker's `/oauth/google/token` and `/oauth/google/refresh` routes.

## 5. GitHub

Two ways; the token route needs no registration.

**Fine-grained personal access token (no setup, works today).** The user creates it at GitHub ->
Settings -> Developer settings -> Fine-grained tokens: one repository, permission *Contents:
read and write*, short expiry. They paste it into Wren's "Git host (access token)" sign-in. Git
over HTTP still needs the CORS proxy (the Worker, or the development proxy).

**Sign in with GitHub (OAuth).** Preferred: a GitHub App (per-repository install picker, tokens
expire after 8 hours and refresh).

1. [GitHub -> Settings -> Developer settings -> GitHub Apps -> New](https://github.com/settings/apps/new).
2. Name `Wren`; Homepage `https://jackhale98.github.io/wren-cad/`; Callback URL
   `https://jackhale98.github.io/wren-cad/` (add `http://localhost:5173/` as a second callback);
   *Expire user authorization tokens* checked; *Request user authorization during installation*
   checked; Device Flow off; Webhook inactive; permission *Contents: Read and write* (Metadata
   read-only is automatic); installable on any account.
3. Copy the **Client ID** (starts `Iv`) and click **Generate a new client secret**; copy it now.
4. Client ID -> repository variable `VITE_GITHUB_CLIENT_ID` and Worker secret `GITHUB_CLIENT_ID`.
   Client secret -> Worker secret `GITHUB_CLIENT_SECRET` only.

A classic GitHub OAuth App also works with the same two secrets (scope `repo`), but it grants access
to all the user's repositories.

## 6. GitLab

GitLab supports PKCE without a secret, so create a non-confidential application.

1. GitLab -> Edit profile -> Applications -> **Add new application** (or the group/instance
   equivalent for self-managed).
2. Name `Wren`; Redirect URIs `https://jackhale98.github.io/wren-cad/` and
   `http://localhost:5173/` (one per line); **Confidential** unchecked; scopes `read_user`,
   `read_api`, `read_repository`, `write_repository`.
3. Application ID -> repository variable `VITE_GITLAB_CLIENT_ID` and Worker secret
   `GITLAB_CLIENT_ID`. If you make the application confidential, also set `GITLAB_CLIENT_SECRET`.

Self-hosted GitLab: add the host to `EXTRA_GIT_HOSTS`. The Worker's OAuth route targets gitlab.com
only; self-hosted instances use access tokens.

## 7. Bitbucket

1. Bitbucket -> Workspace settings -> **OAuth consumers -> Add consumer**.
2. Name `Wren`; Callback URL `https://jackhale98.github.io/wren-cad/`; *This is a private
   consumer* checked; permissions *Account: Read*, *Repositories: Read and Write*.
3. Key -> repository variable `VITE_BITBUCKET_CLIENT_ID` and Worker secret `BITBUCKET_CLIENT_ID`;
   Secret -> Worker secret `BITBUCKET_CLIENT_SECRET`. Bitbucket has no PKCE and allows a single
   callback URL, so localhost development needs a second consumer or the access-token route.

## 8. Forgejo / Gitea

The fully open-source route. Add the host to the Worker's `EXTRA_GIT_HOSTS`, and sign in with an
access token (Settings -> Applications) for a repository-scoped token with read/write on
repositories. No client registration is needed.

## 9. Nextcloud and other WebDAV servers

Nothing to register; the user supplies server, user name and an **app password** (Nextcloud ->
Settings -> Security -> Devices and sessions). Most servers send no CORS headers, so choose one:

1. **The Worker relay** (default, needs `VITE_SYNC_WORKER_URL`): the browser calls
   `<worker>/dav/<host>/<path>`. The password passes through the Worker in memory and is not stored
   or logged. List your servers in `DAV_HOSTS` (the relay is off without it). The server must have a public HTTPS host
   name; LAN addresses and `.local` names cannot be relayed.
2. **Nextcloud `webapppassword` app:** install it from the app store; it adds the CORS headers for
   an origin you list (`https://jackhale98.github.io`) and issues temporary app passwords for web
   apps. No relay needed.
3. **Reverse-proxy headers** (nginx, Caddy, Apache) on the WebDAV path:
   `Access-Control-Allow-Origin: https://jackhale98.github.io`,
   `Access-Control-Allow-Methods: GET, PUT, DELETE, PROPFIND, MKCOL, OPTIONS`,
   `Access-Control-Allow-Headers: Authorization, Content-Type, Depth, If-Match, If-None-Match`,
   `Access-Control-Expose-Headers: ETag, OC-ETag`, and answer `OPTIONS` preflights with `204`
   without requiring authentication.

## Troubleshooting

- *Provider shows as unavailable:* the app names the missing variable. Add it, then re-run CI on
  `main`.
- *403 from the Worker:* the page's origin is not in `ALLOWED_ORIGINS` (check scheme and port).
- *501 from `/oauth/...`:* the response names the missing Worker secret.
- *`redirect_uri` mismatch:* the registered URI must match exactly, including `https` and the
  trailing slash.
