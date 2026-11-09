import type { KeymapCommand } from './keymap';

/**
 * The default keymap (PLAN 9.4), by physical key. It reproduces the shortcuts that
 * apps/web/src/app/workbench.ts `onKey` and the sketch toolbar handle today, so the integration
 * can replace their `e.key` switches with `matchCommand`. Command ids are the app's own tool ids
 * where one exists (`tool:extrude`, `sketch:line`). The bindings avoid every
 * `BROWSER_RESERVED` entry except Save / Open, which Wren deliberately overrides.
 */
const K = (letter: string) => `Key${letter}`;
const cmd = (
  id: string,
  label: string,
  group: string,
  context: KeymapCommand['context'],
  ...defaults: string[]
): KeymapCommand => ({ id, label, group, context, defaults });

export const DEFAULT_COMMANDS: readonly KeymapCommand[] = [
  { ...cmd('cancel', 'Cancel / leave tool', 'General', 'global', 'Escape'), locked: true },
  { ...cmd('repeat', 'Repeat last command', 'General', 'global', 'Space'), locked: true },
  cmd('palette', 'Command palette', 'General', 'global', `Mod+${K('K')}`),
  cmd('undo', 'Undo', 'General', 'global', `Mod+${K('Z')}`),
  cmd('redo', 'Redo', 'General', 'global', `Mod+Shift+${K('Z')}`, `Mod+${K('Y')}`),
  cmd('save', 'Save / export', 'General', 'global', `Mod+${K('S')}`),
  cmd('open', 'Open', 'General', 'global', `Mod+${K('O')}`),

  cmd('tool:sketch', 'Sketch', 'Modeling', 'model', K('S')),
  cmd('tool:extrude', 'Extrude', 'Modeling', 'model', K('E')),
  cmd('tool:revolve', 'Revolve', 'Modeling', 'model', K('R')),
  cmd('tool:fillet', 'Fillet', 'Modeling', 'model', K('F')),
  cmd('tool:chamfer', 'Chamfer', 'Modeling', 'model', K('C')),
  cmd('tool:pushPull', 'Push / pull', 'Modeling', 'model', K('P')),
  cmd('tool:sweep', 'Sweep', 'Modeling', 'model', K('W')),
  cmd('tool:shell', 'Shell', 'Modeling', 'model', K('T')),
  cmd('tool:hole', 'Hole', 'Modeling', 'model', K('O')),
  cmd('tool:mirror', 'Mirror', 'Modeling', 'model', K('I')),
  cmd('tool:linearPattern', 'Linear pattern', 'Modeling', 'model', K('N')),
  cmd('tool:plane', 'Plane', 'Modeling', 'model', K('G')),
  cmd('tool:extrudeCut', 'Extruded cut', 'Modeling', 'model', `Shift+${K('E')}`),
  cmd('tool:revolveCut', 'Revolved cut', 'Modeling', 'model', `Shift+${K('R')}`),
  cmd('tool:loft', 'Loft', 'Modeling', 'model', `Shift+${K('W')}`),
  cmd('tool:draft', 'Draft', 'Modeling', 'model', `Shift+${K('T')}`),
  cmd('tool:thread', 'Thread', 'Modeling', 'model', `Shift+${K('O')}`),
  cmd('tool:circularPattern', 'Circular pattern', 'Modeling', 'model', `Shift+${K('N')}`),
  cmd('tool:axis', 'Axis', 'Modeling', 'model', `Shift+${K('G')}`),
  cmd('tool:point', 'Point', 'Modeling', 'model', `Shift+${K('P')}`),
  cmd('tool:measure', 'Measure', 'Modeling', 'model', K('M')),

  cmd('view:iso', 'Isometric view', 'View', 'global', 'Digit0', 'Digit7'),
  cmd('view:front', 'Front view', 'View', 'global', 'Digit1'),
  cmd('view:back', 'Back view', 'View', 'global', 'Digit2'),
  cmd('view:left', 'Left view', 'View', 'global', 'Digit3'),
  cmd('view:right', 'Right view', 'View', 'global', 'Digit4'),
  cmd('view:top', 'Top view', 'View', 'global', 'Digit5'),
  cmd('view:bottom', 'Bottom view', 'View', 'global', 'Digit6'),

  cmd('sketch:line', 'Line', 'Sketch', 'sketch', K('L')),
  cmd('sketch:arc', 'Arc', 'Sketch', 'sketch', K('A')),
  cmd('sketch:circle', 'Circle', 'Sketch', 'sketch', `Shift+${K('C')}`),
  cmd('sketch:point', 'Point', 'Sketch', 'sketch', K('P')),
  cmd('sketch:dimension', 'Dimension', 'Sketch', 'sketch', K('D')),
  cmd('sketch:construction', 'Construction geometry', 'Sketch', 'sketch', K('X')),
  cmd('sketch:splineControl', 'Spline (control points)', 'Sketch', 'sketch', K('B')),
  cmd('sketch:splineThrough', 'Spline (through points)', 'Sketch', 'sketch', `Shift+${K('B')}`),
  cmd('sketch:ellipse', 'Ellipse', 'Sketch', 'sketch', `Shift+${K('E')}`),
  cmd('sketch:ellipticArc', 'Elliptic arc', 'Sketch', 'sketch', `Shift+${K('A')}`),
  cmd('sketch:offset', 'Offset', 'Sketch edit', 'sketch', K('O')),
  cmd('sketch:convert', 'Convert entities', 'Sketch edit', 'sketch', K('V')),
  cmd('sketch:trim', 'Trim', 'Sketch edit', 'sketch', K('T')),
  cmd('sketch:extend', 'Extend', 'Sketch edit', 'sketch', K('E')),
  cmd('sketch:fillet', 'Sketch fillet', 'Sketch edit', 'sketch', K('F')),
  cmd('sketch:chamfer', 'Sketch chamfer', 'Sketch edit', 'sketch', `Shift+${K('F')}`),
  cmd('sketch:mirror', 'Mirror', 'Sketch edit', 'sketch', K('M')),
];
