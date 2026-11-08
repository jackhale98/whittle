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

### M1 — Parametric part modeling (in progress; gate fixes underway)
- Kernel: sketch regions, extrude/revolve/fillet/chamfer/boolean/plane with history-based persistent naming; STEP (AP214/AP203/AP242), STL, BREP export; STEP/BREP import; mass + inertia from density.
- Regen engine: incremental, hash-cached regeneration in the kernel worker; reference resolution name → fingerprint → needs attention (never guesses); ghosts; multi-body.
- Sketcher: PlaneGCS solver worker with verified residuals, per-entity DOF, minimal conflict sets with plain-language fixes, inference.
- Document: expressions with units (incl. compound), undo/redo with coalescing, deterministic project folder + `.whittle`, materials library, JSON Schema, FILE_FORMAT.md.
- App: welcome card + demo bracket, library with autosave, feature tree/params/inspector, picking, sketch mode, features, export (STEP/STL/3MF/GLB/BREP/.whittle), ⌘K check for updates.
- Licence notices shipped with the site (THIRD_PARTY_NOTICES.txt).
