# IP limits on copying CAD UI ideas, and HCI evidence on CAD interaction efficiency

> **Not legal advice.** These are informational research notes for Wren CAD (free, GPL-3.0, browser-native parametric CAD). Patent status values from Google Patents are labelled there as "an assumption, not a legal conclusion". Before shipping anything flagged "check" below, confirm it with counsel or with USPTO/EPO records directly.

## A1. Generic concepts vs protected expression: what does UI copyright case law allow?

### Takeaway
US case law treats menu command hierarchies (Lotus v. Borland) and general GUI ideas such as the desktop metaphor (Apple v. Microsoft) as unprotectable by copyright. Google v. Oracle (2021) found that reimplementing an interface so users can reuse existing skills was fair use. Wren can therefore adopt feature trees, menu structures, command names that describe functions, and familiar shortcut layouts. It should not copy icons, artwork, help text or distinctive screen designs verbatim.

### Cited Findings
- **Lotus v. Borland (1st Cir. 1995).** The court held that the Lotus 1-2-3 menu command hierarchy is an uncopyrightable "method of operation", so Borland's copy of it in Quattro Pro did not infringe. The court compared the menu to VCR buttons: it would be impossible to operate the program without the hierarchy. — [Wikipedia: Lotus v. Borland](https://en.wikipedia.org/wiki/Lotus_Development_Corp._v._Borland_International,_Inc.); [First Circuit opinion text](https://www.panix.com/~jesse/lotus.html)
- The district court had ruled for Lotus on the ground that other menu designs were possible. The First Circuit rejected that reasoning. — [Wikipedia: Lotus v. Borland](https://en.wikipedia.org/wiki/Lotus_Development_Corp._v._Borland_International,_Inc.)
- The First Circuit distinguished functional from expressive elements. The "long prompts" were not part of the method of operation, because users could run Lotus 1-2-3 without them. — [First Circuit opinion text](https://www.panix.com/~jesse/lotus.html)
- Quattro Pro's "Key Reader" let it run Lotus 1-2-3 keyboard macros, which meant reproducing Lotus key sequences. — [Wikipedia: Lotus v. Borland](https://en.wikipedia.org/wiki/Lotus_Development_Corp._v._Borland_International,_Inc.)
- The Supreme Court affirmed Lotus v. Borland by an equally divided court (516 U.S. 233, 1996). That leaves no nationwide precedent; the ruling binds only within the First Circuit. — [Harvard Cyberlaw case PDF](https://cyber.harvard.edu/people/tfisher/cx/1995_Lotus.pdf)
- **Apple v. Microsoft (9th Cir. 1994).** Apple could not obtain "patent-like protection" for the idea of a GUI or a desktop metaphor through copyright. The court also rejected a claim to the "complete look and feel" of the interface, because the individual elements were not original or were licensed. — [Wikipedia: Apple v. Microsoft](https://Www.wikipedia.org/wiki/Apple_v._Microsoft); [opinion, 35 F.3d 1435 (OpenJurist)](https://openjurist.org/35/f3d/1435)
- The case turned largely on a 1985 licence that allowed Microsoft to use the visual displays of Windows 1.0. — [Wikipedia: Apple v. Microsoft](https://Www.wikipedia.org/wiki/Apple_v._Microsoft)
- **Google v. Oracle (US Supreme Court, April 2021, 6–2).** Google's copying of about 11,500 lines of Java SE API declarations was fair use. The Court characterised the copied material as a "user interface" and stressed that Google took only what programmers needed to "put their accrued talents to work". — [Eric Goldman blog (guest post)](https://blog.ericgoldman.org/archives/2021/04/u-s-supreme-court-upholds-fair-use-in-google-oracle-software-battle-guest-blog-post.htm); [Goulston & Storrs summary](https://www.goulstonstorrs.com/content/uploads/pdf/publication/supreme-court-finds-googles-use-of-oracles-java-code-in-android-operating-system-to-be-fair-use.pdf)
- Google v. Oracle assumed for argument's sake that the API was copyrightable. It decided the case on fair use and did not settle copyrightability. — [TMCA commentary](https://thetmca.com/google-v-oracle-scotus-sides-with-google-on-fair-use-but-is-the-ruling-narrower-than-it-seems/)

### Inferences
- **Keyboard shortcut sets.** Lotus treats a command hierarchy as a method of operation. Oracle values letting users reuse skills they already have. Read together, the risk in offering a "SolidWorks-like" or "Fusion-like" shortcut preset looks low. This is an inference, not a holding; no case found here addresses shortcut maps directly. The safer form is to describe the preset functionally ("familiar to users of X") and not to use the other product's trademark as the preset's name, beyond nominative reference.
- **Layout.** Apple v. Microsoft means the general arrangement is not protectable: a tree on the left, a command bar on top, a property panel and a viewport. A pixel-close clone of one vendor's whole screen, including its icons, colours and artwork, invites "look and feel" and trade-dress arguments. Wren should draw its own icons and set its own visual identity (packages/ui tokens).
- Icons, help text, tutorials and sample models are ordinary copyrighted expression. Wren should never copy them.

### Gaps
- I found no US case that squarely holds a keyboard shortcut set unprotectable, and no EU case on CAD UI copyright. In the EU, SAS Institute v. World Programming (CJEU 2012) is the obvious place to look; I did not verify it this session.
- I did not find a trade-dress case involving CAD software.

## A2. Trademarks: which UI names Wren must not reuse

### Takeaway
Treat every vendor-coined UI term as a mark and give Wren its own names, whatever a given registration currently shows. Verified: FeatureManager is a registered SolidWorks mark. SPACEMOUSE registrations exist and are live. ViewCube has a cancelled registration and another filing whose status is unknown. A T-Splines filing exists. Generic descriptive words stay free: "feature tree", "view cube" in lower case as a description, "push/pull", "manipulator", "property panel".

### Cited Findings
- **FeatureManager.** SolidWorks' legal notice lists FeatureManager as a jointly owned registered trademark of DS SolidWorks. Justia shows a FEATUREMANAGER filing dated 16 Oct 1995 covering CAD software. — [SOLIDWORKS 2019 Legal Notices](https://help.solidworks.com/2019/English/WhatsNew/c_copyright_solidworks.htm); [Justia: DS SolidWorks Corp trademarks](https://trademarks.justia.com/owners/dassault-systemes-solidworks-corporation-746862)
- **PropertyManager, CommandManager, Instant3D.** SolidWorks help uses these as product feature names. Instant3D, for example, lets users "quickly create and modify model geometry using drag handles and rulers". I found no registration record for any of the three. — [SOLIDWORKS 2013 UI overview](https://help.solidworks.com/2013/English/SolidWorks/Sldworks/c_user_interface_top.htm)
- **ViewCube.** USPTO Reg. 3446335 (serial 77230378) is marked dead and was cancelled on 11 Jan 2019. A separate VIEWCUBE filing for GUI software, serial 77074599, is also owned by Autodesk; its current status was not confirmed. — [Markinton: VIEWCUBE 77230378](https://markinton.com/trademark/viewcube-77230378); [Justia: Autodesk trademarks](https://trademarks.justia.com/owners/autodesk-inc-2459447/index.html)
- **T-Splines.** Justia lists serial 78682147 for 3D modelling software under Autodesk. Its registration status was not shown. — [Justia: Autodesk trademarks](https://trademarks.justia.com/owners/autodesk-inc-2459447/index.html)
- Autodesk says its published trademark list "may not be comprehensive" and that it also claims common-law marks. Its style guide reserves ® for USPTO-registered marks and ™/℠ for unregistered ones. — [Autodesk trademarks page](https://www.autodesk.com/company/legal-notices-trademarks/trademarks/autodesk-inc); [Autodesk style guide: trademarks](https://styleguide.autodesk.com/trademarks/)
- **McNeel/Rhino.** The registered marks owned by TLM, Inc. (dba Robert McNeel & Associates) include Rhinoceros, Rhino, Rhino3D, Grasshopper and openNURBS. "Gumball" does not appear on McNeel's trademark page. — [Rhino3D trademarks](https://www.rhino3d.com/trademarks); [McNeel trademarks](https://www.rhino3d.com/mcneel/trademarks/)
- **SPACEMOUSE.** USPTO Reg. 2522639 has status "Registered and Renewed", and Reg. 4260608 has status "Partial Section 8 Accepted", so the mark is live. The 3DCONNEXION word mark is Reg. 2935281. — [Justia: SPACEMOUSE 76268322](https://trademark.justia.com/762/68/spacemouse-76268322.html); [Justia: SPACEMOUSE 85576687](https://trademarks.justia.com/855/76/spacemouse-85576687.html); [Markinton: 3DCONNEXION](https://markinton.com/trademark/3dconnexion-76314011)
- **Synchronous Technology.** Siemens uses "synchronous technology" as an umbrella brand and "synchronous modeling" for direct editing of faces, edges and vertices. — [Siemens: synchronous technology](https://www.sw.siemens.com/en-US/technology/synchronous-technology/)

### Inferences
- Rename table for Wren. Each proposed name is generic and descriptive:

| Avoid | Use instead |
|---|---|
| ViewCube | "orientation cube" or "view widget" |
| FeatureManager | "feature tree" or "history" |
| PropertyManager | "properties panel" or "inline editor" |
| CommandManager | "command bar" |
| Instant3D | "drag-to-edit" or "live handles" |
| Gumball | "transform manipulator" |
| Press Pull | "push/pull" or "offset face" |
| T-Splines | "SubD" |
| Synchronous Technology | "direct edit" |
| SpaceMouse | "3D mouse" / "6DoF controller" in the UI |

- Naming a product to state compatibility is ordinary nominative fair use, for example "Supports 3Dconnexion SpaceMouse devices" or "SolidWorks-style shortcuts". It should not appear in a way that suggests endorsement. This is an inference, not a cited holding.
- Even where a registration has lapsed (ViewCube 3446335), Autodesk may keep common-law rights through continued use. Avoid the name regardless.

### Gaps
- Not verified in TESS/TSDR or EUIPO this session: PROPERTYMANAGER, COMMANDMANAGER, INSTANT3D, GUMBALL, PRESS PULL, SYNCHRONOUS TECHNOLOGY, and the live status of VIEWCUBE serial 77074599 and T-SPLINES serial 78682147. A direct TSDR or EUIPO eSearch lookup is needed.

## A3. Patents on CAD UI and interaction, and their status

### Takeaway
The core marking-menu patents (Kurtenbach; Silicon Graphics, then Alias, then Autodesk) are all expired. Radial and marking menus, including right-drag gesture menus, are free to use as far as the verified patents go. The one live risk found is US 7,782,319, the ViewCube patent: active, with an anticipated expiry of 6 Mar 2029. Its claims describe a cube with faces, edges and corners mapped to viewpoints, so an orientation cube with clickable faces, edges and corners needs counsel review or a design-around. Onshape/PTC's branch-and-merge CAD patent, US 10,691,844, is active until about 2036. No Shapr3D, SolidWorks mouse-gesture, S-key or Siemens synchronous patents were confirmed this session.

### Cited Findings
- **US 5,689,667**, "Methods and system of controlling menus with radial and linear portions". Inventor Gordon P. Kurtenbach; original assignee Silicon Graphics, later Alias (Autodesk Canada by amalgamation, 2007). Filed and with priority 6 Jun 1995; granted 18 Nov 1997. Status: **Expired – Lifetime**, anticipated expiry 6 Jun 2015. — [Google Patents US5689667A](https://patents.google.com/patent/US5689667A)
- Family members listed on the same page:

| Patent | Filed | Status |
|---|---|---|
| US 5,926,178 (continuation) | 1 Apr 1997 | Expired – Lifetime |
| US 6,618,063 | 8 Mar 1999 | Expired – Lifetime |
| US 8,832,597 (Autodesk) | 3 Jul 2003 | Expired – Fee Related |

  — [Google Patents US5689667A](https://patents.google.com/patent/US5689667A); [uspto.report 8832597](https://uspto.report/patent/grant/8832597)
- Patents citing that family include US 2007/0168890 A1, "Position-based multi-stroke marking menus" (Microsoft, published 2007), and US 10,180,714 B1, "Two-handed multi-stroke marking menus for multi-touch devices" (Pixar, published 15 Jan 2019). Their statuses were not shown. — [Google Patents US5689667A](https://patents.google.com/patent/US5689667A)
- Other marking-menu-related Autodesk/Kurtenbach patents exist, for example US 7,555,726 (pop-up interfaces overlapping marking-menu zones). Its status was not checked. — [Justia: Autodesk patents](https://patents.justia.com/assignee/autodesk-inc?page=44)
- **US 7,782,319**, "Three-dimensional orientation indicator and controller" (the ViewCube). Assignee Autodesk. Inventors Ghosh, Mordatch, Khan, Fitzmaurice, Matejka, Schmidt and Kurtenbach. Filed and with priority 28 Mar 2007; granted 24 Aug 2010. Status: **Active – Reinstated**, adjusted anticipated expiry **6 Mar 2029**. The abstract describes a 3D representation with faces, edges and corners, each mapped to a viewpoint; manipulating it reorients the scene. — [Google Patents US7782319](https://patents.google.com/patent/US7782319)
- The ViewCube was also published as an academic paper: Khan, Mordatch, Fitzmaurice, Matejka and Kurtenbach, ACM I3D 2008. — [Autodesk Research: ViewCube](https://www.research.autodesk.com/publications/viewcube-a-3d-orientation-indicator-and-controller/)
- **US 7,814,436**, "3D scene orientation indicator system with scene orientation change capability". Autodesk (Alias); inventors Schrag and Watanabe. Filed 28 Jul 2003; granted 12 Oct 2010. Status: **Expired – Lifetime**, anticipated expiry 11 Dec 2025. It covers a corner-fixed orientation widget whose direction controls rotate the view and frame the object. — [Google Patents US7814436](https://patents.google.com/patent/US7814436)
- **US 8,132,123**, the related Schrag/Watanabe patent (granted 6 Mar 2012), and **US 9,043,707**, "Configurable viewcube controller" (2012 provisional, inventor Porwal), both exist. Their statuses were not checked. — [uspto.report 8132123](https://uspto.report/patent/grant/8132123); [USPTO PDF 9043707](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9043707)
- **US 10,691,844 B2**, "Multi-user cloud parametric feature-based 3D CAD system with branch and merge". Inventors Lauer, Baran, Eyre and Gallo (Onshape; assigned to PTC after the 2020 merger). Priority 25 Feb 2015, filed 13 Sep 2019, granted 23 Jun 2020. Status: **Active**, anticipated expiry **24 Feb 2036**. It is a continuation of application 15/052,418, "Multi-User Cloud Parametric Feature-Based 3D CAD System", filed 24 Feb 2016. — [Google Patents US10691844](https://patents.google.com/patent/US10691844)
- Onshape describes its versioning as a tree of microversions, comparable to git commits, with workspaces comparable to branches. Merge applies the delta between the source branch and the common ancestor. — [Onshape blog: how collaboration works](https://www.onshape.com/en/blog/under-the-hood-how-collaboration-works); [Onshape help: merging](https://cad.onshape.com/help/Content/Document/merging.htm)
- **Siemens Synchronous Technology** was announced in 2008 as "patent-pending" and built on D-Cubed and Parasolid. No patent numbers were found. — [Digital Engineering 24/7](https://www.digitalengineering247.com/article/siemens-plm-introduces-history-free-feature-based-modeling); [Manufacturing Management](https://www.manufacturingmanagement.co.uk/content/news/siemens-plm-says-synchronous-technology-set-to-speed-complex-modelling-100-fold)
- **SolidWorks mouse gestures.** A right-drag in the graphics area shows a radial guide of 4 or 8 directions, and the command fires on passing the target; releasing inside the guide cancels. No patent record surfaced in search. — [SOLIDWORKS 2010 help: mouse gestures](https://help.solidworks.com/2010/english/SolidWorks/sldworks/AllContent/SolidWorks/Core/UI/t_mouse_gesture_Using_Commands.htm); [DraftSight 2025 help: 8 gestures](https://help.solidworks.com/2025/English/DraftSight/additional/mg_8gestures.htm)
- **Shapr3D.** A search turned up no US patent grants assigned to Shapr3D. — [search results were unrelated; e.g. Verdict patent digest](https://www.verdict.co.uk/?p=375460)

### Inferences
- **Right-click or right-drag radial and marking menus, including a "repeat last command" slot.** The foundational Kurtenbach family (5,689,667; 5,926,178; 6,618,063; 8,832,597) is expired, and SolidWorks has shipped right-drag gestures publicly since at least 2010, which also counts as prior art. Low risk on verified evidence, but not a clearance search. A "repeat last" slot is a menu-content choice. No patent on it was found; that is a gap, not a clearance.
- **Orientation cube.** Until 6 Mar 2029, Wren should not clone the ViewCube interaction of clickable faces, edges and corners mapped to viewpoints without a claims review by counsel. Possible design-arounds, all needing review:
  - an axis triad or gizmo with clickable axis endpoints (Blender-style);
  - a standard-views dropdown or pie menu;
  - a non-cube widget.

  US 7,814,436, the corner widget with direction controls that rotate and frame the view, has expired. That suggests simpler corner widgets are freer. This is an inference; claim scope was not read.
- **Branching and merging.** Wren's local-first design history should not copy Onshape's patented claims without review, which means reading the claims of US 10,691,844 and of its parent if granted. Git-style branching of a feature history is a broad idea with prior art in software VCS, but the claims, not the idea, determine risk.
- **GPL-3.0 and patents.** Section 11 of GPL-3.0 governs contributors' own patents; it does nothing about third-party patents. This is a general observation, not sourced this session.

### Gaps
- No claim text was read for any patent; the claims sections were cut off in the fetched pages. Scope conclusions above come from abstracts only.
- Not confirmed:
  - status of US 8,132,123, US 9,043,707 and US 7,555,726;
  - whether 15/052,418 (Onshape parent) issued as a patent, and its number;
  - other Onshape/PTC patents, for example on microversions or "collaboration cues";
  - Siemens synchronous-modelling patent numbers;
  - any SolidWorks/Dassault patent on mouse gestures or the "S key" shortcut bar;
  - any patent on a "repeat last command" radial slot;
  - Shapr3D patents in EPO or HU records.

  Each needs a targeted Google Patents assignee search, for example `assignee:"Dassault Systemes SolidWorks" gesture`.
- A USPTO PDF titled "Cursor control for a visual user interface" (US 10,599,282) appeared in a bubble-cursor search. I did not verify whether it relates to bubble-cursor-style target expansion.

## A4. What open-source CAD and 3D projects have done

### Takeaway
Blender ships pie menus (radial menus) built in, and third parties sell full "marking menu" add-ons. I found no record of Blender developers documenting legal concerns. Community discussion assumed the Autodesk patents had expired, and the patent records above confirm the core family has.

### Cited Findings
- Blender has built-in pie menus. A third-party "Marking Menus" add-on is sold on Blender Market/Superhive. — [Superhive: Marking Menus](https://superhivemarket.com/products/marking-menus); [Blender bf-funboard 2014 list post on pie menus](https://lists.blender.org/pipermail/bf-funboard/2014-April/005806.html)
- In a 2014 Blender Artists thread, users speculated that the Autodesk marking-menu patents were "filed around '99" and would expire. No Blender developer commented on legal concerns. Posters distinguished marking menus from pie menus by nesting: a stroke reaches deep items without the menu being drawn. — [Blender Artists thread](https://blenderartists.org/t/when-will-marking-menu-patent-expire/618541)
- A Rhino forum user stated that "Alias had them for decades, their patent has expired" while requesting marking menus. That is a user claim, though consistent with Google Patents status. — [McNeel Discourse](https://discourse.mcneel.com/t/rhino-8-development/112418/99); [Google Patents US5689667A](https://patents.google.com/patent/US5689667A)
- Rhino's 3Dconnexion support is developed by 3Dconnexion, not McNeel. — [McNeel wiki: Spaceball](https://wiki.mcneel.com/spaceball)

### Inferences
- Wren can cite Blender's pie menus as practical precedent that radial menus are used freely in GPL software. It should still make its own designs and not copy Blender's artwork, since Blender's code is GPL, which is compatible with Wren's licence, but its icons may have their own terms.

### Gaps
- FreeCAD's NaviCube (an orientation cube) and any discussion there of the ViewCube patent were not researched this session. The FreeCAD forum and wiki should be checked for precedent and prior-art dates.

## B1. Command selection: radial/marking menus, linear menus, hotkeys, and the novice-to-expert transition

### Takeaway
The evidence consistently favours radial selection over linear menus for speed and errors: pie menus were about 15% faster with fewer errors in one study. Field data show marks running about 3.5× faster than menu selection once users are expert. Users do not move to hotkeys on their own. Techniques that show the hotkey on the command when a modifier is held (ExposeHK) raised hotkey adoption and speed.

### Cited Findings
- **Callahan, Hopkins, Weiser & Shneiderman, CHI '88** (pp. 95–100, DOI 10.1145/57167.57182). Pie menus gave shorter target seek time and lower error rates than linear menus and were rated subjectively equivalent. Each participant used 15 menus four times, twice per type. — [UMIACS record](https://sites.umiacs.umd.edu/node/16962); [HCI Museum: pie menu](https://hci-museum.lisn.upsaclay.fr/pie-menu)
- Co-author Don Hopkins later reported pie menus as about 15% faster with a significantly lower error rate. That figure comes from a retrospective, not the paper's abstract. — [OSNews: Pie menus, a 30-year retrospective](https://www.osnews.com/story/30371/pie-menus-a-30-year-retrospective/)
- **Kurtenbach & Buxton, CHI '94** ("User learning and performance with marking menus", pp. 258–264). In a real work setting, a mark was on average 3.5× faster than selecting from the menu. Experts used marks extensively but sometimes reopened the menu to refresh their memory of the layout. This was a field case study and not a controlled experiment; a critical summary notes it had 2 users. — [Autodesk Research](https://research.autodesk.com/publications/user-learning-and-performance-with-marking-menus); [Bill Buxton](https://billbuxton.com/MMUserLearn.html); [Berkeley summary](https://people.eecs.berkeley.edu/~fox/summaries/ui/marking_menus.html)
- Kurtenbach, Sellen & Buxton (1993, *Human-Computer Interaction*) ran a controlled experiment on articulatory and cognitive aspects of marking menus. — [Microsoft Research](https://www.microsoft.com/en-us/research/?p=286127)
- Marking menus are designed so that the novice path (wait, see the menu, select) rehearses the same physical movement as the expert path (a quick mark). That is the mechanism behind the novice-to-expert transition. — [Bill Buxton: marking menus](https://billbuxton.com/PieMenus.html)
- **Malacria, Bailly, Harrison, Cockburn & Gutwin, "Promoting Hotkey Use through Rehearsal with ExposeHK", CHI 2013** (pp. 573–582). Holding a modifier overlays each command's hotkey on its toolbar, menu or ribbon button. Across three studies, participants used hotkeys more and were faster than with pointing or other hotkey-learning methods, and they strongly preferred ExposeHK. — [HAL](https://hal.archives-ouvertes.fr/hal-01894253); [Springer Professional / ACM DOI](https://www.springerprofessional.de/doi/10.1145/2470654.2470735); [CORE PDF](https://core.ac.uk/download/162998396.pdf)
- **Bailly, Lecolinet & Nigay, "Visual Menu Techniques"**, ACM Computing Surveys 49(4), Article 60, DOI 10.1145/3002171. Sources date it Dec 2016 or 2017. It gives a taxonomy of menu properties, quality criteria, and a review of the predictive models and empirical methods used to evaluate menus. — [LIG/IIHM](https://iihm.imag.fr/en/publication/BLN17a/); [HAL](https://hal.archives-ouvertes.fr/hal-01258368v1)
- **Hinckley et al., Springboard (CHI 2006).** A keystroke-level analysis of the true cost of each technique found that a local marking menu was not significantly faster than a round trip to a tool palette. Measured gains depend on the full cost of selection, not on menu traversal alone. — [Springboard CHI 2006 PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/11/Springboard-CHI-2006.pdf)

### Inferences
For Wren:
- Use a right-drag or hold-key radial menu where the novice pop-up and the expert flick are the same gesture.
- Keep it to 8 or fewer items per level.
- Show hotkeys in an ExposeHK-style overlay while a modifier is held, on the command bar and on the radial menu.
- Measure total selection cost, including homing and travel, not menu time alone.

### Gaps
- Not retrieved this session; these are primary sources a follow-up should cite:
  - Grossman et al., "Strategies for accelerating on-line learning of hotkeys" (CHI 2007);
  - Scarr et al., "Dips and ceilings" (CHI 2011) on the novice-to-expert transition;
  - Zhao and Balakrishnan, "Simple vs. compound mark hierarchical marking menus" (UIST 2004);
  - command-search studies, for example Autodesk's command search or Fennedy et al.
- I found no gesture-discoverability study specific to CAD. The SolidWorks gesture guide (a radial preview that appears during the drag) is a shipped example, not a study. — [SOLIDWORKS help](https://help.solidworks.com/2010/english/solidworks/sldworks/allcontent/solidworks/core/ui/t_8gestures.htm)

## B2. Cost of mode errors, and quasimodes

### Takeaway
Spring-loaded modes (quasimodes), which last only while a key is held, reduce mode errors compared with latched modes. Sellen, Kurtenbach and Buxton found that a held foot pedal cut errors while a latching pedal did not. I found no study putting a dollar or time cost on mode errors in CAD.

### Cited Findings
- Sellen, Kurtenbach & Buxton (1992), "The prevention of mode errors through sensory feedback". Holding a foot pedal reduced errors in a text editor; a latching pedal did not. Reported here as cited by Hinckley et al. — [Springboard CHI 2006 PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/11/Springboard-CHI-2006.pdf)
- Spring-loaded modes help users stay aware of system state. They don't scale, because there is not a key for every mode, so designers must use them sparingly. — [Springboard CHI 2006 PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/11/Springboard-CHI-2006.pdf)
- Raskin argued that modes are harmful and quasimodes are not. This is an advocacy source. — [Raskin Center: core principles](https://www.raskincenter.org/rchi/core-principles); [Raskin Center: modes are still harmful](https://www.raskincenter.org/ideas/modes-are-harmful/)

### Inferences
- For Wren:
  - Make temporary tool states hold-to-activate: hold a key to snap or suppress inference, and hold for an orbit override.
  - Show the active mode persistently near the cursor, which is the sensory-feedback finding.
  - Have Esc always exit to the neutral selection state.
- Sketch mode versus part mode is an unavoidable latched mode, so it needs strong visual differentiation.

### Gaps
- No quantitative CAD mode-error cost data was found. Dillon, Edey & Tombaugh, "Measuring the True Cost of Command Selection" (CHI '90), was cited but not retrieved.

## B3. Hover pre-highlight and disambiguating overlapping targets

### Takeaway
The Bubble Cursor sizes its activation area dynamically so that exactly one target is always captured. It significantly beat both a point cursor and object pointing, and its performance follows Fitts' law. Most CAD tools pre-highlight by default (Creo, for example), but I found no controlled study of pre-highlight in CAD. The evidence is vendor documentation and practitioner opinion.

### Cited Findings
- **Grossman & Balakrishnan, "The Bubble Cursor", CHI 2005** (pp. 281–290, DOI 10.1145/1054972.1055012). The activation area resizes with the distance to nearby targets so that exactly one target is inside it. In 1D and 2D tasks at varying target densities it significantly outperformed the point cursor and object pointing, and Fitts' law predicted its performance. — [Paper PDF (DGP Toronto)](https://www.dgp.toronto.edu/papers/tgrossman_CHI2005.pdf); [ACM DOI](https://dx.doi.org/10.1145/1054972.1055012); [HCI Museum](https://hci-museum.lisn.upsaclay.fr/the-bubble-cursor)
- PTC Creo enables preselection highlighting by default to help users target geometry accurately, with query tooltips and cycling through candidates. — [PTC Creo help: query and preselection highlighting](https://support.ptc.com/help/creo/creo_pma/r11.0/usascii/fundamentals/fundamentals/About_Query_and_Preselection_Highlighting.html)
- On large imported models, pre-highlight can try to highlight the whole part, and some engineers disable it. A commenter noted that some form of pre-highlight is "a standard" across current CAD/CAM/CAE. — [PTC Community thread](https://community.ptc.com/t5/Creo-Modeling-Questions/prehighlighting-of-imported-geometry-a-sign-of-weakness/m-p/342612)
- AutoCAD's "Selection Preview" is a configurable pre-highlight setting. — [Novedge AutoCAD tip](https://novedge.com/blogs/design-news/autocad-tip-configure-autocad-selection-preview-for-faster-safer-editing)

### Inferences
For Wren:
- Pre-highlight the pick candidate on hover. The budget must hold on large models, which means highlighting the sub-element, never the whole body.
- Use a bubble-cursor-style or proximity-weighted pick for edges and vertices, which are tiny targets in the viewport.
- Offer a "which one?" chooser, Creo-style query cycling, or a popup list when several candidates lie under the cursor. This is consistent with the golden rule "never silently guess".

### Gaps
- No peer-reviewed study of pre-highlight or occluded-target choosers in CAD was found. Candidates to look up include Grossman's 3D-volume selection work (e.g. "Depth Ray" and "Flower Ray", UIST 2006) and the SQUAD/Vanacken disambiguation studies in VR; none were verified this session.
- Bubble-cursor patent status is unknown.

## B4. CAD-specific usability: pre-selection vs post-selection, inline vs modal editing, error recovery, and metrics

### Takeaway
I found little peer-reviewed, CAD-specific usability evidence through general search. The useful findings are design data from vendor documentation and a caution that click counts alone are a weak efficiency proxy. 3D-mouse studies report about 28% shorter task time, but the work was vendor-commissioned.

### Cited Findings
- A forum caution from Onshape users: fewer logged clicks do not necessarily mean a faster or more efficient interface. — [Onshape forum: standard selection interface](https://forum.onshape.com/discussion/13704/standard-selection-interface)
- SolidWorks Instant3D drag handles and rulers edit geometry directly in the viewport, an inline alternative to a dialog. — [SOLIDWORKS 2013 UI overview](https://help.solidworks.com/2013/English/SolidWorks/Sldworks/c_user_interface_top.htm)
- Siemens frames history-free direct editing as defining dimensions and rules at creation or edit time "without ordering or reordering a history". This is a vendor position on recovery from history-order errors. — [Siemens: synchronous technology](https://www.sw.siemens.com/en-US/technology/synchronous-technology/)
- One VR-CAD element-selection study found VR easier, more intuitive and less frustrating than 2D software in usability tests, and recommends action feedback. — [Springer chapter](https://link.springer.com/content/pdf/10.1007%2F978-3-319-91581-4_2.pdf)

### Inferences
- Suggested metrics for Wren's UX harness. These are proposals, not established standards:
  - time-on-task per canonical feature (sketch rectangle → extrude → fillet);
  - total pointer travel;
  - clicks and keystrokes per feature;
  - mode switches per feature;
  - errors and undos per task.

  Use them alongside `pnpm perf`, and report clicks only together with time.

### Gaps
- Not found:
  - peer-reviewed studies comparing pre-selection (select then command) with post-selection (command then select) in CAD;
  - inline versus modal dialogs in CAD;
  - error recovery in history-based modelling (rebuild failures, topological naming).
- I found no recognised published "clicks-per-feature" benchmark for CAD.
- Journals to search directly: Computer-Aided Design and Computer-Aided Design & Applications, for example "usability of parametric CAD" and "CAD rebuild errors". The "Wuppertal" thesis PDF in the results was not opened.

## B5. 6DoF input and CAD mice: evidence, hardware, browser access, licensing and IP

### Takeaway
A vendor-commissioned Fraunhofer study reports 28% faster CAD task completion with a 3D mouse. Browser access to these devices has three routes:
- **WebHID:** desktop Chromium only (Chrome/Edge 89+); not Firefox or Safari, and therefore not on iPadOS.
- **3DconnexionJS:** 3Dconnexion's official web route. It needs the proprietary 3DxWare 10 driver plus a local Navigation Library/Proxy, and is distributed under a proprietary SDK licence.
- **spacenav-ws:** an unofficial bridge for Linux, built by reverse-engineering Onshape's client traffic.

The SPACEMOUSE mark is live; use it only to state compatibility.

### Cited Findings
- **Productivity.** In a Fraunhofer lab study commissioned by 3Dconnexion, a random CAD task took 68 minutes with a 3D mouse and 96 minutes without, a 28% reduction. Participants were 14 advanced CAD students. The 3D mouse also brought 29% fewer hand and finger movements and fewer mouse-wheel zoom actions. — [Digital Engineering 24/7](https://digitalengineering247.com/article/3d-mice-improve-ergonomics-at-cad-workstations-study-shows); [3Dconnexion: increase productivity](https://3dconnexion.com/ba/?p=5288)
- An anecdote: one user (ESAB, 2004) reported design time down about 30%. — [Machine Design](https://machinedesign.com/news/article/21815220/new-cad-maxim-two-hands-are-better-than-one)
- Academic work: two-handed setups can reduce errors. A fully integrated 6DoF SpaceMouse compared unfavourably with separated rotation control for 3D object manipulation (Globefish study). — [Kulik et al., Bauhaus-Uni Weimar PDF](https://www.uni-weimar.de/fileadmin/user/fak/medien/professuren/Virtual_Reality/documents/publications/kulik_globefish_small.pdf)
- **CadMouse (2D CAD mouse).** It has a dedicated middle button that needs less force than a wheel click, a radial-menu button behind the wheel that opens a 4- or 8-segment app-specific radial menu, and "Smart Scroll" with adjustable speed and inertia. 5 of its 7 buttons are programmable, and it needs 3DxWare 10.8.0+. — [Novedge: CadMouse Pro](https://novedge.com/products/buy-cadmouse-pro); [AUGI review](https://augi.com/articles/detail/product-review-3d-connexion-cadmouse); [CadMouse Pro manual (Distrelec)](https://media.distrelec.com/Web/Downloads/_m/an/CADMousePro_eng_man.pdf)
- **WebHID support.** Chrome 89+ and Edge 89+ support it. Firefox and Safari do not; Mozilla's standards position calls WebHID harmful. Mobile browsers do not support it. — [Chrome Developers: Connect to uncommon HID devices](https://developer.chrome.com/docs/capabilities/hid); [TestMu: WebHID support](https://www.testmuai.com/web-technologies/webhid-ie/)
- **3Dconnexion's official web route.** A 3Dconnexion forum moderator describes 3DconnexionJS as a documented interface for third-party web apps, with docs in the 3DxWare SDK's "web" directory, which also covers Mac. In a 2026 thread, a moderator said the only browser input APIs they know of are WebHID and the Gamepad API. Web apps that want an app-specific driver profile must contact 3Dconnexion's certification programme. — [3Dconnexion forum: browser-based 3D app](https://forum.3dconnexion.com/viewtopic.php?p=125693); [3Dconnexion forum](https://forum.3dconnexion.com/viewtopic.php?p=117086)
- The npm package **@3dconnexion/3dconnexionjs** (v0.8.1) needs 3DxWare 10: 10.6.1+ on macOS, 10.8.12+ on Windows. Its supporting software is the Navigation Library and the Navigation Proxy executables. It bundles Autobahn|JS (WAMP/WebSocket) and ships a `LicenseAgreementSDK.txt`; there is no standard OSS licence. — [pkgstats: @3dconnexion/3dconnexionjs](https://www.pkgstats.com/pkg:@3dconnexion/3dconnexionjs)
- A user reported that the navlib server provides 3D mouse state over WebSocket/WAMP. 3Dconnexion staff said further server documentation was not available. Another staff post said there is no SDK documenting web use, which conflicts with the 3DconnexionJS statements. — [3Dconnexion forum: websocket interface](https://forum.3dconnexion.com/viewtopic.php?p=77375); [3Dconnexion forum](https://forum.3dconnexion.com/viewtopic.php?p=77384)
- **Onshape and Linux.** 3Dconnexion's web-driver work targets Windows and Mac. The community package `spacenav-ws` bridges the open-source spacenavd driver to Onshape over WebSocket; its author built it by reverse-engineering Onshape's Windows client traffic. — [PyPI: spacenav-ws](https://pypi.org/project/spacenav-ws/); [Onshape forum: 3Dconnexion driver for Linux](https://forum.onshape.com/discussion/5651/3dconnexion-driver-for-linux)
- **SDK licensing.** The 3D input development tools are "provided under license from 3Dconnexion", so the licence is proprietary. A forum user read the bundled licence as allowing headers and libraries to be redistributed but not DLLs. The 3DxWare driver is proprietary. — [SideFX Houdini third-party licences: 3DxWare SDK](https://www.sidefx.com/docs/houdini/licenses/3DxWare.html); [3Dconnexion forum](https://forum.3dconnexion.com/viewtopic.php?p=31555); [winget: 3DxWare 10](https://wingetgui.com/apps/3Dconnexion-3DxWare-10)
- **Trademarks.** SPACEMOUSE is live (Reg. 2522639 "Registered and Renewed"; Reg. 4260608). 3DCONNEXION is Reg. 2935281. — [Justia: SPACEMOUSE](https://trademark.justia.com/762/68/spacemouse-76268322.html); [Markinton: 3DCONNEXION](https://markinton.com/trademark/3dconnexion-76314011)

### Inferences
- **Recommended layering for Wren.** All three paths are optional and feature-detected:
  1. WebHID on Chromium desktop. Parse the 6DoF HID reports in Wren's own GPL code, without the SDK, and keep any vendor/product-ID table as plain data.
  2. Optionally, 3DconnexionJS when the user has 3DxWare installed. Load it at runtime and do not vendor it, so that proprietary code is never combined into the GPL bundle. Wren must self-host its assets, so whether the npm package may be redistributed has to be checked against `LicenseAgreementSDK.txt`.
  3. A documented localhost WebSocket protocol that spacenavd bridges can target on Linux.
- Safari and iPadOS have no WebHID, so 3D mice there would need 3DxWare plus 3DconnexionJS (macOS only). On iPad there is no known path.
- GPL-3.0 compatibility of the proprietary 3DconnexionJS is uncertain. Treating it as a separately installed, user-provided component loaded at runtime avoids distributing it, but it is a licensing question for counsel. Raw HID is the clean GPL path.
- A CadMouse radial-menu button reaches Wren as an ordinary mouse button or keystroke, depending on driver configuration. Wren should let users bind any button to open its own radial menu. No 3Dconnexion radial-menu patent was found; that is a gap, not a clearance.

### Gaps
- Not obtained:
  - the text of `LicenseAgreementSDK.txt` or the 3DxWare SDK EULA (it ships inside the SDK download);
  - HID report descriptors and vendor/product IDs for SpaceMouse Compact, Wireless, Pro, Enterprise and SpaceNavigator;
  - whether Gamepad API exposure works in practice;
  - alternative-vendor devices, such as SpaceControl (an old SPACE MOUSE filer per [Justia](https://trademark.justia.com/owners/space-control-gesellschaft-fur-3d-systeme-mbh-603957)) and current competitors;
  - 3Dconnexion patents on the radial-menu button or on puck mechanics;
  - Onshape's current official mechanism, beyond the community reports above.
