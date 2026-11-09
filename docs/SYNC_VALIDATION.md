# Sync validation: manual matrix against real accounts

The automated suite (`pnpm --filter @wren-cad/sync test`) covers every provider against a mock
service (contract tests), two-device races, offline replay, cursor expiry, the debounce, the
focus-to-visible timing and a concurrent-edit fuzz. It cannot prove how the real services behave
with CORS, OAuth, rate limits, eventual consistency and desktop sync clients. Run this matrix
before each M2.5+ release, and whenever a provider adapter changes. Record the result, date,
browser and build in the table at the end.

## Setup

- Two devices, A and B: a desktop (Chromium, plus Safari or Firefox for the OAuth rows) and an
  iPad with Wren installed as a PWA. Same build, served from the real Pages origin (OAuth
  redirect URIs are registered for it; see docs/SYNC_SETUP.md on the platform branch).
- Test accounts only. Never a personal account holding real data.
- Accounts and settings the owner provides:
  - **Dropbox:** an app (scoped access, *App folder*), app key in `VITE_DROPBOX_APP_KEY`, redirect
    URI = the app's callback page; permissions `account_info.read`, `files.metadata.read`,
    `files.content.read`, `files.content.write`.
  - **Microsoft:** an Entra app registered as a *single-page application* with the callback as
    redirect URI; delegated permissions `User.Read`, `Files.ReadWrite`, `offline_access`, plus
    `Files.ReadWrite.All` and `Sites.Read.All` for SharePoint; a personal and a work (M365)
    account with a SharePoint site.
  - **Nextcloud:** a test server with the `webapppassword` app (CORS for the origin) and one
    without it (relay path), each with an app password.
  - **Google:** a web OAuth client with the callback as redirect URI and the Worker's
    `/oauth/google/*` routes configured (only once the Drive provider ships).
- Open DevTools on A: Application → IndexedDB, Network, Console.

## Matrix

Each row runs for every provider column unless marked. Expected results are the pass criteria.

| # | Scenario | Steps | Expected |
|---|---|---|---|
| 1 | Sign in | Connect the provider from A. | Full-page redirect to the provider (no popup), back to Wren, connection listed. Address bar no longer shows `code=`/`state=`. |
| 2 | Sign-in cancelled | Start sign-in, press Cancel/Deny on the provider page. | Back in Wren with "Sign-in didn't finish"; no connection created; no `code` in storage. |
| 3 | Tokens at rest | After row 1, inspect IndexedDB `whittle-vault` and `sessionStorage`, search for the access token copied from the Network tab. | Only `{ v, iv, data }` byte records; the token, refresh token, username and password are not found anywhere; `keys` holds a `CryptoKey` with `extractable: false`. |
| 4 | Scopes | Read the consent screen / app permissions page. | Exactly the scopes listed in Setup; OneDrive asks for `.All` only when SharePoint was chosen. |
| 5 | Link a new project | On A, create a project and link it to an empty folder. | All project files appear in the service folder; `.wren/` is absent there; `.wren-history/` present once a version is saved. |
| 6 | Open on B | Link B to the same folder. | Project opens on B identical to A (same parameters, parts, regenerated volume). |
| 7 | Edit visible within 10 s of focus | Edit a parameter on A, wait 4 s, switch to B (focus the app). | B shows the change within 10 s of gaining focus. Repeat with B focused *immediately* after the edit (follow-up check): still within 10 s. |
| 8 | Different features offline | Both devices offline (airplane mode); A edits parameter *width*, B edits a fillet radius; bring A online, then B. | Both edits present on both devices; no conflict shown. |
| 9 | Same parameter offline | Both offline; A sets *width* 45 mm, B sets 50 mm; A online, then B. | B shows a conflict for *width*; the service still has 45 mm until B resolves; after "Keep mine" both show 50 mm, after "Take theirs" both show 45 mm. Other edits survive either way. |
| 10 | Attachment both sides | Replace the same imported STEP on both devices while offline. | Whole-file conflict naming the file path; nothing uploaded until resolved. |
| 11 | Offline queue across restart | Offline on A, edit, close the tab/PWA, reopen still offline, go online. | Status shows pending count while offline and after reopening; edits upload on reconnect. |
| 12 | Race | Edit on A and B within the same 3 s window while both online. | No overwrite: either merged or a conflict; Network tab on the loser shows a 409/412 followed by a re-read. |
| 13 | Delete vs edit | Delete a part on A while B edits it offline; sync A, then B. | B gets a modified/deleted conflict for the part (document merge); nothing silently removed. |
| 14 | Remote change by other tools | Edit `params.json` in the provider's web UI (or the desktop client). | Wren pulls it on the next focus/poll; a malformed file shows "isn't a complete project yet" and retries without changing local files. |
| 15 | Token refresh | Wait past access-token expiry (Dropbox 4 h, Microsoft and Google 1 h), then sync. | Silent refresh; new token in the vault; no sign-in prompt. |
| 16 | Revoked access | Revoke the app in the provider's account settings, then sync. | Status "signed you out. Sign in again"; edits stay queued; re-sign-in (renew) resumes with the same connection. |
| 17 | Rate limit | Bulk-edit (e.g. 200 rapid parameter edits) on a slow account. | Debounced into few uploads; any 429 shows "asked to slow down" and recovers. |
| 18 | Cursor expiry | Leave B closed > 7 days (Dropbox cursors and Graph delta links expire), then open. | Full relisting; correct state; no duplicate or lost files. |
| 19 | Case (Dropbox/OneDrive) | Rename `Parts/` to `parts/` in the web UI. | No duplicate files locally; spelling kept. |
| 20 | WebDAV CORS (Nextcloud without `webapppassword`, relay off) | Connect directly. | Clear CORS message suggesting the relay; with the relay on, rows 5 to 12 pass. |
| 21 | WebDAV weak ETags | Server returning `W/` ETags (e.g. some Apache configs). | Writes still refuse stale revisions (row 12 passes). |
| 22 | SharePoint | Work account, pick a site's document library. | Rows 5 to 9 pass in the library; label shows "SharePoint · <site>". |
| 23 | Local folder (Chromium desktop) | Pick a Dropbox/OneDrive desktop-synced folder as a Folder connection; edit on A, let the desktop client sync, open via the cloud connection on B. | Changes cross; reopening the browser asks to allow folder access again on a click, never silently fails. |
| 24 | Never-synced cache | After all rows, list the service folder. | No `.wren/` folder anywhere in the service. |

Rows 1 to 4 and 15 to 16 don't apply to the local-folder and WebDAV columns (no OAuth); row 3
still applies to WebDAV passwords.

## Results

| Date | Build | Browser / device | Dropbox | OneDrive | SharePoint | Nextcloud (CORS) | Nextcloud (relay) | Folder | Notes |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |
