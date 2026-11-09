# Wren — project memory

Wren is a free, open-source, local-first parametric CAD PWA. The full plan is in docs/PLAN.md. It is authoritative; read it before starting work.

## Golden rules

- The main thread never touches Wasm. The kernel runs in a worker; meshes are transferred, not copied.
- packages/contracts is lead-owned. Propose changes; don't edit it from subagents.
- Every change ships with tests. Kernel changes need golden tests (volume/area/face counts).
- Never silently guess a topological reference. Unresolved = "needs attention".
- No modal dialogs for modeling. Values are inline and accept expressions with units.
- Respect the performance budgets in PLAN §10. Run `pnpm perf` before declaring UI or viewport work done.
- Self-host every asset (cross-origin isolation). No CDN fonts or scripts.
- Pin dependency versions. Record new runtime deps in docs/DEPENDENCIES.md with license and size.
- Record non-obvious choices in docs/DECISIONS.md.

## Commands

- `pnpm i` · `pnpm dev` · `pnpm test` · `pnpm e2e` · `pnpm perf` · `pnpm build`
- `pnpm kernel:build` (Docker; slow; CI caches it) · `pnpm kernel:test`

## Style

- TypeScript strict, no `any` in public APIs. Biome formatting.
- C++17 in the kernel façade; catch all OCCT exceptions at the boundary.
- UI: Radix primitives + Tailwind tokens from packages/ui. Use Motion presets, never ad-hoc animation values.
