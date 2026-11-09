# FreeCAD and Rhino 3D: user feedback on UI/UX, complaints and praised efficiency mechanisms (lessons for Wren)

Tags used: **[F]** = verifiable fact (docs, release notes, issue tracker metadata); **[O]** = user or reviewer opinion/anecdote. Research date: 2026-11-09. Several primary pages (wiki.freecad.org, which is behind Anubis bot protection) could not be fetched directly, so some FreeCAD items rely on mirrors, release pages on freecad.github.io, or secondary coverage. Each such case is noted.

## 1. FreeCAD complaints: workbenches, TNP, containers, inconsistent UI, sketcher solver, errors, navigation, learning curve

### Takeaway
FreeCAD's reputation problems come from structure more than missing features: many workbenches with overlapping tools, a long history of model breakage from topological naming (mitigated but not eliminated in 1.0), opaque solver messages that name constraint numbers, overloaded context menus, and many navigation styles. Wren shares FreeCAD's kernel and solver (OCCT + PlaneGCS), so FreeCAD's solver-message and TNP problems will show up in Wren unless the UI deliberately handles them.

### Cited Findings

**Workbench fragmentation**
- [F] The FreeCAD 1.0 coverage says the UI was updated to be "easier and closer to industry norms" and that "the overlapping workbenches were addressed" before release. — [Hackaday, FreeCAD 1.0 released (2024-11-20)](https://hackaday.com/2024/11/20/freecad-version-1-0-released)
- [F] Adding the TabBar addon to core gave FreeCAD two workbench selectors: "With the addition of TabBar to the core, we now have two Workbench selectors." The Design Working Group was pointed to as the place to decide. — [GitHub Discussion #13818, Workbench selectors](https://fr.github.com/FreeCAD/FreeCAD/discussions/13818)
- [O] One community commenter: "The whole notion of workbenches is a little against optimizing and making good ux." The same thread argues the project lacks the funding and central decision-making needed for a big overhaul. — [lemmy thread (via search)](https://lemmy.4d2.org/post/3724088/4973159)
- [O] A comparison guide says users call the learning curve the biggest hurdle, partly because each workbench has its own toolset. The source is weak: it promotes an AI CAD product. — [neural4d blog](https://blog.neural4d.com/?p=3348)
- [F] An open umbrella issue, #13479 "Consistency in what commands are placed where", now parents the context-menu clean-up (see below). This shows the core team itself sees command placement across workbenches as inconsistent. — [GitHub #13194 timeline](https://github.com/FreeCAD/FreeCAD/issues/13194)

**Topological naming problem (TNP) and the 1.0 mitigation**
- [F] FreeCAD 1.0 (Nov 2024) includes Realthunder's toponaming mitigation algorithm. The grant program funded integration work by CalligaroV and the late Brad McLean. — [Hackaday](https://hackaday.com/2024/11/20/freecad-version-1-0-released); [Libre Arts, FreeCAD 1.0](https://librearts.org/2024/11/freecad-1-0/)
- [O] Libre Arts says the many issues where deleting referenced geometry broke a model are "mostly gone now", with the caveat "It's still possible to run into issues, but it's true for any parametric CAD software to some extent." — [Libre Arts](https://librearts.org/2024/11/freecad-1-0/)
- [F] The official 1.0 release notes (zh-hant translation) say TNP is not fully solved and later versions will improve it further. — [FreeCAD wiki Release notes 1.0 (zh-hant)](https://wiki.freecad.org/Release_notes_1.0/zh-hant), as summarised by search; page not fetched directly
- [O] A Hackaday commenter (JanW) says TNP "is still far from solved!!!": in a simple test, deleting an earlier chamfer broke a later one, "the edge was renamed and can't be found anymore", and "This ultra simple operation absolutely must not destroy the part." Another commenter says SolidWorks fillets/chamfers are also "very fragile" but don't have this specific problem. Others cite best practice: chamfer and fillet last. — [Hackaday comments](https://hackaday.com/2024/11/20/freecad-version-1-0-released)
- [F] FreeCAD 1.1 (released 2026-03-24) lists "continued mitigation" of TNP but no TNP-specific UI change. — [FreeCAD 1.1 release page](https://freecad.github.io/Website/download/releases/1-1/)

**Body/Part containers and "single solid" rules**
- I found no fresh 2024–2026 sourced complaint text in this pass. See Gaps.

**Inconsistent UI, context menus, task panels and property editor**
- [F] GitHub #13194, "UI: context-menu of the tree view is too overloaded" (opened 2024-03-28 by core developer wwmayer): for a selected Part object the tree context menu has "28 top-level commands plus extra commands of some sub-menus." — [GitHub #13194](https://github.com/FreeCAD/FreeCAD/issues/13194)
  - The proposals were: remove Cut/Copy/Paste/Properties; show only commands related to the selection; show tree settings only when nothing is selected; and question Show/Hide/Toggle selectability. Another contributor suggested a top row of checkable icons, and circular (pie) or context-toolbar menus as alternatives.
  - Constraint noted by the maintainer: the top position is reserved for the default double-click command, shown in bold. Workbench-added items such as "Set color" are hard to reorder because core items are appended in sequence.
  - Status at 2026-11-07: partly implemented in wwmayer's fork (clipboard and unrelated entries removed, tree settings only with no selection). It is labelled "In Fork / Addon available" and sits in the "UI / UX Improvements" project. The broader redesign is still open.
- [F] In 1.0, the Pad and Pocket task panels were "slightly reorganized for better UI", and several Sketcher tools were merged into one with options in the task panel. — [Libre Arts](https://librearts.org/2024/11/freecad-1-0/)
- [O/F] In 1.0, changing only an object's appearance "currently requires a few extra clicks" because of the materials rework, a regression the reviewer noted. — [Libre Arts](https://librearts.org/2024/11/freecad-1-0/)
- [F] FreeCAD 1.1 consolidated "Add Property" into a single dialog and improved Expression Editor completion and VarSet input. — [FreeCAD 1.1 release page](https://freecad.github.io/Website/download/releases/1-1/)

**Sketcher solver messages and redundant/conflicting constraints**
- [F] Solver messages name constraints by index, for example "Over-constrained: (#, #, #)". Clicking the underlined text selects them, and there are separate "Select redundant" and "Select conflicting" tools. — [FreeCAD wiki, Sketcher SelectConflictingConstraints](https://wiki.freecad.org/Sketcher_SelectConflictingConstraints); [Sketcher SelectRedundantConstraints](https://wiki.freecad.org/Sketcher_SelectRedundantConstraints) (via search summary)
- [F] A developer explained that the solver "does not have a preference, so it just selects one of the redundant constraints". The flagged constraint is therefore often not the one the user just added. — [FreeCAD tracker (via search)](https://tracker.freecad.org/view.php?id=3976)
- [F] Bug and feature reports cover: a redundant constraint detected but not reported to the GUI; false redundancy when two curves are tangent by geometry but not by constraint; a request to mark partially redundant constraints with an informational note; requests to highlight conflicts in the 3D view and constraint list; and keeping solver messages readable while a conflict dialog is open. — [tracker #3434](https://tracker.freecad.org/view.php?id=3434), [#2729](https://tracker.freecad.org/view.php?id=2729), [#4538](https://tracker.freecad.org/view.php?id=4538), [#1557](https://tracker.freecad.org/view.php?id=1557) (titles via search; individual issue-to-claim mapping not verified)
- [O] A blogger got "Redundant constraints: (61)" without understanding why, and "Auto remove redundants" did not help. — [New Screwdriver, FreeCAD Notes: Midpoint (2023-09)](https://newscrewdriver.com/2023/09/07/freecad-notes-midpoint)
- [O] A Fusion 360 switcher found sketching the hardest part ("completing shapes and using support lines"). — [lemm.ee comment](https://lemm.ee/comment/7196372)

**Navigation styles**
- [F] FreeCAD offers many selectable navigation styles. In OpenInventor style the user must hold Shift or Ctrl to select, so selection is not mouse-only. Touchscreen tilt gesture is disabled by default and is enabled under Preferences → Display → Navigation. — [FreeCAD Manual: Navigating in the 3D view](https://wiki.freecad.org/Manual:Navigating_in_the_3D_View) (via search; wiki blocked for direct fetch)
- [F] The manual admits Mac users report that mouse/key combinations "do not work as expected. Unfortunately, none of the developers owns a Mac." Tracker issues record Gesture-style zoom misfiring on macOS since the Qt5 move and Gesture "doesn't work well" for some users. — [Manual](https://wiki.freecad.org/Manual:Navigating_in_the_3D_View); [tracker #4021](https://tracker.freecad.org/view.php?id=4021); [tracker #3995](https://tracker.freecad.org/view.php?id=3995)
- [O] A user complained that rotating also orbits the part, even in Gesture mode, while "most CAD apps rotate parts about their center without ANY kind of orbiting". — [tracker #3396](https://tracker.freecad.org/view.php?id=3396)
- [F] Historically, the navigation style was set per view (one view could behave differently from another). It was made global in 0.13. — [tracker #677](https://tracker.freecad.org/view.php?id=677)
- [F] FreeCAD 1.1 added "improved navigation controls, align-to-selection and visual utility tools". — [FreeCAD 1.1 release page](https://freecad.github.io/Website/download/releases/1-1/)

**"Hard to learn" reputation**
- [O] Hackaday commenter: "I could not pick it up without the tutorials". The only two non-intuitive CAD tools they had used were "CATIA and FreeCAD". Another replied: "I can't remember ever needing a Fusion 360 tutorial." — [Hackaday comments](https://hackaday.com/2024/11/20/freecad-version-1-0-released)
- [O] Another commenter: "Version 1.0 is SO much better. I actually can get useful work done." — [Hackaday comments](https://hackaday.com/2024/11/20/freecad-version-1-0-released)
- [O] Switchers from Fusion 360 report "a few weeks of study" before they could do everything they did in Fusion, and that FreeCAD is "not as polished". — [lemm.ee](https://lemm.ee/comment/7196372); [v1e forum "FreeCAD is hard"](https://forum.v1e.com/t/freecad-is-hard/52641)
- [F] The project maintains a "Migrating to FreeCAD from Fusion360" wiki page. That the project needs one is itself a signal. — [FreeCAD wiki](https://wiki.freecad.org/Migrating_to_FreeCAD_from_Fusion360)

**Preferences sprawl**
- [F] FreeCAD 1.1 added search to the Preferences editor. This is a fix for preferences sprawl (an inference about intent). — [FreeCAD 1.1 release page](https://freecad.github.io/Website/download/releases/1-1/)

### Inferences
- The sketcher's index-based solver messages ("(61)") are what people complain about. PlaneGCS diagnoses redundancy at the equation level, and the solver picks an arbitrary member of the redundant set. Wren should translate solver output into: highlight every constraint in the conflicting set, both on canvas and in the list; suggest the one most recently added as the default to remove; and never present a bare number.
- The context-menu issue gives a concrete anti-pattern to quantify against: 28 top-level items. Wren's context menus should list only selection-relevant commands, put the default action first, and keep clipboard and view settings out.
- Navigation-style choice is a symptom: FreeCAD hands users a dozen styles instead of one good default with presets. Wren should ship one default plus a small set of "emulate X" presets (described generically), and make touch/Pencil first-class instead of an opt-in tilt gesture.

### Gaps
- No 2024–2026 sourced quotes found specifically on Body/Part containers and the "single solid" rule. The rule is well known from FreeCAD docs (PartDesign Body must hold one contiguous solid), but I did not fetch a page confirming the current 1.0/1.1 wording.
- Crash frequency and error-message quality in 1.x: no quantitative source found.
- The exact list of FreeCAD 1.x navigation styles and the default style could not be verified (wiki blocked by Anubis).

## 2. FreeCAD 1.0 / 1.1 UI improvements and community UX initiatives (UX working group, Ondsel)

### Takeaway
1.0 (Nov 2024) and 1.1 (Mar 2026) moved FreeCAD towards commercial-MCAD norms: a unified Dimension tool, on-view parameters, continuous trim, built-in Assembly with Ondsel's solver, transparent previews, and drag handles on Fillet/Chamfer and Transform. The fixes came from a small community Design Working Group and from upstreamed Ondsel ES work. Ondsel itself shut down in late 2024.

### Cited Findings
- [F] **Sketcher 1.0:** On-view parameters for entering dimensions while drawing. A new Dimension tool "replaces multiple other tools to add constraints", and the M key cycles dimensioning options. New Scale, Offset, Move (with arrays), Rotate (polar), and basic Chamfer. Symmetry "can now use anything as a reference and displays a preview before you click to confirm". Continuous Trim works by press, drag over lines, release. 3-point rectangles, arc slots, B-spline tangency, and revamped geometry colours with dashed vs solid lines. — [Libre Arts](https://librearts.org/2024/11/freecad-1-0/)
- [F] **Assembly 1.0:** An integrated Assembly workbench built by the Ondsel team. The workflow is bottom-up only: insert parts as links, ground one, add joints with offsets and limits, test motion. Exploded views and BOMs are parametric and can be placed on TechDraw pages. — [Libre Arts](https://librearts.org/2024/11/freecad-1-0/); [Hackaday](https://hackaday.com/2024/11/20/freecad-version-1-0-released)
- [F] **1.0 UI:** Toolbars can be locked. — [Libre Arts Ondsel ES guide (via search)](https://librearts.org/2024/11/freecad-to-ondsel-es-look)
- [F] **FreeCAD 1.1 (2026-03-24):**
  - New Theme Editor with a token-based theme system.
  - Three-point lighting.
  - "Clarify Selection", which temporarily makes nearby geometry transparent to disambiguate picks.
  - Preferences search.
  - Status bar with shortcut hints and quick measure.
  - Transform tool overhauled with draggers, precise numeric input, alignment and snapping.
  - Part Design transparent feature previews and interactive draggers (Fillet/Chamfer).
  - Two-sided Pad; overhauled Hole task panel.
  - Assembly part-insertion tool, joint motion simulation and BOM.
  - Sketcher projection/intersection/external geometry and "make internals".
  - Construction geometry no longer limited to Part Design.
  - Better Wayland support; faster startup.
  - Sources: [FreeCAD 1.1 release page](https://freecad.github.io/Website/download/releases/1-1/); [Fabbaloo](https://www.fabbaloo.com/?p=236104); [industryinsider.eu](https://industryinsider.eu/3d-designing-and-simulation/freecad-1-1-improvements-following-the-latest-major-update/)
- [F] **Design Working Group:** Formed around Oct 2023, led by community member @obelisk79 (Joe "Obelisk" Sardos), discussing in Discord #ui-ux-themes. — [FreeCAD blog WIP Wednesday 4 Oct 2023](https://blog.freecad.org/2023/10/05/wip-wednesday-4-oct-2023/)
  - Output: "a major icons cleanup and a number of UI improvements" in FreeCAD and addons such as SheetMetal. — [Libre Arts](https://librearts.org/2024/11/freecad-1-0/)
  - Sardos had a grant to study UX design and a later one to revamp artwork and icon guidelines. — [Libre Arts](https://librearts.org/2024/11/freecad-1-0/)
  - The group publishes a design guide and design principles, and reviews proposed UI changes. — [FreeCAD design intro](https://freecad.github.io/Website/dev/design/intro/); [design principles](https://freecad.github.io/Website/dev/design/principles/)
  - Issues needing it carry a "Requires: UI/UX review" label, as on #13194. — [GitHub #13194](https://github.com/FreeCAD/FreeCAD/issues/13194)
- [F] Planned UX work after 1.0: port Realthunder's quality-of-life improvements upstream, and add a feature-preview system with transparent previews. The second item shipped in 1.1. — [Libre Arts](https://librearts.org/2024/11/freecad-1-0/); [1.1 release page](https://freecad.github.io/Website/download/releases/1-1/)
- [F] **Ondsel:**
  - Founded early 2023. Ondsel ES was a FreeCAD build with "better defaults", a fancier look and SheetMetal bundled.
  - All its changes except reloadable STEP and Assembly simulations were merged upstream into 1.0. Assembly simulation later appeared in 1.1.
  - Its PDM/Lens product "flopped" and the company wound down in Nov 2024, with no more ES releases.
  - Sources: [Libre Arts](https://librearts.org/2024/11/freecad-1-0/); [Libre Arts: make FreeCAD look like Ondsel ES](https://librearts.org/2024/11/freecad-to-ondsel-es-look); [Hackaday: The End of Ondsel](https://hackaday.com/2024/11/12/the-end-of-ondsel-and-reflecting-on-the-commercial-prospects-for-freecad)
- [F] A community "UI/UX improvement project" thread exists on the forum. — [devtalk.freecad.org](https://devtalk.freecad.org/t/community-uiux-improvement-project/59206) (not fetched)
- [F] A GitHub feature request asks for toolbars to follow "basic design principles". — [Discussion #13775](https://fr.github.com/FreeCAD/FreeCAD/discussions/13775) (not fetched)

### Inferences
- The direction of FreeCAD's fixes confirms the commercial-MCAD consensus Wren should adopt from day one:
  - one smart Dimension tool instead of many constraint-specific dimension tools;
  - on-canvas value entry;
  - drag handles plus numeric input on features;
  - transparent result previews before commit;
  - a selection-disambiguation tool;
  - searchable settings;
  - a token-based theme.
- Ondsel's story suggests "better defaults plus preference packs" moves perceived UX a long way without core rewrites. Ondsel also shows that commercial UX efforts around FreeCAD have failed on business model, not on UI.

### Gaps
- The full 1.1 release notes on wiki.freecad.org were not fetchable (Anubis). Details of the 1.1 Theme Editor, the status-bar hints, and any task-panel layout standardisation are therefore from summaries only.
- The 1.0 theme overhaul (new default stylesheets) is not confirmed in fetched sources.

## 3. FreeCAD praise: what users value

### Takeaway
Users value openness and scriptability most: every GUI action echoes Python in the console, macros record that stream, spreadsheets and expressions drive parameters, and data moves in open formats. In 1.0, praise extends to on-view sketch parameters and the unified Dimension tool.

### Cited Findings
- [F] Every toolbar action prints and executes equivalent Python in the console ("you can literally see the Python code unfold as you work"). Macros record the console stream for replay, and FreeCAD can be imported as a Python module or run headless. — [Yorik van Havre, A FreeCAD manual: Python scripting](https://yorikvanhavre.gitbooks.io/a-freecad-manual/python_scripting/a_gentle_introduction.html)
- [F] Spreadsheet cell aliases store "master values" that expressions in the model reference. CSV export keeps formulas as text. — [FreeCAD wiki: Manual Using spreadsheets](https://wiki.freecad.org/Manual:Using_spreadsheets/ro); [Spreadsheet CSV](https://wiki.freecad.org/Spreadsheet_CSV)
- [F] Broad open-format interchange (STEP, IGES, OBJ, STL, DXF, SVG, IFC, etc.). DWG is limited because LibreDWG's licence is incompatible with FreeCAD's. — [Wikipedia: FreeCAD](https://en.wikipedia.org/wiki/FreeCAD)
- [O] Switchers say FreeCAD is "extremely capable" once learned and could do everything they did in Fusion. — [lemm.ee](https://lemm.ee/comment/7196596)
- [O] Hackaday commenters praise Realthunder's branch for doing "a much better job", and 1.0 as "SO much better". — [Hackaday comments](https://hackaday.com/2024/11/20/freecad-version-1-0-released)
- [F] Ondsel's funding of approachability fixes was praised by the community. — [Libre Arts](https://librearts.org/2024/11/freecad-1-0/)

### Inferences
- An "action → script echo" console is cheap for Wren to provide (the commands are already serialisable for the worker) and is a strong learning and automation feature. A browser-native equivalent could echo a JS/TS command log.
- A named-parameters table with units should be first-class, not a separate workbench object.

### Gaps
- No direct 2024–2026 user quotes found praising the constraint visualisation colours in the sketcher specifically. 1.0 revamped the colours (dashed vs solid), but praise is not documented.

## 4. Rhino complaints: command line for beginners, lack of parametric history, layers, Mac vs Windows, Rhino 8 UI

### Takeaway
Rhino's command-centric design divides users. Complaints focus on the Mac/Windows command-line split (only being unified in the Rhino 9 WIP/BETA), the limits of non-Grasshopper history, the right-click-repeats-last-command behaviour surprising newcomers, and an inconsistent order in the overlapping-object selection menu.

### Cited Findings
- [F] McNeel describes Rhino as command-driven: "all actions are activated by named commands such as Line or Rotate". [O] The same guidance acknowledges that "emotions run high" between command-line users and toolbar users. — [Rhino User Guide: The Rhino Interface](https://www.rhino3d.com/docs/guides/user-guide/introduction/)
- [O] History in older versions was "only a baby step towards parametric/associative design", with Grasshopper as the real parametric tool. — [Archinect forum](https://archinect.com/forum/thread/27120/parametric-modeling-in-rhino)
- [O] A McNeel forum thread argues "Rhino should have some parametric capabilities besides Grasshopper". Others counter that in "inventor mode" a direct modeller is superior. — [McNeel Discourse](https://discourse.mcneel.com/t/i-bear-to-say-rhino-should-have-some-parametric-capabilities-besides-grasshopper/53046)
- [F] **Mac vs Windows (Rhino 8):** McNeel aimed at a more similar UI and shareable Window Layouts. — [Rhino UI System (developer guide)](https://developer.rhino3d.com/guides/general/rhino-ui-system/)
  - A McNeel moderator said the command line remains different on Mac, and unifying it "is a big project that wasn't resourced during the Rhino 8 cycle". — [McNeel Discourse: same CLI on Mac as Windows](https://discourse.mcneel.com/t/how-to-have-the-same-command-line-interface-on-the-mac-as-on-windows/174312) (via search)
  - [O] Mac users say the command line "pops up in different places with different size panels", which feels jumpy, and the Mac UI is "not yet as good as Windows v8". — [McNeel Discourse: Command line in Rhino 8 for Mac](https://discourse.mcneel.com/t/command-line-in-rhino-8-for-mac/136287); [Rhino 8 Mac UI](https://discourse.mcneel.com/t/rhino-8-mac-ui/211372) (via search)
- [F] **Rhino 9 WIP/BETA "Command Line UI unification" (2025-10-02):** a `CommandMode` command chooses
  - Location: CommandHistory (Windows-style), SeparatePanel (dockable popup with command search), or Sidebar (Mac-style);
  - Style: Buttons, Links (classic clickable text), or Graphical.
  - "Classic (Mac)" and "Classic (Windows)" window layouts restore Rhino 8 behaviour.
  - [O] Feedback: the graphical look is "cleaner and more professional", and Search mode suits a minimal UI. Others say History visibility is not obvious, and bugs were reported (Instant alias broken with the feature enabled; resize problems).
  - Source: [McNeel Discourse: Command Line UI unification](https://discourse.mcneel.com/t/rhino-wip-feature-command-line-ui-unification/210508)
- [F] **Rhino 8 UI changes:**
  - Window Layouts (save, share and restore the UI).
  - Layer Manager "completely rewritten on both Windows and Mac".
  - More compact rendering UI; FilletSrf with dynamic radius previews; Monochrome display mode.
  - Native Apple Silicon with a Metal display pipeline.
  - Sources: [Microsol Resources: What's New in Rhino 8](https://microsolresources.com/?p=15544); [Novedge: Rhino 8 features](https://novedge.com/blogs/design-news/exploring-the-new-features-and-enhancements-in-rhino-8) (reseller pages)
- [O] **Rhino 8 regressions:** "Toolbars issue: Poor navigation within cascaded buttons in RH8". The Panels list no longer closes on Esc as it did in Rhino 7. — [McNeel Discourse: cascaded buttons](https://discourse.mcneel.com/t/toolbars-issue-poor-navigation-within-cascaded-buttons-in-rh8/170214?page=2); [Some thoughts on V8](https://discourse.mcneel.com/t/some-thoughts-on-v8/167907) (via search)
- [O] A long-running thread asks for "a complete UI overhaul of Rhino" (8+ pages). — [McNeel Discourse](https://discourse.mcneel.com/t/a-complete-ui-overhaul-of-rhino-would-be-a-much-welcomed-move/72575?page=8) (not fetched)
- [O] Value-for-money frustration exists: "What are we paying for? Frustrations with Rhino vs. Open Source". — [McNeel Discourse](https://discourse.mcneel.com/t/what-are-we-paying-for-frustrations-with-rhino-vs-open-source/152921) (not fetched)

### Inferences
- Rhino's ten-year Mac/Windows divergence shows the cost of letting platform UIs fork. Wren's desktop, iPad and phone layouts should share one command model and one option-presentation component, varying only the container.
- Rhino 9's three option styles (buttons, links, graphical) suggest command options should be data-driven, so one definition can render as inline chips, a side panel, or a touch sheet.

### Gaps
- No primary-source complaints about Rhino's layer model specifically, beyond the Layer Manager rewrite in Rhino 8.
- The official rhino3d.com "What's new in Rhino 8" page was not fetched. Rhino 8 details are from resellers.

## 5. Rhino praise: command line, osnaps/SmartTrack, Gumball, popup menus, aliases, display modes, history, Grasshopper, pricing

### Takeaway
Rhino's praised efficiency comes from a fast verb-first loop: type a few letters or right-click to repeat, a manipulator with typed distances, rich object snaps with tracking lines, user aliases and popup toolbars, and Grasshopper for real parametrics. The perpetual licence (about $995 commercial, Grasshopper included) is a large trust factor.

### Cited Findings
- [F] Right-click in an empty viewport area repeats the last command on Windows when no command is active. On Mac this is off by default and is enabled by disabling context menus or using the delayed (click-hold) context menu. — [Novedge: Rhino mouse shortcuts](https://novedge.com/blogs/design-news/rhino-3d-tip-rhino-mouse-shortcuts-for-efficient-navigation-and-command-repetition); [McNeel wiki: Mac right-click repeat](https://wiki.mcneel.com/rhino/mac/no/rightclick/repeat/command/norightclickrepeat)
- [F] **Gumball (Rhino term):** drag arrows to move, the plane to move in 2D, arcs to rotate, squares to scale (1D/3D; plane for 2D), and the extrude dot to extrude. Alt+drag copies. — [Rhino docs: Gestures reference (Rhino 9 era)](https://www.rhino3d.com/docs/guides/gestures/)
- [O] **Gumball and osnaps:** users recommend "smooth dragging" when osnaps are on, to avoid accidental snapping. In snappy mode, holding Alt disables osnaps. Some users expected the Gumball to snap to objects when osnaps are on. A "Gumball Improvements" feature thread is active in the Rhino BETA. — [McNeel Discourse: Gumball smooth/snappy](https://discourse.mcneel.com/t/gumball-smooth-snappy-dragging-request/57228); [Rhino BETA Feature: Gumball Improvements](https://discourse.mcneel.com/t/rhino-wip-feature-gumball-improvements/215248) (via search)
- [F] **SmartTrack (Rhino term):** temporary tracking lines from osnap points. A tip suggests aligning the view so a SmartLine is visible in the drag direction, then typing a distance to commit. — [Novedge: SmartTrack workflow](https://novedge.com/blogs/design-news/rhino-3d-tip-smarttrack-workflow-for-precise-positioning-in-rhino) (third-party); [Rhino docs: Modeling Aids](https://docs.mcneel.com/rhino/8mac/help/en-us/options/modeling_aids.htm)
- [F] Rhino 5 changed osnaps to prefer a selected object over non-selected ones when snap points coincide. — [Rhino 5 New: Interface](https://www.rhino3d.com/5/new/interface)
- [F] **Aliases and popup toolbars:** a university course shows importing AutoCAD-style aliases and building a personal popup toolbar. — [ETH DDM: 12 Rhino Grasshopper Tips](https://girot-ethz.github.io/ddm/12_Rhino_Grasshopper_Tips_and_Tricks.html)
- [O] Users request an alias overlay to "significantly boost modeling speed". — [McNeel Discourse: UI/UX enhancement proposals](https://discourse.mcneel.com/t/feature-requests-ui-ux-enhancement-proposals-for-rhino-and-grasshopper/220581) (via search)
- [F] **Pricing:** Commercial licence is $995 one-time (perpetual), including support and service releases. Grasshopper ships inside Rhino with no separate price. — [rhino3d.com](https://www.rhino3d.com/pl/) (via search)
- [O] "Rhino is one of the few professional software packages that is still on a one-time purchase scheme." — [McNeel Discourse](https://discourse.mcneel.com/t/triggerwarning-i-want-subscription-based-licensing/166662) (via search)
- [O] A user adapting Rhino to an Alias-style workflow says they are "getting pretty close" to Alias modelling speed. — [McNeel Discourse: NEXT surface tools](https://discourse.mcneel.com/t/next-surface-tools/141857?page=2)

### Inferences
- The most transferable Rhino mechanisms for Wren are:
  - repeat-last-command with zero travel;
  - type-to-command with fuzzy search and user aliases;
  - typing a value at any point during a drag to commit it exactly;
  - tracking lines inferred from snap points.
- These are all generic concepts and need no Rhino marks. Generic names to use instead of Rhino's terms are listed in section 7.
- The perpetual-licence trust has a free/OSS analogue for Wren: local-first files that never lock and an openly documented format.

### Gaps
- Display modes and the History recorder: no fresh user-praise sources fetched.
- Rhino's command-line autocomplete behaviour: not documented in the fetched sources. The Rhino 9 post covers search, not autocomplete.

## 6. Low-level input efficiency (coordinator emphasis): navigation, context menus, pie menus, box selection, preselection, repeat, pan, popup, gestures, osnap cycling, overlap disambiguation

### Takeaway
Both tools show that low-level input defaults are where users' daily friction lives:

- FreeCAD's many navigation styles and its 28-item context menu are recurring friction.
- Rhino's right-click repeat and right-drag pan/rotate are loved by experts but surprise newcomers.
- Rhino's overlapping-object Selection Menu has an unpredictable order.
- Pie/radial menus are a long-standing request in both communities. Blender is the reference point, and in both the demand is met by third-party add-ons rather than core.

### Cited Findings

**FreeCAD: navigation styles**
- See section 1: many styles; OpenInventor needs a modifier key to select; Mac issues with Gesture; the touch tilt gesture is off by default; per-view styles before 0.13; align-to-selection added in 1.1.
- [O] The pain of choosing a style is anecdotal in the tracker; no forum thread was fetched. — [tracker #3396](https://tracker.freecad.org/view.php?id=3396)

**FreeCAD: right-click context menus**
- [F] 28 top-level items for a Part object; the proposed clean-up is partly done in a fork. — [GitHub #13194](https://github.com/FreeCAD/FreeCAD/issues/13194)

**FreeCAD: pie menu addons**
- [F] The PieMenu Workbench addon provides radial menus and a QuickMenu for settings. — [FreeCAD wiki: PieMenu Workbench](https://wiki.freecad.org/PieMenu_Workbench)
- [O] One reviewer found the "Context" option (pies that change per workbench) "too ambiguous. I still have no idea how to use it/what it does". It was also out of sync with Preferences. — [devtalk: PieMenu v2.0](https://devtalk.freecad.org/t/piemenu-v20/64141)
- [F] The original maintainer said they had "no time in '23 to maintain PieMenu2.0", and maintenance moved to "Pie Menu Improved". — [devtalk: PieMenu v2.0](https://devtalk.freecad.org/t/piemenu-v20/64141); [devtalk: Pie Menu Improved](https://devtalk.freecad.org/t/pie-menu-improved/74921?page=3)
- [O] Users in "Pie Menu Improved" asked for ways to remove items because the pie list is "quite long". — [devtalk: Pie Menu Improved](https://devtalk.freecad.org/t/pie-menu-improved/74921?page=3)
- [O] In the #13194 discussion, a contributor proposed circular menus or context toolbars as alternatives to the long tree context menu. — [GitHub #13194](https://github.com/FreeCAD/FreeCAD/issues/13194)

**FreeCAD: box selection, preselection, overlap disambiguation**
- [F] 1.1 added "Clarify Selection", which temporarily makes nearby geometry transparent so all nearby entities are visible and pickable. — [FreeCAD 1.1 release page](https://freecad.github.io/Website/download/releases/1-1/)
- Box selection and preselection highlighting: no sourced complaints found (see Gaps).

**Rhino: right-click repeat and right-drag**
- [F] Right-drag rotates in Perspective and pans in parallel views. Shift+right-drag pans in Perspective. Ctrl/Cmd+right-drag zooms smoothly; the wheel zooms in steps. — [Rhino docs: Gestures](https://www.rhino3d.com/docs/guides/gestures/)
- [F] Right-click without drag acts as Enter, and repeats the last command when no command is running and nothing is selected. — [Rhino docs: Gestures](https://www.rhino3d.com/docs/guides/gestures/); [McNeel Discourse: Right mouse repeat last command?](https://discourse.mcneel.com/t/right-mouse-repeat-last-command/21869)
- [O] Newcomer surprise. Thread "Arrg — right-click repeats last command, help me make it stop" (2024-10-18): a returning Windows user thought right-click used to open a context menu. A veteran replied that "right-click has always worked this way", and that click-and-hold gives a popup and middle-click gives another. The user fixed it by setting the context-menu delay to 50 ms. — [McNeel Discourse](https://discourse.mcneel.com/t/arrg-right-click-repeats-last-command-help-me-make-it-stop/193340)
- [O] Recurring friction on the same theme in other threads:
  - "Disable right mouse button repeat workaround" — [McNeel Discourse](https://discourse.mcneel.com/t/disable-right-mouse-button-repeat-workaround/47805)
  - "Right click menu popup wastes lots of time" — [McNeel Discourse](https://discourse.mcneel.com/t/right-click-menu-popup-wastes-lots-of-time/13900)
  - "Rhino7 Right mouse button rotate vs enter sensitivity" (a click vs drag threshold problem) — [McNeel Discourse](https://discourse.mcneel.com/t/rhino7-right-mouse-button-rotate-vs-enter-sensitivity/143907)
  - "Put recent commands back in the right context menu ASAP" (a regression complaint) — [McNeel Discourse](https://discourse.mcneel.com/t/put-recent-commands-back-in-the-right-context-menu-asap/200454)
  - "WIP on Mac: Right-click not repeating commands" — [McNeel Discourse](https://discourse.mcneel.com/t/wip-on-mac-right-click-not-repeating-commands/220871)
  - Magic Mouse right-click-as-Enter not working on Mac — [McNeel Discourse](https://discourse.mcneel.com/t/right-button-for-enter-command-on-magic-mouse-does-not-work/5254)
  - (Titles via search; most bodies not fetched.)

**Rhino: middle-click popup menus and recent commands**
- [F] Middle-click opens a customisable popup toolbar. A thread requests a recent-commands popup on middle-click. — [McNeel Discourse: Recent Commands popup on mouse wheel click](https://discourse.mcneel.com/t/recent-commands-popup-on-mouse-wheel-click/24070); [ETH DDM tips](https://girot-ethz.github.io/ddm/12_Rhino_Grasshopper_Tips_and_Tricks.html)
- [O] Users replace the middle-click popup with a third-party radial menu app (by Frolt, sold through the Microsoft Store, Jan 2026), praising it as "So Good!" and "Amazing tool".
  - Complaints: lag across outer buttons (reduced by disabling shadows); focus stolen from Rhino causing a 3–4 s delay with a 3D mouse; the Microsoft account requirement; transparency glitches.
  - Requests: text-only buttons and smaller submenu arrows.
  - Source: [McNeel Discourse: New Rhino radial menu, so good](https://discourse.mcneel.com/t/new-rhino-radial-menu-so-good/214192)

**Rhino: mouse gestures**
- [F] Rhino's documented "gestures" are mouse/modifier combinations (listed above), not stroke gestures. Sub-object pick uses Ctrl/Cmd+Shift+click. Window selection works left-to-right; crossing selection right-to-left. — [Rhino docs: Gestures](https://www.rhino3d.com/docs/guides/gestures/)
- [O] A "Mouse mark menu" request asks for stroke/marking-menu style input. — [McNeel Discourse: Mouse mark menu](https://discourse.mcneel.com/t/mouse-mark-menu/216902) (via search)

**Rhino: osnap cycling and selection of overlapping objects**
- [F] When several objects lie under the cursor, Rhino shows a Selection Menu listing the candidates. — [Rhino docs: Selection commands](https://docs.mcneel.com/rhino/mac/help/en-us/commands/selection_commands.htm)
- [O] The order of the Selection Menu is unpredictable. In a 2021 thread, picking the top item of three overlapping surfaces did not always select the same surface. A McNeel staffer said the order follows a type hierarchy (curves before edge curves) and did not know the exact sorting; no fix was offered. The user asked for Z-order sorting for architectural work. A 2023 thread reports "selection menu – somehow reversed?". — [McNeel Discourse: Tuning the Selection Menu (Aug 2021)](https://discourse.mcneel.com/t/tuning-the-selection-menu-when-selecting-overlapping-geometry-curves-blocks/128836)
- [O] A newer thread asks to toggle off the overlapping-objects window. — [McNeel Discourse](https://discourse.mcneel.com/t/toggle-window-asking-for-selection-from-multiple-overlapping-objects/218814.md) (via search)
- [F] A Grasshopper/Kangaroo "Grab" component can intercept clicks on the Selection Menu. — [McNeel Discourse: snaps bug](https://discourse.mcneel.com/t/bug-snaps-sometimes-not-displayed-in-move-from/125599) (via search)

**Pie menus and Blender's influence (Rhino and in general)**
- [O] Rhino users repeatedly ask for Blender- or Maya-style radial and marking menus:
  - "a pie menu within Rhino instead of the current popup would certainly be an upgrade".
  - Grasshopper "has a pie menu which is not a marking menu, but it's nicer than the popup for Rhino".
  - A wish for menus that are both icon-based (Autodesk-style) and text-customisable (Blender-style).
  - Sources: [McNeel Discourse: Rhino 8 development wishlist (marking menus)](https://discourse.mcneel.com/t/rhino-8-development/112418/99); [GUI – Rhino – Radial Menu – Cross Platform](https://discourse.mcneel.com/t/gui-rhino-radial-menu-cross-platform/176647); [Section 2: Radial Pop-Up menu](https://discourse.mcneel.com/t/section-2-radial-pop-up-menu/200228) (via search)
- [F] In Oct 2026, a third-party Grasshopper plugin borrowed Blender-style wire cutting and merging by mouse gesture, plus a pie menu. — [McNeel Discourse: Wire cutters + Pie Menu for Grasshopper](https://discourse.mcneel.com/t/wire-cutters-pie-menu-for-grasshopper/223751.md) (via search)
- [O] A Rhino 9 WIP user reports the radial menu (third-party) "crashes Rhino 9 WIP in almost every occasion". — [McNeel Discourse radial menu thread p.3](https://discourse.mcneel.com/t/new-rhino-radial-menu-so-good/214192?page=3) (via search)
- [O] Blender developers say default pies avoid "complex" designs because complexity goes "against the speedy, gestural input that is the main advantage of pie menus". They also proposed that a short tap of a pie key could perform an action instead of opening the menu. — [Blender devtalk: Pie Menu Development](https://devtalk.blender.org/t/pie-menu-development-for-blender/6171/10); [bf-committers 2014: Usability suggestion for pie menu](https://lists.blender.org/pipermail/bf-committers/2014-November/044614.html)
- [O] Blender's Context Pie add-on exposes Radius and Threshold to shrink the movement needed to choose a pie item. — [Blender Extensions: Context Pie](https://extensions.blender.org/add-ons/contextpie)

### Inferences
- **Right button:** Rhino's model (click = Enter/repeat, drag = navigate, hold = menu) is the most efficient pattern documented here, but it needs a well-tuned click-vs-drag threshold and hold delay, or users report surprise. Wren could adopt "secondary click = confirm/repeat, secondary drag = orbit, press-and-hold = context menu" on desktop, with an onboarding hint. On touch the analogue is two-finger tap = repeat/confirm and long-press = context menu. This is an inference, not tested.
- **Radial menus:** demand for pies is real in both communities but is met by fragile add-ons (unmaintained, ambiguous context modes, long item lists, crashes). Wren should build a radial menu natively: 8 items or fewer, context-dependent on selection type, with flick-to-select (marking-menu muscle memory). This fits Pencil and touch well.
- **Overlap disambiguation:** both tools needed a dedicated mechanism (Rhino's Selection Menu, FreeCAD 1.1's Clarify Selection). Users complain when the candidate order is unstable. Wren should order candidates deterministically (for example nearest-to-camera first, then by type), highlight each candidate in the viewport on hover, and support Tab or scroll cycling under the cursor.
- **Navigation:** offer one default, plus presets named after behaviours, not trademarks. Avoid per-view or per-workbench differences.

### Gaps
- **Rhino osnap cycling and Tab-cycling:** no source found in this pass. Rhino's Tab key is documented here only for layer creation and SubD display toggles (see Rhino docs: Gestures), not snap or selection cycling.
- **FreeCAD box selection and preselection highlighting:** no sourced user complaints found. Preselection highlighting exists and is configurable in preferences (not verified via fetch).
- **FreeCAD navigation:** the list of styles and the 1.x default were not verified because the wiki was blocked.

## 7. What switchers between FreeCAD/Rhino and commercial MCAD miss most; trademark notes for Wren

### Takeaway
FreeCAD users coming from Fusion, SolidWorks or Onshape miss:

- a single coherent environment with no workbench switching;
- robust references through fillets and chamfers;
- a smart Dimension tool;
- polished defaults and onboarding.

Many 1.0/1.1 changes target exactly these. Rhino users miss built-in parametric history outside Grasshopper; MCAD users moving to Rhino gain its fast command loop and snaps. Several of the praised mechanisms carry vendor terms, which Wren should rename generically.

### Cited Findings
- [O] Fusion switchers need "a few weeks of study" and find FreeCAD "not as polished"; sketch completion and support lines are the hardest part. — [lemm.ee](https://lemm.ee/comment/7196372)
- [O] Most commercial tools "all do pretty much the same thing: sketch and constrain, add and edit features, assemble, done". FreeCAD differs by being non-intuitive without tutorials. — [Hackaday comments](https://hackaday.com/2024/11/20/freecad-version-1-0-released)
- [O] Some users prefer free-form direct editing (SketchUp, DesignSpark Mechanical) over the SolidWorks-style feature tree: "Most CAD software follows the solidworks model of a feature tree." — [Hackaday comments](https://hackaday.com/2024/11/20/freecad-version-1-0-released)
- [O] A feature-tree workflow "feels much slower than it might actually be" because of its longer lead-in, while rapid simple actions in direct modellers feel productive. — [Hackaday comments](https://hackaday.com/2024/11/20/freecad-version-1-0-released)
- [F] Assembly in FreeCAD 1.0 is bottom-up only, so users from top-down MCAD workflows lose in-context design. — [Libre Arts](https://librearts.org/2024/11/freecad-1-0/)
- [O] Rhino users ask for parametric capability without Grasshopper. — [McNeel Discourse](https://discourse.mcneel.com/t/i-bear-to-say-rhino-should-have-some-parametric-capabilities-besides-grasshopper/53046)

**Trademark and vendor-term notes.** These are vendor names; their registration status was not verified, so treat them all as marks. Generic terms to use instead:

| Vendor term | Generic description for Wren |
|---|---|
| "Gumball" (McNeel/Rhino) | transform manipulator, triad handle, move/rotate/scale widget |
| "SmartTrack" (McNeel) | inference or tracking lines; alignment guides |
| "Grasshopper" (McNeel) | visual node-based programming, dataflow graph |
| "Rhino"/"Rhinoceros" (McNeel) | (product names) |
| "Marking Menu" (Autodesk/Maya) | radial or flick menu |
| "pie menu" | already generic and widely used, including by Blender |
| "Osnap" (Rhino; AutoCAD uses "OSNAP") | object snaps |
| "SubD" | subdivision surface |
| "Clarify Selection" (FreeCAD) | open source, but describe the concept as selection disambiguation / x-ray pick |

Sources for the terms: [Rhino docs: Gestures](https://www.rhino3d.com/docs/guides/gestures/); [Novedge SmartTrack tip](https://novedge.com/blogs/design-news/rhino-3d-tip-smarttrack-workflow-for-precise-positioning-in-rhino); [McNeel Discourse marking menus](https://discourse.mcneel.com/t/rhino-8-development/112418/99)

### Inferences
- A browser-native, single-environment app with no workbench switching, smart dimensioning, on-canvas values and transparent previews addresses the top FreeCAD complaints directly, and is where FreeCAD itself is heading.
- Wren should borrow Rhino's input loop (repeat, aliases, typed values during drags, snap tracking) without adopting its command-line-first learning curve. A command palette with search plus inline option chips gives the speed without the blank-prompt problem.

### Gaps
- No structured survey of switcher pain points was found; all evidence is anecdotal forum or comment text.
- DEVELOP3D reviews and YouTube reviewer opinions were not covered in this pass because of the tool-call budget.

## 8. View orbit / rotation behaviour (coordinator emphasis): pivot, orbit style, indicator, inertia, complaints, preferred defaults

### Takeaway
Both tools' orbit complaints share one cause: users expect the view to pivot around what they are looking at (the point or object under the cursor) and to stay predictable. When the pivot is the window centre, the world origin, or a stale camera target, the part "whips off screen". Both projects changed their defaults over time:

- **FreeCAD:** 1.0 orbited with Trackball around the model point under the cursor. 1.1 changed the shipped defaults to the "Rounded Arcball" orbit style around the window centre. It shows a rotation-centre sphere, and spin-after-release is off by default.
- **Rhino:** right-drag orbits around the camera target, with world-Z kept vertical by default. Orbiting around the object under the cursor is a buried Advanced setting. A Rhino 5 → 8 switcher described the difference as the object "whips around and go[es] off screen".

Correction to the brief: Rounded Arcball arrived in the 1.1 cycle (merged April 2025), not in 1.0.

### Cited Findings

**FreeCAD: options and defaults, verified in source**

FreeCAD's navigation preferences page (Display → Navigation; source `src/Gui/PreferencePages/DlgSettingsNavigation.ui/.cpp`) has these orbit settings:

- [F] **Orbit style choices** (1.1 and main), with the tooltip wording:
  - "Rounded Arcball: moving the mouse in the corners of the screen will only roll the part."
  - "Trackball: moving the mouse horizontally will rotate the part around the Y-axis."
  - "Trackball Classic: moving the mouse will rotate the part allowing precession."
  - "Free Turntable: the part will be rotated around the Z-axis."
  - "Turntable: the part will be rotated around the Z-axis (with constrained axes)."
  - 1.0 offered only Turntable, Trackball and Free Turntable.
  - Sources: [DlgSettingsNavigation.ui (main)](https://github.com/FreeCAD/FreeCAD/blob/main/src/Gui/PreferencePages/DlgSettingsNavigation.ui); [same file at tag 1.0.0](https://github.com/FreeCAD/FreeCAD/blob/1.0.0/src/Gui/PreferencePages/DlgSettingsNavigation.ui)
- [F] **Rotation mode choices:** "Window center", "Drag at cursor", "Object center". The tooltip reads "Rotations in 3D will use current cursor position as center for rotation." In code:
  - Window center = the camera focal point.
  - Drag at cursor = ScenePointAtCursor | FocalPointAtCursor: ray-pick the model point under the cursor at button press; if nothing is hit, use the point on the focal plane under the cursor.
  - Object center = ScenePointAtCursor | BoundingBoxCenter: the picked point, else the scene bounding-box centre.
  - Sources: [NavigationStyle.h](https://github.com/FreeCAD/FreeCAD/blob/main/src/Gui/Navigation/NavigationStyle.h); [NavigationStyle.cpp](https://github.com/FreeCAD/FreeCAD/blob/main/src/Gui/Navigation/NavigationStyle.cpp) (`saveCursorPosition`)
- [F] **Default changes across versions** (from the preference-page source at each release tag):

  | Version | Default orbit style | Default rotation mode | Default navigation style |
  |---|---|---|---|
  | 0.21.2 | Trackball | 1 = Drag at cursor | CAD |
  | 1.0.0 | Trackball | 1 = Drag at cursor | CAD |
  | 1.1.0 and main | Rounded Arcball | 0 = Window center | CAD |

  - Sources: [0.21.2 DlgSettingsNavigation.cpp](https://github.com/FreeCAD/FreeCAD/blob/0.21.2/src/Gui/DlgSettingsNavigation.cpp); [1.0.0](https://github.com/FreeCAD/FreeCAD/blob/1.0.0/src/Gui/PreferencePages/DlgSettingsNavigation.cpp); [1.1.0](https://github.com/FreeCAD/FreeCAD/blob/1.1.0/src/Gui/PreferencePages/DlgSettingsNavigation.cpp)
  - I did not find the PR or rationale for switching the rotation-mode default to Window center.
- [F] **CAD style middle click:** a quick middle click (shorter than the OS double-click interval) calls `lookAtPoint`, which re-targets the camera on the picked point. In Window-center mode that point becomes the new orbit pivot. This is the "click to set rotation centre" gesture. — [CADNavigationStyle.cpp](https://github.com/FreeCAD/FreeCAD/blob/main/src/Gui/Navigation/CADNavigationStyle.cpp)
  - [F] The CAD style's own hint says: rotate = "Press middle+left, middle+right or shift+right mouse button". — same file
  - [F] A FreeCAD doc summary says "The cursor position when the middle mouse button is pressed determines the center of rotation", and a middle-button double-click sets a new centre. — [FreeCAD wiki Mouse navigation (via search)](https://wiki.freecad.org/Mouse_navigation/en)
- [F] **Rotation-centre indicator:** a "Rotation Center Indicator" group (checkable; sphere size, colour and transparency). `ShowRotationCenter` defaults to true in both 1.0 and 1.1. The 1.0 release notes say a rotation centre indicator was added and can be disabled. — [DlgSettingsNavigation.ui](https://github.com/FreeCAD/FreeCAD/blob/main/src/Gui/PreferencePages/DlgSettingsNavigation.ui); [Release notes 1.0 fragment (via search)](https://wiki.freecad.org/Translations:Release_notes_1.0/52/en)
- [F] **Pivot-aware projection:** for the Trackball, Trackball Classic and Rounded Arcball styles, when the pivot is a picked scene point, FreeCAD moves the virtual-trackball sphere to the pivot's screen position and scales its radius and sensitivity. This keeps the rotation coherent when orbiting about an off-centre point. — [NavigationStyle.cpp `spinInternal`](https://github.com/FreeCAD/FreeCAD/blob/main/src/Gui/Navigation/NavigationStyle.cpp)
- [F] **Inertia/spin:** "Enable spinning animations that are used in some navigation styles after dragging" (`UseSpinningAnimations`) defaults to off. Navigation animations (view transitions) default to on, with a default duration of 500 ms. "Zoom at cursor" defaults to on. — [DlgSettingsNavigation.ui](https://github.com/FreeCAD/FreeCAD/blob/main/src/Gui/PreferencePages/DlgSettingsNavigation.ui); [NavigationStyle.cpp](https://github.com/FreeCAD/FreeCAD/blob/main/src/Gui/Navigation/NavigationStyle.cpp)

**FreeCAD: history of Rounded Arcball and Trackball Classic**
- [F] PR #20535, "Gui: Added classic trackball orbit style" (Graicc, opened 2025-03-31, merged 2025-04-28):
  - Added Trackball Classic, which "mimics the default orbit behavior of other CAD applications".
  - Added Rounded Arcball (pure roll when dragging outside a circle), closing #18070, "Add Rounded Arcball Navigation Style with pure Roll around", which cites CATIA-like behaviour.
  - [O] The author: "position independence is far more important than path independence".
  - [O] A design-WG reviewer: "wow, this works great", but "Pure roll outside only seems to work in the corners". The author said the transition onto the sphere "doesn't feel the greatest when FreeCAD is in fullscreen".
  - Source: [GitHub PR #20535](https://github.com/FreeCAD/FreeCAD/pull/20535)
- [O] Issue #21403, "Navigation: Improve Rounded Arcball orbit style" (2025-05-16, still open):
  - The style is "static": "you cannot orbit around the object as pure roll kicks in outside".
  - The roll zone is a screen-ratio oval, so it is "hard to roll only on the right or left edge".
  - Proposals: a circle with a margin; roll only while the drag stays outside the circle; show the circle overlay while orbiting.
  - The issue has slipped from the 1.1 milestone through 26.3/27.1 to no milestone.
  - Source: [GitHub #21403](https://github.com/FreeCAD/FreeCAD/issues/21403)
- [F] Background: arcball control was proposed by Ken Shoemake (1992). A comparison of virtual trackballs rates turntable as path-independent but limited to a fixed axis, and trackball as path-independent with arbitrary rotation. — [Virtual Trackballs: An Interactive Taxonomy](https://theshamblog.com/virtual-trackballs-a-taxonomy/)
- [F] PR #8048 (Dec 2022) added Free Turntable, "a second Turntable orbit style but without primary rotation selection … similar to Blender". In Free Turntable the Z axis stays aligned with screen vertical, unlike Trackball. — [GitHub PR #8048](https://github.com/FreeCAD/FreeCAD/pull/8048)

**FreeCAD: complaints**
- [O] Tracker #3396 says rotating a part also makes it orbit, "most CAD apps rotate parts about their center without ANY kind of orbiting", and that no style avoids it. [O] A maintainer reply (tracker #3417) blamed zoom habits for the moving pivot, and pointed to the then-new "drag at cursor" option to rotate around a point on the model. — [tracker #3396](https://tracker.freecad.org/view.php?id=3396); [tracker #3417](https://tracker.freecad.org/view.php?id=3417)
- [F] A 3Dconnexion report says the rotation centre is not updated in perspective view. Fixes in 2026 include #29998, "honor rotation center mode for SpaceMouse" (closed), and #32066, "partially revert … spacemouse zoom pivot behavior" (closed). — [tracker #4654 (via search)](https://tracker.freecad.org/view.php?id=4654); [GitHub search results](https://github.com/FreeCAD/FreeCAD/pulls?q=rotation+center)
- [F] A "Fusion navigation style" PR (#26359, Dec 2025, based on the Revit style) was tested and approved in Apr 2026. It was then marked draft, and its milestone moved to tbd in Sept 2026. [O] "Would really like this control scheme." — [GitHub PR #26359](https://github.com/FreeCAD/FreeCAD/pull/26359)
- [F] Version naming: FreeCAD milestones and issue titles now use calendar-style versions (26.3, 27.1; "FreeCAD 26.3rc2", Nov 2026) after 1.1. — [GitHub #21403 milestones](https://github.com/FreeCAD/FreeCAD/issues/21403); [GitHub #34280 title (via API search)](https://github.com/FreeCAD/FreeCAD/issues/34280)

**Rhino: pivot and orbit model**
- [F] **Mouse mapping:** right-drag rotates the Perspective view (pans parallel views). Ctrl/Cmd+Shift+right-drag rotates around the object under the cursor (in parallel views it rotates the view). — [Rhino docs: Gestures](https://www.rhino3d.com/docs/guides/gestures/); [RotateView docs](https://docs.mcneel.com/rhino/6/help/en-us/commands/rotateview.htm)
- [F] **Rhino 8 Options → View → Rotate:**
  - "Rotate around world axes" (default on), with tilt keys to roll.
  - "Rotate around CPlane Z-axis"; "Rotate relative to view"; "Classic V2 style" (all off).
  - Keyboard increment 1/60 of a circle (6°).
  - "Auto adjust camera target after Pan and Zoom … Tries to keep the view rotation target where the objects are" (default on).
  - "Wrap cursor at viewport borders" (default on).
  - "Set RotateViewAroundObjectAtMouseCursor=True in Advanced settings to rotate a view around the object under the mouse cursor."
  - No inertia/spin setting is documented.
  - Source: [Rhino 8 Options: View](https://docs.mcneel.com/rhino/8/help/en-us/options/view.htm)
- [F] **Gumball option:** Options → Modeling Aids → Gumball → "Rotate view around Gumball" orbits around the selection. The Advanced setting `RotateViewAroundAutoGumball` controls the auto-gumball variant; one user disabled it to stop orbiting around selected objects. — [McNeel Discourse: Disable orbit around selected object (2026-04)](https://discourse.mcneel.com/t/disable-orbit-around-selected-object/218094); [RotateViewAround ObjectAtMouseCursor does not work (2024)](https://discourse.mcneel.com/t/rotateviewaround-objectatmousecursor-does-not-work/183989)
- [F] **Re-centring tools:** Zoom Selected ("ZS") resets the target to the selection; `_Zoom _Target` sets a precise target; staff call the latter their favourite. — [McNeel Discourse: Nine wish: set center of rotation (2026-07)](https://discourse.mcneel.com/t/nine-wish-set-center-of-rotation/221234); [Rotate about an item … tumbles it out of view V8 (2025-03)](https://discourse.mcneel.com/t/rotate-about-an-item-in-perspective-tumbles-it-out-of-view-v8/200980)

**Rhino: complaints and preferred defaults**
- [O] Rhino 5 → 8 switcher (2025): after a right-drag rotate in V8 "it goes off screen", while "in V5 i just zoom in and out all day long … it rotates about what I have zoomed into, no selections needed".
  - Staff suggested ZS, then the Advanced setting.
  - The user: "IT SHOULD ROTATE ABOUT CURSOR BY DEFAULT … NO ONE WANTS THE OBJECT TO WHIP AROUND AND GO OFF SCREEN", and said the setting is "buried VERY DEEP in advanced".
  - [O] Staff (Gijs) could not reproduce a V5 vs V8 difference with a test file.
  - Source: [McNeel Discourse thread 200980](https://discourse.mcneel.com/t/rotate-about-an-item-in-perspective-tumbles-it-out-of-view-v8/200980)
- [O] Wish (2022): make Shift+Ctrl+RMB "rotate around pickpoint" the default, or map it to the middle button, "so I don't have to hold down the key combo". Staff logged RH-68058, "Rotate view – always use the mouse location". Others agreed: "very unconfortable to orbit when the center of the axis of rotation is moved … from the center of the object". Rotate-at-cursor does not work on unbaked Grasshopper preview geometry. — [McNeel Discourse: Wish rotate around pickpoint as default](https://discourse.mcneel.com/t/wish-rotate-view-option-for-rotate-around-pickpoint-as-default/140191)
- [O] 2019: "to rotate the view … is really suffering from the first day … the view rotation center is always … (0,0,0)". The fixes were "Rotate relative to view" or "Rotate view around Gumball". [O] A 2025 reply: "great one, was struggling with a very uncontrollable view rotation on a larger scale file (architectural model)." — [McNeel Discourse thread 87727](https://discourse.mcneel.com/t/how-can-i-set-a-view-rotation-center-in-rhino-now-the-view-rotation-operation-is-suffering/87727)
- [O] Problems with the cursor-pivot setting:
  - It did not stick at first (bug RH-74898, fixed in WIP 2023).
  - It ignores objects on locked layers, making it "appear as though it is not working" (2025).
  - Users still report it "does not do anything" (2026-01): "really annoying when you are zoomed way into an area … and can not click and rotate."
  - [O] One user found the cursor pivot lands on "the front corner of the box, which is a bit odd". They prefer SpaceMouse "Object Mode" (rotate around the selection's bounding-box centre).
  - Sources: [Rotate View Around ObjectAtMouseCursor not stored](https://discourse.mcneel.com/t/rotate-view-around-objectatmousecursor-not-stored/159279); [does not work](https://discourse.mcneel.com/t/rotateviewaround-objectatmousecursor-does-not-work/183989)
- [O] An NX user wants a quick middle-button press (about 1 s or less) to set the pivot and briefly highlight it, as in NX, Alias and Geomagic Design X, so they can work on a small area and then return. — [McNeel Discourse: Nine wish: set center of rotation](https://discourse.mcneel.com/t/nine-wish-set-center-of-rotation/221234)
- [O] Rhino inertia: no built-in rotation inertia setting found. A 2014 Mac thread complained that the view "continues moving for two or three seconds after lifting their fingers from the trackpad" (OS trackpad momentum). — [McNeel Discourse: Issue rotating view (Rhino 5 Mac)](https://discourse.mcneel.com/t/issue-rotating-view-perspective-following-most-recent-rhino-5-update/2613) (via search)
- [O] The same pivot complaints appear in other CAD forums (Fusion "PLEASE fix the orbit pivot point behavior", SketchUp "Orbit pivot point", Revit "3D Orbit and Pivot point"), so this is industry-wide, not specific to FreeCAD or Rhino. — [Autodesk forum](https://forums.autodesk.com/t5/fusion-design-validate-document/please-fix-the-orbit-pivot-point-behavior-sooner-rather-than/m-p/6203677); [SketchUp forum](https://forums.sketchup.com/t/orbit-pivot-point/68455)

### Inferences
These are inferences for Wren's "rotation feels off" problem; none is tested.

- **Pivot under the cursor.** At pointer-down, ray-pick the B-rep/mesh under the cursor and pivot there. If nothing is hit, fall back to the selection's bounding-box centre, then to the visible-scene centre. Never fall back to the world origin or a stale target. This is FreeCAD's "Drag at cursor" chain with a better fallback, and it is what Rhino users ask for. With this kind of pivot, the object should never leave the screen during an orbit.
- **Keep world Z up.** Use a turntable (world-Z up) by default, as Rhino does with "Rotate around world axes". Offer trackball/arcball as an option. Roll zones such as Rounded Arcball's corner roll confuse users unless the zone is visualised (#21403). A free trackball with no up-axis is a common reason an orbit "feels off" next to MCAD tools that keep the horizon level.
- **Show the pivot.** Show a small pivot marker during the drag only, the way FreeCAD shows its sphere and NX briefly highlights the point. Provide a quick gesture to set the pivot: a tap or middle-click on a point, or double-tap on touch.
- **Sensitivity scales with pivot position.** Adjust sensitivity by how far the pivot is from screen centre, as FreeCAD's `spinInternal` does. Orbiting about an off-centre pivot otherwise feels too fast.
- **No inertia by default.** Both tools leave it off (FreeCAD) or don't offer it (Rhino), and a Rhino Mac user complained about OS-level coasting. On touch, a very short damped coast could be optional.
- **Zoom at cursor on.** FreeCAD has it on by default. Rhino's "Auto adjust camera target" keeps the pivot near the objects after a pan or zoom, which is the main source of Rhino's "whips off screen" complaints when it fails.

### Gaps
- The rationale for FreeCAD 1.1 changing the default rotation mode from "Drag at cursor" to "Window center" was not found. The PR could not be located through API search, and wiki/forum pages are blocked by Anubis. The table above shows that the defaults changed but not why.
- No user surveys on turntable vs trackball preference in FreeCAD were found. The evidence is the PR/issue discussion only.
- The status of Rhino RH-68058 ("always use the mouse location") is unknown, and so is whether Rhino 9 changes the orbit default.
- Rhino 8 Mac trackpad orbit behaviour and gesture mapping were not verified.
