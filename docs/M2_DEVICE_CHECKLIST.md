# M2 real-device checklist (iPad and iPhone)

The M2 acceptance (PLAN §12) needs a real iPad with iPadOS 26 Safari, installed as a home-screen app.
CI covers the rest in emulation; these checks can't be automated. Run them on the deployed M2 build
and note anything that fails, with the device, orientation and steps.

## iPad (installed PWA)

1. **Install.** In Safari choose Share, then Add to Home Screen, and launch from the icon.
   - It opens standalone, with no browser bars.
   - The status bar suits the light and dark themes.
   - Nothing hides under rounded corners or the home indicator, in portrait or landscape. Rotate
     the iPad while the app is open.
2. **The page stays put.**
   - Pinching and double-tapping on the top bar, tool rail and history sheet never zoom the page.
   - Tapping any value field doesn't zoom.
   - Dragging the sheet moves only the sheet.
   - There's no rubber-banding, and long-pressing UI shows no callout and no text selection.
3. **iPadOS gestures don't fight ours.**
   - Two-finger tap undoes and three-finger tap redoes, without the system's undo/redo HUD or
     copy/paste menu taking over.
   - Pinching the model never triggers multitasking.
4. **The tutorial (the M2 acceptance test).**
   - Ask someone who hasn't used Whittle to open it from the welcome card ("Take the 60-second
     tour") and finish it with fingers only, no keyboard, while you time it. **It must take under
     5 minutes.**
   - Note where they hesitate, and whether they pinch or two-finger-tap inside the sketch.
   - Repeat it once using the Pencil.
5. **Smoothness.** In Safari's Web Inspector (connected from a Mac), record a Timeline while
   orbiting the demo bracket, then a large test model. Frames should stay at about 16 ms (60 fps).
6. **Rendering.**
   - In About Whittle (⌘K) or the diagnostics, confirm the renderer is **WebGPU**.
   - Open Section and check that the cut faces are filled solid on X, Y and Z, on a picked face,
     and with Flip.
   - Drag a push/pull arrow and check that the translucent preview follows the finger.
7. **Pencil.**
   - Draw a line, a rectangle (also starting from a corner), a circle and an arc. Each should snap
     to a clean shape.
   - Rest your palm on the screen while drawing: the view must not orbit, and nothing gets
     selected.
   - Hovering the Pencil (on iPads that support hover) highlights what it would pick.
   - After using the Pencil, fingers only move the view.
8. **Gestures in model and sketch mode:**
   - tap selects;
   - double-tap zooms to a face, or fits on empty space;
   - long-press shows the action bubble;
   - two-finger tap undoes and three-finger tap redoes;
   - twisting two fingers rolls the view.
9. **Memory, speed and offline.**
   - Peak memory stays under 1 GB (Web Inspector) on the demo with a few edits.
   - The kernel is ready within about 6 s on a first visit and 1 s afterwards.
   - The app works in airplane mode after one visit.
10. **Keypad.**
    - Edit values near the bottom of the history sheet, in both orientations: the keypad never
      covers the field.
    - Switching to the iOS keyboard and back works.

## iPhone

1. Install it to the home screen, as for the iPad, and check safe areas and that the page stays
   put.
2. Reopen a document you've used before. It appears quickly, and the kernel isn't loaded yet
   (diagnostics).
3. Run each tab: Measure (one and two picks), Section, Params (edit a value; the part updates), and
   Export to STL and STEP. Each should start the kernel when it's needed.
