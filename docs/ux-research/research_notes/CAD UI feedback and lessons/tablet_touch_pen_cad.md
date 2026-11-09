# Tablet, touch and pen CAD UX (iPad and Apple Pencil focus)

Research date: 2026-11-09. About 25 search and fetch calls. Several primary pages could not be read: the Shapr3D support cheat sheet (HTTP 403) and the Apple HIG Pencil page (the body would not render to the fetch tool). Statements that rest only on background knowledge, without a source fetched in this session, are kept out of "Cited Findings". They appear under "Inferences" (marked UNVERIFIED) or under "Gaps".

Each finding is labelled **[Fact]** (documented behaviour, release notes, vendor documentation) or **[Opinion]** (reviewer or user sentiment).

---

## 1. Shapr3D: Pencil and finger roles, gestures, inference, smart tools, dimensions, history, desktop port, praise and complaints

### Takeaway
Shapr3D's core rule is that the finger moves the view and the Pencil makes and edits geometry. It adds an "Adaptive UI": you select geometry and the app offers the tools that fit, with directional glyphs such as drag out to extrude and drag in to cut. Constraints are inferred while you sketch, and dimensions are suggested from what you select. Reviewers call this split the best fit of touch to CAD. The long-standing complaints are:
- weak assemblies (historically none);
- a free tier limited to low-quality STL;
- subscription pricing that hobbyists find steep;
- a parametric history, added in 2024, that some users find confusing or slow on long timelines.

### Cited Findings

**Division of labour and gestures**
- **[Fact]** Fingers control the view (spin, pan, zoom). The Pencil creates and edits geometry: sketching profiles, creating features and adjusting positions. The reviewer's words: "your finger is for manipulation of the view." — [DEVELOP3D review, Al Dean, Jun 2020, updated Nov 2020](https://develop3d.com/cad/review-shapr3d-ipad-parasoild-modelling/)
- **[Fact]** Double-tapping a face with a finger snaps the view normal to that face. Tapping a face with the Pencil selects it and offers an offset. Double-tapping with the Pencil selects the whole body. — [DEVELOP3D](https://develop3d.com/cad/review-shapr3d-ipad-parasoild-modelling/)
- **[Fact]** Shapr3D's gesture cheat sheet lists a single tap, with finger or pen, to select a single part, and a long-tap-and-drag to select an area. The page itself returned 403; this comes from the search snippet. — [Shapr3D Support: Keyboard shortcuts, gestures, and hotkeys](https://support.shapr3d.com/hc/en-us/articles/7873906073884-Keyboard-shortcuts-gestures-and-hotkeys)
- **[Fact]** "Navigation presets" define how mouse, trackpad, touch or pen inputs map to orbit, pan and zoom. — [Shapr3D Support: Navigation Presets](https://support.shapr3d.com/hc/en-us/articles/7873881091356-Navigation-Presets)
- **[Fact]** On Windows, Wacom pen tablets got no touch-gesture support at the time of a community thread. — [Shapr3D Community: Touchpad and Wacom orbit/pan controls](https://discourse.shapr3d.com/t/touchpad-and-wacom-orbit-pan-controls/19884)
- **[Fact]** Version 5.10 added sketching, modelling and navigation with a touchpad, extending beyond Pencil and finger. — [Shapr3D Community: 5.10 touchpad](https://discourse.shapr3d.com/t/5-10-sketch-model-and-navigate-with-touchpad/15819)

**Smart tools, chosen by what you select**
- **[Fact]** Selecting a face shows a direction glyph: drag into the part to cut, drag out to extrude. Extrude offers a draft-angle glyph. Dimension suggestions depend on the selection: one line gives a length, two lines give a distance or angle. — [DEVELOP3D](https://develop3d.com/cad/review-shapr3d-ipad-parasoild-modelling/)
- **[Fact]** The "Adaptive User Interface" is central to Shapr3D. The user selects geometry and the app suggests suitable tools, so there is no hunting for commands. — [Shapr3D blog: Refreshing the Shapr3D UI, 24 May 2023](https://www.shapr3d.com/blog/refreshing-the-shapr3d-user-interface)

**Sketch inference and dimension entry**
- **[Fact]** Constraints (tangent, perpendicular, concentric, parallel, symmetric) are applied automatically where the system can infer them, or can be added afterwards. — [DEVELOP3D](https://develop3d.com/cad/review-shapr3d-ipad-parasoild-modelling/)
- **[Fact]** Dimensions are optional. Selecting geometry produces suggested dimensions, and formalising one with a value makes it persist through later edits. — [DEVELOP3D](https://develop3d.com/cad/review-shapr3d-ipad-parasoild-modelling/)
- **[Fact]** Splines can be CV-driven (press the Pencil down to place each point, lift to finish) or fitted, with curvature editing. — [DEVELOP3D](https://develop3d.com/cad/review-shapr3d-ipad-parasoild-modelling/)
- **[Opinion]** "You don't always get the precision and accuracy you might need." The tip given is to tap a measurement and type a value. — [Creative Bloq: best 3D modelling apps for iPad](https://www.creativebloq.com/3d/3d-software/the-best-3d-modelling-apps-for-ipad)
- **[Opinion]** The sketch dimensioning workflow "takes getting used to". — [DEVELOP3D](https://develop3d.com/cad/review-shapr3d-ipad-parasoild-modelling/)

**History-based parametric modelling**
- **[Fact]** History-based parametric modelling was announced, missed the hoped-for end-of-2023 rollout to all users, and left beta in release 5.590 (April 2024). — [Shapr3D Community: 5.590 History-Based Parametric Modeling is here](https://discourse.shapr3d.com/t/5-590-history-based-parametric-modeling-is-here/31108); [Shapr3D blog: progress update](https://www.shapr3d.com/blog/product-updates-history-based-parametric-modeling-progress); [Shapr3D 2024 recap](https://www.shapr3d.com/content-library/2024-wrapped-whats-new-in-shapr3d)
- **[Fact]** The stated design goal was that parametric modelling should interfere as little as possible with direct modelling. The two coexist, so direct edits get recorded into the history. — [Shapr3D Community: 5.590 thread](https://discourse.shapr3d.com/t/5-590-history-based-parametric-modeling-is-here/31108)
- **[Fact]** Shapr3D acknowledged longer load times caused by very long histories (500 to 1000+ steps). Version 5.620 added one-click merging of history steps, with a planned option to collapse history and drop dependencies. — [Shapr3D Community: Improvements to parametric modeling](https://discourse.shapr3d.com/t/improvements-to-parametric-modeling/31577)
- **[Fact]** Parametric expressions and variables arrived in 5.790 and 5.800 (early 2025), per the Wikipedia release table, a secondary source. — [Wikipedia: Shapr3D](https://en.wikipedia.org/wiki/Shapr3D)
- **[Opinion]** User reaction is split. One long-time user uses only the parametric version. Others, including a former Fusion user, were "a bit disappointed" with it, or found "so many new variables that are really hard to understand". — [Shapr3D Community: Feedback on history-based parametric version](https://discourse.shapr3d.com/t/feedback-on-history-based-parametric-version/30980); [5.590 thread](https://discourse.shapr3d.com/t/5-590-history-based-parametric-modeling-is-here/31108)
- **[Opinion]** An App Store reviewer said the parametric tools "were recoded and made the app more confusing". — [App Store: Shapr3D reviews (Mac)](https://apps.apple.com/us/app/shapr-3d-cad-modeling/id1091675654?see-all=reviews&platform=mac)

**Desktop port of a touch-first UI**
- **[Fact]** Early Windows builds had "the same UI as the iPadOS version" and shipped as "early access". — [engineering.com: Shapr3D available for Windows](https://www.engineering.com/?p=42922)
- **[Fact]** Shapr3D admitted that "when we launched Shapr3D on Windows and macOS we felt that our user interface was still most heavily optimized for touch". The 2023 refresh targeted "touch and stylus on tablets, and large screens with keyboard and mouse input on desktops". It also moved frequently used but hidden tools (Section view, Isolate) into the toolbar and added a Project sidebar. — [Shapr3D blog, 24 May 2023](https://www.shapr3d.com/blog/refreshing-the-shapr3d-user-interface)
- **[Fact]** The Windows product page now advertises full shortcut support, precise mouse input, SpaceMouse support and customisable hotkeys. A Windows navigation preset sits alongside "Shapr3D Classic" and other CAD presets. — [Shapr3D Windows download page](https://www.shapr3d.com/it/download/windows); [DEVELOP3D: Shapr3D for Windows launched](https://develop3d.com/cad/shapr3d-for-windows-launched/)
- **[Opinion]** One user called it "an absolute dream for pen and touch users compared to Fusion". Another complained that it "doesn't integrate into Windows very well", for example with no desktop icon. — [Shapr3D Community: doesn't integrate into Windows very well](https://discourse.shapr3d.com/t/shapr3d-doesnt-integrate-into-windows-very-well/24242)

**Praise and complaints**
- **[Opinion]** The finger/Pencil split "makes complete sense", and the iPad and Pencil interaction is "well matched to the modelling process". — [DEVELOP3D 2020](https://develop3d.com/cad/review-shapr3d-ipad-parasoild-modelling/); [DEVELOP3D Q1 2021 review](https://develop3d.com/cad/shapr3d-q1-2021-review/)
- **[Opinion]** Criticisms in 2020: no formal assemblies, a freemium tier limited to STL export on two devices, no markup tools, a better fit for concepting than production, no Android, and many third-party styluses unsupported. — [DEVELOP3D](https://develop3d.com/cad/review-shapr3d-ipad-parasoild-modelling/)
- **[Opinion]** G2 reviews (4.8/5 from about 170 reviews) praise intuitiveness. Complaints are that "subscription pricing can be a barrier for casual users", that the price is "a bit high for small DIY enthusiasts", and one says format options are "very limited" and resolution is poor. Other reviewers praise the breadth of export formats. — [G2: Shapr3D reviews](https://www.g2.com/products/Shapr3D/reviews)
- **[Opinion]** On the App Store, a hobbyist argued for about $9.99/month because the annual price is steep for people with 3D printers. The listing shows Pro at about $299.99/year or $37.99/month, which may be out of date. — [App Store listing](https://apps.apple.com/us/app/shapr-3d-cad-modeling/id1091675654)
- **[Opinion]** "The free license only lets you export very poor-quality .stl and .3mf files." This is one user's view. — [AlternativeTo: Shapr3D](https://alternativeto.net/software/shapr3d/about)
- **[Opinion]** Shapr3D is strong for architectural concept and massing work but is not a BIM replacement. — [illustrarch review](https://illustrarch.com/articles/design-softwares/93688-shapr3d-review-architects.html)
- **[Opinion]** Capterra: "remarkably simple to use", but another reviewer names that same simplicity as what they like least. — [Capterra: Shapr3D reviews](https://capterra.com/p/184498/Shapr3D/reviews/)

### Inferences
- The key pattern for Wren is to separate modalities by role (pen authors, finger navigates) and to make tools selection-driven, with on-geometry glyphs (drag direction means add or cut). Shapr3D's success suggests this beats palette-driven command entry on touch.
- "Suggested dimension from selection" fits Wren's "values inline, accept expressions" rule well. It is the touch analogue of a smart dimension tool.
- The history lessons are concrete:
  - Long timelines on tablets hurt both performance and comprehension.
  - Provide merge or collapse of steps (Wren's ADR-015 nesting is related).
  - Do not make direct edits feel penalised by history.
- The desktop-port lesson is that a touch-first UI moved unchanged to desktop was judged inadequate by the vendor itself. Desktop needs hotkeys, precise mouse input and familiar navigation presets. Wren's separate tablet shell and desktop command bar already follow this.
- UNVERIFIED (background knowledge): Shapr3D uses Pencil hover for previews on M2+ iPads, and has a scribble or handwriting route to numeric input. Not confirmed this session.

### Gaps
- Could not read the Shapr3D gesture cheat sheet (403), so the full gesture list is missing: undo gesture (believed to be a two-finger tap), Pencil double-tap and squeeze mappings, hover behaviour.
- No primary source on Shapr3D's assembly feature status in 2025–2026.
- No sourced detail on the free-tier export limits in 2025–2026 (resolution and format caps).
- No 2024–2026 Reddit threads surfaced; r/Shapr3D sentiment is not represented.

---

## 2. Onshape mobile (iOS/Android): gestures, selection, menus, capabilities, user feedback

### Takeaway
Onshape mobile is a real editing client (sketch, dimension, features, assemblies). It solves fat-finger picking with a long-press offset crosshair and a force-touch magnifier, and it has a rotation lock for sketching. Users still rate it about 3.5/5. Complaints are about selection effort, too many taps, no keyboard shortcuts, no Pencil hover highlight, and weak mouse support.

### Cited Findings
- **[Fact]** Onshape's team tried offset selection and a second-finger tap as a mouse click. Neither felt natural and both tested poorly. They chose a long press that brings up an offset crosshair cursor, which pre-highlights faces, edges and lines as the finger moves. — [Onshape blog: Under the Hood, CAD for Mobile, 19 Jun 2018](https://www.onshape.com/en/blog/under-the-hood-cad-for-mobile)
- **[Fact]** Force-touch magnifies the area under the cursor and returns to the original zoom on release. — [Onshape blog 2018](https://www.onshape.com/en/blog/under-the-hood-cad-for-mobile)
- **[Fact]** One-finger drag rotates in 3D, two-finger drag rotates in 2D, and pinch zooms. Accidental 3D rotation while sketching was a problem. The fix was an on-screen rotation lock that engages automatically during some operations and can be overridden manually. — [Onshape blog 2018](https://www.onshape.com/en/blog/under-the-hood-cad-for-mobile)
- **[Fact]** Feature, part and assembly trees, the version graph and measure tools needed space-saving layouts, with users sliding between views. Capabilities: sketching, dimensioning, features, assembly modelling, Pencil support, split-screen, release management. — [Onshape blog 2018](https://www.onshape.com/en/blog/under-the-hood-cad-for-mobile)
- **[Fact]** The iOS App Store shows 3.5/5 from 419 ratings, with the latest version 1.223.x (Oct 2026). — [App Store: Onshape 3D CAD](https://apps.apple.com/us/app/onshape-3d-cad/id923421284)
- **[Opinion]** "Selecting objects can be a pain, and selecting views takes too many inputs." Deleting mistakes is unintuitive (several steps get undone). A beginner could not find how to edit dimensions. No dark mode. — [App Store reviews](https://apps.apple.com/us/app/onshape-3d-cad/id923421284)
- **[Opinion]** "I would like to see keyboard shortcuts in the iPad app… would save some tapping with the Apple Pencil." Another reviewer said pressing "N" for normal-to-plane does nothing, so gestures are required. — [App Store reviews](https://apps.apple.com/us/app/onshape-3d-cad/id923421284); [mwm.ai mirror of reviews](https://mwm.ai/apps/onshape-3d-cad/923421284)
- **[Opinion]** "Would be amazing if the app could highlight things when the Apple Pencil is hovering over it." — [mwm.ai review mirror](https://mwm.ai/apps/onshape-3d-cad/923421284)
- **[Opinion]** A 2023 forum user found that a mouse on the iPad app gets no scroll-wheel zoom and left-drag rotates, so drag-box selection is impossible. Another user said the touch app handles box selection, zoom and pan without a mouse. — [Onshape forum: mouse with iPad app](https://forum.onshape.com/discussion/20233/how-do-i-make-a-mouse-work-properly-with-ipad-app)
- **[Opinion]** "Stylus works for selection but not a lot else" (2022). Older requests: a drag-sketch function like the web's middle mouse, and easier access to "select other". — [Onshape forum: best tablet](https://forum.onshape.com/discussion/17566/what-is-the-best-table-to-use-onshape); [Onshape forum: iPad + Apple Pencil tips](https://forum.onshape.com/discussion/5985/ipad-apple-pencil-tips-amp-usage)
- **[Opinion]** Positive: "the only [one] worth using for CAD on iPadOS"; "very accessible and very free". — [mwm.ai review mirror](https://mwm.ai/apps/onshape-3d-cad/923421284)

### Inferences
- The long-press offset crosshair plus magnifier is a proven answer to fat-finger picking. Force-touch no longer exists on current iPads, so Wren would need another trigger for the magnifier: a long-press hold, or pen hover.
- The auto-engaging rotation lock during sketching is directly applicable to Wren's finger camera gestures.
- Users want hover highlight with the Pencil. Safari exposes Pencil hover to the web (see section 5), so Wren can offer pre-selection highlight on hover. That would be a differentiator over Onshape's native app.
- Hardware keyboard shortcuts on iPad are an explicit, repeated ask. Wren as a PWA gets keyboard events for free and should keep desktop hotkeys active in the tablet shell.

### Gaps
- Android Play Store rating and reviews were not retrieved.
- Current (2025–2026) Onshape mobile gesture docs were not fetched. The 2018 blog may be partly outdated, for example the force-touch dependency.

---

## 3. Other tools: Fusion iPad, uMake, Feather, Nomad, Concepts, xDesign, newcomers

### Takeaway
- Autodesk's Fusion iPad app has always been a viewer and markup tool, not a modeller, and users think it is stagnant.
- uMake is a concept-stage, plane-based 3D sketcher.
- The pen-UX leaders are art and 3D-drawing apps (Feather, ZBrush for iPad, Procreate). They use Pencil Pro squeeze for context menus, double-tap for draw/erase toggles, hover for brush preview, and a "finger-pen" toggle.
- xDesign has a browser-based Touch Mode, but iPad support is unconfirmed.

### Cited Findings
- **[Fact]** An Autodesk moderator said the Fusion iPad app "is only meant to be a viewer and markup tool for already created models". — [Autodesk forum: Fusion 360 for iPad Pro users](https://forums.autodesk.com/t5/fusion-support-forum/fusion-360-for-ipad-pro-users/td-p/8341340)
- **[Opinion]** App Store reviewers in about 2025 said there had been no updates since January 2025 and called the app "dead now". — [App Store: Autodesk Fusion](https://apps.apple.com/us/app/autodesk-fusion/id991074843)
- **[Fact]** Autodesk's 123D apps (including the earlier touch apps) were discontinued from November 2016. — [Wikipedia: Autodesk 123D](https://en.wikipedia.org/wiki/Autodesk_123D)
- **[Fact]** uMake is a NURBS-based tool built around Apple Pencil, with drawing on construction planes. It has precision (lines, arcs, dimensions), pen (smooth curves) and freestyle modes. — [illustrarch: uMake review](https://illustrarch.com/articles/design-softwares/93831-umake-review.html); [gfxspeak: uMake brings sketch-model paradigm to iPad](https://gfxspeak.com/archives/brings-sketch-paradigm/)
- **[Opinion]** uMake is best as a concept-stage companion that feeds a main workflow rather than replacing it. — [illustrarch](https://illustrarch.com/articles/design-softwares/93831-umake-review.html); [Fabbaloo: uMake for 3D printing? We don't think so](https://www.fabbaloo.com/2015/12/umake-for-3d-printing-we-dont-think-so)
- **[Fact]** Feather's Pencil interactions:
  - Squeeze (Pencil Pro) opens a context-sensitive Squeeze Menu, and can be reassigned.
  - Double-tap toggles Draw and Erase (with the Select tool, Select and Deselect).
  - "Squeeze-drag to switch": squeezing while placing the pen on the canvas temporarily switches tool until lift.
  - Hover previews brush size and colour on the 3D guide.
  - A "Finger-Pen" toggle locks finger navigation so the next touch draws. Tap-and-hold Finger-Pen draws with another finger, and the icon is draggable.

  — [Feather support: Apple Pencil](https://support.feather.art/docs/interfaceandgestures/applepencil)
- **[Fact]** ZBrush for iPad brushes support squeeze, roll, hover and double-tap gestures plus haptics. A later update added hover tooltips on hover-capable devices. — [App Store: ZBrush](https://apps.apple.com/us/app/zbrush-3d-model-maker/id6612028716)
- **[Fact]** Procreate maps Pencil Pro squeeze to tool switching, QuickShape control, Eyedropper or Layer select, or menus. — [Procreate Handbook: Pencil](https://help.procreate.com/procreate/handbook/interface-gestures/pencil)
- **[Fact]** SOLIDWORKS xDesign runs in the browser and has a "Touch Mode" for mobile and touch devices. Touch Mode is enabled from the View tab and adds a right-hand bar for navigation with a stylus or finger. — [GoEngineer: xDesign](https://www.goengineer.com/3dexperience/3d-creator); [Javelin: Learning the xDesign interface](https://www.javelin-tech.com/blog/?p=68381)
- **[Opinion]** One student found pen design in xDesign Touch Mode in Chrome "a great experience". — [3DSwym: xDesign Touch Mode](https://3dswym.3dexperience.3ds.com/post/3dexperience-edu-students/my-experience-with-3dexperience-solidworks-and-cloud-applications-part-6-xdesign-touch-mode_rUfcXNAoRFa--MyX6WQiIw)
- **[Fact]** A community question asking whether xDesign works on iPad had no visible answer. — [3DSwym: 3DEXPERIENCE on iPad](https://3dswym.3dexperience.3ds.com/question/solidworks-news-info/3dexperience-on-ipad_Wk5gUUlbRQeD38K2BSb1Iw)

### Inferences
- The "Finger-Pen" pattern lets a finger temporarily act as a pen. It is a good fallback for users without a Pencil and for phones, and it maps cleanly onto Wren's pen/finger split.
- Squeeze-drag to switch tool temporarily is a high-value pattern, but iOS native APIs gate it and the web cannot get it (section 5). Wren needs an on-screen equivalent: a hold-modifier button under the non-dominant thumb, or a quasi-mode.
- Hover-tooltips (ZBrush) and hover-preview (Feather) are now norms on Pencil-hover iPads.
- An xDesign-style "touch mode" that just bolts a nav bar onto a desktop UI is the opposite of the Shapr3D approach. There is little evidence it is loved.

### Gaps
- **Nomad Sculpt** and **Concepts**: no specific Pencil gesture docs were retrieved this session.
- **Plasticity** tablet or iPad support: nothing found. I could not confirm that any official iPad version exists as of Nov 2026, so treat it as unknown.
- No other 2024–2026 iPad CAD newcomers were identified with sources.
- Fusion iPad: no official end-of-support notice found.

---

## 4. Recurring touch-CAD problems

### Takeaway
The best-documented pains are:
- picking precision and effort (fat finger, "select other", too many taps);
- accidental orbit while sketching;
- precise value entry;
- missing keyboard shortcuts and poor mouse support on iPad;
- hover pre-highlight being wanted but absent.

Evidence was thin for palm rejection, undo-gesture discoverability, Stage Manager, and phone-size layouts specifically in CAD.

### Cited Findings
- **[Fact/Opinion]** Fat-finger selection was the first problem Onshape tackled. Offset selection and two-finger "click" both failed testing, and a long-press offset crosshair won. — [Onshape blog 2018](https://www.onshape.com/en/blog/under-the-hood-cad-for-mobile)
- **[Opinion]** Selection is still "a pain" with "too many inputs". — [App Store: Onshape](https://apps.apple.com/us/app/onshape-3d-cad/id923421284)
- **[Fact]** Accidental 3D rotation during sketching was a known problem, solved with an auto-engaging rotation lock. — [Onshape blog 2018](https://www.onshape.com/en/blog/under-the-hood-cad-for-mobile)
- **[Opinion]** On precise values, Shapr3D "doesn't always" give the precision needed, and the workaround is tap-and-type. — [Creative Bloq](https://www.creativebloq.com/3d/3d-software/the-best-3d-modelling-apps-for-ipad)
- **[Opinion]** Users ask for iPad hardware keyboard shortcuts and report that desktop shortcuts such as "N" do nothing. — [App Store: Onshape](https://apps.apple.com/us/app/onshape-3d-cad/id923421284); [mwm.ai](https://mwm.ai/apps/onshape-3d-cad/923421284)
- **[Opinion]** A mouse on the Onshape iPad app has no scroll zoom and no box-select. — [Onshape forum](https://forum.onshape.com/discussion/20233/how-do-i-make-a-mouse-work-properly-with-ipad-app)
- **[Fact]** Shapr3D added trackpad sketching, modelling and navigation (5.10) and navigation presets per input device, a response to keyboard and trackpad demand on iPad. — [Shapr3D Community: 5.10](https://discourse.shapr3d.com/t/5-10-sketch-model-and-navigate-with-touchpad/15819); [Navigation Presets](https://support.shapr3d.com/hc/en-us/articles/7873881091356-Navigation-Presets)
- **[Opinion]** Users want hover highlight with the Pencil. — [mwm.ai Onshape review mirror](https://mwm.ai/apps/onshape-3d-cad/923421284)
- **[Fact]** Hiding frequently used tools hurt discoverability: Shapr3D moved Section view and Isolate out of hidden places into the toolbar in 2023. — [Shapr3D blog 2023](https://www.shapr3d.com/blog/refreshing-the-shapr3d-user-interface)
- **[Fact]** Third-party styluses are often unsupported (no pressure or pen identification), as is Android for Shapr3D. — [DEVELOP3D](https://develop3d.com/cad/review-shapr3d-ipad-parasoild-modelling/)
- **[Fact]** A developer research issue treats Pencil hover and real pressure and tilt values as things that "must remain hardware tests". It marks Pencil versus Touch Event ordering in WKWebView as unverified, a reminder that simulators don't cover pen input. — [GitHub: handwriting-natively #130](https://github.com/MarsLuay/handwriting-natively/issues/130)

### Inferences
- **Hand occlusion.** The offset crosshair, and Shapr3D's glyphs that you drag away from the geometry, both address it. Wren should place the confirm UI and value fields away from the stroke's end point, toward the non-dominant side.
- **Values without a keyboard.** Wren's inline expression fields need a touch numpad with units and operators (or iPadOS Scribble into the field), not the full OS keyboard covering half the screen.
- **Undo.** A two-finger tap (undo) and three-finger tap (redo) are the de facto iPad creative-app conventions. UNVERIFIED this session for Shapr3D specifically. Users can't discover them, so show an on-screen undo button as well. Onshape users complain that undo removes several steps, so undo granularity must match user intent.
- **Palm rejection.** On the web, the main tool is to ignore `pointerType: "touch"` contacts while a pen pointer is active or was recently active. There is no OS-level palm flag on the web. This is UNVERIFIED as best practice; it needs device tests.
- **Stage Manager and multitasking.** Wren's layout must reflow at arbitrary window sizes, so breakpoints must not assume full-screen iPad. No CAD-specific user feedback was found.

### Gaps
- No sourced CAD-specific user feedback on palm rejection failures, Stage Manager, Slide Over or Split View, or phone-sized CAD UIs.
- No sourced undo-gesture inventory for Shapr3D (cheat-sheet page was 403).
- No quantitative data (error rates, target sizes) for touch picking in CAD.

---

## 5. Apple HIG guidance and what a PWA can access (pointer events, pen, pressure, tilt, hover; iOS Safari limits)

### Takeaway
- Safari has supported Pointer Events with `pointerType: "pen"`, pressure and tilt since Safari 13.
- Since Safari 16.1 on M2+ iPad Pro, it exposes Apple Pencil **hover** to web pages (up to about 12 mm). Tilt and azimuth during hover came in iPadOS 16.4.
- Pencil Pro **squeeze** and **double-tap** have no web API. An Apple Developer Forums question asking for them (2024) remains unanswered.
- Barrel-roll is a native-only API (`UITouch.rollAngle`); no web equivalent was found.

### Cited Findings
- **[Fact]** Safari 16.1 headline feature: "Hover on iPadOS with Apple Pencil". "The new iPad Pro supports hover with Apple Pencil… users see hover states for links, animations, and more". The post advises feature detection over device detection. — [WebKit: Features in Safari 16.1](https://webkit.org/blog/13399/webkit-features-in-safari-16-1/)
- **[Fact]** Pencil hover detection range is up to 12 mm from the display (secondary press coverage). — [MacRumors: Safari 16.1](https://www.macrumors.com/2022/10/24/apple-safari-16-1-launch/); [iMore](https://www.imore.com/mac/safari-161-adds-support-for-passkeys-apple-pencil-hover-and-more)
- **[Fact]** iPadOS 16.4 added tilt and azimuth during Pencil hover. — [AppleInsider, 27 Mar 2023](https://appleinsider.com/articles/23/03/27/apple-executives-detail-apple-pencil-hover-update)
- **[Fact]** Safari 13 shipped Pointer Events covering Apple Pencil. Developers distinguish pen with `pointerType`, and use `pressure`, `tiltX` and `tiltY`. — [DEV: Pointer Events API](https://dev.to/pfacklam/consistent-access-to-browser-events-with-pointer-events-api-5gh4)
- **[Fact]** Under Pointer Events semantics, a hovering pen reports pressure 0. — [Carlos Rojas: Complete Guide to Pointer Events](https://blog.carlosrojas.dev/the-complete-guide-to-pointer-events-21e44b2f9da0?gi=e0f6f54977b9)
- **[Fact]** Historically, iOS 10.3 Safari first exposed tilt and distinguished stylus from touch through Touch Events (`touchType`). Before that, Pencil was indistinguishable from a finger. — [Patrick H. Lauke, "Getting touchy"](https://patrickhlauke.github.io/getting-touchy-presentation/)
- **[Fact]** A developer asked in July 2024 whether Mobile Safari exposes Pencil Pro hover and squeeze. In October 2024 another developer asked the same. There was no answer from Apple and none accepted. — [Apple Developer Forums thread 760238](https://developer.apple.com/forums/thread/760238)
- **[Fact]** WebKit continues shipping pointer-related changes in Safari 26.x (26.2 and 26.4 posts surfaced in search; contents not read). — [WebKit: Safari 26.2](https://webkit.org/blog/17640/webkit-features-for-safari-26-2/); [WebKit: Safari 26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/)
- **[Fact]** Apple's HIG has an "Apple Pencil and Scribble" page. Its body could not be extracted this session. — [Apple HIG: Apple Pencil and Scribble](https://developer.apple.com/design/human-interface-guidelines/apple-pencil-and-scribble)

### Inferences
- **What Wren can use on iPad Safari:**
  - `pointerType === "pen"`;
  - `pressure`, `tiltX`, `tiltY` (and `altitudeAngle`/`azimuthAngle` where present);
  - hover through `pointermove` and `pointerover` with no buttons and pressure 0, on hover-capable iPads;
  - `getCoalescedEvents()` for smooth strokes. UNVERIFIED on Safari; check support.
  - `touch-action: none` on the canvas, to stop browser gestures from stealing input.
- **What Wren cannot use:**
  - Pencil double-tap and Pencil Pro squeeze: no web events found.
  - Barrel roll: `UITouch.rollAngle` is native only, and no evidence was found that `twist` is populated by Safari.
  - Haptics on Pencil Pro.
  - The system tool palette (`UIToolPicker`).

  Native wrappers (Capacitor or WKWebView) could bridge these via `UIPencilInteraction`, but a pure PWA cannot.
- UNVERIFIED (background knowledge, not fetched): Apple's HIG says to honour the user's system-wide preferred double-tap action, not to require Pencil for core tasks, and to offer hover previews that don't change state. Its pointer guidance covers pointer shape adaptation, hover effects and magnetism toward controls. The writer should treat these as unconfirmed until the HIG is read directly.

### Gaps
- Exact HIG wording on Pencil, hover, squeeze, double-tap and iPad pointer interactions could not be retrieved.
- Whether Safari populates the `twist` property (barrel roll) on Pencil Pro is unconfirmed.
- No WebKit statement exists on squeeze or double-tap for the web. Their absence is inferred from the unanswered forum thread and from no WebKit announcement.
- Whether a home-screen PWA on iPadOS behaves differently from Safari tabs for pointer events was not researched.

---

## 6. Academic and industry HCI work (about 2015–2026) on pen CAD sketching, gesture recognition and touch 3D navigation

### Takeaway
The literature is rich on pen and touch 3D sketching, but this session found little recent (2020–2026) work that evaluates pen-plus-touch navigation for parametric CAD specifically. This is a gap the writer should flag.

### Cited Findings
- **[Fact]** Bi-3D (UIST 2021) combines touch gestures with 2D pen commands for 3D manipulation. It was evaluated against widget and mid-air baselines on object-movement tasks. — [UIST 2021 proceedings TOC](https://uist.acm.org/uist2021/toc.html)
- **[Fact]** A UIST 2023 system for drawing cars in perspective uses a set of pen and touch interactions for 3D curve sketching, tested in a pilot study. — [KAIST: Interactive System for Drawing Cars in Perspective (UIST 2023)](http://i2dea.kaist.ac.kr/pdf/publications/2023_uist_drawing_cars.pdf)
- **[Fact]** SketchingWithHands (UIST 2016) notes that "without efficient navigation, 3D sketching does not work". — [KAIST: SketchingWithHands](https://sketch.kaist.ac.kr/pdf/publications/2016_uist_sketchingwithhands.pdf)
- **[Fact]** ILoveSketch (UIST 2008, outside the date window but foundational) is an "as-natural-as-possible" pen sketching system for 3D curves with gesture commands. — [ILoveSketch](https://www.dgp.toronto.edu/~ravin/papers/uist2008_ilovesketch.pdf)
- **[Fact]** RealitySketch (UIST 2020) covers dynamic sketching of responsive graphics in AR. It is tangential: parametric binding of sketched elements. — [arXiv 2008.08688](https://arxiv.org/pdf/2008.08688)
- **[Fact]** Patents and research also exist on inferring 3D CAD from 2D touch sketches. "Method for inferring a 3D geometry onto a 2D sketch" runs inference after each stroke, on release of the touch. It references EP3958162A1. — [USPTO 12694633 PDF](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12694633)
- **[Fact]** "Forming a dataset for inference of solid CAD features" includes touch-drawn strokes as input. — [USPTO 11514214 PDF](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11514214)

### Inferences
- The recurring research conclusion (SketchingWithHands, Bi-3D) is that pen authoring needs a fast secondary channel for navigation, typically touch from the non-dominant hand. This is the same split Shapr3D commercialised.
- UNVERIFIED background: Hinckley et al. "Pen + Touch = New Tools" (UIST 2010) is the canonical source for "pen writes, touch manipulates" and for touch-modified pen quasi-modes. The writer may cite it only after checking.

### Gaps
- No CHI or UIST 2020–2026 study was found that directly measures touch versus pen versus mouse picking error, or navigation performance, in parametric CAD.
- No Computer-Aided Design journal (Elsevier) papers on tablet CAD UX were retrieved.
- Primitive-recognition benchmarks (for example $-family recognisers, or sketch beautification such as Fluid Sketches or later neural approaches) were not researched this session.

---

## 7. Patents and trademarks around touch-CAD gestures and Shapr3D's interaction model

### Takeaway
No Shapr3D-assigned patent on its sketch, inference or gesture UI was found in this session's searches. That is absence of evidence, not clearance. Shapr3D does hold trademarks (including a 2025 "SHAPER3D" application). Sketch-to-3D inference patents exist whose assignee was not shown. 3D-geometry-inference-from-sketch patent families (EP3958162A1 lineage) belong to others and look like Dassault Systèmes, but that is unconfirmed. A freedom-to-operate check by counsel is needed.

### Cited Findings
- **[Fact]** A search for Google Patents results with Shapr3D as assignee returned none. The legal entities to search are "Shapr3D Zrt." (Shapr3D Zártkörűen Működő Részvénytársaság) and "Shapr3D UK Limited". — [Shapr3D Terms (operating entity)](https://www.shapr3d.com/terms-and-conditions-nov-3-15); [Justia Trademarks: SHAPER3D, serial 99179250](https://trademarks.justia.com/991/79/shaper3d-99179250.html)
- **[Fact]** A trademark application for "SHAPER3D" (serial 99179250, about May 2025) is owned by Shapr3D Zártkörűen Működő Részvénytársaság. — [Justia Trademarks](https://trademarks.justia.com/991/79/shaper3d-99179250.html)
- **[Fact]** Sketch-to-3D inference patents exist:
  - USPTO 12694633, "Method for inferring a 3D geometry onto a 2D sketch", with per-stroke inference on touch release, citing EP3958162A1.
  - USPTO 11514214, "Forming a dataset for inference of solid CAD features".

  The assignees were not shown in the retrieved PDFs. — [USPTO 12694633](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12694633); [USPTO 11514214](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11514214)
- **[Fact]** A Justia search surfaced only similarly named, unrelated assignees (Technologies Shapeshift 3D, Shapetrace, Sharper Shape Oy). — [Justia: Technologies Shapeshift 3D](https://patents.justia.com/assignee/technologies-shapeshift-3d-inc)

### Inferences
- Wren's risk areas are:
  - ML-based sketch-to-3D-feature inference (covered by the patents above, likely owned by a large CAD vendor);
  - any copying of Shapr3D's trade dress or names: "Adaptive UI", the Shapr3D marks, distinctive glyph visuals.
- Generic patterns (finger navigates and pen draws, long-press offset cursor, pinch zoom, rotation lock) have extensive prior art: Onshape 2018 blog, Hinckley 2010 (unverified), UIST literature. These seem low risk, but this is not legal advice.
- Avoid the word "Shapr" and Shapr3D's product names in Wren's UI and marketing.

### Gaps
- A Google Patents or Espacenet assignee query for "Shapr3D" was not executed directly (the search engine returned no patents pages). A manual check of Google Patents assignee "Shapr3D Zrt", Espacenet and HIPO (Hungarian office) is needed.
- Assignees of USPTO 12694633 and 11514214 are unconfirmed.
- Apple's patents on Pencil hover, squeeze UI, or touch gesture recognisers were not researched. They are mostly relevant to OS implementers, not apps.
