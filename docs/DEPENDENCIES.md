# Dependencies

Every runtime dependency, with license, approximate shipped size, and why. Dev-only tooling is listed
separately. Versions are pinned exactly in `package.json` (`save-exact=true`). Whittle is
GPL-3.0-or-later (ADR-003): every dependency must be GPL-3.0-compatible (no GPL-2.0-only).

## Runtime

| Package | Version | License | Shipped size (gzip, approx.) | Used by | Notes |
|---|---|---|---|---|---|
| `react`, `react-dom` | 19.3.1 | MIT | ≈ 62 KB | apps/web, ui | UI chrome only |
| `workbox-window` | 7.4.1 | MIT | ≈ 2.5 KB | apps/web | SW registration/update |
| `workbox-core`, `-precaching`, `-routing`, `-strategies`, `-expiration`, `-cacheable-response` | 7.4.1 | MIT | ≈ 8 KB (in `sw.js`) | apps/web SW | Bundled into the service worker |
| `comlink` | 4.4.2 | Apache-2.0 | ≈ 1.8 KB | kernel-client | Worker RPC with transferables |
| `three` | 0.187.0 | MIT | ≈ 240 KB with camera-controls (lazy chunk) | viewport | `three/webgpu`, `three/tsl`, line/env addons |
| `camera-controls` | 3.1.2 | MIT | (in the above) | viewport | |
| `motion` | 14.10.1 | MIT | ≈ 8 KB initial + 19 KB lazy | ui | Spring presets only |
| `lucide-react` | 1.70.0 | ISC | ≈ 3 KB (tree-shaken) | ui | |
| `@radix-ui/react-tooltip` / `-toolbar` / `-tabs` / `-separator` / `-dialog` | 1.4.1 / 1.2.1 / 1.2.1 / 1.2.0 / 1.3.1 | MIT | ≈ 20 KB (+ 7.7 KB lazy dialog) | ui | |
| `@fontsource-variable/inter` | 5.3.0 | OFL-1.1 | latin woff2 48 KB (on demand) | ui | Self-hosted font (font data, separate work) |
| `fflate` | 0.8.3 | MIT | ≈ 8 KB | io (and document) | Zip for 3MF and `.whittle` |
| `idb` | 8.0.4 | ISC | ≈ 1.2 KB | io (browser) | IndexedDB wrapper for the local library |
| Kernel artefacts `whittle-kernel{,-st}.{js,wasm}` | OCCT 8.0.1 | LGPL-2.1-only WITH Open-CASCADE-Exception-1.0 | ≈ 1.3 MB brotli each (lazy, runtime-cached) | kernel | Built reproducibly from `packages/kernel` |

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
| `@testing-library/react`, `jest-dom`, `user-event` | 16.3.3, 7.0.1, 14.6.8 | MIT |
| `@types/three`, `@types/react`, `@types/react-dom` | 0.187.0, 19.3.0, 19.3.0 | MIT |
