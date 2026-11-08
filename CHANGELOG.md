# Changelog

## Unreleased

### M0 — Foundations

- Plan, project memory (`CLAUDE.md`), subagent definitions, ADR-001 (stack), ADR-002 (kernel toolchain).
- `packages/contracts`: document schema, naming grammar, kernel/viewport/runtime APIs; C++ façade header.
- Kernel: OCCT 8.0.1 Wasm façade (`execFeature` box, `mesh`, `massProperties`), threaded and single-threaded builds (≈ 1.3 MB brotli each), Comlink worker with transferable meshes, golden tests.
- Viewport: three.js WebGPU/WebGL2 engine, studio look, fat-line edges, fading grid, camera-controls orbit/pan/zoom on mouse and touch.
- UI: tokens (light/dark, WCAG AA), Inter, motion presets, primitives, desktop/tablet/phone shells, ⌘K palette.
- Platform: PWA (injectManifest), single SW with COOP/COEP injection, offline kernel cache, CI, Pages deploy.
- App: shell + lazy viewport + kernel worker integrated; OCCT box on screen in ≈ 1 s warm, offline, and in single-threaded fallback.
- Materials and density on parts (ADR-004); GPL-3.0-or-later (ADR-003).
