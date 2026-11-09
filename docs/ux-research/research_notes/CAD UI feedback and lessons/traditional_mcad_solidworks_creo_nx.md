# Traditional desktop MCAD UI/UX feedback: SolidWorks, PTC Creo, Siemens NX

Scope note: research run on 2026-11-09. Items dated before 2020 are marked **[historical]**. Each bullet is labelled **[doc]** (vendor documentation or a documented feature), **[user]** (opinion or report from a forum, Reddit or review site), **[reseller]** (a VAR or partner blog: semi-official and often promotional) or **[study]** (academic or lab study). Several Reddit mirrors and one forum host (cadforum-net.dezignstuff.com) could not be fetched from this session, so the material from Reddit is thinner than intended. See the Gaps sections.

## Q1. Recurring UI and workflow complaints

### Takeaway
The complaints that recur across all three tools are these:
- **Reference fragility.** Broken mates, dangling dimensions and relations, and error cascades whose root cause sits upstream of the feature that is flagged.
- **Slow or blocking UI.** Single-threaded rebuilds, lagging menus and pop-ups that cause mis-clicks, and imports that block the session.
- **Context-dependent or hidden commands.** Short right-click menus behind a chevron, Creo menus that change with the active ribbon tab, and the Creo dashboard hiding its tab.
- **Licensing and login friction.** 3DEXPERIENCE named-user login failures.

SolidWorks is rated easiest to learn. NX is rated powerful but complex. Creo is polarising.

### Cited Findings

**Reference errors, rebuild errors and "what's wrong"**
- [user][2023] The #1 idea on the SOLIDWORKS 2023 user-voted Top Ten List was "AutoSolve Dangling Relations and Dimensions in Sketching and Drawings", aimed at simplifying the repair of dangling dimensions, especially on drawings. #3 was "Ability to Reattach Dangling DimXpert Annotations in MBD". #5 was "Tell Us Which File Is at Fault", a request for diagnostics that name the offending file. — [EngineersRule: Top Ten Requests 2023](https://www.engineersrule.com/the-votes-are-in-the-top-ten-requests-from-3dexperience-world-2023/)
- [doc] SolidWorks' "What's Wrong" dialog lists rebuild errors. The common causes it gives are dimensions or relations dangling to deleted entities, and features that cannot rebuild (e.g., a fillet that is too large). — [SolidWorks Help: What's Wrong (2019)](https://help.solidworks.com/2019/english/SolidWorks/sldworks/hidd_new_whats_wrong.htm); [SolidWorks Tech Blog: Troubleshoot using the What's Wrong dialog (2019)](https://blogs.solidworks.com/tech/2019/09/how-to-troubleshoot-using-the-whats-wrong-dialog.html)
- [user] On the SolidWorks forum, a user with large assemblies reports rebuild-error marks appearing even though everything is fully defined. Pressing Ctrl+Q / Ctrl+B repeatedly sometimes clears them, and then they come back with no clear cause. — [SolidWorks forum thread 228325](https://forum.solidworks.com/thread/228325) (via search snippet; full thread not fetched)
- [study][2024] The UIST 2024 paper "Understanding and Supporting Debugging Workflows in CAD" (Hähnlein, Bernstein, Schulz; DOI 10.1145/3654777.3676353) makes these points:
  - Editing the parameters of one operation often causes later operations to fail, mostly because references fail to resolve.
  - CAD systems highlight the operation that failed, not the earlier operation that changed the reference, so "a reference error leaves the user with a broken program that they have to debug".
  - The authors built DeCAD, a graphical debugger implemented as an Onshape plugin that compares model states across operations and edits, and tested it with CAD experts in a lab study.
  — [DeCAD paper PDF](https://obikate.github.io/papers/decad.pdf); [NSF PAR copy](https://par.nsf.gov/servlets/purl/10637208)

**Topological naming and mates breaking**
- [reseller][historical, 2013] Mechanism in SolidWorks: deleting and recreating a sketch entity creates a face with a new unique ID, and assembly mates reference faces by that ID, so the mates break. Mates to datum planes or axes do not use geometry IDs and are more robust. — [Javelin: Sketch Entities and Mates (2013)](https://www.javelin-tech.com/blog/2013/09/sketch-entities-mates/)
- [user] After "Replace Component" in SolidWorks, a user found "all my mates were broken". — [3DSwym SolidWorks forum: mates broken after Replace Components](https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/my-assembly-mates-broken-after-using-replace-components_SPij28HRTMa7TkxganvNKg)
- [user] Another user saw a failure cascade: one failing subassembly broke many mates ("only 18 of the 155 mates in the assembly are black"), and the errors did not appear immediately. — [SolidWorks forum thread 214150](https://forum.solidworks.com/thread/214150) (via search snippet)
- [doc] SolidWorks has an "Auto Repair" action on the Mates folder for multiple missing mate references (introduced in 2023). — [SolidWorks Help 2024: Repairing a Missing Mate Reference](https://help.solidworks.com/2024/English/SolidWorks/Sldworks/r_auto_repair_mates.htm); [3DSwym wiki: Auto Repair Mates new in SWx 2023](https://3dswym.3dexperience.3ds.com/wiki/solidworks-news-info/making-use-of-the-auto-repair-mates-new-in-swx-2023-pbbp688124_Vty_Hz2kSIunCs9nsJG2CQ)
- [doc][historical, 2016] SolidWorks 2016 added "globally replace failed mate references". — [Javelin 2016](https://www.javelin-tech.com/blog/2016/01/solidworks-2016-globally-replace-failed-mate-references/)

**Performance, blocking UI and crashes**
- [user][2024] In the r/cad thread "Biggest issues with SolidWorks" (June 2024), the poster complains that menus take a while to open after clicking a command. They add that the software is single-threaded, so it cannot process in the background while the user works elsewhere. — [r/cad thread (mirror)](https://redlib.nohost.network/r/cad/comments/1di59xk/biggest_issues_with_solidworks) (search snippet only; the page returned 403 on fetch)
- [user][2025] An r/SolidWorks post (March 2025) says one recurring error usually leaves the program unresponsive. — [r/SolidWorks (mirror)](https://reddit.birdcat.cafe/r/SolidWorks/comments/1j9b0bz/has_anyone_else_tried_this/mhfc439/?context=3) (snippet only)
- [user] A SolidWorks forum user reports that after half an hour or more, buttons such as rebuild and the save shortcut stop working, and ribbon buttons grey out unexpectedly. — [SolidWorks forum: buttons stop working](https://forum.solidworks.com/forum-solidworks/YTysThdrTfWxCUl1S74-iw/buttons-stop-working)
- [user][historical, 2010] In "Who else hates the left click pop up menu" (the SolidWorks context toolbar introduced in 2009):
  - "sometimes it doesn't work (edit sketch gets replaced with a copy of whatever the little glasses means)"
  - "more than once it's lagged to come up and I think I'm clicking on something 'behind' the menu" and "end up doing something unwanted like suppressing a part/feature"
  - "It's going to take me a good 10 minutes of waiting to undo this accidental click."
  This lag-induced mis-click on a pop-up is the key lesson. — [3DSwym SolidWorks forum (2010)](https://3dswym.3dexperience.3ds.com/post/solidworks-user-forum/who-else-hates-the-left-click-pop-up-menu_0eLbRZLgSEyXF4-T8uhSOg)

**Menus, ribbon, dashboard and discoverability**
- [doc][historical, 2015] SolidWorks right-click (shortcut) menus open in a short form by default, and you click the chevron at the bottom to see all items. SolidWorks 2015 moved less-used commands into the long form. Tools > Customize > Options > Shortcut customization > "Show All" turns this off. — [SolidWorks 2015 What's New: shortcut menu enhancements](https://help.solidworks.com/2015/English/WhatsNew/c_shortcut_menu_enhancements.htm); [SolidWorks Help 2020: Shortcut Menus](https://help.solidworks.com/2020/english/SolidWorks/sldworks/c_shortcut_menus.htm); [CATI: How to expand the right-click menu](https://www.cati.com/?p=118892)
- [user] A complaint about that design: "you usually have to click the two v's pointing down to expand the menu". — [SolidWorks forum thread 228019](https://forum.solidworks.com/thread/228019) (snippet)
- [doc] There is a known bug where SolidWorks context menus that cross a monitor boundary in vertical dual-monitor setups render blank. — [Hawk Ridge support: Blank context menu on multi-monitor setups](https://support.hawkridgesys.com/hc/en-us/articles/360004441591-Blank-Context-Menu-On-Multimonitor-Setups)
- [user][historical, ~2013] Creo ribbon backlash in the PTC Community thread "Why does PTC insist on Ribbon Interface? Over 40% strongly dislike":
  - "the ribbon interface doesn't work well in 3D CAD software"
  - The ribbon "requires more mouse travel and more mouse clicks".
  - One user still "modif[ies] the ribbon every day to make it faster".
  — [PTC Community thread](https://community.ptc.com/t5/System-Administration/Why-does-PTC-insist-on-Ribbon-Interface-Over-40-strongly-dislike/m-p/186537)
- [user][historical] Creo context menus depend on the active ribbon tab. RMB options on a drawing view "are not always available if you are on the 'wrong' tab". The workaround is to hold Alt to manipulate items from any tab. — [PTC Community: WF5 Drawing ribbon menus](https://community.ptc.com/t5/3D-Part-Assembly-Design/WF5-Drawing-ribbon-Menus/m-p/406175); [PTC Community WF5 ribbon](https://community.ptc.com/t5/3D-Part-Assembly-Design/WF5-ribbon/m-p/361314)
- [user][historical] Creo dashboard: "when you do anything that has a Dashboard, the tab doesn't show and it auto hides". PTC reportedly said the dashboard position could no longer be changed in Wildfire 5.0. — [PTC Community: Can't change dashboard position](https://community.ptc.com/t5/System-Administration/Can-t-change-dashboard-position/m-p/116188)
- [user] Counterpoint: some Creo users defend the ribbon ("PTC had corrected a lot of their ribbon issues in Creo"), and there is a "Creo Ribbon UI appreciation" thread. — [PTC Community: Creo Ribbon UI appreciation](https://community.ptc.com/t5/System-Administration/Creo-Ribbon-UI-appreciation/m-p/680604)
- [user][historical, 2012] Creo was called "old fashioned" (DOS-style look) in Creo 3 era threads. — [PTC Community: Why is Creo3 so old-fashioned](https://community.ptc.com/t5/System-Administration/Why-is-Creo3-so-old-fashioned/m-p/200964)

**Learning curve and relative ease of use**
- [user] On G2's aggregate, SolidWorks scores 8.6 on ease of use against 7.4 for Creo Parametric, and reviewers call the SolidWorks interface beginner-friendly. — [G2: Creo Parametric vs SolidWorks](https://g2.com/compare/creo-parametric-vs-solidworks)
- [user] G2 also reports that Designcenter NX outperforms Creo on user-experience metrics such as ease of use. — [G2: Creo vs Designcenter NX](https://www.g2.com/compare/creo-parametric-vs-nx-cad)
- [reseller] A Creo reseller claims Creo is "easy to learn" and that NX is steep and complex. The source is biased (a PTC partner). — [Tristar: Creo vs NX (2023)](https://www.tristar.com/blog/cad-simulation/creo-vs-nx/)
- [user] Opinion is split: a cadforum user reportedly called Creo "the most painful user experience" and preferred the SolidWorks sketcher over NX's. — [cadforum: NX vs Creo vs SolidWorks](https://cadforum-net.dezignstuff.com/viewtopic.php?p=25282) (seen only via a search summary; the host was unreachable from this session, so this is unverified)

**Selection pain**
- [user][2023] #2 on the SOLIDWORKS 2023 Top Ten List was "Ability to Toggle a Selection Filter for Entities from a Specific Component", to save time in complex assemblies. — [EngineersRule 2023](https://www.engineersrule.com/the-votes-are-in-the-top-ten-requests-from-3dexperience-world-2023/)
- [user] SolidWorks right-to-left box selection does not respect selection filters (forum report). — [3DSwym: Right to left box selection not working with selection filters](https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/right-to-left-box-selection-not-working-with-selection-filters_TQ11RdHORmu63PNhInTQnA)
- [user][2023] Also on the 2023 Top Ten List: more information in the assembly FeatureManager design tree, and making all part features available in assemblies. — [EngineersRule 2023](https://www.engineersrule.com/the-votes-are-in-the-top-ten-requests-from-3dexperience-world-2023/)

**Licensing and login friction (as UX)**
- [user][2024] Two r/SolidWorks threads in 2024 are titled "Can't do it anymore, 3DEXPERIENCE is unforgivable" (Jan 2024) and "3DEXPERIENCE really that bad?" (Feb 2024). A user notes that the default save location in 3DEXPERIENCE SOLIDWORKS is the cloud. — [r/SolidWorks (mirror) Jan 2024](https://redlib.ssps.io/r/SolidWorks/comments/1aefeao/cant_do_it_anymore_3dexperience_is_unforgivable); [r/SolidWorks (mirror) Feb 2024](https://redlib.ssps.io/r/SolidWorks/comments/1al1jtr/3dexperience_really_that_bad) (snippets only)
- [user][2025] A user who bought a one-year subscription gets a connection error on every launch. — [SolidWorks forum: unable to connect to 3DEXPERIENCE](https://forum.solidworks.com/forum-solidworks/8WeTjykyR5KtxjoOk3hyoQ/solidworks-unable-to-connect-to-3dexperience)
- [user] A forum post titled "A list of frustrations with the 3DEXPERIENCE (3DX) platform from a SOLIDWORKS user perspective". — [SolidWorks forum](https://forum.solidworks.com/forum-solidworks/7l9K6_RJSnSbO5_dwmYjqA/a-list-of-frustrations-with-the-3dexperience-3dx-platform-from-a-solidworks-user-perspective) (not fetched)
- [reseller][2025] 3DEXPERIENCE licences are named users tied to an email address, and login failures ("access denied") are a common issue that is often caused by VPN or firewall settings. — [Visiativ: Common 3DEXPERIENCE connection challenges](https://visiativ.co.uk/news-resources/common-3dexperience-connection-challenges/)
- [doc] Moving to the 3DEXPERIENCE login may require a new password, and the old SOLIDWORKS ID and the new 3DEXPERIENCE ID are separate accounts linked by email. — [SolidWorks: Transition to 3DEXPERIENCE login](https://www.solidworks.com/support/transition-3dexperience-login-dsxclient-care-order)

**NX-specific complaints**
- [user][2020s] After an NX update, radial menus required hovering directly over a command to start it. Before the update, users could just move toward it, which is gesture-like. — [Eng-Tips: radial menu selection gestures](https://www.eng-tips.com/threads/radial-menu-selection-gestures.460281)
- [user] Eng-Tips users are reported to be broadly sceptical of Synchronous Technology, with an "unusually negative tone". This is one blogger's impression (Matt Lombard). — [Dezignstuff: Synchronous Throwdown](https://dezignstuff.com/?p=12272)
- [user][historical, NX4–NX7] In sketch mode, view rotation got disabled, and re-enabling it did not persist to the next sketch session. — [3Dconnexion forum](https://forum.3dconnexion.com/viewtopic.php?p=4040)

### Inferences
- The strongest cross-tool signal is "the error is reported far from its cause". The SolidWorks 2023 #1 and #5 requests, the cascading mate failures and the DeCAD paper all point the same way. Wren's "needs attention" model should point at the upstream operation whose output changed, not only at the failing downstream feature.
- Pop-ups that appear late under the cursor cause destructive mis-clicks (the 2010 SolidWorks thread). Any contextual toolbar Wren shows on selection should never sit where the next click lands, and should not accept a click in the first ~150 ms. That threshold is a design inference, not a sourced number.
- Hiding commands behind a "short menu" chevron, or showing different menus depending on the active tab (Creo), are both cited as friction. Context menus should be stable and short because they are curated, not truncated.
- Long-running, blocking operations are a top complaint about SolidWorks' single-threaded rebuild. Wren's worker-based kernel is a real differentiator, and the UI should stay interactive during rebuilds.

### Gaps
- Could not fetch the full text of the Reddit threads (mirrors returned 403) or of cadforum (host blocked), so there are few verbatim recent Reddit quotes. cadforum-net.dezignstuff.com would need to be allowed in the session's network settings.
- Found no recent (2020+) user complaints specific to NX dialogs, NX crashes or the Creo dashboard. The Creo dashboard material is historical (Wildfire 5 / Creo 1–2).
- Found no sourced user material on sketch "fully defined" status complaints, or on rebuild-time numbers for large assemblies.
- The SolidWorks 2024 and 2025 Top Ten List contents were not retrieved. The official 2024 recap only links to a video. The 2022 list exists ([EngineersRule 2022](https://www.engineersrule.com/the-results-are-in-top-eleven-solidworks-ideas-voted-at-3dexperience-world-2022/)) but was not fetched.

## Q2. Praised productivity and efficiency mechanisms

### Takeaway
The documented speed mechanisms are:
- **SolidWorks:** the S-key shortcut bar, right-drag mouse gestures, D-key breadcrumbs, Instant3D drag handles and Select Other.
- **NX:** Command Finder, three customisable radial menus plus a hold-RMB menu, Selection Intent rules, QuickPick, and a selection bar with type filter, scope and snap points that remembers state per command.
- **Creo:** the mini toolbar, the Smart selection filter, Flexible Modeling and mapkeys.

Power users stress reducing keystrokes (macros, mapkeys), bringing commands to the cursor, and staying in the graphics area.

### Cited Findings

**SolidWorks**
- [doc] **Shortcut bar (S key):** press S to open a customisable shortcut bar at the cursor. The bar is context-specific (part, assembly, drawing, sketch) and its key is rebindable on the Keyboard tab. — [SolidWorks Help 2024: Shortcut Bars](https://nexthelp.solidworks.com/2024/english/SolidWorks/sldworks/c_shortcut_bars.htm); [PLM Group: Tip: S for Shortcut](https://support.plmgroup.eu/hc/en-us/articles/360011817857-Tip-S-for-Shortcut)
- [doc] **Mouse gestures:** right-drag in the graphics area in a direction to run the mapped command, and release inside the guide to cancel.
  - The guide can show 2, 3, 4, 8 or 12 gestures; the default is 4. The 12-gesture layout is shown in the drawings example.
  - Gestures are customised per context in Tools > Customize > Mouse Gestures. Ctrl+drag copies a tool to another slot.
  - Mappings can be saved and restored separately with the Settings Wizard.
  - In assemblies, right-dragging on a component rotates it instead of opening the gestures. Drag in empty space, or use Alt+right-drag over a component.
  — [SolidWorks Help 2023: Mouse Gestures](https://help.solidworks.com/2023/english/SolidWorks/sldworks/c_mouse_sestures.htm); [SolidWorks Help 2018: Using Mouse Gestures](https://help.solidworks.com/2018/English/SolidWorks/Sldworks/t_using_mouse_gestures.htm); [SolidWorks 2025 tutorial: More about mouse gestures](https://help.solidworks.com/2025/English/swconntutorial/c_Closer_Look_at_Mouse_Gestures.htm)
- [reseller] A trainer calls mouse gestures "one of my favorite tools in SOLIDWORKS". — [Javelin: Increase your efficiency with the SOLIDWORKS UI (Jan 2025)](https://www.javelin-tech.com/blog/2025/01/increase-your-efficiency-with-the-solidworks-user-interface/) (via search snippet; the fetch returned empty)
- [doc/reseller] **Breadcrumbs:** "Selection Breadcrumbs" are part of the official UI. The D key brings breadcrumbs, or the confirmation corner, to the pointer "to reduce mouse travel". — [SolidWorks Help 2026: UI overview](https://help.solidworks.com/2026/english/SolidWorks/sldworks/c_user_interface_overview.htm); [Hawk Ridge: Useful keyboard shortcuts](https://hawkridgesys.com/blog/solidworks-useful-keyboard-shortcuts-workflow-customizations)
- [doc][historical, 2012 help] **Instant3D:** create and modify geometry with drag handles and on-screen rulers, in parts and assemblies. — [SolidWorks Help 2012: Instant3D](https://help.solidworks.com/2012/English/SolidWorks/Sldworks/Instant3D.htm)
- [doc] **Select Other:** right-click a face to hide it and see what is behind it. Items under the pointer and hidden faces are listed. — [SolidWorks Help 2026: Select flyout menu](https://help.solidworks.com/2026/English/SolidWorks/Sldworks/r_select_flyout_menu_general.htm); [SolidWorks Help: Selection overview](https://help.solidworks.com/2015/ENGLISH/SolidWorks/sldworks/c_Selection_Overview.htm)
- [reseller] A roundup of selection speed-ups. — [CATI: Speed up selections with SOLIDWORKS selection tools](https://www.cati.com/?p=127402) (not fetched)

**NX**
- [doc] **Command Finder:** type a command name in the "Find a Command" box and press Return. Results can be run directly and also show where the command lives in the ribbon or menu, so it teaches location as well as running the command. — [Siemens blog: NX Hints and Tips – Using Command Finder](https://blogs.sw.siemens.com/news/nx-hints-and-tips-using-command-finder/); [TU Darmstadt NX tutorial 3.5](https://www.iim.maschinenbau.tu-darmstadt.de/CAD-Tutorial/3_basics_in_nx/5_command_finder/index.en.html)
- [user][historical, 2014 NX 9] **Radial menus:**
  - NX has three customisable radial menus with 8 slots each. A user suggests assigning one per task group (basic modelling, sketching, synchronous).
  - A fourth radial menu opens on right-button hold. It is harder to customise and needs a pop-up menu file edit.
  — [GrabCAD tutorial: Radial menus in NX](https://workbench.grabcad.com/tutorials/the-use-of-radial-menus-in-siemens-nx); [Swoosh Tech: Customize radial menus in NX 9 (2014)](https://swooshtech.blogspot.com/2014/06/customize-radial-menus-in-nx-9.html)
- [doc] **Selection Intent:** curve rules such as Single Curve, Connected Curves, Tangent Curves and Curves in Group. Siemens says Connected Curves "saves considerable time". NX remembers the selection-intent setting, so users must check it before running a function. — [Siemens Designcenter blog: Delete Curve tips](https://blogs.sw.siemens.com/designcenter/nx-design-tips-tricks-delete-curve/); [LinkedIn Learning: Selection intent](https://origin-www.lynda.com/NX-tutorials/Selection-intent/716051/760575-4.html)
- [doc] **View shortcut menu:** Ctrl+MB3 opens the View shortcut menu "to avoid extra mouse travel". — [Siemens blog: Command Finder tips](https://blogs.sw.siemens.com/news/nx-hints-and-tips-using-command-finder/) (via search snippet)
- [doc/user] **QuickPick:** hold MB1 over ambiguous geometry for about half a second to get a list of candidates. Turning off "QuickPick on Delay" in Preferences > Selection makes it appear without the wait. — [Eng-Tips: default selection (Siemens evangelist answer)](https://eng-tips.com/threads/default-selection.368200); [Siemens support: QuickPick and preselection highlighting](https://support.sw.siemens.com/en-US/okba/PL8602975/Quick-Pick-and-Highlighting-/-Preselection-does-not-work/index.html)
- [doc] **Selection bar:**
  - The type filter is on the left. Some commands set it automatically, e.g., Edge Blend switches the filter to Edge.
  - Next to it is the Selection Scope drop-down: Within Work Part Only / Within Work Part and Components / Entire Assembly.
  - Snap-point toggles also live on the bar, with an "Enable Snap Point" master switch.
  - Snap-point toggle states "participate in the Dialog Memory mechanism", so they persist per command. There is no Customer Default for them.
  — [TU Darmstadt NX course 4.1.3.2](https://www.iim.maschinenbau.tu-darmstadt.de/kursunterlagen_archiv/cad_ss18_english/4132_additional_information.html); [Siemens support: Controlling default Snap Point choices](https://support.sw.siemens.com/en-US/okba/PL8016264/Controlling-the-default-Snap-Point-choices-in-NX-across-sessions/index.html); [Siemens blog: NX general selection filtering UI](https://blogs.sw.siemens.com/designcenter/nx-tips-and-tricks-general-selection-filtering-ui/)
- [doc] **Synchronous Technology:** works inside the history tree in NX, so users "no longer must choose between constraint-driven or history-free modeling". — [Siemens: Synchronous technology](https://sw.siemens.com/en-US/technology/synchronous-technology); [Siemens blog: Synchronous technology in history-based models](https://blogs.sw.siemens.com/news/synchronous-technology-in-history-based-models/)
- [reseller] Siemens "Timesaving clicks and tricks" series. — [Siemens NX blog Part 3](https://blogs.sw.siemens.com/nx-design/?p=6935) (not fetched)

**Creo**
- [doc][historical, Creo 5–6] **Mini toolbar:**
  - Creo 6.0 added feature mini toolbars for frequently used features in Part and Sheetmetal.
  - Right-click shows the mini toolbar plus the shortcut menu; a left click in the graphics area shows the mini toolbar alone.
  - Creo 5.0 had already moved common commands such as Edit Definition and Suppress from the right-click menu to the mini toolbar.
  — [PTC Help: Improved UX working with features (Creo 6)](https://support.ptc.com/help/creo/creo_pma/r6.0/usascii/whats_new_pma/fund-improved_user_experience_working_features.html); [PTC Help: Mini toolbar is improved (Creo 5)](https://support.ptc.com/help/creo_hc/creo30_pma_hc/usascii/whats_new_pma/FundMiniToolbar.html)
- [doc][historical, Creo 3 Tips PDF] **Smart selection filter:** first select higher-level items (features or components), then the Smart filter narrows the scope on later clicks, so users "spend less time changing filters". The same paper notes a drawback, but the excerpt was cut off. — [PTC Creo 3.0 Tips and Tricks PDF](https://www.ptcusercommunity.com/sejnu66972/attachments/sejnu66972/partassemblydesign/116534/2/Creo_3-0_Tips_and_Tricks.pdf)
- [doc] **Flexible Modeling:** a subset of direct modelling inside Creo Parametric. Edits "do not leverage or impact underlying features", and moves are stored as parametric features. Shape recognition can select a boss, a cut, or a boss with its rounds. — [PTC Help: About Creo Flexible Modeling](https://support.ptc.com/help/creo/creo_plus/usascii/part_modeling/flexible_modeling/about_flexible_modeling.html); [PTC Help: About selection in Flexible Modeling](https://support.ptc.com/help/creo/creo_plus/usascii/sheetmetal/sheetmetaldesign/About_Selection_in_PTC_Creo_Flex_Modeling.html)
- [doc] PTC's own list of Creo UI tips. — [PTC blog: 7 Creo UI tips](https://www.ptc.com/en/blogs/cad/7-cad-ui-tips-for-designing-in-creo) (not fetched)
- [user][historical, 2012] A power-user view: speed comes from reducing keystrokes "with customized macros/mapkeys" rather than from hardware. — [PTC Community: 3D Connexion 3D mice](https://community.ptc.com/t5/Creo-Modeling-Questions/3D-Connexions-3D-Mice/m-p/199839)

### Inferences
- The common pattern among praised features is **summon at the cursor**: S-key bar, D-key breadcrumbs, gestures, radial menus, mini toolbar and QuickPick. Wren should make one consistent "bring the commands here" invocation per input modality: a key on desktop, a long-press or Pencil squeeze on iPad, a long-press on phone.
- **Search as a teaching tool** (NX Command Finder shows where the command lives) is worth copying. SolidWorks 2026 also expanded search keywords to cover terms from other CAD tools; see Q3.
- **Smart, staged selection** (Creo Smart filter going from feature to face; NX Selection Intent rules; NX filters set automatically by the active command) reduces filter fiddling. Wren should have commands auto-set the pick filter, as NX Edge Blend does, rather than relying on manual filter bars.
- **Remembered per-command state** (NX Dialog Memory for snap points and intent) is liked but also catches users out ("make sure selection intent is set correctly"). Show remembered rules visibly in the command's inline panel.

#### Trademark notes (avoid these as Wren UI labels; describe the generic idea instead)
Likely marks or product-specific names:
- **SolidWorks / Dassault:** SOLIDWORKS, 3DEXPERIENCE, FeatureManager, PropertyManager, CommandManager, ConfigurationManager, Instant3D, DimXpert, eDrawings, Treehouse.
- **PTC:** Creo, Pro/ENGINEER, Wildfire, Flexible Modeling Extension, Mapkey.
- **Siemens:** NX, Designcenter, Synchronous Technology, Design Copilot NX, possibly QuickPick.
- **3Dconnexion:** SpaceMouse, CadMouse, Space Navigator.

Suggested generic names:
- "feature history tree" / "history list"
- "inline property panel"
- "drag handles" / "direct-drag editing"
- "pick-from-list for overlapping geometry"
- "command search"
- "radial / gesture menu"
- "selection rules"

Registration status was not verified in this research; see Gaps.

### Gaps
- No primary or sourced material found for: SolidWorks "Rapid Sketch", Design Checker, the "roll back bar", or Instant3D in current versions (only the 2012 help); Creo "insert here" in the model tree, Creo drag handles; NX role-based UIs (only an NX 5-era mention). These features exist, but their user praise or complaints could not be cited.
- The trademark registration status of the names above was not checked (no USPTO/EUIPO lookup).
- Little independent user praise was found for Creo Flexible Modeling or Smart selection. The sources are vendor documentation.

## Q3. Changes in 2023–2026 responding to feedback

### Takeaway
All three vendors are moving toward less clutter and faster pick-and-search:
- **SolidWorks** added a Simplified Interface mode (FD01 2025, expanded in 2026), wider command-search keywords, new Feature and Component selection filters with bindable shortcuts, background imports, and a Modify dimension box that no longer covers the dimension.
- **NX (rebranded Designcenter NX)** added press-and-drag curve creation alongside click-click, gesture-based commands, and an AI help copilot.
- **Creo 12** made smaller UI updates (contextual layer-tree commands, enhanced tooltips).
- **SolidWorks Top Ten:** ideas are implemented at a rate of about 65–70%.

### Cited Findings
- [doc][2025–2026] **SolidWorks Simplified Interface** (first in the February 2025 FD01 release, expanded in 2026): shows "the most commonly used commands, helping you focus on design, reduce distractions". Users can switch it on and off, and customisations made in that mode are saved. — [SolidWorks blog: What's new in SOLIDWORKS 2026 – Design](https://blogs.solidworks.com/products/solidworks/whats-new-in-solidworks-2026-design); [SolidWorks: What's new](https://www.solidworks.com/product/solidworks-design/whats-new)
- [reseller][2026] SolidWorks command search now uses expanded keywords, "even using terminology from other CAD software". — [CAD Software Direct: What's new in SOLIDWORKS 2026](https://blog.cadsoftwaredirect.com/?p=10051) (snippet)
- [reseller][2026] Other SolidWorks 2026 UI/UX items:
  - The Import Model task-pane tab queues imports and processes them in the background so the session stays usable.
  - A status-bar icon reveals messages the user has dismissed.
  - Manager Pane tabs can be hidden via right-click > Customize.
  - The **Modify dimension box now opens away from the dimension so it no longer covers it**.
  - New **Feature Filter** and **Component Filter**; Component Filter picks only top-level parts and subassemblies, as an alternative to breadcrumbs or the tree.
  - Keyboard shortcuts can be assigned to the filters for surface bodies, solid bodies, midpoints, center marks and centerlines.
  - A display-scaling prompt appears on monitors with mixed DPI.
  — [GoEngineer: SOLIDWORKS 2026 UI/UX, performance & imports](https://www.goengineer.com/blog/solidworks-2026-ui-ux-performance-and-imports-whats-new)
- [reseller][2026] The Toolbox upgrade warning now shows only once. — [SolidWorks reseller blog (EGS India)](https://solidworksreselleregsindia.blogspot.com/2026/01/whats-new-in-solidworks-2026-user.html)
- [doc][2026] The April 2026 FD02 update brings folder and organisation flexibility into the Open dialog. — [SolidWorks: What's new](https://www.solidworks.com/product/solidworks-design/whats-new) (snippet)
- [doc] **Top Ten List background:** it has run since 2001, with results presented at SOLIDWORKS World / 3DEXPERIENCE World. Implementation rate: "close to 70%" (2024 blog); 65% of 2001–2021 ideas implemented (2022 write-up). The 2023 list had 12 ideas because of ties. — [SolidWorks blog: Recap of Top Ten List 2024](http://blogs.solidworks.com/products/solidworks/recap-of-top-ten-list-3dexperience-world-2024); [EngineersRule 2022](https://www.engineersrule.com/the-results-are-in-top-eleven-solidworks-ideas-voted-at-3dexperience-world-2022/)
- [doc][2025] **Designcenter NX (June 2025):**
  - "Curve Creation now supports both traditional and modern interaction methods": click-click and press-and-drag.
  - Tangent sliding, dynamic snapping and gesture-based commands are cited as usability improvements made in response to feedback.
  — [Siemens NX blog: What's new in NX June 2025 – Core Design](https://blogs.sw.siemens.com/nx-design/whats-new-in-nx-core-design/)
- [doc][2025] Designcenter X Essentials: new designs can start from the landing page without setting up a full project, and a modelling settings panel is available inside the design environment. — [Siemens: What's new June 2025 X Essentials](https://blogs.sw.siemens.com/designcenter/whats-new-june-2025-x-essentials/)
- [doc][2025] Design Copilot NX: an AI natural-language assistant for learning and documentation. — [Digital Engineering 24/7](https://www.digitalengineering247.com/article/siemens-brings-ai-copilot-immersive-design-to-nx/virtual-reality-and-augmented-reality); [IT Brief UK](https://itbrief.co.uk/story/siemens-updates-nx-platforms-with-ai-copilot-mixed-reality-tools)
- [doc][Dec 2025] NX Algorithmic Features now update as the input context changes, "consistent with Designcenter NX's overall user interface philosophy" (live update). — [Siemens Designcenter blog](https://blogs.sw.siemens.com/designcenter/?p=12655) (snippet)
- [doc][2025] Creo 12.4: "modernized contextual commands for the Layer Tree". Creo 12 marketing cites "enhanced tool tips" and "over 250" updates in total. — [PTC Help: Creo 12 What's New – Layer tree commands](https://support.ptc.com/help/creo/creo_pma/r12/usascii/whats_new_pma/ux_layer_tree_commands.html); [CIMdata: Creo 12 commentary](https://www.cimdata.com/zh/news/item/28152-creo-and-creo-12-commentary); [PTC: New in Creo](https://ptc.com/en/products/creo/whats-new)
- [doc][2025] Creo 12 Expert Moldbase: component operations moved to the mini toolbar. — [PTC Help: EMX 12 mini toolbar](https://support.ptc.com/help/emx/r12.0.0.0/en/EMX/whatsnew-comp_ops_mini_toolbar.html)

### Inferences
- SolidWorks' "Simplified Interface" is an implicit admission that the full CommandManager is too cluttered for many users. Wren should start minimal and grow, rather than shipping a full ribbon with a "simple" toggle.
- The 2026 change to the Modify dimension box (it no longer covers the dimension) supports Wren's inline-value principle: entry fields must never hide the thing being edited.
- NX adding press-and-drag next to click-click sketching matters for Wren's touch and Pencil targets. Both interaction styles are expected now.

### Gaps
- Found no detailed Creo 10 or Creo 11 UI change list. The NX 2023–2024 (NX 2306/2312/2406) UI changes were not retrieved.
- Found no user reaction (positive or negative) to SolidWorks' Simplified Interface or to Designcenter NX's UI changes.

## Q4. Conventions users moving between tools want kept consistent

### Takeaway
Mouse-button mappings for orbit, pan and zoom, and the direction of scroll-wheel zoom, are the most-cited pain points when switching tools. Users reach for config flags (Creo `USE_INVERTED_MOUSEWHEEL_ZOOM`), third-party remappers or AutoHotkey when no preset exists. Box-select direction semantics (left-to-right encloses, right-to-left crosses) are shared with AutoCAD-style conventions.

### Cited Findings
- [doc] **SolidWorks middle-button defaults:** MMB-drag rotates, Ctrl+MMB-drag pans, Shift+MMB-drag zooms. SolidWorks help notes that mouse-driver wheel settings can override its own settings, and suggests turning the driver's wheel feature off if they conflict. — [SolidWorks Help 2023: Middle Mouse Button Functions](https://help.solidworks.com/2023/English/SolidWorks/sldworks/r_Middle_Mouse_Button.htm)
- [doc/user] **Creo wheel direction:** PTC has a knowledge-base article on reversing wheel zoom (CS133100, last modified Jan 2026). The community answer is the config.pro option `USE_INVERTED_MOUSEWHEEL_ZOOM YES`, and a session-only setting reportedly did not persist. — [PTC KB CS133100](https://www.ptc.com/en/support/article/CS133100); [PTC Community: reverse mouse wheel direction once for all](https://community.ptc.com/t5/Part-Modeling/How-to-reverse-mouse-wheel-direction-once-for-all/m-p/599968)
- [user] **SolidWorks wheel direction:** a community question on scroll-wheel zoom direction. — [3DSwym: mouse scroll wheel zoom direction](https://3dswym.3dexperience.3ds.com/question/solidworks-news-info/mouse-scroll-wheel-zoom-direction_3889)
- [user] **Creo button remapping:** users who asked to remap Creo's middle button were pointed to third-party mouse software or AutoHotkey, and one said the scripts did not change the MMB behaviour. One user's preferred layout: "pan with the middle mouse button pressed and orbit with SHIFT+MMB". — [PTC Community: Middle mouse button customization](https://community.ptc.com/t5/3D-Part-Assembly-Design/Middle-Mouse-button-customization/m-p/222641)
- [user] **Navigation presets:** a CATIA V5 preset exists in Creo View, but "in Creo Parametric this functionality is not implemented" (per the thread). — [PTC Community: Set mouse navigation mode in Creo Student Edition](https://community.ptc.com/t5/PTC-Education-Forum/How-to-Set-the-Mouse-Navigation-Mode-in-Creo-Student-Edition/m-p/714360)
- [user][historical, NX7] **NX defaults:** MMB-drag rotates, LMB+MMB-drag zooms, RMB+MMB-drag pans (older post). A user also asked whether NX bindings can be remapped to mimic CATIA V4. — [Eng-Tips: NX7 model manipulation settings](https://eng-tips.com/threads/nx7-model-manipulation-settings.267176); [Eng-Tips: mouse button assignments in NX](https://eng-tips.com/threads/mouse-button-assignments-in-nx-2.102210)
- [doc][historical, 2011+] **Box-select direction (SolidWorks):** dragging left-to-right selects only items fully inside the box. Right-to-left ("cross selection") also selects items that cross the boundary. — [SolidWorks Help 2020: Box Selection](https://help.solidworks.com/2020/English/SolidWorks/sldworks/c_Box_Selection.htm); [SolidWorks Help 2017: Cross Selection](https://help.solidworks.com/2017/English/SolidWorks/sldworks/c_Cross_Selection.htm); [Javelin: Which way do I box-select? (2011)](https://www.javelin-tech.com/blog/2011/09/box-select/)

### Inferences
- Wren should ship navigation presets ("SolidWorks-like", "Creo-like", "NX-like", plus Onshape/Fusion-like, verified separately), an independent invert-zoom toggle and zoom-to-cursor from day one. These are the things users currently hack together with config flags and AutoHotkey.
- Keep the left-to-right "enclose" vs right-to-left "cross" box semantics. They are an established cross-tool convention (SolidWorks, AutoCAD lineage), and the direction can be signalled with solid vs dashed box outlines. That rendering detail is common practice but was not sourced here.

### Gaps
- Found no current (2023+) authoritative default mouse mapping for Creo Parametric or NX. The NX mapping above is from NX7 forum posts.
- No sourced material was found on view-cube behaviour differences or on consistency of keyboard shortcuts between tools.

## Q5. Low-level input efficiency (gestures, context menus, mouse buttons, wheel, double-click, hover, box select, hidden picks, SpaceMouse)

### Takeaway
These mechanisms are well documented. Users praise gestures and radial menus when they are fast and directional. They complain when gestures need precise hovering, when pop-ups lag under the cursor, when right-click menus are truncated or change with context, and when mouse conventions differ between tools. 3D mice are praised for SolidWorks and NX, though the evidence is vendor-sponsored, and are viewed sceptically by some Creo users.

### Cited Findings

**Mouse gestures and radial menus**
- [doc] SolidWorks gestures: right-drag; 2/3/4/8/12 directions (default 4); assignments are per context and customisable; Alt+right-drag over a component (otherwise right-drag rotates the component). — [SolidWorks Help 2023](https://help.solidworks.com/2023/english/SolidWorks/sldworks/c_mouse_sestures.htm); [SolidWorks Help 2018](https://help.solidworks.com/2018/English/SolidWorks/Sldworks/t_using_mouse_gestures.htm)
- [doc] DraftSight (the Dassault 2D product) uses the same mouse-gesture concept. — [SolidWorks Help 2025: DraftSight mouse gestures](https://help.solidworks.com/2025/english/DraftSight/additional/mg_mouse_gesture_Using_Commands.htm); [GoEngineer: DraftSight mouse gestures](https://www.goengineer.com/en-us/blog/draftsight-mouse-gestures)
- [user/doc] NX: three customisable 8-slot radial menus plus a hold-RMB radial menu. A complaint after an update: the radial menu needed a direct hover over the item instead of a directional flick. — [GrabCAD tutorial](https://workbench.grabcad.com/tutorials/the-use-of-radial-menus-in-siemens-nx); [Eng-Tips: radial menu selection gestures](https://www.eng-tips.com/threads/radial-menu-selection-gestures.460281)
- [doc][2025] Designcenter NX cites "gesture-based commands" as a recent usability improvement. — [Siemens NX blog June 2025](https://blogs.sw.siemens.com/nx-design/whats-new-in-nx-core-design/)
- [doc] Creo's nearest equivalent is the mini toolbar on click or right-click plus the shortcut menu (Creo 5/6). A directional gesture system for Creo was not found. — [PTC Help Creo 6](https://support.ptc.com/help/creo/creo_pma/r6.0/usascii/whats_new_pma/fund-improved_user_experience_working_features.html)

**Right-click and context menus**
- [doc] SolidWorks shows short menus by default with a chevron to expand; "Show All" turns this off. — [SolidWorks 2015 What's New](https://help.solidworks.com/2015/English/WhatsNew/c_shortcut_menu_enhancements.htm)
- [user] Users dislike the extra click on the chevron. — [SolidWorks forum 228019](https://forum.solidworks.com/thread/228019)
- [user] Another user asks how to stop the right-click menu appearing at all, which shows a conflict with gestures and context toolbars. — [3DSwym: How do I stop right click menu from appearing](https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/how-do-i-stop-right-click-menu-from-appearing_bHhTMAPxTQ6i2vurB2wR6g) (not fetched)
- [user][historical] Creo RMB menu contents vary by the active ribbon tab, and holding Alt is the workaround. — [PTC Community WF5 drawing ribbon menus](https://community.ptc.com/t5/3D-Part-Assembly-Design/WF5-Drawing-ribbon-Menus/m-p/406175)
- [user] Onshape users report the same "too long" problem: "it starts to slow me down when the right-click menu gets too long". This is outside the three tools but corroborates the point. — [Onshape forum](https://forum.onshape.com/discussion/comment/107626)
- [user][historical, 2010] Left-click context toolbar lag leads to mis-clicks ("clicking on something 'behind' the menu"). — [3DSwym 2010 thread](https://3dswym.3dexperience.3ds.com/post/solidworks-user-forum/who-else-hates-the-left-click-pop-up-menu_0eLbRZLgSEyXF4-T8uhSOg)
- [doc] NX Ctrl+MB3 opens a dedicated View shortcut menu, so view commands are separated from object commands. — [Siemens blog](https://blogs.sw.siemens.com/news/nx-hints-and-tips-using-command-finder/)

**Middle button, wheel and zoom direction:** see Q4. In short, there is no common default; Creo needs a config.pro flag to invert wheel zoom, and remapping Creo MMB needs third-party tools.

**Hidden and overlapping geometry picks**
- [doc] SolidWorks Select Other: right-click a face to hide it temporarily; a list shows the items under the pointer, including hidden faces. — [SolidWorks Help 2026: Select flyout](https://help.solidworks.com/2026/English/SolidWorks/Sldworks/r_select_flyout_menu_general.htm)
- [doc/user] NX QuickPick: hold MB1 about 0.5 s over geometry to get a candidate list; the delay can be disabled. — [Eng-Tips: default selection](https://eng-tips.com/threads/default-selection.368200)
- [doc] Hidden-edge selectability in SolidWorks is a system option (Tools > Options > Selection). In drawings, hidden edges and faces are not selected. The help versions are inconsistent on the default. — [SolidWorks Help 2020: Box Selection](https://help.solidworks.com/2020/English/SolidWorks/sldworks/c_Box_Selection.htm); [SolidWorks Help 2015: Selection overview](https://help.solidworks.com/2015/ENGLISH/SolidWorks/sldworks/c_Selection_Overview.htm)

**Box and lasso direction:** left-to-right encloses, right-to-left crosses (SolidWorks). Users report right-to-left ignoring selection filters. — [SolidWorks Help 2020](https://help.solidworks.com/2020/English/SolidWorks/sldworks/c_Box_Selection.htm); [3DSwym report](https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/right-to-left-box-selection-not-working-with-selection-filters_TQ11RdHORmu63PNhInTQnA)

**Hover pre-highlighting**
- [doc] SolidWorks documents highlighting and dynamic preselection highlighting as part of selection. — [SolidWorks Help 2013: Selection overview / Highlighting](https://help.solidworks.com/2013/English/SolidWorks/sldworks/c_Selection_Overview.htm)
- [doc] NX documents "Highlighting / Preselection" alongside QuickPick, and there is a support article for the failure case where preselection highlighting does not work. — [Siemens support PL8602975](https://support.sw.siemens.com/en-US/okba/PL8602975/Quick-Pick-and-Highlighting-/-Preselection-does-not-work/index.html)

**3D mouse (SpaceMouse)**
- [study, vendor-promoted][historical, 2018] Fraunhofer IAO lab and field study, with participants doing a standardised task in Siemens NX: 29% fewer hand movements and a 28% productivity increase with a 3D mouse. The sample was small (24 participants) and the vendor promoted the results. — [Fraunhofer IAO ergonomic report 2018 (PDF)](https://moodle2.units.it/pluginfile.php/390870/mod_resource/content/1/Ergonomic_Report_3D_Mouse_FraunhoferIAO_2018.pdf); [Digital Engineering 24/7: 3D mice improve ergonomics](https://digitalengineering247.com/article/3d-mice-improve-ergonomics-at-cad-workstations-study-shows)
- [reseller] SolidWorks applications engineer: programmable SpaceMouse and CadMouse buttons for the most-used commands reduce menu navigation time. — [Visiativ: Using the 3Dconnexion SpaceMouse with SOLIDWORKS](https://visiativ.co.uk/news-resources/using-the-3dconnexion-spacemouse-with-solidworks/)
- [doc/vendor] NX: commands can be mapped to 3D-mouse buttons or radial menus, and the configuration adapts to the active NX environment. Mapping should be done in NX's own Button Mapping Editor, which takes priority over the 3Dconnexion control panel. — [3Dconnexion: NX](https://3dconnexion.com/applications/siemens-nx/); [3Dconnexion forum](https://forum.3dconnexion.com/viewtopic.php?p=19198)
- [user][historical, 2012] Creo sceptic: 3D mice "are not a means of significant productivity gains in Creo"; gains come from mapkeys. Another user notes that Creo's heavy Ctrl/Alt/Shift use strains the left hand and suggests putting those modifiers on the device. — [PTC Community: 3D Connexions 3D mice](https://community.ptc.com/t5/Creo-Modeling-Questions/3D-Connexions-3D-Mice/m-p/199839)
- [doc] Two-handed workflow article. — [Machine Design: Two-handed workflow improves efficiency](https://www.machinedesign.com/3d-printing-cad/article/21837115/two-handed-workflow-improves-efficiency-for-cad-professionals) (not fetched)

### Inferences
- For gestures and radial menus, accept direction plus a distance threshold (a "flick"), not only a precise hover. The NX regression complaint shows users notice when this breaks. This maps directly to Pencil and touch flicks on iPad and phone.
- Overlapping-geometry picking needs a dedicated, fast mechanism: SolidWorks' list plus hide-face, or NX's hold-to-list. On touch, a long-press that shows a candidate list is the natural port.
- Context menus should be stable across modes. Separating view commands from object commands (NX Ctrl+MB3) is a pattern worth considering.
- For WebHID support of 3D mice in a browser PWA, the SolidWorks and NX users who rely on them will expect basic orbit, pan and zoom, plus mapped buttons. The productivity gain itself is mostly evidenced by vendor-backed numbers.

### Gaps
- **Double-click behaviour:** no sourced material was found for any of the three tools, e.g. SolidWorks double-click on a feature to show its dimensions and double-click a dimension to edit it, or Creo double-click to edit a value. These are known behaviours but uncited here.
- **Zoom-to-cursor:** no sourced user commentary found for any of the three tools.
- No sourced user opinions on hover pre-highlight (only documentation), and no data on the 4- vs 8- vs 12-gesture choice or on how many users enable gestures.
- Found no sourced material on Creo's right-mouse hold behaviour or on Creo gesture equivalents beyond the mini toolbar.

## Q6. How SolidWorks, Creo and NX orbit the view (rotation model, pivot, speed, constraints, keys)

### Takeaway
All three default to **free (trackball-style) rotation about a pivot**, not a turntable that keeps the world up axis level. Their pivot choices differ:
- **SolidWorks** pivots about the model centroid when the whole model is in view, and otherwise about nearby visible geometry, shown in magenta. Middle-clicking an entity locks the pivot to that entity.
- **Creo** pivots about a "Spin Center". It can be shown or hidden, or turned off so that the orientation center follows the pointer. Creo offers several orient types (Dynamic is the default; also Anchored, Delayed, Velocity and Fly Through).
- **NX** uses a temporary rotation point while MB2 is held over geometry, after a hold delay that is configurable. A persistent rotate point can also be set.

The documented failure mode is **a pivot that lands in empty space**, which makes the model slide or spin off screen (Creo forum, 2015). Freeform-modelling users ask for turntable mode because trackball orbit introduces roll.

### Cited Findings

**SolidWorks**
- [doc] **Pivot.** Middle-drag rotates the view. With the whole model in view, the centre is the model centroid. Otherwise SolidWorks picks a point on visible geometry and highlights the entity and rotation point in magenta while rotating. — [SolidWorks Help 2021: Middle Mouse Button Functions](https://help.solidworks.com/2021/English/SolidWorks/sldworks/r_Middle_Mouse_Button.htm); [SolidWorks blog (J. Wilkinson, 2009, historical): "How do I manipulate my model view; let me count the ways"](https://blogs.solidworks.com/products/solidworks/how-do-i-manipulate-my-model-view-let-me-count-the-ways/)
- [doc] **Rotate About Entity.** Single middle-click a vertex, edge, face, plane or sketch entity (it highlights), then middle-drag. Rotation is about that entity until the button is released. Not available while editing a sketch. — [SolidWorks Help 2017: Rotate View](https://help.solidworks.com/2017/English/solidworks/sldworks/t_rotate_view.htm); [SolidWorks blog 2009](https://blogs.solidworks.com/products/solidworks/how-do-i-manipulate-my-model-view-let-me-count-the-ways/)
- [user] **Gotcha.** Middle-clicking and dragging immediately, without releasing, can switch the cursor to rotate-about-axis, "and that is when things can go haywire". — [SolidWorks forum thread 212048](https://forum.solidworks.com/thread/212048) (via search snippet)
- [doc] **Roll.** Alt+middle-drag rolls the view parallel to the screen about the centroid. — [SolidWorks blog 2009](https://blogs.solidworks.com/products/solidworks/how-do-i-manipulate-my-model-view-let-me-count-the-ways/)
- [doc] **Arrow keys.** Arrow keys rotate by a preset increment about the centroid, around the screen's horizontal and vertical axes. This is constrained screen-axis rotation. Shift+Arrow rotates 90°. Alt+Left/Right rolls by the increment.
  - The increment is set in Tools > Options > System Options > View > View rotation and stored in radians in the API.
  - A mouse-speed slider there sets rotation sensitivity (left is finer and slower). It applies to Rotate View, Rotate About Entity, Roll View and Turn Camera.
  — [SolidWorks Help 2017: View Options (View rotation)](https://help.solidworks.com/2017/English/SolidWorks/sldworks/HIDD_OPTIONS_VIEW_ROTATION.htm); [SolidWorks API: swUserPreference View constants](https://help.solidworks.com/2023/English/api/swconst/SO_View.htm); [SolidWorks blog 2009](https://blogs.solidworks.com/products/solidworks/how-do-i-manipulate-my-model-view-let-me-count-the-ways/)
- [reseller][historical] An older tutorial says the default arrow-key step is 15°. Current help does not state the default. — [Javelin 2013: Keyboard and mouse – controlling the viewport orientation](https://www.javelin-tech.com/blog/2013/11/solidworks-tutorial-keyboard-and-mouse-controlling-the-viewport-orientation/) (via search snippet)
- [doc] **Reference triad.** Alt+click a triad axis rotates about that axis by the increment, and Ctrl+Alt+click rotates the opposite way. Shift+click rotates 90°, and Ctrl+Shift+click rotates 90° the opposite way. — [SolidWorks blog 2009](https://blogs.solidworks.com/products/solidworks/how-do-i-manipulate-my-model-view-let-me-count-the-ways/)
- [doc] The only "reverse" option under View is for wheel zoom direction. No reverse-rotation or turntable ("rotate about floor") option was found. — [SolidWorks Help 2017: View Options](https://help.solidworks.com/2017/English/SolidWorks/sldworks/HIDD_OPTIONS_VIEW_ROTATION.htm)

**Creo Parametric**
- [doc] **Orient types (Creo 9 help).** In Orient Mode the orientation center is shown with an icon specific to each type:
  - **Dynamic (default):** the view updates live and the model "spins freely about the Orientation Center".
  - **Anchored:** rotation depends on the direction and distance from the mouse-down point. The icon changes colour at each 90° interval, and returning to the mouse-down point restores the starting view.
  - **Delayed:** the orientation updates only on MMB release.
  - **Velocity:** spin speed and direction depend on the pointer's distance from its start.
  - **Fly Through:** flight-sim style, perspective only.
  — [PTC Help Creo 9: About Orient Types](https://support.ptc.com/help/creo/creo_pma/r9.0/usascii/fundamentals/fundamentals/about_orient_types.html); [PTC Help Creo 9: About Orient Mode](https://support.ptc.com/help/creo/creo_pma/r9.0/usascii/fundamentals/fundamentals/About_Orient_Mode.html)
- [doc] **Spin Center.**
  - The orientation center is locked at the Spin Center. When the Spin Center is disabled, it can be anywhere in the graphics window.
  - The Orient-mode right-click menu has Show/Hide Spin Center.
  - The config option `spin_with_orientation_center no` turns off the orientation center during spin, pan and zoom. It cannot be disabled while in Orient mode.
  — [PTC Help Creo 9: About Disabling the Orientation Center](https://support.ptc.com/help/creo/creo_pma/r9.0/usascii/fundamentals/fundamentals/About_Disabling_Orientation_Center.html); [PTC Help: Spin Center](https://support.ptc.com/help/creo/creo_plus/usascii/simulate/simulate/spin_center_on_off.html)
- [user][historical, 2015, Creo 2] **The "flies away" complaint.** In "Model Spins Off Screen" (dgschaefer, 21 May 2015): on first opening a model, MMB-spinning on empty screen space makes the model slide off screen. The spin center seems to be "a couple of hundred feet behind my head". A Space Navigator does the same until MMB has been clicked on the model once. The poster had Spin Center turned off.
  - Replies suggested clicking the model first, toggling the Spin Center on, or setting the spin center via Reorient > Preferences ("Point or vertex" / "Screen center"), plus a mapkey on F4 to set a new spin center.
  - Another user confirmed: "I've definitely seen it."
  - Imported models with floating coordinate systems were also suspected, but the poster saw it in "all models".
  - No fix; the poster said it was "Probably not solvable".
  — [PTC Community: Model Spins Off Screen](https://community.ptc.com/t5/3D-Part-Assembly-Design/Model-Spins-Off-Screen/m-p/373014)
- [user] There are more threads on Spin Center behaviour with 3Dconnexion devices, and one user asks why a dynamic spin-center toggle was removed (no definitive answer). — [PTC Community: Spin center with 3Dconnexion mouse](https://community.ptc.com/t5/3D-Part-Assembly-Design/Spin-center-with-3Dconnexion-mouse/m-p/752128); [3Dconnexion forum](https://forum.3dconnexion.com/viewtopic.php?p=73349); [PTC Community: modeling spin center](https://community.ptc.com/t5/Part-Modeling/modeling-spin-center/m-p/197647) (snippets)

**NX**
- [user][historical, NX5–NX9] **Temporary rotate point.** Place the cursor over an edge, face or vertex and press and hold MB2. A temporary rotate point appears and is used while MB2 is held. In NX5 this needed about a 1 s hold without moving.
  - An NX9 user complains that the centre resets as soon as the button is released.
  - A reply points to the Customer Default Visualization > "Rotation point delay" (set to 0 to use the cursor position immediately). This is unconfirmed by Siemens text.
  — [MCAD Central: temporary rotation point in NX5](https://www.mcadcentral.com/threads/temporary-rotation-point-in-nx5.26409); [Eng-Tips: View rotation centre NX9](https://eng-tips.com/threads/view-rotation-centre-nx9.374425) (snippet; 403 on fetch); [DRWE blog: Rotation point delay](https://www.drwe.de/en/blog/tips-tricks-8/rotation-point-delay-385) (title only)
- [doc] **Persistent rotate point.** MB3 in the graphics area > "Set Rotate Point". Ctrl+F2 (Set Rotation Reference) is the default shortcut in NX 8.5. Siemens also documents setting the rotation point for a spaceball and creating hotkeys for Set/Clear Rotate Point. — [Siemens support: hotkey for Set/Clear Rotate Point](https://support.sw.siemens.com/en-US/okba/PL8010245/How-to-create-a-hotkey-for-Set-Rotation-Point-or-Clear-Rotate-Point/index.html); [Siemens support: rotation point for a spaceball](https://support.sw.siemens.com/en-US/okba/PL8009918/Setting-the-rotation-point-for-a-spaceball/index.html) (titles and snippets; login-gated)
- [user] An Eng-Tips thread asks to "fix the rotation point to screen center", so some users want a fixed pivot. — [Eng-Tips](https://www.eng-tips.com/threads/fix-the-rotation-point-to-screen-center.336769) (title only)
- [user][historical, 2011] **Constrained screen-axis rotation.** With the Rotate tool active, moving the cursor near the left or right edge of the window rotates about the view X axis, and near the top or bottom edge about the Y or Z axis. — [Unigraphics basics blog (2011)](https://unigraphicsbasicsnmaterial.blogspot.com/2011/11/rotating-view-of-model-in-3d-space.html)
- [doc] Siemens has a KB article "How to rotate horizontally about the screen", which is login-gated, so its steps were not read. — [Siemens support PL8010760](https://support.sw.siemens.com/en-US/okba/PL8010760/How-to-rotate-horizontally-about-the-screen/index.html)
- [user] F8 snaps to the nearest orthogonal view, and Ctrl+R is cited as a keyboard rotate. — [Eng-Tips: middle mouse button functionality](https://eng-tips.com/threads/middle-mouse-button-functionality.343652) (snippet)
- [user] One user reports that MB2 shows "two concentric orange circles" (the rotate-point indicator) but does not rotate; no resolution. — [Eng-Tips: MB2 refuses to rotate](https://www.eng-tips.com/threads/middle-mouse-button-refuses-to-rotate-the-model.417215) (snippet)

**Turntable vs trackball (cross-tool user sentiment)**
- [user][2016–2025] In the Onshape forum thread "Can I change the orbit mode to something like SketchUp":
  - Lee_Hesketh (2016): "Ideally I would like to see an option to switch between turntable and trackball", complaining that the view "rolls and tilts" and cannot be returned to the desired view.
  - øyvind_kaurstad (2016): "MCAD"-style orbit is considered superior by some, but he prefers the other main type.
  - 3dcad (2016): a user with a 3D mouse and MCAD background finds free orbit works well.
  - Onshape added "Constrained Rotate" (Alt+right-drag), and by January 2025 a preference "Set default rotation behaviour to constrained rotate" (reported by Aydan_Boynton).
  This is outside the three tools, but it is the clearest user statement of the trade-off. — [Onshape forum discussion 4285](https://forum.onshape.com/discussion/4285/can-i-change-the-orbit-mode-to-something-like-sketchup)
- [user] Another Onshape thread explains the trackball roll problem: "the farther the mouse is from the center of the viewport, the more it influences the roll angle". It also gives the pivot rule: start on the model to rotate about that point, start on blank background to rotate about the model center. — [Onshape forum comment 19592](https://forum.onshape.com/discussion/comment/19592); [Onshape forum comment 86040](https://forum.onshape.com/discussion/comment/86040) (snippets)

### Inferences
- **Pivot rules users of these tools expect:**
  - Orbit about geometry under the cursor when the drag starts on geometry.
  - Fall back to the model or visible-geometry centroid when it starts on empty space. **Never** fall back to a world-origin or far-off point; the Creo "spin center a couple of hundred feet behind my head" failure is exactly the bug to avoid.
  - Show the pivot during the drag (SolidWorks magenta highlight, Creo spin-center icon, NX orange circles).
  - Allow an explicit entity pivot (SolidWorks middle-click entity, NX Set Rotate Point).
- **Rotation model:** SolidWorks, Creo and NX all default to free (trackball-style) rotation. MCAD switchers will feel a turntable default as "off", and freeform/SketchUp users feel trackball as "off". Offer both: a free-orbit default for MCAD presets, plus a turntable or constrained option. Onshape's later change (2025 preference) shows demand for a toggle, not only a modifier key.
- **Precise orientation:** provide keyboard arrow-key rotation about screen axes with a configurable step (an older default of 15° is reported for SolidWorks), Shift+Arrow for 90°, and Alt+Left/Right roll. These give constrained screen-axis rotation without a mouse. They map well to on-screen step buttons on iPad and phone.
- **Sensitivity:** SolidWorks exposes a single speed slider for all rotate modes. Creo's Velocity and Anchored types show that some users prefer non-direct-manipulation modes, but Dynamic is the default. Wren should offer one sensitivity setting and make direct, proportional rotation the default.
- **Inertia:** no evidence was found that any of the three tools spins on after release by default (see Gaps). MCAD users likely expect none; that is an inference.

### Gaps
- **Inertia:** found no source documenting whether SolidWorks, Creo or NX apply rotational inertia ("flick to spin") by default, or what users think about it.
- No sourced numeric defaults for rotation sensitivity in any tool, and only an older, unverified 15° arrow-key default for SolidWorks. No Creo or NX arrow-key rotation step was found.
- Current (2023+) NX rotation-point preferences and the steps of Siemens KB PL8010760 could not be read: the KB is login-gated and the Eng-Tips threads returned 403.
- No source compared what SolidWorks, Creo and NX do when the drag starts on empty space while the model is only partly in view, beyond SolidWorks' "nearby visible geometry" rule.
- Creo's handling of constrained rotation about screen axes (if it has any) was not found.
