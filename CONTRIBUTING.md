# Contributing to Whittle

Thanks for helping. Whittle is a browser-based CAD app, so most work touches the document model,
the geometry kernel, or the UI. Before you start, read:

- [`CLAUDE.md`](CLAUDE.md): the project rules (summarised below).
- [`docs/PLAN.md`](docs/PLAN.md): the authoritative plan and milestones.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): how the packages fit together.
- [`docs/DECISIONS.md`](docs/DECISIONS.md): the non-obvious choices already made.

## Setup

Prerequisites:

- **Node.js 22 or later** (`engines` in `package.json`).
- **pnpm 10.28** (pinned by `packageManager`). `corepack enable` gives you the right version.
- **Docker** for the kernel build only. The two toolchain images need about 21 GB of free disk.

```sh
pnpm i                                                 # install (CI uses --frozen-lockfile)
pnpm --filter @whittle/web exec playwright install chromium   # browsers for E2E tests
```

Dependency versions are pinned exactly (`.npmrc` sets `save-exact=true`).

Without a kernel build, the geometry-dependent parts cannot run. These are the kernel golden
tests (which skip with a note), the regeneration tests, and STEP and STL export. Build it with
`pnpm kernel:build` when you need them (see [Kernel build](#kernel-build)).

## The golden rules

These come from `CLAUDE.md`. They apply to every change.

1. **The main thread never runs WebAssembly.** The kernel and the sketch solver run in workers.
   Meshes are transferred to the main thread, not copied.
2. **`packages/contracts` is owned by the lead.** Propose a change before you make it. Do not edit
   contracts as a side effect of a feature. See [Contracts](#contracts).
3. **Every change ships with tests.** Kernel changes need golden tests that check volumes, areas and
   face counts.
4. **Never guess a topological reference.** If a reference can't be resolved, the feature is marked
   "needs attention" and the user re-picks it.
5. **No modal dialogs for modelling.** Values are typed inline and accept expressions with units.
6. **Respect the performance budgets** in PLAN §10. Run `pnpm perf` before you declare UI or
   viewport work finished.
7. **Self-host every asset.** The app is cross-origin isolated, so no CDN fonts or scripts.
8. **Pin dependencies.** Record every new runtime dependency in
   [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) with its licence and size.
9. **Record non-obvious choices** in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Code style

- **TypeScript** in strict mode (`tsconfig.base.json`). No `any` in public APIs.
- **Biome** formats and lints everything. `pnpm lint` runs `biome check .`, and `pnpm format` writes
  fixes. CI runs `biome ci .`, so run `pnpm lint` before you push.
- **C++17** in the kernel façade. Catch every OCCT exception at the boundary, so the worker never
  crashes.
- **UI:** use the Radix primitives and Tailwind tokens from `packages/ui`. Use the Motion presets
  rather than ad-hoc animation values.
- **Comments** explain why something is the way it is. Refer to the plan or an ADR where it helps
  (for example, "ADR-008 §1").

## Tests every change needs

| What you changed | Tests to add or run |
| --- | --- |
| Expressions, units, store, codec, materials (`packages/document`) | Unit tests in `packages/document/test`. If you change the schema, regenerate the JSON Schemas with `pnpm --filter @whittle/document schema`. A test fails when the committed schemas are stale. |
| Kernel façade or features (`packages/kernel`) | Golden tests in `packages/kernel/test` checking volume, area and face counts. For naming changes, add an "edit upstream, check downstream" case in `packages/kernel-client/test/regen`. |
| Regeneration, naming, imports (`packages/kernel-client`) | Tests in `packages/kernel-client/test`. These run against the real kernel, so they need `pnpm kernel:build` first. |
| Sketch solver, constraints, DOF (`packages/sketch`) | Unit tests in `packages/sketch/test`. |
| I/O formats (`packages/io`) | Tests in `packages/io/test`. |
| Viewport (`packages/viewport`) | Unit tests, plus E2E tests in `packages/viewport/e2e` for behaviour a user can see. |
| UI components (`packages/ui`) | Vitest with Testing Library in `packages/ui/test`. For user flows, add a Playwright test in `packages/ui/e2e` or `apps/web/e2e`. |
| App logic and flows (`apps/web`) | Unit tests next to the source (`src/**/*.test.ts`). User-facing flows get E2E tests in `apps/web/e2e`. |
| Anything that affects a budget | Run `pnpm perf`, and say in the PR what you measured. |

A user-visible change also needs a line in the user guide
([`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)).

## Contracts

`packages/contracts` holds the types that packages share: the document schema, the kernel and
modelling APIs, the sketch API, the viewport API, the store and the I/O codecs. Because every package
depends on it, changes there affect everyone.

To change a contract:

1. Open a proposal first (an issue, or a draft PR that only changes the contract). Say which packages
   are affected and why.
2. Get the lead's sign-off.
3. Land the contract change on its own, with regenerated schemas and updated docs if the file
   format changes.

Changes to the document schema are file-format changes. Update
[`docs/FILE_FORMAT.md`](docs/FILE_FORMAT.md) and bump `schemaVersion` when a change breaks readers.

## Running the tests

| Command | What it runs |
| --- | --- |
| `pnpm test` | Unit tests for every package (`pnpm -r --if-present test`). |
| `pnpm typecheck` | `tsc` for every package. |
| `pnpm lint` | Biome. |
| `pnpm kernel:test` | The kernel's golden tests. They need `packages/kernel/dist`. |
| `pnpm e2e` | Builds the app, then runs the Playwright tests in Chromium. |
| `pnpm perf` | The performance project. Run it serially on an idle machine. |

Some details:

- **Ports.** The E2E web server uses port 4173 by default. Set `WHITTLE_E2E_PORT` to use another port,
  for example `WHITTLE_E2E_PORT=4174 pnpm e2e`. Outside CI, Playwright reuses a server that is
  already running on that port.
- **CI mode.** `CI=1` matches the CI run: one worker, one retry, `test.only` is forbidden, and the
  GitHub reporter is used (`apps/web/playwright.config.ts`). Set it locally to reproduce a CI failure.
- **All browsers.** `pnpm --filter @whittle/web e2e:all` runs the Chromium, Firefox and WebKit
  projects. CI runs Firefox headed under a virtual display (`xvfb-run`), because headless Firefox has
  no WebGL on CI runners. Locally, set `WHITTLE_HEADED=1` to get the same headed mode.
- **One file.** Run one spec with
  `pnpm --filter @whittle/web exec playwright test e2e/bracket.spec.ts --project=chromium`.
- **Traces.** The config sets `trace: 'off'`, and the package scripts pass `--trace off`. To record
  a trace, run Playwright with `--trace on` and open the file with `playwright show-trace`.
- **Snapshots.** `pnpm --filter @whittle/ui e2e:update` rewrites the UI screenshots. CI runs the
  UI suite with `--ignore-snapshots` until CI-generated baselines are committed (ADR-005 §6).
- **Browsers in CI.** The workflows install browsers with
  `playwright install --with-deps <browser>` before the tests run. They are not preinstalled on the
  runners.

## Kernel build

The kernel is OCCT 8.0.1 compiled to WebAssembly with Whittle's C++ façade. Its details are in
[`packages/kernel/README.md`](packages/kernel/README.md) and ADR-002.

```sh
pnpm kernel:build                                       # both variants, in Docker (about 20-23 minutes)
node packages/kernel/scripts/build.mjs --variant single  # one variant only
pnpm kernel:test                                        # golden tests against packages/kernel/dist
```

The build amalgamates the façade sources, runs `libcascade build` in digest-pinned Docker images,
assembles the initialisers, and writes a size report. It fails if a `.wasm` is over 15 MB brotli.
Don't run `npx libcascade build` on its own, because the config points at the amalgamated file.

Notes:

- `packages/kernel/dist` is gitignored. Never commit `.wasm` files.
- The façade is C++17. Avoid constructs that the toolchain's libclang 18 can't parse (for example,
  floating-point `std::from_chars`). Use the `NCollection_*` templates rather than the deprecated
  `TopTools_*` typedefs.
- A C++ syntax check is faster than a full build: see the kernel README.

### CI cache

`.github/workflows/kernel.yml` is a reusable workflow, called by `ci.yml` on pull requests and on
pushes to `main`. It caches
`packages/kernel/dist` with a key made from:

- `packages/kernel/src/**`, `packages/kernel/scripts/**`, `packages/kernel/libcascade.config.ts` and
  `packages/kernel/package.json`, and
- `KERNEL_CACHE_VERSION`, set in the workflow.

The repository lockfile is deliberately not part of the key, so app and UI dependency changes reuse
the cached kernel. The build runs only on a cache miss. To force a rebuild without touching the kernel
inputs (for example, after a toolchain image digest changes), bump `KERNEL_CACHE_VERSION`.

## Documentation to update with a change

- **[`CHANGELOG.md`](CHANGELOG.md)**: add a line under "Unreleased" for each user-visible change.
- **[`docs/DECISIONS.md`](docs/DECISIONS.md)**: add an entry (date, decision, why, alternatives) for
  any non-obvious choice. Never rewrite an old entry. Mark it "Superseded by ADR-xxx" instead.
- **[`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md)**: record every new runtime dependency with its
  licence, its approximate shipped size and why it is there. Also record new dev dependencies.
  Dependencies must be GPL-3.0-compatible (ADR-003). GPL-2.0-only dependencies are not allowed.
- **[`docs/FILE_FORMAT.md`](docs/FILE_FORMAT.md)**: any change to what is written to disk.
- **The package's README**, when you change its public API.
- **[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)**, when a user can see the change.

`docs/PLAN.md` is authoritative. Propose changes to it rather than editing it casually.

## Licensing of contributions

- **Code** is GPL-3.0-or-later (ADR-003). Every package declares `"license": "GPL-3.0-or-later"` in
  its `package.json`, and new packages must do the same. By contributing, you agree that your
  contribution is released under that licence.
- **The file-format specification** (`docs/FILE_FORMAT.md`) is CC-BY-4.0, so anyone can implement a
  reader or writer.
- **The kernel build outputs** (`.wasm` and `.js` containing OCCT) are LGPL-2.1-only WITH
  Open-CASCADE-Exception-1.0. They are built from `packages/kernel`, and their licence texts are in
  [`licenses/`](licenses).
- **Third-party code** keeps its own licence. The built site ships `THIRD_PARTY_NOTICES.txt`, which
  is generated during `pnpm build`.
