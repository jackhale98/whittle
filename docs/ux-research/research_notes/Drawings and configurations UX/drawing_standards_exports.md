# Drawing standards and export requirements for Wren M4 (PDF, SVG, DXF)

Scope note: these notes are for PLAN M4. The acceptance criteria are a vector PDF that prints at exactly 1:1 (measured) and a DXF that opens correctly in LibreCAD and QCAD. The PLAN stack is an SVG DOM drawing editor, PDF output via jsPDF + svg2pdf.js, and DXF output via `@tarikjabiri/dxf` or a minimal R12/R2000 writer (docs/PLAN.md, M4 and the stack table).

Labels used below: **[N]** = normative (the standard requires it, as reported by the source). **[P]** = common practice, vendor or community guidance. Most standards text is paywalled, so many findings come from secondary summaries, standards-body preview PDFs (iTeh samples) or forum quotes. Each finding says where it came from. Before shipping a template, check exact figures against licensed copies.

## 1. Projection and views (ISO 128 / ISO 5456, ASME Y14.3)

### Takeaway
Wren must support first-angle (ISO default) and third-angle (ASME/US default) projection as a per-drawing setting. The setting drives where projected views go and which truncated-cone symbol appears in the title block. The two methods differ only in where projected views go relative to the front view. The cone symbols are mirror images of each other, and secondary sources describe them inconsistently. Draw the symbol from the standard figure, not from a blog.

### Cited Findings
- [N] Third-angle projection is the US convention (ASME Y14.3 / ANSI). First-angle is the ISO convention, per ISO 5456-2 — [open-exam-prep, projection](https://open-exam-prep.com/study-guides/asq-cqt/technical-drawings-gdt/engineering-drawing-projection); [Xometry, first vs third angle](https://xometry.pro/en/articles/first-angle-third-angle-projection/)
- [N] In third angle the top view sits above the front view. In first angle it sits below. The front view is placed the same way in both — [Xometry](https://xometry.pro/en/articles/first-angle-third-angle-projection/)
- [N] Symbol: in the third-angle symbol the small end of the frustum faces the concentric circles. The first-angle symbol is the reverse. Sources conflict on how to describe this, and one gives a contradictory left/right rule — [open-exam-prep](https://open-exam-prep.com/study-guides/asq-cqt/technical-drawings-gdt/engineering-drawing-projection); [Eng-Tips thread on determining projection type](https://www.eng-tips.com/threads/request-for-recommended-approaches-for-determining-projection-type-in-engineering-drawings.518366/page-2)
- [N] ASME Y14.3 governs orthographic and pictorial views. It sizes the projection symbol relative to the drawing's text height. ASME Y14.1 points to Y14.3 for the symbol — [Eng-Tips thread](https://eng-tips.com/threads/request-for-recommended-approaches-for-determining-projection-type-in-engineering-drawings.518366/latest)
- [N] ISO line type F (chain line, thick at the ends and at changes of direction, thin elsewhere) is used for cutting planes. This is the line a section view's cutting-plane indicator uses — [draftsperson.net, pen sizes and line types](https://blog.draftsperson.net/pen-sizes-and-line-types-metric/)

### Inferences
- The projection method is a document-level enum (`first` | `third`). It must affect (a) where projected views are placed when they are created, (b) the title-block symbol, and (c) the projection check in the certification-style E2E. A spec drawing may use either.
- Both cone symbols should be generated as parametric geometry sized from the drawing's base text height. That matches the Y14.3 approach reported above and keeps the symbol consistent across templates.
- Section views need: a cutting-plane line using ISO type F (or the ASME equivalent), with arrows and letters at each end; a view label "SECTION A–A"; and hatching inside the cut faces (see §2). Detail views need a circle or other boundary drawn with a thin line, a letter, and a label with the scale (e.g. "DETAIL B (2:1)"). The exact label formats were not verified this pass (see Gaps).

### Gaps
- I did not retrieve exact ISO 128-3 (2020, views/sections) or ASME Y14.3-2012 requirements for section labels, arrow direction, letter exclusions (I, O, Q are commonly excluded), detail-view label wording, broken-view break lines, auxiliary-view alignment, or revolved and removed sections. These are well known in drafting practice but unsourced here. Confirm them against the standards or a textbook such as Giesecke's *Technical Drawing*.
- Some modern ISO references say ISO 128-30/-34/-40/-44 were consolidated into ISO 128-3:2020. This was not confirmed in this pass.

## 2. Lines, hatching and text (ISO 128, ISO 3098, ASME Y14.2)

### Takeaway
ISO line widths come from a fixed √2 series in mm. Mechanical drawings use two widths in a 1:2 ratio, e.g. 0.5/0.25 or 0.35/0.18. ASME Y14.2 uses about 0.6 mm thick and 0.3 mm thin, with lettering of at least 3 mm (0.12 in). Both standards say the widths exist to tell thick from thin, not as pass/fail values. Wren should store widths in mm, in named line groups, and never in screen px.

### Cited Findings
- [N] The ISO 128-20 width series is 0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1, 1.4 and 2 mm. Each step is about √2. Extra-wide, wide and narrow lines are in a 4:2:1 ratio — [ISO 128-20:1996 sample (iTeh)](https://cdn.standards.iteh.ai/samples/1408/f62555427b87436eafe1e6abc5271860/ISO-128-20-1996.pdf); [draftsperson.net](https://blog.draftsperson.net/pen-sizes-and-line-types-metric/)
- [N] ISO 128-24 (mechanical engineering): two widths are normally used, in a 1:2 ratio — [ISO 128-24:1999 sample (iTeh)](https://cdn.standards.iteh.ai/samples/29095/b2e50c3f669649ae9387373c7a73346d/ISO-128-24-1999.pdf)
- [P] FreeCAD TechDraw ships "line groups" as presets: 0.25/0.13, 0.35/0.18, 0.5/0.25 and 0.7/0.35 (thick/thin). This is a useful precedent for an open-source tool — [FreeCAD LineGroup.csv mirror](https://huggingface.co/AbdulElahGwaith/FreeCAD/blob/main/src/Mod/TechDraw/LineGroup/LineGroup.csv)
- [N] Common ISO line types: A continuous thick (visible outlines), B continuous thin (dimension, extension and hatch lines), D dashed (hidden), E thin chain (centre lines), F chain thick at ends and changes of direction (cutting planes), G thick chain — [draftsperson.net](https://blog.draftsperson.net/pen-sizes-and-line-types-metric/)
- [N] ASME Y14.2 (forum readings of the 2008 edition): thin lines at least 0.3 mm, thick lines at least 0.6 mm, lettering at least 3 mm. A Machinery's Handbook summary of Y14.2M-1992 gives 0.6 mm solid and 0.3 mm hidden for 1:10 scale or larger. The two readings disagree on what the 0.3 mm applies to — [Eng-Tips Y14.2 thread](https://www.eng-tips.com/threads/asme-y14-2.497711); [Machinery's Handbook 31st ed. via flippingbook](https://online.flippingbook.com/view/954192180/1555)
- [N] ASME Y14.2 says the approximate line widths are there to tell thick from thin and are "not values influencing acceptance or rejection of drawings". Machinery's Handbook reports the same note for the ISO widths — [Machinery's Handbook 31st ed. p.684](https://online.flippingbook.com/view/954192180/684)
- [P/N] US course notes that cite Y14.2 give 3 mm (0.12 in) for notes, dimensions and title-block text, and 6 mm for titles and view labels — [LibreTexts, Lines and Lettering](https://eng.libretexts.org/Courses/Western_Technical_College/Inventor_Parametric_Design%3A_Level_1_(Bahl)/01%3A_Technical_Drawings/1.01%3A_Understanding_Technical_Drawings/1.1.04%3A_Lines_and_Lettering)
- [N] Y14.2 accepts lettering of other heights or proportions if it meets minimum legibility and reproduction requirements — [Eng-Tips, fonts per Y14.2-2014](https://www.eng-tips.com/threads/fonts-per-y14-2-2014-standards.478590)
- [N] The ISO 3098 nominal text heights are 1.8, 2.5, 3.5, 5, 7, 10, 14 and 20 mm, a √2 progression like ISO 216 paper. One source attributes the list to BS rather than ISO directly — [cadsetterout, lettering heights](https://cadsetterout.com/drawing-standards/lettering-heights/); [Roymech, lettering](https://www.roymech.co.uk/Useful_Tables/Drawing/Lettering.html)
- [N] ISO 3098-0:1997: stroke width is h/10 for type B and h/14 for type A. Type B is preferred — [ISO 3098-0:1997 sample (iTeh)](https://cdn.standards.iteh.ai/samples/24792/1811286881f24ea49763a66a747029c8/ISO-3098-0-1997.pdf)
- [N] ISO 3098-5:1997 defines CAD lettering ("type CB"), with a character-box width of (11/10)h — [ISO 3098-5:1997 sample (iTeh)](https://cdn.standards.iteh.ai/samples/24793/ecb5d87c00b8447488e7de333c5fd888/ISO-3098-5-1997.pdf)

### Inferences
- Model line weight as `lineGroup` (e.g. "0.5") plus a role (`thick | thin | extraThick`). The renderer converts that to mm. PDF, SVG and DXF then share one source of truth (DXF: lineweight in 1/100 mm per entity or layer; see §9).
- Default text heights should be 3.5 mm (ISO) or 3 mm / 0.12 in (ASME), with 5 or 7 mm for view labels. Restrict the height picker to the ISO 3098 series in ISO templates.
- Wren needs a self-hosted, OFL-licensed font that looks like ISO 3098 type B. CLAUDE.md forbids CDN fonts. Osifont (GPL-3 with font exception) is the font FreeCAD uses. Its licence and provenance must be recorded in docs/DEPENDENCIES.md, and it was not verified this pass.

### Gaps
- Hatching by material: ISO 128-50 (now in 128-3?) uses general 45° thin-line hatching. ASME Y14.2 has historical material-specific patterns (cast iron, steel, bronze, etc.) that modern practice usually replaces with general hatching plus a material note. No source was retrieved, so this needs verification.
- I did not retrieve dash and gap lengths for dashed and chain lines (ISO 128-20 defines them as multiples of line width). Wren needs them for its pattern definitions and for DXF LTYPE tables.

## 3. Dimensioning and tolerancing (ISO 129-1, ASME Y14.5)

### Takeaway
The dimension engine needs per-standard style presets: arrowheads, extension-line gap and overshoot, text aligned or unidirectional, and decimal separator. It also needs tolerance types (limits, ±, symmetric, fit designations such as H7/g6) and a library of hole-callout symbols: ⌴ counterbore, ⌵ countersink, ↧ depth, SF spotface, plus Ø, R, SR, SØ. Secondary sources were thin here. Most exact numbers are listed as gaps.

### Cited Findings
- [N] ASME Y14.5 hole symbols: the depth symbol is a downward arrow placed before the depth value. The spotface symbol is the counterbore symbol with "SF" inside it — [open-exam-prep, dimensioning features (Y14.5)](https://open-exam-prep.com/study-guides/asme-gdtp-technologist/ch1/dimensioning-features); [SOLIDWORKS 2015 What's New, spotface symbol](https://help.solidworks.com/2015/english/WhatsNew/c_spotface_symbol.htm)
- [N] Y14.5-2009: if a spotface has no depth or remaining thickness specified, it is the minimum depth needed to clean up the surface to the specified diameter — [open-exam-prep](https://open-exam-prep.com/study-guides/asme-gdtp-technologist/ch1/dimensioning-features)
- [P] Most ASME and ISO dimension symbols are the same. A few differ. ISO adoption of the counterbore, countersink and depth symbols was only "proposed" in the 1994 era, so current ISO usage needs checking — [Eng-Tips, ISO dimensioning](https://www.eng-tips.com/threads/iso-dimensioning.204922)
- [P] The counterbore glyph is described as "⌴" (U+2334). This is a Unicode character, which matters for text export — [Wikipedia ⌴](https://www.Wikipedia.com/wiki/%E2%8C%B4)
- [N] A summary of Y14.5 dimensioning topics covers diameters, radii, chamfers, countersinks, counterbores, spotfaces, keyseats and slots — [open-exam-prep](https://open-exam-prep.com/study-guides/asme-gdtp-technologist/ch1/dimensioning-features)

### Inferences
- Hole callouts should be structured data (`{type: cbore|csk|spotface|simple, dia, depth, cboreDia, cboreDepth, cskDia, cskAngle, qty, thread}`), not free text. Then the PDF/SVG text, the DXF text and AP242 PMI all come from the same record.
- The glyphs ⌴ ⌵ ↧ Ø ± ° must exist in the embedded drawing font. If not, draw them as vector glyphs. DXF fonts (SHX/TTF) often lack them, so DXF export should either explode those symbols to geometry or use `%%c` (Ø), `%%d` (°) and `%%p` (±). Those are AutoCAD control codes. LibreCAD and QCAD handling was not verified.
- Tolerance display modes Wren needs: none, symmetric ±, deviation +a/−b, limits (upper over lower), basic (boxed), reference (parenthesised), and ISO 286 fit codes (e.g. `Ø20 H7`, optionally with the computed limits).

### Gaps
- I did not retrieve exact ISO 129-1:2018 or ASME Y14.5-2018 figures for: extension-line gap (practice is about 1–1.5 mm) and overshoot (about 2–3 mm); arrowhead length-to-width ratio (practice is 3:1, filled); aligned (ISO) vs unidirectional (ASME default) text; ordinate and baseline layout rules; the ASME rule against trailing zeros for mm while inch values keep them; chamfer callout formats ("2 × 45°" vs "C2"). The values in parentheses are general drafting knowledge and are unverified.
- ISO 286-1/-2 fit tables were not covered. Wren needs them as data (licence check needed if tables are transcribed).

## 4. GD&T (ISO 1101:2017, ASME Y14.5-2018)

### Takeaway
One GD&T engine can serve both standards. The symbol set differs: ASME Y14.5-2018 removed concentricity and symmetry, while ISO 1101 keeps them. ISO 1101:2017 added modifiers (CZ, SIM, UZ, etc.), and the two standards default differently on simultaneous requirements. The feature control frame editor has to be standard-aware. It should validate that a symbol or modifier is allowed under the drawing's declared standard and flag it if not, not silently convert it.

### Cited Findings
- [N] ASME Y14.5-2018 removed concentricity and symmetry (the term, symbol and concept). In its words, these "past practices" are "no longer supported". Position (or runout) with appropriate datums replaces them — [Mitutoyo / Salsbury, ASME Y14.5-2018 changes deck](https://www.mitutoyo.com/webfoo/wp-content/uploads/ASME_Y14.5-2018_Salsbury.pdf); [GD&T Basics](https://www.gdandtbasics.com/?p=7318)
- [P] Drawings that don't cite Y14.5-2018 in the title block may still use concentricity. That means legacy symbols matter for importing older drawings and for the title-block standard field — [GD&T Basics](https://www.gdandtbasics.com/?p=7318)
- [N] ISO keeps both. In ISO, concentricity is the 2D cross-section control and coaxiality the 3D axis control. ISO symmetry is a zone between two parallel planes about a datum median plane, similar to ASME position — [ZEISS quality forum ISO vs ASME PDF](https://qualityforum.zeiss.com/migration/images/4532_930ba93a0701c87923e28fa613cdd758.pdf)
- [P] Symbol counts conflict: some sources say 12 active ASME characteristics after 2018, others still list 14 with two deprecated — [Wevolver GD&T explained](https://www.wevolver.com/article/gdt-explained-symbols-datums-and-tolerances)
- [N] Simultaneous requirement is the ASME default. ISO needs SIM or CZ written explicitly. ISO 1101:2017 added the modifiers N, X, CT, CZ, SIM, UZ/OZ and UF. A forum user says SIM was not yet in a released GPS standard, so this conflict is unresolved — [Knowt, Functional equivalence of ISO GPS and ASME](https://knowt.com/note/27d0c404-c3fa-4653-9a4e-3d7f71a4385a/Functional-Equivalence-of-ISO-GPS-and-AS); contradicted by [Eng-Tips, ISO simultaneous requirement](https://www.eng-tips.com/threads/iso-simultaneous-requirement-1998-vs-2016.438749)
- [N] CZ (combined zone) makes one common tolerance zone that applies to several features at once. ASME Y14.5M-1994 did not standardise CZ — [PTC Creo help, optional modifiers (ISO)](https://support.ptc.com/help/creo/creo_pma/r9.0/usascii/model-based_definition/optional_modifiers_2.html); [Eng-Tips, CZ in MMC datum system](https://www.eng-tips.com/threads/combined-zone-in-a-material-condition-modified-datum-system.567349)
- [N] Free state Ⓕ: the tolerance applies to the unrestrained part. It is for non-rigid parts that carry a note saying tolerances apply in the restrained state — [PTC Creo help](https://support.ptc.com/help/creo/creo_pma/r9.0/usascii/model-based_definition/optional_modifiers_2.html); [Machinery's Handbook 31st ed. p.697](https://online.flippingbook.com/view/954192180/697)
- [N] Projected tolerance zone Ⓟ controls orientation of a feature of size (usually a threaded or press-fit hole) above the surface. Machinery's Handbook notes that its illustration differs slightly from Y14.5-2018 — [PTC Creo help](https://support.ptc.com/help/creo/creo_pma/r9.0/usascii/model-based_definition/optional_modifiers_2.html); [Machinery's Handbook p.697](https://online.flippingbook.com/view/954192180/697)

### Inferences
- Data model: `FeatureControlFrame { standard: 'ASME_Y14.5_2018' | 'ISO_1101_2017', characteristic, zoneShape (Ø/SØ/none), value, materialModifier (M/L/none; RFS is the default in both, and S is legacy ASME), zoneModifiers [P(len), F, CZ, SIM, UZ(±), T, U, ST, ...], datums [{label, modifiers}] }`. The renderer draws per standard. Validation rejects concentricity or symmetry in an ASME-2018 drawing, and flags missing SIM/CZ semantics when moving a drawing between standards.
- The drawing's declared standard and edition must appear in the title block. The GD&T Basics finding shows that which symbols are legal depends on that declaration.
- Datum feature symbols (boxed letter, triangle attached) and datum targets (circle split horizontally, with target area size and ID) need their own annotation types, not FCF variants.

### Gaps
- No source retrieved for ASME Y14.5-2018-only modifiers: translation (▷), dynamic profile (△), the "unequally disposed" Ⓤ, and "independency" Ⓘ vs ISO 8015's independency principle. ASME uses Rule #1 (envelope) by default. ISO 8015 uses independency by default, with Ⓔ for envelope. Wren's default needs to depend on the standard, and this needs a primary source.
- Datum target symbol geometry and sizes were not retrieved.

## 5. Other annotations: surface finish, welds, notes, revisions

### Takeaway
The ISO surface-texture indication standard is now **ISO 21920-1:2021**, which replaced ISO 1302:2002. ASME uses Y14.36. A tool should implement the common check-mark symbol family with parameter fields. Weld symbols (AWS A2.4 / ISO 2553) are a large separate system and are a good candidate for post-M4 (out of scope for M4). Revision blocks are mostly a template and data concern tied to Wren's releases feature.

### Cited Findings
- [N] ISO 21920-1 (1st edition, 2021-12) cancels and replaces ISO 1302:2002. EN ISO 21920-1:2022 supersedes EN ISO 1302:2002 — [iTeh ISO 21920-1:2021](https://iteh.es/catalog/standards/iso/ab03b9a1-0a17-4c24-8163-b4ed7798032e/iso-21920-1-2021); [BSI](https://knowledge.bsigroup.com/products/geometrical-product-specifications-gps-surface-texture-profile-indication-of-surface-texture)
- [N] Main changes from ISO 1302: new specification elements for indication, and the "max" tolerance acceptance rule is now the default (it was 16%) — [iTeh EN ISO 21920-1:2022](https://iteh.es/catalog/standards/cen/255f970d-5b20-421e-90f1-fc39c846afaa/en-iso-21920-1-2022); [Quality Magazine on ISO 21920](https://www.qualitymag.com/articles/98952-evolving-roughness-standards-understanding-and-implementing-iso-21920)
- [N] ISO 21920-2 replaces ISO 4287 and ISO 13565-2/-3 (parameters). ISO 21920-3 replaces ISO 4288 (specification operators) — [Quality Magazine](https://www.qualitymag.com/articles/98952-evolving-roughness-standards-understanding-and-implementing-iso-21920); [Digital Surf guide](https://guide.digitalsurf.com/en/guide-iso-21920-parameters.html)

### Inferences
- The surface-finish annotation should carry a `standard` field (ISO 1302:2002 legacy, ISO 21920-1, ASME Y14.36). The acceptance rule changed from 16% to max, so an "Ra 1.6" from an old drawing doesn't mean exactly the same as one under ISO 21920. Show which convention applies, not a bare number.
- Weld symbols: Wren's M4 targets machined-part drawings (the bracket and CSWA-style parts). Defer weld symbols, but keep the leader/annotation framework open to them.
- Revision block: a template table bound to the project's release history (PLAN §8A: releases stamp the revision into title blocks). Columns: rev, zone, description, date, approved.

### Gaps
- ASME Y14.36-2018 symbol details and ISO 21920-1 graphical-symbol changes (clauses 6.2/7.2) were not retrieved.
- No sources retrieved on general notes conventions, flag notes, or the ASME Y14.35 revision-block format.

## 6. Title blocks and sheets (ISO 7200, ISO 5457, ISO 216, ASME Y14.1)

### Takeaway
ISO 5457 fixes borders (20 mm left filing margin, 10 mm on the others), centring marks, a 50 mm grid-reference field and trimming marks. ISO 7200 defines title-block data fields with a few mandatory ones (legal owner, identification number of at most 16 characters, and others). ASME Y14.1 defines ANSI A–E inch sheets, whose aspect ratios alternate. Wren's template system must be parametric in sheet size, keep the grid and zones derived from it, and bind title-block fields to document metadata.

### Cited Findings
- [N] Current edition: ISO 5457:1999 + Amd 1:2010, adopted as DIN EN ISO 5457:2017-10 — [DIN TOC](https://www.din.de/de/mitwirken/normenausschuesse/natg/veroeffentlichungen/wdc-beuth:din21:278410251/toc-2756699/download); [iTeh ISO 5457:1999](https://standards.iteh.ai/catalog/standards/iso/cda39033-c87c-4173-a875-365a3e33753f/iso-5457-1999)
- [N] Border: 20 mm on the left including the frame (usable as a filing margin), 10 mm on all other sides — [ISO 5457 PDF (Autodesk forum attachment)](https://forums.autodesk.com/autodesk/attachments/autodesk/v1232/48404/1/ISO5457.pdf)
- [N] Centring marks: four marks at the ends of the trimmed sheet's two symmetry axes, with a 1 mm tolerance. Recommended as continuous 0.7 mm lines from the grid-reference border to 10 mm beyond the drawing frame — [ISO 5457 PDF](https://forums.autodesk.com/autodesk/attachments/autodesk/v1232/48404/1/ISO5457.pdf)
- [N] Grid-reference system: 0.35 mm continuous lines, 3.5 mm characters, 50 mm fields measured from the centring marks. Letters I and O are excluded. Field counts (long/short side): A0 24/16, A1 16/12, A2 12/8, A3 8/6, A4 6/4 — [ISO 5457 PDF](https://forums.autodesk.com/autodesk/attachments/autodesk/v1232/48404/1/ISO5457.pdf); [cadsetterout, grid reference frame](https://cadsetterout.com/drawing-standards/grid-reference-frame/)
- [N] Trimming marks: two overlapping 10 mm × 5 mm rectangles at the four corners — [ISO 5457 PDF](https://forums.autodesk.com/autodesk/attachments/autodesk/v1232/48404/1/ISO5457.pdf)
- [P] One secondary source says the offset between the drawing frame and the grid border is 5 mm. Unverified — [cadsetterout, frame/border](https://cadsetterout.com/drawing-standards/engineering-drawing-frame-border-size/amp)
- [N] ISO 7200:2004 fields: legal owner is mandatory, with no length limit (name, abridged name or logo). The identification number is mandatory, at most 16 characters, and unique at least within the legal owner's organisation — [ISO 7200:2004 sample (iTeh)](https://cdn.standards.iteh.ai/samples/35446/d3b0887cb4fa47f49f8718807d3b8903/ISO-7200-2004.pdf)
- [N] Other ISO 7200 fields reported: responsible department, technical reference, approval person, creator, document type, classification/keywords, document status, page number, number of pages, paper size, plus title, revision index, date of issue and language. ISO 29845 supplies the document-type vocabulary. A secondary source says 19 fields in three groups, 8 of them mandatory (unverified) — [EN ISO 7200:2004 (iTeh)](https://standards.iteh.ai/catalog/standards/cen/c4467542-9aa3-41f7-86aa-c95e77498646/en-iso-7200-2004); [ISO 29845:2011](https://iteh.es/catalog/standards/iso/7fe47c47-44a7-4ad8-be73-42bc658af2ae/iso-29845-2011); [draftsperson.net sheet layout](https://blog.draftsperson.net/drawing-sheet-layout-metric/)
- [N] ANSI/ASME Y14.1 sizes: A 8.5×11 in (≈A4), B 11×17 (≈A3), C 17×22 (≈A2), D 22×34 (≈A1), E 34×44 (≈A0). Aspect ratios alternate (A/C/E 1.294; B/D 1.545), unlike ISO's constant 1:√2. The current edition is ASME Y14.1-2020 — [Wikipedia, ANSI/ASME Y14.1](https://en.wikipedia.org/wiki/ANSI/ASME_Y14.1)

### Inferences
- A template is a function `(sheetSize, orientation, standard) → frame, zones, centring marks, trim marks, title-block placement`, plus a title-block layout with field slots bound to `wren.project.json` metadata (part number, revision from releases, material, mass, scale, projection symbol, units, general tolerance standard such as ISO 2768-mK, the drawing standard and edition). Users must be able to (a) edit the title-block layout, (b) add custom fields, (c) add a logo (self-hosted asset), and (d) choose ISO or ANSI sheet families.
- The ISO 7200 16-character identification-number limit should be a validation warning in ISO templates.
- Grid zones are also needed for revision-table "zone" columns and for associativity messages ("dimension in zone C4 needs attention").

### Gaps
- ASME Y14.1 margins, zone sizes and title-block layout (Y14.1 fig.) were not retrieved.
- ISO 7200's full mandatory list was not verified against the standard.

## 7. BOM tables and balloons (ISO 6433, ASME Y14.34)

### Takeaway
I found no primary or good secondary source on ISO 6433 or ASME Y14.34 this pass. M4 only requires a "BOM placeholder", so this is low risk now but needs research before M6.

### Cited Findings
- None retrieved in the tool budget.

### Inferences
- Design the BOM as a template table bound to assembly data (M6). Make balloons a leader annotation whose text references a BOM row ID. Then renumbering stays associative and dangling balloons get flagged ("needs attention"), as the CLAUDE.md golden rule requires.

### Gaps
- ISO 6433:2012 (item references: circle/balloon form, size, leader termination with a dot on a surface or an arrow on an edge) and ASME Y14.34-2013 (parts lists, data lists, index lists): field sets, ordering, and whether the BOM reads bottom-up from the title block. Unresearched.

## 8. PDF export

### Takeaway
1:1 printing depends on three things: (1) the page MediaBox equals the physical sheet exactly (e.g. A3 = 297×420 mm = 841.89×1190.55 pt); (2) all geometry is in pt with 1 mm = 72/25.4 pt; (3) the user prints at "Actual size". Wren can only influence (3) with `/ViewerPreferences << /PrintScaling /None >>`. Acrobat reportedly also needs `/Enforce [/PrintScaling]`, and PDF.js historically ignored it. A printed scale bar or known-length check line plus a UI warning is therefore needed. All the JS candidates (jsPDF, svg2pdf.js, pdf-lib, PDFKit) are MIT. Fonts must be embedded, and svg2pdf.js needs them registered in jsPDF first.

### Cited Findings
- [N, PDF spec] `/PrintScaling` takes `/AppDefault` or `/None`. `/None` lets a page laid out at physical size print 1:1, which is why pre-press proofs and measured forms use it — [loslab PDFium docs, PrintScaling](https://www.loslab.com/pdfium-component-doc/vi/entries/TPdf.PrintScaling.html); [DevExpress PdfViewerPreferences.PrintScaling](https://docs.devexpress.com/OfficeFileAPI/DevExpress.Pdf.PdfViewerPreferences.PrintScaling)
- [P] From PDF 1.7 / Acrobat 8 on, PrintScaling is reportedly ignored unless `/Enforce [/PrintScaling]` is also present (an extension-level-3 feature) — [PDFsharp forum](https://forum.pdfsharp.net/viewtopic.php?p=4369)
- [P] PDF.js (Firefox) did not honour `/PrintScaling /None` (Bugzilla 1243580). Its current status was not re-verified — [Mozilla Bugzilla 1243580](https://bugzilla.mozilla.org/show_bug.cgi?id=1243580)
- [P] iText documents PRINTSCALING NONE as the way to ask viewers to print at actual size — [iText KB, prevent page resizing](https://kb.itextpdf.com/itext/how-to-prevent-the-resizing-of-pages-in-pdf)
- [N] OCG layers were added in PDF 1.5. PDF/A-1 forbids optional content, so a library in PDF/A-1 mode refuses layers (later PDF/A versions differ; not verified) — [Nutrient/PSPDFKit, intro to OCG layers](https://www.nutrient.io/guides/web/layers/introduction-to-ocg-layers/); [loslab blog, OCG in Delphi](https://blog.loslab.com/en-gb/delphi-pdf-library/pdflibpas-optional-content-groups-layers-delphi.html)
- [P] svg2pdf.js: MIT (© 2015–2026 yWorks). It "supports only a limited part of the SVG specification" and is meant for curated SVG, not arbitrary SVG. Fonts and non-ASCII characters must be added to jsPDF before calling svg2pdf. Since 2.x it works with upstream jsPDF — [yWorks/svg2pdf.js GitHub](https://github.com/yWorks/svg2pdf.js); [unpkg svg2pdf.js 2.7.0 README](https://unpkg.com/svg2pdf.js@2.7.0/README.md)
- [P] jsPDF is MIT. UTF-8 text needs an embedded custom TTF registered with `addFileToVFS` and `addFont` — [jsPDF licence (Oracle third-party notice)](https://docs.oracle.com/cd/F58861_01/license-oas/jspdf-license-oasli.html); [helpsdev/jsPDF README mirror](https://github.com/helpsdev/jsPDF)
- [P] pdf-lib is MIT. Custom fonts need `@pdf-lib/fontkit` registered via `registerFontkit` — [licenses.dev pdf-lib 1.17.1](https://licenses.dev/npm/pdf-lib/1.17.1)
- [P] PDFKit is MIT. It supports custom fonts, and you manage loading and embedding yourself — [foliojs/pdfkit GitHub](https://github.com/foliojs/pdfkit); [pdfkit README](https://cdn.jsdelivr.net/npm/pdfkit@0.19.1/README.md)
- [P] Neither jsPDF nor pdf-lib was found to document OCG or PDF/A support. Commercial SDKs (Apryse, Nutrient) do support OCG — [Apryse layers guide](https://docs.apryse.com/web/guides/layers); [Nutrient layers](https://pspdfkit.com/guides/web/layers/)

### Inferences
- **1:1 recipe (Wren-specific):**
  1. Make the MediaBox exactly the sheet size. Don't add printer margins to the page. The ISO 5457 10/20 mm borders are already inside the sheet.
  2. Do the mm→pt conversion once (×2.834645669), with no intermediate px stage (SVG's 96 px/in vs PDF's 72 pt/in is a classic source of 4/3 errors, see §10).
  3. Set `/PrintScaling /None` and `/Enforce [/PrintScaling]`, which needs PDF 1.7 ext-3. jsPDF doesn't expose these, so a pdf-lib post-process pass or direct catalog injection is likely.
  4. Put a 100 mm reference bar and the drawing scale in the title block or margin. The M4 "measured" acceptance test can then be a human check with a ruler, plus an automated test that parses the PDF and checks MediaBox and path coordinates.
  5. Show an export-dialog hint: "Print at Actual size / 100%, not Fit to page".
- Fonts: embed a subset of the drawing font as TrueType so text is searchable and selectable, and dimension values can be copied. Offer "text as outlines" only as an option, because outlines lose searchability and accessibility. Stroked single-line fonts (like ISO 3098 CAD lettering) would have to be drawn as paths and are then not searchable. A hybrid is possible: invisible text render mode 3 over stroked glyphs, the "OCR layer" trick. That is an inference and untested.
- Line weights: write them in pt from the mm line groups (0.35 mm = 0.992 pt). Avoid 0-width "hairlines", which print device-dependently.
- Layers: OCGs per line role (visible/hidden/centre/dims/annotations) are nice-to-have. Without library support they would need hand-built OCG dictionaries in pdf-lib. They conflict with PDF/A-1, so PDF/A-2b or -3b would be the archival target (allowed-feature details not verified).
- Stack check: PLAN chose jsPDF + svg2pdf.js. Because svg2pdf supports only a subset of SVG, Wren's drawing SVG must be authored in that subset: no CSS-only styling, no `vector-effect`, no filters. A golden test should round-trip every annotation type.

### Gaps
- I did not verify PDF/A-2/3 support in jsPDF or pdf-lib, the OutputIntent/XMP requirements, or whether svg2pdf handles `stroke-dasharray`, markers and `clipPath` (all needed for line types and arrows). Check the svg2pdf test suite.
- I did not check current browser print dialogs (Chrome's built-in PDF viewer, Safari, Edge) for PrintScaling handling. Needs empirical testing on the M2 device checklist hardware.

## 9. DXF export

### Takeaway
Default to **R2000 (AC1015)** or later with `$INSUNITS = 4` (mm) or 1 (inch). Put one layer per line role, with the matching LTYPE and a lineweight per layer. Use LINE/ARC/CIRCLE/LWPOLYLINE as the core vocabulary. Offer an **R12 "lines, arcs and polylines" compatibility profile** for laser and CNC: no SPLINE, ELLIPSE or HATCH, with curves flattened to arcs or polylines within a tolerance, and TEXT not MTEXT. SPLINE needs R2000+. HATCH is not in R12. Splines are the most common cause of laser/CAM rejection. For CI: ezdxf audit (Python API) for structure; QCAD Pro `dwg2pdf`/`dwg2svg` with `-platform offscreen`, or `librecad dxf2pdf` (needs a display, e.g. Xvfb) for "opens and renders". Then compare the rendered output to Wren's own PDF.

### Cited Findings
- [N, DXF] `$INSUNITS`: 1 = inches, 4 = millimetres (5 cm, 6 m). `$MEASUREMENT` (0 imperial / 1 metric) selects hatch-pattern and linetype files and is independent of $INSUNITS. `$LUNITS` only controls display. ezdxf notes this behaviour was found by experimenting with BricsCAD, and other apps may differ — [ezdxf docs, DXF units](https://ezdxf.readthedocs.io/en/stable/concepts/units.html)
- [P] Laser and CNC guides warn that "DXF files do not contain units" in practice. Always set $INSUNITS, and expect recipients to check scale — [comakingspace DXF wiki](https://wiki.comakingspace.de/DXF); [lapas DXF troubleshooting](https://lapas-landing.pages.dev/blog/dxf-problems-troubleshooting/)
- [N] SPLINE requires DXF R2000 (AC1015) or later — [ezdxf SPLINE docs](https://ezdxf.readthedocs.io/en/stable/dxfentities/spline.html)
- [P] R12 has no SPLINE entity. LibreCAD does not interpret the special vertex flags of old polyline-based splines — [LibreCAD forum, Double lines and unwanted connections](https://forum.librecad.org/Double-lines-and-unwanted-connections-td5721810.html)
- [P] LibreCAD imports fit-point closed splines (flag 3) correctly. Splines made in LibreCAD with "spline through points" vanished when opened in LibreOffice Draw, and snapping to splines didn't work — [LibreCAD forum, Closed spline through points](https://forum.librecad.org/Closed-Spline-through-points-DXF-tp5717157.html); [LibreCAD forum, Spline through points](https://forum.librecad.org/Spline-through-points-td5710167.html)
- [P] Splines are the main laser/CAM failure point. Shops rejected SolidWorks DXFs "even if I export as v2000"; the fix was exporting splines as polylines. Inkscape's R14 LWPOLYLINE export emitting splines was "problematic for the laser" — [GrabCAD, best way to export DXF for CNC laser](https://grabcad.com/groups/solidworks-tutorials-on-demand/discussions/best-way-to-export-dxf-for-cnc-lasercut); [Inkscape forum](https://inkscape.org/forums/beyond/export-to-dxf-r14-lwpolyline-producing-splines)
- [P] Rhino's laser/waterjet guide recommends the "R12 Natural" scheme. It warns against exploded polylines and prefers approximating splines with tangent arcs over plain polylines. A Trumpf user suggested "R12 Lines and Arcs" when a file wouldn't read. Machine support varies: Epilog and Zünd accept splines — [McNeel wiki, export to laser](https://wiki.mcneel.com/rhino/exporttolaser); [McNeel discourse, Trumpf lasers](https://discourse.mcneel.com/t/trumpf-lasers-geometry-issues-anyone-have-experience/140425)
- [P] Version support is inconsistent across CAM. Some laser software won't read anything from R2000 on. Others need 2007. Users ask for AC1009/AC1015/AC1018 options — [Autodesk ArtCAM forum](https://forums.autodesk.com/t5/artcam-forum/laser-dxf-postprocessor-issue/m-p/6895221); [MaxCut feedback](https://feedback.maxcutsoftware.com/p/support-export-to-older-dxf-versions-JLFdYJ)
- [P] Laser cleanup checklist: closed polylines only, no duplicate or overlapping geometry (it causes double cuts), annotation layers excluded, and a spline-flattening tolerance of 0.1 mm or less for production — [lapas troubleshooting](https://lapas-landing.pages.dev/blog/dxf-problems-troubleshooting/); [SketchUcation thread](https://community.sketchucation.com/post/1422918)
- [P] LWPOLYLINE arrived in R14. A wire-EDM guide that lists it as R12 is wrong. Inkscape treats LWPOLYLINE as an R14 option — [Inkscape forum](https://inkscape.org/forums/beyond/export-to-dxf-r14-lwpolyline-producing-splines); the incorrect claim is in [industrialmonitordirect, wire EDM DXF](https://industrialmonitordirect.com/blogs/knowledgebase/dxf-file-exchange-for-wire-edm-compatibility-and-workflow-guide)
- [P] A LibreCAD user lost all hatched geometry when saving to R12. A forum reply couldn't find HATCH in the R10/R12 references. LibreCAD hatches fail ("Hatch failed due to a gap") if the boundary isn't exactly closed. Elliptical hatches with end angle > 360° misbehave — [LibreCAD forum, unable to save hatches to R12](https://forum.librecad.org/Unable-to-save-hatches-to-DXF-R12-tp5720643.html); [Launchpad bug 1653707](https://bugs.launchpad.net/bugs/1653707); [LibreCAD forum, elliptical hatch](https://forum.librecad.org/Elliptical-hatch-problem-with-angles-360-degrees-tp5717435p5717438.html)
- [P] LibreCAD 2.2.1_rc2 has an MTEXT alignment issue report. Exploding MTEXT turns it into non-editable geometry — [LibreCAD forum, MTEXT alignment](https://forum.librecad.org/MTEXT-alignment-issue-2-2-1-rc2-tp5724780.html); [LibreCAD forum, 2.2.1.2 vs old drawings](https://forum.librecad.org/Libre-2-2-1-2-vs-old-drawings-tp5728414.html)
- [P] Downstream apps differ: LightBurn reads hatches from R12/R13 ASCII DXF but not R14+. Dimension text, stored as MTEXT, imports horizontally — [LightBurn forum, DXF import text/dims/hatch](https://forum.lightburnsoftware.com/t/dxf-import-text-dimensions-hatch/58263)
- [P] An R12 file from LibreCAD lost arcs and circles in KiCad but was fine in DoubleCAD (an importer bug in the receiving app) — [Launchpad KiCad bug 1594607](https://bugs.launchpad.net/kicad/+bug/1594607/comments/6)
- [P] ezdxf's R12 fast writer supports only LINE, CIRCLE, ARC, TEXT, POINT, SOLID, 3DFACE and POLYLINE. It has no BLOCKS (so no INSERT), and tables only with `fixed_tables=True` — [ezdxf r12writer](https://ezdxf.readthedocs.io/en/stable/addons/r12writer.html)
- [P] JS writer `@tarikjabiri/dxf` (dxfjs/writer): MIT, TypeScript, `Writer` + `stringify()` API. Versions on npm and jsDelivr disagree (2.8.9 vs 2.10.0). A third-party health score reported July 2023 as the last update, so maintenance is uncertain — [npm @tarikjabiri/dxf](https://npmjs.com/package/@tarikjabiri/dxf); [package.json](https://cdn.jsdelivr.net/npm/@tarikjabiri/dxf@2.8.9/package.json); [depscope](https://depscope.dev/pkg/npm/@tarikjabiri/dxf); [dxfjs docs](https://dxfjs.github.io/writer)
- [P] Other JS writers exist: `dxf-writer` (npm, ognjen-petrovic) and the js-dxf fork — [npm dxf-writer](https://npmjs.com/package/dxf-writer); [mmiscool/js-dxf](https://github.com/mmiscool/js-dxf). Licences not verified this pass.
- [P] **LibreCAD CLI**: `librecad dxf2pdf` flags: `-a/--fit`, `-c/--center`, `-k` greyscale, `-m` monochrome, `-p WxH` paper in mm, `-r` DPI, `-s` scale (e.g. 0.01 = 1:100), `-f L,T,R,B` margins in mm, `-z HxV` multipage, `-o` outfile, `-t` dir. Only dxf2pdf is documented — [LibreCAD docs, console tool](https://docs.librecad.org/en/latest/guides/console-tool.html)
- [P] LibreCAD dxf2pdf pitfalls: without X it fails with "could not connect to display" (a standalone build was mentioned but not confirmed). Users report empty or mostly blank PDFs depending on flags. A developer suggested printing from the GUI instead — [LibreCAD forum, Printing to PDF via command line](https://forum.librecad.org/Printing-to-PDF-via-command-line-tp5712735.html); [LibreCAD forum, dxf2pdf output mostly empty](https://forum.librecad.org/dxf2pdf-output-is-mostly-empty-tp5725553.html)
- [P] **QCAD CLI**: `dwg2pdf`, `dwg2svg` and `dwg2bmp` ship with **QCAD Professional** (commercial), as shell scripts on Linux. Options include auto-fit/orientation and scale (`-s 1:200`). They run headless with `-platform offscreen`. One thread reports lines missing from dwg2pdf output on 3.23.3 Pro — [QCAD command line tools](https://qcad.org/en/qcad-command-line-tools); [QCAD 3 release blog](https://www.qcad.org/en/122-qcad-3-release-command-line-tools); [QCAD forum dwg2pdf issues](https://www.qcad.org/rsforum/viewtopic.php?p=49248)
- [P] **ezdxf validation**: `doc.audit()` returns an `Auditor` (`has_errors`, `errors`, `print_error_report()`). `ezdxf.recover.readfile()` loads malformed files, repairs them and runs the audit, reporting decode errors with approximate line numbers — [ezdxf recover/audit docs](https://ezdxf.readthedocs.io/en/stable/drawing/recover.html)

### Inferences
- **Version choice:** default AC1015 (R2000). That gives LWPOLYLINE, SPLINE, ELLIPSE, HATCH, MTEXT, per-entity lineweight and true-colour/plot-style support in later versions, and is widely read. Add an "R12 / CNC-safe" option that writes only LINE, ARC, CIRCLE, POLYLINE and TEXT, with splines and ellipses flattened to arcs (biarc) or polylines at a user tolerance (default 0.01 mm, at most 0.1 mm) and hatches dropped. The ELLIPSE version requirement (R13+) is from general knowledge and was not sourced this pass.
- **Layers:** `VISIBLE`, `HIDDEN`, `CENTER`, `PHANTOM`, `SECTION_HATCH`, `DIMENSIONS`, `ANNOTATION`, `TITLEBLOCK`, `VIEWPORT_FRAME`, each with an LTYPE (CONTINUOUS, HIDDEN/DASHED, CENTER, PHANTOM) and lineweight. Laser users can then turn off annotation layers. This matches the "exclude annotation layers" advice above.
- **Linetype scale:** emit explicit LTYPE dash definitions in mm (scaled from ISO 128-20 multiples) and set `$LTSCALE = 1`. Don't depend on acad.lin/acadiso.lin, which `$MEASUREMENT` selects.
- **Sheet vs model:** a drawing sheet is paper space. The simplest robust choice is to export the sheet "as printed" in model space at 1:1 sheet mm, with view geometry pre-scaled. Offer a second "model geometry at 1:1" mode (one view, true size) for CNC. Laser/CAM users want true-size part geometry, not sheet-scaled.
- **Dimensions:** export them as exploded geometry (lines, filled SOLID or polyline arrowheads, TEXT) by default, because DIMENSION entities need an anonymous `*D` block plus DIMSTYLE and render differently in each app. An optional "native DIMENSION" mode (with the block written too, so apps that don't regenerate still show it) is a P2 nicety.
- **Text:** use TEXT, not MTEXT, in the compatibility profile, with a STYLE that references a common TTF name or a fallback. Map Ø, ±, ° to `%%c`, `%%p`, `%%d`. Explode ⌴ ⌵ ↧ to geometry, because those glyphs are unlikely to exist in recipients' fonts (inference).
- **CI pipeline (proposed):** (1) the JS unit test writes the DXF; (2) `python -I -c "import ezdxf; doc=ezdxf.readfile(p); a=doc.audit(); assert not a.has_errors"` (pinned ezdxf, MIT); (3) `xvfb-run librecad dxf2pdf -p 420x297 -s 1 -o out.pdf in.dxf` checks the file renders, then compare page extents and path count with Wren's PDF or a raster diff; (4) QCAD needs a Pro licence for the CLI, which is a problem for a free open-source CI. Either run the QCAD CE GUI under Xvfb with an ECMAScript script (unverified) or keep QCAD as a manual pre-release check. Record that choice in docs/DECISIONS.md.
- Golden tests for DXF should check entity counts per layer, total line/arc length per layer, the bounding box in mm, and $INSUNITS. This mirrors the kernel's volume/area/face-count goldens.

### Gaps
- libdxfrw's read support (LibreCAD's DXF library) per entity and version (e.g. ELLIPSE, MTEXT formatting codes, DIMENSION block regeneration, lineweight group 370, true colour) was not confirmed. Read the libdxfrw source or test empirically.
- Whether QCAD Community Edition has any headless conversion path was not established.
- An authoritative Autodesk DXF Reference page per entity/version was not fetched. The version requirements for ELLIPSE (R13) and LWPOLYLINE (R14) come from secondary sources and general knowledge.
- Licences of `dxf-writer`/js-dxf and the `@tarikjabiri/dxf` repository activity were not verified.

## 10. SVG export

### Takeaway
Write the root `<svg>` with physical units and a matching unitless viewBox (`width="420mm" height="297mm" viewBox="0 0 420 297"`), so 1 user unit = 1 mm. Unitless SVG is treated as px at 96/in. Older tools used 90 (Inkscape pre-0.92) or 84 (Illustrator), which is the classic SVG scale bug. Fonts: embed or outline them. A referenced system font will not survive the trip to another machine.

### Cited Findings
- [N, SVG 2] The outer `<svg>` width/height (with units) plus the viewBox set the real-world size of a user unit. Unitless width/height means px — [W3C SVG 2 draft, coordinate systems and units](https://w3c.github.io/svgwg/svg2-draft/coords.html); [Inkscape-devel list (Tavmjong Bah)](https://lists.inkscape.org/hyperkitty/list/inkscape-devel@lists.inkscape.org/message/EZOTK7GOB7HPFBPIEQR4VDA65YJFJJH5)
- [N, CSS] Physical units convert at a fixed 96 user units per inch — [Inkscape-devel list](https://lists.inkscape.org/hyperkitty/list/inkscape-devel@lists.inkscape.org/message/SFR6N36AH5PUYARKZYPFO5OPQKBKIYFD)
- [P] Recommended pattern: width/height = the physical size with units, viewBox = the same numbers without units. Inkscape's example is `width="100mm" viewBox="0 0 100 100"` → 1 uu = 1 mm — [Units in Inkscape wiki](https://wiki.inkscape.org/wiki/Units_In_Inkscape)
- [P] Historically Inkscape used 90 px/in and Illustrator 84 px/in before the CSS 96 value was adopted, so imported SVGs can be off by 90/96 or 84/96 — [Inkscape-devel list](https://lists.inkscape.org/hyperkitty/list/inkscape-devel@lists.inkscape.org/message/SFR6N36AH5PUYARKZYPFO5OPQKBKIYFD)
- [P] Some SVG generators (e.g. R's svglite) omit width and height, so physical scale can't be recovered. The fix is to set them explicitly — [svglite scaling vignette](https://rdrr.io/cran/svglite/f/inst/doc/scaling.Rmd)

### Inferences
- Wren's drawing editor is an SVG DOM. Make the editor SVG's user unit = sheet mm from the start, and set `stroke-width` in mm user units. Export then becomes serialisation plus font handling, and PDF via svg2pdf receives mm coordinates directly (scale by 72/25.4 once).
- Export options: (a) "editable": `<text>` with an embedded subset `@font-face` (WOFF2 data URI). The text stays searchable but some laser and CAM SVG importers ignore it. (b) "outlined": text converted to `<path>` for laser and CNC. Default to (a) for documentation and (b) for fabrication.
- Avoid `vector-effect: non-scaling-stroke` and CSS-class styling in exported SVG. Use presentation attributes, for compatibility with svg2pdf (subset support) and with Inkscape and laser software (inference).

### Gaps
- No sources retrieved on how laser software (LightBurn, RDWorks, Glowforge) treats SVG units or text. Worth a follow-up, since Wren's users may use SVG rather than DXF for laser work.
