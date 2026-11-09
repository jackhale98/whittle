# Dependencies

Every runtime dependency, with license, approximate shipped size, and why. Dev-only tooling is listed
separately. Versions are pinned exactly in `package.json` (`save-exact=true`). Whittle is
GPL-3.0-or-later (ADR-003): every dependency must be GPL-3.0-compatible (no GPL-2.0-only).
Notices: `pnpm build` writes `THIRD_PARTY_NOTICES.txt` into the site (`scripts/third-party-notices.mjs`) with every
bundled package's licence text plus OCCT's LGPL-2.1 + exception (texts in `licenses/`).

## Runtime

| Package | Version | License | Shipped size (gzip, approx.) | Used by | Notes |
|---|---|---|---|---|---|
| `react`, `react-dom` | 19.3.1 | MIT | ≈ 62 KB | apps/web, ui | UI chrome only |
| `workbox-window` | 7.4.1 | MIT | ≈ 2.5 KB | apps/web | SW registration/update |
| `workbox-core`, `-precaching`, `-routing`, `-strategies`, `-expiration`, `-cacheable-response` | 7.4.1 | MIT | ≈ 8 KB (in `sw.js`) | apps/web SW | Declared as devDependencies of apps/web and bundled into `sw.js` at build time, so they are not separate runtime packages |
| `comlink` | 4.4.2 | Apache-2.0 | ≈ 1.8 KB | kernel-client, sketch (runtime); apps/web (dev) | Worker RPC with transferables |
| `three` | 0.187.0 | MIT | ≈ 240 KB with camera-controls (lazy chunk) | viewport | `three/webgpu`, `three/tsl`, line/env addons |
| `camera-controls` | 3.1.2 | MIT | (in the above) | viewport | |
| `three-mesh-bvh` | 0.9.18 | MIT | ≈ 15 KB (lazy viewport chunk) | viewport | Edge/vertex occlusion and fallback face picking |
| `motion` | 14.10.1 | MIT | ≈ 8 KB initial + 19 KB lazy | ui | Spring presets only |
| `lucide-react` | 1.70.0 | ISC | ≈ 3 KB (tree-shaken) | ui, apps/web | |
| `@radix-ui/react-tooltip` / `-toolbar` / `-tabs` / `-separator` / `-dialog` | 1.4.1 / 1.2.1 / 1.2.1 / 1.2.0 / 1.3.1 | MIT | ≈ 20 KB (+ 7.7 KB lazy dialog) | ui | |
| `@fontsource-variable/inter` | 5.3.0 | OFL-1.1 | latin woff2 48 KB (on demand) | ui | Self-hosted font (font data, separate work) |
| `@salusoft89/planegcs` | 1.3.0 | LGPL-2.0-or-later | wasm 173 KB gzip + glue 9.5 KB (sketch worker, lazy) | sketch; kernel-client (lazy, for sketch re-solves in the kernel worker) | FreeCAD's PlaneGCS; outputs re-verified by our residual model |
| `ulid` | 3.0.2 | MIT | < 1 KB | sketch | |
| `fflate` | 0.8.3 | MIT | ≈ 8 KB | document, io, kernel-client | Zip for 3MF and `.whittle` |
| `idb` | 8.0.4 | ISC | ≈ 1.2 KB | io (browser), sync | IndexedDB wrapper for the local library; sync's credential vault, sync state and merge bases, folder handles |

| `idb` | 8.0.4 | ISC | ≈ 1.2 KB | io (browser) | IndexedDB wrapper for the local library |
| `isomorphic-git` | 1.44.3 | MIT (deps MIT, Apache-2.0, BSD-3-Clause, Zlib) | ≈ 97 KB with the next two (lazy chunk, git connections only) | sync (`GitHistory`) | Pinned to Mycelium's version. Clone, fetch, pull, push, tags in the browser |
| `@isomorphic-git/lightning-fs` | 4.10.3 | MIT (dep `@isomorphic-git/idb-keyval` Apache-2.0) | (in the above, ≈ 7.5 KB) | sync (`browserGitFs`) | IndexedDB filesystem for cloned repositories. Pinned to Mycelium's version |
| `buffer` | 6.0.3 | MIT | (in the above, ≈ 13 KB) | sync (git polyfill) | isomorphic-git needs Node's `Buffer` in browsers and workers |
| Kernel artefacts `whittle-kernel{,-st}.{js,wasm}` | OCCT 8.0.1 | LGPL-2.1-only WITH Open-CASCADE-Exception-1.0 | ≈ 3.7 MB brotli / 5.3 MB gzip each since M1 (STEP/XCAF); lazy, runtime-cached | kernel | Built reproducibly from `packages/kernel` |

## Kernel toolchain (build-time, Docker)

| Package / image | Version | License | Notes |
|---|---|---|---|
| `@libcascade/toolchain` | 3.1.0 | MIT | ADR-002. The images and the produced wasm are LGPL (OCCT). |
| `ghcr.io/taucad/opencascade.js` | `3.1.0-single-threaded@sha256:d7bf97ad…`, `3.1.0-multi-threaded@sha256:10b1b3c6…` | LGPL-2.1 (OCCT) | ≈ 12 GB on disk each (shared layers ≈ 21 GB total) |

## Dev tooling

| Package | Version | License |
|---|---|---|
| `@biomejs/biome` | 2.6.6 | MIT/Apache-2.0 |
| `typescript` | 6.0.3 | Apache-2.0 |
| `vitest` | 5.1.0 | MIT |
| `@types/node` | 22.20.5 | MIT |
| `vite` | 8.3.6 | MIT |
| `@vitejs/plugin-react` | 6.2.1 | MIT |
| `vite-plugin-pwa`, `workbox-build` | 2.0.0, 7.4.1 | MIT |
| `tailwindcss`, `@tailwindcss/vite` | 4.3.5 | MIT |
| `@playwright/test` | 1.63.0 | Apache-2.0 |
| `@axe-core/playwright` | 4.14.0 | MPL-2.0 |
| `size-limit`, `@size-limit/file` | 14.3.0 | MIT |
| `jsdom` | 31.0.0 | MIT |
| `fake-indexeddb` | 6.2.7 | Apache-2.0 |
| `ajv` | 8.20.0 | MIT |
| system `git` (not an npm package; `git http-backend` serves the sync tests' local repositories) | ≥ 2.34 | GPL-2.0-only (run as a separate program, not linked or shipped) |
| `ts-json-schema-generator` | 2.9.0 | MIT |
| FreeCAD (not an npm package; `micromamba create -p env -c conda-forge freecad`; optional, run by hand or by CI as a separate program) | 26.3.0 (any release with the `Part` module works) | LGPL-2.0-or-later (run as a separate program, not linked or shipped) | Independent volume check of the reference parts (PLAN 12A): `packages/test-fixtures/reference-parts/freecad/`. Test-only; the Node tests only read its recorded results (`freecad-results.json`). |
| `@testing-library/react`, `jest-dom`, `user-event` | 16.3.3, 7.0.1, 14.6.8 | MIT |
| `@types/three`, `@types/react`, `@types/react-dom` | 0.187.0, 19.3.0, 19.3.0 | MIT |
| `@lhci/cli` (CI only; `npx`, not installed in the workspace) | 0.16.0 | Apache-2.0 |
| `lighthouse` (via `@lhci/cli`) | 13.6.0 | Apache-2.0 |

## Sync worker (`worker/`, Cloudflare Workers)

No runtime dependencies: the worker uses only Workers' built-in `fetch`, `Request`, `Response` and `ReadableStream`, and ships no bundled third-party code. Ported from Mycelium's sync worker (Apache-2.0, same author; licence text kept in `worker/LICENSE-APACHE-2.0`), reminders and push removed; the modified, combined worker is GPL-3.0-or-later. It is tested and typechecked with the root `typescript` and `vitest` above.

| Tool | Version | License | Notes |
|---|---|---|---|
| `wrangler` (deploy only; `npx wrangler@4.151.3`, not installed in the workspace) | 4.151.3 | MIT OR Apache-2.0 | Pinned in the `worker/package.json` scripts and in docs/SYNC_SETUP.md. Never part of the web bundle. |
