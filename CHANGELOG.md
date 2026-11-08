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

### M1 — Parametric part modeling
- Kernel: sketch regions, extrude/revolve/fillet/chamfer/boolean/plane with history-based persistent naming; STEP (AP214/AP203/AP242), STL, BREP export; STEP/BREP import; mass + inertia from density.
- Regen engine: incremental, hash-cached regeneration in the kernel worker; reference resolution name → fingerprint → needs attention (never guesses); ghosts; multi-body.
- Sketcher: PlaneGCS solver worker with verified residuals, per-entity DOF, minimal conflict sets with plain-language fixes, inference.
- Document: expressions with units (incl. compound), undo/redo with coalescing, deterministic project folder + `.whittle`, materials library, JSON Schema, FILE_FORMAT.md.
- App: welcome card + demo bracket, library with autosave, feature tree/params/inspector, picking, sketch mode, features, export (STEP/STL/3MF/GLB/BREP/.whittle), ⌘K check for updates.
- Licence notices shipped with the site (THIRD_PARTY_NOTICES.txt).
- Import: STEP/BREP as solids, STL/OBJ/3MF/GLB as reference meshes, from Open…, ⌘O, drag and drop or the OS; bytes stored in the project (`imports/`) by sha256.
- Healing: rebound references persist with the next edit (ADR-008); needs-attention references show a ghost at their last position, one-click re-pick and a "Which one?" chooser.
- Sketch dimensions: horizontal/vertical by label placement, aligned with Shift, Ø ↔ R, driving ↔ reference.
- Files: cached meshes in `.whittle/meshes/` (cached open ≈ 0.4 s); extra project files survive library and `.whittle` round trips; opening an older copy never overwrites a different library entry; a pending autosave is written with its own document's files when another document loads.
- Published JSON Schemas at `/whittle/schema/`; the fake engine is dev/test only.
- Acceptance: the PLAN §12 bracket built through the UI on the real engine, three parameter edits, STEP export and re-import (volume within 1e-6; holes checked to move).
- Fixes: fast clicks close a sketch loop on its start point; several-group expressions convert Ø ↔ R correctly; CI E2E runs on one worker with real waits.

### M2 — Touch & tablet excellence

- Brand: the perched-bird logo and whittling loader (brand kit in `brand/`). App icons, maskable icons, Apple touch icon and an adaptive favicon; the bird in the top bar and on the welcome card; a boot splash with the loader until the app renders; the loader in the view while the kernel streams in with nothing cached. Theme-aware: one inline SVG follows light/dark, the wing takes the app accent, and reduced motion shows the still bird.

- Platform: installed iPad/iPhone PWA hardening (no page zoom or scroll, no callouts or rubber-banding, safe-area variables), iPadOS-as-Mac tier detection, tier policy (regen cache, mesh quality, phone lazy kernel boot); CI performance gate (shell TTI, memory, viewport probes with a SwiftShader factor), non-gating Lighthouse job, failure-only Playwright traces.
- Sketch: Pencil stroke recognition (`recognizeStroke`, `@whittle/sketch/recognize`, pure TS, ≈ 0.2 ms for 500 samples): line, polyline, rectangle (rotated or snapped axis-aligned), circle, arc (CCW), scribble; snaps H/V, right angles and closure; `strokeFragment` turns it into entities + constraints. Solver polish: driving dimensions and coincidences hold to ≤ 1e-10 mm, so sketches dimensioned to meet are exactly coplanar (ADR-011).
- UI: tablet shell reworked (PLAN §9.1): slim tool rail with Sketch / Solid / Modify / Inspect groups and flyouts, a context bubble that follows the selection (flips at the edges, never covers the anchor), and a three-snap bottom sheet (peek / half / full) with drag, fling and an accessible handle. Phone shell gains real Parts, Measure and Section panels (lazy). Inline keypad now has units, an expression row and parameter names, never covers its field, and hands over to the OS keyboard and back. Push/pull value chip, non-modal bracket tutorial coach marks (`useTutorial`, `bracketTutorial`), long-press menus on history rows, 44 px targets throughout, `overflow-clip` stages, motion presets mirrored as CSS tokens (ADR-012).

- Kernel: push/pull of planar faces (`PushPullFeature`): prism + fuse/cut. Seams the move creates are merged, so a pulled box stays a six-face box and a pocket pulled flush closes. Names per naming.ts M2: moved faces keep their names, walls are `F…:side(<edge>)`, swallowed faces disappear. The result is always BRepCheck-valid (ShapeFix only when needed). Clear errors for curved faces and for pushes that remove the whole body (ADR-013).
- Kernel: exact `measure`: distance with closest points, angle between planar faces or straight edges, edge length, face area, radius of circles/cylinders/spheres, vertex position.
- Regen engine: push/pull end to end (faces resolved like any ref, on one body; downstream refs to moved faces and walls survive upstream edits). `ModelingApi.measure(partId, a, b?)` on the latest regen, with targets resolved exactly as `refFor` resolves them.
- Viewport: `TouchViewport` — twist-roll plus tap/double-tap/long-press/two- and three-finger-tap gestures with palm rejection (`setInputPolicy`), throttled `onCamera`, `zoomTo`, section planes with stencil caps (WebGPU and WebGL2), same-frame push/pull prism previews, constant-size arrow handles picked before geometry, tone/dash markers and `SketchResult.points`; idle shader warm-up and a 1M-triangle frame-time assertion (`WHITTLE_PERF_ASSERT=1`).
- App integration (ADR-016): gestures (tap selects, double-tap zooms, long-press bubble, two/three-finger undo/redo); context bubble at the selection; push/pull tool with arrow drag, same-frame preview, value chip and keypad, recorded as an undoable `PushPullFeature`; Measure (desktop/tablet Inspect, phone tab) with markers and labels; Section (axis or face, offset, flip, caps); Pencil strokes recognised live in sketch mode, palm-safe; the bracket tutorial from the welcome card and ⌘K, completed touch-only on iPad emulation; tier policy and the phone's lazy kernel; attention markers as viewport markers; orphaned import attachments never saved; overlays clear of the rail, top bar and sheet.
- Fix (M2 gate): push/pull of faces facing different ways runs one step per normal group, in a fixed order, re-finding later faces by name; a plate's top + side pulled +5 is now the uniform offset (63750 mm³, was 62500 with a notch at the corner), a face swallowed by an earlier step fails the feature with the face named, and the preview fills the corner too (ADR-013 addendum).
- Fix (M2 gate): phone export: STEP and STL are only unavailable when the kernel failed to start. Choosing one (or pressing Export) boots the lazy kernel, the form shows its loading progress, then the file is written; a target that becomes unavailable is never shown checked-but-disabled. Phone E2E for STL/STEP export and for a parameter edit that boots the kernel.
- Fix (M2 gate): 44 px touch targets on touch tiers for the welcome card actions and its Close button, the floating Library button, the prompt chip's Esc and the Params "Add description" (ADR-012 item 6), measured in the tablet and phone E2E; the landscape bubble-overlap check in m2-touch is now a real overlap assertion.
- Fix (M2 gate): measure picks follow edits: after each regen face and edge picks are found again by persistent name (vertices by position), and picks that no longer resolve are dropped, so an undo while measuring never silently measures another face.
- Fix (M2 gate): the bubble's Sketch action and undo/redo deferred behind a busy sketch are tracked, so `idle()` waits for them.
