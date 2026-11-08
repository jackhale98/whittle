# Whittle

[![CI](https://github.com/jackhale98/whittle/actions/workflows/ci.yml/badge.svg)](https://github.com/jackhale98/whittle/actions/workflows/ci.yml)

Free, open-source, browser-native parametric CAD. Installs as a PWA, works offline, and runs the
OpenCASCADE geometry kernel on your device via WebAssembly.

- Plan & architecture: [`docs/PLAN.md`](docs/PLAN.md)
- Decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- Dependencies: [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md)

## Develop

```sh
pnpm i
pnpm kernel:build   # Docker; builds the OCCT 8 Wasm kernel (cached in CI)
pnpm dev
pnpm test && pnpm e2e
```

Licensed under Apache-2.0. The geometry kernel (OCCT, LGPL-2.1 with exception) ships as a separate,
reproducibly built `.wasm`; see `packages/kernel`.
