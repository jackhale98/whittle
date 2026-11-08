/**
 * Persistent topological naming grammar (PLAN §7.3). Lead-owned.
 *
 *   name     := featureTag ":" role [ "(" name ")" ] [ "#" index ]
 *   featureTag := "F" featureId
 *
 * Examples:
 *   F01J…:start              extrude start cap
 *   F01J…:side(S01H…:e7)      extrude side face generated from sketch edge e7
 *   F01K…:fillet(F01J…:edge(…))
 *   F01J…:face.top#0          primitive face, split index 0 (sorted by geometric key)
 *
 * Primitive (M0) roles, box in its local frame:
 *   faces:    face.xmin face.xmax face.ymin face.ymax face.zmin face.zmax
 *   edges:    edge(<faceRoleA>|<faceRoleB>) with the two face roles sorted lexicographically
 *   vertices: vertex(<x>,<y>,<z>) with each of x,y,z in {min,max}
 *
 * M1 grammar additions (normative; kernel + regen engine must emit exactly these):
 *
 *   Reserved references (no feature):
 *     origin:O                        origin point
 *     origin:X  origin:Y  origin:Z    axes
 *     origin:XY origin:XZ origin:YZ   planes (usable as sketch planes / extrude up-to)
 *
 *   Sketch S (feature id S…):
 *     S…:e(<entityId>)                 sketch curve (edge in the sketch's wire compound)
 *     S…:p(<entityId>)                 sketch point
 *     S…:region(<entityId>,<entityId>,…)  closed region; ids of its outer-loop curves sorted,
 *                                      then "|" and each inner loop's sorted ids, loops sorted:
 *                                      e.g. S1:region(e1,e2,e3,e4|e9)
 *
 *   Extrude / revolve F from profile curves:
 *     F…:start  F…:end                 caps (revolve < 360°); absent when not created
 *     F…:side(<sketchCurveName>)       lateral face generated from a sketch curve (Generated)
 *
 *   Edges and vertices of any solid are named from their adjacent faces:
 *     edge(<faceA>|<faceB>)            face names sorted lexicographically
 *     vertex(<faceA>|<faceB>|<faceC>)  first three adjacent face names, sorted
 *
 *   Modifying features (boolean, fillet, chamfer, push/pull):
 *     a face that survives keeps its name (Modified); new faces are
 *     F…:fillet(<edgeName>)  F…:chamfer(<edgeName>)  F…:face(<toolFaceName>) (boolean tool faces)
 *
 *   Splits: when one name maps to several sub-shapes, each gets "#k" (k = 0…) ordered by a
 *   deterministic geometric key (centroid x, then y, then z, rounded to 1e-6 mm).
 *
 * Bodies: "B<featureId>" for the feature that created the body (op "new").
 *
 * Additions from the M1 kernel (normative):
 *   - Cylinder roles: face.side face.zmin face.zmax. Sphere: face.sphere; its poles are
 *     edge(face.sphere)#0/#1 and vertex(face.sphere)#0/#1.
 *   - Primitive edges/vertices use the local form F…:edge(<role>|<role>) / F…:vertex(…) (as the M0
 *     box), while every later feature writes the global form edge(F…:<role>|…). Both are valid
 *     names; resolution treats them as opaque strings.
 *   - Seam edges: edge(A|A). Free (boundary) edges: edge(A). Corner blends: F…:fillet(<vertexName>).
 *     Last resort when history gives nothing: F…:unnamed#k (resolution then relies on fingerprints).
 *   - Re-indexing: when an operation splits a face, every face sharing that base name is
 *     renumbered so there is only one "#k" level (never "#0#1").
 *   - Regions are minimal: a rectangle with a circle inside yields region(L1,L2,L3,L4|C1) (the ring)
 *     and region(C1) (the disc). Selecting both = the full rectangle.
 *   - Split sketch curves: S…:e(<id>)#k. Coincident sketch points each keep their own S…:p(<id>).
 */

export type PersistentName = string;

/** Sub-shape index space of a single shape handle, as enumerated by TopExp::MapShapes. */
export interface NamingEntry {
  name: PersistentName;
  kind: 'face' | 'edge' | 'vertex';
  /** 0-based index into the shape's TopExp map for `kind` (stable for the lifetime of the handle). */
  index: number;
}

export type NamingMap = NamingEntry[];
