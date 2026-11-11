/**
 * Product gaps the certification-style drawing suite found (M4 gate). Each entry is a spec
 * drawing item that Wren's drawing tools cannot make yet. Nothing here is faked: the spec test
 * (m4-reference-drawings.spec.ts) skips the dimension, requires that it stays unmet, and lists a
 * `test.fixme` with the reason. The lead decides what to build.
 *
 * "Unconfirmed" means the run only showed that the tool made nothing; the cause was not isolated.
 */

export interface Gap {
  /** Spec dimension names (`DrawingDimSpec.name`) this gap leaves unmet (empty: a view property). */
  dims: string[];
  /** The spec item, as a person reads it. */
  what: string;
  reason: string;
}

/** Imported annotations that resolve to needs attention (Import places what cannot resolve). */
export interface AttentionBug {
  count: number;
  reason: string;
}

const ORIGIN =
  'GAP-ORIGIN: Import places it, but it needs attention: the dimension is measured from the sketch origin and its reference (S:p(@origin) or a construction point) never resolves. The Dimension tool cannot pick the origin or a centre line either';
const EXTRUDE =
  'GAP-EXTRUDE-DEPTH: Import places the extrude depth between the feature’s F:start and F:end faces, and those do not resolve when the extrude cuts or merges into a body: needs attention';
const ANGLE =
  'GAP-PICK-OUTLINE: the Angle tool and the Dimension tool now make angles between two straight named edges, but the 3 deg wall is a silhouette/section-face outline, which the drawing kernel does not name, so there is nothing to pick (the same gap as GAP-PICK; Import does not promote a draft angle)';
const COUNT =
  'GAP-COUNT: no instance-count dimension or callout for a pattern (a note is free text, not a resolved value)';
const NOPICK =
  'GAP-PICK: the Dimension tool has nothing to pick there: the geometry is a silhouette outline (unnamed in the drawing kernel), a hidden or construction edge, a mid-plane or a centre line';
const NOTHING =
  'GAP-PICK-UNCONFIRMED: picking the edge(s) made no dimension and showed no message; the cause was not isolated';

const ATTN = (n: string) => `${n} (the import bugs GAP-ORIGIN and GAP-EXTRUDE-DEPTH)`;

export const GAPS: Record<string, Gap[]> = {
  'rp01-base-plate': [
    { dims: ['hole_x', 'hole_y'], what: 'hole centres from the centre lines', reason: ORIGIN },
    { dims: ['pocket_d'], what: 'pocket depth', reason: EXTRUDE },
  ],
  'rp02-stepped-shaft': [
    { dims: ['l2'], what: 'length of the middle step', reason: NOTHING },
    { dims: ['l3', 'd1', 'd2', 'd3'], what: 'end length and the three diameters', reason: NOPICK },
    { dims: ['fillet_r'], what: 'fillet radius', reason: NOPICK },
  ],
  'rp03-ball-knob': [
    {
      dims: ['flat_h', 'ball_d', 'stem_d'],
      what: 'flat height, ball and stem diameters',
      reason: NOPICK,
    },
    { dims: ['stem_l'], what: 'stem length', reason: EXTRUDE },
  ],
  'rp04-clamp-block': [
    { dims: ['corner_r', 'top_r'], what: 'corner and top-edge fillet radii', reason: NOTHING },
    { dims: ['boss_h'], what: 'boss height', reason: EXTRUDE },
    { dims: ['boss_up'], what: 'boss height above the push/pull', reason: NOPICK },
  ],
  'rp05-moulded-housing': [
    { dims: ['height'], what: 'housing height', reason: EXTRUDE },
    { dims: ['wall'], what: 'wall thickness in the section', reason: NOPICK },
    { dims: ['draft_a'], what: 'draft angle 3 deg', reason: ANGLE },
  ],
  'rp06-cable-guide': [
    { dims: ['blk_t'], what: 'block thickness', reason: EXTRUDE },
    {
      dims: ['ch_d', 'rod_h', 'rod_tail'],
      what: 'channel diameter, rod height and tail',
      reason: NOPICK,
    },
  ],
  'rp07-duct-adapter': [
    { dims: ['inset'], what: 'loft base inset (a hidden outline)', reason: NOPICK },
  ],
  'rp08-cover-plate': [
    { dims: ['cb_d', 'cs_d'], what: 'counterbore and countersink diameters', reason: NOTHING },
    { dims: ['cs_x', 'cs_y'], what: 'countersink position from the centre lines', reason: NOPICK },
    {
      dims: ['tap_dx'],
      what: 'tapped hole spacing',
      reason: `${NOTHING}; the spec anchors the dimension 6 mm off the hole centres, which may be the cause`,
    },
    {
      dims: ['cb_y'],
      what: 'counterbore position (18 mm from the centre line)',
      reason:
        'GAP-LAYOUT: Import cannot place it with the stepped cut line in the view: "No room for it on a view, even after moving views apart" (layoutDoesNotFit; the cut line y = 18 mm runs along the dimension). Planner lanes, packages/drawing',
    },
    { dims: ['tap_n'], what: 'number of tapped holes (4)', reason: COUNT },
    {
      dims: ['cb_h', 'tap_depth'],
      what: 'counterbore and tap depths in the section',
      reason: NOPICK,
    },
  ],
  'rp09-flanged-hub': [
    {
      dims: ['flange_d'],
      what: 'flange diameter as a linear dimension across the circle',
      reason: NOPICK,
    },
    { dims: ['bolt_d'], what: 'bolt hole diameter', reason: NOTHING },
    {
      dims: ['pcd'],
      what: 'pitch circle diameter (a centre-line circle, not an edge)',
      reason: NOPICK,
    },
    { dims: ['bolt_n'], what: 'number of bolt holes (8)', reason: COUNT },
    { dims: ['hub_h'], what: 'hub height in the section', reason: NOPICK },
  ],
  'rp10-comb-plate': [
    { dims: ['slot_x0', 'slot_pitch'], what: 'first slot position and slot pitch', reason: NOPICK },
    { dims: ['slot_n'], what: 'number of slots (6)', reason: COUNT },
  ],
};

/**
 * The number of annotations left needing attention after Import, per part: what Import places that
 * cannot resolve (GAP-ORIGIN, GAP-EXTRUDE-DEPTH). A part not listed has none.
 */
export const ATTENTION_BUGS: Record<string, AttentionBug> = {
  'rp01-base-plate': {
    count: 11,
    reason: ATTN('10 origin-anchored hole and rectangle dimensions, 1 cut depth'),
  },
  'rp03-ball-knob': { count: 1, reason: ATTN('the stem depth') },
  'rp04-clamp-block': {
    count: 3,
    reason: ATTN('the boss depth and two origin-anchored dimensions'),
  },
  'rp05-moulded-housing': { count: 1, reason: ATTN('the housing depth') },
  'rp06-cable-guide': { count: 1, reason: ATTN('the block depth') },
  'rp07-duct-adapter': { count: 2, reason: ATTN('two origin-anchored dimensions') },
};
