# Cloud-era parametric CAD UX: Autodesk Fusion and PTC Onshape (user feedback, praised mechanisms, browser lessons)

Scope note: research run 2026-11-09. Autodesk forum pages (forums.autodesk.com) and the 3Dconnexion forum returned HTTP 403 to direct fetch; claims from those sites come from search-result snippets and are marked "(snippet)". Treat snippet-only claims as lower confidence than fully fetched pages. "Fact" = documented by vendor docs/release notes; "Opinion" = user or reviewer sentiment. Items dated before 2020 are marked HISTORICAL.

Trademarks referenced (avoid in Wren UI copy/branding): Autodesk(R), Fusion(R)/Fusion 360(R), Onshape(R), PTC(R), FeatureScript (Onshape language name), SOLIDWORKS(R), Creo(R), 3Dconnexion(R), SpaceMouse(R), CadMouse(R), 3DxWare(R), Apple Pencil(R), iPad(R). Use generic terms ("radial menu", "history bar", "6-DoF navigator", "branch/merge").

## Fusion complaints (timeline, components/bodies, toolbar churn, performance, cloud/offline, updates, data panel, sketch, selection, errors, licensing)

### Takeaway
The dominant Fusion complaints are a fragile, hard-to-debug timeline (circular-dependency and "constraints removed" warnings without enough provenance), crashes and RAM bloat on long histories, a hard 14-day offline cap with a clumsy offline data panel, and UI churn (toolbar redesigns) that users felt fixed non-problems while bugs stayed open. The 2020 personal-use licence cut to 10 active documents permanently coloured hobbyist perception.

### Cited Findings
- Timeline fragility (Opinion): a forum thread titled "Timeline is frustrating, unintuitive and at times unusable" describes Fusion repeatedly reporting a circular dependency the user could not trace (snippet) — [Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/timeline-is-frustrating-unintuitive-and-at-times-unusable/td-p/11869353)
- Error messaging (Opinion): users say the timeline warning "Constraints were removed" is "not enough information to trace back what I may have broken" (snippet) — [Autodesk forum search summary, same thread](https://forums.autodesk.com/t5/fusion-support-forum/timeline-is-frustrating-unintuitive-and-at-times-unusable/td-p/11869353)
- Crashes tied to broken timelines (Opinion): "Long list of bugs/issues" thread reports Fusion "crashes at least once every time I use it, usually when dealing with a broken timeline or when the pc does a display change"; performance also suffers even with the history marker placed before broken features; poster asks Autodesk to "fix ALL the bugs, inconsistencies, oversights, and obvious omissions in features before introducing new features" (snippet) — [Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/long-list-of-bugs-issues/m-p/13161340/highlight/true); [follow-up](https://forums.autodesk.com/t5/fusion-support-forum/long-list-of-bugs-issues/m-p/13228789)
- Memory on long histories (Opinion): a user reports Fusion "constantly eating 32GB of RAM just to stay open" with "a huge history timeline", and editing features randomly crashing the design (snippet) — [Autodesk forum "Why is Fusion 360 such junk?"](https://forums.autodesk.com/t5/fusion-support-forum/why-is-fusion-360-such-junk/m-p/13409042)
- Update regressions (Opinion): Reddit (mirror snapshots, 2026) report sketching/transform broken after an update and sketches created on the wrong plane even when selecting an origin plane, breaking projection workflows — [r/Fusion360 snapshot](https://reddit.sentinel-team.org/subreddits/Fusion360/snapshots/2026-02-06T16%3A31%3A17.269192Z); [snapshot](https://reddit.sentinel-team.org/posts/1qkrhpz/snapshots/2026-01-24T05%3A01%3A14.105878Z) (mirror site; dates and wording unverified)
- Offline cap (Fact): Fusion allows offline work for up to two weeks, after which it must sync online "so that you can stay on the latest version" — [Autodesk help: Work offline in Fusion](https://help.autodesk.com/cloudhelp/ENU/Fusion-Designs/files/ASM-FUSION-OFFLINE-MODE.htm); lockout error article — [Autodesk support](https://autodesk.com/support/technical/article/Error-You-have-been-working-in-offline-mode-for-more-than-the-allowed-period-of-2-weeks)
- Offline complaints (Opinion): a user without internet was sent to the login screen after a few days; Autodesk replied this is intended behaviour (snippet) — [Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/offline-mode-not-working-reverts-to-sign-in-within-2-week-period/td-p/10512167); a user would adopt Fusion "if it had a REAL offline mode" — [IdeaStation "Real offline mode"](https://forums.autodesk.com/t5/fusion-360-ideastation-archived/real-offline-mode/idi-p/8008047) (HISTORICAL, 2018)
- Data panel offline (Fact + Opinion): moving and renaming files is unavailable offline; Autodesk staff acknowledged the "data panel experience when offline is a bit of a pain"; users report being shut out without a cached copy (snippet) — [Autodesk Feedback Hub thread, 2020](https://forums.autodesk.com/t5/fusion-360-feedback-hub/closed-what-s-your-experience-working-in-the-cloud-vs-offline/m-p/9780129)
- Outage mode (Fact): Fusion has a forced "temporarily in offline mode due to an unexpected outage" state — [Autodesk forum, 2024](https://forums.autodesk.com/t5/fusion-support-forum/quot-fusion-is-temporarily-in-offline-mode-due-to-an-unexpected/m-p/12657432); [Autodesk support: stuck in offline mode](https://autodesk.com/support/technical/article/Fusion-360-is-stuck-in-offline-mode)
- Toolbar redesign (Fact): Autodesk's "UI modernization" changed the blue top bar (which users said was distracting and made Fusion look "top heavy") to a neutral toolbar, fixed the "toolbar disappearing" bug, and changed contextual-tab highlighting; Autodesk said it was "inundated" with layout proposals and that sketch constraints had become hard to reach and lost contextual behaviour — [Autodesk blog: UI modernization update](https://www.autodesk.com/products/fusion-360/blog/ui-modernization-update/); [Autodesk blog: fresh new look](https://www.autodesk.com/products/fusion-360/blog/fusion-360-fresh-new-look/)
- Toolbar churn backlash (Opinion): users asked the team to focus on bug fixes rather than "redesigning stuff that wasnt even broken"; the "use old toolbar UI" preference was only temporary; complaints that new icons were inconsistent between sketch and timeline — [IdeaStation "New UI hard to read"](https://forums.autodesk.com/t5/fusion-360-ideastation-archived/new-ui-hard-to-read/idc-p/8974418) (HISTORICAL, 2019)
- Licence changes (Fact): personal-use changes took effect 1 Oct 2020, limiting users to 10 active (editable) documents from 19 Jan 2021; other documents become read-only/inactive; STEP export, initially to be removed, was reinstated after backlash — [Autodesk support: Fusion free licence changes](https://autodesk.com/support/technical/article/Fusion-360-Free-License-Changes); [Hackaday 2020](https://hackaday.com/2020/09/16/autodesk-announces-major-changes-to-fusion-360-personal-use-license-terms/comment-page-2); [Fabbaloo: reactions and retreat](https://fabbaloo.com/?p=194461)
- Licence perception (Opinion): hobbyist community threads framed it as bait-and-switch — [Autodesk forum "Please Autodesk don't limit the personal licenses"](https://forums.autodesk.com/t5/fusion-support-forum/please-autodesk-don-t-limit-the-personal-licenses/td-p/9750422); [Maslow CNC forum](https://forums.maslowcnc.com/t/new-limitations-on-fusion-360-for-personal-use/14685)
- Personal tier also lacks collaboration and native translation (AnyCAD) per forum reply (snippet) — [Autodesk forum](https://forums.autodesk.com/t5/fusion-design-validate-document/shared-project-no-longer-editable-basic-access-issue/m-p/9144509)
- A claimed January 2024 tightening of the 10-document limit appears only on a third-party site and is unverified — [cad-kenkyujo](https://cad-kenkyujo.com/en/3dcad/fusion/free/)

### Inferences
- Wren's "never silently guess a topological reference; unresolved = needs attention" rule directly targets the most-cited Fusion pain. Error UX should name the broken reference, the upstream feature that changed, and offer a repair action, not a generic "constraints removed".
- Long-history performance (RAM, rollback cost) is a key risk; Wren needs incremental regeneration and memory budgets per history length.
- Offline-first with no time-bomb is a clear differentiator versus Fusion's 14-day cap; file operations (rename/move) must work offline too.
- UI churn breeds resentment when bugs remain; ship layout changes behind opt-in with persistent (not temporary) fallback, and keep command locations stable.
- Free-tier rug-pulls are remembered for years; Wren being free/OSS should state its permanence explicitly.

### Gaps
- Could not fetch Autodesk forum pages (403); IdeaStation top-voted idea list and vote counts not obtained.
- No primary source collected for component vs body confusion, selection-filter complaints, or sketch performance on large sketches specifically (widely discussed but not captured this session).
- No sourced data on data panel UX beyond offline.

## Fusion praise (marking menu, S-key toolbox, manipulators, Press Pull, timeline rollback, Form/T-splines, browser, history toggle, shortcuts, CAM)

### Takeaway
Fusion's most praised input mechanisms are the right-click marking menu (context-specific radial, with "Repeat last command" and flick gestures) and the customisable, searchable S-key toolbox; users still ask for a keyboard-bound repeat. Integrated CAM and an approachable UI are recurring reasons people pick Fusion over Onshape.

### Cited Findings
- Marking menu (Fact): right-clicking the canvas opens a radial marking menu around the pointer; in Design the defaults are Repeat (last command), Delete, Press Pull, Undo, Redo, Move/Copy, Hole, Sketch; contents change per workspace, toolbar tab, contextual environment and active command — [Autodesk help: Marking menu reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-GetStarted/files/GUID-6514ABC1-CB75-4F0B-AB0E-316FAD36BA93.htm); [Autodesk blog: Quick tip marking menu](https://www.autodesk.com/products/fusion-360/blog/quick-tip-marking-menu/)
- Flick gestures (Fact + Opinion): gestures (press-drag-release in a direction without waiting for the menu) work for any command in the radial; users commonly flick up for Repeat (snippet) — [Autodesk forum "Does anyone actually use RMB gestures?"](https://forums.autodesk.com/t5/fusion-design-validate-document/does-anyone-actually-use-rmb-gestures-just-curious/m-p/7581781/highlight/true) (HISTORICAL, 2017); [cadforum.cz gestures tip](https://www.cadforum.cz/cadforum_en/using-gestures-in-inventor-and-fusion-360-tip10539)
- Repeat not key-bindable (Fact per community manager, Opinion re speed): no way to bind Space/Enter to "repeat last command"; request notes "the mouse gesture is inherently slower than being able to have it key-bound" (snippet) — [Autodesk forum](https://forums.autodesk.com/t5/fusion-design-validate-document/how-to-make-fusion-repeat-last-command-with-space-or-enter-key/m-p/10109414) (2021); [IdeaStation "Last command"](https://forums.autodesk.com/t5/fusion-360-ideastation-archived/last-command/idc-p/8192407/highlight/true)
- S-key toolbox (Fact + Opinion): pressing S opens a workspace-specific toolbox with search; tools can be added/removed; one user says they use it "almost exclusively" — [Noble Desktop: Efficient Tool Access in Fusion 360](https://nobledesktop.com/learn/cad/efficient-tool-access-in-fusion-360-marking-menu-toolbox-and-customization)
- Positioning (Opinion): reviewers describe Fusion as a conventional desktop UI with integrated manufacturing (CAM) features; Onshape favoured for collaboration — [All3DP: Onshape vs Fusion 360](https://all3dp.com/2/fusion-360-vs-onshape-differences/); [Tristar 2023](https://www.tristar.com/blog/onshape-vs-fusion-360/); [mfgrobots](https://www.mfgrobots.com/Article/mfg/3dprinting/49047.html)

### Inferences
- Wren should offer a context-sensitive radial menu with a fixed "repeat last" slot AND a keyboard repeat (Space/Enter); users explicitly want both.
- A searchable, user-pinnable command palette (S-key analogue) is high-value and cheap.
- Marking-menu IP: see patents below; Wren should design its radial independently (e.g. avoid the exact radial+linear hybrid claim) and get counsel if copying closely.

### Gaps
- No sources collected this session for drag manipulators/inline value entry, Press Pull praise, timeline rollback praise, Form/T-spline praise, browser visibility toggles, "Capture design history" toggle, or CAM praise beyond reviewer summaries.

### Patents (marking menu)
- US 8,832,597 "Method and apparatus for producing, controlling and displaying menus" (Kurtenbach; assigned Autodesk), filed 3 Jul 2003, granted 9 Sep 2014; claims a menu combining a radial marking-menu portion with a linear menu portion — [uspto.report](https://uspto.report/patent/grant/8832597); [9235.net](https://www.9235.net/patent/US8832597B2.html)
- Earlier Alias|Wavefront/SGI marking-menu filings exist (approx. 1990s); expiry status not confirmed — [Canadian patent 2151556](https://brevets-patents.ic.gc.ca/opic-cipo/cpd/eng/patent/2151556/summary.html); [Blender Artists thread asking about expiry](https://blenderartists.org/t/when-will-marking-menu-patent-expire/618541)
- Inference (not legal advice): a 2003 filing would nominally expire ~July 2023 (20 years from filing) subject to term adjustment; the granted term may extend due to PTA given the 11-year prosecution. Verify on USPTO Patent Center before relying.

## Onshape complaints (tabs/feature list, internet dependence, mate connectors, large-model performance, mobile limits, pricing/public docs, SolidWorks learning curve)

### Takeaway
Onshape's documented complaints are internet/browser dependence (keyboard and right-click events captured by the browser or OS), a fiddly feature list, free plan restricted to public documents since 2016, and long-open top-voted improvement requests.

### Cited Findings
- Feature-list ergonomics (Opinion): user calls the feature list "clunky": the list jumps around, causing missed clicks and misplaced drops, with dead space between items where clicks don't register — [Onshape forum "Fix-it mode for broken features"](https://forum.onshape.com/discussion/3845/fix-it-mode-for-broken-features) (HISTORICAL, ~2016)
- Broken-feature repair (Opinion): the same thread requests a dedicated "fix it mode" for broken features — [Onshape forum](https://forum.onshape.com/discussion/3845/fix-it-mode-for-broken-features)
- Voting backlog (Opinion): many top-10 open improvement requests have been listed for 2+ years — [Onshape forum "Top ten improvement request updated"](https://forum.onshape.com/discussion/10786/top-ten-improvement-request-updated); voting process — [Onshape tech tip](https://www.onshape.com/en/resource-center/tech-tips/submit-improvement-request-onshape-team)
- Free plan (Fact): since Nov 2016 the free plan has unlimited public documents but no private document creation — [Fabbaloo 2016](https://www.fabbaloo.com/2016/11/onshape-switches-up-subscription-options-unlimited-docs-pushes-for-pro); [SolidSmack](https://www.solidsmack.com/cad/onshape-switches-subscription-options-pushes-pro); 2018 tightening of terms for free users — [Fabbaloo 2018](https://www.fabbaloo.com/2018/08/onshape-tightens-licensing-for-free-users) (HISTORICAL)
- Free plan sentiment (Opinion): change made Onshape "way less attractive for a whole lot of hobbyists and makers" — [Onshape forum](https://forum.onshape.com/discussion/comment/22929) (HISTORICAL)
- Browser key capture (Fact): Onshape JS relies on the browser for key/modifier input; behaviour differs between Chrome-Windows and Chrome-macOS; sometimes the browser consumes the key before Onshape sees it — [Onshape forum "control key unavailability due to browser hijack"](https://forum.onshape.com/discussion/631/control-key-unavailability-due-to-browser-hijack)
- Cmd-S on Dvorak opened browser dialog instead of Onshape commit; Alt-Left/Right collide with browser back/forward — [Onshape forum: keyboard shortcuts conflict tag](https://forum.onshape.com/discussions/tagged/keyboard-shortcuts-conflict)
- Right-click (Opinion): Mac users report the browser context menu appearing instead of Onshape's in Chrome and Safari — [Onshape forum "right click stopped working on mac"](https://forum.onshape.com/discussion/19068/right-click-stopped-working-on-mac); right-drag rotate triggering a Chrome popup on Windows (moderator could not reproduce) — [Onshape forum](https://forum.onshape.com/discussion/7578/rotating-the-view-with-right-mouse-button-always-triggers-a-popup-in-chrome)
- Layout-dependent shortcut (Opinion): the "`" Select Other shortcut failed on Spanish and UK keyboards — [Onshape forum "select other not working"](https://forum.onshape.com/discussion/15847/select-other-not-working)
- Mouse wheel step too large (Opinion) — [Onshape forum](https://forum.onshape.com/discussion/5213/mouse-wheel-scrolls-too-much)
- CATIA-style navigation requested — [Onshape forum](https://forum.onshape.com/discussion/23562/implement-catia-style-pan-rotate-zoom-translate)

### Inferences
- Any browser CAD will hit OS/browser-reserved chords; Wren needs a remappable keymap with built-in conflict detection (Onshape added this) and should avoid Ctrl/Cmd+W/T/N/L/Tab and Alt+arrows by default.
- Use `event.code` with layout-aware display for shortcuts; never hard-code punctuation keys like "`".
- An unhelpful free tier (public-only) is a known adoption barrier; Wren's local-first OSS model avoids it.

### Gaps
- Not gathered this session: sourced complaints on Part Studio vs Assembly tab structure, mate connector learning curve, large-model performance, mobile app limitations, SolidWorks-migrant learning curve, App Store reviews of the iPad app.
- No vote counts captured for current top improvement requests.

## Onshape praise (versioning/branching, no-save, collaboration/follow, mate connectors, FeatureScript, Part Studio, configs, iPad touch UI, shortcuts, inline dims, release mgmt)

### Takeaway
Onshape's core praised mechanism is git-like data management (immutable microversions, branch/merge with feature-level conflict detection, compare) plus real-time collaboration with Follow Mode. Its iPad app was designed natively (not web) with a long-press offset "Precision Selector", a two-finger tap for the context menu, and a rotation lock to stop accidental orbiting while sketching.

### Cited Findings
- Branching/merging (Fact): branches are built on immutable microversions; Onshape detects geometric conflicts at feature level before merging and won't change conflicting features; no PDM check-in/out — [Onshape: Branching and Merging](https://onshape.com/en/features/branch-merge-cad); [Tech tip: guide to merging](https://www.onshape.com/en/resource-center/tech-tips/tech-tip-a-guide-to-successful-merging-in-onshape)
- Versions/compare (Fact): Versions and History panel updates in real time with merge lines; Compare across two moments, versions or branches — [Onshape blog: versioning workflow features](https://www.onshape.com/en/blog/versioning-workflow-features)
- Collaboration architecture (Fact) — [Onshape blog: Under the hood, how collaboration works](https://www.onshape.com/en/blog/under-the-hood-how-collaboration-works)
- Follow Mode (Fact): view synchronisation and cursor tracking so a viewer sees what the presenter sees; live comments become part of documentation — [Onshape: collaboration features](https://www.onshape.com/features/collaboration); [Onshape blog: cloud-native CAD features](https://www.onshape.com/ja/blog/cloud-native-cad-features-improve-workflows)
- Mobile architecture (Fact, 2018): native iOS/Android rather than hybrid, citing "poor WebGL support on mobile browsers"; shared C++ graphics library; WebSockets — [Onshape blog: Under the hood, CAD for mobile (19 Jun 2018)](https://www.onshape.com/en/blog/under-the-hood-cad-for-mobile) (HISTORICAL but foundational)
- Mobile selection design (Fact): offset selection and second-finger-tap-as-click were tested and rejected as unnatural; chosen design is a long-press Precision Selector (crosshair offset from finger, live pre-highlight of faces/edges); force-touch zooms under the selector and restores zoom on exit — [same post](https://www.onshape.com/en/blog/under-the-hood-cad-for-mobile)
- Accidental rotation fix (Fact): on-screen rotation lock, auto-engaged during certain operations (e.g. sketching), user-overridable — [same post](https://www.onshape.com/en/blog/under-the-hood-cad-for-mobile)
- Mobile gestures (Fact): one-finger drag = 3D rotate, two-finger drag = 2D rotate/pan, pinch = zoom; panels slide to save space; Apple Pencil, split screen, release approvals on mobile — [same post](https://www.onshape.com/en/blog/under-the-hood-cad-for-mobile)
- Three core gestures (Fact, 2019): tap-and-hold = Precision Selector; two-finger tap = context menu (right-click equivalent); double-tap = clear selection — [Onshape tech tip: Mastering gestures on mobile](https://www.onshape.com/en/resource-center/tech-tips/tech-tip-mastering-gestures-mobile)
- Pencil "Force Zoom" for precision on iPad Pro — [Onshape blog (DE): iPad CAD](https://www.onshape.com/de/blog/ipad-cad-enhance-productivity-and-creativity)
- User experience (Opinion): one user said designing on mobile "feels more like sculpting than CAD in some ways" — [Onshape forum: designing on Onshape mobile](https://forum.onshape.com/discussion/29514/designing-on-onshape-mobile-our-experience-air-engine-tutorial-series)
- Customisable shortcuts with conflict flags (Fact): users can remap in Preferences; the UI flags "browser shortcut conflict" when a binding matches a browser/OS action — [Onshape help: Keyboard shortcuts](https://cad.onshape.com/help/Content/Home/keyboard_shortcuts_and_hotkeys.htm); [Tech tip: customizing keyboard shortcuts](https://www.onshape.com/en/resource-center/tech-tips/customizing-keyboard-shortcuts)

### Inferences
- Wren should borrow the shape of Onshape's mobile selection design (long-press offset reticle with pre-highlight, two-finger tap for the context menu, auto rotation-lock while sketching) since Onshape's own testing rejected the alternatives.
- With Pencil, Wren can treat pen = precise select/draw and fingers = navigate, removing the need for an offset reticle when a pen is used.
- Branch/merge with feature-level conflict detection is a strong pattern for a local-first app (CRDT/oplog); consider whether Onshape's patents cover it (see Gaps).

### Gaps
- Not sourced this session: FeatureScript, variable studios/configurations, implicit mate connectors, multi-part Part Studio praise, inline dimension editing, Sketch-on-face flow, Release Management UX details.
- Onshape/PTC patents on cloud-native data model or microversions not searched; must be checked before Wren implements branch/merge.

## Low-level input efficiency (coordinator addition): right-click, middle-click, view presets, zoom-to-cursor, double-click, pre-highlight, box selection, occluded selection, trackpad

### Takeaway
Both tools converge on context-sensitive right-click menus and quick search palettes. Onshape ships view-manipulation presets mimicking SolidWorks, NX, Creo and AutoCAD, documented box semantics (left-to-right = window/enclosed, right-to-left = crossing), and a "Select Other" list for occluded entities (` shortcut). Browser apps must actively suppress the native context menu and handle layout-specific keys.

### Cited Findings
- Onshape view presets (Fact): rotate/pan/zoom can be set to match SOLIDWORKS, NX, Creo or AutoCAD via Preferences > View manipulation/Mouse controls — [Onshape tech tip: changing rotate, pan and zoom](https://onshape.com/en/resource-center/tech-tips/tech-tip-changing-rotate-pan-and-zoom); [Onshape help: view navigation and view cube](https://cad.onshape.com/help/Content/View/view_navigation_and_the_view_cube.htm)
- Default Onshape scheme doesn't support middle-drag zoom; other presets do (snippet) — [Onshape forum](https://forum.onshape.com/discussion/comment/27035)
- SOLIDWORKS-style mapping reference: wheel zoom, Shift+MMB zoom, Ctrl+MMB pan, MMB rotate — [Vention docs](https://docs.vention.io/docs/changing-machinebuilder-navigation-controls); Creo mapping per 3Dconnexion: Ctrl+LMB pan, wheel or Ctrl+RMB zoom, Ctrl+MMB rotate (sources disagree) — [3Dconnexion Onshape page](https://3dconnexion.com/us/applications/ptc-onshape/learn-more/)
- Zoom-to-cursor: Creo zooms around model centre by default and users find it confusing — [PTC community](https://community.ptc.com/3d-part-assembly-design-327/zoom-in-out-center-focus-point-how-to-change-it-s-location-to-cursor-creo-parametric-7-0-3-0-158895); 3Dconnexion's CadMouse QuickZoom zooms toward the cursor in Onshape — [3Dconnexion Onshape page](https://3dconnexion.com/us/applications/ptc-onshape/learn-more/)
- Box select semantics (Fact): left-to-right box selects only fully enclosed entities; right-to-left selects anything touched — [Onshape help: selection](https://cad.onshape.com/help/Content/selection.htm?Highlight=box+select)
- Box selection may pick items behind surfaces (Opinion; test before relying) — [Onshape forum: box selection](https://forum.onshape.com/discussion/175/box-selection); request to start a box over components — [Onshape forum](https://forum.onshape.com/discussion/21710/start-a-selection-box-over-components)
- Occluded selection (Fact): Select Other (right-click menu or ` key) lists all faces/edges under the cursor, from the highlighted one into the part — [Onshape help: Select Other](https://cad.onshape.com/help/Content/select-other.htm); assemblies select through transparent parts by default — [Onshape tech tip](https://www.onshape.com/en/resource-center/tech-tips/shortcuts-select-geometry-covered-assembly)
- Fusion marking menu/flick/S-key/repeat: see Fusion praise section above.

### Inferences
- Wren: ship navigation presets (Onshape-default, SolidWorks, Creo, NX, Fusion, Blender) with zoom-to-cursor ON by default; store the preset per device (trackpad vs mouse vs touch).
- Adopt the window/crossing box convention (direction-dependent) since migrating users expect it; show the box style visually (solid vs dashed).
- Provide a "select other" picker bound to both a layout-neutral key and the radial/context menu, plus a long-press on touch.
- Call `preventDefault()` on `contextmenu` over the canvas only; use pointer capture for right-drag orbit; suppress middle-click autoscroll (`auxclick`/`mousedown` button 1) on Windows.

### Gaps
- Not captured: sourced user feedback on double-click-to-edit, hover pre-highlight, and macOS trackpad gestures (pinch/two-finger orbit) for either tool.
- Onshape's full per-preset mapping table not retrieved.

## SpaceMouse / CadMouse support (coordinator addition)

### Takeaway
Onshape's browser SpaceMouse support relies on 3Dconnexion's 3DxWare driver, which supplies a browser add-in/local bridge (users hit certificate, "Local network access" and WebHID-permission problems). Native WebHID conflicts with a running 3DxWare. Fusion users report driver/SDK-version mismatches, non-customisable radial menus, and focus switching between apps.

### Cited Findings
- Driver provides a browser add-in that browser apps must explicitly use (snippet) — [3Dconnexion forum](https://forum.3dconnexion.com/viewtopic.php?p=76063)
- WebHID conflict (Opinion/developer report): with 3DxWare running, WebHID receives no input reports; options listed are WebHID or Gamepad API (snippet) — [3Dconnexion forum "Browser-based 3D app"](https://forum.3dconnexion.com/viewtopic.php?p=125693); open-source WebHID approach — [three.js forum "SpaceMouse liberated at last"](https://discourse.threejs.org/t/spacemouse-liberated-at-last/37146)
- Onshape user fixes (Opinion): enable WebHID/device permission for the site in Chrome/Edge; update 3DxWare and Chrome; enable Chrome "Local network access"; refresh; 3Dconnexion app may detect "Chrome" not "Onshape", limiting to basic pan/zoom (snippets) — [Onshape forum](https://forum.onshape.com/discussion/comment/117140); [Onshape forum](https://forum.onshape.com/discussion/comment/122651); [Onshape forum "pb with spacemouse pro"](https://forum.onshape.com/discussion/30317/pb-with-spacemouse-pro)
- Stale "3dconnexion CA (auto-generated)" cert breaks the bridge; fix = remove cert and reinstall driver (snippet) — [Onshape forum](https://forum.onshape.com/discussion/comment/127150)
- Linux: users pointed to the open-source spacenavd driver via FreeCAD wiki (snippet) — [Onshape forum](https://forum.onshape.com/discussion/15974/3d-space-mouse-use)
- Third-party Chrome extension "Linapse Browser Connector" provides 6-DoF in Onshape/SketchUp Web — [chromeboard listing](https://chromeboard.com/extension/linapse-browser-connector-bphljljooniagodmibficbocoemkpioc)
- Fusion: radial menus not customisable in Fusion even in 3DxWare 10.8.0; full support requires SDK 4+ devices; a preference toggle between legacy and new driver fixes some; a "SpaceMouse" preview feature toggle was once needed; Autodesk acknowledged active-app focus switching as known (snippets, mostly 2020–21) — [3Dconnexion forum](https://forum.3dconnexion.com/viewtopic.php?p=76874); [Autodesk KB: SpaceMouse does not orbit, pan, or zoom](https://knowledge.autodesk.com/support/fusion-360/troubleshooting/caas/sfdcarticles/sfdcarticles/3D-Connexion-SpaceMouse-does-not-orbit-pan-or-zoom-in-Fusion-360.html); [Autodesk forum "older 3D mouse stopped working"](https://forums.autodesk.com/t5/fusion-support/older-3d-mouse-stopped-working-with-fusion-update/m-p/10799782); [Autodesk forum toggle not working](https://forums.autodesk.com/t5/fusion-support/3d-connexion-space-mouse-toggle-not-working/td-p/9520913)
- Same browser-SpaceMouse problem exists in SketchUp Web — [SketchUp forum](https://forums.sketchup.com/t/spacemouse-support-in-sketchup-web/212609)

### Inferences
- Wren should support both paths: (1) WebHID direct (Chromium only; needs user gesture to grant; fails while 3DxWare holds the device), (2) 3DxWare's local bridge if licensable. Show a diagnostic panel that detects which path is live, rather than silent failure.
- Map device buttons to Wren's own commands (fit, standard views, radial menu, repeat last) in-app so users aren't dependent on the vendor's per-app profile detection.
- WebHID is unavailable in Safari/iPadOS; no tablet SpaceMouse path is evident.

### Gaps
- 3Dconnexion's official Onshape feature page returned 403; exact button mappings (views, radial menus, fit) for Onshape not confirmed.
- No source found on iPad/tablet SpaceMouse support for either tool.
- Licensing terms of the 3DxWare browser bridge for third-party apps unknown.

## What changed 2023–2026 and browser-specific lessons

### Takeaway
Fusion's visible change was the UI modernization (neutral toolbar, contextual tabs) amid "fix bugs first" sentiment. Onshape's 2025 change was AI Advisor moving from Learning Center beta (April 2025) to in-app (October 2025) with admin toggles. Browser lessons: key and right-click capture, layout-dependent shortcuts, device access (WebHID/permissions), and WebGL limits on mobile.

### Cited Findings
- Onshape AI Advisor (Fact): April 2025 beta in Learning Center; in-app from the 10 Oct 2025 update; built on Amazon Bedrock; PTC says it cannot access user data; Enterprise default off, admin toggle — [Onshape forum: Improvements October 10, 2025](https://forum.onshape.com/discussion/28972/improvements-to-onshape-october-10-2025); [PTC press release 2025](https://www.ptc.com/en/news/2025/ptc-announces-latest-onshape-ai-advisor-release); [DEVELOP3D](https://develop3d.com/cad/onshape-release-ai-advisor-for-real-time-guidance/); [All3DP](https://all3dp.com/6/onshape-has-added-an-in-suite-ai-helper-saving-you-the-hassle-of-switching-tabs-to-find-answers/)
- Onshape free plan reportedly gained "AI-powered customization" Oct 2026 (tracker site, unverified) — [pricingsaas](https://pricingsaas.com/companies/onshape/diffs/2026W41)
- Fusion UI modernization — [Autodesk blog](https://www.autodesk.com/products/fusion-360/blog/ui-modernization-update/); Fusion release cadence posts 2023–2024 — [May 2023 update](https://www.autodesk.com/products/fusion-360/blog/may-2023-product-update-whats-new/); [March 2024 update](https://autodesk.com/products/fusion-360/blog/march-2024-product-update-whats-new)
- Mobile WebGL (Fact, 2018): Onshape chose native mobile apps due to poor mobile-browser WebGL — [Onshape blog](https://www.onshape.com/en/blog/under-the-hood-cad-for-mobile)
- Browser shortcuts/right-click — see Onshape complaints section.

### Inferences
- In 2026 WebGL2/WebGPU on iPadOS Safari is far better than in 2018, but Onshape's reason for going native is a warning: Wren must hit its perf budgets on iPad Safari specifically, and test touch latency.
- AI assistants are being added as in-context help panels with admin off switches; if Wren adds one it should be optional and local-data-respecting.

### Gaps
- Fusion's rebrand from "Fusion 360" to "Autodesk Fusion" (believed late 2023/2024) not confirmed by a source this session.
- No sourced data on browser tab memory limits, full-screen API use, or trackpad gesture handling in Onshape.
- No 2024–2026 Onshape UI redesign specifics beyond AI Advisor gathered.
