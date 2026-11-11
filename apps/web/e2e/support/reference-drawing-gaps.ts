/**
 * Product gaps the certification-style drawing suite still finds (M4 gate, round 3). Each entry is
 * a spec drawing item that Wren's drawing tools cannot make yet, with a gap id and the reason
 * found. Nothing here is faked: the spec test (m4-reference-drawings.spec.ts) skips the dimension,
 * requires that it stays unmet, and lists a `test.fixme` with the reason. The lead decides what to
 * build. `WREN_CERT_ALL=1` re-checks every entry.
 *
 * Every annotation Import places now resolves: no part leaves anything needing attention.
 */

export interface Gap {
  /** Spec dimension names (`DrawingDimSpec.name`) this gap leaves unmet. */
  dims: string[];
  /** The spec item, as a person reads it. */
  what: string;
  reason: string;
}

const CONSTRUCTION =
  'GAP-PICK-CONSTRUCTION: it is measured from a centre line, a centre plane or a construction circle (the sketch origin, a slot or hole centre, the pitch circle, a level the model had before a later feature). The view draws no edge there, and the Dimension tool picks only drawn edges and outlines; Import cannot promote it either (its value is not a sketch or feature dimension of its own)';
const SECTION =
  'GAP-PICK-SECTION: the edges of a section view’s cut face come from the cut, not from the model: the drawing kernel gives them no name and no face (`sectionFaces` ids are synthetic), so the Dimension and Angle tools have nothing to pick on them';
const TANGENT =
  'GAP-PICK-TANGENT: the straight leg of the swept rod ends where its bend starts, a tangent (smooth) edge, and the view does not draw tangent edges by default; the leg’s outlines (face-named) run past that point, so there is no edge to measure to';

export const GAPS: Record<string, Gap[]> = {
  'rp02-stepped-shaft': [
    {
      dims: ['fillet_r'],
      what: 'step fillet radius R3, on the outline side of the shaft',
      reason:
        'GAP-PICK-OUTLINE-SPLINE: on the side the spec dimensions, the fillet is the outline of a torus, which the drawing kernel returns as a B-spline with its face, not as an arc: no radius to pick there (on the seam side it is a named arc of radius 3)',
    },
  ],
  'rp03-ball-knob': [
    {
      dims: ['flat_h'],
      what: 'height of the flat above the ball centre',
      reason: CONSTRUCTION,
    },
  ],
  'rp04-clamp-block': [
    {
      dims: ['boss_up'],
      what: 'push/pull distance above the boss as first extruded',
      reason: `${CONSTRUCTION}. The level the push/pull started from is history: no face of the finished part is there`,
    },
  ],
  'rp05-moulded-housing': [
    { dims: ['wall'], what: 'wall thickness in the section', reason: SECTION },
    {
      dims: ['draft_a'],
      what: 'draft angle 3 deg between the drafted wall and the vertical, in the section',
      reason: `${SECTION}. The drafted wall is a cut-face edge there, not an outline, so the new outline face names do not reach it. Closing it also needs the certification driver to make angles with the Angle tool: \`dimensionTool\` has no angle path yet (PLAN M4.1)`,
    },
  ],
  'rp06-cable-guide': [
    { dims: ['rod_h', 'rod_tail'], what: 'rod leg and tail lengths', reason: TANGENT },
  ],
  'rp07-duct-adapter': [
    {
      dims: ['inset'],
      what: 'loft base inset',
      reason:
        'GAP-PICK-HIDDEN: the inset is between the loft’s base outline and the plate edge; the base outline is hidden under the loft in the top view, and the Dimension tool picks visible edges only',
    },
  ],
  'rp08-cover-plate': [
    {
      dims: ['cs_x', 'cs_y'],
      what: 'countersunk hole position (the reference point) from the centre lines',
      reason: `${CONSTRUCTION}. The point feature’s coordinates are not promotable by Import`,
    },
    {
      dims: ['tap_dx'],
      what: 'tapped hole spacing, centre to centre',
      reason:
        'GAP-TOOL-CENTRES: the Dimension tool makes a diameter on the first circle it is given, so two hole centres cannot be picked one after the other (planDimension supports centre to centre; the pick flow never reaches it). The pattern spacing is not promotable by Import',
    },
    { dims: ['tap_depth'], what: 'tapped hole depth in the section', reason: SECTION },
  ],
  'rp09-flanged-hub': [
    {
      dims: ['flange_d'],
      what: 'flange diameter as a linear dimension across the circle',
      reason:
        'GAP-PICK-EXTREMES: a linear dimension across a circle seen face-on runs between its tangent extremes, which are not edges; the Dimension tool makes a diameter from the circle instead (the spec asks for the linear form)',
    },
    { dims: ['pcd'], what: 'pitch circle diameter (a centre-line circle)', reason: CONSTRUCTION },
    { dims: ['hub_h'], what: 'hub height in the section', reason: SECTION },
  ],
  'rp10-comb-plate': [
    {
      dims: ['slot_x0'],
      what: 'first slot centre from the centre line',
      reason: CONSTRUCTION,
    },
  ],
};
