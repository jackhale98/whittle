# Dependencies

Every runtime dependency, with license, approximate shipped size, and why. Dev-only tooling is listed
separately. Versions are pinned exactly in `package.json` (`save-exact=true`).

## Runtime

| Package                                           | Version | License | Shipped size (min+gzip, approx.) | Used by | Notes |
| ------------------------------------------------- | ------- | ------- | -------------------------------- | ------- | ----- |
| _(added by workstreams; keep this table current)_ |         |         |                                  |         |       |

## Kernel toolchain (build-time, Docker)

| Package / image                 | Version                                                                           | License                           | Notes                |
| ------------------------------- | --------------------------------------------------------------------------------- | --------------------------------- | -------------------- |
| `@libcascade/toolchain`         | 3.1.0                                                                             | LGPL-2.1-only WITH OCCT-exception | ADR-002              |
| `ghcr.io/taucad/opencascade.js` | `3.1.0-single-threaded@sha256:d7bf97ad…`, `3.1.0-multi-threaded@sha256:10b1b3c6…` | LGPL-2.1 (OCCT)                   | ≈ 12 GB on disk each |

## Dev tooling

| Package          | Version | License        |
| ---------------- | ------- | -------------- |
| `@biomejs/biome` | 2.6.6   | MIT/Apache-2.0 |
| `typescript`     | 6.0.3   | Apache-2.0     |
| `vitest`         | 5.1.0   | MIT            |
| `@types/node`    | 22.20.5 | MIT            |
