import type { TutorialStep } from '../logic/tutorial';

/**
 * The 60-second "make a bracket" tutorial (PLAN 9.2), written touch-first ("tap", "drag") with the
 * mouse equivalent implied. The app calls `advance(step.id)` when the condition in `hint` is met,
 * e.g. when the document gains a sketch feature after the "sketch" step is current.
 *
 * Targets use comma selectors so they still resolve when a tool lives inside a closed rail flyout:
 * the first match in document order wins (the tool itself when visible, otherwise its group).
 */
export const BRACKET_TUTORIAL_ID = 'make-a-bracket';

export const bracketTutorial: readonly TutorialStep[] = [
  {
    id: 'sketch',
    title: 'Start with a sketch',
    body: 'Every part begins as a flat drawing. Tap Sketch, then tap the Top plane.',
    target: '[data-tool="sketch"]',
    hint: 'Waiting for a sketch on the Top plane',
  },
  {
    id: 'rectangle',
    title: 'Draw a rectangle',
    body: 'Pick the Rectangle tool, then drag from one corner to the opposite one (or tap both corners). This is the bracket’s base plate.',
    target: '[data-tool="rectangle"]',
    hint: 'Waiting for a closed rectangle',
  },
  {
    id: 'dimension',
    title: 'Give it an exact size',
    body: 'Pick Dimension, tap an edge, then tap beside it to place the value, and type 60 for the length. The number keypad takes units and expressions such as 2 * width.',
    target: '[data-testid="keypad"], [data-tool="dimension"]',
    hint: 'Waiting for a driving dimension',
  },
  {
    id: 'extrude',
    title: 'Pull it into a solid',
    body: 'Finish the sketch, tap the rectangle and choose Extrude. Tap the depth next to it to type 6 mm.',
    target: '[data-tool="extrude"], [data-tool-group="solid"]',
    hint: 'Waiting for an extrude feature',
  },
  {
    id: 'holes',
    title: 'Add mounting holes',
    body: 'Tap the top face of the plate and choose Sketch. Draw two circles near the corners and finish. Tap a circle, choose Cut, then tap the other circle.',
    target: '[data-action="cut"], [data-tool="sketch"]',
    hint: 'Waiting for a cut through the plate',
  },
  {
    id: 'fillet',
    title: 'Round the corners',
    body: 'Tap an outer corner edge and choose Fillet; tap more edges to add them. Type 3 mm for the radius in the inspector.',
    target: '[data-tool="fillet"], [data-tool-group="modify"]',
    hint: 'Waiting for a fillet feature',
  },
  {
    id: 'params',
    title: 'Make it adjustable',
    body: 'Open Params in the feature panel (the sheet on a phone) and add a parameter. Use it in the plate’s extrude depth (the keypad lists parameter names), then change its value and watch the bracket update.',
    target: '[data-testid="tools-sheet"], [data-testid="left-toggle"]',
    hint: 'Waiting for a parameter used by a feature',
  },
  {
    id: 'export',
    title: 'Export or print it',
    body: 'Tap Export and choose STL or 3MF for a printer, or STEP to send it to someone else’s CAD.',
    target: '[data-testid="export-trigger"], [data-sheet-tab="export"]',
    hint: 'Waiting for an export',
  },
];
