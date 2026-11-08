# Whittle user guide

This guide covers the app as it is deployed today (M1). It is task-oriented: find the task you want
and follow the steps. Shortcuts and gestures are taken from the code, not from the plan. Features
that are planned but not in the app are marked **Coming in M2** or **Planned**.

Live app: <https://jackhale98.github.io/whittle/>

Contents: [Getting started](#getting-started) · [The interface](#the-interface) · [Sketching](#sketching) ·
[Building features](#building-features) · [Feature tree](#feature-tree-rollback-edit-suppress) ·
[Parameters and expressions](#parameters-and-expressions) · [Materials and mass](#materials-and-mass) ·
[When a reference needs attention](#when-a-reference-needs-attention) · [Import and export](#import-and-export) ·
[Files and the library](#files-and-the-library) · [Offline, install and updates](#offline-install-and-updates) ·
[Keyboard shortcuts](#keyboard-shortcuts) · [Touch and pen](#touch-and-pen)

## Getting started

1. Open <https://jackhale98.github.io/whittle/>. The welcome card appears.
2. Choose **Open the demo bracket** to see a finished part. It has a base plate with holes, an
   upright, fillets and a chamfer. Every size is a parameter, and the material is aluminium 6061-T6.
   Try changing `width` in the **Params** tab and watch the part update.
3. Or choose **New part** to start a blank part.
4. Your work saves on this device as you go. Reopen the app and the last document comes back.

To find things quickly, press **⌘K** (Ctrl+K on Windows and Linux) and type a command. The palette
has Welcome and samples, the demo bracket, New document, Open library, Open or import file, Save as
`.whittle`, Box, Cylinder, Plane, Boolean, Undo, Redo, Check for updates and About.

## The interface

### Desktop

- **Top bar.** The feature-panel toggle, the document name, undo and redo, an export menu, the theme
  toggle, and the inspector toggle. A version menu is shown but disabled until M2.5.
- **Left panel.** Two tabs: **Features** (the feature tree with its rollback bar) and **Params**. Drag
  the edge to resize it.
- **Viewport (centre).** The 3D view. The units chip and the kernel status are at the top left. The
  command bar is at the bottom: Sketch, Solid, Modify, Hole, Inspect and More. Solid, Modify and Inspect open a flyout of their tools (arrow keys work inside it) and show the tool you used last; shortcuts such as **E** still run a tool directly. The
  **Library** button is under the top bar. A view cube in the top-right corner sets the standard
  views: click a face, edge or corner, and the camera animates to it.
- **Right panel.** The **Inspector** for whatever you have selected. A **Runtime** section at the
  bottom shows the kernel variant and the render backend.

### Tablet

- The viewport fills the screen. The document name, undo and redo, the search (command palette),
  theme and export sit in a floating bar at the top left.
- A tool rail on the left holds the command bar tools.
- A bottom sheet holds **History** (the feature tree), **Params** and **Inspector**. Pull it up to
  see them.

### Phone

- The phone is a viewer. You can orbit and zoom, open the library, edit parameters, and export.
- The bottom sheet has five tabs. **Params** and **Export** work. **Parts**, **Measure** and
  **Section** are placeholders.
- You cannot create or edit features on a phone yet. Use a desktop or tablet.

## Sketching

A sketch is a 2D drawing on a plane. You extrude or revolve it into a solid.

### Start a sketch

1. Press **S**, or choose **Sketch** in the command bar. The prompt says "Select a plane or a
   planar face".
2. Choose one of the origin planes from the plane chooser (**Top** is XY, **Front** is XZ and
   **Right** is YZ), or click a flat face of the model.
3. Draw. Press **Esc** to leave the current tool, and press **Esc** again to finish the sketch.

### Tools

The sketch toolbar has these tools. Press the shortcut again to cycle through a tool's variants, or
open its menu with the arrow key or a long press.

| Tool | Shortcut | Variants |
| --- | --- | --- |
| Line | L | Line, polyline |
| Rectangle | none | Corner, centre, 3-point |
| Circle | Shift+C | Centre, 3-point |
| Arc | A | 3-point, tangent, centre-point |
| Slot | none | none |
| Polygon | none | none |
| Dimension | D | none |

Press **X** to toggle construction geometry. Construction lines guide the sketch but do not make
regions. While you draw, Whittle snaps to horizontal, vertical, parallel, perpendicular and tangent
directions, and to existing points.

### Constraints

Select one or more entities, then open the constraints menu on the toolbar. Only the constraints that
fit the selection are enabled. The list includes coincident, horizontal, vertical, parallel,
perpendicular, tangent, equal, midpoint, concentric, symmetric, fix, point on curve, and horizontal
or vertical points.

### Dimensions

Choose **Dimension** (D), then:

- click a line to dimension its length, a circle for its diameter, or an arc for its radius;
- click two points for their distance, or two lines for an angle;
- click a point and a line, or two points, and move the mouse to place the label. Whittle makes a
  horizontal or vertical distance depending on where you place the label. Hold **Shift** to keep the
  dimension aligned instead.

Dimension values accept expressions and units, such as `25mm + 1/8in` or a parameter name. Click a
dimension and press Enter to edit it.

Each dimension label has small toggles:

- **Driving** or **(Reference)**. A driving dimension sets the geometry. A reference dimension
  only measures it, and you cannot type a value into it.
- **R → Ø** or **Ø → R**, for circles and arcs.

### Reading the colours and status

- **Blue** geometry still has free degrees of freedom, so it can still move.
- **Near-black** geometry (white in dark mode) is fully constrained.
- Geometry that is partly constrained is a blend of the two.
- **Red** geometry is part of a conflict.
- The status chip at the top left shows the state: "N degrees of freedom" (blue), "Fully
  constrained", "Over-constrained" (red), or "Solver failed".

### Fixing conflicts

When constraints conflict, a panel appears at the top right. It names the constraints that cannot all
hold and says why, in plain words, for example "Line 2 can't be both horizontal and at 30 degrees".
Each conflict has suggested fixes. Click a fix to apply it, or dismiss the panel and fix the sketch
by hand. Whittle lists a minimal set of conflicting constraints, so you can usually remove just one.

## Building features

Whittle has two ways to start a feature.

- **Act first, select second.** Press a tool's shortcut, or choose it in the command bar. The prompt
  chip says what to select, such as "Select a sketch region to extrude". Click it. The feature is
  created as soon as the pick is made.
- **Select first, act second.** Select the geometry, and the tools that fit appear. Selected regions
  offer Extrude and Revolve. Selected edges offer Fillet and Chamfer. A selected face offers Sketch.

### Extrude

Select a sketch region (a closed area), then press **E**. Type the depth in the depth field on the
viewport, or edit it in the inspector. The end condition is **Blind** (a depth), **Up to** (a
face), or **Through all**. The direction can be normal, reverse or symmetric. The operation is
**New**, **Add**, **Cut** or **Intersect**.

The **Draft angle** field exists, but a non-zero draft is rejected for now ("Draft on extrude is
not available yet"). Leave it empty.

### Revolve

Select a sketch region, then press **R**. The revolve uses an axis of the sketch's plane by default;
you can pick a sketch line or a straight edge as the axis instead. Set the angle (default 360
degrees), the direction and the operation in the inspector.

To make a **sphere**, sketch a semicircle (an arc closed by a line along its diameter) and revolve it
360 degrees about that line. The same approach gives domes, balls on a shaft, and other turned shapes.

### Fillet and chamfer

Select one or more edges, then press **F** (fillet, default radius 2 mm) or **C** (chamfer, default
1 mm). In the inspector, change the radius, or choose a chamfer by **Distance** or **Distance and
angle**.

### Primitives

From the command palette, choose **Box** (40 × 30 × 20 mm by default) or **Cylinder** (radius
10 mm, height 20 mm). They are created as new bodies, and you can change their dimensions in the
inspector.

### Plane

Choose **Plane** from the palette. It creates an offset plane 20 mm from the XY plane. Edit the
distance in the inspector, or select a face to offset from.

### Boolean

Choose **Boolean** from the palette. It needs at least two bodies. The first body is the target
and the rest are tools, and the default operation is **Cut**. In the inspector, change the operation
(Add, Cut or Intersect), the target and tools, and choose **Keep tool bodies** if you want to keep
them.

### Import

See [Import and export](#import-and-export). An imported file becomes a feature, and you can set its
operation (New, Add, Cut or Intersect) like any other solid.

### Bodies

A part can have several bodies. A new feature with the **Add** operation joins the bodies it
touches. **Cut** and **Intersect** work the same way. **New** creates a separate body.

## Feature tree: rollback, edit, suppress

The **Features** tab lists your features in order, with an icon and a name for each one.

- **Select** a feature to see its settings in the inspector.
- **Rollback bar.** Drag the bar between features, or choose **Roll to here** from a feature's
  actions. Features below the bar are not evaluated. Drag the bar back to the end to restore them.
- **Edit.** Choose **Edit** from a feature's actions. For a sketch, this opens the sketch again.
- **Suppress and unsuppress.** Choose **Suppress** from a feature's actions to leave it out of the
  model without deleting it.
- **Reorder.** Drag a feature by its grip, or use **Alt+Up** and **Alt+Down**. Whittle refuses a move
  that would put a feature before something it depends on.
- **Rename.** Press Enter or F2 on a feature, or double-click its name.
- **Delete.** Choose **Delete** from a feature's actions, or press Delete or Backspace on a selected
  row. Deleting takes effect at once, and you can undo it.

A feature that fails is marked in the tree with a short explanation. Its last good geometry stays
on screen as a ghost, so you can see what changed.

## Parameters and expressions

Parameters are named values you can reuse. They live in the **Params** tab.

- **Add parameter** creates `param1`, `param2`, and so on, with the value 10 mm. Rename it, change
  the expression, or add a description.
- **Rename a parameter** and every reference to it updates in one undo step.
- **Delete a parameter** that is in use asks you to confirm.

### Expressions

A value can be a number, a unit, a parameter name, or a formula.

- Units: `um` or `µm`, `mm`, `cm`, `m`, `in`, `ft`, `deg` (or `°`), `rad`, `g`, `kg`, `lb`, `s`,
  `N`, `Pa`, `kPa`, `MPa`, `GPa`. Compound units work too, such as `2.70 g/cm^3`.
- Functions: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sqrt`, `abs`, `min`, `max`,
  `round`, `floor`, `ceil`.
- Constants: `pi` and `π`. These are plain numbers, not angles. Write `pi rad` for radians.
- Examples: `width/2 + 3mm`, `25mm + 1/8in`, `sin(30deg)`, `2*hole_d`.

Bare numbers take the default unit of what they stand for. In a document that uses millimetres and
degrees, `5` as a length means 5 mm, and `30` as an angle means 30 degrees. Next to a value with a
unit, a bare number takes that unit: `width + 5` means 5 mm when `width` is in millimetres.

A name is a parameter, unless it comes straight after a number, where it is a unit. So `2 mm` is a
length, but a parameter named `mm` would be confusing, so avoid that.

Document units are millimetres and degrees. The app has no control to change them yet.

## Materials and mass

With nothing selected, the inspector shows the part: its name, material and mass.

- **Assign material** (or **Change material**) opens the material picker.
- The **Library** tab has 16 built-in materials, for example structural steel, aluminium 6061-T6,
  stainless steel 304, titanium Ti-6Al-4V, ABS, PLA, PETG and nylon PA12, and oak and pine. Search
  by name or category.
- The **Custom** tab takes a name and a density expression, for example `1.2 g/cm^3`.
- Choose **Apply material**.

The **Mass properties** section shows volume, surface area, mass and centre of mass. Without a
material, you see the geometry and a prompt to assign one. Inertia is calculated but not shown yet.

## When a reference needs attention

A feature refers to faces, edges or sketch regions by name. When you change an upstream feature, a
name might no longer match the geometry it meant. Whittle does not guess. It marks the feature
**needs attention**.

What you see:

- The feature row says **needs attention**.
- Its inspector shows a banner with a **Re-pick** button (or **Choose** when there are several
  candidates).
- The old location of the reference is drawn as a translucent ghost in the viewport, so you can see
  where it used to be.
- If several things match, the **Which one?** list shows them. Choose the right one.

What to do:

1. Click **Re-pick** (or the **Re-pick** button next to the reference in the pick field).
2. The model rolls back to the feature's input, so you pick geometry that exists before the feature.
3. Click the new face, edge or region.

If Whittle can match the reference again by its name and location, it updates the reference quietly
with your next edit, in the same undo step. You do not need to do anything.

## Import and export

### Import

Use any of these:

- Press **⌘O** (Ctrl+O on Windows and Linux) or choose **Open or import file…** from the palette.
- Drag files onto the viewport.
- Open a file from your computer with the app, when your system supports it.
- Use **Open or import…** in the library or on the welcome card. This starts a new document for the
  file.

| Format | Extensions | What you get |
| --- | --- | --- |
| STEP | `.step`, `.stp` | Solid bodies, one per solid. Assemblies are flattened. |
| BREP | `.brep`, `.brp` | Solid bodies |
| STL | `.stl` | A reference mesh body |
| OBJ | `.obj` | A reference mesh body |
| 3MF | `.3mf` | A reference mesh body |
| GLB | `.glb` | A reference mesh body |
| `.whittle` | `.whittle` | Opens a project |

Mesh files (STL, OBJ, 3MF, GLB) come in as reference bodies. You can see and export them, but you
cannot use them in booleans, fillets or chamfers. Mesh files can only be imported as **New**.

IGES files (`.iges`, `.igs`) are not supported yet. Export them as STEP from the other program.

### Export

Choose the export control in the top bar (on a phone, in the **Export** tab). Then choose a format.

| Format | Options |
| --- | --- |
| STEP | AP214 |
| STL | Binary or ASCII. One merged file, or one file per body. |
| 3MF | Units in millimetres, with the body colour |
| GLB | For web and AR viewers |
| Whittle project (`.whittle`) | The whole document, with its imported files and cache |

For STL, 3MF and GLB, choose the tessellation quality: **Coarse** (0.1 mm), **Standard** (0.02 mm)
or **Fine** (0.005 mm). If the part has several bodies, you can choose which ones to export.

STEP and STL are made by the geometry kernel, so they need it to be ready. Until it is, the export
says that the kernel is still loading.

BREP export is not offered in the export menu yet.

## Files and the library

### Autosave

Whittle saves your document to the library on this device about half a second after your last edit,
and again when you leave the page. You do not need to save manually.

### The library

Open it with the **Library** button in the viewport, or with **Open library** in the palette. It lists
your documents with thumbnails. You can:

- click a document to open it (the one open now is marked "Open now");
- search by name;
- rename a document with the pencil button;
- delete a document with the trash button, then confirm with **Delete**.

The library lives in your browser's storage on this device. Clearing the site's data removes it. If
you need a copy, save a `.whittle` file.

### `.whittle` files

- **Save as .whittle file** (⌘S, or Ctrl+S on Windows and Linux) saves the project as a file. It
  contains the document, the imported files, and the mesh cache.
- Open a `.whittle` file with ⌘O, or drag it onto the viewport.
- If the file is the same project as one in your library, Whittle reuses that entry. If it has the
  same ID but different content, Whittle opens it as a new library entry, named "Name (copy)" when
  the name is already taken. Your existing entry is never overwritten.

## Connections, versions and compare

The branch button and the sync chip in the top bar open the **Versions** and **Connections**
panel (also ⌘K → "Versions" or "Connections"). Everything works by touch; nothing opens a
dialog.

### Connections

- **Add connection** → choose a service. Dropbox and OneDrive open their sign-in page and bring you
  back to where you were. WebDAV (Nextcloud) asks for the server, user name and an app password;
  turn on **Use relay** if the server refuses requests from Whittle (CORS). Git hosts take a
  repository (`owner/name` or its address) and an access token limited to that repository.
- Then pick a folder. **Open** on a Whittle project folder copies it into your library; **Use** on
  any other folder links the open project to it and uploads it.
- **Open a local git repo…** (Chrome or Edge on a computer): pick the repository's top folder. The
  project's files on disk are the working copy, and versions are real commits your own git tools
  see. Whittle offers to add `.whittle/` to `.gitignore`, lists uncommitted changes, and won't
  switch branches while there are any. Push and pull with your own git, or sign in to the
  repository's host in Connections to push from Whittle.
- Tokens and passwords are stored encrypted on this device only.

### Background sync

A linked project saves locally at once and uploads a few seconds later. It checks for changes
from other devices every minute or so, whenever you come back to the app, and when you reconnect.
Changes from another device arrive as one step you can undo; while you are sketching or dragging
they wait until you finish. Offline edits queue up and upload when you're back online.

If both devices changed the same thing, the chip shows **Resolve**. The merge panel lists each
conflict side by side: keep yours, take theirs, or type a value, with a 3D preview of each choice.
Nothing is uploaded until you finish.

### Versions

- **Save version** with a short message. Automatic snapshots are taken every 10 minutes while you
  edit (show them with the switch) and thinned out over time. Named versions are never removed.
- **Try an idea** starts a branch; switch branches with the Branch menu.
- **Restore** brings an old version back as one undoable step.
- **Mark as release** freezes a STEP export (AP214) into `releases/<name>/`. Releases are
  read-only. Restore a version first if you want to release an older one.
- Versions live in the project's `.whittle-history/` folder, so they sync with it. Git projects use
  the repository's commits, branches and tags instead.

### Compare

Open a version and choose **Compare with current**. The panel lists what changed by feature
("Pocket: depth 4 mm → 5 mm") and how mass and size moved. The viewport shows material the
current model adds in green and material it removes in red, over a ghost of the model; the
**Added** and **Removed** switches show one side at a time, and the swatches in the panel are the
exact colours drawn. **Done** leaves compare.

## Offline, install and updates

### Offline

After your first visit, the app and the geometry kernel are stored in your browser. You can open
the app, your library and your documents without a connection. The first visit needs a connection.

### Install

- **Chrome and Edge:** choose **Install app** on the welcome card, or use the install icon in the
  address bar.
- **iPhone and iPad (Safari):** tap the Share button, then **Add to Home Screen**. The welcome card
  shows this hint.

### Updates

When a new version is ready, a banner says **Update available · Reload**. If you have not touched the
page yet, Whittle updates by itself. Whittle checks for updates when you come back to the page and
every 30 minutes. To check now, choose **Check for updates** in the palette.

## Keyboard shortcuts

These are the shortcuts in the code. On a Mac, ⌘ is the Command key. On Windows and Linux, use Ctrl.

### Anywhere

| Shortcut | Action |
| --- | --- |
| ⌘K | Open the command palette |
| ⌘Z | Undo |
| ⇧⌘Z or ⌘Y | Redo |
| ⌘O | Open or import a file |
| ⌘S | Save as a `.whittle` file |
| Esc | Cancel the innermost thing: a chooser, a pick, a prompt, the selection, the open feature, the library or the welcome card |

### Model (when no sketch is open and no text field has focus)

| Key | Action |
| --- | --- |
| S | Start a sketch |
| E | Extrude |
| R | Revolve |
| F | Fillet |
| C | Chamfer |
| Space | Repeat the last tool |
| 0 or 7 | Isometric view |
| 1 | Front view |
| 2 | Back view |
| 3 | Left view |
| 4 | Right view |
| 5 | Top view |
| 6 | Bottom view |

Shift-letter keys are not used for model tools.

### Sketch

| Key | Action |
| --- | --- |
| L | Line |
| A | Arc |
| Shift+C | Circle |
| D | Dimension |
| X | Toggle construction geometry |
| Delete or Backspace | Delete the selected sketch entities |
| Esc | Leave the current tool. With no tool active, Esc finishes the sketch. |

### Feature tree (when a row has focus)

| Key | Action |
| --- | --- |
| Up, Down, Home, End | Move between features |
| Space | Select the feature |
| Enter or F2 | Rename |
| Alt+Up, Alt+Down | Move the feature up or down |
| Delete or Backspace | Delete the feature |
| Shift+F10 or the Menu key | Open the feature's actions |

### Selection

Hold **Shift**, **Ctrl** or **⌘** while you click to add to the selection. A click on empty space
clears it.

Keys are ignored while you type in a field.

Not in the app yet: the plan's M (Measure) and H (Hide) keys.

## Touch and pen

These gestures work today on a touch device.

| Gesture | Action |
| --- | --- |
| One finger on the model | Orbit |
| Two fingers, pinch | Zoom |
| Two fingers, drag | Pan |
| Three fingers, drag | Pan |
| Tap a face, edge or vertex | Select it. A tap on a face picks the face unless an edge or vertex is very close. |
| Tap empty space | Clear the selection |
| Double-tap | Fit the whole model in view |

Several things are close together? A **Which one?** list appears. Choose the one you mean.

Number fields open an on-screen keypad on touch devices, so you can type expressions with units.
Whittle also stops page-level pinch zoom and double-tap zoom, so only the model and panels move.

**Coming in M2:**

- Pencil drawing, with pen input for sketching and primitive recognition
- Push and pull (dragging a face to change a feature)
- Measure and section on the phone
- Context menus on long press, and two- or three-finger tap for undo and redo
- A guided bracket tutorial for new users
