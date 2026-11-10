# Wren user guide

This guide covers the app as it is deployed today (M1). It is task-oriented: find the task you want
and follow the steps. Shortcuts and gestures are taken from the code, not from the plan. Features
that are planned but not in the app are marked **Coming in M2** or **Planned**.

Live app: <https://jackhale98.github.io/wren-cad/>

Contents: [Getting started](#getting-started) · [The interface](#the-interface) · [Sketching](#sketching) ·
[Building features](#building-features) · [Feature tree](#feature-tree-rollback-edit-suppress) ·
[Parameters and expressions](#parameters-and-expressions) · [Materials and mass](#materials-and-mass) ·
[When a reference needs attention](#when-a-reference-needs-attention) · [Import and export](#import-and-export) ·
[Files and the library](#files-and-the-library) · [Offline, install and updates](#offline-install-and-updates) ·
[Keyboard shortcuts](#keyboard-shortcuts) · [Touch and pen](#touch-and-pen)

## Getting started

1. Open <https://jackhale98.github.io/wren-cad/>. The welcome card appears.
2. Choose **Open the demo bracket** to see a finished part. It has a base plate with holes, an
   upright, fillets and a chamfer. Every size is a parameter, and the material is aluminium 6061-T6.
   Try changing `width` in the **Params** tab and watch the part update.
3. Or choose **New part** to start a blank part.
4. Your work saves on this device as you go. Reopen the app and the last document comes back.

To find things quickly, press **⌘K** (Ctrl+K on Windows and Linux) and type a command. The palette
has Welcome and samples, the demo bracket, New document, Open library, Open or import file, Save as
`.wrencad`, Box, Cylinder, Plane, Boolean, Undo, Redo, Check for updates and About.

## The interface

### Desktop

- **Top bar.** The feature-panel toggle, the document name, undo and redo, the version menu, an export
  menu, **Settings** (the gear), the theme toggle, and the inspector toggle.
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
- The bottom sheet has six tabs. **Features**, **Params** and **Export** work. **Parts**, **Measure**
  and **Section** are placeholders.
- **Features** shows the feature tree with a draggable rollback line; see [Reviewing on the phone](#reviewing-on-the-phone).
- You cannot create or edit features on a phone yet. Use a desktop or tablet.

## Navigating and selecting

### The mouse

The left button **never moves the camera**. It picks and box-selects. Navigation is on the other buttons,
and you choose the layout in **Settings** (the gear in the top bar, or ⌘K, **Settings**). Settings opens as a
panel over the view, not as a dialog: the model stays live behind it, and Esc or **Close** dismisses it.
On a phone, open it from ⌘K (the More button).

| Preset (named by what it does) | Orbit | Pan | Right click |
| --- | --- | --- | --- |
| **Right button orbits** (default) | Right-drag | Middle-drag | Radial menu |
| **Middle button orbits** | Middle-drag | Ctrl + middle-drag, or right-drag | Radial menu. A middle click on the model sets the pivot. |
| **Middle button pans** | Right-drag, or Shift + middle-drag | Middle-drag | Radial menu |
| **Right click repeats** | Right-drag | Middle-drag | A quick click repeats the last command. Hold it for the radial menu. |

The wheel zooms toward the cursor in every preset. Under **Orbit** you can also choose:

- **Turntable** (the +Z axis stays up) or **Trackball** (free rotation);
- the pivot: the **surface point under the cursor** when the drag starts (default), or always the
  centre of the model. Orbiting turns the view about that point, so the point you grabbed stays under
  the cursor. If you start on empty space it falls back to the centre of what is on screen, never to a
  stale point off screen;
- whether the **pivot marker** (a dot at the pivot) shows while you orbit;
- invert zoom, and orbit speed. A drag follows the pointer one to one: there is no smoothing.

The settings are kept on this device (`wren.navigation`).

### Clearing a selection

Tap or click empty space to clear the selection. On a tablet, the context bubble and the selection
inspector also have a ✕ **Clear selection** button, so you never need Esc.

### Box select

Drag with the left button on empty space (or on the model) to draw a box.

- **Left to right** is a **window**: it selects what lies entirely inside the box. The box has a solid
  edge.
- **Right to left** is a **crossing**: it selects everything the box touches. The box has a dashed
  edge.
- A plain drag replaces the selection, **Shift** adds to it, and **Ctrl** (⌘ on a Mac) toggles what the
  box covers. A drag over nothing clears the selection.

Box select is for the mouse and the Pencil. A finger drag still orbits. A click still picks one item,
and dragging a push/pull arrow or a sketch point is not a box.

### The radial menu

A **right click** (mouse), a **long press** (finger or Pencil), or a **held Q** opens a ring of up to seven
commands for what is under the pointer, with **Repeat** always at the top. If you right-click an
unselected face, edge or region it is selected first, so the ring fits it:

| Selection | The ring offers |
| --- | --- |
| Nothing | Sketch, Measure, Section, Fit view, Isometric, Undo, Redo |
| Several features picked in the feature tree (nothing selected in the model) | Add to new folder, Measure, Section, Fit view, Isometric, Undo, Redo |
| One flat face | Sketch, Push/pull, Hole, Shell, Draft, Measure, Section |
| A curved face | Thread, Shell, Draft, Measure |
| Several flat faces | Push/pull, Shell, Draft, Measure |
| Edges | Fillet, Chamfer, Measure |
| A vertex | Measure, Plane, Axis, Point |
| A sketch region | Extrude, Cut, Revolve, Sweep |
| In a sketch | Line, Circle, Arc, Rectangle, Dimension, Spline, Finish sketch |

Inside a sketch the ring opens with a right click or a held Q; a finger long-press or a Pencil hold there selects or grabs geometry instead.

Items sit in fixed places, so you can learn them: Repeat is at the top, the rest fill clockwise from the
upper right. **Flick** toward an item right after the click, before the ring is drawn (a quarter of a
second), and the command runs without the ring ever showing. Once it is drawn, moving the mouse only
highlights; click an item, or use the arrow keys and Enter, or the digits 1 to 8, to choose. The ring
appears when you release the button and ignores a click that started before it appeared, so it never
catches the next click. A press outside it closes it, and that press does not click through.

- **Space** repeats the last command (unless a button or list row has focus: Space then activates that, as usual). In a sketch it brings back the last sketch tool.
- With a finger or the Pencil, hold on the spot for half a second; the ring draws at once, and you can
  drag onto an item and lift. Lifting without a direction leaves it open for a tap.
- **Hold Q**: the ring opens at the pointer; point and release to choose; releasing with no direction
  cancels. Q is a keymap entry (**Radial menu**) and can be moved.

**Add to new folder** only appears when the features you picked in the tree can be grouped (they
form one run in the history and none is in a folder yet). The ring has no room to say why not; the
tree's menu and the command palette do.

The **context bubble** on touch is unchanged: it appears after you tap to select. The long press is the
radial menu.

### Which one?

When several things overlap under the pointer (a vertex, the edges meeting there, the faces around it), a
click on a close tie lists them in a **Which one?** list: vertices first, then edges, faces and bodies, nearest
first, with a fixed order for equal distances. Hover a row to see it highlighted. With a still pointer
over overlapping geometry you can also press **Tab** and **Shift+Tab** to step the highlight through the
same list, and **Enter** (or a click) to pick it. Tab only does this when no control has focus, so
keyboard navigation of the panels is unchanged.

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
| Point | P | none |
| Dimension | D | none |
| Spline (control points) | B | Open or closed |
| Spline (through points) | Shift+B | Open or closed |
| Ellipse | Shift+E | none |
| Elliptic arc | Shift+A | none |

The four curve tools are under **Curves** on the toolbar.

**Point** places a lone sketch point: a hole centre for the hole wizard, or a reference to
dimension from. On touch devices every tool has a text label under its icon.

### Ellipses and splines

- **Ellipse** (Shift+E): click the centre, click the end of an axis, then click a point whose distance
  from that axis sets the other radius. The axis can be either one: the longer radius becomes the major
  axis.
- **Elliptic arc** (Shift+A): the same three clicks for the ellipse (it is drawn dashed), then click the
  start and the end of the arc. The arc runs counter-clockwise from the start.
- **Spline, control points** (B) and **through points** (Shift+B): click the points. The curve shows as you
  go. **Enter**, a **double-click** or a **double-tap** ends the open curve; clicking the **first point
  again** closes it. A through-point spline passes through every point you clicked, and dragging one of
  those points reshapes the curve. A control-point spline is pulled by its poles (shown as construction
  points). Both are cubic.
- The Pencil turns an oval into an ellipse and a smooth stroke into a spline. Dimension, constrain and
  extrude them like any other geometry. Tangent works between any two curves; a curvature-continuous
  constraint that the solver cannot hold is reported as unsupported rather than dropped.
- Inference and snapping work as for the other tools: the cursor snaps to points, midpoints and curves.

Press **X** to toggle construction geometry. Construction lines guide the sketch but do not make
regions. While you draw, Wren snaps to horizontal, vertical, parallel, perpendicular and tangent
directions, and to existing points.

### Leaving a tool

The **Select** tool (arrow) is the first button of the sketch toolbar. It is pressed when no drawing tool
is active, and tapping it drops the current tool and returns to selecting. On a touch screen the active
tool also shows a ✕ **Done with <tool>** beside it. With no tool active, the Pencil draws freehand
strokes that Wren recognises.

### Pencil: draw, or hold to grab

With no tool selected, the Pencil does two things, depending on how you press.

- **Move at once** and you draw a freehand stroke that Wren recognises. If the stroke starts on an existing
  corner or end point, its start joins that point (a coincident constraint) and the point does not move, so
  you can chain strokes from a corner quickly.
- **Press and hold still** for about 0.3 s on sketch geometry and it is grabbed: the target lights up and
  then follows the Pencil as a normal solver drag (one undo step; constraints and dimensions are kept). You
  can grab a point (a rectangle corner, a line or arc end), a circle's or arc's centre (the circle moves), a
  circle's or arc's edge (its radius changes) or a line's body (the line moves).
- **Hover** the Pencil over geometry (on an iPad with Pencil hover) and what a hold would grab is
  highlighted.
- Geometry that is already selected drags at once, a tap selects, a drawing tool in use takes the Pencil
  as before, and fingers are unchanged.

### Editing sketches

The **Edit** button on the sketch toolbar opens the editing tools. Each one is a small panel over
the view, never a dialog. **Apply** (or Enter) makes the change as one undo step, named after what
it did, such as "Offset 4 entities by 5 mm". **Esc** first clears the picks, then leaves the tool.

| Tool | Shortcut | How it works |
| --- | --- | --- |
| Offset | O | Click the lines and arcs of a chain (or select them first), type the distance (an expression), and choose the side or **Both sides**. The copy stays parallel and follows its source: one driving dimension controls it. |
| Convert entities | V | Click model edges, or switch to **Face** and click a face for its whole outline. **Convert** projects them into the sketch as linked, fixed curves. |
| Trim / extend | T / E | Each click trims the part of a curve up to its nearest crossings, or extends a curve's nearest end to the next boundary. |
| Sketch fillet / chamfer | F / Shift+F | Click corner points, type the radius or distance, then Apply. |
| Mirror | M | Click the entities, switch to **Mirror line** and click a line or an axis, then Apply. |

**Linked geometry.** Converted curves update when the model changes upstream. Select one to see the
**Linked geometry** panel: where it comes from, and **Unlink** to keep it as plain sketch geometry.
If its source edge is gone, the sketch needs attention: the panel shows the old source, a ghost marks
where it was, and **Re-pick** lets you click the edge it should follow now. Wren never picks another
edge by itself.

### Constraints

Select one or more entities, then open the constraints menu on the toolbar. Only the constraints that
fit the selection are enabled. The list includes coincident, horizontal, vertical, parallel,
perpendicular, tangent, equal, midpoint, concentric, symmetric, fix, point on curve, and horizontal
or vertical points.

### Dimensions

Choose **Dimension** (D), then:

- click a line to dimension its length, a circle for its diameter, or an arc for its radius;
- click two points for their distance, or two lines for an angle;
- click a point and a line, or two points, and move the mouse to place the label. Wren makes a
  horizontal or vertical distance depending on where you place the label. Hold **Shift** to keep the
  dimension aligned instead.

Dimension values accept expressions and units, such as `25mm + 1/8in` or a parameter name. Click a
dimension and press Enter to edit it.

A dimension is drawn the way other sketchers draw it: **extension lines** from the measured geometry, a
**dimension line with arrows** between them, a **leader** for a radius or diameter, and an **arc** for an
angle, so you can see what it measures. They highlight when you hover them and when the dimension is
selected, and a reference dimension is dashed.

**Drag a label** (mouse, finger or Pencil) to move the dimension line where you want it. A drag only moves
the label: the value never changes, a plain tap still edits it, and the move is one undo step, "Move
dimension".

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
by hand. Wren lists a minimal set of conflicting constraints, so you can usually remove just one.

Constraints and geometry are named ("Line 2", "Angle 30° (Line 1, Line 2)"), never numbered. Hovering or
focusing a conflict highlights the whole set on the canvas. The first fix is marked **Suggested**: it
removes the constraint you added last, which is usually the one that broke the sketch.

## Building features

Wren has two ways to start a feature.

- **Act first, select second.** Press a tool's shortcut, or choose it in the command bar. The prompt
  chip says what to select, such as "Select a sketch region to extrude". Click it. The feature is
  created as soon as the pick is made.
- **Select first, act second.** Select the geometry, and the tools that fit appear. Selected regions
  offer Extrude, Revolve, Extruded cut, Sweep and Loft. Selected edges offer Fillet and Chamfer. A
  selected flat face offers Sketch, Push/pull, Hole, Shell and Draft.

The tools added in M3 (sweep, loft, shell, draft, hole, thread, mirror, patterns and reference
geometry) open their feature at once and then ask for each reference in turn. The prompt chip says
what to pick next, such as "Select the path curves, in order". A field that takes several picks
(the faces to taper, the sections of a loft) stays open until you press **Enter** or click the next
field in the inspector. If you selected something that fits the first field before choosing the
tool, it is used.

Some references have no shape you can click: the origin planes and axes, and reference planes, axes
and points. When a field takes one, chips such as **Top (XY)**, **Z axis** or **Plane 1** appear
beside the prompt. Tap one to pick it.

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

**Propagate along tangent edges** is on by default: the blend carries on along edges that continue
the selection smoothly, such as the arcs of a slot. If you turn it off, the selection must already
end where the tangent chain ends. Otherwise the feature turns red and names the tangent edges it
would have to include ("2 tangent edges continue the selection: the edge between …"). Turn the
option back on, or add those edges.

### Extruded and revolved cut

**Shift+E** and **Shift+R** (Solid group) are Extrude and Revolve with the operation already set to
**Cut**. An extruded cut goes into the material (reverse direction) by default.

### Sweep and loft

**Sweep** (W): pick the profile region, then the path curves (sketch curves or model edges) in
order, and press Enter. **Follow path** turns the profile with the path; **Fixed** keeps its
orientation. **Loft** (Shift+W): pick the section regions in order and press Enter. **Ruled** gives
straight faces between sections. Guide curves are stored but not used yet.

### Shell and draft

**Shell** (T): pick the faces to remove and press Enter, then set the wall thickness and whether it
goes inward or outward. **Draft** (Shift+T): pick the faces to taper, press Enter, then pick the
neutral plane or face, and type the angle. A positive angle leans the faces inward as they move away
from the neutral plane, on the side where the faces are, so the part gets narrower, as a moulded
part needs. **Reverse direction** flips that.

### Hole wizard and threads

**Hole** (O): pick the flat face, then the hole centres (sketch points, or reference points from the
chips), and press Enter. The default is an ISO M6 clearance hole through everything. Choose the
standard (ISO or ANSI), the type (simple, counterbore, countersink or tapped), the size and the fit;
the dimensions come from the standard's table and are shown read-only. Switch on **Override
diameter**, **Override counterbore** or **Override countersink** to type your own values. A size the
standard doesn't cover is reported, never guessed. **Thread** (Shift+O) records a cosmetic thread on
a cylindrical face; it doesn't change the geometry.

### Mirror and patterns

Select the feature to copy in the feature tree, then press **I** (mirror), **N** (linear pattern) or
**Shift+N** (circular pattern). To copy more features, click **Add** under "Features to copy" and
click them in the tree or on the model. Then pick the mirror plane, the direction (an edge, an axis or
a plane) or the axis, often from the chips. Set the count and spacing, or the count and angle. Click an
instance under **Instances** to skip it; the others keep their numbers.

### Reference geometry

**Plane** (G): an offset plane; pick the plane or face to offset from and type the distance. The
**Definition** list has the other kinds: through three points, at an angle about a line, normal to a
curve, midway between two planes, and through a point. **Axis** (Shift+G): along a straight edge by
default; also through two points, the axis of a cylinder, where two planes meet, or through a point
normal to a plane. **Point** (Shift+P): by coordinates by default; also at a vertex, the centre of a
circle or sphere, along an edge, or where two things cross. Sketch on a reference plane from the
plane chooser; pick axes and points from the chips.

### Primitives

From the command palette, choose **Box** (40 × 30 × 20 mm by default) or **Cylinder** (radius
10 mm, height 20 mm). They are created as new bodies, and you can change their dimensions in the
inspector.

### Plane from the palette

**Plane** in the palette creates an offset plane 20 mm from the XY plane (see
[Reference geometry](#reference-geometry) for the Plane tool).

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
- **Reorder.** Drag a feature by its grip, or use **Alt+Up** and **Alt+Down**. Wren refuses a move
  that would put a feature before something it depends on.
- **Rename.** Press Enter or F2 on a feature, or double-click its name.
- **Delete.** Choose **Delete** from a feature's actions, or press Delete or Backspace on a selected
  row. Deleting takes effect at once, and you can undo it.

### Folders

Group related features (a bracket's mounting holes, say) into a folder to keep a long tree tidy.

- **Create.** Select two or more features (Ctrl/Cmd-click toggles, Shift-click selects a range), open
  the menu on one of them and choose **Add to new folder**. The folder is named "Folder 1", "Folder
  2" and so on, and its name opens for editing at once. A sketch that sits under a selected feature
  comes with it. On a touch screen, long-press a row for its menu and tap **Add to new folder**.
  The ⌘K palette has **Add selection to new folder**, and the radial menu offers it when several
  features are picked in the tree.
- **A folder holds a run.** Its features are next to each other in the history, because the order of
  features matters. A feature can be in one folder. If the features you picked are not a run, or one
  is already in a folder, the item is disabled and says why.
- **Rename.** Press F2 on the folder or double-click its name; Enter keeps the name, Esc cancels.
- **Collapse and expand** with the chevron or the Left and Right arrow keys. This is remembered for
  the document on this device. It is not part of the file and is not an undo step. The rollback bar
  skips a collapsed folder as one unit.
- **Move.** Drag the folder's grip, or press **Alt+Up** / **Alt+Down**, to move the whole run. Wren
  validates the move like any reorder and refuses one that would put a feature before something it
  depends on.
- **Take a feature out** by dragging it out of the folder (Wren asks first: "Take Fillet 3 out of
  Mounting?"). Dropping a feature between two members adds it.
- **Folder actions** (the folder's menu): **Suppress all** / **Unsuppress all** (one undo step),
  **Show sketches** / **Hide sketches** for the sketches inside, **Roll back to before folder**,
  **Ungroup** (the features stay) and **Rename**.

Folders are saved with the document. Versions keep them, and a merge combines a rename on one
branch with a move on another. If two branches both move features in and out so that a run would be
split, the merge keeps the folder in one piece and says so in the merge notes.

### Showing and hiding sketches

A sketch that a feature used (an extrude, a cut, a revolve…) is hidden, as before. Every sketch row
in the tree now has an **eye** (nested under its feature, or in the flat list). It shows or hides
that sketch in the viewport whatever the default is, and the choice is saved with the document.

- A small dot on the eye means **automatic**: shown until a feature uses it, hidden after. Clicking
  the eye replaces that with an explicit **shown** or **hidden**.
- **Reset to automatic** (the sketch's menu) goes back to the default.
- **Show all sketches**, **Hide all sketches** and **Reset sketch visibility** are in the ⌘K palette,
  each one undo step. A folder's menu has **Show sketches** / **Hide sketches** for its sketches.
- A hidden sketch still shows while you pick a profile from it, and the sketch you are editing is
  always shown.
- With the rollback bar above a sketch's feature, nothing uses the sketch yet, so it shows.

### Reviewing on the phone

The phone's **Features** tab is just the feature tree, the same as on the tablet: folders, nested
sketches and the eye on each sketch.

- **Drag the line.** The rollback bar between the rows has a grab handle in the middle and a 44 px
  touch target. Drag it up to roll the model back to that point and down to bring features back; the
  model follows your finger. Each stop is an ordinary rollback edit, so **Undo** puts it back (a
  feature and the sketch under it count as one stop; a collapsed folder is skipped as a unit).
- **Touch and hold a row** to open its menu: **Suppress** or **Unsuppress** (an undoable edit), plus
  Rename, Edit and the sketch eye's Show / Hide.
- A change that arrives while you work (a sync from another device) is applied as usual.

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
name might no longer match the geometry it meant. Wren does not guess. It marks the feature
**needs attention**.

What you see:

- The feature row says **needs attention**.
- Its inspector shows a banner with a **Re-pick** button (or **Choose** when there are several
  candidates).
- The old location of the reference is drawn as a translucent ghost in the viewport, so you can see
  where it used to be.
- If several things match, the **Which one?** list shows them. Choose the right one.
- When Wren can tell which upstream change did it, the message says so: **"Fillet 2 lost its edge because
  Extrude 1 changed (depth 10 mm → 4 mm)."** The name of the cause is a button: click it, in the tree or in
  the inspector, to select that feature and fix it there. A feature that is waiting on a broken one
  follows the chain to the root ("Fillet 3 is waiting because Fillet 2 failed"). If the cause was deleted,
  the message says **"Extrude 1 was deleted"** and the inspector offers **Undo**. When Wren cannot tell what
  caused it, it says only that a reference needs attention; it never invents a cause.

What to do:

1. Click **Re-pick** (or the **Re-pick** button next to the reference in the pick field).
2. The model rolls back to the feature's input, so you pick geometry that exists before the feature.
3. Click the new face, edge or region.

If Wren can match the reference again by its name and location, it updates the reference quietly
with your next edit, in the same undo step. You do not need to do anything.

## Where geometry came from

Select a face, an edge or a vertex and the inspector shows **Made by**: the latest feature that created
or changed it, and that feature's sketch, each with an **Edit** button (a fillet's face names the fillet;
an extrude's side names the extrude and its sketch). **Edit** opens the feature in the inspector, or the
sketch for editing.

Select a feature in the history and the inspector lists **Built from** (the sketch and the features whose
geometry it uses) and **Used by** (the features that use it). The history marks them with a coloured edge
on the left, and the chips select those features.

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
| IGES | `.iges`, `.igs` | Solid bodies. Surface models are sewn into solids where their faces close. |
| BREP | `.brep`, `.brp` | Solid bodies |
| STL | `.stl` | A reference mesh body |
| OBJ | `.obj` | A reference mesh body |
| 3MF | `.3mf` | A reference mesh body |
| GLB | `.glb` | A reference mesh body |
| `.wrencad` | `.wrencad` | Opens a project |

Mesh files (STL, OBJ, 3MF, GLB) come in as reference bodies. You can see and export them, but you
cannot use them in booleans, fillets or chamfers. Mesh files can only be imported as **New**.

Many programs export IGES as separate surfaces. Wren sews them together, and every closed set of
faces becomes a solid. If the surfaces leave a gap, you get a surface body and a warning. You can
see, measure and export a surface body, but its volume and mass are not meaningful, and it cannot
add to, cut or intersect other bodies. Close the gap in the other program, or export a solid or a
STEP file.

Imported faces, edges and corners keep their names from one regeneration to the next, so a fillet
or a sketch on an imported face stays attached.

### Export

Choose the export control in the top bar (on a phone, in the **Export** tab). Then choose a format.

| Format | Options |
| --- | --- |
| STEP | AP214 |
| STL | Binary or ASCII. One merged file, or one file per body. |
| 3MF | Units in millimetres, with the body colour |
| GLB | For web and AR viewers |
| Wren project (`.wrencad`) | The whole document, with its imported files and cache |

For STL, 3MF and GLB, choose the tessellation quality: **Coarse** (0.1 mm), **Standard** (0.02 mm)
or **Fine** (0.005 mm). If the part has several bodies, you can choose which ones to export.

STEP and STL are made by the geometry kernel, so they need it to be ready. Until it is, the export
says that the kernel is still loading.

BREP export is not offered in the export menu yet.

## Files and the library

### Autosave

Wren saves your document to the library on this device about half a second after your last edit,
and again when you leave the page. You do not need to save manually.

### The library

Open it with the **Library** button in the viewport, or with **Open library** in the palette. It lists
your documents with thumbnails. You can:

- click a document to open it (the one open now is marked "Open now");
- search by name;
- rename a document with the pencil button;
- delete a document with the trash button, then confirm with **Delete**.

The library lives in your browser's storage on this device. Clearing the site's data removes it. If
you need a copy, save a `.wrencad` file.

### `.wrencad` files

- **Save as .wrencad file** (⌘S, or Ctrl+S on Windows and Linux) saves the project as a file. It
  contains the document, the imported files, and the mesh cache.
- Open a `.wrencad` file with ⌘O, or drag it onto the viewport.
- If the file is the same project as one in your library, Wren reuses that entry. If it has the
  same ID but different content, Wren opens it as a new library entry, named "Name (copy)" when
  the name is already taken. Your existing entry is never overwritten.

## Connections, versions and compare

The branch button and the sync chip in the top bar open the **Versions** and **Connections**
panel (also ⌘K → "Versions" or "Connections"). Everything works by touch; nothing opens a
dialog.

### Connections

- **Add connection** → choose a service. Dropbox and OneDrive open their sign-in page and bring you
  back to where you were. WebDAV (Nextcloud) asks for the server, user name and an app password;
  turn on **Use relay** if the server refuses requests from Wren (CORS). Git hosts take a
  repository (`owner/name` or its address) and an access token limited to that repository.
- Then pick a folder. **Open** on a Wren project folder copies it into your library; **Use** on
  any other folder links the open project to it and uploads it.
- **Open a local git repo…** (Chrome or Edge on a computer): pick the repository's top folder. The
  project's files on disk are the working copy, and versions are real commits your own git tools
  see. Wren offers to add `.wren/` to `.gitignore`, lists uncommitted changes, and won't
  switch branches while there are any. Push and pull with your own git, or sign in to the
  repository's host in Connections to push from Wren.
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
- Versions live in the project's `.wren-history/` folder, so they sync with it. Git projects use
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
page yet, Wren updates by itself. Wren checks for updates when you come back to the page and
every 30 minutes. To check now, choose **Check for updates** in the palette.

## Keyboard shortcuts

These are the default shortcuts. On a Mac, ⌘ is the Command key. On Windows and Linux, use Ctrl.

**Shortcuts follow the physical key**, not the letter on it: **S** is whichever key sits where QWERTY's S is,
so the layout (AZERTY, Dvorak, ...) does not move them, and the editor labels each one with what that key
types on your keyboard where the browser says so (Chrome and Edge).

**Change them in Settings → Keyboard.** Press **Add shortcut** next to a command and press the keys. The
editor warns you when the key is already another command's in the same mode, and when the browser owns
it: Ctrl+W, Ctrl+T, Ctrl+N and a few others never reach a web page and cannot be assigned; others (Ctrl+P,
F5, Ctrl+F ...) can be used if you choose **Use anyway**, and then the browser's own action is lost
while Wren has focus. **Reset** puts a command back, and the keymap is kept on this device
(`wren.keymap`). Esc and Space (repeat) are fixed. Keep Ctrl and Alt off sketch tool keys: the sketch
toolbar reads plain letters and Shift.

### Anywhere

| Shortcut | Action |
| --- | --- |
| ⌘K | Open the command palette |
| ⌘Z | Undo |
| ⇧⌘Z or ⌘Y | Redo |
| ⌘O | Open or import a file |
| ⌘S | Save as a `.wrencad` file |
| Esc | Cancel the innermost thing: the radial menu, settings, a chooser, a pick, a prompt, the selection, the open feature, the library or the welcome card |
| Space | Repeat the last command |
| Q (hold) | Radial menu at the pointer; flick or point, then release |
| Hold Ctrl, ⌘ or Alt for 0.6 s | Show the shortcuts available right now |

### Model (when no sketch is open and no text field has focus)

| Key | Action |
| --- | --- |
| S | Start a sketch |
| E | Extrude |
| R | Revolve |
| F | Fillet |
| C | Chamfer |
| P | Push/pull |
| W / Shift+W | Sweep / loft |
| T / Shift+T | Shell / draft |
| O / Shift+O | Hole / thread |
| I | Mirror |
| N / Shift+N | Linear / circular pattern |
| G / Shift+G / Shift+P | Plane / axis / point |
| Shift+E / Shift+R | Extruded / revolved cut |
| M | Measure |
| Enter | Done with the field being picked: on to the tool's next one; or pick Tab's highlighted candidate |
| Tab / Shift+Tab | Step the highlight through the overlapping candidates under a still pointer |
| 0 or 7 | Isometric view |
| 1 | Front view |
| 2 | Back view |
| 3 | Left view |
| 4 | Right view |
| 5 | Top view |
| 6 | Bottom view |

Shift with a letter gives the second tool of a pair (see above).

### Sketch

| Key | Action |
| --- | --- |
| L | Line |
| A | Arc |
| Shift+C | Circle |
| P | Point |
| D | Dimension |
| B / Shift+B | Spline: control points / through points |
| Shift+E / Shift+A | Ellipse / elliptic arc |
| Enter | End the open spline being drawn |
| Space | Bring back the last sketch tool |
| O, V, T, E, F, Shift+F, M | Edit tools: offset, convert, trim, extend, fillet, chamfer, mirror |
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
clears it. Drag a box to select several things at once (see **Box select**).

Keys are ignored while you type in a field.

Not in the app yet: the plan's H (Hide) key.

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
| Long press (half a second) | The radial menu. Drag onto an item and lift, or lift and tap one. |
| Pencil, hold still | The radial menu |

Several things are close together? A **Which one?** list appears. Choose the one you mean.

Number fields open an on-screen keypad on touch devices, so you can type expressions with units.
Wren also stops page-level pinch zoom and double-tap zoom, so only the model and panels move.

**Coming in M2:**

- Pencil drawing, with pen input for sketching and primitive recognition
- Push and pull (dragging a face to change a feature)
- Measure and section on the phone
- Two- or three-finger tap for undo and redo
- A guided bracket tutorial for new users
