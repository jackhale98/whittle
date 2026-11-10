# UX of 2D engineering drawings in CAD tools: what users praise and complain about (for Wren M4)

Legend used in findings: **[Fact]** documented behaviour (vendor help/release notes); **[Vendor claim]** marketing statement; **[Opinion]** user/forum/reseller view; **[Historical]** source older than 2020. Trademarked/vendor-specific feature names are flagged with (TM-ish) on first use so Wren can choose generic terms; a glossary of suggested generic names is at the end of the Recommendations section.

Research caveats (affect confidence): forums.autodesk.com and autodesk.com blog returned HTTP 403 to the fetch tool (only search snippets were usable); wiki.freecad.org was blocked by a bot wall; cadforum-net.dezignstuff.com (the "SOLIDWORKS pet peeves" thread) is not reachable from this session's network. Reddit threads did not surface in search results at all, so r/SolidWorks, r/onshape, r/Fusion360, r/FreeCAD opinions are under-represented — community opinion here comes mainly from vendor forums, Eng-Tips, PTC Community, Onshape forum and Shapr3D Discourse.

---

## 1. Workflows per tool (view creation/placement, alignment/projection, dimensioning)

### Takeaway
Every mature tool converges on the same skeleton — drop a base view (often from a palette of standard orientations), project children that stay aligned to the parent, then get dimensions either by importing model/PMI dimensions or by a "smart" single dimension tool — and the 2024–2026 differentiator is automation (Fusion Drawing Automation + Auto Dimension; SOLIDWORKS 2026 AI drawing generation) layered on top of that skeleton.

### Cited Findings

**SOLIDWORKS**
- [Fact/Reseller] Views can be created by dragging predefined orientations from the **View Palette** (TM-ish name) onto the sheet; resellers recommend then using **Insert Model Items** (TM-ish) instead of recreating dimensions by hand — [CADimensions](https://www.cadimensions.com/?p=3822); [GoEngineer: Inserting Model Dimensions](https://www.goengineer.com/blog/inserting-model-dimensions-into-solidworks-drawing)
- [Fact] Model Items imports dimensions/annotations from the part or assembly with a source scope of "Entire Model" or "Selected Feature"; Shift-drag moves a dimension to another view, Ctrl-drag copies it, but only to views whose orientation suits the dimension — [Javelin Model Items tip](https://www.javelin-tech.com/blog/?p=56412); [CATI](https://www.cati.com/?p=120454)
- [Fact] Inserted model dimensions are bidirectional: changing the model updates the drawing, and changing an inserted (driving) dimension in the drawing changes the model — [SOLIDWORKS help 2017, Inserting Dimensions into Drawings](https://help.solidworks.com/2017/english/SolidWorks/sldworks/c_Inserting_Dimensions_into_Drawings.htm)
- [Fact] **Rapid Dimension** (TM-ish) is an on-canvas placement selector shown while inserting drawing dimensions, whose purpose is placing dimensions evenly spaced; it can be turned off in the Dimension PropertyManager and the setting persists — [SOLIDWORKS help 2017, Rapid Dimension](https://help.solidworks.com/2017/english/SolidWorks/sldworks/c_Dimension_Placement_Manipulator.htm) (2017 page; feature still current)
- [Fact] A "dimension palette" pops up when inserting or selecting a dimension for quick formatting/tolerance changes — [SOLIDWORKS help 2022, Formatting Dimensions in Drawings](https://help.solidworks.com/2022/English/SolidWorks/Sldworks/c_Dimensions_in_Drawings.htm)
- [Fact] **Sheet formats** are separate `.slddrt` files edited in a distinct "Edit Sheet Format" mode; resellers recommend saving them separately to share across a company — [CATI: Why can I not modify Sheet Properties?](https://cati.com/?p=132228)
- [Fact] SOLIDWORKS 2026 adds **AutoGenerate Drawing** (AI): from the New menu it creates drawings for parts and assemblies, choosing views and detailing; for assemblies it inserts BOM, auto balloons and revision tables — [GoEngineer: SOLIDWORKS 2026 Drawings](https://www.goengineer.com/blog/solidworks-2026-drawings-whats-new); Hawk Ridge describes it as beta and later moved into an "AI Labs" task-pane app in FD02 — [Hawk Ridge](https://hawkridgesys.com/blog/upgrading-solidworks-2026-new-features) (via search summary)
- [Fact] **DimXpert** (TM) is SOLIDWORKS' model-side tolerancing/annotation scheme; its dimensions are explicitly excluded from the 2024 "Reattach" command (see §2) — [SOLIDWORKS 2024 What's New: Reattach dangling dimensions](https://help.solidworks.com/2024/English/WhatsNew/c_wn2024_drawings_reattach_dangling_dimensions.htm) (content via search summary; direct fetch returned only page chrome)

**Autodesk Fusion**
- [Fact] **Drawing Automation** generates 2D drawings in the Drawing workspace; templates are optional but placeholder views in a template override the automation's view-placement algorithm; a **Tidy Up** command "automatically rearrange[s], re-sort[s] and/or resize[s] objects in the sheet" — [Fusion help: Drawing Automation](https://help.autodesk.com/cloudhelp/ENU/Fusion-Drawing/files/DWG-AUTO-DRAWING.htm)
- [Fact] **Auto Dimension** strategies: baseline, chain, ordinate, overall, symmetric, symmetric-with-baseline (plus "Auto-Select"); a Datum Location option (Bottom Left/Right, Top Left/Right, Manual); a **Density slider** controls how many dimensions are created; clicking an auto dimension fades the rest and shows **alternate positions** to pick from; auto dimensions do not affect manually placed dimensions — [Fusion help: Drawing Automation](https://help.autodesk.com/cloudhelp/ENU/Fusion-Drawing/files/DWG-AUTO-DRAWING.htm); [Fusion help: Create auto dimensions](https://help.autodesk.com/cloudhelp/ENU/Fusion-Drawing/files/DWG-AUTO-DIMENSION.htm)
- [Fact] Automation Preferences set a default dimensioning strategy per sheet type: Main Assembly, Sub-Assembly, Component, Folded Component, Flat Pattern, Storyboard — [Fusion help: Drawing Automation](https://help.autodesk.com/cloudhelp/ENU/Fusion-Drawing/files/DWG-AUTO-DRAWING.htm); [Automation preferences reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-Drawing/files/DWG-REF-AUTO-PREFERENCES.htm)
- [Fact] Drawing automation ignores standard fasteners from the Autodesk fastener library — [Fusion help: Automation preferences / Drawing Automation](https://help.autodesk.com/cloudhelp/ENU/Fusion-Drawing/files/DWG-REF-AUTO-PREFERENCES.htm) (via search summary)
- [Fact] Auto-dimension is also exposed via the API (`Sheet.autoDimension`) — [Fusion API reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/drawing_Sheet_autoDimension.htm)
- [Fact, historical context] An Autodesk staffer in the long-running "auto 2D dimensioning" request thread said they were prototyping auto-layout (templates that auto-create sheets and views) and auto-dimensioning, reasoning that modelling dimensions are rarely the ones needed for manufacturing documentation — [Autodesk forum thread](https://forums.autodesk.com/t5/fusion-design-validate-document/there-should-be-an-auto-2d-drawing-dimensioning-function-in/m-p/7060359) (snippet only; thread is ~2017, historical)

**Onshape**
- [Fact/Opinion] Projected views stay horizontally/vertically aligned to their parent; right-click "Break alignment" / "Restore alignment"; a view inserted with the generic Drawing view command can be placed anywhere unaligned — [Onshape forum: problem with position of projected views](https://forum.onshape.com/discussion/11225/drawing-problem-with-the-position-of-the-projected-views)
- [Fact] Projection angle follows the format: ANSI formats are third-angle, ISO formats first-angle (per an Onshape employee); a user could not find a separate setting — [Onshape forum: drawing views](https://forum.onshape.com/discussion/11492/drawing-views) (forum, date not verified)
- [Fact] Hole callouts are editable (precision/tolerance overrides) and the edit propagates to all instances of that hole in the drawing and to hole tables, which update automatically; Onshape auto-breaks extension lines where dimensions overlap (overridable); independent arrowhead control — [Onshape What's New 04/05/2022](https://www.onshape.com/en/resource-center/what-is-new/fillets-hole-callouts-tables)
- [Fact, possibly outdated] Onshape staff answers state that sketch/model dimensions cannot be inserted into drawings and must be recreated (workaround: show sketch dims and print) — [Onshape forum: use sketch and model dimensions in 2D drawing](https://forum.onshape.com/discussion/3774/use-sketch-and-model-dimensions-in-2d-drawing); [Onshape forum: insert part sketches and dimensions](https://forum.onshape.com/discussion/9791/how-can-i-insert-my-part-sketches-and-dimensions-into-a-drawing). Onshape has since added MBD drawing features ("sheet metal jog, MBD drawings") — [Onshape What's New](https://www.onshape.com/en/resource-center/what-is-new/sheet-metal-jog-mbd-drawings-flex-rigid-pcb-layout) and "replicate annotations" — [Onshape What's New (MBD, replicate annotations beta)](https://www.onshape.com/ja/resource-center/what-is-new/comments-model-based-definition-replicate-annotations-beta-composite-part-support-cam-studio); I could not confirm the exact current state of "insert model PMI into drawing views".
- [Fact] Recent drawing changes listed on the Onshape changelog (via search summary, not directly fetched): 1.217 (June 2026) arc-length dimension, replicating chamfer dimensions, axis auxiliary view; 1.219 (Aug 2026) a persistent centre-of-mass indicator insertable/dimensionable in drawings and ISO 21920 surface finish symbols; Oct 31 2025 update: cut-list data on callouts — [Onshape changelog](https://www.onshape.com/en/changelog/); [Onshape forum: improvements Oct 31 2025](https://forum.onshape.com/discussion/29161/improvements-to-onshape-october-31st-2025)
- [Fact] Onshape dimension-tool tech tip and help (dimension shortcut "d") — [Onshape tech tip: dimension tools](https://www.onshape.com/en/resource-center/tech-tips/dimension-tools-onshape-drawings); [Onshape help: Drawing dimensions](https://cad.onshape.com/help/Content/Drawing/drawing_dimensions.htm)

**Creo**
- [Fact] Creo provides **Cleanup Dimensions** to reposition drawing dimensions "to meet industry standards and enable easier reading" — [PTC help: About Cleaning Up Dimensions](https://support.ptc.com/help/creo/creo_pma/r7.0/usascii/detail/About_Cleaning_Up_Dimensions.html); [PTC help r13: To Automatically Cleanup Dimensions](https://support.ptc.com/help/creo/creo_pma/r13/usascii/detail/To_Automatically_Cleanup_Dimensions.html)
- [Fact] Creo MBD has a documented "One or More Dimensions Are Missing" troubleshooting topic — [PTC help: Missing dims](https://support.ptc.com/help/creo/creo_plus/usascii/model-based_definition/missing_dims.html)
- [Opinion] Former Creo users moving to NX miss Creo's **Show and Erase** (show model dimensions in a view) workflow; NX responders suggest authoring PMI in the model and inheriting it into drawing views instead — [Eng-Tips](https://www.eng-tips.com/viewthread.cfm?qid=436540) (date not verified)

**Siemens NX Drafting**
- [Fact] NX inherits model PMI into drafting views; inherited dimensions live inside the view and get clipped by a view break unless "Aligned to Drawing (View Only)" + "Show PMI on Drawing" are used to place them on the sheet — [Siemens KB PL7005642](https://support.sw.siemens.com/en-US/okba/PL7005642/PMI-dimension-is-broken-or-clipped-in-a-view-break/index.html); [Siemens KB PL8010291](https://support.sw.siemens.com/en-US/okba/PL8010291/How-to-display-inherited-PMI-dimensions-in-a-view-with-a-View-Break/index.html)
- [Fact] Inherited-PMI quirks: extension-line overhang scales with view scale (30 mm overhang at 1:20 becomes 600 mm, "default behavior"); PMI text font/size not inherited; table row/col sizes not inherited without "Inherit PMI Tracking"; PMI repositioning not updating on drawing views — [Siemens KB PL8010408](https://support.sw.siemens.com/en-US/okba/PL8010408/PMI-dimension-extension-line-overhang-is-too-long-in-Drafting/index.html); [PL8003868](https://support.sw.siemens.com/en-US/okba/PL8003868/PMI-Text-Font-and-Size-not-Inherited-from-Model-on-to-2D-Drawing/index.html); [PL8814759](https://support.sw.siemens.com/en-US/okba/PL8814759/Column-Width-and-Row-Height-of-PMI-Table-are-not-inherited-to-drawings/index.html); [PL8412041](https://support.sw.siemens.com/en-US/okba/PL8412041/PMI-dimension-reposition-not-updating-on-the-drawing-view/index.html)
- [Fact] NX hole tables report in the drawing sheet's units (edit sheet settings first to get inch tables from metric parts); ordinate datum symbols ship in NX ISO/ANSI symbol fonts — [Siemens KB PL8003319](https://support.sw.siemens.com/en-US/okba/PL8003319/How-to-create-an-english-units-Hole-Table-from-a-metric-part-file/index.html); [Siemens KB PL8769902](https://support.sw.siemens.com/en-US/okba/PL8769902/How-to-insert-a-Hole-Table-Datum-Symbol-ordinate-dimensions/index.html)

**FreeCAD TechDraw**
- [Fact] TechDraw hatching depends on face detection, which carries a performance penalty on complex models (TechDraw preferences doc) — [FreeCAD wiki: TechDraw Preferences](https://wiki.freecad.org/TechDraw_Preferences/en); hatching docs — [FreeCAD wiki: TechDraw Hatching](https://wiki.freecad.org/TechDraw_Hatching/en)
- [Fact] Official guidance (topological naming page): dimensions on projected edges may break when the 3D model changes because vertices/edges are renamed; the wiki advises adding TechDraw dimensions only once the model is finished — [FreeCAD wiki: Topological naming problem](https://wiki.freecad.org/Topological_naming_problem/en)
- [Fact] TechDraw has a **Dimension Repair** tool: select the broken dimension and optionally new edges/points (in the TechDraw or 3D view); FreeCAD sometimes proposes a likely fix and auto-resolves some references when stored information gives high confidence — [FreeCAD wiki: TechDraw DimensionRepair](https://wiki.freecad.org/Translations:TechDraw_DimensionRepair/7/en) (via search summary; page bot-walled on fetch); code-level summary says TechDraw auto-repairs references on model change — [DeepWiki: FreeCAD dimensioning system](https://deepwiki.com/FreeCAD/FreeCAD/3.5.2-dimensioning-system) (secondary, AI-generated summary — low confidence)

**Shapr3D**
- [Fact] Drawings first shipped March 2021 (iPad 4.0) on the Business/Pro plans with base views, dimensions, basic notes, border, simple title block and DWG/DXF/PDF export — [Shapr3D Discourse: 4.0 2D drawings are finally here](https://discourse.shapr3d.com/t/ipad-4-0-2d-drawings-are-finally-here/11729); [DEVELOP3D: Shapr3D adds Drawings](https://develop3d.com/cad/shapr3d-adds-drawings/); [Architosh 2021](https://architosh.com/2021/03/shapr3d-intros-new-drawings-feature-and-new-packaging/)
- [Fact] A 2023 overhaul (product update dated Oct 16 2023) added detail views; a projection flow where tapping a base view shows a **visual menu of projected views** that stay aligned; a settings sidebar (ISO/ANSI, sheets, projection, decimals, line widths); duplicate drawings for different audiences; dimensions that snap to fixed distances with labels centred on the line; double-click a dimension to add tolerances/notes; several predefined title-block layouts with editable fields; logo/screenshot import. GD&T, threads and improved dimensioning were promised "in the near future" — [Shapr3D: Overview of the 2D Drawings overhaul](https://www.shapr3d.com/content-library/an-overview-of-the-2d-drawings-overhaul-whats-done-and-whats-to-come)
- [Fact] Release milestones: 5.420 dimension snapping + duplicate drawings — [Shapr3D support 5.420](https://support.shapr3d.com/hc/en-us/articles/9671864574364); detail views (May/June 2023) — [Shapr3D May updates](https://www.shapr3d.com/content-library/may-updates-detail-views-for-2d-drawings); title-block layouts (April 2023) — [Shapr3D April updates](https://www.shapr3d.com/de-de/content-library/april-updates-2d-drawings-title-block-layouts); 5.460 base/projection views, section views aligned with parents (detaching planned) — [Shapr3D support 5.460](https://support.shapr3d.com/hc/en-us/articles/10341572253212); [Discourse 5.460](https://discourse.shapr3d.com/t/5-460-base-and-projection-views-in-2d-drawings/27719); section views (4.10) — [Discourse 4.10 section views](https://discourse.shapr3d.com/t/4-10-section-views-for-2d-drawings/14823)

### Inferences
- The consensus "grammar" is: sheet → base view (orientation picker) → projected children locked to parent axes → dimensions (import or manual) → tables/annotations. Wren should adopt that grammar rather than invent one; the novelty budget belongs in automation, flagging and touch.
- Two distinct dimension-sourcing philosophies exist: (a) reuse modelling dimensions (SOLIDWORKS Model Items, Creo Show/Erase) and (b) re-dimension for manufacturing (Onshape historically, Fusion's stated rationale). NX/Creo-MBD/SOLIDWORKS-MBD are pushing (c): author manufacturing PMI in the model and inherit it. Wren's "import model annotations" maps to (c) and should not be confused with importing sketch dimensions.
- Fusion's "alternate positions" pick-list and density slider are the most concrete published UX for taming auto-dimension output; it's a good pattern to emulate generically.

### Gaps
- No primary source fetched for SOLIDWORKS 2026 AutoGenerate Drawing limitations (Solid Solutions article returned empty; 3DS blog not fetched).
- No first-party Creo or NX documentation of their view-creation UX was fetched (only KBs on PMI inheritance and cleanup).
- Fusion template workflow (template creation page) not fetched beyond the automation page; Fusion drawing automation launch date not confirmed (Autodesk blog 403).
- Exact current Onshape support for importing model/MBD annotations into drawing views not confirmed.

---

## 2. Complaints (dimension tedium, overlaps, alignment, speed, dangling annotations, auto-dim quality, title blocks, sections/details, hatching, text, print scale, PDF/DXF export)

### Takeaway
The loudest, most durable complaints are (1) broken/dangling annotations after model edits — sometimes flagged, sometimes silently wrong — (2) the click-count and cleanup tedium of placing dimensions, (3) template/sheet-format editing friction, and (4) export fidelity (DXF splines, print scale); the newest complaints are about auto-generated output being cluttered or occasionally wrong.

### Cited Findings

**Dangling / broken annotations after model change**
- [Opinion] "How do i delete dangling dimensions? Cant select them or do anything! Extremely annoying!" — [3DSwym SOLIDWORKS forum](https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/how-do-i-delete-dangling-dimensions_Z2OptDEQSymUQhiYH96XsA)
- [Fact] SOLIDWORKS flags dangling dimensions visually (resellers explain "why dimensions are yellow"/coloured) — [Solid Solutions: Why are SOLIDWORKS dimensions yellow (2023)](https://solidsolutions.co.uk/Blog/2023/03/Why-are-SOLIDWORKS-Dimensions-Yellow); Design Checker has a "dangling dimension/annotation" check — [SOLIDWORKS 2020 Design Checker](https://help.solidworks.com/2020/English/SolidWorks/solidworks_design_checker/r_dangling_dimension_annotation.htm); [Javelin: dangling dimension checklist](https://www.javelin-tech.com/blog/tag/dangling-dimensions/)
- [Fact] SOLIDWORKS only added a right-click **Reattach** for dangling drawing dimensions in 2024; not supported for imported, DimXpert, chain or path-length dimensions — [SOLIDWORKS 2024 What's New](https://help.solidworks.com/2024/English/WhatsNew/c_wn2024_drawings_reattach_dangling_dimensions.htm) (via search summary). Older Eng-Tips threads said reattach was possible in sketches but not drawings — [Eng-Tips: dangling drawing dimensions](https://eng-tips.com/threads/dangling-drawing-dimensions.77358) [Historical]
- [Opinion] Users ask how to *find* dangling dims in large drawings and for macros to bulk-delete them — [Eng-Tips: find dangling dimensions in a large drawing](https://eng-tips.com/threads/how-do-i-find-dangling-dimensions-in-a-large-drawing-document.368638) [likely Historical]; [GrabCAD: how to fix dangling dimensions](https://grabcad.com/questions/how-to-fix-dangling-dimensions)
- [Fact/Reseller] Root cause attributed to changing designs and changing internal feature IDs — [GoEngineer: tools to avoid dangling dimensions](https://www.goengineer.com/videos/tools-to-avoid-dangling-dimensions)
- [Opinion] Fusion: a thread titled "Dimensions on drawings loose reference, automatic hole callouts no good"; other users say Fusion "will happily give you an incorrect dimension", call sketch-based dimensions untrustworthy because "it's not anchored to anything", and report "most of the dimension references are lost" after updates — [Autodesk forum 13699550](https://forums.autodesk.com/t5/fusion-design-validate-document/dimensions-on-drawings-loose-reference-automatic-hole-callouts/m-p/13699550); [Autodesk forum: drawing dimensions are incorrect](https://forums.autodesk.com/t5/fusion-support/drawing-dimensions-are-incorrect/m-p/12021471) (snippets only; 403 on fetch)
- [Fact] FreeCAD's own docs advise dimensioning only after the model is finished because of topological naming — i.e. breakage is expected — [FreeCAD wiki: Topological naming problem](https://wiki.freecad.org/Topological_naming_problem/en); bug report of a file breaking after opening/closing an unrelated sketch once a dimension was added — [FreeCAD tracker 4741](https://tracker.freecad.org/view.php?id=4741) (via search summary)
- [Opinion] Creo: after minor 3D edits "All the dimensions offset the original position runs too far away, very hard to cleanup" — [PTC Community: Creo drawing dimension issue (2014)](https://community.ptc.com/3d-part-assembly-design-327/creo-drawing-dimension-issue-21805) [Historical]; draft dimensions not updating — [PTC Community: Creo 3 draft dims not updating](https://community.ptc.com/3d-part-assembly-design-327/creo-3-strange-bug-with-draft-dimensions-not-updating-properly-78854) [Historical]

**Dimension placement / cleanup tedium and click count**
- [Opinion] Creo: "Why I have to do 1200 clicks in Drafting to perform actions that require 1-click in AutoCAD?"; section lines can't be edited (must recreate the section view); adding a prefix/tolerance takes many steps; dimension orientation can't be changed mid-drag. Thread from 2015 [Historical], but a Feb 2026 reply: "11 years later. PTC is still worthless." — [PTC Community thread](https://community.ptc.com/3d-part-assembly-design-327/why-creo-drafting-and-annotation-are-so-terrible-why-i-have-to-do-1200-clicks-in-drafting-to-perform-actions-that-require-1-click-in-autocad-why-i-cannot-edit-stupid-section-line-in-annotation-and-have-to-re-create-section-view-why-i-have-to-run-m-49951)
- [Opinion] Automating Creo's cleanup via API still gave poor alignment (2021) — [PTC Community: how to cleanup dimension in drawing](https://community.ptc.com/customization-176/how-to-cleanup-dimension-in-drawing-116944)
- [Opinion] SOLIDWORKS Model Items: imported dimensions "come in at odd locations and are not aligned"; "moving dimensions to the correct views and location can be time consuming"; workaround is importing only dims "marked for drawing" — [Javelin: Cleanly inserting key dimensions (2012)](https://www.javelin-tech.com/blog/2012/09/cleanly-inserting-key-dimensions-to-a-drawing/) [Historical]; [GoEngineer: additional techniques to import dimensions](https://www.goengineer.com/videos/solidworks-tutorial-additional-techniques-to-import-dimensions-into-a-drawing)
- [Opinion] Shapr3D launch (2021): manual dimension text placement "very tedious", users asked for a snapper that centres text on the line (later shipped, see §1) — [Shapr3D Discourse 4.0](https://discourse.shapr3d.com/t/ipad-4-0-2d-drawings-are-finally-here/11729)
- [Opinion] NX: "Does anyone else here think that the NX drafting module is awful?" vs reply "very easy to use"; NX "very particular with drafting standards" — [Eng-Tips NX drafting thread](https://www.eng-tips.com/viewthread.cfm?qid=385712) (date not verified)
- [Opinion] Fusion: drawing workspace called "the worst part of Fusion package" (older) — [Autodesk forum: How does the drawings module still suck so bad?](https://forums.autodesk.com/t5/fusion-design-validate-document/how-does-the-drawings-module-still-suck-so-bad/td-p/6264370) [Historical, ~2016]; more recent "Fusion - Drawing sketches, API, overall inadequacy" thread — [Autodesk forum 13888382](https://forums.autodesk.com/t5/fusion-design-validate-document/fusion-drawing-sketches-api-overall-inadequacy/m-p/13888382) (snippet only, ~2025)

**Overlapping dimensions**
- [Fact] Vendors treat overlap as a first-class problem: Onshape auto-breaks overlapping extension lines (2022) — [Onshape What's New](https://www.onshape.com/en/resource-center/what-is-new/fillets-hole-callouts-tables); SOLIDWORKS 2026 adds breaks around dimension *text* that update when moved — [GoEngineer 2026](https://www.goengineer.com/blog/solidworks-2026-drawings-whats-new); SOLIDWORKS 2026 extends "Magnetic Lines" (TM-ish) alignment beyond balloons to notes, GD&T, weld and surface finish symbols — same source.

**Views that won't stay aligned / projection surprises**
- [Opinion] Onshape: rotation of a parent view can't be changed once dependents exist, leaving children no longer in true view; assembly drawings after updates showed views "superimposed and not correctly projected"; break views couldn't keep alignment (later fixed for views, not for break lines) — [Onshape forum: drawing views](https://forum.onshape.com/discussion/11492/drawing-views); [Onshape forum: what could be causing this projection to change](https://forum.onshape.com/discussion/26945/what-could-be-causing-this-projection-to-change-is-it-a-bug); [Onshape forum: align view option disappeared](https://forum.onshape.com/discussion/22042/view-has-align-view-option-disappeared)
- [Opinion] Onshape users surprised that projected views show the "opposite side" (first vs third angle tied to format) — [Onshape forum: drawing views](https://forum.onshape.com/discussion/11492/drawing-views)
- [Fact] Shapr3D: section views are locked to parent; detaching was "planned, no ETA" — [Shapr3D support 5.460](https://support.shapr3d.com/hc/en-us/articles/10341572253212)

**Slow updates on large models / hatching performance**
- [Fact] FreeCAD: face detection for hatching has a performance penalty on complex models — [FreeCAD TechDraw Preferences](https://wiki.freecad.org/TechDraw_Preferences/en); detail view of a swept solid hung FreeCAD every time (2018, fixed) — [FreeCAD tracker 3639](https://tracker.freecad.org/view.php?id=3639) [Historical]
- [Opinion] Cross-hatching "bogs computer down" (SOLIDWORKS) — [MCAD Central](https://mcadcentral.com/threads/drawing-x-hatching-bogs-computer-down.18629) [likely Historical]; cropped section view hatches fail — [SOLIDWORKS forum](https://forum.solidworks.com/forum-solidworks/COzVx3aYSeSP_OfL9YC8YQ/cropped-section-views-hatches-fail); Fusion hatch issues — [Autodesk forum](https://forums.autodesk.com/t5/fusion-design-validate-document/hatch-issues-in-drawings/m-p/13057345/highlight/true); Creo: can't change line thickness in a view because of hatching — [PTC Community](https://community.ptc.com/3d-part-assembly-design-327/unable-to-alter-line-thickness-in-view-due-to-hatching-118499)
- [Opinion] Workaround in SOLIDWORKS: disable automatic view update during bulk hatch changes — [cadforum (via search summary)](https://cadforum-net.dezignstuff.com/viewtopic.php?p=34805)

**Auto-dimension quality**
- [Opinion/Bug] Fusion Drawing Automation produced a stray "0" dimension, investigated by Autodesk QA — [Autodesk forum: a bug and an inconsistency](https://forums.autodesk.com/t5/fusion-design-validate-document/a-bug-and-an-inconsistency/m-p/12685525) (snippet)
- [Opinion] Fusion "automatic hole callouts no good" (thread title) — [Autodesk forum 13699550](https://forums.autodesk.com/t5/fusion-design-validate-document/dimensions-on-drawings-loose-reference-automatic-hole-callouts/m-p/13699550)
- [Opinion] Projecting PMI onto views "produces cluttered output", people must still arrange each view, and any engineering change "scrambles the layout" — [Encube: The drawing is not the problem (Mar 2026, vendor blog)](https://www.getencube.com/post/the-drawing-is-not-the-problem)

**Title block / sheet format / template friction**
- [Opinion] SOLIDWORKS: can edit but not delete a revision row in Edit Sheet Format; block-edit changes not reflected in sheet-format mode; title block vanished after editing an imported DWG format; formats not carrying to new sheets; template changes can't be pushed to existing drawings; stuck in sheet-format mode; title block can't anchor to the corner when paper size changes — [SW forum 78107](https://forum.solidworks.com/thread/78107); [187668](https://forum.solidworks.com/thread/187668); [82039](https://forum.solidworks.com/thread/82039); [86439](https://forum.solidworks.com/thread/86439); [100545](https://forum.solidworks.com/thread/100545); [181872](https://forum.solidworks.com/thread/181872); [Eng-Tips: reload border](https://www.eng-tips.com/threads/reload-border.152505); [Eng-Tips: title blocks](https://eng-tips.com/threads/title-blocks.58846) — mostly 2007–2019 [Historical], but structurally unchanged.
- [Opinion] Expert advice: drive title blocks from custom properties instead of letting users edit them directly — [Eng-Tips: blocks and templates again](https://eng-tips.com/threads/blocks-and-templates-again.291341)
- [Fact] SOLIDWORKS 2026 adds "Display Expressions" to show the link expressions behind title-block notes (e.g. custom properties), and lockable first revision-table row — evidence that link opacity was a pain point — [GoEngineer 2026](https://www.goengineer.com/blog/solidworks-2026-drawings-whats-new)
- [Opinion] Shapr3D 2021 users asked if the title block could be customised (answer: only via preferences dialog) — [Shapr3D Discourse 4.0](https://discourse.shapr3d.com/t/ipad-4-0-2d-drawings-are-finally-here/11729)

**Section and detail view limitations**
- [Opinion] Creo: section line can't be edited; whole section view must be recreated — [PTC Community thread](https://community.ptc.com/3d-part-assembly-design-327/why-creo-drafting-and-annotation-are-so-terrible-why-i-have-to-do-1200-clicks-in-drafting-to-perform-actions-that-require-1-click-in-autocad-why-i-cannot-edit-stupid-section-line-in-annotation-and-have-to-re-create-section-view-why-i-have-to-run-m-49951) [Historical + 2026 reply]
- [Fact] NX: inherited PMI clipped by view breaks — [Siemens KB PL7005642](https://support.sw.siemens.com/en-US/okba/PL7005642/PMI-dimension-is-broken-or-clipped-in-a-view-break/index.html)
- [Opinion] Shapr3D 2021: no dimensioning of 3D/isometric views (radii), hidden edges unavailable in 3D views; section/detail/auxiliary views only "planned" — [Shapr3D Discourse 4.0](https://discourse.shapr3d.com/t/ipad-4-0-2d-drawings-are-finally-here/11729) (since partly addressed)

**GD&T gaps**
- [Opinion] Shapr3D: "currently lacks Geometric Dimensioning and Tolerancing (GD&T) symbols"; "Tolerances are here!" but "Still missing Datum feature" — [Discourse: Add GD&T symbol support](https://discourse.shapr3d.com/t/add-gd-t-symbol-support-for-2d-technical-drawings/36581); [Discourse: GD&T Drawings](https://discourse.shapr3d.com/t/gd-t-drawings/13526)

**Text and fonts**
- [Fact] NX: PMI text font/size not inherited from model to drawing — [Siemens KB PL8003868](https://support.sw.siemens.com/en-US/okba/PL8003868/PMI-Text-Font-and-Size-not-Inherited-from-Model-on-to-2D-Drawing/index.html)
- [Fact] Missing text in PDFs usually comes from non-embedded custom fonts; fix is embedding or standard fonts; Autodesk Vault job processor rendered fonts incorrectly until fonts were installed on the server — [Coohom guide](https://www.coohom.com/article/how-to-fix-cad-to-pdf-conversion-errors) (low-authority); [Autodesk KB](https://knowledge.autodesk.com/support/autocad/troubleshooting/caas/sfdcarticles/sfdcarticles/Error-DWF-created-by-Vault-Job-Processor-has-incorrect-Fonts.html)

**Printing at the wrong scale**
- [Fact] PDF readers default to "Fit to Page"/"Shrink oversized pages", silently changing scale; Acrobat reported shrinking to ~98%; fix is Actual Size/100% — [Bluebeam support: PDF isn't to scale](https://support.bluebeam.com/revu/troubleshooting/pdf-isnt-to-scale-when-printing-from-autocad.html); [Adobe community](https://community.adobe.com/t5/acrobat-discussions/my-pdf-does-not-print-out-to-scale/m-p/12451934); [CADTutor: PDF not printing to exact scale](https://cadtutor.net/forum/topic/67917-pdf-not-printing-to-exact-scale); [WPS guide](https://www.wps.com/office-quick-solution/pdf-troubleshooting/how-to-print-autocad-pdf-drawings-to-exact-scale/) (low-authority)
- [Opinion] Creo PDF export size issues — [PTC Community: size issue when exporting to PDF](https://community.ptc.com/t5/3D-Part-Assembly-Design/Size-issue-when-exporting-to-PDF/m-p/434965)

**DXF export problems**
- [Opinion/Fact] Fusion writes higher-degree / fit-point splines many laser/CAM tools can't read; fit-point splines are app-specific while control-point splines are more portable; users see missing or warped splines (Corel, RDWorks, SOLIDWORKS) or only spline endpoints — [Autodesk forum: Fusion curves vs DXF curves (~2024)](https://forums.autodesk.com/t5/fusion-design-validate-document/fusion-curves-vs-dxf-curves/m-p/12765864); [DXF fit point export problems](https://forums.autodesk.com/t5/fusion-support-forum/dxf-fit-point-export-problems/m-p/9000343/highlight/true); [Trouble with DXFs exported by Fusion (2022)](https://forums.autodesk.com/t5/fusion-support-forum/trouble-with-dxfs-exported-by-fusion/td-p/11365419); [Unreliable DXF exporting (2023)](https://forums.autodesk.com/t5/fusion-support-forum/unreliable-dxf-exporting/m-p/12425351)
- [Fact/Opinion] Workarounds: "convert splines to polylines" option or add-in (faceting arcs is a downside), re-save via Rhino — [Autodesk forum: Exporting spline as DXF](https://forums.autodesk.com/t5/fusion-design-validate-document/exporting-spline-as-a-dxf/m-p/6823785); [McNeel forum](https://discourse.mcneel.com/t/rhino-to-fusion-360-issues/155320)
- [Opinion] Disconnected/misaligned lines in Fusion DXF — [Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/dxf-export-has-disconnected-and-misaligned-lines/m-p/8793500)

### Inferences
- "Dangling" is handled on a spectrum: SOLIDWORKS colours them and (since 2024) offers Reattach for some types; FreeCAD tells you to avoid the situation and offers repair; Fusion/Creo users report silent drift or wrong values. The worst outcome users describe is *silently wrong* — this validates Wren's golden rule ("never silently guess a topological reference") and M4's "dangling dimensions are flagged" acceptance criterion. Reattach must cover *all* dimension types, including imported/PMI ones (SOLIDWORKS' exclusions are a trap).
- Layout drift after model edits (Creo, Encube's "scrambles the layout") means associativity must preserve *placement intent* (offset from geometry/view, snapping lane), not just the reference.
- Sheet-format complaints are mostly about modal editing (a separate "edit sheet format" mode, stuck states) and templates not propagating to existing drawings — Wren should make title-block fields data-bound and allow "re-apply template" to existing drawings.
- DXF: export control-point (or arc/line approximated with tolerance) splines, offer an explicit "polyline/arc approximation" option, and ship layered output by line type. PDF: always embed fonts / outline text, and set PDF print-scaling hints to "None" so readers default to actual size (inference; the PDF ViewerPreferences `PrintScaling /None` key exists in the PDF spec, not verified in this research).

### Gaps
- No Reddit evidence surfaced; complaint frequency/ranking across tools is not quantified anywhere I found.
- No sources specifically on DXF layer mapping or font handling from 3D CAD drawing exporters (only AutoCAD/PDF generic sources).
- No measured data on drawing update speed for large assemblies in any tool.
- Could not read the "SOLIDWORKS pet peeves" cadforum thread (host blocked).

---

## 3. Praised features

### Takeaway
Users and resellers praise the features that remove repetitive placement work while keeping the user in control: importing model dimensions (with filtering), projected-view menus that stay aligned, hole callouts/tables derived from hole features, auto-breaks around overlaps, alignment aids (magnetic lines, snapping lanes, evenly-spaced placement), and live associativity.

### Cited Findings
- [Reseller opinion] Insert Model Items saves recreating dimensions; best practice is importing only dims "marked for drawing" — [GoEngineer](https://www.goengineer.com/blog/inserting-model-dimensions-into-solidworks-drawing); [Javelin](https://www.javelin-tech.com/blog/?p=56412)
- [Opinion, historical] Inventor users point to the ability to pick which model sketch dimensions to bring into the drawing as the model for Fusion to copy — [Autodesk forum thread](https://forums.autodesk.com/t5/fusion-design-validate-document/there-should-be-an-auto-2d-drawing-dimensioning-function-in/m-p/7060801) (~2017)
- [Fact] Rapid Dimension places dimensions "evenly spaced and easier to read" — [SOLIDWORKS help 2017](https://help.solidworks.com/2017/english/SolidWorks/sldworks/c_Dimension_Placement_Manipulator.htm); Smart Dimension tips (inference from selection type) — [SOLIDWORKS Tech Blog: Five great Smart Dimension tips (2017)](https://blogs.solidworks.com/tech/2017/03/five-great-smart-dimension-tips-sketch-drawings.html) [Historical]
- [Fact] Hole callouts editable once and propagated to all instances and to auto-updating hole tables (Onshape) — [Onshape What's New 2022](https://www.onshape.com/en/resource-center/what-is-new/fillets-hole-callouts-tables)
- [Fact] Auto-balloons + BOM + revision tables inserted automatically for assemblies (SOLIDWORKS 2026 AutoGenerate) — [GoEngineer](https://www.goengineer.com/blog/solidworks-2026-drawings-whats-new)
- [Fact] Magnetic Lines alignment extended in 2026 to notes, GD&T, weld and surface-finish symbols — [GoEngineer](https://www.goengineer.com/blog/solidworks-2026-drawings-whats-new)
- [Fact] Auto-breaking overlapping extension lines (Onshape) and dimension-text breaks that update when moved (SOLIDWORKS 2026) — [Onshape](https://www.onshape.com/en/resource-center/what-is-new/fillets-hole-callouts-tables); [GoEngineer](https://www.goengineer.com/blog/solidworks-2026-drawings-whats-new)
- [Fact] Ordinate as a first-class auto-dimension strategy with datum-corner choice (Fusion) — [Fusion help](https://help.autodesk.com/cloudhelp/ENU/Fusion-Drawing/files/DWG-AUTO-DIMENSION.htm)
- [Fact] Alternate-position picking for auto dimensions; density slider — [Fusion help](https://help.autodesk.com/cloudhelp/ENU/Fusion-Drawing/files/DWG-AUTO-DIMENSION.htm)
- [Opinion] Shapr3D users at launch: "a great start", layout "looks good to start with", whole-view hidden-edge toggle "worked well" — [Shapr3D Discourse 4.0](https://discourse.shapr3d.com/t/ipad-4-0-2d-drawings-are-finally-here/11729)
- [Vendor claim] Shapr3D's goal: "create satisfyingly tidy drawings in less time"; dimension snapping to fixed distances and auto-centred labels; visual projection menu — [Shapr3D overhaul](https://www.shapr3d.com/content-library/an-overview-of-the-2d-drawings-overhaul-whats-done-and-whats-to-come)
- [Fact] Onshape break/restore alignment on projected views; Named Views from the Part Studio used as base-view orientations (user workaround praised in forum) — [Onshape forum](https://forum.onshape.com/discussion/11225/drawing-problem-with-the-position-of-the-projected-views)
- [Opinion] Creo user: Annotation became "one of the easier packages" after training (counterpoint to complaints) — [PTC Community thread](https://community.ptc.com/3d-part-assembly-design-327/why-creo-drafting-and-annotation-are-so-terrible-why-i-have-to-do-1200-clicks-in-drafting-to-perform-actions-that-require-1-click-in-autocad-why-i-cannot-edit-stupid-section-line-in-annotation-and-have-to-re-create-section-view-why-i-have-to-run-m-49951)

### Inferences
- The praised set is mostly "propagate once" mechanics (hole callout → all instances → table; title-block property → all sheets; style → all dims) and "align for me" aids. These are cheaper to build than AI layout and give most of the felt benefit.
- Selective import (filter by "marked for drawing"/feature) is praised more than bulk import — Wren's "import model annotations" should default to user-flagged/tolerance-bearing PMI only, with per-view targeting.

### Gaps
- I found no independent user survey or review that ranks which drawing features users value most; praise evidence is reseller tips and scattered forum posts.
- No direct evidence gathered on praise for dimension *styles* (named style libraries) or drag-to-align specifically.

---

## 4. Touch and tablet: drawing review/markup and authoring

### Takeaway
Tablet drawing *authoring* exists credibly only in Shapr3D (iPad-first since 2021, overhauled 2023); tablet drawing *review* is best documented in Onshape's native app (stylus redline on a screenshot, saved to a version-pinned comment, assigned as a task). Independent hands-on evaluations of either are scarce.

### Cited Findings
- [Fact/Vendor] Onshape tablet redline workflow (Nov 5 2024): find drawing via Documents/search → comment tool captures a screenshot → mark up with stylus ("feels like writing on paper") → Done saves markup to the version comment, handwriting allowed in the comment field → reviewers find assigned tasks in the Action items panel → Resolve marks done; reviewers go straight to the right version instead of printouts — [Onshape tech tip: redline drawing on tablet](https://www.onshape.com/en/resource-center/tech-tips/redline-drawing-tablet-paperless)
- [Vendor claim] Onshape: "First 3D CAD System for iPad Pro & Apple Pencil"; mobile is mainly for minor edits and communicating design changes — [Onshape blog: iPad CAD](https://www.onshape.com/it/blog/ipad-cad-enhance-productivity-and-creativity); [Onshape blog: CAD mobile use cases](https://www.onshape.com/en/blog/cad-mobile-use-cases); mobile drawings/publications update — [Onshape What's New: PCB studio, drawings, publications, mobile](https://onshape.com/en/resource-center/what-is-new/pcb-studio-drawings-publications-mobile)
- [Fact] Shapr3D drawings are created on iPad/desktop from Export/Items/Add menus; sheet size/orientation/scale; tap-based visual projection menu; double-click/tap dimension to add tolerance — [Shapr3D Discourse 4.0](https://discourse.shapr3d.com/t/ipad-4-0-2d-drawings-are-finally-here/11729); [Shapr3D overhaul](https://www.shapr3d.com/content-library/an-overview-of-the-2d-drawings-overhaul-whats-done-and-whats-to-come)
- [Opinion] Shapr3D tablet users' early pain was precision placement (centring dimension text by hand "very tedious") — [Shapr3D Discourse 4.0](https://discourse.shapr3d.com/t/ipad-4-0-2d-drawings-are-finally-here/11729)
- [Fact] Shapr3D 2026: Saved Views preserve section-view settings (26.70) and 2D Section View on/off states (26.120) — via search summary of [Shapr3D brief version history](https://www.shapr3d.com/de-de/content-library/brief-version-history) (not fetched directly)

### Inferences
- On touch, the winning interactions are *snap-heavy* (dimension lanes, auto-centred text, tap-to-pick projection menu) because finger precision is low; free-drag placement is where tablet users complain.
- A credible phone/tablet M4 story for Wren: (1) view + measure + markup (stylus/finger redline on a pinned version, saved as a comment) on phone and tablet; (2) authoring on tablet via tap-to-place views and snap lanes; (3) full detailing on desktop. Markup should anchor to drawing coordinates/entities (not just screenshots) so it survives revisions — Onshape's screenshot-based approach is simple but doesn't stay attached to geometry (inference).

### Gaps
- No independent review of Onshape mobile drawing markup or Shapr3D drawing authoring with Apple Pencil was found; no user-wish lists specific to tablet drawing review surfaced (Reddit not reached).
- Fusion, SOLIDWORKS (3DEXPERIENCE apps), FreeCAD: no tablet drawing workflows researched/found.

---

## 5. 2023–2026 trends: AI/automatic dimensioning and MBD replacing drawings

### Takeaway
2024–2026 is the "automation layer" era — Fusion shipped Drawing Automation with strategy-based Auto Dimension, SOLIDWORKS 2026 shipped AI AutoGenerate Drawing (beta), Onshape keeps adding annotation types/MBD drawings — while MBD is advancing but not displacing drawings, because suppliers still consume drawings and curated views remain necessary.

### Cited Findings
- [Fact] Fusion Drawing Automation + Auto Dimension (strategies, density, alternate positions, Tidy Up) — [Fusion help](https://help.autodesk.com/cloudhelp/ENU/Fusion-Drawing/files/DWG-AUTO-DRAWING.htm); launch blog — [Autodesk: Introducing Drawing Automation in Autodesk Fusion](https://www.autodesk.com/products/fusion-360/blog/drawing-automation-autodesk-fusion/) (403; title only); resellers market it as AI — [Arkance: Take advantage of AI – automatic drawings in Fusion](https://ukcommunity.arkance.world/hc/en-us/articles/32944622863250-Take-advantage-of-AI-automatic-drawings-in-Autodesk-Fusion)
- [Fact] SOLIDWORKS 2026 AutoGenerate Drawing (AI; views + detailing; BOM/auto balloons/revision tables for assemblies); official design-enhancements list includes "AI-powered views and hole callouts" and automated dimensioning — [GoEngineer](https://www.goengineer.com/blog/solidworks-2026-drawings-whats-new); [SOLIDWORKS 2026 top enhancements PDF](https://www.solidworks.com/sites/default/filesd10/2025-08/solidworks_2026_design_top_enhancements.pdf) (via search summary); [Solid Solutions: Assistive AI for Drawing Creation (Nov 2025)](https://www.solidsolutions.co.uk/Blog/2025/11/Assistive-AI-for-Drawing-Creation-Whats-New-in-SOLIDWORKS-Drawings-MBD-2026) (fetch returned empty)
- [Fact] Beta status/AI Labs (FD02) — [Hawk Ridge](https://hawkridgesys.com/blog/upgrading-solidworks-2026-new-features) (via search summary)
- [Fact] Onshape 2025–2026: annotation breadth (arc length, chamfer replication, axis auxiliary view, CoM indicator, ISO 21920 surface finish) and MBD drawings / replicate annotations — [Onshape changelog](https://www.onshape.com/en/changelog/); [Onshape What's New: MBD drawings](https://www.onshape.com/en/resource-center/what-is-new/sheet-metal-jog-mbd-drawings-flex-rigid-pcb-layout). I found **no** Onshape auto-dimension feature.
- [Fact] Surface finish per ISO 21920 added by both SOLIDWORKS 2026 and Onshape 1.219 — [GoEngineer](https://www.goengineer.com/blog/solidworks-2026-drawings-whats-new); [Onshape changelog](https://www.onshape.com/en/changelog/) — ISO 21920 replacing ISO 1302 is a concrete standards trend Wren's surface-finish symbol should follow.
- [Opinion, vendor blog Mar 2026] "The drawing is not the problem": drawings are "an editorial artifact"; PMI-projected views are cluttered; suppliers (job shops, contract manufacturers) still need drawings so OEMs maintain both; ASME Y14.41 "saved views" concede curated views are needed; MBD is pushed by IT/PLM rather than users; real problem is keeping drawings in sync — [Encube](https://www.getencube.com/post/the-drawing-is-not-the-problem)
- [Fact] NIST: some of industry has not committed to replacing drawings with models due to risk and skepticism (2016) [Historical] — [NIST](https://www.nist.gov/node/1115181); MBD vs 2D overview — [Autodesk blog](https://www.autodesk.com/blogs/design-and-manufacturing/model-based-definition-mbd-vs-2d-drawings/); 2024 vendor article cites lack of universal conventions for annotation placement as a barrier — [Lattice3D](https://blog.lattice3d.com/blog/beyond-the-2d-mindset-overcoming-barriers-to-model-based-manufacturing); [Tech-Clarity 2017 guide] [Historical] — [Tech-Clarity](https://tech-clarity.com/adopting-model-based-definition-mbd/6343)
- [Vendor claim, unverified] MBD "cuts ECOs by 41% and scrap by 47%" — [SPK blog](https://www.spkaa.com/blog/how-model-based-definition-mbd-cuts-ecos-by-41-and-scrap-by-47) (promotional; methodology not checked)

### Inferences
- The industry is converging on "author PMI once in the model, derive drawings automatically, let humans curate" — exactly Wren's "import model annotations" + STEP AP242 PMI plan. A design where the drawing is a *curated presentation of model PMI* (plus drawing-only annotations) positions Wren for both camps.
- Automation output quality is still the weak spot (stray zero dims, cluttered PMI projections). The safest automation is deterministic and inspectable (strategy + density + alternate positions) rather than opaque "AI".

### Gaps
- No credible, dated 2023–2026 survey quantifying MBD adoption or drawing usage was found.
- No independent evaluation of SOLIDWORKS 2026 AutoGenerate output quality found.

---

## 6. Recommendations: minimum lovable drawing workflow and traps to avoid

### Takeaway
A minimum lovable M4 is: one-tap sheet from a data-bound template → base view from an orientation picker → aligned projected/iso/section/detail views via on-canvas handles → selective import of model PMI plus a single inference-driven dimension tool with snap lanes → auto-propagating hole callouts/tables and centre marks → a persistent, unmissable "needs attention" list for dangling references → vector PDF/SVG/DXF that print at true scale. The traps are silent wrongness, modal template editing, layout drift, opaque automation and lossy export.

### Cited Findings (evidence base for recommendations)
- Silent wrong dimensions are the most damaging complaint — [Autodesk forum](https://forums.autodesk.com/t5/fusion-support/drawing-dimensions-are-incorrect/m-p/12021471); flagging + reattach exists but excludes imported/DimXpert/chain dims in SOLIDWORKS — [SOLIDWORKS 2024 What's New](https://help.solidworks.com/2024/English/WhatsNew/c_wn2024_drawings_reattach_dangling_dimensions.htm); users can't even select or find dangling dims — [3DSwym](https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/how-do-i-delete-dangling-dimensions_Z2OptDEQSymUQhiYH96XsA); [Eng-Tips](https://eng-tips.com/threads/how-do-i-find-dangling-dimensions-in-a-large-drawing-document.368638); FreeCAD repair-with-suggestion pattern — [FreeCAD wiki](https://wiki.freecad.org/Translations:TechDraw_DimensionRepair/7/en)
- Bulk import is messy; selective import is praised — [Javelin](https://www.javelin-tech.com/blog/2012/09/cleanly-inserting-key-dimensions-to-a-drawing/)
- Inspectable automation (strategy, density, alternates) — [Fusion help](https://help.autodesk.com/cloudhelp/ENU/Fusion-Drawing/files/DWG-AUTO-DIMENSION.htm)
- Modal sheet-format editing and non-propagating templates are long-standing friction — [SW forum](https://forum.solidworks.com/thread/187668); [Eng-Tips](https://www.eng-tips.com/threads/reload-border.152505)
- Click-count and non-editable section lines — [PTC Community](https://community.ptc.com/3d-part-assembly-design-327/why-creo-drafting-and-annotation-are-so-terrible-why-i-have-to-do-1200-clicks-in-drafting-to-perform-actions-that-require-1-click-in-autocad-why-i-cannot-edit-stupid-section-line-in-annotation-and-have-to-re-create-section-view-why-i-have-to-run-m-49951)
- DXF spline portability — [Autodesk forum](https://forums.autodesk.com/t5/fusion-design-validate-document/fusion-curves-vs-dxf-curves/m-p/12765864); PDF fit-to-page scale errors — [Bluebeam](https://support.bluebeam.com/revu/troubleshooting/pdf-isnt-to-scale-when-printing-from-autocad.html)
- Projection angle surprise when tied to format — [Onshape forum](https://forum.onshape.com/discussion/11492/drawing-views)

### Inferences (recommendations — these are the researcher's synthesis, not sourced facts)

**Minimum lovable workflow (MLW)**
1. **New drawing = one action.** Pick template (ISO A-series / ANSI) → sheet appears with title block auto-filled from document/part properties (name, material, mass, author, date, revision). Title-block fields are bound properties edited inline on the sheet (no separate "edit format" mode, respecting Wren's no-modal rule). Projection angle is an explicit, visible sheet property (first/third angle symbol in the title block), defaulted from the standard but independently switchable.
2. **Base view** from an orientation picker (front/top/right/iso + saved/named model views), dropped by tap/click; scale auto-chosen to fit, shown as an editable expression ("1:2").
3. **Projected views** by dragging out from the base view (ghost previews in the 4 directions + diagonals for iso), locked to parent alignment; explicit "unlock alignment" with a visible lock glyph; changing parent orientation re-derives children (avoid Onshape's "can't rotate once children exist").
4. **Section** = draw a cut line on a parent view (straight/offset/half), drag out the section view; the cut line stays editable after creation (Creo trap). **Detail** = circle on parent, drag out. Hatch auto-assigned by material, per-body, editable; hatch computed in the worker with the HLR result.
5. **Dimensions:** one inference-driven tool (edge→length, circle→Ø, arc→R, two lines→angle, point-point→aligned/horizontal/vertical by drag direction) with snap lanes at standard spacing, auto-centred text, auto-breaks at crossings, and an inline tolerance field accepting `10 ±0.1`, `10 H7`, limits. Ordinate/baseline/chain as modes of the same tool.
6. **Import model annotations:** per view, import PMI/tolerance-bearing dimensions only (default), with preview of which go where; hole features produce hole callouts automatically and a hole table on demand; centre marks/centre lines auto-applied to circular edges/axes per style.
7. **Optional auto-dimension later (P2):** deterministic strategies (baseline/chain/ordinate/overall), density control and alternate positions; never overwrite manual dims.
8. **Associativity & "needs attention":** a persistent badge + list panel showing every dangling/ambiguous annotation; dangling annotations drawn in a distinct colour *and* pattern (accessible), never displaying a stale value as if valid; click → Reattach flow that works for *every* annotation type (including imported PMI), with a suggested candidate highlighted but requiring confirmation. Placement stored relative to view + geometry so model edits don't scatter layout.
9. **Export:** vector PDF with embedded/outlined fonts and print-scaling "none"; a "print at 1:1 check" scale bar option; SVG with semantic groups; DXF with layers per line type (visible/hidden/centre/dimension/hatch/title), arcs/circles as native entities and splines as control-point (degree ≤3) or arc/polyline approximation by user-chosen tolerance; units and scale written in the header.
10. **Touch:** tablet = tap-to-place views, snap-lane dimensioning, long-press for tolerance; phone = view/measure/markup on a pinned revision, markup anchored to drawing coordinates.

**Traps to avoid**
- Silently showing a stale or re-guessed value after a model change.
- Reattach/repair that excludes some annotation types.
- Separate modal "sheet format" editing; templates that can't be re-applied to existing drawings.
- Bulk-import-everything as the default (clutter); opaque one-shot "AI" layout with no per-dimension alternatives.
- Section lines/view definitions that can't be edited after creation; children that block parent edits.
- Projection angle hidden inside a format choice.
- Spline-heavy DXF and non-embedded fonts; PDF that relies on reader "fit to page".
- Layout drift on model change (dimensions jumping far from geometry).
- Hatch/HLR on the main thread (performance) — keep HLR and hatch computation in the kernel worker per Wren golden rules.

**Generic names for trademarked/vendor-specific terms** (use these in Wren):
| Vendor term | Vendor | Suggested generic Wren term |
|---|---|---|
| View Palette | SOLIDWORKS | View picker / standard views tray |
| Model Items | SOLIDWORKS | Import model annotations |
| Smart Dimension | SOLIDWORKS | Dimension (inferred) |
| Rapid Dimension | SOLIDWORKS | Dimension snap lanes / placement guide |
| DimXpert (TM) | SOLIDWORKS | Model tolerancing / PMI |
| Magnetic Lines | SOLIDWORKS | Alignment rails |
| AutoGenerate Drawing | SOLIDWORKS | Auto drawing |
| Sheet Format | SOLIDWORKS | Sheet template / title block |
| Drawing Automation / Tidy Up / Auto Dimension | Fusion | Auto layout / Tidy / Auto-dimension |
| Show and Erase / Cleanup Dimensions | Creo | Show model dimensions / Tidy dimensions |
| Inherit PMI | NX | Import model annotations |
| TechDraw | FreeCAD | (product name — avoid) |

### Gaps
- No usability study or quantitative data validates any "minimum lovable" feature set; the MLW above is an inference from complaint/praise patterns.
- No evidence collected on BOM placeholder UX specifically, or on GD&T frame editor UX (inline vs dialog) across tools.
- Reddit and YouTube power-user content was not reachable via search in this session; a follow-up pass there could add frequency data and contemporary (2024–2026) opinion.
